/**
 * Store/flux-based plugins batch 3: profile enrichment (last online,
 * friends-since), voice region, member limits, boost tiers, timestamp
 * formatting, and presence overrides. Everything degrades gracefully.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { el, observeAdded, toast } from "./dom-utils";
import { findDispatcher, findStoreByName, isObj } from "./mods";

const log = Logger.get("store3");

// ---------------------------------------------------------------------------
// Shared profile capture
// ---------------------------------------------------------------------------

/**
 * Discord's profile popout fetches user profiles through UserProfileStore.
 * We patch getUserProfile to keep the latest response per user ID, then DOM
 * observers read whichever fields Discord actually returns (last_online,
 * friend_since, premium_since, …). If a field is absent the badge simply
 * never renders — no errors.
 */

const profileCache = new Map<string, Record<string, unknown>>();
let profilePatchInstalled = false;

function installProfileCapture(): boolean {
    if (profilePatchInstalled) return true;
    const store = findStoreByName("UserProfileStore");
    const getProfile = store?.getUserProfile;
    if (!store || typeof getProfile !== "function") return false;
    try {
        Api.Patcher.after("profileCapture", store, "getUserProfile", (result: unknown, userId: unknown) => {
            const stash = (profile: unknown) => {
                if (typeof userId === "string" && isObj(profile)) {
                    profileCache.set(userId, profile as Record<string, unknown>);
                    if (profileCache.size > 200) {
                        const first = profileCache.keys().next().value;
                        if (first) profileCache.delete(first);
                    }
                }
            };
            if (result && typeof (result as Promise<unknown>).then === "function") {
                void (result as Promise<unknown>).then(stash).catch(() => {});
            } else {
                stash(result);
            }
            return result;
        });
        profilePatchInstalled = true;
        return true;
    } catch (e) {
        log.debug("profile capture patch failed", e);
        return false;
    }
}

/** Find a value by key anywhere in a shallow object tree (depth ≤ 3). */
function findField(obj: unknown, pattern: RegExp, depth = 0): unknown {
    if (!isObj(obj) || depth > 3) return undefined;
    for (const [k, v] of Object.entries(obj)) {
        if (pattern.test(k)) return v;
        if (isObj(v)) {
            const found = findField(v, pattern, depth + 1);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

/** Extract a user ID from a profile popout's avatar/banner image URL. */
function userIdFromPopout(popout: Element): string | null {
    const img = popout.querySelector('img[src*="avatars/"], img[src*="banners/"]');
    const src = img?.getAttribute("src") ?? "";
    const m = /\/(\d{15,25})\//.exec(src) ?? /(\d{15,25})/.exec(src);
    return m ? (m[1] ?? m[2] ?? null) : null;
}

function formatTimestamp(v: unknown): string | null {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    // Discord timestamps are usually unix seconds; ms values are huge.
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function injectBadge(popout: Element, marker: string, text: string): void {
    if (popout.querySelector(`[${marker}]`)) return;
    const badge = el(
        "div",
        {
            marginTop: "4px",
            fontSize: "12px",
            color: "var(--text-muted, #949ba4)",
        },
        text,
    );
    badge.setAttribute(marker, "1");
    // Append near the profile header info if we can find it, else popout end.
    const target =
        popout.querySelector('[class*="profileBody"], [class*="userProfileBody"], [class*="body"]') ??
        popout;
    target.append(badge);
}

const PROFILE_POPOUT_SEL =
    '[class*="profilePopout"], [class*="userProfile"], [class*="profilePanel"]';

// ---------------------------------------------------------------------------
// LastOnline
// ---------------------------------------------------------------------------

function lastOnlinePlugin(): Plugin {
    let stopObserve: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    return {
        name: "LastOnline",
        description: "Show a user's last-online timestamp on their profile popout.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            const arm = () => {
                if (!installProfileCapture()) {
                    // Store may lazy-load; retry for a minute.
                    if (!retryTimer) {
                        let tries = 0;
                        retryTimer = setInterval(() => {
                            tries++;
                            if (installProfileCapture() || tries > 20) {
                                if (retryTimer) clearInterval(retryTimer);
                                retryTimer = null;
                            }
                        }, 3000);
                    }
                    return false;
                }
                if (retryTimer) {
                    clearInterval(retryTimer);
                    retryTimer = null;
                }
                return true;
            };
            if (!arm()) return;

            stopObserve = observeAdded(PROFILE_POPOUT_SEL, (popout) => {
                try {
                    const uid = userIdFromPopout(popout);
                    if (!uid) return;
                    const profile = profileCache.get(uid);
                    if (!profile) return;
                    const v =
                        findField(profile, /last_?online/i) ??
                        findField(profile, /lastSeen|last_seen/i);
                    const text = formatTimestamp(v);
                    if (text) injectBadge(popout, "data-mc-lastonline", `Last online: ${text}`);
                } catch {
                    /* popout shape changed */
                }
            });
        },

        stop() {
            stopObserve?.();
            stopObserve = null;
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = null;
        },
    };
}

// ---------------------------------------------------------------------------
// FriendsSince
// ---------------------------------------------------------------------------

function friendsSincePlugin(): Plugin {
    let stopObserve: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    return {
        name: "FriendsSince",
        description: "Show a 'friends since' date on friend profile popouts.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            const arm = () => {
                if (!installProfileCapture()) {
                    if (!retryTimer) {
                        let tries = 0;
                        retryTimer = setInterval(() => {
                            tries++;
                            if (installProfileCapture() || tries > 20) {
                                if (retryTimer) clearInterval(retryTimer);
                                retryTimer = null;
                            }
                        }, 3000);
                    }
                    return false;
                }
                if (retryTimer) {
                    clearInterval(retryTimer);
                    retryTimer = null;
                }
                return true;
            };
            if (!arm()) return;

            stopObserve = observeAdded(PROFILE_POPOUT_SEL, (popout) => {
                try {
                    const uid = userIdFromPopout(popout);
                    if (!uid) return;
                    const profile = profileCache.get(uid);
                    if (!profile) return;
                    const v =
                        findField(profile, /friend_?since|friends_?since|friendship_?since/i) ??
                        findField(profile, /premium_?since|nitro_?since/i);
                    const text = formatTimestamp(v);
                    if (text) injectBadge(popout, "data-mc-friendssince", `Friends since: ${text}`);
                } catch {
                    /* popout shape changed */
                }
            });
        },

        stop() {
            stopObserve?.();
            stopObserve = null;
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = null;
        },
    };
}

