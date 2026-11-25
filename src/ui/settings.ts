/**
 * Monocord settings panels — rendered inside Discord's settings UI through
 * the layout DSL (SECTION / SIDEBAR_ITEM / PANEL / CATEGORY / CUSTOM nodes).
 *
 * Styled with Discord's own CSS variables so the panels match the client.
 */

import { Api } from "../core/api";
import { Events } from "../core/events";
import { Logger } from "../core/logger";
import { Settings } from "../core/settings";
import { Themes } from "../core/themes";
import type { Plugin, Theme } from "../core/types";
import { h } from "./react";

const log = Logger.get("settings-ui");

/**
 * Minimal React class-component base, compatible with any reconciler.
 *
 * Discord renders the settings tree with its own React copy, so hooks from
 * our resolved React have a null dispatcher inside CUSTOM components. Class
 * components avoid hooks entirely: react-dom only requires
 * `prototype.isReactComponent` + `render`, and it injects `updater` on mount
 * — `setState` then flows through whichever reconciler owns the tree.
 */
class PanelBase {
    props: Record<string, any>;
    state: Record<string, any>;
    refs: Record<string, any> = {};
    updater: {
        enqueueSetState?: (
            inst: PanelBase,
            partialState: unknown,
            callback?: () => void,
            caller?: string,
        ) => void;
        enqueueForceUpdate?: (
            inst: PanelBase,
            callback?: () => void,
            caller?: string,
        ) => void;
    } | null = null;

    constructor(props?: Record<string, any>) {
        this.props = props ?? {};
        this.state = {};
    }

    setState(
        update:
            | Record<string, any>
            | ((prev: Record<string, any>, props: Record<string, any>) => Record<string, any>),
        callback?: () => void,
    ): void {
        const partial =
            typeof update === "function" ? update(this.state, this.props) : update;
        this.updater?.enqueueSetState?.(this, partial, callback, "setState");
    }

    forceUpdate(callback?: () => void): void {
        this.updater?.enqueueForceUpdate?.(this, callback, "forceUpdate");
    }

    render(): unknown {
        return null;
    }
}
(PanelBase.prototype as { isReactComponent?: object }).isReactComponent = {};

type Style = Record<string, string | number>;

const S = {
    page: {
        padding: "16px 20px",
        color: "var(--text-normal, #dbdee1)",
        fontSize: 14,
        lineHeight: "20px",
    } as Style,
    h2: { fontSize: 20, fontWeight: 600, margin: "0 0 12px" } as Style,
    muted: { color: "var(--text-muted, #949ba4)", fontSize: 12 } as Style,
    card: {
        background: "var(--background-secondary, #2b2d31)",
        borderRadius: 8,
        padding: "12px 16px",
        marginBottom: 8,
    } as Style,
    row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
    } as Style,
    btn: {
        background: "var(--brand-500, #5865f2)",
        color: "#fff",
        border: "none",
        borderRadius: 4,
        padding: "6px 14px",
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
    } as Style,
    btnOff: {
        background: "var(--background-modifier-accent, #3f4147)",
        color: "var(--text-normal, #dbdee1)",
        border: "1px solid var(--background-modifier-accent, #3f4147)",
        borderRadius: 4,
        padding: "5px 13px",
        fontSize: 13,
        cursor: "pointer",
    } as Style,
    input: {
        width: "100%",
        background: "var(--input-background, #1e1f22)",
        color: "var(--text-normal, #dbdee1)",
        border: "1px solid var(--background-modifier-accent, #3f4147)",
        borderRadius: 4,
        padding: "8px 10px",
        fontSize: 13,
        fontFamily: "var(--font-code, monospace)",
        boxSizing: "border-box",
    } as Style,
    badge: {
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        marginLeft: 8,
        verticalAlign: "middle",
    } as Style,
};

