/**
 * Built-in example plugins.
 *
 * These demonstrate the public API surface. `StatusNote` patches a Discord
 * React component through webpack — its module predicate may need tuning
 * for a given Discord version (module shapes change between releases);
 * the plugin degrades to a logged warning rather than crashing Discord.
 */

import { Api } from "../../core/api";
import { Logger } from "../../core/logger";
import type { Plugin } from "../../core/types";

const log = Logger.get("examples");

/**
 * Patch a component's render method whether it is a class (prototype.render)
 * or a plain object/fn with an own `render` property.
 */
function patchRender(
    pluginName: string,
    component: unknown,
    callback: (ret: unknown, ...args: unknown[]) => unknown,
): boolean {
    const candidates: object[] = [];
    if (typeof component === "function" && component.prototype) {
        candidates.push(component.prototype as object);
    }
    if (typeof component === "object" && component !== null) {
        candidates.push(component as object);
    }
    for (const target of candidates) {
        const render = (target as Record<string, unknown>).render;
        if (typeof render === "function") {
            Api.Patcher.after(pluginName, target, "render", callback);
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// 1. StatusNote — custom status display on the user profile popout.
// ---------------------------------------------------------------------------

const StatusNote: Plugin = {
    name: "StatusNote",
    description: "Example: show a custom note on user profile popouts.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: { note: "Monocord user" },

    async start() {
        const component =
            Api.Webpack.findByDisplayName("UserProfilePopout") ??
            Api.Webpack.findByProps("UserProfilePopout");
        if (!component) {
            log.warn("UserProfilePopout module not found — plugin inactive");
            return;
        }
        const react = await Api.React.get().catch(() => null);
        if (!react) {
            log.warn("React module not found — plugin inactive");
            return;
        }
        const createElement = react.createElement as (
            ...args: unknown[]
        ) => unknown;
        const isValidElement = react.isValidElement as (v: unknown) => boolean;
        const cloneElement = react.cloneElement as (
            el: unknown,
            props: unknown,
            ...children: unknown[]
        ) => unknown;

        const note =
            (await Api.Settings.get<string>("plugins.settings.StatusNote.note")) ??
            "Monocord user";

        const ok = patchRender(this.name, component, (ret) => {
            if (!isValidElement(ret)) return ret;
            const el = ret as { props?: { children?: unknown } };
            const children = Array.isArray(el.props?.children)
                ? el.props!.children
                : [el.props?.children];
            return cloneElement(
                ret,
                {},
                ...children.filter(Boolean),
                createElement(
                    "div",
                    {
                        style: {
                            padding: "8px 12px",
                            fontSize: 12,
                            color: "var(--text-muted, #949ba4)",
                        },
                    },
                    `✎ ${note}`,
                ),
            );
        });
        if (!ok) log.warn("could not patch UserProfilePopout.render");
    },
};

// ---------------------------------------------------------------------------
// 2. CompactMessages — message appearance customization via custom CSS.
// ---------------------------------------------------------------------------

const CompactMessagesCSS = `
    /* CompactMessages: tighter message rows */
    li[id^="chat-messages-"] > div {
        padding-top: 2px !important;
        padding-bottom: 2px !important;
    }
`;

const CompactMessages: Plugin = {
    name: "CompactMessages",
    description: "Example: compact message list spacing via injected CSS.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: {},

    async start() {
        const prev = await Api.Settings.get<string>(
            "plugins.settings.CompactMessages.css",
            "",
        );
        const combined = prev ? `${prev}\n${CompactMessagesCSS}` : CompactMessagesCSS;
        await Api.Themes.setCustomCss(combined);
        await Api.Settings.set(
            "plugins.settings.CompactMessages.css",
            combined,
        );
    },

    async stop() {
        const cur =
            (await Api.Settings.get<string>(
                "plugins.settings.CompactMessages.css",
                "",
            )) ?? "";
        const stripped = cur.replace(CompactMessagesCSS, "").trim();
        await Api.Themes.setCustomCss(stripped);
        await Api.Settings.set(
            "plugins.settings.CompactMessages.css",
            stripped,
        );
    },
};

// ---------------------------------------------------------------------------
// 3. ThemeCycler — Ctrl+Shift+T cycles installed themes.
// ---------------------------------------------------------------------------

let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const ThemeCycler: Plugin = {
    name: "ThemeCycler",
    description: "Example: Ctrl+Shift+T cycles through installed themes.",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: {},

    async start() {
        const handler = async (e: KeyboardEvent) => {
            if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t")) return;
            e.preventDefault();
            const themes = await Api.Themes.list();
            const names = themes.map((t) => t.name);
            if (names.length === 0) return;
            const current = Api.Themes.active;
            const idx = current ? names.indexOf(current) : -1;
            const next = names[(idx + 1) % names.length]!;
            try {
                await Api.Themes.activate(next === current ? null : next);
            } catch (err) {
                log.warn("theme activation failed", err);
            }
        };
        window.addEventListener("keydown", handler);
        keyHandler = handler;
    },

    stop() {
        if (keyHandler) window.removeEventListener("keydown", keyHandler);
        keyHandler = null;
    },
};

/** Register all built-in example plugins. */
export function registerExamples(): void {
    for (const plugin of [StatusNote, CompactMessages, ThemeCycler]) {
        try {
            Api.Plugins.register(plugin);
        } catch (e) {
            log.error(`failed to register ${plugin.name}`, e);
        }
    }
}
