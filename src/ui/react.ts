/**
 * Minimal React binding for Monocord UI.
 *
 * Discord's React instance is discovered through webpack; components are
 * written with `h()` (createElement) so no JSX runtime is required.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";

const log = Logger.get("ui");

type AnyRecord = Record<string, any>;

let react: AnyRecord | null = null;

/** Resolve and cache Discord's React module. */
export async function ensureReact(): Promise<AnyRecord> {
    if (react) return react;
    react = (await Api.React.get()) as AnyRecord;
    return react;
}

/** React module — throws if called before ensureReact(). */
export function getReact(): AnyRecord {
    if (!react) throw new Error("React not initialized — call ensureReact()");
    return react;
}

export function h(type: unknown, props?: unknown, ...children: unknown[]): unknown {
    return getReact().createElement(type, props, ...children);
}

export function useState<T>(
    initial: T | (() => T),
): [T, (v: T | ((prev: T) => T)) => void] {
    return getReact().useState(initial);
}

export function useEffect(
    effect: () => void | (() => void),
    deps?: unknown[],
): void {
    getReact().useEffect(effect, deps);
}

/** Fragment shorthand. */
export function Fragment(props: { children?: unknown }): unknown {
    return h(getReact().Fragment ?? "div", null, props.children);
}

/** Re-render trigger helper for components subscribed to the event bus. */
export function useRevision(events: string[]): () => void {
    const [rev, setRev] = useState(0);
    useEffect(() => {
        const offs = events.map((e) =>
            Api.Events.on(e, () => setRev((r: number) => r + 1)),
        );
        return () => offs.forEach((off) => off());
    }, events);
    return () => rev;
}

/** Diagnostic: log which React hooks resolved. */
export function logReactInfo(): void {
    const r = getReact();
    log.info("react resolved", {
        keys: Object.keys(r).slice(0, 20),
        hasMemo: typeof r.useMemo,
        hasRef: typeof r.useRef,
    });
}
