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
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { BUILTIN_THEMES } from "./builtin-themes";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electron = require("electron") as typeof import("electron");

const DIST_DIR = __dirname;
/** Monocord data dir = parent of dist/ (i.e. %APPDATA%/Monocord). */
const DATA_DIR = path.resolve(DIST_DIR, "..");
const SETTINGS_FILE = path.join(DATA_DIR, "renderer-settings.json");
const THEMES_DIR = path.join(DATA_DIR, "themes");
const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
const LOG_FILE = path.join(DATA_DIR, "logs", "renderer.log");
const LOG_DIR = path.dirname(LOG_FILE);
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

let trackBlockHandler: ((
    details: { url: string },
    callback: (response: { cancel?: boolean }) => void,
) => void) | null = null;

const TRACKING_HOSTS = [
    "science.discord.com",
    "sentry.io",
    "ingest.sentry.io",
    "ingest.us.sentry.io",
];

function isTrackingUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname;
        return TRACKING_HOSTS.some(
            (h) => host === h || host.endsWith(`.${h}`),
        );
    } catch {
        return false;
    }
}

interface WebRequestLike {
    onBeforeRequest(
        listener:
            | ((
                  details: { url: string },
                  callback: (response: { cancel?: boolean }) => void,
              ) => void)
            | null,
    ): void;
}

function setTrackBlocking(on: boolean): void {
    const ses = (
        electron as unknown as {
            session?: { defaultSession?: { webRequest?: WebRequestLike } };
        }
    ).session?.defaultSession;
    if (!ses?.webRequest) return;
    if (on && !trackBlockHandler) {
        trackBlockHandler = (details, callback) => {
            callback({ cancel: isTrackingUrl(details.url) });
        };
        ses.webRequest.onBeforeRequest(trackBlockHandler);
        log("tracking endpoints blocked");
    } else if (!on && trackBlockHandler) {
        ses.webRequest.onBeforeRequest(null);
        trackBlockHandler = null;
        log("tracking block removed");
    }
}

let badgeOriginal: unknown = null;

function setBadgeBlocking(on: boolean): void {
    const appObj = electron.app as unknown as Record<string, unknown>;
    try {
        if (on) {
            if (badgeOriginal === null) badgeOriginal = appObj.setBadgeCount;
            appObj.setBadgeCount = () => {};
        } else if (badgeOriginal !== null) {
            appObj.setBadgeCount = badgeOriginal;
            badgeOriginal = null;
        }
        log(`taskbar badge ${on ? "blocked" : "restored"}`);
    } catch (e) {
        log(`badge block failed: ${String(e)}`);
    }
}

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
// CSP relaxation — ported from Vencord's main/csp.
//
// Discord's CSP blocks the remote assets themes need (fonts, github.io css,
// cdn images). Vencord rewrites the Content-Security-Policy response header
// on mainFrame navigations to whitelist theme hosts and allow inline
// styles/scripts. Without this, themes only partially apply.
// ---------------------------------------------------------------------------

type PolicyMap = Record<string, string[]>;

const CSP_IMAGE_CSS_SRC = ["style-src", "font-src"];
const CSP_IMAGE_AND_CSS_SRC = [
    "connect-src",
    "img-src",
    ...CSP_IMAGE_CSS_SRC,
];
const CSP_IMAGE_MEDIA_SRC = ["connect-src", "img-src", "media-src"];

