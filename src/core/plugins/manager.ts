/**
 * Plugin manager: registration, enable/disable lifecycle, dependency
 * ordering, and error isolation.
 *
 * Third-party plugins are treated as untrusted *code* — the manager
 * isolates their failures (a throwing `start`/`stop` is caught, logged,
 * and reported via `plugin.error`) but does NOT sandbox them. JavaScript
 * in the renderer shares the page's privileges; plugin manifests may
 * declare permissions for user awareness, but that is not an enforcement
 * boundary.
 */

import { Events, eventScope, type EventScope } from "../events";
import { Logger } from "../logger";
import { Patcher } from "../patcher";
import { Settings } from "../settings";
import type { Plugin, PluginManifest } from "../types";
import { FrameworkError } from "../errors";

const log = Logger.get("plugins");

const SETTINGS_ENABLED = "plugins.enabled";

type PluginSource = Plugin | { default: Plugin } | (() => Plugin | { default: Plugin });

function normalize(source: PluginSource): Plugin {
    const resolved = typeof source === "function" ? source() : source;
    const plugin = "default" in resolved ? resolved.default : resolved;
    if (!plugin || typeof plugin.name !== "string" || plugin.name.length === 0) {
        throw new FrameworkError("plugin is missing a name", "INVALID_PLUGIN");
    }
    return plugin;
}

/** Validate a manifest's required fields. */
export function validateManifest(manifest: unknown): manifest is PluginManifest {
    if (typeof manifest !== "object" || manifest === null) return false;
    const m = manifest as Record<string, unknown>;
    return (
        typeof m.name === "string" &&
        m.name.length > 0 &&
        typeof m.version === "string" &&
        typeof m.main === "string" &&
        m.main.length > 0
    );
}

interface Entry {
    plugin: Plugin;
    enabled: boolean;
    scope: EventScope;
    starting: boolean;
}

export class PluginManager {
    private entries = new Map<string, Entry>();
    private started = false;

    /** All registered plugin names. */
    names(): string[] {
        return [...this.entries.keys()];
    }

    get(name: string): Plugin | undefined {
        return this.entries.get(name)?.plugin;
    }

    isEnabled(name: string): boolean {
        return this.entries.get(name)?.enabled ?? false;
    }

    isRunning(name: string): boolean {
        const e = this.entries.get(name);
        return e?.enabled === true && !e.starting;
    }

    /** Register a plugin (does not start it). */
    register(source: PluginSource): Plugin {
        const plugin = normalize(source);
        if (this.entries.has(plugin.name)) {
            throw new FrameworkError(`duplicate plugin name: ${plugin.name}`, "DUPLICATE_PLUGIN");
        }
        this.entries.set(plugin.name, {
            plugin,
            enabled: false,
            scope: eventScope(plugin.name),
            starting: false,
        });
        Events.emit("plugin.registered", { name: plugin.name });
        log.debug("registered", { name: plugin.name });
        return plugin;
    }

    /** Unregister a plugin; disables it first if running. */
    async unregister(name: string): Promise<void> {
        const entry = this.entries.get(name);
        if (!entry) return;
        if (entry.enabled) await this.disable(name);
        entry.scope.dispose();
        this.entries.delete(name);
        Events.emit("plugin.unregistered", { name });
    }

    /** Enable a plugin, starting dependencies first. */
    async enable(name: string): Promise<void> {
        const entry = this.entries.get(name);
        if (!entry) throw new FrameworkError(`unknown plugin: ${name}`, "UNKNOWN_PLUGIN");
        if (entry.enabled) return;
        for (const dep of entry.plugin.required ?? []) {
            if (!this.entries.has(dep)) {
                throw new FrameworkError(
                    `plugin ${name} requires missing plugin ${dep}`,
                    "MISSING_DEPENDENCY",
                );
            }
            if (!this.isEnabled(dep)) await this.enable(dep);
        }
        entry.enabled = true;
        await this.persistEnabled();
        await this.startEntry(entry);
        Events.emit("plugin.enabled", { name });
    }

    /** Disable a plugin and undo its effects. */
    async disable(name: string): Promise<void> {
        const entry = this.entries.get(name);
        if (!entry || !entry.enabled) return;
        entry.enabled = false;
        await this.persistEnabled();
        await this.stopEntry(entry);
        Events.emit("plugin.disabled", { name });
    }

    /** Stop then start a plugin. */
    async restart(name: string): Promise<void> {
        const entry = this.entries.get(name);
        if (!entry?.enabled) return;
        await this.stopEntry(entry);
        await this.startEntry(entry);
    }

