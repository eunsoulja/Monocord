import { describe, expect, it } from "vitest";
import { MemoryBackend, SettingsStore, getPath, setPath } from "../src/core/settings";

describe("settings paths", () => {
    it("getPath reads nested values", () => {
        const obj = { a: { b: { c: 42 } } };
        expect(getPath(obj, "a.b.c")).toBe(42);
        expect(getPath(obj, "a.b.x")).toBeUndefined();
        expect(getPath(obj, "a.b.c.d")).toBeUndefined();
    });

    it("setPath creates intermediate objects", () => {
        const obj: Record<string, unknown> = {};
        setPath(obj, "a.b.c", 1);
        expect(getPath(obj, "a.b.c")).toBe(1);
    });
});

describe("SettingsStore", () => {
    it("persists through the backend", async () => {
        const backend = new MemoryBackend();
        const s1 = new SettingsStore(backend);
        await s1.set("plugins.enabled", ["A"]);
        const s2 = new SettingsStore(backend);
        expect(await s2.get<string[]>("plugins.enabled")).toEqual(["A"]);
    });

    it("getSync works after ready", async () => {
        const s = new SettingsStore(new MemoryBackend());
        await s.set("x.y", "z");
        expect(s.getSync("x.y")).toBe("z");
    });

    it("delete removes the value", async () => {
        const s = new SettingsStore(new MemoryBackend());
        await s.set("a.b", 1);
        await s.delete("a.b");
        expect(await s.get("a.b")).toBeUndefined();
    });
});