const CSP_POLICIES: Record<string, string[]> = {
    "localhost:*": CSP_IMAGE_AND_CSS_SRC,
    "127.0.0.1:*": CSP_IMAGE_AND_CSS_SRC,
    "*.github.io": CSP_IMAGE_AND_CSS_SRC,
    "github.com": CSP_IMAGE_AND_CSS_SRC,
    "raw.githubusercontent.com": CSP_IMAGE_AND_CSS_SRC,
    "*.gitlab.io": CSP_IMAGE_AND_CSS_SRC,
    "gitlab.com": CSP_IMAGE_AND_CSS_SRC,
    "*.codeberg.page": CSP_IMAGE_AND_CSS_SRC,
    "codeberg.org": CSP_IMAGE_AND_CSS_SRC,
    "*.githack.com": CSP_IMAGE_AND_CSS_SRC,
    "jsdelivr.net": CSP_IMAGE_AND_CSS_SRC,
    "cdn.jsdelivr.net": [...CSP_IMAGE_AND_CSS_SRC, "script-src", "worker-src"],
    "cdnjs.cloudflare.com": [
        ...CSP_IMAGE_AND_CSS_SRC,
        "script-src",
        "worker-src",
    ],
    "fonts.googleapis.com": CSP_IMAGE_CSS_SRC,
    "fonts.gstatic.com": ["font-src"],
    "i.imgur.com": ["connect-src", "img-src"],
    "i.ibb.co": ["connect-src", "img-src"],
    "i.pinimg.com": ["connect-src", "img-src"],
    "files.catbox.moe": CSP_IMAGE_AND_CSS_SRC,
    "cdn.discordapp.com": CSP_IMAGE_AND_CSS_SRC,
    "media.discordapp.net": ["connect-src", "img-src"],
    "*.tenor.com": CSP_IMAGE_MEDIA_SRC,
    "*.tenor.co": CSP_IMAGE_MEDIA_SRC,
    "*.giphy.com": CSP_IMAGE_MEDIA_SRC,
    "translate-pa.googleapis.com": ["connect-src"],
    "icons.duckduckgo.com": ["connect-src", "img-src"],
};

const findHeader = (headers: PolicyMap, name: string): string | undefined =>
    Object.keys(headers).find((h) => h.toLowerCase() === name);

const parsePolicy = (policy: string): PolicyMap => {
    const result: PolicyMap = {};
    for (const directive of policy.split(";")) {
        const [key, ...values] = directive.trim().split(/\s+/g);
        if (key && !Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = values;
        }
    }
    return result;
};

const stringifyPolicy = (policy: PolicyMap): string =>
    Object.values(policy)
        .filter((v) => v?.length)
        .map((d) => d.flat().join(" "))
        .join("; ");

function patchCspHeaders(headers: PolicyMap): void {
    const reportOnly = findHeader(headers, "content-security-policy-report-only");
    if (reportOnly) delete headers[reportOnly];

    const header = findHeader(headers, "content-security-policy");
    if (!header) return;

    const csp = parsePolicy(headers[header]?.[0] ?? "");
    const push = (directive: string, ...values: string[]) => {
        csp[directive] ??= [...(csp["default-src"] ?? [])];
        csp[directive].push(...values);
    };

    push("style-src", "'unsafe-inline'");
    push("script-src", "'unsafe-inline'", "'unsafe-eval'");
    for (const d of [
        "style-src",
        "connect-src",
        "img-src",
        "font-src",
        "media-src",
        "worker-src",
    ]) {
        push(d, "blob:", "data:");
    }
    for (const [host, directives] of Object.entries(CSP_POLICIES)) {
        for (const d of directives) push(d, host);
    }
    headers[header] = [stringifyPolicy(csp)];
}

interface HeadersReceivedDetails {
    url: string;
    resourceType?: string;
    responseHeaders?: PolicyMap;
}

function installCspPatch(): void {
    try {
        const ses = (
            electron as unknown as {
                session?: {
                    defaultSession?: {
                        webRequest?: {
                            onHeadersReceived?: (
                                listener: (
                                    details: HeadersReceivedDetails,
                                    callback: (response: {
                                        cancel: boolean;
                                        responseHeaders: PolicyMap | undefined;
                                    }) => void,
                                ) => void,
                            ) => void;
                        };
                    };
                };
            }
        ).session?.defaultSession;
        const wr = ses?.webRequest;
        if (!wr?.onHeadersReceived) {
            log("csp patch skipped (no webRequest)");
            return;
        }
        wr.onHeadersReceived((details, callback) => {
            const headers = details.responseHeaders;
            if (headers) {
                if (details.resourceType === "mainFrame") {
                    patchCspHeaders(headers);
                }
                // raw.githubusercontent.com etc. serve css as text/plain —
                // browsers refuse to apply it without a css content type.
                if (details.resourceType === "stylesheet") {
                    const ct = findHeader(headers, "content-type");
                    if (ct) headers[ct] = ["text/css"];
                }
            }
            callback({ cancel: false, responseHeaders: headers });
        });
        log("csp patch installed");
    } catch (e) {
        // session.defaultSession can throw before app ready on some
        // Electron builds — retry once the app is up rather than dying.
        log("csp patch failed", e);
        try {
            const app = electron.app as unknown as {
                once?: (event: string, cb: () => void) => void;
            };
            app.once?.("ready", () => installCspPatch());
        } catch {
            // give up silently — Discord still starts
        }
    }
}

