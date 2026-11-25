/**
 * Shared DOM helpers for built-in plugins. Everything here is defensive —
 * Discord's DOM is obfuscated and changes between versions, so selectors are
 * substring/class-fragment based and every helper no-ops when absent.
 */

/** Run `cb` once the DOM is ready (or immediately if it already is). */
export function onDomReady(cb: () => void): void {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", cb, { once: true });
    } else {
        cb();
    }
}

/**
 * Observe `root` (default document.body) for additions matching `selector`.
 * `cb` fires for each new match. Returns a stop function.
 */
export function observeAdded(
    selector: string,
    cb: (el: Element) => void,
    root: ParentNode = document.body,
): () => void {
    const seen = new WeakSet<Element>();
    const scan = (scope: ParentNode) => {
        scope.querySelectorAll(selector).forEach((el) => {
            if (!seen.has(el)) {
                seen.add(el);
                cb(el);
            }
        });
    };
    scan(root);
    const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node instanceof Element) {
                    if (node.matches(selector)) {
                        if (!seen.has(node)) {
                            seen.add(node);
                            cb(node);
                        }
                    }
                    scan(node);
                }
            }
        }
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
}

/** Delegated event listener; returns an unlisten function. */
export function on(
    target: EventTarget,
    type: string,
    selector: string | null,
    handler: (el: Element, ev: Event) => void,
    capture = false,
): () => void {
    const listener = (ev: Event) => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const el = selector ? t.closest(selector) : t;
        if (el) handler(el, ev);
    };
    target.addEventListener(type, listener, capture);
    return () => target.removeEventListener(type, listener, capture);
}

/** Create an element with inline styles. */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    style?: Partial<CSSStyleDeclaration> | Record<string, string>,
    ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (style) Object.assign(node.style, style);
    for (const c of children) {
        if (c == null) continue;
        node.append(c instanceof Node ? c : document.createTextNode(c));
    }
    return node;
}

interface MenuItem {
    label: string;
    action: () => void;
    danger?: boolean;
}

/** Show a small context menu at (x, y); returns a close function. */
export function contextMenu(x: number, y: number, items: MenuItem[]): () => void {
    const menu = el(
        "div",
        {
            position: "fixed",
            left: `${x}px`,
            top: `${y}px`,
            zIndex: "100001",
            background: "var(--background-floating, #111214)",
            border: "1px solid var(--background-modifier-accent, #3f4147)",
            borderRadius: "8px",
            padding: "4px",
            minWidth: "180px",
            boxShadow: "0 8px 24px rgba(0,0,0,.4)",
        },
    );
    const close = () => menu.remove();
    for (const item of items) {
        const b = el(
            "button",
            {
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                color: item.danger
                    ? "var(--status-danger, #f23f43)"
                    : "var(--text-normal, #dbdee1)",
                padding: "8px 12px",
                fontSize: "13px",
                cursor: "pointer",
                borderRadius: "4px",
            },
            item.label,
        );
        b.addEventListener("mouseenter", () => (b.style.background = "var(--background-modifier-hover, rgba(78,80,88,.3))"));
        b.addEventListener("mouseleave", () => (b.style.background = "none"));
        b.addEventListener("click", () => {
            close();
            item.action();
        });
        menu.append(b);
    }
    document.body.append(menu);
    setTimeout(() => {
        document.addEventListener("click", close, { once: true });
        document.addEventListener("contextmenu", close, { once: true });
        document.addEventListener("keydown", function onKey(e) {
            if (e.key === "Escape") {
                close();
                document.removeEventListener("keydown", onKey);
            }
        });
    }, 0);
    return close;
}

/** Show a small auto-dismissing toast near the top of the Discord window. */
export function toast(text: string, ms = 2200): void {
    const box = el(
        "div",
        {
            position: "fixed",
            top: "64px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: "100000",
            background: "var(--background-floating, #111214)",
            color: "var(--text-normal, #dbdee1)",
            border: "1px solid var(--background-modifier-accent, #3f4147)",
            borderRadius: "8px",
            padding: "10px 18px",
            fontSize: "14px",
            boxShadow: "0 8px 24px rgba(0,0,0,.4)",
            pointerEvents: "none",
        },
        text,
    );
    document.body.append(box);
    setTimeout(() => box.remove(), ms);
}
