# Twenty CRM benchmark and OpenOperator adoption map

Last reviewed: 2026-07-30
Source: `twentyhq/twenty` at repository snapshot
`1f55234d0bd1abe20e5615dc5830b254a54831ef`

This is a product and architecture benchmark, not a plan to fork Twenty.
OpenOperator remains a Cloudflare-native, workspace-isolated, agent-first CRM
with human-gated sensitive writes. Every adopted feature must preserve those
boundaries.

## Executable integration provenance

`docs/TWENTY_INTEGRATION_MANIFEST.json` is the machine-readable source of
truth for function-level adaptations. `npm run test:twenty` now fails unless:

1. the local upstream checkout is exactly the pinned Twenty commit;
2. every named upstream path still resolves to its recorded Git blob;
3. the named upstream export exists;
4. the corresponding OpenOperator runtime contract exists; and
5. at least one named behavioral test exists for that adaptation.

The first verified set covers workflow structure/lineage, one-time webhook
secrets, sanitized signed webhook envelopes, and review-first relationship
merge. This is intentionally a contract adaptation, not runtime linkage or a
claim of binary compatibility. No Twenty source code is copied into the
OpenOperator runtime by this gate.

## What OpenOperator already has

| Capability | Current OpenOperator state |
|---|---|
| Contacts, companies, opportunities, tasks, notes | Workspace-scoped CRUD, first-class company identity, bounded relationship graphs, chronology, pagination, recovery, cleanup, and audit |
| Pipeline | Multi-pipeline backend, focused pipeline board, terminal-stage guards |
| Saved views | Versioned private/workspace Contact and custom-object definitions with typed filters, ordered visible fields, sort, optimistic edits, permissioned sharing, and safe deletion |
| Automation canvas | React Flow, animated edges, drag ordering, MATCH/ELSE, templates, validation |
| Automation execution | Atomic multi-action runs, caps, idempotent events, signed least-privilege workflow principals, trigger provenance, trace debugger |
| Agent execution | OpenClaw/Hermes leased queue, scope-mapped MCP tools, kill switch, rate limits |
| Human governance | Versioned Contact and Opportunity member grants, field/custom-field read and write controls, proposals, expiry, relationship revalidation, one-winner approval, and audit atomicity |
| Integrations | Source ingestion, inbound/outbound webhooks, Skool mapping, signed delivery, and an isolated AudienceLab/RB2B visitor-intent ledger |
| Recovery | Encrypted export, staged validation, live-state guard, atomic restore |
| Extensible data | Admin-governed custom-object schemas, typed records, bounded polymorphic relations, versioned working views, optimistic versions, archive/read-only lifecycle, and encrypted recovery |

## Twenty capabilities worth adopting

### Current-source findings

The July 28, 2026 source confirms that Twenty now treats the CRM as a tool
platform as well as a record application:

- OpenOperator now goes beyond a role-inherited workflow model: the server derives
  an exact capability manifest from each rule’s action graph, signs it, verifies
  it at run admission, and snapshots both execution principal and trigger
  provenance. This is the security substrate for future reusable agent actions,
  iterators, delays, and managed connections; none should ship by bypassing it.

- Its workflow action enum includes create, update, delete, upsert, find, pick,
  filters, branches, iterator, delay, HTTP, email draft/send, calendar events,
  logic functions, and AI agents.
- Its server has a first-class MCP protocol surface, tool registry, discovery
  card, OAuth discovery, method guards, tool annotations, and execution service.
- Its operator UI includes a command menu, headless workflow launch contexts,
  customizable navigation, record-index actions, and mobile-specific command
  menu behavior.
- Its metadata layer defines objects, fields, roles, commands, skills, and
  application packages rather than hard-coding every customer variant.

### Source-backed mechanism inventory

