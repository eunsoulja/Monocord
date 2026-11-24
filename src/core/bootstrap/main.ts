/**
 * Monocord main-process bootstrap.
 *
 * Loaded by `resources/app.asar`'s `index.js` instead of the stock entry.
 * Runs in Discord's main process BEFORE `_app.asar` (the bootstrapper) and
 * `discord_desktop_core` (the real client core, which creates every
 * BrowserWindow). It therefore:
 *
 *  1. Wraps `electron.BrowserWindow` so every Discord window gets Monocord's
 *     preload chained in front of its original preload.
 *  2. Registers IPC handlers backing the renderer API (settings, themes,
 *     plugin code, logging).
 *  3. Requires `_app.asar`, handing control back to stock Discord.
 *
 * If anything fails before step 3, Discord simply doesn't start — the
 * installer snapshot restores `app.asar` on uninstall.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electron = require("electron") as typeof import("electron");

const DIST_DIR = __dirname;
/** Monocord data dir = parent of dist/ (i.e. %APPDATA%/Monocord). */
const DATA_DIR = path.resolve(DIST_DIR, "..");
const SETTINGS_FILE = path.join(DATA_DIR, "renderer-settings.json");
const THEMES_DIR = path.join(DATA_DIR, "themes");
const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
const LOG_FILE = path.join(DATA_DIR, "logs", "renderer.log");
const RENDERER_FILE = path.join(DIST_DIR, "renderer.js");
const PRELOAD_FILE = path.join(DIST_DIR, "preload.js");

const log = (...args: unknown[]) => {
    const line = `[monocord] ${args.map(String).join(" ")}`;
    console.log(line);
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
    } catch {
        // logging must never crash the host
    }
};

// ---------------------------------------------------------------------------
// BrowserWindow patch
// ---------------------------------------------------------------------------

/**
 * Electron allows exactly one `webPreferences.preload` per window. To keep
 * Discord's own preload working we generate a tiny shim per unique original
 * preload that requires the original first and then ours.
 */
const shimDir = path.join(os.tmpdir(), "monocord-preloads");
const shimCache = new Map<string, string>();
let shimCounter = 0;

function preloadShimFor(originalPreload: string): string {
    const cached = shimCache.get(originalPreload);
    if (cached) return cached;
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(
        shimDir,
        `preload-${process.pid}-${shimCounter++}.js`,
    );
    const body =
        `try{require(${JSON.stringify(originalPreload)});}catch(e){` +
        `console.error("[Monocord] host preload failed:",e)}\n` +
        `try{require(${JSON.stringify(PRELOAD_FILE)});}catch(e){` +
        `console.error("[Monocord] preload failed:",e)}\n`;
    fs.writeFileSync(shimPath, body);
    shimCache.set(originalPreload, shimPath);
    return shimPath;
}

