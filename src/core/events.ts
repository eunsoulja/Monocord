/**
 * Central typed-ish event bus.
 *
 * Events are string keys; payloads are `unknown` to callers but the bus
 * supports generics via `Events.on<T>(event, cb)`.
 *
 * Plugin-scoped subscriptions: `Events.scope("MyPlugin")` returns a handle
 * whose listeners are all removed by `scope.dispose()` — the plugin manager
 * calls this automatically on plugin stop so listeners never leak.
 */

export type EventHandler<T = unknown> = (payload: T) => void;

interface Registered {
    handler: EventHandler;
    scope: string | undefined;
}

class EventBus {
    private listeners = new Map<string, Set<Registered>>();

    /** Subscribe. Returns an unsubscribe function. */
    on<T = unknown>(event: string, handler: EventHandler<T>, scope?: string): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        const reg: Registered = { handler: handler as EventHandler, scope };
        set.add(reg);
        return () => {
            set.delete(reg);
            if (set.size === 0) this.listeners.delete(event);
        };
    }

    /** Subscribe for a single emission. */
    once<T = unknown>(event: string, handler: EventHandler<T>, scope?: string): () => void {
        const off = this.on<T>(
            event,
            (payload) => {
                off();
                handler(payload);
            },
            scope,
        );
        return off;
    }

    /** Remove a specific handler. */
    off<T = unknown>(event: string, handler: EventHandler<T>): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const reg of set) {
            if (reg.handler === handler) set.delete(reg);
        }
        if (set.size === 0) this.listeners.delete(event);
    }

    /** Emit an event to all subscribers. Handler errors are isolated. */
    emit<T = unknown>(event: string, payload?: T): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const reg of [...set]) {
            try {
                reg.handler(payload as T);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error(`[Monocord:events] listener for "${event}" threw`, e);
            }
        }
    }

    /** Remove every listener registered under a scope (e.g. a plugin name). */
    disposeScope(scope: string): number {
        let removed = 0;
        for (const [event, set] of this.listeners) {
            for (const reg of [...set]) {
                if (reg.scope === scope) {
                    set.delete(reg);
                    removed++;
                }
            }
            if (set.size === 0) this.listeners.delete(event);
        }
        return removed;
    }

    /** Count listeners for an event (debugging). */
    listenerCount(event: string): number {
        return this.listeners.get(event)?.size ?? 0;
    }
}

export const Events = new EventBus();

/** Scoped subscription handle for one plugin. */
export interface EventScope {
    on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    once<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    off<T = unknown>(event: string, handler: EventHandler<T>): void;
    /** Remove all listeners this scope registered. */
    dispose(): void;
}

/** Create a plugin-scoped event subscription handle. */
export function eventScope(name: string): EventScope {
    return {
        on: (event, handler) => Events.on(event, handler, name),
        once: (event, handler) => Events.once(event, handler, name),
        off: (event, handler) => Events.off(event, handler),
        dispose: () => {
            Events.disposeScope(name);
        },
    };
}
