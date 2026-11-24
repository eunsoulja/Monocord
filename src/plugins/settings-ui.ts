/**
 * MonocordSettings — built-in infrastructure plugin that injects the
 * Monocord section into Discord's native settings UI.
 *
 * Discord's settings sidebar is driven by a layout tree of nodes
 * (SECTION / SIDEBAR_ITEM / PANEL / CATEGORY / CUSTOM). The root builder
 * object exposes `buildLayout()`; we find it by scanning webpack module
 * exports for an object with `key === "$Root"` (or a layout containing
 * Discord's known section keys) and append-patch `buildLayout` to splice
 * our section in. Discovery retries because Discord lazy-loads the
 * settings modules — they may not exist until the user opens settings.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import { Patcher } from "../core/patcher";
import type { Plugin } from "../core/types";
import { Webpack } from "../core/webpack";
import { ensureReact, h, logReactInfo } from "../ui/react";
import { OverviewPanel, PluginsPanel, ThemesPanel } from "../ui/settings";

const log = Logger.get("settings-plugin");

export const SETTINGS_PLUGIN_NAME = "MonocordSettings";

// Vencord's observed defaults — used only if the enum module isn't found.
const FALLBACK_LAYOUT_TYPES: Record<string, number> = {
    SECTION: 1,
    SIDEBAR_ITEM: 2,
    PANEL: 3,
    CATEGORY: 5,
    CUSTOM: 19,
};

type LayoutNode = Record<string, unknown>;

let discoveryActive = false;

// ---------------------------------------------------------------------------
// Discord module discovery
// ---------------------------------------------------------------------------

function findLayoutTypes(): Record<string, number> {
    const candidates = Webpack.findAllByProps(
        "SECTION",
        "SIDEBAR_ITEM",
        "PANEL",
        "CUSTOM",
    );
    for (const mod of candidates) {
        const e = (mod as Record<string, unknown>).default ?? mod;
        if (e && typeof e === "object") {
            const rec = e as Record<string, unknown>;
            if (
                typeof rec.SECTION === "number" &&
                typeof rec.SIDEBAR_ITEM === "number" &&
                typeof rec.PANEL === "number" &&
                typeof rec.CUSTOM === "number"
            ) {
                log.info("layout types resolved from webpack", {
                    SECTION: rec.SECTION,
                    SIDEBAR_ITEM: rec.SIDEBAR_ITEM,
                    PANEL: rec.PANEL,
                    CUSTOM: rec.CUSTOM,
                });
                return rec as Record<string, number>;
            }
        }
    }
    log.warn("layout type enum not found — using fallback values");
    return FALLBACK_LAYOUT_TYPES;
}

interface Builder {
    key?: unknown;
    buildLayout: () => unknown;
}

function isBuilder(v: unknown): v is Builder {
    return (
        ((typeof v === "object" && v !== null) || typeof v === "function") &&
        typeof (v as Builder).buildLayout === "function"
    );
}

/** Does a buildLayout() result look like Discord's settings root? */
function looksLikeSettingsRoot(result: unknown): boolean {
    if (!Array.isArray(result)) return false;
    const keys = result
        .map((n) => (n as LayoutNode | null)?.key)
        .filter((k): k is string => typeof k === "string");
    return (
        keys.includes("user_section") ||
        keys.includes("billing_section") ||
        keys.includes("utility_section") ||
        keys.length >= 3
    );
}

/**
 * Scan module exports (itself, `.default`, and one level of properties)
 * for the settings layout builder. Returns the "$Root" builder when
 * identifiable, otherwise the first builder whose layout looks like the
 * settings root.
 */
function findSettingsBuilder(): { builder: Builder; moduleId: string | number } | null {
    let fallback: { builder: Builder; moduleId: string | number } | null = null;
    let scanned = 0;

    for (const [id, exports] of Webpack.iterModules()) {
        scanned++;
        try {
            const found = scanExports(exports);
            if (found?.key === "$Root") {
                log.info("found $Root settings builder", { moduleId: String(id) });
                return { builder: found, moduleId: id };
            }
            if (found && !fallback) {
                fallback = { builder: found, moduleId: id };
                log.info("found settings-like builder (fallback)", {
                    moduleId: String(id),
                    key: String(found.key),
                });
            }
        } catch {
            /* hostile module — skip */
        }
    }
    log.info(`settings builder scan complete: ${scanned} modules`);
    return fallback;
}

