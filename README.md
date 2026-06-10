# Shopware Admin MCP Server

A Model Context Protocol (MCP) server that provides AI assistants with direct access to Shopware's Admin API for product management tasks.

## Features

- **Product Management**: List, search, create, and update products with media support
- **Category Management**: List, create, update, and delete categories (supports bulk operations)
- **Sales Channel Management**: List sales channels for product visibility
- **Media Management**: Upload media from URLs for product images
- **Order Management**: List and view orders
- **Theme Management**: Change theme colors and logos
- **Shopware Integration**: Native integration with Shopware Admin API

## Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `product_list` | Search and paginate products | `page`, `term` (optional) |
| `product_get` | Get detailed product information | `id` |
| `product_create` | Create new products with pricing and media | `name`, `productNumber`, `description`, `taxRate`, `stock`, `netPrice`, `grossPrice`, `active` (optional), `visibilities` (optional), `categories` (optional), `media` (optional) |
| `product_update` | Update existing products | `id`, `active` (optional), `name` (optional), `description` (optional), `stock` (optional), `visibilities` (optional), `categories` (optional), `media` (optional) |
| `category_list` | List all categories | None |
| `category_create` | Create categories (supports bulk) | `categories` (array with `name`, `parentId` optional, `active` optional) |
| `category_update` | Update categories (supports bulk) | `categories` (array with `id`, `name` optional, `parentId` optional, `active` optional) |
| `category_delete` | Delete categories | `ids` (array of category IDs) |
| `sales_channel_list` | List all sales channels | None |
| `sales_channel_update` | Update a sales channel | `id`, `active` (optional), `maintenance` (optional) |
| `upload_media_by_url` | Upload media from URL | `url`, `fileName` |
| `order_list` | List all orders | `page`, `filters` (optional) |
| `order_detail` | Get detailed order information | `id` |
| `order_update` | Update an order | `id`, `status` (optional) |
| `theme_config_get` | Get the theme configuration for a sales channel | `salesChannelId` |
| `theme_config_change` | Change the theme configuration for a sales channel | `salesChannelId`, `themeId`, `brandPrimaryColor` (optional), `brandSecondaryColor` (optional), `brandBackgroundColor` (optional), `logoId` (optional) |
| `fetch_entity_list` | List all available entities in Shopware | None |
| `fetch_single_entity_schema` | Get the schema for a single entity | `entity` |
| `dal_aggregate` | Aggregate data from the DAL | `entity`, `type`, `field`, `filter` (optional) |

## Prerequisites

- Shopware 6 instance with admin access
- Node.js 22+ for development

## Installation

Create a Integration in Shopware Admin with permission to create, read, update, delete products.

Set following environment variables:

- `SHOPWARE_API_URL`: URL of your Shopware instance (e.g., `https://your-shopware-instance.com`)
- `SHOPWARE_API_CLIENT_ID`: Client ID of the created integration
- `SHOPWARE_API_CLIENT_SECRET`: Client Secret of the created integration

## Usage

### With Claude Code CLI

Add the server using the Claude Code CLI:

```bash
claude mcp add shopware-admin-mcp \
  --env SHOPWARE_API_URL=https://your-shopware-instance.com \
  --env SHOPWARE_API_CLIENT_ID=your-integration-client-id \
  --env SHOPWARE_API_CLIENT_SECRET=your-integration-client-secret \
  -- npx -y @shopware-ag/admin-mcp
```

Replace the placeholder values with your actual Shopware instance URL and integration credentials.

### With mcp.json

Add the following configuration to your mcp.json file:

```json
{
  "mcpServers": {
    "shopware-admin-mcp": {
      "command": "npx",
      "args": ["-y", "@shopware-ag/admin-mcp"],
      "env": {
        "SHOPWARE_API_URL": "https://your-shopware-instance.com",
        "SHOPWARE_API_CLIENT_ID": "your-integration-client-id",
        "SHOPWARE_API_CLIENT_SECRET": "your-integration-client-secret"
      }
    }
  }
}
```

