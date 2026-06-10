import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClientTokenCacheInterface } from "@shopware-ag/app-server-sdk";
import type { Logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TokenCacheItem {
    token: string;
    expiresIn: string; // ISO date string (serializable)
    createdAt: string; // ISO date string – tracks when token was issued
}

interface TokenCacheFile {
    [shopId: string]: TokenCacheItem;
}

/** Threshold for proactive token refresh: refresh when 80% of lifetime has passed */
const PROACTIVE_REFRESH_THRESHOLD = 0.8;

export class FileTokenCache implements HttpClientTokenCacheInterface {
    private cacheDir: string;
    private cacheFile: string;
    private logger: Logger;

    /** In-memory fallback if file operations fail */
    private memoryCache: TokenCacheFile = {};

    constructor(logger: Logger) {
        this.logger = logger;
        this.cacheDir = join(__dirname, "..", ".cache");
        this.cacheFile = join(this.cacheDir, "token-cache.json");
        this.ensureCacheDir();
    }

    private ensureCacheDir(): void {
        try {
            if (!existsSync(this.cacheDir)) {
                mkdirSync(this.cacheDir, { recursive: true });
                this.logger.debug("CACHE", "Cache directory created", { path: this.cacheDir });
            }
        } catch (err) {
            this.logger.logError("CACHE", "Failed to create cache directory", err, { path: this.cacheDir });
        }
    }

    private readCacheFile(): TokenCacheFile {
        try {
            if (!existsSync(this.cacheFile)) {
                return {};
            }
            const content = readFileSync(this.cacheFile, "utf8");
            return JSON.parse(content) as TokenCacheFile;
        } catch (err) {
            this.logger.logError("CACHE", "Failed to read cache file, using memory fallback", err);
            return { ...this.memoryCache };
        }
    }

    private writeCacheFile(data: TokenCacheFile): void {
        try {
            writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), "utf8");
        } catch (err) {
            this.logger.logError("CACHE", "Failed to write cache file", err);
        }
        // Always update memory cache as backup
        this.memoryCache = { ...data };
    }

    async getToken(shopId: string): Promise<{ token: string; expiresIn: Date } | null> {
        const cache = this.readCacheFile();
        const item = cache[shopId];

        if (!item) {
            this.logger.debug("TOKEN", "Cache miss – no token found", { shopId });
            return null;
        }

        const expiresIn = new Date(item.expiresIn);
        const createdAt = new Date(item.createdAt);
        const now = new Date();

        // Check if token is expired
        if (now >= expiresIn) {
            this.logger.info("TOKEN", "Token expired, clearing cache", {
                shopId,
                expiredAt: item.expiresIn,
                expiredAgoMs: now.getTime() - expiresIn.getTime(),
            });
            await this.clearToken(shopId);
            return null;
        }

        // Proactive refresh: if >80% of token lifetime has passed, request a new one
        const totalLifetimeMs = expiresIn.getTime() - createdAt.getTime();
        const elapsedMs = now.getTime() - createdAt.getTime();
        const lifetimeRatio = totalLifetimeMs > 0 ? elapsedMs / totalLifetimeMs : 1;

        if (lifetimeRatio >= PROACTIVE_REFRESH_THRESHOLD) {
            this.logger.info("TOKEN", "Proactive refresh – token nearing expiry", {
                shopId,
                lifetimeUsedPercent: Math.round(lifetimeRatio * 100),
                remainingMs: expiresIn.getTime() - now.getTime(),
                totalLifetimeMs,
            });
            await this.clearToken(shopId);
            return null;
        }

        this.logger.debug("TOKEN", "Cache hit – token valid", {
            shopId,
            lifetimeUsedPercent: Math.round(lifetimeRatio * 100),
            remainingMs: expiresIn.getTime() - now.getTime(),
        });

        return { token: item.token, expiresIn };
    }

    async setToken(shopId: string, token: { token: string; expiresIn: Date }): Promise<void> {
        const cache = this.readCacheFile();
        const now = new Date();

        cache[shopId] = {
            token: token.token,
            expiresIn: token.expiresIn.toISOString(),
            createdAt: now.toISOString(),
        };

        this.writeCacheFile(cache);

        const lifetimeMs = token.expiresIn.getTime() - now.getTime();

        this.logger.info("TOKEN", "New token cached", {
            shopId,
            expiresIn: token.expiresIn.toISOString(),
            lifetimeMs,
            lifetimeMinutes: Math.round(lifetimeMs / 60000),
        });
    }

    async clearToken(shopId: string): Promise<void> {
        const cache = this.readCacheFile();

        if (cache[shopId]) {
            delete cache[shopId];
            this.writeCacheFile(cache);
            this.logger.info("TOKEN", "Token cleared from cache", { shopId });
        }
    }
}
