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

/** Register store3 plugins. */
export function registerStore3(): void {
    for (const plugin of [lastOnlinePlugin()]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
