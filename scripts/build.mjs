/**
 * Build all three bundles with esbuild's JS API, then sync dist/ into the
 * Monocord data dir (%APPDATA%/Monocord/dist) where `monocord install`
 * expects main.js. Repo dist/ is also kept for inspection.
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
    {
        entryPoints: ["src/core/bootstrap/main.ts"],
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: "dist/main.js",
    },
    {
        entryPoints: ["src/core/bootstrap/preload.ts"],
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: "dist/preload.js",
    },
    {
        entryPoints: ["src/renderer/index.ts"],
        bundle: true,
        platform: "browser",
        format: "iife",
        outfile: "dist/renderer.js",
    },
];

for (const opts of targets) {
    await esbuild.build({ ...opts, absWorkingDir: root, logLevel: "info" });
}

// Sync into the platform data dir.
const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const dataDist = path.join(appData, "Monocord", "dist");
fs.mkdirSync(dataDist, { recursive: true });
for (const f of ["main.js", "preload.js", "renderer.js"]) {
    fs.copyFileSync(path.join(root, "dist", f), path.join(dataDist, f));
}
console.log(`synced dist -> ${dataDist}`);
