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
import { withAudit } from "../audit.js";
import { serializeLLM } from "../shopware.js";
import { snapshotProduct } from "../snapshot.js";
import { getOrCreateTaxByRate } from "./helper.js";

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

type ProductVisibility = {
	salesChannelId: string;
	visibility: number;
};

type ProductCreate = {
	id: string;
	active: boolean;
	name: string;
	taxId: string;
	description: string;
	productNumber: string;
	price: Price[];
	stock: number;
	visibilities: ProductVisibility[];
	categories: { id: string }[];
	coverId?: string | null;
	media?: { id: string; mediaId: string; position: number; cover: boolean }[];
};

type ProductUpdate = {
	id: string;
	active?: boolean;
	name?: string;
	description?: string;
	stock?: number;
	price?: Price[];
	visibilities?: ProductVisibility[];
	categories?: { id: string }[];
	coverId?: string | null;
	media?: { id: string; mediaId: string; position: number; cover: boolean }[];
	customFields?: Record<string, unknown> | null;
};

/** Fields used by product_list and product_get — kept in one place so
 *  the two tools always return the same shape. */
const PRODUCT_LIST_FIELDS = [
	"id",
	"productNumber",
	"name",
	"stock",
	"price",
	"active",
	"parentId",
	"childCount",
	"customFields",
] as const;

const PRODUCT_GET_FIELDS = [
	"id",
	"productNumber",
	"name",
	"description",
	"price",
	"stock",
	"active",
	"parentId",
	"childCount",
	"customFields",
] as const;

export const productList = (server: McpServer, client: HttpClient) => {
	server.tool(
		"product_list",
		{
			term: z.string().optional().describe("Search term"),
			ids: z
				.array(z.string())
				.optional()
				.describe("Fetch specific products by ID"),
			all: z
				.boolean()
				.default(true)
				.describe(
					"Fetch all products at once (auto-paginates). Set to false for paginated results.",
				),
			page: z
				.number()
				.min(1)
				.default(1)
				.describe("Page number (only used when all=false)"),
			limit: z
				.number()
				.min(1)
				.max(500)
				.default(500)
				.describe("Products per page (only used when all=false, max 500)"),
			topLevelOnly: z
				.boolean()
				.default(false)
				.describe(
					"Only return top-level products (parentId IS NULL, i.e. master products and standalone). Filters out variants — matches the backend product listing view.",
				),
			onlyActive: z
				.boolean()
				.default(false)
				.describe("Only return products with active=true."),
		},
		async (data) => {
			const productRepository = new EntityRepository<{
				productNumber: string;
				name: string;
				description: string;
				stock: number;
				price: Price[];
				active: boolean;
				parentId: string | null;
				childCount: number;
				customFields: Record<string, unknown> | null;
			}>(client, "product");

			const applyFilters = (criteria: Criteria) => {
				if (data.topLevelOnly) {
					criteria.addFilter(Criteria.equals("parentId", null));
				}
				if (data.onlyActive) {
					criteria.addFilter(Criteria.equals("active", true));
				}
			};

			// If specific IDs are requested, fetch them directly
			if (data.ids) {
				const criteria = new Criteria(data.ids);
				criteria.addFields(...PRODUCT_LIST_FIELDS);
				criteria.setLimit(data.ids.length);
				applyFilters(criteria);
				const products = await productRepository.search(
					criteria,
					new ApiContext(null, true),
				);
				return {
					content: [{ type: "text", text: serializeLLM(products) }],
				};
			}

			// Auto-paginate to fetch all products
			if (data.all) {
				const PAGE_SIZE = 500;
				// biome-ignore lint/suspicious/noExplicitAny: collecting all pages
				const allProducts: any[] = [];
				let page = 1;
				let totalFetched = 0;
				let total = 0;

				do {
					const criteria = new Criteria();
					criteria.addFields(...PRODUCT_LIST_FIELDS);
					criteria.setLimit(PAGE_SIZE);
					criteria.setPage(page);
					if (data.term) {
						criteria.setTerm(data.term);
					}
					applyFilters(criteria);

					const result = await productRepository.search(
						criteria,
						new ApiContext(null, true),
					);

					allProducts.push(...result.data);
					total = result.total;
					totalFetched += result.data.length;
					page++;
				} while (totalFetched < total);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								total,
								data: allProducts,
							}),
						},
					],
				};
			}

			// Manual pagination mode
			const criteria = new Criteria();
			criteria.addFields(...PRODUCT_LIST_FIELDS);
			criteria.setLimit(data.limit);
			criteria.setPage(data.page);
			if (data.term) {
				criteria.setTerm(data.term);
			}
			applyFilters(criteria);

			const products = await productRepository.search(
				criteria,
				new ApiContext(null, true),
			);

			return {
				content: [{ type: "text", text: serializeLLM(products) }],
			};
		},
	);
};

