/**
 * CustomRPC — sets a Discord Rich Presence activity, modeled after
 * Vencord's CustomRPC plugin.
 *
 * Primary path: dispatch `LOCAL_ACTIVITY_UPDATE` through Discord's flux
 * dispatcher (the same mechanism games/Spotify use). Fallback: the desktop
 * IPC pipe (`monocord:rpc-set` / `rpc-clear`) in the main process, which
 * only supports a subset of fields (no buttons/metadata).
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin, PluginSettingsViewContext } from "../core/types";
import { h, useState } from "../ui/react";
import { findDispatcher, findStoreByName, type Dispatcher } from "./mods";

const log = Logger.get("custom-rpc");

interface Bridge {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function bridge(): Bridge | null {
    return (window as { monocord?: Bridge }).monocord ?? null;
}

const KEY = "plugins.settings.CustomRPC.";
const k = (key: string) => `${KEY}${key}`;

const ACTIVITY_TYPES = [
    { label: "Playing", value: "0" },
    { label: "Streaming", value: "1" },
    { label: "Listening", value: "2" },
    { label: "Watching", value: "3" },
    { label: "Competing", value: "6" },
] as const;

const TIMESTAMP_MODES = [
    { label: "None", value: "none" },
    { label: "Now (elapsed)", value: "now" },
    { label: "Time since midnight", value: "time" },
    { label: "Custom start/end", value: "custom" },
] as const;

/** Discord external-asset prefixes (Rich Presence docs). */
const ASSET_PREFIXES = /^(?:gif|mp4|youtube|twitch|spotify|external|url):/i;

/**
 * Normalize an image field for Discord: pass asset keys and pre-prefixed
 * values through untouched, and wrap direct http(s) URLs as
 * `mp:external/<url>` — Discord's documented form for external activity
 * assets (what fetchAssetIds would resolve them to anyway).
 */