## Development

### Local Development

```bash
# Start local development server in stdio mode
npm run dev
```

### Code Quality

```bash
# Format code
npm run format

# Fix linting issues
npm run lint:fix

# Run type checking
npm run type-check
```

## Permissions

| Entity                  | Read | Create | Update | Delete |
|--------------------------|------|--------|--------|--------|
| **Product**              | ✅   | ✅     | ✅     | ✅     |
| Product Translation      | ✅   | ✅     | ✅     | ✅     |
| Product Visibility       | ✅   | ✅     | ✅     | ✅     |
| Product Category         | ✅   | ✅     | ✅     | ✅     |
| Product Media            | ✅   | ✅     | ✅     | ✅     |
| **Category**             | ✅   | ✅     | ✅     | ✅     |
| Category Translation     | ✅   | ✅     | ✅     | ✅     |
| **Sales Channel**        | ✅   | ✅     | ✅     | ✅     |
| **Media**                | ✅   | ✅     | ✅     | ✅     |
| Media Default Folder     | ✅   | ✅     | ✅     | ✅     |
| Media Folder             | ✅   | ✅     | ✅     | ✅     |
| **Tax**                  | ✅   | ✅     | ✅     | ✅     |
| **Theme**                | ✅   | ✅     | ✅     | ✅     |
| Theme Translation        | ✅   | ✅     | ✅     | ✅     |
| Theme Media              | ✅   | ✅     | ✅     | ✅     |
| Theme Sales Channel      | ✅   | ✅     | ✅     | ✅     |
| **Order**                | ✅   | ✅     | ✅     | ✅     |
| Order Customer           | ✅   | ✅     | ✅     | ✅     |
| Order Delivery           | ✅   | ✅     | ✅     | ✅     |
| Order Transaction        | ✅   | ✅     | ✅     | ✅     |

## GDPR / DSGVO Compliance

This server is hardened so that an AI assistant cannot read, aggregate or
export personally identifiable information (PII) through the Shopware Admin
API. The guarantees are enforced in code (`src/gdpr.ts`), not just by tool
description.

### What is blocked

- **Entity access** — fully blocked in `dal_aggregate` and
  `fetch_single_entity_schema`, and hidden from `fetch_entity_list`:
  `customer`, `customer_address`, `customer_recovery`, `customer_tag`,
  `customer_wishlist`, `customer_wishlist_product`, `order_customer`,
  `order_address`, `newsletter_recipient`, `user`, `user_recovery`,
  `user_access_key`, `acl_user_role`, `log_entry`.
- **Field paths** — `dal_aggregate` rejects any `field` or `filter.field`
  containing PII paths (`orderCustomer.*`, `billingAddress.*`,
  `shippingAddress.*`, `*.email`, `*.firstName`, `*.lastName`, `*.phone`,
  `*.street`, `*.zipcode`, `*.birthday`, `*.vatIds`, IP/remoteAddress, etc.).
  This prevents `terms` aggregation from leaking customer emails via the
  allowed `order` entity.
- **Order tools** — `order_list`, `order_detail` and `order_update` never
  return or accept customer names, emails, addresses or shipping data.
  `order_update` is limited to state transitions.

### Logging

- `logger.logError` records only safe response metadata (`statusCode`,
  `statusText`). Response bodies and headers are **never** written to disk –
  the Shopware API can echo customer emails in validation errors, and those
  must not land in the log file.
- The log file lives at `<package>/logs/mcp-server.log` (rotated at 5 MB,
  3 rotations). The token cache is at `<package>/.cache/token-cache.json`.
  Both stay on the host running the MCP server.

### What is NOT a GDPR boundary

These tools still touch data covered by other compliance regimes – use them
deliberately:

- `theme_config_change`, `cms_*`, `category_*`, `product_*` write to the
  live shop and are visible to all customers.
- `upload_media_by_url` fetches the URL from the host running this server.

## License

MIT License - see LICENSE file for details.

## Support

For issues and feature requests, please use the GitHub issue tracker.
