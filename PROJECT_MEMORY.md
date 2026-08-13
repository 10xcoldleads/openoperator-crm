# OpenOperator CRM project memory

This file is the durable orientation point for every coding session. Read it before planning or editing. Update it in the same pull request whenever scope, truth status, architecture, security posture, or the next milestone changes.

## Destination

Build a secure, self-hostable, open-source execution CRM that demonstrates the direction of HighLevel-class systems without copying proprietary source code or pretending incomplete modules work.

The destination is reached only when:

1. Every visible module has a persisted primary journey, workspace authorization, explicit failure behavior, audit evidence, automated acceptance coverage, and browser proof.
2. External providers are optional, workspace-owned, revocable, redacted, replay-safe, and fail closed.
3. Agent actions are least-privilege and human-gated wherever they affect people, money, permissions, exports, deletion, or external communication.
4. A new operator can self-host the product from documented instructions without developer-owned infrastructure or secrets.
5. The feature truth matrix matches the actual code and UI. Missing features remain absent.

This is not a pixel clone and not a promise to reproduce every HighLevel feature. It is a functional open-source alternative built one complete vertical slice at a time.

## Non-negotiable acceptance contract

- Never ship dead controls, placeholder routes, pretend integrations, or success states backed only by local component state.
- Never weaken tenant isolation, authentication, optimistic concurrency, audit atomicity, or provider credential handling to simplify a feature.
- Never adopt an external repository without license, provenance, maintenance, dependency, and security review.
- Treat concurrency losers as expected outcomes while proving exactly one state winner and exactly one audit event.
- A local pass is insufficient for race-sensitive behavior; the clean Linux CI run is the merge gate.
- Keep production auth fail-closed. `ALLOW_INSECURE_LOCAL_AUTH` is for local browser navigation only and must not authorize raw API calls.
- Do not commit customer data, provider secrets, local D1 state, recovery archives, or authenticated browser artifacts.

## Current proven baseline

Merged to `main` on 2026-08-13 as commit `0614ecb` through PR #1.

Visible and functional:

- Dashboard and executive briefing
- Contacts, companies, notes, relationships, duplicates, imports, saved views, custom fields, custom objects, and layouts
- Opportunities, multiple pipelines, stage governance, forecasts, bulk movement, and record drill-down
- Tasks and bounded calendar views
- Deterministic automations with versioned definitions, branches, retries, cancellation, traces, and action caps
- Scoped agent credentials, MCP discovery/execution, work queues, proposals, human decisions, and audit history
- Source credentials, webhooks, mailbox metadata, Resend transactional delivery, operations health, encrypted recovery, and launch readiness
- Workspace membership, roles, permission policies, Cloudflare Access JWT validation, and fail-closed production behavior

Explicitly omitted from navigation:

- Full conversations inbox and consent-aware composer
- Public booking and calendar-provider sync
- Sites/forms/surveys builder
- Payments and reconciliation
- Marketing/social publishing
- Reputation management
- Full attribution, ads, and call reporting
- Voice carrier and unrestricted chat agents

Authoritative detail: `docs/FEATURE_TRUTH_MATRIX.md`.

## Evidence at the baseline

- GitHub PR #1: `verify`, CodeQL, and security checks passed from a clean Ubuntu checkout.
- Local acceptance: 32 rendered UI/security tests.
- Worker/D1 acceptance: all 186 tests across stress, extended, domain, auth, MCP, and platform shards.
- Edge ingestion: 25 tests.
- TypeScript and ESLint: clean.
- Dependency audit: zero known npm vulnerabilities at merge time.
- Twenty CRM provenance contracts pinned to commit `1f55234d0bd1abe20e5615dc5830b254a54831ef`.

## Important decisions and why

| Decision | Reason |
|---|---|
| Cloudflare Workers + D1 | Self-hostable edge runtime with explicit tenant and credential boundaries. |
| Vinext/React operator UI | React ergonomics while producing a Worker/static-assets deployment shape. |
| One workspace scope on every business row | Tenant isolation is a data-model invariant, not a UI filter. |
| Optimistic version guards | Prevent silent overwrite and make concurrent operator outcomes explicit. |
| Audit and mutation in one D1 batch | A business mutation without its audit, or an audit without its mutation, is a defect. |
| `atomic_mutation_guard` constraint | Forces a D1 batch rollback when an optimistic mutation loses after an audit-first statement. |
| Human-gated sensitive agent actions | Models propose; stored structured actions and policy decide what may execute. |
| Functional-only navigation | The interface is a truthful capability contract. |
| Pinned upstream provenance | Prevents an open-source reference from silently changing under local contracts. |

## Current workstream

Branch: `agent/conversations-core`.

Milestone completed locally: the first truthful Conversations vertical slice extends the existing mailbox metadata and Resend boundaries. It includes a workspace-scoped thread/message ledger, stable provider thread identity, contact association, consent and suppression policy, idempotent delivery state, an inbox UI, negative authorization tests, concurrency tests, and Edge desktop/mobile acceptance. Conversations may remain visible because its primary journey passed. Publish the branch and merge only through green CI.

Evidence on 2026-08-13: `npm test` passed (32 rendered/runtime checks, all 187 worker tests across six shards, 25 ingestion tests); `npm run lint` passed; `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities. Edge acceptance proved desktop navigation, consent-blocked send, zero console errors, and distinct 48px mobile navigation hit targets with no document overflow.

## Next milestone sequence

1. Secure forms: versioned form definitions, public write-only intake, consent evidence, publish/revoke lifecycle.
2. Booking: availability rules, public booking, conflict prevention, cancellation/reschedule, provider adapter boundary.
3. Reporting slices: only reports backed by real first-party data, beginning with funnel/source and pipeline conversion.
5. Payments: provider-neutral ledger before any Stripe surface.

Reorder only when new evidence changes risk or dependency order; record the decision here.

## Session handoff checklist

Before ending meaningful work:

1. Update the proven baseline and current workstream in this file.
2. Update `docs/FEATURE_TRUTH_MATRIX.md` if visible or omitted scope changed.
3. Record new architecture/security decisions here or in `docs/ARCHITECTURE.md`.
4. Record exact test and CI evidence; never write "tested" without scope.
5. Leave the working tree clean or document intentional uncommitted files.
6. Link the active branch/PR and state the next failing or pending acceptance item.
