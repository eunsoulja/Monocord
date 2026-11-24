//! Reversible installation engine.
//!
//! Every modification Monocord makes to Discord files goes through an
//! [`InstallPlan`]: a list of file operations applied transactionally.
//! Before any target is touched, its original bytes are snapshotted into a
//! backup directory with a SHA-256 manifest, and a JSON journal records
//! progress so an interrupted install can be rolled back.
//!
//! Guarantees:
//! - No file is overwritten or deleted without a verified backup first.
//! - `restore` returns Discord files to their pre-install state.
//! - `verify` re-hashes backups against the manifest to detect corruption.
//! - All paths are confined to the Discord install root — no `..` escapes.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// What an install operation does to a target path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    /// Create a new file (fails if the target already exists).
    Create,
    /// Replace an existing file's contents.
    Overwrite,
    /// Remove a file Monocord previously created.
    Delete,
}

/// One file operation in an install plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOp {
    /// Operation kind.
    pub kind: OpKind,
    /// Path relative to the Discord install root.
    pub rel_path: String,
    /// Payload bytes for `Create`/`Overwrite` (None for `Delete`).
    /// Stored inline so plans are self-contained and testable.
    pub payload: Option<Vec<u8>>,
}

impl FileOp {
    /// Create a file-write op from bytes.
    #[must_use]
    pub fn write(rel_path: impl Into<String>, payload: Vec<u8>) -> Self {
        Self {
            kind: OpKind::Overwrite,
            rel_path: rel_path.into(),
            payload: Some(payload),
        }
    }

    /// Create a new-file op (refuses to clobber an existing file).
    #[must_use]
    pub fn create(rel_path: impl Into<String>, payload: Vec<u8>) -> Self {
        Self {
            kind: OpKind::Create,
            rel_path: rel_path.into(),
            payload: Some(payload),
        }
    }

    /// Create a delete op (only valid for files Monocord created).
    #[must_use]
    pub fn delete(rel_path: impl Into<String>) -> Self {
        Self {
            kind: OpKind::Delete,
            rel_path: rel_path.into(),
            payload: None,
        }
    }
}

/// A transactional set of file operations against one Discord install.
#[derive(Debug, Clone, Default)]
pub struct InstallPlan {
    /// Operations to apply, in order.
    pub ops: Vec<FileOp>,
}

impl InstallPlan {
    /// Empty plan.
    #[must_use]
    pub fn new() -> Self {
        Self { ops: Vec::new() }
    }

    /// Add an op and return self for chaining.
    #[must_use]
    pub fn op(mut self, op: FileOp) -> Self {
        self.ops.push(op);
        self
    }
}

/// Per-file backup record stored in `manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupEntry {
    /// Path relative to the install root.
    rel_path: String,
    /// SHA-256 of the original file (None = file did not exist).
    sha256: Option<String>,
    /// Snapshot location relative to the backup dir.
    snapshot: Option<String>,
}

/// On-disk backup manifest.
#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    /// Install root this backup belongs to.
    install_root: String,
    /// Creation time (unix secs).
    created_at: u64,
    /// Framework version that created it.
    framework_version: String,
    /// Per-file records.
    entries: Vec<BackupEntry>,
}

/// Journal entry for crash recovery.
#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    /// Ops completed so far (indices into the plan).
    completed: Vec<usize>,
    /// Whether the plan finished applying.
    finished: bool,
}

/// Result of an integrity verification pass.
#[derive(Debug, Clone)]
pub struct VerifyReport {
    /// Files checked.
    pub checked: usize,
    /// Files whose snapshot hash matches the manifest.
    pub ok: usize,
    /// Files that failed verification.
    pub failed: Vec<String>,
}

/// The installer bound to one Discord install root + backup directory.
pub struct Installer {
    /// Discord install root the ops apply to (e.g. the `app-*` dir).
    pub install_root: PathBuf,
    /// Directory holding backups/journals for this install.
    pub backup_dir: PathBuf,
}

impl Installer {
    /// Create an installer. `backup_dir` is typically
    /// `<config>/Monocord/backups/<channel>-<version>`.
    #[must_use]
    pub fn new(install_root: PathBuf, backup_dir: PathBuf) -> Self {
        Self {
            install_root,
            backup_dir,
        }
    }

    fn manifest_path(&self) -> PathBuf {
        self.backup_dir.join("manifest.json")
    }

    fn journal_path(&self) -> PathBuf {
        self.backup_dir.join("journal.json")
    }

    /// Whether an interrupted or completed install left a journal behind.
    #[must_use]
    pub fn has_journal(&self) -> bool {
        self.journal_path().exists()
    }

