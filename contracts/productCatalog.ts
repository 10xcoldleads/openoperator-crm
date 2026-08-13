export const PRODUCT_CATALOG_VERSION = 1 as const;

export type RecordType = "contact" | "opportunity";
export type AutomationTriggerId =
  | "opportunity.created"
  | "opportunity.stage_changed"
  | "opportunity.manual"
  | "contact.created"
  | "contact.lifecycle_changed"
  | "contact.manual";
export type AutomationConditionField =
  | "status" | "stage" | "stage_id" | "owner" | "source_last"
  | "score" | "probability" | "value";
export type AutomationOperator = "equals" | "not_equals" | "greater_than" | "less_than";
export type AutomationActionId =
  | "create_task" | "add_note" | "update_opportunity"
  | "update_contact" | "request_agent" | "publish_event";

type AutomationTriggerManifest = {
  id: AutomationTriggerId;
  label: string;
  recordType: RecordType;
  mode: "event" | "manual";
};
type ConditionFieldManifest = {
  id: AutomationConditionField;
  label: string;
  recordTypes: readonly RecordType[];
  valueType: "text" | "number" | "pipeline_stage";
  operators: readonly AutomationOperator[];
};
type AutomationActionManifest = {
  id: AutomationActionId;
  label: string;
  recordTypes: readonly RecordType[];
  executor: AutomationActionId;
  editor: AutomationActionId;
  capability: string;
  approval: "optional" | "required" | "none";
  outputFields: readonly string[];
};
type AutomationVariableManifest = {
  token: string;
  label: string;
  valueType: "text" | "number" | "id";
  nullable?: boolean;
};

export const automationCatalog = {
  version: PRODUCT_CATALOG_VERSION,
  triggers: [
    { id: "opportunity.created", label: "Opportunity is created", recordType: "opportunity", mode: "event" },
    { id: "opportunity.stage_changed", label: "Opportunity stage changes", recordType: "opportunity", mode: "event" },
    { id: "opportunity.manual", label: "Opportunity is selected manually", recordType: "opportunity", mode: "manual" },
    { id: "contact.created", label: "Lead is created", recordType: "contact", mode: "event" },
    { id: "contact.lifecycle_changed", label: "Lead lifecycle changes", recordType: "contact", mode: "event" },
    { id: "contact.manual", label: "Lead is selected manually", recordType: "contact", mode: "manual" },
  ] satisfies readonly AutomationTriggerManifest[],
  conditionFields: [
    { id: "status", label: "Record status", recordTypes: ["contact", "opportunity"], valueType: "text", operators: ["equals", "not_equals"] },
    { id: "stage", label: "Lead lifecycle", recordTypes: ["contact"], valueType: "text", operators: ["equals", "not_equals"] },
    { id: "stage_id", label: "Pipeline stage", recordTypes: ["opportunity"], valueType: "pipeline_stage", operators: ["equals", "not_equals"] },
    { id: "owner", label: "Owner", recordTypes: ["contact", "opportunity"], valueType: "text", operators: ["equals", "not_equals"] },
    { id: "source_last", label: "Lead source", recordTypes: ["contact"], valueType: "text", operators: ["equals", "not_equals"] },
    { id: "score", label: "Lead score", recordTypes: ["contact"], valueType: "number", operators: ["equals", "not_equals", "greater_than", "less_than"] },
    { id: "probability", label: "Win probability", recordTypes: ["opportunity"], valueType: "number", operators: ["equals", "not_equals", "greater_than", "less_than"] },
    { id: "value", label: "Opportunity value", recordTypes: ["opportunity"], valueType: "number", operators: ["equals", "not_equals", "greater_than", "less_than"] },
  ] satisfies readonly ConditionFieldManifest[],
  operators: [
    { id: "equals", label: "is" },
    { id: "not_equals", label: "is not" },
    { id: "greater_than", label: "is greater than" },
    { id: "less_than", label: "is less than" },
  ] satisfies ReadonlyArray<{ id: AutomationOperator; label: string }>,
  actions: [
    { id: "create_task", label: "Create a task", recordTypes: ["contact", "opportunity"], executor: "create_task", editor: "create_task", capability: "task.create", approval: "optional", outputFields: ["task_id", "proposal_id"] },
    { id: "add_note", label: "Add CRM note", recordTypes: ["contact", "opportunity"], executor: "add_note", editor: "add_note", capability: "note.create", approval: "none", outputFields: ["note_id"] },
    { id: "update_opportunity", label: "Propose opportunity update", recordTypes: ["opportunity"], executor: "update_opportunity", editor: "update_opportunity", capability: "proposal.create:opportunity_update", approval: "required", outputFields: ["proposal_id"] },
    { id: "update_contact", label: "Propose lead update", recordTypes: ["contact"], executor: "update_contact", editor: "update_contact", capability: "proposal.create:contact_update", approval: "required", outputFields: ["proposal_id"] },
    { id: "request_agent", label: "Request agent work", recordTypes: ["contact", "opportunity"], executor: "request_agent", editor: "request_agent", capability: "agent_work.enqueue", approval: "none", outputFields: ["work_item_id"] },
    { id: "publish_event", label: "Publish integration event", recordTypes: ["contact", "opportunity"], executor: "publish_event", editor: "publish_event", capability: "integration.publish", approval: "none", outputFields: ["event_id"] },
  ] satisfies readonly AutomationActionManifest[],
  variables: {
    opportunity: [
      { token: "{{opportunity.name}}", label: "Opportunity name", valueType: "text" },
      { token: "{{opportunity.status}}", label: "Status", valueType: "text" },
      { token: "{{opportunity.stage_id}}", label: "Pipeline stage ID", valueType: "id" },
      { token: "{{opportunity.owner}}", label: "Owner", valueType: "text", nullable: true },
      { token: "{{opportunity.value}}", label: "Value", valueType: "number" },
      { token: "{{opportunity.probability}}", label: "Probability", valueType: "number" },
      { token: "{{opportunity.next_step}}", label: "Next step", valueType: "text", nullable: true },
    ] satisfies readonly AutomationVariableManifest[],
    contact: [
      { token: "{{contact.email}}", label: "Lead email", valueType: "text" },
      { token: "{{contact.first_name}}", label: "First name", valueType: "text", nullable: true },
      { token: "{{contact.last_name}}", label: "Last name", valueType: "text", nullable: true },
      { token: "{{contact.company}}", label: "Company", valueType: "text", nullable: true },
      { token: "{{contact.status}}", label: "Lead status", valueType: "text" },
      { token: "{{contact.stage}}", label: "Lead lifecycle", valueType: "text" },
      { token: "{{contact.owner}}", label: "Owner", valueType: "text", nullable: true },
      { token: "{{contact.score}}", label: "Lead score", valueType: "number" },
      { token: "{{contact.source_last}}", label: "Latest source", valueType: "text" },
    ] satisfies readonly AutomationVariableManifest[],
  },
} as const;

