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

Merged foundation, Conversations, secure Forms, local-first Booking, and truthful first-party Reporting milestones to `main` on 2026-08-13; current main is `3a8e123` through PR #10.

Visible and functional:

- Dashboard and executive briefing
- Contacts, companies, notes, relationships, duplicates, imports, saved views, custom fields, custom objects, and layouts
- Opportunities, multiple pipelines, stage governance, forecasts, bulk movement, and record drill-down
- Tasks and bounded calendar views
- Deterministic automations with versioned definitions, branches, retries, cancellation, traces, and action caps
- Scoped agent credentials, MCP discovery/execution, work queues, proposals, human decisions, and audit history
- Source credentials, webhooks, mailbox metadata, Resend transactional delivery, operations health, encrypted recovery, and launch readiness
- Consent-aware Conversations with persisted email threads, explicit mailbox sync, delivery receipts, permission/suppression evidence, and replay-safe Resend sending
- Versioned secure Forms with public intake, separate privacy/marketing choices, revocation, and submission evidence
- Local-first Booking with governed publication, public availability, replay-safe booking, and private reschedule/cancel tokens
- Truthful first-party Reporting with bounded cohorts, permission-aware pipeline snapshots, and currency-separated values
- Admin-only provider-neutral Payments register with immutable manual payment/refund/dispute/reversal events and currency-separated balances
- Workspace membership, roles, permission policies, Cloudflare Access JWT validation, and fail-closed production behavior

Explicitly omitted from navigation:

- Sites and surveys builders
- Calendar-provider sync; payment processors, banking, invoices, payouts, settlements, FX conversion, and reconciliation
- Marketing/social publishing
- Reputation management
- Full attribution, ads, and call reporting
- Voice carrier and unrestricted chat agents

Authoritative detail: `docs/FEATURE_TRUTH_MATRIX.md`.

## Evidence at the baseline

- GitHub PRs through #11: milestone PRs passed clean Ubuntu `verify`, CodeQL, and GitGuardian before merge.
- Current local acceptance on the Payments branch: 36 rendered UI/security tests.
- Worker/D1 acceptance: all 191 tests across stress, extended, domain, auth, MCP, and platform shards.
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
| Immutable published form versions | A draft edit cannot retroactively change the fields or consent language a submitter saw. |
| Separate privacy acknowledgement and optional marketing consent | A service request is not treated as marketing permission; opt-out suppression always wins. |
| Public forms are write-only by slug | Visitors can fetch only the active published snapshot and submit bounded values; CRM data and draft history remain private. |
| Booking management tokens are fragment-delivered and hash-only at rest | Private management credentials stay out of server logs and cannot be recovered from D1. |
| Local-first booking provider boundary | A working self-hosted calendar is truthful today; external sync remains explicitly false until a real adapter is implemented. |
| Reporting uses bounded created-record cohorts | Current state can be shown honestly without pretending the system has historical transition events it never stored. |
| First-touch is directional, never causal attribution | A retained source label is evidence of grouping, not proof that a channel caused revenue. |
| Monetary values remain separated by currency | Reporting never silently adds unlike currencies without an explicit FX normalization source. |
| Payment corrections are new immutable events | Money history is append-only: refunds, disputes, and reversals reference an original payment instead of rewriting it. |
| Manual payment boundary precedes provider adapters | The CRM can truthfully record verified off-platform money events without pretending Stripe, banking, invoices, payouts, or settlements are connected. |
| Payment retries are idempotent and adjustments are bounded atomically | Retries cannot duplicate money events; concurrent refunds/disputes cannot exceed the original payment, and reversals cannot exceed disputed value. |
| Survey summaries are grouped by immutable publication version | Editing a draft cannot relabel, reorder, or reinterpret historical response evidence. |
| Survey privacy acknowledgement is not marketing consent | Anonymous research responses record the required data-use acknowledgement but never create a communication opt-in or Contact implicitly. |

## Current workstream

Active branch: `agent/surveys`; no implementation PR yet.

Booking merged through PR #9, first-party Reporting through PR #10, and provider-neutral Payments through PR #11. Payments is now on `main` at merge commit `387054bc518a6b13a75ed15661e3f54528b95b9e`; it adds migration `0051`, admin-only APIs, immutable/idempotent payment events, bounded append-only adjustments, recovery validation, contact/opportunity selectors, currency-separated balances, explicit manual-provider disclosures, and a responsive ledger UI.

Reporting evidence on 2026-08-13: `npm test` passed (35 rendered/runtime checks, all 190 worker tests across six shards, and 25 ingestion tests); TypeScript and ESLint passed; Twenty provenance passed; npm audit reported zero vulnerabilities. Aggregation tests prove bounded range rejection, cohort exclusion, lifecycle/source grouping, currency separation, and opportunity-permission redaction. Edge proved filter changes, methodology disclosures, zero application console errors, and 390px body containment with an internally scrolling source register. PR #10 clean Linux `verify`, CodeQL, and GitGuardian passed before merge.

