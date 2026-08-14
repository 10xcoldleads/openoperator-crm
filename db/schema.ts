import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  settings: text("settings").notNull().default("{}"),
  onboardingStatus: text("onboarding_status").notNull().default("draft"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("workspaces_slug_unique").on(table.slug)]);

export const workspaceMembers = sqliteTable("workspace_members", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("workspace_members_email_unique").on(table.workspaceId, table.email)]);

export const mailboxConnections = sqliteTable("mailbox_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerEmail: text("owner_email").notNull(),
  provider: text("provider").notNull(),
  toolkit: text("toolkit").notNull(),
  alias: text("alias").notNull(),
  authConfigId: text("auth_config_id").notNull(),
  composioUserId: text("composio_user_id").notNull(),
  connectedAccountId: text("connected_account_id"),
  status: text("status").notNull().default("pending"),
  providerStatus: text("provider_status"),
  allowedCapabilities: text("allowed_capabilities").notNull().default("[]"),
  lastSyncedAt: text("last_synced_at"),
  lastError: text("last_error"),
  revision: integer("revision").notNull().default(1),
  changeId: text("change_id"),
  connectExpiresAt: text("connect_expires_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("mailbox_connections_workspace_provider_alias_unique")
    .on(table.workspaceId, table.provider, table.alias),
  uniqueIndex("mailbox_connections_composio_account_unique").on(table.connectedAccountId),
  index("mailbox_connections_workspace_status_idx").on(table.workspaceId, table.status, table.updatedAt),
]);

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(),
  domain: text("domain"),
  website: text("website"),
  industry: text("industry"),
  owner: text("owner"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("companies_workspace_name_key_unique").on(table.workspaceId, table.nameKey),
  index("companies_workspace_activity_idx").on(table.workspaceId, table.updatedAt),
  index("companies_workspace_cursor_idx").on(table.workspaceId, table.updatedAt, table.id),
]);

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
  company: text("company"),
  companyId: text("company_id").references(() => companies.id),
  status: text("status").notNull().default("lead"),
  stage: text("stage").notNull().default("new"),
  score: integer("score").notNull().default(0),
  owner: text("owner"),
  sourceFirst: text("source_first"),
  sourceLast: text("source_last"),
  tags: text("tags").notNull().default("[]"),
  customFields: text("custom_fields").notNull().default("{}"),
  lastActivityAt: text("last_activity_at"),
  nextFollowUpAt: text("next_follow_up_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("contacts_workspace_email_unique").on(table.workspaceId, table.email),
  index("contacts_workspace_stage_idx").on(table.workspaceId, table.stage),
  index("contacts_workspace_status_stage_idx").on(table.workspaceId, table.status, table.stage),
  index("contacts_workspace_owner_idx").on(table.workspaceId, table.owner),
  index("contacts_workspace_company_idx").on(table.workspaceId, table.companyId),
  index("contacts_workspace_source_idx").on(table.workspaceId, table.sourceLast),
  index("contacts_workspace_activity_idx").on(table.workspaceId, table.lastActivityAt),
  index("contacts_workspace_follow_up_idx").on(table.workspaceId, table.nextFollowUpAt),
  index("contacts_workspace_score_idx").on(table.workspaceId, table.score),
  index("contacts_workspace_cursor_idx").on(table.workspaceId, table.updatedAt, table.id),
  index("contacts_stage_idx").on(table.stage),
  index("contacts_activity_idx").on(table.lastActivityAt),
]);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  allowedOrigins: text("allowed_origins").notNull().default("[]"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("sources_workspace_slug_unique").on(table.workspaceId, table.slug),
  uniqueIndex("sources_key_hash_unique").on(table.keyHash),
]);

export const activities = sqliteTable("activities", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  sourceId: text("source_id").references(() => sources.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  metadata: text("metadata").notNull().default("{}"),
  externalId: text("external_id"),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("activities_contact_idx").on(table.contactId),
  uniqueIndex("activities_source_external_unique").on(table.sourceId, table.externalId),
]);

export const deals = sqliteTable("deals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  sourceId: text("source_id").references(() => sources.id),
  name: text("name").notNull(),
  stage: text("stage").notNull().default("open"),
  value: real("value").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  externalId: text("external_id"),
  closedAt: text("closed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("deals_contact_idx").on(table.contactId),
  uniqueIndex("deals_source_external_unique").on(table.sourceId, table.externalId),
]);

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  author: text("author").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
}, (table) => [index("notes_contact_idx").on(table.contactId)]);

export const companyNotes = sqliteTable("company_notes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  companyId: text("company_id").notNull().references(() => companies.id),
  author: text("author").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
}, (table) => [index("company_notes_company_idx").on(table.workspaceId, table.companyId, table.createdAt)]);

export const companyRedirects = sqliteTable("company_redirects", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  sourceCompanyId: text("source_company_id").notNull(),
  targetCompanyId: text("target_company_id").notNull().references(() => companies.id),
  sourceName: text("source_name").notNull(),
  mergedAt: text("merged_at").notNull(),
}, (table) => [
  uniqueIndex("company_redirects_workspace_source_unique").on(table.workspaceId, table.sourceCompanyId),
  index("company_redirects_workspace_target_idx").on(table.workspaceId, table.targetCompanyId),
]);

