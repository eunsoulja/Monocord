//! Error types for the Monocord native core.

/// Errors produced by detection, config, logging, and install operations.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An I/O operation failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// JSON (de)serialization failed.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    /// A required path does not exist or is not a directory.
    #[error("path not found: {0}")]
    NotFound(String),
    /// The target does not look like a supported Discord installation.
    #[error("not a Discord installation: {0}")]
    NotADiscordInstall(String),
    /// The requested Discord channel is not installed.
    #[error("discord channel not installed: {0}")]
    ChannelNotInstalled(String),
    /// Configuration file exists but could not be parsed.
    #[error("corrupt config at {path}: {reason}")]
    CorruptConfig {
        /// Path of the offending file.
        path: String,
        /// Human-readable parse failure.
        reason: String,
    },
    /// A file operation was refused because it would destroy data
    /// without a verified backup.
    #[error("refusing unsafe operation: {0}")]
    UnsafeOperation(String),
    /// An install journal exists from an interrupted operation.
    #[error("interrupted install detected; run restore to recover")]
    InterruptedInstall,
    /// Integrity verification failed for a backed-up file.
    #[error("integrity check failed for {path}: expected {expected}, got {actual}")]
    Integrity {
        /// File that failed verification.
        path: String,
        /// Expected SHA-256.
        expected: String,
        /// Actual SHA-256.
        actual: String,
    },
    /// A process listing / system query failed.
    #[error("system query failed: {0}")]
    System(String),
}

/// Convenience result alias.
pub type Result<T> = std::result::Result<T, Error>;