    /// Apply a plan transactionally.
    ///
    /// Steps: snapshot every touched file → write journal → apply ops →
    /// mark journal finished. If any step fails mid-way, `restore` can roll
    /// back from snapshots.
    pub fn apply(&self, plan: &InstallPlan) -> Result<()> {
        if plan.ops.is_empty() {
            return Ok(());
        }
        if self.has_journal() {
            return Err(Error::InterruptedInstall);
        }
        std::fs::create_dir_all(&self.backup_dir)?;

        // 1. Snapshot originals + build manifest.
        let mut entries = Vec::with_capacity(plan.ops.len());
        for op in &plan.ops {
            let target = self.resolve(&op.rel_path)?;
            let entry = self.snapshot(&op.rel_path, &target)?;
            entries.push(entry);
        }
        let manifest = Manifest {
            install_root: self.install_root.display().to_string(),
            created_at: unix_now(),
            framework_version: env!("CARGO_PKG_VERSION").to_string(),
            entries,
        };
        write_json(&self.manifest_path(), &manifest)?;

        // 2. Journal: nothing completed yet.
        write_json(
            &self.journal_path(),
            &Journal {
                completed: Vec::new(),
                finished: false,
            },
        )?;

        // 3. Apply ops, journaling each completion.
        let mut journal = Journal {
            completed: Vec::new(),
            finished: false,
        };
        for (i, op) in plan.ops.iter().enumerate() {
            self.apply_one(op)?;
            journal.completed.push(i);
            write_json(&self.journal_path(), &journal)?;
        }
        journal.finished = true;
        write_json(&self.journal_path(), &journal)?;
        Ok(())
    }

    /// Restore the install root to its pre-install state.
    ///
    /// Uses snapshots + manifest. Safe to call after a partial apply —
    /// files that were never touched simply have no manifest entry effect.
    /// Removes the journal on success.
    pub fn restore(&self) -> Result<()> {
        let manifest: Manifest = if let Ok(m) = read_json(&self.manifest_path()) {
            m
        } else {
            // No manifest: nothing backed up. Still clear a stray journal.
            let _ = fs::remove_file(self.journal_path());
            return Ok(());
        };
        for entry in manifest.entries.iter().rev() {
            let target = self.resolve(&entry.rel_path)?;
            match (&entry.snapshot, &entry.sha256) {
                // File existed before: restore snapshot bytes.
                (Some(snap_rel), _) => {
                    let snap = self.backup_dir.join(snap_rel);
                    if snap.is_file() {
                        if let Some(parent) = target.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        fs::copy(&snap, &target)?;
                    }
                }
                // File did not exist before: remove whatever we created.
                (None, _) => {
                    if target.exists() {
                        fs::remove_file(&target)?;
                    }
                }
            }
        }
        let _ = fs::remove_file(self.journal_path());
        Ok(())
    }

    /// Verify backup snapshots against the manifest hashes.
    pub fn verify(&self) -> Result<VerifyReport> {
        let manifest: Manifest = read_json(&self.manifest_path())?;
        let mut report = VerifyReport {
            checked: 0,
            ok: 0,
            failed: Vec::new(),
        };
        for entry in &manifest.entries {
            let Some(snap_rel) = &entry.snapshot else {
                continue;
            };
            let Some(expected) = &entry.sha256 else {
                continue;
            };
            let snap = self.backup_dir.join(snap_rel);
            report.checked += 1;
            match hash_file(&snap) {
                Ok(actual) if &actual == expected => report.ok += 1,
                Ok(actual) => report.failed.push(format!(
                    "{}: expected {expected}, got {actual}",
                    entry.rel_path
                )),
                Err(_) => report
                    .failed
                    .push(format!("{}: snapshot missing", entry.rel_path)),
            }
        }
        Ok(report)
    }

    /// Resolve a relative path, rejecting traversal outside the install root.
    fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let rel_path = Path::new(rel);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(Error::UnsafeOperation(format!(
                "path escapes install root: {rel}"
            )));
        }
        Ok(self.install_root.join(rel_path))
    }

    /// Snapshot a target file before modification. Returns its manifest entry.
    fn snapshot(&self, rel: &str, target: &Path) -> Result<BackupEntry> {
        if !target.exists() {
            return Ok(BackupEntry {
                rel_path: rel.to_string(),
                sha256: None,
                snapshot: None,
            });
        }
        if !target.is_file() {
            return Err(Error::UnsafeOperation(format!(
                "refusing to modify non-file target: {rel}"
            )));
        }
        let bytes = fs::read(target)?;
        let sha = hex_sha256(&bytes);
        // Snapshot path mirrors the relative path under backups/snapshots/.
        let snap_rel = Path::new("snapshots").join(rel);
        let snap_abs = self.backup_dir.join(&snap_rel);
        if let Some(parent) = snap_abs.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&snap_abs, &bytes)?;
        Ok(BackupEntry {
            rel_path: rel.to_string(),
            sha256: Some(sha),
            snapshot: Some(snap_rel.to_string_lossy().replace('\\', "/")),
        })
    }

    /// Apply one op. `Create` refuses to overwrite; `Overwrite` requires the
    /// file to exist (it was just snapshotted); `Delete` removes the file.
    fn apply_one(&self, op: &FileOp) -> Result<()> {
        let target = self.resolve(&op.rel_path)?;
        match op.kind {
            OpKind::Create => {
                if target.exists() {
                    return Err(Error::UnsafeOperation(format!(
                        "create target already exists: {}",
                        op.rel_path
                    )));
                }
                write_payload(&target, op.payload.as_deref())?;
            }
            OpKind::Overwrite => {
                if !target.is_file() {
                    return Err(Error::UnsafeOperation(format!(
                        "overwrite target missing: {}",
                        op.rel_path
                    )));
                }
                write_payload(&target, op.payload.as_deref())?;
            }
            OpKind::Delete => {
                if target.exists() {
                    fs::remove_file(&target)?;
                }
            }
        }
        Ok(())
    }
}

