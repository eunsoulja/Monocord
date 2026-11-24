//! Framework bundles embedded into the binary at compile time.
//!
//! `build.rs` copies `dist/{main,preload,renderer}.js` into `OUT_DIR`;
//! installers deploy them into the Monocord data dir so a single exe is
//! a complete installer. When the TS bundles weren't built first, stubs
//! are embedded and `deploy_dist` refuses.

use std::path::Path;

use crate::config::ConfigPaths;
use crate::error::{Error, Result};

static MAIN_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/main.js"));
static PRELOAD_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/preload.js"));
static RENDERER_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/renderer.js"));

const STUB_MARKER: &[u8] = b"// monocord dist missing";

const FILES: &[(&str, &[u8])] = &[
    ("main.js", MAIN_JS),
    ("preload.js", PRELOAD_JS),
    ("renderer.js", RENDERER_JS),
];

/// Whether real (non-stub) bundles were embedded at compile time.
#[must_use]
pub fn bundles_embedded() -> bool {
    FILES.iter().all(|(_, b)| !b.starts_with(STUB_MARKER))
}

/// Write the embedded bundles to `<data>/dist/`.
pub fn deploy_dist(paths: &ConfigPaths) -> Result<()> {
    let dist_dir = paths.root.join("dist");
    std::fs::create_dir_all(&dist_dir)
        .map_err(|e| Error::UnsafeOperation(format!("creating {}: {e}", dist_dir.display())))?;
    for (name, bytes) in FILES {
        if bytes.starts_with(STUB_MARKER) {
            return Err(Error::UnsafeOperation(
                "installer was built without framework bundles — \
                 run `pnpm build` then rebuild"
                    .into(),
            ));
        }
        let dest = dist_dir.join(name);
        std::fs::write(&dest, bytes)
            .map_err(|e| Error::UnsafeOperation(format!("writing {}: {e}", dest.display())))?;
    }
    Ok(())
}

/// Absolute path Discord's `index.js` will require: `<data>/dist/main.js`.
#[must_use]
pub fn bootstrap_path(paths: &ConfigPaths) -> std::path::PathBuf {
    paths.root.join("dist").join("main.js")
}

/// Ensure dist is deployed and return the bootstrap path for patch plans.
pub fn ensure_bootstrap(paths: &ConfigPaths) -> Result<std::path::PathBuf> {
    deploy_dist(paths)?;
    let p = bootstrap_path(paths);
    if !Path::new(&p).is_file() {
        return Err(Error::UnsafeOperation(format!(
            "bootstrap missing after deploy: {}",
            p.display()
        )));
    }
    Ok(p)
}
