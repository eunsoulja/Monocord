/**
 * Reversible function patching.
 *
 * `before`/`after`/`instead` wrap a method on any object. Patches on the
 * same (object, key) form an ordered stack; unpatching any plugin rebuilds
 * the chain without it, so middle-of-stack removal works correctly.
 *
 * Callback contracts:
 * - `before`: `cb(...args)` — return an array to replace the arguments,
 *   return nothing to keep them.
 * - `after`: `cb(returnValue, ...args)` — return a value to replace the
 *   result, return `undefined` to keep it.
 * - `instead`: `cb(...args)` — return `undefined` to call the original,
 *   return any other value to skip the original and use it as the result.
 */

import { Logger } from "../logger";
import { FrameworkError } from "../errors";

type AnyFunction = (...args: never[]) => unknown;
type PatchMode = "before" | "after" | "instead";

interface StackEntry {
    plugin: string;
    mode: PatchMode;
    callback: (...args: unknown[]) => unknown;
}

interface KeyStack {
    object: object;
    key: string | symbol;
    /** The unpatched function — bottom of the chain. */
    original: AnyFunction;
    /** Applied patches in order (first applied = innermost). */
    entries: StackEntry[];
}

const stacks = new WeakMap<object, Map<string | symbol, KeyStack>>();
const log = Logger.get("patcher");

function stackFor(object: object, key: string | symbol, fn: AnyFunction): KeyStack {
    let byKey = stacks.get(object);
    if (!byKey) {
        byKey = new Map();
        stacks.set(object, byKey);
    }
    let stack = byKey.get(key);
    if (!stack) {
        stack = { object, key, original: fn, entries: [] };
        byKey.set(key, stack);
    }
    return stack;
}

function wrap(inner: AnyFunction, entry: StackEntry): AnyFunction {
    const { mode, callback } = entry;
    if (mode === "before") {
        return function (this: unknown, ...args: unknown[]) {
            const replacement = callback.apply(this, args);
            const finalArgs = Array.isArray(replacement) ? replacement : args;
            return inner.apply(this, finalArgs as never[]);
        } as AnyFunction;
    }
    if (mode === "after") {
        return function (this: unknown, ...args: unknown[]) {
            const result = inner.apply(this, args as never[]);
            const replaced = callback.call(this, result, ...args);
            return replaced === undefined ? result : replaced;
        } as AnyFunction;
    }
    return function (this: unknown, ...args: unknown[]) {
        const result = callback.apply(this, args);
        return result === undefined ? inner.apply(this, args as never[]) : result;
    } as AnyFunction;
}

function rebuild(stack: KeyStack): void {
    if (stack.entries.length === 0) {
        (stack.object as Record<string | symbol, unknown>)[stack.key] = stack.original;
        return;
    }
    let fn = stack.original;
    for (const entry of stack.entries) fn = wrap(fn, entry);
    (stack.object as Record<string | symbol, unknown>)[stack.key] = fn;
}

function getFn(object: object, key: string | symbol): AnyFunction {
    const fn = (object as Record<string | symbol, unknown>)[key];
    if (typeof fn !== "function") {
        throw new FrameworkError(
            `cannot patch non-function ${String(key)}`,
            "PATCH_TARGET_NOT_FUNCTION",
        );
    }
    return fn as AnyFunction;
}

function apply(
    plugin: string,
    object: object,
    key: string | symbol,
    mode: PatchMode,
    callback: (...args: unknown[]) => unknown,
): void {
    const current = getFn(object, key);
    const stack = stackFor(object, key, current);
    // If this (object,key) already has a stack, `current` is the top wrapper —
    // stack.original already holds the true original.
    stack.entries.push({ plugin, mode, callback });
    let set = pluginStacks.get(plugin);
    if (!set) {
        set = new Set();
        pluginStacks.set(plugin, set);
    }
    set.add(stack);
    rebuild(stack);
    log.debug(`${mode} patch applied`, { plugin, key: String(key) });
}

function removePluginFrom(stack: KeyStack, plugin: string): number {
    const before = stack.entries.length;
    stack.entries = stack.entries.filter((e) => e.plugin !== plugin);
    return before - stack.entries.length;
}

/** Drop emptied stacks from plugin bookkeeping. */
function gcStack(stack: KeyStack): void {
    if (stack.entries.length > 0) return;
    for (const set of pluginStacks.values()) set.delete(stack);
}

/** Remove every patch `plugin` placed on `object.key`. */
function unpatch(plugin: string, object: object, key: string | symbol): boolean {
    const byKey = stacks.get(object);
    const stack = byKey?.get(key);
    if (!stack) return false;
    const removed = removePluginFrom(stack, plugin);
    if (removed === 0) return false;
    rebuild(stack);
    gcStack(stack);
    if (stack.entries.length === 0) byKey!.delete(key);
    return true;
}

export const Patcher = {
    /** Run `callback` before the original method. */
    before(
        plugin: string,
        object: object,
        key: string | symbol,
        callback: (...args: unknown[]) => unknown,
    ): void {
        apply(plugin, object, key, "before", callback);
    },

    /** Run `callback` after the original method. */
    after(
        plugin: string,
        object: object,
        key: string | symbol,
        callback: (...args: unknown[]) => unknown,
    ): void {
        apply(plugin, object, key, "after", callback);
    },

    /** Replace the method; `undefined` return falls through to original. */
    instead(
        plugin: string,
        object: object,
        key: string | symbol,
        callback: (...args: unknown[]) => unknown,
    ): void {
        apply(plugin, object, key, "instead", callback);
    },

    /** Remove all patches a plugin placed on `object.key`. */
    unpatch,

    /** Remove every patch belonging to a plugin, across all objects. */
    unpatchAll(plugin: string): number {
        let removed = 0;
        // WeakMap isn't iterable — track stacks per plugin instead.
        for (const stack of pluginStacks.get(plugin) ?? []) {
            removed += removePluginFrom(stack, plugin);
            rebuild(stack);
        }
        pluginStacks.delete(plugin);
        return removed;
    },

    /** Patch records currently registered for a plugin (debugging). */
    patchesOf(plugin: string): readonly StackEntry[] {
        const out: StackEntry[] = [];
        for (const stack of pluginStacks.get(plugin) ?? []) {
            out.push(...stack.entries.filter((e) => e.plugin === plugin));
        }
        return out;
    },
};

/** plugin → set of KeyStacks it has entries in (for unpatchAll). */
const pluginStacks = new Map<string, Set<KeyStack>>();
