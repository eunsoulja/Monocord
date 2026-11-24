/** Base error for Monocord framework failures. */
export class FrameworkError extends Error {
    /** Machine-readable error code. */
    readonly code: string;

    constructor(message: string, code: string = "FRAMEWORK_ERROR", cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "FrameworkError";
        this.code = code;
    }
}

/** Raised when a webpack module cannot be found. */
export class ModuleNotFoundError extends FrameworkError {
    constructor(what: string) {
        super(`webpack module not found: ${what}`, "MODULE_NOT_FOUND");
        this.name = "ModuleNotFoundError";
    }
}
