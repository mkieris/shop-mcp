import type { HttpClient } from "@shopware-ag/app-server-sdk";
import type { Logger } from "./logger.js";

interface RetryConfig {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries: number;
    /** Base delay in ms for exponential backoff (default: 1000) */
    baseDelayMs: number;
    /** Maximum delay in ms (default: 10000) */
    maxDelayMs: number;
    /** Jitter factor 0-1 to randomize delays (default: 0.3) */
    jitterFactor: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    jitterFactor: 0.3,
};

/** HTTP methods that the proxy should intercept for retry logic */
const INTERCEPTED_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** HTTP status codes that should trigger a retry */
const RETRYABLE_STATUS_CODES = new Set([401, 408, 429, 500, 502, 503, 504]);

/** Error messages/patterns that indicate a retryable network error */
const RETRYABLE_ERROR_PATTERNS = [
    "failed to load session",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "fetch failed",
    "network error",
    "socket hang up",
    "aborted",
    "UND_ERR",
];

function isRetryableError(err: unknown): boolean {
    if (err instanceof Error) {
        const message = err.message.toLowerCase();
        return RETRYABLE_ERROR_PATTERNS.some((pattern) => message.includes(pattern.toLowerCase()));
    }

    // Check if the error has a response with a retryable status code
    if (err && typeof err === "object" && "response" in err) {
        const response = (err as { response: { statusCode?: number } }).response;
        if (response?.statusCode && RETRYABLE_STATUS_CODES.has(response.statusCode)) {
            return true;
        }
    }

    return false;
}

function getErrorStatusCode(err: unknown): number | undefined {
    if (err && typeof err === "object" && "response" in err) {
        const response = (err as { response: { statusCode?: number } }).response;
        return response?.statusCode;
    }
    return undefined;
}

function calculateDelay(attempt: number, config: RetryConfig): number {
    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = config.baseDelayMs * 2 ** attempt;
    const clampedDelay = Math.min(exponentialDelay, config.maxDelayMs);

    // Add jitter: delay * (1 ± jitterFactor)
    const jitter = clampedDelay * config.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(clampedDelay + jitter));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a resilient HttpClient wrapper using a JavaScript Proxy.
 *
 * The Proxy intercepts all HTTP methods (get, post, put, patch, delete) and adds:
 * - Exponential backoff retry with jitter
 * - Detailed logging of every request, retry and error
 * - Transparent pass-through for non-HTTP properties (EntityRepository etc. work unchanged)
 *
 * @returns An HttpClient-typed Proxy that wraps the original client
 */
export function createResilientClient(
    client: HttpClient,
    logger: Logger,
    config: Partial<RetryConfig> = {},
): HttpClient {
    const retryConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

    logger.info("STARTUP", "Resilient HTTP client initialized", {
        maxRetries: retryConfig.maxRetries,
        baseDelayMs: retryConfig.baseDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        jitterFactor: retryConfig.jitterFactor,
    });

    return new Proxy(client, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);

            // Only intercept known HTTP methods
            if (typeof prop !== "string" || !INTERCEPTED_METHODS.has(prop)) {
                return value;
            }

            if (typeof value !== "function") {
                return value;
            }

            const method = prop.toUpperCase();

            // Return a wrapped async function with retry logic
            return async (...args: unknown[]) => {
                const url = typeof args[0] === "string" ? args[0] : "unknown";
                const requestId = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

                logger.debug("HTTP", `Request start`, {
                    requestId,
                    method,
                    url,
                });

                const startTime = Date.now();
                let lastError: unknown = null;

                for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
                    try {
                        const attemptStart = Date.now();
                        // biome-ignore lint/suspicious/noExplicitAny: Proxy requires dynamic method invocation
                        const result = await (value as any).apply(target, args);
                        const duration = Date.now() - attemptStart;

                        logger.debug("HTTP", `Request success`, {
                            requestId,
                            method,
                            url,
                            duration_ms: duration,
                            attempt: attempt + 1,
                            totalDuration_ms: Date.now() - startTime,
                        });

                        // Log if this was a retry that succeeded
                        if (attempt > 0) {
                            logger.info("RETRY", `Request succeeded after retry`, {
                                requestId,
                                method,
                                url,
                                successfulAttempt: attempt + 1,
                                totalAttempts: attempt + 1,
                                totalDuration_ms: Date.now() - startTime,
                            });
                        }

                        return result;
                    } catch (err) {
                        lastError = err;
                        const duration = Date.now() - startTime;
                        const statusCode = getErrorStatusCode(err);
                        const isRetryable = isRetryableError(err);

                        const errorInfo: Record<string, unknown> = {
                            requestId,
                            method,
                            url,
                            attempt: attempt + 1,
                            maxAttempts: retryConfig.maxRetries + 1,
                            duration_ms: duration,
                            isRetryable,
                        };

                        if (statusCode) {
                            errorInfo.statusCode = statusCode;
                        }

                        if (err instanceof Error) {
                            errorInfo.errorMessage = err.message;
                        }

                        // If we have retries left and error is retryable
                        if (attempt < retryConfig.maxRetries && isRetryable) {
                            const delay = calculateDelay(attempt, retryConfig);

                            logger.warn("RETRY", `Retrying request`, {
                                ...errorInfo,
                                nextRetryIn_ms: delay,
                                remainingRetries: retryConfig.maxRetries - attempt,
                            });

                            await sleep(delay);
                            continue;
                        }

                        // Final failure – no more retries or error not retryable
                        if (!isRetryable) {
                            logger.logError("HTTP", `Request failed (non-retryable)`, err, errorInfo);
                        } else {
                            logger.logError("HTTP", `Request failed after all retries`, err, {
                                ...errorInfo,
                                totalRetries: attempt,
                            });
                        }

                        throw err;
                    }
                }

                // Should not reach here, but safety net
                throw lastError;
            };
        },
    });
}