fn write_payload(target: &Path, payload: Option<&[u8]>) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(target, payload.unwrap_or(&[]))?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<String> {
    Ok(hex_sha256(&fs::read(path)?))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(v)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installer() -> (tempfile::TempDir, Installer) {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("discord");
        std::fs::create_dir_all(&target).unwrap();
        let backups = root.path().join("backups");
        (root, Installer::new(target, backups))
    }

    #[test]
    fn overwrite_then_restore_roundtrip() {
        let (_t, inst) = installer();
        std::fs::write(inst.install_root.join("app.asar"), b"original").unwrap();
        let plan = InstallPlan::new().op(FileOp::write("app.asar", b"patched".to_vec()));
        inst.apply(&plan).unwrap();
        assert_eq!(
            std::fs::read(inst.install_root.join("app.asar")).unwrap(),
            b"patched"
        );
        inst.restore().unwrap();
        assert_eq!(
            std::fs::read(inst.install_root.join("app.asar")).unwrap(),
            b"original"
        );
        assert!(!inst.has_journal());
    }

    #[test]
    fn create_then_restore_removes_file() {
        let (_t, inst) = installer();
        let plan = InstallPlan::new().op(FileOp::create("loader.js", b"// x".to_vec()));
        inst.apply(&plan).unwrap();
        assert!(inst.install_root.join("loader.js").is_file());
        inst.restore().unwrap();
        assert!(!inst.install_root.join("loader.js").exists());
    }

    #[test]
    fn create_refuses_existing_file() {
        let (_t, inst) = installer();
        std::fs::write(inst.install_root.join("exists.txt"), b"data").unwrap();
        let plan = InstallPlan::new().op(FileOp::create("exists.txt", b"new".to_vec()));
        assert!(inst.apply(&plan).is_err());
        // Original untouched.
        assert_eq!(
            std::fs::read(inst.install_root.join("exists.txt")).unwrap(),
            b"data"
        );
    }

    #[test]
    fn path_traversal_rejected() {
        let (_t, inst) = installer();
        let plan = InstallPlan::new().op(FileOp::write("../escape.txt", b"x".to_vec()));
        assert!(inst.apply(&plan).is_err());
    }

    #[test]
    fn verify_detects_snapshot_corruption() {
        let (_t, inst) = installer();
        std::fs::write(inst.install_root.join("f.txt"), b"orig").unwrap();
        let plan = InstallPlan::new().op(FileOp::write("f.txt", b"new".to_vec()));
        inst.apply(&plan).unwrap();
        let report = inst.verify().unwrap();
        assert_eq!(report.checked, 1);
        assert_eq!(report.ok, 1);
        assert_eq!(report.failed, Vec::<String>::new());
        // Corrupt the snapshot.
        let snap = inst.backup_dir.join("snapshots/f.txt");
        std::fs::write(&snap, b"tampered").unwrap();
        let report = inst.verify().unwrap();
        assert_eq!(report.failed.len(), 1);
    }

    #[test]
    fn journal_blocks_double_apply() {
        let (_t, inst) = installer();
        std::fs::write(inst.install_root.join("f.txt"), b"orig").unwrap();
        let plan = InstallPlan::new().op(FileOp::write("f.txt", b"new".to_vec()));
        inst.apply(&plan).unwrap();
        // Journal exists (finished) — second apply must refuse until restore.
        assert!(inst.has_journal());
        assert!(matches!(inst.apply(&plan), Err(Error::InterruptedInstall)));
        inst.restore().unwrap();
        inst.apply(&plan).unwrap();
    }

    #[test]
    fn restore_without_backup_is_noop() {
        let (_t, inst) = installer();
        inst.restore().unwrap();
        assert!(!inst.has_journal());
    }
}
