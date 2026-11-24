//! Discord `app.asar` patching.
//!
//! Discord's Electron entry point is `resources/app.asar`, a tiny archive
//! whose `index.js` is the `main` script. Client modifications replace that
//! script with a `require()` to an external bootstrap, which installs
//! main-process hooks (BrowserWindow preload injection, IPC) and then loads
//! the real application (`_app.asar`).
//!
//! This module inspects the current `index.js`, classifies who owns it
//! (nobody / Monocord / a foreign mod like Vencord), and builds the
//! [`InstallPlan`] that swaps in Monocord's bootstrap. It refuses to
//! silently clobber a foreign patch — the user must uninstall the other
//! mod first or pass `force`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::asar::Asar;
use crate::error::{Error, Result};
use crate::install::{FileOp, InstallPlan};

/// Path of the entry script inside `app.asar`.
pub const ENTRY_FILE: &str = "index.js";
/// Path of the archive inside a Discord `resources/` dir.
pub const ARCHIVE_NAME: &str = "app.asar";

/// Who currently owns `app.asar`'s entry script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchState {
    /// Entry script is Monocord's bootstrap require.
    Monocord,
    /// Entry script shows no sign of modification.
    Pristine,
    /// Another modification framework (or unknown content) owns the entry.
    /// `hint` is a short excerpt for display.
    Foreign { hint: String },
    /// `app.asar` could not be read or parsed.
    Unreadable { reason: String },
}

/// Inspect `resources/app.asar` and classify its entry script.
#[must_use]
pub fn inspect(resources_dir: &Path) -> PatchState {
    let archive = resources_dir.join(ARCHIVE_NAME);
    let asar = match Asar::from_file(&archive) {
        Ok(a) => a,
        Err(e) => {
            return PatchState::Unreadable {
                reason: e.to_string(),
            };
        }
    };
    let index = match asar.read_file(ENTRY_FILE) {
        Ok(b) => b,
        Err(e) => {
            return PatchState::Unreadable {
                reason: e.to_string(),
            };
        }
    };
    classify_entry(&String::from_utf8_lossy(&index))
}

/// Classify entry-script content. Kept separate from IO for testing.
#[must_use]
pub fn classify_entry(content: &str) -> PatchState {
    let trimmed = content.trim();
    if trimmed.contains("Monocord") {
        return PatchState::Monocord;
    }
    // Discord's stock entry is a single require of the sibling archive.
    if trimmed.starts_with("require(")
        && trimmed.contains("_app.asar")
        && trimmed.len() < 200
        && !trimmed.contains("patcher")
    {
        return PatchState::Pristine;
    }
    PatchState::Foreign {
        hint: trimmed.chars().take(80).collect(),
    }
}

/// The `index.js` payload that loads Monocord's main-process bootstrap.
///
/// `bootstrap_path` is the absolute path to `dist/main.js` inside the
/// Monocord data dir. Forward slashes keep the generated JS portable.
#[must_use]
pub fn entry_payload(bootstrap_path: &Path) -> Vec<u8> {
    let p = bootstrap_path.to_string_lossy().replace('\\', "/");
    let quoted = serde_json::to_string(&p).unwrap_or_else(|_| "\"\"".into());
    format!("// Monocord bootstrap\nrequire({quoted});\n").into_bytes()
}

/// Build the install plan that patches `app.asar` for this Discord install.
///
/// `bootstrap_path` must point at the built `dist/main.js`. The plan is a
/// single `Overwrite` of `resources/app.asar` with the entry script swapped;
/// the installer snapshots the original archive first.
pub fn build_plan(
    install: &crate::discord::DiscordInstall,
    bootstrap_path: &Path,
) -> Result<InstallPlan> {
    let archive_path = install.resources.join(ARCHIVE_NAME);
    let asar = Asar::from_file(&archive_path).map_err(|e| {
        Error::UnsafeOperation(format!("cannot read {}: {e}", archive_path.display()))
    })?;
    if !asar.contains(ENTRY_FILE) {
        return Err(Error::NotADiscordInstall(format!(
            "{} has no {ENTRY_FILE}",
            archive_path.display()
        )));
    }
    let mut replacements = BTreeMap::new();
    replacements.insert(ENTRY_FILE.to_string(), entry_payload(bootstrap_path));
    let repacked = asar
        .repack_with(&replacements)
        .map_err(|e| Error::UnsafeOperation(format!("asar repack failed: {e}")))?;
    Ok(InstallPlan::new().op(FileOp::write(format!("resources/{ARCHIVE_NAME}"), repacked)))
}

