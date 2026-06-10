#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpClient, SimpleShop } from "@shopware-ag/app-server-sdk";
import { initAuditLog } from "./audit.js";
import { Logger } from "./logger.js";
import { createResilientClient } from "./resilient-client.js";
import { FileTokenCache } from "./token-cache.js";
import { configureTools } from "./tools/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
	readFileSync(join(__dirname, "..", "package.json"), "utf8"),
);
const version = packageJson.version;

// Initialize logger first – everything else depends on it
const logger = new Logger();
logger.info("STARTUP", "Shopware Admin MCP Server starting", {
	version,
	nodeVersion: process.version,
	platform: process.platform,
	pid: process.pid,
});

const requiredEnvVars = [
	"SHOPWARE_API_URL",
	"SHOPWARE_API_CLIENT_ID",
	"SHOPWARE_API_CLIENT_SECRET",
];

for (const envVar of requiredEnvVars) {
	if (!process.env[envVar]) {
		logger.error("STARTUP", `Missing required environment variable: ${envVar}`);
		process.exit(1);
	}
}

logger.info("STARTUP", "Environment validated", {
	shopwareUrl: process.env.SHOPWARE_API_URL,
	clientId: process.env.SHOPWARE_API_CLIENT_ID?.slice(0, 8) + "...",
});

const server = new McpServer({
	name: "shopware-admin-mcp",
	version,
});

const shop = new SimpleShop(
	"static-id",
	process.env.SHOPWARE_API_URL as string,
	"shop-secret",
);

shop.setShopCredentials(
	process.env.SHOPWARE_API_CLIENT_ID as string,
	process.env.SHOPWARE_API_CLIENT_SECRET as string,
);

// Create HttpClient with persistent file-based token cache
const tokenCache = new FileTokenCache(logger);
const rawClient = new HttpClient(shop, tokenCache);

// Wrap with resilient proxy (retry + backoff + logging)
const client = createResilientClient(rawClient, logger);

logger.info("STARTUP", "HttpClient initialized with persistent cache and retry logic");

// Initialize the audit log (multi-user accountability + rollback)
initAuditLog(logger);
logger.info("STARTUP", "Audit log initialized", {
	user: process.env.SHOPWARE_API_CLIENT_ID?.slice(0, 12),
	label: process.env.MCP_USER_LABEL ?? null,
});

configureTools(server, client);

logger.info("STARTUP", "All MCP tools registered");

const transport = new StdioServerTransport();
await server.connect(transport);

logger.info("STARTUP", "MCP Server connected via stdio transport – ready for requests", {
	logFile: logger.getLogFilePath(),
});

// Handle graceful shutdown
process.on("SIGINT", () => {
	logger.info("SHUTDOWN", "Received SIGINT, shutting down");
	process.exit(0);
});

process.on("SIGTERM", () => {
	logger.info("SHUTDOWN", "Received SIGTERM, shutting down");
	process.exit(0);
});

process.on("uncaughtException", (err) => {
	logger.logError("SHUTDOWN", "Uncaught exception", err);
	process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	logger.logError("SHUTDOWN", "Unhandled promise rejection", reason);
});
