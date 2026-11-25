/**
 * Extra built-in plugins: CSS appearance tweaks and lightweight behavior
 * patches. Everything degrades gracefully — a missing Discord module or an
 * unmatched CSS selector just means the plugin does nothing.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";

const log = Logger.get("extras");

function cssPlugin(name: string, description: string, css: string): Plugin {
    const styleId = name.toLowerCase();
    return {
        name,
        description,
        authors: ["Monocord"],
        version: "0.1.0",
        start() {
            Api.Themes.injectCss(styleId, css);
        },
        stop() {
            Api.Themes.removeCss(styleId);
        },
    };
}

// ---------------------------------------------------------------------------
// CSS plugins
// ---------------------------------------------------------------------------

const RoundAvatars = cssPlugin(
    "RoundAvatars",
    "Round server and group icons instead of rounded squares.",
    `
    /* RoundAvatars */
    nav [class*="guilds"] img,
    [class*="guilds"] [class*="avatar"] img,
    [class*="guilds"] [class*="icon"] img {
        border-radius: 50% !important;
    }
    `,
);

const ThinScrollbars = cssPlugin(
    "ThinScrollbars",
    "Slimmer, more subtle scrollbars.",
    `
    /* ThinScrollbars */
    ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
    }
    ::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thin-thumb, rgba(255,255,255,.16));
        border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
        background: var(--scrollbar-thin-thumb-hover, rgba(255,255,255,.24));
    }
    ::-webkit-scrollbar-track,
    ::-webkit-scrollbar-corner {
        background: transparent;
    }
    `,
);

const DisableAnimations = cssPlugin(
    "DisableAnimations",
    "Remove UI animations and transitions for a snappier feel.",
    `
    /* DisableAnimations */
    *,
    *::before,
    *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
    }
    `,
);

const BiggerText = cssPlugin(
    "BiggerText",
    "Slightly larger UI text (scales rem-based layout).",
    `
    /* BiggerText */
    html {
        font-size: 17px !important;
    }
    `,
);

// ---------------------------------------------------------------------------
// NoTypingIndicator — hide "X is typing" affordances.
// ---------------------------------------------------------------------------

const NoTypingIndicator: Plugin = {
    name: "NoTypingIndicator",
    description: "Hide typing indicators in message lists.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        // 1) Try the typing store first — empty results hide every indicator.
        const store =
            Api.Webpack.findStore("TypingStore") ??
            Api.Webpack.findByProps("getTypingUsers", "isTyping");
        if (store && typeof store === "object") {
            const target = store as Record<string, unknown>;
            const patched: string[] = [];
            for (const key of Object.keys(target)) {
                const fn = target[key];
                if (
                    typeof fn === "function" &&
                    /typing|isTyping|getUsers|getAll/i.test(key)
                ) {
                    try {
                        Api.Patcher.instead(this.name, target, key, () =>
                            /^is/i.test(key) ? false : [],
                        );
                        patched.push(key);
                    } catch {
                        // non-configurable — try next
                    }
                }
            }
            if (patched.length > 0) {
                log.info("typing store patched", { methods: patched });
                return;
            }
        }

        // 2) Fall back to hiding the typing component entirely.
        for (const displayName of [
            "TypingDots",
            "TypingIndicator",
            "MessageTypingIndicator",
            "TypingIndicatorContainer",
        ]) {
            const component = Api.Webpack.findByDisplayName(displayName);
            const proto =
                component && typeof component === "function"
                    ? (component as { prototype?: { render?: unknown } })
                          .prototype
                    : undefined;
            if (proto && typeof proto.render === "function") {
                try {
                    Api.Patcher.instead(this.name, proto, "render", () => null);
                    log.info("typing component hidden", { displayName });
                    return;
                } catch {
                    // keep looking
                }
            }
        }
        log.warn("no typing indicator target found — plugin inactive");
    },
};

// ---------------------------------------------------------------------------
// FakeTyping — periodically emit typing events in the current channel.
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | undefined;

const FakeTyping: Plugin = {
    name: "FakeTyping",
    description: "Pretend to be typing in the current channel.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { intervalSeconds: 9 },

    async start() {
        const starter =
            Api.Webpack.findByProps("startTyping") ??
            Api.Webpack.findByProps("typingStart");
        const channelStore =
            Api.Webpack.findStore("SelectedChannelStore") ??
            Api.Webpack.findStore("SelectedChannelStore") ??
            Api.Webpack.findByProps("getCurrentlySelectedChannelId");
        if (!starter || typeof starter !== "object") {
            log.warn("typing action module not found — plugin inactive");
            return;
        }
        const interval =
            ((await Api.Settings.get<number>(
                "plugins.settings.FakeTyping.intervalSeconds",
                9,
            )) ?? 9) * 1000;

        const tick = () => {
            try {
                const channelId = (
                    channelStore as { getChannelId?: () => string | null }
                )?.getChannelId?.();
                if (!channelId) return;
                for (const key of Object.keys(starter as object)) {
                    const fn = (starter as Record<string, unknown>)[key];
                    if (typeof fn === "function" && /typing/i.test(key)) {
                        (fn as (id: string) => void)(channelId);
                        return;
                    }
                }
                const direct = (starter as Record<string, unknown>).startTyping;
                if (typeof direct === "function") {
                    (direct as (id: string) => void)(channelId);
                }
            } catch (e) {
                log.debug("fake typing tick failed", e);
            }
        };
        tick();
        timer = setInterval(tick, interval);
    },

    stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
    },
};

/** Register all extra plugins. */
export function registerExtras(): void {
    for (const plugin of [
        RoundAvatars,
        ThinScrollbars,
        DisableAnimations,
        BiggerText,
        NoTypingIndicator,
        FakeTyping,
    ]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
