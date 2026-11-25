/**
 * Second wave of Vencord ports — DOM/store-based implementations of plugins
 * whose upstream versions need string-replacement webpack patches we can't
 * perform. All degrade gracefully when Discord internals don't match.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { el, observeAdded } from "./dom-utils";
import { findDispatcher, findStoreByName, isObj, type Dispatcher } from "./mods";

const log = Logger.get("vencord-late");

function storeMethod<T extends (...args: never[]) => unknown>(
    name: string,
    method: string,
): T | null {
    const store = findStoreByName(name);
    const fn = store?.[method];
    return typeof fn === "function" ? (fn as T) : null;
}

// ---------------------------------------------------------------------------
// LoadingQuotes — replace Discord's loading-screen quotes.
// ---------------------------------------------------------------------------

const PRESET_QUOTES = [
    "Did you know? You can press Ctrl+K to quick switch channels.",
    "Pro tip: Shift+Click a message to select multiple messages.",
    "You can reply to a message by swiping right on mobile.",
    "Discord was originally called 'Scratchpad'.",
    "You can pin up to 50 messages per channel.",
    "Hold Alt while dragging to resize image previews.",
    "You can use ||spoiler tags|| to hide text until hovered.",
    "Pressing ? shows you all available keyboard shortcuts.",
    "You can edit your own messages for up to a year.",
    "Nitro boosts level up your server's emoji slots and quality.",
    "You can react with any emoji, including server-specific ones.",
    "Drag and drop files anywhere in a channel to upload them.",
    "You can create a poll using the built-in poll feature.",
    "Typing / in chat opens the slash command menu.",
    "You can mute a channel without leaving it.",
    "Server discovery lets you find communities by topic.",
    "You can mark a server as a home channel for quick access.",
    "Push-to-talk can be bound to any key or mouse button.",
    "You can stream your screen in any voice channel.",
    "Custom statuses let you show what you're up to.",
];

const LoadingQuotes: Plugin = {
    name: "LoadingQuotes",
    description: "Replace Discord's loading quotes with your own.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { quotes: "", usePreset: true, useDiscord: false },
    settingsSchema: {
        usePreset: {
            type: "boolean",
            label: "Include preset quotes",
            description: "Use Monocord's built-in quote list.",
        },
        useDiscord: {
            type: "boolean",
            label: "Keep Discord quotes",
            description: "Also show Discord's original loading quotes.",
        },
        quotes: {
            type: "textarea",
            label: "Custom quotes",
            description: "One quote per line.",
        },
    },

    async start() {
        const readQuotes = async (): Promise<string[]> => {
            const s = await Promise.all([
                Api.Settings.get<boolean>("plugins.settings.LoadingQuotes.usePreset", true),
                Api.Settings.get<boolean>("plugins.settings.LoadingQuotes.useDiscord", false),
                Api.Settings.get<string>("plugins.settings.LoadingQuotes.quotes", ""),
            ]);
            const out: string[] = [];
            if (s[1]) out.push("__DISCORD__");
            if (s[0]) out.push(...PRESET_QUOTES);
            out.push(
                ...(s[2] ?? "")
                    .split("\n")
                    .map((q) => q.trim())
                    .filter(Boolean),
            );
            return out;
        };

        let quotes = await readQuotes();
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (typeof path === "string" && path.startsWith("plugins.settings.LoadingQuotes")) {
                void readQuotes().then((q) => (quotes = q));
            }
        });

        const pick = () =>
            quotes.length ? quotes[Math.floor(Math.random() * quotes.length)] : null;

        observeAdded('[class*="quote" i]', (node) => {
            const html = node as HTMLElement;
            if (html.dataset.mcQuote) return;
            // Skip anything inside rendered messages — only the loading screen.
            if (html.closest('[class*="message"]')) return;
            const replacement = pick();
            if (!replacement || replacement === "__DISCORD__") return;
            html.dataset.mcQuote = "1";
            const original = html.textContent ?? "";
            html.dataset.mcQuoteOrig = original;
            html.textContent = replacement;
        });
    },
};

// ---------------------------------------------------------------------------
// MessageLinkEmbeds — preview linked Discord messages already in MessageStore.
// ---------------------------------------------------------------------------

const MessageLinkEmbeds: Plugin = {
    name: "MessageLinkEmbeds",
    description:
        "Preview messages linked with discord.com/channels URLs (uses already-loaded messages only).",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const getMessage = storeMethod<(c: string, m: string) => Record<string, unknown> | null>(
            "MessageStore",
            "getMessage",
        );
        if (!getMessage) {
            log.warn("MessageStore.getMessage not found — plugin inactive");
            return;
        }
        const cache = new Map<string, boolean>();
        const linkRe = /https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/;

        observeAdded("a[href*='discord.com/channels/'], a[href*='discordapp.com/channels/']", (a) => {
            const html = a as HTMLAnchorElement;
            const msgRoot = html.closest('[id^="chat-messages-"]');
            if (!msgRoot || msgRoot.querySelector("[data-mc-msglink]")) return;
            const m = linkRe.exec(html.href);
            if (!m) return;
            const [, channelId, messageId] = m;
            if (!channelId || !messageId) return;
            const key = `${channelId}:${messageId}`;
            if (cache.get(key)) return;
            let msg: Record<string, unknown> | null = null;
            try {
                msg = getMessage(channelId, messageId);
            } catch {
                msg = null;
            }
            cache.set(key, !!msg);
            if (!msg) return;

            const author = isObj(msg.author) ? msg.author : {};
            const authorName = String(author.global_name ?? author.username ?? "Unknown");
            const content = String(msg.content ?? "").slice(0, 140);
            const card = el(
                "div",
                {
                    marginTop: "4px",
                    padding: "6px 10px",
                    borderLeft: "3px solid var(--brand-500,#5865f2)",
                    background: "var(--background-secondary,#2b2d31)",
                    borderRadius: "4px",
                    fontSize: "13px",
                },
            );
            card.dataset.mcMsglink = "1";
            card.append(
                el(
                    "div",
                    { fontWeight: "600", fontSize: "12px", color: "var(--text-muted,#949ba4)" },
                    authorName,
                ),
                el("div", { marginTop: "2px" }, content || "(no text content)"),
            );
            const contentEl = html.closest('[class*="content"], [class*="messageContent"]') ?? msgRoot;
            contentEl.append(card);
        });
    },
};

// ---------------------------------------------------------------------------
// DontRoundMyTimestamps — floor relative-time rounding via moment.
// ---------------------------------------------------------------------------

const DontRoundMyTimestamps: Plugin = {
    name: "DontRoundMyTimestamps",
    description: "Round relative timestamps down (7.6y → 7y instead of 8y).",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const candidates = Api.Webpack.findAll(() => true);
        for (const exp of candidates) {
            const objs = [exp, isObj(exp) ? exp.default : null].filter(isObj);
            for (const o of objs) {
                const rtr = o.relativeTimeRounding;
                if (typeof rtr === "function") {
                    try {
                        rtr(Math.floor);
                        log.info("moment.relativeTimeRounding → floor");
                        return;
                    } catch (e) {
                        log.debug("relativeTimeRounding call failed", e);
                    }
                }
            }
        }
        log.warn("moment.relativeTimeRounding not found — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// ReadAllNotificationsButton — BULK_ACK everything via flux.
// ---------------------------------------------------------------------------

const ReadAllNotificationsButton: Plugin = {
    name: "ReadAllNotificationsButton",
    description: "Mark all server notifications as read with one click.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const dispatcher = findDispatcher() as
            | (Dispatcher & { dispatch(a: Record<string, unknown>): void })
            | null;
        const getGuilds = storeMethod<() => Record<string, { id: string }>>("GuildStore", "getGuilds");
        const getChannels = storeMethod<(g: string) => Record<string, unknown>>("GuildChannelStore", "getChannels");
        const threads = storeMethod<(g: string) => Record<string, unknown>>("ActiveJoinedThreadsStore", "getActiveJoinedThreadsForGuild");
        const hasUnread = storeMethod<(c: string) => boolean>("ReadStateStore", "hasUnread");
        const lastMessageId = storeMethod<(c: string) => string | null>("ReadStateStore", "lastMessageId");
        if (!dispatcher?.dispatch || !getGuilds || !getChannels || !hasUnread || !lastMessageId) {
            log.warn("required stores/dispatcher missing — plugin inactive");
            return;
        }

        const channelIdsOf = (guildId: string): string[] => {
            const out: string[] = [];
            try {
                const chans = getChannels(guildId) as Record<string, unknown>;
                for (const key of ["SELECTABLE", "VOCAL"]) {
                    const list = chans[key];
                    if (!Array.isArray(list)) continue;
                    for (const item of list) {
                        const ch = isObj(item) && isObj(item.channel) ? item.channel : item;
                        if (isObj(ch) && typeof ch.id === "string") out.push(ch.id);
                    }
                }
                if (threads) {
                    const t = threads(guildId);
                    if (isObj(t)) {
                        for (const v of Object.values(t)) {
                            if (Array.isArray(v)) {
                                for (const th of v) {
                                    if (isObj(th) && typeof th.id === "string") out.push(th.id);
                                }
                            } else if (isObj(v) && typeof v.id === "string") {
                                out.push(v.id);
                            }
                        }
                    }
                }
            } catch (e) {
                log.debug("channel enumeration failed", e);
            }
            return out;
        };

        const stop = observeAdded('[class*="guilds"]', (node) => {
            const html = node as HTMLElement;
            if (html.querySelector("[data-mc-readall]")) return;
            const btn = el(
                "button",
                {
                    margin: "8px auto 0",
                    display: "block",
                    padding: "4px 12px",
                    fontSize: "12px",
                    borderRadius: "4px",
                    border: "1px solid var(--background-modifier-accent,#3f4147)",
                    background: "var(--background-secondary,#2b2d31)",
                    color: "var(--text-normal,#dbdee1)",
                    cursor: "pointer",
                },
                "Read All",
            );
            btn.dataset.mcReadall = "1";
            btn.addEventListener("click", () => {
                const channels: Record<string, unknown>[] = [];
                try {
                    for (const g of Object.values(getGuilds())) {
                        if (!isObj(g) || typeof g.id !== "string") continue;
                        for (const id of channelIdsOf(g.id)) {
                            if (!hasUnread(id)) continue;
                            channels.push({
                                channelId: id,
                                messageId: lastMessageId(id),
                                readStateType: 0,
                            });
                        }
                    }
                } catch (e) {
                    log.warn("read-all failed", e);
                    return;
                }
                if (channels.length) {
                    dispatcher.dispatch({
                        type: "BULK_ACK",
                        context: "APP",
                        channels,
                    });
                }
            });
            html.prepend(btn);
        });
        (this as { __cleanup?: () => void }).__cleanup = stop;
    },

    stop() {
        document.querySelectorAll("[data-mc-readall]").forEach((n) => n.remove());
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// ShowTimeoutDuration — append remaining time to timeout indicators.
// ---------------------------------------------------------------------------

const ShowTimeoutDuration: Plugin = {
    name: "ShowTimeoutDuration",
    description: "Show how much longer a member timeout lasts.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const getMember = storeMethod<(g: string, u: string) => Record<string, unknown> | null>(
            "GuildMemberStore",
            "getMember",
        );
        if (!getMember) {
            log.warn("GuildMemberStore.getMember not found — plugin inactive");
            return;
        }
        const guildFromUrl = () => /\/channels\/(\d{15,25})\//.exec(location.pathname)?.[1] ?? null;
        const userFromRow = (row: Element): string | null => {
            const img = row.querySelector<HTMLImageElement>('img[src*="/avatars/"], img[src*="/guilds/"]');
            const m = img ? /\/(\d{15,25})\//.exec(img.src) : null;
            return m?.[1] ?? null;
        };
        const fmt = (ms: number) => {
            const mins = Math.floor(ms / 60000);
            if (mins < 60) return `${mins}m`;
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return `${hrs}h`;
            return `${Math.floor(hrs / 24)}d`;
        };

        observeAdded('[class*="timeout" i], [class*="communicationDisabled" i]', (node) => {
            const html = node as HTMLElement;
            if (html.dataset.mcTimeout) return;
            const row = html.closest('[class*="member"], li, [role="listitem"]') ?? html.parentElement;
            if (!row) return;
            const uid = userFromRow(row);
            const gid = guildFromUrl();
            if (!uid || !gid) return;
            let until: unknown;
            try {
                until = getMember(gid, uid)?.communicationDisabledUntil;
            } catch {
                return;
            }
            const ts = typeof until === "string" ? Date.parse(until) : Number(until);
            if (!ts || ts <= Date.now()) return;
            html.dataset.mcTimeout = "1";
            const label = el(
                "span",
                {
                    marginLeft: "4px",
                    fontSize: "11px",
                    color: "var(--text-muted,#949ba4)",
                },
                `(${fmt(ts - Date.now())})`,
            );
            html.append(label);
        });
    },
};

// ---------------------------------------------------------------------------
// SortFriendRequests — DOM-sort incoming requests by RelationshipStore.getSince.
// ---------------------------------------------------------------------------

const SortFriendRequests: Plugin = {
    name: "SortFriendRequests",
    description: "Sort friend requests by date of receipt (newest first).",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const getSince = storeMethod<(u: string) => number | null>("RelationshipStore", "getSince");
        if (!getSince) {
            log.warn("RelationshipStore.getSince not found — plugin inactive");
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const resort = () => {
            // Friend request rows live under the friends page; find candidate
            // list containers holding avatar images.
            const containers = document.querySelectorAll<HTMLElement>(
                '[class*="incomingRequests"], [class*="friendRequests"], [class*="requests"]',
            );
            for (const c of containers) {
                const items = Array.from(c.querySelectorAll<HTMLElement>(":scope > *"));
                const keyed = items
                    .map((item) => {
                        const img = item.querySelector<HTMLImageElement>(
                            'img[src*="/avatars/"], img[src*="/embed/avatars/"]',
                        );
                        const uid = img ? /(\d{15,25})/.exec(img.src)?.[1] : null;
                        if (!uid) return null;
                        let since = 0;
                        try {
                            since = Number(getSince(uid)) || 0;
                        } catch {
                            return null;
                        }
                        return { item, since };
                    })
                    .filter((x): x is { item: HTMLElement; since: number } => !!x);
                if (keyed.length < 2) continue;
                keyed.sort((a, b) => b.since - a.since);
                for (const { item } of keyed) c.append(item);
            }
        };
        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(resort, 400);
        };
        const stopObserve = observeAdded('[class*="friend" i], [class*="request" i]', schedule);
        const interval = setInterval(resort, 10_000);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            stopObserve();
            clearInterval(interval);
            if (timer) clearTimeout(timer);
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// MentionAvatars — prepend user avatars to mentions (best-effort).
// ---------------------------------------------------------------------------

const MentionAvatars: Plugin = {
    name: "MentionAvatars",
    description: "Show user avatars inside @mentions.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const getUser = storeMethod<(id: string) => Record<string, unknown> | null>("UserStore", "getUser");
        if (!getUser) {
            log.warn("UserStore.getUser not found — plugin inactive");
            return;
        }
        const avatarUrl = (u: Record<string, unknown>): string | null => {
            const id = String(u.id ?? "");
            const avatar = String(u.avatar ?? "");
            if (!id || !avatar) return null;
            const ext = avatar.startsWith("a_") ? "gif" : "png";
            return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}?size=32`;
        };
        observeAdded('[class*="mention"]', (node) => {
            const html = node as HTMLElement;
            if (html.dataset.mcMentionAvatar || html.querySelector("img[data-mc-ma]")) return;
            // Mentions don't reliably carry ids in the DOM — try common spots.
            const raw =
                html.getAttribute("data-id") ??
                html.id ??
                /users\/(\d{15,25})/.exec(html.innerHTML)?.[1] ??
                null;
            const uid = raw ? /(\d{15,25})/.exec(raw)?.[1] : null;
            if (!uid) return;
            let user: Record<string, unknown> | null = null;
            try {
                user = getUser(uid);
            } catch {
                user = null;
            }
            const url = user ? avatarUrl(user) : null;
            if (!url) return;
            html.dataset.mcMentionAvatar = "1";
            const img = document.createElement("img");
            img.dataset.mcMa = "1";
            img.src = url;
            img.alt = "";
            Object.assign(img.style, {
                width: "16px",
                height: "16px",
                borderRadius: "50%",
                marginRight: "3px",
                verticalAlign: "text-bottom",
            });
            html.prepend(img);
        });
    },
};

// ---------------------------------------------------------------------------
// UserMessagesPronouns — show Discord profile pronouns next to usernames.
// ---------------------------------------------------------------------------

const UserMessagesPronouns: Plugin = {
    name: "UserMessagesPronouns",
    description: "Show users' profile pronouns next to their names in chat.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { lowercase: false },
    settingsSchema: {
        lowercase: {
            type: "boolean",
            label: "Lowercase pronouns",
        },
    },

    start() {
        const profile = findStoreByName("UserProfileStore");
        const getProfile = profile?.getUserProfile as
            | ((id: string) => Record<string, unknown> | undefined)
            | undefined;
        if (!getProfile) {
            log.warn("UserProfileStore.getUserProfile not found — plugin inactive");
            return;
        }
        const cache = new Map<string, string | null>();
        const pronounsFor = async (uid: string): Promise<string | null> => {
            if (cache.has(uid)) return cache.get(uid) ?? null;
            let p: string | null = null;
            try {
                const prof = getProfile(uid) as Record<string, unknown> | undefined;
                const raw = prof?.pronouns;
                if (typeof raw === "string" && raw.trim()) {
                    p = raw.trim().replace(/\n+/g, " ");
                    if ((await Api.Settings.get<boolean>(
                        "plugins.settings.UserMessagesPronouns.lowercase",
                        false,
                    )) === true) {
                        p = p.toLowerCase();
                    }
                }
            } catch {
                p = null;
            }
            cache.set(uid, p);
            return p;
        };

        observeAdded('[id^="chat-messages-"]', (node) => {
            const msg = node as HTMLElement;
            if (msg.dataset.mcPronouns) return;
            const avatar = msg.querySelector<HTMLImageElement>(
                'img[src*="/avatars/"]',
            );
            const uid = avatar ? /(\d{15,25})/.exec(avatar.src)?.[1] : null;
            const nameEl = msg.querySelector<HTMLElement>('[class*="username"]');
            if (!uid || !nameEl || nameEl.querySelector("[data-mc-pronouns]")) return;
            msg.dataset.mcPronouns = "1";
            void pronounsFor(uid).then((p) => {
                if (!p) return;
                const tag = el(
                    "span",
                    {
                        marginLeft: "4px",
                        fontSize: "12px",
                        fontWeight: "400",
                        color: "var(--text-muted,#949ba4)",
                    },
                    `(${p})`,
                );
                tag.dataset.mcPronouns = "1";
                nameEl.append(tag);
            });
        });
    },
};

// ---------------------------------------------------------------------------

const PLUGINS: Plugin[] = [
    LoadingQuotes,
    MessageLinkEmbeds,
    DontRoundMyTimestamps,
    ReadAllNotificationsButton,
    ShowTimeoutDuration,
    SortFriendRequests,
    MentionAvatars,
    UserMessagesPronouns,
];

export function registerVencordLate(): void {
    for (const p of PLUGINS) {
        try {
            Api.Plugins.register(p);
        } catch (e) {
            log.warn(`register ${p.name} failed`, e);
        }
    }
}
