import { beforeEach, describe, expect, it } from "vitest";
import { Patcher } from "../src/core/patcher";

interface Target {
    greet(name: string): string;
    add(a: number, b: number): number;
}

function makeTarget(): Target {
    return {
        greet(name: string) {
            return `hello ${name}`;
        },
        add(a: number, b: number) {
            return a + b;
        },
    };
}

describe("Patcher", () => {
    beforeEach(() => {
        // Fresh object per test; patches are keyed by object identity so
        // leaks across tests are impossible, but clear anyway.
        Patcher.unpatchAll("t1");
        Patcher.unpatchAll("t2");
    });

    it("before can rewrite arguments", () => {
        const t = makeTarget();
        Patcher.before("t1", t, "greet", (name) => [`mr. ${name}`]);
        expect(t.greet("bob")).toBe("hello mr. bob");
    });

    it("before with no return keeps arguments", () => {
        const t = makeTarget();
        let called = 0;
        Patcher.before("t1", t, "add", () => {
            called++;
        });
        expect(t.add(1, 2)).toBe(3);
        expect(called).toBe(1);
    });

    it("after can replace the return value", () => {
        const t = makeTarget();
        Patcher.after("t1", t, "add", (ret) => (ret as number) * 10);
        expect(t.add(2, 3)).toBe(50);
    });

    it("after returning undefined keeps original result", () => {
        const t = makeTarget();
        Patcher.after("t1", t, "greet", () => undefined);
        expect(t.greet("x")).toBe("hello x");
    });

    it("instead skips original when returning a value", () => {
        const t = makeTarget();
        Patcher.instead("t1", t, "add", () => 42);
        expect(t.add(1, 2)).toBe(42);
    });

    it("instead falls through on undefined", () => {
        const t = makeTarget();
        Patcher.instead("t1", t, "add", (a, b) =>
            (a as number) > 10 ? "big" : undefined,
        );
        expect(t.add(1, 2)).toBe(3);
        expect(t.add(20, 2)).toBe("big");
    });

    it("unpatch restores the original", () => {
        const t = makeTarget();
        Patcher.after("t1", t, "add", (r) => (r as number) + 100);
        expect(t.add(1, 1)).toBe(102);
        Patcher.unpatch("t1", t, "add");
        expect(t.add(1, 1)).toBe(2);
    });

    it("unpatchAll removes every patch for a plugin only", () => {
        const t = makeTarget();
        Patcher.after("t1", t, "add", (r) => (r as number) + 1);
        Patcher.after("t2", t, "add", (r) => (r as number) + 10);
        expect(t.add(0, 0)).toBe(11);
        expect(Patcher.unpatchAll("t1")).toBe(1);
        expect(t.add(0, 0)).toBe(10);
        expect(Patcher.unpatchAll("t2")).toBe(1);
        expect(t.add(0, 0)).toBe(0);
    });

    it("patches stack across plugins", () => {
        const t = makeTarget();
        Patcher.after("t1", t, "add", (r) => (r as number) + 1);
        Patcher.after("t2", t, "add", (r) => (r as number) * 2);
        // t2 wraps t1's wrapper: ((0+0)+1)*2 = 2
        expect(t.add(0, 0)).toBe(2);
    });

    it("rejects patching non-functions", () => {
        const t = { value: 5 };
        expect(() => Patcher.before("t1", t, "value", () => {})).toThrow();
    });
});
