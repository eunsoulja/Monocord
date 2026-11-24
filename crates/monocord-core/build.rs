//! Embed the built renderer bundles (`dist/*.js`) into dependent binaries.
//!
//! Run `pnpm build` before `cargo build` so installers carry the current
//! framework code. Missing/empty bundles degrade to a stub so the crate
//! still compiles — install then refuses rather than bricking Discord.

use std::env;
use std::fs;
use std::path::PathBuf;

const BUNDLES: [&str; 3] = ["main.js", "preload.js", "renderer.js"];
const STUB: &[u8] = b"// monocord dist missing - run `pnpm build` before building\n";

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist");

    for name in BUNDLES {
        let src = dist.join(name);
        let out_path = out_dir.join(name);
        match fs::read(&src) {
            Ok(bytes) if !bytes.is_empty() => {
                println!("cargo:rerun-if-changed={}", src.display());
                fs::write(&out_path, bytes).expect("write embedded bundle");
            }
            _ => {
                println!(
                    "cargo:warning=dist/{name} missing or empty - installers will refuse until `pnpm build` is run"
                );
                fs::write(&out_path, STUB).expect("write stub bundle");
            }
        }
    }
}
