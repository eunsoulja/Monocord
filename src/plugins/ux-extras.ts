/**
 * DOM/CSS-based plugins — appearance tweaks and message-area conveniences.
 * All of them work by observing Discord's DOM and degrade silently when
 * selectors stop matching after a Discord update.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { cssPlugin } from "./extras";
import { el, observeAdded, on, onDomReady, toast } from "./dom-utils";

const log = Logger.get("ux-extras");

// ---------------------------------------------------------------------------
// CharacterCounter — show length/limit while typing.
// ---------------------------------------------------------------------------

const CharacterCounter: Plugin = {
    name: "CharacterCounter",
    description: "Shows the character count of your message draft.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const cleanups: (() => void)[] = [];
        const attach = (container: Element) => {
            const editable =
                container.querySelector<HTMLElement>(
                    '[contenteditable="true"], textarea',
                ) ?? (container as HTMLElement);
            if ((editable as HTMLElement).dataset?.mcCounter) return;
            editable.dataset.mcCounter = "1";
            const counter = el(
                "div",
                {
                    position: "absolute",
                    bottom: "6px",
                    right: "12px",
                    fontSize: "11px",
                    color: "var(--text-muted, #949ba4)",
                    pointerEvents: "none",
                    zIndex: "5",
                    fontVariantNumeric: "tabular-nums",
                },
            );
            const parent =
                container instanceof HTMLElement ? container : editable;
            const prevPosition = parent.style.position;
            parent.style.position = "relative";
            parent.append(counter);
            const update = () => {
                const text =
                    editable instanceof HTMLTextAreaElement
                        ? editable.value
                        : (editable.textContent ?? "");
                counter.textContent = String(text.length);
                counter.style.color =
                    text.length > 1900
                        ? "var(--status-danger, #f23f43)"
                        : "var(--text-muted, #949ba4)";
            };
            editable.addEventListener("input", update);
            update();
            cleanups.push(() => {
                editable.removeEventListener("input", update);
                counter.remove();
                parent.style.position = prevPosition;
            });
        };
        const stopObserve = observeAdded('[class*="channelTextArea"]', attach);
        cleanups.push(stopObserve);
        (this as { __cleanup?: () => void }).__cleanup = () =>
            cleanups.forEach((c) => c());
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// ClearURLs — strip tracking parameters from links before navigation.
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|dclid|gclsrc|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|vero_id|wickedid|ttclid|twclid|li_fat_id|igshid|spm|scm)/i;

const ClearURLs: Plugin = {
    name: "ClearURLs",
    description: "Removes tracking parameters from links you click.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const handler = (ev: Event) => {
            const t = ev.target;
            if (!(t instanceof Element)) return;
            const a = t.closest("a[href]");
            if (!(a instanceof HTMLAnchorElement)) return;
            try {
                const url = new URL(a.href);
                let changed = false;
                for (const key of [...url.searchParams.keys()]) {
                    if (TRACKING_PARAMS.test(key)) {
                        url.searchParams.delete(key);
                        changed = true;
                    }
                }
                if (changed) a.href = url.toString();
            } catch {
                // not a parseable URL — leave it
            }
        };
        document.addEventListener("click", handler, true);
        document.addEventListener("auxclick", handler, true);
        (this as { __off?: () => void }).__off = () => {
            document.removeEventListener("click", handler, true);
            document.removeEventListener("auxclick", handler, true);
        };
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// Image helpers — decide which <img> elements are message media.
// ---------------------------------------------------------------------------

const MEDIA_HOST = /media\.discordapp\.net|images-ext|cdn\.discordapp\.com\/attachments|media\.discordapp\.com/i;

function isMessageImage(img: HTMLImageElement): boolean {
    if (!MEDIA_HOST.test(img.currentSrc || img.src)) return false;
    // Emojis/stickers are tiny; require a reasonable rendered size.
    return img.naturalWidth > 96 && img.naturalHeight > 96;
}

// ---------------------------------------------------------------------------
// ImageZoom — click a message image to view it large.
// ---------------------------------------------------------------------------

const ImageZoom: Plugin = {
    name: "ImageZoom",
    description: "Click an image in chat to view it full size.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const open = (src: string) => {
            const overlay = el(
                "div",
                {
                    position: "fixed",
                    inset: "0",
                    zIndex: "100001",
                    background: "rgba(0,0,0,.85)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "zoom-out",
                },
            );
            const img = document.createElement("img");
            img.src = src;
            img.style.cssText =
                "max-width:92vw;max-height:92vh;object-fit:contain;border-radius:8px;";
            overlay.append(img);
            const close = () => overlay.remove();
            overlay.addEventListener("click", close);
            document.addEventListener("keydown", function onKey(e) {
                if (e.key === "Escape") {
                    close();
                    document.removeEventListener("keydown", onKey);
                }
            });
            document.body.append(overlay);
        };
        const off = on(document, "click", "img", (node, ev) => {
            const img = node as HTMLImageElement;
            // Don't hijack clicks inside the zoom overlay itself or on
            // lightbox-triggering embeds Discord already handles.
            if (img.closest('[class*="imageZoom"], [class*="modal"]')) return;
            if (!isMessageImage(img)) return;
            ev.preventDefault();
            ev.stopPropagation();
            open(img.currentSrc || img.src);
        });
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// ReverseImageSearch — context-menu on an image to search it.
// ---------------------------------------------------------------------------

const ReverseImageSearch: Plugin = {
    name: "ReverseImageSearch",
    description: "Right-click an image to reverse image search it.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(document, "contextmenu", "img", (node, ev) => {
            const img = node as HTMLImageElement;
            if (!isMessageImage(img)) return;
            ev.preventDefault();
            ev.stopPropagation();
            const src = img.currentSrc || img.src;
            const menu = el(
                "div",
                {
                    position: "fixed",
                    left: `${(ev as MouseEvent).clientX}px`,
                    top: `${(ev as MouseEvent).clientY}px`,
                    zIndex: "100001",
                    background: "var(--background-floating, #111214)",
                    border: "1px solid var(--background-modifier-accent, #3f4147)",
                    borderRadius: "8px",
                    padding: "4px",
                    minWidth: "180px",
                    boxShadow: "0 8px 24px rgba(0,0,0,.4)",
                },
            );
            const close = () => menu.remove();
            const item = (label: string, url: string) => {
                const b = el(
                    "button",
                    {
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        background: "none",
                        border: "none",
                        color: "var(--text-normal, #dbdee1)",
                        padding: "8px 12px",
                        fontSize: "13px",
                        cursor: "pointer",
                        borderRadius: "4px",
                    },
                    label,
                );
                b.addEventListener("mouseenter", () => (b.style.background = "var(--background-modifier-hover, rgba(78,80,88,.3))"));
                b.addEventListener("mouseleave", () => (b.style.background = "none"));
                b.addEventListener("click", () => {
                    window.open(url, "_blank");
                    close();
                });
                return b;
            };
            menu.append(
                item(
                    "Search with Google Lens",
                    `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(src)}`,
                ),
                item(
                    "Search with SauceNAO",
                    `https://saucenao.com/search.php?url=${encodeURIComponent(src)}`,
                ),
            );
            document.body.append(menu);
            setTimeout(() => {
                document.addEventListener("click", close, { once: true });
                document.addEventListener("contextmenu", close, { once: true });
            }, 0);
        });
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// PictureInPicture — PiP button on videos in chat.
// ---------------------------------------------------------------------------

const PictureInPicture: Plugin = {
    name: "PictureInPicture",
    description: "Adds a picture-in-picture button to videos.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const stop = observeAdded("video", (video) => {
            if (!(video instanceof HTMLVideoElement)) return;
            if (video.dataset.mcPip) return;
            video.dataset.mcPip = "1";
            const wrap = video.parentElement;
            if (!wrap) return;
            const prevPosition = wrap.style.position;
            wrap.style.position = "relative";
            const btn = el(
                "button",
                {
                    position: "absolute",
                    bottom: "8px",
                    right: "8px",
                    zIndex: "5",
                    background: "rgba(0,0,0,.6)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "4px",
                    padding: "4px 8px",
                    fontSize: "11px",
                    cursor: "pointer",
                    opacity: "0",
                    transition: "opacity .15s",
                },
                "PiP",
            );
            wrap.addEventListener("mouseenter", () => (btn.style.opacity = "1"));
            wrap.addEventListener("mouseleave", () => (btn.style.opacity = "0"));
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                video
                    .requestPictureInPicture?.()
                    .catch(() => toast("Picture-in-picture unavailable"));
            });
            wrap.append(btn);
            (video as HTMLVideoElement & { __mcCleanup?: () => void }).__mcCleanup =
                () => {
                    btn.remove();
                    wrap.style.position = prevPosition;
                };
        });
        (this as { __stop?: () => void }).__stop = stop;
    },

    stop() {
        (this as { __stop?: () => void }).__stop?.();
    },
};

// ---------------------------------------------------------------------------
// Oneko — a cat that follows your mouse.
// ---------------------------------------------------------------------------

const Oneko: Plugin = {
    name: "Oneko",
    description: "A cat emoji follows your cursor around Discord.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { speed: 300 },

    start() {
        const cat = el(
            "div",
            {
                position: "fixed",
                zIndex: "99999",
                fontSize: "42px",
                pointerEvents: "none",
                left: "0",
                top: "0",
                transition: "transform .45s ease-out",
                willChange: "transform",
            },
            "🐱",
        );
        document.body.append(cat);
        let x = 0;
        let y = 0;
        let cx = 0;
        let cy = 0;
        const onMove = (e: MouseEvent) => {
            x = e.clientX;
            y = e.clientY;
        };
        document.addEventListener("mousemove", onMove);
        const interval = setInterval(() => {
            // Ease toward the cursor with a little lag so it feels alive.
            cx += (x - cx) * 0.18;
            cy += (y - cy) * 0.18;
            cat.style.transform = `translate(${cx - 21}px, ${cy - 21}px)`;
        }, 50);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            clearInterval(interval);
            document.removeEventListener("mousemove", onMove);
            cat.remove();
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// VoiceChatDoubleClick — double-click a voice channel to join it.
// ---------------------------------------------------------------------------

const VoiceChatDoubleClick: Plugin = {
    name: "VoiceChatDoubleClick",
    description: "Double-click a voice channel to join it.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(document, "dblclick", '[class*="container"], li, [role="treeitem"]', (node) => {
            const row = node as HTMLElement;
            const joinBtn = row.querySelector<HTMLElement>(
                'button[aria-label*="oice"], [class*="join"], [class*="connect"]',
            );
            if (joinBtn) {
                joinBtn.click();
                return;
            }
            // Fallback: voice channel rows often contain a phone icon svg.
            const icon = row.querySelector('svg[aria-label*="oice"], [class*="icon"]');
            if (icon) (icon as HTMLElement).click();
        });
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// FixImagesQuality — request lossless images from Discord's media proxy.
// ---------------------------------------------------------------------------

const QUALITY_RE = /([?&])quality=[^&]*/;

