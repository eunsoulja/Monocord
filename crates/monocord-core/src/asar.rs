//! Minimal Electron `asar` archive reader/writer.
//!
//! Asar layout (all integers little-endian u32 unless noted):
//!
//! ```text
//! [u32: 4]                    outer pickle payload size (one u32 follows)
//! [u32: header_size H]        size of the header pickle that follows
//! header pickle (H bytes):
//!   [u32: payload_size]       = H - 4
//!   [u32: json_len]
//!   [json bytes][zero pad]    padded so payload_size is 4-aligned
//! file data (concatenated, offsets in JSON are relative to data start)
//! ```
//!
//! Header JSON shape:
//! `{"files": {"name": {"size": N, "offset": "O"} | {"files": {...}}}}`
//!
//! Only regular files and directories are supported. Entries marked
//! `"unpacked"` or `"link"` are rejected — repacking them would corrupt
//! the archive semantics, and Discord's `app.asar` does not use them.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// A single file entry inside an asar archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsarEntry {
    /// Archive-internal path using `/` separators (e.g. `dir/file.js`).
    pub path: String,
    /// File size in bytes.
    pub size: u64,
    /// Byte offset relative to the start of the data section.
    pub offset: u64,
}

/// Parsed asar archive. Cheap to clone the raw bytes; parsing is lazy.
#[derive(Debug, Clone)]
pub struct Asar {
    raw: Vec<u8>,
    /// Absolute offset where concatenated file data begins.
    data_start: usize,
    /// Parsed header JSON (`{"files": {...}}`).
    header: Value,
}

impl Asar {
    /// Parse an asar archive from bytes.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 16 {
            return Err(Error::UnsafeOperation("asar too small".into()));
        }
        let u32_at = |off: usize| -> Result<u32> {
            let s = bytes
                .get(off..off + 4)
                .ok_or_else(|| Error::UnsafeOperation("asar truncated".into()))?;
            Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        };
        // Outer pickle: payload must be exactly one u32.
        if u32_at(0)? != 4 {
            return Err(Error::UnsafeOperation("bad asar outer pickle".into()));
        }
        let header_size = u32_at(4)? as usize;
        let header_start = 8usize;
        let header_end = header_start
            .checked_add(header_size)
            .filter(|e| *e <= bytes.len())
            .ok_or_else(|| Error::UnsafeOperation("asar header out of bounds".into()))?;

        // Header pickle payload: u32 payload_size, then u32 json_len + json.
        let payload_size = u32_at(header_start)? as usize;
        if payload_size + 4 != header_size {
            return Err(Error::UnsafeOperation("asar header size mismatch".into()));
        }
        let json_len = u32_at(header_start + 4)? as usize;
        let json_start = header_start + 8;
        let json_end = json_start
            .checked_add(json_len)
            .filter(|e| *e <= header_end)
            .ok_or_else(|| Error::UnsafeOperation("asar json out of bounds".into()))?;
        let header: Value = serde_json::from_slice(&bytes[json_start..json_end])
            .map_err(|e| Error::UnsafeOperation(format!("bad asar header json: {e}")))?;
        if header.get("files").and_then(Value::as_object).is_none() {
            return Err(Error::UnsafeOperation("asar header missing files".into()));
        }

        Ok(Self {
            raw: bytes.to_vec(),
            data_start: header_end,
            header,
        })
    }

    /// Read an archive from a file path.
    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        Self::parse(&std::fs::read(path)?)
    }

    /// All regular-file entries, sorted by path.
    #[must_use]
    pub fn entries(&self) -> Vec<AsarEntry> {
        let mut out = Vec::new();
        if let Some(files) = self.header.get("files").and_then(Value::as_object) {
            collect_entries(files, "", &mut out);
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    /// Read one file's bytes. `path` uses `/` separators, no leading slash.
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let node = self.lookup(path)?;
        let size = node
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(|| Error::UnsafeOperation(format!("asar entry has no size: {path}")))?;
        let offset = node
            .get("offset")
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| v.as_u64())
            })
            .ok_or_else(|| Error::UnsafeOperation(format!("asar entry has no offset: {path}")))?;
        let start = self
            .data_start
            .checked_add(offset as usize)
            .filter(|s| *s <= self.raw.len())
            .ok_or_else(|| Error::UnsafeOperation(format!("asar offset out of bounds: {path}")))?;
        let end = start
            .checked_add(size as usize)
            .filter(|e| *e <= self.raw.len())
            .ok_or_else(|| Error::UnsafeOperation(format!("asar size out of bounds: {path}")))?;
        Ok(self.raw[start..end].to_vec())
    }

    /// Whether a path exists as a file entry.
    #[must_use]
    pub fn contains(&self, path: &str) -> bool {
        self.lookup(path).is_ok_and(|n| n.get("size").is_some())
    }

    /// Produce a new archive with every file replaced/added per `files`.
    ///
    /// `files` maps archive path → contents. Paths not present keep their
    /// original bytes; entries marked unpacked/link cause an error.
    pub fn repack_with(&self, replacements: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
        // Materialize all current files.
        let mut all: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for entry in self.entries() {
            all.insert(entry.path.clone(), self.read_file(&entry.path)?);
        }
        // Reject entries we cannot carry over (unpacked/link live outside
        // the data section and would be silently dropped otherwise).
        self.reject_nonportable()?;
        all.extend(replacements.iter().map(|(k, v)| (k.clone(), v.clone())));
        Ok(pack(&all))
    }

    fn reject_nonportable(&self) -> Result<()> {
        fn walk(node: &Map<String, Value>, prefix: &str) -> Result<()> {
            for (name, val) in node {
                let path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                let obj = val
                    .as_object()
                    .ok_or_else(|| Error::UnsafeOperation(format!("bad asar node: {path}")))?;
                if obj.contains_key("unpacked") || obj.contains_key("link") {
                    return Err(Error::UnsafeOperation(format!(
                        "asar entry is unpacked/linked and cannot be repacked: {path}"
                    )));
                }
                if let Some(sub) = obj.get("files").and_then(Value::as_object) {
                    walk(sub, &path)?;
                }
            }
            Ok(())
        }
        walk(
            self.header
                .get("files")
                .and_then(Value::as_object)
                .expect("header validated"),
            "",
        )
    }

    /// Navigate the header JSON to a file node.
    fn lookup(&self, path: &str) -> Result<&Value> {
        if path.is_empty() || path.split('/').any(str::is_empty) {
            return Err(Error::UnsafeOperation("invalid asar path".into()));
        }
        let mut map = self
            .header
            .get("files")
            .and_then(Value::as_object)
            .expect("header validated");
        let mut last: Option<&Value> = None;
        for part in path.split('/') {
            last =
                Some(map.get(part).ok_or_else(|| {
                    Error::UnsafeOperation(format!("asar entry not found: {path}"))
                })?);
            if let Some(sub) = last.and_then(|v| v.get("files")).and_then(Value::as_object) {
                map = sub;
            }
        }
        let node = last.expect("non-empty path");
        if node.get("size").is_none() {
            return Err(Error::UnsafeOperation(format!(
                "asar path is a directory: {path}"
            )));
        }
        Ok(node)
    }
}

