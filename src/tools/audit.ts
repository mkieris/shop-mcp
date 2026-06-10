import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "@shopware-ag/app-server-sdk";
import {
	ApiContext,
	EntityRepository,
	SyncOperation,
	SyncService,
} from "@shopware-ag/app-server-sdk/helper/admin-api";
import { Criteria } from "@shopware-ag/app-server-sdk/helper/criteria";
import { z } from "zod";
import { type AuditEvent, getAuditLog } from "../audit.js";
import { serializeLLM } from "../shopware.js";

/**
 * Reconstruct and apply the reverse of an audited write operation from its
 * `payloadBefore` snapshot. Returns a human-readable summary of what was done.
 */
async function applyRollback(
	client: HttpClient,
	event: AuditEvent,
	dryRun: boolean,
): Promise<{ ok: boolean; message: string }> {
	const before = event.payloadBefore as Record<string, unknown> | null;

	if (event.payloadBefore === null || before === null) {
		return {
			ok: false,
			message: `Op ${event.operationId} (${event.tool}) hat keinen Vorher-Zustand (war vermutlich ein Create). Rollback = manuelles Löschen nötig.`,
		};
	}

	// Build the reverse payload depending on entity type
	let entity: string;
	let payload: Record<string, unknown>;

	switch (event.entityType) {
		case "product":
			entity = "product";
			payload = {
				id: before.id,
				name: before.name,
				stock: before.stock,
				active: before.active,
				price: before.price,
				customFields: before.customFields,
			};
			break;
		case "category":
			entity = "category";
			payload = {
				id: before.id,
				name: before.name,
				parentId: before.parentId,
				active: before.active,
				cmsPageId: before.cmsPageId,
			};
			break;
		case "cms_slot":
			entity = "cms_slot";
			payload = {
				id: before.id,
				config: before.config,
			};
			break;
		case "product_price": {
			// Special: delete current prices for product+rule, re-insert the snapshot
			const productId = before.productId as string;
			const ruleId = before.ruleId as string | undefined;
			const prices = (before.prices as Record<string, unknown>[]) ?? [];
			if (dryRun) {
				return {
					ok: true,
					message: `[DRY-RUN] Würde Advanced-Prices für Produkt ${productId}${ruleId ? ` / Regel ${ruleId}` : ""} auf ${prices.length} vorherige Preis-Tier(s) zurücksetzen.`,
				};
			}
			const sync = new SyncService(client);
			const filters = [Criteria.equals("productId", productId)];
			if (ruleId) filters.push(Criteria.equals("ruleId", ruleId));
			const ops: SyncOperation[] = [
				new SyncOperation("rb-price-delete", "product_price", "delete", [], filters),
			];
			if (prices.length > 0) {
				ops.push(
					new SyncOperation("rb-price-create", "product_price", "upsert", prices),
				);
			}
			await sync.sync(ops);
			return {
				ok: true,
				message: `Advanced-Prices für Produkt ${productId}${ruleId ? ` / Regel ${ruleId}` : ""} auf ${prices.length} vorherige Tier(s) zurückgesetzt.`,
			};
		}
		default:
			return {
				ok: false,
				message: `Rollback für entityType "${event.entityType}" nicht unterstützt (Op ${event.operationId}). Tools: order_state/theme = manuell, create = löschen, delete = neu anlegen.`,
			};
	}

	if (dryRun) {
		return {
			ok: true,
			message: `[DRY-RUN] Würde ${entity} ${event.entityId} (${event.sku ?? ""}) auf Vorher-Zustand zurücksetzen: ${serializeLLM(payload)}`,
		};
	}

	const repo = new EntityRepository<Record<string, unknown>>(client, entity);
	await repo.upsert([payload], new ApiContext(null, true));

	return {
		ok: true,
		message: `${entity} ${event.entityId} (${event.sku ?? ""}) auf Vorher-Zustand zurückgesetzt.`,
	};
}

export function auditSearch(server: McpServer, _client: HttpClient) {
	server.tool(
		"audit_search",
		{
			user: z.string().optional().describe("Filter by user / integration id (substring)"),
			tool: z.string().optional().describe("Filter by tool, e.g. product_update"),
			entityId: z.string().optional().describe("Filter by entity id"),
			sku: z.string().optional().describe("Filter by product SKU"),
			status: z
				.enum(["pending", "success", "failed", "rolled_back"])
				.optional(),
			action: z.enum(["write", "rollback"]).optional(),
			from: z.string().optional().describe("ISO date lower bound"),
			to: z.string().optional().describe("ISO date upper bound"),
			limit: z.number().min(1).max(500).default(50),
		},
		async (data) => {
			const audit = getAuditLog();
			const events = audit.search(data);
			// Compact view: omit big payloads, keep essentials
			const compact = events.map((e) => ({
				operationId: e.operationId,
				parentOperationId: e.parentOperationId,
				timestamp: e.timestamp,
				user: e.userLabel ?? e.user,
				tool: e.tool,
				action: e.action,
				entityType: e.entityType,
				entityId: e.entityId,
				sku: e.sku,
				status: e.status,
				rolledBackBy: e.rolledBackBy ?? null,
			}));
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ count: compact.length, events: compact }),
					},
				],
			};
		},
	);
}

