/**
 * Chat-area plugins — message list conveniences, context-menu actions,
 * composer tweaks, and small behavior patches. Best-effort throughout.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { cssPlugin } from "./extras";
import { contextMenu, el, observeAdded, on, toast } from "./dom-utils";
import { findDispatcher, findSendModule, findStoreByName, isObj } from "./mods";

const log = Logger.get("chat3");

/** Parse `chat-messages-<channelId>-<messageId>` from an element id. */
function messageIds(elm: Element): { channelId: string; messageId: string } | null {
    let node: Element | null = elm;
    while (node) {
        const m = /^chat-messages-(\d+)-(\d+)$/.exec(node.id);
        if (m) return { channelId: m[1] ?? "", messageId: m[2] ?? "" };
        node = node.parentElement;
    }
    return null;
}

function getMessage(channelId: string, messageId: string): Record<string, unknown> | null {
    const store = findStoreByName("MessageStore");
    const fn = store?.getMessage;
    if (typeof fn !== "function") return null;
    try {
        const msg = (fn as (c: string, id: string) => unknown).call(
            store,
            channelId,
            messageId,
        );
        return isObj(msg) ? msg : null;
    } catch {
        return null;
    }
}

/** Insert text at the cursor of Discord's chat input. */
function insertIntoComposer(text: string): void {
    const editable = document.querySelector<HTMLElement>(
        '[class*="channelTextArea"] [contenteditable="true"], [class*="channelTextArea"] textarea',
    );
    if (!editable) {
        toast("Focus the message box first");
        return;
    }
    editable.focus();
    if (editable instanceof HTMLTextAreaElement) {
        const s = editable.selectionStart ?? editable.value.length;
        editable.value = editable.value.slice(0, s) + text + editable.value.slice(s);
        editable.dispatchEvent(new Event("input", { bubbles: true }));
        editable.selectionStart = editable.selectionEnd = s + text.length;
        return;
    }
    document.execCommand("insertText", false, text);
}

// ---------------------------------------------------------------------------
// JumpToTop — floating button that scrolls the message list to the top.
// ---------------------------------------------------------------------------