export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  objectType: text("object_type").notNull().default("contact"),
  filters: text("filters").notNull().default("{}"),
  visibility: text("visibility").notNull().default("private"),
  columns: text("columns").notNull().default('["identity","company","score","stage","owner"]'),
  sorts: text("sorts").notNull().default('[{"field":"recent","direction":"desc"}]'),
  revision: integer("revision").notNull().default(1),
  changeId: text("change_id"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("saved_views_workspace_name_unique").on(table.workspaceId, table.objectType, table.name),
  index("saved_views_workspace_visibility_creator_idx").on(table.workspaceId, table.objectType, table.visibility, table.createdBy, table.updatedAt),
]);

export const pipelines = sqliteTable("pipelines", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  objectType: text("object_type").notNull().default("opportunity"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("pipelines_workspace_idx").on(table.workspaceId)]);

export const pipelineStages = sqliteTable("pipeline_stages", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  pipelineId: text("pipeline_id").notNull().references(() => pipelines.id),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  probability: integer("probability").notNull().default(0),
  category: text("category").notNull().default("open"),
  color: text("color").notNull().default("#827b70"),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("pipeline_stages_position_unique").on(table.pipelineId, table.position)]);

export const opportunities = sqliteTable("opportunities", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  pipelineId: text("pipeline_id").notNull().references(() => pipelines.id),
  stageId: text("stage_id").notNull().references(() => pipelineStages.id),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("open"),
  value: real("value").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  probability: integer("probability").notNull().default(0),
  owner: text("owner"),
  expectedCloseAt: text("expected_close_at"),
  lastActivityAt: text("last_activity_at"),
  nextStep: text("next_step"),
  lostReason: text("lost_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("opportunities_workspace_pipeline_idx").on(table.workspaceId, table.pipelineId, table.stageId),
  index("opportunities_contact_idx").on(table.workspaceId, table.contactId),
  index("opportunities_workspace_cursor_idx").on(table.workspaceId, table.updatedAt, table.id),
  index("opportunities_workspace_close_idx").on(table.workspaceId, table.status, table.expectedCloseAt, table.id),
]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  contactId: text("contact_id").references(() => contacts.id),
  opportunityId: text("opportunity_id").references(() => opportunities.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull().default("normal"),
  assignee: text("assignee"),
  dueAt: text("due_at"),
  completedAt: text("completed_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("tasks_workspace_due_idx").on(table.workspaceId, table.status, table.dueAt)]);

export const automationRules = sqliteTable("automation_rules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(),
  conditions: text("conditions").notNull().default("[]"),
  actions: text("actions").notNull().default("[]"),
  elseActions: text("else_actions").notNull().default("[]"),
  status: text("status").notNull().default("draft"),
  maxRunsPerRecord: integer("max_runs_per_record").notNull().default(1),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("automation_rules_workspace_idx").on(table.workspaceId, table.status, table.triggerType)]);

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  ruleId: text("rule_id").notNull().references(() => automationRules.id),
  recordType: text("record_type").notNull(),
  recordId: text("record_id").notNull(),
  eventId: text("event_id"),
  retryOfRunId: text("retry_of_run_id"),
  status: text("status").notNull(),
  stepCount: integer("step_count").notNull().default(0),
  output: text("output").notNull().default("{}"),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
}, (table) => [
  uniqueIndex("automation_runs_event_unique").on(table.workspaceId, table.ruleId, table.eventId),
  uniqueIndex("automation_runs_retry_once_unique").on(table.workspaceId, table.retryOfRunId),
  index("automation_runs_workspace_status_idx").on(table.workspaceId, table.status, table.startedAt),
]);

export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  direction: text("direction").notNull(),
  url: text("url"),
  eventTypes: text("event_types").notNull().default("[]"),
  secretPrefix: text("secret_prefix").notNull(),
  secretHash: text("secret_hash").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("webhook_endpoints_workspace_idx").on(table.workspaceId, table.direction, table.active)]);

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  endpointId: text("endpoint_id").notNull().references(() => webhookEndpoints.id),
  eventId: text("event_id").notNull(),
  direction: text("direction").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  requestBody: text("request_body").notNull().default("{}"),
  responseStatus: integer("response_status"),
  responseExcerpt: text("response_excerpt"),
  nextAttemptAt: text("next_attempt_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("webhook_delivery_event_unique").on(table.endpointId, table.eventId, table.direction),
  index("webhook_delivery_retry_queue_idx").on(table.direction, table.status, table.nextAttemptAt, table.updatedAt),
  index("webhook_delivery_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const agentPolicies = sqliteTable("agent_policies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  mode: text("mode").notNull().default("copilot"),
  requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(true),
  maxProposalsPerRun: integer("max_proposals_per_run").notNull().default(25),
  staleAfterDays: integer("stale_after_days").notNull().default(7),
  highValueThreshold: real("high_value_threshold").notNull().default(5000),
  agentAccessEnabled: integer("agent_access_enabled", { mode: "boolean" }).notNull().default(true),
  workspaceRateLimitPerMinute: integer("workspace_rate_limit_per_minute").notNull().default(120),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("agent_policies_workspace_unique").on(table.workspaceId)]);

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  agentType: text("agent_type").notNull(),
  triggerType: text("trigger_type").notNull(),
  status: text("status").notNull(),
  policySnapshot: text("policy_snapshot").notNull().default("{}"),
  observations: text("observations").notNull().default("{}"),
  proposalsCreated: integer("proposals_created").notNull().default(0),
  proposalsRefreshed: integer("proposals_refreshed").notNull().default(0),
  proposalsExpired: integer("proposals_expired").notNull().default(0),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
}, (table) => [index("agent_runs_workspace_started_idx").on(table.workspaceId, table.startedAt)]);

