/**
 * Webpack/flux-based plugins — message logging, blocked-message hiding,
 * send-pipeline patches, translation, voice narration, and presence tweaks.
 * Every finder degrades gracefully: if Discord's module shapes change the
 * plugin logs a warning and stays inert.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { el, on, toast } from "./dom-utils";

const log = Logger.get("mods");

interface Bridge {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function bridge(): Bridge | null {
    return (window as { monocord?: Bridge }).monocord ?? null;
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

/** Discord's Flux dispatcher: subscribe(cb) receives action objects with `type`. */
interface Dispatcher {
    subscribe(cb: (action: Record<string, unknown>) => void): unknown;
    dispatch?(action: Record<string, unknown>): void;
}

function findDispatcher(): Dispatcher | null {
    const looksLike = (o: unknown): o is Dispatcher => {
        if (!isObj(o)) return false;
        const d = o as unknown as Dispatcher;
        return (
            typeof d.subscribe === "function" &&
            (typeof d.dispatch === "function" ||
                "_actionHandlers" in o ||
                "_subscriptions" in o ||
                "_actionHandlerSubscribers" in o)
        );
    };
    const found = Api.Webpack.findAll((exp) => {
        if (looksLike(exp)) return true;
        if (isObj(exp) && looksLike(exp.default)) return true;
        return false;
    });
    for (const exp of found) {
        const direct = looksLike(exp) ? exp : undefined;
        const viaDefault = isObj(exp) ? exp.default : undefined;
        const d = (direct ??
            (looksLike(viaDefault) ? viaDefault : undefined)) as
            | Dispatcher
            | undefined;
        if (d) return d;
    }
    return null;
}

/** Find the flux store for `displayName` (e.g. "MessageStore"). */
function findStoreByName(name: string): Record<string, unknown> | null {
    const store = Api.Webpack.findStore(name);
    return isObj(store) ? store : null;
}

// ---------------------------------------------------------------------------
// MessageLogger — append edited/deleted messages to messages.jsonl.
// ---------------------------------------------------------------------------

const MessageLogger: Plugin = {
    name: "MessageLogger",
    description: "Logs edited and deleted messages to a local file.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { includeContent: true },

    async start() {
        const dispatcher = findDispatcher();
        if (!dispatcher) {
            log.warn("flux dispatcher not found — plugin inactive");
            return;
        }
        const cache = new Map<string, Record<string, unknown>>();
        const CACHE_MAX = 10_000;
        const b = bridge();
        if (!b) {
            log.warn("no bridge — cannot persist logs");
            return;
        }
        const includeContent =
            ((await Api.Settings.get<boolean>(
                "plugins.settings.MessageLogger.includeContent",
                true,
            )) ?? true) === true;

        const remember = (channelId: string, msg: Record<string, unknown>) => {
            const id = String(msg.id ?? "");
            if (!id) return;
            const key = `${channelId}:${id}`;
            cache.set(key, msg);
            if (cache.size > CACHE_MAX) {
                const first = cache.keys().next().value;
                if (first !== undefined) cache.delete(first);
            }
        };

        const summarize = (msg: Record<string, unknown> | undefined) => {
            if (!msg) return null;
            const author = isObj(msg.author) ? msg.author : {};
            return {
                messageId: msg.id,
                authorId: author.id,
                author:
                    [author.username, author.discriminator]
                        .filter(Boolean)
                        .join("#") || author.globalName || author.username,
                content: includeContent ? msg.content : undefined,
                timestamp: msg.timestamp,
                attachments: Array.isArray(msg.attachments)
                    ? (msg.attachments as { filename?: string }[]).map(
                          (a) => a.filename,
                      )
                    : undefined,
            };
        };

        const write = (record: Record<string, unknown>) => {
            void b
                .invoke("msglog", JSON.stringify({ ts: Date.now(), ...record }))
                .catch(() => {});
        };

        dispatcher.subscribe((action) => {
            const type = action.type;
            try {
                if (type === "MESSAGE_CREATE") {
                    const channelId = String(action.channelId ?? "");
                    const msg = action.message;
                    if (channelId && isObj(msg)) remember(channelId, msg);
                    return;
                }
                if (type === "MESSAGE_UPDATE") {
                    const channelId = String(action.channelId ?? "");
                    const msg = action.message;
                    if (!channelId || !isObj(msg)) return;
                    const id = String(msg.id ?? "");
                    const prev = cache.get(`${channelId}:${id}`);
                    const edited =
                        msg.edited_timestamp ?? msg.editedTimestamp ?? null;
                    if (prev && edited && prev.content !== msg.content) {
                        write({
                            kind: "edit",
                            channelId,
                            before: summarize(prev),
                            after: summarize(msg),
                        });
                    }
                    remember(channelId, msg);
                    return;
                }
                if (type === "MESSAGE_DELETE") {
                    const channelId = String(action.channelId ?? "");
                    const mid = isObj(action.message) ? action.message.id : null;
                    const id = String(action.id ?? mid ?? "");
                    const msg = isObj(action.message)
                        ? action.message
                        : cache.get(`${channelId}:${id}`);
                    write({ kind: "delete", channelId, message: summarize(msg) });
                    cache.delete(`${channelId}:${id}`);
                    return;
                }
                if (type === "MESSAGE_DELETE_BULK") {
                    const channelId = String(action.channelId ?? "");
                    const ids = Array.isArray(action.ids) ? action.ids : [];
                    for (const id of ids) {
                        const msg = cache.get(`${channelId}:${String(id)}`);
                        write({
                            kind: "delete",
                            channelId,
                            message: summarize(msg),
                        });
                        cache.delete(`${channelId}:${String(id)}`);
                    }
                }
            } catch (e) {
                log.debug("message logger handler failed", e);
            }
        });
        log.info("message logger subscribed");
    },
};

