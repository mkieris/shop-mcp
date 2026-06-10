import type { HttpClient } from "@shopware-ag/app-server-sdk";
import {
	ApiContext,
	EntityRepository,
} from "@shopware-ag/app-server-sdk/helper/admin-api";
import { Criteria } from "@shopware-ag/app-server-sdk/helper/criteria";

/**
 * Pre-operation state capturing for the audit/rollback system.
 *
 * Each snapshot returns exactly the fields a corresponding *_update tool can
 * write, so the snapshot can be replayed verbatim to undo a change.
 */

export async function snapshotProduct(
	client: HttpClient,
	id: string,
): Promise<Record<string, unknown> | null> {
	const repo = new EntityRepository<Record<string, unknown>>(client, "product");
	const criteria = new Criteria([id]);
	criteria.addFields(
		"id",
		"productNumber",
		"name",
		"stock",
		"active",
		"price",
		"customFields",
	);
	const p = (await repo.search(criteria, new ApiContext(null, true))).first();
	if (!p) return null;
	return {
		id: p.id,
		productNumber: p.productNumber,
		name: p.name,
		stock: p.stock,
		active: p.active,
		price: p.price,
		customFields: p.customFields,
	};
}

export async function snapshotCategory(
	client: HttpClient,
	id: string,
): Promise<Record<string, unknown> | null> {
	const repo = new EntityRepository<Record<string, unknown>>(client, "category");
	const criteria = new Criteria([id]);
	criteria.addFields("id", "name", "parentId", "active", "cmsPageId");
	const c = (await repo.search(criteria, new ApiContext(null, true))).first();
	if (!c) return null;
	return {
		id: c.id,
		name: c.name,
		parentId: c.parentId,
		active: c.active,
		cmsPageId: c.cmsPageId,
	};
}

export async function snapshotCmsSlot(
	client: HttpClient,
	id: string,
): Promise<Record<string, unknown> | null> {
	const repo = new EntityRepository<Record<string, unknown>>(client, "cms_slot");
	const criteria = new Criteria([id]);
	criteria.addFields("id", "type", "slot", "config", "fieldConfig");
	const s = (await repo.search(criteria, new ApiContext(null, true))).first();
	if (!s) return null;
	return {
		id: s.id,
		type: s.type,
		slot: s.slot,
		config: s.config,
		fieldConfig: s.fieldConfig,
	};
}

export async function snapshotProductPrices(
	client: HttpClient,
	productId: string,
	ruleId?: string,
): Promise<Record<string, unknown>[]> {
	const repo = new EntityRepository<Record<string, unknown>>(
		client,
		"product_price",
	);
	const criteria = new Criteria();
	criteria.addFilter(Criteria.equals("productId", productId));
	if (ruleId) criteria.addFilter(Criteria.equals("ruleId", ruleId));
	const res = await repo.search(criteria, new ApiContext(null, true));
	return res.data as Record<string, unknown>[];
}

export async function snapshotOrderState(
	client: HttpClient,
	id: string,
): Promise<Record<string, unknown> | null> {
	const repo = new EntityRepository<Record<string, unknown>>(client, "order");
	const criteria = new Criteria([id]);
	criteria.addFields(
		"id",
		"orderNumber",
		"stateMachineState.technicalName",
	);
	const o = (await repo.search(criteria, new ApiContext(null, true))).first();
	if (!o) return null;
	return {
		id: o.id,
		orderNumber: o.orderNumber,
		state: (o as { stateMachineState?: { technicalName?: string } })
			.stateMachineState?.technicalName,
	};
}
