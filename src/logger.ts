import { existsSync, mkdirSync, statSync, renameSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type LogCategory =
    | "STARTUP"
    | "TOKEN"
    | "HTTP"
    | "RETRY"
    | "TOOL"
    | "CACHE"
    | "SHUTDOWN";

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    category: LogCategory;
    message: string;
    details?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATED_FILES = 3;

export class Logger {
    private logDir: string;
    private logFile: string;
    private minLevel: LogLevel;

    constructor(minLevel: LogLevel = "DEBUG") {
        this.logDir = join(__dirname, "..", "logs");
        this.logFile = join(this.logDir, "mcp-server.log");
        this.minLevel = minLevel;
        this.ensureLogDir();
    }

    private ensureLogDir(): void {
        try {
            if (!existsSync(this.logDir)) {
                mkdirSync(this.logDir, { recursive: true });
            }
        } catch {
            // If we can't create log dir, we'll still log to stderr
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
    }

    private rotateIfNeeded(): void {
        try {
            if (!existsSync(this.logFile)) return;

            const stats = statSync(this.logFile);
            if (stats.size < MAX_LOG_SIZE_BYTES) return;

            // Rotate: .log.2 → .log.3, .log.1 → .log.2, .log → .log.1
            for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
                const from = `${this.logFile}.${i}`;
                const to = `${this.logFile}.${i + 1}`;
                if (existsSync(from)) {
                    try {
                        renameSync(from, to);
                    } catch {
                        // Ignore rotation errors for individual files
                    }
                }
            }

            renameSync(this.logFile, `${this.logFile}.1`);
        } catch {
            // If rotation fails, continue logging to current file
        }
    }

    private writeToFile(entry: LogEntry): void {
        try {
            this.rotateIfNeeded();
            const line = JSON.stringify(entry) + "\n";
            appendFileSync(this.logFile, line, "utf8");
        } catch {
            // File write failed – stderr fallback happens in log()
        }
    }

    private writeToStderr(entry: LogEntry): void {
        const prefix = `[${entry.level}][${entry.category}]`;
        const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
        process.stderr.write(`${prefix} ${entry.message}${details}\n`);
    }

    private log(level: LogLevel, category: LogCategory, message: string, details?: Record<string, unknown>): void {
        if (!this.shouldLog(level)) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            category,
            message,
            ...(details && { details }),
        };

        // Always write to file
        this.writeToFile(entry);

        // Write WARN and ERROR to stderr (visible in MCP host logs)
        if (LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY.WARN) {
            this.writeToStderr(entry);
        }
    }

    debug(category: LogCategory, message: string, details?: Record<string, unknown>): void {
        this.log("DEBUG", category, message, details);
    }

    info(category: LogCategory, message: string, details?: Record<string, unknown>): void {
        this.log("INFO", category, message, details);
    }

    warn(category: LogCategory, message: string, details?: Record<string, unknown>): void {
        this.log("WARN", category, message, details);
    }

    error(category: LogCategory, message: string, details?: Record<string, unknown>): void {
        this.log("ERROR", category, message, details);
    }

    /** Log an error object with full stack trace.
     *  Response bodies and headers are NOT logged – they may contain personal
     *  data (customer emails in validation errors, etc.). Only safe metadata
     *  (status code, statusText) is captured.
     */
    logError(category: LogCategory, message: string, err: unknown, extraDetails?: Record<string, unknown>): void {
        const errorDetails: Record<string, unknown> = {
            ...extraDetails,
        };

        if (err instanceof Error) {
            errorDetails.errorName = err.name;
            errorDetails.errorMessage = err.message;
            errorDetails.stack = err.stack;

            // Capture ONLY safe response metadata – never the body or headers,
            // which may contain personal data echoed by the Shopware API.
            if ("response" in err) {
                const response = (err as { response: unknown }).response;
                if (response && typeof response === "object") {
                    const r = response as {
                        statusCode?: number;
                        status?: number;
                        statusText?: string;
                    };
                    errorDetails.response = {
                        statusCode: r.statusCode ?? r.status,
                        statusText: r.statusText,
                    };
                }
            }
        } else {
            errorDetails.error = String(err);
        }

        this.log("ERROR", category, message, errorDetails);
    }

    /** Get the log file path (for diagnostics) */
    getLogFilePath(): string {
        return this.logFile;
    }
}
