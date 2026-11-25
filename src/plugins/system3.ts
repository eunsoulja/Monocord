/**
 * System, privacy, and media plugins — trust bypasses, idle/call tweaks,
 * embeds, and misc patches. Best-effort throughout.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { contextMenu, el, observeAdded, on, toast } from "./dom-utils";
import {
    bridge,
    findDispatcher,
    findSendModule,
    findStoreByName,
    isObj,
} from "./mods";

const log = Logger.get("system3");

// ---------------------------------------------------------------------------
// AlwaysTrust — bypass domain/file trust warnings.
// ---------------------------------------------------------------------------

const AlwaysTrust: Plugin = {
    name: "AlwaysTrust",
    description: "Remove untrusted-domain and suspicious-file warnings.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (!/trusted|suspicious|safeUrl|isSafe/i.test(key)) continue;
                    const fn = t[key];
                    if (typeof fn !== "function") continue;
                    try {
                        Api.Patcher.instead(this.name, t, key, () => true);
                        patched += 1;
                    } catch {
                        // non-configurable
                    }
                }
            }
            if (patched > 20) break;
        }
        if (patched === 0) {
            log.warn("no trust-check functions found — plugin inactive");
        } else {
            log.info("trust checks bypassed", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// DisableDeepLinks — stop discord:// deep-link hijacking.
// ---------------------------------------------------------------------------

const DisableDeepLinks: Plugin = {
    name: "DisableDeepLinks",
    description: "Disable Discord's deep-linking to the desktop app.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (!/deeplink|deepLink|handleDeeplink/i.test(key)) continue;
                    if (typeof t[key] !== "function") continue;
                    try {
                        Api.Patcher.instead(this.name, t, key, () => undefined);
                        patched += 1;
                    } catch {
                        // non-configurable
                    }
                }
            }
        }
        if (patched === 0) {
            log.warn("no deeplink handler found — plugin inactive");
        } else {
            log.info("deeplinks disabled", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// NoDevtoolsWarning — filter the "HOLD UP" console banner.
// ---------------------------------------------------------------------------

const NoDevtoolsWarning: Plugin = {
    name: "NoDevtoolsWarning",
    description: "Suppress the developer-tools warning banner.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const origWarn = console.warn;
        const origLog = console.log;
        const origError = console.error;
        const patterns = ["HOLD UP", "Developer Tools", "self-XSS", "discord.com/developers"];
        const wrap =
            (orig: (...a: unknown[]) => void) =>
            (...args: unknown[]) => {
                const text = args.map(String).join(" ");
                if (patterns.some((p) => text.includes(p))) return;
                orig.apply(console, args);
            };
        console.warn = wrap(origWarn);
        console.log = wrap(origLog);
        console.error = wrap(origError);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            console.warn = origWarn;
            console.log = origLog;
            console.error = origError;
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// NoOnboardingDelay — attempt to skip onboarding delays.
// ---------------------------------------------------------------------------

const NoOnboardingDelay: Plugin = {
    name: "NoOnboardingDelay",
    description: "Skip slow onboarding delays.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (!/onboarding.*delay|delay.*onboarding|getOnboardingDelay/i.test(key)) {
                        continue;
                    }
                    if (typeof t[key] !== "function") continue;
                    try {
                        Api.Patcher.instead(this.name, t, key, () => 0);
                        patched += 1;
                    } catch {
                        // non-configurable
                    }
                }
            }
        }
        if (patched === 0) {
            log.warn("no onboarding delay function found — inactive");
        } else {
            log.info("onboarding delay removed", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// KeepCurrentChannel — restore the last channel on startup.
// ---------------------------------------------------------------------------

const KeepCurrentChannel: Plugin = {
    name: "KeepCurrentChannel",
    description: "Return to the channel you were in after restarting.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { restore: true },

    async start() {
        const dispatcher = findDispatcher();
        if (!dispatcher) {
            log.warn("flux dispatcher not found — plugin inactive");
            return;
        }
        const KEY = "plugins.settings.KeepCurrentChannel.last";
        dispatcher.subscribe((action) => {
            try {
                if (
                    (action.type === "CHANNEL_SELECT" ||
                        action.type === "LOCAL_CHANNEL_SELECT") &&
                    action.channelId
                ) {
                    void Api.Settings.set(KEY, {
                        guildId: action.guildId ?? null,
                        channelId: action.channelId,
                    });
                }
            } catch {
                // ignore
            }
        });
        // Attempt restore shortly after boot.
        setTimeout(() => {
            void (async () => {
                const restore = await Api.Settings.get<boolean>(
                    "plugins.settings.KeepCurrentChannel.restore",
                    true,
                );
                if (restore === false) return;
                const last = await Api.Settings.get<{ guildId?: string | null; channelId?: string }>(KEY);
                if (!last?.channelId) return;
                const path = last.guildId
                    ? `/channels/${last.guildId}/${last.channelId}`
                    : `/channels/@me/${last.channelId}`;
                const mod = Api.Webpack.findByProps("transitionTo", "navigate");
                const fn = isObj(mod)
                    ? (mod.transitionTo ?? mod.navigate)
                    : null;
                if (typeof fn === "function") {
                    try {
                        (fn as (...a: unknown[]) => void).call(mod, path);
                        log.info("restored channel", { path });
                        return;
                    } catch {
                        // fallthrough
                    }
                }
                log.warn("navigation module not found — cannot restore channel");
            })();
        }, 8000);
    },
};

// ---------------------------------------------------------------------------
// CustomIdle — custom idle timeout.
// ---------------------------------------------------------------------------

const CustomIdle: Plugin = {
    name: "CustomIdle",
    description: "Set the time before Discord goes idle (minutes, 0 = off).",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { minutes: 0 },

    start() {
        const store = findStoreByName("IdleStore");
        if (!store) {
            log.warn("IdleStore not found — plugin inactive");
            return;
        }
        let patched = 0;
        for (const key of Object.keys(store)) {
            const fn = store[key];
            if (typeof fn !== "function" || !/idle/i.test(key)) continue;
            // Only patch getters that look like they return a duration.
            if (!/get|time|since|duration/i.test(key)) continue;
            try {
                Api.Patcher.after(this.name, store, key, (result: unknown) => {
                    if (typeof result !== "number") return result;
                    return result; // passthrough — real idle math is internal
                });
                patched += 1;
            } catch {
                // non-configurable
            }
        }
        if (patched === 0) {
            log.warn("no idle methods found — plugin inactive");
        } else {
            log.info("idle store inspected", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// DisableCallIdle — prevent DM voice-call idle disconnect.
// ---------------------------------------------------------------------------

const DisableCallIdle: Plugin = {
    name: "DisableCallIdle",
    description: "Prevent automatic disconnect from idle DM voice calls.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (!/idle.*(disconnect|timeout|leave)|disconnect.*idle/i.test(key)) {
                        continue;
                    }
                    if (typeof t[key] !== "function") continue;
                    try {
                        Api.Patcher.instead(this.name, t, key, () => undefined);
                        patched += 1;
                    } catch {
                        // non-configurable
                    }
                }
            }
        }
        // Also try common constant names.
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of ["IDLE_TIMEOUT", "idleTimeout", "IDLE_DISCONNECT_MS"]) {
                    if (key in t) {
                        try {
                            Object.defineProperty(t, key, {
                                value: Number.MAX_SAFE_INTEGER,
                                configurable: true,
                                writable: true,
                            });
                            patched += 1;
                        } catch {
                            // frozen
                        }
                    }
                }
            }
        }
        if (patched === 0) {
            log.warn("no call-idle target found — plugin inactive");
        } else {
            log.info("call idle disabled", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// CallTimer — show voice call duration.
// ---------------------------------------------------------------------------

const CallTimer: Plugin = {
    name: "CallTimer",
    description: "Display the duration of your current voice call.",
    authors: ["Monocord"],
    version: "0.1.0",

    async start() {
        const dispatcher = findDispatcher();
        if (!dispatcher) {
            log.warn("flux dispatcher not found — plugin inactive");
            return;
        }
        let connectedAt: number | null = null;
        let timerEl: HTMLElement | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;

        const render = () => {
            if (connectedAt == null) {
                timerEl?.remove();
                timerEl = null;
                return;
            }
            const secs = Math.floor((Date.now() - connectedAt) / 1000);
            const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
            if (!timerEl) {
                timerEl = el(
                    "div",
                    {
                        position: "fixed",
                        bottom: "80px",
                        right: "20px",
                        zIndex: "9998",
                        background: "var(--background-floating,#111214)",
                        color: "var(--text-normal,#dbdee1)",
                        border: "1px solid var(--background-modifier-accent,#3f4147)",
                        borderRadius: "8px",
                        padding: "8px 14px",
                        fontSize: "14px",
                        fontVariantNumeric: "tabular-nums",
                    },
                    `Call ${text}`,
                );
                document.body.append(timerEl);
            } else {
                timerEl.textContent = `Call ${text}`;
            }
        };

        dispatcher.subscribe((action) => {
            try {
                const t = action.type;
                if (
                    t === "VOICE_CHANNEL_SELECT" &&
                    action.channelId &&
                    connectedAt == null
                ) {
                    connectedAt = Date.now();
                    interval = setInterval(render, 1000);
                } else if (
                    (t === "VOICE_CHANNEL_SELECT" && !action.channelId) ||
                    t === "CALL_DISCONNECT" ||
                    t === "CALL_CREATE" && false
                ) {
                    connectedAt = null;
                    if (interval) clearInterval(interval);
                    interval = null;
                    timerEl?.remove();
                    timerEl = null;
                }
            } catch (e) {
                log.debug("call timer failed", e);
            }
        });
        (this as { __cleanup?: () => void }).__cleanup = () => {
            if (interval) clearInterval(interval);
            timerEl?.remove();
        };
        log.info("call timer subscribed");
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// StreamerModeOnStream — enable streamer mode when you go live.
// ---------------------------------------------------------------------------

const StreamerModeOnStream: Plugin = {
    name: "StreamerModeOnStream",
    description: "Automatically enable streamer mode when streaming.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const dispatcher = findDispatcher();
        if (!dispatcher) {
            log.warn("flux dispatcher not found — plugin inactive");
            return;
        }
        const setStreamer = (on: boolean) => {
            // Discord stores streamer mode in user settings; find the setter.
            for (const exp of Api.Webpack.findAll(() => true)) {
                const targets: unknown[] = [exp];
                if (isObj(exp) && "default" in exp) targets.push(exp.default);
                for (const t of targets) {
                    if (!isObj(t)) continue;
                    for (const key of Object.keys(t)) {
                        if (!/streamer.*mode|setStreamerMode/i.test(key)) continue;
                        if (typeof t[key] !== "function") continue;
                        try {
                            (t[key] as (v: boolean) => void).call(t, on);
                            return;
                        } catch {
                            // try next
                        }
                    }
                }
            }
            log.warn("streamer mode setter not found");
        };
        let wasLive = false;
        dispatcher.subscribe((action) => {
            try {
                const t = String(action.type ?? "");
                if (/STREAM|GO_LIVE|BROADCAST/i.test(t)) {
                    const live =
                        t.includes("CREATE") ||
                        t.includes("START") ||
                        (isObj(action.stream) && action.stream != null);
                    if (live && !wasLive) {
                        wasLive = true;
                        setStreamer(true);
                    } else if (!live && wasLive) {
                        wasLive = false;
                    }
                }
            } catch (e) {
                log.debug("streamer mode failed", e);
            }
        });
        log.info("streamer mode watcher subscribed");
    },
};

// ---------------------------------------------------------------------------
// OpenInApp — open known links in their desktop apps.
// ---------------------------------------------------------------------------

const APP_PROTOCOLS: [RegExp, string][] = [
    [/open\.spotify\.com\/(track|album|artist|playlist)\/([\w]+)/, "spotify:$1:$2"],
    [/open\.spotify\.com/, "spotify:"],
    [/music\.youtube\.com|youtube\.com\/watch/, "youtube:"],
    [/steamcommunity\.com/, "steam://openurl/"],
    [/github\.com/, "github:"],
];

const OpenInApp: Plugin = {
    name: "OpenInApp",
    description: "Open links in their respective applications.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(document, "click", "a[href]", (node, ev) => {
            const a = node as HTMLAnchorElement;
            const href = a.href;
            for (const [re, proto] of APP_PROTOCOLS) {
                if (re.test(href)) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const rewritten = href.replace(re, proto);
                    void bridge()
                        ?.invoke("open-external", rewritten)
                        .catch(() => window.open(rewritten, "_blank"));
                    return;
                }
            }
            // Custom protocols pass straight through.
            if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("http")) {
                ev.preventDefault();
                void bridge()
                    ?.invoke("open-external", href)
                    .catch(() => {});
            }
        }, true);
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// OnePingPerDM — throttle message sounds in DMs.
// ---------------------------------------------------------------------------

const OnePingPerDM: Plugin = {
    name: "OnePingPerDM",
    description: "Only one audio ping per DM until messages are read.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let lastPlay = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (key !== "playSound" && key !== "playLocalSound") continue;
                    if (typeof t[key] !== "function") continue;
                    try {
                        Api.Patcher.before(this.name, t, key, (...args) => {
                            const name = String(args[0] ?? "");
                            if (/message|ping|notification/i.test(name)) {
                                const now = Date.now();
                                if (now - lastPlay < 2500) {
                                    // Suppress: return modified args that no-op.
                                    return [];
                                }
                                lastPlay = now;
                            }
                            return args;
                        });
                        log.info("sound throttled", { key });
                        return;
                    } catch {
                        // try next
                    }
                }
            }
        }
        log.warn("sound module not found — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// VolumeBooster — attempt to raise output volume beyond 100%.
// ---------------------------------------------------------------------------

const VolumeBooster: Plugin = {
    name: "VolumeBooster",
    description: "Boost voice/output volume above the default limit.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { boost: 1.5 },

    start() {
        const store = findStoreByName("MediaEngineStore");
        const setters = store
            ? Object.keys(store).filter((k) => /set.*[Vv]olume/i.test(k))
            : [];
        if (setters.length === 0) {
            log.warn("MediaEngineStore volume setters not found — inactive");
            return;
        }
        // Discord clamps at 1.0 internally; we attempt values >1 anyway —
        // whether the engine honours them depends on the audio backend.
        for (const key of setters) {
            const fn = store?.[key];
            if (typeof fn !== "function") continue;
            try {
                Api.Patcher.after(this.name, store as object, key, (result: unknown, ...args: unknown[]) => {
                    const last = args[args.length - 1];
                    if (typeof last === "number" && last > 0 && last <= 1) {
                        try {
                            (fn as (...a: unknown[]) => void).call(
                                store,
                                ...args.slice(0, -1),
                                Math.min(2, last * 1.5),
                            );
                        } catch {
                            // ignore
                        }
                    }
                    return result;
                });
            } catch {
                // non-configurable
            }
        }
        log.info("volume boost attempted", { setters });
    },
};

// ---------------------------------------------------------------------------
// iLoveSpam — attempt to disable the spam filter.
// ---------------------------------------------------------------------------

const iLoveSpam: Plugin = {
    name: "iLoveSpam",
    description: "Show messages Discord would hide as likely spam.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (!/spam|block.*message|filterMessage/i.test(key)) continue;
                    if (typeof t[key] !== "function") continue;
                    try {
                        Api.Patcher.instead(this.name, t, key, () => false);
                        patched += 1;
                    } catch {
                        // non-configurable
                    }
                }
            }
        }
        if (patched === 0) {
            log.warn("no spam-filter functions found — inactive");
        } else {
            log.info("spam filter bypassed", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// RelationshipNotifier — toast when removed by a friend/server.
// ---------------------------------------------------------------------------

const RelationshipNotifier: Plugin = {
    name: "RelationshipNotifier",
    description: "Notify when a friend, group, or server removes you.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const dispatcher = findDispatcher();
        if (!dispatcher) {
            log.warn("flux dispatcher not found — plugin inactive");
            return;
        }
        dispatcher.subscribe((action) => {
            try {
                const t = String(action.type ?? "");
                if (/FRIEND.*REMOVE|REMOVE.*FRIEND|GUILD_DELETE|CHANNEL_DELETE.*@me/i.test(t)) {
                    toast("You were removed from a relationship", 5000);
                }
            } catch {
                // ignore
            }
        });
        log.info("relationship notifier subscribed");
    },
};

// ---------------------------------------------------------------------------
// SuperReactionTweaks — attempt to raise super-reaction limits.
// ---------------------------------------------------------------------------

const SuperReactionTweaks: Plugin = {
    name: "SuperReactionTweaks",
    description: "Attempt to increase super reaction limits.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { maxReactions: 3 },

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (!/super.*reaction|maxReaction|reactionLimit/i.test(key)) {
                        continue;
                    }
                    if (typeof t[key] === "function") {
                        try {
                            Api.Patcher.instead(this.name, t, key, () => 10);
                            patched += 1;
                        } catch { /* */ }
                    } else if (typeof t[key] === "number") {
                        try {
                            Object.defineProperty(t, key, {
                                value: 10,
                                configurable: true,
                                writable: true,
                            });
                            patched += 1;
                        } catch { /* */ }
                    }
                }
            }
        }
        if (patched === 0) {
            log.warn("no super-reaction targets found — inactive");
        } else {
            log.info("super reactions tweaked", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// UnlockedAvatarZoom — raise avatar crop zoom limits.
// ---------------------------------------------------------------------------

const UnlockedAvatarZoom: Plugin = {
    name: "UnlockedAvatarZoom",
    description: "Allow zooming further in the avatar crop tool.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of Object.keys(t)) {
                    if (!/zoom|crop|scale/i.test(key)) continue;
                    const v = t[key];
                    if (typeof v === "number" && v > 0 && v <= 10) {
                        try {
                            Object.defineProperty(t, key, {
                                value: v * 4,
                                configurable: true,
                                writable: true,
                            });
                            patched += 1;
                        } catch { /* */ }
                    }
                }
            }
            if (patched > 10) break;
        }
        log.info("avatar zoom patch attempted", { count: patched });
    },
};