fn collect_entries(files: &Map<String, Value>, prefix: &str, out: &mut Vec<AsarEntry>) {
    for (name, val) in files {
        let Some(obj) = val.as_object() else { continue };
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if let Some(sub) = obj.get("files").and_then(Value::as_object) {
            collect_entries(sub, &path, out);
        } else if obj.contains_key("size")
            && !obj.contains_key("unpacked")
            && let (Some(size), Some(offset)) = (
                obj.get("size").and_then(Value::as_u64),
                obj.get("offset").and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse::<u64>().ok())
                        .or_else(|| v.as_u64())
                }),
            )
        {
            out.push(AsarEntry { path, size, offset });
        }
    }
}

#[derive(Default)]
struct PackDir {
    files: BTreeMap<String, PackNode>,
}

enum PackNode {
    Dir(PackDir),
    File { size: u64, offset: String },
}

fn pack_insert(dir: &mut PackDir, parts: &[&str], size: u64, offset: &str) {
    let (first, rest) = parts.split_first().expect("non-empty path");
    if rest.is_empty() {
        dir.files.insert(
            (*first).to_string(),
            PackNode::File {
                size,
                offset: offset.to_string(),
            },
        );
        return;
    }
    // If a file already occupies this segment, replace it with a dir.
    if matches!(dir.files.get(*first), Some(PackNode::File { .. })) {
        dir.files
            .insert((*first).to_string(), PackNode::Dir(PackDir::default()));
    }
    let entry = dir
        .files
        .entry((*first).to_string())
        .or_insert_with(|| PackNode::Dir(PackDir::default()));
    if let PackNode::Dir(d) = entry {
        pack_insert(d, rest, size, offset);
    }
}

fn pack_node_json(node: &PackNode) -> Value {
    match node {
        PackNode::Dir(d) => {
            let mut files = Map::new();
            for (name, child) in &d.files {
                files.insert(name.clone(), pack_node_json(child));
            }
            let mut m = Map::new();
            m.insert("files".into(), Value::Object(files));
            Value::Object(m)
        }
        PackNode::File { size, offset } => {
            let mut m = Map::new();
            m.insert("size".into(), Value::from(*size));
            m.insert("offset".into(), Value::from(offset.clone()));
            Value::Object(m)
        }
    }
}

