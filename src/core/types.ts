/** Shared types for the Monocord plugin API. */

/** A Monocord plugin. `start`/`stop` may be sync or async. */
export interface Plugin {
    /** Unique plugin name (manifest `name`). */
    name: string;
    /** Short description shown in the plugin manager. */
    description?: string;
    /** Author handles. */
    authors?: string[];
    /** Semver-ish version string. */
    version?: string;
    /** Names of plugins that must be enabled before this one starts. */
    required?: string[];
    /**
     * When true, the plugin is not started during the eager boot pass —
     * it starts after `framework.ready`, in idle-time chunks. Use for
     * plugins whose work (DOM observers, webpack scans) can wait a moment
     * so Discord's own startup isn't competing with them.
     */
    defer?: boolean;
    /** Optional user-facing settings schema (key → default). */
    settings?: Record<string, unknown>;
    /**
     * Optional typed settings schema — when present, the plugins panel
     * renders real form controls for these keys instead of the raw JSON
     * editor. Keys should match entries in `settings`.
     */
    settingsSchema?: Record<string, SettingField>;
    /**
     * Optional fully custom settings renderer. When present it replaces the
     * generic `settingsSchema` form — use for plugins needing paired
     * fields, validation, or live previews (e.g. CustomRPC).
     */
    settingsView?: (ctx: PluginSettingsViewContext) => unknown;
    /** Called when the plugin is enabled. Throwing is caught and reported. */
    start?(): void | Promise<void>;
    /** Called when the plugin is disabled. Must undo everything `start` did. */
    stop?(): void | Promise<void>;
}

/** Context passed to `Plugin.settingsView` custom settings renderers. */
export interface PluginSettingsViewContext {
    /** createElement bound to Discord's React (same as ui/react `h`). */
    h: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
    /** Current persisted setting values for this plugin (key → value). */
    values: Record<string, unknown>;
    /** Persist one setting key (fires settings.changed → live update). */
    set: (key: string, value: unknown) => void;
    /** Whether the plugin is currently enabled. */
    enabled: boolean;
}

/** A single typed setting rendered by the plugins panel. */
export interface SettingField {
    /** Control type. */
    type: "string" | "boolean" | "number" | "select" | "textarea";
    /** Label shown next to the control. */
    label?: string;
    /** Help text shown under the control. */
    description?: string;
    /** Placeholder for string/textarea inputs. */
    placeholder?: string;
    /** Options for `select` fields. */
    options?: { label: string; value: string }[];
}

/** On-disk manifest for a third-party plugin (`monocord-plugin.json`). */
export interface PluginManifest {
    name: string;
    version: string;
    description?: string;
    authors?: string[];
    /** Entry file inside the plugin directory (e.g. `index.js`). */
    main: string;
    /** Plugin names that must be enabled first. */
    dependencies?: string[];
}

/** A registered theme. */
export interface Theme {
    /** Unique theme id (directory name or file name). */
    name: string;
    /** Human-readable label. */
    label?: string;
    /** Author(s). */
    authors?: string[]
    /** Description parsed from the theme's `/** ... *\/` header. */
    description?: string;
    /** Version parsed from the theme header. */
    version?: string;
    /** Theme website parsed from the theme header. */
    website?: string;
    /** Discord invite code parsed from the theme header. */
    invite?: string;
    /** Raw CSS applied while the theme is enabled. */
    css: string;
}

/** Result of a webpack module search. */
export type ModulePredicate = (exports: unknown) => boolean;