const JumpToTop: Plugin = {
    name: "JumpToTop",
    description: "Button to jump to the first message in a channel.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const stop = observeAdded('[data-list-id="chat-messages"]', (scroller) => {
            if (scroller.querySelector("[data-mc-jumptop]")) return;
            const btn = el(
                "button",
                {
                    position: "absolute",
                    bottom: "12px",
                    right: "16px",
                    zIndex: "4",
                    background: "var(--background-modifier-accent, #3f4147)",
                    color: "var(--text-normal, #dbdee1)",
                    border: "none",
                    borderRadius: "50%",
                    width: "36px",
                    height: "36px",
                    fontSize: "16px",
                    cursor: "pointer",
                    boxShadow: "0 2px 8px rgba(0,0,0,.4)",
                },
                "↑",
            );
            btn.dataset.mcJumptop = "1";
            btn.title = "Jump to top";
            btn.addEventListener("click", () => {
                (scroller as HTMLElement).scrollTo({ top: 0, behavior: "smooth" });
            });
            const parent = scroller.parentElement;
            if (parent) {
                const prev = parent.style.position;
                parent.style.position = "relative";
                parent.append(btn);
                (btn as HTMLButtonElement & { __cleanup?: () => void }).__cleanup =
                    () => {
                        btn.remove();
                        parent.style.position = prev;
                    };
            }
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// MessageClickActions — dblclick to edit/reply, Backspace+click to delete.
// ---------------------------------------------------------------------------

const MessageClickActions: Plugin = {
    name: "MessageClickActions",
    description: "Double-click to edit, hold Backspace and click to delete.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let backspaceHeld = false;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Backspace") backspaceHeld = true;
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Backspace") backspaceHeld = false;
        };
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("keyup", onKeyUp, true);

        const findAction = (msg: Element, labels: string[]) =>
            msg.querySelector<HTMLElement>(
                labels.map((l) => `[aria-label="${l}"]`).join(","),
            );

        const offDbl = on(document, "dblclick", '[id^="chat-messages-"]', (node) => {
            const msg = node as HTMLElement;
            const edit = findAction(msg, ["Edit", "Edit Message"]);
            const reply = findAction(msg, ["Reply", "Reply to Message"]);
            // Prefer reply unless the message is ours (edit exists).
            (edit ?? reply)?.click();
        });

        const offClick = on(
            document,
            "click",
            '[id^="chat-messages-"]',
            (node, ev) => {
                if (!backspaceHeld) return;
                // Don't hijack clicks on interactive children.
                if ((ev.target as Element).closest("a,button,input,textarea,video,img")) {
                    return;
                }
                const msg = node as HTMLElement;
                const del = findAction(msg, ["Delete Message", "Delete"]);
                if (del) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    del.click();
                }
            },
            true,
        );

        (this as { __cleanup?: () => void }).__cleanup = () => {
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("keyup", onKeyUp, true);
            offDbl();
            offClick();
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// QuickReply — Ctrl+Up/Down cycles messages for reply/edit.
// ---------------------------------------------------------------------------

const QuickReply: Plugin = {
    name: "QuickReply",
    description: "Ctrl+Up/Down reply, Ctrl+Shift+Up/Down edit messages.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let index = -1;
        let highlighted: HTMLElement | null = null;
        const messages = () =>
            Array.from(
                document.querySelectorAll<HTMLElement>('[id^="chat-messages-"]'),
            );
        const clearHighlight = () => {
            if (highlighted) {
                highlighted.style.outline = "";
                highlighted = null;
            }
        };
        const move = (delta: number, edit: boolean) => {
            const list = messages();
            if (list.length === 0) return;
            index = Math.min(Math.max(index + delta, 0), list.length - 1);
            const msg = list[index];
            if (!msg) return;
            clearHighlight();
            msg.style.outline = "2px solid var(--brand-500, #5865f2)";
            highlighted = msg;
            const labels = edit ? ["Edit", "Edit Message"] : ["Reply", "Reply to Message"];
            const btn = msg.querySelector<HTMLElement>(
                labels.map((l) => `[aria-label="${l}"]`).join(","),
            );
            if (btn) btn.click();
        };
        const onKey = (e: KeyboardEvent) => {
            if (!e.ctrlKey || e.altKey || e.metaKey) return;
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            e.preventDefault();
            e.stopPropagation();
            const delta = e.key === "ArrowUp" ? -1 : 1;
            if (e.shiftKey) {
                index = -1; // reset selection for edit mode
                move(delta, true);
            } else {
                move(delta, false);
            }
        };
        document.addEventListener("keydown", onKey, true);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            document.removeEventListener("keydown", onKey, true);
            clearHighlight();
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// QuickMention — "@" button inserts an @ mention trigger.
// ---------------------------------------------------------------------------

const QuickMention: Plugin = {
    name: "QuickMention",
    description: "Quick-mention button in the chat input.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const cleanups: (() => void)[] = [];
        const attach = (container: Element) => {
            if (container.querySelector("[data-mc-mention]")) return;
            const btn = el(
                "button",
                {
                    position: "absolute",
                    bottom: "6px",
                    right: "52px",
                    zIndex: "5",
                    background: "var(--background-modifier-accent, #3f4147)",
                    color: "var(--text-normal, #dbdee1)",
                    border: "none",
                    borderRadius: "4px",
                    width: "24px",
                    height: "24px",
                    fontSize: "13px",
                    fontWeight: "700",
                    cursor: "pointer",
                },
                "@",
            );
            btn.dataset.mcMention = "1";
            btn.title = "Mention";
            btn.addEventListener("click", () => insertIntoComposer("@"));
            const parent = container as HTMLElement;
            const prev = parent.style.position;
            parent.style.position = "relative";
            parent.append(btn);
            cleanups.push(() => {
                btn.remove();
                parent.style.position = prev;
            });
        };
        cleanups.push(observeAdded('[class*="channelTextArea"]', attach));
        (this as { __cleanup?: () => void }).__cleanup = () =>
            cleanups.forEach((c) => c());
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// RevealAllSpoilers — Ctrl+click reveals every spoiler in view.
// ---------------------------------------------------------------------------

const RevealAllSpoilers: Plugin = {
    name: "RevealAllSpoilers",
    description: "Ctrl+click a message to reveal all its spoilers.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(document, "click", '[id^="chat-messages-"]', (node, ev) => {
            if (!(ev instanceof MouseEvent) || !ev.ctrlKey) return;
            const msg = node as HTMLElement;
            const spoilers = msg.querySelectorAll<HTMLElement>(
                '[class*="spoiler"], [class*="Spoiler"]',
            );
            if (spoilers.length === 0) return;
            ev.preventDefault();
            ev.stopPropagation();
            spoilers.forEach((s) => s.click());
        });
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// UnsuppressEmbeds — auto-expand suppressed embeds/attachments.
// ---------------------------------------------------------------------------

const UnsuppressEmbeds: Plugin = {
    name: "UnsuppressEmbeds",
    description: "Automatically expand suppressed embeds and attachments.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const tryExpand = (root: ParentNode) => {
            root.querySelectorAll<HTMLElement>("button").forEach((btn) => {
                const label =
                    btn.getAttribute("aria-label") ?? btn.textContent ?? "";
                if (/show (embed|attachment|image|content)/i.test(label)) {
                    btn.click();
                }
            });
        };
        const stop = observeAdded('[id^="chat-messages-"]', (node) => {
            tryExpand(node as ParentNode);
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// HideMedia — per-message hide button for attachments/embeds.
// ---------------------------------------------------------------------------

const HideMedia: Plugin = {
    name: "HideMedia",
    description: "Hide attachments and embeds via a hover button.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const cleanups: (() => void)[] = [];
        const attach = (msg: Element) => {
            msg.querySelectorAll<HTMLElement>(
                '[class*="attachment"], [class*="embedWrapper"], [class*="embed"]',
            ).forEach((media) => {
                if (media.dataset.mcHide) return;
                media.dataset.mcHide = "1";
                const btn = el(
                    "button",
                    {
                        position: "absolute",
                        top: "4px",
                        right: "4px",
                        zIndex: "6",
                        background: "rgba(0,0,0,.6)",
                        color: "#fff",
                        border: "none",
                        borderRadius: "4px",
                        padding: "2px 7px",
                        fontSize: "11px",
                        cursor: "pointer",
                    },
                    "hide",
                );
                const prev = media.style.position;
                media.style.position = "relative";
                media.append(btn);
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    media.style.display = "none";
                });
                cleanups.push(() => {
                    btn.remove();
                    media.style.position = prev;
                    media.style.display = "";
                });
            });
        };
        cleanups.push(
            observeAdded('[id^="chat-messages-"]', (node) => {
                // Re-scan as embeds lazy-load.
                attach(node);
                setTimeout(() => attach(node), 800);
            }),
        );
        (this as { __cleanup?: () => void }).__cleanup = () =>
            cleanups.forEach((c) => c());
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// ImageFilename — show attachment filename as a hover tooltip.
// ---------------------------------------------------------------------------

const ImageFilename: Plugin = {
    name: "ImageFilename",
    description: "Show the file name of images as a hover tooltip.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(document, "mouseover", '[class*="attachment"], [class*="imageAttachment"]', (node) => {
            const media = node as HTMLElement;
            const nameEl = media.querySelector<HTMLElement>(
                '[class*="filename"], [class*="fileName"], [class*="name"]',
            );
            const name =
                nameEl?.textContent?.trim() ||
                media.querySelector("a[href]")?.getAttribute("href")?.split("/").pop();
            if (!name) return;
            media.title = name;
        });
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// VoiceDownload — download voice messages.
// ---------------------------------------------------------------------------

const VoiceDownload: Plugin = {
    name: "VoiceDownload",
    description: "Adds a download option to voice messages.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            '[class*="voiceMessage"], [class*="waveform"], [class*="audioAttachment"]',
            (node, ev) => {
                const container = node as HTMLElement;
                const src =
                    container.querySelector<HTMLSourceElement>("source")?.src ??
                    container.querySelector<HTMLMediaElement>("audio,video")?.currentSrc ??
                    container.querySelector<HTMLElement>("[src]")?.getAttribute("src");
                if (!src) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                contextMenu(me.clientX, me.clientY, [
                    {
                        label: "Download voice message",
                        action: () => {
                            const a = document.createElement("a");
                            a.href = src;
                            a.download = "voice-message.ogg";
                            a.target = "_blank";
                            a.rel = "noopener";
                            document.body.append(a);
                            a.click();
                            a.remove();
                        },
                    },
                ]);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// DirectFileDownload — download attachments directly.
// ---------------------------------------------------------------------------

const DirectFileDownload: Plugin = {
    name: "DirectFileDownload",
    description: "Download attachments and media directly.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            'a[href*="cdn.discordapp.com/attachments"], a[href*="media.discordapp.net/attachments"], a[href*="cdn.discordapp.com/avatars"], a[href*="cdn.discordapp.com/icons"]',
            (node, ev) => {
                const a = node as HTMLAnchorElement;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                contextMenu(me.clientX, me.clientY, [
                    { label: "Open in browser", action: () => window.open(a.href, "_blank") },
                    {
                        label: "Download",
                        action: () => {
                            void (async () => {
                                try {
                                    const res = await fetch(a.href);
                                    const blob = await res.blob();
                                    const url = URL.createObjectURL(blob);
                                    const dl = document.createElement("a");
                                    dl.href = url;
                                    dl.download =
                                        new URL(a.href).pathname.split("/").pop() ??
                                        "download";
                                    document.body.append(dl);
                                    dl.click();
                                    dl.remove();
                                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                                } catch (e) {
                                    log.warn("direct download failed", e);
                                    toast("Download failed");
                                }
                            })();
                        },
                    },
                ]);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// ViewRaw — copy the raw message JSON.
// ---------------------------------------------------------------------------

const ViewRaw: Plugin = {
    name: "ViewRaw",
    description: "Copy the raw data of any message.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(document, "contextmenu", '[id^="chat-messages-"]', (node, ev) => {
            const ids = messageIds(node);
            if (!ids) return;
            const msg = getMessage(ids.channelId, ids.messageId);
            if (!msg) return;
            ev.preventDefault();
            ev.stopPropagation();
            const me = ev as MouseEvent;
            contextMenu(me.clientX, me.clientY, [
                {
                    label: "Copy Raw Message",
                    action: () => {
                        void navigator.clipboard
                            .writeText(JSON.stringify(msg, null, 2))
                            .then(() => toast("Raw message copied"))
                            .catch(() => toast("Copy failed"));
                    },
                },
            ]);
        });
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// CopyUserURLs — "Copy User URL" on message authors.
// ---------------------------------------------------------------------------

const CopyUserURLs: Plugin = {
    name: "CopyUserURLs",
    description: "Copy a user's profile URL from their messages.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            '[id^="chat-messages-"] [class*="username"], [id^="chat-messages-"] [class*="avatar"]',
            (node, ev) => {
                const ids = messageIds(node);
                if (!ids) return;
                const msg = getMessage(ids.channelId, ids.messageId);
                const author = isObj(msg?.author) ? msg.author : null;
                const userId = author?.id;
                if (userId == null) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                contextMenu(me.clientX, me.clientY, [
                    {
                        label: "Copy User URL",
                        action: () => {
                            void navigator.clipboard
                                .writeText(`https://discord.com/users/${userId}`)
                                .then(() => toast("User URL copied"))
                                .catch(() => {});
                        },
                    },
                ]);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// CopyEmojiMarkdown — copy custom emoji as <:name:id>.
// ---------------------------------------------------------------------------

const CopyEmojiMarkdown: Plugin = {
    name: "CopyEmojiMarkdown",
    description: "Copy emojis as formatted markdown strings.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            'img[src*="/emojis/"], img[alt*=":"]',
            (node, ev) => {
                const img = node as HTMLImageElement;
                const src = img.currentSrc || img.src;
                const idMatch = /\/emojis\/(\d+)/.exec(src) ?? /(\d{15,25})/.exec(src);
                const name =
                    (img.getAttribute("alt") ?? "")
                        .replace(/^:|:$/g, "")
                        .replace(/[^\w+-]/g, "") || "emoji";
                if (!idMatch) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                contextMenu(me.clientX, me.clientY, [
                    {
                        label: "Copy Emoji Markdown",
                        action: () => {
                            void navigator.clipboard
                                .writeText(`<:${name}:${idMatch[1]}>`)
                                .then(() => toast("Emoji markdown copied"))
                                .catch(() => {});
                        },
                    },
                ]);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// UserPronouns — copy pronouns for a message author.
// ---------------------------------------------------------------------------

const UserPronouns: Plugin = {
    name: "UserPronouns",
    description: "Copy a user's pronouns (pronouns.alejo.io).",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { enabled: true },

    start() {
        const off = on(
            document,
            "contextmenu",
            '[id^="chat-messages-"] [class*="username"], [id^="chat-messages-"] [class*="avatar"]',
            (node, ev) => {
                const ids = messageIds(node);
                if (!ids) return;
                const msg = getMessage(ids.channelId, ids.messageId);
                const author = isObj(msg?.author) ? msg.author : null;
                const userId = author?.id;
                if (userId == null) return;
                ev.preventDefault();
                ev.stopPropagation();
                const me = ev as MouseEvent;
                contextMenu(me.clientX, me.clientY, [
                    {
                        label: "Copy Pronouns",
                        action: () => {
                            void (async () => {
                                try {
                                    const res = await fetch(
                                        `https://pronouns.alejo.io/api/users/${userId}`,
                                    );
                                    const data = (await res.json()) as {
                                        string?: string;
                                    };
                                    const pronouns = data?.string;
                                    if (pronouns) {
                                        await navigator.clipboard.writeText(pronouns);
                                        toast(`Pronouns: ${pronouns}`);
                                    } else {
                                        toast("No pronouns set");
                                    }
                                } catch {
                                    toast("Pronouns lookup failed");
                                }
                            })();
                        },
                    },
                ]);
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// NoMaskedUrlPaste — paste URLs as plain text when text is selected.
// ---------------------------------------------------------------------------

const URL_RE = /^https?:\/\//i;

const NoMaskedUrlPaste: Plugin = {
    name: "NoMaskedUrlPaste",
    description: "Pasting a link with text selected inserts the raw URL.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const onPaste = (ev: ClipboardEvent) => {
            const sel = window.getSelection()?.toString() ?? "";
            if (!sel) return;
            const text = ev.clipboardData?.getData("text/plain") ?? "";
            if (!URL_RE.test(text.trim())) return;
            ev.preventDefault();
            ev.stopPropagation();
            document.execCommand("insertText", false, text.trim());
        };
        document.addEventListener("paste", onPaste, true);
        (this as { __off?: () => void }).__off = () =>
            document.removeEventListener("paste", onPaste, true);
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// NoF1 — disable the F1 help shortcut.
// ---------------------------------------------------------------------------

const NoF1: Plugin = {
    name: "NoF1",
    description: "Disables the F1 help keybind.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "F1") {
                e.preventDefault();
                e.stopPropagation();
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
// ConsoleJanitor — filter noisy console messages.
// ---------------------------------------------------------------------------

const DEFAULT_JANITOR_PATTERNS = ["Electron Security Warning"];

const ConsoleJanitor: Plugin = {
    name: "ConsoleJanitor",
    description: "Suppresses selected console warnings/errors.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { patterns: DEFAULT_JANITOR_PATTERNS.join("\n") },

    start() {
        const originals = {
            warn: console.warn,
            error: console.error,
            info: console.info,
            log: console.log,
        };
        const getPatterns = async (): Promise<string[]> => {
            const raw = await Api.Settings.get<string>(
                "plugins.settings.ConsoleJanitor.patterns",
            );
            return (raw ?? "")
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);
        };
        let patterns = DEFAULT_JANITOR_PATTERNS;
        void getPatterns().then((p) => (patterns = p.length ? p : patterns));
        const wrap =
            (orig: (...a: unknown[]) => void) =>
            (...args: unknown[]) => {
                const text = args.map(String).join(" ");
                if (patterns.some((p) => text.includes(p))) return;
                orig.apply(console, args);
            };
        console.warn = wrap(originals.warn);
        console.error = wrap(originals.error);
        console.info = wrap(originals.info);
        console.log = wrap(originals.log);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            Object.assign(console, originals);
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// SilentTyping — don't send typing events at all.
// ---------------------------------------------------------------------------

const SilentTyping: Plugin = {
    name: "SilentTyping",
    description: "Hide that you are typing.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const mod = Api.Webpack.findByProps("startTyping", "typingStart");
        const target =
            isObj(mod) && typeof mod.startTyping === "function"
                ? mod
                : isObj(mod) && typeof mod.typingStart === "function"
                  ? mod
                  : null;
        if (!target) {
            const key =
                isObj(mod) && typeof mod.startTyping === "function"
                    ? "startTyping"
                    : "typingStart";
            if (isObj(mod)) {
                try {
                    Api.Patcher.instead(this.name, mod, key, () => null);
                    log.info("typing suppressed", { key });
                    return;
                } catch {
                    // fallthrough
                }
            }
            log.warn("typing module not found — plugin inactive");
            return;
        }
        const key =
            typeof target.startTyping === "function" ? "startTyping" : "typingStart";
        try {
            Api.Patcher.instead(this.name, target, key, () => null);
            log.info("typing suppressed", { key });
        } catch (e) {
            log.warn("typing patch failed", e);
        }
    },
};

// ---------------------------------------------------------------------------
// GifPaste / StickerPaste — insert into composer instead of sending.
// ---------------------------------------------------------------------------

const GIF_URL_RE =
    /^https?:\/\/(tenor\.com|media\.tenor\.com|media\.giphy\.com|media\d*\.giphy\.com|cdn\.discordapp\.com\/attachments).*\.(gif|mp4|webm)/i;

function patchSendToInsert(pluginName: string, predicate: (data: Record<string, unknown>) => boolean, toText: (data: Record<string, unknown>) => string): boolean {
    const mod = findSendModule();
    if (!mod) return false;
    Api.Patcher.before(pluginName, mod, "sendMessage", (...args) => {
        for (const arg of args) {
            if (!isObj(arg)) continue;
            if (predicate(arg)) {
                insertIntoComposer(toText(arg));
                // Signal "handled" by returning modified args that send
                // nothing: empty content + no attachments/stickers.
                const clean: Record<string, unknown> = { ...arg };
                clean.content = "";
                delete clean.attachments;
                delete clean.sticker_ids;
                delete clean.stickers;
                delete clean.embeds;
                return args.map((a) => (a === arg ? clean : a));
            }
        }
        return args;
    });
    return true;
}

const GifPaste: Plugin = {
    name: "GifPaste",
    description: "Insert picked GIFs into the message box instead of sending.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const ok = patchSendToInsert(
            this.name,
            (data) =>
                typeof data.content === "string" && GIF_URL_RE.test(data.content.trim()),
            (data) => `${data.content}\n`,
        );
        if (!ok) log.warn("send module not found — plugin inactive");
    },
};

const StickerPaste: Plugin = {
    name: "StickerPaste",
    description: "Insert picked stickers as links instead of sending.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const ok = patchSendToInsert(
            this.name,
            (data) =>
                Array.isArray(data.sticker_ids) &&
                (data.sticker_ids as unknown[]).length > 0,
            (data) => {
                const id = String((data.sticker_ids as unknown[])[0]);
                return `https://cdn.discordapp.com/stickers/${id}.png?size=160\n`;
            },
        );
        if (!ok) log.warn("send module not found — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// TypingIndicator — show "X is typing" above the composer.
// ---------------------------------------------------------------------------

const TypingIndicator: Plugin = {
    name: "TypingIndicator",
    description: "Shows who is typing in the current channel.",
    authors: ["Monocord"],
    version: "0.1.0",

    async start() {
        // Discord's TypingStore emits TYPING_START/STOP flux events.
        const dispatcher = findDispatcher();
        if (!dispatcher) {
            log.warn("flux dispatcher not found — plugin inactive");
            return;
        }
        const typing = new Map<string, Set<string>>(); // channelId -> userIds
        const indicator = el(
            "div",
            {
                position: "absolute",
                bottom: "56px",
                left: "16px",
                zIndex: "5",
                fontSize: "12px",
                color: "var(--text-muted, #949ba4)",
                fontStyle: "italic",
                pointerEvents: "none",
            },
        );
        const userStore = findStoreByName("UserStore");
        const getUserName = (id: string): string => {
            const fn = userStore?.getUser;
            if (typeof fn !== "function") return "Someone";
            try {
                const u = (fn as (id: string) => Record<string, unknown>).call(
                    userStore,
                    id,
                );
                return String(u?.username ?? u?.globalName ?? "Someone");
            } catch {
                return "Someone";
            }
        };
        const currentChannel = (): string | null => {
            const url = location.pathname;
            const m = /\/channels\/(?:@me|\d+)\/(\d+)/.exec(url);
            return m?.[1] ?? null;
        };
        const render = () => {
            const ch = currentChannel();
            const users = ch ? typing.get(ch) : undefined;
            if (!users || users.size === 0) {
                indicator.remove();
                return;
            }
            const names = [...users].slice(0, 3).map(getUserName);
            const suffix = users.size > 3 ? ` +${users.size - 3} more` : "";
            indicator.textContent = `${names.join(", ")}${suffix} ${users.size === 1 ? "is" : "are"} typing…`;
            const container = document.querySelector('[class*="channelTextArea"]')
                ?.parentElement;
            if (container && !indicator.isConnected) {
                const prev = container.style.position;
                container.style.position = "relative";
                container.append(indicator);
                (indicator as HTMLElement & { __prev?: string }).__prev = prev;
            }
        };
        dispatcher.subscribe((action) => {
            try {
                const type = action.type;
                if (type !== "TYPING_START" && type !== "TYPING_STOP") return;
                const channelId = String(action.channelId ?? "");
                const authorId = isObj(action.author) ? action.author.id : null;
                const userId = String(action.userId ?? authorId ?? "");
                if (!channelId || !userId) return;
                let set = typing.get(channelId);
                if (!set) {
                    set = new Set();
                    typing.set(channelId, set);
                }
                if (type === "TYPING_START") set.add(userId);
                else set.delete(userId);
                render();
            } catch (e) {
                log.debug("typing indicator failed", e);
            }
        });
        // Typing events expire — periodically prune stale entries.
        const prune = setInterval(() => {
            typing.forEach((set, ch) => {
                if (set.size && currentChannel() !== ch) {
                    // keep; Discord sends TYPING_STOP eventually
                }
            });
        }, 10_000);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            clearInterval(prune);
            indicator.remove();
        };
        log.info("typing indicator subscribed");
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// MessageLatency — toast when a message takes a while to send.
// ---------------------------------------------------------------------------

const MessageLatency: Plugin = {
    name: "MessageLatency",
    description: "Notify when a message takes over 2s to send.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { thresholdMs: 2000 },

    start() {
        const mod = findSendModule();
        if (!mod) {
            log.warn("send module not found — plugin inactive");
            return;
        }
        Api.Patcher.after(this.name, mod, "sendMessage", (result: unknown) => {
            // sendMessage resolves when the message is dispatched locally;
            // true server latency isn't observable here, so we measure the
            // synchronous+promise portion and warn on slow sends.
            if (result && typeof (result as Promise<unknown>).then === "function") {
                const t0 = Date.now();
                (result as Promise<unknown>).then(() => {
                    const ms = Date.now() - t0;
                    if (ms > 2000) toast(`Message took ${ms}ms to send`, 4000);
                });
            }
            return result;
        });
        log.info("latency watcher installed");
    },
};

// ---------------------------------------------------------------------------
// Unindent — dedent code blocks in the DOM.
// ---------------------------------------------------------------------------

const Unindent: Plugin = {
    name: "Unindent",
    description: "Trim leading indentation from code blocks.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const dedent = (pre: Element) => {
            const html = pre as HTMLElement;
            if (html.dataset.mcUnindent) return;
            html.dataset.mcUnindent = "1";
            const code = pre.querySelector("code");
            if (!code) return;
            const text = code.textContent ?? "";
            if (!text.includes("\n")) return;
            const lines = text.split("\n");
            const indents = lines
                .filter((l) => l.trim().length > 0)
                .map((l) => l.match(/^\s*/)![0].length);
            const min = Math.min(...indents);
            if (min === 0) return;
            code.textContent = lines
                .map((l) => l.slice(Math.min(min, l.match(/^\s*/)![0].length)))
                .join("\n");
        };
        const stop = observeAdded("pre", (node) => {
            dedent(node);
            setTimeout(() => dedent(node), 500);
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// BetterGifAltText — replace "GIF" alt text with filename/tags.
// ---------------------------------------------------------------------------

const BetterGifAltText: Plugin = {
    name: "BetterGifAltText",
    description: "Show GIF filename/tags instead of plain 'GIF' alt text.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const fix = (img: HTMLImageElement) => {
            if (img.dataset.mcGifAlt || img.alt !== "GIF") return;
            img.dataset.mcGifAlt = "1";
            const container = img.closest('[class*="embed"], [class*="attachment"], [id^="chat-messages-"]');
            const title =
                container?.querySelector<HTMLElement>(
                    '[class*="title"], [class*="filename"], [class*="name"]',
                )?.textContent?.trim();
            const href = container?.querySelector("a[href]")?.getAttribute("href");
            const fromUrl = href?.split("/").pop()?.split("?")[0];
            img.alt = title || fromUrl || img.alt;
        };
        const stop = observeAdded("img", (node) => {
            if (node instanceof HTMLImageElement) fix(node);
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// BetterGifPicker — open the GIF picker on Favorites.
// ---------------------------------------------------------------------------

const BetterGifPicker: Plugin = {
    name: "BetterGifPicker",
    description: "Open the GIF picker on your favorites category.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const stop = observeAdded('[class*="gifPicker"], [class*="GIFPicker"]', (picker) => {
            const html = picker as HTMLElement;
            if (html.dataset.mcGifFav) return;
            html.dataset.mcGifFav = "1";
            setTimeout(() => {
                const fav = Array.from(
                    picker.querySelectorAll<HTMLElement>("button, [role='tab'], [role='button']"),
                ).find((b) => /favorite|favourite/i.test(b.textContent ?? ""));
                fav?.click();
            }, 300);
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// AddAttachments — show an attach button while editing a message.
// ---------------------------------------------------------------------------

const AddAttachments: Plugin = {
    name: "AddAttachments",
    description: "Allows adding attachments while editing messages.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const cleanups: (() => void)[] = [];
        const attach = (container: Element) => {
            if (container.querySelector("[data-mc-editattach]")) return;
            const btn = el(
                "button",
                {
                    position: "absolute",
                    bottom: "6px",
                    right: "70px",
                    zIndex: "5",
                    background: "var(--background-modifier-accent, #3f4147)",
                    color: "var(--text-normal, #dbdee1)",
                    border: "none",
                    borderRadius: "4px",
                    padding: "4px 10px",
                    fontSize: "12px",
                    cursor: "pointer",
                    display: "none",
                },
                "📎",
            );
            btn.dataset.mcEditattach = "1";
            btn.title = "Add attachment while editing";
            btn.addEventListener("click", () => {
                document
                    .querySelector<HTMLInputElement>('input[type="file"]')
                    ?.click();
            });
            const parent = container as HTMLElement;
            const prev = parent.style.position;
            parent.style.position = "relative";
            parent.append(btn);
            // Show only while an edit is in progress (composer shows a
            // "Edit Message" indicator or cancel button).
            const mo = new MutationObserver(() => {
                const editing = !!document.querySelector(
                    '[class*="editMessage"], [aria-label*="Cancel"], [class*="editing"]',
                );
                btn.style.display = editing ? "block" : "none";
            });
            mo.observe(document.body, { childList: true, subtree: true });
            cleanups.push(() => {
                mo.disconnect();
                btn.remove();
                parent.style.position = prev;
            });
        };
        cleanups.push(observeAdded('[class*="channelTextArea"]', attach));
        (this as { __cleanup?: () => void }).__cleanup = () =>
            cleanups.forEach((c) => c());
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// BetterUploadButton — click uploads, right-click opens the menu.
// ---------------------------------------------------------------------------

const BetterUploadButton: Plugin = {
    name: "BetterUploadButton",
    description: "Single click to upload, right click for the upload menu.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        let armed = false;
        const offCtx = on(
            document,
            "contextmenu",
            'button[aria-label*="Upload"], [class*="upload"] button',
            (node, ev) => {
                armed = true;
                (node as HTMLElement).click();
                setTimeout(() => (armed = false), 400);
                ev.preventDefault();
            },
        );
        const offClick = on(
            document,
            "click",
            'button[aria-label*="Upload"], [class*="upload"] button',
            (node, ev) => {
                if (armed) return; // let the menu open
                ev.preventDefault();
                ev.stopPropagation();
                document
                    .querySelector<HTMLInputElement>('input[type="file"]')
                    ?.click();
            },
            true,
        );
        (this as { __cleanup?: () => void }).__cleanup = () => {
            offCtx();
            offClick();
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// MessageLinkEmbeds — nothing extra needed; Discord already unfurls links.
// (Kept as a no-op placeholder is NOT done — skipped entirely.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure CSS plugins
// ---------------------------------------------------------------------------

const ShowAllMessageButtons = cssPlugin(
    "ShowAllMessageButtons",
    "Always show all message action buttons.",
    `
    [class*="message"] [class*="toolbar"],
    [class*="message"] [class*="hoverToolbar"],
    [id^="chat-messages-"] [class*="toolbar"] {
        opacity: 1 !important;
        pointer-events: auto !important;
    }
    `,
);

const NoTypingAnimation = cssPlugin(
    "NoTypingAnimation",
    "Disables the typing dots animation.",
    `
    [class*="typing"] [class*="dot"],
    [class*="typingDots"] * {
        animation: none !important;
    }
    `,
);

const PlainFolderIcon = cssPlugin(
    "PlainFolderIcon",
    "Don't show small guild icons inside folders.",
    `
    [class*="folder"] img {
        display: none !important;
    }
    `,
);

const NoPendingCount = cssPlugin(
    "NoPendingCount",
    "Hide friend-request and Nitro badge counts.",
    `
    [class*="friends"] [class*="badge"],
    [class*="nitro"] [class*="badge"],
    [class*="directMessages"] [class*="badge"][class*="count"] {
        display: none !important;
    }
    `,
);

const FixCodeblockGap = cssPlugin(
    "FixCodeblockGap",
    "Remove the gap between code blocks and surrounding text.",
    `
    [class*="codeBlock"] {
        margin-bottom: 0 !important;
    }
    [class*="codeBlock"] + div,
    [class*="codeBlock"] + span {
        margin-top: 0 !important;
    }
    `,
);

const ColorSighted = cssPlugin(
    "ColorSighted",
    "Remove colorblind-friendly status icons.",
    `
    [class*="colorBlind"],
    [class*="colorblind"] {
        display: none !important;
    }
    `,
);

const NoMosaic = cssPlugin(
    "NoMosaic",
    "Remove Discord's image mosaic blur.",
    `
    [class*="mosaic"] img,
    [class*="mosaic"] video,
    [class*="imageMosaic"] * {
        filter: none !important;
    }
    `,
);

const AlwaysExpandRoles = cssPlugin(
    "AlwaysExpandRoles",
    "Attempt to always expand role lists in profiles.",
    `
    [class*="roles"] [class*="container"],
    [class*="roleList"] {
        max-height: none !important;
        overflow: visible !important;
    }
    `,
);

// ---------------------------------------------------------------------------

export function registerChat3(): void {
    for (const plugin of [
        JumpToTop,
        MessageClickActions,
        QuickReply,
        QuickMention,
        RevealAllSpoilers,
        UnsuppressEmbeds,
        HideMedia,
        ImageFilename,
        VoiceDownload,
        DirectFileDownload,
        ViewRaw,
        CopyUserURLs,
        CopyEmojiMarkdown,
        UserPronouns,
        NoMaskedUrlPaste,
        NoF1,
        ConsoleJanitor,
        SilentTyping,
        GifPaste,
        StickerPaste,
        TypingIndicator,
        MessageLatency,
        Unindent,
        BetterGifAltText,
        BetterGifPicker,
        AddAttachments,
        BetterUploadButton,
        ShowAllMessageButtons,
        NoTypingAnimation,
        PlainFolderIcon,
        NoPendingCount,
        FixCodeblockGap,
        ColorSighted,
        NoMosaic,
        AlwaysExpandRoles,
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