/// Pack a set of `path → bytes` into a new asar archive.
///
/// Paths use `/` separators; intermediate directories are created
/// implicitly in the header. File order is sorted by path for determinism.
#[must_use]
pub fn pack(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut root = PackDir::default();
    let mut data = Vec::new();
    for (path, bytes) in files {
        let offset = data.len() as u64;
        data.extend_from_slice(bytes);
        let parts: Vec<&str> = path.split('/').collect();
        pack_insert(&mut root, &parts, bytes.len() as u64, &offset.to_string());
    }

    let mut files_map = Map::new();
    for (name, child) in &root.files {
        files_map.insert(name.clone(), pack_node_json(child));
    }
    let mut header_map = Map::new();
    header_map.insert("files".into(), Value::Object(files_map));
    let json = serde_json::to_vec(&Value::Object(header_map)).unwrap_or_default();

    // Header pickle: u32 payload_size, u32 json_len, json, zero-pad to 4.
    let pad = (4 - (json.len() % 4)) % 4;
    let payload_size = 4 + json.len() + pad; // u32 len field + json + pad
    let header_size = 4 + payload_size; // pickle size field + payload

    let mut out = Vec::with_capacity(8 + header_size + data.len());
    out.extend_from_slice(&4u32.to_le_bytes()); // outer pickle payload size
    out.extend_from_slice(&(header_size as u32).to_le_bytes());
    out.extend_from_slice(&(payload_size as u32).to_le_bytes());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.resize(out.len() + pad, 0);
    out.extend_from_slice(&data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_parse_roundtrip() {
        let mut files = BTreeMap::new();
        files.insert("index.js".to_string(), b"require('x');".to_vec());
        files.insert(
            "package.json".to_string(),
            b"{\"main\":\"index.js\"}".to_vec(),
        );
        files.insert("lib/deep/file.txt".to_string(), b"hello world".to_vec());
        let bytes = pack(&files);
        let asar = Asar::parse(&bytes).unwrap();
        let entries = asar.entries();
        assert_eq!(entries.len(), 3);
        assert_eq!(asar.read_file("index.js").unwrap(), b"require('x');");
        assert_eq!(asar.read_file("lib/deep/file.txt").unwrap(), b"hello world");
        assert!(asar.contains("package.json"));
        assert!(!asar.contains("missing.js"));
    }

    #[test]
    fn repack_replaces_one_file() {
        let mut files = BTreeMap::new();
        files.insert("a.js".to_string(), b"aaa".to_vec());
        files.insert("b.js".to_string(), b"bbb".to_vec());
        let asar = Asar::parse(&pack(&files)).unwrap();
        let mut repl = BTreeMap::new();
        repl.insert("b.js".to_string(), b"patched!".to_vec());
        let out = asar.repack_with(&repl).unwrap();
        let asar2 = Asar::parse(&out).unwrap();
        assert_eq!(asar2.read_file("a.js").unwrap(), b"aaa");
        assert_eq!(asar2.read_file("b.js").unwrap(), b"patched!");
    }

    #[test]
    fn json_padding_respected() {
        // Force odd-length json by using a path that makes json_len % 4 != 0.
        let mut files = BTreeMap::new();
        files.insert("x".to_string(), vec![0u8; 3]);
        let bytes = pack(&files);
        let asar = Asar::parse(&bytes).unwrap();
        assert_eq!(asar.read_file("x").unwrap(), vec![0u8; 3]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(Asar::parse(b"not an asar at all..........").is_err());
        assert!(Asar::parse(&[0u8; 4]).is_err());
    }

    /// Reads the real Discord `app.asar` if present on this machine.
    /// Skips silently elsewhere — this is an environment probe, not a
    /// correctness requirement.
    #[test]
    fn parses_real_discord_app_asar() {
        let Some(local) = dirs::data_local_dir() else {
            return;
        };
        let path = local
            .join("Discord")
            .join("app-1.0.9269")
            .join("resources")
            .join("app.asar");
        let Ok(bytes) = std::fs::read(&path) else {
            // Version dir may differ; glob for any app-*.
            let root = local.join("Discord");
            let Ok(rd) = std::fs::read_dir(&root) else {
                return;
            };
            let mut found = None;
            for e in rd.flatten() {
                let p = e.path().join("resources").join("app.asar");
                if p.is_file() {
                    found = Some(p);
                    break;
                }
            }
            let Some(p) = found else { return };
            let bytes = std::fs::read(&p).unwrap();
            let asar = Asar::parse(&bytes).unwrap();
            let entries = asar.entries();
            assert!(entries.iter().any(|e| e.path == "index.js"));
            let index = asar.read_file("index.js").unwrap();
            assert!(String::from_utf8_lossy(&index).contains("require"));
            return;
        };
        let asar = Asar::parse(&bytes).unwrap();
        let entries = asar.entries();
        assert!(entries.iter().any(|e| e.path == "index.js"));
        let index = asar.read_file("index.js").unwrap();
        let text = String::from_utf8_lossy(&index);
        assert!(text.contains("require"));

        // Full repack roundtrip on the real archive.
        let mut repl = BTreeMap::new();
        repl.insert("index.js".to_string(), b"// test\n".to_vec());
        let repacked = asar.repack_with(&repl).unwrap();
        let asar2 = Asar::parse(&repacked).unwrap();
        assert_eq!(asar2.read_file("index.js").unwrap(), b"// test\n");
        assert!(asar2.contains("package.json"));
    }
}
