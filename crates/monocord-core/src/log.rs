//! Structured logging: stderr for humans, rolling file for diagnostics.
//!
//! Logs live under `<config>/Monocord/logs/monocord.log` (daily rotation).
//! Credentials are never logged — callers must not pass tokens, cookies,
//! or Discord auth material to tracing macros.

use std::path::Path;
use std::sync::OnceLock;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

static INIT: OnceLock<()> = OnceLock::new();

/// Initialize the global logger with stderr + file output.
/// Safe to call multiple times (first call wins).
///
/// Honors the `MONOCORD_LOG` env filter (e.g. `MONOCORD_LOG=debug`).
pub fn init(log_dir: &Path) {
    INIT.get_or_init(|| {
        let _ = std::fs::create_dir_all(log_dir);
        let file_appender = tracing_appender::rolling::daily(log_dir, "monocord.log");
        let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
        // Leak the guard: buffered writes must flush for the process lifetime.
        // One guard per process is intentional.
        let _ = Box::leak(Box::new(guard));

        let filter =
            EnvFilter::try_from_env("MONOCORD_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

        tracing_subscriber::registry()
            .with(filter)
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::stderr)
                    .with_ansi(false),
            )
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(file_writer)
                    .with_ansi(false),
            )
            .init();
    });
}
