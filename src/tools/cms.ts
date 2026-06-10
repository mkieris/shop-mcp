import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "@shopware-ag/app-server-sdk";
import {
	ApiContext,
	EntityRepository,
	uuid,
} from "@shopware-ag/app-server-sdk/helper/admin-api";
import { Criteria } from "@shopware-ag/app-server-sdk/helper/criteria";
import { z } from "zod";
import { getAuditLog } from "../audit.js";
import { serializeLLM } from "../shopware.js";
import { snapshotCmsSlot } from "../snapshot.js";

const CMS_BULK_CONFIRM_THRESHOLD = 10;

// ============================================================
// Shared Zod schemas for nested CMS structures
// ============================================================

const slotSchema = z.object({
	type: z.string().describe("Slot type, e.g. text, image, product-listing, buy-box"),
	slot: z.string().describe("Slot position name, e.g. content, left, right, center"),
	config: z
		.record(z.unknown())
		.optional()
		.describe(
			"Slot config object. Pattern: { fieldName: { source: 'static', value: '...' } }. Example text: { content: { source: 'static', value: '<p>Hello</p>' } }",
		),
});

const blockSchema = z.object({
	type: z.string().describe("Block type, e.g. text, image-text, hero-image, product-listing"),
	slots: z.array(slotSchema).optional().describe("Slots inside this block"),
	backgroundColor: z.string().optional(),
	backgroundMediaId: z.string().optional(),
	cssClass: z.string().optional(),
	visibility: z
		.object({
			mobile: z.boolean().default(true),
			tablet: z.boolean().default(true),
			desktop: z.boolean().default(true),
		})
		.optional()
		.describe("Device visibility"),
	marginTop: z.string().optional(),
	marginBottom: z.string().optional(),
	marginLeft: z.string().optional(),
	marginRight: z.string().optional(),
});

const sectionSchema = z.object({
	type: z
		.enum(["default", "sidebar"])
		.default("default")
		.describe("Section layout type"),
	sizingMode: z
		.enum(["boxed", "full_width"])
		.default("boxed")
		.describe("Section sizing mode"),
	backgroundColor: z.string().optional(),
	backgroundMediaId: z.string().optional(),
	cssClass: z.string().optional(),
	visibility: z
		.object({
			mobile: z.boolean().default(true),
			tablet: z.boolean().default(true),
			desktop: z.boolean().default(true),
		})
		.optional(),
	blocks: z.array(blockSchema).optional().describe("Blocks inside this section"),
});

// ============================================================
// Tool 1: cms_page_list
// ============================================================

export const cmsPageList = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_page_list",
		{
			page: z.number().min(1).default(1),
			type: z
				.enum(["page", "landingpage", "product_list", "product_detail"])
				.optional()
				.describe("Filter by page type"),
			term: z.string().optional().describe("Search term"),
		},
		async (data) => {
			const repo = new EntityRepository<{
				name: string;
				type: string;
				locked: boolean;
			}>(client, "cms_page");

			const criteria = new Criteria();
			criteria.addFields("id", "name", "type", "locked");
			criteria.setLimit(50);
			criteria.setPage(data.page);

			if (data.type) {
				criteria.addFilter(Criteria.equals("type", data.type));
			}
			if (data.term) {
				criteria.setTerm(data.term);
			}

			const pages = await repo.search(
				criteria,
				new ApiContext(null, true),
			);

			return {
				content: [{ type: "text", text: serializeLLM(pages) }],
			};
		},
	);
};

// ============================================================
// Tool 2: cms_page_detail
// Full page with all sections, blocks, slots and their configs.
// ============================================================

type CmsSlot = {
	type: string;
	slot: string;
	config: Record<string, unknown> | null;
	fieldConfig: Record<string, unknown> | null;
};

type CmsBlock = {
	type: string;
	position: number;
	sectionId: string;
	backgroundColor: string | null;
	cssClass: string | null;
	visibility: Record<string, boolean> | null;
	marginTop: string | null;
	marginBottom: string | null;
	marginLeft: string | null;
	marginRight: string | null;
	slots: CmsSlot[];
};

type CmsSection = {
	type: string;
	position: number;
	sizingMode: string;
	backgroundColor: string | null;
	backgroundMediaId: string | null;
	cssClass: string | null;
	visibility: Record<string, boolean> | null;
	blocks: CmsBlock[];
};

type CmsPage = {
	name: string;
	type: string;
	locked: boolean;
	sections: CmsSection[];
};