export const revenueAgentRunLeases = sqliteTable("revenue_agent_run_leases", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  leaseUntil: text("lease_until").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("revenue_agent_run_leases_expiry_idx").on(table.leaseUntil)]);

export const workspaceOperationLeases = sqliteTable("workspace_operation_leases", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  operation: text("operation", { enum: ["revenue_analysis", "workspace_restore"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  leaseUntil: text("lease_until").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("workspace_operation_leases_expiry_idx").on(table.leaseUntil)]);

export const agentCredentials = sqliteTable("agent_credentials", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  provider: text("provider").notNull().default("custom"),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: text("scopes").notNull().default("[]"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(60),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("agent_credentials_key_hash_unique").on(table.keyHash),
  index("agent_credentials_workspace_active_idx").on(table.workspaceId, table.active),
]);

export const resendConnections = sqliteTable("resend_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  apiKeyPrefix: text("api_key_prefix").notNull(),
  apiKeyCiphertext: text("api_key_ciphertext").notNull(),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  replyTo: text("reply_to"),
  status: text("status", { enum: ["pending", "active", "error", "revoked"] }).notNull().default("pending"),
  lastVerifiedAt: text("last_verified_at"),
  lastError: text("last_error"),
  revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("resend_connections_workspace_active_unique").on(table.workspaceId)
    .where(sql`${table.status} <> 'revoked'`),
  index("resend_connections_workspace_status_idx").on(table.workspaceId, table.status),
]);

export const resendDeliveries = sqliteTable("resend_deliveries", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull().references(() => resendConnections.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  bodyExcerpt: text("body_excerpt").notNull(),
  providerEmailId: text("provider_email_id"),
  status: text("status", { enum: ["pending", "succeeded", "failed"] }).notNull().default("pending"),
  responseStatus: integer("response_status"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("resend_deliveries_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  index("resend_deliveries_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const communicationConsents = sqliteTable("communication_consents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  channel: text("channel", { enum: ["email"] }).notNull(),
  status: text("status", { enum: ["unknown", "opted_in", "opted_out"] }).notNull().default("unknown"),
  basis: text("basis", { enum: ["unknown", "express", "contractual", "inbound_request", "manual_suppression"] }).notNull().default("unknown"),
  evidence: text("evidence"),
  capturedAt: text("captured_at"),
  revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("communication_consents_contact_channel_unique").on(table.workspaceId, table.contactId, table.channel),
  index("communication_consents_workspace_status_idx").on(table.workspaceId, table.channel, table.status),
]);

export const crmCustomValues = sqliteTable("crm_custom_values", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  valueKey: text("value_key").notNull(), label: text("label").notNull(), value: text("value").notNull(),
  folder: text("folder"), active: integer("active", { mode: "boolean" }).notNull().default(true),
  revision: integer("revision").notNull().default(1), changeId: text("change_id").notNull(),
  createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("crm_custom_values_workspace_key_unique").on(table.workspaceId, table.valueKey),
  index("crm_custom_values_workspace_folder_idx").on(table.workspaceId, table.active, table.folder, table.label),
]);

export const twilioConnections = sqliteTable("twilio_connections", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(), accountSid: text("account_sid").notNull(), authTokenPrefix: text("auth_token_prefix").notNull(),
  authTokenCiphertext: text("auth_token_ciphertext").notNull(), messagingServiceSid: text("messaging_service_sid").notNull(),
  status: text("status", { enum: ["pending", "active", "error", "revoked"] }).notNull().default("pending"),
  advancedOptOutStatus: text("advanced_opt_out_status", { enum: ["unverified", "enabled", "disabled"] }).notNull().default("unverified"),
  lastVerifiedAt: text("last_verified_at"), lastError: text("last_error"), revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("twilio_connections_workspace_active_unique").on(table.workspaceId).where(sql`${table.status} <> 'revoked'`),
  index("twilio_connections_workspace_status_idx").on(table.workspaceId, table.status),
]);

export const smsConsents = sqliteTable("sms_consents", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["unknown", "opted_in", "opted_out"] }).notNull().default("unknown"),
  basis: text("basis", { enum: ["unknown", "express", "contractual", "inbound_request", "manual_suppression", "provider_stop"] }).notNull().default("unknown"),
  evidence: text("evidence"), capturedAt: text("captured_at"), providerOptOutType: text("provider_opt_out_type", { enum: ["STOP", "START", "HELP"] }),
  revision: integer("revision").notNull().default(1), changeId: text("change_id").notNull(), createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("sms_consents_contact_unique").on(table.workspaceId, table.contactId),
  index("sms_consents_workspace_status_idx").on(table.workspaceId, table.status),
]);