// ---------------------------------------------------------------------------
// IPC: themes & plugins (filesystem access lives here, not in the renderer)
// ---------------------------------------------------------------------------

interface ThemeManifest {
    name?: string;
    label?: string;
    authors?: string[];
    description?: string;
    version?: string;
    website?: string;
    invite?: string;
}

function safeJoin(root: string, ...parts: string[]): string | null {
    const p = path.resolve(root, ...parts);
    return p === root || p.startsWith(root + path.sep) ? p : null;
}

interface ThemeListEntry {
    name: string;
    label?: string | undefined;
    authors?: string[] | undefined;
    description?: string | undefined;
    version?: string | undefined;
    website?: string | undefined;
    invite?: string | undefined;
}

// Ported from Vencord's main/themes getThemeInfo — parses the BetterDiscord
// style `/** @name ... @author ... */` header block at the top of a theme.
const THEME_SPLIT_REGEX = /[^\S\r\n]*?\r?(?:\r\n|\n)[^\S\r\n]*?\*[^\S\r\n]?/;
const THEME_ESCAPED_AT = /^\\@/;

interface ThemeHeaderInfo {
    name?: string | undefined;
    label?: string | undefined;
    authors?: string[] | undefined;
    description?: string | undefined;
    version?: string | undefined;
    website?: string | undefined;
    invite?: string | undefined;
}

function parseThemeHeader(css: string, fileName: string): ThemeHeaderInfo {
    const block = css.split("/**", 2)[1]?.split("*/", 1)[0];
    if (!block) {
        return {
            name: fileName.replace(/\.css$/i, ""),
            authors: ["Unknown Author"],
        };
    }

    const header: Record<string, string> = {};
    let field = "";
    let accum = "";
    for (const line of block.split(THEME_SPLIT_REGEX)) {
        if (line.length === 0) continue;
        if (line.charAt(0) === "@" && line.charAt(1) !== " ") {
            header[field] = accum.trim();
            const l = line.indexOf(" ");
            field = line.substring(1, l);
            accum = line.substring(l + 1);
        } else {
            accum += " " + line.replace("\\n", "\n").replace(THEME_ESCAPED_AT, "@");
        }
    }
    header[field] = accum.trim();
    delete header[""];

    const author = header.author ?? "Unknown Author";
    return {
        name: header.name ?? fileName.replace(/\.css$/i, ""),
        label: header.name,
        authors: author ? [author] : undefined,
        description: header.description,
        version: header.version,
        website: header.website,
        invite: header.invite,
    };
}

function listThemes(): ThemeListEntry[] {
    const builtin = BUILTIN_THEMES.map((t) => ({
        name: t.name,
        label: t.label,
        authors: t.authors,
    }));
    const builtinNames = new Set(BUILTIN_THEMES.map((t) => t.name));
    const out: ThemeListEntry[] = [...builtin];
    const seen = new Set(builtinNames);
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(THEMES_DIR, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const d of entries) {
        // Vencord-style loose .css/.theme.css files.
        if (d.isFile() && /\.css$/i.test(d.name)) {
            const fileName = d.name;
            const themeName = fileName.replace(/\.css$/i, "");
            if (seen.has(themeName)) continue;
            seen.add(themeName);
            try {
                const css = fs.readFileSync(path.join(THEMES_DIR, fileName), "utf8");
                const info = parseThemeHeader(css, fileName);
                out.push({
                    name: themeName,
                    ...(info.name ? { label: info.name } : {}),
                    ...(info.authors ? { authors: info.authors } : {}),
                    ...(info.description ? { description: info.description } : {}),
                    ...(info.version ? { version: info.version } : {}),
                    ...(info.website ? { website: info.website } : {}),
                    ...(info.invite ? { invite: info.invite } : {}),
                });
            } catch {
                out.push({ name: themeName });
            }
            continue;
        }
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
        const themeName = manifest.name ?? d.name;
        // Disk themes may shadow a built-in of the same name.
        if (seen.has(themeName)) continue;
        seen.add(themeName);
        const entry: ThemeListEntry = {
            name: themeName,
            ...(manifest.label ? { label: manifest.label } : {}),
            ...(manifest.authors ? { authors: manifest.authors } : {}),
            ...(manifest.description ? { description: manifest.description } : {}),
            ...(manifest.version ? { version: manifest.version } : {}),
            ...(manifest.website ? { website: manifest.website } : {}),
            ...(manifest.invite ? { invite: manifest.invite } : {}),
        };
        // Fall back to the css header for metadata the manifest lacks.
        try {
            const css = fs.readFileSync(cssPath, "utf8");
            const info = parseThemeHeader(css, `${themeName}.css`);
            entry.description ??= info.description;
            entry.version ??= info.version;
            entry.website ??= info.website;
            entry.invite ??= info.invite;
            if (!entry.authors?.length && info.authors) entry.authors = info.authors;
            if (!entry.label && info.label) entry.label = info.label;
        } catch {
            // unreadable css — skip header metadata
        }
        out.push(entry);
    }
    return out;
}

