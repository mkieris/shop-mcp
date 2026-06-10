import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "@shopware-ag/app-server-sdk";
import {
	ApiContext,
	Defaults,
	EntityRepository,
	SyncOperation,
	SyncService,
	uuid,
} from "@shopware-ag/app-server-sdk/helper/admin-api";
import { Criteria } from "@shopware-ag/app-server-sdk/helper/criteria";
import { z } from "zod";
import { getAuditLog, withAudit } from "../audit.js";
import { serializeLLM } from "../shopware.js";
import { snapshotProductPrices } from "../snapshot.js";

const PRICE_BULK_CONFIRM_THRESHOLD = 10;

type ListPrice = {
	currencyId: string;
	net: number;
	gross: number;
	linked: boolean;
};

type Price = {
	currencyId: string;
	net: number;
	gross: number;
	linked: boolean;
	listPrice?: ListPrice | null;
};

// ============================================================
// Tool 1: product_price_list
// Lists all advanced prices for a product, including rule name
// and quantity tiers.
// ============================================================

type ProductPrice = {
	ruleId: string;
	quantityStart: number;
	quantityEnd: number | null;
	price: Price[];
	rule: { name: string } | null;
};

export const productPriceList = (server: McpServer, client: HttpClient) => {
	server.tool(
		"product_price_list",
		{
			productId: z
				.string()
				.describe("Product ID to list advanced prices for"),
		},
		async ({ productId }) => {
			const repo = new EntityRepository<ProductPrice>(
				client,
				"product_price",
			);

			const criteria = new Criteria<ProductPrice>();
			criteria.addFilter(Criteria.equals("productId", productId));
			criteria.addAssociation("rule");
			criteria.addSorting(Criteria.sort("ruleId", "ASC"));
			criteria.addSorting(Criteria.sort("quantityStart", "ASC"));

			const prices = await repo.search(
				criteria,
				new ApiContext(null, true),
			);

			return {
				content: [
					{
						type: "text",
						text: serializeLLM(prices),
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 2: product_price_set
// Creates or replaces advanced prices for a product + rule
// combination. Supports quantity tiers (Staffelpreise).
// Deletes existing prices for the given product+rule first,
// then creates the new tiers.
// ============================================================

export const productPriceSet = (server: McpServer, client: HttpClient) => {
	server.tool(
		"product_price_set",
		{
			productId: z.string().describe("Product ID"),
			ruleId: z
				.string()
				.describe(
					"Rule ID (e.g. customer group rule, use rule_list to find available rules)",
				),
			prices: z
				.array(
					z.object({
						quantityStart: z
							.number()
							.min(1)
							.describe("Starting quantity for this tier"),
						quantityEnd: z
							.number()
							.optional()
							.describe(
								"Ending quantity for this tier (omit for unlimited)",
							),
						net: z.number().min(0).describe("Net price in EUR"),
						gross: z
							.number()
							.min(0)
							.describe("Gross price in EUR"),
						listPriceNet: z
							.number()
							.min(0)
							.optional()
							.describe(
								"Net list price (Streichpreis/UVP) for this tier",
							),
						listPriceGross: z
							.number()
							.min(0)
							.optional()
							.describe(
								"Gross list price (Streichpreis/UVP) for this tier",
							),
					}),
				)
				.min(1)
				.describe("Price tiers for this rule"),
		},
		async (data) => {
			const syncService = new SyncService(client);
			const ops: SyncOperation[] = [];

			// Step 1: Delete existing prices for this product+rule combination
			ops.push(
				new SyncOperation(
					"price-delete",
					"product_price",
					"delete",
					[],
					[
						Criteria.equals("productId", data.productId),
						Criteria.equals("ruleId", data.ruleId),
					],
				),
			);

			// Step 2: Create new price tiers
			const payloads = data.prices.map((tier) => {
				const priceEntry: Price = {
					currencyId: Defaults.systemCurrencyId,
					net: tier.net,
					gross: tier.gross,
					linked: false,
				};

				if (
					tier.listPriceNet !== undefined &&
					tier.listPriceGross !== undefined
				) {
					priceEntry.listPrice = {
						currencyId: Defaults.systemCurrencyId,
						net: tier.listPriceNet,
						gross: tier.listPriceGross,
						linked: false,
					};
				}

				return {
					id: uuid(),
					productId: data.productId,
					ruleId: data.ruleId,
					quantityStart: tier.quantityStart,
					...(tier.quantityEnd !== undefined && {
						quantityEnd: tier.quantityEnd,
					}),
					price: [priceEntry],
				};
			});

			ops.push(
				new SyncOperation(
					"price-create",
					"product_price",
					"upsert",
					payloads,
				),
			);

			// Snapshot existing prices for this product+rule for rollback
			const before = await snapshotProductPrices(
				client,
				data.productId,
				data.ruleId,
			);

			try {
				const { event } = await withAudit(
					{
						tool: "product_price_set",
						entityType: "product_price",
						entityId: data.productId,
						sku: null,
						payloadIn: { ruleId: data.ruleId, prices: payloads },
						payloadBefore: { productId: data.productId, ruleId: data.ruleId, prices: before },
					},
					() => syncService.sync(ops),
				);
				return {
					content: [
						{
							type: "text",
							text: `Successfully set ${data.prices.length} price tier(s) for product ${data.productId} with rule ${data.ruleId}. operationId: ${event.operationId}`,
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error setting prices: ${serializeLLM(e)}`,
						},
					],
				};
			}
		},
	);
};

// ============================================================
// Tool 3: product_price_delete
// Deletes advanced prices for a product. If ruleId is provided,
// only prices for that specific rule are deleted. Otherwise,
// ALL advanced prices for the product are removed.
// ============================================================

export const productPriceDelete = (server: McpServer, client: HttpClient) => {
	server.tool(
		"product_price_delete",
		{
			productId: z.string().describe("Product ID"),
			ruleId: z
				.string()
				.optional()
				.describe(
					"Rule ID - if omitted, ALL advanced prices for the product are deleted",
				),
		},
		async (data) => {
			const syncService = new SyncService(client);

			const filters = [
				Criteria.equals("productId", data.productId),
			];

			if (data.ruleId) {
				filters.push(Criteria.equals("ruleId", data.ruleId));
			}

			// Snapshot prices before delete for rollback (re-create)
			const before = await snapshotProductPrices(
				client,
				data.productId,
				data.ruleId,
			);

			try {
				const { event } = await withAudit(
					{
						tool: "product_price_delete",
						entityType: "product_price",
						entityId: data.productId,
						sku: null,
						payloadIn: { ruleId: data.ruleId ?? "ALL" },
						payloadBefore: {
							productId: data.productId,
							ruleId: data.ruleId,
							prices: before,
						},
					},
					() =>
						syncService.sync([
							new SyncOperation(
								"price-delete",
								"product_price",
								"delete",
								[],
								filters,
							),
						]),
				);
				return {
					content: [
						{
							type: "text",
							text: `${
								data.ruleId
									? `Deleted advanced prices for product ${data.productId} with rule ${data.ruleId}.`
									: `Deleted ALL advanced prices for product ${data.productId}.`
							} operationId: ${event.operationId}`,
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error deleting prices: ${serializeLLM(e)}`,
						},
					],
				};
			}
		},
	);
};

// ============================================================
// Tool 4: rule_list
// Lists all available rules in the shop. This is essential
// because a rule UUID is required to create advanced prices.
// ============================================================

export const ruleList = (server: McpServer, client: HttpClient) => {
	server.tool(
		"rule_list",
		{
			term: z
				.string()
				.optional()
				.describe("Search term to filter rules"),
			page: z.number().min(1).default(1).describe("The page to fetch"),
		},
		async (data) => {
			const repo = new EntityRepository<{
				name: string;
				description: string | null;
				priority: number;
			}>(client, "rule");

			const criteria = new Criteria();
			criteria.addFields("id", "name", "description", "priority");
			criteria.setLimit(50);
			criteria.setPage(data.page);

			if (data.term) {
				criteria.setTerm(data.term);
			}

			const rules = await repo.search(
				criteria,
				new ApiContext(null, true),
			);

			return {
				content: [
					{
						type: "text",
						text: serializeLLM(rules),
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 5: product_price_bulk_set
// Sets advanced prices for multiple products at once using a
// single rule. Useful for applying the same pricing scheme
// (e.g. B2B discount) across an entire product range.
// ============================================================

export const productPriceBulkSet = (
	server: McpServer,
	client: HttpClient,
) => {
	server.tool(
		"product_price_bulk_set",
		{
			ruleId: z.string().describe("Rule ID to apply for all products"),
			entries: z
				.array(
					z.object({
						productId: z.string().describe("Product ID"),
						prices: z
							.array(
								z.object({
									quantityStart: z
										.number()
										.min(1)
										.describe("Starting quantity for this tier"),
									quantityEnd: z
										.number()
										.optional()
										.describe(
											"Ending quantity for this tier (omit for unlimited)",
										),
									net: z
										.number()
										.min(0)
										.describe("Net price in EUR"),
									gross: z
										.number()
										.min(0)
										.describe("Gross price in EUR"),
									listPriceNet: z
										.number()
										.min(0)
										.optional()
										.describe(
											"Net list price (Streichpreis/UVP) for this tier",
										),
									listPriceGross: z
										.number()
										.min(0)
										.optional()
										.describe(
											"Gross list price (Streichpreis/UVP) for this tier",
										),
								}),
							)
							.min(1),
					}),
				)
				.min(1)
				.describe("Array of products with their price tiers"),
			confirm_bulk: z
				.boolean()
				.default(false)
				.describe(
					`Required true when setting prices for more than ${PRICE_BULK_CONFIRM_THRESHOLD} products at once.`,
				),
		},
		async (data) => {
			if (
				data.entries.length > PRICE_BULK_CONFIRM_THRESHOLD &&
				data.confirm_bulk !== true
			) {
				return {
					content: [
						{
							type: "text",
							text: `Bulk-Schutz: Du setzt Preise für ${data.entries.length} Produkte gleichzeitig. Setze confirm_bulk: true (Schwelle ${PRICE_BULK_CONFIRM_THRESHOLD}).`,
						},
					],
				};
			}

			const syncService = new SyncService(client);
			const ops: SyncOperation[] = [];

			// Step 1: Delete existing prices for all affected products with this rule
			for (const entry of data.entries) {
				ops.push(
					new SyncOperation(
						`price-delete-${entry.productId}`,
						"product_price",
						"delete",
						[],
						[
							Criteria.equals("productId", entry.productId),
							Criteria.equals("ruleId", data.ruleId),
						],
					),
				);
			}

			// Step 2: Create all new price tiers, grouped per product so each
			// audit child event carries only its own payloads
			const payloadsByEntry = data.entries.map((entry) =>
				entry.prices.map((tier) => {
					const priceEntry: Price = {
						currencyId: Defaults.systemCurrencyId,
						net: tier.net,
						gross: tier.gross,
						linked: false,
					};

					if (
						tier.listPriceNet !== undefined &&
						tier.listPriceGross !== undefined
					) {
						priceEntry.listPrice = {
							currencyId: Defaults.systemCurrencyId,
							net: tier.listPriceNet,
							gross: tier.listPriceGross,
							linked: false,
						};
					}

					return {
						id: uuid(),
						productId: entry.productId,
						ruleId: data.ruleId,
						quantityStart: tier.quantityStart,
						...(tier.quantityEnd !== undefined && {
							quantityEnd: tier.quantityEnd,
						}),
						price: [priceEntry],
					};
				}),
			);

			ops.push(
				new SyncOperation(
					"price-bulk-create",
					"product_price",
					"upsert",
					payloadsByEntry.flat(),
				),
			);

			// One parent operation, one child audit event per product (granular rollback)
			const audit = getAuditLog();
			const parentId = audit.newOperationId();

			try {
				for (const [i, entry] of data.entries.entries()) {
					const before = await snapshotProductPrices(
						client,
						entry.productId,
						data.ruleId,
					);
					audit.begin({
						operationId: audit.newOperationId(),
						parentOperationId: parentId,
						tool: "product_price_bulk_set",
						entityType: "product_price",
						entityId: entry.productId,
						sku: null,
						payloadIn: {
							ruleId: data.ruleId,
							prices: payloadsByEntry[i],
						},
						payloadBefore: {
							productId: entry.productId,
							ruleId: data.ruleId,
							prices: before,
						},
					});
				}

				await syncService.sync(ops);

				// finalize all children as success
				for (const child of audit.get(parentId).children) {
					audit.finalize(child, "success");
				}
			} catch (e) {
				for (const child of audit.get(parentId).children) {
					audit.finalize(child, "failed", {
						error: e instanceof Error ? e.message : String(e),
					});
				}
				return {
					content: [
						{
							type: "text",
							text: `Error setting bulk prices: ${serializeLLM(e)}`,
						},
					],
				};
			}

			const totalTiers = data.entries.reduce(
				(sum, e) => sum + e.prices.length,
				0,
			);

			return {
				content: [
					{
						type: "text",
						text: `Successfully set ${totalTiers} price tier(s) across ${data.entries.length} product(s). bulkOperationId: ${parentId} (audit_rollback to undo all, or per-product via child operationIds from audit_get_operation)`,
					},
				],
			};
		},
	);
};
