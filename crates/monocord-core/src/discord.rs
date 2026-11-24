//! Discord desktop installation detection.
//!
//! Discord ships per-user via Squirrel: a stable root directory
//! (`%LOCALAPPDATA%\Discord`, `DiscordPTB`, `DiscordCanary`) containing
//! versioned `app-*` directories. Each version directory holds `Discord.exe`
//! and `resources\` with `app.asar`, `_app.asar`, `build_info.json`, and a
//! `bootstrap\` folder.
//!
//! Detection is deliberately path-driven so it can be tested against
//! synthetic directory trees without a real Discord install.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{Error, Result};

/// Discord release channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// Stable (`Discord`).
    Stable,
    /// Public Test Build (`DiscordPTB`).
    Ptb,
    /// Canary (`DiscordCanary`).
    Canary,
}

impl Channel {
    /// All known channels, in display order.
    pub const ALL: [Self; 3] = [Self::Stable, Self::Ptb, Self::Canary];

    /// Directory name under the local app-data root.
    #[must_use]
    pub fn dir_name(self) -> &'static str {
        match self {
            Self::Stable => "Discord",
            Self::Ptb => "DiscordPTB",
            Self::Canary => "DiscordCanary",
        }
    }

    /// Executable file name inside each `app-*` directory.
    #[must_use]
    pub fn exe_name(self) -> &'static str {
        match self {
            Self::Stable => "Discord.exe",
            Self::Ptb => "DiscordPTB.exe",
            Self::Canary => "DiscordCanary.exe",
        }
    }

    /// Parse a channel from its directory name.
    #[must_use]
    pub fn from_dir_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.dir_name() == name)
    }
}

impl std::fmt::Display for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Stable => "stable",
            Self::Ptb => "ptb",
            Self::Canary => "canary",
        })
    }
}

/// A detected Discord installation.
#[derive(Debug, Clone)]
pub struct DiscordInstall {
    /// Release channel.
    pub channel: Channel,
    /// Channel root, e.g. `%LOCALAPPDATA%\Discord`.
    pub root: PathBuf,
    /// Active version directory, e.g. `app-1.0.9269`.
    pub version_dir: PathBuf,
    /// Path to the channel executable.
    pub exe: PathBuf,
    /// `resources/` directory inside the version dir.
    pub resources: PathBuf,
    /// Discord version string (e.g. `1.0.9269`).
    pub version: String,
    /// Release channel string reported by `build_info.json`.
    pub release_channel: String,
}

/// `resources/build_info.json` — authoritative version metadata.
#[derive(Debug, Deserialize)]
struct BuildInfo {
    version: Option<String>,
    #[serde(rename = "releaseChannel")]
    release_channel: Option<String>,
}

/// A running Discord-related process.
#[derive(Debug, Clone)]
pub struct DiscordProcess {
    /// Process name (e.g. `Discord.exe`).
    pub name: String,
    /// Operating system pid.
    pub pid: u32,
}

/// Detect all Discord installations under the local app-data directory.
#[must_use]
pub fn detect_all() -> Vec<DiscordInstall> {
    let Some(local) = dirs::data_local_dir() else {
        return Vec::new();
    };
    Channel::ALL
        .iter()
        .filter_map(|c| detect_in(&local.join(c.dir_name()), *c).ok())
        .collect()
}

/// Detect a single channel under an explicit root (testable).
///
/// `root` is the channel directory itself (e.g. `...\Discord`), not its parent.
pub fn detect_in(root: &Path, channel: Channel) -> Result<DiscordInstall> {
    if !root.is_dir() {
        return Err(Error::NotFound(root.display().to_string()));
    }
    let version_dir = pick_version_dir(root)?;
    let exe = version_dir.join(channel.exe_name());
    if !exe.is_file() {
        return Err(Error::NotADiscordInstall(format!(
            "missing {} in {}",
            channel.exe_name(),
            version_dir.display()
        )));
    }
    let resources = version_dir.join("resources");
    if !resources.is_dir() {
        return Err(Error::NotADiscordInstall(format!(
            "missing resources dir in {}",
            version_dir.display()
        )));
    }
    let (version, release_channel) = read_build_info(&resources.join("build_info.json"))
        .unwrap_or_else(|_| (dir_version(&version_dir), channel.to_string()));
    Ok(DiscordInstall {
        channel,
        root: root.to_path_buf(),
        version_dir,
        exe,
        resources,
        version,
        release_channel,
    })
}