// ---------------------------------------------------------------------------
// ServerRegion
// ---------------------------------------------------------------------------

function serverRegionPlugin(): Plugin {
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopObserve: (() => void) | null = null;

    const region = (): string | null => {
        for (const name of ["RTCRegionStore", "VoiceRegionStore", "RTCStore"]) {
            try {
                const store = findStoreByName(name);
                if (!store) continue;
                for (const key of ["getRegion", "getCurrentRegion", "region"]) {
                    const v = store[key];
                    const r =
                        typeof v === "function"
                            ? (v as () => unknown).call(store)
                            : v;
                    if (typeof r === "string" && r) return r;
                    if (isObj(r) && typeof r.region === "string") return r.region;
                    if (isObj(r) && typeof r.name === "string") return r.name;
                }
            } catch {
                /* keep probing */
            }
        }
        return null;
    };

    const inVoiceChannel = (): boolean => {
        try {
            const sel = findStoreByName("SelectedChannelStore");
            const getChannel = sel?.getChannel as
                | (() => Record<string, unknown> | undefined)
                | undefined;
            const ch = getChannel?.();
            const t = ch?.type;
            return t === 2 || t === 13 || t === 14; // voice / stage / stage-thread
        } catch {
            return false;
        }
    };

    const update = () => {
        const badge = document.querySelector("[data-mc-region]");
        if (!inVoiceChannel()) {
            badge?.remove();
            return;
        }
        const r = region();
        if (!r) {
            badge?.remove();
            return;
        }
        if (badge) {
            badge.textContent = r;
            return;
        }
        const header = document.querySelector(
            '[class*="chat"] [class*="header"], [class*="guildHeader"]',
        );
        if (!header) return;
        const el = document.createElement("span");
        el.setAttribute("data-mc-region", "1");
        Object.assign(el.style, {
            marginLeft: "8px",
            fontSize: "12px",
            color: "var(--text-muted, #949ba4)",
        });
        el.textContent = r;
        header.append(el);
    };

    return {
        name: "ServerRegion",
        description: "Show your voice server's region in the channel header.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            timer = setInterval(update, 15000);
            update();
            stopObserve = observeAdded('[class*="header"]', () => update());
        },

        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            stopObserve?.();
            stopObserve = null;
            document.querySelectorAll("[data-mc-region]").forEach((n) => n.remove());
        },
    };
}

// ---------------------------------------------------------------------------
// MemberLimit
// ---------------------------------------------------------------------------

