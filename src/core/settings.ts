/**
 * Persistent settings store.
 *
 * Renderer code cannot touch the filesystem (contextIsolation + no node in
 * the page), so persistence goes through a [`SettingsBackend`]. The default
 * renderer backend talks to the Monocord main process over IPC; tests and
 * tooling can inject a memory backend.
 *
 * Values are addressed by dot-paths (`plugins.enabled`, `theme.active`).
 * Every `set` emits `settings.changed` on the event bus.
 */

import { Events } from "./events";
import { Logger } from "./logger";

const log = Logger.get("settings");

/** Storage backend contract. */
export interface SettingsBackend {
    /** Load the full settings document. */
    load(): Promise<Record<string, unknown>>;
    /** Persist the full settings document atomically. */
    save(data: Record<string, unknown>): Promise<void>;
}

/** In-memory backend — default before IPC is available and for tests. */
export class MemoryBackend implements SettingsBackend {
    private data: Record<string, unknown> = {};

    async load(): Promise<Record<string, unknown>> {
        return structuredClone(this.data);
    }

    async save(data: Record<string, unknown>): Promise<void> {
        this.data = structuredClone(data);
    }
}

/** Minimal shape of the `window.monocord` bridge exposed by the preload. */
export interface MonocordBridge {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/** IPC-backed backend used inside Discord's renderer. */
export class IpcBackend implements SettingsBackend {
    constructor(private readonly bridge: MonocordBridge) {}

    async load(): Promise<Record<string, unknown>> {
        const data = await this.bridge.invoke("settings-get");
        return (data ?? {}) as Record<string, unknown>;
    }

    async save(data: Record<string, unknown>): Promise<void> {
        // The main process owns the document; push each top-level change is
        // complex, so send the whole doc through a dedicated channel.
        await this.bridge.invoke("settings-save", data);
    }
}

/** Dot-path get on a plain object. Returns `undefined` for missing paths. */
export function getPath(obj: unknown, path: string): unknown {
    let cur = obj;
    for (const part of path.split(".")) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

/** Immutable-ish dot-path set; creates intermediate objects. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        const next = cur[part];
        if (next === null || typeof next !== "object" || Array.isArray(next)) {
            cur[part] = {};
        }
        cur = cur[part] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
}

export class SettingsStore {
    private data: Record<string, unknown> = {};
    private loaded = false;
    private loadPromise: Promise<void> | null = null;

    constructor(private backend: SettingsBackend = new MemoryBackend()) {}

    /** Swap the storage backend (e.g. memory → IPC once the bridge exists). */
    useBackend(backend: SettingsBackend): void {
        this.backend = backend;
        this.loaded = false;
        this.loadPromise = null;
        this.data = {};
    }

    /** Lazily load persisted settings (once). */
    async ready(): Promise<void> {
        if (this.loaded) return;
        if (!this.loadPromise) {
            this.loadPromise = this.backend
                .load()
                .then((d) => {
                    this.data = d ?? {};
                    this.loaded = true;
                })
                .catch((e) => {
                    log.error("failed to load settings, using defaults", e);
                    this.data = {};
                    this.loaded = true;
                });
        }
        await this.loadPromise;
    }

    /** Read a dot-path value. */
    async get<T = unknown>(path: string, fallback?: T): Promise<T | undefined> {
        await this.ready();
        const v = getPath(this.data, path);
        return v === undefined ? fallback : (v as T);
    }

    /** Synchronous read — only valid after `ready()` resolved. */
    getSync<T = unknown>(path: string, fallback?: T): T | undefined {
        const v = getPath(this.data, path);
        return v === undefined ? fallback : (v as T);
    }

    /** Write a dot-path value and persist. */
    async set(path: string, value: unknown): Promise<void> {
        await this.ready();
        setPath(this.data, path, value);
        Events.emit("settings.changed", { path, value });
        try {
            await this.backend.save(this.data);
        } catch (e) {
            log.error(`failed to persist setting "${path}"`, e);
        }
    }

    /** Remove a dot-path value and persist. */
    async delete(path: string): Promise<void> {
        await this.ready();
        const parts = path.split(".");
        let cur: unknown = this.data;
        for (const part of parts.slice(0, -1)) {
            if (cur === null || typeof cur !== "object") return;
            cur = (cur as Record<string, unknown>)[part];
        }
        if (cur !== null && typeof cur === "object") {
            delete (cur as Record<string, unknown>)[parts[parts.length - 1]!];
        }
        Events.emit("settings.changed", { path, value: undefined });
        try {
            await this.backend.save(this.data);
        } catch (e) {
            log.error(`failed to persist deletion of "${path}"`, e);
        }
    }
}

/** Shared default store; backend is swapped in by the renderer bootstrap. */
export const Settings = new SettingsStore();