| Twenty mechanism | Source evidence at `1f55234d` | OpenOperator decision |
|---|---|---|
| Generic record surfaces | `twenty-front/src/modules/object-record/record-table`, `record-board`, `record-calendar`, `record-show`, `record-merge`, `record-update-multiple` | Adopt table/board/calendar view contracts and relationship-rich record pages incrementally; keep the current purpose-built lead and pipeline surfaces during migration |
| Saved/configurable views | `twenty-front/src/modules/views` plus metadata modules for view fields, groups, filters, sorts, and permissions | Extend our saved filters into versioned view definitions with visibility, columns, grouping, and object scope |
| Activity workspace | `activities/{emails,calendar,tasks,notes,files,timeline-activities}` | Add communication signals and one chronological record timeline before attempting generic custom objects |
| Workflow trigger families | Shared schema permits `DATABASE_EVENT`, `MANUAL`, `CRON`, and `WEBHOOK` | We have bounded record events and manual single-record runs; next add schedules, authenticated webhook starts, and bulk-manual envelopes |
| Workflow actions | `WorkflowActionType` includes record CRUD/upsert/find/pick, filter/branch, iterator, delay, HTTP, email, calendar, form, logic function, and AI agent | Adopt schemas and observability, not open-world power. Destructive writes remain proposals; HTTP uses managed connections; code becomes versioned sandboxed functions |
| Workflow graph safety | Shared workflow validation, graph construction, variable-reference validation, and output-schema search | Add immutable workflow versions and typed prior-step output schemas before richer branching/iteration |
| Run observability | Frontend `workflow-run/observability`; server queue, stale-run handling, retry/stop services | Preserve our one-winner retry/cancel semantics and add duration, waiting state, per-step input/output, and redaction |
| AI execution | Server modules for agent execution, monitoring, roles, chat, tools, model policy, and workspace stats | Keep external runtime neutrality (OpenClaw/Hermes/custom MCP), leased jobs, risk classes, scopes, budgets, and human-gated mutations |
| Extensibility as code | `twenty-sdk` definitions for objects/views/agents/logic functions and versioned app publishing | Build signed, versioned customer packages after metadata permissions and onboarding dry runs exist |
| Authorization | Metadata modules for roles, object/field permissions, row predicates, view permissions, and role targets | This is a higher priority than generic objects: add object/action/field grants and explicit agent/workflow principals first |
| Operator navigation | Command menu, customizable navigation, side panel, layouts, widgets, and keyboard shortcuts | Add a command palette for record search and manual workflow launch; retain restrained, task-focused navigation |

OpenOperator should copy the contracts, not Twenty's implementation stack. The
Cloudflare-native boundary remains smaller and safer: closed-world MCP tools,
explicit scopes, bounded reads, idempotent proposals, optimistic versions, and
human approval for sensitive writes.

Calendar-view progress: Tasks now provides a six-week month and compact mobile
agenda across three fixed CRM date families: open task due dates, contact
follow-ups, and open opportunity closes. A workspace-scoped range endpoint
admits at most 93 days, caps each family at 200 and the merged response at 500,
labels truncation and record text truthfully, and preserves linked-record
navigation without exposing a generic object query. This is the eighth pinned
contract adaptation; provider calendar sync and calendar-event creation remain
separate integration work.

Authorization progress: the first production-shaped vertical now versions
member contact-write grants at workspace scope. It proves action grants,
field-level update grants, owner-only audited revision changes, concurrency,
customer-workspace provisioning, and a review-first operator surface. This is
not yet a generic role system: read-field redaction, custom roles, row
predicates, and other CRM objects remain open. Explicit workflow principals
are now proven: agents may observe bounded workflow/run metadata and propose a
manual launch, but only a current human approval can admit the run, and the run
executes as `automation:<rule_id>` rather than borrowing agent or reviewer
authority. That boundary is intentional; remaining permissions should reuse
the proven version/evaluator/audit contract rather than adding another
route-local role check.

### P0: automation platform foundation

1. **Broader triggers**
   - Record created, updated, created-or-updated, and deleted
   - Manual single-record and bulk triggers
   - Scheduled triggers
   - Authenticated webhook triggers
   - OpenOperator adaptation: start with contacts, opportunities, tasks, and
     inbound messages. Preserve event idempotency and per-record run caps.
2. **Typed step data**
   - Every step exposes typed outputs to later steps.
   - Builder fields need a variable picker that shows source step and type.
   - Persist a versioned input/output schema with every workflow definition.
3. **Run operations**
   - Global run view with workflow/status/date filters
   - Running, succeeded, failed, waiting, and cancelled states
   - Trigger payload, duration, per-step input/output, and bounded retry
   - OpenOperator must redact secrets and label CRM text as untrusted data.
4. **Agent tool manifests**
   - Reusable, versioned tools exposed both to workflows and external agents.
   - Each tool declares input schema, output schema, scopes, risk class,
     approval policy, rate budget, and idempotency behavior.

### P1: useful workflow actions

1. Search records with filters, sort, cursor, and a hard result cap.
   - External-agent contact, company, and opportunity reads now implement this
     as a proven MCP slice: exact normalized filters, fixed recent-to-oldest
     ordering, 50-record caps, HMAC-signed credential/workspace/tool-bound
     keyset cursors, matching indexes, and truthful best-effort consistency.
   - Workflow-native search remains separate; do not expose an unbounded
     iterator merely because MCP traversal is safe.
