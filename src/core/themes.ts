/**
 * Theme engine (renderer side), modeled on Vencord's api/Themes.
 *
 * Multiple themes can be enabled at once — their CSS is concatenated in
 * enable order into a single <style> element (later themes win conflicts,
 * same as Vencord's stacked @imports). QuickCSS (user custom CSS) lives in
 * a separate style element with its own on/off toggle.
 *
 * Theme css is fetched from the Monocord main process over IPC
 * (`theme:get`/`themes:list`). Enabled themes, QuickCSS state and custom
 * CSS persist through the Settings store.
 */

import { Events } from "./events";
import { Logger } from "./logger";
import { Settings } from "./settings";
import type { Theme } from "./types";

const log = Logger.get("themes");

const STYLE_ID = "monocord-theme";
const CUSTOM_STYLE_ID = "monocord-custom-css";
const SETTINGS_ENABLED = "theme.enabled";
const SETTINGS_ACTIVE = "theme.active"; // legacy single-theme key
const SETTINGS_CUSTOM_CSS = "theme.customCss";
const SETTINGS_QUICK_CSS = "theme.quickCss";
const SETTINGS_DEFAULT_APPLIED = "theme.defaultApplied";
const DEFAULT_THEME = "system24";

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
    const el = ensureStyle(id);
    // Constructable stylesheets skip the <style> text parse and are cheaper
    // to swap, but replaceSync rejects @import — fall back for those.
    if (!/^\s*@import/m.test(css) && "adoptedStyleSheets" in document) {
        let sheet = adoptedSheets.get(id);
        if (!sheet) {
            sheet = new CSSStyleSheet();
            adoptedSheets.set(id, sheet);
            document.adoptedStyleSheets = [
                ...document.adoptedStyleSheets.filter((s) => s !== sheet),
                sheet,
            ];
        }
        try {
            sheet.replaceSync(css);
            el.textContent = "";
            return;
        } catch {
            // fall through to <style>
        }
    }
    detachAdopted(id);
    el.textContent = css;
}

function detachAdopted(id: string): void {
    const sheet = adoptedSheets.get(id);
    if (!sheet) return;
    adoptedSheets.delete(id);
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (s) => s !== sheet,
    );
}

const adoptedSheets = new Map<string, CSSStyleSheet>();

/** Extract @import rules so they can be hoisted to the top of the sheet. */
function splitImports(css: string): { imports: string[]; body: string } {
    const imports: string[] = [];
    const body = css
        .split("\n")
        .filter((line) => {
            const t = line.trim();
            if (/^@import\b/.test(t)) {
                imports.push(t);
                return false;
            }
            return true;
        })
        .join("\n");
    return { imports, body };
}