const FixImagesQuality: Plugin = {
    name: "FixImagesQuality",
    description: "Loads chat images at lossless quality instead of compressed.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const fix = (img: HTMLImageElement) => {
            if (img.dataset.mcQuality) return;
            const src = img.currentSrc || img.src;
            if (!MEDIA_HOST.test(src)) return;
            img.dataset.mcQuality = "1";
            try {
                const url = new URL(src);
                if (!QUALITY_RE.test(url.search)) {
                    url.searchParams.set("quality", "lossless");
                } else {
                    url.search = url.search.replace(QUALITY_RE, "$1quality=lossless");
                }
                const next = url.toString();
                if (next !== src) img.src = next;
            } catch {
                // unparseable — skip
            }
        };
        const stop = observeAdded("img", (node) => {
            if (node instanceof HTMLImageElement) fix(node);
        });
        // Re-check lazily-loaded images as they scroll in.
        const interval = setInterval(() => {
            document
                .querySelectorAll<HTMLImageElement>("img")
                .forEach((img) => {
                    if (!img.dataset.mcQuality) fix(img);
                });
        }, 3000);
        (this as { __cleanup?: () => void }).__cleanup = () => {
            stop();
            clearInterval(interval);
        };
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

// ---------------------------------------------------------------------------
// SendTimestamps — button that inserts a Discord timestamp into the draft.
// ---------------------------------------------------------------------------

