# GoHighLevel capability map and OpenOperator scope

This map comes from read-only observation of a configured GoHighLevel client sub-account on 2026-08-13. It records generic product capability, not client contacts, messages, credentials, pipeline names, or configuration values.

| Capability family | Observed GHL surfaces | OpenOperator status |
|---|---|---|
| CRM records | Contacts, custom fields, tags, smart lists, contact detail/activity | Implemented |
| Sales execution | Opportunities, pipelines, forecast, bulk actions | Implemented |
| Inbox | Team inbox, filters, snippets, trigger links, analytics, contact context | Partial: governed email plus Twilio SMS threads, consent, opt-out, and delivery evidence are implemented; snippets, trigger links, MMS, voice, and inbox analytics are absent |
| Calendars | Calendar view, appointment list, calendar settings | Partial: local-first public Booking and appointment management are implemented; external calendar-provider sync is absent |
| Automation | Workflows, campaigns, triggers, global settings, run history | Implemented for bounded deterministic workflows, typed record fields, reusable workspace custom values, guarded merge variables, branches, and run evidence |
| AI agents | Voice AI, conversation AI, knowledge base, templates, content AI, logs | Partial: scoped agent work, proposals, MCP, logs; no bundled voice carrier or unrestricted chatbot |
| Sites | Funnels, websites, stores, webinars, forms, surveys, quizzes, chat, QR | Partial: secure Forms, Surveys, and bounded hosted-path Sites are implemented; stores, webinars, chat, QR, and custom domains are absent |
| Payments | Proposals, estimates and provider connection | Partial: immutable customer-facing Estimates and append-only provider-neutral payment evidence are implemented; processors, proposals, payouts, and reconciliation are absent |
| Marketing | Social planning and brand assets | Partial: bounded consent-aware Resend email campaigns are implemented; social planning and brand assets are absent |
| Reputation | Review/reputation overview | Partial: governed first-party review requests and private feedback are implemented; third-party ownership verification, review ingestion, synchronization, and public replies remain absent |
| Reporting | Custom, ads, calls, agents, appointments, local audit | Core operational summaries implemented; ad/call provider reports require adapters |
| Configuration | Staff, roles, pipelines, calendars, email, phone, objects, fields, domains, integrations, audit logs | Core workspace/roles/objects/typed fields/reusable custom values/email/Twilio/integrations/audit implemented; domain and telephony administration remain provider-owned |

## Inclusion rule

A feature is labeled implemented only when its server behavior, authorization boundary, persistence, failure state, and primary UI journey are tested. A catalog card or disabled button does not qualify.

The live navigation contract and explicit omissions are maintained in [FEATURE_TRUTH_MATRIX.md](./FEATURE_TRUTH_MATRIX.md). Missing HighLevel modules are intentionally absent rather than represented by dead controls.
