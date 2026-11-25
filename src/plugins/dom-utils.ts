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
