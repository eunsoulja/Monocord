export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export type LogSink = (level: LogLevel, scope: string, message: string, data?: unknown) => void;

let globalLevel: LogLevel = "info";
let sink: LogSink | undefined;

/** Set the minimum level emitted by all loggers. */
export function setLogLevel(level: LogLevel): void {
    globalLevel = level;
}

/** Attach an external sink (e.g. IPC bridge to the Rust logger). */
export function setLogSink(fn: LogSink | undefined): void {
    sink = fn;
}

/** Scoped logger. `Logger.get("patcher")` etc. */
export class Logger {
    constructor(private readonly scope: string) {}

    static get(scope: string): Logger {
        return new Logger(scope);
    }

    child(name: string): Logger {
        return new Logger(`${this.scope}:${name}`);
    }

    private emit(level: LogLevel, message: string, data?: unknown): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;
        const line = `[Monocord:${this.scope}] ${message}`;
        const consoleFn =
            level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        if (data === undefined) consoleFn(line);
        else consoleFn(line, data);
        sink?.(level, this.scope, message, data);
    }

    debug(message: string, data?: unknown): void {
        this.emit("debug", message, data);
    }
    info(message: string, data?: unknown): void {
        this.emit("info", message, data);
    }
    warn(message: string, data?: unknown): void {
        this.emit("warn", message, data);
    }
    error(message: string, data?: unknown): void {
        this.emit("error", message, data);
    }
}
