# Monocord

A Vencord-inspired Discord client modification framework: a Rust native core
handles installation, detection, configuration, and reversible file
operations, while a TypeScript layer provides the webpack finder, patcher,
plugin system, theme engine, and Discord-facing bootstrap.

## Status

**Milestone 2 — TypeScript modification layer.** Implemented and unit-tested:

- `asar` reader/writer + `app.asar` patch planner (Rust)
- `install` / `uninstall` / `patch-status` CLI commands with foreign-mod
  detection (refuses to clobber e.g. Vencord without `--force`)
- Webpack module discovery (`find`, `findAll`, `findByProps`,
  `findByDisplayName`, `findStore`)
- Reversible patcher (`before`/`after`/`instead`, per-plugin `unpatchAll`,
  correct middle-of-stack removal)
- Plugin manager (lifecycle, dependencies, error isolation, scoped events)
- Settings store (IPC-backed persistence), theme engine (CSS injection),
  typed event bus, logger
- Main-process bootstrap (`BrowserWindow` preload injection + IPC) and
  renderer entry; 3 example plugins

Not yet done: settings UI inside Discord, updater, diagnostics page,
napi-rs bridge, live verification inside Discord.

## Layout

```text
Monocord/
├── Cargo.toml                  # Rust workspace
├── crates/
│   ├── monocord-core/          # detection, config, logging, asar, install engine
│   └── monocord-cli/           # `monocord` CLI
├── src/
│   ├── core/
│   │   ├── bootstrap/          # main.ts (node), preload.ts
│   │   ├── webpack/            # module discovery
│   │   ├── patcher/            # reversible patching
│   │   ├── plugins/            # plugin manager + manifest validation
│   │   ├── events.ts / settings.ts / themes.ts / logger.ts / api.ts
│   ├── plugins/examples/       # 3 example plugins
│   └── renderer/index.ts       # renderer entry
├── tests/                      # vitest suite (37 tests)
├── scripts/build.mjs           # esbuild → dist/ + sync to %APPDATA%/Monocord/dist
└── package.json / pnpm-workspace.yaml / tsconfig.json
```

## Building

```sh
cargo build --workspace                     # Rust CLI + core
cargo test --workspace                      # Rust unit tests
corepack pnpm install                       # TS deps (esbuild, vitest, tsc)
corepack pnpm typecheck                     # strict TS check
corepack pnpm test                          # vitest
node scripts/build.mjs                      # bundles → dist/ + %APPDATA%/Monocord/dist
```

## CLI

```sh
monocord detect        # Discord installs + running processes
monocord status        # config summary
monocord paths         # config/log/backup locations
monocord patch-status --channel stable   # who owns app.asar (pristine|monocord|foreign)
monocord install --channel stable        # patch app.asar (backs up first)
monocord install --channel stable --force  # overwrite a foreign patch
monocord uninstall --channel stable      # restore app.asar
monocord apply/restore/verify            # low-level file ops
```

## How injection works (verified on Discord 1.0.9269)

1. `resources/app.asar` is the Electron entry; its `index.js` is replaced
   with `require("<Monocord data dir>/dist/main.js")`.
2. `main.js` wraps `electron.BrowserWindow` (chaining each window's original
   preload with `dist/preload.js` via generated shim files), registers IPC
   handlers, then requires `resources/_app.asar`.
3. `_app.asar` bootstraps and loads `modules/discord_desktop_core-*/core.asar`,
   which creates all windows — every one gets the Monocord preload.
4. The preload exposes `window.monocord` (IPC bridge) and executes
   `dist/renderer.js` in the page's main world via `webFrame.executeJavaScript`.
5. The renderer captures `__webpack_require__` by pushing a probe chunk onto
   the `webpackChunk*` globals, then runs plugins/themes.

Only `resources/app.asar` is modified inside the Discord directory; all
Monocord payloads live in `%APPDATA%/Monocord/`. Uninstall restores the
snapshotted archive byte-for-byte.

## Install safety model

`monocord-core::install::Installer` applies `InstallPlan`s transactionally:
every touched file is snapshotted (with a SHA-256 manifest) before any write,
a JSON journal tracks progress for crash recovery, and `restore` rolls back
to the pre-install state. Paths are confined to the Discord app directory —
traversal outside it is rejected. `patch::inspect` refuses to overwrite a
foreign `app.asar` entry (e.g. Vencord) without `--force`.
