# OpenOperator Agentic CRM — Product Blueprint

## Product thesis

OpenOperator should be an execution CRM for service businesses and agencies, not
another passive address book. The system joins a trustworthy record graph,
pipeline execution, deterministic automation, and human-gated AI agents.

The product must be distributable without sharing customer data or configuration:
every row is workspace-scoped, every user is a workspace member, every mutation
is auditable, and every integration credential belongs to one workspace.

## Market findings

The research indicates a consistent baseline:

- HighLevel separates contacts from opportunities, supports multiple pipelines,
  task management, smart lists, workflow triggers/actions, and inbound/outbound
  webhooks.
- HubSpot adds pipeline transition rules, stage approvals, fit and engagement
  scores, workflow history, and object-level permissions.
- Pipedrive keeps unqualified leads out of active pipelines, then converts them
  into deals when qualified.
- Close emphasizes an execution inbox, communication windows, workflow goals,
  run-once controls, stalled-deal detection, and suggested next actions.
- Attio treats people, companies, and deals as related records; its workflows
  expose triggers, conditional branches, run inspection, and AI-assisted
  workflow creation.
- Salesforce’s agent features focus on record summaries, deal prioritization,
  close plans, buying committees, and explainable opportunity scoring.

Primary references:

- [HighLevel pipelines](https://help.gohighlevel.com/support/solutions/articles/155000001985-step-by-step-guide-creating-pipelines)
- [HighLevel opportunities](https://help.gohighlevel.com/support/solutions/articles/155000001983-understanding-opportunities-in-highlevel)
- [HighLevel outbound webhooks](https://help.gohighlevel.com/support/solutions/articles/155000003299-actions-webhook)
- [HubSpot pipeline rules](https://knowledge.hubspot.com/object-settings/set-up-pipeline-rules)
- [HubSpot lead scoring](https://knowledge.hubspot.com/scoring/build-lead-scores)
- [Pipedrive Leads Inbox](https://support.pipedrive.com/en/article/leads-inbox)
- [Close workflows](https://help.close.com/docs/workflows)
- [Attio workflows](https://attio.com/help/reference/automations/workflows/overview-of-workflows)
- [Salesforce Agentforce for Sales](https://help.salesforce.com/s/articleView?id=sf.einstein_copilot_for_sales.htm&language=en_US)
- [Cloudflare human-in-the-loop patterns](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/)

## Core domain model

1. Workspace and members
2. People and companies
3. Leads awaiting qualification
4. Pipelines and ordered stages
5. Opportunities linked to contacts and companies
6. Tasks, notes, calls, meetings, emails, and timeline events
7. Automation definitions and immutable run history
8. Inbound webhook endpoints and outbound destinations
9. Delivery attempts with idempotency and retry state
10. Agent proposals, approvals, decisions, and execution results
11. Audit events
12. Onboarding and launch checks

Contacts are not opportunities. A contact may have multiple opportunities across
different offers and pipelines. Moving a deal must not overwrite the person’s
lifecycle.

## Agent safety model

AI output is a proposal until policy says otherwise.

- Read-only analysis can run without approval.
- Creating internal tasks is low risk but still defaults to approval during
  onboarding.
- Sending external email/SMS, modifying money, deleting records, exporting data,
  changing permissions, or invoking third-party tools always requires approval.
- Every proposal includes rationale, confidence, risk, source records, and the
  exact structured action.
- Approval executes only the stored structured action, never newly generated
  free-form instructions.
- Tool scopes, record scopes, maximum actions, timeouts, and spend limits are
  enforced outside the model.
- Agent and automation loops have per-record run caps and step caps.

## Customer onboarding

Each customer starts from a versioned business template:

1. Company profile, timezone, currency, and terminology
2. Users, roles, data visibility, and approval owners
3. Lead sources and duplicate rules
4. Pipeline stages, probabilities, entry requirements, and exit requirements
5. Qualification framework and lead scoring
6. Task SLAs and ownership rules
7. Email/calendar/phone providers
8. Inbound and outbound webhook credentials
9. Automation drafts
10. Agent roles, allowed tools, and approval matrix
11. Historical data import and reconciliation
12. Sandbox acceptance and launch gate

Templates are copied into a workspace; they are not shared mutable configuration.

## Launch quality gate

A workspace cannot be marked live until:

- Owner identity and workspace isolation pass
- Pipeline and stage configuration pass
- Duplicate import simulation passes
- Inbound signature, expiry, and replay tests pass
- Outbound delivery, timeout, retry, and redaction tests pass
- Automation loop, run-once, and failure-path tests pass
- Agent approval and rejection tests pass
- Permission-negative tests pass for every role
- Load and concurrency thresholds pass
- Backup/export restore rehearsal passes
- Mobile and desktop operator acceptance passes

## Delivery phases

### Foundation

Workspace isolation, RBAC, opportunities, pipelines, tasks, audit history,
signed webhooks, deterministic automations, approval-gated agent proposals.

### Sales execution

Lead inbox, company records, saved views, bulk actions, assignment queues,
forecasting, scoring, email/calendar sync, and activity capture.

### Agentic operations

Daily briefing, stale-deal coach, lead research, call preparation, transcript
summaries, follow-up drafts, close plans, buying committee detection, and
forecast explanations.

### Platform

Template marketplace, self-serve onboarding, metering, billing, support
diagnostics, data retention controls, and migration tooling.

## Honest current boundary

The repository now implements the foundation data model, operator workflows,
owner-gated customer workspace provisioning, default pipeline/QC creation, and
explicit workspace selection. A separate public, write-only ingestion Worker
connects external funnels without making the dashboard or admin API public. It
does not yet provide full email/calendar sync,
telephony, generic custom objects, predictive ML
scoring, billing, or a self-serve provisioning portal. Those are explicit
subsequent phases, not features to imply through UI labels.