interface BrowserWindowOptions {
    webPreferences?: {
        preload?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/** The patched BrowserWindow class, set by installModuleLoadPatch. */
let PatchedBrowserWindow: (new (options?: BrowserWindowOptions) => object) | null =
    null;

function makeElectronProxy(real: Record<string, unknown>): Record<string, unknown> {
    const handler: ProxyHandler<Record<string, unknown>> = {
        get(target, prop, receiver) {
            if (prop === "BrowserWindow") return PatchedBrowserWindow;
            if (prop === "default") {
                const d = target.default;
                if (d && typeof d === "object") {
                    return makeElectronProxy(d as Record<string, unknown>);
                }
                return receiver;
            }
            return Reflect.get(target, prop, receiver);
        },
    };
    return new Proxy(real, handler);
}

const proxyCache = new WeakMap<object, Record<string, unknown>>();

function installModuleLoadPatch(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require("module") as {
        _load: (
            request: string,
            parent: unknown,
            isMain: boolean,
        ) => unknown;
    };
    const RealBW = electron.BrowserWindow as new (
        options?: BrowserWindowOptions,
    ) => object;
    if (typeof RealBW !== "function") {
        log("electron.BrowserWindow unavailable — renderer injection disabled");
        return;
    }

    class PatchedBW extends RealBW {
        constructor(options?: BrowserWindowOptions) {
            const opts = options ?? {};
            const wp = opts.webPreferences;
            log(
                `BrowserWindow ctor: preload=${wp?.preload ?? "none"} sandbox=${String(wp?.sandbox)}`,
            );
            if (wp) {
                const originalPreload =
                    typeof wp.preload === "string" && wp.preload.length > 0
                        ? wp.preload
                        : null;
                opts.webPreferences = {
                    ...wp,
                    preload: originalPreload
                        ? preloadShimFor(originalPreload)
                        : PRELOAD_FILE,
                };
            }
            super(opts);
        }
    }
    // Static members (fromId, getAllWindows, …) inherit through the
    // constructor's prototype chain.
    Object.setPrototypeOf(PatchedBW, RealBW);
    PatchedBrowserWindow = PatchedBW as new (
        options?: BrowserWindowOptions,
    ) => object;

    const originalLoad = Module._load;
    Module._load = function patchedLoad(
        this: unknown,
        request: string,
        parent: unknown,
        isMain: boolean,
    ) {
        const exp = originalLoad.call(this, request, parent, isMain);
        if (
            (request === "electron" || request === "electron/main") &&
            exp &&
            typeof exp === "object"
        ) {
            const key = exp as object;
            let proxied = proxyCache.get(key);
            if (!proxied) {
                proxied = makeElectronProxy(key as Record<string, unknown>);
                proxyCache.set(key, proxied);
            }
            return proxied;
        }
        return exp;
    };
    log("Module._load patched for electron");
}

// ---------------------------------------------------------------------------
// IPC: settings
// ---------------------------------------------------------------------------

function readSettings(): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Record<
            string,
            unknown
        >;
    } catch {
        return {};
    }
}

function writeSettings(data: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
}

function getPath(obj: unknown, pathParts: string[]): unknown {
    let cur = obj;
    for (const p of pathParts) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

function setPath(obj: Record<string, unknown>, pathParts: string[], value: unknown): void {
    let cur = obj;
    for (const p of pathParts.slice(0, -1)) {
        const next = cur[p];
        if (next === null || typeof next !== "object" || Array.isArray(next)) {
            cur[p] = {};
        }
        cur = cur[p] as Record<string, unknown>;
    }
    cur[pathParts[pathParts.length - 1]!] = value;
}

// ---------------------------------------------------------------------------
// IPC: themes & plugins (filesystem access lives here, not in the renderer)
// ---------------------------------------------------------------------------

interface ThemeManifest {
    name?: string;
    label?: string;
    authors?: string[];
}

function safeJoin(root: string, ...parts: string[]): string | null {
    const p = path.resolve(root, ...parts);
    return p === root || p.startsWith(root + path.sep) ? p : null;
}

function listThemes(): { name: string; label?: string; authors?: string[] }[] {
    const out: { name: string; label?: string; authors?: string[] }[] = [];
    let dirs: fs.Dirent[] = [];
    try {
        dirs = fs.readdirSync(THEMES_DIR, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(THEMES_DIR, d.name);
        const manifestPath = path.join(dir, "manifest.json");
        const cssPath = path.join(dir, "theme.css");
        if (!fs.existsSync(cssPath)) continue;
        let manifest: ThemeManifest = {};
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ThemeManifest;
        } catch {
            // manifest optional
        }
        out.push({
            name: manifest.name ?? d.name,
            ...(manifest.label ? { label: manifest.label } : {}),
            ...(manifest.authors ? { authors: manifest.authors } : {}),
        });
    }
    return out;
}

function getThemeCss(name: string): string | null {
    // Theme name must be a single path segment — no traversal.
    if (!/^[\w.-]+$/.test(name)) return null;
    const cssPath = safeJoin(THEMES_DIR, name, "theme.css");
    if (!cssPath || !fs.existsSync(cssPath)) return null;
    return fs.readFileSync(cssPath, "utf8");
}

interface PluginManifestInfo {
    name: string;
    version?: string;
    description?: string;
    main?: string;
}

function listPlugins(): PluginManifestInfo[] {
    const out: PluginManifestInfo[] = [];
    let dirs: fs.Dirent[] = [];
    try {
        dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const manifestPath = path.join(PLUGINS_DIR, d.name, "monocord-plugin.json");
        try {
            const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PluginManifestInfo;
            if (typeof m.name === "string") out.push(m);
        } catch {
            // skip invalid manifests
        }
    }
    return out;
}

function getPluginCode(name: string): { code: string; manifest: PluginManifestInfo } | null {
    if (!/^[\w.-]+$/.test(name)) return null;
    const dir = safeJoin(PLUGINS_DIR, name);
    if (!dir) return null;
    const manifestPath = path.join(dir, "monocord-plugin.json");
    let manifest: PluginManifestInfo;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PluginManifestInfo;
    } catch {
        return null;
    }
    const entry = typeof manifest.main === "string" ? manifest.main : "index.js";
    if (entry.includes("..") || path.isAbsolute(entry)) return null;
    const codePath = safeJoin(dir, entry);
    if (!codePath || !fs.existsSync(codePath)) return null;
    return { code: fs.readFileSync(codePath, "utf8"), manifest };
}

