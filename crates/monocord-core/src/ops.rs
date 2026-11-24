//! High-level install/uninstall operations shared by the CLI and the GUI
//! installer. Both front-ends funnel through these so behavior (backup
//! journaling, foreign-patch refusal, config bookkeeping) stays identical.

use std::path::PathBuf;

use crate::bundled;
use crate::config::{self, ConfigPaths};
use crate::discord::{self, Channel, DiscordInstall};
use crate::error::{Error, Result};
use crate::install::Installer;
use crate::patch::{self, PatchState};

/// Monocord framework version recorded in config on install.
pub const FRAMEWORK_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Backup directory for a Discord install: `<backups>/<channel>-<version>`.
#[must_use]
pub fn backup_dir_for(paths: &ConfigPaths, inst: &DiscordInstall) -> PathBuf {
    paths
        .backups
        .join(format!("{}-{}", inst.channel, inst.version))
}

/// Find a detected install for `channel`.
pub fn find_install(channel: Channel) -> Result<DiscordInstall> {
    discord::detect_all()
        .into_iter()
        .find(|i| i.channel == channel)
        .ok_or_else(|| Error::ChannelNotInstalled(channel.to_string()))
}

/// Install Monocord into a Discord channel. `force` permits overwriting a
/// foreign patch (e.g. Vencord). Returns the backup directory used.
pub fn install_monocord(paths: &ConfigPaths, channel: Channel, force: bool) -> Result<PathBuf> {
    let inst = find_install(channel)?;

    // Deploy embedded framework bundles, then patch app.asar.
    let bootstrap = bundled::ensure_bootstrap(paths)?;

    match patch::inspect(&inst.resources) {
        PatchState::Foreign { hint } if !force => {
            return Err(Error::UnsafeOperation(format!(
                "app.asar is owned by another modification ({hint}); \
                 uninstall it first or pass force"
            )));
        }
        PatchState::Unreadable { reason } => {
            return Err(Error::UnsafeOperation(format!(
                "cannot inspect app.asar: {reason}"
            )));
        }
        _ => {}
    }

    let plan = patch::build_plan(&inst, &bootstrap)?;
    let installer = Installer::new(inst.version_dir.clone(), backup_dir_for(paths, &inst));
    if installer.has_journal() {
        return Err(Error::InterruptedInstall);
    }
    installer.apply(&plan)?;

    let mut cfg = config::load(paths)?;
    let state = cfg.discord.installs.entry(channel.to_string()).or_default();
    state.applied_version = Some(FRAMEWORK_VERSION.to_string());
    state.discord_version = Some(inst.version.clone());
    config::save(paths, &cfg)?;

    Ok(installer.backup_dir)
}

/// Remove Monocord from a Discord channel, restoring the original app.asar.
pub fn uninstall_monocord(paths: &ConfigPaths, channel: Channel) -> Result<()> {
    let inst = find_install(channel)?;
    let installer = Installer::new(inst.version_dir.clone(), backup_dir_for(paths, &inst));
    installer.restore()?;

    let mut cfg = config::load(paths)?;
    if let Some(state) = cfg.discord.installs.get_mut(&channel.to_string()) {
        state.applied_version = None;
    }
    config::save(paths, &cfg)?;
    Ok(())
}
