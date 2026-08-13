# Feature truth matrix

This matrix is the release contract for the open-source HighLevel-style workspace. A navigation item is visible only when its primary journey has persistence, authorization, failure handling, and automated acceptance evidence.

| Product surface | Current evidence | UI decision | Next complete vertical slice |
|---|---|---|---|
| Dashboard | Live metrics, briefing, scoring, pipeline snapshot, record drill-down | Visible | Add configurable dashboard widgets only with persisted layouts |
| Contacts | Create, search, filter, save views, bulk edit, import/rollback, companies, custom fields, timelines | Visible | Continue browser acceptance across import and duplicate-resolution failures |
| Opportunities | Multiple pipelines, stage rules, drag/keyboard movement, editing, tasks, agent proposals, concurrency guards | Visible | Add forecast views only after API and acceptance tests exist |
| Calendar & tasks | Task CRUD/lifecycle plus bounded calendar range API and linked records | Visible | This module remains task-centric; Booking is a separate lifecycle |
| Booking | Draft/publish/revoke calendars, timezone-aware availability, buffers/notices, public booking, replay/conflict protection, private reschedule/cancel, appointment ledger, and hash-only management tokens | Visible | External calendar sync is explicitly local-only/false until a real provider adapter exists |
| Agent work | Scoped credentials, work queue, proposals, approvals, execution results, audit trail | Visible | Voice and unrestricted chat agents remain omitted |
| Automations | Versioned deterministic workflow builder, validation, activation, run history, repair paths | Visible | Campaign messaging remains omitted until provider and consent policy exist |
| App connections | Governed sources, webhooks, mailboxes, agent credentials, health checks, revoke/rotate paths | Visible | Provider-specific setup wizards are added one tested adapter at a time |
| Settings | Workspace access, roles, fields, objects, layouts, readiness, operations health, recovery | Visible | Domain and billing controls remain omitted |
| Conversations | Workspace-scoped email threads/messages, explicit Gmail/Outlook metadata sync, contact permission/suppression evidence, replay-safe Resend delivery, receipts, lifecycle controls, and responsive browser acceptance | Visible | Add incremental provider adapters only after equivalent consent, idempotency, authorization, and failure-path evidence |
| Forms | Versioned form definitions, immutable published snapshots, public responsive intake, required privacy acknowledgement, optional express-email consent, rate/replay/honeypot controls, immediate revocation, contact/activity association, and submission ledger | Visible | Add richer field/layout types only with equivalent validation, recovery, and browser evidence |
| Sites and surveys | No complete page builder, hosting lifecycle, survey model, or response analytics | Omitted | Build each as an independent vertical slice rather than extending Forms with placeholders |
| Payments | Admin-only append-only manual ledger; contact/opportunity links; idempotent payment ingestion; immutable payment/refund/dispute/reversal events; bounded adjustments; currency-separated balances; audit/recovery coverage; two-step confirmations; responsive browser proof | Visible | Stripe, banking, invoices, payouts, settlements, FX conversion, and provider reconciliation remain explicitly absent until each adapter has equivalent credential, webhook, replay, failure, and browser evidence |
| Marketing and social | No publish scheduler, provider authorization, or post lifecycle | Omitted | Research and implement as a separate bounded module |
| Reputation | No review-provider adapter or reply governance | Omitted | Add only with provider evidence and human approval for replies |
| Reporting | Bounded 7/30/90-day first-party cohorts, daily arrivals, contact lifecycle distribution, directional first-touch grouping, permission-aware pipeline snapshots, currency-separated values, responsive browser proof, and explicit methodology limits | Visible | Historical conversion requires a dedicated immutable stage-transition event model; ads/calls remain omitted until authoritative sources exist |

## Proof rules

- A card, route, button, or placeholder is not a feature.
- “Visible” requires a working primary browser journey and negative authorization tests.
- External integrations require per-workspace credentials, revocation, redacted logs, idempotency, and timeout/retry behavior.
- Open-source dependencies require license compatibility, maintainer/release history review, dependency scanning, and a written reason to adopt instead of build.
- Missing modules stay absent from navigation. Documentation may name them only as planned work.