function registerIpc(): void {
    const { ipcMain } = electron;

    ipcMain.handle("monocord:settings-get", () => readSettings());
    ipcMain.handle("monocord:settings-save", (_e, data: Record<string, unknown>) => {
        if (data && typeof data === "object") writeSettings(data);
        return true;
    });
    ipcMain.handle("monocord:settings-set", (_e, pathStr: string, value: unknown) => {
        const data = readSettings();
        setPath(data, String(pathStr).split("."), value);
        writeSettings(data);
        return true;
    });

    ipcMain.handle("monocord:themes-list", () => listThemes());
    ipcMain.handle("monocord:theme-get", (_e, name: string) => getThemeCss(name));
    ipcMain.handle("monocord:plugins-list", () => listPlugins());
    ipcMain.handle("monocord:plugin-get", (_e, name: string) => getPluginCode(name));

    ipcMain.on("monocord:log", (_e, level: string, scope: string, message: string) => {
        log(`[${level}] ${scope}: ${message}`);
    });

    // Execute renderer code in the page's main world (preload asks us to
    // because webFrame.executeJavaScript lands in the isolated world).
    ipcMain.on("monocord:execute-js", (event, code: string) => {
        try {
            const wc = event.sender;
            void wc
                .executeJavaScript(code)
                .catch((e: unknown) => log("renderer eval rejected", e));
            log("renderer executed via webContents.executeJavaScript");
            // Probe the page a few seconds later: is the bridge visible and
            // are Discord's webpack chunks on window in this world?
            setTimeout(() => {
                wc.executeJavaScript(
                    `JSON.stringify({` +
                        `mc: typeof window.monocord !== "undefined",` +
                        `mcKeys: window.monocord ? Object.keys(window.monocord) : [],` +
                        `chunks: Object.keys(window).filter(k => k.indexOf("webpackChunk") === 0),` +
                        `href: location.href` +
                        `})`,
                )
                    .then((r: unknown) => log(`renderer probe: ${String(r)}`))
                    .catch((e: unknown) => log("renderer probe failed", e));
            }, 4000);
        } catch (e) {
            log("executeJavaScript failed", e);
        }
    });

    // Synchronous renderer-bundle fetch for the preload script.
    ipcMain.on("monocord:renderer-code", (event) => {
        try {
            event.returnValue = fs.readFileSync(RENDERER_FILE, "utf8");
        } catch (e) {
            event.returnValue = `console.error("[Monocord] renderer bundle missing: ${e}");`;
        }
    });

    ipcMain.handle("monocord:version", () => ({
        monocord: "0.1.0",
        discord: electron.app.getVersion(),
    }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

installModuleLoadPatch();
registerIpc();
log(`bootstrap loaded (data: ${DATA_DIR})`);

const appAsar = path.join(
    (process as NodeJS.Process & { resourcesPath: string }).resourcesPath,
    "_app.asar",
);
if (!fs.existsSync(appAsar)) {
    log(`FATAL: ${appAsar} not found — cannot start Discord`);
    electron.app.quit();
} else {
    log("loading Discord _app.asar");
    require(appAsar);
}
