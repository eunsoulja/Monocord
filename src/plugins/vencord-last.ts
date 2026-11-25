/**
 * Final wave of Vencord ports — lite/DOM/store implementations plus
 * best-effort probes for plugins whose upstream versions need
 * string-replacement webpack patches.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { contextMenu, el, on, observeAdded } from "./dom-utils";
import {
    findDispatcher,
    findSendModule,
    findStoreByName,
    isObj,
    type Dispatcher,
} from "./mods";

const log = Logger.get("vencord-last");

function storeMethod<T extends (...args: never[]) => unknown>(
    name: string,
    method: string,
): T | null {
    const store = findStoreByName(name);
    const fn = store?.[method];
    return typeof fn === "function" ? (fn as T) : null;
}

// ---------------------------------------------------------------------------
// ConsoleShortcuts — window.mc debugging shortcuts (lite port).
// ---------------------------------------------------------------------------

const ConsoleShortcuts: Plugin = {
    name: "ConsoleShortcuts",
    description: "Exposes `window.mc` with API, stores, and webpack helpers for console debugging.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const w = window as unknown as Record<string, unknown>;
        if (w.mc) return;
        w.mc = {
            Api,
            Plugins: Api.Plugins,
            Settings: Api.Settings,
            Events: Api.Events,
            Themes: Api.Themes,
            version: Api.version,
            reload: () => location.reload(),
            plugins: () => Api.Plugins.names(),
            enable: (n: string) => Api.Plugins.enable(n),
            disable: (n: string) => Api.Plugins.disable(n),
            stores: () => {
                const out: Record<string, unknown> = {};
                for (const name of [
                    "UserStore", "GuildStore", "ChannelStore", "MessageStore",
                    "ReadStateStore", "GuildMemberStore", "PresenceStore",
                    "RelationshipStore", "EmojiStore", "UserProfileStore",
                    "SelectedChannelStore", "PermissionStore",
                ]) {
                    const s = Api.Webpack.findStore(name);
                    if (s) out[name] = s;
                }
                return out;
            },
            find: (f: unknown) => Api.Webpack.find(f as never),
            findAll: (f: unknown) => Api.Webpack.findAll(f as never),
            findByProps: (...p: string[]) => Api.Webpack.findByProps(...p),
            findAllByProps: (...p: string[]) => Api.Webpack.findAllByProps(...p),
            findStore: (n: string) => Api.Webpack.findStore(n),
            channelId: () =>
                /\/channels\/(?:@me|\d+)\/(\d+)/.exec(location.pathname)?.[1] ?? null,
            guildId: () => /\/channels\/(\d{15,25})\//.exec(location.pathname)?.[1] ?? null,
            dispatch: (a: Record<string, unknown>) => {
                const d = findDispatcher() as
                    | (Dispatcher & { dispatch(x: Record<string, unknown>): void })
                    | null;
                d?.dispatch(a);
            },
            shortcutList: () => Object.keys(w.mc as object),
        };
        log.info("window.mc shortcuts installed — run `mc.shortcutList()`");
    },
};

// ---------------------------------------------------------------------------
// MusicRichPresence — Last.fm scrobbling → rich presence.
// ---------------------------------------------------------------------------

const MusicRichPresence: Plugin = {
    name: "MusicRichPresence",
    description:
        "Show your current Last.fm track as Discord rich presence. Requires a Last.fm API key.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: {
        apiKey: "",
        username: "",
        showAlbum: true,
        mode: "listening",
    },
    settingsSchema: {
        apiKey: {
            type: "string",
            label: "Last.fm API key",
            description: "Get one free at last.fm/api/account/create.",
        },
        username: { type: "string", label: "Last.fm username" },
        showAlbum: { type: "boolean", label: "Show album name" },
        mode: {
            type: "select",
            label: "Activity type",
            options: [
                { label: "Listening", value: "listening" },
                { label: "Playing", value: "playing" },
            ],
        },
    },

    async start() {
        const dispatcher = findDispatcher() as
            | (Dispatcher & { dispatch(a: Record<string, unknown>): void })
            | null;
        if (!dispatcher?.dispatch) {
            log.warn("dispatcher not found — plugin inactive");
            return;
        }
        let timer: ReturnType<typeof setInterval> | undefined;
        let lastTrack = "";

        const tick = async () => {
            const apiKey = await Api.Settings.get<string>(
                "plugins.settings.MusicRichPresence.apiKey",
            );
            const username = await Api.Settings.get<string>(
                "plugins.settings.MusicRichPresence.username",
            );
            if (!apiKey || !username) {
                if (lastTrack) {
                    lastTrack = "";
                    dispatcher.dispatch({
                        type: "LOCAL_ACTIVITY_UPDATE",
                        activity: null,
                        socketId: "MusicRichPresence",
                    });
                }
                return;
            }
            try {
                const url =
                    `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks` +
                    `&user=${encodeURIComponent(username)}&api_key=${encodeURIComponent(apiKey)}` +
                    `&format=json&limit=1`;
                const res = await fetch(url);
                const data = (await res.json()) as {
                    recenttracks?: { track?: Record<string, unknown>[] };
                };
                const track = data.recenttracks?.track?.[0];
                const name = String(track?.name ?? "");
                const artist = isObj(track?.artist)
                    ? String(track.artist["#text"] ?? "")
                    : "";
                if (!name || name === lastTrack) return;
                lastTrack = name;
                const showAlbum =
                    (await Api.Settings.get<boolean>(
                        "plugins.settings.MusicRichPresence.showAlbum",
                        true,
                    )) !== false;
                const album = showAlbum ? String(track?.album ?? "") : "";
                const mode =
                    (await Api.Settings.get<string>(
                        "plugins.settings.MusicRichPresence.mode",
                        "listening",
                    )) === "playing"
                        ? 0
                        : 2;
                dispatcher.dispatch({
                    type: "LOCAL_ACTIVITY_UPDATE",
                    activity: {
                        name: "Last.fm",
                        type: mode,
                        details: name,
                        state: [artist, album].filter(Boolean).join(" — ") || undefined,
                        assets: {
                            large_image: "https://www.last.fm/static/images/lastfm_avatar_walk.png",
                            large_text: "Last.fm",
                        },
                        application_id: "0",
                    },
                    socketId: "MusicRichPresence",
                });
            } catch (e) {
                log.debug("last.fm fetch failed", e);
            }
        };

        void tick();
        timer = setInterval(() => void tick(), 30_000);
        (this as { __timer?: unknown }).__timer = timer;
    },

    stop() {
        const t = (this as { __timer?: ReturnType<typeof setInterval> }).__timer;
        if (t) clearInterval(t);
        const dispatcher = findDispatcher() as
            | (Dispatcher & { dispatch(a: Record<string, unknown>): void })
            | null;
        dispatcher?.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: null,
            socketId: "MusicRichPresence",
        });
    },
};

// ---------------------------------------------------------------------------
// SpotifyControls — embed a Spotify player above the account panel (lite).
// ---------------------------------------------------------------------------

const SpotifyControls: Plugin = {
    name: "SpotifyControls",
    description: "Embed a Spotify player (artist/album/track/playlist URI) in the sidebar.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { spotifyUri: "" },
    settingsSchema: {
        spotifyUri: {
            type: "string",
            label: "Spotify URI or URL",
            description: "e.g. spotify:album:4LH4d3cOWNNsVw41Gqt2kv or an open.spotify.com link.",
            placeholder: "spotify:track:…",
        },
    },

    async start() {
        const raw = await Api.Settings.get<string>(
            "plugins.settings.SpotifyControls.spotifyUri",
        );
        const uri = (raw ?? "").trim();
        if (!uri) return;
        const m = /spotify:(\w+):([A-Za-z0-9]+)/.exec(uri) ??
            /open\.spotify\.com\/(\w+)\/([A-Za-z0-9]+)/.exec(uri);
        if (!m) {
            log.warn("invalid spotify uri — plugin inactive");
            return;
        }
        const [, kind, id] = m;
        if (!kind || !id) return;
        const src = `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`;

        const inject = () => {
            const panel = document.querySelector<HTMLElement>(
                '[class*="panels"], [class*="accountPanel"], nav [class*="wrapper"]',
            );
            if (!panel || panel.querySelector("[data-mc-spotify]")) return;
            const wrap = el("div", {
                padding: "8px",
                borderTop: "1px solid var(--background-modifier-accent,#3f4147)",
            });
            wrap.dataset.mcSpotify = "1";
            const iframe = document.createElement("iframe");
            iframe.src = src;
            iframe.style.cssText =
                "border-radius:8px;border:0;width:100%;height:152px;display:block;";
            iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
            iframe.loading = "lazy";
            wrap.append(iframe);
            panel.append(wrap);
        };
        inject();
        const stopObserve = observeAdded('[class*="accountPanel"], [class*="panels"]', inject);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            stopObserve();
            document.querySelectorAll("[data-mc-spotify]").forEach((n) => n.remove());
        };
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (path === "plugins.settings.SpotifyControls.spotifyUri") {
                location.reload();
            }
        });
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// WhoReacted — show reactor names in reaction tooltips (flux-lite).
// ---------------------------------------------------------------------------

interface ReactionEntry {
    users: Map<string, string>;
    emojiKey: string;
}

const WhoReacted: Plugin = {
    name: "WhoReacted",
    description: "Show who reacted to a message in the reaction tooltip.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const dispatcher = findDispatcher();
        const getUser = storeMethod<(id: string) => Record<string, unknown> | null>(
            "UserStore",
            "getUser",
        );
        if (!dispatcher || !getUser) {
            log.warn("dispatcher/UserStore missing — plugin inactive");
            return;
        }
        const reactions = new Map<string, ReactionEntry>(); // `${channelId}:${messageId}` -> emojiKey -> entry
        const key = (emoji: Record<string, unknown>) =>
            `${String(emoji.name ?? "")}:${String(emoji.id ?? "")}`;

        const sub = dispatcher.subscribe((action) => {
            const type = action.type;
            if (type !== "MESSAGE_REACTION_ADD" && type !== "MESSAGE_REACTION_REMOVE") return;
            const msgObj = isObj(action.message) ? action.message : null;
            const channelId = String(action.channelId ?? msgObj?.channel_id ?? "");
            const messageId = String(action.messageId ?? msgObj?.id ?? "");
            const userId = String(action.userId ?? "");
            const emoji = isObj(action.emoji) ? action.emoji : null;
            if (!channelId || !messageId || !userId || !emoji) return;
            const mapKey = `${channelId}:${messageId}`;
            let byEmoji = reactions.get(mapKey);
            if (!byEmoji) {
                // Store as emojiKey -> users map directly.
                byEmoji = { users: new Map(), emojiKey: "" };
                reactions.set(mapKey, byEmoji);
            }
            const ek = key(emoji);
            const users = (byEmoji as unknown as Record<string, Map<string, string>>)[ek] ??
                ((byEmoji as unknown as Record<string, Map<string, string>>)[ek] = new Map());
            if (type === "MESSAGE_REACTION_ADD") {
                const u = getUser(userId);
                const name = String(
                    (u?.global_name as string) ?? (u?.username as string) ?? userId,
                );
                users.set(userId, name);
            } else {
                users.delete(userId);
            }
        });

        const nameFor = (userId: string): string => {
            const u = getUser(userId);
            return String(
                (u?.global_name as string) ?? (u?.username as string) ?? userId,
            );
        };

        observeAdded('[class*="reaction"]', (node) => {
            const chip = node as HTMLElement;
            if (chip.dataset.mcWhoReacted) return;
            const msgRoot = chip.closest('[id^="chat-messages-"]');
            if (!msgRoot) return;
            const ids = /chat-messages-(\d+)-(\d+)/.exec(msgRoot.id);
            if (!ids?.[1] || !ids[2]) return;
            const entry = reactions.get(`${ids[1]}:${ids[2]}`);
            if (!entry) return;
            // Match this chip's emoji to a tracked reaction key.
            const emojiEl = chip.querySelector('[class*="emoji"], img[alt]');
            const alt = emojiEl?.getAttribute("alt") ?? "";
            let names: string[] = [];
            for (const [ek, users] of Object.entries(
                entry as unknown as Record<string, Map<string, string>>,
            )) {
                const emojiName = ek.split(":")[0];
                if (emojiName && alt && (alt.includes(emojiName) || emojiName.includes(alt))) {
                    names = [...users.values()];
                    break;
                }
            }
            if (!names.length) return;
            chip.dataset.mcWhoReacted = "1";
            chip.title = `Reacted by: ${names.slice(0, 20).join(", ")}`;
        });

        (this as { __sub?: unknown }).__sub = sub;
    },

    stop() {
        const sub = (this as { __sub?: { unsubscribe?: () => void } }).__sub;
        sub?.unsubscribe?.();
    },
};

// ---------------------------------------------------------------------------
// FullSearchContext — context menu on message-search results (lite).
// ---------------------------------------------------------------------------

const FullSearchContext: Plugin = {
    name: "FullSearchContext",
    description: "Right-click search results for Copy Text / Copy Link / Reply.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            '[class*="searchResult"], [class*="searchResultMessage"], li[class*="message"]',
            (el, ev) => {
                const msgRoot = el.closest('[id^="chat-messages-"]');
                if (!msgRoot) return;
                const text = msgRoot.textContent ?? "";
                const ids = /chat-messages-(\d+)-(\d+)/.exec(msgRoot.id);
                const items = [
                    {
                        label: "Copy Text",
                        action: () => void navigator.clipboard.writeText(text),
                    },
                ];
                if (ids?.[1] && ids[2]) {
                    items.push({
                        label: "Copy Message Link",
                        action: () =>
                            void navigator.clipboard.writeText(
                                `https://discord.com/channels/${ids[1]}/${ids[2]}`,
                            ),
                    });
                }
                const mev = ev as MouseEvent;
                ev.preventDefault();
                contextMenu(mev.clientX, mev.clientY, items);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// GameActivityToggle — button to toggle "Share your activity" (lite).
// ---------------------------------------------------------------------------

const GameActivityToggle: Plugin = {
    name: "GameActivityToggle",
    description: "Toggle game activity sharing from a button near voice controls.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        // Discord stores this in user settings; find the settings module.
        const settingsMod = Api.Webpack.findAllByProps("showCurrentGame");
        let setter: ((v: boolean) => void) | null = null;
        for (const exp of settingsMod) {
            const o = isObj(exp) ? exp : null;
            const d = o && isObj(o.default) ? o.default : null;
            for (const target of [o, d]) {
                if (!target) continue;
                for (const [k, v] of Object.entries(target)) {
                    if (typeof v === "function" && /update|set/i.test(k)) {
                        setter = (val: boolean) => {
                            try {
                                (v as (a: unknown) => void).call(target, {
                                    status: { showCurrentGame: val },
                                });
                            } catch {
                                try {
                                    (v as (a: unknown) => void).call(target, val);
                                } catch { /* ignore */ }
                            }
                        };
                    }
                }
            }
        }
        if (!setter) {
            log.warn("user settings module not found — plugin inactive");
            return;
        }
        let enabled = true;
        const inject = () => {
            const anchor = document.querySelector<HTMLElement>(
                '[class*="panels"] [class*="buttons"], [class*="voiceControls"]',
            );
            if (!anchor || anchor.querySelector("[data-mc-gameact]")) return;
            const btn = el(
                "button",
                {
                    marginLeft: "4px",
                    padding: "2px 8px",
                    fontSize: "12px",
                    borderRadius: "4px",
                    border: "1px solid var(--background-modifier-accent,#3f4147)",
                    background: "var(--background-secondary,#2b2d31)",
                    color: "var(--text-normal,#dbdee1)",
                    cursor: "pointer",
                },
                "Game Activity",
            );
            btn.dataset.mcGameact = "1";
            btn.title = "Toggle game activity sharing";
            btn.addEventListener("click", () => {
                enabled = !enabled;
                setter?.(enabled);
                btn.style.opacity = enabled ? "1" : "0.5";
            });
            anchor.append(btn);
        };
        inject();
        const stopObserve = observeAdded('[class*="voiceControls"], [class*="panels"]', inject);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            stopObserve();
            document.querySelectorAll("[data-mc-gameact]").forEach((n) => n.remove());
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// NoReplyMention — strip reply pings in send options (best-effort).
// ---------------------------------------------------------------------------

