//! Monocord CLI — manage the Discord modification framework.

use std::path::PathBuf;

use anyhow::Context;
use clap::{Parser, Subcommand};
use monocord_core::{
    Channel, ConfigPaths, Installer, detect_all, install::OpKind, running_discord_processes,
};

#[derive(Parser)]
#[command(
    name = "monocord",
    version,
    about = "Monocord — Discord modification framework"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Detect Discord installations and running processes.
    Detect,
    /// Show framework status: config, installs, processes.
    Status,
    /// Print the resolved config/log/backup paths.
    Paths,
    /// Apply a file operation to a Discord install (backup first).
    Apply {
        /// Discord channel (stable|ptb|canary).
        #[arg(long)]
        channel: String,
        /// Operation: create|overwrite|delete.
        #[arg(long)]
        op: String,
        /// Path relative to the Discord app dir.
        #[arg(long)]
        file: String,
        /// Payload file on disk (required for create/overwrite).
        #[arg(long)]
        payload: Option<PathBuf>,
    },
    /// Restore a Discord install from its backup.
    Restore {
        /// Discord channel (stable|ptb|canary).
        #[arg(long)]
        channel: String,
    },
    /// Verify backup integrity (SHA-256 manifest check).
    Verify {
        /// Discord channel (stable|ptb|canary).
        #[arg(long)]
        channel: String,
    },
    /// Install the Monocord bootstrap into a Discord install.
    Install {
        /// Discord channel (stable|ptb|canary).
        #[arg(long)]
        channel: String,
        /// Overwrite a foreign patch (e.g. Vencord). Use with care.
        #[arg(long)]
        force: bool,
    },
    /// Remove Monocord from a Discord install (restores app.asar).
    Uninstall {
        /// Discord channel (stable|ptb|canary).
        #[arg(long)]
        channel: String,
    },
    /// Show who owns the Discord entry point (pristine/monocord/foreign).
    PatchStatus {
        /// Discord channel (stable|ptb|canary).
        #[arg(long)]
        channel: String,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let paths = ConfigPaths::platform().context("could not resolve platform config directory")?;
    monocord_core::log::init(&paths.logs);
    tracing::info!("monocord cli starting");

    match cli.command {
        Command::Detect => {
            cmd_detect();
            Ok(())
        }
        Command::Status => cmd_status(&paths),
        Command::Paths => {
            println!("root:    {}", paths.root.display());
            println!("config:  {}", paths.config.display());
            println!("logs:    {}", paths.logs.display());
            println!("backups: {}", paths.backups.display());
            Ok(())
        }
        Command::Apply {
            channel,
            op,
            file,
            payload,
        } => cmd_apply(&paths, &channel, &op, &file, payload),
        Command::Restore { channel } => cmd_restore(&paths, &channel),
        Command::Verify { channel } => cmd_verify(&paths, &channel),
        Command::Install { channel, force } => cmd_install(&paths, &channel, force),
        Command::Uninstall { channel } => cmd_uninstall(&paths, &channel),
        Command::PatchStatus { channel } => cmd_patch_status(&channel),
    }
}

fn channel_arg(s: &str) -> anyhow::Result<Channel> {
    match s.to_ascii_lowercase().as_str() {
        "stable" => Ok(Channel::Stable),
        "ptb" => Ok(Channel::Ptb),
        "canary" => Ok(Channel::Canary),
        other => anyhow::bail!("unknown channel '{other}' (stable|ptb|canary)"),
    }
}

fn find_install(channel: Channel) -> anyhow::Result<monocord_core::DiscordInstall> {
    detect_all()
        .into_iter()
        .find(|i| i.channel == channel)
        .with_context(|| format!("discord {channel} not detected"))
}

fn backup_dir_for(paths: &ConfigPaths, inst: &monocord_core::DiscordInstall) -> PathBuf {
    paths
        .backups
        .join(format!("{}-{}", inst.channel, inst.version))
}

fn cmd_detect() {
    let installs = detect_all();
    if installs.is_empty() {
        println!("no discord installations detected");
    }
    for i in &installs {
        println!(
            "{}: {} (dir: {})",
            i.channel,
            i.version,
            i.version_dir.display()
        );
    }
    let procs = running_discord_processes();
    if procs.is_empty() {
        println!("no discord processes running");
    }
    for p in &procs {
        println!("process: {} pid={}", p.name, p.pid);
    }
}

fn cmd_status(paths: &ConfigPaths) -> anyhow::Result<()> {
    let cfg = monocord_core::config::load(paths)?;
    println!("config version: {}", cfg.version);
    println!("preferred channel: {:?}", cfg.discord.preferred_channel);
    println!("enabled plugins: {}", cfg.plugins.enabled.len());
    println!("disabled plugins: {}", cfg.plugins.disabled.len());
    println!("active theme: {:?}", cfg.theme.active);
    println!("auto update check: {}", cfg.framework.auto_update_check);
    Ok(())
}

