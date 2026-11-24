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
    /** Optional user-facing settings schema (key → default). */
    settings?: Record<string, unknown>;
    /** Called when the plugin is enabled. Throwing is caught and reported. */
    start?(): void | Promise<void>;
    /** Called when the plugin is disabled. Must undo everything `start` did. */
    stop?(): void | Promise<void>;
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
    /** Unique theme id (directory name). */
    name: string;
    /** Human-readable label. */
    label?: string;
    /** Author(s). */
    authors?: string[]
    /** Raw CSS applied while the theme is active. */
    css: string;
}

/** Result of a webpack module search. */
export type ModulePredicate = (exports: unknown) => boolean;
