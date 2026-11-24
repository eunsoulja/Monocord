/**
 * Webpack module discovery.
 *
 * Discord's renderer is a webpack bundle exposed on `window` as one or more
 * `webpackChunk*` arrays. Pushing a synthetic chunk whose runtime callback
 * receives `__webpack_require__` is the standard way to obtain the require
 * function; from there `req.m` lists module factories and `req.c` the cache
 * of already-executed modules.
 *
 * Module ids and export shapes are Discord-version-sensitive. All finders
 * return `undefined`/empty when nothing matches — callers must handle that
 * (the plugin manager logs and isolates the failure).
 */

import { Logger } from "../logger";
import { ModuleNotFoundError } from "../errors";
import type { ModulePredicate } from "../types";

const log = Logger.get("webpack");

/** Minimal structural type of `__webpack_require__`. */
export interface WebpackRequire {
    /** Module factories: id → (module, exports, require) => void */
    m: Record<string, unknown>;
    /** Executed-module cache: id → { exports } */
    c: Record<string, { exports?: unknown } | undefined>;
    (id: string | number): unknown;
}

declare global {
    interface Window {
        webpackChunkdiscord_app?: unknown[];
        [key: `webpackChunk${string}`]: unknown[] | undefined;
    }
}

/** Find all `webpackChunk*` arrays currently on `window`. */
function chunkArrays(): unknown[][] {
    const out: unknown[][] = [];
    for (const key of Object.keys(window)) {
        if (!key.startsWith("webpackChunk")) continue;
        const v = (window as unknown as Record<string, unknown>)[key];
        if (Array.isArray(v)) out.push(v as unknown[]);
    }
    return out;
}

class WebpackFinder {
    private req: WebpackRequire | null = null;
    private probeToken = 0;
    /** Memoized exports lookups: moduleId → exports | undefined */
    private exportCache = new Map<string, unknown>();
    private warnedNoChunk = false;

    /** Whether the webpack require function has been captured. */
    get ready(): boolean {
        return this.req !== null;
    }

    /**
     * Locate `__webpack_require__` by pushing a probe chunk. Idempotent.
     * Returns false when no chunk array exists yet (Discord still loading).
     */
    ensure(): boolean {
        if (this.req) return true;
        const chunks = chunkArrays();
        if (chunks.length === 0) {
            if (!this.warnedNoChunk) {
                this.warnedNoChunk = true;
                log.debug("no webpackChunk* arrays on window yet");
            }
            return false;
        }
        for (const chunksArr of chunks) {
            const token = `__monocord_probe_${++this.probeToken}`;
            let captured: WebpackRequire | null = null;
            try {
                // Chunk tuple: [chunkIds, moreModules, runtime(require)]
                (chunksArr as { push(item: unknown[]): unknown }).push?.([
                    [token],
                    {},
                    (requireFn: WebpackRequire) => {
                        captured = requireFn;
                    },
                ]);
            } catch (e) {
                log.debug("probe push threw", e);
                continue;
            }
            if (captured) {
                this.req = captured;
                log.info("captured webpack require", { chunks: chunks.length });
                return true;
            }
        }
        return false;
    }

    /** Poll until the require function is available or `timeoutMs` elapses. */
    async waitReady(timeoutMs = 30_000, intervalMs = 50): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.ensure()) return true;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return this.ensure();
    }

    private require_(): WebpackRequire {
        if (!this.req && !this.ensure()) {
            throw new ModuleNotFoundError("webpack runtime (no webpackChunk* arrays)");
        }
        return this.req!;
    }

    /** All module ids currently known to webpack. */
    moduleIds(): (string | number)[] {
        const req = this.require_();
        return Object.keys(req.m ?? {});
    }

    /**
     * Get a module's exports. Uses the executed-module cache when present;
     * otherwise requires the module (executes its factory — side effects are
     * possible, same trade-off every client mod makes).
     */
    getExports(id: string | number): unknown {
        if (this.exportCache.has(String(id))) return this.exportCache.get(String(id));
        const req = this.require_();
        let exports: unknown;
        const cached = req.c?.[id as never];
        if (cached && "exports" in cached) {
            exports = cached.exports;
        } else {
            try {
                exports = req(id);
            } catch (e) {
                log.debug(`module ${String(id)} threw on require`, e);
                exports = undefined;
            }
        }
        this.exportCache.set(String(id), exports);
        return exports;
    }

    /** Iterate (id, exports) for every loadable module. */
    *iterModules(): Generator<[string | number, unknown]> {
        for (const id of this.moduleIds()) {
            const exports = this.getExports(id);
            if (exports !== undefined) yield [id, exports];
        }
    }

    /** First module whose exports satisfy `predicate`. */
    find(predicate: ModulePredicate): unknown | undefined {
        for (const [, exports] of this.iterModules()) {
            try {
                if (predicate(exports)) return exports;
            } catch {
                // Predicate threw on this shape — keep searching.
            }
        }
        return undefined;
    }

    /** All modules whose exports satisfy `predicate`. */
    findAll(predicate: ModulePredicate): unknown[] {
        const out: unknown[] = [];
        for (const [, exports] of this.iterModules()) {
            try {
                if (predicate(exports)) out.push(exports);
            } catch {
                // ignore
            }
        }
        return out;
    }

    /**
     * Find a module whose exports (or `exports.default`) contain every
     * listed property.
     */
    findByProps(...props: string[]): unknown | undefined {
        return this.find((exports) => hasProps(exports, props));
    }

    /** Find all modules matching `findByProps`. */
    findAllByProps(...props: string[]): unknown[] {
        return this.findAll((exports) => hasProps(exports, props));
    }

    /** Find a module by `displayName` on exports or `exports.default`. */
    findByDisplayName(name: string): unknown | undefined {
        return this.find(
            (exports) =>
                displayNameOf(exports) === name ||
                (isObject(exports) && displayNameOf(exports.default) === name),
        );
    }

    /** Find a Flux store by display name. */
    findStore(name: string): unknown | undefined {
        const mod = this.findByDisplayName(name);
        if (isObject(mod) && isObject(mod.default)) return mod.default;
        return mod;
    }

    /** Clear memoized exports (e.g. after a Discord reload). */
    invalidate(): void {
        this.exportCache.clear();
    }

    /** Drop the captured require entirely — next ensure() re-probes. */
    reset(): void {
        this.req = null;
        this.exportCache.clear();
        this.warnedNoChunk = false;
    }
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function hasProps(exports: unknown, props: string[]): boolean {
    const candidates: unknown[] = [exports];
    if (isObject(exports) && "default" in exports) candidates.push(exports.default);
    return candidates.some(
        (c) => isObject(c) && props.every((p) => p in c),
    );
}

function displayNameOf(v: unknown): string | undefined {
    if (!isObject(v)) return undefined;
    const dn = v.displayName;
    return typeof dn === "string" ? dn : undefined;
}

export const Webpack = new WebpackFinder();
