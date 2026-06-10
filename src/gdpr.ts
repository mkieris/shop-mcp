/**
 * Central GDPR / DSGVO compliance configuration.
 *
 * The MCP server is read/write capable on the Shopware Admin API and would
 * otherwise be able to expose, aggregate or export personally identifiable
 * information (PII). To keep the surface narrow, we maintain two block lists:
 *
 *  - BLOCKED_ENTITIES: entities that must never be queried, aggregated or
 *    have their schema exposed.
 *  - BLOCKED_FIELD_PATTERNS: field paths (dot notation, lower-cased,
 *    regex-matched) that must never be read, filtered on, or aggregated –
 *    even when the parent entity itself is allowed (e.g. `order ->
 *    orderCustomer.email`).
 */

/** Entities containing personal data – fully blocked. */
export const BLOCKED_ENTITIES: ReadonlySet<string> = new Set([
	"customer",
	"customer_address",
	"customer_group_registration_sales_channels",
	"customer_recovery",
	"customer_tag",
	"customer_wishlist",
	"customer_wishlist_product",
	"order_customer",
	"order_address",
	"newsletter_recipient",
	"user",
	"user_recovery",
	"user_access_key",
	"acl_user_role",
	"log_entry",
]);

/**
 * Field-path patterns (case-insensitive, matched against the lower-cased field
 * path) that expose personal data even when accessed through an allowed entity.
 *
 * Matched with `String.includes` for nested paths AND `RegExp.test` for
 * exact leaf names.
 */
const BLOCKED_FIELD_SUBSTRINGS: readonly string[] = [
	"customer",
	"ordercustomer",
	"billingaddress",
	"shippingaddress",
	"orderaddress",
	"newsletter",
	"recipient",
	"recovery",
	"useraccess",
	"acluser",
];

const BLOCKED_FIELD_LEAFS: readonly RegExp[] = [
	/(^|\.)email$/i,
	/(^|\.)firstname$/i,
	/(^|\.)lastname$/i,
	/(^|\.)phone(number)?$/i,
	/(^|\.)mobile$/i,
	/(^|\.)fax$/i,
	/(^|\.)birthday$/i,
	/(^|\.)dateofbirth$/i,
	/(^|\.)salutation$/i,
	/(^|\.)street$/i,
	/(^|\.)zipcode$/i,
	/(^|\.)city$/i,
	/(^|\.)additionaladdressline[12]$/i,
	/(^|\.)vatid(s)?$/i,
	/(^|\.)password$/i,
	/(^|\.)hash$/i,
	/(^|\.)recoveryid$/i,
	/(^|\.)remoteaddress$/i,
	/(^|\.)ipaddress$/i,
	/(^|\.)ip$/i,
];

/** Returns true if the entity name is fully blocked. */
export function isBlockedEntity(entity: string): boolean {
	return BLOCKED_ENTITIES.has(entity);
}

/**
 * Returns true if the dot-notation field path touches personal data.
 * Use this for any user-provided field argument (aggregation field, filter
 * field, sort field, etc.).
 */
export function isBlockedFieldPath(field: string): boolean {
	if (!field) return false;
	const lower = field.toLowerCase();

	for (const sub of BLOCKED_FIELD_SUBSTRINGS) {
		if (lower.includes(sub)) return true;
	}
	for (const re of BLOCKED_FIELD_LEAFS) {
		if (re.test(field)) return true;
	}
	return false;
}

/** Standard refusal payload for MCP tool responses. */
export function gdprRefusal(reason: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: `Blocked for GDPR/DSGVO compliance: ${reason}`,
			},
		],
	};
}
