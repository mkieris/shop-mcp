import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "@shopware-ag/app-server-sdk";
import { EntityRepository } from "@shopware-ag/app-server-sdk/helper/admin-api";
import { Criteria } from "@shopware-ag/app-server-sdk/helper/criteria";
import z from "zod";
import { withAudit } from "../audit.js";
import { serializeLLM } from "../shopware.js";
import { snapshotOrderState } from "../snapshot.js";

const orderStatuses = [
	"open",
	"in_progress",
	"completed",
	"cancelled",
] as const;

type OrderListItem = {
	id: string;
	orderNumber: string;
	orderDateTime: string;
	amountTotal: number;
	primaryOrderDelivery: {
		stateMachineState: {
			technicalName: string;
		};
	};
	primaryOrderTransaction: {
		stateMachineState: {
			technicalName: string;
		};
	};
	stateMachineState: {
		technicalName: string;
	};
	currency: {
		name: string;
	};
};

// list orders, list by status,
export function orderList(server: McpServer, httpClient: HttpClient) {
	server.tool(
		"order_list",
		{
			page: z.number().min(1).default(1),
			term: z
				.string()
				.optional()
				.describe("Search term to search in order number"),
			filters: z
				.object({
					status: z
						.enum(orderStatuses)
						.optional()
						.describe("Filter by order status"),
				})
				.optional(),
		},
		async (data) => {
			const orderRepository = new EntityRepository<OrderListItem>(
				httpClient,
				"order",
			);
			const criteria = new Criteria<OrderListItem>();
			criteria.addSorting(Criteria.sort("orderDateTime", "DESC"));
			criteria.setLimit(20);
			criteria.setPage(data.page);
			criteria.addFields(
				"id",
				"orderNumber",
				"orderDateTime",
				"amountTotal",
				"primaryOrderDelivery.stateMachineState.technicalName",
				"primaryOrderTransaction.stateMachineState.technicalName",
				"stateMachineState.technicalName",
				"currency.name",
			);

			if (data.term) {
				criteria.setTerm(data.term);
			}

			if (data.filters?.status) {
				criteria.addFilter(
					Criteria.equals(
						"stateMachineState.technicalName",
						data.filters.status,
					),
				);
			}

			const orders = await orderRepository.search(criteria);

			return {
				content: [
					{
						type: "text",
						text: serializeLLM(orders),
					},
				],
			};
		},
	);
}

type OrderDetailItem = {
	id: string;
	orderNumber: string;
	orderDateTime: string;
	amountTotal: number;
	primaryOrderDelivery: {
		stateMachineState: {
			technicalName: string;
		};
		trackingCodes: string[];
	};
	primaryOrderTransaction: {
		stateMachineState: {
			technicalName: string;
		};
	};
	stateMachineState: {
		technicalName: string;
	};
	lineItems: {
		referencedId: string;
		label: string;
		quantity: number;
		position: number;
		unitPrice: number;
		totalPrice: number;
	}[];
	currency: {
		name: string;
	};
};

// get detailed a single order
export function orderDetail(server: McpServer, httpClient: HttpClient) {
	server.tool(
		"order_detail",
		{
			id: z.string().describe("The ID of the order to retrieve"),
		},
		async (data) => {
			const orderRepository = new EntityRepository<OrderDetailItem>(
				httpClient,
				"order",
			);
			const criteria = new Criteria<OrderDetailItem>([data.id]);
			criteria.addFields(
				"id",
				"orderNumber",
				"orderDateTime",
				"amountTotal",
				"primaryOrderDelivery.stateMachineState.technicalName",
				"primaryOrderDelivery.trackingCodes",
				"primaryOrderTransaction.stateMachineState.technicalName",
				"stateMachineState.technicalName",
				"currency.name",
				"lineItems.referencedId",
				"lineItems.label",
				"lineItems.quantity",
				"lineItems.position",
				"lineItems.unitPrice",
				"lineItems.totalPrice",
			);

			const orders = await orderRepository.search(criteria);

			return {
				content: [
					{
						type: "text",
						text: serializeLLM(orders),
					},
				],
			};
		},
	);
}

// update order status only (address updates removed for GDPR/DSGVO compliance)
export function orderUpdate(server: McpServer, httpClient: HttpClient) {
	server.tool(
		"order_update",
		{
			id: z.string().describe("The ID of the order to update"),
			status: z
				.enum(["cancel", "reopen", "in_progress", "completed"])
				.describe("The new status of the order"),
		},
		async (data) => {
			const before = await snapshotOrderState(httpClient, data.id);
			const { event } = await withAudit(
				{
					tool: "order_update",
					entityType: "order_state",
					entityId: data.id,
					sku: (before?.orderNumber as string) ?? null,
					payloadIn: { status: data.status },
					payloadBefore: before,
				},
				() =>
					httpClient.post(`/_action/order/${data.id}/state/${data.status}`),
			);

			return {
				content: [
					{
						type: "text",
						text: `Order ${data.id} status updated to ${data.status}. operationId: ${event.operationId} (Hinweis: Order-Status-Rollback nur über erneute Status-Transition möglich)`,
					},
				],
			};
		},
	);
}
