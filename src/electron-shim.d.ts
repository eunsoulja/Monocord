/**
 * Minimal `electron` module declarations.
 *
 * The real Electron binary is injected by Discord at runtime; we only need
 * the small surface Monocord's bootstrap/preload use. Typing it loosely
 * keeps the build free of the multi-hundred-MB electron devDependency.
 */
declare module "electron" {
    export const app: {
        getVersion(): string;
        quit(): void;
        on(event: string, listener: (...args: unknown[]) => void): void;
    };
    export const ipcMain: {
        handle(channel: string, listener: (...args: any[]) => unknown): void;
        on(channel: string, listener: (event: any, ...args: any[]) => void): void;
    };
    export const ipcRenderer: {
        invoke(channel: string, ...args: unknown[]): Promise<unknown>;
        on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
        removeListener(channel: string, listener: (...args: unknown[]) => void): void;
        sendSync(channel: string, ...args: unknown[]): unknown;
        send(channel: string, ...args: unknown[]): void;
    };
    export const contextBridge: {
        exposeInMainWorld(key: string, value: unknown): void;
    };
    export const webFrame: {
        executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    };
    export const session: Record<string, unknown>;
    export const shell: Record<string, unknown>;
    export const BrowserWindow: any;
    export const nativeTheme: Record<string, unknown>;
    const _default: {
        app: typeof app;
        ipcMain: typeof ipcMain;
        ipcRenderer: typeof ipcRenderer;
        contextBridge: typeof contextBridge;
        webFrame: typeof webFrame;
        session: typeof session;
        shell: typeof shell;
        BrowserWindow: typeof BrowserWindow;
        nativeTheme: typeof nativeTheme;
    };
    export default _default;
}
