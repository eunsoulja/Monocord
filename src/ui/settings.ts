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

function statusDot(enabled: boolean, running: boolean): unknown {
    const cls = !enabled ? "off" : running ? "on" : "warn";
    const tip = !enabled
        ? "Disabled"
        : running
          ? "Enabled · running"
          : "Enabled · not running";
    return h("span", { className: `mc-status ${cls}`, title: tip });
}

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
    override state: {
        info: Record<string, unknown> | null;
        dataMsg: string;
        importing: boolean;
    } = { info: null, dataMsg: "", importing: false };

    private bridge(): { invoke(c: string, ...a: unknown[]): Promise<unknown> } | null {
        return (window as { monocord?: { invoke(c: string, ...a: unknown[]): Promise<unknown> } })
            .monocord ?? null;
    }

    private async exportSettings(): Promise<void> {
        const b = this.bridge();
        if (!b) return this.setState({ dataMsg: "Bridge unavailable" });
        try {
            const doc = await b.invoke("settings-get");
            const blob = new Blob([JSON.stringify(doc, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "monocord-settings.json";
            a.click();
            URL.revokeObjectURL(url);
            this.setState({ dataMsg: "Settings exported" });
        } catch (e) {
            this.setState({ dataMsg: `Export failed: ${String(e)}` });
        }
    }

    private async retryPlugin(name: string): Promise<void> {
        try {
            if (Api.Plugins.isEnabled(name)) await Api.Plugins.restart(name);
            else await Api.Plugins.enable(name);
            this.setState({ dataMsg: `${name}: retry succeeded` });
        } catch (e) {
            this.setState({ dataMsg: `${name}: retry failed — ${String(e)}` });
        }
    }

    private async importSettings(file: File): Promise<void> {
        const b = this.bridge();
        if (!b) return this.setState({ dataMsg: "Bridge unavailable" });
        this.setState({ importing: true, dataMsg: "Importing…" });
        try {
            const text = await file.text();
            const imported = JSON.parse(text) as Record<string, unknown>;
            if (typeof imported !== "object" || imported === null || Array.isArray(imported)) {
                throw new Error("not a settings object");
            }
            const current =
                ((await b.invoke("settings-get")) as Record<string, unknown>) ?? {};
            // Shallow merge: imported top-level keys win, the rest are kept.
            await b.invoke("settings-save", { ...current, ...imported });
            this.setState({ dataMsg: "Settings imported — reload Discord to apply" });
        } catch (e) {
            this.setState({ dataMsg: `Import failed: ${String(e)}` });
        } finally {
            this.setState({ importing: false });
        }
    }

    componentDidMount(): void {
        ensurePluginsCss();
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
        const failedCount = Api.Plugins.getFailures().length;
        const stats: [string, string][] = [
            ["Framework", `v${Api.version}`],
            ["Discord", String(info?.discord ?? "unknown")],
            ["Host", "Electron"],
            ["Plugins", `${enabledCount} enabled / ${pluginCount}`],
            ...(failedCount > 0
                ? ([["Failed plugins", String(failedCount)]] as [string, string][])
                : []),
            [
                "Theme",
                Themes.enabled.length === 0
                    ? "None"
                    : Themes.enabled.length === 1
                      ? (Themes.enabled[0] ?? "")
                      : `${Themes.enabled.length} enabled`,
            ],
        ];

        return h(
        "div",
        { style: S.page },
        h("h2", { style: S.h2 }, "Monocord"),
        h(
            "div",
            { className: "mc-grid" },
            stats.map(([label, value]) =>
                h(
                    "div",
                    { key: label, className: "mc-card" },
                    h("div", { className: "mc-author" }, label),
                    h("div", { className: "mc-name", style: { fontSize: 18 } }, value),
                ),
            ),
        ),
        failedCount > 0
            ? h(
                  "div",
                  { className: "mc-card", style: { marginTop: 12 } },
                  h("div", { className: "mc-name" }, "Failed plugins"),
                  h(
                      "div",
                      { className: "mc-desc", style: { minHeight: 0, opacity: 1, marginTop: 8 } },
                      "These plugins threw during their last start/stop. Retry re-runs the lifecycle.",
                  ),
                  h(
                      "div",
                      { className: "mc-keys", style: { marginTop: 10 } },
                      Api.Plugins.getFailures().map((n) =>
                          h(
                              "button",
                              {
                                  key: n,
                                  className: "mc-chip",
                                  onClick: () => void this.retryPlugin(n),
                              },
                              `Retry ${n}`,
                          ),
                      ),
                  ),
              )
            : null,
        h(
            "div",
            { className: "mc-card", style: { marginTop: 12 } },
            h(
                "div",
                { className: "mc-desc", style: { minHeight: 0, opacity: 1 } },
                "Monocord is a Vencord-inspired modification framework. Manage plugins from the Plugins tab and themes from the Themes tab.",
            ),
        ),
        h(
            "div",
            { className: "mc-card", style: { marginTop: 12 } },
            h(
                "div",
                { className: "mc-head" },
                h("div", { className: "mc-name" }, "Debug info"),
                h(
                    "button",
                    {
                        className: "mc-chip",
                        onClick: () => {
                            const text = [
                                `Monocord v${Api.version}`,
                                `Discord: ${String(info?.discord ?? "unknown")}`,
                                `Host: Electron`,
                                `Plugins: ${enabledCount} enabled / ${pluginCount}`,
                                `Failed: ${failedCount}`,
                                `Themes: ${Themes.enabled.join(", ") || "none"}`,
                                `UA: ${navigator.userAgent}`,
                            ].join("\n");
                            void navigator.clipboard?.writeText(text);
                            this.setState({ dataMsg: "Debug info copied" });
                        },
                    },
                    "Copy",
                ),
            ),
            h(
                "div",
                { className: "mc-desc", style: { minHeight: 0, opacity: 1, marginTop: 8 } },
                "Copies framework version, Discord build, plugin/theme counts and user agent — useful for bug reports.",
            ),
            this.state.dataMsg
                ? h(
                      "div",
                      { className: "mc-desc", style: { minHeight: 0, opacity: 1, marginTop: 8 } },
                      this.state.dataMsg,
                  )
                : null,
        ),
        h(
            "div",
            { className: "mc-card", style: { marginTop: 12 } },
            h("div", { className: "mc-name" }, "Settings data"),
            h(
                "div",
                { className: "mc-desc", style: { minHeight: 0, opacity: 1, marginTop: 8 } },
                "Export downloads your plugin/theme/CSS settings as JSON. Import merges a previously exported file (imported keys win).",
            ),
            h(
                "div",
                { className: "mc-keys", style: { marginTop: 10 } },
                h(
                    "button",
                    {
                        className: "mc-chip",
                        onClick: () => void this.exportSettings(),
                    },
                    "Export settings",
                ),
                h(
                    "button",
                    {
                        className: "mc-chip",
                        disabled: this.state.importing,
                        onClick: () => {
                            const input = document.createElement("input");
                            input.type = "file";
                            input.accept = "application/json,.json";
                            input.onchange = () => {
                                const f = input.files?.[0];
                                if (f) void this.importSettings(f);
                            };
                            input.click();
                        },
                    },
                    this.state.importing ? "Importing…" : "Import settings",
                ),
            ),
            this.state.dataMsg
                ? h(
                      "div",
                      { className: "mc-desc", style: { minHeight: 0, opacity: 1, marginTop: 8 } },
                      this.state.dataMsg,
                  )
                : null,
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

const PLUGINS_CSS = `
.mc-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));}
.mc-card{background:var(--card-background-default,var(--background-secondary,#2b2d31));border:1px solid var(--border-subtle,rgba(255,255,255,.06));border-radius:8px;padding:12px 14px;transition:transform .1s ease,box-shadow .1s ease,border-color .1s ease;box-sizing:border-box;}
.mc-card:hover{transform:translateY(-1px);box-shadow:0 8px 16px rgba(0,0,0,.28);border-color:var(--border-subtle,#3f4147);}
.mc-card-off{opacity:.55;}
.mc-card-off:hover{opacity:.8;}
.mc-name{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px;min-width:0;}
.mc-ver{font-size:11px;color:var(--text-muted,#949ba4);font-weight:400;flex-shrink:0;}
.mc-author{font-size:12px;color:var(--text-muted,#949ba4);margin-top:2px;}
.mc-desc{margin-top:8px;font-size:12px;line-height:16px;color:var(--text-normal,#dbdee1);opacity:.75;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:32px;}
.mc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.mc-head-l{display:flex;align-items:center;gap:6px;min-width:0;flex:1;}
.mc-icon-btn{background:transparent;border:none;color:var(--icon-muted,#80848e);cursor:pointer;font-size:15px;padding:4px;border-radius:4px;line-height:1;flex-shrink:0;}
.mc-icon-btn:hover{color:var(--interactive-icon-hover,#dbdee1);background:var(--background-modifier-hover,rgba(78,80,88,.35));}
.mc-back{background:transparent;border:none;color:var(--brand-500,#5865f2);cursor:pointer;font-size:13px;padding:4px 0;margin-bottom:8px;}
.mc-back:hover{text-decoration:underline;}
.mc-detail{max-width:680px;}
.mc-toggle{position:relative;width:38px;height:22px;border-radius:11px;border:none;cursor:pointer;padding:0;flex-shrink:0;background:var(--background-modifier-accent,#4e5058);transition:background .15s;}
.mc-toggle.on{background:var(--status-positive,#23a55a);}
.mc-toggle>span{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.4);}
.mc-toggle.on>span{left:18px;}
.mc-filters{display:flex;gap:8px;margin:10px 0 14px;align-items:center;}
.mc-chip{background:var(--background-secondary,#2b2d31);border:1px solid var(--background-modifier-accent,#3f4147);color:var(--text-normal,#dbdee1);border-radius:16px;padding:5px 14px;font-size:13px;cursor:pointer;transition:background .12s,border-color .12s,color .12s;}
.mc-chip:hover{border-color:var(--brand-500,#5865f2);}
.mc-chip.on{background:var(--brand-500,#5865f2);border-color:var(--brand-500,#5865f2);color:#fff;}
.mc-chip .mc-count{opacity:.65;font-size:11px;margin-left:4px;}
.mc-card-link{cursor:pointer;}
.mc-card-link:focus-visible{outline:2px solid var(--brand-500,#5865f2);outline-offset:2px;}
.mc-status{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;}
.mc-status.on{background:var(--status-positive,#23a55a);box-shadow:0 0 6px rgba(35,165,90,.55);}
.mc-status.warn{background:var(--status-warning,#f0b232);}
.mc-status.off{background:var(--background-modifier-accent,#4e5058);}
.mc-warn{background:var(--background-warning-solid,#59421e);border:1px solid var(--status-warning,#f0b232);border-radius:8px;padding:12px 14px;margin-bottom:12px;font-size:13px;line-height:18px;color:var(--text-normal,#dbdee1);}
.mc-warn code{background:rgba(0,0,0,.25);border-radius:3px;padding:0 4px;font-family:var(--font-code,monospace);font-size:12px;}
.mc-keys{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;}
.mc-key{font-size:11px;color:var(--text-muted,#949ba4);border:1px solid var(--border-subtle,rgba(255,255,255,.08));border-radius:4px;padding:2px 6px;font-family:var(--font-code,monospace);}
`;

let pluginsCssInjected = false;
function ensurePluginsCss(): void {
    if (pluginsCssInjected) return;
    pluginsCssInjected = true;
    Api.Themes.injectCss("monocord-plugins-ui", PLUGINS_CSS);
}

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
    override state: {
        rev: number;
        drafts: Record<string, string>;
        errors: Record<string, string>;
        values: Record<string, Record<string, unknown>>;
        query: string;
        filter: "all" | "on" | "off";
        detail: string | null;
    } = {
        rev: 0,
        drafts: {},
        errors: {},
        values: {},
        query: "",
        filter: "all",
        detail: null,
    };
    private offs: (() => void)[] = [];

    componentDidMount(): void {
        ensurePluginsCss();
        this.offs = PLUGIN_EVENTS.map((e) =>
            Events.on(e, () => this.setState({ rev: this.state.rev + 1 })),
        );
    }

    componentWillUnmount(): void {
        this.offs.forEach((off) => off());
        this.offs = [];
        // Flush debounced setting writes so the last keystrokes aren't lost.
        for (const [tkey, timer] of this.persistTimers) {
            clearTimeout(timer);
            const dot = tkey.indexOf(".");
            const name = tkey.slice(0, dot);
            const key = tkey.slice(dot + 1);
            const value = this.state.values[name]?.[key];
            if (value !== undefined) {
                void Settings.set(`plugins.settings.${name}.${key}`, value).catch(
                    () => {},
                );
            }
        }
        this.persistTimers.clear();
    }

    private settingKeys(plugin: Plugin): string[] {
        return plugin.settings ? Object.keys(plugin.settings) : [];
    }

    private async loadDraft(name: string, plugin: Plugin): Promise<void> {
        const values: Record<string, unknown> = {};
        for (const key of this.settingKeys(plugin)) {
            const v = await Settings.get(
                `plugins.settings.${name}.${key}`,
                plugin.settings?.[key],
            );
            values[key] = v ?? plugin.settings?.[key];
        }
        this.setState({
            drafts: {
                ...this.state.drafts,
                [name]: JSON.stringify(values, null, 2),
            },
            errors: { ...this.state.errors, [name]: "" },
            values: { ...this.state.values, [name]: values },
        });
    }

    // Debounce settings.json writes — custom views (e.g. CustomRPC) call
    // set() per keystroke, and each write is a full-document IPC save.
    private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

    private setSetting(
        name: string,
        key: string,
        value: unknown,
        plugin: Plugin,
    ): void {
        const cur = this.state.values[name] ?? {};
        this.setState({
            values: { ...this.state.values, [name]: { ...cur, [key]: value } },
        });
        const tkey = `${name}.${key}`;
        const prev = this.persistTimers.get(tkey);
        if (prev) clearTimeout(prev);
        this.persistTimers.set(
            tkey,
            setTimeout(() => {
                this.persistTimers.delete(tkey);
                void Settings.set(`plugins.settings.${name}.${key}`, value).catch(
                    (e) => log.error(`settings set ${name}.${key} failed`, e),
                );
            }, 400),
        );
    }

    private renderField(
        name: string,
        plugin: Plugin,
        key: string,
        field: NonNullable<Plugin["settingsSchema"]>[string],
    ): unknown {
        const value = this.state.values[name]?.[key] ?? plugin.settings?.[key];
        const set = (v: unknown) => this.setSetting(name, key, v, plugin);
        const label = field.label ?? key;
        const common = { disabled: !Api.Plugins.isEnabled(name) };

        let control: unknown;
        switch (field.type) {
            case "boolean":
                control = h(
                    "button",
                    {
                        role: "switch",
                        "aria-checked": value === true,
                        disabled: common.disabled,
                        onClick: () => set(value !== true),
                        style: {
                            position: "relative",
                            width: 40,
                            height: 22,
                            borderRadius: 11,
                            border: "none",
                            cursor: common.disabled ? "default" : "pointer",
                            padding: 0,
                            flexShrink: 0,
                            background:
                                value === true
                                    ? "var(--status-positive, #23a55a)"
                                    : "var(--background-modifier-accent, #4e5058)",
                            transition: "background .15s",
                        },
                    },
                    h("span", {
                        style: {
                            position: "absolute",
                            top: 2,
                            left: value === true ? 20 : 2,
                            width: 18,
                            height: 18,
                            borderRadius: "50%",
                            background: "#fff",
                            transition: "left .15s",
                            boxShadow: "0 1px 3px rgba(0,0,0,.4)",
                        },
                    }),
                );
                break;
            case "select":
                control = h(
                    "select",
                    {
                        ...common,
                        value: String(value ?? ""),
                        onChange: (e: { target: { value: string } }) =>
                            set(e.target.value),
                        style: { ...S.input, width: "auto", minWidth: 140 },
                    },
                    (field.options ?? []).map((o) =>
                        h("option", { key: o.value, value: o.value }, o.label),
                    ),
                );
                break;
            case "number":
                control = h("input", {
                    ...common,
                    type: "number",
                    value: value == null ? "" : String(value),
                    placeholder: field.placeholder,
                    onChange: (e: { target: { value: string } }) =>
                        set(e.target.value === "" ? null : Number(e.target.value)),
                    style: { ...S.input, width: 90 },
                });
                break;
            case "textarea":
                control = h("textarea", {
                    ...common,
                    value: String(value ?? ""),
                    placeholder: field.placeholder,
                    onChange: (e: { target: { value: string } }) => set(e.target.value),
                    style: { ...S.input, minHeight: 64, resize: "vertical" },
                });
                break;
            default:
                control = h("input", {
                    ...common,
                    type: "text",
                    value: String(value ?? ""),
                    placeholder: field.placeholder,
                    onChange: (e: { target: { value: string } }) => set(e.target.value),
                    style: S.input,
                });
        }

        return h(
            "div",
            { key, style: { marginTop: 10 } },
            h(
                "div",
                { style: { ...S.row, alignItems: "flex-start" } },
                h(
                    "label",
                    { style: { fontSize: 13, fontWeight: 500, flex: "0 0 160px" } },
                    label,
                ),
                h("div", { style: { flex: 1, minWidth: 0 } }, control),
            ),
            field.description
                ? h("div", { style: { ...S.muted, marginTop: 3, marginLeft: 172 } }, field.description)
                : null,
        );
    }

    private saveSettings(name: string, plugin: Plugin): void {
        const raw = this.state.drafts[name] ?? "";
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch (e) {
            this.setState({
                errors: {
                    ...this.state.errors,
                    [name]: `Invalid JSON: ${String(e)}`,
                },
            });
            return;
        }
        void (async () => {
            for (const key of this.settingKeys(plugin)) {
                if (key in parsed) {
                    await Settings.set(
                        `plugins.settings.${name}.${key}`,
                        parsed[key],
                    );
                }
            }
            this.setState({
                errors: { ...this.state.errors, [name]: "" },
                drafts: { ...this.state.drafts, [name]: "" },
            });
            void this.loadDraft(name, plugin);
        })();
    }

    private openDetail(name: string, plugin: Plugin): void {
        this.setState({ detail: name });
        if (!this.state.values[name] && !this.state.drafts[name]) {
            void this.loadDraft(name, plugin);
        }
    }

    private togglePlugin(name: string, enabled: boolean): void {
        const p = enabled
            ? Api.Plugins.disable(name)
            : Api.Plugins.enable(name);
        void p.catch((e) => log.error(`toggle ${name} failed`, e));
    }

    private resetSettings(name: string, plugin: Plugin): void {
        void Settings.delete(`plugins.settings.${name}`)
            .catch((e) => log.error(`reset settings ${name} failed`, e))
            .then(() => {
                const values = { ...this.state.values };
                const drafts = { ...this.state.drafts };
                const errors = { ...this.state.errors };
                delete values[name];
                delete drafts[name];
                delete errors[name];
                this.setState({ values, drafts, errors });
                void this.loadDraft(name, plugin);
            });
    }

    private async toggleAll(enable: boolean): Promise<void> {
        for (const name of Api.Plugins.names()) {
            if (name === "MonocordSettings") continue;
            const op = enable
                ? Api.Plugins.isEnabled(name)
                    ? Promise.resolve()
                    : Api.Plugins.enable(name)
                : Api.Plugins.isEnabled(name)
                  ? Api.Plugins.disable(name)
                  : Promise.resolve();
            await op.catch((e) => log.error(`toggle ${name} failed`, e));
        }
        this.forceUpdate();
    }

    private exportPluginList(): void {
        const enabled = Api.Plugins.names().filter(
            (n) => n !== "MonocordSettings" && Api.Plugins.isEnabled(n),
        );
        const blob = new Blob([JSON.stringify({ enabled }, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "monocord-plugins.json";
        a.click();
        URL.revokeObjectURL(url);
    }

    private async importPluginList(file: File): Promise<void> {
        try {
            const doc = JSON.parse(await file.text()) as { enabled?: unknown };
            if (!Array.isArray(doc.enabled)) throw new Error("missing enabled array");
            const wanted = new Set(doc.enabled.filter((x): x is string => typeof x === "string"));
            for (const name of Api.Plugins.names()) {
                if (name === "MonocordSettings") continue;
                const should = wanted.has(name);
                const op = should
                    ? Api.Plugins.isEnabled(name)
                        ? Promise.resolve()
                        : Api.Plugins.enable(name)
                    : Api.Plugins.isEnabled(name)
                      ? Api.Plugins.disable(name)
                      : Promise.resolve();
                await op.catch((e) => log.error(`import ${name} failed`, e));
            }
        } catch (e) {
            log.error("plugin list import failed", e);
        }
        this.forceUpdate();
    }

    private renderToggle(name: string, enabled: boolean): unknown {
        return h(
            "button",
            {
                className: `mc-toggle${enabled ? " on" : ""}`,
                role: "switch",
                "aria-checked": enabled,
                title: enabled ? "Disable" : "Enable",
                onClick: (e: { stopPropagation?: () => void }) => {
                    e.stopPropagation?.();
                    this.togglePlugin(name, enabled);
                },
            },
            h("span", null),
        );
    }

    private renderSettingsBody(name: string, plugin: Plugin): unknown {
        const { drafts, errors } = this.state;
        if (plugin.settingsView) {
            const ctx = {
                h,
                values: this.state.values[name] ?? {},
                set: (key: string, value: unknown) =>
                    this.setSetting(name, key, value, plugin),
                enabled: Api.Plugins.isEnabled(name),
            };
            return h(
                "div",
                { style: { marginTop: 14 } },
                plugin.settingsView(ctx),
                // Escape hatch: raw JSON editor for power users.
                h(
                    "details",
                    { style: { marginTop: 14 } },
                    h("summary", { style: S.muted }, "Advanced: raw JSON"),
                    h("textarea", {
                        style: {
                            ...S.input,
                            minHeight: 120,
                            resize: "vertical",
                            marginTop: 8,
                        },
                        value: drafts[name] ?? "",
                        placeholder: "{}",
                        onChange: (e: { target: { value: string } }) =>
                            this.setState({
                                drafts: {
                                    ...this.state.drafts,
                                    [name]: e.target.value,
                                },
                            }),
                    }),
                    h(
                        "div",
                        {
                            style: {
                                ...S.row,
                                marginTop: 8,
                                justifyContent: "flex-start",
                            },
                        },
                        h(
                            "button",
                            {
                                style: S.btnOff,
                                onClick: () => this.saveSettings(name, plugin),
                            },
                            "Save JSON",
                        ),
                    ),
                ),
            );
        }
        if (plugin.settingsSchema) {
            return h(
                "div",
                { style: { marginTop: 14, paddingLeft: 4 } },
                Object.entries(plugin.settingsSchema).map(([key, field]) =>
                    this.renderField(name, plugin, key, field),
                ),
                errors[name]
                    ? h(
                          "div",
                          {
                              style: {
                                  ...S.muted,
                                  color: "var(--status-danger,#f23f43)",
                                  marginTop: 6,
                              },
                          },
                          errors[name],
                      )
                    : null,
            );
        }
        return h(
            "div",
            { style: { marginTop: 14 } },
            h("textarea", {
                style: { ...S.input, minHeight: 140, resize: "vertical" },
                value: drafts[name] ?? "",
                placeholder: "{}",
                onChange: (e: { target: { value: string } }) =>
                    this.setState({
                        drafts: { ...this.state.drafts, [name]: e.target.value },
                    }),
            }),
            h(
                "div",
                {
                    style: {
                        ...S.row,
                        marginTop: 8,
                        justifyContent: "flex-start",
                    },
                },
                h(
                    "button",
                    {
                        style: S.btn,
                        onClick: () => this.saveSettings(name, plugin),
                    },
                    "Save settings",
                ),
                errors[name]
                    ? h(
                          "span",
                          {
                              style: {
                                  ...S.muted,
                                  color: "var(--status-danger,#f23f43)",
                              },
                          },
                          errors[name],
                      )
                    : null,
            ),
        );
    }

    private renderDetail(name: string, plugin: Plugin, enabled: boolean): unknown {
        const hasSettings = this.settingKeys(plugin).length > 0;
        return h(
            "div",
            { className: "mc-detail" },
            h(
                "button",
                { className: "mc-back", onClick: () => this.setState({ detail: null }) },
                "← All plugins",
            ),
            h(
                "div",
                { className: `mc-card${enabled ? "" : " mc-card-off"}` },
                h(
                    "div",
                    { className: "mc-head" },
                    h(
                        "div",
                        { className: "mc-head-l" },
                        statusDot(enabled, Api.Plugins.isRunning(name)),
                        h(
                            "div",
                            null,
                            h(
                                "div",
                                { className: "mc-name" },
                                name,
                                plugin.version
                                    ? h("span", { className: "mc-ver" }, `v${plugin.version}`)
                                    : null,
                            ),
                            plugin.authors?.length
                                ? h(
                                      "div",
                                      { className: "mc-author" },
                                      `by ${plugin.authors.join(", ")}`,
                                  )
                                : null,
                        ),
                    ),
                    this.renderToggle(name, enabled),
                ),
                h("div", { className: "mc-desc", style: { minHeight: 0 } },
                    plugin.description ?? "No description"),
            ),
            hasSettings
                ? h(
                      "div",
                      { className: "mc-card", style: { marginTop: 12 } },
                      h(
                          "div",
                          {
                              className: "mc-head",
                              style: { marginBottom: 8 },
                          },
                          h(
                              "div",
                              { className: "mc-name", style: { fontSize: 14 } },
                              "Settings",
                          ),
                          h(
                              "button",
                              {
                                  className: "mc-chip",
                                  title: "Delete all saved settings for this plugin",
                                  onClick: () => this.resetSettings(name, plugin),
                              },
                              "Reset",
                          ),
                      ),
                      this.renderSettingsBody(name, plugin),
                  )
                : null,
        );
    }

    override render(): unknown {
        const { query, filter, detail } = this.state;

        const detailRow = detail
            ? pluginRows().find((r) => r.name === detail)
            : undefined;
        if (detailRow) {
            return h(
                "div",
                { style: S.page },
                h("h2", { style: S.h2 }, "Plugins"),
                this.renderDetail(detailRow.name, detailRow.plugin, detailRow.enabled),
            );
        }

        const q = query.trim().toLowerCase();
        const rows = pluginRows()
            .filter(({ name, plugin, enabled }) => {
                if (filter === "on" && !enabled) return false;
                if (filter === "off" && enabled) return false;
                if (!q) return true;
                if (
                    name.toLowerCase().includes(q) ||
                    name.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`).includes(q) ||
                    (plugin.description ?? "").toLowerCase().includes(q)
                ) {
                    return true;
                }
                if (!plugin.settingsSchema) return false;
                return Object.entries(plugin.settingsSchema).some(
                    ([key, field]) =>
                        key.toLowerCase().includes(q) ||
                        (field.label ?? "").toLowerCase().includes(q) ||
                        (field.description ?? "").toLowerCase().includes(q),
                );
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        const all = pluginRows();
        const counts: Record<typeof filter, number> = {
            all: all.length,
            on: all.filter((r) => r.enabled).length,
            off: all.filter((r) => !r.enabled).length,
        };
        const chips: [typeof filter, string][] = [
            ["all", "All"],
            ["on", "Enabled"],
            ["off", "Disabled"],
        ];

        return h(
            "div",
            { style: S.page },
            h("h2", { style: S.h2 }, "Plugins"),
            h("div", { style: { ...S.muted, marginBottom: 10 } },
                `${pluginRows().length} plugins · click a card for details & settings`),
            h("input", {
                style: S.input,
                placeholder: "Search plugins…",
                value: query,
                onChange: (e: { target: { value: string } }) =>
                    this.setState({ query: e.target.value }),
            }),
            h(
                "div",
                { className: "mc-filters" },
                chips.map(([value, label]) =>
                    h(
                        "button",
                        {
                            key: value,
                            className: `mc-chip${filter === value ? " on" : ""}`,
                            onClick: () => this.setState({ filter: value }),
                        },
                        label,
                        h("span", { className: "mc-count" }, String(counts[value])),
                    ),
                ),
                h(
                    "span",
                    { style: { flex: 1 } },
                ),
                h(
                    "button",
                    {
                        className: "mc-chip",
                        title: "Enable every plugin (except the settings UI)",
                        onClick: () => void this.toggleAll(true),
                    },
                    "Enable all",
                ),
                h(
                    "button",
                    {
                        className: "mc-chip",
                        title: "Disable every plugin (except the settings UI)",
                        onClick: () => void this.toggleAll(false),
                    },
                    "Disable all",
                ),
                h(
                    "button",
                    {
                        className: "mc-chip",
                        title: "Download the list of enabled plugins as JSON",
                        onClick: () => this.exportPluginList(),
                    },
                    "Export",
                ),
                h(
                    "button",
                    {
                        className: "mc-chip",
                        title: "Apply an exported plugin list (enables/disables to match)",
                        onClick: () => {
                            const input = document.createElement("input");
                            input.type = "file";
                            input.accept = "application/json,.json";
                            input.onchange = () => {
                                const f = input.files?.[0];
                                if (f) void this.importPluginList(f);
                            };
                            input.click();
                        },
                    },
                    "Import",
                ),
            ),
            rows.length === 0
                ? h("div", { style: S.muted }, "No plugins match.")
                : h(
                      "div",
                      { className: "mc-grid" },
                      rows.map(({ name, plugin, enabled, running }) =>
                          h(
                              "div",
                              {
                                  key: name,
                                  className: `mc-card mc-card-link${enabled ? "" : " mc-card-off"}`,
                                  role: "button",
                                  tabIndex: 0,
                                  title: plugin.description ?? name,
                                  onClick: () => this.openDetail(name, plugin),
                                  onKeyDown: (e: {
                                      key: string;
                                      preventDefault?: () => void;
                                  }) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault?.();
                                          this.openDetail(name, plugin);
                                      }
                                  },
                              },
                              h(
                                  "div",
                                  { className: "mc-head" },
                                  h(
                                      "div",
                                      { className: "mc-head-l" },
                                      statusDot(enabled, running),
                                      h(
                                          "div",
                                          null,
                                          h(
                                              "div",
                                              { className: "mc-name" },
                                              name,
                                              plugin.version
                                                  ? h("span", { className: "mc-ver" }, `v${plugin.version}`)
                                                  : null,
                                          ),
                                          plugin.authors?.length
                                              ? h(
                                                    "div",
                                                    { className: "mc-author" },
                                                    `by ${plugin.authors.join(", ")}`,
                                                )
                                              : null,
                                      ),
                                  ),
                                  this.renderToggle(name, enabled),
                              ),
                              h(
                                  "div",
                                  { className: "mc-desc" },
                                  plugin.description ?? "No description",
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
    enabled: string[];
    quickCss: boolean;
    customCss: string;
    saved: boolean;
    wallpaper: string | null;
    wallpaperBusy: boolean;
}

export class ThemesPanel extends PanelBase {
    override state: ThemesState = {
        themes: null,
        enabled: [...Themes.enabled],
        quickCss: Themes.quickCss,
        customCss: "",
        saved: false,
        wallpaper: Themes.wallpaperUrl,
        wallpaperBusy: false,
    };
    private offs: (() => void)[] = [];
    private wallpaperInput: HTMLInputElement | null = null;

    componentDidMount(): void {
        ensurePluginsCss();
        void Themes.list().then((themes) => this.setState({ themes }));
        void Settings.get<string>("theme.customCss", "").then((v) =>
            this.setState({ customCss: v ?? "" }),
        );
        void Themes.refreshWallpaper().then(() =>
            this.setState({ wallpaper: Themes.wallpaperUrl }),
        );
        this.offs = [
            Events.on("theme.changed", () =>
                this.setState({
                    enabled: [...Themes.enabled],
                    wallpaper: Themes.wallpaperUrl,
                }),
            ),
            Events.on("settings.changed", () => this.setState({ saved: false })),
        ];
    }

    private pickWallpaper(): void {
        if (this.wallpaperInput) {
            this.wallpaperInput.value = "";
            this.wallpaperInput.click();
            return;
        }
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/gif,image/webp,image/avif";
        input.style.display = "none";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            this.setState({ wallpaperBusy: true });
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = String(reader.result ?? "");
                void Themes.setWallpaper(dataUrl)
                    .then((name) => {
                        this.setState({
                            wallpaper: Themes.wallpaperUrl,
                            wallpaperBusy: false,
                        });
                        if (!name) log.warn("wallpaper upload rejected");
                    })
                    .catch((e) => {
                        log.error("wallpaper upload failed", e);
                        this.setState({ wallpaperBusy: false });
                    });
            };
            reader.onerror = () => this.setState({ wallpaperBusy: false });
            reader.readAsDataURL(file);
        };
        document.body.appendChild(input);
        this.wallpaperInput = input;
        input.click();
    }

    componentWillUnmount(): void {
        this.offs.forEach((off) => off());
        this.offs = [];
        this.wallpaperInput?.remove();
        this.wallpaperInput = null;
    }

    private renderThemeToggle(name: string, isEnabled: boolean): unknown {
        return h(
            "button",
            {
                className: `mc-toggle${isEnabled ? " on" : ""}`,
                role: "switch",
                "aria-checked": isEnabled,
                title: isEnabled ? "Disable theme" : "Enable theme",
                onClick: () =>
                    void Themes.toggle(name)
                        .then(() => this.setState({ enabled: [...Themes.enabled] }))
                        .catch((e) => log.error("theme toggle failed", e)),
            },
            h("span", null),
        );
    }

    override render(): unknown {
        const { themes, enabled, quickCss, customCss, saved, wallpaper, wallpaperBusy } =
            this.state;
        const setCustomCss = (v: string) => this.setState({ customCss: v });

    return h(
        "div",
        { style: S.page },
        h(
            "div",
            {
                style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                },
            },
            h("h2", { style: S.h2 }, "Themes"),
            enabled.length > 0
                ? h(
                      "button",
                      {
                          className: "mc-chip",
                          title: "Disable every enabled theme",
                          onClick: () => {
                              Themes.clear();
                              void Settings.set("theme.enabled", []).catch(
                                  () => {},
                              );
                              this.setState({ enabled: [] });
                          },
                      },
                      "Clear all",
                  )
                : null,
        ),
        h(
            "div",
            { className: "mc-warn" },
            h("strong", null, "Theme performance: "),
            "Themes and custom CSS can cause lag. The most common cause is the ",
            h("code", null, ":has()"),
            " operator — avoid it in custom CSS and poorly-written themes.",
        ),
        h(
            "div",
            { className: "mc-grid" },
            themes === null
                ? h("div", { style: S.muted }, "Loading…")
                : themes.length === 0
                  ? h("div", { style: S.muted }, "No themes installed.")
                  : themes.map((t) => {
                        const isEnabled = enabled.includes(t.name);
                        return h(
                            "div",
                            {
                                key: t.name,
                                className: `mc-card${isEnabled ? "" : " mc-card-off"}`,
                            },
                            h(
                                "div",
                                { className: "mc-head" },
                                h(
                                    "div",
                                    { className: "mc-head-l" },
                                    statusDot(isEnabled, isEnabled),
                                    h(
                                        "div",
                                        null,
                                        h(
                                            "div",
                                            { className: "mc-name" },
                                            t.label ?? t.name,
                                            t.version
                                                ? h("span", { className: "mc-ver" }, `v${t.version}`)
                                                : null,
                                        ),
                                        t.authors?.length
                                            ? h(
                                                  "div",
                                                  { className: "mc-author" },
                                                  `by ${t.authors.join(", ")}`,
                                              )
                                            : null,
                                    ),
                                ),
                                this.renderThemeToggle(t.name, isEnabled),
                            ),
                            h(
                                "div",
                                { className: "mc-desc", style: { minHeight: 0 } },
                                t.description ?? t.name,
                            ),
                        );
                    }),
        ),
        h(
            "div",
            { className: "mc-card", style: { marginTop: 16 } },
            h(
                "div",
                { className: "mc-head", style: { marginBottom: 8 } },
                h("div", { className: "mc-name", style: { fontSize: 14 } }, "Wallpaper"),
                h(
                    "div",
                    { className: "mc-head-l" },
                    wallpaper
                        ? h(
                              "button",
                              {
                                  style: S.btn,
                                  onClick: () =>
                                      void Themes.clearWallpaper().then(() =>
                                          this.setState({ wallpaper: null }),
                                      ),
                              },
                              "Remove",
                          )
                        : null,
                    h(
                        "button",
                        {
                            style: S.btn,
                            disabled: wallpaperBusy,
                            onClick: () => this.pickWallpaper(),
                        },
                        wallpaperBusy ? "Uploading…" : wallpaper ? "Replace" : "Upload image",
                    ),
                ),
            ),
            h(
                "div",
                {
                    style: {
                        height: 90,
                        borderRadius: 8,
                        background: wallpaper
                            ? `url("${wallpaper}") center/cover no-repeat, var(--background-secondary, #1e1f22)`
                            : "var(--background-secondary, #1e1f22)",
                        border: "1px solid var(--background-modifier-accent, rgba(255,255,255,.08))",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--text-muted, #949ba4)",
                        fontSize: 12,
                        marginBottom: 6,
                    },
                },
                wallpaper ? null : "No wallpaper — used by transparent themes like Glass",
            ),
            h(
                "div",
                { className: "mc-desc", style: { minHeight: 0 } },
                "Shown behind transparent themes (e.g. Glass) as --monocord-wallpaper. PNG, JPG, GIF, WebP or AVIF up to 15 MB.",
            ),
        ),
        h(
            "div",
            { className: "mc-card", style: { marginTop: 16 } },
            h(
                "div",
                { className: "mc-head", style: { marginBottom: 8 } },
                h("div", { className: "mc-name", style: { fontSize: 14 } }, "Custom CSS"),
                h(
                    "div",
                    { className: "mc-head-l" },
                    h(
                        "button",
                        {
                            className: `mc-toggle${quickCss ? " on" : ""}`,
                            role: "switch",
                            "aria-checked": quickCss,
                            title: quickCss ? "Disable custom CSS" : "Enable custom CSS",
                            onClick: () => {
                                const next = !quickCss;
                                this.setState({ quickCss: next });
                                void Themes.setQuickCssEnabled(next);
                            },
                        },
                        h("span", null),
                    ),
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
            ),
            h("textarea", {
                style: { ...S.input, minHeight: 140, resize: "vertical" },
                value: customCss,
                placeholder: "/* custom css */",
                onChange: (e: { target: { value: string } }) =>
                    setCustomCss(e.target.value),
            }),
            h(
                "div",
                { className: "mc-desc", style: { minHeight: 0, marginTop: 6 } },
                `${customCss.split("\n").length} lines · ${customCss.length} chars · saved instantly on Save`,
            ),
        ),
        );
    }
}