fn cmd_apply(
    paths: &ConfigPaths,
    channel: &str,
    op: &str,
    file: &str,
    payload: Option<PathBuf>,
) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = find_install(channel)?;
    let kind = match op {
        "create" => OpKind::Create,
        "overwrite" => OpKind::Overwrite,
        "delete" => OpKind::Delete,
        other => anyhow::bail!("unknown op '{other}' (create|overwrite|delete)"),
    };
    let payload_bytes = if kind == OpKind::Delete {
        None
    } else {
        let p = payload.context("--payload required for create/overwrite")?;
        Some(std::fs::read(&p).with_context(|| format!("reading {}", p.display()))?)
    };
    let fop = monocord_core::install::FileOp {
        kind,
        rel_path: file.to_string(),
        payload: payload_bytes,
    };
    let installer = Installer::new(inst.version_dir.clone(), backup_dir_for(paths, &inst));
    if installer.has_journal() {
        anyhow::bail!("interrupted install detected — run `monocord restore` first");
    }
    installer.apply(&monocord_core::InstallPlan::new().op(fop))?;
    println!(
        "applied {op} to {file} (backup in {})",
        installer.backup_dir.display()
    );
    Ok(())
}

fn cmd_restore(paths: &ConfigPaths, channel: &str) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = find_install(channel)?;
    let installer = Installer::new(inst.version_dir.clone(), backup_dir_for(paths, &inst));
    installer.restore()?;
    println!(
        "restored {} to pre-install state",
        inst.version_dir.display()
    );
    Ok(())
}

fn cmd_verify(paths: &ConfigPaths, channel: &str) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = find_install(channel)?;
    let installer = Installer::new(inst.version_dir.clone(), backup_dir_for(paths, &inst));
    let report = installer.verify()?;
    println!(
        "checked: {}  ok: {}  failed: {}",
        report.checked,
        report.ok,
        report.failed.len()
    );
    for f in &report.failed {
        println!("  FAIL {f}");
    }
    Ok(())
}

/// Path to the built main-process bootstrap inside the Monocord data dir.
fn bootstrap_path(paths: &ConfigPaths) -> PathBuf {
    paths.root.join("dist").join("main.js")
}

fn cmd_install(paths: &ConfigPaths, channel: &str, force: bool) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = find_install(channel)?;

    // Refuse to clobber a foreign patch unless forced.
    match monocord_core::patch::inspect(&inst.resources) {
        monocord_core::PatchState::Foreign { hint } if !force => {
            anyhow::bail!(
                "app.asar is owned by another modification ({hint}). \
                 Uninstall it first, or re-run with --force."
            );
        }
        monocord_core::PatchState::Unreadable { reason } => {
            anyhow::bail!("cannot inspect app.asar: {reason}");
        }
        _ => {}
    }

    let bootstrap = bootstrap_path(paths);
    if !bootstrap.is_file() {
        anyhow::bail!(
            "Monocord bootstrap not built: {} — run `pnpm build` first",
            bootstrap.display()
        );
    }

    let plan = monocord_core::patch::build_plan(&inst, &bootstrap)?;
    let installer = Installer::new(inst.version_dir.clone(), backup_dir_for(paths, &inst));
    if installer.has_journal() {
        anyhow::bail!("interrupted install detected — run `monocord uninstall` first");
    }
    installer.apply(&plan)?;

    // Record install state in config.
    let mut cfg = monocord_core::config::load(paths)?;
    let key = channel.to_string();
    let state = cfg.discord.installs.entry(key).or_default();
    state.applied_version = Some(env!("CARGO_PKG_VERSION").to_string());
    state.discord_version = Some(inst.version.clone());
    monocord_core::config::save(paths, &cfg)?;

    println!(
        "installed Monocord {} into {} ({}), backup in {}",
        env!("CARGO_PKG_VERSION"),
        inst.version_dir.display(),
        inst.version,
        installer.backup_dir.display()
    );
    Ok(())
}

fn cmd_uninstall(paths: &ConfigPaths, channel: &str) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = find_install(channel)?;
    let installer = Installer::new(inst.version_dir.clone(), backup_dir_for(paths, &inst));
    installer.restore()?;

    let mut cfg = monocord_core::config::load(paths)?;
    if let Some(state) = cfg.discord.installs.get_mut(&channel.to_string()) {
        state.applied_version = None;
    }
    monocord_core::config::save(paths, &cfg)?;

    println!("uninstalled Monocord from {}", inst.version_dir.display());
    Ok(())
}

fn cmd_patch_status(channel: &str) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = find_install(channel)?;
    match monocord_core::patch::inspect(&inst.resources) {
        monocord_core::PatchState::Monocord => println!("monocord"),
        monocord_core::PatchState::Pristine => println!("pristine"),
        monocord_core::PatchState::Foreign { hint } => println!("foreign: {hint}"),
        monocord_core::PatchState::Unreadable { reason } => println!("unreadable: {reason}"),
    }
    Ok(())
}