    /** Enable every plugin marked enabled in settings, in dependency order. */
    async startEnabled(): Promise<void> {
        await Settings.ready();
        await this.startMatching((p) => p.defer !== true);
        this.started = true;
    }

    /**
     * Start enabled plugins flagged `defer`, yielding to the event loop
     * between each so Discord stays responsive while they install.
     */
    async startDeferred(): Promise<void> {
        await this.startMatching((p) => p.defer === true, true);
    }

    /** Last start/stop error per plugin name, for diagnostics UI. */
    private failures = new Map<string, unknown>();

    /** Plugin names whose most recent lifecycle call threw. */
    getFailures(): string[] {
        return [...this.failures.keys()];
    }

    private async startMatching(
        match: (plugin: Plugin) => boolean,
        yieldBetween = false,
    ): Promise<void> {
        const enabled = (await Settings.get<string[]>(SETTINGS_ENABLED, [])) ?? [];
        for (const name of this.topoOrder()) {
            const entry = this.entries.get(name);
            if (
                !entry ||
                entry.enabled !== false ||
                !enabled.includes(name) ||
                !match(entry.plugin)
            ) {
                continue;
            }
            try {
                await this.enable(name);
                this.failures.delete(name);
            } catch (e) {
                this.failures.set(name, e);
                log.error(`failed to enable ${name} at startup`, e);
                Events.emit("plugin.error", { name, phase: "start", error: e });
            }
            if (yieldBetween) {
                await new Promise((r) => setTimeout(r, 0));
            }
        }
    }

    /** Disable all running plugins (framework shutdown). */
    async stopAll(): Promise<void> {
        for (const name of [...this.entries.keys()].reverse()) {
            await this.disable(name).catch((e) =>
                log.error(`error disabling ${name}`, e),
            );
        }
        this.started = false;
    }

    /** Dependency-respecting start order over all registered plugins. */
    topoOrder(): string[] {
        const out: string[] = [];
        const state = new Map<string, "visiting" | "done">();
        const visit = (name: string) => {
            const s = state.get(name);
            if (s === "done") return;
            if (s === "visiting") return; // cycle — start anyway, log below
            state.set(name, "visiting");
            const entry = this.entries.get(name);
            if (!entry) return;
            for (const dep of entry.plugin.required ?? []) {
                if (this.entries.has(dep)) visit(dep);
                else log.warn(`plugin ${name} requires missing ${dep}`);
            }
            state.set(name, "done");
            out.push(name);
        };
        for (const name of this.entries.keys()) visit(name);
        return out;
    }

    private async startEntry(entry: Entry): Promise<void> {
        if (!entry.plugin.start || entry.starting) return;
        entry.starting = true;
        try {
            await entry.plugin.start();
            this.failures.delete(entry.plugin.name);
            Events.emit("plugin.started", { name: entry.plugin.name });
            log.info("started", { name: entry.plugin.name });
        } catch (e) {
            // A failed start leaves the plugin enabled-but-broken; mark
            // disabled so a retry is possible and the UI shows the truth.
            entry.enabled = false;
            this.failures.set(entry.plugin.name, e);
            await this.persistEnabled();
            log.error(`start() failed for ${entry.plugin.name}`, e);
            Events.emit("plugin.error", {
                name: entry.plugin.name,
                phase: "start",
                error: e,
            });
        } finally {
            entry.starting = false;
        }
    }

    private async stopEntry(entry: Entry): Promise<void> {
        try {
            if (entry.plugin.stop) await entry.plugin.stop();
        } catch (e) {
            log.error(`stop() failed for ${entry.plugin.name}`, e);
            Events.emit("plugin.error", {
                name: entry.plugin.name,
                phase: "stop",
                error: e,
            });
        } finally {
            // Patches must never survive a disabled plugin.
            const removed = Patcher.unpatchAll(entry.plugin.name);
            if (removed > 0) log.debug("removed leftover patches", { name: entry.plugin.name, removed });
            this.failures.delete(entry.plugin.name);
            entry.scope.dispose();
            Events.emit("plugin.stopped", { name: entry.plugin.name });
        }
    }

    private async persistEnabled(): Promise<void> {
        const enabled = [...this.entries.values()]
            .filter((e) => e.enabled)
            .map((e) => e.plugin.name);
        await Settings.set(SETTINGS_ENABLED, enabled);
    }
}

/** Shared manager instance used by the public API. */
export const Plugins = new PluginManager();