// ---------------------------------------------------------------------------
// NoBlockedMessages — hide messages from blocked/ignored users.
// ---------------------------------------------------------------------------

const NoBlockedMessages: Plugin = {
    name: "NoBlockedMessages",
    description: "Hide messages from users you have blocked or ignored.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const rel = findStoreByName("RelationshipStore");
        if (!rel) {
            log.warn("RelationshipStore not found — plugin inactive");
            return;
        }
        const isBlocked = (id: unknown): boolean => {
            if (typeof id !== "string" && typeof id !== "number") return false;
            for (const fn of ["isBlocked", "isIgnored", "isBlockedOrIgnored"]) {
                const f: unknown = rel[fn];
                if (typeof f === "function") {
                    try {
                        if ((f as (id: unknown) => boolean).call(rel, id)) {
                            return true;
                        }
                    } catch {
                        // try next
                    }
                }
            }
            return false;
        };

        // Discord's chat message component is a class named "Message".
        let patched = 0;
        for (const exp of Api.Webpack.findAll(() => true)) {
            const candidates: unknown[] = [exp];
            if (isObj(exp) && "default" in exp) candidates.push(exp.default);
            for (const c of candidates) {
                if (!isObj(c)) continue;
                if (c.displayName !== "Message") continue;
                const proto = (c as { prototype?: Record<string, unknown> })
                    .prototype;
                if (!proto || typeof proto.render !== "function") continue;
                try {
                    Api.Patcher.instead(
                        this.name,
                        proto,
                        "render",
                        function (this: { props?: Record<string, unknown> }) {
                            const props = this.props ?? {};
                            const msg = isObj(props.message) ? props.message : {};
                            const author = isObj(msg.author) ? msg.author : {};
                            if (isBlocked(author.id)) return null;
                            return undefined; // fall through to original
                        },
                    );
                    patched += 1;
                } catch {
                    // non-configurable — keep looking
                }
            }
        }
        if (patched === 0) {
            log.warn("no Message component found — plugin inactive");
        } else {
            log.info("message render patched", { count: patched });
        }
    },
};