/** Scan one module's exports for builder candidates. */
function scanExports(exports: unknown): Builder | null {
    let fallback: Builder | null = null;
    const seen = new Set<object>();
    const queue: unknown[] = [exports];
    const isObjLike = (v: unknown): v is Record<string, unknown> =>
        (typeof v === "object" && v !== null) || typeof v === "function";

    if (isObjLike(exports) && "default" in exports) {
        queue.push(exports.default);
    }
    // One level of export properties.
    if (isObjLike(exports)) {
        for (const v of Object.values(exports)) {
            if (isObjLike(v)) queue.push(v);
        }
    }

    for (const candidate of queue) {
        if (!isBuilder(candidate) || seen.has(candidate)) continue;
        seen.add(candidate);
        if (candidate.key === "$Root") return candidate;
        if (!fallback) {
            try {
                if (looksLikeSettingsRoot(candidate.buildLayout())) {
                    fallback = candidate;
                }
            } catch {
                /* not callable in this state */
            }
        }
    }
    return fallback;
}

// ---------------------------------------------------------------------------
// Layout injection
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

function buildEntry(opts: {
    key: string;
    title: string;
    panelTitle?: string;
    Component: () => unknown;
    Icon: () => unknown;
    types: Record<string, number>;
}): LayoutNode {
    const { key, title, panelTitle = title, Component, Icon, types } = opts;
    const panel: LayoutNode = {
        key: `${key}_panel`,
        type: types.PANEL,
        useTitle: () => panelTitle,
        buildLayout: () => [
            {
                type: types.CATEGORY,
                key: `${key}_category`,
                buildLayout: () => [
                    {
                        type: types.CUSTOM,
                        key: `${key}_custom`,
                        Component,
                        useSearchTerms: () => [title],
                    },
                ],
            },
        ],
    };
    return {
        key,
        type: types.SIDEBAR_ITEM,
        useTitle: () => title,
        icon: () => Icon(),
        buildLayout: () => [panel],
    };
}

/** Build the Monocord section node (fresh each call — nodes may be mutated). */
function buildSection(types: Record<string, number>): LayoutNode {
    const entries = [
        buildEntry({
            key: "monocord_main",
            title: "Monocord",
            panelTitle: "Monocord",
            Component: OverviewPanel,
            Icon: Icons.overview,
            types,
        }),
        buildEntry({
            key: "monocord_plugins",
            title: "Plugins",
            Component: PluginsPanel,
            Icon: Icons.plugins,
            types,
        }),
        buildEntry({
            key: "monocord_themes",
            title: "Themes",
            Component: ThemesPanel,
            Icon: Icons.themes,
            types,
        }),
    ];
    return {
        key: "monocord_section",
        type: types.SECTION,
        useTitle: () => "Monocord",
        buildLayout: () => entries,
    };
}

/** Splice our section into Discord's settings layout result. */
function injectIntoLayout(result: unknown, types: Record<string, number>): unknown {
    if (!Array.isArray(result)) return result;
    if (result.some((n) => (n as LayoutNode | null)?.key === "monocord_section")) {
        return result;
    }
    const section = buildSection(types);
    // Prefer above-Nitro placement like Vencord's default: insert before
    // billing_section; fall back to before user_section, else append.
    const idx =
        result.findIndex((n) => (n as LayoutNode | null)?.key === "billing_section") !== -1
            ? result.findIndex((n) => (n as LayoutNode | null)?.key === "billing_section")
            : result.findIndex((n) => (n as LayoutNode | null)?.key === "user_section");
    result.splice(idx === -1 ? result.length : idx, 0, section);
    return result;
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

async function discoverAndInstall(): Promise<void> {
    while (discoveryActive) {
        try {
            await ensureReact();
            const found = findSettingsBuilder();
            if (found) {
                const types = findLayoutTypes();
                logReactInfo();
                try {
                    Patcher.after(
                        SETTINGS_PLUGIN_NAME,
                        found.builder,
                        "buildLayout",
                        (result: unknown) => injectIntoLayout(result, types),
                    );
                    log.info("settings layout patch installed", {
                        moduleId: String(found.moduleId),
                    });
                    return;
                } catch (e) {
                    log.error("failed to patch buildLayout", e);
                    return;
                }
            }
        } catch (e) {
            log.debug("discovery pass failed", e);
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
}

export const SettingsUIPlugin: Plugin = {
    name: SETTINGS_PLUGIN_NAME,
    description: "Injects the Monocord section into Discord settings.",
    authors: ["Monocord"],
    version: "0.1.0",

    start() {
        if (discoveryActive) return;
        discoveryActive = true;
        void discoverAndInstall();
    },

    stop() {
        discoveryActive = false;
    },
};