/// List running processes whose image name matches a Discord channel exe.
#[must_use]
pub fn running_discord_processes() -> Vec<DiscordProcess> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let names: Vec<&str> = Channel::ALL.iter().map(|c| c.exe_name()).collect();
    sys.processes()
        .values()
        .filter(|p| {
            p.name()
                .to_str()
                .is_some_and(|n| names.iter().any(|want| n.eq_ignore_ascii_case(want)))
        })
        .map(|p| DiscordProcess {
            name: p.name().to_string_lossy().into_owned(),
            pid: p.pid().as_u32(),
        })
        .collect()
}

/// Pick the newest `app-*` version directory under a channel root.
fn pick_version_dir(root: &Path) -> Result<PathBuf> {
    let mut candidates: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix("app-") else {
            continue;
        };
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            candidates.push((parse_version(rest), entry.path()));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates
        .into_iter()
        .next()
        .map(|(_, p)| p)
        .ok_or_else(|| Error::NotADiscordInstall(root.display().to_string()))
}

/// Parse `1.0.9269` (or `app-` suffix variants) into comparable parts.
fn parse_version(s: &str) -> Vec<u64> {
    s.split(['.', '-', '_'])
        .filter_map(|p| p.parse::<u64>().ok())
        .collect()
}

/// Extract the version from an `app-X.Y.Z` directory name.
fn dir_version(dir: &Path) -> String {
    dir.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("app-"))
        .unwrap_or("unknown")
        .to_string()
}

fn read_build_info(path: &Path) -> Result<(String, String)> {
    let text = std::fs::read_to_string(path)?;
    let info: BuildInfo = serde_json::from_str(&text)?;
    Ok((
        info.version.unwrap_or_else(|| "unknown".into()),
        info.release_channel.unwrap_or_else(|| "unknown".into()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a fake Discord install tree under `root`.
    fn fake_install(root: &Path, channel: Channel, version: &str) {
        let vdir = root.join(format!("app-{version}"));
        std::fs::create_dir_all(vdir.join("resources")).unwrap();
        std::fs::write(vdir.join(channel.exe_name()), b"fake-exe").unwrap();
        std::fs::write(vdir.join("resources").join("app.asar"), b"asar").unwrap();
        std::fs::write(
            vdir.join("resources").join("build_info.json"),
            format!(r#"{{"releaseChannel":"{channel}","version":"{version}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn detects_stable_install() {
        let tmp = tempfile::tempdir().unwrap();
        fake_install(tmp.path(), Channel::Stable, "1.0.9269");
        let inst = detect_in(tmp.path(), Channel::Stable).unwrap();
        assert_eq!(inst.version, "1.0.9269");
        assert_eq!(inst.channel, Channel::Stable);
        assert!(inst.exe.is_file());
        assert!(inst.resources.is_dir());
    }

    #[test]
    fn picks_newest_version_dir() {
        let tmp = tempfile::tempdir().unwrap();
        fake_install(tmp.path(), Channel::Stable, "1.0.9000");
        fake_install(tmp.path(), Channel::Stable, "1.0.9269");
        fake_install(tmp.path(), Channel::Stable, "1.1.0");
        let inst = detect_in(tmp.path(), Channel::Stable).unwrap();
        assert_eq!(inst.version, "1.1.0");
    }

    #[test]
    fn rejects_non_discord_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("app-1.0.1")).unwrap();
        assert!(detect_in(tmp.path(), Channel::Stable).is_err());
    }

    #[test]
    fn channel_names_roundtrip() {
        for c in Channel::ALL {
            assert_eq!(Channel::from_dir_name(c.dir_name()), Some(c));
        }
        assert_eq!(Channel::from_dir_name("Nope"), None);
    }
}