// ---------------------------------------------------------------------------
// TextReplace — rewrite outgoing message content.
// ---------------------------------------------------------------------------

interface ReplaceRule {
    find: string;
    replace: string;
}

let cachedRules: ReplaceRule[] = [];
let rulesLoaded = false;

async function refreshRules(): Promise<void> {
    const raw = await Api.Settings.get<unknown>(
        "plugins.settings.TextReplace.rules",
    );
    if (Array.isArray(raw)) {
        cachedRules = raw
            .filter(isObj)
            .map((r) => ({
                find: String(r.find ?? ""),
                replace: String(r.replace ?? ""),
            }))
            .filter((r) => r.find.length > 0);
    } else {
        cachedRules = [];
    }
    rulesLoaded = true;
}

function applyRules(content: string): string {
    if (!rulesLoaded) void refreshRules();
    let out = content;
    for (const r of cachedRules) {
        out = out.split(r.find).join(r.replace);
    }
    return out;
}

/** Find Discord's message-send entry point; returns the module object. */
function findSendModule(): Record<string, unknown> | null {
    const candidates = Api.Webpack.findAllByProps("sendMessage");
    for (const exp of candidates) {
        const targets: unknown[] = [exp];
        if (isObj(exp) && "default" in exp) targets.push(exp.default);
        for (const t of targets) {
            if (
                isObj(t) &&
                typeof t.sendMessage === "function" &&
                typeof t.editMessage === "function"
            ) {
                return t;
            }
        }
    }
    return null;
}

const TextReplace: Plugin = {
    name: "TextReplace",
    description: "Automatically replace configured text in outgoing messages.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { rules: [] as ReplaceRule[] },

    async start() {
        await refreshRules();
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (path === "plugins.settings.TextReplace.rules") {
                void refreshRules();
            }
        });
        const mod = findSendModule();
        if (!mod) {
            log.warn("send module not found — plugin inactive");
            return;
        }
        Api.Patcher.before(this.name, mod, "sendMessage", (...args) => {
            // sendMessage(channelId, messageData, ...) — messageData.content
            for (const arg of args) {
                if (isObj(arg) && typeof arg.content === "string") {
                    const next = applyRules(arg.content);
                    if (next !== arg.content) arg.content = next;
                }
            }
            return args;
        });
        log.info("send pipeline patched");
    },
};

// ---------------------------------------------------------------------------
// SilentMessageToggle — Ctrl+Alt+S toggles silent (@silent) sending.
// Discord's SUPPRESS_NOTIFICATIONS message flag is 4096.
// ---------------------------------------------------------------------------

const SILENT_FLAG = 4096;

const SilentMessageToggle: Plugin = {
    name: "SilentMessageToggle",
    description: "Ctrl+Alt+S toggles sending messages silently.",
    authors: ["Monocord"],
    version: "0.1.0",

    async start() {
        const mod = findSendModule();
        if (!mod) {
            log.warn("send module not found — plugin inactive");
            return;
        }
        let silent =
            ((await Api.Settings.get<boolean>(
                "plugins.settings.SilentMessageToggle.active",
                false,
            )) ?? false) === true;

        Api.Patcher.before(this.name, mod, "sendMessage", (...args) => {
            if (!silent) return args;
            for (const arg of args) {
                if (isObj(arg)) {
                    const flags = typeof arg.flags === "number" ? arg.flags : 0;
                    arg.flags = flags | SILENT_FLAG;
                }
            }
            return args;
        });

        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.altKey && e.code === "KeyS") {
                e.preventDefault();
                e.stopPropagation();
                silent = !silent;
                void Api.Settings.set(
                    "plugins.settings.SilentMessageToggle.active",
                    silent,
                );
                toast(silent ? "Silent messages ON" : "Silent messages OFF");
            }
        };
        document.addEventListener("keydown", onKey, true);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            document.removeEventListener("keydown", onKey, true);
        };
        log.info("silent toggle ready", { initial: silent });
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// Translate — right-click a message → Translate (Google gtx endpoint).
// ---------------------------------------------------------------------------