function Badge(props: { ok: boolean; text: string }) {
    return h(
        "span",
        {
            style: {
                ...S.badge,
                background: props.ok
                    ? "var(--status-positive, #23a55a)"
                    : "var(--status-danger, #f23f43)",
                color: "#fff",
            },
        },
        props.text,
    );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export class OverviewPanel extends PanelBase {
    override state: { info: Record<string, unknown> | null } = { info: null };

    componentDidMount(): void {
        const bridge = (window as { monocord?: { invoke(c: string): Promise<unknown> } })
            .monocord;
        if (bridge) {
            bridge
                .invoke("version")
                .then((v) => this.setState({ info: v as Record<string, unknown> }))
                .catch(() => {});
        }
    }

    override render(): unknown {
        const info = this.state.info;
        const pluginCount = Api.Plugins.names().length;
        const enabledCount = Api.Plugins.names().filter((n) =>
            Api.Plugins.isEnabled(n),
        ).length;

        return h(
        "div",
        { style: S.page },
        h("h2", { style: S.h2 }, "Monocord"),
        h(
            "div",
            { style: S.card },
            h("div", null, `Framework v${Api.version}`),
            h(
                "div",
                { style: S.muted },
                `Discord ${String(info?.discord ?? "unknown")} · Electron host`,
            ),
        ),
        h(
            "div",
            { style: S.card },
            h(
                "div",
                { style: S.row },
                h("span", null, "Plugins"),
                h("span", { style: S.muted }, `${enabledCount} enabled / ${pluginCount} registered`),
            ),
        ),
        h(
            "div",
            { style: { ...S.card, ...S.muted } },
            "Monocord is a Vencord-inspired modification framework. Manage plugins and themes from the sidebar.",
        ),
        );
    }
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const PLUGIN_EVENTS = [
    "plugin.enabled",
    "plugin.disabled",
    "plugin.error",
    "plugin.started",
    "plugin.stopped",
    "plugin.registered",
    "plugin.unregistered",
];

function pluginRows(): { name: string; plugin: Plugin; enabled: boolean; running: boolean }[] {
    return Api.Plugins.names()
        .filter((n) => n !== "MonocordSettings")
        .map((name) => ({
            name,
            plugin: Api.Plugins.get(name) as Plugin,
            enabled: Api.Plugins.isEnabled(name),
            running: Api.Plugins.isRunning(name),
        }));
}

export class PluginsPanel extends PanelBase {
    override state: { rev: number } = { rev: 0 };
    private offs: (() => void)[] = [];

    componentDidMount(): void {
        this.offs = PLUGIN_EVENTS.map((e) =>
            Events.on(e, () => this.setState({ rev: this.state.rev + 1 })),
        );
    }

    componentWillUnmount(): void {
        this.offs.forEach((off) => off());
        this.offs = [];
    }

    override render(): unknown {
        const rows = pluginRows();

    return h(
        "div",
        { style: S.page },
        h("h2", { style: S.h2 }, "Plugins"),
        rows.length === 0
            ? h("div", { style: S.muted }, "No plugins registered.")
            : rows.map(({ name, plugin, enabled }) =>
                  h(
                      "div",
                      { key: name, style: S.card },
                      h(
                          "div",
                          { style: S.row },
                          h(
                              "div",
                              null,
                              h("strong", null, name),
                              plugin.version
                                  ? h("span", { style: S.muted }, ` v${plugin.version}`)
                                  : null,
                              h("div", { style: S.muted }, plugin.description ?? ""),
                          ),
                          h(
                              "button",
                              {
                                  style: enabled ? S.btnOff : S.btn,
                                  onClick: () => {
                                      const p = enabled
                                          ? Api.Plugins.disable(name)
                                          : Api.Plugins.enable(name);
                                      void p.catch((e) =>
                                          log.error(`toggle ${name} failed`, e),
                                      );
                                  },
                              },
                              enabled ? "Disable" : "Enable",
                          ),
                      ),
                  ),
              ),
        );
    }
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

interface ThemesState {
    themes: Theme[] | null;
    active: string | null;
    customCss: string;
    saved: boolean;
}

export class ThemesPanel extends PanelBase {
    override state: ThemesState = {
        themes: null,
        active: Themes.active,
        customCss: "",
        saved: false,
    };
    private offs: (() => void)[] = [];

    componentDidMount(): void {
        void Themes.list().then((themes) => this.setState({ themes }));
        void Settings.get<string>("theme.customCss", "").then((v) =>
            this.setState({ customCss: v ?? "" }),
        );
        this.offs = [
            Events.on("theme.changed", () =>
                this.setState({ active: Themes.active }),
            ),
            Events.on("settings.changed", () => this.setState({ saved: false })),
        ];
    }

    componentWillUnmount(): void {
        this.offs.forEach((off) => off());
        this.offs = [];
    }

    private activate(name: string | null): void {
        void Themes.activate(name)
            .then(() => this.setState({ active: Themes.active }))
            .catch((e) => log.error("theme activation failed", e));
    }

    override render(): unknown {
        const { themes, active, customCss, saved } = this.state;
        const activate = (name: string | null) => this.activate(name);
        const setCustomCss = (v: string) => this.setState({ customCss: v });

    return h(
        "div",
        { style: S.page },
        h("h2", { style: S.h2 }, "Themes"),
        h(
            "div",
            { style: S.card },
            h("div", { style: { ...S.row, marginBottom: 8 } },
                h("strong", null, "Installed themes"),
                h("button", { style: S.btnOff, onClick: () => activate(null) }, "None"),
            ),
            themes === null
                ? h("div", { style: S.muted }, "Loading…")
                : themes.length === 0
                  ? h("div", { style: S.muted }, "No themes installed.")
                  : themes.map((t) =>
                        h(
                            "div",
                            { key: t.name, style: { ...S.row, padding: "6px 0" } },
                            h(
                                "span",
                                null,
                                t.label ?? t.name,
                                active === t.name
                                    ? h(Badge, { ok: true, text: "active" })
                                    : null,
                            ),
                            h(
                                "button",
                                {
                                    style: active === t.name ? S.btnOff : S.btn,
                                    onClick: () => activate(t.name),
                                },
                                active === t.name ? "Active" : "Apply",
                            ),
                        ),
                    ),
        ),
        h(
            "div",
            { style: S.card },
            h("div", { style: { ...S.row, marginBottom: 8 } },
                h("strong", null, "Custom CSS"),
                h(
                    "button",
                    {
                        style: S.btn,
                        onClick: () => {
                            void Themes.setCustomCss(customCss).then(() =>
                                this.setState({ saved: true }),
                            );
                        },
                    },
                    saved ? "Saved ✓" : "Save",
                ),
            ),
            h("textarea", {
                style: { ...S.input, minHeight: 140, resize: "vertical" },
                value: customCss,
                placeholder: "/* custom css */",
                onChange: (e: { target: { value: string } }) =>
                    setCustomCss(e.target.value),
            }),
        ),
        );
    }
}
