import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager, validateManifest } from "../src/core/plugins/manager";
import { MemoryBackend, Settings } from "../src/core/settings";
import { Patcher } from "../src/core/patcher";
import type { Plugin } from "../src/core/types";

function mgr(): PluginManager {
    return new PluginManager();
}

describe("PluginManager", () => {
    beforeEach(() => {
        Settings.useBackend(new MemoryBackend());
        Patcher.unpatchAll("P1");
        Patcher.unpatchAll("P2");
        Patcher.unpatchAll("P3");
    });

    it("registers and reports names", () => {
        const m = mgr();
        m.register({ name: "P1", start() {} });
        expect(m.names()).toContain("P1");
        expect(m.isEnabled("P1")).toBe(false);
    });

    it("rejects duplicate names", () => {
        const m = mgr();
        m.register({ name: "P1" });
        expect(() => m.register({ name: "P1" })).toThrow();
    });

    it("enable runs start, disable runs stop", async () => {
        const calls: string[] = [];
        const p: Plugin = {
            name: "P1",
            start: () => void calls.push("start"),
            stop: () => void calls.push("stop"),
        };
        const m = mgr();
        m.register(p);
        await m.enable("P1");
        expect(calls).toEqual(["start"]);
        expect(m.isEnabled("P1")).toBe(true);
        await m.disable("P1");
        expect(calls).toEqual(["start", "stop"]);
        expect(m.isEnabled("P1")).toBe(false);
    });

    it("enable is idempotent", async () => {
        let n = 0;
        const m = mgr();
        m.register({ name: "P1", start: () => { n++; } });
        await m.enable("P1");
        await m.enable("P1");
        expect(n).toBe(1);
    });

    it("dependencies start first", async () => {
        const order: string[] = [];
        const m = mgr();
        m.register({ name: "Base", start: () => void order.push("Base") });
        m.register({
            name: "Dependent",
            required: ["Base"],
            start: () => void order.push("Dependent"),
        });
        await m.enable("Dependent");
        expect(order).toEqual(["Base", "Dependent"]);
    });

    it("missing dependency fails enable", async () => {
        const m = mgr();
        m.register({ name: "P1", required: ["Ghost"] });
        await expect(m.enable("P1")).rejects.toThrow();
        expect(m.isEnabled("P1")).toBe(false);
    });

    it("throwing start is isolated and disables the plugin", async () => {
        const errors: unknown[] = [];
        const { Events } = await import("../src/core/events");
        Events.on("plugin.error", (p) => errors.push(p));
        const m = mgr();
        m.register({
            name: "P1",
            start() {
                throw new Error("boom");
            },
        });
        await m.enable("P1");
        expect(m.isEnabled("P1")).toBe(false);
        expect(errors.length).toBe(1);
    });

    it("disable removes the plugin's patches", async () => {
        const target = { f: () => "orig" };
        const m = mgr();
        m.register({
            name: "P1",
            start() {
                Patcher.instead("P1", target, "f", () => "patched");
            },
        });
        await m.enable("P1");
        expect(target.f()).toBe("patched");
        await m.disable("P1");
        expect(target.f()).toBe("orig");
    });

    it("enabled state persists through Settings", async () => {
        const m = mgr();
        m.register({ name: "P1", start() {} });
        await m.enable("P1");
        const m2 = mgr();
        m2.register({ name: "P1", start() {} });
        await m2.startEnabled();
        expect(m2.isEnabled("P1")).toBe(true);
    });

    it("validateManifest requires name/version/main", () => {
        expect(validateManifest({ name: "x", version: "1", main: "i.js" })).toBe(true);
        expect(validateManifest({ name: "x", main: "i.js" })).toBe(false);
        expect(validateManifest(null)).toBe(false);
        expect(validateManifest("nope")).toBe(false);
    });

    it("stopAll disables everything", async () => {
        const m = mgr();
        m.register({ name: "P1", start() {} });
        m.register({ name: "P2", start() {} });
        await m.enable("P1");
        await m.enable("P2");
        await m.stopAll();
        expect(m.isEnabled("P1")).toBe(false);
        expect(m.isEnabled("P2")).toBe(false);
    });
});