export const smsThreads = sqliteTable("sms_threads", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull().references(() => twilioConnections.id, { onDelete: "restrict" }),
  contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }), participantPhone: text("participant_phone").notNull(),
  status: text("status", { enum: ["open", "closed", "quarantined"] }).notNull().default("open"),
  lastMessageAt: text("last_message_at").notNull(), unreadCount: integer("unread_count").notNull().default(0),
  revision: integer("revision").notNull().default(1), changeId: text("change_id").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("sms_threads_workspace_phone_unique").on(table.workspaceId, table.participantPhone),
  index("sms_threads_workspace_recent_idx").on(table.workspaceId, table.lastMessageAt, table.id),
  index("sms_threads_workspace_contact_idx").on(table.workspaceId, table.contactId, table.lastMessageAt),
]);

export const smsMessages = sqliteTable("sms_messages", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull().references(() => twilioConnections.id, { onDelete: "restrict" }),
  threadId: text("thread_id").notNull().references(() => smsThreads.id, { onDelete: "cascade" }),
  contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }), direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  providerMessageSid: text("provider_message_sid"), idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(),
  fromPhone: text("from_phone").notNull(), toPhone: text("to_phone").notNull(), bodyTemplate: text("body_template"), bodyText: text("body_text").notNull(),
  purpose: text("purpose", { enum: ["inbound", "transactional", "marketing"] }).notNull(),
  status: text("status", { enum: ["received", "pending", "accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed", "unknown"] }).notNull(),
  errorCode: text("error_code"), error: text("error"), optOutType: text("opt_out_type", { enum: ["STOP", "START", "HELP"] }),
  providerStatusAt: text("provider_status_at"), sentBy: text("sent_by"), occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("sms_messages_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  uniqueIndex("sms_messages_workspace_provider_unique").on(table.workspaceId, table.providerMessageSid),
  index("sms_messages_thread_occurred_idx").on(table.workspaceId, table.threadId, table.occurredAt, table.id),
  index("sms_messages_workspace_status_idx").on(table.workspaceId, table.status, table.updatedAt, table.id),
]);

export const twilioWebhookReceipts = sqliteTable("twilio_webhook_receipts", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull().references(() => twilioConnections.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: ["inbound", "status"] }).notNull(), requestHash: text("request_hash").notNull(),
  signatureHash: text("signature_hash").notNull(), providerMessageSid: text("provider_message_sid"), processedAt: text("processed_at").notNull(),
}, (table) => [
  uniqueIndex("twilio_webhook_receipts_connection_request_unique").on(table.connectionId, table.requestHash),
  index("twilio_webhook_receipts_workspace_processed_idx").on(table.workspaceId, table.processedAt, table.id),
]);

export const marketingCampaigns = sqliteTable("marketing_campaigns", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(), status: text("status", { enum: ["draft", "ready", "sending", "completed", "cancelled"] }).notNull().default("draft"),
  subject: text("subject").notNull(), bodyText: text("body_text").notNull(), contactIds: text("contact_ids").notNull().default("[]"),
  publishedVersionId: text("published_version_id"), revision: integer("revision").notNull().default(1), changeId: text("change_id").notNull(),
  createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("marketing_campaigns_workspace_updated_idx").on(table.workspaceId, table.updatedAt, table.id)]);

export const marketingCampaignVersions = sqliteTable("marketing_campaign_versions", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => marketingCampaigns.id, { onDelete: "cascade" }), version: integer("version").notNull(),
  subject: text("subject").notNull(), bodyText: text("body_text").notNull(), selectedContactIds: text("selected_contact_ids").notNull(),
  exclusionSummary: text("exclusion_summary").notNull(), publishedBy: text("published_by").notNull(), publishedAt: text("published_at").notNull(),
}, (table) => [uniqueIndex("marketing_campaign_versions_campaign_version_unique").on(table.workspaceId, table.campaignId, table.version)]);

export const marketingCampaignRecipients = sqliteTable("marketing_campaign_recipients", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id").notNull().references(() => marketingCampaigns.id, { onDelete: "cascade" }),
  campaignVersionId: text("campaign_version_id").notNull().references(() => marketingCampaignVersions.id, { onDelete: "cascade" }),
  contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }), email: text("email").notNull(),
  firstName: text("first_name"), lastName: text("last_name"), consentRevision: integer("consent_revision").notNull(),
  unsubscribeTokenHash: text("unsubscribe_token_hash").notNull(),
  status: text("status", { enum: ["queued", "sending", "succeeded", "failed", "suppressed", "cancelled"] }).notNull().default("queued"),
  attemptCount: integer("attempt_count").notNull().default(0), providerEmailId: text("provider_email_id"), responseStatus: integer("response_status"),
  error: text("error"), sentAt: text("sent_at"), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("marketing_campaign_recipients_version_contact_unique").on(table.workspaceId, table.campaignVersionId, table.contactId),
  uniqueIndex("marketing_campaign_recipients_unsubscribe_hash_unique").on(table.unsubscribeTokenHash),
  index("marketing_campaign_recipients_campaign_status_idx").on(table.workspaceId, table.campaignId, table.status, table.id),
]);

