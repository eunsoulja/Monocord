//! Monocord CLI — manage the Discord modification framework.

use std::io::{self, BufRead, IsTerminal, Write};
use std::path::PathBuf;

use anyhow::Context;
use clap::{CommandFactory, Parser, Subcommand};
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
    command: Option<Command>,
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

    let Some(command) = cli.command else {
        // No subcommand: interactive installer (Vencord-style). Falls back
        // to help output when stdin isn't a terminal.
        if io::stdin().is_terminal() {
            return cmd_interactive(&paths);
        }
        Cli::command().print_help()?;
        println!();
        return Ok(());
    };

    match command {
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
    Ok(monocord_core::find_install(channel)?)
}

fn backup_dir_for(paths: &ConfigPaths, inst: &monocord_core::DiscordInstall) -> PathBuf {
    monocord_core::backup_dir_for(paths, inst)
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

fn cmd_install(paths: &ConfigPaths, channel: &str, force: bool) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = monocord_core::find_install(channel)?;
    let backup = monocord_core::install_monocord(paths, channel, force)?;
    println!(
        "installed Monocord {} into {} ({}), backup in {}",
        monocord_core::ops::FRAMEWORK_VERSION,
        inst.version_dir.display(),
        inst.version,
        backup.display()
    );
    Ok(())
}

fn cmd_uninstall(paths: &ConfigPaths, channel: &str) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = monocord_core::find_install(channel)?;
    monocord_core::uninstall_monocord(paths, channel)?;
    println!("uninstalled Monocord from {}", inst.version_dir.display());
    Ok(())
}

fn cmd_patch_status(channel: &str) -> anyhow::Result<()> {
    let channel = channel_arg(channel)?;
    let inst = find_install(channel)?;
    match monocord_core::patch::inspect_install(&inst) {
        monocord_core::PatchState::Monocord => println!("monocord"),
        monocord_core::PatchState::Pristine => println!("pristine"),
        monocord_core::PatchState::Foreign { hint } => println!("foreign: {hint}"),
        monocord_core::PatchState::Unreadable { reason } => println!("unreadable: {reason}"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Interactive installer (no subcommand, TTY stdin)
// ---------------------------------------------------------------------------

fn patch_state_label(inst: &monocord_core::DiscordInstall) -> String {
    match monocord_core::patch::inspect_install(&inst) {
        monocord_core::PatchState::Monocord => "monocord installed".to_string(),
        monocord_core::PatchState::Pristine => "not installed".to_string(),
        monocord_core::PatchState::Foreign { hint } => format!("foreign patch ({hint})"),
        monocord_core::PatchState::Unreadable { reason } => format!("unreadable ({reason})"),
    }
}

fn prompt(msg: &str) -> String {
    print!("{msg}");
    let _ = io::stdout().flush();
    let mut line = String::new();
    if io::stdin().lock().read_line(&mut line).is_err() {
        return String::new();
    }
    line.trim().to_string()
}

fn confirm(msg: &str) -> bool {
    let answer = prompt(&format!("{msg} [y/N] "));
    answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")
}

/// Pick a Discord install interactively; returns None on cancel/quit.
fn pick_install(installs: &[monocord_core::DiscordInstall]) -> Option<Channel> {
    if installs.is_empty() {
        println!("no discord installations detected");
        return None;
    }
    if installs.len() == 1 {
        return Some(installs[0].channel);
    }
    println!("\ndetected discord installs:");
    for (i, inst) in installs.iter().enumerate() {
        println!(
            "  {}) {} {} — {}",
            i + 1,
            inst.channel,
            inst.version,
            patch_state_label(inst)
        );
    }
    loop {
        let answer = prompt(&format!("select install [1-{} or q]: ", installs.len()));
        if answer.eq_ignore_ascii_case("q") {
            return None;
        }
        if let Ok(n) = answer.parse::<usize>()
            && (1..=installs.len()).contains(&n)
        {
            return Some(installs[n - 1].channel);
        }
        println!("invalid selection");
    }
}

fn interactive_install(paths: &ConfigPaths) -> anyhow::Result<()> {
    let installs = detect_all();
    let Some(channel) = pick_install(&installs) else {
        return Ok(());
    };

    // Foreign patch → confirm overwrite.
    let inst = find_install(channel)?;
    let mut force = false;
    if let monocord_core::PatchState::Foreign { hint } =
        monocord_core::patch::inspect_install(&inst)
    {
        println!("\nwarning: app.asar is owned by another modification ({hint})");
        if !confirm("overwrite it and install Monocord?") {
            println!("aborted");
            return Ok(());
        }
        force = true;
    }

    // Discord running → warn.
    if !running_discord_processes().is_empty()
        && !confirm("discord is running — install anyway? (restart required)")
    {
        println!("aborted");
        return Ok(());
    }

    monocord_core::install_monocord(paths, channel, force)?;
    println!("\ninstalled — restarting discord…");
    let inst = monocord_core::find_install(channel)?;
    match monocord_core::restart_discord(&inst) {
        Ok(()) => println!("discord restarted"),
        Err(e) => println!("install done, but restart failed: {e} — restart discord manually"),
    }
    Ok(())
}

fn interactive_uninstall(paths: &ConfigPaths) -> anyhow::Result<()> {
    let installs = detect_all();
    let Some(channel) = pick_install(&installs) else {
        return Ok(());
    };
    if !confirm("uninstall Monocord and restore the original app.asar?") {
        println!("aborted");
        return Ok(());
    }
    monocord_core::uninstall_monocord(paths, channel)?;
    println!("\nuninstalled — restarting discord…");
    let inst = monocord_core::find_install(channel)?;
    match monocord_core::restart_discord(&inst) {
        Ok(()) => println!("discord restarted"),
        Err(e) => println!("uninstall done, but restart failed: {e} — restart discord manually"),
    }
    Ok(())
}

fn cmd_interactive(paths: &ConfigPaths) -> anyhow::Result<()> {
    println!("=== Monocord Installer v{} ===", env!("CARGO_PKG_VERSION"));
    loop {
        let installs = detect_all();
        println!("\ndetected installs: {}", installs.len());
        for inst in &installs {
            println!(
                "  {} {} — {}",
                inst.channel,
                inst.version,
                patch_state_label(inst)
            );
        }
        let procs = running_discord_processes();
        if !procs.is_empty() {
            println!("discord is running ({} process(es))", procs.len());
        }
        println!("\n  [i] install    [u] uninstall");
        println!("  [d] detect     [s] status");
        println!("  [q] quit");
        match prompt("choice: ").to_ascii_lowercase().as_str() {
            "i" => {
                if let Err(e) = interactive_install(paths) {
                    eprintln!("error: {e:#}");
                }
            }
            "u" => {
                if let Err(e) = interactive_uninstall(paths) {
                    eprintln!("error: {e:#}");
                }
            }
            "d" => cmd_detect(),
            "s" => cmd_status(paths)?,
            "q" | "" => return Ok(()),
            other => println!("unknown choice '{other}'"),
        }
    }
}