const STYLES = ["t", "T", "d", "D", "f", "F", "R"] as const;

const SendTimestamps: Plugin = {
    name: "SendTimestamps",
    description: "Insert Discord timestamps (<t:…:F>) into your message.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { style: "F" },

    start() {
        const cleanups: (() => void)[] = [];
        const attach = (container: Element) => {
            if (container.querySelector("[data-mc-ts]")) return;
            const btn = el(
                "button",
                {
                    position: "absolute",
                    bottom: "6px",
                    right: "34px",
                    zIndex: "5",
                    background: "var(--background-modifier-accent, #3f4147)",
                    color: "var(--text-normal, #dbdee1)",
                    border: "none",
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "11px",
                    cursor: "pointer",
                },
                "TS",
            );
            btn.dataset.mcTs = "1";
            const parent = container as HTMLElement;
            const prevPosition = parent.style.position;
            parent.style.position = "relative";
            parent.append(btn);
            btn.addEventListener("click", () => {
                void Api.Settings.get<string>(
                    "plugins.settings.SendTimestamps.style",
                    "F",
                ).then((s) => insertTimestamp(s ?? "F"));
            });
            cleanups.push(() => {
                btn.remove();
                parent.style.position = prevPosition;
            });
        };
        const stopObserve = observeAdded('[class*="channelTextArea"]', attach);
        cleanups.push(stopObserve);
        (this as { __cleanup?: () => void }).__cleanup = () =>
            cleanups.forEach((c) => c());
    },

    stop() {
        (this as { __cleanup?: () => void }).__cleanup?.();
    },
};