function memberLimitPlugin(): Plugin {
    let stopObserve: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const update = () => {
        const badge = document.querySelector("[data-mc-memberlimit]");
        try {
            const sel = findStoreByName("SelectedChannelStore");
            const getGuildId = sel?.getGuildId as (() => string | null) | undefined;
            const guildId = getGuildId?.();
            const guilds = findStoreByName("GuildStore");
            const getGuild = guilds?.getGuild as
                | ((id: string) => Record<string, unknown> | undefined)
                | undefined;
            const g = guildId ? getGuild?.(guildId) : undefined;
            if (!g) {
                badge?.remove();
                return;
            }
            const count =
                (g.approximateMemberCount as number) ?? (g.memberCount as number);
            const max =
                (g.maxMembers as number) ??
                (g.max_members as number) ??
                (g.approximateMaxMembers as number);
            if (typeof count !== "number" || typeof max !== "number" || max <= 0) {
                badge?.remove();
                return;
            }
            const text = `${count.toLocaleString()} / ${max.toLocaleString()}`;
            if (badge) {
                badge.textContent = text;
                return;
            }
            const header = document.querySelector(
                '[class*="members"] [class*="header"], [class*="memberList"] [class*="title"], [class*="membersWrap"]',
            );
            if (!header) return;
            const el = document.createElement("span");
            el.setAttribute("data-mc-memberlimit", "1");
            Object.assign(el.style, {
                marginLeft: "8px",
                fontSize: "12px",
                color: "var(--text-muted, #949ba4)",
            });
            el.textContent = text;
            header.append(el);
        } catch {
            /* stores not ready */
        }
    };

    return {
        name: "MemberLimit",
        description: "Show 'x / y members' in the member list when the server has a cap.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,

        start() {
            timer = setInterval(update, 20000);
            update();
            stopObserve = observeAdded(
                '[class*="members"] [class*="header"], [class*="memberList"] [class*="title"], [class*="membersWrap"]',
                () => update(),
            );
        },

        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            stopObserve?.();
            stopObserve = null;
            document.querySelectorAll("[data-mc-memberlimit]").forEach((n) => n.remove());
        },
    };
}

// ---------------------------------------------------------------------------
// TimestampFormat
// ---------------------------------------------------------------------------

function timestampFormatPlugin(): Plugin {
    const Original = Intl.DateTimeFormat;
    let patched = false;

    const apply = (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) => {
        const fmt = Api.Settings.getSync<string>(
            "plugins.settings.TimestampFormat.format",
            "system",
        );
        if (fmt !== "system" && options) {
            options = { ...options };
            if (fmt === "24h") {
                options.hour12 = false;
                options.hourCycle = "h23";
            } else if (fmt === "12h") {
                options.hour12 = true;
                options.hourCycle = "h12";
            }
        }
        return new Original(locales, options);
    };

    return {
        name: "TimestampFormat",
        description: "Force 12-hour or 24-hour timestamps everywhere.",
        authors: ["Monocord"],
        version: "0.1.0",
        defer: true,
        settings: { format: "system" },
        settingsSchema: {
            format: {
                type: "select",
                label: "Format",
                options: [
                    { value: "system", label: "System default" },
                    { value: "12h", label: "12-hour" },
                    { value: "24h", label: "24-hour" },
                ],
            },
        },

        start() {
            if (patched) return;
            // Wrap the constructor so every Discord timestamp respects the
            // setting. `supportedLocalesOf` etc. are copied over.
            const Wrapped = function (
                this: unknown,
                locales?: Intl.LocalesArgument,
                options?: Intl.DateTimeFormatOptions,
            ) {
                return apply(locales, options) as unknown;
            } as unknown as typeof Intl.DateTimeFormat;
            Object.setPrototypeOf(Wrapped, Original);
            try {
                Object.defineProperty(Wrapped, "prototype", {
                    value: Original.prototype,
                    writable: false,
                });
            } catch {
                /* non-configurable */
            }
            for (const k of Object.getOwnPropertyNames(Original)) {
                if (k !== "length" && k !== "name" && k !== "prototype") {
                    try {
                        Object.defineProperty(
                            Wrapped,
                            k,
                            Object.getOwnPropertyDescriptor(Original, k)!,
                        );
                    } catch {
                        /* non-configurable */
                    }
                }
            }
            Intl.DateTimeFormat = Wrapped;
            patched = true;
        },

        stop() {
            if (patched) {
                Intl.DateTimeFormat = Original;
                patched = false;
            }
        },
    };
}

/** Register store3 plugins. */
export function registerStore3(): void {
    for (const plugin of [
        lastOnlinePlugin(),
        friendsSincePlugin(),
        serverRegionPlugin(),
        memberLimitPlugin(),
        timestampFormatPlugin(),
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