export type IntegrationCategory =
  | "mailbox" | "calendar" | "transactional_email" | "community"
  | "visitor_identity" | "agent_runtime" | "developer";
export type IntegrationAvailability = "implemented" | "planned";

type IntegrationManifest = {
  id: string;
  label: string;
  category: IntegrationCategory;
  availability: IntegrationAvailability;
  authStrategy: "oauth" | "api_key" | "signed_webhook" | "agent_credential";
  capabilities: readonly string[];
  requiredBindings: readonly string[];
  setup: string;
  healthCheck: string | null;
  executor: string | null;
  revoke: string | null;
};

export const integrationCatalog: readonly IntegrationManifest[] = [
  { id: "gmail", label: "Gmail", category: "mailbox", availability: "implemented", authStrategy: "oauth", capabilities: ["mail.profile.read", "mail.drafts.create"], requiredBindings: ["COMPOSIO_API_KEY", "COMPOSIO_GMAIL_AUTH_CONFIG_ID"], setup: "composio-oauth", healthCheck: "composio-account", executor: "composio", revoke: "composio-revoke" },
  { id: "outlook", label: "Outlook", category: "mailbox", availability: "implemented", authStrategy: "oauth", capabilities: ["mail.profile.read", "mail.drafts.create"], requiredBindings: ["COMPOSIO_API_KEY", "COMPOSIO_OUTLOOK_AUTH_CONFIG_ID"], setup: "composio-oauth", healthCheck: "composio-account", executor: "composio", revoke: "composio-revoke" },
  { id: "google-calendar", label: "Google Calendar", category: "calendar", availability: "planned", authStrategy: "oauth", capabilities: ["calendar.events.read", "calendar.availability.read"], requiredBindings: [], setup: "not-implemented", healthCheck: null, executor: null, revoke: null },
  { id: "microsoft-calendar", label: "Microsoft Calendar", category: "calendar", availability: "planned", authStrategy: "oauth", capabilities: ["calendar.events.read", "calendar.availability.read"], requiredBindings: [], setup: "not-implemented", healthCheck: null, executor: null, revoke: null },
  { id: "resend", label: "Resend", category: "transactional_email", availability: "implemented", authStrategy: "api_key", capabilities: ["email.send", "email.delivery.read"], requiredBindings: ["WEBHOOK_ENCRYPTION_KEY"], setup: "resend-api-key", healthCheck: "resend-verification", executor: "resend-email", revoke: "resend-local-revoke" },
  { id: "skool", label: "Skool", category: "community", availability: "implemented", authStrategy: "api_key", capabilities: ["community.member.ingest", "community.payment.ingest"], requiredBindings: [], setup: "source-credential", healthCheck: "source-last-used", executor: "skool-ingest", revoke: "source-revoke" },
  { id: "audiencelab", label: "AudienceLab", category: "visitor_identity", availability: "implemented", authStrategy: "signed_webhook", capabilities: ["visitor.identify", "audience.import"], requiredBindings: [], setup: "visitor-connector", healthCheck: "connector-last-event", executor: "visitor-intake", revoke: "visitor-connector-revoke" },
  { id: "rb2b", label: "RB2B", category: "visitor_identity", availability: "implemented", authStrategy: "signed_webhook", capabilities: ["visitor.identify"], requiredBindings: [], setup: "visitor-connector", healthCheck: "connector-last-event", executor: "visitor-intake", revoke: "visitor-connector-revoke" },
  { id: "openclaw", label: "OpenClaw", category: "agent_runtime", availability: "implemented", authStrategy: "agent_credential", capabilities: ["crm.read", "crm.propose", "agent_work.claim"], requiredBindings: [], setup: "agent-credential", healthCheck: "agent-run-observed", executor: "agent-mcp", revoke: "agent-credential-revoke" },
  { id: "hermes", label: "Hermes", category: "agent_runtime", availability: "implemented", authStrategy: "agent_credential", capabilities: ["crm.read", "crm.propose", "agent_work.claim"], requiredBindings: [], setup: "agent-credential", healthCheck: "agent-run-observed", executor: "agent-mcp", revoke: "agent-credential-revoke" },
  { id: "inbound-webhook", label: "Inbound webhook", category: "developer", availability: "implemented", authStrategy: "signed_webhook", capabilities: ["contact.upsert"], requiredBindings: [], setup: "webhook-endpoint", healthCheck: "delivery-history", executor: "webhook-ingest", revoke: "webhook-delete" },
  { id: "outbound-webhook", label: "Outbound webhook", category: "developer", availability: "implemented", authStrategy: "signed_webhook", capabilities: ["integration.publish"], requiredBindings: ["WEBHOOK_ENCRYPTION_KEY"], setup: "webhook-endpoint", healthCheck: "delivery-history", executor: "webhook-delivery", revoke: "webhook-delete" },
] as const;

