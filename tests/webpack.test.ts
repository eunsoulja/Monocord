import { beforeEach, describe, expect, it, vi } from "vitest";
import { Webpack, type WebpackRequire } from "../src/core/webpack";

/**
 * Build a fake webpack runtime: a chunk array whose push() immediately
 * invokes the runtime callback of pushed chunks, mimicking webpack's
 * jsonp handler.
 */
function makeWebpackRuntime(modules: Record<string, unknown>) {
    const cache: Record<string, { exports: unknown }> = {};
    const requireFn = ((id: string | number) => {
        const key = String(id);
        if (cache[key]) return cache[key]!.exports;
        const factory = modules[key];
        if (typeof factory !== "function") return undefined;
        const moduleObj = { exports: {} as Record<string, unknown> };
        cache[key] = { exports: moduleObj.exports };
        (factory as (m: unknown, e: unknown, r: unknown) => void)(
            moduleObj,
            moduleObj.exports,
            requireFn,
        );
        cache[key]!.exports = moduleObj.exports;
        return moduleObj.exports;
    }) as WebpackRequire;
    requireFn.m = modules;
    requireFn.c = cache;
    return requireFn;
}

function installFakeWindow(requireFn: WebpackRequire): unknown[] {
    const chunks: unknown[] = [];
    const origPush = Array.prototype.push;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chunks as any).push = function (this: unknown[], item: unknown) {
        const rt = (item as unknown[])?.[2];
        if (typeof rt === "function") (rt as (r: WebpackRequire) => void)(requireFn);
        return origPush.call(this, item);
    };
    vi.stubGlobal("window", { webpackChunkdiscord_app: chunks });
    return chunks;
}

describe("Webpack finder", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        Webpack.reset();
    });

    it("captures require via probe chunk and finds modules", () => {
        const modules: Record<string, unknown> = {
            "./modA.js": (_m: unknown, e: Record<string, unknown>) => {
                e.findMe = { marker: "yes" };
            },
            "./modB.js": (_m: unknown, e: Record<string, unknown>) => {
                e.other = 1;
            },
        };
        const req = makeWebpackRuntime(modules);
        installFakeWindow(req);
        expect(Webpack.ensure()).toBe(true);
        const found = Webpack.find((exp) => {
            const o = exp as Record<string, unknown> | null;
            return !!o && typeof o === "object" && "marker" in (o.findMe as object);
        });
        expect(found).toBeDefined();
    });

    it("findByProps matches exports and default", () => {
        const modules: Record<string, unknown> = {
            "./a.js": (_m: unknown, e: Record<string, unknown>) => {
                e.default = { neededProp: 1, another: 2 };
            },
        };
        const req = makeWebpackRuntime(modules);
        installFakeWindow(req);
        // Force fresh capture: previous test already set req on the
        // singleton, which is fine — require is interchangeable for finds.
        expect(Webpack.findByProps("neededProp", "another")).toBeDefined();
    });

    it("findByDisplayName matches displayName on default export", () => {
        const modules: Record<string, unknown> = {
            "./c.js": (_m: unknown, e: Record<string, unknown>) => {
                e.default = { displayName: "MyComponent", render() {} };
            },
        };
        const req = makeWebpackRuntime(modules);
        installFakeWindow(req);
        expect(Webpack.findByDisplayName("MyComponent")).toBeDefined();
        expect(Webpack.findByDisplayName("Nope")).toBeUndefined();
    });

    it("findAll returns every match", () => {
        const modules: Record<string, unknown> = {
            "./1.js": (_m: unknown, e: Record<string, unknown>) => {
                e.tag = "hit";
            },
            "./2.js": (_m: unknown, e: Record<string, unknown>) => {
                e.tag = "hit";
            },
            "./3.js": (_m: unknown, e: Record<string, unknown>) => {
                e.tag = "miss";
            },
        };
        const req = makeWebpackRuntime(modules);
        installFakeWindow(req);
        const all = Webpack.findAllByProps("tag");
        expect(all.length).toBe(3);
        const hits = Webpack.findAll((exp) => (exp as { tag?: string }).tag === "hit");
        expect(hits.length).toBe(2);
    });

    it("returns undefined/empty when nothing matches", () => {
        const modules: Record<string, unknown> = {
            "./x.js": (_m: unknown, e: Record<string, unknown>) => {
                e.a = 1;
            },
        };
        const req = makeWebpackRuntime(modules);
        installFakeWindow(req);
        expect(Webpack.findByProps("zzz")).toBeUndefined();
        expect(Webpack.findAllByProps("zzz")).toEqual([]);
    });
});