export const reviewDestinations = sqliteTable("review_destinations", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(), businessName: text("business_name").notNull(), reviewUrl: text("review_url").notNull(),
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"), revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("review_destinations_workspace_status_idx").on(table.workspaceId, table.status, table.updatedAt, table.id)]);

export const reviewRequests = sqliteTable("review_requests", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  destinationId: text("destination_id").notNull().references(() => reviewDestinations.id, { onDelete: "restrict" }),
  contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }), email: text("email").notNull(), firstName: text("first_name"),
  businessName: text("business_name").notNull(), reviewUrl: text("review_url").notNull(), subject: text("subject").notNull(), bodyText: text("body_text").notNull(),
  feedbackTokenHash: text("feedback_token_hash").notNull(), unsubscribeTokenHash: text("unsubscribe_token_hash").notNull(),
  status: text("status", { enum: ["pending", "sending", "succeeded", "failed"] }).notNull().default("pending"), attemptCount: integer("attempt_count").notNull().default(0),
  providerEmailId: text("provider_email_id"), responseStatus: integer("response_status"), error: text("error"), sentAt: text("sent_at"),
  createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("review_requests_feedback_token_hash_unique").on(table.feedbackTokenHash),
  uniqueIndex("review_requests_unsubscribe_token_hash_unique").on(table.unsubscribeTokenHash),
  index("review_requests_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
]);

export const reviewFeedback = sqliteTable("review_feedback", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull().references(() => reviewRequests.id, { onDelete: "restrict" }), idempotencyKey: text("idempotency_key").notNull(),
  rating: integer("rating").notNull(), feedback: text("feedback"), privacyText: text("privacy_text").notNull(), ipHash: text("ip_hash"),
  userAgent: text("user_agent"), submittedAt: text("submitted_at").notNull(),
}, (table) => [
  uniqueIndex("review_feedback_request_unique").on(table.workspaceId, table.requestId),
  uniqueIndex("review_feedback_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
]);

export const conversationThreads = sqliteTable("conversation_threads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  channel: text("channel", { enum: ["email"] }).notNull(),
  provider: text("provider", { enum: ["gmail", "outlook"] }),
  providerThreadId: text("provider_thread_id"),
  participantEmail: text("participant_email").notNull(),
  subject: text("subject").notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  lastMessageAt: text("last_message_at").notNull(),
  unreadCount: integer("unread_count").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("conversation_threads_workspace_recent_idx").on(table.workspaceId, table.lastMessageAt, table.id),
  index("conversation_threads_workspace_contact_idx").on(table.workspaceId, table.contactId, table.lastMessageAt),
  uniqueIndex("conversation_threads_workspace_provider_unique").on(table.workspaceId, table.provider, table.providerThreadId),
]);

export const conversationMessages = sqliteTable("conversation_messages", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull().references(() => conversationThreads.id, { onDelete: "cascade" }),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  provider: text("provider", { enum: ["gmail", "outlook", "resend"] }).notNull(),
  providerMessageId: text("provider_message_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  fromEmail: text("from_email").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  purpose: text("purpose", { enum: ["inbound", "transactional", "marketing"] }).notNull(),
  status: text("status", { enum: ["received", "pending", "sent", "failed"] }).notNull(),
  error: text("error"),
  sentBy: text("sent_by"),
  occurredAt: text("occurred_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("conversation_messages_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  uniqueIndex("conversation_messages_workspace_provider_unique").on(table.workspaceId, table.provider, table.providerMessageId),
  index("conversation_messages_thread_occurred_idx").on(table.workspaceId, table.threadId, table.occurredAt, table.id),
]);

export const agentRequests = sqliteTable("agent_requests", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  credentialId: text("credential_id").notNull().references(() => agentCredentials.id),
  idempotencyKey: text("idempotency_key").notNull(),
  toolName: text("tool_name").notNull(),
  argumentsHash: text("arguments_hash").notNull(),
  status: text("status").notNull(),
  responseJson: text("response_json"),
  proposalId: text("proposal_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("agent_requests_credential_idempotency_unique").on(table.credentialId, table.idempotencyKey),
  index("agent_requests_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const agentRateWindows = sqliteTable("agent_rate_windows", {
  credentialId: text("credential_id").primaryKey().references(() => agentCredentials.id),
  windowStart: integer("window_start").notNull(),
  requestCount: integer("request_count").notNull().default(0),
});

export const forms = sqliteTable("forms", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: text("status", { enum: ["draft", "published", "revoked"] }).notNull().default("draft"),
  title: text("title").notNull(), description: text("description").notNull().default(""), fields: text("fields").notNull(),
  consentText: text("consent_text").notNull(), successMessage: text("success_message").notNull(),
  publishedVersionId: text("published_version_id"), revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(), createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("forms_slug_unique").on(table.slug), index("forms_workspace_updated_idx").on(table.workspaceId, table.updatedAt, table.id)]);

export const formVersions = sqliteTable("form_versions", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }), version: integer("version").notNull(),
  title: text("title").notNull(), description: text("description").notNull(), fields: text("fields").notNull(),
  consentText: text("consent_text").notNull(), successMessage: text("success_message").notNull(),
  publishedBy: text("published_by").notNull(), publishedAt: text("published_at").notNull(),
}, (table) => [uniqueIndex("form_versions_form_version_unique").on(table.workspaceId, table.formId, table.version)]);