function getThemeCss(name: string): string | null {
    // Theme name must be a single path segment — no traversal.
    if (!/^[\w.-]+$/.test(name)) return null;
    const dirPath = safeJoin(THEMES_DIR, name, "theme.css");
    if (dirPath && fs.existsSync(dirPath)) {
        return fs.readFileSync(dirPath, "utf8");
    }
    for (const fileName of [`${name}.css`, `${name}.theme.css`]) {
        const filePath = safeJoin(THEMES_DIR, fileName);
        if (filePath && fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, "utf8");
        }
    }
    return BUILTIN_THEMES.find((t) => t.name === name)?.css ?? null;
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

// ---------------------------------------------------------------------------
// Discord Rich Presence (local IPC pipe)
// ---------------------------------------------------------------------------
//
// Discord desktop exposes \\.\pipe\discord-ipc-0 for games to set activity.
// We speak the same framed JSON protocol: 8-byte LE header
// {opcode u32, length u32} + UTF-8 payload. Opcodes: 0 handshake,
// 1 command frame, 2 close, 3 ping, 4 pong. Discord pings clients and
// closes the socket if they don't pong — which is why the presence kept
// dying ~20s after connect (write EPIPE on the resend timer). The
// activity is attributed to the Discord application id supplied by the
// user (created in the developer portal — image assets must be uploaded
// there to render).

interface RpcConfig {
    appId: string;
    /** Prebuilt activity object (renderer-side model); falls back to flat fields. */
    activity?: Record<string, unknown> | undefined;
    details?: string | undefined;
    state?: string | undefined;
    largeImage?: string | undefined;
    largeText?: string | undefined;
    smallImage?: string | undefined;
    smallText?: string | undefined;
    elapsed?: boolean | undefined;
}

const RPC_PIPE = "\\\\.\\pipe\\discord-ipc-0";
const RPC_RESEND_MS = 20_000;
const RPC_RETRY_MS = 5_000;

let rpcConfig: RpcConfig | null = null;
let rpcSocket: net.Socket | null = null;
let rpcConnecting = false;
let rpcNonce = 0;
let rpcResendTimer: NodeJS.Timeout | null = null;
let rpcRetryTimer: NodeJS.Timeout | null = null;
let rpcBuffer = Buffer.alloc(0);

const RPC_MAX_FRAME = 1024 * 1024;

/** Write one framed message; no-op unless the socket is writable. */
function rpcSendRaw(opcode: number, body: Buffer): void {
    const sock = rpcSocket;
    if (!sock || sock.destroyed || !sock.writable) return;
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(body.length, 4);
    sock.write(Buffer.concat([header, body]));
}

function rpcSend(opcode: number, payload: unknown): void {
    rpcSendRaw(opcode, Buffer.from(JSON.stringify(payload), "utf8"));
}

/** Handle one complete inbound frame from Discord. */
function rpcHandleFrame(opcode: number, body: Buffer): void {
    if (opcode === 3) {
        // PING — Discord drops clients that don't answer.
        rpcSendRaw(4, body);
        return;
    }
    if (opcode === 2) {
        log("rpc: server sent CLOSE frame");
        rpcSocket?.destroy();
        return;
    }
    if (opcode === 1) {
        try {
            const msg = JSON.parse(body.toString("utf8")) as {
                evt?: string;
                cmd?: string;
                nonce?: string;
                data?: unknown;
            };
            const detail =
                msg.evt === "ERROR" ? ` data=${JSON.stringify(msg.data)}` : "";
            log(
                `rpc: frame evt=${msg.evt ?? "-"} cmd=${msg.cmd ?? "-"} nonce=${msg.nonce ?? "-"}${detail}`,
            );
        } catch {
            log(`rpc: frame (non-JSON, ${body.length} bytes)`);
        }
    }
}