export function auditGetOperation(server: McpServer, _client: HttpClient) {
	server.tool(
		"audit_get_operation",
		{
			operationId: z
				.string()
				.describe("Operation id (incl. full payloadBefore/payloadIn + children for bulk)"),
		},
		async ({ operationId }) => {
			const audit = getAuditLog();
			const { operation, children } = audit.get(operationId);
			if (!operation && children.length === 0) {
				return {
					content: [
						{ type: "text", text: `Keine Operation mit id ${operationId} gefunden.` },
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ operation, children }),
					},
				],
			};
		},
	);
}

export function auditRollback(server: McpServer, client: HttpClient) {
	server.tool(
		"audit_rollback",
		{
			operationId: z
				.string()
				.describe(
					"Operation id to undo. If it is a bulk parent, ALL its child operations are rolled back.",
				),
			dry_run: z
				.boolean()
				.default(false)
				.describe("Preview what would be rolled back without writing."),
		},
		async ({ operationId, dry_run }) => {
			const audit = getAuditLog();
			const { operation, children } = audit.get(operationId);

			// Determine the set of events to roll back
			let targets: AuditEvent[];
			if (children.length > 0) {
				targets = children; // bulk parent → roll back all children
			} else if (operation) {
				targets = [operation];
			} else {
				return {
					content: [
						{ type: "text", text: `Keine Operation mit id ${operationId} gefunden.` },
					],
				};
			}

			const results: string[] = [];
			for (const ev of targets) {
				if (ev.status === "rolled_back") {
					results.push(`⏭️  ${ev.entityId} bereits zurückgesetzt — übersprungen.`);
					continue;
				}
				if (ev.status !== "success") {
					results.push(`⏭️  ${ev.entityId} Status "${ev.status}" — übersprungen.`);
					continue;
				}
				try {
					const res = await applyRollback(client, ev, dry_run);
					results.push(res.ok ? `✅ ${res.message}` : `⚠️  ${res.message}`);
					if (res.ok && !dry_run) {
						// Log the rollback as its own event + mark original
						const rb = audit.begin({
							tool: "audit_rollback",
							action: "rollback",
							entityType: ev.entityType,
							entityId: ev.entityId,
							sku: ev.sku,
							payloadIn: ev.payloadBefore,
							payloadBefore: ev.payloadIn,
							rollbackOf: ev.operationId,
						});
						audit.finalize(rb, "success");
						audit.markRolledBack(ev.operationId, rb.operationId);
					}
				} catch (e) {
					results.push(
						`❌ ${ev.entityId}: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `${dry_run ? "[DRY-RUN] " : ""}Rollback von ${targets.length} Operation(en):\n${results.join("\n")}`,
					},
				],
			};
		},
	);
}

export function auditRollbackRange(server: McpServer, client: HttpClient) {
	server.tool(
		"audit_rollback_range",
		{
			user: z.string().optional().describe("Restrict to this user"),
			from: z.string().describe("ISO date lower bound (inclusive)"),
			to: z.string().describe("ISO date upper bound (inclusive)"),
			tool: z.string().optional().describe("Restrict to this tool"),
			dry_run: z
				.boolean()
				.default(true)
				.describe("Preview only (default true for this dangerous bulk op)."),
		},
		async ({ user, from, to, tool, dry_run }) => {
			const audit = getAuditLog();
			const events = audit
				.search({ user, from, to, tool, action: "write", status: "success" })
				// roll back in REVERSE chronological order (newest first → oldest)
				.filter((e) => e.entityId);

			if (events.length === 0) {
				return {
					content: [
						{ type: "text", text: "Keine rückrollbaren Operationen im Zeitraum gefunden." },
					],
				};
			}

			const results: string[] = [];
			for (const ev of events) {
				try {
					const res = await applyRollback(client, ev, dry_run);
					results.push(res.ok ? `✅ ${ev.sku ?? ev.entityId}: ${res.message}` : `⚠️  ${res.message}`);
					if (res.ok && !dry_run) {
						const rb = audit.begin({
							tool: "audit_rollback",
							action: "rollback",
							entityType: ev.entityType,
							entityId: ev.entityId,
							sku: ev.sku,
							payloadIn: ev.payloadBefore,
							payloadBefore: ev.payloadIn,
							rollbackOf: ev.operationId,
						});
						audit.finalize(rb, "success");
						audit.markRolledBack(ev.operationId, rb.operationId);
					}
				} catch (e) {
					results.push(`❌ ${ev.entityId}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `${dry_run ? "[DRY-RUN] " : ""}${events.length} Operation(en) im Zeitraum:\n${results.join("\n")}`,
					},
				],
			};
		},
	);
}
