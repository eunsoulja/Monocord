//! Monocord native core.
//!
//! Provides the Rust foundation for the Monocord Discord modification
//! framework: Discord installation detection, persistent configuration,
//! structured logging, and the reversible install engine that snapshots
//! and restores Discord files.

pub mod asar;
pub mod config;
pub mod discord;
pub mod error;
pub mod install;
pub mod log;
pub mod patch;

pub use asar::{Asar, pack as asar_pack};
pub use config::{Config, ConfigPaths};
pub use discord::{Channel, DiscordInstall, detect_all, detect_in, running_discord_processes};
pub use error::{Error, Result};
pub use install::{FileOp, InstallPlan, Installer, OpKind, VerifyReport};
pub use patch::{PatchState, build_plan, classify_entry, entry_payload, inspect as inspect_patch};