function assetValue(raw: string): string {
    const v = raw.trim();
    if (!v || ASSET_PREFIXES.test(v)) return v;
    if (/^https?:\/\//i.test(v)) return `mp:external/${v}`;
    return v;
}

/** Strip a known external-asset prefix for preview rendering. */
function previewAssetUrl(v: string): string {
    return v
        .replace(/^mp:external\//i, "")
        .replace(/^(?:gif|mp4|youtube|twitch|spotify|external|url):/i, "");
}

type FetchAssetIds = (appId: string, keys: string[]) => Promise<string[]>;

let assetUtilsTried = false;
let fetchAssetIds: FetchAssetIds | null = null;
let assetUtilsWarned = false;
const loggedAssets = new Set<string>();

function logAsset(msg: string): void {
    if (loggedAssets.has(msg)) return;
    loggedAssets.add(msg);
    log.info(msg);
}

/**
 * Locate Discord's ApplicationAssetUtils module (mangled exports) and pull
 * out `fetchAssetIds` — the function Vencord uses to turn an image key or
 * URL into the asset id Discord's servers accept. Without this step the
 * presence renders locally but is dropped when broadcast to other clients.
 */
function findFetchAssetIds(): FetchAssetIds | null {
    if (fetchAssetIds) return fetchAssetIds;
    if (assetUtilsTried) return null;
    assetUtilsTried = true;
    try {
        const mods = Api.Webpack.findAllByCode("getAssetImage: size must === [");
        logAsset(`asset utils: ${mods.length} candidate module(s)`);
        // Collect candidate objects: the exports themselves, .default,
        // and one level of nested export objects (rspack namespaces).
        const candidates: Record<string, unknown>[] = [];
        const push = (v: unknown) => {
            if (v && typeof v === "object") {
                candidates.push(v as Record<string, unknown>);
            }
        };
        for (const mod of mods) {
            push(mod);
            const m = mod as Record<string, unknown>;
            push(m.default);
            for (const v of Object.values(m)) push(v);
            const d = m.default as Record<string, unknown> | undefined;
            if (d) for (const v of Object.values(d)) push(v);
        }
        for (const c of candidates) {
            for (const v of Object.values(c)) {
                if (typeof v !== "function") continue;
                const src = Function.prototype.toString.call(v);
                // Vencord's filter for fetchAssetIds: startsWith("http:") + dispatch(
                if (/startsWith\(["'`]http:/.test(src) && src.includes("dispatch(")) {
                    fetchAssetIds = v as FetchAssetIds;
                    logAsset("asset utils found — image keys will be resolved");
                    return fetchAssetIds;
                }
            }
        }
        logAsset("asset utils: fetchAssetIds not found in candidates");
    } catch (e) {
        log.warn("asset utils lookup failed", e);
    }
    // Not found yet — the module may live in a lazy chunk. Reset so the
    // next pushConfig retries instead of giving up permanently.
    assetUtilsTried = false;
    return null;
}

/**
 * Resolve an image key/URL through Discord's asset pipeline (Vencord
 * parity). Falls back to the raw value when the module isn't available.
 */
async function resolveAsset(
    key: string,
    appId: string,
): Promise<string> {
    const fetch = appId ? findFetchAssetIds() : null;
    if (fetch && appId) {
        try {
            const ids = await fetch(appId, [key]);
            const id = ids?.[0];
            if (typeof id === "string" && id) {
                logAsset(`asset resolved: ${key.slice(0, 80)} -> ${id.slice(0, 120)}`);
                return id;
            }
        } catch (e) {
            if (!assetUtilsWarned) {
                assetUtilsWarned = true;
                log.warn("fetchAssetIds failed — using raw image value", e);
            }
        }
    }
    const fallback = assetValue(key);
    logAsset(`asset fallback (unresolved): ${key.slice(0, 80)} -> ${fallback.slice(0, 120)}`);
    return fallback;
}

const FIELDS = [
    "enabled", "appId", "appName",
    "details", "detailsUrl", "state", "stateUrl",
    "type", "streamUrl", "timestampMode", "startTime", "endTime",
    "imageBig", "imageBigUrl", "imageBigTooltip",
    "imageSmall", "imageSmallUrl", "imageSmallTooltip",
    "buttonOneText", "buttonOneUrl", "buttonTwoText", "buttonTwoUrl",
    "partySize", "partyMaxSize",
] as const;

async function readSettings(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of FIELDS) {
        out[key] = await Api.Settings.get<unknown>(k(key));
    }
    return out;
}

/** Build the activity object Discord expects (Vencord's model). */
async function buildActivity(
    s: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
    const appName = String(s.appName ?? "").trim();
    const appId = String(s.appId ?? "").trim();
    // Vencord parity: the flux path only needs a name; application_id
    // falls back to "0". A real app id is still needed for the IPC
    // fallback and app-icon images.
    if (!appName) return null;

    const activity: Record<string, unknown> = {
        application_id: appId || "0",
        name: appName || "Custom RPC",
        type: Number(s.type ?? 0),
        flags: 1,
    };
    const str = (key: string) => {
        const v = String(s[key] ?? "").trim();
        return v || undefined;
    };
    const details = str("details");
    const state = str("state");
    const detailsUrl = str("detailsUrl");
    const stateUrl = str("stateUrl");
    if (details) activity.details = details;
    if (state) activity.state = state;
    if (detailsUrl) activity.details_url = detailsUrl;
    if (stateUrl) activity.state_url = stateUrl;

    const type = Number(s.type ?? 0);
    if (type === 1) {
        const url = str("streamUrl");
        if (url) activity.url = url;
    }

    switch (String(s.timestampMode ?? "none")) {
        case "now":
            activity.timestamps = { start: Date.now() };
            break;
        case "time": {
            const d = new Date();
            activity.timestamps = {
                start: Date.now() - (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 1000,
            };
            break;
        }
        case "custom": {
            const start = Number(s.startTime);
            const end = Number(s.endTime);
            const ts: Record<string, number> = {};
            if (start) ts.start = start;
            if (end) ts.end = end;
            if (Object.keys(ts).length) activity.timestamps = ts;
            break;
        }
    }

    const btn1 = str("buttonOneText");
    const btn1Url = str("buttonOneUrl");
    const btn2 = str("buttonTwoText");
    const btn2Url = str("buttonTwoUrl");
    if (btn1) {
        activity.buttons = [btn1, btn2].filter((b) => typeof b === "string" && b);
        activity.metadata = {
            button_urls: [btn1Url, btn2Url].filter((b) => typeof b === "string" && b),
        };
    }

    const imageBig = str("imageBig");
    const imageSmall = str("imageSmall");
    if (imageBig || imageSmall) {
        const assets: Record<string, string> = {};
        if (imageBig) assets.large_image = await resolveAsset(imageBig, appId);
        const bigTip = str("imageBigTooltip");
        const bigUrl = str("imageBigUrl");
        if (bigTip) assets.large_text = bigTip;
        if (bigUrl) assets.large_url = bigUrl;
        if (imageSmall)
            assets.small_image = await resolveAsset(imageSmall, appId);
        const smallTip = str("imageSmallTooltip");
        const smallUrl = str("imageSmallUrl");
        if (smallTip) assets.small_text = smallTip;
        if (smallUrl) assets.small_url = smallUrl;
        activity.assets = assets;
    }

    const partySize = Number(s.partySize);
    const partyMax = Number(s.partyMaxSize);
    if (partySize > 0 && partyMax > 0) {
        activity.party = { size: [partySize, partyMax] };
    }
    return activity;
}

/** Strip fields the game-IPC protocol doesn't understand. */
function toIpcActivity(activity: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { type: activity.type ?? 0 };
    for (const key of [
        "name",
        "state",
        "details",
        "url",
        "timestamps",
        "party",
        "assets",
    ]) {
        if (activity[key] != null) out[key] = activity[key];
    }
    // The flux model stores buttons as label strings + metadata.button_urls;
    // the IPC schema wants [{label, url}] objects — one wrong shape gets the
    // whole SET_ACTIVITY rejected with a 4000 validation error.
    const buttons = activity.buttons;
    const buttonUrls = (
        activity.metadata as Record<string, unknown> | undefined
    )?.button_urls;
    if (Array.isArray(buttons) && buttons.length) {
        const urls = Array.isArray(buttonUrls) ? buttonUrls : [];
        out.buttons = buttons
            .map((label, i) => ({
                label: String(label),
                url: typeof urls[i] === "string" ? urls[i] : "",
            }))
            .filter((b) => b.label);
        if (!(out.buttons as unknown[]).length) delete out.buttons;
    }
    // Discord's IPC protocol wants unix SECONDS, not milliseconds.
    const ts = out.timestamps as Record<string, unknown> | undefined;
    if (ts) {
        for (const k of ["start", "end"] as const) {
            const v = ts[k];
            if (typeof v === "number" && v > 1e12) ts[k] = Math.floor(v / 1000);
        }
    }
    // The IPC activity schema accepts the same asset values Discord's own
    // pipeline produces (asset ids, mp:external/, gif:/mp4: prefixes), so
    // pass them through verbatim — only drop the click-URL extras that
    // aren't part of the RPC asset model.
    const assets = activity.assets as Record<string, unknown> | undefined;
    if (assets) {
        const clean: Record<string, string> = {};
        for (const key of [
            "large_image",
            "large_text",
            "small_image",
            "small_text",
        ]) {
            const v = assets[key];
            if (typeof v === "string" && v) clean[key] = v;
        }
        out.assets = clean;
    }
    return out;
}

type H = PluginSettingsViewContext["h"];

const TYPE_LABELS = ["Playing", "Streaming", "Listening", "Watching", "", "", "Competing"];

function imageOrKey(
    h: H,
    key: string,
    appId: string,
    size: number,
): unknown {
    const style: Record<string, string | number> = {
        width: size,
        height: size,
        borderRadius: size > 40 ? 8 : "50%",
        objectFit: "cover",
        flexShrink: 0,
    };
    // Strip Discord's external-asset prefixes (gif:, mp4:, …) for <img>.
    const url = previewAssetUrl(key);
    if (/^https?:\/\//.test(url)) {
        return h("img", { src: url, style, alt: "" });
    }
    if (!key && appId) {
        // Discord app icon CDN — hide if it 404s.
        return h("img", {
            src: `https://cdn.discordapp.com/app-icons/${appId}/${appId}.png?size=128`,
            style,
            alt: "",
            onError: (e: { target?: { style?: { display: string } } }) => {
                if (e.target?.style) e.target.style.display = "none";
            },
        });
    }
    // Asset key — show a labeled placeholder.
    return h(
        "div",
        {
            style: {
                ...style,
                background: "var(--background-modifier-accent, #3f4147)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: size > 40 ? 22 : 11,
                fontWeight: 700,
                color: "var(--text-muted, #949ba4)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                padding: 4,
                boxSizing: "border-box",
            },
        },
        key ? key.slice(0, 2).toUpperCase() : "?",
    );
}

/** Live Discord-style rich presence card built from current values. */
function presencePreview(
    h: H,
    ctx: PluginSettingsViewContext,
    str: (k: string) => string,
    num: (k: string) => number,
    type: number,
    tsMode: string,
): unknown {
    const muted = "var(--text-muted, #949ba4)";
    const normal = "var(--text-normal, #dbdee1)";
    const appName = str("appName").trim();
    const appId = str("appId").trim();
    const details = str("details").trim();
    const state = str("state").trim();
    const detailsUrl = str("detailsUrl").trim();
    const stateUrl = str("stateUrl").trim();
    const imageBig = str("imageBig").trim();
    const imageSmall = str("imageSmall").trim();
    const btn1 = str("buttonOneText").trim();
    const btn2 = str("buttonTwoText").trim();
    const partySize = num("partySize");
    const partyMax = num("partyMaxSize");

    const configured = ctx.enabled && val0(ctx, "enabled") !== false && (appName || appId);
    if (!configured) {
        return h(
            "div",
            {
                style: {
                    background: "var(--background-secondary, #2b2d31)",
                    borderRadius: 8,
                    padding: "18px 14px",
                    fontSize: 13,
                    color: muted,
                    textAlign: "center",
                },
            },
            ctx.enabled
                ? "No presence configured — set an app name or ID below."
                : "Plugin is disabled — enable it to see a preview.",
        );
    }

    const linkStyle = (url: string) => ({
        color: url ? "var(--brand-500, #5865f2)" : normal,
        textDecoration: url ? "underline" : "none",
        cursor: url ? "pointer" : "default",
    });

    const line = (text: string, url: string, size = 13) =>
        text
            ? h(
                  "div",
                  { style: { fontSize: size, marginTop: 2, ...linkStyle(url) } },
                  url ? h("a", { href: url, style: { color: "inherit" } }, text) : text,
              )
            : null;

    const buttons = [btn1, btn2].filter(Boolean);
    const tsText =
        tsMode === "now"
            ? "Elapsed: live"
            : tsMode === "time"
              ? "Since midnight"
              : tsMode === "custom"
                ? [str("startTime"), str("endTime")].some((v) => Number(v) > 0)
                    ? "Custom range"
                    : "Custom (unset)"
                : null;

    return h(
        "div",
        {
            style: {
                background: "var(--background-secondary, #2b2d31)",
                borderRadius: 8,
                padding: 12,
                display: "flex",
                gap: 12,
                maxWidth: 460,
            },
        },
        // images
        h(
            "div",
            { style: { position: "relative", flexShrink: 0 } },
            imageOrKey(h, imageBig, appId, 68),
            imageSmall
                ? h("div", {
                      style: {
                          position: "absolute",
                          right: -6,
                          bottom: -6,
                          borderRadius: "50%",
                          border: "3px solid var(--background-secondary, #2b2d31)",
                      },
                  }, imageOrKey(h, imageSmall, appId, 30))
                : null,
        ),
        // text column
        h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h(
                "div",
                { style: { display: "flex", alignItems: "baseline", gap: 6 } },
                h(
                    "div",
                    {
                        style: {
                            fontSize: 14,
                            fontWeight: 600,
                            color: normal,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        },
                    },
                    appName || "Custom RPC",
                ),
                h(
                    "div",
                    { style: { fontSize: 11, color: muted, flexShrink: 0 } },
                    TYPE_LABELS[type] ?? "Playing",
                ),
            ),
            line(details, detailsUrl),
            line(state, stateUrl),
            buttons.length
                ? h(
                      "div",
                      { style: { display: "flex", gap: 6, marginTop: 8 } },
                      buttons.map((b, i) =>
                          h(
                              "div",
                              {
                                  key: i,
                                  style: {
                                      background: "var(--button-secondary-background, #4e5058)",
                                      color: normal,
                                      borderRadius: 4,
                                      padding: "4px 10px",
                                      fontSize: 12,
                                      fontWeight: 500,
                                  },
                              },
                              b,
                          ),
                      ),
                  )
                : null,
            h(
                "div",
                {
                    style: {
                        display: "flex",
                        gap: 10,
                        marginTop: 6,
                        fontSize: 11,
                        color: muted,
                    },
                },
                tsText ? h("span", null, tsText) : null,
                partySize > 0 && partyMax > 0
                    ? h("span", null, `${partySize}/${partyMax} in party`)
                    : null,
            ),
        ),
    );
}

function val0(ctx: PluginSettingsViewContext, key: string): unknown {
    return ctx.values[key] ?? CustomRPC.settings?.[key];
}

const RPC_PRESET_FIELDS = [
    "appId", "appName", "details", "detailsUrl", "state", "stateUrl",
    "type", "streamUrl", "timestampMode", "startTime", "endTime",
    "imageBig", "imageBigUrl", "imageBigTooltip",
    "imageSmall", "imageSmallUrl", "imageSmallTooltip",
    "buttonOneText", "buttonOneUrl", "buttonTwoText", "buttonTwoUrl",
    "partySize", "partyMaxSize",
] as const;

/** Named snapshots of the activity fields, stored under `presets`. */
function RpcPresetsBar(props: {
    ctx: PluginSettingsViewContext;
    set: (key: string, value: unknown) => void;
    disabled: boolean;
}): unknown {
    const { ctx, set, disabled } = props;
    const [name, setName] = useState("");
    const [sel, setSel] = useState("");
    const presets = (ctx.values["presets"] ?? {}) as Record<
        string,
        Record<string, unknown>
    >;
    const names = Object.keys(presets);
    const chip: Record<string, unknown> = {
        background: "var(--background-secondary, #2b2d31)",
        border: "1px solid var(--background-modifier-accent, #3f4147)",
        color: "var(--text-normal, #dbdee1)",
        borderRadius: 16,
        padding: "4px 12px",
        fontSize: 12,
        cursor: "pointer",
        opacity: disabled ? 0.5 : 1,
    };
    const inputStyle: Record<string, unknown> = {
        background: "var(--input-background, #1e1f22)",
        color: "var(--text-normal, #dbdee1)",
        border: "1px solid var(--background-modifier-accent, #3f4147)",
        borderRadius: 4,
        padding: "5px 9px",
        fontSize: 12,
        opacity: disabled ? 0.5 : 1,
    };
    return h(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "0 0 4px" } },
        h(
            "select",
            {
                style: { ...inputStyle, maxWidth: 160 },
                disabled,
                value: sel,
                onChange: (e: { target: { value: string } }) => {
                    setSel(e.target.value);
                    const p = presets[e.target.value];
                    if (!p) return;
                    for (const k of RPC_PRESET_FIELDS) {
                        if (k in p) set(k, p[k]);
                    }
                },
            },
            h("option", { value: "" }, "Load preset…"),
            names.map((n) => h("option", { key: n, value: n }, n)),
        ),
        h("input", {
            style: { ...inputStyle, width: 110 },
            placeholder: "Preset name",
            value: name,
            disabled,
            onChange: (e: { target: { value: string } }) => setName(e.target.value),
        }),
        h(
            "button",
            {
                style: chip,
                disabled: disabled || !name.trim(),
                title: "Save the current activity fields as a preset",
                onClick: () => {
                    const snap = Object.fromEntries(
                        RPC_PRESET_FIELDS.map((k) => [k, val0(ctx, k)]),
                    );
                    set("presets", { ...presets, [name.trim()]: snap });
                    setName("");
                },
            },
            "Save",
        ),
        names.length > 0
            ? h(
                  "button",
                  {
                      style: chip,
                      disabled,
                      title: "Delete the selected preset",
                      onClick: () => {
                          if (!sel || !(sel in presets)) return;
                          const next = { ...presets };
                          delete next[sel];
                          set("presets", next);
                          setSel("");
                      },
                  },
                  "Delete…",
              )
            : null,
    );
}

let dispatcher: Dispatcher | null = null;
let dispatcherPoll: ReturnType<typeof setInterval> | null = null;

/** Poll for the flux dispatcher — Discord lazy-loads it after boot. */
function ensureDispatcher(): void {
    if (dispatcher?.dispatch || dispatcherPoll) return;
    let attempts = 0;
    dispatcherPoll = setInterval(() => {
        attempts += 1;
        const d = findDispatcher();
        if (d?.dispatch) {
            dispatcher = d;
            if (dispatcherPoll) clearInterval(dispatcherPoll);
            dispatcherPoll = null;
            log.info("flux dispatcher found — LOCAL_ACTIVITY_UPDATE active");
            void pushConfig();
        } else if (attempts >= 60) {
            // ~2 minutes — give up, IPC fallback remains.
            if (dispatcherPoll) clearInterval(dispatcherPoll);
            dispatcherPoll = null;
            log.warn("flux dispatcher not found — IPC fallback only");
        }
    }, 2000);
}

let warnedMissingAppId = false;
let diagnosed = false;

/** Read Discord's activity stores back to verify the dispatch landed. */
function diagnoseActivity(): void {
    if (diagnosed) return;
    diagnosed = true;
    for (const name of [
        "LocalActivityStore",
        "ActivityStore",
        "ActivityTrackingStore",
    ]) {
        const st = findStoreByName(name);
        if (!st) {
            log.info(`rpc diag: ${name} not found`);
            continue;
        }
        const keys = Object.keys(st).slice(0, 25).join(",");
        log.info(`rpc diag: ${name} keys: ${keys}`);
        for (const m of [
            "getAllActivities",
            "getActivities",
            "getLocalActivity",
            "getVisibleActivities",
            "getState",
        ]) {
            const fn = st[m];
            if (typeof fn !== "function") continue;
            try {
                const r = fn.call(st);
                log.info(
                    `rpc diag: ${name}.${m}() = ${JSON.stringify(r)?.slice(0, 600)}`,
                );
            } catch (e) {
                log.info(`rpc diag: ${name}.${m} threw ${String(e)}`);
            }
        }
    }
}

async function pushConfig(): Promise<void> {
    const s = await readSettings();
    const enabled = s.enabled !== false;
    const appIdMissing = !String(s.appId ?? "").trim();
    if (enabled && appIdMissing && !warnedMissingAppId) {
        warnedMissingAppId = true;
        log.warn(
            "CustomRPC: Application ID is empty — the IPC fallback and " +
                "app-icon images won't work. Create an app at " +
                "discord.com/developers/applications for full features.",
        );
    } else if (!appIdMissing) {
        warnedMissingAppId = false;
    }
    const activity = enabled ? await buildActivity(s) : null;

    // Primary path: Discord's own flux dispatcher (full feature set —
    // buttons, urls, party). Dispatch null to clear.
    ensureDispatcher();
    if (dispatcher?.dispatch) {
        dispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity,
            socketId: "CustomRPC",
        });
        // Verify the action actually reached Discord's activity store.
        setTimeout(diagnoseActivity, 3000);
    }

    // Fallback: game IPC pipe (requires numeric app id, no buttons).
    // Kept in sync so the presence survives a Discord restart.
    const appId = String(s.appId ?? "").trim();
    const b = bridge();
    if (!b) return;
    if (!activity || !/^\d{5,25}$/.test(appId)) {
        await b.invoke("rpc-clear").catch(() => {});
        return;
    }
    log.info(`rpc: sending SET_ACTIVITY via IPC pipe (appId ${appId})`);
    await b
        .invoke("rpc-set", { appId, activity: toIpcActivity(activity) })
        .catch((e) => log.warn("failed to set rich presence", e));
}

