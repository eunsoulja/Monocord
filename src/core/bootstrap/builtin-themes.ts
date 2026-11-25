/**
 * Built-in themes shipped inside the installer.
 *
 * Each entry becomes a directory-equivalent theme: `name` is the id used by
 * `theme:get`, `label`/`authors` feed `themes:list`, `css` is injected into a
 * <style> tag while active. Disk themes in %APPDATA%/Monocord/themes still
 * work and can shadow a built-in of the same name.
 */

import { CHILLAX_CSS } from "./chillax-theme";
import { GLASS_CSS } from "./glass-theme";
import { SYSTEM24_CSS } from "./system24-theme";

export interface BuiltinTheme {
    name: string;
    label: string;
    authors: string[];
    css: string;
}

const t = (css: string): string => css;

export const BUILTIN_THEMES: BuiltinTheme[] = [
    {
        name: "midnight",
        label: "Midnight",
        authors: ["Monocord"],
        css: t(`
:root {
    --background-primary: #0b1020;
    --background-secondary: #111a30;
    --background-secondary-alt: #0e1628;
    --background-tertiary: #182542;
    --background-accent: #1d2b52;
    --background-floating: #131c36;
    --background-modifier-hover: rgba(255,255,255,.06);
    --background-modifier-active: rgba(255,255,255,.10);
    --background-modifier-selected: rgba(88,101,242,.35);
    --header-primary: #e8ecff;
    --header-secondary: #9aa8d0;
    --text-normal: #dfe5ff;
    --text-muted: #8b96c4;
    --channels-default: #aab6e8;
    --interactive-normal: #7f8fd4;
    --interactive-hover: #9aa8e8;
    --interactive-active: #5a6bc4;
    --brand-500: #5865f2;
    --brand-560: #4752c4;
    --status-positive: #23a55a;
    --status-danger: #f23f43;
    --status-warning: #f0b232;
    --status-idle: #f0b232;
    --status-online: #23a55a;
    --guildsnav-background: #080d1a;
    --guildsnav-color: #6d7bab;
    --guildsnav-selected-color: #ffffff;
    --channel-background: #0d1526;
    --channel-background-selected: #1a2650;
    --channel-color: #93a0cf;
    --channel-color-selected: #ffffff;
    --channel-icon: #5a6a9e;
    --mention-background: rgba(88,101,242,.35);
    --mention-message-background: rgba(88,101,242,.25);
    --mention-foreground: #cdd6ff;
    --background-message-hover: rgba(255,255,255,.04);
    --background-message-automod: rgba(240,178,50,.08);
    --scrollbar-thin-thumb: rgba(255,255,255,.16);
    --scrollbar-thin-track: transparent;
    --input-background: #0a1122;
}
`),
    },
    {
        name: "dracula",
        label: "Dracula",
        authors: ["Monocord"],
        css: t(`
:root {
    --background-primary: #282a36;
    --background-secondary: #21222c;
    --background-secondary-alt: #1e1f29;
    --background-tertiary: #343746;
    --background-accent: #44475a;
    --background-floating: #2c2e3e;
    --background-modifier-hover: rgba(255,255,255,.06);
    --background-modifier-active: rgba(255,255,255,.10);
    --background-modifier-selected: rgba(189,147,249,.30);
    --header-primary: #f8f8f2;
    --header-secondary: #bfbfbf;
    --text-normal: #f8f8f2;
    --text-muted: #a7adba;
    --channels-default: #a7adba;
    --interactive-normal: #bd93f9;
    --interactive-hover: #d6acff;
    --interactive-active: #9d6ff0;
    --brand-500: #bd93f9;
    --brand-560: #a86ef0;
    --status-positive: #50fa7b;
    --status-danger: #ff5555;
    --status-warning: #f1fa8c;
    --status-idle: #f1fa8c;
    --status-online: #50fa7b;
    --guildsnav-background: #1e1f29;
    --guildsnav-color: #6272a4;
    --guildsnav-selected-color: #f8f8f2;
    --channel-background: #191a21;
    --channel-background-selected: #343746;
    --channel-color: #a7adba;
    --channel-color-selected: #f8f8f2;
    --channel-icon: #6272a4;
    --mention-background: rgba(189,147,249,.30);
    --mention-message-background: rgba(189,147,249,.22);
    --mention-foreground: #e6dbff;
    --background-message-hover: rgba(255,255,255,.04);
    --background-message-automod: rgba(241,250,140,.08);
    --scrollbar-thin-thumb: rgba(255,255,255,.18);
    --scrollbar-thin-track: transparent;
    --input-background: #1e1f29;
}
`),
    },
    {
        name: "catppuccin-mocha",
        label: "Catppuccin Mocha",
        authors: ["Monocord"],
        css: t(`
:root {
    --background-primary: #1e1e2e;
    --background-secondary: #181825;
    --background-secondary-alt: #11111b;
    --background-tertiary: #313244;
    --background-accent: #45475a;
    --background-floating: #232334;
    --background-modifier-hover: rgba(255,255,255,.05);
    --background-modifier-active: rgba(255,255,255,.09);
    --background-modifier-selected: rgba(203,166,247,.28);
    --header-primary: #cdd6f4;
    --header-secondary: #a6adc8;
    --text-normal: #cdd6f4;
    --text-muted: #9399b2;
    --channels-default: #a6adc8;
    --interactive-normal: #cba6f7;
    --interactive-hover: #decbe4;
    --interactive-active: #b4befe;
    --brand-500: #cba6f7;
    --brand-560: #a879e6;
    --status-positive: #a6e3a1;
    --status-danger: #f38ba8;
    --status-warning: #f9e2af;
    --status-idle: #f9e2af;
    --status-online: #a6e3a1;
    --guildsnav-background: #11111b;
    --guildsnav-color: #6c7086;
    --guildsnav-selected-color: #cdd6f4;
    --channel-background: #1e1e2e;
    --channel-background-selected: #313244;
    --channel-color: #a6adc8;
    --channel-color-selected: #cdd6f4;
    --channel-icon: #6c7086;
    --mention-background: rgba(203,166,247,.28);
    --mention-message-background: rgba(203,166,247,.20);
    --mention-foreground: #e4d7ff;
    --background-message-hover: rgba(255,255,255,.04);
    --background-message-automod: rgba(249,226,175,.08);
    --scrollbar-thin-thumb: rgba(255,255,255,.16);
    --scrollbar-thin-track: transparent;
    --input-background: #181825;
}
`),
    },
    {
        name: "tokyo-night",
        label: "Tokyo Night",
        authors: ["Monocord"],
        css: t(`
:root {
    --background-primary: #1a1b26;
    --background-secondary: #16161e;
    --background-secondary-alt: #13131a;
    --background-tertiary: #24283b;
    --background-accent: #2f3549;
    --background-floating: #1f2335;
    --background-modifier-hover: rgba(255,255,255,.05);
    --background-modifier-active: rgba(255,255,255,.09);
    --background-modifier-selected: rgba(122,162,247,.30);
    --header-primary: #c0caf5;
    --header-secondary: #9aa5ce;
    --text-normal: #c0caf5;
    --text-muted: #7982a9;
    --channels-default: #9aa5ce;
    --interactive-normal: #7aa2f7;
    --interactive-hover: #89b4fa;
    --interactive-active: #2ac3de;
    --brand-500: #7aa2f7;
    --brand-560: #5a8fe0;
    --status-positive: #9ece6a;
    --status-danger: #f7768e;
    --status-warning: #e0af68;
    --status-idle: #e0af68;
    --status-online: #9ece6a;
    --guildsnav-background: #15161e;
    --guildsnav-color: #565f89;
    --guildsnav-selected-color: #c0caf5;
    --channel-background: #1a1b26;
    --channel-background-selected: #24283b;
    --channel-color: #9aa5ce;
    --channel-color-selected: #c0caf5;
    --channel-icon: #565f89;
    --mention-background: rgba(122,162,247,.30);
    --mention-message-background: rgba(122,162,247,.22);
    --mention-foreground: #d0dcff;
    --background-message-hover: rgba(255,255,255,.04);
    --background-message-automod: rgba(224,175,104,.08);
    --scrollbar-thin-thumb: rgba(255,255,255,.16);
    --scrollbar-thin-track: transparent;
    --input-background: #16161e;
}
`),
    },
    {
        name: "github-dim",
        label: "GitHub Dim",
        authors: ["Monocord"],
        css: t(`
:root {
    --background-primary: #22272e;
    --background-secondary: #1c2128;
    --background-secondary-alt: #171b21;
    --background-tertiary: #2d333b;
    --background-accent: #373e47;
    --background-floating: #262c36;
    --background-modifier-hover: rgba(255,255,255,.05);
    --background-modifier-active: rgba(255,255,255,.09);
    --background-modifier-selected: rgba(56,139,253,.30);
    --header-primary: #e6edf3;
    --header-secondary: #8b949e;
    --text-normal: #e6edf3;
    --text-muted: #768390;
    --channels-default: #8b949e;
    --interactive-normal: #539bf5;
    --interactive-hover: #79b8ff;
    --interactive-active: #2f81f7;
    --brand-500: #539bf5;
    --brand-560: #388bfd;
    --status-positive: #3fb950;
    --status-danger: #f85149;
    --status-warning: #d29922;
    --status-idle: #d29922;
    --status-online: #3fb950;
    --guildsnav-background: #15181d;
    --guildsnav-color: #636e7b;
    --guildsnav-selected-color: #e6edf3;
    --channel-background: #22272e;
    --channel-background-selected: #2d333b;
    --channel-color: #8b949e;
    --channel-color-selected: #e6edf3;
    --channel-icon: #636e7b;
    --mention-background: rgba(56,139,253,.30);
    --mention-message-background: rgba(56,139,253,.22);
    --mention-foreground: #cfe3ff;
    --background-message-hover: rgba(255,255,255,.04);
    --background-message-automod: rgba(210,153,34,.08);
    --scrollbar-thin-thumb: rgba(255,255,255,.16);
    --scrollbar-thin-track: transparent;
    --input-background: #1c2128;
}
`),
    },
    {
        name: "monokai",
        label: "Monokai",
        authors: ["Monocord"],
        css: t(`
:root {
    --background-primary: #272822;
    --background-secondary: #1e1f1c;
    --background-secondary-alt: #191a17;
    --background-tertiary: #3e3d32;
    --background-accent: #49483e;
    --background-floating: #2d2e27;
    --background-modifier-hover: rgba(255,255,255,.05);
    --background-modifier-active: rgba(255,255,255,.09);
    --background-modifier-selected: rgba(249,38,114,.30);
    --header-primary: #f8f8f2;
    --header-secondary: #cfcfc2;
    --text-normal: #f8f8f2;
    --text-muted: #a59f8d;
    --channels-default: #a59f8d;
    --interactive-normal: #f92672;
    --interactive-hover: #fd5d9d;
    --interactive-active: #a81e56;
    --brand-500: #f92672;
    --brand-560: #c2185b;
    --status-positive: #a6e22e;
    --status-danger: #f92672;
    --status-warning: #e6db74;
    --status-idle: #e6db74;
    --status-online: #a6e22e;
    --guildsnav-background: #141510;
    --guildsnav-color: #75715e;
    --guildsnav-selected-color: #f8f8f2;
    --channel-background: #23241e;
    --channel-background-selected: #3e3d32;
    --channel-color: #a59f8d;
    --channel-color-selected: #f8f8f2;
    --channel-icon: #75715e;
    --mention-background: rgba(249,38,114,.30);
    --mention-message-background: rgba(249,38,114,.22);
    --mention-foreground: #ffd7e6;
    --background-message-hover: rgba(255,255,255,.04);
    --background-message-automod: rgba(230,219,116,.08);
    --scrollbar-thin-thumb: rgba(255,255,255,.16);
    --scrollbar-thin-track: transparent;
    --input-background: #1e1f1c;
}
`),
    },
    {
        name: "system24",
        label: "system24",
        authors: ["refact0r"],
        css: SYSTEM24_CSS,
    },
    {
        name: "chillax",
        label: "Chillax",
        authors: ["Chillax Squad", "Wq", "LofiTurtle", "Inmoresentum", "Demented_Elmo"],
        css: CHILLAX_CSS,
    },
    {
        name: "glass",
        label: "Glass",
        authors: ["Monocord"],
        css: GLASS_CSS,
    },
];