export const formSubmissions = sqliteTable("form_submissions", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
  formVersionId: text("form_version_id").notNull().references(() => formVersions.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(), contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  payload: text("payload").notNull(), emailConsent: integer("email_consent", { mode: "boolean" }).notNull(),
  consentText: text("consent_text").notNull(), ipHash: text("ip_hash"), userAgent: text("user_agent"), submittedAt: text("submitted_at").notNull(),
}, (table) => [
  uniqueIndex("form_submissions_form_idempotency_unique").on(table.workspaceId, table.formId, table.idempotencyKey),
  index("form_submissions_form_recent_idx").on(table.workspaceId, table.formId, table.submittedAt, table.id),
]);

export const surveys = sqliteTable("surveys", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(), slug: text("slug").notNull(), status: text("status", { enum: ["draft", "published", "revoked"] }).notNull().default("draft"),
  title: text("title").notNull(), description: text("description").notNull().default(""), questions: text("questions").notNull(),
  successMessage: text("success_message").notNull(), publishedVersionId: text("published_version_id"), revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("surveys_slug_unique").on(table.slug), index("surveys_workspace_updated_idx").on(table.workspaceId, table.updatedAt, table.id)]);

export const surveyVersions = sqliteTable("survey_versions", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  surveyId: text("survey_id").notNull().references(() => surveys.id, { onDelete: "cascade" }), version: integer("version").notNull(),
  title: text("title").notNull(), description: text("description").notNull(), questions: text("questions").notNull(), successMessage: text("success_message").notNull(),
  publishedBy: text("published_by").notNull(), publishedAt: text("published_at").notNull(),
}, (table) => [uniqueIndex("survey_versions_survey_version_unique").on(table.workspaceId, table.surveyId, table.version)]);

export const surveyResponses = sqliteTable("survey_responses", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  surveyId: text("survey_id").notNull().references(() => surveys.id, { onDelete: "cascade" }),
  surveyVersionId: text("survey_version_id").notNull().references(() => surveyVersions.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(), answers: text("answers").notNull(), privacyAccepted: integer("privacy_accepted", { mode: "boolean" }).notNull(),
  startedAt: text("started_at"), submittedAt: text("submitted_at").notNull(), durationSeconds: integer("duration_seconds"), ipHash: text("ip_hash"), userAgent: text("user_agent"),
}, (table) => [
  uniqueIndex("survey_responses_survey_idempotency_unique").on(table.workspaceId, table.surveyId, table.idempotencyKey),
  index("survey_responses_survey_recent_idx").on(table.workspaceId, table.surveyId, table.submittedAt, table.id),
]);

export const bookingCalendars = sqliteTable("booking_calendars", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(), slug: text("slug").notNull(), status: text("status", { enum: ["draft", "published", "revoked"] }).notNull().default("draft"),
  title: text("title").notNull(), description: text("description").notNull().default(""), timezone: text("timezone").notNull(),
  durationMinutes: integer("duration_minutes").notNull(), bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0), minimumNoticeMinutes: integer("minimum_notice_minutes").notNull().default(60),
  maximumDaysAhead: integer("maximum_days_ahead").notNull().default(60), revision: integer("revision").notNull().default(1),
  changeId: text("change_id").notNull(), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("booking_calendars_slug_unique").on(table.slug), index("booking_calendars_workspace_updated_idx").on(table.workspaceId, table.updatedAt, table.id)]);

export const bookingAvailabilityRules = sqliteTable("booking_availability_rules", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  calendarId: text("calendar_id").notNull().references(() => bookingCalendars.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(), startMinute: integer("start_minute").notNull(), endMinute: integer("end_minute").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("booking_rules_calendar_day_window_unique").on(table.workspaceId, table.calendarId, table.dayOfWeek, table.startMinute, table.endMinute),
  index("booking_rules_calendar_day_idx").on(table.workspaceId, table.calendarId, table.dayOfWeek),
]);

export const bookingAppointments = sqliteTable("booking_appointments", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  calendarId: text("calendar_id").notNull().references(() => bookingCalendars.id, { onDelete: "restrict" }),
  contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }), idempotencyKey: text("idempotency_key").notNull(),
  name: text("name").notNull(), email: text("email").notNull(), phone: text("phone"), visitorTimezone: text("visitor_timezone").notNull(),
  startsAt: text("starts_at").notNull(), endsAt: text("ends_at").notNull(), status: text("status", { enum: ["booked", "cancelled"] }).notNull().default("booked"),
  manageTokenHash: text("manage_token_hash").notNull(), externalProvider: text("external_provider"), externalEventId: text("external_event_id"),
  syncStatus: text("sync_status", { enum: ["local", "pending", "synced", "failed"] }).notNull().default("local"), cancelledAt: text("cancelled_at"),
  cancellationReason: text("cancellation_reason"), revision: integer("revision").notNull().default(1), changeId: text("change_id").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("booking_appointments_calendar_idempotency_unique").on(table.workspaceId, table.calendarId, table.idempotencyKey),
  uniqueIndex("booking_appointments_calendar_start_active_unique").on(table.workspaceId, table.calendarId, table.startsAt).where(sql`${table.status} = 'booked'`),
  uniqueIndex("booking_appointments_manage_token_unique").on(table.manageTokenHash),
  index("booking_appointments_calendar_range_idx").on(table.workspaceId, table.calendarId, table.status, table.startsAt, table.endsAt),
]);

