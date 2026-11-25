/**
 * Monocord public API surface.
 *
 * Plugins import from `monocord/api` (mapped here for the bundled build).
 * Everything a plugin needs is reachable through `Api` — internals are
 * intentionally not exported.
 */

import { Events, eventScope } from "./events";
import { Logger } from "./logger";
import { Patcher } from "./patcher";
import { Plugins } from "./plugins/manager";
import { Settings } from "./settings";
import { Themes } from "./themes";
import { Webpack } from "./webpack";
import type { Plugin } from "./types";

/** Discord's React, resolved lazily through webpack. */
export function getReact(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        // Discord ships multiple modules with `createElement` (jsx runtimes,
        // compat shims). Require the full hook surface so we bind the real
        // React dispatcher — a wrong copy yields `useState` on a null
        // dispatcher and crashes the renderer.
        const candidates = [
            ["createElement", "useState", "useEffect", "createContext"],
            ["createElement", "useState", "useEffect"],
            ["createElement", "useEffect"],
            ["createElement", "Fragment", "useState"],
        ];
        const tryFind = () => {
            for (const props of candidates) {
                const react = Webpack.findByProps(...props);
                if (react) {
                    resolve(react as Record<string, unknown>);
                    return true;
                }
            }
            return false;
        };
        if (tryFind()) return;
        const timer = setInterval(() => {
            if (tryFind()) clearInterval(timer);
        }, 250);
        setTimeout(() => {
            clearInterval(timer);
            reject(new Error("could not locate React module"));
        }, 30_000);
    });
}

export const Api = {
    Webpack,
    Patcher,
    Events,
    eventScope,
    Plugins,
    Settings,
    Themes,
    Logger,
    React: { get: getReact },
    version: "0.1.0",
};

export type { Plugin };
export { FrameworkError, ModuleNotFoundError } from "./errors";
