# OpenOperator CRM

OpenOperator is a Cloudflare-native, open-source CRM for teams that want an operational system—not a dashboard full of placeholders. It connects contacts, companies, opportunities, tasks, notes, bounded automations, human-approved agent work, webhooks, and audit history in one workspace-scoped event model.

This project is an independent open-source implementation. It is not affiliated with, endorsed by, or derived from GoHighLevel source code. Product research was limited to read-only observation of ordinary CRM capabilities and workflows.

## What works

- Multi-workspace membership and role enforcement
- Contacts, companies, deduplication, custom fields, saved views, imports, notes, and activity history
- Configurable pipelines, stages, opportunities, forecasting, and optimistic updates
- Tasks with contact/opportunity relationships and lifecycle controls
- Visual event-driven automations with conditions, MATCH/ELSE branches, typed variables, run caps, traces, retries, and cancellation
- Human-gated agent proposals plus scoped OpenClaw/Hermes-compatible work queues
- Source credentials, signed inbound/outbound webhooks, replay protection, retries, health evidence, and audit-atomic mutations
- Encrypted recovery archives and workspace restore validation
- Optional transactional email, mailbox metadata previews, PagerDuty, and external integrations when operators provide credentials
- Responsive operator interface and a comprehensive local D1 test suite

## Intentionally not claimed

The repository does not pretend to include a production telephony carrier, payment processor, social network publisher, full website builder, review network, or autonomous unrestricted AI. Those capabilities require third-party accounts and compliance work. The integration boundaries are documented so operators can add them without weakening the core system.

## Architecture

- UI: React 19 / Next-compatible Vinext application
- Runtime: Cloudflare Workers
- Database: Cloudflare D1
- Public intake: isolated Worker with revocable source credentials and rate controls
- Automation: deterministic, bounded server execution
- Agents: least-privilege MCP tools and human approval before sensitive writes

See [architecture](docs/ARCHITECTURE.md), [self-hosting](docs/SELF_HOSTING.md), and the [feature map](docs/GHL_CAPABILITY_MAP.md).

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci
npx wrangler d1 migrations apply DB --local --config wrangler.test.jsonc
npm run dev
```

The default local owner is `owner@example.com`. Local development deliberately enables header-based test authentication; never enable `ALLOW_INSECURE_LOCAL_AUTH` in a deployed environment. Production requests are authenticated by a validated Cloudflare Access JWT.

## Verification

```bash
npm test
npm run lint
npm run test:typecheck
npm audit --omit=dev --audit-level=moderate
npx wrangler deploy --config ingest-worker/wrangler.jsonc --dry-run
```

No feature belongs in the navigation unless its primary journey has executable acceptance coverage. Optional integrations must display `not configured` until their server-side health check succeeds.

## Deployment

Operators create and own their Cloudflare account, D1 database, domains, secrets, and third-party provider accounts. There are no shared OpenOperator credentials or hosted dependencies. Follow [SELF_HOSTING.md](docs/SELF_HOSTING.md) and replace every `example.com` value before production deployment.

## Security

Read [SECURITY.md](SECURITY.md) before exposing the CRM or intake Worker. Never commit `.dev.vars`, provider credentials, exported CRM data, `.wrangler/state`, or recovery archives.

## License

Apache-2.0. See [LICENSE](LICENSE).