Payments local evidence on 2026-08-13: `npm test` passed (36 rendered/runtime checks, all 191 Worker tests across six supported shards, and 25 ingestion tests); TypeScript, ESLint, Twenty provenance, and build passed; production `npm audit` reported zero vulnerabilities. Worker acceptance proves admin isolation, immutable rows, idempotent replay, provider-reference uniqueness, currency matching, atomic concurrent adjustment caps, audit atomicity, and recovery-table coverage. Edge proved a real $125.50 manual payment followed by a linked $25.50 refund, correct $100.00 net/$125.50 gross/$25.50 refunded balances, explicit no-provider/no-FX disclosures, zero application console errors, and 390px body containment with only the ledger tape scrolling internally. Browser QA also caught and drove the repair of a non-opening adjustment editor before this evidence was recorded.

Payments remote evidence: PR #11 clean Linux `verify` passed in 4m31s; CodeQL analysis and result passed; GitGuardian passed; merged 2026-08-13 at `387054b`.

Surveys merged through PR #12 at merge commit `cdaf156c2deb255b973c3677689ea3c3af2564ba`. The next vertical slice is Sites. It remains omitted until its page/version/publication/domain lifecycle is independently mapped and proven; Forms and Surveys may supply versioning patterns, but neither is a website builder.

Survey implementation on active branch: migration `0052_surveys_core.sql` and Drizzle schema define workspace-scoped drafts, immutable published versions, and immutable responses. Questions use stable operator-defined IDs and support bounded short text, long text, email, single choice, multiple choice, and 1–5 rating types. Admin APIs cover list/create/detail/edit/publish/revoke and bounded response evidence; mutations require an admin role, optimistic revisions, explicit lifecycle confirmation, and atomic audit. Public APIs expose only the active frozen snapshot and accept privacy-required, honeypot/rate-bounded, replay-safe anonymous answers. Response summaries are grouped by the immutable publication version rather than the current draft, and the UI exposes both version summaries and a bounded recent-response ledger. Recovery schema version 29 validates survey references, slugs, versions, replay keys, question shape, privacy, timestamps, and duration.

Survey local evidence on 2026-08-13: build, TypeScript, ESLint, Twenty provenance, and 37 rendered/runtime tests pass. All 192 Worker tests pass across stress, extended, domain, authorization/transport, MCP, and platform-data shards; the focused lifecycle test proves member mutation denial, draft invisibility, a 200/409 concurrent publish race, one immutable version, no marketing-consent request, invalid privacy/rating rejection, idempotent replay and mismatch conflict, immutable response rows, version-faithful summaries after a later draft edit, and immediate revoke. Ingestion acceptance passes 25/25 and production `npm audit --omit=dev` reports zero vulnerabilities.

Survey Edge acceptance: an admin created `Browser acceptance pulse`, saved its introduction, used the two-step publication control, and opened its frozen V1 public route. The public page displayed the required rating and separate privacy acknowledgement with the explicit text `No marketing consent is requested`, accepted a real 5/5 response, and rendered its success state. The admin response evidence then showed one V1 response, a 5.0/5 aggregate, and the recent immutable response entry. At 390px, the public page reported `innerWidth=scrollWidth=bodyWidth=390`; the admin page reported `innerWidth=390`, `bodyWidth=scrollWidth=375`, and a 323px survey layout. Both pages had zero application-origin console errors. Browser QA initially failed because a build hot reload left the local Worker without a generated RSC manifest; restarting from the completed build restored the server and proved the final journey.

Survey remote evidence: PR #12 clean Linux `verify` passed in 4m36s on the final evidence commit; CodeQL analysis and result passed; GitGuardian passed. It merged 2026-08-13 at `cdaf156`.

Sites orientation on active branch `agent/sites`: the first release is an explicitly hosted-path builder, not a custom-domain product. It needs workspace-scoped sites, ordered pages, immutable publication versions, bounded component schemas, SEO metadata, public rendering, admin-only revision/audit lifecycle, recovery contracts, responsive proof, and immediate revoke. Domain fields may be modeled only as inactive/verification-pending metadata until authoritative DNS ownership, collision prevention, TLS/route provisioning, and removal are all implemented and tested. Arbitrary HTML/JavaScript, uploads, analytics injection, custom CSS, commerce, blogs, memberships, and custom domains remain false for the first slice.

Sites foundation: migration `0053_sites_core.sql`, Drizzle models, and recovery schema version 30 now define workspace-scoped site drafts and immutable publication snapshots. A site contains 1–10 uniquely pathed pages; each page contains 1–20 ordered, stable-ID components from a closed `hero`, `text`, `features`, or `cta` schema. Text, item counts, links, page paths, theme colors, and font choices are bounded. Links accept only same-site relative paths or credential-free HTTPS URLs. Custom domains are forced to `null`/`disabled` by recovery validation because routing and ownership proof are not implemented. TypeScript passes this foundation; APIs, UI, lifecycle tests, and browser proof remain pending, so Sites remains omitted from navigation.

## Next milestone sequence

1. Surveys: separate versioned publish/respond lifecycle and response evidence; do not relabel Forms.
2. Sites: independent page/version/publication/domain lifecycle after Surveys.

Reorder only when new evidence changes risk or dependency order; record the decision here.

## Session handoff checklist

Before ending meaningful work:

1. Update the proven baseline and current workstream in this file.
2. Update `docs/FEATURE_TRUTH_MATRIX.md` if visible or omitted scope changed.
3. Record new architecture/security decisions here or in `docs/ARCHITECTURE.md`.
4. Record exact test and CI evidence; never write "tested" without scope.
5. Leave the working tree clean or document intentional uncommitted files.
6. Link the active branch/PR and state the next failing or pending acceptance item.
