# GoHighLevel capability map and OpenOperator scope

This map comes from read-only observation of a configured GoHighLevel client sub-account on 2026-08-13. It records generic product capability, not client contacts, messages, credentials, pipeline names, or configuration values.

| Capability family | Observed GHL surfaces | OpenOperator status |
|---|---|---|
| CRM records | Contacts, custom fields, tags, smart lists, contact detail/activity | Implemented |
| Sales execution | Opportunities, pipelines, forecast, bulk actions | Implemented |
| Inbox | Team inbox, filters, snippets, trigger links, analytics, contact context | Partial: notes/activity and optional mailbox metadata; outbound messaging requires an adapter |
| Calendars | Calendar view, appointment list, calendar settings | Partial: local-first public Booking and appointment management are implemented; external calendar-provider sync is absent |
| Automation | Workflows, campaigns, triggers, global settings, run history | Implemented for bounded deterministic workflows |
| AI agents | Voice AI, conversation AI, knowledge base, templates, content AI, logs | Partial: scoped agent work, proposals, MCP, logs; no bundled voice carrier or unrestricted chatbot |
| Sites | Funnels, websites, stores, webinars, forms, surveys, quizzes, chat, QR | Partial: secure Forms, Surveys, and bounded hosted-path Sites are implemented; stores, webinars, chat, QR, and custom domains are absent |
| Payments | Proposals, estimates and provider connection | Partial: append-only provider-neutral payment evidence is implemented; processors, proposals, estimates, payouts, and reconciliation are absent |
| Marketing | Social planning and brand assets | Partial: bounded consent-aware Resend email campaigns are implemented; social planning and brand assets are absent |
| Reputation | Review/reputation overview | Planned active slice: first-party review requests and private feedback; third-party review ingestion and replies remain absent |
| Reporting | Custom, ads, calls, agents, appointments, local audit | Core operational summaries implemented; ad/call provider reports require adapters |
| Configuration | Staff, roles, pipelines, calendars, email, phone, objects, fields, domains, integrations, audit logs | Core workspace/roles/objects/fields/integrations/audit implemented |

## Inclusion rule

A feature is labeled implemented only when its server behavior, authorization boundary, persistence, failure state, and primary UI journey are tested. A catalog card or disabled button does not qualify.

The live navigation contract and explicit omissions are maintained in [FEATURE_TRUTH_MATRIX.md](./FEATURE_TRUTH_MATRIX.md). Missing HighLevel modules are intentionally absent rather than represented by dead controls.
