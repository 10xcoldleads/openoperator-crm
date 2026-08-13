# Product catalog architecture

## Decision

CRM capabilities must be declared once in `contracts/productCatalog.ts` and
consumed by both the React application and the Cloudflare Worker.

The catalog is metadata, not executable code. Its `editor`, `executor`,
`healthCheck`, and `revoke` values are stable keys that must be explicitly
registered by the corresponding runtime.

## Catalogs

### Automation

The automation catalog owns:

- trigger IDs, labels, record types, and invocation modes;
- condition fields, value types, and compatible operators;
- action labels, compatible record types, authority capabilities, approval
  policy, editors, executors, and declared outputs;
- record variables that may be used in templates.

The workflow definition remains versioned data. A visual node position is not
execution order. Until graph topology is persisted explicitly, execution order
is the order of the `actions` and `else_actions` arrays.

### Integrations

Each integration declares:

- category and availability;
- authentication strategy;
- bounded capabilities;
- required runtime bindings;
- setup, health, execution, and revocation handler keys.

`planned` means visible roadmap only. Planned entries must not declare runtime
handlers and must never render an enabled connect action.

`implemented` means the complete lifecycle is registered: setup, readiness,
health, execution, and revocation. The authenticated
`GET /v1/admin/product-catalog` endpoint adds environment-specific readiness
without returning secret values.

### Pipeline

The pipeline catalog declares board interaction and mutation contracts.
`updated_at` remains the optimistic-concurrency token. Drag-and-drop must use the
same mutation endpoint and server-side transition enforcement as the accessible
"Move to" fallback.

## Change protocol

Adding a capability requires this order:

1. Add or version the catalog entry.
2. Implement the Worker executor and lifecycle handlers.
3. Register those handlers independently in the Worker.
4. Implement the UI editor/setup renderer.
5. Add contract, failure, permission, and lifecycle tests.
6. Expose the feature only when runtime readiness is true.

The product-catalog endpoint fails closed when metadata is internally invalid or
when implemented handler keys are not registered by the Worker.

## UI migration sequence

1. Replace hardcoded integration tabs with Catalog and Installed views.
2. Introduce one shared integration setup drawer.
3. Split `CrmDashboard.tsx` into domain modules.
4. Rebuild Automations as node library, canvas, and inspector panes.
5. Add accessible pipeline drag-and-drop with conflict rollback.
6. Remove the legacy CSS override layers after each migrated surface is covered
   by visual and interaction tests.