function insertTimestamp(style: string): void {
    const editable = document.querySelector<HTMLElement>(
        '[class*="channelTextArea"] [contenteditable="true"], [class*="channelTextArea"] textarea',
    );
    if (!editable) {
        toast("Focus the message box first");
        return;
    }
    editable.focus();
    const ts = Math.floor(Date.now() / 1000);
    const text = `<t:${ts}:${style}>`;
    if (editable instanceof HTMLTextAreaElement) {
        const s = editable.selectionStart ?? editable.value.length;
        editable.value =
            editable.value.slice(0, s) + text + editable.value.slice(s);
        editable.dispatchEvent(new Event("input", { bubbles: true }));
        editable.selectionStart = editable.selectionEnd = s + text.length;
        return;
    }
    // Slate-backed contenteditable: execCommand routes through its input path.
    document.execCommand("insertText", false, text);
}

// ---------------------------------------------------------------------------
// CopyFileContents — right-click a text attachment to copy its contents.
// ---------------------------------------------------------------------------

const TEXT_EXT = /\.(txt|md|markdown|json|log|csv|xml|ya?ml|ini|cfg|env|py|js|ts|html?|css|rs|go|java|c|cpp|h|sh|bat|ps1)$/i;

const CopyFileContents: Plugin = {
    name: "CopyFileContents",
    description: "Right-click a text-file attachment to copy its contents.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        const off = on(
            document,
            "contextmenu",
            'a[href*="cdn.discordapp.com/attachments"], a[href*="media.discordapp.net/attachments"]',
            (node, ev) => {
                const a = node as HTMLAnchorElement;
                const href = a.href;
                if (!TEXT_EXT.test(new URL(href).pathname)) return;
                ev.preventDefault();
                ev.stopPropagation();
                void (async () => {
                    try {
                        const res = await fetch(href);
                        if (!res.ok) throw new Error(String(res.status));
                        const text = await res.text();
                        await navigator.clipboard.writeText(text);
                        toast("File contents copied");
                    } catch (e) {
                        log.warn("copy file contents failed", e);
                        toast("Failed to copy file");
                    }
                })();
            },
        );
        (this as { __off?: () => void }).__off = off;
    },

    stop() {
        (this as { __off?: () => void }).__off?.();
    },
};