const Translate: Plugin = {
    name: "Translate",
    description: "Right-click a message to translate it.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { target: "en" },

    start() {
        const off = on(
            document,
            "contextmenu",
            '[id^="chat-messages-"]',
            (node, ev) => {
                const li = node as HTMLElement;
                const m = /^chat-messages-(\d+)-(\d+)$/.exec(li.id);
                if (!m) return;
                const [, channelId = "", messageId = ""] = m;
                const store = findStoreByName("MessageStore");
                const getMessage = store?.getMessage;
                const msg =
                    typeof getMessage === "function"
                        ? (getMessage as (c: string, id: string) => unknown).call(
                              store,
                              channelId,
                              messageId,
                          )
                        : null;
                const content = isObj(msg) ? msg.content : null;
                if (typeof content !== "string" || !content.trim()) return;
                // Don't intercept Discord's own reply/copy actions on empty msgs.
                ev.preventDefault();
                const me = (ev as MouseEvent).clientX + 8;
                const my = (ev as MouseEvent).clientY + 8;
                void translateAndShow(content, me, my);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

async function translateAndShow(
    text: string,
    x: number,
    y: number,
): Promise<void> {
    const target =
        (await Api.Settings.get<string>("plugins.settings.Translate.target")) ??
        "en";
    const tip = el(
        "div",
        {
            position: "fixed",
            left: `${x}px`,
            top: `${y}px`,
            zIndex: "100001",
            maxWidth: "420px",
            background: "var(--background-floating, #111214)",
            color: "var(--text-normal, #dbdee1)",
            border: "1px solid var(--background-modifier-accent, #3f4147)",
            borderRadius: "8px",
            padding: "10px 14px",
            fontSize: "13px",
            lineHeight: "18px",
            boxShadow: "0 8px 24px rgba(0,0,0,.4)",
            whiteSpace: "pre-wrap",
        },
        "Translating…",
    );
    document.body.append(tip);
    const close = () => tip.remove();
    document.addEventListener("click", close, { once: true });
    document.addEventListener("keydown", function onKey(e) {
        if (e.key === "Escape") {
            close();
            document.removeEventListener("keydown", onKey);
        }
    });
    try {
        const url =
            "https://translate.googleapis.com/translate_a/single" +
            `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t` +
            `&q=${encodeURIComponent(text.slice(0, 4000))}`;
        const res = await fetch(url);
        const data = (await res.json()) as unknown;
        const sentences = isObj(data) && Array.isArray(data[0]) ? data[0] : [];
        const translated = sentences
            .map((s) => (Array.isArray(s) && typeof s[0] === "string" ? s[0] : ""))
            .join("");
        tip.textContent = translated || "(no translation)";
    } catch (e) {
        log.warn("translate failed", e);
        tip.textContent = "Translation failed";
    }
}

// ---------------------------------------------------------------------------
// VcNarrator — speak when you join/leave voice channels.
// ---------------------------------------------------------------------------

const VcNarrator: Plugin = {
    name: "VcNarrator",
    description: "Announces voice channel joins and leaves.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        if (typeof speechSynthesis === "undefined") {
            log.warn("speechSynthesis unavailable — plugin inactive");
            return;
        }
        const dispatcher = findDispatcher();
        if (!dispatcher) {
            log.warn("flux dispatcher not found — plugin inactive");
            return;
        }
        const speak = (text: string) => {
            try {
                const u = new SpeechSynthesisUtterance(text);
                u.rate = 1.05;
                speechSynthesis.speak(u);
            } catch {
                // ignore
            }
        };
        dispatcher.subscribe((action) => {
            try {
                if (action.type === "VOICE_CHANNEL_SELECT") {
                    speak(action.channelId ? "Joined voice channel" : "Left voice channel");
                } else if (action.type === "CALL_DISCONNECT") {
                    speak("Call ended");
                }
            } catch (e) {
                log.debug("narrator failed", e);
            }
        });
        log.info("voice narrator subscribed");
    },
};

// ---------------------------------------------------------------------------
// AutoDNDWhilePlaying — set DND while a game is running.
// ---------------------------------------------------------------------------

const AutoDNDWhilePlaying: Plugin = {
    name: "AutoDNDWhilePlaying",
    description: "Automatically go DND while a game is running.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const currentUser = findStoreByName("CurrentUserStore");
        const getUser = currentUser?.getCurrentUser;

        const hasGame = (): boolean => {
            try {
                let activities: unknown;
                const cu =
                    typeof getUser === "function"
                        ? (getUser as () => Record<string, unknown>).call(
                              currentUser,
                          )
                        : null;
                if (cu && Array.isArray(cu.activities)) {
                    activities = cu.activities;
                } else if (
                    typeof currentUser?.getActivities === "function"
                ) {
                    activities = (
                        currentUser as unknown as {
                            getActivities: () => unknown;
                        }
                    ).getActivities.call(currentUser);
                }
                if (!Array.isArray(activities)) return false;
                return activities.some((a) => {
                    if (!isObj(a)) return false;
                    // type 0 = Playing, 5 = Competing
                    return a.type === 0 || a.type === 5;
                });
            } catch {
                return false;
            }
        };

        const setStatus = findStatusSetter();
        if (!setStatus) {
            log.warn("status setter not found — plugin inactive");
            return;
        }
        let applied = false;
        const tick = () => {
            try {
                const playing = hasGame();
                if (playing && !applied) {
                    setStatus("dnd");
                    applied = true;
                } else if (!playing && applied) {
                    setStatus("online");
                    applied = false;
                }
            } catch (e) {
                log.debug("auto dnd tick failed", e);
            }
        };
        tick();
        const timer = setInterval(tick, 15_000);
        (this as { __timer?: ReturnType<typeof setInterval> }).__timer = timer;
    },

    stop() {
        const t = (this as { __timer?: ReturnType<typeof setInterval> }).__timer;
        if (t) clearInterval(t);
    },
};

function findStatusSetter(): ((status: string) => void) | null {
    const names = ["setStatus", "updateStatus", "saveStatus", "setStatusText"];
    for (const exp of Api.Webpack.findAll(() => true)) {
        const targets: unknown[] = [exp];
        if (isObj(exp) && "default" in exp) targets.push(exp.default);
        for (const t of targets) {
            if (!isObj(t)) continue;
            for (const name of names) {
                const f = t[name];
                if (typeof f === "function") {
                    return (status: string) => {
                        try {
                            (f as (...a: unknown[]) => void).call(t, status);
                        } catch (e) {
                            log.debug(`status setter ${name} failed`, e);
                        }
                    };
                }
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// NoTrack — block Discord telemetry endpoints (main-process webRequest).
// ---------------------------------------------------------------------------

const NoTrack: Plugin = {
    name: "NoTrack",
    description: "Blocks Discord telemetry and analytics requests.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        void bridge()
            ?.invoke("track-block", true)
            .catch((e) => log.warn("track-block failed", e));
    },

    stop() {
        void bridge()
            ?.invoke("track-block", false)
            .catch(() => {});
    },
};

// ---------------------------------------------------------------------------
// NoSystemBadge — suppress the unread-count taskbar badge.
// ---------------------------------------------------------------------------

const NoSystemBadge: Plugin = {
    name: "NoSystemBadge",
    description: "Removes the unread-count badge on the taskbar icon.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        void bridge()
            ?.invoke("badge-block", true)
            .catch((e) => log.warn("badge-block failed", e));
    },

    stop() {
        void bridge()
            ?.invoke("badge-block", false)
            .catch(() => {});
    },
};

// ---------------------------------------------------------------------------

export function registerMods(): void {
    for (const plugin of [
        MessageLogger,
        NoBlockedMessages,
        TextReplace,
        SilentMessageToggle,
        Translate,
        VcNarrator,
        AutoDNDWhilePlaying,
        NoTrack,
        NoSystemBadge,
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
