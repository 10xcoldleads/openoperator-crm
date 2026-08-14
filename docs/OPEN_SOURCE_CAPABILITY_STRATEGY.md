# Open-source capability strategy

## Purpose

OpenOperator is an agent-first execution CRM, not a bundle of adjacent open-source applications. This document decides where a mature upstream should be referenced, adapted, connected as an optional sidecar, or rejected. It must be updated before any third-party runtime or source is added.

The decision rule is stricter than feature resemblance. A candidate must improve the user outcome without creating a second source of truth for workspace identity, Contacts, consent, permissions, automations, audit, or agent approvals. Every adopted boundary must remain self-hostable, revocable, observable, recovery-aware, and testable without developer-owned credentials.

Assessment date: 2026-08-14. Repository activity and security state are time-sensitive and must be rechecked at adoption time.

## What is already ours

The proven core already owns workspace isolation, role and field permissions, Contacts and companies, opportunities and pipelines, tasks, deterministic automations, scoped agent work/proposals, audit, recovery, provider credentials, webhooks, Conversations email, Forms, Booking, Reporting, Payments evidence, Surveys, hosted Sites, consent-aware Marketing email, and first-party Review requests. These domains must not be replaced by an upstream application's account, CRM, workflow, or consent model.

An Estimates slice exists on `agent/estimates`. Migration and Drizzle models are committed; the Worker/recovery/admin UI/public route/test work remains uncommitted. Build, typecheck, lint, focused lifecycle, and rendered/security proof pass. Browser proof is still unavailable, and the repository-wide gate exceeded ten minutes inside the existing `auth-domain` shard, so no commit, PR, or merge has occurred. Completing those acceptance gates still precedes a new external runtime integration.

## Critical capability gaps

| Priority | Outcome | Native ownership | External boundary |
|---|---|---|---|
| P0 | Estimates and customer acknowledgement | Drafts, immutable versions, totals, access, response, audit, recovery | None in the first slice |
| P1 | Instagram/Facebook conversations and comment-to-DM automation | Contact identity links, channel windows, inbound event ledger, workflow triggers/actions, agent proposals, consent/policy, audit | Meta OAuth, Graph API, signed webhooks |
| P2 | Social publishing | Campaign brief, approval, schedule intent, content/version evidence, agent proposal | A provider adapter or optional social-publishing sidecar |
| P3 | Proposals and e-signature | Opportunity/document linkage, approval, status evidence | Optional signature provider; never claim legal effect from a typed acknowledgement |
| P4 | Voice/SMS/WhatsApp | Consent, contact/channel identity, human approval, message/call evidence | Carrier/provider adapters and jurisdiction/platform compliance |
| P5 | Calendar sync | OpenOperator booking authority and conflict evidence | Google/Microsoft calendar adapters |
| P6 | Payment processing/invoicing | Opportunity and immutable financial evidence | Provider checkout, webhook, refund, dispute, invoice adapters |
| P7 | Ad/call attribution and reputation sync | Evidence ledger and methodology | Authoritative provider APIs only |
| P8 | Knowledge, memberships, courses, stores | CRM relationships and agent access policy | Separate bounded services only when a real customer journey requires them |

Priority is dependency-based, not a claim that every HighLevel surface must be reproduced. A capability can remain omitted when an external service already does it better and a governed connection is the honest product.

## Instagram / ManyChat-style decision

The desired outcome is not a standalone chatbot builder. It is a governed social conversation channel inside the existing CRM:

1. A workspace admin connects an Instagram professional account through official Meta OAuth.
2. Signed, replay-safe webhooks record comments, DMs, story replies, postbacks, and delivery evidence.
3. External Instagram identities link to Contacts without silently merging people.
4. The existing Conversations ledger renders the channel.
5. The existing automation engine gains bounded Instagram triggers and actions: comment keyword, inbound DM/reply, private reply to comment, DM reply, quick replies/buttons, wait/timeout branch, tag/task/opportunity actions.
6. Server policy enforces Meta's permitted messaging window and feature-specific limitations before execution.
7. AI may classify, draft, or propose a branch; external replies remain human-gated by workspace policy and execute only the stored structured action.
8. Provider acceptance, delivery, expiration, throttling, auth loss, and permanent failure are distinct persisted outcomes.

### Candidate assessment