/// Convenience: absolute path Discord's resources dir for an install.
#[must_use]
pub fn resources_dir(version_dir: &Path) -> PathBuf {
    version_dir.join("resources")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_monocord() {
        assert_eq!(
            classify_entry("// Monocord bootstrap\nrequire(\"C:/x/main.js\");\n"),
            PatchState::Monocord
        );
    }

    #[test]
    fn classifies_pristine() {
        assert_eq!(
            classify_entry("require(\"./_app.asar\");"),
            PatchState::Pristine
        );
    }

    #[test]
    fn classifies_vencord_as_foreign() {
        match classify_entry("require(\"C:\\\\Users\\\\x\\\\Vencord\\\\dist\\\\patcher.js\");") {
            PatchState::Foreign { hint } => assert!(hint.contains("Vencord")),
            other => panic!("expected foreign, got {other:?}"),
        }
    }

    #[test]
    fn classifies_unknown_as_foreign() {
        match classify_entry("eval(Buffer.from('...','base64').toString())") {
            PatchState::Foreign { .. } => {}
            other => panic!("expected foreign, got {other:?}"),
        }
    }

    #[test]
    fn entry_payload_is_valid_js_require() {
        let p = PathBuf::from("C:\\Users\\eunso\\AppData\\Roaming\\Monocord\\dist\\main.js");
        let payload = entry_payload(&p);
        let text = String::from_utf8(payload).unwrap();
        assert!(text.contains("Monocord"));
        assert!(text.contains("require(\"C:/Users/eunso/AppData/Roaming/Monocord/dist/main.js\")"));
        // Must not contain unescaped backslashes.
        assert!(!text.contains("\\\\"));
    }

    #[test]
    fn build_plan_rewrites_only_entry() {
        // Synthetic app.asar with index.js + package.json.
        let mut files = BTreeMap::new();
        files.insert(
            "index.js".to_string(),
            b"require(\"./_app.asar\");".to_vec(),
        );
        files.insert(
            "package.json".to_string(),
            br#"{"name":"discord","main":"index.js"}"#.to_vec(),
        );
        let asar_bytes = crate::asar::pack(&files);

        let tmp = tempfile::tempdir().unwrap();
        let vdir = tmp.path().join("app-9.9.9");
        let resources = vdir.join("resources");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(resources.join("app.asar"), &asar_bytes).unwrap();
        std::fs::write(vdir.join("Discord.exe"), b"x").unwrap();
        std::fs::write(
            resources.join("build_info.json"),
            r#"{"version":"9.9.9","releaseChannel":"stable"}"#,
        )
        .unwrap();

        let inst = crate::discord::detect_in(tmp.path(), crate::discord::Channel::Stable).unwrap();
        let bootstrap = tmp.path().join("monocord").join("main.js");
        let plan = build_plan(&inst, &bootstrap).unwrap();
        assert_eq!(plan.ops.len(), 1);
        assert_eq!(plan.ops[0].rel_path, "resources/app.asar");

        // Simulate apply: write payload, re-parse, verify entry swapped.
        let payload = plan.ops[0].payload.clone().unwrap();
        let new_asar = Asar::parse(&payload).unwrap();
        let index = String::from_utf8(new_asar.read_file("index.js").unwrap()).unwrap();
        assert_eq!(classify_entry(&index), PatchState::Monocord);
        // Untouched file survives repack.
        assert!(new_asar.contains("package.json"));
    }
}