2. Create and upsert records using declared unique keys.
3. Iterator for bounded arrays and bulk manual selections.
4. Delay-until and duration waits backed by durable jobs.
5. Authenticated HTTP requests through allowlisted connections; never accept
   arbitrary model-controlled destinations or raw secrets in workflow code.
6. Email draft and send actions. Drafts can be agent-created; sending remains
   human-gated until an explicit workspace policy permits a narrow exception.
7. Forms for manual workflows and human-in-the-loop waits.
8. Reusable logic functions, deployed and versioned as code, instead of
   unrestricted inline JavaScript.

### P1: operator experience

1. Table, Kanban, and calendar views with saved filters, sort, grouping, and
   visible fields.
2. Private versus workspace-shared views.
3. Command palette for navigation and manual workflow launch.
4. Record page tabs and widgets for fields, related records, timeline, email,
   calendar, tasks, notes, files, charts, and safe iframes.
5. Run-health badges and failure inbox surfaced beside each workflow.

### P2: productization

1. Metadata-defined custom objects, fields, relations, views, and validation.
2. Versioned application packages for customer-specific objects and tools.
3. Role permissions per object, field, action, agent, and workflow.
4. Reorderable navigation, folders, favorites, and customer-specific layouts.
5. Contact import mapping, dry run, typed validation, durable lineage, and
   conflict-aware rollback are shipped. Reusable versioned onboarding templates
   across other governed objects remain.

### July 30, 2026 gap refresh

The earlier gap table below is retained as historical prioritization, not as a
claim about the current build. Current verified state:

| Capability | Current state | Remaining product gap |
|---|---|---|
| Granular permissions | Versioned member object/action/field grants are enforced for Contacts, Opportunities, and every governed custom object | Customer-defined roles, row predicates, and workflow/agent-specific principals |
| Recovery | Ciphertext-only export, validation staging, atomic restore, key rotation, and conflict rejection are shipped | Scheduled restore rehearsal and retention policy UI |
| Job execution | Signed schedulers, retries, leases, admin-only health history, incident transitions, 24h/7d/30d snapshot rates, versioned workspace SLO thresholds, snapshotted multi-step escalation schedules, signed generic/Slack/Teams/Discord alerts, and encrypted/deduplicated PagerDuty trigger-resolve lifecycle are shipped | Jira Service Management or Compass incident routing after Opsgenie retirement |
| Extensible data | Typed fields and versioned layouts span core objects; custom objects now include typed records, bounded relations, member object/field grants, schema versions, private/workspace views, archive state, and recovery | Customer-defined roles/row predicates, grouping/board/calendar views, import mapping, automation triggers/actions, MCP tools, and package navigation |
| Imports | Mapping, preview, typed validation, lineage, pagination, and conflict-aware rollback are shipped | Reusable imports for every governed object |
| Communications | Governed Gmail/Outlook OAuth lifecycle and Resend transactional delivery are shipped | Calendar execution, telephony, and unified conversation timeline |
| Workflow operations | Visual branching builder, signed least-privilege principal, run debugger, retry, and manual launch are shipped | Reusable packaged logic functions and human wait steps |
| Agent review | Explainable proposal inbox, exact approval/rejection, budgets, credential scopes, and trace evidence are shipped | Customer-defined approval matrices and packaged agent templates |
| Productization | Isolated workspace provisioning, default pipeline, revision-one policy, readiness checks, backup, and workspace selection are shipped | Versioned business templates, self-serve provisioning portal, metering, and billing |

## Features to adapt, not copy

- Twenty's generic delete-record action is too broad for an autonomous agent.
  OpenOperator should require a proposal, impact preview, optimistic version, and
  explicit approval for destructive actions.
- Twenty's arbitrary HTTP action and inline code editor can expose secrets and
  create SSRF or exfiltration paths. OpenOperator should use managed connections,
  destination allowlists, sandboxed reusable functions, and output limits.
- Twenty describes AI chatbot access to all workspace data. OpenOperator keeps
  least-privilege scopes, bounded result sets, record trust labels, and explicit
  tool discovery.
- Twenty's agent actions follow roles. OpenOperator additionally requires action
  risk classes, proposal policies, workspace kill switch, per-agent budgets,
  and immutable audit evidence.

## Current evidence and next implementation order

Production version 65 proves one workflow can connect:

`opportunity movement → MATCH branch → agent work + gated proposal + direct task + note`

The run debugger exposed every generated entity ID. The proposal was rejected,
the task completed and deleted, opportunity/contact deletion cleared the queued
agent work, workflow/history deletion succeeded, and production returned to its
two-contact baseline.

Implementation order:

