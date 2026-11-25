/**
 * Theme engine (renderer side).
 *
 * Themes are CSS payloads fetched from the Monocord main process over IPC
 * (`theme:get`/`themes:list`). Applying a theme swaps the contents of a
 * dedicated <style> element — no Discord restart needed.
 *
 * The active theme id and user CSS persist through the Settings store.
 */

import { Events } from "./events";
import { Logger } from "./logger";
import { Settings } from "./settings";
import type { Theme } from "./types";

const log = Logger.get("themes");

const STYLE_ID = "monocord-theme";
const CUSTOM_STYLE_ID = "monocord-custom-css";
const SETTINGS_THEME = "theme.active";
const SETTINGS_CUSTOM_CSS = "theme.customCss";

/** Bridge to the main process, injected by the preload script. */
export interface ThemeBridge {
    listThemes(): Promise<Theme[]>;
    getThemeCss(name: string): Promise<string | null>;
}

let bridge: ThemeBridge | null = null;

/** Called once by the renderer bootstrap with the IPC-backed bridge. */
export function setThemeBridge(b: ThemeBridge | null): void {
    bridge = b;
}

function ensureStyle(id: string): HTMLStyleElement {
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
        el = document.createElement("style");
        el.id = id;
        el.setAttribute("data-monocord", "true");
        (document.head ?? document.documentElement).appendChild(el);
    }
    return el;
}

function setCss(id: string, css: string): void {
    ensureStyle(id).textContent = css;
}

export const Themes = {
    /** Currently applied theme name, if any. */
    active: null as string | null,

    /** Apply raw CSS as the active theme (no persistence). */
    applyCss(css: string, name = "custom"): void {
        this.active = name;
        setCss(STYLE_ID, css);
        Events.emit("theme.changed", { name });
    },

    /** Clear the active theme. */
    clear(): void {
        this.active = null;
        setCss(STYLE_ID, "");
        Events.emit("theme.changed", { name: null });
    },

    /** List themes known to the main process. */
    async list(): Promise<Theme[]> {
        if (!bridge) return [];
        try {
            return await bridge.listThemes();
        } catch (e) {
            log.error("theme list failed", e);
            return [];
        }
    },

    /** Activate a theme by name; persists the choice. */
    async activate(name: string | null): Promise<void> {
        if (name === null) {
            this.clear();
            await Settings.set(SETTINGS_THEME, null);
            return;
        }
        if (!bridge) throw new Error("theme bridge unavailable");
        const css = await bridge.getThemeCss(name);
        if (css === null) throw new Error(`theme not found: ${name}`);
        this.applyCss(css, name);
        await Settings.set(SETTINGS_THEME, name);
    },

    /** Re-apply the persisted theme + custom CSS (called on framework start). */
    async restore(): Promise<void> {
        await Settings.ready();
        const custom = await Settings.get<string>(SETTINGS_CUSTOM_CSS, "");
        if (custom) setCss(CUSTOM_STYLE_ID, custom);
        const active = await Settings.get<string | null>(SETTINGS_THEME, null);
        if (active) {
            try {
                await this.activate(active);
            } catch (e) {
                log.warn(`could not restore theme "${active}"`, e);
            }
        } else if (!(await Settings.get<boolean>("theme.defaultApplied", false))) {
            // First run with no chosen theme: apply the bundled default once.
            await Settings.set("theme.defaultApplied", true);
            try {
                await this.activate("system24");
            } catch (e) {
                log.warn("could not apply default theme", e);
            }
        }
    },

    /** Set user custom CSS (appended after the active theme). */
    async setCustomCss(css: string): Promise<void> {
        setCss(CUSTOM_STYLE_ID, css);
        await Settings.set(SETTINGS_CUSTOM_CSS, css);
    },

    /**
     * Inject CSS owned by a plugin under a unique id. Independent of the
     * active theme and custom CSS — several plugins can coexist.
     */
    injectCss(id: string, css: string): void {
        setCss(`monocord-plugin-${id}`, css);
    },

    /** Remove CSS previously injected via `injectCss`. */
    removeCss(id: string): void {
        document.getElementById(`monocord-plugin-${id}`)?.remove();
    },
};