export const estimates = sqliteTable("estimates", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }), opportunityId: text("opportunity_id").references(() => opportunities.id, { onDelete: "restrict" }),
  estimateNumber: text("estimate_number").notNull(), title: text("title").notNull(), sellerName: text("seller_name").notNull(), sellerEmail: text("seller_email").notNull(),
  currency: text("currency").notNull(), expiresOn: text("expires_on"), notes: text("notes").notNull().default(""), lineItems: text("line_items").notNull().default("[]"),
  subtotalMinor: integer("subtotal_minor").notNull().default(0), status: text("status", { enum: ["draft", "published", "revoked"] }).notNull().default("draft"),
  publishedVersionId: text("published_version_id"), revision: integer("revision").notNull().default(1), changeId: text("change_id").notNull(),
  createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("estimates_workspace_number_unique").on(table.workspaceId, table.estimateNumber), index("estimates_workspace_status_idx").on(table.workspaceId, table.status, table.updatedAt, table.id), index("estimates_contact_idx").on(table.workspaceId, table.contactId, table.updatedAt, table.id)]);

export const estimateVersions = sqliteTable("estimate_versions", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }), estimateId: text("estimate_id").notNull().references(() => estimates.id, { onDelete: "restrict" }),
  version: integer("version").notNull(), estimateNumber: text("estimate_number").notNull(), title: text("title").notNull(), sellerName: text("seller_name").notNull(), sellerEmail: text("seller_email").notNull(), recipientName: text("recipient_name").notNull(), recipientEmail: text("recipient_email").notNull(),
  currency: text("currency").notNull(), expiresOn: text("expires_on"), notes: text("notes").notNull(), lineItems: text("line_items").notNull(), subtotalMinor: integer("subtotal_minor").notNull(), accessTokenHash: text("access_token_hash").notNull(), publishedBy: text("published_by").notNull(), publishedAt: text("published_at").notNull(),
}, (table) => [uniqueIndex("estimate_versions_estimate_version_unique").on(table.workspaceId, table.estimateId, table.version), uniqueIndex("estimate_versions_access_hash_unique").on(table.accessTokenHash)]);

export const estimateResponses = sqliteTable("estimate_responses", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }), estimateId: text("estimate_id").notNull().references(() => estimates.id, { onDelete: "restrict" }), versionId: text("version_id").notNull().references(() => estimateVersions.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(), decision: text("decision", { enum: ["acknowledged", "declined"] }).notNull(), typedName: text("typed_name").notNull(), note: text("note"), privacyText: text("privacy_text").notNull(), ipHash: text("ip_hash"), userAgent: text("user_agent"), submittedAt: text("submitted_at").notNull(),
}, (table) => [uniqueIndex("estimate_responses_version_unique").on(table.workspaceId, table.versionId), uniqueIndex("estimate_responses_idempotency_unique").on(table.workspaceId, table.idempotencyKey)]);

export const paymentLedgerEntries = sqliteTable("payment_ledger_entries", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: text("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  opportunityId: text("opportunity_id").references(() => opportunities.id, { onDelete: "restrict" }),
  parentEntryId: text("parent_entry_id"), idempotencyKey: text("idempotency_key").notNull(),
  kind: text("kind", { enum: ["payment", "refund", "dispute", "dispute_reversal"] }).notNull(),
  amountMinor: integer("amount_minor").notNull(), currency: text("currency").notNull(), description: text("description").notNull(),
  provider: text("provider", { enum: ["manual"] }).notNull().default("manual"), providerReference: text("provider_reference"),
  occurredAt: text("occurred_at").notNull(), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("payment_ledger_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  uniqueIndex("payment_ledger_provider_reference_unique").on(table.workspaceId, table.provider, table.providerReference),
  index("payment_ledger_workspace_occurred_idx").on(table.workspaceId, table.occurredAt, table.id),
  index("payment_ledger_parent_idx").on(table.workspaceId, table.parentEntryId, table.occurredAt, table.id),
  index("payment_ledger_contact_idx").on(table.workspaceId, table.contactId, table.occurredAt, table.id),
]);

export const agentWorkspaceRateWindows = sqliteTable("agent_workspace_rate_windows", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  windowStart: integer("window_start").notNull(),
  requestCount: integer("request_count").notNull().default(0),
});

export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(), slug: text("slug").notNull(), status: text("status").notNull().default("draft"), pages: text("pages").notNull(), theme: text("theme").notNull(),
  customDomain: text("custom_domain"), domainStatus: text("domain_status").notNull().default("disabled"), publishedVersionId: text("published_version_id"),
  revision: integer("revision").notNull().default(1), changeId: text("change_id").notNull(), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("sites_slug_unique").on(table.slug), index("sites_workspace_updated_idx").on(table.workspaceId, table.updatedAt, table.id)]);

export const siteVersions = sqliteTable("site_versions", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }), version: integer("version").notNull(), pages: text("pages").notNull(), theme: text("theme").notNull(),
  publishedBy: text("published_by").notNull(), publishedAt: text("published_at").notNull(),
}, (table) => [uniqueIndex("site_versions_site_version_unique").on(table.workspaceId, table.siteId, table.version)]);