const NoReplyMention: Plugin = {
    name: "NoReplyMention",
    description: "Send replies without pinging the original author.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { enabled: true },
    settingsSchema: {
        enabled: { type: "boolean", label: "Don't ping on reply" },
    },

    start() {
        const mod = findSendModule();
        if (!mod) {
            log.warn("send module not found — plugin inactive");
            return;
        }
        Api.Patcher.before(this.name, mod, "sendMessage", (...args) => {
            const messageData = args[1];
            const options = args[2];
            if (!isObj(messageData) || !isObj(messageData.messageReference)) return;
            const ref = messageData.messageReference;
            if (!isObj(ref) || !ref.message_id) return;
            // Neutralise mention flags wherever they appear.
            for (const target of [messageData, options]) {
                if (!isObj(target)) continue;
                for (const key of ["shouldMention", "mentioned", "mention"]) {
                    if (key in target) target[key] = false;
                }
            }
        });
    },
};

// ---------------------------------------------------------------------------
// OverrideForumDefaults — patch getDefaultLayout/getDefaultSortOrder probes.
// ---------------------------------------------------------------------------

const OverrideForumDefaults: Plugin = {
    name: "OverrideForumDefaults",
    description: "Override default forum layout (List/Gallery) and sort order.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { layout: 1, sortOrder: 0 },
    settingsSchema: {
        layout: {
            type: "select",
            label: "Default layout",
            options: [
                { label: "List", value: "1" },
                { label: "Gallery", value: "2" },
            ],
        },
        sortOrder: {
            type: "select",
            label: "Default sort order",
            options: [
                { label: "Recently Active", value: "0" },
                { label: "Date Posted", value: "1" },
            ],
        },
    },

    start() {
        let layout = 1;
        let sortOrder = 0;
        const KEY = "plugins.settings.OverrideForumDefaults.";
        const load = async () => {
            layout =
                (await Api.Settings.get<number>(`${KEY}layout`, 1)) ?? 1;
            sortOrder =
                (await Api.Settings.get<number>(`${KEY}sortOrder`, 0)) ?? 0;
        };
        void load();
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (typeof path === "string" && path.startsWith(KEY)) void load();
        });
        let patched = 0;
        for (const exp of Api.Webpack.findAllByProps("getDefaultLayout")) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && isObj(exp.default)) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                if (typeof t.getDefaultLayout === "function") {
                    Api.Patcher.instead(this.name, t, "getDefaultLayout", () => layout);
                    patched++;
                }
                if (typeof t.getDefaultSortOrder === "function") {
                    Api.Patcher.instead(this.name, t, "getDefaultSortOrder", () => sortOrder);
                    patched++;
                }
            }
        }
        if (!patched) log.warn("forum defaults module not found — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// MoreQuickReactions — probe-based attempt at the quick-react count.
// ---------------------------------------------------------------------------

const MoreQuickReactions: Plugin = {
    name: "MoreQuickReactions",
    description: "Increase quick reactions shown on message hover (best-effort).",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { count: 5 },
    settingsSchema: {
        count: { type: "number", label: "Reaction count (0-42)" },
    },

    start() {
        let count = 5;
        const KEY = "plugins.settings.MoreQuickReactions.count";
        void Api.Settings.get<number>(KEY, 5).then((v) => (count = v ?? 5));
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (path === KEY) void Api.Settings.get<number>(KEY, 5).then((v) => (count = v ?? 5));
        });
        // The quick-react slice lives inside a component; try common export
        // shapes that expose the reaction list length.
        const probes = [
            Api.Webpack.findByProps("quickReactions"),
            Api.Webpack.findByProps("getQuickReactions"),
        ];
        let ok = false;
        for (const p of probes) {
            if (isObj(p)) {
                for (const [k, v] of Object.entries(p)) {
                    if (typeof v === "function" && /reaction/i.test(k)) {
                        Api.Patcher.after(this.name, p, k, (result: unknown) => {
                            if (Array.isArray(result)) {
                                return result.slice(0, Math.max(0, Math.min(42, count)));
                            }
                            return result;
                        });
                        ok = true;
                    }
                }
            }
        }
        if (!ok) log.warn("quick reactions module not found — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// NoServerEmojis — filter server emojis from autocomplete (best-effort).
// ---------------------------------------------------------------------------

const NoServerEmojis: Plugin = {
    name: "NoServerEmojis",
    description: "Hide server emojis from the emoji autocomplete.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { mode: "onlyUnicode" },
    settingsSchema: {
        mode: {
            type: "select",
            label: "Shown emojis",
            options: [
                { label: "Only unicode emojis", value: "onlyUnicode" },
                { label: "Unicode + current server", value: "currentServer" },
                { label: "All (Discord default)", value: "all" },
            ],
        },
    },

    start() {
        let mode = "onlyUnicode";
        const KEY = "plugins.settings.NoServerEmojis.mode";
        void Api.Settings.get<string>(KEY, "onlyUnicode").then((v) => (mode = v ?? "onlyUnicode"));
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (path === KEY) void Api.Settings.get<string>(KEY, "onlyUnicode").then((v) => (mode = v ?? "onlyUnicode"));
        });
        const candidates = Api.Webpack.findAllByProps("searchWithoutFetchingLatest");
        let patched = 0;
        for (const exp of candidates) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && isObj(exp.default)) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                const fn = t.searchWithoutFetchingLatest;
                if (typeof fn !== "function") continue;
                Api.Patcher.after(this.name, t, "searchWithoutFetchingLatest", (result: unknown) => {
                    if (mode === "all" || !Array.isArray(result)) return result;
                    return result.filter((e: unknown) => {
                        if (!isObj(e)) return true;
                        // Discord emoji type 1 = guild emoji.
                        if (e.type !== 1) return true;
                        return mode === "currentServer";
                    });
                });
                patched++;
            }
        }
        if (!patched) log.warn("emoji search module not found — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// FavoriteEmojiFirst — sort favorites first in emoji autocomplete.
// ---------------------------------------------------------------------------

const FavoriteEmojiFirst: Plugin = {
    name: "FavoriteEmojiFirst",
    description: "Show favorite emoji first in the emoji picker (best-effort).",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const store = findStoreByName("EmojiStore");
        if (!store) {
            log.warn("EmojiStore not found — plugin inactive");
            return;
        }
        let patched = 0;
        const getFavs = store.getFavorites;
        for (const key of Object.keys(store)) {
            const v = store[key];
            if (typeof v !== "function" || !/emoji|favorite/i.test(key)) continue;
            Api.Patcher.after(this.name, store, key, (result: unknown) => {
                if (!Array.isArray(result)) return result;
                const favs =
                    typeof getFavs === "function"
                        ? (getFavs as () => { id?: string; name?: string }[]).call(store)
                        : [];
                const favIds = new Set(
                    favs.map((f) => `${f.name}:${f.id ?? ""}`),
                );
                if (!favIds.size) return result;
                const rank = (e: unknown) => {
                    if (!isObj(e)) return 1;
                    return favIds.has(`${String(e.name ?? "")}:${String(e.id ?? "")}`) ? 0 : 1;
                };
                return [...result].sort((a, b) => rank(a) - rank(b));
            });
            patched++;
        }
        if (!patched) log.warn("no emoji methods found on EmojiStore — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// WebScreenShareFixes — probe for bitrate/framerate caps (best-effort).
// ---------------------------------------------------------------------------

const WebScreenShareFixes: Plugin = {
    name: "WebScreenShareFixes",
    description: "Attempt to raise screenshare bitrate/framerate caps (best-effort).",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let patched = 0;
        for (const exp of Api.Webpack.findAllByProps("maxBitrate", "frameRate")) {
            const targets: unknown[] = [exp];
            if (isObj(exp) && isObj(exp.default)) targets.push(exp.default);
            for (const t of targets) {
                if (!isObj(t)) continue;
                for (const key of ["maxBitrate", "frameRate", "maxFrameRate"]) {
                    const v = t[key];
                    if (typeof v === "number" && v > 0 && v <= 2500) {
                        try {
                            (t as Record<string, unknown>)[key] = key === "maxBitrate" ? 8000 : 60;
                            patched++;
                        } catch { /* readonly */ }
                    }
                }
            }
        }
        if (!patched) {
            log.warn("screenshare settings module not found — plugin inactive");
        } else {
            log.info(`raised ${patched} screenshare caps`);
        }
    },
};

// ---------------------------------------------------------------------------

const PLUGINS: Plugin[] = [
    ConsoleShortcuts,
    MusicRichPresence,
    SpotifyControls,
    WhoReacted,
    FullSearchContext,
    GameActivityToggle,
    NoReplyMention,
    OverrideForumDefaults,
    MoreQuickReactions,
    NoServerEmojis,
    FavoriteEmojiFirst,
    WebScreenShareFixes,
];

export function registerVencordLast(): void {
    for (const p of PLUGINS) {
        try {
            Api.Plugins.register(p);
        } catch (e) {
            log.warn(`register ${p.name} failed`, e);
        }
    }
}
