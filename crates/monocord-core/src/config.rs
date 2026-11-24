//! Persistent framework configuration.
//!
//! Stored as JSON at `<config_dir>/Monocord/config.json`. Writes are atomic
//! (temp file + rename). A corrupt config is preserved as `config.json.bad`
//! and defaults are returned rather than crashing or silently losing data.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::discord::Channel;
use crate::error::Result;

/// Current config schema version. Bump on breaking changes; `load` migrates.
pub const CONFIG_VERSION: u32 = 1;

/// Root configuration document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Schema version.
    pub version: u32,
    /// Discord-related settings.
    pub discord: DiscordConfig,
    /// Plugin enablement and per-plugin settings.
    pub plugins: PluginsConfig,
    /// Theme selection.
    pub theme: ThemeConfig,
    /// Framework-level settings.
    pub framework: FrameworkConfig,
}

/// Discord channel selections and per-install state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscordConfig {
    /// Preferred channel for new installs (None = auto-detect).
    pub preferred_channel: Option<Channel>,
    /// Per-channel install records keyed by channel name.
    pub installs: BTreeMap<String, InstallState>,
}

/// State tracked for one Discord installation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstallState {
    /// Monocord payload currently applied, if any.
    pub applied_version: Option<String>,
    /// Last Discord version seen at install time.
    pub discord_version: Option<String>,
    /// Whether the user has dismissed the update notice for this install.
    pub update_dismissed: bool,
}

/// Plugin manager state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginsConfig {
    /// Explicitly enabled plugin names (absent = default).
    pub enabled: Vec<String>,
    /// Explicitly disabled plugin names.
    pub disabled: Vec<String>,
    /// Per-plugin user settings, keyed by plugin name then setting key.
    pub settings: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
}

/// Theme configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThemeConfig {
    /// Active theme id (`None` = framework default / none).
    pub active: Option<String>,
    /// User custom CSS appended after the active theme.
    pub custom_css: String,
}

/// Framework-level settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameworkConfig {
    /// Check for framework updates on launch.
    pub auto_update_check: bool,
    /// Show the settings page inside Discord on startup.
    pub open_settings_on_start: bool,
    /// Developer mode: verbose plugin/patch logging.
    pub developer_mode: bool,
}

impl Default for FrameworkConfig {
    fn default() -> Self {
        Self {
            auto_update_check: true,
            open_settings_on_start: false,
            developer_mode: false,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            discord: DiscordConfig::default(),
            plugins: PluginsConfig::default(),
            theme: ThemeConfig::default(),
            framework: FrameworkConfig::default(),
        }
    }
}

/// On-disk location of the Monocord data directory.
#[derive(Debug, Clone)]
pub struct ConfigPaths {
    /// Root data dir (`<config>/Monocord` or platform equivalent).
    pub root: PathBuf,
    /// `config.json` path.
    pub config: PathBuf,
    /// Log directory.
    pub logs: PathBuf,
    /// Backup directory for install snapshots.
    pub backups: PathBuf,
}

impl ConfigPaths {
    /// Resolve paths under the platform config directory.
    #[must_use]
    pub fn platform() -> Option<Self> {
        dirs::config_dir().map(|d| Self::under(d.join("Monocord")))
    }

    /// Build paths under an explicit root (tests, portable mode).
    #[must_use]
    pub fn under(root: PathBuf) -> Self {
        Self {
            config: root.join("config.json"),
            logs: root.join("logs"),
            backups: root.join("backups"),
            root,
        }
    }
}

/// Load configuration, tolerating absence and corruption.
///
/// - Missing file → defaults.
/// - Corrupt file → renamed to `config.json.bad-<ts>` and defaults returned.
/// - Older `version` → migrated forward (currently a no-op past v1).
pub fn load(paths: &ConfigPaths) -> Result<Config> {
    if !paths.config.exists() {
        return Ok(Config::default());
    }
    let text = std::fs::read_to_string(&paths.config)?;
    match serde_json::from_str::<Config>(&text) {
        Ok(mut cfg) => {
            if cfg.version < CONFIG_VERSION {
                migrate(&mut cfg);
            }
            Ok(cfg)
        }
        Err(e) => {
            let bad = paths.config.with_extension(format!(
                "json.bad-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs())
            ));
            let _ = std::fs::rename(&paths.config, &bad);
            tracing::warn!(path = %paths.config.display(), error = %e, "corrupt config quarantined");
            Ok(Config::default())
        }
    }
}

/// Save configuration atomically (write temp, then rename).
pub fn save(paths: &ConfigPaths, cfg: &Config) -> Result<()> {
    std::fs::create_dir_all(&paths.root)?;
    let tmp = paths.config.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &paths.config)?;
    Ok(())
}

fn migrate(cfg: &mut Config) {
    cfg.version = CONFIG_VERSION;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = ConfigPaths::under(tmp.path().to_path_buf());
        let cfg = load(&paths).unwrap();
        assert_eq!(cfg.version, CONFIG_VERSION);
        assert_eq!(cfg.plugins.enabled, Vec::<String>::new());
    }

    #[test]
    fn roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = ConfigPaths::under(tmp.path().to_path_buf());
        let mut cfg = Config::default();
        cfg.plugins.enabled.push("TestPlugin".into());
        cfg.theme.custom_css = "body { }".into();
        cfg.discord.preferred_channel = Some(Channel::Ptb);
        save(&paths, &cfg).unwrap();
        let loaded = load(&paths).unwrap();
        assert_eq!(loaded.plugins.enabled, vec!["TestPlugin"]);
        assert_eq!(loaded.theme.custom_css, "body { }");
        assert_eq!(loaded.discord.preferred_channel, Some(Channel::Ptb));
    }

    #[test]
    fn corrupt_config_quarantined() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = ConfigPaths::under(tmp.path().to_path_buf());
        std::fs::create_dir_all(tmp.path()).unwrap();
        std::fs::write(&paths.config, b"{not json").unwrap();
        let cfg = load(&paths).unwrap();
        assert_eq!(cfg.version, CONFIG_VERSION);
        // Original quarantined, defaults returned.
        assert!(!paths.config.exists());
        let bads: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".bad-"))
            .collect();
        assert_eq!(bads.len(), 1);
    }
}
