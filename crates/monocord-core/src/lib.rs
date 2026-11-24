//! Monocord native core.
//!
//! Provides the Rust foundation for the Monocord Discord modification
//! framework: Discord installation detection, persistent configuration,
//! structured logging, and the reversible install engine that snapshots
//! and restores Discord files.

pub mod asar;
pub mod bundled;
pub mod config;
pub mod discord;
pub mod error;
pub mod install;
pub mod log;
pub mod ops;
pub mod patch;

pub use asar::{Asar, pack as asar_pack};
pub use bundled::{bundles_embedded, deploy_dist};
pub use config::{Config, ConfigPaths};
pub use discord::{
    Channel, DiscordInstall, detect_all, detect_in, restart_discord, running_discord_processes,
};
pub use error::{Error, Result};
pub use install::{FileOp, InstallPlan, Installer, OpKind, VerifyReport};
pub use ops::{backup_dir_for, find_install, install_monocord, uninstall_monocord};
pub use patch::{PatchState, build_plan, classify_entry, entry_payload, inspect as inspect_patch};
