/**
 * CustomRPC — sets a Discord Rich Presence activity through the desktop
 * IPC pipe, attributed to a Discord application id the user supplies.
 *
 * The actual socket lives in the main process (`monocord:rpc-set` /
 * `monocord:rpc-clear`); this plugin only shuttles settings to it. Image
 * keys must exist in the application's developer portal to render.
 */

import { Api } from "../core/api";
import { Logger } from "../core/logger";
import type { Plugin } from "../core/types";

const log = Logger.get("custom-rpc");

interface Bridge {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function bridge(): Bridge {
    return (window as { monocord?: Bridge }).monocord as Bridge;
}

const KEY = "plugins.settings.CustomRPC.";
const KEYS = {
    appId: `${KEY}appId`,
    details: `${KEY}details`,
    state: `${KEY}state`,
    largeImage: `${KEY}largeImage`,
    largeText: `${KEY}largeText`,
    smallImage: `${KEY}smallImage`,
    smallText: `${KEY}smallText`,
    elapsed: `${KEY}elapsed`,
} as const;

async function pushConfig(): Promise<void> {
    const appId = ((await Api.Settings.get<string>(KEYS.appId)) ?? "").trim();
    if (!appId) {
        await bridge().invoke("rpc-clear").catch(() => {});
        return;
    }
    const config = {
        appId,
        details: await Api.Settings.get<string>(KEYS.details),
        state: await Api.Settings.get<string>(KEYS.state),
        largeImage: await Api.Settings.get<string>(KEYS.largeImage),
        largeText: await Api.Settings.get<string>(KEYS.largeText),
        smallImage: await Api.Settings.get<string>(KEYS.smallImage),
        smallText: await Api.Settings.get<string>(KEYS.smallText),
        elapsed: (await Api.Settings.get<boolean>(KEYS.elapsed)) === true,
    };
    await bridge()
        .invoke("rpc-set", config)
        .catch((e) => log.warn("failed to set rich presence", e));
}

export const CustomRPC: Plugin = {
    name: "CustomRPC",
    description:
        "Set a custom Rich Presence activity (requires a Discord application id).",
    authors: ["Monocord"],
    version: "0.1.0",
    settings: {
        appId: "",
        details: "",
        state: "",
        largeImage: "",
        largeText: "",
        smallImage: "",
        smallText: "",
        elapsed: false,
    },

    async start() {
        Api.Events.on("settings.changed", (payload) => {
            const path = (payload as { path?: unknown } | undefined)?.path;
            if (typeof path === "string" && path.startsWith(KEY)) {
                void pushConfig();
            }
        });
        await pushConfig();
    },

    stop() {
        void bridge().invoke("rpc-clear").catch(() => {});
    },
};