export const cmsPageDetail = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_page_detail",
		{
			id: z.string().describe("CMS Page ID"),
		},
		async ({ id }) => {
			const repo = new EntityRepository<CmsPage>(client, "cms_page");

			const criteria = new Criteria<CmsPage>([id]);
			criteria.addAssociation("sections");
			criteria.addAssociation("sections.blocks");
			criteria.addAssociation("sections.blocks.slots");
			criteria.addSorting({ field: "sections.position", order: "ASC", naturalSorting: false });

			const page = (
				await repo.search(criteria, new ApiContext(null, true))
			).first();

			if (!page) {
				return {
					content: [{ type: "text", text: "CMS page not found" }],
				};
			}

			return {
				content: [{ type: "text", text: serializeLLM(page) }],
			};
		},
	);
};

// ============================================================
// Tool 3: cms_page_create
// Creates a complete page with nested sections/blocks/slots
// in a single atomic operation.
// ============================================================

export const cmsPageCreate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_page_create",
		{
			name: z.string().describe("Page name"),
			type: z
				.enum(["page", "landingpage", "product_list", "product_detail"])
				.describe("Page type"),
			sections: z
				.array(sectionSchema)
				.optional()
				.describe("Sections with nested blocks and slots"),
		},
		async (data) => {
			const repo = new EntityRepository<Record<string, unknown>>(
				client,
				"cms_page",
			);

			const pageId = uuid();

			const payload: Record<string, unknown> = {
				id: pageId,
				name: data.name,
				type: data.type,
			};

			if (data.sections) {
				payload.sections = data.sections.map((section, sIdx) => {
					const sectionPayload: Record<string, unknown> = {
						id: uuid(),
						position: sIdx,
						type: section.type,
						sizingMode: section.sizingMode,
						...(section.backgroundColor && {
							backgroundColor: section.backgroundColor,
						}),
						...(section.backgroundMediaId && {
							backgroundMediaId: section.backgroundMediaId,
						}),
						...(section.cssClass && { cssClass: section.cssClass }),
						...(section.visibility && {
							visibility: section.visibility,
						}),
					};

					if (section.blocks) {
						sectionPayload.blocks = section.blocks.map(
							(block, bIdx) => {
								const blockPayload: Record<string, unknown> = {
									id: uuid(),
									position: bIdx,
									type: block.type,
									...(block.backgroundColor && {
										backgroundColor: block.backgroundColor,
									}),
									...(block.backgroundMediaId && {
										backgroundMediaId:
											block.backgroundMediaId,
									}),
									...(block.cssClass && {
										cssClass: block.cssClass,
									}),
									...(block.visibility && {
										visibility: block.visibility,
									}),
									...(block.marginTop && {
										marginTop: block.marginTop,
									}),
									...(block.marginBottom && {
										marginBottom: block.marginBottom,
									}),
									...(block.marginLeft && {
										marginLeft: block.marginLeft,
									}),
									...(block.marginRight && {
										marginRight: block.marginRight,
									}),
								};

								if (block.slots) {
									blockPayload.slots = block.slots.map(
										(slot) => ({
											id: uuid(),
											type: slot.type,
											slot: slot.slot,
											...(slot.config && {
												config: slot.config,
											}),
										}),
									);
								}

								return blockPayload;
							},
						);
					}

					return sectionPayload;
				});
			}

			try {
				await repo.upsert([payload], new ApiContext(null, true));
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error creating CMS page: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `CMS page created with id: ${pageId}`,
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 4: cms_section_create
// Adds sections (with nested blocks/slots) to an existing page.
// ============================================================

export const cmsSectionCreate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_section_create",
		{
			pageId: z.string().describe("CMS Page ID to add sections to"),
			sections: z
				.array(sectionSchema)
				.min(1)
				.describe("Sections with nested blocks and slots"),
		},
		async (data) => {
			const repo = new EntityRepository<Record<string, unknown>>(
				client,
				"cms_section",
			);

			const payloads = data.sections.map((section, sIdx) => {
				const sectionPayload: Record<string, unknown> = {
					id: uuid(),
					pageId: data.pageId,
					position: sIdx,
					type: section.type,
					sizingMode: section.sizingMode,
					...(section.backgroundColor && {
						backgroundColor: section.backgroundColor,
					}),
					...(section.backgroundMediaId && {
						backgroundMediaId: section.backgroundMediaId,
					}),
					...(section.cssClass && { cssClass: section.cssClass }),
					...(section.visibility && {
						visibility: section.visibility,
					}),
				};

				if (section.blocks) {
					sectionPayload.blocks = section.blocks.map(
						(block, bIdx) => {
							const blockPayload: Record<string, unknown> = {
								id: uuid(),
								position: bIdx,
								type: block.type,
								...(block.backgroundColor && {
									backgroundColor: block.backgroundColor,
								}),
								...(block.backgroundMediaId && {
									backgroundMediaId:
										block.backgroundMediaId,
								}),
								...(block.cssClass && {
									cssClass: block.cssClass,
								}),
								...(block.visibility && {
									visibility: block.visibility,
								}),
								...(block.marginTop && {
									marginTop: block.marginTop,
								}),
								...(block.marginBottom && {
									marginBottom: block.marginBottom,
								}),
								...(block.marginLeft && {
									marginLeft: block.marginLeft,
								}),
								...(block.marginRight && {
									marginRight: block.marginRight,
								}),
							};

							if (block.slots) {
								blockPayload.slots = block.slots.map(
									(slot) => ({
										id: uuid(),
										type: slot.type,
										slot: slot.slot,
										...(slot.config && {
											config: slot.config,
										}),
									}),
								);
							}

							return blockPayload;
						},
					);
				}

				return sectionPayload;
			});

			try {
				await repo.upsert(payloads, new ApiContext(null, true));
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error creating sections: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Created ${data.sections.length} section(s) on page ${data.pageId}`,
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 5: cms_page_update
// Updates page-level properties (name, type).
// ============================================================

export const cmsPageUpdate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_page_update",
		{
			id: z.string().describe("CMS Page ID"),
			name: z.string().optional().describe("New page name"),
			type: z
				.enum(["page", "landingpage", "product_list", "product_detail"])
				.optional()
				.describe("New page type"),
		},
		async (data) => {
			const repo = new EntityRepository<Record<string, unknown>>(
				client,
				"cms_page",
			);

			const payload: Record<string, unknown> = { id: data.id };
			if (data.name) payload.name = data.name;
			if (data.type) payload.type = data.type;

			try {
				await repo.upsert([payload], new ApiContext(null, true));
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error updating CMS page: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{ type: "text", text: `CMS page ${data.id} updated.` },
				],
			};
		},
	);
};

// ============================================================
// Tool 6: cms_section_update
// Batch-update section properties.
// ============================================================

export const cmsSectionUpdate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_section_update",
		{
			sections: z
				.array(
					z.object({
						id: z.string().describe("Section ID"),
						position: z.number().optional(),
						type: z.enum(["default", "sidebar"]).optional(),
						sizingMode: z.enum(["boxed", "full_width"]).optional(),
						backgroundColor: z.string().optional(),
						backgroundMediaId: z.string().optional(),
						cssClass: z.string().optional(),
						visibility: z
							.object({
								mobile: z.boolean().default(true),
								tablet: z.boolean().default(true),
								desktop: z.boolean().default(true),
							})
							.optional(),
					}),
				)
				.min(1),
		},
		async (data) => {
			const repo = new EntityRepository<Record<string, unknown>>(
				client,
				"cms_section",
			);

			const payloads = data.sections.map((s) => {
				const p: Record<string, unknown> = { id: s.id };
				if (s.position !== undefined) p.position = s.position;
				if (s.type) p.type = s.type;
				if (s.sizingMode) p.sizingMode = s.sizingMode;
				if (s.backgroundColor !== undefined)
					p.backgroundColor = s.backgroundColor;
				if (s.backgroundMediaId !== undefined)
					p.backgroundMediaId = s.backgroundMediaId;
				if (s.cssClass !== undefined) p.cssClass = s.cssClass;
				if (s.visibility) p.visibility = s.visibility;
				return p;
			});

			try {
				await repo.upsert(payloads, new ApiContext(null, true));
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error updating sections: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Updated ${data.sections.length} section(s).`,
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 7: cms_block_update
// Batch-update block properties.
// ============================================================

export const cmsBlockUpdate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_block_update",
		{
			blocks: z
				.array(
					z.object({
						id: z.string().describe("Block ID"),
						position: z.number().optional(),
						backgroundColor: z.string().optional(),
						backgroundMediaId: z.string().optional(),
						cssClass: z.string().optional(),
						visibility: z
							.object({
								mobile: z.boolean().default(true),
								tablet: z.boolean().default(true),
								desktop: z.boolean().default(true),
							})
							.optional(),
						marginTop: z.string().optional(),
						marginBottom: z.string().optional(),
						marginLeft: z.string().optional(),
						marginRight: z.string().optional(),
					}),
				)
				.min(1),
		},
		async (data) => {
			const repo = new EntityRepository<Record<string, unknown>>(
				client,
				"cms_block",
			);

			const payloads = data.blocks.map((b) => {
				const p: Record<string, unknown> = { id: b.id };
				if (b.position !== undefined) p.position = b.position;
				if (b.backgroundColor !== undefined)
					p.backgroundColor = b.backgroundColor;
				if (b.backgroundMediaId !== undefined)
					p.backgroundMediaId = b.backgroundMediaId;
				if (b.cssClass !== undefined) p.cssClass = b.cssClass;
				if (b.visibility) p.visibility = b.visibility;
				if (b.marginTop !== undefined) p.marginTop = b.marginTop;
				if (b.marginBottom !== undefined)
					p.marginBottom = b.marginBottom;
				if (b.marginLeft !== undefined) p.marginLeft = b.marginLeft;
				if (b.marginRight !== undefined) p.marginRight = b.marginRight;
				return p;
			});

			try {
				await repo.upsert(payloads, new ApiContext(null, true));
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error updating blocks: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Updated ${data.blocks.length} block(s).`,
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 8: cms_slot_update
// The heart of CMS editing – update slot content/config.
// Config pattern: { fieldName: { source: "static", value: "..." } }
// ============================================================

export const cmsSlotUpdate = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_slot_update",
		{
			slots: z
				.array(
					z.object({
						id: z.string().describe("Slot ID"),
						config: z
							.record(z.unknown())
							.describe(
								"Slot config. Pattern: { fieldName: { source: 'static', value: '...' } }",
							),
					}),
				)
				.min(1),
			confirm_bulk: z
				.boolean()
				.default(false)
				.describe(
					`Required true when updating more than ${CMS_BULK_CONFIRM_THRESHOLD} slots at once.`,
				),
		},
		async (data) => {
			if (
				data.slots.length > CMS_BULK_CONFIRM_THRESHOLD &&
				data.confirm_bulk !== true
			) {
				return {
					content: [
						{
							type: "text",
							text: `Bulk-Schutz: ${data.slots.length} Slots gleichzeitig. Setze confirm_bulk: true (Schwelle ${CMS_BULK_CONFIRM_THRESHOLD}).`,
						},
					],
				};
			}

			const repo = new EntityRepository<{
				id: string;
				config: Record<string, unknown>;
			}>(client, "cms_slot");

			const payloads = data.slots.map((s) => ({
				id: s.id,
				config: s.config,
			}));

			const audit = getAuditLog();
			const parentId = audit.newOperationId();
			for (const p of payloads) {
				const before = await snapshotCmsSlot(client, p.id);
				audit.begin({
					operationId: audit.newOperationId(),
					parentOperationId: parentId,
					tool: "cms_slot_update",
					entityType: "cms_slot",
					entityId: p.id,
					payloadIn: p,
					payloadBefore: before,
				});
			}

			try {
				await repo.upsert(payloads, new ApiContext(null, true));
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
							text: `Error updating slots: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Updated ${data.slots.length} slot(s). bulkOperationId: ${parentId} (audit_rollback to undo)`,
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 9: cms_page_delete
// Deletes a CMS page (cascades to sections/blocks/slots).
// ============================================================

export const cmsPageDelete = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_page_delete",
		{
			id: z.string().describe("CMS Page ID to delete"),
		},
		async ({ id }) => {
			const repo = new EntityRepository<{ id: string }>(
				client,
				"cms_page",
			);

			try {
				await repo.delete([{ id }], new ApiContext(null, true));
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error deleting CMS page: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{ type: "text", text: `CMS page ${id} deleted.` },
				],
			};
		},
	);
};

// ============================================================
// Tool 10: cms_section_delete
// Deletes sections by IDs (cascades to blocks/slots).
// ============================================================

export const cmsSectionDelete = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_section_delete",
		{
			ids: z
				.array(z.string())
				.min(1)
				.describe("Array of section IDs to delete"),
		},
		async ({ ids }) => {
			const repo = new EntityRepository<{ id: string }>(
				client,
				"cms_section",
			);

			try {
				await repo.delete(
					ids.map((id) => ({ id })),
					new ApiContext(null, true),
				);
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error deleting sections: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Deleted ${ids.length} section(s).`,
					},
				],
			};
		},
	);
};

// ============================================================
// Tool 11: cms_block_delete
// Deletes blocks by IDs (cascades to slots).
// ============================================================

export const cmsBlockDelete = (server: McpServer, client: HttpClient) => {
	server.tool(
		"cms_block_delete",
		{
			ids: z
				.array(z.string())
				.min(1)
				.describe("Array of block IDs to delete"),
		},
		async ({ ids }) => {
			const repo = new EntityRepository<{ id: string }>(
				client,
				"cms_block",
			);

			try {
				await repo.delete(
					ids.map((id) => ({ id })),
					new ApiContext(null, true),
				);
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error deleting blocks: ${serializeLLM(e)}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Deleted ${ids.length} block(s).`,
					},
				],
			};
		},
	);
};