export const CustomRPC: Plugin = {
    name: "CustomRPC",
    description:
        "Set a custom Rich Presence activity (name, details, images, buttons, timestamps).",
    authors: ["Monocord"],
    version: "0.2.0",

    settings: {
        enabled: true,
        appId: "",
        appName: "",
        details: "",
        detailsUrl: "",
        state: "",
        stateUrl: "",
        type: 0,
        streamUrl: "",
        timestampMode: "none",
        startTime: 0,
        endTime: 0,
        imageBig: "",
        imageBigUrl: "",
        imageBigTooltip: "",
        imageSmall: "",
        imageSmallUrl: "",
        imageSmallTooltip: "",
        buttonOneText: "",
        buttonOneUrl: "",
        buttonTwoText: "",
        buttonTwoUrl: "",
        partySize: 0,
        partyMaxSize: 0,
        presets: {},
    },

    // Vencord-style dedicated settings UI (paired fields, validation,
    // live presence preview) instead of the generic schema form.
    settingsView(ctx: PluginSettingsViewContext): unknown {
        const { h } = ctx;
        const defaults = CustomRPC.settings ?? {};
        const val = (key: string): unknown =>
            ctx.values[key] ?? defaults[key];
        const str = (key: string) => String(val(key) ?? "");
        const num = (key: string) => Number(val(key) ?? 0) || 0;

        // ctx.set updates panel state immediately (controlled inputs stay
        // responsive); PluginsPanel debounces the actual settings.json
        // write, and settings.changed then re-dispatches the activity.
        const set = (key: string, value: unknown) => ctx.set(key, value);

        const type = num("type");
        const tsMode = str("timestampMode") || "none";
        const disabled = !ctx.enabled;

        const input = (
            key: string,
            opts: { placeholder?: string; type?: string; width?: number } = {},
        ) =>
            h("input", {
                type: opts.type ?? "text",
                value: str(key),
                placeholder: opts.placeholder,
                disabled,
                onChange: (e: { target: { value: string } }) =>
                    set(
                        key,
                        opts.type === "number"
                            ? e.target.value === ""
                                ? 0
                                : Number(e.target.value)
                            : e.target.value,
                    ),
                style: {
                    width: opts.width ? `${opts.width}px` : "100%",
                    background: "var(--input-background, #1e1f22)",
                    color: "var(--text-normal, #dbdee1)",
                    border: "1px solid var(--background-modifier-accent, #3f4147)",
                    borderRadius: 4,
                    padding: "7px 10px",
                    fontSize: 13,
                    boxSizing: "border-box",
                    opacity: disabled ? 0.5 : 1,
                },
            });

        const select = (
            key: string,
            options: readonly { label: string; value: string }[],
        ) =>
            h(
                "select",
                {
                    value: str(key),
                    disabled,
                    onChange: (e: { target: { value: string } }) =>
                        set(key, e.target.value),
                    style: {
                        width: "100%",
                        background: "var(--input-background, #1e1f22)",
                        color: "var(--text-normal, #dbdee1)",
                        border: "1px solid var(--background-modifier-accent, #3f4147)",
                        borderRadius: 4,
                        padding: "7px 10px",
                        fontSize: 13,
                    },
                },
                options.map((o) =>
                    h("option", { key: o.value, value: o.value }, o.label),
                ),
            );

        const label = (text: string) =>
            h(
                "div",
                {
                    style: {
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-muted, #949ba4)",
                        margin: "14px 0 6px",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                    },
                },
                text,
            );

        const hint = (text: string) =>
            h(
                "div",
                {
                    style: {
                        fontSize: 11,
                        color: "var(--text-muted, #949ba4)",
                        marginTop: 3,
                    },
                },
                text,
            );

        const warn = (text: string) =>
            h(
                "div",
                {
                    style: {
                        fontSize: 11,
                        color: "var(--status-warning, #f0b232)",
                        marginTop: 3,
                    },
                },
                text,
            );

        const field = (
            text: string,
            control: unknown,
            extra?: unknown,
        ) =>
            h(
                "div",
                { style: { flex: 1, minWidth: 0 } },
                h(
                    "div",
                    {
                        style: {
                            fontSize: 12,
                            fontWeight: 500,
                            marginBottom: 4,
                            color: "var(--text-normal, #dbdee1)",
                        },
                    },
                    text,
                ),
                control,
                extra ?? null,
            );

        const pair = (a: unknown, b: unknown) =>
            h(
                "div",
                { style: { display: "flex", gap: 12 } },
                field(...(a as [string, unknown, unknown?])),
                b ? field(...(b as [string, unknown, unknown?])) : null,
            );

        // -- validation hints (Vencord's isValid rules, simplified) ------
        const appId = str("appId").trim();
        const appIdWarn = !appId
            ? warn(
                  "Required — create an app at discord.com/developers/applications and paste its Application ID. Without it the presence won't show.",
              )
            : !/^\d{5,25}$/.test(appId)
              ? warn("Application ID must be numeric (5–25 digits).")
              : null;
        const urlWarn = (key: string) => {
            const v = str(key).trim();
            return v && !/^https?:\/\//.test(v)
                ? warn("Must be a valid http(s) URL.")
                : null;
        };
        const imageWarn = (key: string) => {
            const v = str(key).trim();
            if (!v || !/^https?:\/\//.test(v)) return null;
            if (/discordapp\.(com|net)/.test(v))
                return warn("Don't use a Discord CDN link — use Imgur instead.");
            if (/imgur\.com\//.test(v) && !/i\.imgur\.com/.test(v))
                return warn("Use a direct image URL (i.imgur.com/…).");
            return null;
        };
        const streamUrl = str("streamUrl").trim();
        const streamWarn =
            type === 1 && !streamUrl
                ? warn("Streaming type needs a Twitch/YouTube URL.")
                : type === 1 &&
                    streamUrl &&
                    !/https?:\/\/(www\.)?(twitch\.tv|youtube\.com|youtu\.be)\//.test(
                        streamUrl,
                    )
                  ? warn(
                        "Discord only allows Twitch and YouTube links for Streaming — this presence will be rejected. Use Playing/Watching instead, or a supported URL.",
                    )
                  : null;

        const onlyPlaying = type !== 0;
        const customTs = tsMode !== "custom";

        return h(
            "div",
            null,
            label("Presets"),
            h(RpcPresetsBar, { ctx, set, disabled }),
            hint("Save the current fields as a named preset and reload them later."),

            // -- live preview -------------------------------------------
            label("Preview"),
            h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" } },
                h("input", {
                    type: "checkbox",
                    checked: val("enabled") !== false,
                    disabled,
                    onChange: (e: { target: { checked: boolean } }) =>
                        set("enabled", e.target.checked),
                }),
                h("span", { style: { fontSize: 13 } }, "Show this presence"),
            ),
            presencePreview(h, ctx, str, num, type, tsMode),

            label("Activity"),
            pair(
                ["Activity type", select("type", ACTIVITY_TYPES)],
                [
                    "Timestamps",
                    select("timestampMode", TIMESTAMP_MODES),
                ],
            ),
            pair(
                [
                    "Application ID",
                    input("appId", {
                        placeholder: "123456789012345678",
                    }),
                    appIdWarn,
                ],
                [
                    "App name",
                    input("appName", { placeholder: "Spotify" }),
                    hint("Shown as the activity title."),
                ],
            ),

            label("Text"),
            pair(
                [
                    "Details (line 1)",
                    input("details", { placeholder: "In a match" }),
                    urlWarn("detailsUrl"),
                ],
                [
                    "Details URL",
                    input("detailsUrl", { placeholder: "https://…" }),
                ],
            ),
            pair(
                [
                    "State (line 2)",
                    input("state", { placeholder: "Ranked" }),
                    urlWarn("stateUrl"),
                ],
                [
                    "State URL",
                    input("stateUrl", { placeholder: "https://…" }),
                ],
            ),
            type === 1
                ? h("div", { style: { marginTop: 10 } },
                      field(
                          "Stream URL (Twitch/YouTube)",
                          input("streamUrl", {
                              placeholder: "https://twitch.tv/…",
                          }),
                          streamWarn,
                      ))
                : null,

            label("Images"),
            hint("Paste a .gif URL (Imgur/Tenor/Giphy) and it animates automatically. You can also use Discord's prefixes: gif:, mp4:, youtube:, twitch:."),
            pair(
                [
                    "Large image key/URL",
                    input("imageBig", { placeholder: "spotify:album:… or https://…" }),
                    imageWarn("imageBig"),
                ],
                [
                    "Large image tooltip",
                    input("imageBigTooltip"),
                ],
            ),
            h("div", { style: { marginTop: 4 } },
                field(
                    "Large image click URL",
                    input("imageBigUrl", { placeholder: "https://…" }),
                    urlWarn("imageBigUrl"),
                )),
            pair(
                [
                    "Small image key/URL",
                    input("imageSmall", { placeholder: "spotify:artist:…" }),
                    imageWarn("imageSmall"),
                ],
                [
                    "Small image tooltip",
                    input("imageSmallTooltip"),
                ],
            ),
            h("div", { style: { marginTop: 4 } },
                field(
                    "Small image click URL",
                    input("imageSmallUrl", { placeholder: "https://…" }),
                    urlWarn("imageSmallUrl"),
                )),

            label("Buttons & party"),
            pair(
                ["Button 1 text", input("buttonOneText", { placeholder: "Join" })],
                ["Button 1 URL", input("buttonOneUrl", { placeholder: "https://…" })],
            ),
            pair(
                ["Button 2 text", input("buttonTwoText")],
                ["Button 2 URL", input("buttonTwoUrl", { placeholder: "https://…" })],
            ),
            pair(
                [
                    "Party size",
                    input("partySize", { type: "number", placeholder: "2" }),
                    onlyPlaying ? hint("Only used for Playing type.") : null,
                ],
                [
                    "Max party size",
                    input("partyMaxSize", { type: "number", placeholder: "5" }),
                ],
            ),

            label("Custom timestamps"),
            h("div", { style: { opacity: customTs ? 0.5 : 1 } },
                pair(
                    [
                        "Start (epoch ms)",
                        input("startTime", { type: "number", placeholder: "1700000000000" }),
                    ],
                    [
                        "End (epoch ms)",
                        input("endTime", { type: "number", placeholder: "1700003600000" }),
                    ],
                ),
                customTs ? hint("Enable 'Custom start/end' timestamp mode to use these.") : null,
            ),
        );
    },

    async start() {
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (typeof path === "string" && path.startsWith(KEY)) {
                void pushConfig();
            }
        });
        await pushConfig();
    },

    async stop() {
        if (dispatcherPoll) {
            clearInterval(dispatcherPoll);
            dispatcherPoll = null;
        }
        const s = await readSettings();
        const activity = await buildActivity(s);
        if (activity && dispatcher?.dispatch) {
            dispatcher.dispatch({
                type: "LOCAL_ACTIVITY_UPDATE",
                activity: null,
                socketId: "CustomRPC",
            });
        }
        dispatcher = null;
        const b = bridge();
        if (b) await b.invoke("rpc-clear").catch(() => {});
    },
};
