//! Monocord Installer — native GUI frontend.
//!
//! Lists detected Discord installs, shows who owns `app.asar`, and runs
//! install/uninstall through `monocord-core`'s shared ops (same backup,
//! journaling, and foreign-patch rules as the CLI). Optionally restarts
//! Discord automatically after a successful operation.

use std::sync::mpsc::{Receiver, Sender, channel};

use eframe::egui;
use monocord_core::{self as mc, Channel, DiscordInstall, PatchState};

/// Messages from worker threads back to the UI.
enum Msg {
    Log(String),
    /// An install/uninstall finished — refresh state.
    Finished,
}

struct InstallerApp {
    paths: mc::ConfigPaths,
    installs: Vec<DiscordInstall>,
    patch_states: Vec<PatchState>,
    discord_running: bool,
    restart_after: bool,
    busy: bool,
    logs: Vec<String>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
}

impl InstallerApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let paths =
            mc::ConfigPaths::platform().expect("could not resolve platform config directory");
        mc::log::init(&paths.logs);
        let (tx, rx) = channel();
        let mut app = Self {
            paths,
            installs: Vec::new(),
            patch_states: Vec::new(),
            discord_running: false,
            restart_after: true,
            busy: false,
            logs: vec![format!(
                "Monocord installer v{}",
                mc::ops::FRAMEWORK_VERSION
            )],
            tx,
            rx,
        };
        app.refresh();
        cc.egui_ctx.request_repaint();
        app
    }

    fn refresh(&mut self) {
        self.installs = mc::detect_all();
        self.patch_states = self
            .installs
            .iter()
            .map(|i| mc::patch::inspect(&i.resources))
            .collect();
        self.discord_running = !mc::running_discord_processes().is_empty();
    }

    fn spawn_op(&mut self, channel: Channel, uninstall: bool) {
        if self.busy {
            return;
        }
        self.busy = true;
        let paths = self.paths.clone();
        let restart = self.restart_after;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let result = if uninstall {
                mc::uninstall_monocord(&paths, channel)
            } else {
                mc::install_monocord(&paths, channel, false).map(|_| ())
            };
            match result {
                Ok(()) => {
                    let _ = tx.send(Msg::Log(format!(
                        "{} {} succeeded",
                        if uninstall { "uninstall" } else { "install" },
                        channel
                    )));
                    if restart {
                        match mc::find_install(channel).and_then(|inst| mc::restart_discord(&inst))
                        {
                            Ok(()) => {
                                let _ = tx.send(Msg::Log("discord restarted".into()));
                            }
                            Err(e) => {
                                let _ = tx.send(Msg::Log(format!(
                                    "restart failed: {e} — restart discord manually"
                                )));
                            }
                        }
                    }
                    let _ = tx.send(Msg::Finished);
                }
                Err(e) => {
                    let msg = format!("{e:#}");
                    let _ = tx.send(Msg::Log(format!("error: {msg}")));
                    let _ = tx.send(Msg::Finished);
                }
            }
        });
    }

    fn state_label(state: &PatchState) -> (&'static str, egui::Color32) {
        match state {
            PatchState::Monocord => ("Monocord installed", egui::Color32::from_rgb(35, 165, 90)),
            PatchState::Pristine => ("Not installed", egui::Color32::from_rgb(148, 155, 164)),
            PatchState::Foreign { .. } => (
                "Foreign patch — will need force",
                egui::Color32::from_rgb(242, 63, 67),
            ),
            PatchState::Unreadable { .. } => {
                ("Unreadable app.asar", egui::Color32::from_rgb(242, 63, 67))
            }
        }
    }
}

impl eframe::App for InstallerApp {
    #[allow(clippy::too_many_lines)]
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Drain worker messages.
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Msg::Log(line) => {
                    self.logs.push(line);
                    if self.logs.len() > 200 {
                        self.logs.remove(0);
                    }
                }
                Msg::Finished => {
                    self.busy = false;
                    self.refresh();
                }
            }
        }
        if self.busy {
            ui.ctx()
                .request_repaint_after(std::time::Duration::from_millis(100));
        }

        egui::Panel::top("header").show(ui, |ui| {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.heading("Monocord Installer");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(format!("v{}", mc::ops::FRAMEWORK_VERSION));
                });
            });
            ui.add_space(4.0);
        });

        egui::Panel::bottom("log").show(ui, |ui| {
            ui.separator();
            egui::ScrollArea::vertical()
                .stick_to_bottom(true)
                .max_height(140.0)
                .show(ui, |ui| {
                    for line in &self.logs {
                        ui.monospace(line);
                    }
                });
        });

        egui::CentralPanel::default_margins().show(ui, |ui| {
            ui.add_space(8.0);
            if self.discord_running {
                ui.colored_label(
                    egui::Color32::from_rgb(240, 179, 70),
                    "Discord is running — it will be restarted after install/uninstall.",
                );
                ui.add_space(4.0);
            }

            if self.installs.is_empty() {
                ui.label("No Discord installations detected.");
                ui.add_space(4.0);
                if ui.button("Rescan").clicked() {
                    self.refresh();
                }
                return;
            }

            ui.checkbox(&mut self.restart_after, "Restart Discord automatically");
            ui.add_space(8.0);

            let installs = self.installs.clone();
            let patch_states = self.patch_states.clone();
            for (idx, inst) in installs.iter().enumerate() {
                let state = &patch_states[idx];
                let (label, color) = Self::state_label(state);
                egui::Frame::group(ui.style()).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.strong(format!(
                                "{} — Discord {}",
                                match inst.channel {
                                    Channel::Stable => "Stable",
                                    Channel::Ptb => "PTB",
                                    Channel::Canary => "Canary",
                                },
                                inst.version
                            ));
                            ui.small(inst.version_dir.display().to_string());
                            ui.colored_label(color, label);
                            if let PatchState::Foreign { hint } = state {
                                ui.colored_label(
                                    egui::Color32::from_rgb(240, 179, 70),
                                    format!("owned by: {hint}"),
                                );
                            }
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let installed = matches!(state, PatchState::Monocord);
                            ui.add_enabled_ui(!self.busy, |ui| {
                                if installed {
                                    if ui.button("Uninstall").clicked() {
                                        self.spawn_op(inst.channel, true);
                                    }
                                } else {
                                    let btn = if matches!(state, PatchState::Foreign { .. }) {
                                        "Install anyway"
                                    } else {
                                        "Install"
                                    };
                                    if ui.button(btn).clicked() {
                                        self.spawn_op(inst.channel, false);
                                    }
                                }
                                if ui.button("Restart Discord").clicked() {
                                    let channel = inst.channel;
                                    let tx = self.tx.clone();
                                    std::thread::spawn(move || {
                                        match mc::find_install(channel)
                                            .and_then(|i| mc::restart_discord(&i))
                                        {
                                            Ok(()) => {
                                                let _ =
                                                    tx.send(Msg::Log("discord restarted".into()));
                                            }
                                            Err(e) => {
                                                let _ = tx
                                                    .send(Msg::Log(format!("restart failed: {e}")));
                                            }
                                        }
                                    });
                                }
                            });
                        });
                    });
                });
                ui.add_space(6.0);
            }

            ui.add_space(4.0);
            if ui.button("Rescan").clicked() {
                self.refresh();
            }
        });
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Monocord Installer")
            .with_inner_size([560.0, 480.0])
            .with_min_inner_size([480.0, 360.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Monocord Installer",
        options,
        Box::new(|cc| Ok(Box::new(InstallerApp::new(cc)))),
    )
}
