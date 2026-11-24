/**
 * Monocord preload — runs in every Discord window before page scripts.
 *
 * Two jobs:
 *  1. Expose a minimal IPC bridge on `window.monocord` (contextBridge).
 *  2. Execute the renderer bundle in the page's main world via
 *     `webFrame.executeJavaScript`, which bypasses page CSP.
 *
 * The renderer bundle is fetched synchronously from the main process so
 * this file stays small and needs no fs access of its own.
 */

import { contextBridge, ipcRenderer } from "electron";

/** File-based marker logging — works even if the IPC bridge fails. */
function plog(msg: string): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("fs") as typeof import("fs");
        fs.appendFileSync(
            `${process.env.APPDATA}\\Monocord\\logs\\preload.log`,
            `${new Date().toISOString()} ${msg}\n`,
        );
    } catch {
        /* ignore */
    }
}

plog(`preload start: ${location.href}`);

contextBridge.exposeInMainWorld("monocord", {
    invoke: (channel: string, ...args: unknown[]) =>
        ipcRenderer.invoke(`monocord:${channel}`, ...args),
    on: (channel: string, listener: (data: unknown) => void) => {
        const wrapped = (_e: unknown, data: unknown) => listener(data);
        ipcRenderer.on(`monocord:${channel}`, wrapped);
        return () => ipcRenderer.removeListener(`monocord:${channel}`, wrapped);
    },
    version: "0.1.0",
});

try {
    const code = ipcRenderer.sendSync("monocord:renderer-code") as string;
    plog(`renderer code fetched: ${code.length} bytes`);
    // webFrame.executeJavaScript runs in the *isolated* preload world on
    // modern Electron, where window.monocord and Discord's webpack chunks
    // are invisible. Hand the code to the main process instead —
    // webContents.executeJavaScript runs in the page's main world.
    ipcRenderer.send("monocord:execute-js", code);
    plog("execute-js sent to main process");
    // Verify the renderer→main log IPC path independently of the bundle.
    void ipcRenderer
        .invoke("monocord:log", "info", "preload", `preload alive: ${location.href}`)
        .catch(() => {});
} catch (e) {
    plog(`inject failed: ${String(e)}`);
    console.error("[Monocord] failed to inject renderer", e);
}
