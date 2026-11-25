/**
 * Glass — transparent Discord surfaces with backdrop blur.
 *
 * Uses Discord's own --background-* variables (translucent tints) so most
 * of the UI goes glass automatically; a few class-substring selectors add
 * backdrop-filter to the big surfaces only — blur on every element would
 * murder the GPU. The wallpaper comes from the uploaded image exposed as
 * --monocord-wallpaper (Monocord wallpaper upload); with none set the
 * theme is a plain dark glass.
 */

export const GLASS_CSS = `
/* Monocord wallpaper hook — set by the wallpaper upload feature. */
:root {
    --monocord-wallpaper: none;
    --glass-tint: rgba(10, 13, 19, 0.62);
    --glass-tint-strong: rgba(8, 10, 15, 0.78);
    --glass-blur: 14px;
    --glass-border: rgba(255, 255, 255, 0.09);
}

/* Wallpaper layer: dimmed image (or flat color) behind everything. */
html, body {
    background-color: #0b0e14;
    background-image:
        linear-gradient(rgba(7, 9, 14, 0.66), rgba(7, 9, 14, 0.66)),
        var(--monocord-wallpaper, none);
    background-size: cover;
    background-position: center;
    background-attachment: fixed;
}

/* Discord's own background layers must not paint over the wallpaper. */
#app, .layer {
    background: transparent !important;
}

/* Translucent surfaces via Discord's theme variables. */
:root {
    --background-primary: var(--glass-tint);
    --background-secondary: rgba(18, 22, 31, 0.58);
    --background-tertiary: rgba(24, 29, 40, 0.62);
    --background-floating: rgba(16, 20, 29, 0.72);
    --background-accent: rgba(88, 101, 242, 0.45);
    --background-modifier-hover: rgba(255, 255, 255, 0.08);
    --background-modifier-active: rgba(255, 255, 255, 0.12);
    --background-modifier-selected: rgba(88, 101, 242, 0.38);
    --background-message-hover: rgba(255, 255, 255, 0.06);
    --channel-background: transparent;
    --chat-background: transparent;
    --guild-header-background: transparent;
    --user-profile-background: transparent;
    --modal-background: rgba(18, 22, 31, 0.82);
    --popover-background: rgba(18, 22, 31, 0.85);
    --tooltip-background: rgba(10, 13, 18, 0.9);
    --input-background: rgba(255, 255, 255, 0.06);
    --deprecated-card-bg: rgba(255, 255, 255, 0.05);
    --card-background: rgba(255, 255, 255, 0.05);
    --card-secondary-bg: rgba(255, 255, 255, 0.03);
}

/* Frosted glass on the major surfaces only. Discord's hashed class names
   keep readable substrings (sidebar-, chatContent-, memberList-, modal-,
   popout-, popover-), which is what client themes match on. */
[class*="sidebar"],
[class*="chatContent"],
[class*="memberList"],
[class*="member-list"],
[class*="modal"],
[class*="popout"],
[class*="popover"] {
    backdrop-filter: blur(var(--glass-blur)) saturate(1.3);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.3);
}

/* Thin glass borders so panels read against busy wallpapers. */
[class*="sidebar"] > *,
[class*="chatContent"] > *,
[class*="memberList"] > *,
[class*="modal"] > * {
    border-color: var(--glass-border) !important;
}

/* Stronger tint for floating surfaces (menus, modals, popouts) so text
   stays readable over bright wallpapers. */
[class*="modal"], [class*="popout"], [class*="popover"] {
    background-color: var(--glass-tint-strong) !important;
}

/* Keep scrollbars subtle on glass. */
::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.16);
}
::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.24);
}
`;