export const productGet = (server: McpServer, client: HttpClient) => {
	server.tool("product_get", { id: z.string() }, async ({ id }) => {
		const productRepository = new EntityRepository<{
			productNumber: string;
			name: string;
			description: string;
			price: Price[];
			customFields: Record<string, unknown> | null;
			parentId: string | null;
			childCount: number;
			active: boolean;
		}>(client, "product");

		const criteria = new Criteria([id]);
		criteria.addFields(...PRODUCT_GET_FIELDS);

		const product = (
			await productRepository.search(criteria, new ApiContext(null, true))
		).first();

		if (!product) {
			return {
				content: [
					{
						type: "text",
						text: "Product not found",
					},
				],
			};
		}

		return {
			content: [
				{
					type: "text",
					text: serializeLLM(product),
				},
			],
		};
	});
};

export const productCreate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"product_create",
		{
			name: z.string(),
			active: z.boolean().default(false),
			productNumber: z.string(),
			description: z.string(),
			taxRate: z.number().default(19),
			stock: z.number().default(0),
			netPrice: z.number().min(0),
			grossPrice: z.number().min(0),
			listPriceNet: z
				.number()
				.min(0)
				.optional()
				.describe(
					"Net list price (Streichpreis/UVP) - the original price shown as struck-through",
				),
			listPriceGross: z
				.number()
				.min(0)
				.optional()
				.describe(
					"Gross list price (Streichpreis/UVP) - the original price shown as struck-through",
				),
			visibilities: z
				.array(z.string())
				.optional()
				.describe("Sales channel ids in which the product should be visible"),
			categories: z
				.array(z.string())
				.optional()
				.describe("Category ids to which the product belongs"),
			media: z
				.array(
					z.object({
						mediaId: z.string().describe("ID of the media to link"),
						position: z.number().optional().describe("Position of the media"),
						cover: z
							.boolean()
							.default(false)
							.describe("Whether this media is the cover of the product"),
					}),
				)
				.optional()
				.describe("Array of media items to add to the product"),
		},
		async (data) => {
			const productRepository = new EntityRepository<ProductCreate>(
				client,
				"product",
			);

			const taxId = await getOrCreateTaxByRate(client, data.taxRate);

			const id = uuid();

			const payload: ProductCreate = {
				id,
				productNumber: data.productNumber,
				name: data.name,
				active: data.active,
				description: data.description,
				taxId,
				stock: data.stock,
				price: [
					{
						currencyId: Defaults.systemCurrencyId,
						net: data.netPrice,
						gross: data.grossPrice,
						linked: false,
						...(data.listPriceNet !== undefined &&
							data.listPriceGross !== undefined && {
								listPrice: {
									currencyId: Defaults.systemCurrencyId,
									net: data.listPriceNet,
									gross: data.listPriceGross,
									linked: false,
								},
							}),
					},
				],
				visibilities:
					data.visibilities?.map((salesChannelId) => ({
						salesChannelId,
						visibility: 30, // Default visibility
					})) || [],
				categories:
					data.categories?.map((categoryId) => ({
						id: categoryId,
					})) || [],
			};

			if (data.media) {
				payload.media = data.media.map((item) => ({
					id: uuid(),
					mediaId: item.mediaId,
					position: item.position ?? 0,
					cover: item.cover,
				}));

				const cover = payload.media?.filter((m) => m.cover === true) || [];
				payload.coverId = cover.length ? cover[0].id : null;
			}

			try {
				await withAudit(
					{
						operationId: id, // use product id as op id for easy lookup
						tool: "product_create",
						entityType: "product",
						entityId: id,
						sku: data.productNumber,
						payloadIn: payload,
						payloadBefore: null, // create → rollback = delete (manual)
					},
					() =>
						productRepository.upsert([payload], new ApiContext(null, true)),
				);
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error creating product: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Product created with id: ${id}. (Rollback eines Create = Produkt löschen, manuell)`,
					},
				],
			};
		},
	);
};

export const productUpdate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"product_update",
		{
			id: z.string(),
			active: z.boolean().optional(),
			name: z.string().optional(),
			description: z.string().optional(),
			stock: z.number().optional(),
			netPrice: z
				.number()
				.min(0)
				.optional()
				.describe("New net price (requires grossPrice too)"),
			grossPrice: z
				.number()
				.min(0)
				.optional()
				.describe("New gross price (requires netPrice too)"),
			listPriceNet: z
				.number()
				.min(0)
				.optional()
				.describe(
					"Net list price (Streichpreis/UVP) - set to 0 to remove the list price",
				),
			listPriceGross: z
				.number()
				.min(0)
				.optional()
				.describe(
					"Gross list price (Streichpreis/UVP) - set to 0 to remove the list price",
				),
			visibilities: z
				.array(z.string())
				.optional()
				.describe(
					"Sales channel ids in which the product should be visible (replaces existing visibilities)",
				),
			media: z
				.array(
					z.object({
						mediaId: z.string().describe("ID of the media to link"),
						position: z.number().optional().describe("Position of the media"),
						cover: z
							.boolean()
							.default(false)
							.describe("Whether this media is the cover of the product"),
					}),
				)
				.optional()
				.describe("Array of media items to add to the product"),
			categories: z
				.array(z.string())
				.optional()
				.describe(
					"Category ids to which the product belongs (replaces existing categories)",
				),
			customFields: z
				.record(z.unknown())
				.optional()
				.describe(
					"Custom fields to set/update. By default MERGED with existing customFields (only the supplied keys change, others kept). Set customFieldsMode='replace' to overwrite the whole object.",
				),
			customFieldsMode: z
				.enum(["merge", "replace"])
				.default("merge")
				.describe(
					"How to apply customFields. 'merge' = combine with existing keys (default, safe). 'replace' = drop existing customFields and only keep the supplied keys.",
				),
		},
		async (data) => {
			const syncService = new SyncService(client);

			const ops: SyncOperation[] = [];

			if (data.visibilities) {
				ops.push(
					new SyncOperation(
						"visibility-delete",
						"product_visibility",
						"delete",
						[],
						[Criteria.equals("productId", data.id)],
					),
				);
			}

			// Custom fields: merge with existing unless mode=replace
			let customFieldsPayload: Record<string, unknown> | null | undefined;
			if (data.customFields !== undefined) {
				if (data.customFieldsMode === "replace") {
					customFieldsPayload = data.customFields;
				} else {
					// Read existing customFields and merge
					const cfRepo = new EntityRepository<{
						customFields: Record<string, unknown> | null;
					}>(client, "product");
					const cfCriteria = new Criteria([data.id]);
					cfCriteria.addFields("customFields");
					const current = (
						await cfRepo.search(cfCriteria, new ApiContext(null, true))
					).first();
					const existing = current?.customFields ?? {};
					customFieldsPayload = { ...existing, ...data.customFields };
				}
			}

			// Build price update if price fields are provided
			const hasNewPrice =
				data.netPrice !== undefined && data.grossPrice !== undefined;
			const hasListPrice =
				data.listPriceNet !== undefined &&
				data.listPriceGross !== undefined;

			let pricePayload: Price[] | undefined;

			if (hasNewPrice || hasListPrice) {
				// We need to read the current price to merge with updates
				const productRepo = new EntityRepository<{ price: Price[] }>(
					client,
					"product",
				);
				const currentProduct = (
					await productRepo.search(
						new Criteria([data.id]),
						new ApiContext(null, true),
					)
				).first();

				const currentPrice = currentProduct?.price?.[0];
				const net = data.netPrice ?? currentPrice?.net ?? 0;
				const gross = data.grossPrice ?? currentPrice?.gross ?? 0;

				const priceEntry: Price = {
					currencyId: Defaults.systemCurrencyId,
					net,
					gross,
					linked: false,
				};

				if (hasListPrice) {
					if (data.listPriceNet === 0 && data.listPriceGross === 0) {
						// Remove list price
						priceEntry.listPrice = null;
					} else {
						priceEntry.listPrice = {
							currencyId: Defaults.systemCurrencyId,
							net: data.listPriceNet as number,
							gross: data.listPriceGross as number,
							linked: false,
						};
					}
				} else if (currentPrice?.listPrice) {
					// Preserve existing list price
					priceEntry.listPrice = currentPrice.listPrice;
				}

				pricePayload = [priceEntry];
			}

			const updatePayload: ProductUpdate = {
				id: data.id,
				...(data.active !== undefined && { active: data.active }),
				...(data.name !== undefined && { name: data.name }),
				...(data.description !== undefined && { description: data.description }),
				...(data.stock !== undefined && { stock: data.stock }),
				...(pricePayload && { price: pricePayload }),
				...(customFieldsPayload !== undefined && {
					customFields: customFieldsPayload,
				}),
				...(data.visibilities && {
					visibilities: data.visibilities.map((salesChannelId) => ({
						salesChannelId: salesChannelId,
						visibility: 30,
					})),
				}),
				...(data.categories && {
					categories: data.categories.map((categoryId) => ({
						id: categoryId,
					})),
				}),
			};

			if (data.media) {
				ops.push(
					new SyncOperation(
						"media-delete",
						"product_media",
						"delete",
						[],
						[Criteria.equals("productId", data.id)],
					),
				);

				updatePayload.media = data.media.map((item) => ({
					id: uuid(),
					mediaId: item.mediaId,
					position: item.position ?? 0,
					cover: item.cover,
				}));

				const cover =
					updatePayload.media?.filter((m) => m.cover === true) || [];
				updatePayload.coverId = cover.length ? cover[0].id : null;
			}

			ops.push(
				new SyncOperation("product-update", "product", "upsert", [
					updatePayload,
				]),
			);

			// Snapshot before state for rollback, then run audited
			const before = await snapshotProduct(client, data.id);
			const { event } = await withAudit(
				{
					tool: "product_update",
					entityType: "product",
					entityId: data.id,
					sku: (before?.productNumber as string) ?? null,
					payloadIn: updatePayload,
					payloadBefore: before,
				},
				() => syncService.sync(ops),
			);

			return {
				content: [
					{
						type: "text",
						text: `Product updated successfully. operationId: ${event.operationId} (use audit_rollback to undo)`,
					},
				],
			};
		},
	);
};
