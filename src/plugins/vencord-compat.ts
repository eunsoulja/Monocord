/**
 * Vencord compatibility shim for external plugins.
 *
 * Third-party plugins live in `%APPDATA%/Monocord/plugins/` and are
 * evaluated as CJS with a `require()` shim. Vencord plugins import from
 * specifiers like `@utils`, `@webpack/common`, `vencord/webpack` — this
 * module maps the common ones onto Monocord's equivalents so bundled
 * Vencord-style plugins can run unmodified.
 *
 * Returns `undefined` for specifiers we don't shim (the require shim
 * then throws its usual error). Coverage is intentionally partial:
 * plugins using Discord internals we haven't mapped will still fail —
 * check `renderer.log` for the missing specifier.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import { Webpack } from "../core/webpack";
import { getReact, useEffect, useState } from "../ui/react";
import * as domUtils from "./dom-utils";
import { findDispatcher, findStoreByName } from "./mods";

const log = Logger.get("vencord-compat");

const logger = {
    info: (...a: unknown[]) => log.info(a.map(String).join(" ")),
    warn: (...a: unknown[]) => log.warn(a.map(String).join(" ")),
    error: (...a: unknown[]) => log.error(a.map(String).join(" ")),
    debug: (...a: unknown[]) => log.debug(a.map(String).join(" ")),
};

/** Lazily-forwarding React module (getReact throws before Discord boots). */
const reactProxy = new Proxy(
    {},
    {
        get: (_t, prop) => getReact()[prop as string],
    },
);

/** Vencord-style Flux dispatcher that resolves lazily on each call. */
const dispatcherProxy = {
    dispatch: (action: Record<string, unknown>) =>
        findDispatcher()?.dispatch?.(action),
    subscribe: (cb: (action: Record<string, unknown>) => void) =>
        findDispatcher()?.subscribe(cb),
    get dispatcher() {
        return findDispatcher();
    },
};

const webpackCommon = {
    find: (predicate: (m: unknown) => boolean) => Webpack.find(predicate),
    findByProps: (...props: string[]) => Webpack.findByProps(...props),
    findByCode: (code: string | RegExp) => Webpack.findByCode(code),
    findAll: (predicate: (m: unknown) => boolean) =>
        Webpack.findAll(predicate as never),
    findStore: (name: string) => Webpack.findStore(name),
    waitFor: async (
        predicate: (m: unknown) => boolean,
        opts?: { interval?: number; timeout?: number },
    ) => {
        const deadline = Date.now() + (opts?.timeout ?? 30000);
        for (;;) {
            const m = Webpack.find(predicate);
            if (m !== undefined) return m;
            if (Date.now() > deadline) throw new Error("waitFor timed out");
            await new Promise((r) => setTimeout(r, opts?.interval ?? 100));
        }
    },
    filters: {
        byProps: (...props: string[]) => (m: unknown) => {
            if (typeof m !== "object" || m === null) return false;
            return props.every((p) => p in (m as Record<string, unknown>));
        },
        byCode: (code: string | RegExp) => (m: unknown) => {
            try {
                return String(m).includes(String(code));
            } catch {
                return false;
            }
        },
    },
};

const settingsShim = {
    /** Vencord's definePluginSettings is a no-op normalizer — pass through. */
    definePluginSettings: <T>(s: T) => s,
    migratePluginSettings: <T>(s: T) => s,
    isPluginSettingEnabled: () => true,
};

const constantsShim = {
    // Any Devs.<Name> access yields a plausible dev object.
    Devs: new Proxy(
        {},
        {
            get: (_t, prop) => ({ name: String(prop), id: "" }),
        },
    ),
};

const miscShim = {
    // Lazy store lookup matching Vencord's findStoreByName shape.
    findStoreByName: (name: string) => findStoreByName(name),
    getIntlMessage: (key: string) => key,
};

const reactAny = reactProxy as Record<
    string,
    (...a: never[]) => unknown
>;

const uiShim = {
    // Vencord's @utils/react exports React itself plus common hooks.
    // `React` is a lazy proxy — property access resolves Discord's React
    // at call time, so it survives plugins that grab it during boot.
    React: reactProxy,
    useState,
    useEffect,
    useMemo: (...a: never[]) => reactAny.useMemo!(...a),
    useRef: (...a: never[]) => reactAny.useRef!(...a),
    useCallback: (...a: never[]) => reactAny.useCallback!(...a),
};

const SHIMS: Record<string, unknown> = {
    vencord: Api,
    "vencord/api": Api,
    "@utils": miscShim,
    "@utils/constants": constantsShim,
    "@utils/settings": settingsShim,
    "@utils/logger": { Logger: logger },
    "@utils/react": uiShim,
    "@utils/dom": domUtils,
    "@utils/discord": { Dispatcher: dispatcherProxy },
    "@utils/misc": miscShim,
    "@webpack": webpackCommon,
    "@webpack/common": webpackCommon,
    "@webpack/webpack": webpackCommon,
    "vencord/webpack": webpackCommon,
    "vencord/utils": miscShim,
    "vencord/utils/constants": constantsShim,
    "vencord/utils/settings": settingsShim,
    "vencord/utils/logger": { Logger: logger },
    "vencord/utils/react": uiShim,
    "vencord/utils/discord": { Dispatcher: dispatcherProxy },
    "vencord/utils/dom": domUtils,
};

/**
 * Resolve a require() specifier for external plugins.
 * Returns the shimmed module, or `undefined` if unsupported.
 */
export function vencordCompatRequire(id: string): unknown {
    if (Object.prototype.hasOwnProperty.call(SHIMS, id)) {
        return SHIMS[id];
    }
    return undefined;
}
