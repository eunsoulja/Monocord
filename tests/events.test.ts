import { describe, expect, it } from "vitest";
import { Events, eventScope } from "../src/core/events";

describe("Events", () => {
    it("on/emit delivers payloads", () => {
        const seen: unknown[] = [];
        Events.on("test.a", (p) => seen.push(p));
        Events.emit("test.a", { x: 1 });
        Events.emit("test.a", { x: 2 });
        expect(seen).toEqual([{ x: 1 }, { x: 2 }]);
    });

    it("unsubscribe stops delivery", () => {
        let n = 0;
        const off = Events.on("test.b", () => n++);
        Events.emit("test.b");
        off();
        Events.emit("test.b");
        expect(n).toBe(1);
    });

    it("once fires exactly once", () => {
        let n = 0;
        Events.once("test.c", () => n++);
        Events.emit("test.c");
        Events.emit("test.c");
        expect(n).toBe(1);
    });

    it("off removes a specific handler", () => {
        let a = 0;
        let b = 0;
        const ha = () => a++;
        const hb = () => b++;
        Events.on("test.d", ha);
        Events.on("test.d", hb);
        Events.off("test.d", ha);
        Events.emit("test.d");
        expect(a).toBe(0);
        expect(b).toBe(1);
    });

    it("eventScope listeners are removed by dispose", () => {
        let pluginHits = 0;
        let coreHits = 0;
        const scope = eventScope("TestPlugin");
        scope.on("test.e", () => pluginHits++);
        Events.on("test.e", () => coreHits++);
        Events.emit("test.e");
        expect(pluginHits).toBe(1);
        expect(coreHits).toBe(1);
        scope.dispose();
        Events.emit("test.e");
        expect(pluginHits).toBe(1);
        expect(coreHits).toBe(2);
    });

    it("a throwing listener does not break others", () => {
        let ok = 0;
        Events.on("test.f", () => {
            throw new Error("boom");
        });
        Events.on("test.f", () => ok++);
        expect(() => Events.emit("test.f")).not.toThrow();
        expect(ok).toBe(1);
    });
});
