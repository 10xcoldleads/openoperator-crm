# Self-hosting

## 1. Prerequisites

- Cloudflare account with Workers and D1 access
- Node.js 22.13+
- Git and npm
- A domain you control if you want custom hostnames
- An identity-aware access layer for the CRM hostname

Third-party providers are optional. Create those accounts only for modules you intend to enable.

## 2. Install and test locally

```bash
git clone <your-fork-url>
cd openoperator-crm
npm ci
npx wrangler d1 migrations apply DB --local --config wrangler.test.jsonc
npm test
npm run dev
```

Local D1 state is separate from production and remains under `.wrangler/state`; it must not be committed.
The default development command deliberately builds before serving so local acceptance exercises the production asset layout. Use `npm run dev:hot` only for edit feedback, then verify every UI change with `npm run dev`.

## 3. Create production infrastructure

```bash
npx wrangler login
npx wrangler d1 create openoperator-crm
```

Copy the returned database ID into your production Wrangler configuration. Replace the placeholder CRM and intake domains. Do not reuse the test database ID.

Apply migrations explicitly:

```bash
npx wrangler d1 migrations list openoperator-crm --remote
npx wrangler d1 migrations apply openoperator-crm --remote
```

Wrangler may return `incomplete input` while batching trigger-heavy migrations `0017` or `0038` against remote D1 even though the SQL is valid locally. If that occurs, execute that single file with `wrangler d1 execute DB --remote --file drizzle/<migration>.sql`, verify the resulting tables/triggers, record its filename in `d1_migrations`, and resume `migrations apply`. Never mark a migration applied before verifying that the direct file execution succeeded.

## 4. Configure secrets

Generate independent random values for every enabled security boundary. Store them with `wrangler secret put`; do not place them in JSON, source, CI logs, command history, or GitHub variables exposed to forks.

| Binding | Minimum | Required for |
|---|---:|---|
| `WEBHOOK_ENCRYPTION_KEY` | 24 characters | Encrypting workspace webhook, Resend, and provider credentials |
| `RECOVERY_ENCRYPTION_KEY` | 32 characters | Encrypted backup export, validation, and restore |
| `UNSUBSCRIBE_SIGNING_KEY` | 32 characters | Marketing recipient freezing, review-request feedback links, and immediate email opt-out |
| `SCHEDULER_SECRET` | 32 characters | Authenticating internal scheduled-job requests; use the same value on the CRM and intake Workers |
| `SITES_BYPASS_TOKEN` | 32 random bytes | The private intake-to-CRM service hop; configure only on the intake Worker and the platform route that validates `oai-sites-authorization` |

Set each secret against the intended Worker configuration and verify the binding names in the Cloudflare dashboard before deployment. Generate values with a cryptographically secure password manager or operating-system generator; never reuse keys between rows. `RECOVERY_PREVIOUS_ENCRYPTION_KEYS` is only for a documented recovery-key rotation window and must not contain the current key. Marketing and Review requests remain truthfully disabled until `UNSUBSCRIBE_SIGNING_KEY` is configured; outbound email also requires an operator-created, server-verified Resend connection in the application.

Configure `ADMIN_EMAILS` with real operator identities and put the CRM behind a Cloudflare Access self-hosted application that admits only those identities. Copy the Access application audience tag to `POLICY_AUD` and set `TEAM_DOMAIN` to the complete `https://<team>.cloudflareaccess.com` issuer. The Worker validates the Access JWT signature, issuer, audience, and email claim before converting it to an internal identity; it does not trust the email header on its own. Cloudflare recommends validating `Cf-Access-Jwt-Assertion` even when Access is in front of a Worker.

`ALLOW_INSECURE_LOCAL_AUTH=true` exists solely for Miniflare and local tests. The production configuration must omit it. A deployment with neither valid Access settings nor the local-only override fails closed with HTTP 503. Do not expose the `workers.dev` preview hostname as an alternative route around your Access-protected custom domain.

The intake hostname must not share interactive CRM routes.

## 5. Deploy

Run a dry run first:

```bash
npx wrangler deploy --dry-run
npx wrangler deploy --config ingest-worker/wrangler.jsonc --dry-run
```

Deploy the private CRM, verify identity enforcement, then deploy the intake Worker. Test health, unauthorized rejection, one disposable source credential, idempotent ingestion, and credential revocation before accepting real traffic.

In Workers > Domains, set both the production Worker URL and preview URLs to **Restricted**. Cloudflare creates an Access application and exposes the audience tag and JWKS URL. Put those values into `POLICY_AUD` and `TEAM_DOMAIN`, redeploy, and confirm an anonymous browser receives the Access login screen rather than CRM HTML.

## 6. Optional providers

Enable providers individually. Required credentials and callbacks are shown in the Integrations workspace. A provider is operational only after its server-side verification succeeds.

- Email: sending-only provider key and verified sender domain
- Mailboxes: provider OAuth through a managed broker or your own OAuth app
- Agents: scoped OpenClaw/Hermes credential and explicit workspace pickup policy
- Alerts: signed webhook destination or PagerDuty routing key
- Messaging/voice/payments: implement a dedicated adapter plus provider compliance; none are implied by the core deployment

## 7. Production acceptance gate

- Authentication rejects anonymous CRM reads.
- Cross-workspace reads and writes fail.
- Every mutation produces audit evidence.
- Duplicate ingestion is idempotent.
- Revoked credentials stop immediately.
- Webhook signing and replay rejection pass.
- Automation run caps and failure traces pass.
- Agent proposals require human approval.
- Backups encrypt and restore into a disposable workspace.
- Desktop and mobile operator journeys pass without hidden or dead controls.
