/**
 * MonocordSettings — built-in infrastructure plugin that injects the
 * Monocord section into Discord's native settings UI.
 *
 * Discord's settings sidebar is driven by a tree of layout builders
 * (SECTION / SIDEBAR_ITEM / PANEL / CATEGORY / CUSTOM). The root builder is
 * not reachable through webpack module exports: Discord's rspack runtime
 * exposes empty namespace objects for deferred settings modules, and the
 * settings component binds the directory hook at module-evaluation time.
 *
 * The stable hook is the recursive builder walker inside the settings chunk.
 * Its source contains `.buildLayout().map`; Webpack.patchFactories rewrites
 * that call to a global hook before the chunk is registered. The hook sees
 * every builder and only modifies the one with `key === "$Root"`.
 *
 * Discovery is source-pattern based (never a module id) and degrades
 * gracefully: if the pattern changes, the patch simply logs that it did not
 * apply and Discord's settings UI is untouched.
 */

import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";
import { Webpack } from "../core/webpack";
import { ensureReact, h, logReactInfo } from "../ui/react";
import { OverviewPanel, PluginsPanel, ThemesPanel } from "../ui/settings";

const log = Logger.get("settings-plugin");

export const SETTINGS_PLUGIN_NAME = "MonocordSettings";

/** Global function referenced from the patched Discord factory source. */
const LAYOUT_HOOK = "__monocord_buildSettingsLayout";
const ROOT_KEY = "monocord_main";

/**
 * Discord's layout type enum. The enum module is a deferred namespace and is
 * not readable through exports, so use Discord's long-standing values.
 */
const LAYOUT_TYPES = {
    SECTION: 1,
    SIDEBAR_ITEM: 2,
    PANEL: 3,
    CATEGORY: 5,
    CUSTOM: 19,
} as const;

type LayoutNode = Record<string, unknown>;

interface LayoutBuilder {
    key?: unknown;
    buildLayout(): unknown;
}

type WindowWithHook = typeof window & {
    [LAYOUT_HOOK]?: (builder: LayoutBuilder) => unknown;
};

let active = false;
let loggedFirstCall = false;

// ---------------------------------------------------------------------------
// Icons & node construction
// ---------------------------------------------------------------------------

function iconPath(d: string): () => unknown {
    return () =>
        h(
            "svg",
            {
                width: 20,
                height: 20,
                viewBox: "0 0 24 24",
                fill: "currentColor",
                "aria-hidden": true,
            },
            h("path", { d }),
        );
}

const Icons = {
    overview: iconPath(
        "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
    ),
    plugins: iconPath(
        "M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm10 2h5v3h-5v-3zm-2-2h3v7h-3v-7z",
    ),
    themes: iconPath(
        "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.5 6.5-3 5.5h-3l3-5.5h3zm-9 0 3 5.5H7.5l-3-5.5h3z",
    ),
};

function buildEntry(options: {
    key: string;
    title: string;
    panelTitle?: string;
    Component: unknown;
    Icon: () => unknown;
}): LayoutNode {
    const { key, title, panelTitle = title, Component, Icon } = options;
    const panel: LayoutNode = {
        key: `${key}_panel`,
        type: LAYOUT_TYPES.PANEL,
        useTitle: () => panelTitle,
        buildLayout: () => [
            {
                key: `${key}_category`,
                type: LAYOUT_TYPES.CATEGORY,
                buildLayout: () => [
                    {
                        key: `${key}_custom`,
                        type: LAYOUT_TYPES.CUSTOM,
                        Component,
                        useSearchTerms: () => [title],
                    },
                ],
            },
        ],
    };
    return {
        key,
        type: LAYOUT_TYPES.SIDEBAR_ITEM,
        useTitle: () => title,
        icon: () => Icon(),
        buildLayout: () => [panel],
    };
}

const SECTION_KEY = "monocord_section";

/** Fresh nodes each render — Discord annotates them with `parent`. */
function buildSection(): LayoutNode {
    return {
        key: SECTION_KEY,
        type: LAYOUT_TYPES.SECTION,
        useTitle: () => "Monocord",
        buildLayout: () => [
            buildEntry({
                key: ROOT_KEY,
                title: "Monocord",
                panelTitle: "Monocord",
                Component: OverviewPanel,
                Icon: Icons.overview,
            }),
            buildEntry({
                key: "monocord_plugins",
                title: "Plugins",
                Component: PluginsPanel,
                Icon: Icons.plugins,
            }),
            buildEntry({
                key: "monocord_themes",
                title: "Themes",
                Component: ThemesPanel,
                Icon: Icons.themes,
            }),
        ],
    };
}

// ---------------------------------------------------------------------------
// Factory-source hook
// ---------------------------------------------------------------------------

/**
 * Called by the patched walker in place of `builder.buildLayout()`.
 * Must always return the layout array so the walker can recurse normally.
 */
function layoutHook(builder: LayoutBuilder): unknown {
    const layout = builder.buildLayout();
    if (!active) return layout;

    if (!loggedFirstCall) {
        loggedFirstCall = true;
        log.info("settings layout hook invoked", {
            key: String(builder.key ?? "<none>"),
        });
    }

    if (builder.key !== "$Root" || !Array.isArray(layout)) return layout;
    if (layout.some((node) => (node as LayoutNode | null)?.key === SECTION_KEY)) {
        return layout;
    }

    const section = buildSection();
    // Prefer above the Nitro/billing group, like Vencord's default. Fall
    // back to above the account section, then to the end.
    const billing = layout.findIndex(
        (node) => (node as LayoutNode | null)?.key === "billing_section",
    );
    const user = layout.findIndex(
        (node) => (node as LayoutNode | null)?.key === "user_section",
    );
    const insertAt = billing !== -1 ? billing : user;
    layout.splice(insertAt === -1 ? layout.length : insertAt, 0, section);

    log.info("settings layout injected", { insertAt });
    return layout;
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

export const SettingsUIPlugin: Plugin = {
    name: SETTINGS_PLUGIN_NAME,
    description: "Injects the Monocord section into Discord settings.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        if (active) return;
        active = true;
        (window as WindowWithHook)[LAYOUT_HOOK] = layoutHook;

        try {
            // Discord's settings walker: `builder.buildLayout().map(walk)`.
            // Rewrite the call, not the module id — Discord is free to move
            // the builder as long as the walker keeps this shape.
            Webpack.patchFactories({
                plugin: SETTINGS_PLUGIN_NAME,
                find: ".buildLayout().map",
                replacement: {
                    match: /([A-Za-z_$][\w$]*)\.buildLayout\(\)(?=\.map)/g,
                    replace: `(0,window.${LAYOUT_HOOK})($1)`,
                },
            });
            log.info("settings layout factory patch installed");
        } catch (e) {
            log.error("failed to install settings layout factory patch", e);
        }

        void ensureReact()
            .then(() => logReactInfo())
            .catch((e) => log.error("React not available for settings UI", e));
    },

    stop() {
        // The compiled factories still call the hook; leave it in place and
        // make it a passthrough so disabling the plugin is non-destructive.
        active = false;
    },
};
