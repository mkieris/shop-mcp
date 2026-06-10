import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "@shopware-ag/app-server-sdk";
import {
	auditGetOperation,
	auditRollback,
	auditRollbackRange,
	auditSearch,
} from "./audit.js";
import {
	categoryCreate,
	categoryDelete,
	categoryList,
	categoryUpdate,
} from "./category.js";
import {
	countryList,
	dalAggregate,
	fetchEntitySchema,
	fetchEntitySchemaListEntities,
} from "./general.js";
import { uploadMediaByUrl } from "./media.js";
import { orderDetail, orderList, orderUpdate } from "./order.js";
import {
	productCreate,
	productGet,
	productList,
	productUpdate,
} from "./product.js";
import {
	productPriceBulkSet,
	productPriceDelete,
	productPriceList,
	productPriceSet,
	ruleList,
} from "./pricing.js";
import {
	cmsBlockDelete,
	cmsBlockUpdate,
	cmsPageCreate,
	cmsPageDelete,
	cmsPageDetail,
	cmsPageList,
	cmsPageUpdate,
	cmsSectionCreate,
	cmsSectionDelete,
	cmsSectionUpdate,
	cmsSlotUpdate,
} from "./cms.js";
import { salesChannelList, salesChannelUpdate } from "./sales_channel.js";
import { themeConfigChange, themeConfigGet } from "./theme.js";

export function configureTools(server: McpServer, client: HttpClient) {
	fetchEntitySchemaListEntities(server, client);
	fetchEntitySchema(server, client);
	dalAggregate(server, client);
	countryList(server, client);

	salesChannelList(server, client);
	salesChannelUpdate(server, client);

	themeConfigGet(server, client);
	themeConfigChange(server, client);

	uploadMediaByUrl(server, client);

	// Category tools
	categoryList(server, client);
	categoryCreate(server, client);
	categoryUpdate(server, client);
	categoryDelete(server, client);

	// Product tools
	productList(server, client);
	productGet(server, client);
	productCreate(server, client);
	productUpdate(server, client);

	// Advanced Pricing tools
	productPriceList(server, client);
	productPriceSet(server, client);
	productPriceDelete(server, client);
	productPriceBulkSet(server, client);
	ruleList(server, client);

	// Order tools
	orderList(server, client);
	orderDetail(server, client);
	orderUpdate(server, client);

	// CMS tools
	cmsPageList(server, client);
	cmsPageDetail(server, client);
	cmsPageCreate(server, client);
	cmsPageUpdate(server, client);
	cmsPageDelete(server, client);
	cmsSectionCreate(server, client);
	cmsSectionUpdate(server, client);
	cmsSectionDelete(server, client);
	cmsBlockUpdate(server, client);
	cmsBlockDelete(server, client);
	cmsSlotUpdate(server, client);

	// Audit & rollback tools (multi-user accountability)
	auditSearch(server, client);
	auditGetOperation(server, client);
	auditRollback(server, client);
	auditRollbackRange(server, client);
}
