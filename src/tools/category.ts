import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "@shopware-ag/app-server-sdk";
import {
	ApiContext,
	EntityRepository,
	uuid,
} from "@shopware-ag/app-server-sdk/helper/admin-api";
import { Criteria } from "@shopware-ag/app-server-sdk/helper/criteria";
import { z } from "zod";
import { getAuditLog, withAudit } from "../audit.js";
import { serializeLLM } from "../shopware.js";
import { snapshotCategory } from "../snapshot.js";

/** Bulk confirmation threshold — operations above this need confirm_bulk:true. */
export const BULK_CONFIRM_THRESHOLD = 10;

export function categoryList(server: McpServer, client: HttpClient) {
	server.tool("category_list", {}, async () => {
		const categoryRepository = new EntityRepository<{
			id: string;
			active: boolean;
			translated: { name: string };
			parentId: string | null;
			seoUrls: { seoPathInfo: string; salesChannelId: string }[];
		}>(client, "category");

		const criteria = new Criteria();
		criteria.addFields(
			"id",
			"name",
			"parentId",
			"active",
			"seoUrls.seoPathInfo",
			"seoUrls.salesChannelId",
		);
		criteria.setLimit(50);

		const categories = await categoryRepository.search(
			criteria,
			new ApiContext(null, true),
		);

		for (const category of categories.data) {
			//@ts-expect-error
			delete category.translated;
		}

		return {
			content: [
				{
					type: "text",
					text: `${serializeLLM(categories)}, for complete url call sales_channel_list and prepend the url to the right salesChannelId`,
				},
			],
		};
	});
}

export function categoryCreate(server: McpServer, client: HttpClient) {
	server.tool(
		"category_create",
		{
			categories: z
				.array(
					z.object({
						name: z.string().describe("Category name"),
						parentId: z
							.string()
							.optional()
							.describe("Parent category ID (optional for root category)"),
						active: z
							.boolean()
							.default(true)
							.describe("Whether the category should be active"),
					}),
				)
				.describe("Array of categories to create"),
		},
		async (data) => {
			const categoryRepository = new EntityRepository<{
				id: string;
				name: string;
				parentId?: string;
				active: boolean;
			}>(client, "category");

			const payloads = data.categories.map((category) => ({
				id: uuid(),
				name: category.name,
				active: category.active,
				...(category.parentId && { parentId: category.parentId }),
			}));

			try {
				await withAudit(
					{
						tool: "category_create",
						entityType: "category",
						entityId: payloads.map((p) => p.id).join(","),
						payloadIn: payloads,
						payloadBefore: null, // create → rollback = delete (manual)
					},
					() =>
						categoryRepository.upsert(payloads, new ApiContext(null, true)),
				);

				return {
					content: [
						{
							type: "text",
							text: serializeLLM(
								payloads.map((p) => ({ id: p.id, name: p.name })),
							),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error creating categories: ${serializeLLM(e)}`,
						},
					],
				};
			}
		},
	);
}

export function categoryUpdate(server: McpServer, client: HttpClient) {
	server.tool(
		"category_update",
		{
			categories: z
				.array(
					z.object({
						id: z.string().describe("Category ID to update"),
						name: z.string().optional().describe("New category name"),
						parentId: z.string().optional().describe("New parent category ID"),
						active: z
							.boolean()
							.optional()
							.describe("Whether the category should be active"),
						cmsPageId: z
							.string()
							.optional()
							.describe("CMS page ID to assign to this category"),
					}),
				)
				.describe("Array of categories to update"),
			confirm_bulk: z
				.boolean()
				.default(false)
				.describe(
					`Required to be true when updating more than ${BULK_CONFIRM_THRESHOLD} categories at once (safety pause).`,
				),
		},
		async (data) => {
			if (
				data.categories.length > BULK_CONFIRM_THRESHOLD &&
				data.confirm_bulk !== true
			) {
				return {
					content: [
						{
							type: "text",
							text: `Bulk-Schutz: Du willst ${data.categories.length} Kategorien gleichzeitig ändern. Setze confirm_bulk: true um zu bestätigen (Schwelle: ${BULK_CONFIRM_THRESHOLD}).`,
						},
					],
				};
			}

			const categoryRepository = new EntityRepository<{
				id: string;
				name?: string;
				parentId?: string;
				active?: boolean;
				cmsPageId?: string;
			}>(client, "category");

			const payloads = data.categories.map((category) => ({
				id: category.id,
				...(category.name && { name: category.name }),
				...(category.parentId !== undefined && { parentId: category.parentId }),
				...(category.active !== undefined && { active: category.active }),
				...(category.cmsPageId !== undefined && { cmsPageId: category.cmsPageId }),
			}));

			// One parent operation, one child audit event per category (granular rollback)
			const audit = getAuditLog();
			const parentId = audit.newOperationId();

			try {
				for (const payload of payloads) {
					const before = await snapshotCategory(client, payload.id);
					audit.begin({
						operationId: audit.newOperationId(),
						parentOperationId: parentId,
						tool: "category_update",
						entityType: "category",
						entityId: payload.id,
						payloadIn: payload,
						payloadBefore: before,
					});
				}

				await categoryRepository.upsert(payloads, new ApiContext(null, true));

				// finalize all children as success
				for (const child of audit.get(parentId).children) {
					audit.finalize(child, "success");
				}

				return {
					content: [
						{
							type: "text",
							text: `Updated ${payloads.length} categories successfully. bulkOperationId: ${parentId} (audit_rollback to undo all, or per-category via child operationIds from audit_get_operation)`,
						},
					],
				};
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
							text: `Error updating categories: ${serializeLLM(e)}`,
						},
					],
				};
			}
		},
	);
}

export function categoryDelete(server: McpServer, client: HttpClient) {
	server.tool(
		"category_delete",
		{
			ids: z.array(z.string()).describe("Array of category IDs to delete"),
		},
		async (data) => {
			const categoryRepository = new EntityRepository<{
				id: string;
			}>(client, "category");

			// Snapshot each category before deletion (basic fields for awareness)
			const snapshots: Record<string, unknown>[] = [];
			for (const id of data.ids) {
				const snap = await snapshotCategory(client, id);
				if (snap) snapshots.push(snap);
			}

			try {
				await withAudit(
					{
						tool: "category_delete",
						entityType: "category",
						entityId: data.ids.join(","),
						payloadIn: { ids: data.ids },
						payloadBefore: { categories: snapshots },
					},
					() =>
						categoryRepository.delete(
							data.ids.map((id) => ({ id })),
							new ApiContext(null, true),
						),
				);

				return {
					content: [
						{
							type: "text",
							text: serializeLLM({
								success: true,
								count: data.ids.length,
								deletedIds: data.ids,
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error deleting categories: ${serializeLLM(e)}`,
						},
					],
				};
			}
		},
	);
}