export const pipelineCatalog = {
  version: PRODUCT_CATALOG_VERSION,
  board: {
    cardDrag: true,
    keyboardDrag: true,
    mobileMoveFallback: true,
    optimisticConcurrency: "updated_at",
    sameStageReorder: false,
  },
  stageCategories: ["open", "won", "lost"] as const,
  terminalCategories: ["won", "lost"] as const,
  mutationEndpoint: "/v1/admin/opportunities/:id",
  stageChangedEvent: "opportunity.stage_changed",
} as const;

export function publicProductCatalog() {
  return {
    version: PRODUCT_CATALOG_VERSION,
    automation: automationCatalog,
    integrations: integrationCatalog,
    pipeline: pipelineCatalog,
  };
}

export function validateProductCatalog(): string[] {
  const errors: string[] = [];
  const unique = (scope: string, ids: readonly string[]) => {
    if (new Set(ids).size !== ids.length) errors.push(`${scope} IDs must be unique`);
  };
  unique("automation trigger", automationCatalog.triggers.map((item) => item.id));
  unique("automation condition field", automationCatalog.conditionFields.map((item) => item.id));
  unique("automation action", automationCatalog.actions.map((item) => item.id));
  unique("integration", integrationCatalog.map((item) => item.id));
  for (const action of automationCatalog.actions) {
    if (!action.executor || !action.editor || !action.capability) errors.push(`Automation action ${action.id} is incomplete`);
    if (!action.recordTypes.length) errors.push(`Automation action ${action.id} needs a record type`);
  }
  for (const integration of integrationCatalog) {
    if (integration.availability === "implemented" &&
      (!integration.executor || !integration.healthCheck || !integration.revoke)) {
      errors.push(`Implemented integration ${integration.id} is missing lifecycle handlers`);
    }
    if (integration.availability === "planned" &&
      (integration.executor || integration.healthCheck || integration.revoke)) {
      errors.push(`Planned integration ${integration.id} advertises executable handlers`);
    }
  }
  return errors;
}