// ---------------------------------------------------------------------------
// ClientTheme — map settings colors onto Discord's CSS variables.
// ---------------------------------------------------------------------------

const THEME_VARS: Record<string, string> = {
    brand: "--brand-500",
    brandHover: "--brand-560",
    background: "--background-primary",
    secondary: "--background-secondary",
    tertiary: "--background-tertiary",
    floating: "--background-floating",
    text: "--text-normal",
    muted: "--text-muted",
    success: "--status-positive",
    danger: "--status-danger",
    warning: "--status-warning",
};

const ClientTheme: Plugin = {
    name: "ClientTheme",
    description: "Override Discord's color theme via settings.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: {
        brand: "",
        brandHover: "",
        background: "",
        secondary: "",
        tertiary: "",
        floating: "",
        text: "",
        muted: "",
        success: "",
        danger: "",
        warning: "",
    },

    async start() {
        const apply = async () => {
            const parts: string[] = [":root {"];
            for (const [key, cssVar] of Object.entries(THEME_VARS)) {
                const value = await Api.Settings.get<string>(
                    `plugins.settings.ClientTheme.${key}`,
                );
                if (value && /^#[0-9a-fA-F]{3,8}$|^rgba?\(/.test(value.trim())) {
                    parts.push(`  ${cssVar}: ${value.trim()};`);
                }
            }
            parts.push("}");
            Api.Themes.injectCss("clienttheme", parts.join("\n"));
        };
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (
                typeof path === "string" &&
                path.startsWith("plugins.settings.ClientTheme.")
            ) {
                void apply();
            }
        });
        await apply();
    },

    stop() {
        Api.Themes.removeCss("clienttheme");
    },
};

// ---------------------------------------------------------------------------
// Pure CSS plugins
// ---------------------------------------------------------------------------

const BlurNSFW = cssPlugin(
    "BlurNSFW",
    "Blur images inside NSFW-flagged channels until hovered.",
    `
    [class*="nsfw"] img,
    [class*="nsfw"] video {
        filter: blur(18px) saturate(.7) !important;
        transition: filter .2s ease !important;
    }
    [class*="nsfw"] img:hover,
    [class*="nsfw"] video:hover {
        filter: none !important;
    }
    `,
);

const AlwaysAnimate = cssPlugin(
    "AlwaysAnimate",
    "Force all CSS animations to keep playing.",
    `
    *, *::before, *::after {
        animation-play-state: running !important;
    }
    `,
);

const BiggerStreamPreview = cssPlugin(
    "BiggerStreamPreview",
    "Enlarge the stream preview modal.",
    `
    [class*="streamPreview"],
    [class*="previewModal"] [class*="video"],
    [class*="previewModal"] video {
        max-width: 82vw !important;
        max-height: 82vh !important;
    }
    `,
);

// ---------------------------------------------------------------------------

export function registerUxExtras(): void {
    for (const plugin of [
        CharacterCounter,
        ClearURLs,
        ImageZoom,
        ReverseImageSearch,
        PictureInPicture,
        Oneko,
        VoiceChatDoubleClick,
        FixImagesQuality,
        SendTimestamps,
        CopyFileContents,
        ClientTheme,
        BlurNSFW,
        AlwaysAnimate,
        BiggerStreamPreview,
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