export const agentWorkItems = sqliteTable("agent_work_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  automationRuleId: text("automation_rule_id").references(() => automationRules.id),
  automationRunId: text("automation_run_id").references(() => automationRuns.id),
  contactId: text("contact_id").references(() => contacts.id),
  opportunityId: text("opportunity_id").references(() => opportunities.id),
  visitorProfileId: text("visitor_profile_id"),
  workItemType: text("work_item_type").notNull().default("general"),
  evidenceRevision: integer("evidence_revision"),
  evidenceSnapshot: text("evidence_snapshot"),
  objective: text("objective").notNull(),
  instructions: text("instructions").notNull(),
  preferredProvider: text("preferred_provider").notNull().default("any"),
  status: text("status").notNull().default("queued"),
  claimedByCredentialId: text("claimed_by_credential_id").references(() => agentCredentials.id),
  claimExpiresAt: text("claim_expires_at"),
  result: text("result"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  index("agent_work_items_workspace_queue_idx").on(table.workspaceId, table.status, table.preferredProvider, table.createdAt),
  index("agent_work_items_claim_idx").on(table.claimedByCredentialId, table.status, table.claimExpiresAt),
]);

export const agentProposals = sqliteTable("agent_proposals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  credentialId: text("credential_id").references(() => agentCredentials.id),
  runId: text("run_id"),
  dedupeKey: text("dedupe_key"),
  contactId: text("contact_id").references(() => contacts.id),
  opportunityId: text("opportunity_id").references(() => opportunities.id),
  agentType: text("agent_type").notNull(),
  category: text("category").notNull().default("execution"),
  priority: integer("priority").notNull().default(50),
  title: text("title").notNull(),
  rationale: text("rationale").notNull(),
  confidence: integer("confidence").notNull(),
  riskLevel: text("risk_level").notNull(),
  proposedAction: text("proposed_action").notNull(),
  status: text("status").notNull().default("pending"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: text("reviewed_at"),
  executionResult: text("execution_result"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("agent_proposals_workspace_status_idx").on(table.workspaceId, table.status, table.createdAt),
  index("agent_proposals_credential_created_idx").on(table.workspaceId, table.credentialId, table.createdAt, table.id),
  uniqueIndex("agent_proposals_pending_dedupe_unique").on(table.workspaceId, table.dedupeKey).where(sql`${table.status} = 'pending'`),
]);

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  beforeState: text("before_state"),
  afterState: text("after_state"),
  requestId: text("request_id").notNull(),
  ipHash: text("ip_hash"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("audit_log_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const onboardingChecks = sqliteTable("onboarding_checks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  checkKey: text("check_key").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull().default("pending"),
  details: text("details").notNull().default("{}"),
  checkedAt: text("checked_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("onboarding_checks_workspace_key_unique").on(table.workspaceId, table.checkKey)]);

export const contactImports = sqliteTable("contact_imports", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("committed"),
  requestedRows: integer("requested_rows").notNull(),
  importedRows: integer("imported_rows").notNull().default(0),
  skippedRows: integer("skipped_rows").notNull().default(0),
  rollbackDeletedRows: integer("rollback_deleted_rows").notNull().default(0),
  rollbackConflictRows: integer("rollback_conflict_rows").notNull().default(0),
  rollbackMissingRows: integer("rollback_missing_rows").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  rolledBackBy: text("rolled_back_by"),
  rolledBackAt: text("rolled_back_at"),
  rollbackRequestId: text("rollback_request_id"),
  rollbackAuditId: text("rollback_audit_id"),
}, (table) => [index("contact_imports_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id)]);

export const contactImportMembers = sqliteTable("contact_import_members", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  importId: text("import_id").notNull().references(() => contactImports.id, { onDelete: "cascade" }),
  contactId: text("contact_id").notNull(),
  email: text("email").notNull(),
  importedUpdatedAt: text("imported_updated_at").notNull(),
  outcome: text("outcome").notNull().default("created"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("contact_import_members_import_contact_unique").on(table.importId, table.contactId),
  index("contact_import_members_workspace_contact_idx").on(table.workspaceId, table.contactId, table.createdAt),
]);

export const recoverySessions = sqliteTable("recovery_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  status: text("status").notNull().default("ready"),
  backupCreatedAt: text("backup_created_at").notNull(),
  fingerprint: text("fingerprint").notNull(),
  summary: text("summary").notNull().default("{}"),
  expiresAt: text("expires_at").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("recovery_sessions_workspace_status_idx").on(table.workspaceId, table.status, table.expiresAt)]);

export const recoveryRows = sqliteTable("recovery_rows", {
  sessionId: text("session_id").notNull().references(() => recoverySessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  rowJson: text("row_json").notNull(),
}, (table) => [
  uniqueIndex("recovery_rows_session_table_row_unique").on(table.sessionId, table.tableName, table.rowId),
  index("recovery_rows_workspace_session_idx").on(table.workspaceId, table.sessionId, table.tableName),
]);

export const recoveryGuardRows = sqliteTable("recovery_guard_rows", {
  sessionId: text("session_id").notNull().references(() => recoverySessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  rowJson: text("row_json").notNull(),
}, (table) => [
  uniqueIndex("recovery_guard_rows_session_table_row_unique").on(table.sessionId, table.tableName, table.rowId),
  index("recovery_guard_rows_workspace_session_idx").on(table.workspaceId, table.sessionId, table.tableName),
]);