/** Parse the byte stream into frames; Discord may split/coalesce them. */
function rpcOnData(chunk: Buffer): void {
    rpcBuffer = Buffer.concat([rpcBuffer, chunk]);
    for (;;) {
        if (rpcBuffer.length < 8) return;
        const opcode = rpcBuffer.readUInt32LE(0);
        const length = rpcBuffer.readUInt32LE(4);
        if (length > RPC_MAX_FRAME) {
            rpcBuffer = Buffer.alloc(0);
            return;
        }
        if (rpcBuffer.length < 8 + length) return;
        const body = rpcBuffer.subarray(8, 8 + length);
        rpcBuffer = rpcBuffer.subarray(8 + length);
        rpcHandleFrame(opcode, body);
    }
}

function rpcSetActivity(): void {
    const cfg = rpcConfig;
    if (!cfg?.appId) return;
    // Prefer the renderer-built activity (Vencord model) when present.
    if (cfg.activity && typeof cfg.activity === "object") {
        rpcNonce += 1;
        rpcSend(1, {
            cmd: "SET_ACTIVITY",
            args: { pid: process.pid, activity: cfg.activity },
            nonce: String(rpcNonce),
        });
        return;
    }
    const assets: Record<string, string> = {};
    if (cfg.largeImage) assets.large_image = cfg.largeImage;
    if (cfg.largeText) assets.large_text = cfg.largeText;
    if (cfg.smallImage) assets.small_image = cfg.smallImage;
    if (cfg.smallText) assets.small_text = cfg.smallText;
    const activity: Record<string, unknown> = { type: 0 };
    if (cfg.details) activity.details = cfg.details;
    if (cfg.state) activity.state = cfg.state;
    if (Object.keys(assets).length) activity.assets = assets;
    if (cfg.elapsed) activity.timestamps = { start: Math.floor(Date.now() / 1000) };
    rpcNonce += 1;
    rpcSend(1, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity },
        nonce: String(rpcNonce),
    });
}

function rpcConnect(): void {
    const cfg = rpcConfig;
    if (!cfg?.appId || rpcSocket || rpcConnecting) return;
    rpcConnecting = true;
    const sock = net.connect(RPC_PIPE);
    rpcSocket = sock;
    rpcBuffer = Buffer.alloc(0);
    sock.on("connect", () => {
        rpcConnecting = false;
        rpcSend(0, { v: 1, client_id: cfg.appId });
        rpcSetActivity();
        log(`rpc: connected to ${RPC_PIPE}`);
        if (rpcResendTimer) clearInterval(rpcResendTimer);
        rpcResendTimer = setInterval(rpcSetActivity, RPC_RESEND_MS);
        if (rpcRetryTimer) {
            clearTimeout(rpcRetryTimer);
            rpcRetryTimer = null;
        }
    });
    sock.on("data", rpcOnData);
    sock.on("error", (e) => {
        log(`rpc: socket error: ${e.message}`);
    });
    sock.on("close", () => {
        rpcSocket = null;
        rpcConnecting = false;
        rpcBuffer = Buffer.alloc(0);
        if (rpcResendTimer) {
            clearInterval(rpcResendTimer);
            rpcResendTimer = null;
        }
        // Discord may restart — retry while a config is still active.
        if (rpcConfig?.appId && !rpcRetryTimer) {
            rpcRetryTimer = setTimeout(() => {
                rpcRetryTimer = null;
                rpcConnect();
            }, RPC_RETRY_MS);
        }
    });
}

function rpcSet(cfg: unknown): void {
    if (!cfg || typeof cfg !== "object") return;
    const c = cfg as Record<string, unknown>;
    const appId = typeof c.appId === "string" ? c.appId.trim() : "";
    if (!/^\d{5,25}$/.test(appId)) {
        log("rpc: rejected — appId must be a numeric Discord application id");
        return;
    }
    const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : undefined);
    const activity =
        c.activity && typeof c.activity === "object"
            ? (c.activity as Record<string, unknown>)
            : undefined;
    rpcConfig = {
        appId,
        activity,
        details: str("details"),
        state: str("state"),
        largeImage: str("largeImage"),
        largeText: str("largeText"),
        smallImage: str("smallImage"),
        smallText: str("smallText"),
        elapsed: c.elapsed === true,
    };
    rpcConnect();
    rpcSetActivity();
}