1. Event envelope plus contact/opportunity created and updated triggers
2. Typed step outputs and variable picker
3. Global run-health view and retry/cancel policies
4. First-class company relationship graph and unified account chronology
5. Search/upsert and bounded iterator
6. Durable delays and schedules
7. Managed HTTP/email connections
8. Manual single/bulk workflows and command palette
9. Metadata-driven objects, views, layouts, and customer app packages

Progress: `opportunity.created` is implemented as the first event-envelope
slice alongside `opportunity.stage_changed`. It executes through the same
bounded, transactional, and human-gated action engine after the opportunity
creation and audit transaction commits.

Typed opportunity variables are now the second completed slice. Seven
allowlisted fields can be inserted into task titles, notes, gated opportunity
updates, and agent instructions. Resolution is single-pass, bounded after
substitution, and independently validated by the client and server. Prior-step
outputs remain next because they require explicit step-output schemas and
retry-safe identity rather than untyped string interpolation.

Workflow/run observability now has a release-candidate keyset traversal
contract. Signed opaque cursors are bound to the exact agent credential,
workspace, tool, and filters; dedicated indexes support the declared order.
The API labels the consistency model `best_effort_keyset`, which is deliberate:
it prevents duplicates in a stable walk without pretending mutable CRM history
is a snapshot. This closes the earlier first-page-only gap without exposing
workflow action definitions or granting execution authority.

Global run operations are the third completed slice. The workspace now shows
named workflow context, succeeded/failed/running/canceled health, filters,
debug traces, one-winner retry lineage, and stale-only cancellation. Unlike a
generic replay button, retry requires the current workflow to be active, the
record to exist, and the per-record run budget to remain available.

Contact lifecycle automation is the fourth completed slice. Contact creation
and lifecycle/status commits now feed the same bounded automation engine, and
automations may propose lifecycle, record-status, or owner changes without
performing them directly. Approval is one-winner, version-checked, audited, and
can safely emit a subsequent lifecycle event. The builder includes a
human-gated Lead progression starting point.

MCP discovery annotations are the fifth completed slice. Every exposed tool
now declares read-only, destructive, idempotent, and open-world hints. Reads
are closed-world and idempotent; proposal tools are non-destructive and
idempotent; leased work-item operations are correctly marked non-idempotent.
This makes external agent installation less ambiguous without weakening
server-side scope or approval enforcement.

Visitor identity is now an agent-readable but separately governed object
surface. Unlike a generic CRM object list, vendor pixel data remains in a
quarantine ledger with explicit untrusted-data metadata. Separate read and
promotion-proposal scopes, signed traversal cursors, current-revision
proposals, origin-credential revalidation, and human-only promotion adapt
Twenty's extensible tool model without granting open-world record creation or
outreach authority.

The first-class company graph is now another completed Twenty-derived slice.
Companies have workspace-isolated identities, normalized contact links,
deal/task rollups, notes, activity/audit chronology, recovery coverage, an
operator relationship workspace, and two least-privilege read-only MCP tools.
Unlike a generic object endpoint, agents receive only capped account graphs
with explicit untrusted-record metadata; company mutations remain operator
controlled.

Company identity maintenance is also complete as a bounded adaptation of
Twenty-style record merge. Admin rename preserves canonical aliases across
ingestion paths; duplicate merge is optimistic and atomic; old UI/MCP IDs
resolve through durable, transitive redirects; and account-note edits/deletes
are author/admin scoped and versioned. The implementation deliberately omits
autonomous merge and generic agent delete tools. The next deduplication slice
adds duplicate scoring and dry-run comparison before any bulk operation:
domain, normalized-name/root overlap, and owner signals are individually
visible; scans and result sets are capped; exact relationship impact and
field-resolution provenance are reviewed side by side; and the destructive
merge rejects missing, forged, or stale review tokens. Bulk and autonomous
merge remain intentionally absent until repeated single-pair production proof
justifies widening the blast radius. Duplicate scoring contract v2 also treats
four-or-more-character names that differ only by spacing or punctuation as an
explainable review candidate, while short ambiguous pairs remain excluded.

Manual workflow triggers are now implemented for one selected contact or
opportunity. They reuse the same workspace lookup, condition branch, action
transaction, run cap, trace, and audit boundary as event-driven runs.

The first managed-connection workflow slice is implemented as a release
candidate: `publish_event` emits only `contact.workflow_event` or
`opportunity.workflow_event`. The server constructs the payload from an
allowlisted record snapshot and workflow/run identity, atomically enqueues
matching workspace subscribers, and hands delivery to the existing signed,
leased, retryable webhook engine. Workflow definitions cannot provide a URL,
secret, event name, or arbitrary payload. Tests prove signed matching delivery,
zero-subscriber success, and rejection of destination smuggling.