export const Themes = {
    /** Currently enabled theme names, in apply order. */
    enabled: [] as string[],
    /** QuickCSS (custom CSS) toggle — Vencord's `useQuickCss`. */
    quickCss: true,
    /** Custom CSS payload (cached for re-application). */
    customCss: "",
    /** Legacy compat: first enabled theme, if any. */
    get active(): string | null {
        return this.enabled[0] ?? null;
    },

    /** Apply raw CSS as the only enabled theme (no persistence). */
    applyCss(css: string, name = "custom"): void {
        this.enabled = [name];
        void this.reapply();
        Events.emit("theme.changed", { enabled: this.enabled });
    },

    /** Clear all enabled themes. */
    clear(): void {
        this.enabled = [];
        void this.reapply();
        Events.emit("theme.changed", { enabled: [] });
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

    /** Toggle a theme in the enabled set; persists the choice. */
    async toggle(name: string): Promise<void> {
        const idx = this.enabled.indexOf(name);
        if (idx >= 0) this.enabled.splice(idx, 1);
        else this.enabled.push(name);
        this.enabled = [...this.enabled];
        await this.reapply();
        await Settings.set(SETTINGS_ENABLED, this.enabled);
        Events.emit("theme.changed", { enabled: this.enabled });
    },

    /** Replace the enabled set with a single theme (legacy activate). */
    async activate(name: string | null): Promise<void> {
        this.enabled = name === null ? [] : [name];
        await this.reapply();
        await Settings.set(SETTINGS_ENABLED, this.enabled);
        Events.emit("theme.changed", { enabled: this.enabled });
    },

    /** Set QuickCSS on/off (Vencord's useQuickCss setting). */
    async setQuickCssEnabled(on: boolean): Promise<void> {
        this.quickCss = on;
        setCss(CUSTOM_STYLE_ID, on ? this.customCss : "");
        await Settings.set(SETTINGS_QUICK_CSS, on);
    },

    /** Set user custom CSS (QuickCSS — appended after enabled themes). */
    async setCustomCss(css: string): Promise<void> {
        this.customCss = css;
        setCss(CUSTOM_STYLE_ID, this.quickCss ? css : "");
        await Settings.set(SETTINGS_CUSTOM_CSS, css);
    },

    /** Fetch + concatenate all enabled theme CSS and apply it. */
    async reapply(): Promise<void> {
        if (!bridge) return;
        const imports: string[] = [];
        const bodies: string[] = [];
        const seenImports = new Set<string>();
        for (const name of this.enabled) {
            try {
                const css = await bridge.getThemeCss(name);
                if (css === null) {
                    log.warn(`theme not found: ${name}`);
                    continue;
                }
                const { imports: im, body } = splitImports(css);
                for (const i of im) {
                    if (!seenImports.has(i)) {
                        seenImports.add(i);
                        imports.push(i);
                    }
                }
                bodies.push(`/* --- theme: ${name} --- */\n${body}`);
            } catch (e) {
                log.error(`theme ${name} failed`, e);
            }
        }
        // @import must precede all other rules — hoist them to the top.
        setCss(STYLE_ID, `${imports.join("\n")}\n${bodies.join("\n")}`);
    },

    /** Re-apply persisted themes + QuickCSS (called on framework start). */
    async restore(): Promise<void> {
        await Settings.ready();
        this.customCss =
            (await Settings.get<string>(SETTINGS_CUSTOM_CSS, "")) ?? "";
        this.quickCss =
            (await Settings.get<boolean>(SETTINGS_QUICK_CSS, true)) ?? true;
        setCss(CUSTOM_STYLE_ID, this.quickCss ? this.customCss : "");

        let enabled =
            (await Settings.get<string[]>(SETTINGS_ENABLED, [])) ?? [];
        // Migrate the legacy single-theme key.
        if (enabled.length === 0) {
            const legacy = await Settings.get<string | null>(SETTINGS_ACTIVE, null);
            if (legacy) enabled = [legacy];
        }

        if (!(await Settings.get<boolean>(SETTINGS_DEFAULT_APPLIED, false))) {
            // First run on this version: make the bundled default theme the
            // active choice once. Previously-chosen themes stay in the list
            // and can be re-enabled; the flag prevents re-applying after the
            // user opts out.
            await Settings.set(SETTINGS_DEFAULT_APPLIED, true);
            enabled = [DEFAULT_THEME];
        }

        this.enabled = enabled;
        await Settings.set(SETTINGS_ENABLED, enabled);
        await this.reapply();
        Events.emit("theme.changed", { enabled });
    },

    /**
     * Inject CSS owned by a plugin under a unique id. Independent of the
     * enabled themes and QuickCSS — several plugins can coexist.
     */
    injectCss(id: string, css: string): void {
        setCss(`monocord-plugin-${id}`, css);
    },

    /** Remove CSS previously injected via `injectCss`. */
    removeCss(id: string): void {
        detachAdopted(`monocord-plugin-${id}`);
        document.getElementById(`monocord-plugin-${id}`)?.remove();
    },
};
