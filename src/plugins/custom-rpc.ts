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
import type { Plugin } from "../core/types";
import { findDispatcher, type Dispatcher } from "./mods";

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
function buildActivity(s: Record<string, unknown>): Record<string, unknown> | null {
    const appName = String(s.appName ?? "").trim();
    const appId = String(s.appId ?? "").trim();
    if (!appName && !appId) return null;

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
        if (imageBig) assets.large_image = imageBig;
        const bigTip = str("imageBigTooltip");
        const bigUrl = str("imageBigUrl");
        if (bigTip) assets.large_text = bigTip;
        if (bigUrl) assets.large_url = bigUrl;
        if (imageSmall) assets.small_image = imageSmall;
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
    for (const key of ["name", "state", "details", "url", "timestamps", "party", "assets"]) {
        if (activity[key] != null) out[key] = activity[key];
    }
    const assets = activity.assets as Record<string, unknown> | undefined;
    if (assets) {
        const clean: Record<string, string> = {};
        for (const key of ["large_image", "large_text", "small_image", "small_text"]) {
            const v = assets[key];
            if (typeof v === "string" && v) clean[key] = v;
        }
        out.assets = clean;
    }
    return out;
}

let dispatcher: Dispatcher | null | undefined;

async function pushConfig(): Promise<void> {
    const s = await readSettings();
    const enabled = s.enabled !== false;
    const activity = enabled ? buildActivity(s) : null;

    // Primary path: Discord's own flux dispatcher (full feature set —
    // buttons, urls, party). Dispatch null to clear.
    if (dispatcher === undefined) dispatcher = findDispatcher();
    if (dispatcher?.dispatch) {
        dispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity,
            socketId: "CustomRPC",
        });
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
    },

    settingsSchema: {
        enabled: {
            type: "boolean",
            label: "Enable presence",
            description: "Show your custom activity on your profile.",
        },
        appId: {
            type: "string",
            label: "Application ID",
            description: "Numeric id from discord.com/developers. Required for the IPC fallback and image keys.",
            placeholder: "123456789012345678",
        },
        appName: {
            type: "string",
            label: "App name",
            description: "Name shown as the activity title (e.g. \"Spotify\").",
            placeholder: "My App",
        },
        type: {
            type: "select",
            label: "Activity type",
            options: ACTIVITY_TYPES.map((o) => ({ label: o.label, value: String(o.value) })),
        },
        details: { type: "string", label: "Details", placeholder: "In a match" },
        detailsUrl: { type: "string", label: "Details URL", placeholder: "https://…" },
        state: { type: "string", label: "State", placeholder: "Ranked" },
        stateUrl: { type: "string", label: "State URL", placeholder: "https://…" },
        streamUrl: {
            type: "string",
            label: "Stream URL",
            description: "Twitch/YouTube URL — only used when type is Streaming.",
            placeholder: "https://twitch.tv/…",
        },
        timestampMode: {
            type: "select",
            label: "Timestamps",
            options: TIMESTAMP_MODES.map((o) => ({ label: o.label, value: o.value })),
        },
        startTime: {
            type: "number",
            label: "Start (epoch ms)",
            description: "Used when timestamps = Custom. 0 = unset.",
        },
        endTime: {
            type: "number",
            label: "End (epoch ms)",
            description: "Used when timestamps = Custom. 0 = unset.",
        },
        imageBig: {
            type: "string",
            label: "Large image key",
            description: "Asset key from the app's Rich Presence art assets.",
        },
        imageBigTooltip: { type: "string", label: "Large image tooltip" },
        imageBigUrl: { type: "string", label: "Large image URL", placeholder: "https://…" },
        imageSmall: { type: "string", label: "Small image key" },
        imageSmallTooltip: { type: "string", label: "Small image tooltip" },
        imageSmallUrl: { type: "string", label: "Small image URL", placeholder: "https://…" },
        buttonOneText: { type: "string", label: "Button 1 text" },
        buttonOneUrl: { type: "string", label: "Button 1 URL", placeholder: "https://…" },
        buttonTwoText: { type: "string", label: "Button 2 text" },
        buttonTwoUrl: { type: "string", label: "Button 2 URL", placeholder: "https://…" },
        partySize: { type: "number", label: "Party size" },
        partyMaxSize: { type: "number", label: "Party max size" },
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
        const s = await readSettings();
        const activity = buildActivity(s);
        if (activity && dispatcher?.dispatch) {
            dispatcher.dispatch({
                type: "LOCAL_ACTIVITY_UPDATE",
                activity: null,
                socketId: "CustomRPC",
            });
        }
        const b = bridge();
        if (b) await b.invoke("rpc-clear").catch(() => {});
    },
};