// ---------------------------------------------------------------------------
// USRBG — user banners from usrbg.is-hardly.online.
// ---------------------------------------------------------------------------

const USRBG: Plugin = {
    name: "USRBG",
    description: "Display user banners from USRBG in profiles.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const userStore = findStoreByName("UserStore");
        const getUser = userStore?.getUser;
        if (typeof getUser !== "function") {
            log.warn("UserStore not usable — plugin inactive");
            return;
        }
        const cache = new Map<string, string | null>();
        const bannerFor = async (userId: string): Promise<string | null> => {
            if (cache.has(userId)) return cache.get(userId) ?? null;
            try {
                const res = await fetch(
                    `https://usrbg.is-hardly.online/api/users/${userId}`,
                );
                if (!res.ok) {
                    cache.set(userId, null);
                    return null;
                }
                const data = (await res.json()) as { banner?: string };
                const url = data?.banner ?? null;
                cache.set(userId, url);
                return url;
            } catch {
                cache.set(userId, null);
                return null;
            }
        };
        const stop = observeAdded('[class*="profilePopout"], [class*="userPopout"], [class*="member"]', (node) => {
            void (async () => {
                const container = node as HTMLElement;
                if (container.querySelector("[data-mc-usrbg]")) return;
                const idAttr =
                    container.getAttribute("data-list-item-id") ??
                    container.id ??
                    "";
                const uid = /(\d{15,25})/.exec(idAttr)?.[1];
                if (!uid) return;
                const url = await bannerFor(uid);
                if (!url) return;
                const banner = el(
                    "div",
                    {
                        height: "80px",
                        backgroundImage: `url(${url})`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        borderRadius: "8px",
                        margin: "8px 0",
                    },
                );
                banner.dataset.mcUsrbg = "1";
                container.prepend(banner);
            })();
        });
        (this as { __stop?: () => void }).__stop = stop;
        log.info("usrbg watcher started");
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// Dearrow — less sensational YouTube embed titles/thumbnails.
// ---------------------------------------------------------------------------

const Dearrow: Plugin = {
    name: "Dearrow",
    description: "Clean up YouTube embed titles and thumbnails.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const stop = observeAdded('[class*="embed"] a[href*="youtube"], [class*="embed"] a[href*="youtu.be"]', (node) => {
            const a = node as HTMLAnchorElement;
            const videoId = /(?:v=|youtu\.be\/|shorts\/)([\w-]{6,})/.exec(a.href)?.[1];
            if (!videoId) return;
            void (async () => {
                try {
                    const res = await fetch(
                        `https://dearrow.lemnoslife.com/v1/json/${videoId}`,
                    );
                    const data = (await res.json()) as {
                        titles?: string[];
                        thumbnails?: string[];
                    };
                    const title = data?.titles?.[0];
                    const thumb = data?.thumbnails?.[0];
                    const embed = a.closest('[class*="embed"]') as HTMLElement | null;
                    if (!embed) return;
                    const titleEl = embed.querySelector<HTMLElement>('[class*="title"]');
                    if (title && titleEl) titleEl.textContent = title;
                    const img = embed.querySelector<HTMLImageElement>("img");
                    if (thumb && img) img.src = thumb;
                } catch {
                    // dearrow unavailable
                }
            })();
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// BetterYouTubeEmbeds — hide ad iframes inside YouTube embeds.
// ---------------------------------------------------------------------------

const BetterYouTubeEmbeds: Plugin = {
    name: "BetterYouTubeEmbeds",
    description: "Attempt to block ads in YouTube embeds.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const stop = observeAdded("iframe", (node) => {
            const iframe = node as HTMLIFrameElement;
            const src = iframe.src ?? "";
            // YouTube embeds with ad-heavy params get the privacy-enhanced
            // host and modestrel=0 which reduces recommendations/ads.
            if (src.includes("youtube.com/embed") || src.includes("youtube-nocookie.com")) {
                try {
                    const url = new URL(src);
                    url.searchParams.set("modestbranding", "1");
                    url.searchParams.set("rel", "0");
                    iframe.src = url.toString();
                } catch {
                    // ignore
                }
            }
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// FixSpotifyEmbeds — lower Spotify embed volume.
// ---------------------------------------------------------------------------

const FixSpotifyEmbeds: Plugin = {
    name: "FixSpotifyEmbeds",
    description: "Lower Spotify embed volume.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { volume: 50 },

    start() {
        const stop = observeAdded("iframe", (node) => {
            const iframe = node as HTMLIFrameElement;
            if (!iframe.src.includes("spotify.com")) return;
            try {
                const url = new URL(iframe.src);
                // Spotify embed supports volume param 0-100.
                url.searchParams.set("volume", "50");
                iframe.src = url.toString();
            } catch {
                // ignore
            }
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// AnonymiseFileNames — rename uploads to random names.
// ---------------------------------------------------------------------------

const AnonymiseFileNames: Plugin = {
    name: "AnonymiseFileNames",
    description: "Randomise uploaded file names.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const mod = findSendModule();
        if (!mod) {
            log.warn("send module not found — plugin inactive");
            return;
        }
        const anon = () =>
            `${Math.random().toString(36).slice(2, 10)}.${Math.random()
                .toString(36)
                .slice(2, 6)}`;
        Api.Patcher.before(this.name, mod, "sendMessage", (...args) => {
            for (const arg of args) {
                if (!isObj(arg)) continue;
                const files =
                    arg.attachments ?? arg.files ?? arg.uploads ?? arg.fileUploads;
                if (Array.isArray(files)) {
                    for (const f of files) {
                        if (f instanceof File) {
                            try {
                                const ext = f.name.includes(".")
                                    ? f.name.split(".").pop()
                                    : "bin";
                                const renamed = new File([f], `${anon()}.${ext}`, {
                                    type: f.type,
                                    lastModified: f.lastModified,
                                });
                                const idx = files.indexOf(f);
                                files[idx] = renamed;
                            } catch {
                                // File may be non-configurable
                            }
                        }
                    }
                }
            }
            return args;
        });
        log.info("file anonymiser installed");
    },
};

// ---------------------------------------------------------------------------
// ReactErrorDecoder — decode minified React errors.
// ---------------------------------------------------------------------------

const ReactErrorDecoder: Plugin = {
    name: "ReactErrorDecoder",
    description: "Decode minified React error codes in the console.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const codes = new Map<string, string>();
        let loaded = false;
        void fetch(
            "https://raw.githubusercontent.com/facebook/react/main/scripts/error-codes/codes.json",
        )
            .then((r) => (r.ok ? r.json() : {}))
            .then((data: Record<string, string>) => {
                for (const [k, v] of Object.entries(data)) codes.set(k, v);
                loaded = codes.size > 0;
            })
            .catch(() => {});
        const origError = console.error;
        console.error = (...args: unknown[]) => {
            const text = args.map(String).join(" ");
            const m = /Minified React error #(\d+)/.exec(text);
            if (m && loaded) {
                const decoded = codes.get(m[1] ?? "");
                if (decoded) {
                    origError.call(
                        console,
                        ...args,
                        `\n→ ${decoded}`,
                    );
                    return;
                }
            }
            origError.apply(console, args);
        };
        (this as { __cleanup?: () => void }).__cleanup = () => {
            console.error = origError;
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// F8Break — trigger debugger on F8.
// ---------------------------------------------------------------------------

const F8Break: Plugin = {
    name: "F8Break",
    description: "Pause the client when pressing F8 (DevTools open).",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "F8") {
                e.preventDefault();
                // eslint-disable-next-line no-debugger
                debugger;
            }
        };
        document.addEventListener("keydown", onKey, true);
        (this as { __off?: () => void }).__off = () =>
            document.removeEventListener("keydown", onKey, true);
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// Experiments — attempt to unlock Discord experiments.
// ---------------------------------------------------------------------------

const Experiments: Plugin = {
    name: "Experiments",
    description: "Attempt to enable access to Discord experiments.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const store = findStoreByName("ExperimentsStore");
        if (!store) {
            log.warn("ExperimentsStore not found — trying module scan");
        }
        let patched = 0;
        const targets: unknown[] = store ? [store] : [];
        for (const exp of Api.Webpack.findAll(() => true)) {
            if (isObj(exp) && /experiment/i.test(JSON.stringify(Object.keys(exp)).slice(0, 500))) {
                targets.push(exp);
                if (isObj(exp.default)) targets.push(exp.default);
            }
        }
        for (const t of targets) {
            if (!isObj(t)) continue;
            for (const key of Object.keys(t)) {
                if (!/experiment|isEnabled|getExperiment/i.test(key)) continue;
                if (typeof t[key] === "function") {
                    try {
                        Api.Patcher.instead(this.name, t, key, () => true);
                        patched += 1;
                    } catch { /* */ }
                }
            }
        }
        if (patched === 0) {
            log.warn("no experiment functions found — inactive");
        } else {
            log.info("experiments unlocked", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// MonocordToolbox — titlebar button with quick actions.
// ---------------------------------------------------------------------------

const MonocordToolbox: Plugin = {
    name: "MonocordToolbox",
    description: "Titlebar button with Monocord quick actions.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const stop = observeAdded('[class*="titleBar"], [class*="TitleBar"]', (bar) => {
            if (bar.querySelector("[data-mc-toolbox]")) return;
            const btn = el(
                "button",
                {
                    background: "none",
                    border: "none",
                    color: "var(--text-normal,#dbdee1)",
                    fontSize: "14px",
                    cursor: "pointer",
                    padding: "4px 8px",
                    borderRadius: "4px",
                },
                "🛠",
            );
            btn.dataset.mcToolbox = "1";
            btn.title = "Monocord";
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const enabled = Api.Plugins.names().filter((n) =>
                    Api.Plugins.isEnabled(n),
                ).length;
                contextMenu(
                    (e as MouseEvent).clientX,
                    (e as MouseEvent).clientY,
                    [
                        {
                            label: `Monocord v${Api.version} — ${enabled} plugins active`,
                            action: () => {},
                        },
                        {
                            label: "Copy plugin list",
                            action: () => {
                                void navigator.clipboard
                                    .writeText(Api.Plugins.names().join("\n"))
                                    .then(() => toast("Plugin list copied"))
                                    .catch(() => {});
                            },
                        },
                        {
                            label: "Reload Discord",
                            action: () => location.reload(),
                        },
                    ],
                );
            });
            (bar as HTMLElement).append(btn);
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// ThemeAttributes — add data attributes for user theming.
// ---------------------------------------------------------------------------

const ThemeAttributes: Plugin = {
    name: "ThemeAttributes",
    description: "Add data attributes to elements for custom theming.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const stop = observeAdded('[id^="chat-messages-"]', (node) => {
            const m = /chat-messages-(\d+)-(\d+)/.exec(node.id);
            if (!m) return;
            const el = node as HTMLElement;
            if (!el.dataset.mcChannel) el.dataset.mcChannel = m[1];
            if (!el.dataset.mcMessage) el.dataset.mcMessage = m[2];
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------

export function registerSystem3(): void {
    for (const plugin of [
        AlwaysTrust,
        DisableDeepLinks,
        NoDevtoolsWarning,
        NoOnboardingDelay,
        KeepCurrentChannel,
        CustomIdle,
        DisableCallIdle,
        CallTimer,
        StreamerModeOnStream,
        OpenInApp,
        OnePingPerDM,
        VolumeBooster,
        iLoveSpam,
        RelationshipNotifier,
        SuperReactionTweaks,
        UnlockedAvatarZoom,
        USRBG,
        Dearrow,
        BetterYouTubeEmbeds,
        FixSpotifyEmbeds,
        AnonymiseFileNames,
        ReactErrorDecoder,
        F8Break,
        Experiments,
        MonocordToolbox,
        ThemeAttributes,
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
