/**
 * Monocord renderer entry — injected into Discord windows by the preload.
 *
 * Order: wait for webpack → wire IPC-backed settings/themes → register
 * built-in example plugins → load external plugins from the data dir →
 * start enabled plugins → restore theme → emit `framework.ready`.
 */

import { Api } from "../core/api";
import { Events } from "../core/events";
import { Logger } from "../core/logger";
import { setLogLevel, setLogSink } from "../core/logger";
import { IpcBackend, Settings, type MonocordBridge } from "../core/settings";
import { setThemeBridge, Themes } from "../core/themes";
import type { Plugin, PluginManifest, Theme } from "../core/types";
import { registerExtras } from "../plugins/extras";
import { registerExamples } from "../plugins/examples";
import { CustomRPC } from "../plugins/custom-rpc";
import { SETTINGS_PLUGIN_NAME, SettingsUIPlugin } from "../plugins/settings-ui";

const log = Logger.get("renderer");

declare global {
    interface Window {
        monocord?: MonocordBridge & { version: string };
    }
}

/** Evaluate external plugin code with the public API injected. */
function evaluatePlugin(code: string): Plugin | { default: Plugin } {
    const moduleObj = { exports: {} as Record<string, unknown> };
    const requireShim = (id: string): unknown => {
        if (id === "monocord/api" || id === "monocord") return Api;
        throw new Error(`plugin require() is not supported for "${id}"`);
    };
    const fn = new Function(
        "Monocord",
        "module",
        "exports",
        "require",
        code,
    ) as (
        api: typeof Api,
        mod: typeof moduleObj,
        exp: Record<string, unknown>,
        req: typeof requireShim,
    ) => void;
    fn(Api, moduleObj, moduleObj.exports, requireShim);
    const exported = moduleObj.exports;
    if (exported && typeof exported === "object" && "default" in exported) {
        return exported as { default: Plugin };
    }
    return exported as unknown as Plugin;
}

async function loadExternalPlugins(): Promise<void> {
    const bridge = window.monocord;
    if (!bridge) return;
    let manifests: PluginManifest[];
    try {
        manifests = (await bridge.invoke("plugins-list")) as PluginManifest[];
    } catch (e) {
        log.warn("plugins-list IPC failed", e);
        return;
    }
    for (const manifest of manifests ?? []) {
        try {
            const result = (await bridge.invoke("plugin-get", manifest.name)) as {
                code: string;
                manifest: PluginManifest;
            } | null;
            if (!result?.code) continue;
            const plugin = evaluatePlugin(result.code);
            Api.Plugins.register(plugin);
            log.info("loaded external plugin", { name: manifest.name });
        } catch (e) {
            log.error(`failed to load external plugin ${manifest.name}`, e);
            Events.emit("plugin.error", { name: manifest.name, phase: "load", error: e });
        }
    }
}

async function main(): Promise<void> {
    const bridge = window.monocord;
    if (bridge) {
        Settings.useBackend(new IpcBackend(bridge));
        setLogSink((level, scope, message) => {
            void bridge.invoke("log", level, scope, message).catch(() => {});
        });
        setThemeBridge({
            listThemes: () =>
                bridge.invoke("themes-list") as Promise<Theme[]>,
            getThemeCss: (name) =>
                bridge.invoke("theme-get", name) as Promise<string | null>,
        });
    } else {
        log.warn("no monocord bridge — running without IPC persistence");
    }
    log.info("renderer entry executing", { bridge: Boolean(bridge) });

    // Wait for Discord's webpack runtime before touching modules.
    const ready = await Api.Webpack.waitReady(60_000);
    if (!ready) {
        log.error("webpack runtime never appeared — plugins disabled");
        return;
    }

    registerExamples();
    registerExtras();
    try {
        Api.Plugins.register(CustomRPC);
    } catch (e) {
        log.warn("CustomRPC already registered", e);
    }
    try {
        Api.Plugins.register(SettingsUIPlugin);
    } catch (e) {
        log.warn("settings UI plugin already registered", e);
    }
    await loadExternalPlugins();
    await Api.Plugins.startEnabled();
    // The settings UI is framework infrastructure — always on.
    if (!Api.Plugins.isEnabled(SETTINGS_PLUGIN_NAME)) {
        await Api.Plugins.enable(SETTINGS_PLUGIN_NAME).catch((e) =>
            log.error("failed to enable settings UI", e),
        );
    }
    await Themes.restore();

    Events.emit("framework.ready", { version: Api.version });
    log.info("framework ready");
}

void main().catch((e) => log.error("renderer bootstrap failed", e));