function rpcClear(): void {
    rpcConfig = null;
    if (rpcResendTimer) {
        clearInterval(rpcResendTimer);
        rpcResendTimer = null;
    }
    if (rpcRetryTimer) {
        clearTimeout(rpcRetryTimer);
        rpcRetryTimer = null;
    }
    const sock = rpcSocket;
    rpcSocket = null;
    rpcConnecting = false;
    if (sock && !sock.destroyed) {
        // Best-effort activity clear, then hang up.
        rpcNonce += 1;
        const body = Buffer.from(
            JSON.stringify({
                cmd: "SET_ACTIVITY",
                args: { pid: process.pid, activity: {} },
                nonce: String(rpcNonce),
            }),
            "utf8",
        );
        const header = Buffer.alloc(8);
        header.writeUInt32LE(1, 0);
        header.writeUInt32LE(body.length, 4);
        sock.write(Buffer.concat([header, body]), () => sock.destroy());
    }
}

const MSGLOG_PATH = path.join(LOG_DIR, "messages.jsonl");
const MSGLOG_MAX_BYTES = 5 * 1024 * 1024;

function appendMessageLog(line: unknown): void {
    // Accepts a single JSONL string or an array of them (batched flushes).
    const lines = Array.isArray(line) ? line : [line];
    try {
        let rotated = false;
        for (const l of lines) {
            if (typeof l !== "string" || l.length === 0 || l.length > 64 * 1024) {
                continue;
            }
            if (!rotated) {
                rotated = true;
                try {
                    const stat = fs.statSync(MSGLOG_PATH);
                    if (stat.size > MSGLOG_MAX_BYTES) {
                        fs.renameSync(MSGLOG_PATH, `${MSGLOG_PATH}.1`);
                    }
                } catch {
                    // file doesn't exist yet
                }
            }
            fs.appendFileSync(MSGLOG_PATH, `${l}\n`, "utf8");
        }
    } catch (e) {
        log(`msglog write failed: ${String(e)}`);
    }
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

    ipcMain.handle("monocord:rpc-set", (_e, cfg: unknown) => {
        rpcSet(cfg);
        return true;
    });
    ipcMain.handle("monocord:rpc-clear", () => {
        rpcClear();
        return true;
    });

    ipcMain.handle("monocord:msglog", (_e, line: unknown) => {
        appendMessageLog(line);
        return true;
    });
    ipcMain.handle("monocord:track-block", (_e, on: unknown) => {
        setTrackBlocking(on === true);
        return true;
    });
    ipcMain.handle("monocord:badge-block", (_e, on: unknown) => {
        setBadgeBlocking(on === true);
        return true;
    });
    ipcMain.handle("monocord:open-external", (_e, url: unknown) => {
        if (typeof url === "string" && /^https?:\/\//.test(url)) {
            const shell = electron.shell as { openExternal(u: string): Promise<void> };
            void shell.openExternal(url);
        }
        return true;
    });

    // Renderer logs arrive via ipcRenderer.invoke — must be `handle`, not
    // `on`, or the renderer's promise never resolves and logs vanish.
    ipcMain.handle(
        "monocord:log",
        (_e, level: string, scope: string, message: string) => {
            log(`[${level}] ${scope}: ${message}`);
        },
    );

    // Execute renderer code in the page's main world (preload asks us to
    // because webFrame.executeJavaScript lands in the isolated world).
    ipcMain.on("monocord:execute-js", (event, code: string) => {
        try {
            const wc = event.sender;
            // Wrap with a boot marker so the probe can tell whether the
            // bundle evaluated, threw, or never ran.
            const wrapped =
                `try{window.__monocord_boot="evaluating";` +
                code +
                `window.__monocord_boot="evaluated";}catch(e){window.__monocord_boot="threw:"+e;}`;
            void wc
                .executeJavaScript(wrapped)
                .catch((e: unknown) => log("renderer eval rejected", e));
            log("renderer executed via webContents.executeJavaScript");
            // Probe the page a few seconds later: is the bridge visible and
            // are Discord's webpack chunks on window in this world?
            setTimeout(() => {
                wc.executeJavaScript(
                    `JSON.stringify({` +
                        `mc: typeof window.monocord !== "undefined",` +
                        `boot: window.__monocord_boot || null,` +
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
// Monocord must never be the reason Discord won't start: every optional
// subsystem is isolated so a failure degrades features, not the client.
try {
    installCspPatch();
} catch (e) {
    log("csp patch crashed", e);
}
try {
    registerIpc();
    log("ipc registered");
} catch (e) {
    log("ipc registration failed", e);
}
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