| Candidate | Evidence | Decision |
|---|---|---|
| [Chatwoot](https://github.com/chatwoot/chatwoot) | Mature omnichannel inbox; active 4.x releases; root license makes non-`enterprise/` code MIT; dedicated Instagram channel, webhook job, send service, tests, and API. It is also a large Rails application with PostgreSQL/Redis/worker infrastructure and its own accounts, contacts, conversations, permissions, and automation concepts. Current upstream issues show Meta App Review and permission changes remain operational risks. | **Reference and optional sidecar, not embedded product.** Pin and study the community Instagram transport/tests. Prefer a native OpenOperator adapter. A later Chatwoot connector may synchronize channel events through an explicit external-ID ledger for operators who already run it. Never share databases or treat Chatwoot contacts as authoritative. |
| [InstaAuto / `insta-p8`](https://github.com/ayuuxh2/insta-p8) | Literal MIT ManyChat-style feature set: comment/DM/story automation, keyword rules, follower gates, inbox, AI replies. Created 2026; 92 stars/50 forks at review; no GitHub Actions workflow; package scripts contain no tests; `@supabase/supabase-js` is set to `latest`; recent history repairs missing imports, migrations that never installed, RLS gaps, ephemeral serverless counters, and broad `@ts-nocheck` debt. | **Reject runtime/source adoption.** Use only as a feature and failure-mode checklist. Any borrowed MIT idea must be independently specified and implemented against D1, OpenOperator permissions, signed webhooks, replay controls, tests, and audit. |
| [ChatbotX](https://github.com/ChatbotXIO/ChatbotX) | The strongest literal ManyChat alternative found after exact-name correction. Community code outside `apps/builder/src/enterprise` is MIT; enterprise UI paths use a commercial license. Release `v1.2.1` (commit `932eae567885cce5875b861f5c13e4c15896354e`) is an active Node 24/TypeScript monorepo with PostgreSQL/pgvector, Redis/BullMQ, object storage, worker/realtime services, public API, CLI/MCP, channel adapters, a large test corpus, and dedicated Instagram/Instagram-via-Facebook implementations. The Instagram packages cover OAuth/refresh/revoke, signed webhook verification, comments, DMs, contact/conversation sync, private replies, rich messages, normalized errors, and focused tests. Risks: it duplicates CRM/contact/inbox/workflow/agent domains, currently supports only the latest release, uses rolling Docker image tags in the development compose file, and its generic HTTP client retries POST by default—unsafe for non-idempotent provider sends unless each action supplies or proves replay protection. GitHub's top-level license detector reports `NOASSERTION` because of the mixed commercial directory. | **Primary ManyChat capability base, integrated as an optional pinned sidecar plus selectively adapted MIT channel contracts.** Do not merge its databases or enterprise paths into OpenOperator. First prove a black-box API/MCP and webhook bridge against a pinned release/commit; OpenOperator remains authority for Contacts, consent, agent approval, audit, and cross-channel CRM automation. Adapt only the minimum community Instagram transport/schema/test paths when native execution is materially safer than a sidecar call, preserve notices, and remove/restrict automatic POST retries. |
| [Activepieces](https://github.com/activepieces/activepieces) Instagram Business piece | Active MIT community core with a dedicated Instagram Business piece, but that piece currently centers on photo/reel publishing. The full platform is a very large second workflow runtime and has separately licensed enterprise directories. | **Reference small connector patterns only.** Do not embed the workflow engine because OpenOperator already owns deterministic workflows, traces, caps, human approvals, and recovery. Recheck the exact file license and pin commit before adapting code. |
| [Postiz](https://github.com/gitroomhq/postiz-app) | Strong social scheduling breadth, public API, agent CLI, active releases, and official OAuth approach. AGPL-3.0; requires Next/Nest/PostgreSQL/Redis/Temporal; recent security advisory and self-hosted API/provider failure reports demonstrate a non-trivial operational boundary. It is publishing infrastructure, not a ManyChat inbox. | **Candidate optional sidecar for P2 only.** Never copy into the Apache core. Deploy independently, pin a patched release, use scoped workspace-owned API credentials, and require setup/health/execute/revoke plus webhook/poll reconciliation tests. Keep post approval and audit native. |
| [Mixpost Lite](https://github.com/inovector/mixpost) | MIT Laravel/Vue social publisher with a smaller operational footprint than Postiz, active releases, and Meta publishing. Lite/pro separation means the exact needed API, workspace, approval, and analytics capabilities must be verified rather than inferred from marketing. | **P2 alternate candidate.** Run a contract spike against the Lite API before choosing it over Postiz or a native adapter. Do not adopt merely because its license is simpler. |

### First Instagram acceptance contract

The first visible release is deliberately smaller than ManyChat:

- Admin-only Meta connection setup, verification, health, refresh/revoke, redacted credential evidence.
- One Instagram professional account per connection; workspace ownership and external account uniqueness enforced.
- Webhook verification plus signature, timestamp/event replay, payload-size, event-type, and workspace-route validation.
- Inbound DM and comment events persisted idempotently; external identity linked explicitly to a Contact or held as an unlinked channel participant.
- A real Conversations Instagram thread and message renderer.
- Two automation triggers (`instagram.dm_received`, `instagram.comment_keyword`) and two actions (`instagram.reply`, `instagram.private_reply`) with bounded text and stored provider results.
- Current provider window/policy checked at claim and again immediately before send.
- Agent drafts/proposals require the existing approval policy; no model-created free-form provider call.
- Auth loss, rate limit, timeout, invalid recipient/window, provider rejection, duplicate webhook, retry, cancel/revoke, and concurrent winner tests.
- Recovery validates records but never exports raw tokens.
- Desktop/mobile browser proof and a Meta test-account journey before navigation exposure.

Quick replies, buttons, attachments, follower gates, story mentions, icebreakers, persistent menus, bulk campaigns, and AI auto-replies remain omitted until each receives its own provider and policy proof.

## Other upstream decisions

| Capability | Candidate | Decision and boundary |
|---|---|---|
| Durable background jobs | [Trigger.dev](https://github.com/triggerdotdev/trigger.dev) (Apache-2.0), [Node-RED](https://github.com/node-red/node-red) (Apache-2.0) | Do not replace the proven bounded automation runner. Trigger.dev is a future optional executor only if Workers cron/queues cannot meet a measured job requirement. Node-RED is an interoperability target, not an embedded editor/runtime. |
| E-signature | [Documenso](https://github.com/documenso/documenso) (AGPL-3.0) | Optional independent service/API after Estimates. OpenOperator owns opportunity/proposal status and immutable evidence; Documenso owns document/signing ceremony. No source copying into Apache core; complete legal/compliance review is separate from technical integration. |
| Voice | [Fonoster](https://github.com/fonoster/fonoster) (MIT) | Best current open-source reference/sidecar candidate for programmable voice. It is substantial telephony infrastructure. Require carrier setup, recording consent, number lifecycle, emergency-use exclusions, webhook verification, spend/rate limits, and human approval before any visible module. |
| Notification delivery | [Novu](https://github.com/novuhq/novu) | Potential sidecar if multi-channel notification orchestration becomes a measured need. License is multi-part and must be inspected by path. Do not duplicate the existing consent or campaign authority. |
| Marketing automation | [Mautic](https://github.com/mautic/mautic) | Interoperability candidate for operators already running it, not a core base. Its GPL runtime and duplicate contact/campaign models make source integration inappropriate. |
| Broad workflow platforms | Activepieces, n8n, Node-RED | Expose signed OpenOperator triggers/actions to them; do not hand CRM database or agent authority to their plugins. n8n's source-available license is not treated as an open-source dependency. |

## Repository admission gate

No clone, package, container, copied file, or API dependency enters an implementation branch until a dated record proves:

1. Exact repository, commit/release, source paths, and license boundaries.
2. Maintainer/release activity, supported versions, security policy/advisories, CI and tests.
3. Dependency lock, install/build scripts, containers, network calls, telemetry, secret handling, and update behavior.
4. Whether it becomes a derivative/core dependency, adapted source, optional sidecar, or documentation-only reference.
5. Workspace identity, authorization, credential ownership, contact/consent authority, idempotency, audit, recovery, and deletion boundaries.
6. A threat model and rollback/removal plan.
7. A minimal contract spike that tests the exact required capability, including negative/failure cases.
8. Production dependency and container scans with no unexplained critical/high findings.
9. Browser acceptance for the end-to-end user journey.
10. Attribution and license notices required by the adopted paths.

Popularity is context, not proof. A healthy repository can still be the wrong architecture. A compatible license does not establish secure code. A successful API response does not establish delivery or business outcome.

## Execution sequence

1. Preserve the proven `main` baseline and complete the interrupted Estimates slice on its branch.
2. Merge Estimates only after focused/full Linux gates and desktop/mobile browser proof; keep e-signature, invoices, tax, checkout, and payment providers omitted.
3. Create a ChatbotX contract-spike branch pinned to `v1.2.1`/`932eae5`; inventory community versus commercial paths, run its real channel tests/scans, and prove a sidecar API/MCP/webhook boundary without importing its CRM database.
4. Implement the minimal Instagram connection, webhook, identity, Conversations, and workflow slice above by combining the proven ChatbotX sidecar boundary with only those native OpenOperator records and controls needed for consent, identity, approval, audit, and recovery. Chatwoot remains an independent reference used to challenge ChatbotX behavior.
5. Evaluate Postiz versus Mixpost with the same black-box publishing contract. Select at most one optional publishing sidecar, or use ChatbotX publishing/channel capabilities when the exact contract is stronger and does not duplicate state.
6. Add Documenso and Fonoster only as independent optional-service spikes after their user journeys, compliance boundaries, and operational costs are accepted.
7. Repeat the prove-before-visible cycle. Update the feature truth matrix only after code, automated gates, clean CI, and browser evidence agree.

## Plan criticism checkpoint

This plan intentionally does not promise feature parity with every HighLevel screen. That promise would reward dead UI and unsafe integrations. Its weakness is slower apparent breadth: each provider requires OAuth/app review/test accounts and failure-path evidence. The mitigation is to reuse one native connection/event/delivery contract across channels and let agents operate through the existing structured proposal system. The plan should be changed only when measured implementation evidence shows a sidecar is simpler and safer than a native adapter—not when a repository merely advertises more features.
