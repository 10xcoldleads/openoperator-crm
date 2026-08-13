"use client";

import { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  WorkflowAction,
  WorkflowCondition,
  WorkflowDefinition,
} from "./VisualAutomationBuilder";
import { parseAutomationTrace } from "./automationTrace";
import GradientText from "./components/GradientText";
import ConversationsWorkspace from "./ConversationsWorkspace";
import FormsWorkspace from "./FormsWorkspace";
import BookingWorkspace from "./BookingWorkspace";
import ReportingWorkspace from "./ReportingWorkspace";
import PaymentsWorkspace from "./PaymentsWorkspace";
import SurveysWorkspace from "./SurveysWorkspace";
import SitesWorkspace from "./SitesWorkspace";
import MarketingWorkspace from "./MarketingWorkspace";
import ReviewRequestsWorkspace from "./ReviewRequestsWorkspace";

const VisualAutomationBuilder = lazy(() => import("./VisualAutomationBuilder"));

type Contact = {
  id: string; email: string; first_name: string | null; last_name: string | null;
  company: string | null; stage: string; status: string; source_last: string | null;
  owner: string | null; next_follow_up_at: string | null; last_activity_at: string | null; created_at: string; updated_at: string; revenue: number;
  score: number; custom_fields?: string;
};
type CustomFieldDefinition = {
  id: string; object_type: "contact" | "company" | "opportunity"; field_key: string; label: string;
  field_type: "text" | "number" | "boolean" | "date" | "select"; options: string[];
  required: boolean; active: boolean; position: number; revision: number;
};
type CustomFieldDraft = Record<string, string | number | boolean | null>;
type ContactCustomFilter = { field_key: string; operator: string; value?: string | number | boolean };
const customFilterComplete = (filter: ContactCustomFilter) =>
  filter.operator === "is_empty" || (filter.value !== undefined && filter.value !== null && filter.value !== "");
function customFieldDisplay(field: CustomFieldDefinition, value: unknown) {
  if (value === undefined || value === null || value === "") return "—";
  if (field.field_type === "boolean") return value === true ? "Yes" : "No";
  if (field.field_type === "date" && typeof value === "string") {
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString();
  }
  return String(value);
}
type ObjectPageLayout = {
  id: string | null; object_type: CustomFieldDefinition["object_type"]; name: string;
  sections: Array<{ id: string; title: string; fields: string[] }>;
  revision: number; change_id: string | null; updated_at: string | null;
};
type CustomObjectField = {
  key: string; label: string; type: "text" | "number" | "boolean" | "date" | "select";
  required: boolean; options: string[];
};
type CustomObjectDefinition = {
  id: string; slug: string; singular_label: string; plural_label: string; description: string | null;
  fields: CustomObjectField[]; active: boolean; revision: number; record_count: number;
  created_at: string; updated_at: string;
  authority: { configure: boolean; create: boolean; update: boolean; delete: boolean; relations: boolean };
};
type CustomObjectRelation = {
  id: string; target_type: "contact" | "company" | "opportunity" | "custom_record";
  target_id: string; target_label?: string | null; target_detail?: string | null; label: string; created_at: string;
};
type CustomObjectRecord = {
  id: string; object_id: string; display_name: string; data: Record<string, string | number | boolean>;
  revision: number; relation_count: number; relations: CustomObjectRelation[]; created_at: string; updated_at: string;
};
type CustomObjectViewFilter = {
  field_key: string; operator: "equals" | "contains" | "gte" | "lte" | "before" | "after" | "is_empty";
  value?: string | number | boolean;
};
type CustomObjectView = {
  id: string; object_id: string; name: string; visibility: "private" | "workspace";
  filters: CustomObjectViewFilter[]; visible_fields: string[]; sort_field: string;
  sort_direction: "asc" | "desc"; revision: number; created_by: string; updated_at: string;
};

function CustomFieldEditor(props: {
  fields: CustomFieldDefinition[];
  draft: CustomFieldDraft;
  disabled: boolean;
  onChange: (next: CustomFieldDraft) => void;
}) {
  return <div className="record-custom-field-grid">{props.fields.map((field) => {
    const value = props.draft[field.field_key];
    if (field.field_type === "boolean") return <label key={field.id} className="record-custom-checkbox">
      <input type="checkbox" checked={value === true} disabled={props.disabled}
        onChange={(event) => props.onChange({ ...props.draft, [field.field_key]: event.target.checked })} />
      {field.label}{field.required ? " *" : ""}
    </label>;
    if (field.field_type === "select") return <label key={field.id}>{field.label.toUpperCase()}{field.required ? " *" : ""}
      <select disabled={props.disabled} value={typeof value === "string" ? value : ""}
        onChange={(event) => props.onChange({ ...props.draft, [field.field_key]: event.target.value || null })}>
        <option value="">Not set</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>;
    return <label key={field.id}>{field.label.toUpperCase()}{field.required ? " *" : ""}
      <input disabled={props.disabled} type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : "text"}
        maxLength={field.field_type === "text" ? 1000 : undefined}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
        onChange={(event) => props.onChange({
          ...props.draft, [field.field_key]: field.field_type === "number"
            ? event.target.value === "" ? null : Number(event.target.value)
            : event.target.value || null,
        })} />
    </label>;
  })}</div>;
}
function LayoutCustomFieldEditor(props: {
  layout?: ObjectPageLayout;
  fields: CustomFieldDefinition[];
  draft: CustomFieldDraft;
  disabled: boolean;
  onChange: (next: CustomFieldDraft) => void;
}) {
  const byKey = new Map(props.fields.map((field) => [field.field_key, field]));
  const fallback = [{ id: "additional_details", title: "Additional details", fields: props.fields.map((field) => field.field_key) }];
  return <div className="record-layout-sections">{(props.layout?.sections || fallback).map((section) => {
    const fields = section.fields.map((key) => byKey.get(key)).filter((field): field is CustomFieldDefinition => Boolean(field));
    if (!fields.length) return null;
    return <section className="record-layout-section" key={section.id}>
      <header><h4>{section.title}</h4><span>{fields.length} {fields.length === 1 ? "field" : "fields"}</span></header>
      <CustomFieldEditor fields={fields} draft={props.draft} disabled={props.disabled} onChange={props.onChange} />
    </section>;
  })}</div>;
}
function CustomFilterEditor(props: {
  fields: CustomFieldDefinition[];
  filters: ContactCustomFilter[];
  disabled: boolean;
  onChange: (filters: ContactCustomFilter[]) => void;
}) {
  const [fieldKey, setFieldKey] = useState("");
  const available = props.fields.filter((field) => field.object_type === "contact" && field.active &&
    !props.filters.some((filter) => filter.field_key === field.field_key));
  const operators = (field: CustomFieldDefinition) => field.field_type === "text"
    ? [["equals", "Equals"], ["contains", "Contains"], ["is_empty", "Is empty"]]
    : field.field_type === "number"
      ? [["equals", "Equals"], ["gte", "At least"], ["lte", "At most"], ["is_empty", "Is empty"]]
      : field.field_type === "date"
        ? [["equals", "On"], ["before", "Before"], ["after", "After"], ["is_empty", "Is empty"]]
        : [["equals", "Equals"], ["is_empty", "Is empty"]];
  return <div className="custom-filter-editor">
    <div className="custom-filter-add">
      <select aria-label="Choose custom field filter" value={fieldKey} disabled={props.disabled || props.filters.length >= 5}
        onChange={(event) => setFieldKey(event.target.value)}>
        <option value="">Add custom-field filter…</option>
        {available.map((field) => <option key={field.id} value={field.field_key}>{field.label}</option>)}
      </select>
      <button type="button" disabled={props.disabled || !fieldKey || props.filters.length >= 5} onClick={() => {
        props.onChange([...props.filters, { field_key: fieldKey, operator: "equals", value: "" }]);
        setFieldKey("");
      }}>ADD FILTER</button>
    </div>
    {props.filters.map((filter) => {
      const field = props.fields.find((candidate) => candidate.object_type === "contact" && candidate.active && candidate.field_key === filter.field_key);
      if (!field) return null;
      const setFilter = (next: ContactCustomFilter) => props.onChange(props.filters.map((item) => item.field_key === filter.field_key ? next : item));
      return <div className="custom-filter-row" key={filter.field_key}>
        <strong>{field.label}</strong>
        <select aria-label={`Operator for ${field.label}`} value={filter.operator} disabled={props.disabled} onChange={(event) =>
          setFilter({ field_key: filter.field_key, operator: event.target.value,
            ...(event.target.value === "is_empty" ? {} : { value: "" }) })}>
          {operators(field).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {filter.operator !== "is_empty" && (field.field_type === "select"
          ? <select aria-label={`Value for ${field.label}`} disabled={props.disabled} value={String(filter.value ?? "")}
              onChange={(event) => setFilter({ ...filter, value: event.target.value })}>
              <option value="">Choose value…</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          : field.field_type === "boolean"
            ? <select aria-label={`Value for ${field.label}`} disabled={props.disabled} value={String(filter.value ?? "")}
                onChange={(event) => setFilter({ ...filter, value: event.target.value === "true" })}>
                <option value="">Choose value…</option><option value="true">True</option><option value="false">False</option>
              </select>
            : <input aria-label={`Value for ${field.label}`} disabled={props.disabled}
                type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : "text"}
                maxLength={field.field_type === "text" ? 1000 : undefined} value={String(filter.value ?? "")}
                onChange={(event) => setFilter({ ...filter, value: field.field_type === "number"
                  ? event.target.value === "" ? "" : Number(event.target.value) : event.target.value })} />)}
        <button type="button" aria-label={`Remove ${field.label} filter`} disabled={props.disabled}
          onClick={() => props.onChange(props.filters.filter((item) => item.field_key !== filter.field_key))}>REMOVE</button>
      </div>;
    })}
    <small>{props.filters.length}/5 custom filters · archived or ungranted fields are removed automatically</small>
  </div>;
}
function CustomColumnPicker(props: {
  fields: CustomFieldDefinition[];
  columns: string[];
  disabled: boolean;
  onChange: (columns: string[]) => void;
}) {
  const fields = props.fields.filter((field) => field.object_type === "contact" && field.active);
  if (!fields.length) return null;
  return <fieldset className="custom-column-picker"><legend>CUSTOM LIST COLUMNS</legend>
    {fields.map((field) => {
      const column = `custom:${field.field_key}`;
      return <label key={field.id}><input type="checkbox" checked={props.columns.includes(column)}
        disabled={props.disabled || (!props.columns.includes(column) && props.columns.length >= 12)}
        onChange={(event) => props.onChange(event.target.checked
          ? [...props.columns, column] : props.columns.filter((item) => item !== column))} /> {field.label}</label>;
    })}
    <small>Up to 12 total columns. Visibility follows field-level read permission.</small>
  </fieldset>;
}
type DashboardData = {
  metrics: { contacts: number; customers: number; revenue: number; followUps: number };
  stages: Record<string, number>; contacts: Contact[];
};
type ContactPageData = {
  contacts: Contact[];
  pagination: { page: number; limit: number; total: number; pages: number };
  facets: {
    owners: Array<{ owner: string; total: number }>;
    sources: Array<{ source: string; total: number }>;
  };
};
type Activity = { id: string; type: string; title: string; body: string | null; occurred_at: string };
type Deal = { id: string; name: string; stage: string; value: number; currency: string };
type Note = { id: string; body: string; author: string; created_at: string; updated_at?: string | null };
type ContactDetail = {
  contact: Contact & { next_follow_up_at: string | null };
  activities: Activity[];
  deals: Deal[];
  notes: Note[];
  opportunities: Opportunity[];
  tasks: Task[];
};
type Source = { id: string; slug: string; name: string; key_prefix: string; active: number; last_used_at: string | null; created_at: string };
type ProductCatalogData = {
  version: number;
  integrations: Array<{
    id: string; label: string; category: string; availability: "implemented" | "planned";
    authStrategy: string; capabilities: string[];
    runtime: { configured: boolean; missingBindings: string[] };
  }>;
};
type Pipeline = { id: string; name: string };
type PipelineStage = { id: string; pipeline_id: string; name: string; position: number; probability: number; category: string; color: string };
type Opportunity = {
  id: string; pipeline_id: string; stage_id: string; contact_id: string; name: string; status: string;
  value: number; currency: string; probability: number; next_step: string | null; expected_close_at: string | null; owner: string | null;
  last_activity_at?: string | null; created_at?: string; updated_at: string; custom_fields?: string;
  email: string; first_name: string | null; last_name: string | null; company: string | null; stage_name: string; stage_color: string;
};

function PipelineDropColumn(props: { stage: PipelineStage; children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `pipeline-stage:${props.stage.id}`,
    data: { stageId: props.stage.id },
  });
  return <section ref={setNodeRef} className={`kanban-column${isOver ? " drop-target" : ""}`}
    aria-label={`${props.stage.name} stage drop zone`}>
    {props.children}
  </section>;
}

function DraggableOpportunityCard(props: {
  opportunity: Opportunity;
  disabled: boolean;
  onKeyboardMove: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `pipeline-opportunity:${props.opportunity.id}`,
    disabled: props.disabled,
    data: { opportunityId: props.opportunity.id },
  });
  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return <article ref={setNodeRef} style={style}
    className={`opportunity-card${isDragging ? " dragging" : ""}`}>
    <button type="button" className="opportunity-drag-handle"
      aria-label={`Drag ${props.opportunity.name}. Use left and right arrow keys to move stages.`}
      disabled={props.disabled}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        props.onKeyboardMove(event.key === "ArrowLeft" ? -1 : 1);
      }}>
      <span aria-hidden="true">⠿</span><small>MOVE</small>
    </button>
    {props.children}
  </article>;
}
type Task = { id: string; contact_id: string | null; opportunity_id: string | null; title: string; status: string; priority: string; assignee: string | null; due_at: string | null; contact_email: string | null; opportunity_name: string | null; updated_at: string };

function TaskLifecycleControls(props: {
  task: Task;
  disabled: boolean;
  deleteArmed: boolean;
  onStatus: (status: "open" | "completed" | "cancelled") => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  const { task, disabled, deleteArmed, onStatus, onDelete, onCancelDelete } = props;
  return <div className="task-lifecycle-controls" aria-label={`Actions for ${task.title}`}>
    {task.status === "open" && <>
      <button type="button" className="task-complete" disabled={disabled}
        aria-label={`Complete ${task.title}`} onClick={() => onStatus("completed")}>COMPLETE</button>
      <button type="button" className="task-state" disabled={disabled}
        aria-label={`Cancel ${task.title}`} onClick={() => onStatus("cancelled")}>CANCEL</button>
    </>}
    {task.status !== "open" && <button type="button" className="task-state" disabled={disabled}
      aria-label={`Reopen ${task.title}`} onClick={() => onStatus("open")}>REOPEN</button>}
    {task.status === "completed" && <>
      <button type="button" className="task-delete" disabled={disabled}
        aria-label={`Delete ${task.title}`} onClick={onDelete}>{deleteArmed ? "CONFIRM DELETE" : "DELETE"}</button>
      {deleteArmed && <button type="button" className="task-delete task-keep" disabled={disabled}
        aria-label={`Cancel delete ${task.title}`} onClick={onCancelDelete}>KEEP</button>}
    </>}
  </div>;
}

type CalendarEvent = {
  id: string; kind: "task" | "contact_follow_up" | "opportunity_close";
  record_id: string; contact_id: string | null; opportunity_id: string | null;
  title: string; starts_at: string; status: string; priority: string | null;
  owner: string | null; subtitle: string;
};
type CalendarData = {
  range: { start: string; end: string; maximum_days: number };
  events: CalendarEvent[];
  counts: { tasks: number; follow_ups: number; opportunity_closes: number };
  limits: { per_kind: number; total: number };
  truncated: { tasks: boolean; follow_ups: boolean; opportunity_closes: boolean; total: boolean };
};
type Automation = {
  id: string; name: string; trigger_type: string; status: string; conditions: string; actions: string; else_actions: string;
  max_runs_per_record: number; authority_manifest: string; authority_hash: string | null; updated_at: string;
  metadata_status?: "ready" | "blocked"; metadata_error?: string | null;
};
type Webhook = {
  id: string; name: string; direction: string; url: string | null; event_types: string;
  payload_preset: "generic" | "slack" | "teams" | "discord" | "pagerduty";
  secret_prefix: string; provider_credential_prefix: string | null; active: number; updated_at: string;
};
type AutomationRun = {
  id: string; rule_id: string; record_type: string; record_id: string; retry_of_run_id: string | null;
  automation_name: string; trigger_type: string;
  principal_id: string | null; trigger_actor_type: string | null; trigger_actor_id: string | null;
  authority_manifest: string; authority_hash: string | null;
  status: string; step_count: number; output: string; error: string | null; started_at: string; finished_at: string | null;
};
type AgentWorkItem = { id: string; objective: string; instructions: string; preferred_provider: string; status: string;
  contact_id: string | null; opportunity_id: string | null;
  visitor_profile_id?: string | null; work_item_type?: string; evidence_revision?: number | null;
  automation_name: string | null; contact_email: string | null; opportunity_name: string | null;
  claimed_by_name: string | null; claimed_by_provider: string | null; claim_expires_at: string | null;
  result: string | null; created_at: string; updated_at: string; completed_at: string | null };
type WebhookDelivery = {
  id: string; endpoint_id: string; endpoint_name: string; event_id: string; direction: string; status: string;
  attempts: number; response_status: number | null; response_excerpt: string | null; next_attempt_at: string | null;
  created_at: string; updated_at: string;
};
type Company = {
  id: string; name: string; domain: string | null; website: string | null; industry: string | null; owner: string | null;
  contacts: number; leads: number; revenue: number; open_pipeline: number; last_activity_at: string | null; updated_at: string; custom_fields?: string;
};
type CompanyContact = {
  id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null;
  status: string; stage: string; score: number; owner: string | null; last_activity_at: string | null;
  next_follow_up_at: string | null; created_at: string; updated_at: string;
};
type CompanyActivity = Activity & {
  contact_id: string;
  contact_email: string; contact_first_name: string | null; contact_last_name: string | null;
};
type CompanyNote = Note & {
  company_id?: string; contact_id?: string; updated_at?: string | null; contact_email?: string;
  contact_first_name?: string | null; contact_last_name?: string | null;
};
type CompanyDetail = {
  company: Company & { won_revenue: number; weighted_forecast: number };
  contacts: CompanyContact[];
  opportunities: Array<Opportunity & { contact_email: string; contact_first_name: string | null; contact_last_name: string | null }>;
  tasks: Task[];
  company_notes: CompanyNote[];
  contact_notes: CompanyNote[];
  activities: CompanyActivity[];
  audits: AuditEntry[];
};
type CompanyDuplicateCandidate = {
  source: Company; target: Company; score: number;
  reasons: Array<{ code: string; label: string; weight: number }>;
};
type CompanyMergePreview = {
  source: Company; target: Company;
  source_counts: Record<"contacts" | "notes" | "opportunities" | "tasks" | "aliases", number>;
  target_counts: Record<"contacts" | "notes" | "opportunities" | "tasks" | "aliases", number>;
  resulting_counts: Record<"contacts" | "notes" | "opportunities" | "tasks" | "aliases", number>;
  field_resolutions: Array<{ field: string; source_value: string | null; target_value: string | null; resolved_value: string | null; resolution: string }>;
  warnings: string[]; source_if_updated_at: string; target_if_updated_at: string; review_token: string;
};
type SavedView = {
  id: string; name: string; filters: string; visibility: "private" | "workspace";
  columns: string; sorts: string; revision: number; created_by: string; updated_at: string;
};
type Briefing = {
  generated_at: string;
  metrics: { open_pipeline: number; weighted_forecast: number; overdue_tasks: number; due_today: number; stalled_deals: number; unqualified_leads: number };
  top_leads: Array<{ id: string; email: string; first_name: string | null; last_name: string | null; company: string | null; score: number; reasons: string[] }>;
  stalled_opportunities: Opportunity[];
  overdue_tasks: Task[];
};
type AgentProposal = {
  id: string; credential_id?: string | null; contact_id?: string | null; opportunity_id?: string | null;
  title: string; rationale: string; confidence: number; risk_level: string; status: string; proposed_action: string;
  execution_result: string | null; created_at: string; expires_at: string | null; category: string; priority: number;
  agent_type: string; origin_credential_name?: string | null; origin_provider?: string | null;
  visitor_email?: string | null; visitor_first_name?: string | null; visitor_last_name?: string | null;
  visitor_company_name?: string | null; visitor_provider?: string | null; visitor_consent_status?: string | null;
  visitor_visit_count?: number | null; visitor_high_intent_count?: number | null; visitor_last_seen_at?: string | null;
  visitor_latest_url?: string | null; visitor_revision?: number | null;
};
type AgentPolicy = {
  mode: string; require_approval: number; max_proposals_per_run: number; stale_after_days: number; high_value_threshold: number;
  agent_access_enabled: number; workspace_rate_limit_per_minute: number;
};
type AgentCredential = {
  id: string; name: string; provider: string; key_prefix: string; scopes: string; active: number;
  lifecycle_status: "active" | "expired" | "revoked"; rate_limit_per_minute: number;
  last_used_at: string | null; expires_at: string | null; created_at: string; created_by: string; revoked_at: string | null;
};
type RevenueAgentRun = { id: string; status: string; trigger_type: string; observations: string; proposals_created: number; proposals_refreshed: number; proposals_expired: number; started_at: string; finished_at: string | null };
type AgentRunSummary = {
  analysis_id: string; analyzed: number; proposals_created: number; proposals_refreshed: number; proposals_expired: number; healthy: number;
  reasons: { missing_next_step: number; stale: number; overdue: number; unowned: number; missing_close_date: number; zero_value: number; lead_follow_up: number; call_risk: number };
  policy: { mode: string; require_approval: boolean; max_proposals_per_run: number; stale_after_days: number; high_value_threshold: number };
};
type OpportunityIntelligence = {
  opportunity_id: string; generated_at: string;
  health: {
    score: number; status: "strong" | "watch" | "at_risk"; coverage: "connected" | "not_connected";
    last_signal_at: string | null;
    reasons: Array<{ code: string; label: string; impact: number; evidence: string }>;
  };
  summary: { total: number; analyzed_calls: number; emails: number; meetings: number };
  signals: Array<{
    id: string; type: string; title: string; body: string | null; occurred_at: string;
    metadata: { sentiment: "positive" | "neutral" | "negative" | null; call_score: number | null; objections: string[]; next_step_detected: boolean | null };
  }>;
  safety: { source_content_trusted: false; score_is_deterministic: true; mutations_require_human_approval: true; bounded_to: number };
};
type OnboardingCheck = { id: string; check_key: string; label: string; status: string; details: string; checked_at: string | null };
type AuditEntry = { id: string; actor_id: string; action: string; entity_type: string; entity_id: string; created_at: string };
type RecoveryPreview = {
  id: string; backup_created_at: string; expires_at: string; counts: Record<string, number>;
  total_rows: number; confirmation: string; preserved: string[]; cleared: string[];
};
type AccessPolicyData = {
  policy: {
    revision: number; updated_by: string; updated_at: string; editable: boolean;
    subject_role: "member"; resource: "contact"; grants: string[]; allowed_grants: string[];
    custom_fields: Array<{ field_key: string; label: string; grant: string; read_grant: string }>;
    opportunity: {
      resource: "opportunity"; grants: string[]; allowed_grants: string[];
      custom_fields: Array<{ field_key: string; label: string; grant: string; read_grant: string }>;
    };
    custom_objects: Array<{
      object_id: string; resource: string; slug: string; singular_label: string; plural_label: string;
      active: boolean; grants: string[]; stale_grants: string[]; allowed_grants: string[];
      fields: Array<{ field_key: string; label: string; required: boolean; read_grant: string; update_grant: string }>;
    }>;
    invariants: Record<string, string>;
  };
  current_user: { email: string; role: string };
  members: Array<{ email: string; role: string; active: number; created_at: string }>;
};
type ControlData = {
  workspace: { id: string; name: string; onboarding_status: string }; role: string;
  current_user?: { email: string; role: string };
  pipelines: Pipeline[]; stages: PipelineStage[]; opportunities: Opportunity[]; tasks: Task[];
  automations: Automation[]; runs: AutomationRun[]; webhooks: Webhook[]; deliveries: WebhookDelivery[];
  proposals: AgentProposal[]; agent_runs: RevenueAgentRun[]; agent_policy: AgentPolicy | null; checks: OnboardingCheck[]; audits: AuditEntry[];
  companies: Company[]; saved_views: SavedView[]; agent_work_items: AgentWorkItem[];
};
type OperationsHealth = {
  generated_at: string; status: "healthy" | "watch" | "action"; attention_count: number;
  components: Array<{
    id: "scheduler" | "webhooks" | "automations" | "agents" | "email";
    label: string; status: "healthy" | "watch" | "action";
    summary: string; details: string; counts: Record<string, number>; last_event_at: string | null;
  }>;
  history: Array<{
    observed_at: string; status: "healthy" | "watch" | "action"; attention_count: number;
    components: Array<{ id: string; status: "healthy" | "watch" | "action"; counts: Record<string, number> }>;
  }>;
  history_window: {
    retained_days: number; returned_snapshots: number; healthy: number; watch: number; action: number;
  };
  slo_windows: Array<{
    label: "24H" | "7D" | "30D"; total: number; healthy: number; watch: number; action: number;
    healthy_percentage: number | null;
  }>;
  incidents: Array<{
    id: string; status: "open" | "resolved"; severity: "action"; component_ids: string[];
    opened_at: string; last_observed_at: string; resolved_at: string | null;
    escalation_delays_minutes: number[]; escalated_steps: number[];
  }>;
  alerting: {
    destination: "outbound_webhook"; subscribed_endpoints: number;
    event_types: ["operations.health.action", "operations.health.escalated", "operations.health.recovered"]; retry_contract: string;
  };
  policy: {
    target_healthy_percentage: number; incident_after_consecutive_action: number;
    notify_on_recovery: boolean; escalation_delays_minutes: number[];
    revision: number; change_id: string | null;
    updated_by: string; updated_at: string | null;
  };
  active_operation: { operation: string; acquired_at: string; lease_until: string } | null;
  safety: {
    admin_only: true; workspace_data_scoped: true; scheduler_heartbeat_global: true;
    record_content_included: false; derived_without_mutation: true;
  };
};
type CommandSearchData = {
  query: string;
  groups: { contacts: Contact[]; companies: Company[]; opportunities: Opportunity[] };
  returned: number;
  limits: { per_group: 6; total: 18 };
  trust: { record_content_trusted: false; read_only: true; workspace_scoped: true };
};
type VisitorConnector = {
  id: string; provider: "audiencelab" | "rb2b"; name: string; token_prefix: string;
  active: number; consent_default: "unknown" | "granted" | "denied";
  last_event_at: string | null; created_at: string; updated_at: string;
};
type VisitorProfile = {
  id: string; connector_id: string; provider: "audiencelab" | "rb2b"; identity_kind: "person" | "company";
  email: string | null; first_name: string | null; last_name: string | null; linkedin_url: string | null;
  title: string | null; company_name: string | null; company_domain: string | null; industry: string | null;
  employee_count: string | null; estimated_revenue: string | null; city: string | null; region: string | null;
  consent_status: "unknown" | "granted" | "denied"; review_status: "new" | "reviewed" | "promoted" | "suppressed";
  matched_contact_id: string | null; matched_contact_email: string | null;
  visit_count: number; high_intent_count: number; repeat_visits: number; event_count: number;
  first_seen_at: string; last_seen_at: string; latest_url: string | null; latest_referrer: string | null;
  tags: string; revision: number; updated_at: string;
};
type VisitorIntentAccount = {
  company_domain: string; company_name: string; profile_count: number; people_count: number;
  visit_count: number; high_intent_count: number; repeat_visits: number; known_contact_count: number;
  consent_granted_count: number; consent_denied_count: number; first_seen_at: string; last_seen_at: string;
  evidence_updated_at: string;
  latest_url: string | null; crm_company_id: string | null; crm_company_name: string | null;
  open_opportunity_count: number; open_pipeline_value: number; intent_score: number;
  active_case_id: string | null; active_case_status: "new" | "in_review" | null;
  score_reasons: Array<{ code: string; label: string; points: number }>;
};
type VisitorIntentCase = {
  id: string; company_domain: string; company_name: string;
  status: "new" | "in_review" | "resolved" | "dismissed";
  priority: "low" | "normal" | "high" | "urgent"; owner: string | null; due_at: string | null;
  evidence_updated_at: string; intent_score: number; evidence_snapshot: VisitorIntentAccount;
  resolution_note: string | null; revision: number; created_at: string; updated_at: string;
};
type VisitorIntentCaseDetail = {
  case: VisitorIntentCase;
  timeline: Array<{
    id: string; actor_type: string; actor_id: string; action: string;
    before: Partial<VisitorIntentCase> | null; after: Partial<VisitorIntentCase> | null; created_at: string;
  }>;
  isolation: { contacts_created: false; companies_created: false; opportunities_created: false; outreach_authorized: false };
};
type VisitorIntentData = {
  connectors: VisitorConnector[]; profiles: VisitorProfile[]; accounts: VisitorIntentAccount[];
  counts: Partial<Record<VisitorProfile["review_status"], number>>;
  limits: { profiles: number; accounts: number };
  isolation: {
    contacts_created_automatically: false; companies_created_automatically: false;
    domainless_profiles_excluded_from_accounts: true; payload_content_trusted: false;
    promotion_requires_admin_review: true;
  };
};
type AudienceImportPreview = {
  total: number; create_quarantine: number; update_quarantine: number;
  contacts_created: 0; outreach_authorized: false;
};
type ContactImportPreview = {
  total: number; ready: number; skipped_existing: number;
  rows: Array<{ email: string; outcome: "create" | "skip_existing"; custom_fields: string }>;
};
type ContactImportBatch = {
  id: string; status: "committed" | "rolled_back";
  requested_rows: number; imported_rows: number; skipped_rows: number;
  rollback_deleted_rows: number; rollback_conflict_rows: number; rollback_missing_rows: number;
  rollback_ready_rows: number; rollback_conflicts_now: number; rollback_missing_now: number;
  created_by: string; created_at: string; rolled_back_by: string | null; rolled_back_at: string | null;
};
type CsvDocument = { headers: string[]; rows: string[][] };
type CsvMapping = Record<string, string>;
type MailboxConnection = {
  id: string; owner_email: string; provider: "gmail" | "outlook"; toolkit: string; alias: string;
  status: "pending" | "active" | "expired" | "disabled" | "revoked" | "error";
  connected_account_id: string | null; connect_expires_at: string | null;
  provider_status: string | null; allowed_capabilities: string[]; last_synced_at: string | null;
  last_error: string | null; revision: number; created_at: string; updated_at: string;
};
type MailboxConnectionData = {
  connections: MailboxConnection[];
  readiness: { composio: boolean; gmail: boolean; outlook: boolean; authority: "connection_only_no_execution" };
  contracts: {
    self_service: "mailbox_oauth_self_service_v1";
    advanced_link: "mailbox_connect_link_advanced_v1";
    reconnect: "mailbox_oauth_reconnect_v1";
  };
};
type MailboxConversationData = {
  connection: { id: string; owner_email: string; provider: "gmail" | "outlook" };
  conversations: Array<{
    id: string; subject: string; sender_name: string; sender_email: string;
    received_at: string | null; snippet: string; unread: boolean;
  }>;
  privacy: { persisted: false; bodies_returned: false; attachments_returned: false; maximum_results: 25 };
  authority: { read_metadata: true; draft: false; send: false; delete: false };
};
type ResendConnection = {
  id: string; label: string; api_key_prefix: string; from_email: string; from_name: string | null;
  reply_to: string | null; status: "pending" | "active" | "error"; last_verified_at: string | null;
  last_error: string | null; revision: number; change_id: string; created_at: string; updated_at: string;
};
type ResendConnectionData = {
  connection: ResendConnection | null;
  deliveries: Array<{
    id: string; recipient: string; subject: string; body_excerpt: string; provider_email_id: string | null;
    status: "pending" | "succeeded" | "failed"; response_status: number | null; error: string | null;
    created_by: string; created_at: string; updated_at: string;
  }>;
  history_visible: boolean;
  runtime: { encryption_configured: boolean };
  limits: { hourly_sends: number; subject_characters: number; body_characters: number; history: number };
};

function parseCsv(value: string): CsvDocument {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted && character === '"' && value[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === ",") { record.push(field); field = ""; continue; }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      record.push(field); field = "";
      if (record.some((item) => item.trim())) records.push(record);
      record = [];
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error("CSV contains an unclosed quote.");
  record.push(field);
  if (record.some((item) => item.trim())) records.push(record);
  if (records.length < 2) throw new Error("CSV needs a header and at least one data row.");
  if (records.length > 101) throw new Error("Import at most 100 rows at a time.");
  const headers = records[0].map((item) => item.trim());
  if (headers.some((header) => !header)) throw new Error("CSV headers cannot be blank.");
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique.");
  const rows = records.slice(1);
  if (rows.some((row) => row.length > headers.length)) throw new Error("A CSV row has more values than the header.");
  return { headers, rows };
}
function suggestedCsvTarget(header: string, allowed: string[]) {
  const normalized = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return allowed.includes(normalized) ? normalized : "";
}
function mapCsvDocument(document: CsvDocument, mapping: CsvMapping) {
  const targets = Object.values(mapping).filter(Boolean);
  if (new Set(targets).size !== targets.length) throw new Error("Each destination field can only be mapped once.");
  return document.rows.map((values) => {
    const row: Record<string, unknown> = {};
    document.headers.forEach((header, index) => {
      const target = mapping[header];
      if (!target) return;
      const value = values[index]?.trim() || null;
      if (target.startsWith("custom:")) {
        const key = target.slice(7);
        const custom = (row.custom_fields ||= {}) as Record<string, unknown>;
        custom[key] = value;
      } else row[target] = value;
    });
    return row;
  });
}
function CsvMappingEditor({ csv, mapping, targets, onChange }: {
  csv: string; mapping: CsvMapping; targets: Array<{ value: string; label: string }>;
  onChange: (mapping: CsvMapping) => void;
}) {
  let document: CsvDocument;
  try { document = parseCsv(csv); }
  catch { return null; }
  const allowed = targets.map((target) => target.value);
  return <fieldset className="csv-mapping"><legend>MAP CSV COLUMNS</legend>
    <small>Confirm where every source column belongs. Unmapped columns are ignored.</small>
    <div>{document.headers.map((header) => {
      const selected = mapping[header] ?? suggestedCsvTarget(header, allowed);
      return <label key={header}><span>{header}</span><b>→</b><select aria-label={`Map ${header}`} value={selected}
        onChange={(event) => onChange({ ...mapping, [header]: event.target.value })}>
        <option value="">Ignore</option>
        {targets.map((target) => <option key={target.value} value={target.value}>{target.label}</option>)}
      </select></label>;
    })}</div>
  </fieldset>;
}
type CommandEntry =
  | { id: string; kind: "navigation"; label: string; description: string; view: WorkspaceView; leadView?: LeadView }
  | { id: string; kind: "contact"; label: string; description: string; record: Contact }
  | { id: string; kind: "company"; label: string; description: string; record: Company }
  | { id: string; kind: "opportunity"; label: string; description: string; record: Opportunity };
type WorkspaceView = "dashboard" | "leads" | "pipeline" | "conversations" | "forms" | "surveys" | "sites" | "marketing" | "reviews" | "booking" | "payments" | "tasks" | "reports" | "agent" | "automations" | "integrations" | "settings";
type IntegrationDomain = "mailboxes" | "agents" | "sources" | "webhooks";
type IntegrationCatalogView = "catalog" | "installed";
type LeadView = "inbox" | "contacts" | "companies" | "visitors";
type ContactDrawerTab = "overview" | "timeline" | "related";
type OpportunityDrawerTab = "overview" | "intelligence" | "execution" | "agent";
type CompanyDrawerTab = "overview" | "relationships" | "timeline";
const workspaceViews: Array<{ id: WorkspaceView; label: string; icon: string; group: "Workspace" | "Intelligence" | "System"; adminOnly?: boolean }> = [
  { id: "dashboard", label: "Dashboard", icon: "D", group: "Workspace" },
  { id: "leads", label: "Contacts", icon: "C", group: "Workspace" },
  { id: "pipeline", label: "Opportunities", icon: "O", group: "Workspace" },
  { id: "conversations", label: "Conversations", icon: "M", group: "Workspace" },
  { id: "forms", label: "Forms", icon: "F", group: "Workspace" },
  { id: "surveys", label: "Surveys", icon: "Q", group: "Workspace" },
  { id: "sites", label: "Sites", icon: "S", group: "Workspace" },
  { id: "marketing", label: "Marketing", icon: "E", group: "Workspace" },
  { id: "reviews", label: "Review requests", icon: "★", group: "Workspace" },
  { id: "booking", label: "Booking", icon: "B", group: "Workspace" },
  { id: "payments", label: "Payments", icon: "$", group: "Workspace", adminOnly: true },
  { id: "tasks", label: "Calendar & tasks", icon: "T", group: "Workspace" },
  { id: "reports", label: "Reports", icon: "R", group: "Intelligence" },
  { id: "agent", label: "Agent work", icon: "A", group: "Intelligence" },
  { id: "automations", label: "Automations", icon: "W", group: "Intelligence" },
  { id: "integrations", label: "App connections", icon: "I", group: "System" },
  { id: "settings", label: "Settings", icon: "S", group: "System" },
];

const stageLabels: Record<string, string> = {
  new: "New", registered: "Registered", confirmed: "Confirmed", attended: "Attended",
  offer: "Community Offer", booked: "Call Booked", won: "Converted",
};
const defaultWorkflow: WorkflowDefinition = {
  trigger_type: "opportunity.stage_changed",
  conditions: [],
  actions: [{ type: "create_task", title: "Follow up after stage change", priority: "normal", due_in_minutes: 1440 }],
  else_actions: [],
  max_runs_per_record: 20,
};
const automationDefinition = (automation: Automation): WorkflowDefinition | null => {
  try {
    const storedConditions = JSON.parse(automation.conditions);
    const storedActions = JSON.parse(automation.actions);
    const storedElseActions = JSON.parse(automation.else_actions || "[]");
    if (!Array.isArray(storedConditions) || !Array.isArray(storedActions) || !Array.isArray(storedElseActions)) return null;
    if (storedConditions.some((condition) => !condition || typeof condition !== "object" ||
      (!["status", "stage", "stage_id", "owner", "source_last", "score", "probability", "value"].includes(condition.field) &&
        !(typeof condition.field === "string" && /^custom:[a-z][a-z0-9_]{1,39}$/.test(condition.field))) ||
      (condition.operator !== undefined &&
        !["equals", "not_equals", "greater_than", "less_than"].includes(condition.operator)) ||
      !Object.hasOwn(condition, "value"))) return null;
    if (storedActions.some((action) => !action || typeof action !== "object" ||
      !["create_task", "add_note", "update_opportunity", "update_contact", "request_agent", "publish_event"].includes(action.type))) return null;
    const conditions = storedConditions.map((condition) => ({
      ...condition, operator: condition.operator || "equals",
    })) as WorkflowCondition[];
    const normalizeAction = (action: Record<string, unknown>) => action.type === "create_task" ? {
      ...action, title: action.title || "Follow up after stage change", priority: action.priority || "normal",
      due_in_minutes: action.due_in_minutes ?? 0, approval_required: action.approval_required === true,
    } : action;
    const actions = storedActions.map(normalizeAction) as WorkflowAction[];
    const elseActions = storedElseActions.map(normalizeAction) as WorkflowAction[];
    const triggerType = ["opportunity.created", "opportunity.stage_changed", "opportunity.manual",
      "contact.created", "contact.lifecycle_changed", "contact.manual"].includes(automation.trigger_type)
      ? automation.trigger_type as WorkflowDefinition["trigger_type"]
      : "opportunity.stage_changed";
    return { trigger_type: triggerType, conditions, actions, else_actions: elseActions,
      max_runs_per_record: automation.max_runs_per_record };
  } catch { return null; }
};
function automationAgentReadiness(
  definition: WorkflowDefinition | null,
  providers: Array<"openclaw" | "hermes">,
  observedProviders: Array<"openclaw" | "hermes">,
  accessEnabled: boolean,
) {
  const requests = [...(definition?.actions ?? []), ...(definition?.else_actions ?? [])]
    .filter((action): action is Extract<WorkflowAction, { type: "request_agent" }> => action.type === "request_agent");
  if (!requests.length) return null;
  if (!accessEnabled) return { ready: false, label: "Agent pickup paused by workspace policy" };
  const missing = [...new Set(requests.flatMap((action) =>
    action.preferred_provider === "any"
      ? providers.length ? [] : ["OpenClaw or Hermes"]
      : providers.includes(action.preferred_provider) ? [] : [action.preferred_provider],
  ))];
  if (missing.length) return { ready: false, label: `Connect ${missing.join(" + ")} before activation` };
  const unobserved = requests.some((action) => action.preferred_provider === "any"
    ? !observedProviders.length
    : !observedProviders.includes(action.preferred_provider));
  return unobserved
    ? { ready: false, label: "Agent credential active · runtime has never checked in" }
    : { ready: true, label: "Agent runtime previously observed" };
}
const automationRunTrace = (run: AutomationRun | null) => {
  return run ? parseAutomationTrace(run.output) : [];
};
const agentWorkResult = (item: AgentWorkItem) => {
  if (!item.result) return null;
  try {
    const parsed = JSON.parse(item.result) as { summary?: unknown; error?: unknown; retryable?: unknown };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      error: typeof parsed.error === "string" ? parsed.error : "",
      retryable: parsed.retryable === true,
    };
  } catch { return { summary: "", error: "Stored runtime result is unreadable.", retryable: false }; }
};
const agentAccessPresets = {
  assistant: {
    label: "Executive assistant",
    description: "Briefing, records, visitor intent, workflow observability, and human-gated proposals—including manual workflow launches.",
    scopes: ["crm:summary:read", "crm:companies:read", "crm:contacts:read", "crm:opportunities:read", "crm:automations:read", "crm:visitor-intent:read", "crm:visitor-intent:propose", "crm:visitor-research:execute", "crm:propose"],
  },
  analyst: {
    label: "Read-only analyst",
    description: "Briefing, companies, contacts, and opportunities. Cannot propose changes.",
    scopes: ["crm:summary:read", "crm:companies:read", "crm:contacts:read", "crm:opportunities:read"],
  },
  contacts: {
    label: "Contact researcher",
    description: "Company relationship graphs, contact search, and timelines only.",
    scopes: ["crm:companies:read", "crm:contacts:read"],
  },
  pipeline: {
    label: "Pipeline analyst",
    description: "Revenue briefing and opportunities only.",
    scopes: ["crm:summary:read", "crm:opportunities:read"],
  },
} as const;
type AgentAccessPreset = keyof typeof agentAccessPresets;
const money = (value: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
}).format(value);
const localDateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const currentCalendarMonth = () => localDateKey(new Date()).slice(0, 7);
const calendarMonthRange = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = new Date(year, monthNumber - 1, 1);
  const gridStart = new Date(year, monthNumber - 1, 1 - monthStart.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);
  return {
    monthStart,
    start: gridStart,
    end: gridEnd,
    days: Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    }),
  };
};
const scopeLabels = (value: string) => {
  const labels: Record<string, string> = {
    "crm:read": "Legacy broad read",
    "crm:summary:read": "Briefing",
    "crm:companies:read": "Companies",
    "crm:contacts:read": "Contacts",
    "crm:opportunities:read": "Opportunities",
    "crm:automations:read": "Workflow observability",
    "crm:visitor-intent:read": "Visitor intent",
    "crm:visitor-intent:propose": "Visitor promotion proposals",
    "crm:visitor-research:execute": "Visitor research jobs",
    "crm:propose": "Human-gated proposals",
  };
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map((scope) => labels[String(scope)] || scope).join(" · ") : "No scopes"; }
  catch { return "Invalid scope data"; }
};
const proposalActionView = (proposal: AgentProposal) => {
  try {
    const action = JSON.parse(proposal.proposed_action) as Record<string, unknown>;
    if (action.type === "create_task") {
      return { button: "APPROVE + CREATE TASK", summary: `Create task: ${String(action.title || proposal.title)}` };
    }
    if (action.type === "update_opportunity") {
      const changes = action.changes && typeof action.changes === "object" && !Array.isArray(action.changes)
        ? Object.keys(action.changes as Record<string, unknown>).join(", ")
        : "unknown fields";
      return { button: "APPROVE + UPDATE OPPORTUNITY", summary: `Update opportunity fields: ${changes}` };
    }
    if (action.type === "update_contact") {
      const changes = action.changes && typeof action.changes === "object" && !Array.isArray(action.changes)
        ? Object.entries(action.changes as Record<string, unknown>)
          .map(([field, value]) => `${field}: ${value === null ? "unassigned" : String(value)}`).join(", ")
        : "unknown fields";
      return { button: "APPROVE + UPDATE LEAD", summary: `Update lead: ${changes}` };
    }
    if (action.type === "run_workflow") {
      return {
        button: "APPROVE + RUN WORKFLOW",
        summary: `Launch manual workflow ${String(action.workflow_id || "unknown")} on ${String(action.record_id || "unknown")}`,
      };
    }
    if (action.type === "promote_visitor") {
      return {
        button: "APPROVE + PROMOTE VISITOR",
        summary: `Create or link one Contact from quarantined profile ${String(action.visitor_profile_id || "unknown")}. Outreach remains unauthorized.`,
      };
    }
    if (action.type === "open_intent_case") {
      return {
        button: "APPROVE + OPEN INTENT CASE",
        summary: `Open one quarantined case for ${String(action.company_domain || "unknown")} with frozen evidence and an SLA. No CRM record or outreach permission is created.`,
      };
    }
  } catch {}
  return { button: "REVIEW INVALID ACTION", summary: "The stored action cannot be safely previewed." };
};
const proposalOrigin = (proposal: AgentProposal) =>
  proposal.origin_credential_name
    ? `${proposal.origin_credential_name} · ${proposal.origin_provider || "agent"}`
    : proposal.agent_type.startsWith("mcp:")
      ? `${proposal.agent_type.slice(4)} · legacy credential`
      : proposal.agent_type.replaceAll("_", " ");
const proposalResultText = (value: string) => {
  try {
    const result = JSON.parse(value) as { executed?: boolean; rejected?: boolean; invalid?: boolean; conflict?: boolean; message?: string };
    if (result.rejected) return "Rejected — nothing executed.";
    if (result.conflict) return result.message || "Conflict — the target changed and nothing executed.";
    if (result.invalid) return result.message || "Invalid action — nothing executed.";
    if (result.executed) return "Approved and executed.";
    return result.message || "No action executed.";
  } catch {
    return "Execution result is unreadable.";
  }
};
const visitorIntentScore = (profile: VisitorProfile) => Math.min(100,
  15 + Math.min(profile.visit_count, 5) * 7 + Math.min(profile.repeat_visits, 3) * 8 +
  Math.min(profile.high_intent_count, 2) * 20 + (profile.email ? 8 : 0) + (profile.company_domain ? 6 : 0));
const visitorDisplayName = (profile: VisitorProfile) =>
  [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
  profile.company_name || profile.email || profile.company_domain || "Identified visitor";
const safeVisitorTags = (profile: VisitorProfile) => {
  try {
    const tags = JSON.parse(profile.tags);
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8) : [];
  } catch { return []; }
};
const contactCustomValues = (value: string | undefined) => {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string | number | boolean | null> : {};
  } catch { return {}; }
};

export default function CrmDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [drawerTab, setDrawerTab] = useState<ContactDrawerTab>("overview");
  const [selectedOpportunityId, setSelectedOpportunityId] = useState("");
  const [opportunityDrawerTab, setOpportunityDrawerTab] = useState<OpportunityDrawerTab>("overview");
  const [opportunityIntelligence, setOpportunityIntelligence] = useState<OpportunityIntelligence | null>(null);
  const [opportunityIntelligenceLoading, setOpportunityIntelligenceLoading] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [companyDetail, setCompanyDetail] = useState<CompanyDetail | null>(null);
  const [companyDrawerTab, setCompanyDrawerTab] = useState<CompanyDrawerTab>("overview");
  const [companyNote, setCompanyNote] = useState("");
  const [companyDraft, setCompanyDraft] = useState({ name: "", domain: "", website: "", industry: "", owner: "" });
  const [companyMergeTargetId, setCompanyMergeTargetId] = useState("");
  const [companyMergeArmed, setCompanyMergeArmed] = useState(false);
  const [companyMergePreview, setCompanyMergePreview] = useState<CompanyMergePreview | null>(null);
  const [companyDuplicates, setCompanyDuplicates] = useState<CompanyDuplicateCandidate[] | null>(null);
  const [companyDuplicateMeta, setCompanyDuplicateMeta] = useState({ scanned: 0, total: 0, truncated: false });
  const [companyNoteEditing, setCompanyNoteEditing] = useState<{ id: string; body: string } | null>(null);
  const [companyNoteDeleteArmed, setCompanyNoteDeleteArmed] = useState("");
  const [contactNoteEditing, setContactNoteEditing] = useState<{ id: string; body: string } | null>(null);
  const [contactNoteDeleteArmed, setContactNoteDeleteArmed] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [productCatalog, setProductCatalog] = useState<ProductCatalogData | null>(null);
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [pageLayouts, setPageLayouts] = useState<ObjectPageLayout[]>([]);
  const [customObjects, setCustomObjects] = useState<CustomObjectDefinition[]>([]);
  const [selectedCustomObjectId, setSelectedCustomObjectId] = useState("");
  const [customObjectRecords, setCustomObjectRecords] = useState<CustomObjectRecord[]>([]);
  const [customObjectRecordsLoading, setCustomObjectRecordsLoading] = useState(false);
  const [customObjectViews, setCustomObjectViews] = useState<CustomObjectView[]>([]);
  const [activeCustomObjectViewId, setActiveCustomObjectViewId] = useState("");
  const [editingCustomObjectViewId, setEditingCustomObjectViewId] = useState("");
  const [customObjectViewDeleteArmed, setCustomObjectViewDeleteArmed] = useState("");
  const [customObjectViewBuilderOpen, setCustomObjectViewBuilderOpen] = useState(false);
  const [customObjectViewDraft, setCustomObjectViewDraft] = useState<{
    name: string; visibility: "private" | "workspace"; filters: CustomObjectViewFilter[];
    visible_fields: string[]; sort_field: string; sort_direction: "asc" | "desc";
  }>({ name: "", visibility: "private", filters: [], visible_fields: ["display_name"],
    sort_field: "display_name", sort_direction: "asc" });
  const [customObjectDraft, setCustomObjectDraft] = useState({
    singular: "", plural: "", slug: "", description: "", fieldLabel: "", fieldKey: "", fieldType: "text" as CustomObjectField["type"],
  });
  const [customObjectFieldDraft, setCustomObjectFieldDraft] = useState({
    label: "", key: "", type: "text" as CustomObjectField["type"], required: false, options: "",
  });
  const [customObjectRecordDraft, setCustomObjectRecordDraft] = useState<Record<string, string | number | boolean>>({});
  const [customObjectRecordName, setCustomObjectRecordName] = useState("");
  const [customObjectDeleteArmed, setCustomObjectDeleteArmed] = useState("");
  const [customObjectArchiveArmed, setCustomObjectArchiveArmed] = useState("");
  const [customObjectEditing, setCustomObjectEditing] = useState<{
    id: string; display_name: string; data: Record<string, string | number | boolean>;
  } | null>(null);
  const [customRelationDraft, setCustomRelationDraft] = useState<Record<string, {
    target_type: CustomObjectRelation["target_type"]; target_id: string; label: string;
  }>>({});
  const [customRelationQuery, setCustomRelationQuery] = useState<Record<string, string>>({});
  const [customRelationTargets, setCustomRelationTargets] = useState<Record<string, Array<{
    id: string; label: string; detail: string;
  }>>>({});
  const [customRelationSearching, setCustomRelationSearching] = useState("");
  const [customFieldObject, setCustomFieldObject] = useState<CustomFieldDefinition["object_type"]>("contact");
  const [settingsView, setSettingsView] = useState<"access" | "fields" | "objects" | "readiness" | "recovery">("access");
  const [customFieldDraft, setCustomFieldDraft] = useState({
    label: "", fieldKey: "", fieldType: "text" as CustomFieldDefinition["field_type"], options: "", required: false,
  });
  const [contactCustomDraft, setContactCustomDraft] = useState<Record<string, string | number | boolean | null>>({});
  const [companyCustomDraft, setCompanyCustomDraft] = useState<Record<string, string | number | boolean | null>>({});
  const [opportunityCustomDraft, setOpportunityCustomDraft] = useState<Record<string, string | number | boolean | null>>({});
  const [query, setQuery] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceSlug, setSourceSlug] = useState("");
  const [newSourceKey, setNewSourceKey] = useState("");
  const [sourceActionArmed, setSourceActionArmed] = useState<{ id: string; action: "revoke" | "purge" } | null>(null);
  const [control, setControl] = useState<ControlData | null>(null);
  const [operationsHealth, setOperationsHealth] = useState<OperationsHealth | null>(null);
  const [operationsHealthLoading, setOperationsHealthLoading] = useState(false);
  const [operationsPolicyDraft, setOperationsPolicyDraft] = useState<{
    target: number; consecutive: number; recovery: boolean; escalations: number[];
  } | null>(null);
  const [operationsPolicyReviewOpen, setOperationsPolicyReviewOpen] = useState(false);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskPriority, setTaskPriority] = useState("normal");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskContactId, setTaskContactId] = useState("");
  const [taskOpportunityId, setTaskOpportunityId] = useState("");
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  const [taskDeleteArmed, setTaskDeleteArmed] = useState("");
  const [agentWorkCancelArmed, setAgentWorkCancelArmed] = useState("");
  const [opportunityName, setOpportunityName] = useState("");
  const [opportunityValue, setOpportunityValue] = useState("5000");
  const [opportunityContactId, setOpportunityContactId] = useState("");
  const [activePipelineId, setActivePipelineId] = useState("");
  const [pendingTerminalMove, setPendingTerminalMove] = useState<{ opportunityId: string; stageId: string } | null>(null);
  const [activeDraggedOpportunityId, setActiveDraggedOpportunityId] = useState("");
  const [opportunityDraft, setOpportunityDraft] = useState<{
    id: string; value: string; nextStep: string; owner: string; expectedClose: string;
  } | null>(null);
  const [opportunityDeleteArmed, setOpportunityDeleteArmed] = useState("");
  const [automationName, setAutomationName] = useState("");
  const [automationEditing, setAutomationEditing] = useState<Automation | null>(null);
  const [automationBuilderOpen, setAutomationBuilderOpen] = useState(false);
  const [workflowDefinition, setWorkflowDefinition] = useState<WorkflowDefinition>(defaultWorkflow);
  const [automationDeleteArmed, setAutomationDeleteArmed] = useState("");
  const [automationManualRecords, setAutomationManualRecords] = useState<Record<string, string>>({});
  const [automationDebugRunId, setAutomationDebugRunId] = useState("");
  const [automationRunFilter, setAutomationRunFilter] = useState("all");
  const [webhookName, setWebhookName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDirection, setWebhookDirection] = useState<"inbound" | "outbound">("inbound");
  const [webhookOperationsAlerts, setWebhookOperationsAlerts] = useState(false);
  const [webhookVisitorIntentAlerts, setWebhookVisitorIntentAlerts] = useState(false);
  const [webhookPayloadPreset, setWebhookPayloadPreset] = useState<"generic" | "slack" | "teams" | "discord" | "pagerduty">("generic");
  const [webhookProviderCredential, setWebhookProviderCredential] = useState("");
  const [webhookEdit, setWebhookEdit] = useState<{ id: string; url: string } | null>(null);
  const [pagerDutyEdit, setPagerDutyEdit] = useState<{ id: string; key: string } | null>(null);
  const [webhookDeleteArmed, setWebhookDeleteArmed] = useState("");
  const [newWebhookSecret, setNewWebhookSecret] = useState("");
  const [agentCredentials, setAgentCredentials] = useState<AgentCredential[]>([]);
  const [agentCredentialName, setAgentCredentialName] = useState("");
  const [agentProvider, setAgentProvider] = useState("openclaw");
  const [agentAccessPreset, setAgentAccessPreset] = useState<AgentAccessPreset>("assistant");
  const [newAgentKey, setNewAgentKey] = useState("");
  const [agentRun, setAgentRun] = useState<AgentRunSummary | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [mutating, setMutating] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterOwner, setFilterOwner] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [customFilters, setCustomFilters] = useState<ContactCustomFilter[]>([]);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [contactSort, setContactSort] = useState("recent");
  const [contactDirection, setContactDirection] = useState("desc");
  const [contactPage, setContactPage] = useState(1);
  const [contactRows, setContactRows] = useState<Contact[]>([]);
  const [contactPagination, setContactPagination] = useState({ page: 1, limit: 50, total: 0, pages: 1 });
  const [contactFacets, setContactFacets] = useState<ContactPageData["facets"]>({ owners: [], sources: [] });
  const [contactsLoading, setContactsLoading] = useState(false);
  const [inboxTotal, setInboxTotal] = useState(0);
  const [allContactsTotal, setAllContactsTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewName, setViewName] = useState("");
  const [viewVisibility, setViewVisibility] = useState<"private" | "workspace">("private");
  const [viewColumns, setViewColumns] = useState(["identity", "company", "score", "stage", "owner"]);
  const [activeSavedViewId, setActiveSavedViewId] = useState("");
  const [editingSavedViewId, setEditingSavedViewId] = useState("");
  const [savedViewDeleteArmed, setSavedViewDeleteArmed] = useState("");
  const [bulkStage, setBulkStage] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkOwnerAction, setBulkOwnerAction] = useState<"keep" | "assign" | "unassign">("keep");
  const [bulkOwner, setBulkOwner] = useState("");
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [contactOwnerDraft, setContactOwnerDraft] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadFirstName, setLeadFirstName] = useState("");
  const [leadCompany, setLeadCompany] = useState("");
  const [activeView, setActiveView] = useState<WorkspaceView>("dashboard");
  const [taskView, setTaskView] = useState<"list" | "calendar">("list");
  const [calendarMonth, setCalendarMonth] = useState(currentCalendarMonth);
  const [calendarData, setCalendarData] = useState<CalendarData | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState("");
  const [integrationDomain, setIntegrationDomain] = useState<IntegrationDomain>("mailboxes");
  const [integrationCatalogView, setIntegrationCatalogView] = useState<IntegrationCatalogView>("catalog");
  const [integrationCatalogOpen, setIntegrationCatalogOpen] = useState(false);
  const [leadView, setLeadView] = useState<LeadView>("inbox");
  const [visitorIntent, setVisitorIntent] = useState<VisitorIntentData | null>(null);
  const [visitorIntentCases, setVisitorIntentCases] = useState<VisitorIntentCase[]>([]);
  const [visitorCaseStatus, setVisitorCaseStatus] = useState("active");
  const [visitorCasePriority, setVisitorCasePriority] = useState("");
  const [visitorCaseOwner, setVisitorCaseOwner] = useState("");
  const [visitorCaseQuery, setVisitorCaseQuery] = useState("");
  const [visitorCasePage, setVisitorCasePage] = useState(1);
  const [visitorCasePagination, setVisitorCasePagination] = useState({ page: 1, pages: 1, total: 0 });
  const [selectedVisitorCase, setSelectedVisitorCase] = useState<VisitorIntentCaseDetail | null>(null);
  const [visitorCaseOwnerDraft, setVisitorCaseOwnerDraft] = useState("");
  const [visitorCasePriorityDraft, setVisitorCasePriorityDraft] = useState<VisitorIntentCase["priority"]>("normal");
  const [visitorCaseDueDraft, setVisitorCaseDueDraft] = useState("");
  const [visitorIntentLoading, setVisitorIntentLoading] = useState(false);
  const [visitorReviewFilter, setVisitorReviewFilter] = useState("new");
  const [visitorProviderFilter, setVisitorProviderFilter] = useState("");
  const [visitorEntityView, setVisitorEntityView] = useState<"accounts" | "people">("accounts");
  const [expandedVisitorAccount, setExpandedVisitorAccount] = useState("");
  const [visitorConnectorName, setVisitorConnectorName] = useState("");
  const [visitorConnectorProvider, setVisitorConnectorProvider] = useState<"audiencelab" | "rb2b">("audiencelab");
  const [visitorConsentDefault, setVisitorConsentDefault] = useState<"unknown" | "granted" | "denied">("unknown");
  const [newVisitorConnectorUrls, setNewVisitorConnectorUrls] = useState<{ pixel: string; audienceSync: string | null } | null>(null);
  const [audienceConnectorId, setAudienceConnectorId] = useState("");
  const [audienceListName, setAudienceListName] = useState("");
  const [audienceExternalKey, setAudienceExternalKey] = useState("");
  const [audienceConsentBasis, setAudienceConsentBasis] = useState<"unknown" | "granted" | "denied">("unknown");
  const [audienceTags, setAudienceTags] = useState("");
  const [audienceCsv, setAudienceCsv] = useState("email,first_name,last_name,company_name,company_domain,consent_status\n");
  const [audienceMapping, setAudienceMapping] = useState<CsvMapping>({});
  const [audiencePreview, setAudiencePreview] = useState<AudienceImportPreview | null>(null);
  const [contactImportOpen, setContactImportOpen] = useState(false);
  const [contactImportCsv, setContactImportCsv] = useState("email,first_name,last_name,phone,company,owner\n");
  const [contactImportMapping, setContactImportMapping] = useState<CsvMapping>({});
  const [contactImportPreview, setContactImportPreview] = useState<ContactImportPreview | null>(null);
  const [contactImports, setContactImports] = useState<ContactImportBatch[]>([]);
  const [contactImportsLoading, setContactImportsLoading] = useState(false);
  const [contactImportRollbackArmed, setContactImportRollbackArmed] = useState("");
  const [visitorActionArmed, setVisitorActionArmed] = useState<{ id: string; action: "promote" | "suppress" | "case" | "research" } | null>(null);
  const [visitorCaseResolution, setVisitorCaseResolution] = useState<Record<string, string>>({});
  const [visitorConnectorArmed, setVisitorConnectorArmed] = useState<{ id: string; action: "rotate" | "revoke" } | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandSearch, setCommandSearch] = useState<CommandSearchData | null>(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const [leadComposerOpen, setLeadComposerOpen] = useState(false);
  const [viewManagerOpen, setViewManagerOpen] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [webhookClock, setWebhookClock] = useState(0);
  const [taskClock, setTaskClock] = useState(0);
  const [agentDisableArmed, setAgentDisableArmed] = useState(false);
  const [proposalDecisionArmed, setProposalDecisionArmed] = useState<{
    id: string; decision: "approved" | "rejected";
  } | null>(null);
  const [agentCredentialArmed, setAgentCredentialArmed] = useState("");
  const [showAgentCredentialHistory, setShowAgentCredentialHistory] = useState(false);
  const [recoveryPreview, setRecoveryPreview] = useState<RecoveryPreview | null>(null);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState("");
  const [recoveryFileName, setRecoveryFileName] = useState("");
  const [mailboxes, setMailboxes] = useState<MailboxConnectionData | null>(null);
  const [mailboxesLoading, setMailboxesLoading] = useState(false);
  const [mailboxesError, setMailboxesError] = useState("");
  const [mailboxProvider, setMailboxProvider] = useState<"gmail" | "outlook">("gmail");
  const [mailboxAlias, setMailboxAlias] = useState("Primary inbox");
  const [mailboxActionArmed, setMailboxActionArmed] = useState<{ id: string; action: "disable" | "revoke" | "remove" } | null>(null);
  const [mailboxConversations, setMailboxConversations] = useState<Record<string, MailboxConversationData>>({});
  const [mailboxConversationLoading, setMailboxConversationLoading] = useState("");
  const [mailboxConversationError, setMailboxConversationError] = useState<Record<string, string>>({});
  const [resendData, setResendData] = useState<ResendConnectionData | null>(null);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendError, setResendError] = useState("");
  const [resendDraft, setResendDraft] = useState({
    label: "Transactional email", api_key: "", from_email: "", from_name: "OpenOperator", reply_to: "",
  });
  const [resendMessage, setResendMessage] = useState({ recipient: "", subject: "", text: "" });
  const [resendSendArmed, setResendSendArmed] = useState(false);
  const [resendDisconnectArmed, setResendDisconnectArmed] = useState(false);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState("");
  const [accessPolicy, setAccessPolicy] = useState<AccessPolicyData | null>(null);
  const [accessDraft, setAccessDraft] = useState<string[]>([]);
  const [opportunityAccessDraft, setOpportunityAccessDraft] = useState<string[]>([]);
  const [customObjectAccessDraft, setCustomObjectAccessDraft] = useState<Record<string, string[]>>({});
  const [accessPolicyReviewOpen, setAccessPolicyReviewOpen] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const opportunityCloseButtonRef = useRef<HTMLButtonElement>(null);
  const opportunityDrawerRef = useRef<HTMLElement>(null);
  const opportunityIntelligenceAbortRef = useRef<AbortController | null>(null);
  const companyCloseButtonRef = useRef<HTMLButtonElement>(null);
  const companyDrawerRef = useRef<HTMLElement>(null);
  const visitorCaseCloseButtonRef = useRef<HTMLButtonElement>(null);
  const visitorCaseDrawerRef = useRef<HTMLElement>(null);
  const visitorCaseReturnFocusRef = useRef<HTMLElement | null>(null);
  const integrationDrawerRef = useRef<HTMLElement>(null);
  const integrationDrawerCloseRef = useRef<HTMLButtonElement>(null);
  const integrationReturnFocusRef = useRef<HTMLElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const commandTriggerRef = useRef<HTMLButtonElement>(null);
  const commandCenterRef = useRef<HTMLElement>(null);
  const pipelineSensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { distance: 7 },
  }));

  const load = useCallback(async (options?: { preserveError?: boolean }) => {
    if (!options?.preserveError) setError("");
    const [response, sourceResponse, controlResponse, briefingResponse, accessResponse, catalogResponse, customFieldResponse, pageLayoutResponse, customObjectResponse] = await Promise.all([
      fetch("/v1/admin/dashboard", { credentials: "include" }),
      fetch("/v1/admin/sources", { credentials: "include" }),
      fetch("/v1/admin/control-center", { credentials: "include" }),
      fetch("/v1/admin/briefing", { credentials: "include" }),
      fetch("/v1/admin/access-policy", { credentials: "include" }),
      fetch("/v1/admin/product-catalog", { credentials: "include" }),
      fetch("/v1/admin/custom-fields", { credentials: "include" }),
      fetch("/v1/admin/page-layouts", { credentials: "include" }),
      fetch("/v1/admin/custom-objects", { credentials: "include" }),
    ]);
    if (response.status === 401) { setNeedsLogin(true); return; }
    if (!response.ok || !sourceResponse.ok || !controlResponse.ok || !briefingResponse.ok) { setError("CRM data could not be loaded."); setLoading(false); return; }
    setData(await response.json());
    setSources(((await sourceResponse.json()) as { sources: Source[] }).sources);
    const nextControl = await controlResponse.json() as ControlData;
    setControl(nextControl);
    setTaskClock(Date.now());
    setBriefing(await briefingResponse.json());
    if (catalogResponse.ok) setProductCatalog(await catalogResponse.json() as ProductCatalogData);
    if (customFieldResponse.ok) setCustomFields(((await customFieldResponse.json()) as { definitions: CustomFieldDefinition[] }).definitions);
    if (pageLayoutResponse.ok) setPageLayouts(((await pageLayoutResponse.json()) as { layouts: ObjectPageLayout[] }).layouts);
    if (customObjectResponse.ok) {
      const definitions = ((await customObjectResponse.json()) as { definitions: CustomObjectDefinition[] }).definitions;
      setCustomObjects(definitions);
      setSelectedCustomObjectId((current) => current && definitions.some((definition) => definition.id === current)
        ? current : definitions.find((definition) => definition.active)?.id || definitions[0]?.id || "");
    }
    if (accessResponse.ok) {
      const nextAccessPolicy = await accessResponse.json() as AccessPolicyData;
      setAccessPolicy(nextAccessPolicy);
      setAccessDraft(nextAccessPolicy.policy.grants);
      setOpportunityAccessDraft(nextAccessPolicy.policy.opportunity.grants);
      setCustomObjectAccessDraft(Object.fromEntries(nextAccessPolicy.policy.custom_objects.map((definition) =>
        [definition.object_id, definition.grants])));
    }
    if (nextControl.role === "owner" || nextControl.role === "admin") {
      const credentialResponse = await fetch("/v1/admin/agent-credentials", { credentials: "include" });
      if (credentialResponse.ok) setAgentCredentials(((await credentialResponse.json()) as { credentials: AgentCredential[] }).credentials);
    } else setAgentCredentials([]);
    setNeedsLogin(false);
    setLoading(false);
  }, []);

  const loadOperationsHealth = useCallback(async () => {
    setOperationsHealthLoading(true);
    try {
      const response = await fetch("/v1/admin/operations-health", { credentials: "include" });
      if (response.ok) {
        const next = await response.json() as OperationsHealth;
        setOperationsHealth(next);
        setOperationsPolicyDraft({
          target: next.policy.target_healthy_percentage,
          consecutive: next.policy.incident_after_consecutive_action,
          recovery: next.policy.notify_on_recovery,
          escalations: next.policy.escalation_delays_minutes,
        });
        setOperationsPolicyReviewOpen(false);
      }
      else setOperationsHealth(null);
    } catch {
      setOperationsHealth(null);
    } finally {
      setOperationsHealthLoading(false);
    }
  }, []);

  async function saveOperationsHealthPolicy() {
    if (!operationsHealth || !operationsPolicyDraft || mutating) return;
    setMutating("operations-policy"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/operations-health-policy", {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          expected_revision: operationsHealth.policy.revision,
          target_healthy_percentage: operationsPolicyDraft.target,
          incident_after_consecutive_action: operationsPolicyDraft.consecutive,
          notify_on_recovery: operationsPolicyDraft.recovery,
          escalation_delays_minutes: operationsPolicyDraft.escalations,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) {
        setOperationsPolicyReviewOpen(false);
        setNotice("Operations alert policy updated. Existing incidents and retained history were not changed.");
        await loadOperationsHealth();
      } else if (response.status === 409) {
        setOperationsPolicyReviewOpen(false);
        setError(result.error || "The operations policy changed before it could be saved.");
        await loadOperationsHealth();
      } else setError(result.error || "The operations policy could not be saved.");
    } finally { setMutating(""); }
  }

  const loadContacts = useCallback(async (options?: { preserveError?: boolean }) => {
    if (!options?.preserveError) setError("");
    setContactsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(contactPage), limit: "50",
        view: leadView === "inbox" ? "inbox" : "contacts",
        sort: contactSort, direction: contactDirection,
      });
      if (query.trim()) params.set("query", query.trim());
      if (filterStage) params.set("stage", filterStage);
      if (filterStatus && leadView !== "inbox") params.set("status", filterStatus);
      if (filterOwner) params.set("owner", filterOwner);
      if (filterSource) params.set("source", filterSource);
      if (attentionOnly) params.set("attention", "1");
      const appliedCustomFilters = customFilters.filter(customFilterComplete);
      if (appliedCustomFilters.length) params.set("custom_filters", JSON.stringify(appliedCustomFilters));
      const response = await fetch(`/v1/admin/contacts?${params}`, { credentials: "include" });
      if (response.status === 401) { setNeedsLogin(true); return; }
      const result = await response.json() as ContactPageData & { error?: string };
      if (!response.ok) { setError(result.error || "Contact records could not be loaded."); return; }
      setContactRows(result.contacts);
      setContactPagination(result.pagination);
      setContactFacets(result.facets);
      const hasFilters = Boolean(query.trim() || filterStage || filterStatus || filterOwner || filterSource || attentionOnly || customFilters.length);
      if (!hasFilters && leadView === "inbox") setInboxTotal(result.pagination.total);
      else if (!hasFilters) setAllContactsTotal(result.pagination.total);
    } finally {
      setContactsLoading(false);
    }
  }, [attentionOnly, contactDirection, contactPage, contactSort, customFilters, filterOwner, filterSource, filterStage, filterStatus, leadView, query]);

  const loadContactImports = useCallback(async (options?: { preserveError?: boolean }) => {
    if (!options?.preserveError) setError("");
    setContactImportsLoading(true);
    try {
      const response = await fetch("/v1/admin/contact-imports", { credentials: "include" });
      const result = await response.json().catch(() => ({})) as { imports?: ContactImportBatch[]; error?: string };
      if (!response.ok) {
        setError(result.error || "Contact import history could not be loaded.");
        return;
      }
      setContactImports(result.imports || []);
    } finally {
      setContactImportsLoading(false);
    }
  }, []);

  const refreshContactTotals = useCallback(async () => {
    const [inboxResponse, contactsResponse] = await Promise.all([
      fetch("/v1/admin/contacts?page=1&limit=1&view=inbox", { credentials: "include" }),
      fetch("/v1/admin/contacts?page=1&limit=1&view=contacts", { credentials: "include" }),
    ]);
    if (inboxResponse.ok) {
      const inbox = await inboxResponse.json() as ContactPageData;
      setInboxTotal(inbox.pagination.total);
    }
    if (contactsResponse.ok) {
      const contacts = await contactsResponse.json() as ContactPageData;
      setAllContactsTotal(contacts.pagination.total);
    }
  }, []);

  const loadVisitorIntent = useCallback(async (options?: { preserveError?: boolean }) => {
    if (!options?.preserveError) setError("");
    setVisitorIntentLoading(true);
    try {
      const params = new URLSearchParams({ review_status: visitorReviewFilter });
      if (visitorProviderFilter) params.set("provider", visitorProviderFilter);
      const caseParams = new URLSearchParams({
        status: visitorCaseStatus, page: String(visitorCasePage), limit: "25",
      });
      if (visitorCasePriority) caseParams.set("priority", visitorCasePriority);
      if (visitorCaseOwner) caseParams.set("owner", visitorCaseOwner);
      if (visitorCaseQuery.trim()) caseParams.set("query", visitorCaseQuery.trim());
      const [response, caseResponse] = await Promise.all([
        fetch(`/v1/admin/visitor-intent?${params}`, { credentials: "include" }),
        fetch(`/v1/admin/visitor-intent/cases?${caseParams}`, { credentials: "include" }),
      ]);
      const result = await response.json().catch(() => ({})) as VisitorIntentData & { error?: string };
      const caseResult = await caseResponse.json().catch(() => ({})) as {
        cases?: VisitorIntentCase[]; pagination?: { page: number; pages: number; total: number }; error?: string;
      };
      if (!response.ok || !caseResponse.ok) {
        setError(result.error || caseResult.error || "Visitor intent could not be loaded."); return;
      }
      setVisitorIntent(result);
      setVisitorIntentCases(caseResult.cases ?? []);
      setVisitorCasePagination(caseResult.pagination ?? { page: 1, pages: 1, total: 0 });
    } finally {
      setVisitorIntentLoading(false);
    }
  }, [visitorCaseOwner, visitorCasePage, visitorCasePriority, visitorCaseQuery, visitorCaseStatus,
    visitorProviderFilter, visitorReviewFilter]);

  const loadMailboxes = useCallback(async () => {
    setMailboxesLoading(true); setMailboxesError("");
    try {
      const response = await fetch("/v1/admin/mailbox-connections", { credentials: "include" });
      const result = await response.json().catch(() => ({})) as MailboxConnectionData & { error?: string };
      if (!response.ok) {
        setMailboxesError(result.error || "Mailbox connections could not be loaded."); return;
      }
      setMailboxes(result);
    } catch {
      setMailboxesError("Mailbox connections could not be loaded.");
    } finally {
      setMailboxesLoading(false);
    }
  }, []);

  const loadMailboxConversations = useCallback(async (connection: MailboxConnection) => {
    setMailboxConversationLoading(connection.id);
    setMailboxConversationError((current) => ({ ...current, [connection.id]: "" }));
    try {
      const response = await fetch(
        `/v1/admin/mailbox-connections/${encodeURIComponent(connection.id)}/conversations?limit=10`,
        { credentials: "include" },
      );
      const result = await response.json().catch(() => ({})) as MailboxConversationData & { error?: string };
      if (!response.ok) {
        setMailboxConversationError((current) => ({
          ...current, [connection.id]: result.error || "Conversation metadata could not be loaded.",
        }));
        return;
      }
      setMailboxConversations((current) => ({ ...current, [connection.id]: result }));
    } catch {
      setMailboxConversationError((current) => ({
        ...current, [connection.id]: "Conversation metadata could not be loaded.",
      }));
    } finally {
      setMailboxConversationLoading("");
    }
  }, []);

  const loadResend = useCallback(async () => {
    setResendLoading(true); setResendError("");
    try {
      const response = await fetch("/v1/admin/resend-connection", { credentials: "include" });
      const result = await response.json().catch(() => ({})) as ResendConnectionData & { error?: string };
      if (!response.ok) { setResendError(result.error || "Resend control could not be loaded."); return; }
      setResendData(result);
    } finally { setResendLoading(false); }
  }, []);

  const loadCalendar = useCallback(async () => {
    const range = calendarMonthRange(calendarMonth);
    setCalendarLoading(true); setCalendarError("");
    try {
      const query = new URLSearchParams({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      });
      const response = await fetch(`/v1/admin/calendar?${query}`, { credentials: "include" });
      const result = await response.json().catch(() => ({})) as CalendarData & { error?: string };
      if (!response.ok) {
        setCalendarError(result.error || "Calendar commitments could not be loaded.");
        return;
      }
      setCalendarData(result);
    } catch {
      setCalendarError("Calendar commitments could not be loaded.");
    } finally {
      setCalendarLoading(false);
    }
  }, [calendarMonth]);

  // Initial network synchronization; subsequent refreshes are explicit.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (activeView !== "settings" || settingsView !== "readiness" ||
      (control?.role !== "owner" && control?.role !== "admin")) return;
    // Remote state is loaded only when the readiness surface becomes active.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOperationsHealth();
  }, [activeView, control?.role, control?.workspace.id, loadOperationsHealth, settingsView]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadContacts(); }, 250);
    return () => window.clearTimeout(timer);
  }, [loadContacts]);

  // Keep the active list contract aligned with the readable, active schema after refresh or archival.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const readableKeys = new Set(customFields.filter((field) => field.object_type === "contact" && field.active)
        .map((field) => field.field_key));
      setCustomFilters((current) => {
        const next = current.filter((filter) => readableKeys.has(filter.field_key));
        return next.length === current.length ? current : next;
      });
      setViewColumns((current) => {
        const next = current.filter((column) => !column.startsWith("custom:") || readableKeys.has(column.slice(7)));
        return next.length === current.length ? current : next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [customFields]);

  useEffect(() => {
    if (activeView !== "integrations") return;
    const mailboxTimer = window.setTimeout(() => { void loadMailboxes(); }, 0);
    const resendTimer = window.setTimeout(() => { void loadResend(); }, 0);
    const updateClock = () => setWebhookClock(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => { window.clearTimeout(mailboxTimer); window.clearTimeout(resendTimer); window.clearInterval(timer); };
  }, [activeView, loadMailboxes, loadResend]);

  useEffect(() => {
    if (activeView !== "tasks" || taskView !== "calendar") return;
    const timer = window.setTimeout(() => { void loadCalendar(); }, 0);
    return () => window.clearTimeout(timer);
  }, [activeView, taskView, loadCalendar]);

  useEffect(() => {
    if (!contactImportOpen || (control?.role !== "owner" && control?.role !== "admin")) return;
    const timer = window.setTimeout(() => { void loadContactImports(); }, 0);
    return () => window.clearTimeout(timer);
  }, [contactImportOpen, control?.role, loadContactImports]);

  // A confirmation belongs to one visible proposal context only.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setProposalDecisionArmed(null); }, [activeView, selectedOpportunityId, opportunityDrawerTab]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "integrations") return;
    const timer = window.setTimeout(() => {
      setActiveView("integrations");
      if (params.get("mailbox") === "connected") setNotice("Mailbox connected with read + draft authority. Sending remains blocked.");
    }, 0);
    window.history.replaceState({}, "", window.location.pathname);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (activeView !== "leads" || leadView !== "visitors") return;
    const timer = window.setTimeout(() => { void loadVisitorIntent(); }, 0);
    return () => window.clearTimeout(timer);
  }, [activeView, leadView, loadVisitorIntent]);

  const commandNavigation = useMemo<CommandEntry[]>(() => [
    ...workspaceViews.filter((view) => !view.adminOnly || control?.role === "owner" || control?.role === "admin").map((view) => ({
      id: `nav:${view.id}`,
      kind: "navigation" as const,
      label: view.label,
      description: view.id === "dashboard" ? "Revenue command center" : `Open ${view.label.toLowerCase()} workspace`,
      view: view.id,
    })),
    { id: "nav:contacts", kind: "navigation", label: "All Contacts", description: "Search and manage every person", view: "leads", leadView: "contacts" },
    { id: "nav:companies", kind: "navigation", label: "Companies", description: "Open account intelligence", view: "leads", leadView: "companies" },
    { id: "nav:visitors", kind: "navigation", label: "Visitor Intent", description: "Review identified website visitors outside the lead database", view: "leads", leadView: "visitors" },
  ], [control?.role]);
  const commandEntries = useMemo<CommandEntry[]>(() => {
    const normalized = commandQuery.trim().toLowerCase();
    const navigation = commandNavigation.filter((entry) =>
      !normalized || `${entry.label} ${entry.description}`.toLowerCase().includes(normalized));
    if (!commandSearch || commandSearch.query.toLowerCase() !== normalized) return navigation;
    return [
      ...navigation,
      ...commandSearch.groups.contacts.map((record) => ({
        id: `contact:${record.id}`, kind: "contact" as const,
        label: [record.first_name, record.last_name].filter(Boolean).join(" ") || record.email,
        description: `${record.email}${record.company ? ` · ${record.company}` : ""}`, record,
      })),
      ...commandSearch.groups.companies.map((record) => ({
        id: `company:${record.id}`, kind: "company" as const,
        label: record.name, description: `${record.domain || "No domain"} · ${record.contacts} people`, record,
      })),
      ...commandSearch.groups.opportunities.map((record) => ({
        id: `opportunity:${record.id}`, kind: "opportunity" as const,
        label: record.name, description: `${record.stage_name} · ${record.email} · ${money(record.value)}`, record,
      })),
    ];
  }, [commandNavigation, commandQuery, commandSearch]);
  const safeCommandActiveIndex = Math.min(commandActiveIndex, Math.max(0, commandEntries.length - 1));

  useEffect(() => {
    const onCommandShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (commandOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCommandCenter();
      }
    };
    window.addEventListener("keydown", onCommandShortcut, true);
    return () => window.removeEventListener("keydown", onCommandShortcut, true);
  }, [commandOpen]);

  useEffect(() => {
    if (!commandOpen) return;
    window.requestAnimationFrame(() => commandInputRef.current?.focus());
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = priorOverflow; };
  }, [commandOpen]);

  useEffect(() => {
    if (!commandOpen) return;
    const queryValue = commandQuery.trim();
    if (queryValue.length < 2) {
      const clearTimer = window.setTimeout(() => {
        setCommandSearch(null);
        setCommandLoading(false);
      }, 0);
      return () => window.clearTimeout(clearTimer);
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCommandLoading(true);
      try {
        const response = await fetch(`/v1/admin/search?q=${encodeURIComponent(queryValue)}`, {
          credentials: "include", signal: controller.signal,
        });
        if (!response.ok) {
          setCommandSearch(null);
          return;
        }
        setCommandSearch(await response.json() as CommandSearchData);
      } catch (searchError) {
        if (!(searchError instanceof DOMException && searchError.name === "AbortError")) setCommandSearch(null);
      } finally {
        if (!controller.signal.aborted) setCommandLoading(false);
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [commandOpen, commandQuery]);

  const closeContactWorkspace = useCallback(async () => {
    setDeleteArmed(false);
    setContactNoteEditing(null);
    setContactNoteDeleteArmed("");
    setSelected(null);
    setDetail(null);
    if (!selectedCompanyId) return;
    const response = await fetch(`/v1/admin/companies/${selectedCompanyId}`, { credentials: "include" });
    if (!response.ok) {
      setError("The latest company relationship graph could not be loaded.");
      return;
    }
    setCompanyDetail(await response.json() as CompanyDetail);
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selected || selectedOpportunityId) return;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeContactWorkspace();
      if (event.key === "Tab" && drawerRef.current) {
        const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>("button,a,input,select,textarea")].filter((element) => !element.hasAttribute("disabled"));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected, selectedCompanyId, selectedOpportunityId, closeContactWorkspace]);

  useEffect(() => {
    if (!selectedIntegrationId) return;
    integrationDrawerCloseRef.current?.focus();
    const close = () => {
      setSelectedIntegrationId("");
      window.requestAnimationFrame(() => integrationReturnFocusRef.current?.focus());
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && integrationDrawerRef.current) {
        const focusable = [...integrationDrawerRef.current.querySelectorAll<HTMLElement>("button,a,input,select,textarea")]
          .filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedIntegrationId]);

  useEffect(() => {
    if (!selectedOpportunityId) return;
    opportunityCloseButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeOpportunityWorkspace();
      }
      if (event.key === "Tab" && opportunityDrawerRef.current) {
        const focusable = [...opportunityDrawerRef.current.querySelectorAll<HTMLElement>("button,a,input,select,textarea")]
          .filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedOpportunityId]);

  useEffect(() => {
    if (!selectedCompanyId || selectedOpportunityId || selected) return;
    companyCloseButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedCompanyId("");
        setCompanyDetail(null);
        setCompanyNote("");
      }
      if (event.key === "Tab" && companyDrawerRef.current) {
        const focusable = [...companyDrawerRef.current.querySelectorAll<HTMLElement>("button,a,input,select,textarea")]
          .filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedCompanyId, selectedOpportunityId, selected]);

  useEffect(() => {
    if (!selectedVisitorCase) return;
    visitorCaseCloseButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeVisitorIntentCaseDetail();
      if (event.key === "Tab" && visitorCaseDrawerRef.current) {
        const focusable = [...visitorCaseDrawerRef.current.querySelectorAll<HTMLElement>("button,a,input,select,textarea")]
          .filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedVisitorCase]);

  function moveDrawerTab(event: ReactKeyboardEvent<HTMLButtonElement>, current: ContactDrawerTab) {
    const order: ContactDrawerTab[] = ["overview", "timeline", "related"];
    const currentIndex = order.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % order.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + order.length) % order.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = order.length - 1;
    else return;
    event.preventDefault();
    const next = order[nextIndex];
    setDrawerTab(next);
    window.requestAnimationFrame(() => document.getElementById(`record-tab-${next}`)?.focus());
  }

  function moveOpportunityDrawerTab(event: ReactKeyboardEvent<HTMLButtonElement>, current: OpportunityDrawerTab) {
    const order: OpportunityDrawerTab[] = ["overview", "intelligence", "execution", "agent"];
    const currentIndex = order.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % order.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + order.length) % order.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = order.length - 1;
    else return;
    event.preventDefault();
    const next = order[nextIndex];
    setOpportunityDrawerTab(next);
    window.requestAnimationFrame(() => document.getElementById(`opportunity-tab-${next}`)?.focus());
  }

  function moveIntegrationDomain(event: ReactKeyboardEvent<HTMLButtonElement>, current: IntegrationDomain) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const order = (canAdmin
      ? ["mailboxes", "agents", "sources", "webhooks"]
      : ["mailboxes", "sources", "webhooks"]) as IntegrationDomain[];
    const currentIndex = order.indexOf(current);
    const next = event.key === "Home" ? order[0]
      : event.key === "End" ? order[order.length - 1]
      : event.key === "ArrowRight" ? order[(currentIndex + 1) % order.length]
      : order[(currentIndex - 1 + order.length) % order.length];
    setIntegrationDomain(next);
    window.requestAnimationFrame(() => document.getElementById(`integration-tab-${next}`)?.focus());
  }

  function moveCompanyDrawerTab(event: ReactKeyboardEvent<HTMLButtonElement>, current: CompanyDrawerTab) {
    const order: CompanyDrawerTab[] = ["overview", "relationships", "timeline"];
    const currentIndex = order.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % order.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + order.length) % order.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = order.length - 1;
    else return;
    event.preventDefault();
    const next = order[nextIndex];
    setCompanyDrawerTab(next);
    window.requestAnimationFrame(() => document.getElementById(`company-tab-${next}`)?.focus());
  }

  function closeOpportunityWorkspace() {
    opportunityIntelligenceAbortRef.current?.abort();
    opportunityIntelligenceAbortRef.current = null;
    setSelectedOpportunityId("");
    setPendingTerminalMove(null);
    setOpportunityDraft(null);
    setOpportunityIntelligenceLoading(false);
  }

  async function openOpportunityWorkspace(opportunity: Opportunity) {
    opportunityIntelligenceAbortRef.current?.abort();
    const controller = new AbortController();
    opportunityIntelligenceAbortRef.current = controller;
    setError("");
    setNotice("");
    setPendingTerminalMove(null);
    setOpportunityDraft(null);
    setOpportunityDeleteArmed("");
    setOpportunityDrawerTab("overview");
    setOpportunityIntelligence(null);
    setOpportunityIntelligenceLoading(true);
    setSelectedOpportunityId(opportunity.id);
    setOpportunityCustomDraft(contactCustomValues(opportunity.custom_fields));
    setTaskContactId(opportunity.contact_id);
    setTaskOpportunityId(opportunity.id);
    try {
      const response = await fetch(`/v1/admin/opportunities/${opportunity.id}/intelligence`, {
        credentials: "include", signal: controller.signal,
      });
      if (opportunityIntelligenceAbortRef.current !== controller) return;
      if (response.ok) setOpportunityIntelligence(await response.json() as OpportunityIntelligence);
      else setError("Opportunity intelligence could not be loaded.");
    } catch (fetchError) {
      if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) {
        setError("Opportunity intelligence could not be loaded.");
      }
    } finally {
      if (opportunityIntelligenceAbortRef.current === controller) {
        opportunityIntelligenceAbortRef.current = null;
        setOpportunityIntelligenceLoading(false);
      }
    }
  }

  async function openContact(contact: Contact, preserveCompany = Boolean(selectedCompanyId)) {
    setDeleteArmed(false);
    setContactNoteEditing(null);
    setContactNoteDeleteArmed("");
    setError("");
    if (!preserveCompany) {
      setSelectedCompanyId("");
      setCompanyDetail(null);
    }
    setDrawerTab("overview");
    setContactOwnerDraft(contact.owner || "");
    setSelected(contact);
    setDetail(null);
    const response = await fetch(`/v1/admin/contacts/${contact.id}`, { credentials: "include" });
    if (response.ok) {
      const nextDetail = await response.json() as ContactDetail;
      setDetail(nextDetail);
      setContactCustomDraft(contactCustomValues(nextDetail.contact.custom_fields));
    }
    else setError("The contact record could not be loaded.");
  }

  async function openCompanyTimelineContact(contactId: string) {
    const contact = companyDetail?.contacts.find((item) => item.id === contactId);
    if (!contact || !selectedCompany) {
      setError("The linked contact is no longer available in this company.");
      return;
    }
    await openContact({
      ...contact,
      company: selectedCompany.name,
      source_last: null,
      revenue: 0,
    }, true);
  }

  async function openContactById(contactId: string, destination: WorkspaceView = "leads") {
    setError("");
    const response = await fetch(`/v1/admin/contacts/${contactId}`, { credentials: "include" });
    if (!response.ok) {
      setError("The contact record could not be loaded.");
      return;
    }
    const nextDetail = await response.json() as ContactDetail;
    setActiveView(destination);
    if (destination === "leads") setLeadView("contacts");
    setDeleteArmed(false);
    setContactNoteEditing(null);
    setContactNoteDeleteArmed("");
    setSelectedCompanyId("");
    setCompanyDetail(null);
    setDrawerTab("overview");
    setContactOwnerDraft(nextDetail.contact.owner || "");
    setSelected(nextDetail.contact);
    setDetail(nextDetail);
    setContactCustomDraft(contactCustomValues(nextDetail.contact.custom_fields));
  }

  async function openBriefingTask(task: Task) {
    const opportunity = task.opportunity_id
      ? control?.opportunities.find((item) => item.id === task.opportunity_id) : null;
    if (opportunity) {
      setActiveView("pipeline");
      setActivePipelineId(opportunity.pipeline_id);
      await openOpportunityWorkspace(opportunity);
      return;
    }
    if (task.contact_id) {
      await openContactById(task.contact_id);
      return;
    }
    setActiveView("tasks");
    setTaskView("list");
  }

  async function openProposalRecord(proposal: AgentProposal) {
    setError("");
    setNotice("");
    if (proposal.opportunity_id) {
      const opportunity = control?.opportunities.find((item) => item.id === proposal.opportunity_id);
      if (opportunity) {
        await openOpportunityWorkspace(opportunity);
        return;
      }
    }
    if (proposal.contact_id) {
      await openContactById(proposal.contact_id, "agent");
      return;
    }
    if (proposal.category === "visitor_promotion") {
      setActiveView("leads");
      setLeadView("visitors");
      return;
    }
    setError("The proposal source record is no longer available.");
  }

  async function openAgentWorkRecord(item: AgentWorkItem) {
    setError("");
    setNotice("");
    if (item.opportunity_id) {
      const opportunity = control?.opportunities.find((candidate) => candidate.id === item.opportunity_id);
      if (opportunity) {
        await openOpportunityWorkspace(opportunity);
        return;
      }
    }
    if (item.contact_id) {
      await openContactById(item.contact_id, "automations");
      return;
    }
    setError("The agent work source record is no longer available.");
  }

  async function openCompany(company: Company) {
    setError("");
    setNotice("");
    setSelected(null);
    closeOpportunityWorkspace();
    setSelectedCompanyId(company.id);
    setCompanyDrawerTab("overview");
    setCompanyDetail(null);
    setCompanyNote("");
    setCompanyMergeTargetId("");
    setCompanyMergeArmed(false);
    setCompanyMergePreview(null);
    setCompanyNoteEditing(null);
    setCompanyNoteDeleteArmed("");
    setCompanyDraft({
      name: company.name,
      domain: company.domain || "", website: company.website || "",
      industry: company.industry || "", owner: company.owner || "",
    });
    const response = await fetch(`/v1/admin/companies/${company.id}`, { credentials: "include" });
    if (!response.ok) { setError("The company relationship workspace could not be loaded."); return; }
    const next = await response.json() as CompanyDetail;
    setCompanyDetail(next);
    setCompanyCustomDraft(contactCustomValues(next.company.custom_fields));
    setCompanyDraft({
      name: next.company.name,
      domain: next.company.domain || "", website: next.company.website || "",
      industry: next.company.industry || "", owner: next.company.owner || "",
    });
  }

  function closeCommandCenter(restoreTriggerFocus = true) {
    setCommandOpen(false);
    setCommandQuery("");
    setCommandSearch(null);
    setCommandLoading(false);
    setCommandActiveIndex(0);
    if (restoreTriggerFocus) window.requestAnimationFrame(() => commandTriggerRef.current?.focus());
  }

  function runCommand(entry: CommandEntry) {
    closeCommandCenter(entry.kind === "navigation");
    setError("");
    setNotice("");
    if (entry.kind === "navigation") {
      setActiveView(entry.view);
      if (entry.leadView) {
        setLeadView(entry.leadView);
        setContactPage(1);
        setSelectedIds([]);
      }
      if (entry.view === "agent") void load();
      return;
    }
    if (entry.kind === "contact") {
      setActiveView("leads");
      setLeadView("contacts");
      void openContact(entry.record);
      return;
    }
    if (entry.kind === "company") {
      setActiveView("leads");
      setLeadView("companies");
      void openCompany(entry.record);
      return;
    }
    setActiveView("pipeline");
    setActivePipelineId(entry.record.pipeline_id);
    void openOpportunityWorkspace(entry.record);
  }

  function handleCommandKeys(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCommandActiveIndex((index) => commandEntries.length ? (index + 1) % commandEntries.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCommandActiveIndex((index) => commandEntries.length ? (index - 1 + commandEntries.length) % commandEntries.length : 0);
    } else if (event.key === "Home") {
      event.preventDefault();
      setCommandActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setCommandActiveIndex(Math.max(0, commandEntries.length - 1));
    } else if (event.key === "Enter" && commandEntries[safeCommandActiveIndex]) {
      event.preventDefault();
      runCommand(commandEntries[safeCommandActiveIndex]);
    }
  }

  function trapCommandFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab" || !commandCenterRef.current) return;
    const focusable = [...commandCenterRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function updateCompany() {
    if (!companyDetail || mutating) return;
    setMutating(`company:${companyDetail.company.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/companies/${companyDetail.company.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          name: companyDraft.name,
          domain: companyDraft.domain || null, website: companyDraft.website || null,
          industry: companyDraft.industry || null, owner: companyDraft.owner || null,
          custom_fields: Object.fromEntries(customFields.filter((field) => field.object_type === "company" && field.active)
            .map((field) => [field.field_key, companyCustomDraft[field.field_key] ?? null])),
          if_updated_at: companyDetail.company.updated_at,
        }),
      });
      const result = await response.json() as { company?: CompanyDetail["company"]; error?: string };
      if (response.status === 409) {
        const selectedCompany = control?.companies.find((item) => item.id === companyDetail.company.id);
        if (selectedCompany) await openCompany(selectedCompany);
        setError("This company changed in another session. The latest account context has been reloaded.");
        return;
      }
      if (!response.ok || !result.company) { setError(result.error || "The company details could not be saved."); return; }
      setCompanyDetail((current) => current ? { ...current, company: { ...current.company, ...result.company } } : current);
      await load();
      setNotice("Company context updated.");
    } finally { setMutating(""); }
  }

  async function addCompanyNote(event: FormEvent) {
    event.preventDefault();
    if (!companyDetail || !companyNote.trim() || mutating) return;
    setMutating(`company-note:${companyDetail.company.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/companies/${companyDetail.company.id}/notes`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ body: companyNote }),
      });
      if (!response.ok) { setError("The company note could not be saved."); return; }
      setCompanyNote("");
      const selectedCompany = control?.companies.find((item) => item.id === companyDetail.company.id);
      if (selectedCompany) await openCompany(selectedCompany);
      setCompanyDrawerTab("timeline");
      setNotice("Company note added.");
    } finally { setMutating(""); }
  }

  async function refreshCompanyDetail(companyId: string) {
    const response = await fetch(`/v1/admin/companies/${companyId}`, { credentials: "include" });
    if (!response.ok) { setError("The latest company relationship graph could not be loaded."); return null; }
    const next = await response.json() as CompanyDetail;
    setCompanyDetail(next);
    setCompanyDraft({
      name: next.company.name, domain: next.company.domain || "", website: next.company.website || "",
      industry: next.company.industry || "", owner: next.company.owner || "",
    });
    return next;
  }

  async function mergeCompany() {
    if (!companyDetail || !companyMergeTargetId || !companyMergeArmed || !companyMergePreview || mutating) return;
    const target = control?.companies.find((item) => item.id === companyMergeTargetId);
    if (!target) { setError("Choose a current target company."); return; }
    setMutating(`company-merge:${companyDetail.company.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/companies/${companyDetail.company.id}/merge`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          target_company_id: target.id,
          source_if_updated_at: companyMergePreview.source_if_updated_at,
          target_if_updated_at: companyMergePreview.target_if_updated_at,
          review_token: companyMergePreview.review_token,
        }),
      });
      const result = await response.json() as { error?: string; merge?: { contacts_moved: number; notes_moved: number } };
      if (!response.ok) {
        if (response.status === 409) await Promise.all([load(), refreshCompanyDetail(companyDetail.company.id)]);
        setError(result.error || "The companies could not be merged.");
        setCompanyMergeArmed(false);
        setCompanyMergePreview(null);
        return;
      }
      await load();
      setSelectedCompanyId(target.id);
      await refreshCompanyDetail(target.id);
      setCompanyMergeTargetId("");
      setCompanyMergeArmed(false);
      setCompanyMergePreview(null);
      setCompanyDrawerTab("relationships");
      setNotice(`Companies merged. ${result.merge?.contacts_moved || 0} people and ${result.merge?.notes_moved || 0} notes moved.`);
    } finally { setMutating(""); }
  }

  async function reviewCompanyMerge(sourceId = companyDetail?.company.id, targetId = companyMergeTargetId) {
    if (!sourceId || !targetId || mutating) return;
    setMutating(`company-merge-review:${sourceId}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/companies/${sourceId}/merge-preview`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ target_company_id: targetId }),
      });
      const result = await response.json() as CompanyMergePreview & { error?: string };
      if (!response.ok) { setError(result.error || "The merge impact could not be reviewed."); return; }
      setCompanyMergeTargetId(targetId);
      setCompanyMergePreview(result);
      setCompanyMergeArmed(true);
    } finally { setMutating(""); }
  }

  async function scanCompanyDuplicates() {
    if (mutating) return;
    setMutating("company-duplicate-scan"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/companies/duplicates", { credentials: "include" });
      const result = await response.json() as {
        candidates?: CompanyDuplicateCandidate[]; scanned_companies?: number; candidate_count?: number; truncated?: boolean; error?: string;
      };
      if (!response.ok) { setError(result.error || "Duplicate companies could not be scanned."); return; }
      setCompanyDuplicates(result.candidates || []);
      setCompanyDuplicateMeta({ scanned: result.scanned_companies || 0, total: result.candidate_count || 0, truncated: Boolean(result.truncated) });
    } finally { setMutating(""); }
  }

  async function openDuplicateReview(candidate: CompanyDuplicateCandidate) {
    const source = control?.companies.find((item) => item.id === candidate.source.id);
    if (!source) { setError("The suggested source company is no longer available."); return; }
    await openCompany(source);
    await reviewCompanyMerge(candidate.source.id, candidate.target.id);
  }

  async function updateCompanyNote(note: CompanyNote) {
    if (!companyNoteEditing || companyNoteEditing.id !== note.id || !companyNoteEditing.body.trim() || mutating) return;
    setMutating(`company-note-edit:${note.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/company-notes/${note.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ body: companyNoteEditing.body, if_updated_at: note.updated_at || note.created_at }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        if (response.status === 409 && companyDetail) await refreshCompanyDetail(companyDetail.company.id);
        setError(result.error || "The company note could not be updated.");
        return;
      }
      if (companyDetail) await refreshCompanyDetail(companyDetail.company.id);
      setCompanyNoteEditing(null);
      setNotice("Company note updated.");
    } finally { setMutating(""); }
  }

  async function deleteCompanyNote(note: CompanyNote) {
    if (companyNoteDeleteArmed !== note.id || mutating) { setCompanyNoteDeleteArmed(note.id); return; }
    setMutating(`company-note-delete:${note.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/company-notes/${note.id}`, {
        method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ if_updated_at: note.updated_at || note.created_at }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        if (response.status === 409 && companyDetail) await refreshCompanyDetail(companyDetail.company.id);
        setError(result.error || "The company note could not be deleted.");
        setCompanyNoteDeleteArmed("");
        return;
      }
      if (companyDetail) await refreshCompanyDetail(companyDetail.company.id);
      setCompanyNoteDeleteArmed("");
      setCompanyNoteEditing((current) => current?.id === note.id ? null : current);
      setNotice("Company note deleted.");
    } finally { setMutating(""); }
  }

  async function updateContact(contact: Contact, updates: Record<string, unknown>) {
    if (mutating) return;
    setMutating(`contact:${contact.id}`); setError(""); setNotice("");
    try {
    const response = await fetch(`/v1/admin/contacts/${contact.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...updates, if_updated_at: detail?.contact.updated_at || contact.updated_at }), credentials: "include",
    });
    if (response.ok) {
      const result = await response.json() as { updated_at: string; custom_fields?: string };
      const nextContact = {
        ...(detail?.contact || contact), ...updates,
        custom_fields: result.custom_fields || detail?.contact.custom_fields || contact.custom_fields,
        updated_at: result.updated_at,
      } as Contact;
      setDetail((current) => current ? { ...current, contact: nextContact } : current);
      setSelected(nextContact);
      await Promise.all([load(), loadContacts()]);
      if (taskView === "calendar" && Object.hasOwn(updates, "next_follow_up_at")) await loadCalendar();
      await refreshContactTotals();
      setData((current) => current ? {
        ...current,
        contacts: current.contacts.map((item) => item.id === contact.id ? { ...item, ...updates, updated_at: result.updated_at } as Contact : item),
      } : current);
      setContactRows((current) => current.map((item) => item.id === contact.id
        ? { ...item, ...updates, updated_at: result.updated_at } as Contact : item));
      if (Object.hasOwn(updates, "owner")) setContactOwnerDraft(String(updates.owner || ""));
      setNotice("Contact updated.");
    } else if (response.status === 409) {
      setError("This contact changed in another session. The latest record has been loaded; review it before saving again.");
      await load({ preserveError: true });
      const latest = await fetch(`/v1/admin/contacts/${contact.id}`, { credentials: "include" });
      if (latest.ok) {
        const latestDetail = await latest.json() as ContactDetail;
        setDetail(latestDetail);
        setSelected(latestDetail.contact);
        setContactOwnerDraft(latestDetail.contact.owner || "");
        setContactCustomDraft(contactCustomValues(latestDetail.contact.custom_fields));
      }
    }
    else setError("The contact update did not save.");
    } finally { setMutating(""); }
  }

  async function createCustomField(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setMutating("custom-field-create"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/custom-fields", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          object_type: customFieldObject,
          label: customFieldDraft.label.trim(), field_key: customFieldDraft.fieldKey.trim(),
          field_type: customFieldDraft.fieldType, required: customFieldDraft.required,
          options: customFieldDraft.fieldType === "select"
            ? customFieldDraft.options.split("\n").map((option) => option.trim()).filter(Boolean) : [],
        }),
      });
      const result = await response.json() as { error?: string; definition?: CustomFieldDefinition };
      if (!response.ok || !result.definition) { setError(result.error || "The custom field could not be created."); return; }
      setCustomFields((current) => [...current, result.definition!].sort((a, b) => a.position - b.position));
      setCustomFieldDraft({ label: "", fieldKey: "", fieldType: "text", options: "", required: false });
      await load();
      setNotice(`${customFieldObject} field created and placed in Unplaced fields.`);
    } finally { setMutating(""); }
  }

  async function archiveCustomField(definition: CustomFieldDefinition) {
    if (mutating) return;
    setMutating(`custom-field:${definition.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-fields/${definition.id}`, {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false, if_revision: definition.revision }),
      });
      const result = await response.json() as { error?: string; definition?: CustomFieldDefinition };
      if (!response.ok || !result.definition) { setError(result.error || "The field could not be archived."); return; }
      setCustomFields((current) => current.map((field) => field.id === definition.id ? result.definition! : field));
      await load();
      setNotice("Field archived. Existing values remain preserved.");
    } finally { setMutating(""); }
  }

  async function loadCustomObjectRecords(objectId = selectedCustomObjectId, viewId = activeCustomObjectViewId) {
    if (!objectId) { setCustomObjectRecords([]); return; }
    setCustomObjectRecordsLoading(true);
    try {
      const response = await fetch(`/v1/admin/custom-objects/${objectId}/records?limit=100${viewId
        ? `&view_id=${encodeURIComponent(viewId)}` : ""}`, { credentials: "include" });
      const result = await response.json().catch(() => ({})) as { records?: CustomObjectRecord[]; error?: string };
      if (!response.ok) { setError(result.error || "Custom-object records could not be loaded."); return; }
      setCustomObjectRecords(result.records || []);
    } finally { setCustomObjectRecordsLoading(false); }
  }

  async function loadCustomObjectViews(objectId = selectedCustomObjectId) {
    if (!objectId) { setCustomObjectViews([]); return; }
    const response = await fetch(`/v1/admin/custom-objects/${objectId}/views`, { credentials: "include" });
    const result = await response.json().catch(() => ({})) as { views?: CustomObjectView[]; error?: string };
    if (!response.ok) { setError(result.error || "Custom-object views could not be loaded."); return; }
    const views = result.views || [];
    setCustomObjectViews(views);
    setActiveCustomObjectViewId((current) => views.some((view) => view.id === current) ? current : "");
  }

  function resetCustomObjectViewDraft(definition = selectedCustomObject) {
    setEditingCustomObjectViewId("");
    setCustomObjectViewDraft({
      name: "", visibility: "private", filters: [],
      visible_fields: ["display_name", ...(definition?.fields.slice(0, 4).map((field) => field.key) || [])],
      sort_field: "display_name", sort_direction: "asc",
    });
  }

  async function saveCustomObjectView(event: FormEvent) {
    event.preventDefault();
    if (!selectedCustomObject || mutating) return;
    const editing = customObjectViews.find((view) => view.id === editingCustomObjectViewId);
    setMutating("custom-object-view"); setError(""); setNotice("");
    try {
      const response = await fetch(editing
        ? `/v1/admin/custom-object-views/${editing.id}`
        : `/v1/admin/custom-objects/${selectedCustomObject.id}/views`, {
        method: editing ? "PATCH" : "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...customObjectViewDraft, ...(editing ? { if_revision: editing.revision } : {}) }),
      });
      const result = await response.json().catch(() => ({})) as { view?: CustomObjectView; error?: string };
      if (!response.ok || !result.view) {
        setError(result.error || "Custom-object view could not be saved.");
        if (response.status === 409) await loadCustomObjectViews();
        return;
      }
      setCustomObjectViews((current) => editing
        ? current.map((view) => view.id === result.view!.id ? result.view! : view)
        : [result.view!, ...current]);
      setActiveCustomObjectViewId(result.view.id);
      setCustomObjectViewBuilderOpen(false);
      resetCustomObjectViewDraft();
      await loadCustomObjectRecords(selectedCustomObject.id, result.view.id);
      setNotice(editing ? "Working view updated." : "Working view saved.");
    } finally { setMutating(""); }
  }

  function editCustomObjectView(view: CustomObjectView) {
    setEditingCustomObjectViewId(view.id);
    setCustomObjectViewDraft({
      name: view.name, visibility: view.visibility, filters: view.filters.map((filter) => ({ ...filter })),
      visible_fields: [...view.visible_fields], sort_field: view.sort_field, sort_direction: view.sort_direction,
    });
    setCustomObjectViewBuilderOpen(true);
  }

  async function deleteCustomObjectView(view: CustomObjectView) {
    if (customObjectViewDeleteArmed !== view.id) { setCustomObjectViewDeleteArmed(view.id); return; }
    if (mutating) return;
    setMutating(`custom-object-view-delete:${view.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-object-views/${view.id}?expected_revision=${view.revision}`, {
        method: "DELETE", credentials: "include",
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(result.error || "Custom-object view could not be deleted.");
        if (response.status === 409) await loadCustomObjectViews();
        return;
      }
      setCustomObjectViews((current) => current.filter((candidate) => candidate.id !== view.id));
      if (activeCustomObjectViewId === view.id) {
        setActiveCustomObjectViewId("");
        await loadCustomObjectRecords(selectedCustomObjectId, "");
      }
      setCustomObjectViewDeleteArmed(""); setNotice("Working view deleted.");
    } finally { setMutating(""); }
  }

  async function createCustomObject(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setMutating("custom-object-create"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/custom-objects", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: customObjectDraft.slug, singular_label: customObjectDraft.singular,
          plural_label: customObjectDraft.plural, description: customObjectDraft.description || null,
          fields: [{ key: customObjectDraft.fieldKey, label: customObjectDraft.fieldLabel,
            type: customObjectDraft.fieldType, required: false, options: [] }],
        }),
      });
      const result = await response.json() as { definition?: CustomObjectDefinition; error?: string };
      if (!response.ok || !result.definition) { setError(result.error || "Custom object could not be created."); return; }
      setCustomObjects((current) => [...current, result.definition!]);
      setSelectedCustomObjectId(result.definition.id);
      setCustomObjectRecords([]);
      setCustomObjectDraft({ singular: "", plural: "", slug: "", description: "",
        fieldLabel: "", fieldKey: "", fieldType: "text" });
      setNotice(`${result.definition.singular_label} object created.`);
    } finally { setMutating(""); }
  }

  async function addCustomObjectField(event: FormEvent) {
    event.preventDefault();
    const definition = customObjects.find((item) => item.id === selectedCustomObjectId);
    if (!definition || mutating) return;
    setMutating(`custom-object-field:${definition.id}`); setError(""); setNotice("");
    try {
      const nextField: CustomObjectField = {
        key: customObjectFieldDraft.key.trim(), label: customObjectFieldDraft.label.trim(),
        type: customObjectFieldDraft.type, required: false,
        options: customObjectFieldDraft.type === "select"
          ? customObjectFieldDraft.options.split("\n").map((option) => option.trim()).filter(Boolean) : [],
      };
      const response = await fetch(`/v1/admin/custom-objects/${definition.id}`, {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ if_revision: definition.revision, fields: [...definition.fields, nextField] }),
      });
      const result = await response.json() as { definition?: CustomObjectDefinition; error?: string };
      if (!response.ok || !result.definition) {
        setError(result.error || "Field could not be added.");
        if (response.status === 409) await load();
        return;
      }
      setCustomObjects((current) => current.map((item) => item.id === definition.id
        ? { ...item, ...result.definition!, record_count: item.record_count } : item));
      setCustomObjectFieldDraft({ label: "", key: "", type: "text", required: false, options: "" });
      setNotice("Optional field added without changing existing records.");
    } finally { setMutating(""); }
  }

  function customObjectInputValue(field: CustomObjectField, value: string) {
    if (value === "") return "";
    if (field.type === "number") return value === "" ? "" : Number(value);
    if (field.type === "boolean") return value === "true";
    return value;
  }

  async function createCustomObjectRecord(event: FormEvent) {
    event.preventDefault();
    const definition = customObjects.find((item) => item.id === selectedCustomObjectId);
    if (!definition || mutating) return;
    setMutating(`custom-object-record:${definition.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-objects/${definition.id}/records`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: customObjectRecordName, data: customObjectRecordDraft }),
      });
      const result = await response.json() as { record?: CustomObjectRecord; error?: string };
      if (!response.ok || !result.record) { setError(result.error || "Record could not be created."); return; }
      if (activeCustomObjectViewId) await loadCustomObjectRecords(definition.id, activeCustomObjectViewId);
      else setCustomObjectRecords((current) => [result.record!, ...current]);
      setCustomObjects((current) => current.map((item) => item.id === definition.id
        ? { ...item, record_count: item.record_count + 1 } : item));
      setCustomObjectRecordName(""); setCustomObjectRecordDraft({});
      setNotice(`${definition.singular_label} record created.`);
    } finally { setMutating(""); }
  }

  async function saveCustomObjectRecord(record: CustomObjectRecord) {
    if (!customObjectEditing || customObjectEditing.id !== record.id || mutating) return;
    setMutating(`custom-object-edit:${record.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-object-records/${record.id}`, {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          if_revision: record.revision, display_name: customObjectEditing.display_name,
          data: customObjectEditing.data,
        }),
      });
      const result = await response.json() as { record?: Partial<CustomObjectRecord>; error?: string };
      if (!response.ok || !result.record) {
        setError(result.error || "Record could not be updated.");
        if (response.status === 409) { setCustomObjectEditing(null); await loadCustomObjectRecords(); }
        return;
      }
      setCustomObjectRecords((current) => current.map((item) => item.id === record.id
        ? { ...item, ...result.record!, data: customObjectEditing.data } : item));
      setCustomObjectEditing(null);
      if (activeCustomObjectViewId) await loadCustomObjectRecords(selectedCustomObjectId, activeCustomObjectViewId);
      setNotice("Custom-object record updated.");
    } finally { setMutating(""); }
  }

  async function toggleCustomObjectArchive(definition: CustomObjectDefinition) {
    if (customObjectArchiveArmed !== definition.id) { setCustomObjectArchiveArmed(definition.id); return; }
    if (mutating) return;
    setMutating(`custom-object-archive:${definition.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-objects/${definition.id}`, {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ if_revision: definition.revision, active: !definition.active }),
      });
      const result = await response.json() as { definition?: CustomObjectDefinition; error?: string };
      if (!response.ok || !result.definition) {
        setError(result.error || "Custom object lifecycle could not be changed.");
        if (response.status === 409) await load();
        return;
      }
      setCustomObjects((current) => current.map((item) => item.id === definition.id
        ? { ...item, ...result.definition!, record_count: item.record_count } : item));
      setCustomObjectArchiveArmed("");
      setNotice(definition.active ? "Custom object archived. Records remain recoverable and read-only."
        : "Custom object restored.");
    } finally { setMutating(""); }
  }

  async function deleteCustomObjectRecord(record: CustomObjectRecord) {
    if (customObjectDeleteArmed !== record.id) { setCustomObjectDeleteArmed(record.id); return; }
    if (mutating) return;
    setMutating(`custom-object-delete:${record.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-object-records/${record.id}?expected_revision=${record.revision}`, {
        method: "DELETE", credentials: "include",
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(result.error || "Record could not be deleted.");
        if (response.status === 409) await loadCustomObjectRecords();
        return;
      }
      setCustomObjectRecords((current) => current.filter((item) => item.id !== record.id));
      setCustomObjects((current) => current.map((item) => item.id === record.object_id
        ? { ...item, record_count: Math.max(0, item.record_count - 1) } : item));
      setCustomObjectDeleteArmed(""); setNotice("Custom-object record and its outgoing relations were deleted.");
    } finally { setMutating(""); }
  }

  async function addCustomObjectRelation(event: FormEvent, record: CustomObjectRecord) {
    event.preventDefault();
    const draft = customRelationDraft[record.id];
    if (!draft || mutating) return;
    setMutating(`custom-relation:${record.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-object-records/${record.id}/relations`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json() as { relation?: CustomObjectRelation; error?: string };
      if (!response.ok || !result.relation) { setError(result.error || "Relation could not be created."); return; }
      const selectedTarget = (customRelationTargets[record.id] || []).find((target) => target.id === draft.target_id);
      const createdRelation = { ...result.relation,
        target_label: selectedTarget?.label || null, target_detail: selectedTarget?.detail || null };
      setCustomObjectRecords((current) => current.map((item) => item.id === record.id
        ? { ...item, relations: [...item.relations, createdRelation], relation_count: item.relation_count + 1 } : item));
      setCustomRelationDraft((current) => ({ ...current,
        [record.id]: { target_type: "contact", target_id: "", label: "" } }));
      setCustomRelationQuery((current) => ({ ...current, [record.id]: "" }));
      setCustomRelationTargets((current) => ({ ...current, [record.id]: [] }));
      setNotice("Relationship created.");
    } finally { setMutating(""); }
  }

  async function findCustomRelationTargets(record: CustomObjectRecord) {
    const draft = customRelationDraft[record.id] || { target_type: "contact" as const, target_id: "", label: "" };
    const query = (customRelationQuery[record.id] || "").trim();
    if (query.length < 2 || customRelationSearching) return;
    setCustomRelationSearching(record.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-relation-targets?type=${encodeURIComponent(draft.target_type)}&query=${encodeURIComponent(query)}`, {
        credentials: "include",
      });
      const result = await response.json().catch(() => ({})) as {
        targets?: Array<{ id: string; label: string; detail: string }>; truncated?: boolean; error?: string;
      };
      if (!response.ok) { setError(result.error || "Relationship targets could not be searched."); return; }
      const targets = result.targets || [];
      setCustomRelationTargets((current) => ({ ...current, [record.id]: targets }));
      setCustomRelationDraft((current) => ({ ...current, [record.id]: {
        ...draft, target_id: targets.some((target) => target.id === draft.target_id) ? draft.target_id : "",
      } }));
      setNotice(targets.length
        ? `${targets.length} matching target${targets.length === 1 ? "" : "s"} found${result.truncated ? "; refine the search for more." : "."}`
        : "No matching relationship targets found.");
    } finally { setCustomRelationSearching(""); }
  }

  async function removeCustomObjectRelation(relation: CustomObjectRelation, record: CustomObjectRecord) {
    if (mutating) return;
    setMutating(`custom-relation-delete:${relation.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/custom-object-relations/${relation.id}`, {
        method: "DELETE", credentials: "include",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setError(result.error || "Relation could not be removed."); return;
      }
      setCustomObjectRecords((current) => current.map((item) => item.id === record.id
        ? { ...item, relations: item.relations.filter((candidate) => candidate.id !== relation.id),
          relation_count: Math.max(0, item.relation_count - 1) } : item));
      setNotice("Relationship removed.");
    } finally { setMutating(""); }
  }

  useEffect(() => {
    if (activeView === "settings" && settingsView === "objects" && selectedCustomObjectId) {
      // Changing object scope requires both records and saved views to refresh together.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void Promise.all([loadCustomObjectRecords(selectedCustomObjectId, ""), loadCustomObjectViews(selectedCustomObjectId)]);
    }
    // Record refresh is intentionally keyed to the selected object/workspace surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, selectedCustomObjectId, settingsView]);

  async function saveContactCustomFields() {
    if (!selected || mutating) return;
    await updateContact(selected, { custom_fields: Object.fromEntries(customFields.filter((field) => field.object_type === "contact" && field.active)
      .map((field) => [field.field_key, contactCustomDraft[field.field_key] ?? null])) });
  }

  function updatePageLayout(objectType: CustomFieldDefinition["object_type"], update: (layout: ObjectPageLayout) => ObjectPageLayout) {
    setPageLayouts((current) => current.map((layout) => layout.object_type === objectType ? update(layout) : layout));
  }

  function moveLayoutField(objectType: CustomFieldDefinition["object_type"], fieldKey: string, direction: -1 | 1) {
    updatePageLayout(objectType, (layout) => {
      const sections = layout.sections.map((section) => ({ ...section, fields: [...section.fields] }));
      const flat = sections.flatMap((section, sectionIndex) => section.fields.map((key, fieldIndex) => ({ key, sectionIndex, fieldIndex })));
      const currentIndex = flat.findIndex((item) => item.key === fieldKey);
      const target = flat[currentIndex + direction];
      const source = flat[currentIndex];
      if (!source || !target) return layout;
      sections[source.sectionIndex].fields.splice(source.fieldIndex, 1);
      const adjustedTargetIndex = source.sectionIndex === target.sectionIndex
        ? target.fieldIndex
        : target.fieldIndex + (direction === 1 ? 1 : 0);
      sections[target.sectionIndex].fields.splice(adjustedTargetIndex, 0, fieldKey);
      return { ...layout, sections };
    });
  }

  function moveLayoutFieldToSection(objectType: CustomFieldDefinition["object_type"], fieldKey: string, targetSectionId: string) {
    updatePageLayout(objectType, (layout) => {
      const sections = layout.sections.map((section) => ({ ...section, fields: section.fields.filter((key) => key !== fieldKey) }));
      const target = sections.find((section) => section.id === targetSectionId);
      if (target) target.fields.push(fieldKey);
      return { ...layout, sections };
    });
  }

  async function savePageLayout(objectType: CustomFieldDefinition["object_type"]) {
    const layout = pageLayouts.find((item) => item.object_type === objectType);
    if (!layout || mutating) return;
    setMutating(`page-layout:${objectType}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/page-layouts/${objectType}`, {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: layout.revision, name: layout.name, sections: layout.sections }),
      });
      const result = await response.json() as { error?: string; layout?: ObjectPageLayout };
      if (!response.ok || !result.layout) {
        setError(result.error || "The page layout could not be saved.");
        if (response.status === 409) await load({ preserveError: true });
        return;
      }
      setPageLayouts((current) => current.map((item) => item.object_type === objectType ? result.layout! : item));
      setNotice(`${objectType} layout saved.`);
    } finally { setMutating(""); }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!selected || !note.trim() || mutating) return;
    setMutating("contact-note-create"); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/contacts/${selected.id}/notes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: note }), credentials: "include",
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        setError(result.error || "The contact note could not be saved.");
        return;
      }
      setNote("");
      await openContact(selected);
      setDrawerTab("timeline");
      setNotice("Contact note saved.");
    } finally { setMutating(""); }
  }

  async function updateContactNote(contactNote: Note) {
    if (!selected || !contactNoteEditing || contactNoteEditing.id !== contactNote.id ||
      !contactNoteEditing.body.trim() || mutating) return;
    setMutating(`contact-note-edit:${contactNote.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/notes/${contactNote.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          body: contactNoteEditing.body,
          if_updated_at: contactNote.updated_at || contactNote.created_at,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        if (response.status === 409) {
          await openContact(selected);
          setDrawerTab("timeline");
        }
        setError(result.error || "The contact note could not be updated.");
        return;
      }
      await openContact(selected);
      setDrawerTab("timeline");
      setContactNoteEditing(null);
      setNotice("Contact note updated.");
    } finally { setMutating(""); }
  }

  async function deleteContactNote(contactNote: Note) {
    if (!selected) return;
    if (contactNoteDeleteArmed !== contactNote.id || mutating) {
      setContactNoteDeleteArmed(contactNote.id);
      setContactNoteEditing(null);
      return;
    }
    setMutating(`contact-note-delete:${contactNote.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/notes/${contactNote.id}`, {
        method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ if_updated_at: contactNote.updated_at || contactNote.created_at }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        if (response.status === 409) {
          await openContact(selected);
          setDrawerTab("timeline");
        }
        setError(result.error || "The contact note could not be deleted.");
        setContactNoteDeleteArmed("");
        return;
      }
      await openContact(selected);
      setDrawerTab("timeline");
      setContactNoteDeleteArmed("");
      setNotice("Contact note deleted.");
    } finally { setMutating(""); }
  }

  async function createSource(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setMutating("source"); setError("");
    try {
      const response = await fetch("/v1/admin/sources", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: sourceName, slug: sourceSlug }), credentials: "include",
      });
      const result = await response.json() as { source?: { api_key: string }; error?: string };
      if (!response.ok || !result.source) { setError(result.error || "The source could not be created."); return; }
      setNewSourceKey(result.source.api_key);
      setSourceName(""); setSourceSlug("");
      await load();
    } finally { setMutating(""); }
  }

  async function revokeSource(sourceId: string) {
    if (sourceActionArmed?.id !== sourceId || sourceActionArmed.action !== "revoke") {
      setSourceActionArmed({ id: sourceId, action: "revoke" }); return;
    }
    if (mutating) return;
    setMutating(`source-revoke:${sourceId}`); setError("");
    try {
      const response = await fetch(`/v1/admin/sources/${sourceId}`, { method: "DELETE", credentials: "include" });
      if (response.ok) { setSourceActionArmed(null); await load(); setNotice("Source key revoked. Connected submissions now fail authentication."); }
      else setError("The source could not be revoked.");
    } finally { setMutating(""); }
  }

  async function purgeSource(sourceId: string) {
    if (sourceActionArmed?.id !== sourceId || sourceActionArmed.action !== "purge") {
      setSourceActionArmed({ id: sourceId, action: "purge" }); return;
    }
    if (mutating) return;
    setMutating(`source-purge:${sourceId}`); setError("");
    try {
      const response = await fetch(`/v1/admin/sources/${sourceId}/purge`, { method: "DELETE", credentials: "include" });
      if (response.ok) { setSourceActionArmed(null); await load(); setNotice("Unused revoked source configuration purged."); }
      else setError("The source still has CRM history or could not be purged.");
    } finally { setMutating(""); }
  }

  async function connectMailbox(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setMutating("mailbox-connect"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/mailbox-connections", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ provider: mailboxProvider, alias: mailboxAlias }),
      });
      const result = await response.json().catch(() => ({})) as {
        redirect_url?: string; error?: string; code?: string;
      };
      if (!response.ok || !result.redirect_url) {
        await loadMailboxes();
        setError(result.error || "The secure mailbox connection could not be started.");
        return;
      }
      window.location.assign(result.redirect_url);
    } finally { setMutating(""); }
  }

  async function reconcileMailbox(connection: MailboxConnection) {
    if (mutating || !connection.connected_account_id) return;
    setMutating(`mailbox-reconcile:${connection.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/mailbox-connections/${connection.id}`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ expected_revision: connection.revision }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string;
        connection?: Pick<MailboxConnection, "status" | "provider_status">;
      };
      if (!response.ok) { setError(result.error || "Mailbox status could not be verified."); return; }
      setNotice(result.connection?.status === "active"
        ? "Mailbox provider authority is active. No mail action was executed."
        : result.connection?.status === "expired"
          ? "The provider still reports this mailbox as expired. Reconnect to restore OAuth authority; no mail action was executed."
          : result.connection?.status === "error"
            ? "The provider account is still unusable. Reconnect or revoke it; no mail action was executed."
            : "Mailbox ownership was verified, but provider authorization is still pending. No mail action was executed.");
      await loadMailboxes();
    } finally { setMutating(""); }
  }

  async function reconnectMailbox(connection: MailboxConnection) {
    if (mutating || !connection.connected_account_id) return;
    setMutating(`mailbox-reconnect:${connection.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/mailbox-connections/${connection.id}/reconnect`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ expected_revision: connection.revision }),
      });
      const result = await response.json().catch(() => ({})) as {
        redirect_url?: string; error?: string;
      };
      if (!response.ok || !result.redirect_url) {
        await loadMailboxes();
        setError(result.error || "Secure mailbox reconnection could not be started.");
        return;
      }
      window.location.assign(result.redirect_url);
    } finally { setMutating(""); }
  }

  async function disableMailbox(connection: MailboxConnection) {
    if (mailboxActionArmed?.id !== connection.id || mailboxActionArmed.action !== "disable") {
      setMailboxActionArmed({ id: connection.id, action: "disable" }); return;
    }
    if (mutating) return;
    setMutating(`mailbox-disable:${connection.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/mailbox-connections/${connection.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ expected_revision: connection.revision }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || "Mailbox could not be disabled."); return; }
      setMailboxActionArmed(null);
      setNotice("CRM mailbox use disabled. Provider tokens were not revoked.");
      await loadMailboxes();
    } finally { setMutating(""); }
  }

  async function revokeMailbox(connection: MailboxConnection) {
    if (mailboxActionArmed?.id !== connection.id || mailboxActionArmed.action !== "revoke") {
      setMailboxActionArmed({ id: connection.id, action: "revoke" }); return;
    }
    if (mutating) return;
    setMutating(`mailbox-revoke:${connection.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/mailbox-connections/${connection.id}/revoke`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ expected_revision: connection.revision }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || "Provider token revocation could not be confirmed."); return; }
      setMailboxActionArmed(null);
      setNotice("Composio confirmed provider-token revocation. The mailbox remains as audit history.");
      await loadMailboxes();
    } finally { setMutating(""); }
  }

  async function removeFailedMailbox(connection: MailboxConnection) {
    if (mailboxActionArmed?.id !== connection.id || mailboxActionArmed.action !== "remove") {
      setMailboxActionArmed({ id: connection.id, action: "remove" }); return;
    }
    if (mutating) return;
    setMutating(`mailbox-remove:${connection.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/mailbox-connections/${connection.id}?expected_revision=${connection.revision}`, {
        method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include",
        body: "{}",
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || "Failed mailbox setup could not be removed."); return; }
      setMailboxActionArmed(null);
      setNotice("Failed local setup removed. No provider account or token existed.");
      await loadMailboxes();
    } finally { setMutating(""); }
  }

  async function connectResend(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setMutating("resend-connect"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/resend-connection", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify(resendDraft),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || "Resend could not be connected."); return; }
      setResendDraft({ ...resendDraft, api_key: "" });
      setNotice("Resend credential encrypted. Send the verification email before transactional sending is enabled.");
      await loadResend();
    } finally { setMutating(""); }
  }

  async function verifyResend() {
    const connection = resendData?.connection;
    if (!connection || mutating) return;
    setMutating("resend-verify"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/resend-connection/verify", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          expected_revision: connection.revision,
          idempotency_key: `verify-${crypto.randomUUID()}`,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || "Resend verification failed."); await loadResend(); return; }
      setNotice("Verification email accepted by Resend. Transactional sending is now enabled.");
      await loadResend();
    } finally { setMutating(""); }
  }

  async function sendResendMessage() {
    if (!resendSendArmed) { setResendSendArmed(true); return; }
    if (mutating) return;
    setMutating("resend-send"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/resend-connection/send", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          ...resendMessage,
          idempotency_key: `operator-${crypto.randomUUID()}`,
          confirmation: "SEND TRANSACTIONAL EMAIL",
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || "Transactional email was not accepted."); return; }
      setResendMessage({ recipient: "", subject: "", text: "" });
      setResendSendArmed(false);
      setNotice("Transactional email accepted by Resend.");
      await loadResend();
    } finally { setMutating(""); }
  }

  async function disconnectResend() {
    const connection = resendData?.connection;
    if (!connection || mutating) return;
    if (!resendDisconnectArmed) { setResendDisconnectArmed(true); return; }
    setMutating("resend-disconnect"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/resend-connection", {
        method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ expected_revision: connection.revision, confirmation: "DISCONNECT RESEND" }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(result.error || "Resend could not be disconnected."); return; }
      setResendDisconnectArmed(false);
      setNotice("Local Resend authority removed. Revoke the provider key in Resend to invalidate it globally.");
      await loadResend();
    } finally { setMutating(""); }
  }

  async function createSkoolSource() {
    if (mutating) return;
    setMutating("skool"); setError("");
    try {
      const response = await fetch("/v1/admin/sources", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ name: "Skool Community", slug: "skool-community" }),
      });
      const result = await response.json() as { source?: { api_key: string }; error?: string };
      if (!response.ok || !result.source) { setError(result.error || "The Skool connector could not be created."); return; }
      setNewSourceKey(result.source.api_key); await load();
    } finally { setMutating(""); }
  }

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!taskTitle.trim() || mutating) return;
    const submittedDue = String(new FormData(event.currentTarget as HTMLFormElement).get("due_at") || taskDue);
    let dueAt: string | null = null;
    if (submittedDue) {
      const parsed = new Date(submittedDue);
      if (!Number.isFinite(parsed.getTime())) { setError("Choose a valid task due date."); return; }
      dueAt = parsed.toISOString();
    }
    setMutating("task"); setError("");
    try {
      const response = await fetch("/v1/admin/tasks", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          title: taskTitle, due_at: dueAt, priority: taskPriority, assignee: taskAssignee || null,
          contact_id: taskContactId || null, opportunity_id: taskOpportunityId || null,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error || "The task could not be created."); return; }
      setTaskTitle(""); setTaskDue(""); setTaskPriority("normal"); setTaskAssignee("");
      if (!selectedOpportunityId) { setTaskContactId(""); setTaskOpportunityId(""); }
      setTaskDetailsOpen(false); await load();
      if (taskView === "calendar") await loadCalendar();
      setNotice("Task added to the execution queue.");
    } finally { setMutating(""); }
  }

  async function createLead(event: FormEvent) {
    event.preventDefault();
    if (!leadEmail.trim() || mutating) return;
    setMutating("lead"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/contacts", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ email: leadEmail, first_name: leadFirstName, company: leadCompany }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error || "The lead could not be created."); return; }
      setLeadEmail(""); setLeadFirstName(""); setLeadCompany(""); setLeadComposerOpen(false);
      await Promise.all([load(), loadContacts()]);
      await refreshContactTotals();
      setNotice("Lead created.");
    } finally { setMutating(""); }
  }

  async function updateTaskStatus(task: Task, status: "open" | "completed" | "cancelled") {
    if (mutating) return;
    setMutating(`task:${task.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/tasks/${task.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ status, if_updated_at: task.updated_at }),
      });
      if (response.ok) {
        const result = await response.json() as { task: Task };
        setControl((current) => current ? {
          ...current, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, ...result.task } : item),
        } : current);
        setDetail((current) => current ? {
          ...current, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, ...result.task } : item),
        } : current);
        setCompanyDetail((current) => current ? {
          ...current, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, ...result.task } : item),
        } : current);
        if (taskView === "calendar") await loadCalendar();
        setNotice(status === "completed" ? "Task completed." : status === "cancelled" ? "Task cancelled." : "Task reopened.");
      } else if (response.status === 409) {
        setError("This task changed in another session. The latest task list has been loaded.");
        await Promise.all([
          load({ preserveError: true }),
          refreshOpenContactDetail(task.contact_id),
          refreshOpenCompanyTaskDetail(task.id),
        ]);
      }
      else setError("The task status could not be changed.");
    } finally { setMutating(""); }
  }

  async function deleteTask(task: Task) {
    if (taskDeleteArmed !== task.id) { setTaskDeleteArmed(task.id); return; }
    if (mutating) return;
    setMutating(`task:${task.id}`); setError("");
    try {
      const version = encodeURIComponent(task.updated_at);
      const response = await fetch(`/v1/admin/tasks/${task.id}?if_updated_at=${version}`, { method: "DELETE", credentials: "include" });
      if (response.ok) {
        setControl((current) => current ? { ...current, tasks: current.tasks.filter((item) => item.id !== task.id) } : current);
        setDetail((current) => current ? { ...current, tasks: current.tasks.filter((item) => item.id !== task.id) } : current);
        setCompanyDetail((current) => current ? { ...current, tasks: current.tasks.filter((item) => item.id !== task.id) } : current);
        if (taskView === "calendar") await loadCalendar();
        setTaskDeleteArmed(""); setNotice("Completed task deleted.");
      } else if (response.status === 409) {
        setTaskDeleteArmed("");
        setError("This task changed before deletion. The latest task list has been loaded.");
        await Promise.all([
          load({ preserveError: true }),
          refreshOpenContactDetail(task.contact_id),
          refreshOpenCompanyTaskDetail(task.id),
        ]);
      } else setError("The completed task could not be deleted.");
    } finally { setMutating(""); }
  }

  async function refreshOpenContactDetail(contactId: string | null) {
    if (!contactId || selected?.id !== contactId) return;
    const response = await fetch(`/v1/admin/contacts/${contactId}`, { credentials: "include" });
    if (!response.ok) return;
    const nextDetail = await response.json() as ContactDetail;
    setDetail((current) => current?.contact.id === contactId ? nextDetail : current);
  }

  async function refreshOpenCompanyTaskDetail(taskId: string) {
    const companyId = companyDetail?.tasks.some((item) => item.id === taskId)
      ? companyDetail.company.id
      : null;
    if (!companyId) return;
    await refreshCompanyDetail(companyId);
  }

  async function refreshSelectedCompanyGraph() {
    if (!selectedCompanyId) return null;
    return refreshCompanyDetail(selectedCompanyId);
  }

  async function refreshSelectedContactDetail() {
    if (!selected) return null;
    const response = await fetch(`/v1/admin/contacts/${selected.id}`, { credentials: "include" });
    if (!response.ok) {
      setError("The latest contact record could not be loaded.");
      return null;
    }
    const next = await response.json() as ContactDetail;
    setDetail(next);
    return next;
  }

  async function createOpportunity(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    const contactId = selectedOpportunityContactId;
    const contact = [...contactRows, ...(data?.contacts ?? [])].find((item) => item.id === contactId);
    const pipeline = control?.pipelines.find((item) => item.id === activePipelineId) || control?.pipelines[0];
    const stage = control?.stages
      .filter((item) => item.pipeline_id === pipeline?.id)
      .sort((left, right) => left.position - right.position)[0];
    if (!contact || !pipeline || !stage) { setError("Add a contact before creating an opportunity."); return; }
    setMutating("opportunity"); setError("");
    try {
      const response = await fetch("/v1/admin/opportunities", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ contact_id: contact.id, pipeline_id: pipeline.id, stage_id: stage.id, name: opportunityName, value: Number(opportunityValue), next_step: "Qualify the opportunity" }),
      });
      const result = await response.json() as { opportunity?: Omit<Opportunity, "email" | "first_name" | "last_name" | "company" | "stage_name" | "stage_color"> };
      if (!response.ok || !result.opportunity) { setError("The opportunity could not be created."); return; }
      const createdOpportunity: Opportunity = {
        ...result.opportunity,
        email: contact.email, first_name: contact.first_name, last_name: contact.last_name, company: contact.company,
        stage_name: stage.name, stage_color: stage.color,
      };
      setOpportunityName("");
      await Promise.all([load(), loadContacts()]);
      setControl((current) => current && !current.opportunities.some((item) => item.id === createdOpportunity.id)
        ? { ...current, opportunities: [createdOpportunity, ...current.opportunities] }
        : current);
      setNotice("Opportunity created.");
    } finally { setMutating(""); }
  }

  async function moveOpportunity(opportunity: Opportunity, stageId: string, terminalConfirmed = false) {
    if (mutating || stageId === opportunity.stage_id) return;
    const stage = control?.stages.find((item) => item.id === stageId);
    if (!stage || stage.pipeline_id !== opportunity.pipeline_id) {
      setError("That stage is not available for this opportunity.");
      return;
    }
    if (["won", "lost"].includes(stage.category) && !terminalConfirmed) {
      setPendingTerminalMove({ opportunityId: opportunity.id, stageId });
      setNotice("");
      return;
    }
    setPendingTerminalMove(null);
    setMutating(`opportunity-move:${opportunity.id}`); setError(""); setNotice("");
    const previousOpportunity = opportunity;
    setControl((current) => current ? {
      ...current,
      opportunities: current.opportunities.map((item) => item.id === opportunity.id ? {
        ...item,
        stage_id: stage.id,
        stage_name: stage.name,
        stage_color: stage.color,
        probability: stage.probability,
        status: stage.category === "won" ? "won" : stage.category === "lost" ? "lost" : "open",
      } : item),
    } : current);
    try {
      const response = await fetch(`/v1/admin/opportunities/${opportunity.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ stage_id: stageId, status: stage.category === "won" ? "won" : stage.category === "lost" ? "lost" : "open", if_updated_at: opportunity.updated_at }),
      });
      if (response.ok) {
        await Promise.all([load(), refreshSelectedCompanyGraph(), refreshSelectedContactDetail()]);
        setNotice(`${opportunity.name} moved to ${stage.name}.`);
      }
      else if (response.status === 409) {
        setError("This opportunity moved in another session. The latest pipeline has been reloaded.");
        await Promise.all([load({ preserveError: true }), refreshSelectedCompanyGraph(), refreshSelectedContactDetail()]);
      }
      else {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setControl((current) => current ? {
          ...current,
          opportunities: current.opportunities.map((item) =>
            item.id === previousOpportunity.id ? previousOpportunity : item),
        } : current);
        setError(result.error || "The opportunity could not be moved.");
      }
    } catch {
      setControl((current) => current ? {
        ...current,
        opportunities: current.opportunities.map((item) =>
          item.id === previousOpportunity.id ? previousOpportunity : item),
      } : current);
      setError("The opportunity could not be moved. Its previous stage has been restored.");
    } finally { setMutating(""); }
  }

  function handlePipelineDragStart(event: DragStartEvent) {
    const opportunityId = typeof event.active.data.current?.opportunityId === "string"
      ? event.active.data.current.opportunityId
      : "";
    setActiveDraggedOpportunityId(opportunityId);
    setPendingTerminalMove(null);
  }

  function handlePipelineDragEnd(event: DragEndEvent) {
    setActiveDraggedOpportunityId("");
    const opportunityId = typeof event.active.data.current?.opportunityId === "string"
      ? event.active.data.current.opportunityId
      : "";
    const stageId = typeof event.over?.data.current?.stageId === "string"
      ? event.over.data.current.stageId
      : "";
    const opportunity = selectedPipelineOpportunities.find((item) => item.id === opportunityId);
    if (!opportunity || !stageId || stageId === opportunity.stage_id) return;
    void moveOpportunity(opportunity, stageId);
  }

  function moveOpportunityByKeyboard(opportunity: Opportunity, direction: -1 | 1) {
    const currentIndex = selectedPipelineStages.findIndex((stage) => stage.id === opportunity.stage_id);
    const target = selectedPipelineStages[currentIndex + direction];
    if (!target) {
      setNotice(direction < 0 ? "This opportunity is already in the first stage." : "This opportunity is already in the last stage.");
      return;
    }
    void moveOpportunity(opportunity, target.id);
  }

  function editOpportunity(opportunity: Opportunity) {
    setOpportunityDeleteArmed("");
    setOpportunityDraft({
      id: opportunity.id, value: String(opportunity.value), nextStep: opportunity.next_step || "",
      owner: opportunity.owner || "", expectedClose: opportunity.expected_close_at?.slice(0, 10) || "",
    });
  }

  async function saveOpportunity(opportunity: Opportunity) {
    if (!opportunityDraft || opportunityDraft.id !== opportunity.id || mutating) return;
    setMutating(`opportunity-edit:${opportunity.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/opportunities/${opportunity.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          value: Number(opportunityDraft.value), next_step: opportunityDraft.nextStep || null,
          owner: opportunityDraft.owner || null,
          expected_close_at: opportunityDraft.expectedClose ? new Date(`${opportunityDraft.expectedClose}T12:00:00Z`).toISOString() : null,
          custom_fields: Object.fromEntries(customFields.filter((field) => field.object_type === "opportunity" && field.active)
            .map((field) => [field.field_key, opportunityCustomDraft[field.field_key] ?? null])),
          if_updated_at: opportunity.updated_at,
        }),
      });
      const result = await response.json() as { opportunity?: Opportunity; error?: string };
      if (response.status === 409) {
        setError("This opportunity changed in another session. The latest pipeline has been reloaded.");
        setOpportunityDraft(null);
        await Promise.all([load({ preserveError: true }), refreshSelectedCompanyGraph(), refreshSelectedContactDetail()]);
        return;
      }
      if (!response.ok || !result.opportunity) { setError(result.error || "The opportunity details could not be saved."); return; }
      setOpportunityDraft(null);
      await Promise.all([load(), refreshSelectedCompanyGraph(), refreshSelectedContactDetail()]);
      if (taskView === "calendar") await loadCalendar();
    } finally { setMutating(""); }
  }

  async function deleteOpportunity(opportunity: Opportunity) {
    if (opportunityDeleteArmed !== opportunity.id) { setOpportunityDeleteArmed(opportunity.id); return; }
    setMutating(`opportunity-delete:${opportunity.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/opportunities/${opportunity.id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) { setError("The opportunity could not be deleted."); return; }
      setOpportunityDeleteArmed("");
      closeOpportunityWorkspace();
      await Promise.all([load(), loadContacts(), refreshSelectedCompanyGraph(), refreshSelectedContactDetail()]);
      setNotice("Opportunity deleted.");
    } finally { setMutating(""); }
  }

  function openAutomationBuilder(automation?: Automation) {
    const parsed = automation ? automationDefinition(automation) : defaultWorkflow;
    if (!parsed) { setError("This stored workflow is unreadable and cannot be edited."); return; }
    setAutomationEditing(automation || null);
    setAutomationBuilderOpen(true);
    setAutomationName(automation?.name || "");
    setWorkflowDefinition(structuredClone(parsed));
    setAutomationDeleteArmed("");
    setError("");
  }

  async function saveAutomation() {
    if (mutating) return;
    setMutating("automation"); setError("");
    try {
      const response = await fetch(automationEditing ? `/v1/admin/automations/${automationEditing.id}` : "/v1/admin/automations", {
        method: automationEditing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          name: automationName, ...workflowDefinition,
          ...(automationEditing ? { if_updated_at: automationEditing.updated_at } : {}),
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 409) {
        setError("This workflow changed in another session. The latest version has been loaded.");
        setAutomationEditing(null); setAutomationBuilderOpen(false); setAutomationName("");
        setWorkflowDefinition(defaultWorkflow); await load({ preserveError: true }); return;
      }
      if (!response.ok) { setError(result.error || "The workflow could not be saved."); return; }
      const wasEditing = Boolean(automationEditing);
      setAutomationName(""); setAutomationEditing(null); setAutomationBuilderOpen(false); setWorkflowDefinition(defaultWorkflow); await load();
      setNotice(wasEditing ? "Workflow updated." : "Workflow draft created.");
    } finally { setMutating(""); }
  }

  async function setAutomationStatus(automation: Automation, status: string) {
    if (mutating) return;
    setMutating(`automation-status:${automation.id}`); setError(""); setAutomationDeleteArmed("");
    try {
      const response = await fetch(`/v1/admin/automations/${automation.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ status, if_updated_at: automation.updated_at }),
      });
      const result = await response.json() as { error?: string };
      if (response.ok) { await load(); setNotice(status === "active" ? "Workflow activated." : "Workflow paused."); }
      else if (response.status === 409) {
        setError("This automation changed in another session. The latest rule state has been loaded.");
        await load({ preserveError: true });
      } else setError(result.error || "The automation status could not be changed.");
    } finally { setMutating(""); }
  }

  async function pauseAndRepairAutomation(automation: Automation) {
    if (mutating) return;
    setMutating(`automation-repair:${automation.id}`); setError(""); setAutomationDeleteArmed("");
    try {
      const response = await fetch(`/v1/admin/automations/${automation.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ status: "paused", if_updated_at: automation.updated_at }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; automation?: Automation };
      if (!response.ok || !result.automation) {
        setError(response.status === 409
          ? "This automation changed in another session. The latest rule state has been loaded."
          : result.error || "The workflow could not be paused for repair.");
        await load({ preserveError: true });
        return;
      }
      await load();
      openAutomationBuilder(result.automation);
      setNotice("Workflow paused. Replace the unavailable field, then save and reactivate it.");
    } finally { setMutating(""); }
  }

  async function deleteAutomation(automation: Automation) {
    if (automationDeleteArmed !== automation.id) { setAutomationDeleteArmed(automation.id); return; }
    if (mutating) return;
    setMutating(`automation-delete:${automation.id}`); setError("");
    try {
      const version = encodeURIComponent(automation.updated_at);
      const response = await fetch(`/v1/admin/automations/${automation.id}?if_updated_at=${version}`, {
        method: "DELETE", credentials: "include",
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) {
        setAutomationDeleteArmed(""); await load(); setNotice("Workflow and its run history deleted.");
      } else if (response.status === 409) {
        setAutomationDeleteArmed(""); setError(result.error || "This workflow changed before deletion. The latest version has been loaded.");
        await load({ preserveError: true });
      } else setError(result.error || "The workflow could not be deleted.");
    } finally { setMutating(""); }
  }

  async function createVisitorConnector(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setMutating("visitor-connector"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/visitor-connectors", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          name: visitorConnectorName, provider: visitorConnectorProvider, consent_default: visitorConsentDefault,
        }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string; connector?: { webhook_url: string; audience_sync_url?: string | null };
      };
      if (!response.ok) { setError(result.error || "The visitor connector could not be created."); return; }
      setVisitorConnectorName("");
      setNewVisitorConnectorUrls(result.connector ? {
        pixel: result.connector.webhook_url,
        audienceSync: result.connector.audience_sync_url || null,
      } : null);
      await loadVisitorIntent();
      setNotice("Visitor connector created. Copy its webhook URL before leaving this page.");
    } finally { setMutating(""); }
  }

  async function submitAudienceImport(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setError(""); setNotice("");
    let rows: Array<Record<string, unknown>>;
    try {
      const document = parseCsv(audienceCsv);
      const allowed = ["email", "first_name", "last_name", "linkedin_url", "title", "company_name",
        "company_domain", "company_website", "industry", "city", "region", "postal_code", "consent_status"];
      const mapping = Object.fromEntries(document.headers.map((header) =>
        [header, audienceMapping[header] ?? suggestedCsvTarget(header, allowed)]));
      rows = mapCsvDocument(document, mapping);
      if (!Object.values(mapping).includes("email") && !Object.values(mapping).includes("linkedin_url") &&
        !Object.values(mapping).includes("company_domain") && !Object.values(mapping).includes("company_website")) {
        throw new Error("Map at least one identity field: email, LinkedIn URL, or company domain.");
      }
    }
    catch (error) { setError(error instanceof Error ? error.message : "CSV could not be parsed."); return; }
    const payload = {
      connector_id: audienceConnectorId,
      external_key: audienceExternalKey.trim(),
      list_name: audienceListName.trim(),
      mode: "interactive",
      consent_basis: audienceConsentBasis,
      tags: audienceTags.split(",").map((tag) => tag.trim()).filter(Boolean),
      rows,
    };
    const action = audiencePreview ? "commit" : "preview";
    setMutating(`audience-${action}`);
    try {
      const response = await fetch(`/v1/admin/audience-imports/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string; preview?: AudienceImportPreview;
        import?: { requested_rows: number; created_profiles: number; updated_profiles: number };
      };
      if (!response.ok) { setError(result.error || `Audience ${action} failed.`); return; }
      if (action === "preview") {
        setAudiencePreview(result.preview || null);
        setNotice("Preview ready. No Contacts were created and no outreach was authorized.");
      } else {
        const imported = result.import;
        setAudiencePreview(null); setAudienceListName(""); setAudienceExternalKey(""); setAudienceTags("");
        setAudienceCsv("email,first_name,last_name,company_name,company_domain,consent_status\n");
        setAudienceMapping({});
        await loadVisitorIntent();
        setNotice(`${imported?.requested_rows || rows.length} audience rows quarantined · ${imported?.created_profiles || 0} new · ${imported?.updated_profiles || 0} updated.`);
      }
    } finally { setMutating(""); }
  }

  async function submitContactImport(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setError(""); setNotice("");
    let rows: Array<Record<string, unknown>>;
    try {
      const document = parseCsv(contactImportCsv);
      const allowed = ["email", "first_name", "last_name", "phone", "company", "owner"];
      const mapping = Object.fromEntries(document.headers.map((header) =>
        [header, contactImportMapping[header] ?? suggestedCsvTarget(header, allowed)]));
      rows = mapCsvDocument(document, mapping);
      if (!Object.values(mapping).includes("email")) throw new Error("Map one CSV column to Email.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "CSV could not be parsed.");
      return;
    }
    const action = contactImportPreview ? "commit" : "preview";
    setMutating(`contacts-import-${action}`);
    try {
      const response = await fetch(`/v1/admin/contacts/import/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ rows }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string; preview?: ContactImportPreview; imported?: number; skipped_existing?: number;
      };
      if (!response.ok) { setError(result.error || `Contact import ${action} failed.`); return; }
      if (action === "preview") {
        setContactImportPreview(result.preview || null);
        setNotice("Import preview ready. No contacts have been changed.");
      } else {
        setContactImportPreview(null); setContactImportCsv("email,first_name,last_name,phone,company,owner\n");
        setContactImportMapping({}); setContactImportOpen(false);
        await Promise.all([loadContacts(), loadContactImports()]);
        setNotice(`${result.imported || 0} contacts imported · ${result.skipped_existing || 0} existing records skipped.`);
      }
    } finally { setMutating(""); }
  }

  async function rollbackContactImport(batch: ContactImportBatch) {
    if (mutating || batch.status !== "committed") return;
    if (contactImportRollbackArmed !== batch.id) {
      setContactImportRollbackArmed(batch.id);
      return;
    }
    setMutating(`contact-import-rollback:${batch.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/contact-imports/${batch.id}/rollback`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ confirmation: batch.id, expected_created_at: batch.created_at }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string; code?: string;
        import?: Pick<ContactImportBatch, "rollback_deleted_rows" | "rollback_conflict_rows" | "rollback_missing_rows">;
      };
      if (!response.ok) {
        setError(result.code === "edit_conflict" || result.code === "already_rolled_back"
          ? "This import changed in another session. The latest history has been loaded."
          : result.error || "The import could not be rolled back.");
        await loadContactImports({ preserveError: true });
        return;
      }
      setContactImportRollbackArmed("");
      await Promise.all([load(), loadContacts(), loadContactImports()]);
      setNotice(`${result.import?.rollback_deleted_rows || 0} untouched imported contacts removed · ${
        result.import?.rollback_conflict_rows || 0} changed contacts preserved · ${
        result.import?.rollback_missing_rows || 0} already missing.`);
    } finally {
      setMutating("");
    }
  }

  async function changeVisitorConnector(connector: VisitorConnector, action: "rotate" | "revoke") {
    if (mutating) return;
    if (visitorConnectorArmed?.id !== connector.id || visitorConnectorArmed.action !== action) {
      setVisitorConnectorArmed({ id: connector.id, action });
      return;
    }
    setMutating(`visitor-connector-${action}:${connector.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(action === "rotate"
        ? `/v1/admin/visitor-connectors/${connector.id}`
        : `/v1/admin/visitor-connectors/${connector.id}?if_updated_at=${encodeURIComponent(connector.updated_at)}`, {
        method: action === "rotate" ? "PATCH" : "DELETE",
        headers: action === "rotate" ? { "content-type": "application/json" } : undefined,
        credentials: "include",
        body: action === "rotate" ? JSON.stringify({ expected_updated_at: connector.updated_at }) : undefined,
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string; code?: string; connector?: { webhook_url?: string; audience_sync_url?: string | null };
      };
      if (!response.ok) {
        setError(result.code === "edit_conflict"
          ? "This connector changed in another session. The latest state has been loaded."
          : result.error || `The connector could not be ${action === "rotate" ? "rotated" : "revoked"}.`);
        await loadVisitorIntent({ preserveError: true });
        return;
      }
      setVisitorConnectorArmed(null);
      if (action === "rotate" && result.connector?.webhook_url) setNewVisitorConnectorUrls({
        pixel: result.connector.webhook_url,
        audienceSync: result.connector.audience_sync_url || null,
      });
      await loadVisitorIntent();
      setNotice(action === "rotate"
        ? "Connector rotated. The old URL stopped working; copy the new URL now."
        : "Connector revoked. Its webhook URL now rejects ingestion.");
    } finally { setMutating(""); }
  }

  async function requestVisitorResearch(profile: VisitorProfile) {
    if (mutating) return;
    if (visitorActionArmed?.id !== profile.id || visitorActionArmed.action !== "research") {
      setVisitorActionArmed({ id: profile.id, action: "research" });
      return;
    }
    const researchType = profile.company_domain ? "company_research" : "person_enrichment";
    setMutating(`visitor-research:${profile.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/visitor-profiles/${profile.id}/research`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ expected_revision: profile.revision, research_type: researchType }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string; code?: string; work_item?: { id: string };
      };
      if (!response.ok) {
        setError(result.code === "active_research_exists"
          ? "A research agent is already working from this evidence."
          : result.error || "Research could not be queued.");
        return;
      }
      setVisitorActionArmed(null);
      await load();
      setNotice("Research queued from frozen evidence. The agent cannot create CRM records or contact anyone.");
    } finally { setMutating(""); }
  }

  async function reviewVisitorProfile(profile: VisitorProfile, reviewStatus: "reviewed" | "suppressed") {
    if (mutating) return;
    if (reviewStatus === "suppressed" &&
      (visitorActionArmed?.id !== profile.id || visitorActionArmed.action !== "suppress")) {
      setVisitorActionArmed({ id: profile.id, action: "suppress" });
      return;
    }
    setMutating(`visitor-review:${profile.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/visitor-profiles/${profile.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ review_status: reviewStatus, expected_revision: profile.revision }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; code?: string };
      if (!response.ok) {
        setError(result.code === "edit_conflict"
          ? "This visitor changed before review. The latest profile has been loaded."
          : result.error || "The visitor review could not be saved.");
        await loadVisitorIntent({ preserveError: true });
        return;
      }
      setVisitorActionArmed(null);
      await loadVisitorIntent();
      setNotice(reviewStatus === "suppressed"
        ? "Visitor suppressed. No CRM lead was created."
        : "Visitor marked reviewed. It remains outside the CRM lead database.");
    } finally { setMutating(""); }
  }

  async function promoteVisitorProfile(profile: VisitorProfile) {
    if (mutating) return;
    if (visitorActionArmed?.id !== profile.id || visitorActionArmed.action !== "promote") {
      setVisitorActionArmed({ id: profile.id, action: "promote" });
      return;
    }
    setMutating(`visitor-promote:${profile.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/visitor-profiles/${profile.id}/promote`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ expected_revision: profile.revision }),
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string; code?: string; created?: boolean; consent_warning?: boolean;
      };
      if (!response.ok) {
        setError(result.code === "edit_conflict"
          ? "This visitor changed before promotion. Review the latest visits and try again."
          : result.error || "The visitor could not be promoted.");
        await loadVisitorIntent({ preserveError: true });
        return;
      }
      setVisitorActionArmed(null);
      await Promise.all([loadVisitorIntent(), load(), refreshContactTotals()]);
      setNotice(`${result.created ? "Lead created" : "Existing CRM contact linked"} from Visitor Intent.${
        result.consent_warning ? " Consent remains unknown; promotion does not authorize outreach." : ""}`);
    } finally { setMutating(""); }
  }

  async function openVisitorIntentCase(account: VisitorIntentAccount) {
    if (mutating) return;
    if (visitorActionArmed?.id !== account.company_domain || visitorActionArmed.action !== "case") {
      setVisitorActionArmed({ id: account.company_domain, action: "case" });
      return;
    }
    setMutating(`visitor-case:${account.company_domain}`); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/visitor-intent/cases", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          company_domain: account.company_domain,
          expected_evidence_updated_at: account.evidence_updated_at,
          priority: account.intent_score >= 80 ? "urgent" : account.intent_score >= 60 ? "high" : "normal",
          due_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; code?: string };
      if (!response.ok) {
        setError(result.code === "evidence_conflict"
          ? "New website activity arrived before the case opened. The latest account evidence has been loaded."
          : result.error || "The intent case could not be opened.");
        await loadVisitorIntent({ preserveError: true });
        return;
      }
      setVisitorActionArmed(null);
      await loadVisitorIntent();
      setNotice("Intent case opened. The account remains outside Contacts and Pipeline.");
    } finally { setMutating(""); }
  }

  async function openVisitorIntentCaseDetail(intentCase: VisitorIntentCase) {
    if (!selectedVisitorCase) {
      visitorCaseReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setMutating(`visitor-case-detail:${intentCase.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/visitor-intent/cases/${intentCase.id}`, { credentials: "include" });
      const result = await response.json().catch(() => ({})) as VisitorIntentCaseDetail & { error?: string };
      if (!response.ok) { setError(result.error || "The intent case could not be loaded."); return; }
      setSelectedVisitorCase(result);
      setVisitorCaseOwnerDraft(result.case.owner || "");
      setVisitorCasePriorityDraft(result.case.priority);
      setVisitorCaseDueDraft(result.case.due_at ? result.case.due_at.slice(0, 16) : "");
    } finally { setMutating(""); }
  }

  function closeVisitorIntentCaseDetail() {
    setSelectedVisitorCase(null);
    window.requestAnimationFrame(() => visitorCaseReturnFocusRef.current?.focus());
  }

  async function updateVisitorIntentCase(intentCase: VisitorIntentCase, changes: {
    status?: VisitorIntentCase["status"]; owner?: string | null; priority?: VisitorIntentCase["priority"];
    due_at?: string | null;
  }) {
    if (mutating) return;
    const status = changes.status ?? intentCase.status;
    const terminal = status === "resolved" || status === "dismissed";
    const resolutionNote = visitorCaseResolution[intentCase.id]?.trim() || intentCase.resolution_note || "";
    if (terminal && resolutionNote.length < 3) {
      setError("Add a short resolution note before closing an intent case."); return;
    }
    setMutating(`visitor-case-update:${intentCase.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/visitor-intent/cases/${intentCase.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          expected_revision: intentCase.revision, status, ...changes,
          ...(changes.owner !== undefined ? { owner: changes.owner }
            : status === "in_review" && !intentCase.owner
              ? { owner: control?.current_user?.email || null } : {}),
          resolution_note: terminal ? resolutionNote : status !== intentCase.status ? null : intentCase.resolution_note,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; code?: string; case?: VisitorIntentCase };
      if (!response.ok) {
        setError(result.code === "edit_conflict"
          ? "This case changed in another session. The current queue has been loaded."
          : result.error || "The intent case could not be updated.");
        await loadVisitorIntent({ preserveError: true });
        return;
      }
      await loadVisitorIntent();
      if (status === "new") setVisitorCaseResolution((current) => {
        const next = { ...current }; delete next[intentCase.id]; return next;
      });
      if (selectedVisitorCase?.case.id === intentCase.id && result.case) await openVisitorIntentCaseDetail(result.case);
      setNotice(terminal ? "Intent case closed with an auditable resolution."
        : changes.owner !== undefined || changes.priority !== undefined || changes.due_at !== undefined
          ? "Intent case ownership and service level updated." : "Intent case state updated.");
    } finally { setMutating(""); }
  }

  async function runManualAutomation(automation: Automation) {
    if (mutating) return;
    const recordId = automationManualRecords[automation.id];
    if (!recordId) { setError("Choose a record before running this workflow."); return; }
    setMutating(`automation-run-now:${automation.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/automations/${automation.id}/run`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ record_id: recordId }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; run?: AutomationRun };
      if (!response.ok) { setError(result.error || "The workflow could not be run."); return; }
      await Promise.all([load(), loadContacts()]);
      setNotice(result.run?.status === "failed"
        ? "Workflow ran but a step failed. Open its trace for the exact error."
        : "Workflow completed for the selected record.");
    } finally { setMutating(""); }
  }

  async function operateAutomationRun(run: AutomationRun, operation: "retry" | "cancel") {
    if (mutating) return;
    setMutating(`automation-run:${run.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/automation-runs/${run.id}/${operation}`, {
        method: "POST", credentials: "include",
      });
      const result = await response.json().catch(() => ({})) as { error?: string; code?: string };
      if (response.ok) {
        await load();
        setNotice(operation === "retry"
          ? "Failed run retried against the current record and active workflow."
          : "Stale running execution canceled.");
      } else if (result.code === "run_already_retried") {
        setError("This failed run already has a retry. Open the newer run instead.");
        await load({ preserveError: true });
      } else {
        setError(result.error || `The automation run could not be ${operation === "retry" ? "retried" : "canceled"}.`);
      }
    } finally { setMutating(""); }
  }

  async function requeueAgentWorkItem(item: AgentWorkItem) {
    if (mutating) return;
    setMutating(`agent-work:${item.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/agent-work-items/${item.id}/requeue`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ if_updated_at: item.updated_at }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) { await load(); setNotice("Agent work returned to the compatible runtime queue."); }
      else if (response.status === 409) {
        setError(result.error || "This agent work item changed before it could be requeued.");
        await load({ preserveError: true });
      } else setError(result.error || "The agent work item could not be requeued.");
    } finally { setMutating(""); }
  }

  async function cancelAgentWorkItem(item: AgentWorkItem) {
    if (agentWorkCancelArmed !== item.id) {
      setAgentWorkCancelArmed(item.id);
      return;
    }
    if (mutating) return;
    setMutating(`agent-work-cancel:${item.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/agent-work-items/${item.id}/cancel`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ if_updated_at: item.updated_at }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) {
        setAgentWorkCancelArmed("");
        await load();
        setNotice("Queued agent work canceled before any runtime claimed it.");
      } else if (response.status === 409) {
        setAgentWorkCancelArmed("");
        setError(result.error || "This agent work item changed before it could be canceled.");
        await load({ preserveError: true });
      } else setError(result.error || "The queued agent work could not be canceled.");
    } finally { setMutating(""); }
  }

  async function createWebhook(event: FormEvent) {
    event.preventDefault();
    if (mutating) return;
    setMutating("webhook"); setError("");
    try {
      const response = await fetch("/v1/admin/webhooks", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({ name: webhookName, direction: webhookDirection,
          url: webhookDirection === "outbound" && webhookPayloadPreset !== "pagerduty" ? webhookUrl : null,
          provider_credential: webhookPayloadPreset === "pagerduty" ? webhookProviderCredential : null,
          payload_preset: webhookDirection === "outbound" ? webhookPayloadPreset : "generic",
          event_types: webhookDirection === "outbound"
            ? webhookPayloadPreset === "generic"
              ? ["contact.created", "opportunity.updated", "contact.workflow_event", "opportunity.workflow_event",
                ...(webhookOperationsAlerts
                  ? ["operations.health.action", "operations.health.escalated", "operations.health.recovered"] : [])]
              : webhookPayloadPreset === "slack" && webhookVisitorIntentAlerts
                ? ["visitor_intent_case.created"]
                : ["operations.health.action", "operations.health.escalated", "operations.health.recovered"]
            : ["contact.created", "opportunity.updated"] }),
      });
      const result = await response.json() as { webhook?: { secret: string | null }; error?: string };
      if (!response.ok || !result.webhook) { setError(result.error || "The webhook could not be created."); return; }
      if (result.webhook.secret) setNewWebhookSecret(result.webhook.secret);
      else setNotice("PagerDuty destination created. The routing key is encrypted and will not be shown again.");
      setWebhookName(""); setWebhookUrl(""); setWebhookProviderCredential("");
      setWebhookOperationsAlerts(false); setWebhookVisitorIntentAlerts(false); setWebhookPayloadPreset("generic"); await load();
    } finally { setMutating(""); }
  }

  async function deleteWebhook(webhookId: string) {
    if (mutating || webhookDeleteArmed !== webhookId) return;
    setMutating(`webhook-delete:${webhookId}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/webhooks/${webhookId}`, { method: "DELETE", credentials: "include" });
      if (response.ok) {
        setWebhookDeleteArmed(""); setWebhookEdit(null); setPagerDutyEdit(null);
        setNotice("Webhook and delivery history deleted."); await load();
      } else setError("The webhook could not be deleted.");
    } finally { setMutating(""); }
  }

  async function updateWebhookDestination(webhook: Webhook) {
    if (mutating || webhookEdit?.id !== webhook.id) return;
    setMutating(`webhook-edit:${webhook.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/webhooks/${webhook.id}`, {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: webhookEdit.url, expected_updated_at: webhook.updated_at }),
      });
      const result = await response.json() as { error?: string };
      if (response.status === 409) {
        setWebhookEdit(null);
        setError("This webhook changed in another session. The latest destination has been loaded.");
        await load({ preserveError: true });
        return;
      }
      if (!response.ok) { setError(result.error || "The webhook destination could not be updated."); return; }
      setWebhookEdit(null); setNotice("Webhook destination updated."); await load();
    } finally { setMutating(""); }
  }

  async function rotatePagerDutyKey(webhook: Webhook) {
    if (mutating || pagerDutyEdit?.id !== webhook.id || pagerDutyEdit.key.length !== 32) return;
    setMutating(`pagerduty-rotate:${webhook.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/webhooks/${webhook.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          provider_credential: pagerDutyEdit.key,
          expected_updated_at: webhook.updated_at,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 409) {
        setPagerDutyEdit(null);
        setError("This PagerDuty destination changed in another session. The latest key prefix has been loaded.");
        await load({ preserveError: true });
        return;
      }
      if (!response.ok) { setError(result.error || "The PagerDuty routing key could not be rotated."); return; }
      setPagerDutyEdit(null);
      setNotice("PagerDuty routing key rotated. The previous key was invalidated in this CRM.");
      await load();
    } finally { setMutating(""); }
  }

  async function testWebhook(webhookId: string) {
    if (mutating) return;
    setMutating(`webhook-test:${webhookId}`); setError("");
    try {
      const response = await fetch(`/v1/admin/webhooks/${webhookId}/test`, {
        method: "POST", credentials: "include",
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error || "The webhook test could not be delivered."); return; }
      const tested = control?.webhooks.find((hook) => hook.id === webhookId);
      setNotice(tested?.payload_preset === "pagerduty"
        ? "PagerDuty test alert was triggered and automatically resolved."
        : "Webhook test queued for delivery.");
      await load();
    } finally { setMutating(""); }
  }

  async function retryWebhookDeliveries() {
    if (mutating) return;
    setMutating("webhook-retry"); setError("");
    try {
      const response = await fetch("/v1/admin/webhooks/retry", { method: "POST", credentials: "include" });
      const result = await response.json() as { error?: string; processed?: number };
      if (!response.ok) { setError(result.error || "Webhook retries could not be processed."); return; }
      setNotice(result.processed ? `Processed ${result.processed} due webhook ${result.processed === 1 ? "delivery" : "deliveries"}.` : "No webhook deliveries are due yet.");
      await load();
    } finally { setMutating(""); }
  }

  async function runLaunchChecks() {
    if (mutating) return;
    setMutating("launch"); setError("");
    try {
      const response = await fetch("/v1/admin/onboarding/validate", { method: "POST", credentials: "include" });
      if (!response.ok) { setError("Launch checks could not be completed."); return; }
      setNotice("Launch readiness refreshed from current policy and safety contracts.");
      await load();
    } finally { setMutating(""); }
  }

  function toggleMemberContactGrant(grant: string) {
    setAccessPolicyReviewOpen(false);
    setAccessDraft((current) => {
      if (current.includes(grant)) {
        return grant === "update"
          ? current.filter((item) => item !== "update" && !item.startsWith("update_field:"))
          : current.filter((item) => item !== grant);
      }
      return [...new Set([
        ...current,
        ...(grant.startsWith("update_field:") ? ["update"] : []),
        grant,
      ])];
    });
  }

  function toggleMemberOpportunityGrant(grant: string) {
    setAccessPolicyReviewOpen(false);
    setOpportunityAccessDraft((current) => {
      if (current.includes(grant)) {
        if (grant === "read") return [];
        if (grant === "update") {
          return current.filter((item) => item !== "update" &&
            !item.startsWith("update_field:") && !item.startsWith("update_custom_field:"));
        }
        return current.filter((item) => item !== grant);
      }
      return [...new Set([
        ...current,
        "read",
        ...(grant.startsWith("update_") ? ["update"] : []),
        grant,
      ])];
    });
  }

  function toggleMemberCustomObjectGrant(objectId: string, grant: string) {
    setAccessPolicyReviewOpen(false);
    setCustomObjectAccessDraft((current) => {
      const existing = current[objectId] || [];
      let next: string[];
      if (existing.includes(grant)) {
        if (grant === "read") next = [];
        else if (grant === "create" && !existing.includes("update")) {
          next = existing.filter((item) => item !== "create" && !item.startsWith("update_field:"));
        }
        else if (grant === "update") next = existing.filter((item) =>
          item !== "update" && (existing.includes("create") || !item.startsWith("update_field:")));
        else if (grant.startsWith("read_field:")) {
          const fieldKey = grant.slice("read_field:".length);
          next = existing.filter((item) => item !== grant && item !== `update_field:${fieldKey}`);
        } else next = existing.filter((item) => item !== grant);
      } else {
        const definition = accessPolicy?.policy.custom_objects.find((item) => item.object_id === objectId);
        const requiredFieldGrants = grant === "create" && definition
          ? definition.fields.filter((field) => field.required)
            .flatMap((field) => [field.read_grant, field.update_grant])
          : [];
        const dependencies = [
          "read",
          ...(grant.startsWith("update_field:")
            ? [...(existing.includes("create") ? [] : ["update"]), `read_field:${grant.slice("update_field:".length)}`]
            : []),
          ...requiredFieldGrants,
        ];
        next = [...new Set([...existing, ...dependencies, grant])];
      }
      return { ...current, [objectId]: next };
    });
  }

  async function saveAccessPolicy() {
    if (!accessPolicy?.policy.editable || mutating) return;
    setMutating("access-policy"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/access-policy", {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_revision: accessPolicy.policy.revision,
          member_contact_grants: accessDraft,
          member_opportunity_grants: opportunityAccessDraft,
          member_custom_object_grants: customObjectAccessDraft,
        }),
      });
      const result = await response.json() as { error?: string; policy?: AccessPolicyData["policy"] };
      if (!response.ok || !result.policy) {
        setError(result.error || "The workspace access policy could not be saved.");
        if (response.status === 409) await load({ preserveError: true });
        return;
      }
      setAccessPolicy((current) => current ? { ...current, policy: result.policy! } : current);
      setAccessDraft(result.policy.grants);
      setOpportunityAccessDraft(result.policy.opportunity.grants);
      setCustomObjectAccessDraft(Object.fromEntries(result.policy.custom_objects.map((definition) =>
        [definition.object_id, definition.grants])));
      setAccessPolicyReviewOpen(false);
      setNotice(`Member CRM permissions saved as revision ${result.policy.revision}.`);
    } catch {
      setError("The workspace access policy could not be saved. Nothing was changed.");
    } finally { setMutating(""); }
  }

  async function downloadWorkspaceBackup() {
    if (mutating) return;
    setMutating("recovery-export"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/recovery/backup", { credentials: "include" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setError(result.error || "The encrypted workspace backup could not be created.");
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || `workspace-${new Date().toISOString().slice(0, 10)}.crbackup.json`;
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href; anchor.download = fileName; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(href);
      setNotice("Encrypted workspace backup downloaded.");
    } finally { setMutating(""); }
  }

  async function validateWorkspaceBackup(file: File | null) {
    if (!file || mutating) return;
    setRecoveryPreview(null); setRecoveryConfirmation(""); setRecoveryFileName(file.name); setError(""); setNotice("");
    if (file.size > 1_500_000) { setError("This backup exceeds the 1.5 MB in-app restore limit."); return; }
    setMutating("recovery-validate");
    try {
      const body = await file.text();
      const response = await fetch("/v1/admin/recovery/restore/validate", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body,
      });
      const result = await response.json() as { error?: string; restore?: RecoveryPreview };
      if (!response.ok || !result.restore) { setError(result.error || "The backup could not be validated."); return; }
      setRecoveryPreview(result.restore);
      setNotice("Backup authenticated and validated. Nothing has been restored yet.");
    } catch {
      setError("The backup could not be validated. Workspace data was not changed.");
    } finally { setMutating(""); }
  }

  async function cancelWorkspaceRestore() {
    if (!recoveryPreview || mutating) return;
    setMutating("recovery-cancel"); setError("");
    try {
      const response = await fetch(`/v1/admin/recovery/restore/${recoveryPreview.id}`, {
        method: "DELETE", credentials: "include",
      });
      if (!response.ok && response.status !== 404) { setError("The staged restore could not be cancelled."); return; }
      setRecoveryPreview(null); setRecoveryConfirmation(""); setRecoveryFileName("");
      setNotice("Staged restore cancelled. Workspace data was not changed.");
    } finally { setMutating(""); }
  }

  async function commitWorkspaceRestore() {
    if (!recoveryPreview || recoveryConfirmation !== recoveryPreview.confirmation || mutating) return;
    setMutating("recovery-commit"); setError(""); setNotice("");
    try {
      const response = await fetch(`/v1/admin/recovery/restore/${recoveryPreview.id}`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: recoveryConfirmation }),
      });
      const result = await response.json() as {
        error?: string; code?: string; blocking_operation?: string; retry_after_seconds?: number;
      };
      if (!response.ok) {
        if (response.status === 409 && result.code === "workspace_operation_in_progress") {
          const blocker = result.blocking_operation === "revenue_analysis"
            ? "Revenue analysis is still running"
            : "Another workspace restore is still running";
          setError(`${blocker}. This validated restore remains staged; retry in about ${result.retry_after_seconds || 1} seconds.`);
          return;
        }
        setError(result.error || "The restore did not commit. Workspace data was not changed.");
        if ((response.status === 409 && result.code === "restore_conflict") || response.status === 410) {
          setRecoveryPreview(null); setRecoveryConfirmation("");
        }
        return;
      }
      setRecoveryPreview(null); setRecoveryConfirmation(""); setRecoveryFileName("");
      setNotice("Workspace restored from the encrypted backup.");
      await Promise.all([load(), loadContacts()]);
    } finally { setMutating(""); }
  }

  async function recalculateScores() {
    if (mutating) return;
    setMutating("scoring"); setError("");
    try {
      const response = await fetch("/v1/admin/scoring/recalculate", { method: "POST", credentials: "include" });
      if (!response.ok) { setError("Lead scoring could not be completed."); return; }
      await load();
    } finally { setMutating(""); }
  }

  async function createSavedView(event: FormEvent) {
    event.preventDefault();
    if (!viewName.trim() || mutating) return;
    if (customFilters.some((filter) => !customFilterComplete(filter))) {
      setError("Complete or remove every custom-field filter before saving this view.");
      return;
    }
    setMutating("view"); setError("");
    try {
      const existing = control?.saved_views.find((view) => view.id === editingSavedViewId);
      const response = await fetch(existing ? `/v1/admin/saved-views/${existing.id}` : "/v1/admin/saved-views", {
        method: existing ? "PATCH" : "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: viewName, object_type: "contact", visibility: viewVisibility, columns: viewColumns,
          sorts: [{ field: contactSort, direction: contactDirection }], ...(existing ? { expected_revision: existing.revision } : {}), filters: {
          stage: filterStage || null, status: filterStatus || null, owner: filterOwner || null,
          source: filterSource || null, attention: attentionOnly, query: query || null,
          sort: contactSort, direction: contactDirection, custom: customFilters,
        } }),
      });
      const result = await response.json() as { error?: string };
      if (response.status === 409) {
        setError("This view changed in another session. The latest version has been loaded; review it before saving again.");
        setEditingSavedViewId(""); await load({ preserveError: true }); return;
      }
      if (!response.ok) { setError(result.error || "The view could not be saved."); return; }
      setViewName(""); setEditingSavedViewId(""); await load();
      setNotice(existing ? "Saved view updated." : "Current view saved.");
    } finally { setMutating(""); }
  }

  function applySavedView(view: SavedView) {
    try {
      const filters = JSON.parse(view.filters) as {
        stage?: string | null; status?: string | null; owner?: string | null; source?: string | null;
        attention?: boolean; query?: string | null; sort?: string; direction?: string;
        custom?: ContactCustomFilter[];
      };
      setFilterStage(filters.stage || "");
      setFilterStatus(filters.status || ""); setFilterOwner(filters.owner || ""); setFilterSource(filters.source || "");
      setAttentionOnly(Boolean(filters.attention)); setQuery(filters.query || "");
      setCustomFilters(Array.isArray(filters.custom) ? filters.custom : []);
      setContactSort(filters.sort || "recent"); setContactDirection(filters.direction || "desc");
      const columns = JSON.parse(view.columns || "[]");
      setViewColumns(Array.isArray(columns) && columns.length ? columns : ["identity", "company", "score", "stage", "owner"]);
      setViewName(view.name); setViewVisibility(view.visibility); setActiveSavedViewId(view.id); setEditingSavedViewId("");
      setAdvancedFiltersOpen(Boolean(filters.owner || filters.source || filters.custom?.length ||
        (filters.sort && filters.sort !== "recent") || (filters.direction && filters.direction !== "desc")));
      setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false);
    } catch {
      setError("This saved view is unreadable and was not applied.");
    }
  }

  async function deleteSavedView(view: SavedView) {
    if (savedViewDeleteArmed !== view.id) { setSavedViewDeleteArmed(view.id); return; }
    if (mutating) return;
    setMutating(`delete-view:${view.id}`); setError("");
    try {
      const response = await fetch(`/v1/admin/saved-views/${view.id}?expected_revision=${view.revision}`, { method: "DELETE", credentials: "include" });
      if (response.status === 409) {
        setSavedViewDeleteArmed(""); setError("This view changed before deletion. The latest version has been loaded.");
        await load({ preserveError: true }); return;
      }
      if (!response.ok) { const result = await response.json().catch(() => ({})) as { error?: string }; setError(result.error || "The saved view could not be deleted."); return; }
      if (activeSavedViewId === view.id) setActiveSavedViewId("");
      if (editingSavedViewId === view.id) setEditingSavedViewId("");
      setSavedViewDeleteArmed(""); await load(); setNotice("Saved view deleted.");
    } finally { setMutating(""); }
  }

  async function bulkUpdateContacts() {
    const ownerChangeReady = bulkOwnerAction === "unassign" || (bulkOwnerAction === "assign" && Boolean(bulkOwner.trim()));
    if (!selectedIds.length || (!bulkStage && !bulkStatus && !ownerChangeReady) || mutating) return;
    setMutating("bulk"); setError(""); setNotice("");
    try {
      const response = await fetch("/v1/admin/contacts/bulk", {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: selectedIds,
          versions: Object.fromEntries(contactRows.filter((contact) => selectedIds.includes(contact.id)).map((contact) => [contact.id, contact.updated_at])),
          ...(bulkStage ? { stage: bulkStage } : {}),
          ...(bulkStatus ? { status: bulkStatus } : {}),
          ...(bulkOwnerAction === "assign" ? { owner: bulkOwner.trim() } : {}),
          ...(bulkOwnerAction === "unassign" ? { owner: null } : {}),
        }),
      });
      const result = await response.json() as { updated_at?: string; error?: string; code?: string };
      if (response.status === 409) {
        setError("One or more selected leads changed in another session. The latest records have been reloaded; review and try again.");
        setSelectedIds([]);
        await load();
        return;
      }
      if (response.status === 428) {
        setError(result.error || "This CRM tab is out of date. Refresh it, review the latest lead records, and try again.");
        setSelectedIds([]);
        await load();
        return;
      }
      if (!response.ok || !result.updated_at) { setError(result.error || "The selected leads could not be updated."); return; }
      const changedIds = new Set(selectedIds);
      const appliedStage = bulkStage;
      const appliedStatus = bulkStatus;
      const appliedOwner = bulkOwnerAction === "assign" ? bulkOwner.trim() : bulkOwnerAction === "unassign" ? null : undefined;
      setSelectedIds([]); setBulkStage(""); setBulkStatus(""); setBulkOwnerAction("keep"); setBulkOwner(""); setBulkReviewOpen(false);
      await Promise.all([load(), loadContacts()]);
      setData((current) => current ? {
        ...current,
        contacts: current.contacts.map((contact) => changedIds.has(contact.id) ? {
          ...contact,
          ...(appliedStage ? { stage: appliedStage } : {}),
          ...(appliedStatus ? { status: appliedStatus } : {}),
          ...(appliedOwner !== undefined ? { owner: appliedOwner } : {}),
          updated_at: result.updated_at as string,
        } : contact),
      } : current);
      setNotice(`${changedIds.size} ${changedIds.size === 1 ? "lead" : "leads"} updated.`);
    } finally { setMutating(""); }
  }

  function qualifyContact(contact: Contact) {
    setOpportunityContactId(contact.id);
    setOpportunityName(contact.company ? `${contact.company} opportunity` : `${contact.email} opportunity`);
    setDeleteArmed(false); setSelected(null); setDetail(null);
    setSelectedCompanyId(""); setCompanyDetail(null);
    setActiveView("pipeline");
    setNotice("Lead selected. Confirm the opportunity name and value, then create it.");
  }

  async function analyzePipeline() {
    setAgentRunning(true); setError("");
    try {
      const response = await fetch("/v1/admin/agent/analyze", { method: "POST", credentials: "include" });
      const result = await response.json() as (AgentRunSummary & {
        error?: string; code?: string; blocking_operation?: string; retry_after_seconds?: number;
      });
      if (response.status === 409 && result.code === "agent_run_in_progress") {
        const blocker = result.blocking_operation === "workspace_restore"
          ? "A workspace restore is running. Revenue analysis is paused"
          : "A revenue-agent analysis is already running in another session";
        setError(`${blocker}. Retry in about ${result.retry_after_seconds || 1} seconds.`);
        await load({ preserveError: true });
        return;
      }
      if (!response.ok) { setError(result.error || "The pipeline agent could not complete its analysis."); return; }
      setAgentRun(result);
      await load();
    } catch {
      setError("The pipeline agent could not complete its analysis.");
    } finally {
      setAgentRunning(false);
    }
  }

  async function toggleWorkspaceAgentAccess() {
    if (!control?.agent_policy || mutating) return;
    const nextEnabled = !Boolean(control.agent_policy.agent_access_enabled);
    setMutating("agent-policy"); setError("");
    try {
      const response = await fetch("/v1/admin/agent-policy", {
        method: "PATCH", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_access_enabled: nextEnabled }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) { setError(result.error || "Workspace agent access could not be changed."); return; }
      setAgentDisableArmed(false);
      await load();
    } finally { setMutating(""); }
  }

  async function decideProposal(proposalId: string, decision: "approved" | "rejected") {
    if (proposalDecisionArmed?.id !== proposalId || proposalDecisionArmed.decision !== decision) {
      setProposalDecisionArmed({ id: proposalId, decision });
      return;
    }
    if (mutating) return;
    setMutating(`proposal:${proposalId}`); setError("");
    try {
      const response = await fetch(`/v1/admin/agent/proposals/${proposalId}/decision`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ decision }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        setError(result.error || "The proposal decision could not be completed.");
        await load();
        return;
      }
      setAgentRun((current) => current ? { ...current } : current);
      await load();
    } finally {
      setProposalDecisionArmed(null);
      setMutating("");
    }
  }

  async function createAgentCredential(event: FormEvent) {
    event.preventDefault();
    if (!agentCredentialName.trim() || mutating) return;
    setMutating("agent-credential"); setError("");
    try {
      const response = await fetch("/v1/admin/agent-credentials", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          name: agentCredentialName, provider: agentProvider,
          scopes: agentAccessPresets[agentAccessPreset].scopes, rate_limit_per_minute: 60,
        }),
      });
      const result = await response.json() as { credential?: { api_key: string }; error?: string };
      if (!response.ok || !result.credential) { setError(result.error || "The agent credential could not be created."); return; }
      setNewAgentKey(result.credential.api_key); setAgentCredentialName(""); await load();
    } finally { setMutating(""); }
  }

  async function revokeAgentCredential(credentialId: string) {
    if (mutating) return;
    if (agentCredentialArmed !== `revoke:${credentialId}`) {
      setAgentCredentialArmed(`revoke:${credentialId}`);
      return;
    }
    setMutating(`agent-revoke:${credentialId}`); setError("");
    try {
      const response = await fetch(`/v1/admin/agent-credentials/${credentialId}`, { method: "DELETE", credentials: "include" });
      if (response.ok) {
        setAgentCredentialArmed("");
        setNotice("Agent access revoked immediately.");
        await load();
      } else setError("The agent credential could not be revoked.");
    } finally { setMutating(""); }
  }

  async function rotateAgentCredential(credential: AgentCredential) {
    if (mutating) return;
    if (agentCredentialArmed !== `rotate:${credential.id}`) {
      setAgentCredentialArmed(`rotate:${credential.id}`);
      return;
    }
    setMutating(`agent-rotate:${credential.id}`); setError(""); setNewAgentKey("");
    try {
      const response = await fetch(`/v1/admin/agent-credentials/${credential.id}/rotate`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_key_prefix: credential.key_prefix }),
      });
      const result = await response.json() as { credential?: { api_key: string }; error?: string };
      if (!response.ok || !result.credential) {
        setError(result.error || "The agent credential could not be rotated.");
        await load();
        return;
      }
      setNewAgentKey(result.credential.api_key);
      setAgentCredentialArmed("");
      setNotice(`${credential.name} rotated. The previous key no longer works.`);
      await load();
    } finally { setMutating(""); }
  }

  async function deleteSelectedContact() {
    if (!selected || !canAdmin || !deleteArmed) return;
    const response = await fetch(`/v1/admin/contacts/${selected.id}`, { method: "DELETE", credentials: "include" });
    if (response.ok) {
      setDeleteArmed(false); setSelected(null); setDetail(null);
      await Promise.all([load(), loadContacts(), selectedCompanyId ? refreshCompanyDetail(selectedCompanyId) : Promise.resolve(null)]);
      await refreshContactTotals();
      setNotice("Contact deleted.");
    }
    else setError("The contact could not be deleted.");
  }

  const filtered = contactRows;
  const selectedCustomObject = customObjects.find((definition) => definition.id === selectedCustomObjectId) || null;
  const activeCustomObjectView = customObjectViews.find((view) => view.id === activeCustomObjectViewId) || null;
  const listCustomFields = customFields.filter((field) =>
    field.object_type === "contact" && field.active && viewColumns.includes(`custom:${field.field_key}`));
  const contactTableColumns = `2fr 1fr 1fr ${listCustomFields.map(() => "minmax(120px,1fr)").join(" ")} .8fr 1fr`;
  const advancedFilterCount = Number(Boolean(filterOwner)) + Number(Boolean(filterSource))
    + Number(contactSort !== "recent") + Number(contactDirection !== "desc") + customFilters.length;
  const outboundDeliveries = (control?.deliveries ?? []).filter((delivery) => delivery.direction === "outbound");
  const webhookDueCount = outboundDeliveries.filter((delivery) =>
    delivery.status === "retrying" && Boolean(delivery.next_attempt_at) && Date.parse(delivery.next_attempt_at || "") <= webhookClock).length;
  const webhookRetryingCount = outboundDeliveries.filter((delivery) => delivery.status === "retrying").length;
  const webhookFailedCount = outboundDeliveries.filter((delivery) => delivery.status === "failed").length;
  const webhookHealthLabel = webhookFailedCount ? `${webhookFailedCount} FAILED`
    : webhookRetryingCount ? `${webhookRetryingCount} RETRYING`
      : outboundDeliveries.length ? "DELIVERY HEALTHY" : "NO OUTBOUND PROOF";
  const leadInbox = leadView === "inbox" ? contactRows : [];
  const visibleLeadIds = leadInbox.map((contact) => contact.id);
  const availableContacts = useMemo(() => {
    const byId = new Map<string, Contact>();
    for (const contact of [...contactRows, ...(data?.contacts ?? [])]) byId.set(contact.id, contact);
    return [...byId.values()];
  }, [contactRows, data]);
  const selectedOpportunityContactId = availableContacts.some((contact) => contact.id === opportunityContactId)
    ? opportunityContactId
    : availableContacts[0]?.id || "";
  const selectedPipelineId = control?.pipelines.some((pipeline) => pipeline.id === activePipelineId)
    ? activePipelineId
    : control?.pipelines[0]?.id || "";
  const selectedPipeline = control?.pipelines.find((pipeline) => pipeline.id === selectedPipelineId);
  const selectedPipelineStages = (control?.stages ?? [])
    .filter((stage) => stage.pipeline_id === selectedPipelineId)
    .sort((left, right) => left.position - right.position);
  const selectedPipelineOpportunities = (control?.opportunities ?? [])
    .filter((opportunity) => opportunity.pipeline_id === selectedPipelineId);
  const selectedOpportunity = (control?.opportunities ?? []).find((opportunity) => opportunity.id === selectedOpportunityId) || null;
  const selectedOpportunityStage = selectedOpportunity
    ? (control?.stages ?? []).find((stage) => stage.id === selectedOpportunity.stage_id) || null
    : null;
  const selectedOpportunityTasks = selectedOpportunity
    ? (control?.tasks ?? []).filter((task) => task.opportunity_id === selectedOpportunity.id)
    : [];
  const taskCalendarRange = calendarMonthRange(calendarMonth);
  const calendarEventsByDay = new Map<string, CalendarEvent[]>();
  for (const event of calendarData?.events ?? []) {
    const parsed = new Date(event.starts_at);
    if (!Number.isFinite(parsed.getTime())) continue;
    const key = localDateKey(parsed);
    calendarEventsByDay.set(key, [...(calendarEventsByDay.get(key) ?? []), event]);
  }
  const selectedOpportunityWork = selectedOpportunity
    ? (control?.agent_work_items ?? []).filter((item) => item.opportunity_id === selectedOpportunity.id)
    : [];
  const selectedOpportunityProposals = selectedOpportunity
    ? (control?.proposals ?? []).filter((proposal) => proposal.opportunity_id === selectedOpportunity.id)
    : [];
  const selectedOpportunityAudits = selectedOpportunity
    ? (control?.audits ?? []).filter((entry) => entry.entity_type === "opportunity" && entry.entity_id === selectedOpportunity.id)
    : [];
  const selectedOpportunityForecast = selectedOpportunity
    ? selectedOpportunity.value * selectedOpportunity.probability / 100
    : 0;
  const selectedCompany = (control?.companies ?? []).find((company) => company.id === selectedCompanyId) ||
    (companyDetail?.company.id === selectedCompanyId ? companyDetail.company : null);
  const allVisibleSelected = visibleLeadIds.length > 0 && visibleLeadIds.every((id) => selectedIds.includes(id));
  const canAdmin = control?.role === "owner" || control?.role === "admin";
  // Never strand a demoted/reloaded member on the admin-only Agents panel.
  // Keep the stored choice for a later authorized session, but render a valid
  // tab and panel for the role that is authoritative right now.
  const visibleIntegrationDomain = !canAdmin && integrationDomain === "agents"
    ? "mailboxes" : integrationDomain;
  const implementedIntegrations = productCatalog?.integrations.filter((integration) =>
    integration.availability === "implemented") ?? [];
  const configuredIntegrations = implementedIntegrations.filter((integration) =>
    integration.runtime.configured);
  const plannedIntegrations = productCatalog?.integrations.filter((integration) =>
    integration.availability === "planned") ?? [];
  const mailboxConnections = mailboxes?.connections ?? [];
  const mailboxAttentionStatuses = new Set<MailboxConnection["status"]>(["pending", "expired", "error"]);
  const mailboxNeedsAttention = mailboxConnections.some((connection) =>
    mailboxAttentionStatuses.has(connection.status));
  const attentionIntegrationIds = new Set<string>(
    mailboxConnections
      .filter((connection) => mailboxAttentionStatuses.has(connection.status) &&
        !mailboxConnections.some((candidate) =>
          candidate.provider === connection.provider && candidate.status === "active"))
      .map((connection) => connection.provider),
  );
  const installedIntegrationIds = new Set<string>([
    ...mailboxConnections.filter((connection) => connection.status === "active")
      .map((connection) => connection.provider),
    ...(resendData?.connection?.status === "active" ? ["resend"] : []),
    ...sources.filter((source) => source.active && source.slug === "skool-community").map(() => "skool"),
    ...(visitorIntent?.connectors ?? []).filter((connector) => connector.active).map((connector) => connector.provider),
    ...agentCredentials.filter((credential) => credential.active &&
      (!credential.expires_at || Date.parse(credential.expires_at) > taskClock))
      .map((credential) => credential.provider).filter((provider) =>
      provider === "openclaw" || provider === "hermes"),
    ...(control?.webhooks ?? []).filter((hook) => hook.active)
      .map((hook) => hook.direction === "inbound" ? "inbound-webhook" : "outbound-webhook"),
  ]);
  const catalogIntegrations = (productCatalog?.integrations ?? []).filter((integration) =>
    integrationCatalogView === "catalog" || installedIntegrationIds.has(integration.id));
  const selectedIntegration = productCatalog?.integrations.find((integration) =>
    integration.id === selectedIntegrationId) ?? null;
  const integrationDomainFor = (id: string): IntegrationDomain =>
    id === "gmail" || id === "outlook" || id.includes("calendar") || id === "resend" ? "mailboxes"
      : id === "openclaw" || id === "hermes" ? "agents"
        : id.includes("webhook") ? "webhooks" : "sources";
  const integrationDestinationFor = (id: string) =>
    id === "audiencelab" || id === "rb2b" ? "VISITOR INTENT"
      : id === "resend" ? "TRANSACTIONAL EMAIL"
        : id === "skool" ? "SKOOL"
          : id === "inbound-webhook" ? "INBOUND WEBHOOK"
            : id === "outbound-webhook" ? "OUTBOUND WEBHOOK"
              : integrationDomainFor(id).toUpperCase();
  const openIntegrationSetup = (id: string, trigger: HTMLElement) => {
    integrationReturnFocusRef.current = trigger;
    setSelectedIntegrationId(id);
  };
  const focusIntegrationDestination = (id: string) => {
    window.setTimeout(() => {
      const domain = integrationDomainFor(id);
      const target = id === "audiencelab" || id === "rb2b" ? document.getElementById("visitor-provider")
        : id === "resend" ? document.getElementById("resend-command")
          : id === "gmail" || id === "outlook"
            ? document.querySelector<HTMLElement>(`[data-mailbox-provider="${id}"][data-mailbox-actionable="true"]`)
              || document.getElementById("mailbox-provider")
            : id === "openclaw" || id === "hermes"
              ? document.querySelector<HTMLElement>(`[data-agent-provider="${id}"][data-agent-active="true"]`)
                || document.getElementById("agent-provider")
              : id === "skool" ? document.getElementById("skool-connector")
                : id === "inbound-webhook" || id === "outbound-webhook"
                  ? document.querySelector<HTMLElement>(`[data-webhook-direction="${id === "inbound-webhook" ? "inbound" : "outbound"}"]`)
                    || document.getElementById("webhook-direction")
                  : document.getElementById(`integration-tab-${domain}`);
      target?.focus();
      target?.scrollIntoView({ block: id === "audiencelab" || id === "rb2b" ? "center" : "start", behavior: "smooth" });
    }, 0);
  };
  const continueIntegrationSetup = (id: string) => {
    if (id === "audiencelab" || id === "rb2b") {
      setVisitorConnectorProvider(id);
      setSelectedIntegrationId("");
      setActiveView("leads");
      setLeadView("visitors");
      focusIntegrationDestination(id);
      return;
    }
    const domain = integrationDomainFor(id);
    if (id === "gmail" || id === "outlook") setMailboxProvider(id);
    if (id === "openclaw" || id === "hermes") setAgentProvider(id);
    if (id === "inbound-webhook" || id === "outbound-webhook") {
      setWebhookDirection(id === "inbound-webhook" ? "inbound" : "outbound");
    }
    setSelectedIntegrationId("");
    setIntegrationDomain(domain);
    setIntegrationCatalogOpen(false);
    focusIntegrationDestination(id);
  };
  const automationDebugRun = control?.runs.find((run) => run.id === automationDebugRunId) || null;
  const automationDebugTrace = automationRunTrace(automationDebugRun);
  const automationRuns = control?.runs ?? [];
  const effectiveCredentialStatus = (credential: AgentCredential): AgentCredential["lifecycle_status"] =>
    !credential.active ? "revoked"
      : credential.expires_at && Date.parse(credential.expires_at) <= taskClock ? "expired"
        : credential.lifecycle_status;
  const activeAgentCredentials = agentCredentials.filter((credential) => effectiveCredentialStatus(credential) === "active");
  const historicalAgentCredentials = agentCredentials.filter((credential) => effectiveCredentialStatus(credential) !== "active");
  const availableAgentProviders = [...new Set(agentCredentials
    .filter((credential) => effectiveCredentialStatus(credential) === "active")
    .map((credential) => credential.provider)
    .filter((provider): provider is "openclaw" | "hermes" => provider === "openclaw" || provider === "hermes"))];
  const observedAgentProviders = [...new Set(agentCredentials
    .filter((credential) => effectiveCredentialStatus(credential) === "active" && Boolean(credential.last_used_at))
    .map((credential) => credential.provider)
    .filter((provider): provider is "openclaw" | "hermes" => provider === "openclaw" || provider === "hermes"))];
  const agentAccessEnabled = Boolean(control?.agent_policy?.agent_access_enabled);
  const outboundWebhookEventTypes = [...new Set((control?.webhooks ?? [])
    .filter((webhook) => webhook.direction === "outbound" && Boolean(webhook.active))
    .flatMap((webhook) => {
      try {
        const parsed = JSON.parse(webhook.event_types);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
      } catch { return []; }
    }))];
  const automationRetryByParent = new Map(
    automationRuns
      .filter((run) => Boolean(run.retry_of_run_id))
      .map((run) => [run.retry_of_run_id as string, run]),
  );
  const visibleAutomationRuns = automationRuns
    .filter((run) => automationRunFilter === "all" || run.status === automationRunFilter)
    .slice(0, 25);
  const contactTimeline = detail ? [
    ...detail.notes.map((item) => ({
      id: item.id, kind: "note" as const, title: "Operator note", body: item.body,
      actor: item.author, occurred_at: item.created_at, note: item,
    })),
    ...detail.activities.map((item) => ({
      id: item.id, kind: "activity" as const, title: item.title, body: item.body,
      actor: item.type, occurred_at: item.occurred_at, note: null,
    })),
  ].sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at)) : [];
  const companyTimeline = companyDetail ? [
    ...companyDetail.company_notes.map((item) => ({
      id: item.id, kind: "company-note" as const, title: "Company note", body: item.body,
      actor: item.author, occurred_at: item.created_at, note: item, contact_id: null,
    })),
    ...companyDetail.contact_notes.map((item) => ({
      id: item.id, kind: "contact-note" as const, title: `Contact note · ${item.contact_first_name || item.contact_email || "Contact"}`,
      body: item.body, actor: item.author, occurred_at: item.created_at, note: null, contact_id: item.contact_id || null,
    })),
    ...companyDetail.activities.map((item) => ({
      id: item.id, kind: "activity" as const, title: `${item.title} · ${item.contact_first_name || item.contact_email}`,
      body: item.body, actor: item.type, occurred_at: item.occurred_at, note: null, contact_id: item.contact_id,
    })),
    ...companyDetail.audits.map((item) => ({
      id: item.id, kind: "audit" as const, title: item.action, body: null,
      actor: item.actor_id, occurred_at: item.created_at, note: null, contact_id: null,
    })),
  ].sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at)) : [];
  const selectedName = selected
    ? [selected.first_name, selected.last_name].filter(Boolean).join(" ") || selected.email
    : "";
  const selectedInitials = selected
    ? ([selected.first_name, selected.last_name].filter(Boolean).map((value) => String(value)[0]).join("") || selected.email[0]).slice(0, 2).toUpperCase()
    : "";
  const renderAgentCredentialCard = (credential: AgentCredential) => {
    const status = effectiveCredentialStatus(credential);
    const isActive = status === "active";
    const canRevoke = Boolean(credential.active);
    return <article className={`source-card agent-credential-card ${status}`} key={credential.id}
      data-agent-provider={credential.provider} data-agent-active={isActive} tabIndex={-1}>
      <div><i className={isActive ? "on" : ""}></i><span>{status.toUpperCase()}</span></div>
      <h3>{credential.name}</h3><code>{credential.provider} · {credential.key_prefix}••••</code>
      <small>{scopeLabels(credential.scopes)} · {credential.rate_limit_per_minute}/min</small>
      <small>{credential.last_used_at ? `Last used ${new Date(credential.last_used_at).toLocaleString()}` : "Never used"}</small>
      <small>Created {new Date(credential.created_at).toLocaleString()} by {credential.created_by}</small>
      {credential.expires_at && <small>{status === "expired" ? "Expired" : "Expires"} {new Date(credential.expires_at).toLocaleString()}</small>}
      {credential.revoked_at && <small>Revoked {new Date(credential.revoked_at).toLocaleString()}</small>}
      {agentCredentialArmed === `rotate:${credential.id}` && <small>The current key will stop working immediately. Copy the replacement key before leaving this page.</small>}
      {(isActive || canRevoke) && <div className="credential-actions">
        {isActive && <button disabled={Boolean(mutating)} onClick={() => void rotateAgentCredential(credential)}>
          {mutating === `agent-rotate:${credential.id}` ? "ROTATING..." :
            agentCredentialArmed === `rotate:${credential.id}` ? "CONFIRM ROTATE + INVALIDATE OLD KEY" : "ROTATE KEY"}
        </button>}
        {canRevoke && <button disabled={Boolean(mutating)} onClick={() => void revokeAgentCredential(credential.id)}>
          {mutating === `agent-revoke:${credential.id}` ? "REVOKING..." :
            agentCredentialArmed === `revoke:${credential.id}` ? "CONFIRM REVOKE ACCESS" :
              status === "expired" ? "REVOKE EXPIRED KEY" : "REVOKE ACCESS"}
        </button>}
        {agentCredentialArmed.endsWith(`:${credential.id}`) && <button className="secondary" disabled={Boolean(mutating)}
          onClick={() => setAgentCredentialArmed("")}>CANCEL</button>}
      </div>}
    </article>;
  };

  if (needsLogin) {
    return <main className="login-shell"><section className="login-card">
      <div className="logo-box">CR</div><p className="eyebrow">PRIVATE REVENUE SYSTEM</p>
      <h1>OpenOperator<br/><em>Command Center.</em></h1>
      <p>Contacts, pipeline, purchases, and activity from every connected funnel.</p>
      <a className="login-button" href="/signin-with-chatgpt?return_to=%2F">SIGN IN TO ENTER <span>→</span></a>
      {error && <p className="form-error">{error}</p>}
    </section></main>;
  }

  return <main className="crm-shell">
    <aside className="sidebar">
      <div className="brand"><span>OO</span><b>OPENOPERATOR<small>OPERATIONS CRM</small></b></div>
      <div className="workspace-identity" aria-label="Current workspace">
        <span>O</span><div><b>{control?.workspace.name || "My workspace"}</b><small>Private workspace</small></div>
      </div>
      <nav aria-label="CRM workspace">
        {(["Workspace", "Intelligence", "System"] as const).map((group) => <div className="nav-group" key={group}>
          <p>{group}</p>
          {workspaceViews.filter((view) => view.group === group && (!view.adminOnly || canAdmin)).map((view) => <button key={view.id} className={activeView === view.id ? "active" : ""} aria-label={view.label} title={view.label} aria-current={activeView === view.id ? "page" : undefined} onClick={() => { setActiveView(view.id); setError(""); setNotice(""); if (view.id === "agent") void load(); }}>
            <i aria-hidden="true">{view.icon}</i><span>{view.label}</span>
          </button>)}
        </div>)}
      </nav>
      <div className="connection"><i></i><div><b>Workspace protected</b><span>Isolated and audited</span></div></div>
    </aside>
    <section className="workspace" id="dashboard" data-view={activeView}>
      <header className="topbar"><div><p>{control?.workspace.name || "MY WORKSPACE"} <b>/</b> {activeView.toUpperCase()}</p><h1>{activeView === "dashboard"
        ? <GradientText colors={["#3457d5", "#6857d9", "#3457d5"]} animationSpeed={8} pauseOnHover>Dashboard</GradientText>
        : workspaceViews.find((view) => view.id === activeView)?.label}</h1><small>{activeView === "dashboard" ? "Live revenue command center" : "Workspace operations"}</small></div>
        <div className="top-actions">{activeView === "leads" && leadView !== "visitors" && <input aria-label="Search contacts" placeholder="Search contacts..." value={query} onChange={(e) => { setQuery(e.target.value); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }} />}
          <button ref={commandTriggerRef} type="button" className="command-trigger" aria-haspopup="dialog" aria-expanded={commandOpen} onClick={() => setCommandOpen(true)}><span>SEARCH + JUMP</span><kbd>CTRL K</kbd></button>
          <span className="live-chip"><i></i>LIVE</span><button onClick={() => void load()} disabled={loading}>↻ {loading ? "LOADING" : "REFRESH"}</button></div></header>
      {error && <div className="error-banner">{error}</div>}
      {!error && notice && <div className="notice-banner" role="status">{notice}</div>}
      {activeView === "leads" && <nav className="lead-view-switcher" aria-label="Lead workspace">
        {(["inbox", "contacts", "companies", "visitors"] as LeadView[]).map((view) => <button type="button" key={view} className={leadView === view ? "active" : ""} aria-pressed={leadView === view} onClick={() => { setLeadView(view); setContactPage(1); setContactRows([]); setSelectedIds([]); setBulkReviewOpen(false); }}>
          {view === "inbox" ? `Lead Inbox (${inboxTotal})` : view === "contacts" ? `All Contacts (${allContactsTotal || data?.metrics.contacts || 0})` :
            view === "companies" ? `Companies (${control?.companies.length ?? 0})` : `Visitor Intent (${visitorIntent?.counts.new ?? 0})`}
        </button>)}
      </nav>}
      <ConversationsWorkspace active={activeView === "conversations"}/>
      <FormsWorkspace active={activeView === "forms"} canAdmin={Boolean(canAdmin)}/>
      <SurveysWorkspace active={activeView === "surveys"} canAdmin={Boolean(canAdmin)}/>
      <SitesWorkspace active={activeView === "sites"} canAdmin={Boolean(canAdmin)}/>
      <MarketingWorkspace active={activeView === "marketing"} canAdmin={Boolean(canAdmin)}/>
      <ReviewRequestsWorkspace active={activeView === "reviews"} canAdmin={Boolean(canAdmin)}/>
      <BookingWorkspace active={activeView === "booking"} canAdmin={Boolean(canAdmin)}/>
      <ReportingWorkspace active={activeView === "reports"}/>
      <PaymentsWorkspace active={activeView === "payments" && Boolean(canAdmin)}/>
      <section className="metrics" hidden={activeView !== "dashboard"}>
        <article><i aria-hidden="true">◎</i><span>TOTAL CONTACTS</span><strong>{data?.metrics.contacts ?? "—"}</strong><small>Across connected sources</small></article>
        <article><i aria-hidden="true">↗</i><span>CUSTOMERS</span><strong>{data?.metrics.customers ?? "—"}</strong><small>Paying relationships</small></article>
        <article className="accent"><i aria-hidden="true">$</i><span>ATTRIBUTED REVENUE</span><strong>{data ? money(data.metrics.revenue) : "—"}</strong><small>Closed and collected</small></article>
        <article><i aria-hidden="true">!</i><span>FOLLOW-UPS DUE</span><strong>{data?.metrics.followUps ?? "—"}</strong><small>Need operator attention</small></article>
      </section>
      <section className="briefing-panel" id="briefing" hidden={activeView !== "dashboard"}><div className="section-head"><div><p>EXECUTIVE BRIEFING</p><h2>What needs attention right now.</h2></div><div className="briefing-actions"><button disabled={Boolean(mutating)} onClick={() => void recalculateScores()}>{mutating === "scoring" ? "SCORING…" : "RECALCULATE SCORES"}</button><button disabled={loading} onClick={() => void load()}>REFRESH BRIEFING</button></div></div>
        <div className="briefing-metrics"><article><span>OPEN PIPELINE</span><strong>{money(briefing?.metrics.open_pipeline || 0)}</strong></article><article><span>WEIGHTED FORECAST</span><strong>{money(briefing?.metrics.weighted_forecast || 0)}</strong></article><article><span>STALLED DEALS</span><strong>{briefing?.metrics.stalled_deals ?? 0}</strong></article><article><span>OVERDUE TASKS</span><strong>{briefing?.metrics.overdue_tasks ?? 0}</strong></article></div>
        <div className="briefing-grid"><article><p className="eyebrow">TOP LEADS</p>{(briefing?.top_leads ?? []).slice(0, 5).map((lead) => <button type="button" className="brief-row" aria-label={`Open ${lead.email} contact record`} key={lead.id} onClick={() => void openContactById(lead.id)}><b>{lead.score}</b><span><strong>{[lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email}</strong><small>{lead.reasons.join(" · ") || "Not enough qualification evidence yet"}</small></span><i aria-hidden="true">OPEN</i></button>)}{!briefing?.top_leads.length && <div className="empty-state">No leads to score yet.</div>}</article>
          <article><p className="eyebrow">STALLED OPPORTUNITIES</p>{(briefing?.stalled_opportunities ?? []).slice(0, 5).map((opportunity) => <button type="button" className="brief-row" aria-label={`Open ${opportunity.name} opportunity workspace`} key={opportunity.id} onClick={() => { setActiveView("pipeline"); setActivePipelineId(opportunity.pipeline_id); void openOpportunityWorkspace(opportunity); }}><b>!</b><span><strong>{opportunity.name}</strong><small>{opportunity.next_step || "No next step"} · {money(opportunity.value)}</small></span><i aria-hidden="true">OPEN</i></button>)}{!briefing?.stalled_opportunities.length && <div className="empty-state">No stalled opportunities.</div>}</article>
          <article><p className="eyebrow">OVERDUE EXECUTION</p>{(briefing?.overdue_tasks ?? []).slice(0, 5).map((task) => <button type="button" className="brief-row" aria-label={`Open work for ${task.title}`} key={task.id} onClick={() => void openBriefingTask(task)}><b>→</b><span><strong>{task.title}</strong><small>{task.assignee || "Unassigned"} · {task.due_at ? new Date(task.due_at).toLocaleString() : "No due date"}</small></span><i aria-hidden="true">OPEN</i></button>)}{!briefing?.overdue_tasks.length && <div className="empty-state">No overdue tasks.</div>}</article></div>
      </section>
      <section className="pipeline-panel" id="pipeline" hidden={activeView !== "dashboard"}><div className="section-head"><div><p>PIPELINE SNAPSHOT</p><h2>From first touch to revenue.</h2></div><span>LIVE DATA</span></div>
        <div className="pipeline-strip">{Object.entries(stageLabels).map(([key, label]) =>
          <div key={key}><b>{data?.stages[key] ?? 0}</b><span>{label}</span></div>)}</div></section>
      <section className="sales-execution" id="lead-inbox" hidden={activeView !== "leads" || leadView !== "inbox"}>
        <div className="section-head"><div><p>SALES EXECUTION</p><h2>Qualify leads before they enter pipeline.</h2></div><div className="lead-head-actions"><span>{contactPagination.total} UNQUALIFIED</span>
          <button type="button" aria-expanded={viewManagerOpen} onClick={() => setViewManagerOpen((open) => !open)}>{viewManagerOpen ? "HIDE VIEWS" : "VIEWS"}</button>
          <button type="button" aria-expanded={leadComposerOpen} onClick={() => setLeadComposerOpen((open) => !open)}>{leadComposerOpen ? "CANCEL ADD" : "+ ADD LEAD"}</button>
        </div></div>
        <div className="view-toolbar">
          <select aria-label="Filter contact lifecycle" value={filterStage} onChange={(event) => { setFilterStage(event.target.value); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }}>
            <option value="">All lifecycle steps</option>{Object.entries(stageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          {leadView === "contacts" && <select aria-label="Filter record status" value={filterStatus} onChange={(event) => { setFilterStatus(event.target.value); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }}>
            <option value="">All record statuses</option><option value="lead">Lead</option><option value="customer">Customer</option><option value="inactive">Inactive</option>
          </select>}
          <label className="attention-toggle"><input type="checkbox" checked={attentionOnly} onChange={(event) => { setAttentionOnly(event.target.checked); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }} /> Needs attention</label>
          <button type="button" aria-expanded={advancedFiltersOpen} onClick={() => setAdvancedFiltersOpen((open) => !open)}>{advancedFiltersOpen ? "FEWER FILTERS" : `MORE FILTERS${advancedFilterCount ? ` (${advancedFilterCount})` : ""}`}</button>
          {advancedFiltersOpen && <><select aria-label="Filter contact owner" value={filterOwner} onChange={(event) => { setFilterOwner(event.target.value); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }}>
            <option value="">All owners</option><option value="__unassigned__">Unassigned</option>{contactFacets.owners.map((item) => <option key={item.owner} value={item.owner}>{item.owner} ({item.total})</option>)}
          </select>
          <select aria-label="Filter contact source" value={filterSource} onChange={(event) => { setFilterSource(event.target.value); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }}>
            <option value="">All sources</option><option value="__direct__">Direct</option>{contactFacets.sources.map((item) => <option key={item.source} value={item.source}>{item.source} ({item.total})</option>)}
          </select>
          <select aria-label="Sort contacts" value={contactSort} onChange={(event) => { setContactSort(event.target.value); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }}>
            <option value="recent">Recent activity</option><option value="name">Name</option><option value="company">Company</option><option value="score">Lead score</option><option value="follow_up">Next follow-up</option>
          </select>
          <button type="button" onClick={() => { setContactDirection((current) => current === "asc" ? "desc" : "asc"); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }}>{contactDirection === "asc" ? "ASC ↑" : "DESC ↓"}</button>
          <CustomFilterEditor fields={customFields} filters={customFilters} disabled={contactsLoading}
            onChange={(filters) => { setCustomFilters(filters); setContactPage(1); setSelectedIds([]); setBulkReviewOpen(false); }} />
          <CustomColumnPicker fields={customFields} columns={viewColumns} disabled={contactsLoading} onChange={setViewColumns} /></>}
        </div>
        {viewManagerOpen && <div className="view-manager" aria-label="Contact view manager">
          <div className="view-manager-head"><div><p className="eyebrow">OPERATOR VIEWS</p><h3>Save a trusted lead workspace.</h3><small>Filters, sort, and visible fields travel together. Private views stay yours.</small></div>
            <button type="button" onClick={() => { setEditingSavedViewId(""); setActiveSavedViewId(""); setViewName(""); setViewVisibility("private"); setViewColumns(["identity", "company", "score", "stage", "owner"]); }}>NEW VIEW</button></div>
          <div className="saved-views" aria-label="Saved contact views">{(control?.saved_views ?? []).map((view) => {
            const canManage = view.created_by === control?.current_user?.email || control?.role === "owner" || control?.role === "admin";
            return <article key={view.id} className={activeSavedViewId === view.id ? "active" : ""}>
              <button className="saved-view-apply" onClick={() => applySavedView(view)}><strong>{view.name}</strong><small>{view.visibility === "workspace" ? "WORKSPACE" : "PRIVATE"} · v{view.revision}</small></button>
              {canManage && <button aria-label={`Edit ${view.name}`} onClick={() => { applySavedView(view); setEditingSavedViewId(view.id); }}>EDIT</button>}
              {canManage && <button aria-label={`Delete ${view.name}`} disabled={Boolean(mutating)} onClick={() => void deleteSavedView(view)}>{savedViewDeleteArmed === view.id ? "CONFIRM" : "DELETE"}</button>}
              {savedViewDeleteArmed === view.id && <button aria-label={`Keep ${view.name}`} disabled={Boolean(mutating)} onClick={() => setSavedViewDeleteArmed("")}>KEEP</button>}
            </article>;
          })}{!control?.saved_views.length && <small>No saved views yet. Configure the lead workspace and save your first private view.</small>}</div>
          <form className="view-definition-form" onSubmit={createSavedView}>
            <label>VIEW NAME<input aria-label="Saved view name" placeholder="Unassigned high-intent leads" value={viewName} onChange={(event) => setViewName(event.target.value)} maxLength={100} /></label>
            <label>VISIBILITY<select aria-label="Saved view visibility" value={viewVisibility} onChange={(event) => setViewVisibility(event.target.value as "private" | "workspace")}>
              <option value="private">Private · only me</option>
              {(control?.role === "owner" || control?.role === "admin") && <option value="workspace">Workspace · all members</option>}
            </select></label>
            <fieldset><legend>VISIBLE FIELDS</legend>{[
              ["identity", "Identity"], ["company", "Company"], ["score", "Score"], ["stage", "Lifecycle"],
              ["owner", "Owner"], ["source", "Source"], ["next_follow_up", "Next follow-up"],
            ].map(([field, label]) => <label key={field}><input type="checkbox" checked={viewColumns.includes(field)} disabled={field === "identity"}
              onChange={(event) => setViewColumns((current) => event.target.checked ? [...current, field] : current.filter((item) => item !== field))} /> {label}</label>)}
              {customFields.filter((field) => field.object_type === "contact" && field.active).map((field) =>
                <label key={field.id}><input type="checkbox" checked={viewColumns.includes(`custom:${field.field_key}`)}
                  disabled={!viewColumns.includes(`custom:${field.field_key}`) && viewColumns.length >= 12}
                  onChange={(event) => setViewColumns((current) => event.target.checked
                    ? [...current, `custom:${field.field_key}`]
                    : current.filter((item) => item !== `custom:${field.field_key}`))} /> {field.label} <small>CUSTOM</small></label>)}
            </fieldset>
            <button disabled={Boolean(mutating) || !viewName.trim() || customFilters.some((filter) => !customFilterComplete(filter))}
              type="submit">{mutating === "view" ? "SAVING…" : editingSavedViewId ? "UPDATE VIEW" : "SAVE CURRENT VIEW"}</button>
            {editingSavedViewId && <button type="button" className="secondary" onClick={() => { setEditingSavedViewId(""); setViewName(""); }}>CANCEL EDIT</button>}
          </form>
        </div>}
        {leadComposerOpen && <form className="manual-lead-form" onSubmit={createLead}>
          <div><p className="eyebrow">ADD LEAD</p><small>Create a manual lead without leaving the inbox.</small></div>
          <input aria-label="Lead email" type="email" placeholder="lead@company.com" value={leadEmail} onChange={(event) => setLeadEmail(event.target.value)} required maxLength={254} />
          <input aria-label="Lead first name" placeholder="First name" value={leadFirstName} onChange={(event) => setLeadFirstName(event.target.value)} maxLength={100} />
          <input aria-label="Lead company" placeholder="Company" value={leadCompany} onChange={(event) => setLeadCompany(event.target.value)} maxLength={200} />
          <button type="submit" disabled={Boolean(mutating)}>{mutating === "lead" ? "ADDING…" : "ADD LEAD"}</button>
        </form>}
        <div className="lead-layout">
          <div className="lead-list">{leadInbox.map((contact) => <div className="lead-card" key={contact.id}>
            <input aria-label={`Select ${contact.email}`} type="checkbox" checked={selectedIds.includes(contact.id)} onChange={(event) => { setBulkReviewOpen(false); setSelectedIds((current) => event.target.checked ? [...current, contact.id] : current.filter((id) => id !== contact.id)); }} />
            <span><strong>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email}</strong><small>{contact.email}</small></span>
            {viewColumns.includes("company") && <small className="view-field"><b>COMPANY</b>{contact.company || "—"}</small>}
            {viewColumns.includes("score") && <small className="view-field"><b>SCORE</b>{contact.score}</small>}
            {viewColumns.includes("stage") && <select className="lead-quick-stage" aria-label={`Move ${contact.email} lifecycle`} disabled={Boolean(mutating)} value={contact.stage} onChange={(event) => void updateContact(contact, { stage: event.target.value })}>
              {Object.entries(stageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>}
            {viewColumns.includes("owner") && <small className="view-field"><b>OWNER</b>{contact.owner || "Unassigned"}</small>}
            {viewColumns.includes("source") && <small className="view-field"><b>SOURCE</b>{contact.source_last || "Direct"}</small>}
            {viewColumns.filter((column) => column.startsWith("custom:")).map((column) => {
              const field = customFields.find((candidate) => candidate.object_type === "contact" && candidate.active && column === `custom:${candidate.field_key}`);
              if (!field) return null;
              return <small className="view-field custom-view-field" key={column}><b>{field.label.toUpperCase()}</b>
                {customFieldDisplay(field, contactCustomValues(contact.custom_fields)[field.field_key])}</small>;
            })}
            {viewColumns.includes("next_follow_up") && <small className="view-field"><b>FOLLOW-UP</b>{contact.next_follow_up_at ? new Date(contact.next_follow_up_at).toLocaleDateString() : "—"}</small>}
            <button type="button" className="lead-qualify" disabled={Boolean(mutating)} onClick={() => qualifyContact(contact)}>QUALIFY → OPPORTUNITY</button>
            <button type="button" className="lead-open" onClick={() => void openContact(contact)}>OPEN</button>
          </div>)}{!leadInbox.length && <div className="empty-state">{contactsLoading ? "Loading lead records…" : "No unqualified leads match this view."}</div>}</div>
          <aside className="bulk-panel"><p className="eyebrow">BULK ACTIONS</p><strong>{selectedIds.length} selected</strong>
            <button className="selection-toggle" type="button" disabled={!visibleLeadIds.length} onClick={() => { setBulkReviewOpen(false); setSelectedIds((current) => allVisibleSelected ? current.filter((id) => !visibleLeadIds.includes(id)) : [...new Set([...current, ...visibleLeadIds])]); }}>
              {allVisibleSelected ? "CLEAR VISIBLE" : `SELECT VISIBLE (${visibleLeadIds.length})`}
            </button>
            {!selectedIds.length && <small>Select one or more leads to reveal bulk changes. Up to 100 visible leads can be updated at once.</small>}
            {Boolean(selectedIds.length) && <><select aria-label="Bulk contact lifecycle" value={bulkStage} onChange={(event) => { setBulkStage(event.target.value); setBulkReviewOpen(false); }}><option value="">Keep contact lifecycle</option>{Object.entries(stageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
            <select aria-label="Bulk record status" value={bulkStatus} onChange={(event) => { setBulkStatus(event.target.value); setBulkReviewOpen(false); }}><option value="">Keep record status</option><option value="lead">Lead</option><option value="customer">Customer</option><option value="inactive">Inactive</option></select>
            <select aria-label="Bulk owner action" value={bulkOwnerAction} onChange={(event) => { setBulkOwnerAction(event.target.value as "keep" | "assign" | "unassign"); setBulkOwner(""); setBulkReviewOpen(false); }}>
              <option value="keep">Keep owner</option><option value="assign">Assign owner</option><option value="unassign">Unassign owner</option>
            </select>
            {bulkOwnerAction === "assign" && <input aria-label="Bulk owner" type="email" placeholder="owner@company.com" value={bulkOwner} onChange={(event) => { setBulkOwner(event.target.value); setBulkReviewOpen(false); }} />}
            {!bulkReviewOpen && <button disabled={(!bulkStage && !bulkStatus && bulkOwnerAction === "keep") || (bulkOwnerAction === "assign" && !bulkOwner.trim()) || Boolean(mutating)} onClick={() => setBulkReviewOpen(true)}>{`REVIEW ${selectedIds.length} ${selectedIds.length === 1 ? "LEAD" : "LEADS"}`}</button>}
            {bulkReviewOpen && <div className="bulk-review" role="alert"><b>REVIEW BEFORE APPLYING</b>
              <small>{selectedIds.length} records · {bulkStage ? `lifecycle → ${stageLabels[bulkStage] || bulkStage}` : "lifecycle unchanged"} · {bulkStatus ? `status → ${bulkStatus}` : "status unchanged"} · {bulkOwnerAction === "assign" ? `owner → ${bulkOwner.trim()}` : bulkOwnerAction === "unassign" ? "owner → unassigned" : "owner unchanged"}</small>
              <button disabled={Boolean(mutating)} onClick={() => void bulkUpdateContacts()}>{mutating === "bulk" ? "UPDATING…" : "CONFIRM BULK UPDATE"}</button>
              <button className="selection-toggle" disabled={Boolean(mutating)} onClick={() => setBulkReviewOpen(false)}>CANCEL</button>
            </div>}</>}
          </aside>
        </div>
        <div className="pagination" aria-label="Lead inbox pages"><button disabled={contactPage <= 1 || contactsLoading} onClick={() => { setContactPage((page) => page - 1); setSelectedIds([]); setBulkReviewOpen(false); }}>← PREVIOUS</button><span>PAGE {contactPagination.page} OF {contactPagination.pages} · {contactPagination.total} {contactPagination.total === 1 ? "RECORD" : "RECORDS"}</span><button disabled={contactPage >= contactPagination.pages || contactsLoading} onClick={() => { setContactPage((page) => page + 1); setSelectedIds([]); setBulkReviewOpen(false); }}>NEXT →</button></div>
      </section>
      <section className="companies-panel" id="companies" hidden={activeView !== "leads" || leadView !== "companies"}><div className="section-head"><div><p>ACCOUNT INTELLIGENCE</p><h2>Companies and their revenue footprint.</h2></div><div className="company-head-actions"><span>{control?.companies.length ?? 0} COMPANIES</span>{(control?.role === "owner" || control?.role === "admin") && <button type="button" disabled={Boolean(mutating)} onClick={() => void scanCompanyDuplicates()}>{mutating === "company-duplicate-scan" ? "SCANNING…" : "SCAN DUPLICATES"}</button>}</div></div>
        {companyDuplicates && <section className="duplicate-review-center" aria-label="Duplicate company review">
          <div><p>IDENTITY REVIEW</p><h3>{companyDuplicates.length ? `${companyDuplicateMeta.total} possible duplicate pair${companyDuplicateMeta.total === 1 ? "" : "s"}` : "No likely duplicates found."}</h3><small>{companyDuplicateMeta.scanned} companies compared with explainable, deterministic signals.{companyDuplicateMeta.truncated ? " Showing the 50 highest scores." : ""}</small></div>
          {companyDuplicates.map((candidate) => <article key={`${candidate.source.id}:${candidate.target.id}`}><mark>{candidate.score}/100</mark><div><strong>{candidate.source.name} ↔ {candidate.target.name}</strong><small>{candidate.reasons.map((reason) => `${reason.label} (+${reason.weight})`).join(" · ")}</small></div><button type="button" onClick={() => void openDuplicateReview(candidate)}>REVIEW PAIR</button></article>)}
          {!companyDuplicates.length && <div className="duplicate-clear">Your current company identities do not cross the 40-point review threshold. Nothing was changed.</div>}
        </section>}
        <div className="company-grid">{(control?.companies ?? []).map((company) => <article key={company.id}><i>{company.name.slice(0, 2).toUpperCase()}</i><div><strong>{company.name}</strong><small>{company.contacts} contact{company.contacts === 1 ? "" : "s"} · {company.leads} open lead{company.leads === 1 ? "" : "s"}</small><small>{money(company.open_pipeline)} open pipeline</small></div><b>{money(company.revenue)}</b><button className="company-open" aria-label={`Open ${company.name} account workspace`} onClick={() => void openCompany(company)}>OPEN ACCOUNT</button></article>)}
          {!control?.companies.length && <div className="empty-state">Company records appear as contacts are enriched.</div>}</div></section>
      <section className="visitor-intent-panel" id="visitor-intent" hidden={activeView !== "leads" || leadView !== "visitors"}>
        <div className="section-head"><div><p>IDENTIFIED WEBSITE TRAFFIC</p><h2>Intent first. CRM lead only after review.</h2></div><span>{visitorIntent?.profiles.length ?? 0} SHOWN · MAX 100</span></div>
        <div className="visitor-boundary">
          <div><p className="eyebrow">QUARANTINED INTENT LEDGER</p><h3>Pixel identities stay outside Contacts and Pipeline.</h3>
            <small>AudienceLab and RB2B events are normalized, replay-safe, and treated as untrusted enrichment. Known people link without mutation. Net-new people require an explicit promotion.</small></div>
          <dl><div><dt>AUTO-CREATE</dt><dd>Never</dd></div><div><dt>PAYLOAD TRUST</dt><dd>Untrusted data</dd></div>
            <div><dt>OUTREACH</dt><dd>Not authorized</dd></div><div><dt>PROMOTION</dt><dd>Admin review</dd></div></dl>
        </div>
        <div className="visitor-agent-loop" aria-label="Visitor intent agent control loop">
          <div><p className="eyebrow">AGENTIC CONTROL LOOP</p><h3>Observe → explain → propose → human decides.</h3>
            <small>Scoped agents can read only bounded quarantined profiles and propose one current person promotion. They cannot ingest secrets, alter pixel data, create outreach, or bypass this review.</small></div>
          <ol><li><b>01</b><span>OBSERVE<small>Intent evidence only</small></span></li>
            <li><b>02</b><span>PROPOSE<small>Version-bound profile</small></span></li>
            <li><b>03</b><span>REVIEW<small>Owner or admin</small></span></li>
            <li><b>04</b><span>COMMIT<small>Contact, audit, no outreach</small></span></li></ol>
          <div><strong>{(control?.proposals ?? []).filter((proposal) => proposal.category === "visitor_promotion" && proposal.status === "pending").length}</strong>
            <span>PENDING VISITOR PROPOSALS</span>
            <button type="button" onClick={() => { setActiveView("agent"); setError(""); setNotice(""); }}>OPEN AGENT INBOX</button></div>
        </div>
        <div className="visitor-connector-layout">
          <section className="visitor-connectors"><div><p className="eyebrow">CONNECTED PIXELS</p><h3>Vendor-specific receivers.</h3></div>
            {(visitorIntent?.connectors ?? []).map((connector) => <article key={connector.id}><i className={connector.active ? "on" : ""}></i><div><strong>{connector.name}</strong>
              <small>{connector.provider.toUpperCase()} · {connector.token_prefix}•••• · consent {connector.consent_default}</small>
              <small>{connector.active ? (connector.last_event_at ? `Last event ${new Date(connector.last_event_at).toLocaleString()}` : "Waiting for first event") : "Revoked · ingestion disabled"}</small></div>
              {canAdmin && connector.active && <div className="visitor-connector-actions">
                <button type="button" className="secondary" disabled={Boolean(mutating)}
                  onClick={() => void changeVisitorConnector(connector, "rotate")}>
                  {visitorConnectorArmed?.id === connector.id && visitorConnectorArmed.action === "rotate" ? "CONFIRM ROTATE" : "ROTATE URL"}
                </button>
                <button type="button" className="danger" disabled={Boolean(mutating)}
                  onClick={() => void changeVisitorConnector(connector, "revoke")}>
                  {visitorConnectorArmed?.id === connector.id && visitorConnectorArmed.action === "revoke" ? "CONFIRM REVOKE" : "REVOKE"}
                </button>
                {visitorConnectorArmed?.id === connector.id && <button type="button" className="secondary"
                  onClick={() => setVisitorConnectorArmed(null)}>CANCEL</button>}
              </div>}</article>)}
            {!visitorIntent?.connectors.length && <div className="empty-state">No visitor pixel receiver configured.</div>}
          </section>
          {canAdmin && <form className="visitor-connector-form" onSubmit={createVisitorConnector}><p className="eyebrow">ADD PIXEL RECEIVER</p>
            <label htmlFor="visitor-provider">PROVIDER</label><select id="visitor-provider" value={visitorConnectorProvider}
              onChange={(event) => setVisitorConnectorProvider(event.target.value as "audiencelab" | "rb2b")}>
              <option value="audiencelab">AudienceLab SuperPixel</option><option value="rb2b">RB2B</option>
            </select>
            <label htmlFor="visitor-connector-name">CONNECTION NAME</label><input id="visitor-connector-name" required maxLength={120}
              placeholder="Main website pixel" value={visitorConnectorName} onChange={(event) => setVisitorConnectorName(event.target.value)} />
            <label htmlFor="visitor-consent-default">CONSENT DEFAULT</label><select id="visitor-consent-default" value={visitorConsentDefault}
              onChange={(event) => setVisitorConsentDefault(event.target.value as "unknown" | "granted" | "denied")}>
              <option value="unknown">Unknown — safest default</option><option value="granted">Granted by upstream consent gate</option><option value="denied">Denied — never promote</option>
            </select>
            <small>Choose “granted” only when your consent manager gates the pixel. CRM promotion still does not authorize automated outreach.</small>
            <button type="submit" disabled={Boolean(mutating)}>{mutating === "visitor-connector" ? "CREATING…" : "CREATE RECEIVER"}</button>
          </form>}
        </div>
        {newVisitorConnectorUrls && <div className="visitor-webhook-reveal" role="status"><div><strong>ONE-TIME CONNECTION URLS</strong>
          <label>SUPERPIXEL EVENTS<code>{newVisitorConnectorUrls.pixel}</code></label>
          {newVisitorConnectorUrls.audienceSync && <label>AUDIENCESYNC HTTP DESTINATION<code>{newVisitorConnectorUrls.audienceSync}</code></label>}
          <small>These URLs share one revocable connector secret. It is stored only as a hash and cannot be shown again. Rotating either URL rotates both.</small></div>
          <div className="visitor-url-actions"><button onClick={() => void navigator.clipboard.writeText(newVisitorConnectorUrls.pixel)}>COPY PIXEL URL</button>
            {newVisitorConnectorUrls.audienceSync && <button onClick={() => void navigator.clipboard.writeText(newVisitorConnectorUrls.audienceSync!)}>COPY AUDIENCESYNC URL</button>}
            <button className="secondary" onClick={() => setNewVisitorConnectorUrls(null)}>I SAVED THEM</button></div></div>}
        {canAdmin && <form className="audience-intake" onSubmit={submitAudienceImport}>
          <header><div><p className="eyebrow">AUDIENCE INTAKE</p><h3>Import a list without turning it into outreach.</h3>
            <small>Preview first. Rows enter the same governed identity quarantine as pixel signals, retain list lineage and tags, and require individual promotion before becoming Contacts.</small></div>
            <span>CSV · 100 ROW MAX</span></header>
          <details className="audience-sync-template"><summary>AUDIENCESYNC HTTP TEMPLATE</summary>
            <p>Use the one-time AudienceSync destination URL above. Send a stable cursor/export key so retries are idempotent. One record per request is supported.</p>
            <pre>{`{
  "external_key": "{{ event.timestamp }}:{{ event.data.email }}",
  "list_name": "Workshop buyers",
  "mode": "incremental",
  "consent_basis": "unknown",
  "tags": ["audiencesync", "workshop"],
  "record": {
    "email": "{{ event.data.email }}",
    "first_name": "{{ event.data.first_name }}",
    "company_name": "{{ event.data.company }}",
    "company_domain": "{{ event.data.company_domain }}"
  }
}`}</pre>
            <small>For batch delivery, replace <code>record</code> with a <code>rows</code> array of up to 100 records. Full refresh and incremental modes are accepted.</small>
          </details>
          <div className="audience-intake-grid">
            <label>AUDIENCELAB CONNECTION<select required aria-label="AudienceLab list connection" value={audienceConnectorId}
              onChange={(event) => { setAudienceConnectorId(event.target.value); setAudiencePreview(null); }}>
              <option value="">Choose a connection</option>
              {(visitorIntent?.connectors ?? []).filter((connector) => connector.provider === "audiencelab" && connector.active)
                .map((connector) => <option key={connector.id} value={connector.id}>{connector.name}</option>)}
            </select></label>
            <label>LIST NAME<input required maxLength={160} placeholder="Workshop buyers" value={audienceListName}
              onChange={(event) => { setAudienceListName(event.target.value); setAudiencePreview(null); }} /></label>
            <label>BATCH KEY<input required maxLength={200} placeholder="audiencesync:buyers:cursor-42" value={audienceExternalKey}
              onChange={(event) => { setAudienceExternalKey(event.target.value); setAudiencePreview(null); }} />
              <small>Use a unique export ID or incremental cursor. Replays are rejected.</small></label>
            <label>CONSENT BASIS<select value={audienceConsentBasis}
              onChange={(event) => { setAudienceConsentBasis(event.target.value as "unknown" | "granted" | "denied"); setAudiencePreview(null); }}>
              <option value="unknown">Unknown · review required</option><option value="granted">Granted upstream</option><option value="denied">Denied · suppress activation</option>
            </select></label>
            <label className="audience-tags">TAGS<input maxLength={500} placeholder="workshop, high-value, july-2026" value={audienceTags}
              onChange={(event) => { setAudienceTags(event.target.value); setAudiencePreview(null); }} /></label>
          </div>
          <label className="audience-csv">CSV DATA<textarea required rows={7} spellCheck={false} value={audienceCsv}
            onChange={(event) => { setAudienceCsv(event.target.value); setAudienceMapping({}); setAudiencePreview(null); }}
            aria-describedby="audience-csv-help" /></label>
          <small id="audience-csv-help">Supported headers: email, first_name, last_name, linkedin_url, title, company_name, company_domain, company_website, industry, city, region, postal_code, consent_status. A row needs an email, LinkedIn URL, or company domain.</small>
          <CsvMappingEditor csv={audienceCsv} mapping={audienceMapping} onChange={(mapping) => {
            setAudienceMapping(mapping); setAudiencePreview(null);
          }} targets={[
            ["email", "Email"], ["first_name", "First name"], ["last_name", "Last name"], ["linkedin_url", "LinkedIn URL"],
            ["title", "Job title"], ["company_name", "Company name"], ["company_domain", "Company domain"],
            ["company_website", "Company website"], ["industry", "Industry"], ["city", "City"], ["region", "Region"],
            ["postal_code", "Postal code"], ["consent_status", "Consent status"],
          ].map(([value, label]) => ({ value, label }))} />
          {audiencePreview && <div className="audience-preview" role="status"><div><strong>{audiencePreview.total}</strong><span>ROWS VALIDATED</span></div>
            <dl><div><dt>NEW PROFILES</dt><dd>{audiencePreview.create_quarantine}</dd></div><div><dt>UPDATES</dt><dd>{audiencePreview.update_quarantine}</dd></div>
              <div><dt>CONTACTS</dt><dd>0</dd></div><div><dt>OUTREACH</dt><dd>Blocked</dd></div></dl>
            <button type="button" className="secondary" onClick={() => setAudiencePreview(null)}>EDIT INPUT</button></div>}
          <button type="submit" disabled={Boolean(mutating) || !audienceConnectorId}>
            {mutating === "audience-preview" ? "VALIDATING…" : mutating === "audience-commit" ? "IMPORTING…" : audiencePreview ? "CONFIRM QUARANTINED IMPORT" : "PREVIEW IMPORT"}
          </button>
        </form>}
        <div className="visitor-toolbar">
          <div className="visitor-entity-switch" role="group" aria-label="Visitor intent entity view">
            <button type="button" aria-pressed={visitorEntityView === "accounts"}
              onClick={() => setVisitorEntityView("accounts")}>ACCOUNTS</button>
            <button type="button" aria-pressed={visitorEntityView === "people"}
              onClick={() => setVisitorEntityView("people")}>PEOPLE</button>
          </div>
          <label>REVIEW STATE<select aria-label="Filter visitor review state" value={visitorReviewFilter}
            onChange={(event) => setVisitorReviewFilter(event.target.value)}><option value="new">New</option><option value="reviewed">Reviewed</option>
            <option value="promoted">Promoted</option><option value="suppressed">Suppressed</option><option value="all">All states</option></select></label>
          <label>PROVIDER<select aria-label="Filter visitor provider" value={visitorProviderFilter}
            onChange={(event) => setVisitorProviderFilter(event.target.value)}><option value="">All providers</option><option value="audiencelab">AudienceLab</option><option value="rb2b">RB2B</option></select></label>
          <button disabled={visitorIntentLoading} onClick={() => void loadVisitorIntent()}>{visitorIntentLoading ? "LOADING…" : "REFRESH INTENT"}</button>
          <span>{visitorIntent?.counts.new ?? 0} NEW · {visitorIntent?.counts.promoted ?? 0} PROMOTED</span>
        </div>
        <section className="intent-case-queue" aria-label="Active visitor intent cases">
          <header><div><p className="eyebrow">INTENT OPERATING QUEUE</p><h3>Signals with an owner, SLA, and frozen evidence.</h3>
            <small>Cases coordinate review without creating a Contact, Company, Opportunity, task, or outreach permission.</small></div>
            <strong>{visitorCasePagination.total}<small>MATCHING CASES</small></strong></header>
          <div className="intent-case-filters">
            <select aria-label="Filter intent case status" value={visitorCaseStatus}
              onChange={(event) => { setVisitorCaseStatus(event.target.value); setVisitorCasePage(1); }}>
              <option value="active">Active queue</option><option value="new">New</option><option value="in_review">In review</option>
              <option value="resolved">Resolved history</option><option value="dismissed">Dismissed history</option><option value="all">All cases</option>
            </select>
            <select aria-label="Filter intent case priority" value={visitorCasePriority}
              onChange={(event) => { setVisitorCasePriority(event.target.value); setVisitorCasePage(1); }}>
              <option value="">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option>
              <option value="normal">Normal</option><option value="low">Low</option>
            </select>
            <select aria-label="Filter intent case owner" value={visitorCaseOwner}
              onChange={(event) => { setVisitorCaseOwner(event.target.value); setVisitorCasePage(1); }}>
              <option value="">All owners</option><option value="__unassigned__">Unassigned</option>
              {(accessPolicy?.members ?? []).filter((member) => member.active).map((member) =>
                <option key={member.email} value={member.email}>{member.email}</option>)}
            </select>
            <input aria-label="Search intent cases" maxLength={200} placeholder="Search company or domain…"
              value={visitorCaseQuery} onChange={(event) => { setVisitorCaseQuery(event.target.value); setVisitorCasePage(1); }} />
          </div>
          <div className="intent-case-list">
            {visitorIntentCases.map((intentCase) => {
              const evidence = intentCase.evidence_snapshot;
              const overdue = Boolean(intentCase.due_at && Date.parse(intentCase.due_at) < Date.now());
              return <article key={intentCase.id} className={overdue ? "overdue" : ""}>
                <div className="intent-case-rank"><mark>{intentCase.intent_score}</mark><span>{intentCase.priority}</span></div>
                <div><strong>{intentCase.company_name}</strong><small>{intentCase.company_domain} · evidence {new Date(intentCase.evidence_updated_at).toLocaleString()}</small>
                  <small>{evidence.people_count ?? 0} people · {evidence.high_intent_count ?? 0} high-intent visits · {money(evidence.open_pipeline_value ?? 0)} pipeline</small></div>
                <div className="intent-case-owner"><b>{intentCase.owner || "UNASSIGNED"}</b><small>{intentCase.due_at ? `${overdue ? "OVERDUE" : "DUE"} ${new Date(intentCase.due_at).toLocaleString()}` : "NO SLA"}</small></div>
                {canAdmin && <div className="intent-case-actions">
                  {intentCase.status === "new" && <button type="button" disabled={Boolean(mutating)}
                    onClick={() => void updateVisitorIntentCase(intentCase, { status: "in_review" })}>CLAIM REVIEW</button>}
                  {["new", "in_review"].includes(intentCase.status) && <><input aria-label={`Resolution note for ${intentCase.company_name}`} maxLength={1000}
                    placeholder="Resolution note…" value={visitorCaseResolution[intentCase.id] || ""}
                    onChange={(event) => setVisitorCaseResolution((current) => ({ ...current, [intentCase.id]: event.target.value }))} />
                    <button type="button" className="secondary" disabled={Boolean(mutating)}
                      onClick={() => void updateVisitorIntentCase(intentCase, { status: "resolved" })}>RESOLVE</button>
                    <button type="button" className="danger-action" disabled={Boolean(mutating)}
                      onClick={() => void updateVisitorIntentCase(intentCase, { status: "dismissed" })}>DISMISS</button></>}
                  {["resolved", "dismissed"].includes(intentCase.status) && <button type="button" disabled={Boolean(mutating)}
                    onClick={() => void updateVisitorIntentCase(intentCase, { status: "new", owner: null })}>REOPEN</button>}
                  <button type="button" disabled={Boolean(mutating)}
                    onClick={() => void openVisitorIntentCaseDetail(intentCase)}>OPEN CASE</button>
                </div>}
              </article>;
            })}
            {!visitorIntentCases.length && <div className="empty-state">{visitorCaseStatus === "active"
              ? "No active intent cases. Open one from an account only when its evidence deserves coordinated review."
              : "No intent cases match these history filters."}</div>}
          </div>
          <footer className="intent-case-pages"><small>PAGE {visitorCasePagination.page} OF {visitorCasePagination.pages}</small>
            <div><button type="button" disabled={visitorCasePage <= 1 || visitorIntentLoading}
              onClick={() => setVisitorCasePage((page) => Math.max(1, page - 1))}>PREVIOUS</button>
              <button type="button" disabled={visitorCasePage >= visitorCasePagination.pages || visitorIntentLoading}
                onClick={() => setVisitorCasePage((page) => page + 1)}>NEXT</button></div></footer>
        </section>
        {visitorEntityView === "accounts" && <div className="visitor-account-grid">
          {(visitorIntent?.accounts ?? []).map((account) => {
            const expanded = expandedVisitorAccount === account.company_domain;
            const activeCase = account.active_case_id ? { status: account.active_case_status || "new" } : null;
            const crmCompany = account.crm_company_id
              ? control?.companies.find((company) => company.id === account.crm_company_id) || {
                id: account.crm_company_id, name: account.crm_company_name || account.company_name,
                domain: account.company_domain, website: null, industry: null, owner: null,
                contacts: account.known_contact_count, leads: 0, revenue: 0,
                open_pipeline: account.open_pipeline_value, last_activity_at: account.last_seen_at,
                updated_at: account.last_seen_at,
              }
              : undefined;
            const people = (visitorIntent?.profiles ?? []).filter((profile) =>
              profile.company_domain?.trim().toLowerCase() === account.company_domain);
            return <article className={`visitor-account-card intent-${account.intent_score >= 70 ? "hot" : account.intent_score >= 45 ? "warm" : "signal"}`}
              key={account.company_domain}>
              <header><div><p className="eyebrow">INTENT ACCOUNT</p><h3>{account.company_name}</h3><small>{account.company_domain}</small></div>
                <mark>{account.intent_score} INTENT</mark></header>
              <dl><div><dt>PEOPLE</dt><dd>{account.people_count}</dd></div><div><dt>VISITS</dt><dd>{account.visit_count}</dd></div>
                <div><dt>HIGH INTENT</dt><dd>{account.high_intent_count}</dd></div><div><dt>PIPELINE</dt><dd>{money(account.open_pipeline_value)}</dd></div></dl>
              <div className="intent-reasons">{account.score_reasons.slice(0, 5).map((reason) =>
                <span key={reason.code}>+{reason.points} {reason.label}</span>)}</div>
              <div className="visitor-account-context">
                <small>{account.crm_company_id ? `CRM ACCOUNT · ${account.crm_company_name}` : "NO MATCHING CRM ACCOUNT"}</small>
                <small>{account.open_opportunity_count} OPEN OPPORTUNIT{account.open_opportunity_count === 1 ? "Y" : "IES"} · {account.known_contact_count} KNOWN CONTACT{account.known_contact_count === 1 ? "" : "S"}</small>
                {account.consent_denied_count > 0 && <small className="visitor-blocked">{account.consent_denied_count} denied-consent profile{account.consent_denied_count === 1 ? "" : "s"} remain blocked.</small>}
              </div>
              <div className="visitor-account-actions">
                {crmCompany && <button type="button" onClick={() => void openCompany(crmCompany)}>OPEN CRM ACCOUNT</button>}
                <button type="button" className="secondary" aria-expanded={expanded}
                  onClick={() => setExpandedVisitorAccount(expanded ? "" : account.company_domain)}>
                  {expanded ? "HIDE PEOPLE" : `VIEW ${account.profile_count} PROFILE${account.profile_count === 1 ? "" : "S"}`}
                </button>
                {canAdmin && <button type="button" disabled={Boolean(mutating) || Boolean(activeCase)}
                  onClick={() => void openVisitorIntentCase(account)}>{activeCase ? `${activeCase.status.toUpperCase()} CASE ACTIVE` :
                    visitorActionArmed?.id === account.company_domain && visitorActionArmed.action === "case"
                      ? "CONFIRM OPEN CASE" : "OPEN INTENT CASE"}</button>}
              </div>
              {visitorActionArmed?.id === account.company_domain && visitorActionArmed.action === "case" && !activeCase &&
                <div className="visitor-action-review" role="alert"><b>FREEZE CURRENT EVIDENCE</b>
                  <small>Create one quarantined case with a 24-hour SLA. No CRM record or outreach permission will be created.</small>
                  <button type="button" className="secondary" onClick={() => setVisitorActionArmed(null)}>CANCEL</button></div>}
              {expanded && <div className="visitor-account-people">
                {people.map((profile) => <div key={profile.id}><b>{visitorDisplayName(profile)}</b>
                  <span>{profile.email || "Company-level identity"} · {profile.visit_count} visits · {profile.high_intent_count} high intent</span>
                  <small>{profile.review_status} · consent {profile.consent_status}</small></div>)}
                {!people.length && <small>The matching profiles are outside this bounded 100-profile page. Refine the review/provider filter.</small>}
              </div>}
              <small>Last signal {new Date(account.last_seen_at).toLocaleString()} · scoring is deterministic and read-only.</small>
            </article>;
          })}
          {!visitorIntentLoading && !visitorIntent?.accounts.length && <div className="empty-state">No domain-backed intent accounts match this view. Domainless identities remain available under People and are never guessed into an account.</div>}
        </div>}
        {visitorEntityView === "people" && <div className="visitor-grid">
          {(visitorIntent?.profiles ?? []).map((profile) => { const score = visitorIntentScore(profile); const tags = safeVisitorTags(profile);
            const armed = visitorActionArmed?.id === profile.id ? visitorActionArmed.action : null;
            return <article className={`visitor-card intent-${score >= 70 ? "hot" : score >= 45 ? "warm" : "signal"}`} key={profile.id}>
              <header><div><i>{profile.identity_kind === "person" ? "P" : "CO"}</i><span><strong>{visitorDisplayName(profile)}</strong><small>{profile.title || profile.email || profile.company_domain || "Company-level identity"}</small></span></div>
                <mark>{score} INTENT</mark></header>
              <div className="visitor-company"><b>{profile.company_name || "Company unknown"}</b><span>{profile.industry || profile.company_domain || profile.provider.toUpperCase()}</span></div>
              <dl><div><dt>VISITS</dt><dd>{profile.visit_count}</dd></div><div><dt>HIGH INTENT</dt><dd>{profile.high_intent_count}</dd></div>
                <div><dt>REPEATS</dt><dd>{profile.repeat_visits}</dd></div><div><dt>CONSENT</dt><dd>{profile.consent_status}</dd></div></dl>
              {profile.latest_url && <a className="visitor-page" href={profile.latest_url} target="_blank" rel="noreferrer">{profile.latest_url.replace(/^https?:\/\//, "")}</a>}
              {tags.length > 0 && <div className="visitor-tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <small>First seen {new Date(profile.first_seen_at).toLocaleString()} · last seen {new Date(profile.last_seen_at).toLocaleString()}</small>
              {profile.matched_contact_id && <small className="visitor-match">KNOWN CRM IDENTITY · {profile.matched_contact_email}</small>}
              {armed && <div className="visitor-action-review" role="alert"><b>{armed === "promote" ? "REVIEW CRM PROMOTION" :
                armed === "research" ? "FREEZE EVIDENCE FOR RESEARCH" : "CONFIRM SUPPRESSION"}</b>
                <small>{armed === "promote"
                  ? `${profile.matched_contact_id ? "Link this signal to the existing contact" : "Create one lead from this isolated profile"}. ${
                    profile.consent_status === "unknown" ? "Consent is unknown; this does not authorize outreach." : "The upstream record says consent is granted."}`
                  : armed === "research"
                    ? `${profile.company_domain ? "Queue public account research using the company domain only." : "Queue consented person enrichment."} The agent receives a bounded snapshot and cannot create CRM records or contact anyone.`
                    : "Keep this identity and its visit history out of active review. No CRM record will be created."}</small></div>}
              {canAdmin && profile.review_status !== "promoted" && <div className="visitor-actions">
                {profile.review_status !== "suppressed" && <button className="secondary" disabled={Boolean(mutating)}
                  onClick={() => void reviewVisitorProfile(profile, "reviewed")}>MARK REVIEWED</button>}
                {profile.review_status !== "suppressed" && <button className="secondary"
                  disabled={Boolean(mutating) || (!profile.company_domain && (profile.identity_kind !== "person" || profile.consent_status !== "granted"))}
                  onClick={() => void requestVisitorResearch(profile)}>{mutating === `visitor-research:${profile.id}` ? "QUEUING…" :
                    armed === "research" ? "CONFIRM RESEARCH" : profile.company_domain ? "RESEARCH ACCOUNT" : "ENRICH PERSON"}</button>}
                <button disabled={Boolean(mutating) || !profile.email || profile.consent_status === "denied" || profile.review_status === "suppressed"}
                  onClick={() => void promoteVisitorProfile(profile)}>{mutating === `visitor-promote:${profile.id}` ? "PROMOTING…" :
                    armed === "promote" ? profile.matched_contact_id ? "CONFIRM LINK" : "CONFIRM CREATE LEAD" :
                      profile.matched_contact_id ? "LINK KNOWN CONTACT" : "PROMOTE TO LEAD"}</button>
                {profile.review_status !== "suppressed" && <button className="danger-action" disabled={Boolean(mutating)}
                  onClick={() => void reviewVisitorProfile(profile, "suppressed")}>{mutating === `visitor-review:${profile.id}` ? "SAVING…" :
                    armed === "suppress" ? "CONFIRM SUPPRESS" : "SUPPRESS"}</button>}
                {armed && <button className="secondary" disabled={Boolean(mutating)} onClick={() => setVisitorActionArmed(null)}>CANCEL</button>}
              </div>}
              {!profile.email && <small className="visitor-blocked">Company-only identity stays quarantined until a person-level email is available.</small>}
              {profile.consent_status === "denied" && <small className="visitor-blocked">Promotion blocked because the upstream consent state is denied.</small>}
            </article>; })}
          {!visitorIntentLoading && !visitorIntent?.profiles.length && <div className="empty-state">No visitor identities match this review state. Pixel events will appear here without entering Contacts or Pipeline.</div>}
        </div>}
      </section>
      <section className="contacts-panel" id="contacts" hidden={activeView !== "leads" || leadView !== "contacts"}><div className="section-head"><div><p>CENTRAL CONTACT DATABASE</p><h2>Every lead. One record.</h2></div>
        <div className="section-head-actions"><span>{contactPagination.total} RECORDS</span>{canAdmin && <button type="button"
          aria-expanded={contactImportOpen} onClick={() => { setContactImportOpen((open) => !open); setContactImportPreview(null); }}>
          {contactImportOpen ? "CLOSE IMPORT" : "IMPORT CSV"}</button>}</div></div>
        {canAdmin && contactImportOpen && <form className="contact-import" onSubmit={submitContactImport}>
          <header><div><p className="eyebrow">GOVERNED CONTACT IMPORT</p><h3>Map, validate, then commit.</h3>
            <small>Existing emails are skipped. Typed custom fields are checked by the server before any row is written.</small></div><span>100 ROW MAX</span></header>
          <label>CSV DATA<textarea required rows={7} spellCheck={false} value={contactImportCsv}
            onChange={(event) => { setContactImportCsv(event.target.value); setContactImportMapping({}); setContactImportPreview(null); }} /></label>
          <CsvMappingEditor csv={contactImportCsv} mapping={contactImportMapping} onChange={(mapping) => {
            setContactImportMapping(mapping); setContactImportPreview(null);
          }} targets={[
            { value: "email", label: "Email (required)" }, { value: "first_name", label: "First name" },
            { value: "last_name", label: "Last name" }, { value: "phone", label: "Phone" },
            { value: "company", label: "Company" }, { value: "owner", label: "Owner email" },
            ...customFields.filter((field) => field.object_type === "contact" && field.active)
              .map((field) => ({ value: `custom:${field.field_key}`, label: `${field.label} · ${field.field_type}` })),
          ]} />
          {contactImportPreview && <div className="contact-import-preview" role="status">
            <div><strong>{contactImportPreview.ready}</strong><span>READY TO CREATE</span></div>
            <div><strong>{contactImportPreview.skipped_existing}</strong><span>EXISTING · SKIPPED</span></div>
            <button type="button" className="secondary" onClick={() => setContactImportPreview(null)}>EDIT INPUT</button>
          </div>}
          <div className="contact-import-actions"><button type="submit" disabled={Boolean(mutating)}>
            {mutating === "contacts-import-preview" ? "VALIDATING…" : mutating === "contacts-import-commit" ? "IMPORTING…" :
              contactImportPreview ? "CONFIRM IMPORT" : "PREVIEW IMPORT"}</button>
            <button type="button" className="secondary" onClick={() => { setContactImportOpen(false); setContactImportPreview(null); }}>CANCEL</button></div>
          <section className="contact-import-history" aria-label="Contact import history">
            <header><div><p className="eyebrow">RECENT IMPORTS</p><h4>Undo only what is still untouched.</h4></div>
              <button type="button" className="secondary" disabled={contactImportsLoading || Boolean(mutating)}
                onClick={() => void loadContactImports()}>{contactImportsLoading ? "REFRESHING…" : "REFRESH"}</button></header>
            <small>Rollback preserves any imported contact that was edited, linked to activity, or used by another CRM record.</small>
            {contactImports.map((batch) => <article key={batch.id} className={batch.status === "rolled_back" ? "rolled-back" : ""}>
              <div><strong>{batch.imported_rows} CREATED · {batch.skipped_rows} SKIPPED</strong>
                <small>{new Date(batch.created_at).toLocaleString()} · {batch.created_by}</small>
                <code>{batch.id}</code></div>
              {batch.status === "committed" ? <div className="contact-import-rollback">
                <span><b>{batch.rollback_ready_rows}</b> removable · <b>{batch.rollback_conflicts_now}</b> protected · <b>{batch.rollback_missing_now}</b> missing</span>
                {contactImportRollbackArmed === batch.id && <small role="alert">Confirm rollback. Changed or related contacts will stay in the CRM.</small>}
                <button type="button" className={contactImportRollbackArmed === batch.id ? "danger-action" : "secondary"}
                  disabled={Boolean(mutating) || batch.rollback_ready_rows === 0}
                  onClick={() => void rollbackContactImport(batch)}>
                  {mutating === `contact-import-rollback:${batch.id}` ? "ROLLING BACK…" :
                    contactImportRollbackArmed === batch.id ? "CONFIRM SAFE ROLLBACK" : "ROLL BACK UNTOUCHED"}
                </button>
                {contactImportRollbackArmed === batch.id && <button type="button" className="secondary"
                  disabled={Boolean(mutating)} onClick={() => setContactImportRollbackArmed("")}>CANCEL</button>}
              </div> : <div className="contact-import-result"><mark>ROLLED BACK</mark>
                <span>{batch.rollback_deleted_rows} removed · {batch.rollback_conflict_rows} preserved · {batch.rollback_missing_rows} missing</span>
                <small>{batch.rolled_back_at ? new Date(batch.rolled_back_at).toLocaleString() : ""} · {batch.rolled_back_by}</small></div>}
            </article>)}
            {!contactImportsLoading && !contactImports.length && <div className="empty-state">No governed contact imports yet.</div>}
          </section>
        </form>}
        <div className="view-toolbar">
          <select aria-label="Filter all-contact lifecycle" value={filterStage} onChange={(event) => { setFilterStage(event.target.value); setContactPage(1); }}><option value="">All lifecycle steps</option>{Object.entries(stageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          <select aria-label="Filter all-contact status" value={filterStatus} onChange={(event) => { setFilterStatus(event.target.value); setContactPage(1); }}><option value="">All statuses</option><option value="lead">Lead</option><option value="customer">Customer</option><option value="inactive">Inactive</option></select>
          <label className="attention-toggle"><input type="checkbox" checked={attentionOnly} onChange={(event) => { setAttentionOnly(event.target.checked); setContactPage(1); }} /> Needs attention</label>
          <button type="button" aria-expanded={advancedFiltersOpen} onClick={() => setAdvancedFiltersOpen((open) => !open)}>{advancedFiltersOpen ? "FEWER FILTERS" : `MORE FILTERS${advancedFilterCount ? ` (${advancedFilterCount})` : ""}`}</button>
          {advancedFiltersOpen && <><select aria-label="Filter all-contact owner" value={filterOwner} onChange={(event) => { setFilterOwner(event.target.value); setContactPage(1); }}><option value="">All owners</option><option value="__unassigned__">Unassigned</option>{contactFacets.owners.map((item) => <option key={item.owner} value={item.owner}>{item.owner} ({item.total})</option>)}</select>
          <select aria-label="Filter all-contact source" value={filterSource} onChange={(event) => { setFilterSource(event.target.value); setContactPage(1); }}><option value="">All sources</option><option value="__direct__">Direct</option>{contactFacets.sources.map((item) => <option key={item.source} value={item.source}>{item.source} ({item.total})</option>)}</select>
          <select aria-label="Sort all contacts" value={contactSort} onChange={(event) => { setContactSort(event.target.value); setContactPage(1); }}><option value="recent">Recent activity</option><option value="name">Name</option><option value="company">Company</option><option value="score">Lead score</option><option value="follow_up">Next follow-up</option></select>
          <button type="button" onClick={() => { setContactDirection((current) => current === "asc" ? "desc" : "asc"); setContactPage(1); }}>{contactDirection === "asc" ? "ASC ↑" : "DESC ↓"}</button>
          <CustomFilterEditor fields={customFields} filters={customFilters} disabled={contactsLoading}
            onChange={(filters) => { setCustomFilters(filters); setContactPage(1); }} />
          <CustomColumnPicker fields={customFields} columns={viewColumns} disabled={contactsLoading} onChange={setViewColumns} /></>}
        </div>
        <div className="contact-table"><div className="table-row table-header" style={{ gridTemplateColumns: contactTableColumns }}><span>CONTACT</span><span>CONTACT LIFECYCLE</span><span>SOURCE</span>
          {listCustomFields.map((field) => <span key={field.id}>{field.label.toUpperCase()}</span>)}<span>REVENUE</span><span>LAST ACTIVITY</span></div>
          {filtered.map((contact) => <button className="table-row" style={{ gridTemplateColumns: contactTableColumns }} key={contact.id} onClick={() => void openContact(contact)}>
            <span className="contact-name"><i>{(contact.first_name?.[0] || contact.email[0]).toUpperCase()}</i><b>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email}<small>{contact.company || contact.email}</small></b></span>
            <span><mark>{stageLabels[contact.stage] || contact.stage}</mark></span><span>{contact.source_last || "Direct"}</span>
            {listCustomFields.map((field) => <span key={field.id}>{customFieldDisplay(field, contactCustomValues(contact.custom_fields)[field.field_key])}</span>)}
            <span>{money(contact.revenue || 0)}</span><span>{contact.last_activity_at ? new Date(contact.last_activity_at).toLocaleDateString() : "—"}</span>
          </button>)}{!filtered.length && <div className="empty-state">{contactsLoading ? "Loading contact records…" : "No contacts match this view yet."}</div>}</div>
        <div className="pagination" aria-label="All contact pages"><button disabled={contactPage <= 1 || contactsLoading} onClick={() => setContactPage((page) => page - 1)}>← PREVIOUS</button><span>PAGE {contactPagination.page} OF {contactPagination.pages} · {contactPagination.total} {contactPagination.total === 1 ? "RECORD" : "RECORDS"}</span><button disabled={contactPage >= contactPagination.pages || contactsLoading} onClick={() => setContactPage((page) => page + 1)}>NEXT →</button></div>
      </section>
      <section className="opportunity-panel" id="opportunities" hidden={activeView !== "pipeline"}><div className="section-head"><div><p>OPPORTUNITY COMMAND</p><h2>Move deals through one pipeline at a time.</h2></div><span>{selectedPipelineOpportunities.length} RECORDS</span></div>
        <div className="pipeline-selector"><label htmlFor="active-pipeline">PIPELINE</label><select id="active-pipeline" value={selectedPipelineId} onChange={(event) => {
          setActivePipelineId(event.target.value); setOpportunityDeleteArmed(""); closeOpportunityWorkspace();
        }}>
          {(control?.pipelines ?? []).map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
        </select><small>{selectedPipeline?.name || "No pipeline configured"} · contact lifecycle stays separate</small></div>
        <div className="pipeline-move-guidance" role="note"><span>DRAG CARDS BETWEEN STAGES</span><small>Keyboard: focus MOVE and use ← or →. Won and lost moves still require confirmation.</small></div>
        <DndContext sensors={pipelineSensors} onDragStart={handlePipelineDragStart}
          onDragCancel={() => setActiveDraggedOpportunityId("")} onDragEnd={handlePipelineDragEnd}>
        <div className="kanban" style={{ gridTemplateColumns: `repeat(${Math.max(selectedPipelineStages.length, 1)}, minmax(210px, 1fr))` }}>{selectedPipelineStages.map((stage) => <PipelineDropColumn stage={stage} key={stage.id}>
          <header><i style={{ background: stage.color }}></i><b>{stage.name}</b><span>{stage.probability}%</span></header>
          {selectedPipelineOpportunities.filter((item) => item.stage_id === stage.id).map((item) => <DraggableOpportunityCard
            key={item.id} opportunity={item} disabled={Boolean(mutating)}
            onKeyboardMove={(direction) => moveOpportunityByKeyboard(item, direction)}>
            <div><strong>{item.name}</strong><span>{money(item.value)}</span></div><p>{[item.first_name, item.last_name].filter(Boolean).join(" ") || item.email}</p>
            <small>{item.next_step || "No next step"} · {item.probability}% confidence</small>
            <select aria-label={`Move ${item.name}`} disabled={Boolean(mutating)} value={item.stage_id} onChange={(event) => void moveOpportunity(item, event.target.value)}>
              {selectedPipelineStages.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            {pendingTerminalMove?.opportunityId === item.id && selectedOpportunityId !== item.id && (() => {
              const target = selectedPipelineStages.find((option) => option.id === pendingTerminalMove.stageId);
              return target ? <div className="terminal-move-review" role="alert"><b>CONFIRM {target.category.toUpperCase()}</b><small>Move “{item.name}” to {target.name}? This changes forecast status immediately.</small>
                <button disabled={Boolean(mutating)} onClick={() => void moveOpportunity(item, target.id, true)}>CONFIRM MOVE</button>
                <button className="secondary" disabled={Boolean(mutating)} onClick={() => setPendingTerminalMove(null)}>CANCEL</button>
              </div> : null;
            })()}
            {mutating === `opportunity-move:${item.id}` && <small role="status">Moving opportunity…</small>}
            <button className="card-action" aria-label={`Open ${item.name} workspace`} onClick={() => openOpportunityWorkspace(item)}>OPEN WORKSPACE</button>
          </DraggableOpportunityCard>)}{!selectedPipelineOpportunities.some((item) => item.stage_id === stage.id) && <div className="column-empty">Drop opportunities here</div>}
        </PipelineDropColumn>)}</div>
        <DragOverlay dropAnimation={null}>{activeDraggedOpportunityId && (() => {
          const item = selectedPipelineOpportunities.find((opportunity) => opportunity.id === activeDraggedOpportunityId);
          return item ? <article className="opportunity-card opportunity-drag-overlay"><div><strong>{item.name}</strong><span>{money(item.value)}</span></div><p>{item.company || item.email}</p></article> : null;
        })()}</DragOverlay>
        </DndContext>
        <form className="inline-create" onSubmit={createOpportunity}><div><p className="eyebrow">CREATE OPPORTUNITY</p><small>Choose the contact this revenue record belongs to.</small></div>
          <select aria-label="Opportunity contact" value={selectedOpportunityContactId} onChange={(event) => setOpportunityContactId(event.target.value)} disabled={!availableContacts.length}>
            {!availableContacts.length && <option value="">Add a contact first</option>}
            {availableContacts.map((contact) => <option key={contact.id} value={contact.id}>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email}</option>)}
          </select>
          <input aria-label="Opportunity name" placeholder="AI agent implementation" value={opportunityName} onChange={(event) => setOpportunityName(event.target.value)} required maxLength={200} />
          <input aria-label="Opportunity value" type="number" min="0" max="100000000" value={opportunityValue} onChange={(event) => setOpportunityValue(event.target.value)} required /><button type="submit" disabled={!availableContacts.length || !opportunityName.trim() || Boolean(mutating)}>{mutating === "opportunity" ? "CREATING…" : "CREATE"}</button></form>
      </section>
      <section className="operations-grid focused-grid" hidden={activeView !== "tasks" && activeView !== "agent"}>
        <section className="tasks-panel" id="tasks" hidden={activeView !== "tasks"}><div className="section-head"><div><p>EXECUTION QUEUE</p><h2>{taskView === "calendar" ? "Every commitment. One calendar." : "Tasks with accountability."}</h2></div><span>{control?.tasks.filter((task) => task.status === "open").length ?? 0} OPEN</span></div>
          <nav className="task-view-switcher" aria-label="Task workspace view">
            <button type="button" className={taskView === "list" ? "active" : ""} aria-pressed={taskView === "list"} onClick={() => setTaskView("list")}>LIST</button>
            <button type="button" className={taskView === "calendar" ? "active" : ""} aria-pressed={taskView === "calendar"} onClick={() => setTaskView("calendar")}>CALENDAR</button>
          </nav>
          {taskView === "list" && <><div className="task-list">{(control?.tasks ?? []).map((task) => { const overdue = task.status === "open" && task.due_at && Date.parse(task.due_at) < taskClock; return <article key={task.id} className={`${task.status !== "open" ? "done" : ""}${overdue ? " overdue" : ""}`}>
            <div><strong>{task.title}</strong><small>{task.assignee || "Unassigned"} · {task.due_at ? new Date(task.due_at).toLocaleString() : "No due date"}{overdue ? " · OVERDUE" : ""}</small>
              {(task.contact_email || task.opportunity_name) && <small>{[task.contact_email, task.opportunity_name].filter(Boolean).join(" · ")}</small>}</div><mark>{task.priority}</mark>
            <TaskLifecycleControls task={task} disabled={Boolean(mutating)} deleteArmed={taskDeleteArmed === task.id}
              onStatus={(status) => void updateTaskStatus(task, status)} onDelete={() => void deleteTask(task)}
              onCancelDelete={() => setTaskDeleteArmed("")} /></article>; })}
            {!control?.tasks.length && <div className="empty-state">Nothing is waiting on the team.</div>}</div>
          <form className="compact-form task-form" onSubmit={createTask}><input aria-label="Task title" placeholder="Follow up with…" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} required maxLength={200} />
            <input aria-label="Task due date" name="due_at" type="datetime-local" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} />
            <button type="button" className="secondary" aria-expanded={taskDetailsOpen} onClick={() => setTaskDetailsOpen((open) => !open)}>{taskDetailsOpen ? "HIDE DETAILS" : "TASK DETAILS"}</button>
            {taskDetailsOpen && <div className="task-details">
              <select aria-label="Task priority" value={taskPriority} onChange={(event) => setTaskPriority(event.target.value)}><option value="low">Low priority</option><option value="normal">Normal priority</option><option value="high">High priority</option><option value="urgent">Urgent</option></select>
              <input aria-label="Task assignee" type="email" placeholder="assignee@company.com" value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)} />
              <select aria-label="Task contact" value={taskContactId} onChange={(event) => { setTaskContactId(event.target.value); setTaskOpportunityId(""); }}><option value="">No linked contact</option>{availableContacts.map((contact) => <option key={contact.id} value={contact.id}>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email}</option>)}</select>
              <select aria-label="Task opportunity" value={taskOpportunityId} onChange={(event) => { const opportunity = control?.opportunities.find((item) => item.id === event.target.value); setTaskOpportunityId(event.target.value); if (opportunity) setTaskContactId(opportunity.contact_id); }}><option value="">No linked opportunity</option>{(control?.opportunities ?? []).map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.name}</option>)}</select>
            </div>}
            <button type="submit" disabled={Boolean(mutating)}>{mutating === "task" ? "ADDING…" : "ADD TASK"}</button></form></>}
          {taskView === "calendar" && <section className="task-calendar" aria-label={`${taskCalendarRange.monthStart.toLocaleString(undefined, { month: "long", year: "numeric" })} CRM calendar`}>
            <header className="calendar-toolbar"><div><button type="button" aria-label="Previous month" onClick={() => {
              const previous = new Date(taskCalendarRange.monthStart); previous.setMonth(previous.getMonth() - 1);
              setCalendarMonth(localDateKey(previous).slice(0, 7));
            }}>←</button><button type="button" onClick={() => setCalendarMonth(currentCalendarMonth())}>TODAY</button><button type="button" aria-label="Next month" onClick={() => {
              const next = new Date(taskCalendarRange.monthStart); next.setMonth(next.getMonth() + 1);
              setCalendarMonth(localDateKey(next).slice(0, 7));
            }}>→</button></div><strong>{taskCalendarRange.monthStart.toLocaleString(undefined, { month: "long", year: "numeric" })}</strong>
              <button type="button" disabled={calendarLoading} onClick={() => void loadCalendar()}>{calendarLoading ? "REFRESHING…" : "REFRESH"}</button>
            </header>
            <div className="calendar-legend" aria-label="Calendar event types">
              <span><i className="task"></i>{calendarData?.counts.tasks ?? 0} TASKS</span>
              <span><i className="follow-up"></i>{calendarData?.counts.follow_ups ?? 0} FOLLOW-UPS</span>
              <span><i className="close"></i>{calendarData?.counts.opportunity_closes ?? 0} CLOSE DATES</span>
            </div>
            {calendarError && <div className="calendar-feedback error" role="alert">{calendarError}<button type="button" onClick={() => void loadCalendar()}>TRY AGAIN</button></div>}
            {(calendarData?.truncated.tasks || calendarData?.truncated.follow_ups ||
              calendarData?.truncated.opportunity_closes || calendarData?.truncated.total) &&
              <div className="calendar-feedback" role="status">This month exceeds the safe calendar display limit. Narrow the working month or use the record lists for the complete set.</div>}
            <div className="calendar-weekdays" aria-hidden="true">{["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="calendar-grid" aria-busy={calendarLoading}>
              {taskCalendarRange.days.map((day) => {
                const key = localDateKey(day);
                const events = calendarEventsByDay.get(key) ?? [];
                const outside = day.getMonth() !== taskCalendarRange.monthStart.getMonth();
                const today = key === localDateKey(new Date());
                return <section key={key} className={`${outside ? "outside" : ""}${today ? " today" : ""}`} aria-label={`${day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${events.length} commitments`}>
                  <time dateTime={key}>{day.getDate()}</time>
                  <div>{events.map((event) => {
                    const opportunity = event.opportunity_id
                      ? control?.opportunities.find((item) => item.id === event.opportunity_id) : null;
                    const contact = event.contact_id
                      ? availableContacts.find((item) => item.id === event.contact_id) : null;
                    return <button type="button" key={event.id} className={`calendar-event ${event.kind}`}
                      disabled={!opportunity && !contact}
                      title={`${event.title} · ${new Date(event.starts_at).toLocaleString()}`}
                      onClick={() => opportunity ? void openOpportunityWorkspace(opportunity)
                        : contact ? void openContact(contact) : undefined}>
                      <span>{new Date(event.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                      <strong>{event.title}</strong>
                    </button>;
                  })}</div>
                </section>;
              })}
            </div>
            {!calendarLoading && !calendarData?.events.length && !calendarError &&
              <div className="empty-state">No dated tasks, follow-ups, or open opportunity closes in this month.</div>}
          </section>}
        </section>
        <section className="agent-panel" id="agent" hidden={activeView !== "agent"}><div className="section-head"><div><p>GOVERNED REVENUE AGENT</p><h2>Next-best-action control loop.</h2></div><div className="agent-controls">
          {canAdmin && control?.agent_policy && Boolean(control.agent_policy.agent_access_enabled) && !agentDisableArmed && <button className="agent-kill-switch" disabled={Boolean(mutating)} onClick={() => setAgentDisableArmed(true)}>DISABLE ALL AGENTS</button>}
          {canAdmin && control?.agent_policy && Boolean(control.agent_policy.agent_access_enabled) && agentDisableArmed && <><button className="agent-kill-switch confirm" disabled={Boolean(mutating)} onClick={() => void toggleWorkspaceAgentAccess()}>CONFIRM DISABLE ALL</button><button className="agent-cancel-disable" disabled={Boolean(mutating)} onClick={() => setAgentDisableArmed(false)}>CANCEL</button></>}
          {canAdmin && control?.agent_policy && !Boolean(control.agent_policy.agent_access_enabled) && <button className="agent-kill-switch" disabled={Boolean(mutating)} onClick={() => void toggleWorkspaceAgentAccess()}>ENABLE AGENT ACCESS</button>}
          {canAdmin && <button className="agent-run" disabled={agentRunning || !Boolean(control?.agent_policy?.agent_access_enabled)} onClick={() => void analyzePipeline()}>{agentRunning ? "RUNNING…" : "RUN REVENUE AGENT"}</button>}
        </div></div>
          <div className="agent-policy"><span><b>{control?.agent_policy?.agent_access_enabled ? "ENABLED" : "DISABLED"}</b> WORKSPACE ACCESS</span><span><b>{control?.agent_policy?.require_approval ? "REQUIRED" : "LIMITED AUTO"}</b> HUMAN APPROVAL</span><span><b>{control?.agent_policy?.workspace_rate_limit_per_minute ?? 0}/MIN</b> WORKSPACE LIMIT</span><span><b>{control?.agent_policy?.max_proposals_per_run ?? 0}</b> ACTION BUDGET</span></div>
          {!canAdmin && <div className="agent-member-boundary"><b>READ-ONLY REVIEW</b><small>Only an owner or admin can start analysis or decide proposals. Members can inspect the governed queue and execution evidence.</small></div>}
          {agentRun && <div className="agent-summary" role="status"><strong>{agentRun.analyzed} REVENUE RECORDS EVALUATED</strong>
            <span>{agentRun.proposals_created} new · {agentRun.proposals_refreshed} refreshed · {agentRun.proposals_expired} expired · {agentRun.healthy} healthy</span>
            <small>{agentRun.analyzed === 0 ? "There are no leads or open opportunities to evaluate." :
              agentRun.proposals_created + agentRun.proposals_refreshed === 0 ? "No intervention is currently required under the active operating policy." :
              `${agentRun.reasons.lead_follow_up} lead follow-ups · ${agentRun.reasons.missing_next_step} missing next steps · ${agentRun.reasons.stale} stale · ${agentRun.reasons.unowned} unowned · ${agentRun.reasons.missing_close_date + agentRun.reasons.zero_value} data-quality gaps`}</small></div>}
          <div className="proposal-list">{(control?.proposals ?? []).map((proposal) => { const actionView = proposalActionView(proposal); return <article key={proposal.id}><div className="proposal-meta"><mark>{proposal.category.replaceAll("_", " ")} · P{proposal.priority}</mark><span>{proposal.confidence}% confidence · {proposal.risk_level} risk</span><small className="proposal-origin">ORIGIN · {proposalOrigin(proposal)}</small></div>
            <h3>{proposal.title}</h3><p>{proposal.rationale}</p>
            {proposal.category === "visitor_promotion" && <div className="proposal-visitor-evidence">
              <div><span>IDENTITY</span><b>{[proposal.visitor_first_name, proposal.visitor_last_name].filter(Boolean).join(" ") || proposal.visitor_email || "Profile unavailable"}</b><small>{proposal.visitor_company_name || proposal.visitor_provider || "Company unknown"}</small></div>
              <dl><div><dt>VISITS</dt><dd>{proposal.visitor_visit_count ?? "—"}</dd></div><div><dt>HIGH INTENT</dt><dd>{proposal.visitor_high_intent_count ?? "—"}</dd></div>
                <div><dt>CONSENT</dt><dd>{proposal.visitor_consent_status || "unknown"}</dd></div><div><dt>PROFILE</dt><dd>R{proposal.visitor_revision ?? "—"}</dd></div></dl>
              {proposal.visitor_latest_url && <a href={proposal.visitor_latest_url} target="_blank" rel="noreferrer">{proposal.visitor_latest_url.replace(/^https?:\/\//, "")}</a>}
              <small>Promotion creates or links a Contact only. It does not authorize email, ads, tasks, or workflow execution.</small>
            </div>}
            <small>{actionView.summary}</small><small>Status: {proposal.status}{proposal.expires_at ? ` · expires ${new Date(proposal.expires_at).toLocaleString()}` : ""}</small>{proposal.execution_result && <small className="proposal-result">{proposalResultText(proposal.execution_result)}</small>}
            {(proposal.opportunity_id || proposal.contact_id || proposal.category === "visitor_promotion") &&
              <button type="button" className="proposal-record-link" onClick={() => void openProposalRecord(proposal)}>
                {proposal.category === "visitor_promotion" && !proposal.contact_id ? "OPEN VISITOR INTENT" : "OPEN SOURCE RECORD"}
              </button>}
            {proposal.status === "pending" && canAdmin && !Boolean(control?.agent_policy?.agent_access_enabled) && <small>Approval is paused while workspace agent access is disabled. Rejection remains available.</small>}
            {proposal.status === "pending" && canAdmin && proposalDecisionArmed?.id === proposal.id && <small className="proposal-confirmation" role="status">
              {proposalDecisionArmed.decision === "approved"
                ? `Confirm execution: ${actionView.summary}. The server will revalidate this exact proposal before writing.`
                : "Confirm rejection. Nothing will execute and this proposal will leave the pending queue."}
            </small>}
            {proposal.status === "pending" && canAdmin && <div><button disabled={Boolean(mutating) || !Boolean(control?.agent_policy?.agent_access_enabled)} onClick={() => void decideProposal(proposal.id, "approved")}>{mutating === `proposal:${proposal.id}` ? "EXECUTING…" : proposalDecisionArmed?.id === proposal.id && proposalDecisionArmed.decision === "approved" ? "CONFIRM EXECUTION" : actionView.button}</button><button disabled={Boolean(mutating)} className="secondary" onClick={() => void decideProposal(proposal.id, "rejected")}>{proposalDecisionArmed?.id === proposal.id && proposalDecisionArmed.decision === "rejected" ? "CONFIRM REJECTION" : "REJECT"}</button>
              {proposalDecisionArmed?.id === proposal.id && <button disabled={Boolean(mutating)} className="secondary" onClick={() => setProposalDecisionArmed(null)}>CANCEL</button>}
            </div>}{proposal.status === "pending" && !canAdmin && <small>Awaiting an owner or admin decision.</small>}</article>; })}
            {!control?.proposals.length && <div className="empty-state">{agentRun ? "Agent run completed with no proposed actions." : "Run the revenue agent to inspect leads and opportunities. It cannot execute without approval."}</div>}</div>
          <div className="agent-run-history" aria-label="Revenue agent run history"><p className="eyebrow">RECENT AGENT RUNS</p>{(control?.agent_runs ?? []).slice(0, 5).map((run) => <small key={run.id}><b>{run.status.toUpperCase()}</b> · {run.trigger_type} · {run.proposals_created} new / {run.proposals_refreshed} refreshed / {run.proposals_expired} expired · {new Date(run.started_at).toLocaleString()}</small>)}{!control?.agent_runs.length && <small>No persisted runs yet.</small>}</div>
        </section>
      </section>
      <section className="operations-grid focused-grid" hidden={activeView !== "automations" && activeView !== "settings"}>
        <section className={`automation-panel ${automationBuilderOpen ? "builder-active" : ""}`} id="automations" hidden={activeView !== "automations"}><div className="section-head"><div><p>SAFE AUTOMATION</p><h2>{automationBuilderOpen ? "Workflow builder." : "Rules and run state."}</h2></div><span>{control?.automations.filter((item) => item.status === "active").length ?? 0} ACTIVE</span></div>
          {!automationBuilderOpen && <div className="automation-list">{(control?.automations ?? []).map((automation) => { const definition = automationDefinition(automation); const actionCount = (definition?.actions.length ?? 0) + (definition?.else_actions.length ?? 0); const runtimeReadiness = automationAgentReadiness(definition, availableAgentProviders, observedAgentProviders, agentAccessEnabled); const manualRecordType = automation.trigger_type === "contact.manual" ? "contact" : automation.trigger_type === "opportunity.manual" ? "opportunity" : null; const metadataBlocked = automation.metadata_status === "blocked"; return <article className={metadataBlocked ? "metadata-blocked" : ""} key={automation.id}><div><strong>{automation.name}</strong><small>{automation.trigger_type} · {actionCount} action{actionCount === 1 ? "" : "s"}{definition?.else_actions.length ? " · MATCH/ELSE" : ""} · up to {automation.max_runs_per_record} runs/record</small>{runtimeReadiness && <small className={runtimeReadiness.ready ? "automation-runtime-ready" : "automation-runtime-gap"}>{runtimeReadiness.label}</small>}{metadataBlocked && <small className="automation-metadata-gap">BLOCKED · {automation.metadata_error || "Workflow definition needs review"}</small>}</div><mark>{metadataBlocked ? "repair" : automation.status}</mark>
            {canAdmin && manualRecordType && automation.status === "active" && !metadataBlocked && <div className="automation-manual-run">
              <label><span>{manualRecordType === "contact" ? "LEAD" : "OPPORTUNITY"}</span><select
                aria-label={`Choose ${manualRecordType} for ${automation.name}`}
                value={automationManualRecords[automation.id] || ""}
                disabled={Boolean(mutating)}
                onChange={(event) => setAutomationManualRecords((current) => ({ ...current, [automation.id]: event.target.value }))}>
                <option value="">Choose one…</option>
                {manualRecordType === "contact"
                  ? contactRows.map((contact) => <option key={contact.id} value={contact.id}>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email} · {contact.company || contact.email}</option>)
                  : (control?.opportunities ?? []).map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.name} · {opportunity.company || opportunity.email}</option>)}
              </select></label>
              <button disabled={Boolean(mutating) || !automationManualRecords[automation.id]}
                onClick={() => void runManualAutomation(automation)}>
                {mutating === `automation-run-now:${automation.id}` ? "RUNNING…" : "RUN NOW"}
              </button>
            </div>}
            {canAdmin && automation.status !== "active" && <button className="secondary" disabled={Boolean(mutating)} onClick={() => openAutomationBuilder(automation)}>{metadataBlocked ? "EDIT TO REPAIR" : "EDIT"}</button>}
            {canAdmin && automation.status === "active" && metadataBlocked && <button disabled={Boolean(mutating)}
              onClick={() => void pauseAndRepairAutomation(automation)}>
              {mutating === `automation-repair:${automation.id}` ? "PAUSING…" : "PAUSE + REPAIR"}
            </button>}
            {canAdmin && !(automation.status === "active" && metadataBlocked) && <button disabled={Boolean(mutating) || (metadataBlocked && automation.status !== "active")} onClick={() => void setAutomationStatus(automation, automation.status === "active" ? "paused" : "active")}>
              {mutating === `automation-status:${automation.id}` ? "UPDATING…" : automation.status === "active" ? "PAUSE" : "ACTIVATE"}
            </button>}
            {canAdmin && automation.status !== "active" && <button className="secondary" disabled={Boolean(mutating)} onClick={() => void deleteAutomation(automation)}>
              {mutating === `automation-delete:${automation.id}` ? "DELETING…" : automationDeleteArmed === automation.id ? "CONFIRM DELETE + HISTORY" : "DELETE"}
            </button>}
            {automationDeleteArmed === automation.id && <button className="secondary" disabled={Boolean(mutating)} onClick={() => setAutomationDeleteArmed("")}>CANCEL</button>}</article>; })}
            {!control?.automations.length && <div className="empty-state">No automation rules defined.</div>}</div>}
          {canAdmin && !automationBuilderOpen && <button className="workflow-create" disabled={Boolean(mutating)} onClick={() => openAutomationBuilder()}>+ BUILD WORKFLOW</button>}
          {canAdmin && automationBuilderOpen && <Suspense fallback={<div className="builder-loading" role="status">Loading workflow builder…</div>}><VisualAutomationBuilder
            name={automationName} definition={workflowDefinition} disabled={Boolean(mutating)}
            stages={(control?.stages ?? []).map((stage) => ({ id: stage.id, name: stage.name }))}
            availableAgentProviders={availableAgentProviders}
            observedAgentProviders={observedAgentProviders}
            agentAccessEnabled={agentAccessEnabled}
            outboundWebhookEventTypes={outboundWebhookEventTypes}
            customFields={customFields}
            onNameChange={setAutomationName} onChange={setWorkflowDefinition}
            onSave={() => void saveAutomation()} saveLabel={mutating === "automation" ? "SAVING…" : automationEditing ? "SAVE DRAFT" : "CREATE DRAFT"}
            onClose={() => { setAutomationEditing(null); setAutomationBuilderOpen(false); setAutomationName(""); setWorkflowDefinition(defaultWorkflow); }}
          /></Suspense>}
          <div className="run-health" aria-label="Automation run health">
            {(["succeeded", "failed", "running", "canceled"] as const).map((status) =>
              <span className={`run-health-${status}`} key={status}>
                <b>{automationRuns.filter((run) => run.status === status).length}</b>{status}
              </span>)}
            <label>SHOW<select aria-label="Filter automation runs" value={automationRunFilter}
              onChange={(event) => { setAutomationRunFilter(event.target.value); setAutomationDebugRunId(""); }}>
              <option value="all">All recent runs</option>
              <option value="failed">Failed</option><option value="running">Running</option>
              <option value="succeeded">Succeeded</option><option value="canceled">Canceled</option>
            </select></label>
          </div>
          <div className="run-list" aria-label="Automation run history">{visibleAutomationRuns.map((run) => {
            const staleRunning = run.status === "running" && taskClock - Date.parse(run.started_at) >= 5 * 60_000;
            const retryChild = automationRetryByParent.get(run.id);
            return <article key={run.id}><strong>{run.status.toUpperCase()}</strong><span>{run.automation_name} · {run.step_count} step{run.step_count === 1 ? "" : "s"} · {new Date(run.started_at).toLocaleString()}</span>
              <small>{run.principal_id || "legacy workflow"} triggered by {run.trigger_actor_type || "unknown"}:{run.trigger_actor_id || "unknown"}</small>
              {run.retry_of_run_id && <small>Retry of {run.retry_of_run_id}</small>}
              {retryChild && <small>Retried as {retryChild.id} · {retryChild.status}</small>}
              {run.error && <small>{run.error}</small>}
              {run.status === "running" && !staleRunning && <small>Execution lease active · cancellation unlocks after five minutes</small>}
              <div className="run-actions">
                {canAdmin && run.status === "failed" && !retryChild && <button disabled={Boolean(mutating)}
                  onClick={() => void operateAutomationRun(run, "retry")}>
                  {mutating === `automation-run:${run.id}` ? "RETRYING…" : "RETRY FAILED RUN"}
                </button>}
                {canAdmin && staleRunning && <button className="secondary" disabled={Boolean(mutating)}
                  onClick={() => void operateAutomationRun(run, "cancel")}>
                  {mutating === `automation-run:${run.id}` ? "CANCELLING…" : "CANCEL STALE RUN"}
                </button>}
                <button className="trace-run" onClick={() => setAutomationDebugRunId(automationDebugRunId === run.id ? "" : run.id)}>
                  {automationDebugRunId === run.id ? "CLOSE TRACE" : "TRACE"}
                </button>
              </div>
            </article>;
          })}
            {!visibleAutomationRuns.length && <div className="empty-state">{automationRuns.length ? "No runs match this status." : "No automation runs yet."}</div>}</div>
          {automationDebugRun && <div className="automation-debugger" role="region" aria-label="Automation run debugger">
            <div><p className="eyebrow">RUN DEBUGGER</p><h3>{automationDebugRun.status.toUpperCase()} · {automationDebugRun.step_count} executed step{automationDebugRun.step_count === 1 ? "" : "s"}</h3><small>{automationDebugRun.id} · {new Date(automationDebugRun.started_at).toLocaleString()}</small></div>
            <div className="debug-authority"><b>{automationDebugRun.principal_id || "LEGACY PRINCIPAL"}</b>
              <small>Triggered by {automationDebugRun.trigger_actor_type || "unknown"}:{automationDebugRun.trigger_actor_id || "unknown"}</small>
              <span>{(() => { try { return (JSON.parse(automationDebugRun.authority_manifest || "[]") as string[]).join(" · ") || "No authority snapshot"; } catch { return "Unreadable authority snapshot"; } })()}</span>
            </div>
            <ol>{automationDebugTrace.map((step, index) => <li className={`trace-${step.status}`} key={`${step.action}-${step.stepId || index}`}><b>{step.ordinal ?? "PATH"}</b><span><strong>{step.label}</strong><small>{step.detail}</small>{step.stepId && <code>STEP {step.stepId}</code>}</span></li>)}</ol>
            {!automationDebugTrace.length && !automationDebugRun.error && <div className="debug-error">Stored run output is empty or unreadable.</div>}
            {automationDebugRun.error && <div className="debug-error">{automationDebugRun.error}</div>}
          </div>}
          <div className="agent-work-queue" aria-label="OpenClaw and Hermes workflow queue">
            {(() => { const items = control?.agent_work_items ?? []; const now = taskClock;
              const expired = (item: AgentWorkItem) => item.status === "claimed" && Boolean(item.claim_expires_at) && Date.parse(item.claim_expires_at || "") <= now;
              const available = items.filter((item) => item.status === "queued" || expired(item)).length;
              const leased = items.filter((item) => item.status === "claimed" && !expired(item)).length;
              const failed = items.filter((item) => item.status === "failed").length;
              const completed = items.filter((item) => item.status === "completed").length;
              return <><div className="queue-head"><div><p className="eyebrow">AGENT WORK QUEUE</p><h3>OpenClaw + Hermes handoffs</h3></div>
                <div className="queue-health" aria-label="Agent work health"><span><b>{available}</b> AVAILABLE</span><span><b>{leased}</b> LEASED</span><span><b>{failed}</b> FAILED</span><span><b>{completed}</b> DONE</span></div></div>
            {items.slice(0, 8).map((item) => { const leaseExpired = expired(item); const result = agentWorkResult(item); return <article key={item.id} className={item.status === "failed" ? "failed" : leaseExpired ? "expired" : item.status}>
              <mark>{leaseExpired ? "lease expired" : item.status}</mark><div><strong>{item.objective.replaceAll("_", " ")}</strong>
                <small>{item.preferred_provider} · {item.opportunity_name || item.contact_email || "workspace job"} · {item.automation_name || "workflow"}</small>
                <small>{leaseExpired ? "The runtime stopped renewing this lease. Requeue it or let a compatible runtime reclaim it."
                  : item.status === "claimed" ? `${item.claimed_by_name || item.claimed_by_provider || "Agent"} has the lease until ${item.claim_expires_at ? new Date(item.claim_expires_at).toLocaleString() : "expiry"}`
                  : item.status === "failed" ? result?.error || "The runtime failed without a readable error."
                  : item.status === "completed" ? result?.summary || "Runtime completed without a written summary."
                  : item.instructions}</small>
                {item.status === "failed" && <small className="work-result">{result?.retryable ? "Runtime marked this retryable." : "Admin review required before retry."}</small>}</div>
              {(item.contact_id || item.opportunity_id || (canAdmin && (item.status === "queued" || item.status === "failed" || leaseExpired))) &&
                <div className="agent-work-actions">
                  {(item.contact_id || item.opportunity_id) && <button type="button" className="secondary"
                    onClick={() => void openAgentWorkRecord(item)}>OPEN RECORD</button>}
                  {canAdmin && item.status === "queued" && <button type="button" className="secondary"
                    disabled={Boolean(mutating)} onClick={() => void cancelAgentWorkItem(item)}>
                    {mutating === `agent-work-cancel:${item.id}` ? "CANCELLING…" :
                      agentWorkCancelArmed === item.id ? "CONFIRM CANCEL" : "CANCEL QUEUED"}
                  </button>}
                  {agentWorkCancelArmed === item.id && <button type="button" className="secondary"
                    disabled={Boolean(mutating)} onClick={() => setAgentWorkCancelArmed("")}>KEEP</button>}
                  {canAdmin && (item.status === "failed" || leaseExpired) && <button type="button" className="secondary" disabled={Boolean(mutating)}
                    onClick={() => void requeueAgentWorkItem(item)}>{mutating === `agent-work:${item.id}` ? "REQUEUING…" : "REQUEUE"}</button>}
                </div>}
            </article>; })}
            {!items.length && <div className="empty-state">No agent work has been requested. Add “Request agent work” to a workflow.</div>}</>; })()}
          </div>
        </section>
          {activeView === "settings" && <nav className="settings-view-switcher" aria-label="Settings workspace">
            {([
              ["access", "ACCESS", "People + permissions"],
              ["fields", "FIELDS + LAYOUTS", "CRM data model"],
              ["objects", "CUSTOM OBJECTS", "Customer-specific records"],
              ["readiness", "READINESS", "Launch checks + audit"],
              ["recovery", "RECOVERY", "Encrypted backup"],
            ] as const).map(([id, label, description]) => <button type="button" key={id}
              className={settingsView === id ? "active" : ""} aria-pressed={settingsView === id}
              onClick={() => { setSettingsView(id); setError(""); setNotice(""); }}>
              <strong>{label}</strong><small>{description}</small>
            </button>)}
          </nav>}
          {pageLayouts.find((layout) => layout.object_type === customFieldObject) && <section className="page-layout-manager"
            aria-label={`${customFieldObject} page layout`} hidden={activeView !== "settings" || settingsView !== "fields"}>
            <div className="section-head"><div><p>RECORD PAGE LAYOUT</p><h3>Arrange custom fields into simple sections.</h3>
              <small>Core identity, lifecycle, and relationship controls remain fixed. This layout governs workspace-defined fields.</small></div>
              <span>REVISION {pageLayouts.find((layout) => layout.object_type === customFieldObject)?.revision || 0}</span>
            </div>
            <div className="page-layout-sections">
              {pageLayouts.find((layout) => layout.object_type === customFieldObject)!.sections.map((section, sectionIndex, sections) =>
                <article key={section.id}>
                  <div className="page-layout-section-title">
                    <input aria-label={`Section ${sectionIndex + 1} title`} maxLength={80} disabled={!canAdmin || Boolean(mutating)}
                      value={section.title} onChange={(event) => updatePageLayout(customFieldObject, (layout) => ({
                        ...layout, sections: layout.sections.map((item) => item.id === section.id ? { ...item, title: event.target.value } : item),
                      }))} />
                    <span>{section.fields.length} FIELDS</span>
                    {canAdmin && sections.length > 1 && section.fields.length === 0 && <button type="button" disabled={Boolean(mutating)}
                      onClick={() => updatePageLayout(customFieldObject, (layout) => ({ ...layout, sections: layout.sections.filter((item) => item.id !== section.id) }))}>REMOVE</button>}
                  </div>
                  <div className="page-layout-fields">{section.fields.map((fieldKey) => {
                    const field = customFields.find((item) => item.object_type === customFieldObject && item.field_key === fieldKey && item.active);
                    if (!field) return null;
                    const orderedKeys = pageLayouts.find((layout) => layout.object_type === customFieldObject)!.sections.flatMap((item) => item.fields);
                    const position = orderedKeys.indexOf(fieldKey);
                    return <div key={fieldKey}><div><strong>{field.label}</strong><code>{field.field_key}</code></div>
                      <button type="button" aria-label={`Move ${field.label} up`} disabled={!canAdmin || Boolean(mutating) || position === 0} onClick={() => moveLayoutField(customFieldObject, fieldKey, -1)}>↑</button>
                      <button type="button" aria-label={`Move ${field.label} down`} disabled={!canAdmin || Boolean(mutating) || position === orderedKeys.length - 1} onClick={() => moveLayoutField(customFieldObject, fieldKey, 1)}>↓</button>
                      <select aria-label={`Section for ${field.label}`} disabled={!canAdmin || Boolean(mutating)} value={section.id}
                        onChange={(event) => moveLayoutFieldToSection(customFieldObject, fieldKey, event.target.value)}>
                        {sections.map((target) => <option key={target.id} value={target.id}>{target.title}</option>)}
                      </select>
                    </div>;
                  })}</div>
                </article>)}
            </div>
            {canAdmin && <div className="page-layout-actions">
              <button type="button" disabled={Boolean(mutating) || pageLayouts.find((layout) => layout.object_type === customFieldObject)!.sections.length >= 8}
                onClick={() => updatePageLayout(customFieldObject, (layout) => ({
                  ...layout, sections: [...layout.sections, {
                    id: `section_${Date.now().toString(36)}`, title: "New section", fields: [],
                  }],
                }))}>ADD SECTION</button>
              <button type="button" disabled={Boolean(mutating)}
                onClick={() => void savePageLayout(customFieldObject)}>{mutating === `page-layout:${customFieldObject}` ? "SAVING LAYOUT…" : "SAVE PAGE LAYOUT"}</button>
            </div>}
          </section>}
        <section className="custom-object-workspace" hidden={activeView !== "settings" || settingsView !== "objects"}>
          <div className="section-head"><div><p>METADATA-DEFINED RECORDS</p>
            <h2>Model the business without changing the codebase.</h2>
            <small>Custom objects are workspace-isolated, versioned, recoverable, and explicitly permissioned. Agent execution remains disabled.</small></div>
            <span>{customObjects.filter((definition) => definition.active).length}/10 ACTIVE</span>
          </div>
          <div className="custom-object-layout">
            <aside className="custom-object-sidebar" aria-label="Custom object definitions">
              {customObjects.map((definition) => <button type="button" key={definition.id}
                className={selectedCustomObjectId === definition.id ? "active" : ""}
                onClick={() => {
                  setSelectedCustomObjectId(definition.id); setCustomObjectRecordDraft({});
                  setActiveCustomObjectViewId(""); setCustomObjectViewBuilderOpen(false); resetCustomObjectViewDraft(definition);
                }}>
                <span><strong>{definition.plural_label}</strong><small>{definition.slug} · R{definition.revision}</small></span>
                <b>{definition.record_count}</b>
              </button>)}
              {canAdmin && customObjects.length < 10 && <button type="button" className={!selectedCustomObjectId ? "active create" : "create"}
                onClick={() => {
                  setSelectedCustomObjectId(""); setCustomObjectRecords([]); setCustomObjectViews([]);
                  setActiveCustomObjectViewId(""); setCustomObjectViewBuilderOpen(false);
                }}>+ NEW OBJECT</button>}
              {!customObjects.length && <div className="empty-state">No customer-specific objects yet.</div>}
            </aside>
            <div className="custom-object-main">
              {selectedCustomObject ? <>
                <header className="custom-object-heading"><div><p className="eyebrow">{selectedCustomObject.slug}</p>
                  <h3>{selectedCustomObject.plural_label}</h3>
                  <small>{selectedCustomObject.description || `${selectedCustomObject.singular_label} records`}</small></div>
                  <div className="custom-object-lifecycle"><mark>{selectedCustomObject.active ? "ACTIVE" : "ARCHIVED"}</mark>
                    {selectedCustomObject.authority.configure && <button type="button" className={customObjectArchiveArmed === selectedCustomObject.id ? "danger-action" : "secondary"}
                      disabled={Boolean(mutating)} onClick={() => void toggleCustomObjectArchive(selectedCustomObject)}>
                      {customObjectArchiveArmed === selectedCustomObject.id
                        ? `CONFIRM ${selectedCustomObject.active ? "ARCHIVE" : "RESTORE"}`
                        : selectedCustomObject.active ? "ARCHIVE OBJECT" : "RESTORE OBJECT"}</button>}
                    {selectedCustomObject.authority.configure && customObjectArchiveArmed === selectedCustomObject.id && <button type="button" className="secondary"
                      onClick={() => setCustomObjectArchiveArmed("")}>CANCEL</button>}</div></header>
                <div className="custom-object-field-chips">{selectedCustomObject.fields.map((field) =>
                  <span key={field.key}><b>{field.label}</b><code>{field.key} · {field.type}</code></span>)}</div>
                <section className="custom-object-view-panel" aria-label={`${selectedCustomObject.plural_label} working views`}>
                  <div className="custom-object-view-heading"><div><p className="eyebrow">WORKING VIEWS</p>
                    <small>Reuse filters, columns, and sort order as an operator queue.</small></div>
                    {selectedCustomObject.active && selectedCustomObject.authority.configure && <button type="button" className="secondary" onClick={() => {
                      resetCustomObjectViewDraft(selectedCustomObject); setCustomObjectViewBuilderOpen(true);
                    }}>NEW VIEW</button>}</div>
                  <div className="custom-object-view-tabs">
                    <button type="button" className={!activeCustomObjectViewId ? "active" : ""}
                      onClick={() => {
                        setActiveCustomObjectViewId(""); void loadCustomObjectRecords(selectedCustomObject.id, "");
                      }}>ALL RECORDS</button>
                    {customObjectViews.map((view) => <div key={view.id} className={activeCustomObjectViewId === view.id ? "active" : ""}>
                      <button type="button" onClick={() => {
                        setActiveCustomObjectViewId(view.id); void loadCustomObjectRecords(selectedCustomObject.id, view.id);
                      }}><strong>{view.name}</strong><small>{view.visibility === "workspace" ? "WORKSPACE" : "PRIVATE"} · R{view.revision}</small></button>
                      {selectedCustomObject.active && selectedCustomObject.authority.configure && <button type="button" aria-label={`Edit ${view.name} custom-object view`}
                        onClick={() => editCustomObjectView(view)}>EDIT</button>}
                      {selectedCustomObject.active && selectedCustomObject.authority.configure && <button type="button" aria-label={`Delete ${view.name} custom-object view`}
                        className={customObjectViewDeleteArmed === view.id ? "danger-action" : ""}
                        onClick={() => void deleteCustomObjectView(view)}>
                        {customObjectViewDeleteArmed === view.id ? "CONFIRM" : "DELETE"}</button>}
                      {customObjectViewDeleteArmed === view.id && <button type="button"
                        aria-label={`Keep ${view.name} custom-object view`}
                        onClick={() => setCustomObjectViewDeleteArmed("")}>KEEP</button>}
                    </div>)}
                  </div>
                  {activeCustomObjectView && <small className="custom-object-view-summary">
                    Showing {activeCustomObjectView.visible_fields.length} columns · {activeCustomObjectView.filters.length}
                    {activeCustomObjectView.filters.length === 1 ? " filter" : " filters"} · sorted by {activeCustomObjectView.sort_field.replaceAll("_", " ")}
                  </small>}
                  {customObjectViewBuilderOpen && selectedCustomObject.active && selectedCustomObject.authority.configure && <form className="custom-object-view-builder"
                    onSubmit={saveCustomObjectView}>
                    <header><div><p className="eyebrow">{editingCustomObjectViewId ? "EDIT WORKING VIEW" : "NEW WORKING VIEW"}</p>
                      <small>Every filter is combined with AND. A maximum of five keeps queues explainable.</small></div>
                      <button type="button" className="secondary" onClick={() => {
                        setCustomObjectViewBuilderOpen(false); resetCustomObjectViewDraft(selectedCustomObject);
                      }}>CLOSE</button></header>
                    <div className="custom-object-view-basics">
                      <label>VIEW NAME<input required maxLength={100} placeholder="Renewals due"
                        value={customObjectViewDraft.name}
                        onChange={(event) => setCustomObjectViewDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                      <label>VISIBILITY<select value={customObjectViewDraft.visibility}
                        onChange={(event) => setCustomObjectViewDraft((current) => ({
                          ...current, visibility: event.target.value as "private" | "workspace",
                        }))}><option value="private">Private</option><option value="workspace">Workspace</option></select></label>
                      <label>SORT BY<select value={customObjectViewDraft.sort_field}
                        onChange={(event) => setCustomObjectViewDraft((current) => ({ ...current, sort_field: event.target.value }))}>
                        <option value="display_name">Record name</option><option value="updated_at">Last updated</option>
                        {selectedCustomObject.fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                      </select></label>
                      <label>DIRECTION<select value={customObjectViewDraft.sort_direction}
                        onChange={(event) => setCustomObjectViewDraft((current) => ({
                          ...current, sort_direction: event.target.value as "asc" | "desc",
                        }))}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
                    </div>
                    <fieldset><legend>FILTERS</legend>
                      {customObjectViewDraft.filters.map((filter, index) => {
                        const field = selectedCustomObject.fields.find((candidate) => candidate.key === filter.field_key)
                          || selectedCustomObject.fields[0];
                        const operators = field.type === "text" ? [["equals", "Equals"], ["contains", "Contains"], ["is_empty", "Is empty"]]
                          : field.type === "select" || field.type === "boolean" ? [["equals", "Equals"], ["is_empty", "Is empty"]]
                            : field.type === "number" ? [["equals", "Equals"], ["gte", "At least"], ["lte", "At most"], ["is_empty", "Is empty"]]
                              : [["equals", "On"], ["before", "Before"], ["after", "After"], ["is_empty", "Is empty"]];
                        return <div className="custom-object-view-filter" key={`${index}:${filter.field_key}`}>
                          <select aria-label={`View filter ${index + 1} field`} value={filter.field_key}
                            onChange={(event) => setCustomObjectViewDraft((current) => ({
                              ...current, filters: current.filters.map((item, itemIndex) => itemIndex === index
                                ? { field_key: event.target.value, operator: "equals", value: "" } : item),
                            }))}>{selectedCustomObject.fields.map((candidate) =>
                              <option key={candidate.key} value={candidate.key}
                                disabled={customObjectViewDraft.filters.some((item, itemIndex) =>
                                  itemIndex !== index && item.field_key === candidate.key)}>{candidate.label}</option>)}</select>
                          <select aria-label={`View filter ${index + 1} operator`} value={filter.operator}
                            onChange={(event) => setCustomObjectViewDraft((current) => ({
                              ...current, filters: current.filters.map((item, itemIndex) => itemIndex === index
                                ? { ...item, operator: event.target.value as CustomObjectViewFilter["operator"],
                                  ...(event.target.value === "is_empty" ? { value: undefined } : {}) } : item),
                            }))}>{operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                          {filter.operator !== "is_empty" && (field.type === "select" ? <select required
                            aria-label={`View filter ${index + 1} value`} value={String(filter.value ?? "")}
                            onChange={(event) => setCustomObjectViewDraft((current) => ({
                              ...current, filters: current.filters.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, value: event.target.value } : item),
                            }))}><option value="">Choose value</option>{field.options.map((option) =>
                              <option value={option} key={option}>{option}</option>)}</select>
                            : field.type === "boolean" ? <select required aria-label={`View filter ${index + 1} value`}
                              value={filter.value === undefined ? "" : String(filter.value)}
                              onChange={(event) => setCustomObjectViewDraft((current) => ({
                                ...current, filters: current.filters.map((item, itemIndex) => itemIndex === index
                                  ? { ...item, value: event.target.value === "true" } : item),
                              }))}><option value="">Choose value</option><option value="true">Yes</option><option value="false">No</option></select>
                              : <input aria-label={`View filter ${index + 1} value`} required
                                type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                                value={String(filter.value ?? "")}
                                onChange={(event) => setCustomObjectViewDraft((current) => ({
                                  ...current, filters: current.filters.map((item, itemIndex) => itemIndex === index
                                    ? { ...item, value: field.type === "number" && event.target.value !== ""
                                      ? Number(event.target.value) : event.target.value } : item),
                                }))} />)}
                          <button type="button" className="secondary" aria-label={`Remove view filter ${index + 1}`}
                            onClick={() => setCustomObjectViewDraft((current) => ({
                              ...current, filters: current.filters.filter((_, itemIndex) => itemIndex !== index),
                            }))}>REMOVE</button>
                        </div>;
                      })}
                      {customObjectViewDraft.filters.length < Math.min(5, selectedCustomObject.fields.length) &&
                        <button type="button" className="secondary" onClick={() => {
                          const field = selectedCustomObject.fields.find((candidate) =>
                            !customObjectViewDraft.filters.some((filter) => filter.field_key === candidate.key));
                          if (field) setCustomObjectViewDraft((current) => ({
                            ...current, filters: [...current.filters, { field_key: field.key, operator: "equals", value: "" }],
                          }));
                        }}>ADD FILTER</button>}
                    </fieldset>
                    <fieldset><legend>VISIBLE COLUMNS</legend><div className="custom-object-view-columns">
                      <label><input type="checkbox" checked disabled /> Record name</label>
                      {selectedCustomObject.fields.map((field) => <label key={field.key}><input type="checkbox"
                        checked={customObjectViewDraft.visible_fields.includes(field.key)}
                        disabled={!customObjectViewDraft.visible_fields.includes(field.key) &&
                          customObjectViewDraft.visible_fields.length >= 12}
                        onChange={(event) => setCustomObjectViewDraft((current) => ({
                          ...current, visible_fields: event.target.checked
                            ? [...current.visible_fields, field.key]
                            : current.visible_fields.filter((key) => key !== field.key),
                        }))} /> {field.label}</label>)}</div></fieldset>
                    <button type="submit" disabled={Boolean(mutating) || !customObjectViewDraft.name.trim()}>
                      {mutating === "custom-object-view" ? "SAVING…" : editingCustomObjectViewId ? "UPDATE VIEW" : "SAVE VIEW"}
                    </button>
                  </form>}
                </section>
                {selectedCustomObject.active && selectedCustomObject.authority.create && <form className="custom-object-record-form" onSubmit={createCustomObjectRecord}>
                  <div><p className="eyebrow">NEW {selectedCustomObject.singular_label.toUpperCase()}</p>
                    <label>DISPLAY NAME<input value={customObjectRecordName} maxLength={200} required
                      onChange={(event) => setCustomObjectRecordName(event.target.value)} /></label></div>
                  <div className="custom-object-dynamic-fields">{selectedCustomObject.fields.map((field) =>
                    <label key={field.key}>{field.label.toUpperCase()}{field.required ? " *" : ""}
                      {field.type === "select" ? <select value={String(customObjectRecordDraft[field.key] ?? "")}
                        required={field.required} onChange={(event) => setCustomObjectRecordDraft((current) => ({
                          ...current, [field.key]: event.target.value,
                        }))}><option value="">Not set</option>{field.options.map((option) =>
                          <option value={option} key={option}>{option}</option>)}</select>
                        : field.type === "boolean" ? <select value={customObjectRecordDraft[field.key] === undefined
                          ? "" : String(customObjectRecordDraft[field.key])} required={field.required}
                          onChange={(event) => setCustomObjectRecordDraft((current) => ({
                            ...current, [field.key]: customObjectInputValue(field, event.target.value),
                          }))}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select>
                          : <input type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                            maxLength={field.type === "text" ? 1000 : undefined} required={field.required}
                            value={String(customObjectRecordDraft[field.key] ?? "")}
                            onChange={(event) => setCustomObjectRecordDraft((current) => ({
                              ...current, [field.key]: customObjectInputValue(field, event.target.value),
                            }))} />}</label>)}</div>
                  <button type="submit" disabled={Boolean(mutating)}>
                    {mutating === `custom-object-record:${selectedCustomObject.id}` ? "CREATING…" : `CREATE ${selectedCustomObject.singular_label.toUpperCase()}`}
                  </button>
                </form>}
                <section className="custom-object-records" aria-label={`${selectedCustomObject.plural_label} records`}>
                  {customObjectRecordsLoading && <div className="empty-state">Loading records…</div>}
                  {!customObjectRecordsLoading && customObjectRecords.map((record) => <article key={record.id}>
                    <header><div><strong>{record.display_name}</strong><small>R{record.revision} · updated {new Date(record.updated_at).toLocaleString()}</small></div>
                      <div className="custom-object-record-actions">{selectedCustomObject.active && selectedCustomObject.authority.update &&
                        <button type="button" className="secondary" disabled={Boolean(mutating)}
                          onClick={() => setCustomObjectEditing({ id: record.id, display_name: record.display_name, data: { ...record.data } })}>EDIT</button>}
                        {selectedCustomObject.authority.delete && <button type="button" className={customObjectDeleteArmed === record.id ? "danger-action" : "secondary"}
                          disabled={Boolean(mutating)} onClick={() => void deleteCustomObjectRecord(record)}>
                          {customObjectDeleteArmed === record.id ? "CONFIRM DELETE" : "DELETE"}</button>}</div></header>
                    {customObjectEditing?.id === record.id ? <div className="custom-object-record-editor">
                      <label>DISPLAY NAME<input maxLength={200} value={customObjectEditing.display_name}
                        onChange={(event) => setCustomObjectEditing((current) => current ? { ...current, display_name: event.target.value } : current)} /></label>
                      <div className="custom-object-dynamic-fields">{selectedCustomObject.fields.map((field) =>
                        <label key={field.key}>{field.label.toUpperCase()}
                          {field.type === "select" ? <select value={String(customObjectEditing.data[field.key] ?? "")}
                            onChange={(event) => setCustomObjectEditing((current) => current ? {
                              ...current, data: { ...current.data, [field.key]: event.target.value },
                            } : current)}><option value="">Not set</option>{field.options.map((option) =>
                              <option key={option} value={option}>{option}</option>)}</select>
                            : field.type === "boolean" ? <select value={customObjectEditing.data[field.key] === undefined
                              ? "" : String(customObjectEditing.data[field.key])}
                              onChange={(event) => setCustomObjectEditing((current) => current ? {
                                ...current, data: { ...current.data, [field.key]: customObjectInputValue(field, event.target.value) },
                              } : current)}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select>
                              : <input type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                                value={String(customObjectEditing.data[field.key] ?? "")}
                                onChange={(event) => setCustomObjectEditing((current) => current ? {
                                  ...current, data: { ...current.data, [field.key]: customObjectInputValue(field, event.target.value) },
                                } : current)} />}</label>)}</div>
                      <div><button type="button" className="secondary" onClick={() => setCustomObjectEditing(null)}>CANCEL</button>
                        <button type="button" disabled={Boolean(mutating) || !customObjectEditing.display_name.trim()}
                          onClick={() => void saveCustomObjectRecord(record)}>SAVE CHANGES</button></div>
                    </div> : <dl>{selectedCustomObject.fields
                      .filter((field) => !activeCustomObjectView ||
                        activeCustomObjectView.visible_fields.includes(field.key))
                      .map((field) => <div key={field.key}><dt>{field.label}</dt>
                      <dd>{record.data[field.key] === undefined ? "—" : typeof record.data[field.key] === "boolean"
                        ? record.data[field.key] ? "Yes" : "No" : String(record.data[field.key])}</dd></div>)}</dl>}
                    {selectedCustomObject.authority.relations && <div className="custom-object-relations">{record.relations.map((relation) => <span key={relation.id}>
                      <b>{relation.label}</b><code>{relation.target_label || "Removed target"}
                        {relation.target_detail ? ` · ${relation.target_detail}` : ""}</code>
                      <button type="button" aria-label={`Remove ${relation.label} relation`} disabled={Boolean(mutating)}
                        onClick={() => void removeCustomObjectRelation(relation, record)}>×</button></span>)}</div>}
                    {selectedCustomObject.authority.relations && record.relation_count < 50 && <form className="custom-object-relation-form"
                      onSubmit={(event) => void addCustomObjectRelation(event, record)}>
                      <select aria-label={`Relation target type for ${record.display_name}`}
                        value={customRelationDraft[record.id]?.target_type || "contact"}
                        onChange={(event) => {
                          setCustomRelationDraft((current) => ({ ...current,
                            [record.id]: { target_type: event.target.value as CustomObjectRelation["target_type"],
                              target_id: "", label: current[record.id]?.label || "" },
                          }));
                          setCustomRelationTargets((current) => ({ ...current, [record.id]: [] }));
                          setCustomRelationQuery((current) => ({ ...current, [record.id]: "" }));
                        }}><option value="contact">Contact</option><option value="company">Company</option>
                        <option value="opportunity">Opportunity</option><option value="custom_record">Custom record</option></select>
                      <input aria-label={`Search relation targets for ${record.display_name}`} minLength={2} maxLength={100}
                        placeholder="Search name, email, or domain" value={customRelationQuery[record.id] || ""}
                        onChange={(event) => setCustomRelationQuery((current) => ({ ...current, [record.id]: event.target.value }))} />
                      <button type="button" className="secondary"
                        disabled={Boolean(customRelationSearching) || (customRelationQuery[record.id] || "").trim().length < 2}
                        onClick={() => void findCustomRelationTargets(record)}>
                        {customRelationSearching === record.id ? "FINDING…" : "FIND"}
                      </button>
                      <select aria-label={`Relation target for ${record.display_name}`} required
                        value={customRelationDraft[record.id]?.target_id || ""}
                        onChange={(event) => setCustomRelationDraft((current) => ({ ...current,
                          [record.id]: { target_type: current[record.id]?.target_type || "contact",
                            target_id: event.target.value, label: current[record.id]?.label || "" },
                        }))}>
                        <option value="">{(customRelationTargets[record.id] || []).length ? "Choose a match" : "Search first"}</option>
                        {(customRelationTargets[record.id] || []).map((target) =>
                          <option key={target.id} value={target.id}>{target.label}{target.detail ? ` — ${target.detail}` : ""}</option>)}
                      </select>
                      <input aria-label={`Relation label for ${record.display_name}`} required maxLength={80}
                        placeholder="Relationship label" value={customRelationDraft[record.id]?.label || ""}
                        onChange={(event) => setCustomRelationDraft((current) => ({ ...current,
                          [record.id]: { target_type: current[record.id]?.target_type || "contact",
                            target_id: current[record.id]?.target_id || "", label: event.target.value },
                        }))} />
                      <button type="submit" disabled={Boolean(mutating) || !customRelationDraft[record.id]?.target_id}>LINK</button>
                    </form>}
                  </article>)}
                  {!customObjectRecordsLoading && !customObjectRecords.length &&
                    <div className="empty-state">No {selectedCustomObject.plural_label.toLowerCase()} yet.</div>}
                </section>
                {selectedCustomObject.active && selectedCustomObject.authority.configure && <form className="custom-object-add-field" onSubmit={addCustomObjectField}>
                  <div><p className="eyebrow">EVOLVE SCHEMA SAFELY</p><h4>Add an optional field</h4>
                    <small>Existing keys and types cannot be removed or changed while records exist.</small></div>
                  <input aria-label="New custom object field label" required maxLength={80} placeholder="Field label"
                    value={customObjectFieldDraft.label} onChange={(event) => setCustomObjectFieldDraft((current) => ({ ...current, label: event.target.value }))} />
                  <input aria-label="New custom object field key" required maxLength={40} pattern="[a-z][a-z0-9_]{1,39}" placeholder="field_key"
                    value={customObjectFieldDraft.key} onChange={(event) => setCustomObjectFieldDraft((current) => ({ ...current, key: event.target.value }))} />
                  <select aria-label="New custom object field type" value={customObjectFieldDraft.type}
                    onChange={(event) => setCustomObjectFieldDraft((current) => ({ ...current, type: event.target.value as CustomObjectField["type"] }))}>
                    <option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes / No</option>
                    <option value="date">Date</option><option value="select">Select</option></select>
                  {customObjectFieldDraft.type === "select" && <textarea aria-label="New custom object select options"
                    placeholder={"One option per line"} value={customObjectFieldDraft.options}
                    onChange={(event) => setCustomObjectFieldDraft((current) => ({ ...current, options: event.target.value }))} />}
                  <button type="submit" disabled={Boolean(mutating) || selectedCustomObject.fields.length >= 20}>ADD OPTIONAL FIELD</button>
                </form>}
              </> : canAdmin ? <form className="custom-object-create" onSubmit={createCustomObject}>
                <div><p className="eyebrow">CREATE THE FIRST OBJECT</p><h3>Start with one clear record type.</h3>
                  <small>You can add optional fields after creation.</small></div>
                <label>SINGULAR LABEL<input required maxLength={80} placeholder="Subscription"
                  value={customObjectDraft.singular} onChange={(event) => setCustomObjectDraft((current) => ({ ...current, singular: event.target.value }))} /></label>
                <label>PLURAL LABEL<input required maxLength={80} placeholder="Subscriptions"
                  value={customObjectDraft.plural} onChange={(event) => setCustomObjectDraft((current) => ({ ...current, plural: event.target.value }))} /></label>
                <label>SLUG<input required maxLength={40} pattern="[a-z][a-z0-9_]{1,39}" placeholder="subscriptions"
                  value={customObjectDraft.slug} onChange={(event) => setCustomObjectDraft((current) => ({ ...current, slug: event.target.value }))} /></label>
                <label>DESCRIPTION<input maxLength={500} placeholder="What this object represents"
                  value={customObjectDraft.description} onChange={(event) => setCustomObjectDraft((current) => ({ ...current, description: event.target.value }))} /></label>
                <label>FIRST FIELD LABEL<input required maxLength={80} placeholder="Plan"
                  value={customObjectDraft.fieldLabel} onChange={(event) => setCustomObjectDraft((current) => ({ ...current, fieldLabel: event.target.value }))} /></label>
                <label>FIRST FIELD KEY<input required maxLength={40} pattern="[a-z][a-z0-9_]{1,39}" placeholder="plan"
                  value={customObjectDraft.fieldKey} onChange={(event) => setCustomObjectDraft((current) => ({ ...current, fieldKey: event.target.value }))} /></label>
                <button type="submit" disabled={Boolean(mutating)}>CREATE CUSTOM OBJECT</button>
              </form> : <div className="empty-state">No custom-object access has been granted to your member role.</div>}
            </div>
          </div>
        </section>
        <section className="access-governance" id="access-governance" hidden={activeView !== "settings" || settingsView !== "access"}>
          <div className="section-head"><div><p>HUMAN ACCESS GOVERNANCE</p><h2>Decide what members can see and change.</h2></div>
            <span>{accessPolicy ? `POLICY R${accessPolicy.policy.revision}` : "POLICY UNAVAILABLE"}</span></div>
          {!accessPolicy && <div className="empty-state">The workspace permission policy could not be loaded.</div>}
          {accessPolicy && <div className="access-governance-grid">
            <article className="access-principal-card">
              <div className="access-principal-head"><div><i>M</i><span><strong>WORKSPACE MEMBER</strong><small>Deny-by-default CRM collaboration</small></span></div><mark>{accessPolicy.members.filter((member) => member.role === "member" && member.active).length} ACTIVE</mark></div>
              <p>Owners and admins retain full operator control. Agent credentials remain separately scoped and can only propose sensitive writes.</p>
              <div className="access-invariants"><span>OWNER <b>FULL</b></span><span>ADMIN <b>FULL</b></span><span>DELETE <b>ADMIN ONLY</b></span><span>AGENTS <b>SEPARATE</b></span></div>
            </article>
            <article className="access-capability-card">
              <div><p className="eyebrow">OPPORTUNITY ACCESS</p><h3>Pipeline visibility and execution</h3><small>Without Read pipeline, members cannot see revenue, deals, linked tasks, forecasts, or opportunity search results.</small></div>
              <div className="access-capability-list">
                {[
                  ["read", "Read pipeline", "See opportunities, revenue, forecasts, and linked work"],
                  ["create", "Create opportunities", "Qualify contacts into the pipeline"],
                  ["update", "Update opportunities", "Required before any deal field permission"],
                ].map(([grant, label, description]) => <button key={grant} type="button"
                  className={opportunityAccessDraft.includes(grant) ? "enabled" : ""}
                  aria-pressed={opportunityAccessDraft.includes(grant)}
                  disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                  onClick={() => toggleMemberOpportunityGrant(grant)}>
                  <span><strong>{label}</strong><small>{description}</small></span><i>{opportunityAccessDraft.includes(grant) ? "ALLOW" : "DENY"}</i>
                </button>)}
              </div>
              <div className="access-field-grid">
                {[
                  ["update_field:stage_id", "Pipeline stage"],
                  ["update_field:status", "Deal status"],
                  ["update_field:value", "Deal value"],
                  ["update_field:probability", "Probability"],
                  ["update_field:owner", "Assigned owner"],
                  ["update_field:expected_close_at", "Expected close"],
                  ["update_field:next_step", "Next step"],
                  ["update_field:lost_reason", "Lost reason"],
                ].map(([grant, label]) => <button key={grant} type="button"
                  className={opportunityAccessDraft.includes(grant) ? "enabled" : ""}
                  aria-pressed={opportunityAccessDraft.includes(grant)}
                  disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                  onClick={() => toggleMemberOpportunityGrant(grant)}>
                  <span>{label}</span><i>{opportunityAccessDraft.includes(grant) ? "✓" : "—"}</i>
                </button>)}
              </div>
              {!!accessPolicy.policy.opportunity.custom_fields.length && <div className="access-field-grid custom-access-field-grid">
                {accessPolicy.policy.opportunity.custom_fields.flatMap((field) => [
                  <button key={field.read_grant} type="button"
                    className={opportunityAccessDraft.includes(field.read_grant) ? "enabled" : ""}
                    aria-pressed={opportunityAccessDraft.includes(field.read_grant)}
                    disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                    onClick={() => toggleMemberOpportunityGrant(field.read_grant)}>
                    <span><b>{field.label}</b><code>{field.field_key} · READ</code></span>
                    <i>{opportunityAccessDraft.includes(field.read_grant) ? "ALLOW" : "DENY"}</i>
                  </button>,
                  <button key={field.grant} type="button"
                    className={opportunityAccessDraft.includes(field.grant) ? "enabled" : ""}
                    aria-pressed={opportunityAccessDraft.includes(field.grant)}
                    disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                    onClick={() => toggleMemberOpportunityGrant(field.grant)}>
                    <span><b>{field.label}</b><code>{field.field_key} · EDIT</code></span>
                    <i>{opportunityAccessDraft.includes(field.grant) ? "ALLOW" : "DENY"}</i>
                  </button>,
                ])}
              </div>}
            </article>
            <article className="access-capability-card">
              <div><p className="eyebrow">CONTACT ACTIONS</p><h3>Member collaboration envelope</h3><small>Removing a capability takes effect on the next request. Existing records are not changed.</small></div>
              <div className="access-capability-list">
                {[
                  ["create", "Create contacts", "Add a person manually"],
                  ["note", "Add notes", "Write relationship context"],
                  ["update", "Update contacts", "Required before any field permission"],
                ].map(([grant, label, description]) => <button key={grant} type="button"
                  className={accessDraft.includes(grant) ? "enabled" : ""}
                  aria-pressed={accessDraft.includes(grant)}
                  disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                  onClick={() => toggleMemberContactGrant(grant)}>
                  <span><strong>{label}</strong><small>{description}</small></span><i>{accessDraft.includes(grant) ? "ALLOW" : "DENY"}</i>
                </button>)}
              </div>
            </article>
            <article className="access-fields-card">
              <div><p className="eyebrow">FIELD-LEVEL CONTROL</p><h3>Which operational fields can members move?</h3></div>
              <div className="access-field-grid">
                {[
                  ["update_field:stage", "Lifecycle stage"],
                  ["update_field:status", "Record status"],
                  ["update_field:owner", "Assigned owner"],
                  ["update_field:next_follow_up_at", "Next follow-up"],
                ].map(([grant, label]) => <button key={grant} type="button"
                  className={accessDraft.includes(grant) ? "enabled" : ""}
                  aria-pressed={accessDraft.includes(grant)}
                  disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                  onClick={() => toggleMemberContactGrant(grant)}>
                  <span>{label}</span><i>{accessDraft.includes(grant) ? "✓" : "—"}</i>
                </button>)}
              </div>
              {!!accessPolicy.policy.custom_fields.length && <>
                <div><p className="eyebrow">GOVERNED CUSTOM FIELDS</p><small>Each field stays denied until explicitly granted. Archiving a field removes it from this policy surface.</small></div>
                <div className="access-field-grid custom-access-field-grid">
                  {accessPolicy.policy.custom_fields.flatMap((field) => [
                    <button key={field.read_grant} type="button"
                      className={accessDraft.includes(field.read_grant) ? "enabled" : ""}
                      aria-pressed={accessDraft.includes(field.read_grant)}
                      disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                      onClick={() => toggleMemberContactGrant(field.read_grant)}>
                      <span><b>{field.label}</b><code>{field.field_key} · READ</code></span>
                      <i>{accessDraft.includes(field.read_grant) ? "ALLOW" : "DENY"}</i>
                    </button>,
                    <button key={field.grant} type="button"
                      className={accessDraft.includes(field.grant) ? "enabled" : ""}
                      aria-pressed={accessDraft.includes(field.grant)}
                      disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                      onClick={() => toggleMemberContactGrant(field.grant)}>
                      <span><b>{field.label}</b><code>{field.field_key} · EDIT</code></span>
                      <i>{accessDraft.includes(field.grant) ? "ALLOW" : "DENY"}</i>
                    </button>,
                  ])}
                </div>
              </>}
              {!!accessPolicy.policy.custom_objects.length && <div className="custom-object-access-list">
                <div><p className="eyebrow">CUSTOM OBJECT ACCESS</p>
                  <h3>Grant one business object at a time.</h3>
                  <small>Read is the gateway. Field edits require object update and matching field visibility. Relations remain admin-only.</small></div>
                {accessPolicy.policy.custom_objects.map((definition) => {
                  const grants = customObjectAccessDraft[definition.object_id] || [];
                  return <section key={definition.object_id} aria-label={`${definition.plural_label} member permissions`}>
                    <header><div><strong>{definition.plural_label}</strong><code>{definition.slug}</code></div>
                      <mark>{grants.includes("read") ? "VISIBLE" : "HIDDEN"}</mark></header>
                    <div className="access-capability-list">
                      {[
                        ["read", "Read records", "See names and explicitly readable fields"],
                        ["create", "Create records", "Create names and permitted fields"],
                        ["update", "Update records", "Rename records and edit permitted fields"],
                        ["delete", "Delete records", "Version-checked deletion with audit"],
                      ].map(([grant, label, description]) => <button key={grant} type="button"
                        className={grants.includes(grant) ? "enabled" : ""}
                        aria-pressed={grants.includes(grant)}
                        disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                        onClick={() => toggleMemberCustomObjectGrant(definition.object_id, grant)}>
                        <span><strong>{label}</strong><small>{description}</small></span>
                        <i>{grants.includes(grant) ? "ALLOW" : "DENY"}</i>
                      </button>)}
                    </div>
                    <div className="access-field-grid custom-access-field-grid">
                      {definition.fields.flatMap((field) => [
                        <button key={field.read_grant} type="button"
                          className={grants.includes(field.read_grant) ? "enabled" : ""}
                          aria-pressed={grants.includes(field.read_grant)}
                          disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                          onClick={() => toggleMemberCustomObjectGrant(definition.object_id, field.read_grant)}>
                          <span><b>{field.label}</b><code>{field.field_key} · READ</code></span>
                          <i>{grants.includes(field.read_grant) ? "ALLOW" : "DENY"}</i>
                        </button>,
                        <button key={field.update_grant} type="button"
                          className={grants.includes(field.update_grant) ? "enabled" : ""}
                          aria-pressed={grants.includes(field.update_grant)}
                          disabled={!accessPolicy.policy.editable || Boolean(mutating)}
                          onClick={() => toggleMemberCustomObjectGrant(definition.object_id, field.update_grant)}>
                          <span><b>{field.label}</b><code>{field.field_key} · WRITE</code></span>
                          <i>{grants.includes(field.update_grant) ? "ALLOW" : "DENY"}</i>
                        </button>,
                      ])}
                    </div>
                  </section>;
                })}
              </div>}
              <footer><small>Last changed by {accessPolicy.policy.updated_by} · {new Date(accessPolicy.policy.updated_at).toLocaleString()}</small>
                {accessPolicy.policy.editable
                  ? <button type="button" disabled={Boolean(mutating) ||
                    (JSON.stringify([...accessDraft].sort()) === JSON.stringify([...accessPolicy.policy.grants].sort()) &&
                    JSON.stringify([...opportunityAccessDraft].sort()) === JSON.stringify([...accessPolicy.policy.opportunity.grants].sort()) &&
                    JSON.stringify(Object.entries(customObjectAccessDraft).sort().map(([id, grants]) => [id, [...grants].sort()])) ===
                      JSON.stringify(accessPolicy.policy.custom_objects.map((definition) =>
                        [definition.object_id, [...definition.grants].sort()]).sort(([left], [right]) =>
                          String(left).localeCompare(String(right)))))}
                    onClick={() => setAccessPolicyReviewOpen(true)}>REVIEW POLICY CHANGE</button>
                  : <mark>OWNER EDIT REQUIRED</mark>}</footer>
              {accessPolicyReviewOpen && <div className="access-policy-review" role="alert">
                <div><strong>CONFIRM MEMBER AUTHORITY</strong><small>This changes the next request for every workspace member. No existing CRM record will be modified.</small></div>
                <dl><div><dt>ALLOW</dt><dd>{accessDraft.length + opportunityAccessDraft.length +
                  Object.values(customObjectAccessDraft).reduce((sum, grants) => sum + grants.length, 0)}</dd></div>
                  <div><dt>DENY</dt><dd>{accessPolicy.policy.allowed_grants.length +
                    accessPolicy.policy.opportunity.allowed_grants.length +
                    accessPolicy.policy.custom_objects.reduce((sum, definition) => sum + definition.allowed_grants.length, 0) -
                    accessDraft.length - opportunityAccessDraft.length -
                    Object.values(customObjectAccessDraft).reduce((sum, grants) => sum + grants.length, 0)}</dd></div>
                  <div><dt>FROM</dt><dd>R{accessPolicy.policy.revision}</dd></div>
                  <div><dt>TO</dt><dd>R{accessPolicy.policy.revision + 1}</dd></div></dl>
                <div><button type="button" disabled={Boolean(mutating)} onClick={() => void saveAccessPolicy()}>{mutating === "access-policy" ? "SAVING POLICY…" : "CONFIRM + APPLY"}</button>
                  <button type="button" className="secondary" disabled={Boolean(mutating)} onClick={() => setAccessPolicyReviewOpen(false)}>CANCEL</button></div>
              </div>}
            </article>
          </div>}
        </section>
        <section className="launch-panel" id="launch" hidden={activeView !== "settings" || settingsView !== "readiness"}><div className="section-head"><div><p>PRODUCTIZATION QA</p><h2>Launch control.</h2><small>Checks current configuration and safety guards without creating test leads, runs, or deliveries.</small></div>
          <div className="launch-actions"><span>{control?.checks.filter((check) => check.status === "passed").length || 0}/{control?.checks.length || 0} READY</span>{canAdmin && <button disabled={Boolean(mutating)} onClick={() => void runLaunchChecks()}>{mutating === "launch" ? "RUNNING…" : "RUN READINESS CHECKS"}</button>}</div></div>
          {canAdmin && <section className="operations-health" aria-label="Background operations health">
            <header><div><p>BACKGROUND OPERATIONS</p><h3>Is the CRM doing its work?</h3>
              <small>Read-only diagnostics across the scheduler, delivery retries, workflows, agent leases, and transactional email.</small></div>
              <div>{operationsHealth && <mark className={operationsHealth.status}>{operationsHealth.status === "action" ? "ACTION REQUIRED" : operationsHealth.status.toUpperCase()}</mark>}
                <button type="button" disabled={operationsHealthLoading} onClick={() => void loadOperationsHealth()}>
                  {operationsHealthLoading ? "CHECKING…" : "REFRESH HEALTH"}
                </button></div></header>
            {operationsHealthLoading && !operationsHealth && <div className="operations-health-loading">Checking background operations…</div>}
            {!operationsHealthLoading && !operationsHealth && <div className="operations-health-loading">Operational health is unavailable. Refresh to retry.</div>}
            {operationsHealth && <><div className="operations-health-grid">{operationsHealth.components.map((component) =>
              <article className={component.status} key={component.id}><div><i></i><span>{component.status === "action" ? "ACTION" : component.status.toUpperCase()}</span></div>
                <h4>{component.label}</h4><strong>{component.summary}</strong><small>{component.details}</small>
                {component.last_event_at && <time dateTime={component.last_event_at}>Latest evidence {new Date(component.last_event_at).toLocaleString()}</time>}
                {component.id !== "scheduler" && <button type="button" onClick={() => {
                  setActiveView(component.id === "webhooks" || component.id === "email" ? "integrations" : "automations");
                  setError(""); setNotice("");
                }}>{component.id === "webhooks" || component.id === "email" ? "OPEN INTEGRATIONS" : "OPEN AUTOMATIONS"}</button>}
              </article>)}</div>
              <div className="operations-history">
                <section aria-label="Recent operations health history">
                  <div><p>RECENT RELIABILITY</p><small>{operationsHealth.history_window.returned_snapshots
                    ? `${operationsHealth.history_window.healthy} healthy · ${operationsHealth.history_window.watch} watch · ${operationsHealth.history_window.action} action`
                    : "History begins with the next signed scheduler sweep"}</small></div>
                  <div className="operations-slo-windows">{operationsHealth.slo_windows.map((window) =>
                    <article key={window.label}><small>{window.label} HEALTHY SNAPSHOTS</small>
                      <strong>{window.healthy_percentage === null ? "—" : `${window.healthy_percentage}%`}</strong>
                      <span>{window.total} observed · {window.action} action</span></article>)}</div>
                  {operationsHealth.history.length
                    ? <div className="operations-history-strip" aria-label={`${operationsHealth.history.length} retained health snapshots`}>
                      {[...operationsHealth.history].reverse().map((snapshot) =>
                        <i key={snapshot.observed_at} className={snapshot.status}
                          title={`${new Date(snapshot.observed_at).toLocaleString()} · ${snapshot.status} · ${snapshot.attention_count} need attention`}></i>)}
                    </div>
                    : <div className="operations-history-empty">No retained snapshots yet.</div>}
                  <small>One snapshot per minute · retained {operationsHealth.history_window.retained_days} days</small>
                </section>
                <section aria-label="Operations incidents and alerts">
                  <div><p>INCIDENTS + ALERTS</p><small>{operationsHealth.incidents.filter((incident) => incident.status === "open").length} open · {operationsHealth.alerting.subscribed_endpoints} alert destination{operationsHealth.alerting.subscribed_endpoints === 1 ? "" : "s"}</small></div>
                  {operationsHealth.incidents.slice(0, 3).map((incident) =>
                    <article key={incident.id}><mark className={incident.status}>{incident.status.toUpperCase()}</mark>
                      <span>{incident.component_ids.join(", ") || "Operations"}</span>
                      {incident.escalation_delays_minutes.length > 0 && <small>
                        {incident.escalated_steps.length}/{incident.escalation_delays_minutes.length} escalation reminders triggered
                      </small>}
                      <time dateTime={incident.opened_at}>{new Date(incident.opened_at).toLocaleString()}</time></article>)}
                  {!operationsHealth.incidents.length && <div className="operations-history-empty">No health incidents recorded.</div>}
                  <button type="button" onClick={() => {
                    setActiveView("integrations"); setIntegrationDomain("webhooks"); setIntegrationCatalogOpen(false);
                    setError(""); setNotice("");
                  }}>
                    {operationsHealth.alerting.subscribed_endpoints ? "MANAGE ALERT WEBHOOKS" : "ADD ALERT WEBHOOK"}
                  </button>
                  <small>Subscribe an outbound webhook to incident, escalation, and recovery events. Delivery is signed and retried.</small>
                </section>
              </div>
              {operationsPolicyDraft && <section className="operations-policy" aria-label="Operations alert policy">
                <header><div><p>ALERT POLICY</p><h4>When should operators be paged?</h4>
                  <small>Policy changes affect future incident transitions only. History and existing incidents stay intact.</small></div>
                  <mark>R{operationsHealth.policy.revision || "DEFAULT"}</mark></header>
                <div className="operations-policy-fields">
                  <label htmlFor="operations-target">HEALTHY SNAPSHOT TARGET<select id="operations-target"
                    value={operationsPolicyDraft.target}
                    onChange={(event) => { setOperationsPolicyDraft((current) => current && ({ ...current, target: Number(event.target.value) })); setOperationsPolicyReviewOpen(false); }}>
                    {[95, 99, 99.5, 99.9, 100].map((target) => <option key={target} value={target}>{target}%</option>)}
                  </select><small>Reporting target for the 24h, 7d, and 30d windows.</small></label>
                  <label htmlFor="operations-consecutive">OPEN INCIDENT AFTER<select id="operations-consecutive"
                    value={operationsPolicyDraft.consecutive}
                    onChange={(event) => { setOperationsPolicyDraft((current) => current && ({ ...current, consecutive: Number(event.target.value) })); setOperationsPolicyReviewOpen(false); }}>
                    {[1, 2, 3, 5, 10].map((count) => <option key={count} value={count}>{count} consecutive action sweep{count === 1 ? "" : "s"}</option>)}
                  </select><small>Prevents a single transient action state from paging when raised.</small></label>
                  <label className="operations-policy-toggle"><input type="checkbox" checked={operationsPolicyDraft.recovery}
                    onChange={(event) => { setOperationsPolicyDraft((current) => current && ({ ...current, recovery: event.target.checked })); setOperationsPolicyReviewOpen(false); }} />
                    <span><b>NOTIFY ON RECOVERY</b><small>Send one signed recovery event when an open incident resolves.</small></span></label>
                  <label htmlFor="operations-escalations">ESCALATION REMINDERS<select id="operations-escalations"
                    value={operationsPolicyDraft.escalations.join(",")}
                    onChange={(event) => {
                      const escalations = event.target.value
                        ? event.target.value.split(",").map((delay) => Number(delay)) : [];
                      setOperationsPolicyDraft((current) => current && ({ ...current, escalations }));
                      setOperationsPolicyReviewOpen(false);
                    }}>
                    <option value="">No reminders</option>
                    <option value="15">After 15 minutes</option>
                    <option value="15,60">After 15 minutes + 1 hour</option>
                    <option value="15,60,240">After 15 minutes + 1 hour + 4 hours</option>
                  </select><small>Up to three one-time reminders while a new incident remains open.</small></label>
                </div>
                <div className="operations-policy-windows">{operationsHealth.slo_windows.map((window) => {
                  const passing = window.healthy_percentage === null || window.healthy_percentage >= operationsPolicyDraft.target;
                  return <span key={window.label} className={passing ? "passing" : "breached"}><b>{window.label}</b>
                    {window.healthy_percentage === null ? "NO DATA" : passing ? "ON TARGET" : "BELOW TARGET"}</span>;
                })}</div>
                <footer><small>{operationsHealth.policy.updated_at
                  ? `Last changed by ${operationsHealth.policy.updated_by} · ${new Date(operationsHealth.policy.updated_at).toLocaleString()}`
                  : "Using safe workspace defaults; no custom policy saved yet."}</small>
                  <button type="button" disabled={Boolean(mutating) ||
                    (operationsPolicyDraft.target === operationsHealth.policy.target_healthy_percentage &&
                    operationsPolicyDraft.consecutive === operationsHealth.policy.incident_after_consecutive_action &&
                    operationsPolicyDraft.recovery === operationsHealth.policy.notify_on_recovery &&
                    operationsPolicyDraft.escalations.join(",") === operationsHealth.policy.escalation_delays_minutes.join(","))}
                    onClick={() => setOperationsPolicyReviewOpen(true)}>REVIEW POLICY CHANGE</button></footer>
                {operationsPolicyReviewOpen && <div className="operations-policy-review" role="alert">
                  <div><strong>CONFIRM FUTURE ALERT BEHAVIOR</strong><small>No record, snapshot, or existing incident will be changed.</small></div>
                  <dl><div><dt>TARGET</dt><dd>{operationsPolicyDraft.target}%</dd></div>
                    <div><dt>OPEN AFTER</dt><dd>{operationsPolicyDraft.consecutive} action sweep{operationsPolicyDraft.consecutive === 1 ? "" : "s"}</dd></div>
                    <div><dt>REMINDERS</dt><dd>{operationsPolicyDraft.escalations.length
                      ? operationsPolicyDraft.escalations.map((delay) => `${delay}m`).join(" + ") : "OFF"}</dd></div>
                    <div><dt>RECOVERY</dt><dd>{operationsPolicyDraft.recovery ? "SEND" : "SILENT"}</dd></div></dl>
                  <div><button type="button" disabled={Boolean(mutating)} onClick={() => void saveOperationsHealthPolicy()}>
                    {mutating === "operations-policy" ? "APPLYING…" : "CONFIRM + APPLY"}</button>
                    <button type="button" disabled={Boolean(mutating)} onClick={() => setOperationsPolicyReviewOpen(false)}>CANCEL</button></div>
                </div>}
              </section>}
              <footer><span>{operationsHealth.attention_count} component{operationsHealth.attention_count === 1 ? "" : "s"} need attention</span>
                <small>Generated {new Date(operationsHealth.generated_at).toLocaleString()} · no record content inspected or changed</small>
                {operationsHealth.active_operation && <small>Active protected operation: {operationsHealth.active_operation.operation} until {new Date(operationsHealth.active_operation.lease_until).toLocaleString()}</small>}</footer></>}
          </section>}
          <div className="check-list">{(control?.checks ?? []).map((check) => <article key={check.id}><i className={check.status}></i><div><strong>{check.label}</strong><small>{check.details}</small>{check.checked_at && <time dateTime={check.checked_at}>Checked {new Date(check.checked_at).toLocaleString()}</time>}</div><mark>{check.status}</mark></article>)}</div>
          <div className="audit-feed"><p className="eyebrow">RECENT AUDIT TRAIL</p>{(control?.audits ?? []).slice(0, 6).map((entry) => <small key={entry.id}><b>{entry.action}</b> · {entry.entity_type} · {new Date(entry.created_at).toLocaleString()}</small>)}</div>
        </section>
        <section className="custom-field-manager" hidden={activeView !== "settings" || settingsView !== "fields"}>
          <div className="section-head"><div><p>CRM METADATA</p><h2>Core object field manager.</h2></div><span>{customFields.filter((field) => field.object_type === customFieldObject && field.active).length} ACTIVE</span></div>
          <div className="custom-field-object-switch" role="tablist" aria-label="Custom field object">
            {(["contact", "company", "opportunity"] as const).map((objectType) => <button type="button" role="tab"
              aria-selected={customFieldObject === objectType} className={customFieldObject === objectType ? "active" : ""}
              key={objectType} onClick={() => setCustomFieldObject(objectType)}>
              {{ contact: "CONTACTS", company: "ACCOUNTS", opportunity: "OPPORTUNITIES" }[objectType]}</button>)}
          </div>
          <div className="custom-field-layout">
            <div className="custom-field-list">
              {customFields.filter((field) => field.object_type === customFieldObject).map((field) => <article key={field.id} className={field.active ? "" : "archived"}>
                <div><strong>{field.label}</strong><code>{field.field_key}</code></div>
                <span>{field.field_type.toUpperCase()}{field.required ? " · REQUIRED" : ""}</span>
                <small>{field.field_type === "select" ? field.options.join(" · ") : `Position ${field.position + 1}`} · revision {field.revision}</small>
                {canAdmin && field.active && <button type="button" disabled={Boolean(mutating)}
                  onClick={() => void archiveCustomField(field)}>{mutating === `custom-field:${field.id}` ? "ARCHIVING…" : "ARCHIVE FIELD"}</button>}
                {!field.active && <mark>ARCHIVED · VALUES PRESERVED</mark>}
              </article>)}
              {!customFields.some((field) => field.object_type === customFieldObject) && <div className="empty-state">No governed {customFieldObject} fields yet. Create the first field to extend every record.</div>}
            </div>
            {canAdmin && <form className="custom-field-form" onSubmit={createCustomField}>
              <p className="eyebrow">CREATE {customFieldObject.toUpperCase()} FIELD</p>
              <label htmlFor="custom-field-label">LABEL</label>
              <input id="custom-field-label" required maxLength={80} value={customFieldDraft.label}
                onChange={(event) => setCustomFieldDraft((draft) => ({
                  ...draft, label: event.target.value,
                  fieldKey: draft.fieldKey || event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40),
                }))} placeholder="Customer tier" />
              <label htmlFor="custom-field-key">API KEY</label>
              <input id="custom-field-key" required minLength={2} maxLength={40} pattern="[a-z][a-z0-9_]{1,39}"
                value={customFieldDraft.fieldKey} onChange={(event) => setCustomFieldDraft((draft) => ({ ...draft, fieldKey: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") }))} placeholder="customer_tier" />
              <label htmlFor="custom-field-type">TYPE</label>
              <select id="custom-field-type" value={customFieldDraft.fieldType}
                onChange={(event) => setCustomFieldDraft((draft) => ({ ...draft, fieldType: event.target.value as CustomFieldDefinition["field_type"], options: "" }))}>
                <option value="text">Text</option><option value="number">Number</option><option value="boolean">Checkbox</option>
                <option value="date">Date</option><option value="select">Select</option>
              </select>
              {customFieldDraft.fieldType === "select" && <><label htmlFor="custom-field-options">OPTIONS · ONE PER LINE</label>
                <textarea id="custom-field-options" required maxLength={4000} value={customFieldDraft.options}
                  onChange={(event) => setCustomFieldDraft((draft) => ({ ...draft, options: event.target.value }))} placeholder={"Enterprise\nGrowth\nStarter"} /></>}
              <label className="custom-field-required"><input type="checkbox" checked={customFieldDraft.required}
                onChange={(event) => setCustomFieldDraft((draft) => ({ ...draft, required: event.target.checked }))} /> REQUIRED WHEN SET OR EDITED</label>
              <button type="submit" disabled={Boolean(mutating)}>{mutating === "custom-field-create" ? "CREATING…" : "CREATE FIELD"}</button>
              <small>Field keys are immutable API contracts. Archiving hides a field but preserves every stored value.</small>
            </form>}
          </div>
        </section>
        <section className="recovery-panel" id="recovery" hidden={activeView !== "settings" || settingsView !== "recovery"}><div className="section-head"><div><p>ENCRYPTED RECOVERY</p><h2>Backup and restore this workspace.</h2></div><span>ADMIN ONLY</span></div>
          {!canAdmin && <div className="empty-state">An owner or admin must manage workspace recovery.</div>}
          {canAdmin && <div className="recovery-grid">
            <article><p className="eyebrow">1 · CREATE BACKUP</p><h3>Download an encrypted snapshot.</h3>
              <p>Includes CRM records, pipelines, tasks, notes, saved views, and automation definitions. Credentials and immutable audit history stay outside the archive.</p>
              <button disabled={Boolean(mutating)} onClick={() => void downloadWorkspaceBackup()}>{mutating === "recovery-export" ? "ENCRYPTING…" : "DOWNLOAD ENCRYPTED BACKUP"}</button>
              <small>Same-workspace recovery only. Store the file somewhere private.</small>
            </article>
            <article><p className="eyebrow">2 · VALIDATE FILE</p><h3>Authenticate before changing anything.</h3>
              <label className="recovery-file" htmlFor="recovery-file">SELECT .CRBACKUP.JSON FILE</label>
              <input id="recovery-file" type="file" accept=".json,.crbackup.json,application/json,application/vnd.openoperator.backup+json" disabled={Boolean(mutating)} onChange={(event) => {
                const file = event.currentTarget.files?.[0] || null;
                event.currentTarget.value = "";
                void validateWorkspaceBackup(file);
              }} />
              <small>{mutating === "recovery-validate" ? "Decrypting and validating…" : recoveryFileName || "No backup selected."}</small>
            </article>
          </div>}
          {canAdmin && recoveryPreview && <div className="recovery-review" role="alert">
            <div><p className="eyebrow">VALIDATED · NOTHING RESTORED YET</p><h3>{recoveryPreview.total_rows} records from {new Date(recoveryPreview.backup_created_at).toLocaleString()}</h3>
              <div className="recovery-counts">{Object.entries(recoveryPreview.counts).filter(([, count]) => count > 0).map(([table, count]) => <span key={table}><b>{count}</b>{table.replaceAll("_", " ")}</span>)}</div>
              <small>Preserved outside the restore: {recoveryPreview.preserved.join(" · ")}</small>
              <small>Cleared to prevent stale actions: {recoveryPreview.cleared.join(" · ")}</small>
            </div>
            <label htmlFor="recovery-confirmation">TYPE <code>{recoveryPreview.confirmation}</code> TO REPLACE CURRENT BUSINESS DATA</label>
            <input id="recovery-confirmation" autoComplete="off" value={recoveryConfirmation} onChange={(event) => setRecoveryConfirmation(event.target.value)} />
            <div className="recovery-actions"><button className="danger-action" disabled={Boolean(mutating) || recoveryConfirmation !== recoveryPreview.confirmation} onClick={() => void commitWorkspaceRestore()}>{mutating === "recovery-commit" ? "RESTORING ATOMICALLY…" : "COMMIT WORKSPACE RESTORE"}</button>
              <button disabled={Boolean(mutating)} onClick={() => void cancelWorkspaceRestore()}>{mutating === "recovery-cancel" ? "CANCELLING…" : "CANCEL RESTORE"}</button></div>
            <small>If any CRM data changed after validation, the restore will be rejected and must be validated again.</small>
          </div>}
        </section>
      </section>
      <section className="sources-panel integration-control-center" id="integrations" hidden={activeView !== "integrations"}><div className="section-head"><div><p>CONNECTION CONTROL CENTER</p><h2>Every system. One governed boundary.</h2></div><span>PRIVATE + AUDITED</span></div>
        <div className="integration-catalog-summary" aria-label="Integration catalog status">
          <div><span>CONFIGURED</span><b>{productCatalog ? configuredIntegrations.length : "—"}</b><small>Runtime requirements satisfied</small></div>
          <div><span>AVAILABLE</span><b>{productCatalog ? implementedIntegrations.length : "—"}</b><small>Executable lifecycle implemented</small></div>
          <div><span>PLANNED</span><b>{productCatalog ? plannedIntegrations.length : "—"}</b><small>Visible roadmap, not connectable</small></div>
          <div><span>CATALOG</span><b>{productCatalog ? `V${productCatalog.version}` : "—"}</b><small>Shared UI + Worker contract</small></div>
        </div>
        <div className="integration-catalog-disclosure">
          <div><strong>{integrationCatalogOpen ? "CONNECTION CATALOG OPEN" : "WORKSPACE CONTROLS FIRST"}</strong>
            <small>{integrationCatalogOpen
              ? "Choose a connector, then return to its focused setup panel."
              : "Use the tabs below for active operations. Open the catalog only when adding or reviewing a connector."}</small></div>
          <button type="button" aria-expanded={integrationCatalogOpen} aria-controls="integration-catalog"
            onClick={() => setIntegrationCatalogOpen((current) => !current)}>
            {integrationCatalogOpen ? "CLOSE CATALOG" : "BROWSE CONNECTORS"}
          </button>
        </div>
        <section id="integration-catalog" className="integration-catalog" aria-labelledby="integration-catalog-title"
          hidden={!integrationCatalogOpen}>
          <header>
            <div><p className="eyebrow">SHARED CONNECTION CATALOG</p><h3 id="integration-catalog-title">Choose a system, then configure its governed boundary.</h3>
              <small>Installed means this workspace has an active connection. Available means the complete server lifecycle exists. Planned connectors cannot be started.</small></div>
            <div className="integration-catalog-switch" role="group" aria-label="Integration catalog view">
              <button type="button" className={integrationCatalogView === "catalog" ? "active" : ""}
                aria-pressed={integrationCatalogView === "catalog"} onClick={() => setIntegrationCatalogView("catalog")}>ALL</button>
              <button type="button" className={integrationCatalogView === "installed" ? "active" : ""}
                aria-pressed={integrationCatalogView === "installed"} onClick={() => setIntegrationCatalogView("installed")}>INSTALLED <b>{installedIntegrationIds.size}</b></button>
            </div>
          </header>
          <div className="integration-catalog-grid">
            {catalogIntegrations.map((integration) => {
              const installed = installedIntegrationIds.has(integration.id);
              const needsAttention = attentionIntegrationIds.has(integration.id);
              const connectable = integration.availability === "implemented" && integration.runtime.configured;
              const state = installed ? "installed" : needsAttention ? "attention"
                : integration.availability === "planned" ? "planned"
                : connectable ? "available" : "blocked";
              return <article key={integration.id} className={`integration-catalog-card integration-${state}`}>
                <div className="integration-catalog-card-head"><i aria-hidden="true">{integration.label.slice(0, 1)}</i>
                  <span><strong>{integration.label}</strong><small>{integration.category.replaceAll("_", " ")}</small></span>
                  <mark>{state.toUpperCase()}</mark></div>
                <p>{integration.capabilities.map((capability) => capability.replaceAll(".", " ")).join(" · ")}</p>
                <small>{installed ? "Active workspace connection"
                  : needsAttention ? "Existing connection requires owner attention"
                  : integration.availability === "planned" ? "Roadmap only — no executable handlers"
                    : connectable ? `${integration.authStrategy.replaceAll("_", " ")} setup is ready`
                      : `Needs private runtime setup${integration.runtime.missingBindings.length ? `: ${integration.runtime.missingBindings.join(", ")}` : ""}`}</small>
                <button type="button"
                  onClick={(event) => openIntegrationSetup(integration.id, event.currentTarget)}>
                  {installed || needsAttention ? "MANAGE" : integration.availability === "planned" ? "VIEW PLAN"
                    : !connectable ? "VIEW REQUIREMENTS" : canAdmin ? "CONFIGURE" : "VIEW SETUP"}
                </button>
              </article>;
            })}
            {productCatalog && !catalogIntegrations.length && <div className="empty-state">No active integrations are installed in this workspace.</div>}
            {!productCatalog && <div className="empty-state">Loading the governed connection catalog…</div>}
          </div>
        </section>
        <nav className="integration-status-strip" aria-label="Integration categories" role="tablist">
          <button type="button" id="integration-tab-mailboxes" role="tab" aria-selected={visibleIntegrationDomain === "mailboxes"} aria-controls="integration-mailbox"
            tabIndex={visibleIntegrationDomain === "mailboxes" ? 0 : -1} className={visibleIntegrationDomain === "mailboxes" ? "active" : ""}
            onKeyDown={(event) => moveIntegrationDomain(event, "mailboxes")} onClick={() => setIntegrationDomain("mailboxes")}><span>MAILBOXES</span>
            <b>{mailboxesError || (mailboxesLoading && !mailboxes) ? "—" : (mailboxes?.connections ?? []).filter((connection) => connection.status === "active").length}</b>
            <small>{mailboxesError ? "UNAVAILABLE" : mailboxesLoading && !mailboxes ? "LOADING" : mailboxNeedsAttention ? "ATTENTION" : "CONTROL ONLY"}</small>
          </button>
          {canAdmin && <button type="button" id="integration-tab-agents" role="tab" aria-selected={visibleIntegrationDomain === "agents"} aria-controls="integration-agents"
            tabIndex={visibleIntegrationDomain === "agents" ? 0 : -1} className={visibleIntegrationDomain === "agents" ? "active" : ""}
            onKeyDown={(event) => moveIntegrationDomain(event, "agents")} onClick={() => setIntegrationDomain("agents")}><span>AGENTS</span><b>{activeAgentCredentials.length}</b><small>SCOPED ACCESS</small></button>}
          <button type="button" id="integration-tab-sources" role="tab" aria-selected={visibleIntegrationDomain === "sources"} aria-controls="integration-sources"
            tabIndex={visibleIntegrationDomain === "sources" ? 0 : -1} className={visibleIntegrationDomain === "sources" ? "active" : ""}
            onKeyDown={(event) => moveIntegrationDomain(event, "sources")} onClick={() => setIntegrationDomain("sources")}><span>INBOUND SOURCES</span><b>{sources.filter((source) => source.active).length}</b><small>FUNNELS + SKOOL</small></button>
          <button type="button" id="integration-tab-webhooks" role="tab" aria-selected={visibleIntegrationDomain === "webhooks"} aria-controls="integration-webhooks"
            tabIndex={visibleIntegrationDomain === "webhooks" ? 0 : -1} className={visibleIntegrationDomain === "webhooks" ? "active" : ""}
            onKeyDown={(event) => moveIntegrationDomain(event, "webhooks")} onClick={() => setIntegrationDomain("webhooks")}><span>WEBHOOKS</span><b>{control?.webhooks.filter((hook) => hook.active).length ?? 0}</b><small>{webhookHealthLabel}</small></button>
        </nav>
        <section className="mailbox-command" id="integration-mailbox" role="tabpanel" aria-labelledby="integration-tab-mailboxes" hidden={visibleIntegrationDomain !== "mailboxes"}>
          <div className="mailbox-command-copy"><p className="eyebrow">PRIVATE MAILBOX CONTROL</p>
            <h2 id="mailbox-title">See the inbox context. Keep every action human-gated.</h2>
            <p>Load up to 10 recent conversation previews on demand. Bodies and attachments are never returned or persisted; drafting, sending, and deleting remain blocked.</p>
            <div className="mailbox-authority"><span>METADATA ON DEMAND</span><span>NO LOCAL MESSAGE STORE</span><span className="blocked">SEND BLOCKED</span><span className="blocked">DELETE BLOCKED</span></div>
          </div>
          <div className="mailbox-grid">
            <div className="mailbox-list">
              {mailboxesLoading && !mailboxes && <div className="mailbox-local-state" role="status">Loading private mailbox controls…</div>}
              {mailboxesError && <div className="mailbox-local-state error" role="alert"><span><b>MAILBOX CONTROL UNAVAILABLE</b><small>{mailboxesError}</small></span><button type="button" disabled={mailboxesLoading} onClick={() => void loadMailboxes()}>RETRY</button></div>}
              {(mailboxes?.connections ?? []).map((connection) => <article className={`mailbox-card mailbox-${connection.status}`} key={connection.id}
                data-mailbox-provider={connection.provider}
                data-mailbox-actionable={connection.status !== "disabled" && connection.status !== "revoked"} tabIndex={-1}>
                <div><i className={connection.status === "active" ? "on" : ""}></i><span>{connection.status.toUpperCase()}</span></div>
                <strong>{connection.alias}</strong><small>{connection.provider === "gmail" ? "GMAIL" : "MICROSOFT 365"} · {connection.owner_email}</small>
                <div className="mailbox-capabilities">{connection.allowed_capabilities.map((capability) => <mark key={capability}>
                  {capability === "mail.profile.read" ? "PROFILE READ POLICY" : capability === "mail.drafts.create" ? "DRAFT CREATE POLICY" : capability}
                </mark>)}</div>
                <small>{connection.status === "active" && connection.last_synced_at
                  ? `Verified ${new Date(connection.last_synced_at).toLocaleString()}`
                  : connection.last_error
                    || (connection.status === "pending" ? "OAuth completion pending"
                      : connection.status === "expired" ? "Provider authorization expired; recheck status, reconnect securely, or revoke access"
                      : connection.status === "revoked" ? "Provider authority revoked"
                        : connection.status === "disabled" ? "CRM use disabled; provider authority retained"
                          : connection.status === "active" ? "Provider account active; verification timestamp unavailable"
                            : "Provider state has not been verified")}</small>
                {connection.status === "error" && !connection.connected_account_id && <p className="mailbox-remediation">No provider account or token was created. Remove this failed setup, then reconnect with the same label.</p>}
                <div className="mailbox-actions">
                  {connection.status === "active" && <button type="button" disabled={Boolean(mutating) || Boolean(mailboxConversationLoading)}
                    onClick={() => void loadMailboxConversations(connection)}>
                    {mailboxConversationLoading === connection.id ? "LOADING PREVIEWS…" : "VIEW RECENT CONVERSATIONS"}
                  </button>}
                  {connection.connected_account_id && connection.status !== "revoked" && <button type="button" disabled={Boolean(mutating)}
                    onClick={() => void reconcileMailbox(connection)}>
                    {mutating === `mailbox-reconcile:${connection.id}` ? "VERIFYING…" : "RECHECK PROVIDER"}
                  </button>}
                  {connection.connected_account_id && (connection.status === "expired" || connection.status === "error") &&
                    <button type="button" disabled={Boolean(mutating)} onClick={() => void reconnectMailbox(connection)}>
                      {mutating === `mailbox-reconnect:${connection.id}` ? "OPENING SECURE LOGIN…"
                        : `RECONNECT ${connection.provider === "gmail" ? "GMAIL" : "MICROSOFT 365"}`}
                    </button>}
                  {connection.connected_account_id && connection.status !== "disabled" && connection.status !== "revoked" && <button type="button"
                    disabled={Boolean(mutating)} onClick={() => void disableMailbox(connection)}>
                    {mailboxActionArmed?.id === connection.id && mailboxActionArmed.action === "disable" ? "CONFIRM LOCAL DISABLE" : "DISABLE CRM USE"}
                  </button>}
                  {connection.connected_account_id && connection.status !== "revoked" && <button type="button" className="danger-action"
                    disabled={Boolean(mutating)} onClick={() => void revokeMailbox(connection)}>
                    {mailboxActionArmed?.id === connection.id && mailboxActionArmed.action === "revoke" ? "CONFIRM PROVIDER REVOKE" : "REVOKE TOKENS"}
                  </button>}
                  {connection.status === "error" && !connection.connected_account_id && <button type="button" className="danger-action"
                    disabled={Boolean(mutating)} onClick={() => void removeFailedMailbox(connection)}>
                    {mutating === `mailbox-remove:${connection.id}` ? "REMOVING…" :
                      mailboxActionArmed?.id === connection.id && mailboxActionArmed.action === "remove"
                        ? "CONFIRM REMOVE FAILED SETUP" : "REMOVE FAILED SETUP"}
                  </button>}
                  {mailboxActionArmed?.id === connection.id && <button type="button" className="secondary"
                    disabled={Boolean(mutating)} onClick={() => setMailboxActionArmed(null)}>CANCEL</button>}
                </div>
                {mailboxConversationError[connection.id] && <p className="mailbox-remediation" role="alert">
                  {mailboxConversationError[connection.id]}
                </p>}
                {mailboxConversations[connection.id] && <section className="mailbox-conversations"
                  aria-label={`Recent conversation metadata for ${connection.alias}`}>
                  <header><b>RECENT CONVERSATIONS</b><small>Live preview · not stored</small></header>
                  {mailboxConversations[connection.id].conversations.map((conversation) =>
                    <article key={`${connection.id}:${conversation.id}`} className={conversation.unread ? "unread" : ""}>
                      <div><strong>{conversation.subject}</strong>{conversation.unread && <mark>UNREAD</mark>}</div>
                      <small>{conversation.sender_name || conversation.sender_email || "Unknown sender"}
                        {conversation.sender_name && conversation.sender_email ? ` · ${conversation.sender_email}` : ""}
                        {conversation.received_at ? ` · ${new Date(conversation.received_at).toLocaleString()}` : ""}</small>
                      {conversation.snippet && <p>{conversation.snippet}</p>}
                    </article>)}
                  {!mailboxConversations[connection.id].conversations.length &&
                    <div className="empty-state">No recent conversation metadata was returned.</div>}
                  <small>Bodies, attachments, drafts, sending, and deletion are outside this view&apos;s authority.</small>
                </section>}
              </article>)}
              {mailboxes && !mailboxesError && !mailboxes.connections.length && <div className="empty-state">No private mailbox connected. Mail execution remains unavailable to the CRM and every agent.</div>}
            </div>
            <form className="mailbox-connect" onSubmit={connectMailbox}>
              <p className="eyebrow">ADD YOUR INBOX</p>
              <label htmlFor="mailbox-provider">EMAIL PROVIDER</label>
              <select id="mailbox-provider" value={mailboxProvider} onChange={(event) => setMailboxProvider(event.target.value as "gmail" | "outlook")}>
                <option value="gmail">Gmail / Google Workspace</option><option value="outlook">Microsoft 365 / Outlook</option>
              </select>
              <label htmlFor="mailbox-alias">CONNECTION LABEL</label>
              <input id="mailbox-alias" value={mailboxAlias} onChange={(event) => setMailboxAlias(event.target.value)} required maxLength={80} placeholder="Primary inbox" />
              <button type="submit" disabled={Boolean(mutating) || !mailboxes?.readiness[mailboxProvider]}>
                {mutating === "mailbox-connect" ? "OPENING SECURE LOGIN…" : `CONNECT ${mailboxProvider === "gmail" ? "GMAIL" : "MICROSOFT 365"}`}
              </button>
              <small>{mailboxesError
                ? "Mailbox control data is unavailable. Retry the private control before starting a new connection."
                : mailboxesLoading && !mailboxes
                  ? "Loading private provider readiness…"
                  : mailboxes?.readiness[mailboxProvider]
                ? "You will authenticate on Composio. This CRM never sees your password or OAuth token."
                : "Provider setup is not live yet. An owner must add the private Composio configuration before this control activates."}</small>
            </form>
          </div>
        </section>
        <section className="resend-command" id="resend-command" tabIndex={-1}
          aria-labelledby="resend-title" hidden={visibleIntegrationDomain !== "mailboxes"}>
          <header><div><p className="eyebrow">TRANSACTIONAL EMAIL</p><h2 id="resend-title">Resend delivery control.</h2>
            <small>A workspace-owned sending key is encrypted at rest. Verification sends only to the current administrator. AI agents receive no email authority.</small></div>
            <mark className={`resend-status-${resendData?.connection?.status || "offline"}`}>
              {resendLoading && !resendData ? "LOADING" : resendData?.connection?.status.toUpperCase() || "NOT CONNECTED"}
            </mark></header>
          {resendError && <div className="mailbox-local-state error" role="alert"><span><b>RESEND CONTROL UNAVAILABLE</b><small>{resendError}</small></span>
            <button type="button" disabled={resendLoading} onClick={() => void loadResend()}>RETRY</button></div>}
          <div className="resend-grid">
            <div className="resend-connection-zone">
              {resendData?.connection ? <article className="resend-connection-card">
                <div><strong>{resendData.connection.label}</strong><mark>{resendData.connection.status.toUpperCase()}</mark></div>
                <dl><div><dt>SENDER</dt><dd>{resendData.connection.from_name ? `${resendData.connection.from_name} <${resendData.connection.from_email}>` : resendData.connection.from_email}</dd></div>
                  <div><dt>KEY</dt><dd><code>{resendData.connection.api_key_prefix}••••••</code></dd></div>
                  <div><dt>REPLY TO</dt><dd>{resendData.connection.reply_to || "Not set"}</dd></div>
                  <div><dt>VERIFIED</dt><dd>{resendData.connection.last_verified_at ? new Date(resendData.connection.last_verified_at).toLocaleString() : "Not yet"}</dd></div></dl>
                {resendData.connection.last_error && <p className="resend-provider-error">{resendData.connection.last_error}</p>}
                {canAdmin && <div className="resend-actions">
                  {resendData.connection.status !== "active" && <button type="button" disabled={Boolean(mutating)}
                    onClick={() => void verifyResend()}>{mutating === "resend-verify" ? "VERIFYING…" : "SEND VERIFICATION TO ME"}</button>}
                  <button type="button" className={resendDisconnectArmed ? "danger-action" : "secondary"} disabled={Boolean(mutating)}
                    onClick={() => void disconnectResend()}>{mutating === "resend-disconnect" ? "DISCONNECTING…"
                      : resendDisconnectArmed ? "CONFIRM LOCAL DISCONNECT" : "DISCONNECT LOCAL AUTHORITY"}</button>
                  {resendDisconnectArmed && <button type="button" className="secondary" disabled={Boolean(mutating)}
                    onClick={() => setResendDisconnectArmed(false)}>KEEP CONNECTION</button>}
                </div>}
                <small>Local disconnect cryptographically erases the stored credential. Revoke the key in Resend to invalidate it at the provider.</small>
              </article> : canAdmin ? <form className="resend-setup-form" onSubmit={connectResend}>
                <p className="eyebrow">CONNECT RESEND</p>
                <label htmlFor="resend-label">CONNECTION LABEL</label><input id="resend-label" maxLength={80} required
                  value={resendDraft.label} onChange={(event) => setResendDraft({ ...resendDraft, label: event.target.value })} />
                <label htmlFor="resend-key">SENDING-ONLY API KEY</label><input id="resend-key" type="password" autoComplete="off" maxLength={200} required
                  placeholder="re_…" value={resendDraft.api_key} onChange={(event) => setResendDraft({ ...resendDraft, api_key: event.target.value })} />
                <label htmlFor="resend-from-email">VERIFIED SENDER EMAIL</label><input id="resend-from-email" type="email" maxLength={254} required
                  placeholder="hello@openoperator.ai" value={resendDraft.from_email} onChange={(event) => setResendDraft({ ...resendDraft, from_email: event.target.value })} />
                <label htmlFor="resend-from-name">SENDER NAME</label><input id="resend-from-name" maxLength={100}
                  value={resendDraft.from_name} onChange={(event) => setResendDraft({ ...resendDraft, from_name: event.target.value })} />
                <label htmlFor="resend-reply-to">REPLY TO (OPTIONAL)</label><input id="resend-reply-to" type="email" maxLength={254}
                  value={resendDraft.reply_to} onChange={(event) => setResendDraft({ ...resendDraft, reply_to: event.target.value })} />
                <button type="submit" disabled={Boolean(mutating) || !resendData?.runtime.encryption_configured}>
                  {mutating === "resend-connect" ? "ENCRYPTING…" : "ENCRYPT + CONNECT"}</button>
                <small>Use a domain-restricted sending key. It is encrypted before storage and never returned after setup.</small>
              </form> : <div className="empty-state">An administrator must connect transactional email.</div>}
              {canAdmin && resendData?.connection?.status === "active" && <section className="resend-compose">
                <p className="eyebrow">OPERATOR SEND</p><h3>Send one bounded transactional email.</h3>
                <label htmlFor="resend-recipient">RECIPIENT</label><input id="resend-recipient" type="email" maxLength={254}
                  value={resendMessage.recipient} onChange={(event) => { setResendMessage({ ...resendMessage, recipient: event.target.value }); setResendSendArmed(false); }} />
                <label htmlFor="resend-subject">SUBJECT</label><input id="resend-subject" maxLength={200}
                  value={resendMessage.subject} onChange={(event) => { setResendMessage({ ...resendMessage, subject: event.target.value }); setResendSendArmed(false); }} />
                <label htmlFor="resend-text">PLAIN-TEXT BODY</label><textarea id="resend-text" maxLength={10_000}
                  value={resendMessage.text} onChange={(event) => { setResendMessage({ ...resendMessage, text: event.target.value }); setResendSendArmed(false); }} />
                <button type="button" className={resendSendArmed ? "danger-action" : ""} disabled={Boolean(mutating) ||
                  !resendMessage.recipient.trim() || !resendMessage.subject.trim() || !resendMessage.text.trim()}
                  onClick={() => void sendResendMessage()}>{mutating === "resend-send" ? "SENDING…"
                    : resendSendArmed ? "CONFIRM SEND TRANSACTIONAL EMAIL" : "REVIEW SEND"}</button>
                {resendSendArmed && <button type="button" className="secondary" onClick={() => setResendSendArmed(false)}>CANCEL</button>}
              </section>}
            </div>
            <section className="resend-history" aria-label="Resend delivery history"><div><p className="eyebrow">DELIVERY HISTORY</p>
              <strong>{resendData?.deliveries.length || 0} RECENT</strong></div>
              {(resendData?.deliveries ?? []).map((delivery) => <article key={delivery.id} className={`resend-delivery-${delivery.status}`}>
                <div><strong>{delivery.subject}</strong><mark>{delivery.status.toUpperCase()}</mark></div>
                <small>To {delivery.recipient} · {new Date(delivery.created_at).toLocaleString()}</small>
                <p>{delivery.body_excerpt}</p>
                {delivery.error && <small className="resend-provider-error">{delivery.error}</small>}
                {delivery.provider_email_id && <code>{delivery.provider_email_id}</code>}
              </article>)}
              {resendData && !resendData.history_visible && <div className="empty-state">Delivery recipients, subjects, and message excerpts are administrator-only.</div>}
              {resendData?.history_visible && !resendData.deliveries.length && <div className="empty-state">No transactional deliveries yet.</div>}
            </section>
          </div>
        </section>
        {(control?.role === "owner" || control?.role === "admin") && <section className="agent-access-zone integration-domain" id="integration-agents" role="tabpanel" aria-labelledby="integration-tab-agents" hidden={visibleIntegrationDomain !== "agents"}>
          <div className="section-head"><div><p>OPENCLAW + HERMES</p><h2>Scoped agent access.</h2></div><span>{activeAgentCredentials.length} ACTIVE ACCESS</span></div>
          <div className="agent-traversal-contract"><div><p className="eyebrow">BOUNDED AGENT DISCOVERY</p><h3>Agents can continue safely beyond the first page.</h3><small>Contacts, companies, opportunities, workflows, and workflow runs return at most 50 records per call with opaque continuation cursors. Cursors are signed, workspace- and credential-bound, and rejected when filters change.</small></div>
            <dl><div><dt>ORDER</dt><dd>Recent → oldest</dd></div><div><dt>CONSISTENCY</dt><dd>Best-effort keyset</dd></div><div><dt>TRUST</dt><dd>Record text is data only</dd></div><div><dt>WRITES</dt><dd>Human-gated only</dd></div></dl></div>
          <div className="agent-operating-loop" aria-label="Agent workflow operating loop">
            <div><p className="eyebrow">AGENTIC CONTROL LOOP</p><h3>Observe broadly. Execute through a human gate.</h3>
              <small>The Executive assistant preset can inspect workflow identities and run history, then request one manual launch. Approval rechecks the exact workflow version, record, kill switch, run budget, and signed authority before anything executes.</small></div>
            <ol><li><b>01</b><span>OBSERVE<small>Bounded CRM + workflow state</small></span></li>
              <li><b>02</b><span>PROPOSE<small>Idempotent launch request</small></span></li>
              <li><b>03</b><span>REVIEW<small>Owner/admin approval</small></span></li>
              <li><b>04</b><span>TRACE<small>Principal + outcome evidence</small></span></li></ol>
          </div>
          <div className="agent-access-grid"><div className="source-list">
            {activeAgentCredentials.map(renderAgentCredentialCard)}
            {!activeAgentCredentials.length && <div className="empty-state">No AI agent currently has usable CRM access.</div>}
          </div>
          <form className="source-form" onSubmit={createAgentCredential}><p className="eyebrow">CONNECT AN AGENT</p>
            <label htmlFor="agent-name">CONNECTION NAME</label><input id="agent-name" value={agentCredentialName} onChange={(event) => setAgentCredentialName(event.target.value)} required maxLength={120} placeholder="Executive CRM Agent" />
            <label htmlFor="agent-provider">AGENT RUNTIME</label><select id="agent-provider" value={agentProvider} onChange={(event) => setAgentProvider(event.target.value)}>
              <option value="openclaw">OpenClaw</option><option value="hermes">Hermes</option><option value="custom">Custom MCP client</option>
            </select>
            <label htmlFor="agent-access">ACCESS PRESET</label><select id="agent-access" value={agentAccessPreset} onChange={(event) => setAgentAccessPreset(event.target.value as AgentAccessPreset)}>
              {Object.entries(agentAccessPresets).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
            </select>
            <small>{agentAccessPresets[agentAccessPreset].description}</small>
            <button type="submit" disabled={Boolean(mutating)}>{mutating === "agent-credential" ? "CREATING…" : "CREATE SCOPED KEY"} <span>＋</span></button>
            <small>MCP endpoint: https://ingest.example.com/mcp. Tool discovery follows this key&apos;s exact grants. Every proposed action requires approval.</small>
          </form></div>
          <section className="agent-credential-history">
            <button type="button" aria-expanded={showAgentCredentialHistory} aria-controls="agent-credential-history-list"
              onClick={() => { setShowAgentCredentialHistory((current) => !current); setAgentCredentialArmed(""); }}>
              <span><b>REVOKED + EXPIRED HISTORY</b><small>Retained for lifecycle evidence. Historical keys cannot authenticate.</small></span>
              <mark>{historicalAgentCredentials.length} {showAgentCredentialHistory ? "HIDE" : "SHOW"}</mark>
            </button>
            <div id="agent-credential-history-list" hidden={!showAgentCredentialHistory} className="agent-credential-history-grid">
              {historicalAgentCredentials.map(renderAgentCredentialCard)}
              {!historicalAgentCredentials.length && <div className="empty-state">No revoked or expired credentials.</div>}
            </div>
          </section>
        </section>}
        <section className="integration-domain integration-sources" id="integration-sources" role="tabpanel" aria-labelledby="integration-tab-sources" hidden={visibleIntegrationDomain !== "sources"}>
          <header className="integration-domain-head"><div><p className="eyebrow">INBOUND IDENTITY + LEAD FLOW</p><h2>Funnels and communities.</h2></div><span>{sources.filter((source) => source.active).length} ACTIVE</span></header>
        <div className="skool-connector" id="skool-connector" tabIndex={-1}><div><i className={sources.some((source) => source.slug === "skool-community" && source.active) ? "on" : ""}>S</i><span><strong>SKOOL COMMUNITY</strong><small>Paid members, join events, cancellations and membership-question answers</small></span></div>
          <code>POST https://ingest.example.com/v1/integrations/skool/events</code>
          {sources.some((source) => source.slug === "skool-community" && source.active)
            ? <mark>CONNECTED</mark>
            : canAdmin ? <button disabled={Boolean(mutating)} onClick={() => void createSkoolSource()}>{mutating === "skool" ? "CREATING…" : "CREATE SKOOL KEY"}</button> : <mark>ADMIN SETUP REQUIRED</mark>}
          <p>Use the key in Webhooks by Zapier with an Authorization: Bearer header. Map Skool’s member email, name, unique transaction ID, event type and membership answers. Browser automation can audit Skool settings, but event sync stays on this stable server endpoint.</p>
        </div>
        <div className="sources-layout"><div className="source-list">
          {sources.map((source) => <article className="source-card" key={source.id}>
            <div><i className={source.active ? "on" : ""}></i><span>{source.active ? "ACTIVE" : "REVOKED"}</span></div>
            <h3>{source.name}</h3><code>{source.slug} · {source.key_prefix}••••</code>
            <small>{source.last_used_at ? `Last used ${new Date(source.last_used_at).toLocaleString()}` : "Never used"}</small>
            {Boolean(source.active) && canAdmin && <button disabled={Boolean(mutating)} onClick={() => void revokeSource(source.id)}>{mutating === `source-revoke:${source.id}` ? "REVOKING…" : sourceActionArmed?.id === source.id && sourceActionArmed.action === "revoke" ? "CONFIRM REVOKE + STOP INGESTION" : "REVOKE KEY"}</button>}
            {!source.active && canAdmin && <button disabled={Boolean(mutating)} onClick={() => void purgeSource(source.id)}>{mutating === `source-purge:${source.id}` ? "PURGING…" : sourceActionArmed?.id === source.id && sourceActionArmed.action === "purge" ? "CONFIRM PURGE UNUSED CONFIG" : "PURGE CONFIG"}</button>}
            {sourceActionArmed?.id === source.id && <button className="secondary" disabled={Boolean(mutating)} onClick={() => setSourceActionArmed(null)}>KEEP</button>}
          </article>)}
          {!sources.length && <div className="empty-state">No funnel sources connected yet.</div>}
        </div>
        {canAdmin && <form className="source-form" onSubmit={createSource}><p className="eyebrow">CONNECT A NEW FUNNEL</p>
          <label htmlFor="source-name">SOURCE NAME</label><input id="source-name" value={sourceName} onChange={(event) => { setSourceName(event.target.value); if (!sourceSlug) setSourceSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} required maxLength={120} placeholder="AI Workshop Funnel" />
          <label htmlFor="source-slug">SOURCE ID</label><input id="source-slug" value={sourceSlug} onChange={(event) => setSourceSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} required maxLength={80} placeholder="ai-workshop" />
          <button type="submit" disabled={Boolean(mutating)}>{mutating === "source" ? "CREATING…" : "CREATE SOURCE KEY"} <span>＋</span></button>
          <small>Keys are shown once. Store them as a secret in the connected app.</small>
        </form>}</div>
        </section>
        <section className="integration-domain integration-webhooks" id="integration-webhooks" role="tabpanel" aria-labelledby="integration-tab-webhooks" hidden={visibleIntegrationDomain !== "webhooks"}>
          <header className="integration-domain-head"><div><p className="eyebrow">SIGNED EVENT TRANSPORT</p><h2>Webhooks and delivery health.</h2></div><span>{control?.webhooks.filter((hook) => hook.active).length ?? 0} ACTIVE</span></header>
        <div className="webhook-zone"><div className="source-list">{(control?.webhooks ?? []).map((hook) => <article className="source-card" key={hook.id}
          data-webhook-direction={hook.direction} tabIndex={-1}>
          <div><i className={hook.active ? "on" : ""}></i><span>{hook.direction.toUpperCase()}</span></div><h3>{hook.name}</h3>
          <code>{hook.payload_preset === "pagerduty"
            ? `PagerDuty routing key ${hook.provider_credential_prefix || "encrypted"}••••`
            : `${hook.url || `/v1/hooks/${hook.id}`} · ${hook.secret_prefix}••••`}</code>
          {hook.direction === "outbound" && (hook.payload_preset || "generic") !== "generic" && <mark>{hook.payload_preset.toUpperCase()} PAYLOAD</mark>}
          <small>{hook.active ? `Events: ${(() => { try { return (JSON.parse(hook.event_types) as string[]).join(" · ") || "all"; } catch { return "invalid subscription"; } })()}` : "Disabled"}</small>
          {canAdmin && hook.direction === "outbound" && hook.payload_preset !== "pagerduty" && webhookEdit?.id !== hook.id && <button disabled={Boolean(mutating)} onClick={() => setWebhookEdit({ id: hook.id, url: hook.url || "" })}>CHANGE DESTINATION</button>}
          {canAdmin && hook.direction === "outbound" && webhookEdit?.id === hook.id && <div className="webhook-edit">
            <label htmlFor={`webhook-url-${hook.id}`}>PUBLIC HTTPS DESTINATION</label>
            <input id={`webhook-url-${hook.id}`} type="url" value={webhookEdit.url} onChange={(event) => setWebhookEdit({ id: hook.id, url: event.target.value })} />
            <button disabled={Boolean(mutating) || !webhookEdit.url} onClick={() => void updateWebhookDestination(hook)}>{mutating === `webhook-edit:${hook.id}` ? "SAVING…" : "SAVE DESTINATION"}</button>
            <button disabled={Boolean(mutating)} onClick={() => setWebhookEdit(null)}>CANCEL</button>
          </div>}
          {canAdmin && hook.payload_preset === "pagerduty" && pagerDutyEdit?.id !== hook.id &&
            <button disabled={Boolean(mutating)} onClick={() => setPagerDutyEdit({ id: hook.id, key: "" })}>ROTATE ROUTING KEY</button>}
          {canAdmin && hook.payload_preset === "pagerduty" && pagerDutyEdit?.id === hook.id && <div className="webhook-edit">
            <label htmlFor={`pagerduty-key-${hook.id}`}>NEW 32-CHARACTER ROUTING KEY</label>
            <input id={`pagerduty-key-${hook.id}`} type="password" minLength={32} maxLength={32}
              pattern="[A-Za-z0-9]{32}" autoComplete="new-password" value={pagerDutyEdit.key}
              onChange={(event) => setPagerDutyEdit({ id: hook.id, key: event.target.value.trim() })} />
            <button disabled={Boolean(mutating) || pagerDutyEdit.key.length !== 32}
              onClick={() => void rotatePagerDutyKey(hook)}>
              {mutating === `pagerduty-rotate:${hook.id}` ? "ROTATING…" : "CONFIRM ROTATE KEY"}
            </button>
            <button disabled={Boolean(mutating)} onClick={() => setPagerDutyEdit(null)}>CANCEL</button>
          </div>}
          {canAdmin && hook.direction === "outbound" && <button disabled={Boolean(mutating)} onClick={() => void testWebhook(hook.id)}>{mutating === `webhook-test:${hook.id}` ? "SENDING TEST…" : hook.payload_preset === "pagerduty" ? "TEST ALERT + RESOLVE" : "SEND TEST"}</button>}
          {canAdmin && <button className={webhookDeleteArmed === hook.id ? "danger-action" : ""} disabled={Boolean(mutating)} onClick={() => webhookDeleteArmed === hook.id ? void deleteWebhook(hook.id) : setWebhookDeleteArmed(hook.id)}>
            {mutating === `webhook-delete:${hook.id}` ? "DELETING…" : webhookDeleteArmed === hook.id ? "CONFIRM DELETE + HISTORY" : "DELETE WEBHOOK"}
          </button>}
          {canAdmin && webhookDeleteArmed === hook.id && <button disabled={Boolean(mutating)} onClick={() => setWebhookDeleteArmed("")}>CANCEL DELETE</button>}
        </article>)}{!control?.webhooks.length && <div className="empty-state">No webhook endpoints configured.</div>}</div>
          {canAdmin && <form className="source-form" onSubmit={createWebhook}><p className="eyebrow">CREATE WEBHOOK</p>
            <label htmlFor="webhook-name">NAME</label><input id="webhook-name" value={webhookName} onChange={(event) => setWebhookName(event.target.value)} required maxLength={120} placeholder="Stripe events" />
            <label htmlFor="webhook-direction">DIRECTION</label><select id="webhook-direction" value={webhookDirection}
              onChange={(event) => {
                const direction = event.target.value as "inbound" | "outbound";
                setWebhookDirection(direction);
                if (direction === "inbound") {
                  setWebhookPayloadPreset("generic"); setWebhookOperationsAlerts(false); setWebhookVisitorIntentAlerts(false); setWebhookProviderCredential("");
                }
              }}>
              <option value="inbound">Inbound credential</option><option value="outbound">Outbound delivery</option>
            </select>
            {webhookDirection === "outbound" && <><label htmlFor="webhook-preset">PAYLOAD FORMAT</label>
              <select id="webhook-preset" value={webhookPayloadPreset}
                onChange={(event) => {
                  const preset = event.target.value as typeof webhookPayloadPreset;
                  setWebhookPayloadPreset(preset);
                  if (preset !== "pagerduty") setWebhookProviderCredential("");
                  if (preset !== "slack") setWebhookVisitorIntentAlerts(false);
                }}>
                <option value="generic">Generic signed JSON</option>
                <option value="slack">Slack incoming webhook</option>
                <option value="teams">Microsoft Teams workflow</option>
                <option value="discord">Discord webhook</option>
                <option value="pagerduty">PagerDuty Events API v2</option>
              </select>
              <small>{webhookPayloadPreset === "generic"
                ? "Canonical CRM event JSON with an HMAC signature."
                : webhookPayloadPreset === "pagerduty"
                  ? "Creates, deduplicates, escalates, and resolves one PagerDuty alert per CRM incident."
                : webhookPayloadPreset === "slack" && webhookVisitorIntentAlerts
                  ? "Slack receives company-level visitor research cards when an operator opens an intent case. No person-level data or outreach authorization is included."
                  : `${webhookPayloadPreset === "teams" ? "Teams" : webhookPayloadPreset[0].toUpperCase() + webhookPayloadPreset.slice(1)} receives operations incident, escalation, and recovery alerts.`}</small>
              {webhookPayloadPreset === "pagerduty" ? <>
                <label htmlFor="webhook-provider-credential">EVENTS API V2 ROUTING KEY</label>
                <input id="webhook-provider-credential" type="password" required minLength={32} maxLength={32}
                  pattern="[A-Za-z0-9]{32}" autoComplete="new-password" value={webhookProviderCredential}
                  onChange={(event) => setWebhookProviderCredential(event.target.value.trim())}
                  placeholder="32-character integration key" />
                <small>Encrypted at rest. Test Alert briefly triggers and then resolves a PagerDuty incident.</small>
              </> : <>
                <label htmlFor="webhook-url">PUBLIC HTTPS DESTINATION</label>
                <input id="webhook-url" type="url" required value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)}
                  placeholder="https://example.com/hooks/crm" />
              </>}
              {webhookPayloadPreset === "generic" && <label className="webhook-alert-option"><input type="checkbox" checked={webhookOperationsAlerts}
                onChange={(event) => setWebhookOperationsAlerts(event.target.checked)} />
                <span><b>OPERATIONS ALERTS</b><small>Send incident-opened, escalation, and recovery events through this signed, retryable destination.</small></span>
              </label>}
              {webhookPayloadPreset === "slack" && <label className="webhook-alert-option"><input type="checkbox" checked={webhookVisitorIntentAlerts}
                onChange={(event) => setWebhookVisitorIntentAlerts(event.target.checked)} />
                <span><b>VISITOR RESEARCH CARDS</b><small>Send one deduplicated, company-level Slack card after an intent case is opened. This never authorizes outreach.</small></span>
              </label>}</>}
            <button type="submit" disabled={Boolean(mutating)}>{mutating === "webhook" ? "CREATING…" : "CREATE CREDENTIAL"} <span>＋</span></button><small>Outbound destinations reject local, private, credentialed, and non-HTTPS URLs. New outbound hooks subscribe to CRM changes and workflow events.</small>
          </form>}
          <div className="webhook-health" aria-label="Outbound webhook health">
            <span><strong>{outboundDeliveries.filter((delivery) => delivery.status === "succeeded").length}</strong> DELIVERED</span>
            <span><strong>{webhookRetryingCount}</strong> SCHEDULED</span>
            <span className={webhookFailedCount ? "has-failures" : ""}><strong>{webhookFailedCount}</strong> TERMINAL</span>
          </div>
          {canAdmin && webhookDueCount > 0 &&
            <button className="retry-webhooks" disabled={Boolean(mutating)} onClick={() => void retryWebhookDeliveries()}>{mutating === "webhook-retry" ? "PROCESSING…" : `PROCESS ${webhookDueCount} DUE NOW`}</button>}
          {webhookRetryingCount > 0 && webhookDueCount === 0 && <small className="retry-schedule">Automatic retry is scheduled. No delivery is due right now.</small>}
          <div className="run-list webhook-history" aria-label="Webhook delivery history">{(control?.deliveries ?? []).slice(0, 10).map((delivery) => <article className={`delivery-${delivery.status}`} key={delivery.id}>
            <strong>{delivery.endpoint_name || "Deleted endpoint"} · {delivery.direction.toUpperCase()} · {delivery.status.toUpperCase()}</strong>
            <span>{delivery.event_id} · attempt {delivery.attempts} · {delivery.response_status ? `HTTP ${delivery.response_status}` : "no HTTP response"} · updated {new Date(delivery.updated_at).toLocaleString()}</span>
            {delivery.next_attempt_at && <small>Next attempt {new Date(delivery.next_attempt_at).toLocaleString()}</small>}
            {delivery.response_excerpt && delivery.status !== "succeeded" && <small className="delivery-error">{delivery.response_excerpt.slice(0, 180)}</small>}
          </article>)}
            {!control?.deliveries.length && <div className="empty-state">No webhook deliveries yet.</div>}</div></div>
        </section>
        {newSourceKey && <div className="key-reveal" role="status"><div><strong>NEW SOURCE KEY — COPY IT NOW</strong><code>{newSourceKey}</code></div>
          <button onClick={() => void navigator.clipboard.writeText(newSourceKey)}>COPY KEY</button><button className="dismiss-key" onClick={() => setNewSourceKey("")}>I SAVED IT</button></div>}
        {newWebhookSecret && <div className="key-reveal" role="status"><div><strong>NEW WEBHOOK SECRET — COPY IT NOW</strong><code>{newWebhookSecret}</code></div>
          <button onClick={() => void navigator.clipboard.writeText(newWebhookSecret)}>COPY SECRET</button><button className="dismiss-key" onClick={() => setNewWebhookSecret("")}>I SAVED IT</button></div>}
        {newAgentKey && <div className="key-reveal" role="status"><div><strong>NEW AGENT KEY — COPY IT NOW</strong><code>{newAgentKey}</code></div>
          <button onClick={() => void navigator.clipboard.writeText(newAgentKey)}>COPY KEY</button><button className="dismiss-key" onClick={() => setNewAgentKey("")}>I SAVED IT</button></div>}
      </section>
    </section>
    {commandOpen && <div className="command-backdrop" onClick={() => closeCommandCenter()}>
      <section ref={commandCenterRef} className="command-center" role="dialog" aria-modal="true" aria-labelledby="command-title" onClick={(event) => event.stopPropagation()} onKeyDown={trapCommandFocus}>
        <header><div><p>UNIVERSAL COMMAND</p><h2 id="command-title">Go anywhere. Find anything.</h2></div><button type="button" aria-label="Close command center" onClick={() => closeCommandCenter()}>ESC</button></header>
        <div className="command-input-shell">
          <span aria-hidden="true">⌕</span>
          <input ref={commandInputRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results"
            aria-activedescendant={commandEntries[safeCommandActiveIndex] ? `command-${commandEntries[safeCommandActiveIndex].id.replaceAll(":", "-")}` : undefined}
            value={commandQuery} onChange={(event) => {
              setCommandQuery(event.target.value); setCommandActiveIndex(0);
              if (event.target.value.trim().length < 2) { setCommandSearch(null); setCommandLoading(false); }
            }}
            onKeyDown={handleCommandKeys} placeholder="Search people, companies, deals, or workspaces…" maxLength={100} />
          {commandLoading && <i aria-label="Searching"></i>}
        </div>
        <div className="command-safety"><span>READ ONLY</span><span>WORKSPACE SCOPED</span><span>{commandQuery.trim().length < 2 ? "TYPE 2+ FOR RECORDS" : "MAX 18 RECORDS"}</span></div>
        <div className="command-results" id="command-results" role="listbox" aria-label="Command results">
          {commandEntries.map((entry, index) => <button type="button" role="option" aria-selected={index === safeCommandActiveIndex}
            id={`command-${entry.id.replaceAll(":", "-")}`} key={entry.id} className={index === safeCommandActiveIndex ? "active" : ""}
            onMouseEnter={() => setCommandActiveIndex(index)} onClick={() => runCommand(entry)}>
            <i aria-hidden="true">{entry.kind === "navigation" ? "↗" : entry.kind === "contact" ? "P" : entry.kind === "company" ? "C" : "$"}</i>
            <span><strong>{entry.label}</strong><small>{entry.description}</small></span>
            <mark>{entry.kind === "navigation" ? "GO" : entry.kind.toUpperCase()}</mark>
          </button>)}
          {!commandEntries.length && !commandLoading && <div className="command-empty"><b>No workspace records matched.</b><span>Try a name, email, company, or opportunity.</span></div>}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> MOVE</span><span><kbd>ENTER</kbd> OPEN</span><span><kbd>ESC</kbd> CLOSE</span></footer>
      </section>
    </div>}
    {selectedIntegration && <div className="drawer-backdrop integration-setup-backdrop"
      onClick={() => { setSelectedIntegrationId(""); window.requestAnimationFrame(() => integrationReturnFocusRef.current?.focus()); }}>
      <aside ref={integrationDrawerRef} className="contact-drawer integration-setup-drawer" role="dialog" aria-modal="true"
        aria-labelledby="integration-setup-title" onClick={(event) => event.stopPropagation()}>
        <button ref={integrationDrawerCloseRef} className="drawer-close" aria-label="Close integration details"
          onClick={() => { setSelectedIntegrationId(""); window.requestAnimationFrame(() => integrationReturnFocusRef.current?.focus()); }}>×</button>
        {(() => {
          const installed = installedIntegrationIds.has(selectedIntegration.id);
          const needsAttention = attentionIntegrationIds.has(selectedIntegration.id);
          const connectable = selectedIntegration.availability === "implemented" && selectedIntegration.runtime.configured;
          const destination = integrationDestinationFor(selectedIntegration.id);
          const status = installed ? "INSTALLED" : needsAttention ? "ATTENTION REQUIRED"
            : selectedIntegration.availability === "planned" ? "PLANNED"
            : connectable ? "READY TO CONFIGURE" : "RUNTIME SETUP REQUIRED";
          return <>
            <header className="integration-setup-identity">
              <span aria-hidden="true">{selectedIntegration.label.slice(0, 1)}</span>
              <div><p className="eyebrow">{selectedIntegration.category.replaceAll("_", " ")}</p>
                <h2 id="integration-setup-title">{selectedIntegration.label}</h2><mark>{status}</mark></div>
            </header>
            <section className="integration-setup-section">
              <p className="eyebrow">GOVERNED AUTHORITY</p>
              <h3>What this connection can do</h3>
              <ul>{selectedIntegration.capabilities.map((capability) =>
                <li key={capability}><code>{capability}</code></li>)}</ul>
              <small>Only these cataloged capabilities are advertised. Installing a connection does not grant an AI agent access.</small>
            </section>
            <section className="integration-setup-section">
              <p className="eyebrow">SETUP CONTRACT</p>
              <dl>
                <div><dt>AUTHENTICATION</dt><dd>{selectedIntegration.authStrategy.replaceAll("_", " ")}</dd></div>
                <div><dt>WORKSPACE STATE</dt><dd>{installed ? "Active connection found"
                  : needsAttention ? "Existing connection requires attention" : "Not installed"}</dd></div>
                <div><dt>SERVER LIFECYCLE</dt><dd>{selectedIntegration.availability === "implemented" ? "Implemented" : "Not implemented"}</dd></div>
              </dl>
              {selectedIntegration.runtime.missingBindings.length > 0 &&
                <div className="integration-requirements" role="note"><strong>OWNER ACTION OUTSIDE THE CRM</strong>
                  <p>Add the private runtime configuration, then reload this page.</p>
                  {selectedIntegration.runtime.missingBindings.map((binding) => <code key={binding}>{binding}</code>)}
                </div>}
              {selectedIntegration.availability === "planned" &&
                <div className="integration-requirements planned" role="note"><strong>ROADMAP ONLY</strong>
                  <p>This connector has no setup, health-check, execution, or revoke handler yet. The CRM will not pretend it can connect.</p></div>}
              {!canAdmin && !installed && selectedIntegration.availability === "implemented" &&
                <div className="integration-requirements" role="note"><strong>ADMINISTRATOR REQUIRED</strong>
                  <p>You can inspect this boundary, but only an owner or administrator can start setup.</p></div>}
            </section>
            <div className="integration-setup-actions">
              {(installed || needsAttention || (connectable && canAdmin)) &&
                <button type="button" onClick={() => continueIntegrationSetup(selectedIntegration.id)}>
                  {installed || needsAttention ? `MANAGE IN ${destination}` : `CONTINUE TO ${destination}`}
                </button>}
              <button type="button" className="secondary"
                onClick={() => { setSelectedIntegrationId(""); window.requestAnimationFrame(() => integrationReturnFocusRef.current?.focus()); }}>CLOSE</button>
            </div>
          </>;
        })()}
      </aside>
    </div>}
    {selectedVisitorCase && <div className="drawer-backdrop intent-case-backdrop" onClick={closeVisitorIntentCaseDetail}>
      <aside ref={visitorCaseDrawerRef} className="contact-drawer intent-case-workspace" role="dialog" aria-modal="true"
        aria-labelledby="intent-case-title" onClick={(event) => event.stopPropagation()}>
        <button ref={visitorCaseCloseButtonRef} className="drawer-close" aria-label="Close intent case workspace"
          onClick={closeVisitorIntentCaseDetail}>×</button>
        <header className="record-identity intent-case-identity">
          <span aria-hidden="true">{selectedVisitorCase.case.intent_score}</span>
          <div><p className="eyebrow">VISITOR INTENT CASE</p><h2 id="intent-case-title">{selectedVisitorCase.case.company_name}</h2>
            <small>{selectedVisitorCase.case.company_domain} · evidence frozen {new Date(selectedVisitorCase.case.evidence_updated_at).toLocaleString()}</small></div>
          <mark>{selectedVisitorCase.case.status.replace("_", " ")}</mark>
        </header>
        {error && <div className="record-feedback error" role="alert">{error}</div>}
        {!error && notice && <div className="record-feedback notice" role="status">{notice}</div>}
        <section className="intent-case-safety">
          <b>QUARANTINED OPERATING RECORD</b>
          <span>No Contact, Company, Opportunity, task, or outreach permission is created by this case.</span>
        </section>
        <section className="intent-case-control">
          <div><p className="eyebrow">ACCOUNTABILITY</p><h3>Owner and service level</h3></div>
          <label>OWNER<select aria-label="Intent case owner" value={visitorCaseOwnerDraft}
            onChange={(event) => setVisitorCaseOwnerDraft(event.target.value)}>
            <option value="">Unassigned</option>{(accessPolicy?.members ?? []).filter((member) => member.active).map((member) =>
              <option key={member.email} value={member.email}>{member.email} · {member.role}</option>)}
          </select></label>
          <label>PRIORITY<select aria-label="Intent case priority" value={visitorCasePriorityDraft}
            onChange={(event) => setVisitorCasePriorityDraft(event.target.value as VisitorIntentCase["priority"])}>
            <option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
          </select></label>
          <label>DUE AT<input aria-label="Intent case due at" type="datetime-local" value={visitorCaseDueDraft}
            onChange={(event) => setVisitorCaseDueDraft(event.target.value)} /></label>
          {canAdmin && <button type="button" disabled={Boolean(mutating) ||
            (visitorCaseOwnerDraft === (selectedVisitorCase.case.owner || "") &&
              visitorCasePriorityDraft === selectedVisitorCase.case.priority &&
              visitorCaseDueDraft === (selectedVisitorCase.case.due_at?.slice(0, 16) || ""))}
            onClick={() => void updateVisitorIntentCase(selectedVisitorCase.case, {
              owner: visitorCaseOwnerDraft || null, priority: visitorCasePriorityDraft,
              due_at: visitorCaseDueDraft ? new Date(visitorCaseDueDraft).toISOString() : null,
            })}>SAVE ACCOUNTABILITY</button>}
        </section>
        <section className="intent-case-evidence">
          <div><p className="eyebrow">FROZEN DECISION INPUT</p><h3>Why this case existed</h3></div>
          {[
            ["PROFILES", selectedVisitorCase.case.evidence_snapshot.profile_count ?? 0],
            ["PEOPLE", selectedVisitorCase.case.evidence_snapshot.people_count ?? 0],
            ["VISITS", selectedVisitorCase.case.evidence_snapshot.visit_count ?? 0],
            ["HIGH INTENT", selectedVisitorCase.case.evidence_snapshot.high_intent_count ?? 0],
            ["REPEATS", selectedVisitorCase.case.evidence_snapshot.repeat_visits ?? 0],
            ["OPEN PIPELINE", money(selectedVisitorCase.case.evidence_snapshot.open_pipeline_value ?? 0)],
          ].map(([label, value]) => <article key={label}><small>{label}</small><strong>{value}</strong></article>)}
        </section>
        {canAdmin && <section className="intent-case-decision">
          <div><p className="eyebrow">HUMAN DECISION</p><h3>Move the case deliberately</h3></div>
          {["new", "in_review"].includes(selectedVisitorCase.case.status) ? <>
            <textarea aria-label="Intent case resolution note" maxLength={1000} placeholder="Required before resolving or dismissing…"
              value={visitorCaseResolution[selectedVisitorCase.case.id] || ""}
              onChange={(event) => setVisitorCaseResolution((current) =>
                ({ ...current, [selectedVisitorCase.case.id]: event.target.value }))} />
            <div>{selectedVisitorCase.case.status === "new" && <button type="button" disabled={Boolean(mutating)}
              onClick={() => void updateVisitorIntentCase(selectedVisitorCase.case, { status: "in_review" })}>CLAIM REVIEW</button>}
              <button type="button" className="secondary" disabled={Boolean(mutating)}
                onClick={() => void updateVisitorIntentCase(selectedVisitorCase.case, { status: "resolved" })}>RESOLVE</button>
              <button type="button" className="danger-action" disabled={Boolean(mutating)}
                onClick={() => void updateVisitorIntentCase(selectedVisitorCase.case, { status: "dismissed" })}>DISMISS</button></div>
          </> : <div className="intent-case-resolution"><b>{selectedVisitorCase.case.status.toUpperCase()}</b>
            <p>{selectedVisitorCase.case.resolution_note}</p><button type="button" disabled={Boolean(mutating)}
              onClick={() => void updateVisitorIntentCase(selectedVisitorCase.case, { status: "new", owner: null })}>REOPEN AS NEW</button></div>}
        </section>}
        <section className="intent-case-timeline" aria-label="Intent case audit timeline">
          <div><p className="eyebrow">IMMUTABLE CASE HISTORY</p><h3>Latest {selectedVisitorCase.timeline.length} audited event{selectedVisitorCase.timeline.length === 1 ? "" : "s"}</h3></div>
          {selectedVisitorCase.timeline.map((entry) => {
            const changed = ["status", "priority", "owner", "due_at", "resolution_note"].filter((field) =>
              entry.before?.[field as keyof VisitorIntentCase] !== entry.after?.[field as keyof VisitorIntentCase]);
            return <article key={entry.id}><i aria-hidden="true"></i><div><strong>{entry.action === "visitor_intent_case.created" ? "Case opened" : "Case updated"}</strong>
              <small>{entry.actor_id} · {new Date(entry.created_at).toLocaleString()}</small>
              <p>{changed.length ? changed.map((field) => field.replace("_", " ")).join(" · ") : "Frozen evidence and initial controls recorded"}</p></div></article>;
          })}
        </section>
      </aside>
    </div>}
    {selectedOpportunity && <div className="drawer-backdrop opportunity-backdrop" onClick={closeOpportunityWorkspace}><aside ref={opportunityDrawerRef} className="contact-drawer opportunity-workspace" role="dialog" aria-modal="true" aria-labelledby="opportunity-title" onClick={(event) => event.stopPropagation()}>
      <button ref={opportunityCloseButtonRef} className="drawer-close" aria-label="Close opportunity workspace" onClick={closeOpportunityWorkspace}>×</button>
      <header className="record-identity opportunity-identity">
        <span aria-hidden="true">$</span>
        <div><p className="eyebrow">OPPORTUNITY RECORD</p><h2 id="opportunity-title">{selectedOpportunity.name}</h2><a href={`mailto:${selectedOpportunity.email}`}>{[selectedOpportunity.first_name, selectedOpportunity.last_name].filter(Boolean).join(" ") || selectedOpportunity.email}{selectedOpportunity.company ? ` · ${selectedOpportunity.company}` : ""}</a></div>
        <mark>{selectedOpportunityStage?.name || selectedOpportunity.status}</mark>
      </header>
      <nav className="record-tabs" role="tablist" aria-label="Opportunity workspace sections">
        {([
          { id: "overview", label: "Overview" },
          { id: "intelligence", label: `Intel ${opportunityIntelligence?.summary.total || 0}` },
          { id: "execution", label: `Execution ${selectedOpportunityTasks.length}` },
          { id: "agent", label: `Agent ${selectedOpportunityProposals.length + selectedOpportunityWork.length}` },
        ] as Array<{ id: OpportunityDrawerTab; label: string }>).map((tab) =>
          <button key={tab.id} id={`opportunity-tab-${tab.id}`} role="tab" aria-selected={opportunityDrawerTab === tab.id} aria-controls={`opportunity-panel-${tab.id}`} tabIndex={opportunityDrawerTab === tab.id ? 0 : -1} onKeyDown={(event) => moveOpportunityDrawerTab(event, tab.id)} onClick={() => setOpportunityDrawerTab(tab.id)}>{tab.label}</button>)}
      </nav>
      {error && <div className="record-feedback error" role="alert">{error}</div>}
      {!error && notice && <div className="record-feedback notice" role="status">{notice}</div>}
      {opportunityDrawerTab === "overview" && <section id="opportunity-panel-overview" className="record-panel opportunity-overview" role="tabpanel" aria-labelledby="opportunity-tab-overview">
        <dl className="record-facts"><div><dt>Value</dt><dd>{money(selectedOpportunity.value)}</dd></div><div><dt>Weighted</dt><dd>{money(selectedOpportunityForecast)}</dd></div>
          <div><dt>Probability</dt><dd>{selectedOpportunity.probability}%</dd></div><div><dt>Expected close</dt><dd>{selectedOpportunity.expected_close_at ? new Date(selectedOpportunity.expected_close_at).toLocaleDateString() : "Not set"}</dd></div></dl>
        <section className="opportunity-stage-control"><div><p className="eyebrow">PIPELINE POSITION</p><strong>{selectedPipeline?.name || "Pipeline"}</strong></div>
          <select aria-label={`Move ${selectedOpportunity.name}`} disabled={Boolean(mutating)} value={selectedOpportunity.stage_id} onChange={(event) => void moveOpportunity(selectedOpportunity, event.target.value)}>
            {selectedPipelineStages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
          </select>
          {pendingTerminalMove?.opportunityId === selectedOpportunity.id && (() => {
            const target = selectedPipelineStages.find((stage) => stage.id === pendingTerminalMove.stageId);
            return target ? <div className="terminal-move-review" role="alert"><b>CONFIRM {target.category.toUpperCase()}</b><small>Move “{selectedOpportunity.name}” to {target.name}? Forecast status and probability change immediately.</small>
              <button disabled={Boolean(mutating)} onClick={() => void moveOpportunity(selectedOpportunity, target.id, true)}>CONFIRM MOVE</button>
              <button className="secondary" disabled={Boolean(mutating)} onClick={() => setPendingTerminalMove(null)}>CANCEL</button>
            </div> : null;
          })()}
        </section>
        {opportunityDraft?.id === selectedOpportunity.id ? <div className="opportunity-editor workspace-editor">
          <label>VALUE<input aria-label={`Value for ${selectedOpportunity.name}`} type="number" min="0" max="100000000" value={opportunityDraft.value} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, value: event.target.value })} /></label>
          <label>NEXT STEP<input aria-label={`Next step for ${selectedOpportunity.name}`} maxLength={500} placeholder="Next step" value={opportunityDraft.nextStep} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, nextStep: event.target.value })} /></label>
          <label>OWNER<input aria-label={`Owner for ${selectedOpportunity.name}`} type="email" maxLength={254} placeholder="owner@company.com" value={opportunityDraft.owner} onChange={(event) => setOpportunityDraft({ ...opportunityDraft, owner: event.target.value })} /></label>
          <label>EXPECTED CLOSE<input aria-label={`Close date for ${selectedOpportunity.name}`} type="date" value={opportunityDraft.expectedClose} onInput={(event) => setOpportunityDraft({ ...opportunityDraft, expectedClose: event.currentTarget.value })} /></label>
          {customFields.some((field) => field.object_type === "opportunity" && field.active) && <section className="record-custom-fields">
            <div><p className="eyebrow">CUSTOM OPPORTUNITY DATA</p></div>
            <LayoutCustomFieldEditor layout={pageLayouts.find((layout) => layout.object_type === "opportunity")}
              fields={customFields.filter((field) => field.object_type === "opportunity" && field.active)}
              draft={opportunityCustomDraft} disabled={Boolean(mutating)} onChange={setOpportunityCustomDraft} />
          </section>}
          <div><button disabled={Boolean(mutating)} onClick={() => void saveOpportunity(selectedOpportunity)}>{mutating === `opportunity-edit:${selectedOpportunity.id}` ? "SAVING…" : "SAVE DETAILS"}</button>
            <button className="secondary" disabled={Boolean(mutating)} onClick={() => setOpportunityDraft(null)}>CANCEL</button></div>
        </div> : <section className="opportunity-summary"><div><p className="eyebrow">NEXT BEST STEP</p><strong>{selectedOpportunity.next_step || "No next step defined"}</strong><small>{selectedOpportunity.owner ? `Owned by ${selectedOpportunity.owner}` : "Unassigned"} · {selectedOpportunity.last_activity_at ? `active ${new Date(selectedOpportunity.last_activity_at).toLocaleDateString()}` : "no activity timestamp"}</small></div><button onClick={() => editOpportunity(selectedOpportunity)}>EDIT FIELDS</button></section>}
        {canAdmin && <div className="delete-confirmation opportunity-delete-zone">
          <button className="danger-action" disabled={Boolean(mutating)} onClick={() => void deleteOpportunity(selectedOpportunity)}>
            {opportunityDeleteArmed === selectedOpportunity.id ? "CONFIRM DELETE + LINKED TASKS" : "DELETE OPPORTUNITY"}
          </button>
          {opportunityDeleteArmed === selectedOpportunity.id && <button className="cancel-delete" onClick={() => setOpportunityDeleteArmed("")}>CANCEL</button>}
        </div>}
      </section>}
      {opportunityDrawerTab === "intelligence" && <section id="opportunity-panel-intelligence" className="record-panel opportunity-intelligence" role="tabpanel" aria-labelledby="opportunity-tab-intelligence">
        {opportunityIntelligenceLoading && <div className="drawer-loading">Building bounded opportunity intelligence…</div>}
        {!opportunityIntelligenceLoading && opportunityIntelligence && <>
          <section className={`deal-health ${opportunityIntelligence.health.status}`}>
            <div className="deal-health-score"><span>{opportunityIntelligence.health.score}</span><small>/ 100</small></div>
            <div><p className="eyebrow">EXPLAINABLE DEAL HEALTH</p><h3>{opportunityIntelligence.health.status === "strong" ? "Strong operating posture" : opportunityIntelligence.health.status === "watch" ? "Needs attention" : "At risk"}</h3>
              <small>{opportunityIntelligence.health.coverage === "connected" ? `Communication coverage connected · ${opportunityIntelligence.summary.total} bounded signals` : "No communication source is connected for this contact yet."}</small></div>
            <mark>{opportunityIntelligence.health.status.replace("_", " ")}</mark>
          </section>
          <dl className="intelligence-metrics">
            <div><dt>Analyzed calls</dt><dd>{opportunityIntelligence.summary.analyzed_calls}</dd></div>
            <div><dt>Email signals</dt><dd>{opportunityIntelligence.summary.emails}</dd></div>
            <div><dt>Meetings</dt><dd>{opportunityIntelligence.summary.meetings}</dd></div>
          </dl>
          <section className="health-reasons"><div className="related-heading"><p className="eyebrow">WHY THIS SCORE</p><b>{opportunityIntelligence.health.reasons.length}</b></div>
            {opportunityIntelligence.health.reasons.map((reason) => <article key={reason.code}><mark>{reason.impact}</mark><div><strong>{reason.label}</strong><p>{reason.evidence}</p></div></article>)}
            {!opportunityIntelligence.health.reasons.length && <div className="drawer-loading">No deterministic risk rule is currently active.</div>}
          </section>
          <section className="signal-timeline"><div className="related-heading"><p className="eyebrow">COMMUNICATION JOURNEY</p><b>LAST {opportunityIntelligence.safety.bounded_to}</b></div>
            {opportunityIntelligence.signals.map((signal) => <article key={signal.id}>
              <span className={`signal-icon ${signal.type.split(".")[0]}`}>{signal.type.startsWith("sales.") ? "CALL" : signal.type.startsWith("email.") ? "MAIL" : "MEET"}</span>
              <div><strong>{signal.title}</strong><small>{signal.type.replaceAll(".", " ")} · {new Date(signal.occurred_at).toLocaleString()}</small>
                {signal.body && <p>{signal.body}</p>}
                {signal.metadata.call_score !== null && <span className="signal-chip">CALL SCORE {signal.metadata.call_score}</span>}
                {signal.metadata.sentiment && <span className={`signal-chip ${signal.metadata.sentiment}`}>{signal.metadata.sentiment}</span>}
                {signal.metadata.objections.map((objection) => <span className="signal-chip objection" key={objection}>OBJECTION · {objection}</span>)}
              </div>
            </article>)}
            {!opportunityIntelligence.signals.length && <div className="signal-empty"><strong>Communication coverage is not connected.</strong><p>Calls, email, and meeting events can already enter through a scoped CRM source. Until they do, health uses CRM fields only and does not pretend it analyzed conversations.</p></div>}
          </section>
          <div className="intelligence-safety"><span>DETERMINISTIC SCORE</span><span>UNTRUSTED SOURCE CONTENT</span><span>HUMAN APPROVAL REQUIRED</span></div>
          {canAdmin
            ? <button className="agent-run intelligence-run" disabled={agentRunning || !Boolean(control?.agent_policy?.agent_access_enabled)} onClick={() => void analyzePipeline()}>{agentRunning ? "ANALYZING…" : "GENERATE HUMAN-GATED NEXT ACTIONS"}</button>
            : <div className="agent-member-boundary"><b>READ-ONLY INTELLIGENCE</b><small>An owner or admin can generate new human-gated actions. You can inspect the deterministic score and bounded communication evidence.</small></div>}
        </>}
      </section>}
      {opportunityDrawerTab === "execution" && <section id="opportunity-panel-execution" className="record-panel opportunity-execution" role="tabpanel" aria-labelledby="opportunity-tab-execution">
        <section className="execution-brief"><p className="eyebrow">CURRENT COMMITMENT</p><h3>{selectedOpportunity.next_step || "Define a next step before this deal stalls."}</h3><small>{selectedOpportunityTasks.filter((task) => task.status === "open").length} open task{selectedOpportunityTasks.filter((task) => task.status === "open").length === 1 ? "" : "s"} linked to this opportunity.</small></section>
        <form className="opportunity-task-form" onSubmit={createTask}><p className="eyebrow">ADD LINKED TASK</p>
          <input aria-label="Opportunity task title" placeholder={`Advance ${selectedOpportunity.name}`} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} required maxLength={200} />
          <div><input aria-label="Opportunity task due date" name="due_at" type="datetime-local" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} />
            <select aria-label="Opportunity task priority" value={taskPriority} onChange={(event) => setTaskPriority(event.target.value)}><option value="low">Low priority</option><option value="normal">Normal priority</option><option value="high">High priority</option><option value="urgent">Urgent priority</option></select></div>
          <input aria-label="Opportunity task assignee" type="email" placeholder={selectedOpportunity.owner || "assignee@company.com"} value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)} />
          <button type="submit" disabled={!taskTitle.trim() || Boolean(mutating)}>{mutating === "task" ? "ADDING…" : "ADD TO EXECUTION QUEUE"}</button>
        </form>
        <div className="opportunity-task-list">{selectedOpportunityTasks.map((task) => <article key={task.id} className={task.status}>
          <div><strong>{task.title}</strong><small>{task.priority} priority{task.assignee ? ` · ${task.assignee}` : ""}{task.due_at ? ` · due ${new Date(task.due_at).toLocaleString()}` : ""}</small></div><mark>{task.status}</mark>
          <TaskLifecycleControls task={task} disabled={Boolean(mutating)} deleteArmed={taskDeleteArmed === task.id}
            onStatus={(status) => void updateTaskStatus(task, status)} onDelete={() => void deleteTask(task)}
            onCancelDelete={() => setTaskDeleteArmed("")} />
        </article>)}{!selectedOpportunityTasks.length && <div className="drawer-loading">No execution tasks linked yet.</div>}</div>
      </section>}
      {opportunityDrawerTab === "agent" && <section id="opportunity-panel-agent" className="record-panel opportunity-agent" role="tabpanel" aria-labelledby="opportunity-tab-agent">
        <section className="agent-opportunity-status"><div><p className="eyebrow">AGENT GOVERNANCE</p><h3>{control?.agent_policy?.agent_access_enabled ? "Agents may analyze this record." : "Agent execution is disabled."}</h3></div><mark>{selectedOpportunityProposals.filter((proposal) => proposal.status === "pending").length} pending</mark></section>
        <div className="related-group"><div className="related-heading"><p className="eyebrow">HUMAN-GATED PROPOSALS</p><b>{selectedOpportunityProposals.length}</b></div>
          {selectedOpportunityProposals.map((proposal) => { const actionView = proposalActionView(proposal); return <article className="opportunity-agent-item" key={proposal.id}><mark>{proposal.status}</mark><div><strong>{proposal.title}</strong><small>{proposal.confidence}% confidence · {proposal.risk_level} risk</small><small className="proposal-origin">ORIGIN · {proposalOrigin(proposal)}</small><p>{proposal.rationale}</p><small>{actionView.summary}</small>
            {proposal.status === "pending" && canAdmin && proposalDecisionArmed?.id === proposal.id && <small className="proposal-confirmation" role="status">
              {proposalDecisionArmed.decision === "approved"
                ? `Confirm execution: ${actionView.summary}. The server will revalidate this exact proposal before writing.`
                : "Confirm rejection. Nothing will execute and this proposal will leave the pending queue."}
            </small>}
            {proposal.status === "pending" && canAdmin && <span><button disabled={Boolean(mutating) || !Boolean(control?.agent_policy?.agent_access_enabled)} onClick={() => void decideProposal(proposal.id, "approved")}>{mutating === `proposal:${proposal.id}` ? "EXECUTING…" : proposalDecisionArmed?.id === proposal.id && proposalDecisionArmed.decision === "approved" ? "CONFIRM EXECUTION" : actionView.button}</button><button className="secondary" disabled={Boolean(mutating)} onClick={() => void decideProposal(proposal.id, "rejected")}>{mutating === `proposal:${proposal.id}` ? "DECIDING…" : proposalDecisionArmed?.id === proposal.id && proposalDecisionArmed.decision === "rejected" ? "CONFIRM REJECTION" : "REJECT"}</button>
              {proposalDecisionArmed?.id === proposal.id && <button className="secondary" disabled={Boolean(mutating)} onClick={() => setProposalDecisionArmed(null)}>CANCEL</button>}
            </span>}
            {proposal.status === "pending" && !canAdmin && <small>Awaiting an owner or admin decision.</small>}</div></article>; })}
          {!selectedOpportunityProposals.length && <div className="drawer-loading">No proposals for this opportunity.</div>}
        </div>
        <div className="related-group"><div className="related-heading"><p className="eyebrow">AGENT WORK</p><b>{selectedOpportunityWork.length}</b></div>
          {selectedOpportunityWork.map((item) => <article className="opportunity-agent-item" key={item.id}><mark>{item.status}</mark><div><strong>{item.objective}</strong><small>{item.preferred_provider} · {item.automation_name || "manual"}</small><p>{item.instructions}</p>{item.result && <small>{item.result}</small>}</div></article>)}
          {!selectedOpportunityWork.length && <div className="drawer-loading">No agent jobs for this opportunity.</div>}
        </div>
        <div className="opportunity-audit"><p className="eyebrow">IMMUTABLE AUDIT TRACE</p>{selectedOpportunityAudits.map((entry) => <small key={entry.id}><b>{entry.action}</b> · {entry.actor_id} · {new Date(entry.created_at).toLocaleString()}</small>)}{!selectedOpportunityAudits.length && <small>No opportunity audit entries in the current bounded window.</small>}</div>
      </section>}
    </aside></div>}
    {selectedCompany && !selectedOpportunity && !selected && <div className="drawer-backdrop company-backdrop" onClick={() => { setSelectedCompanyId(""); setCompanyDetail(null); setCompanyNote(""); }}><aside ref={companyDrawerRef} className="contact-drawer company-workspace" role="dialog" aria-modal="true" aria-labelledby="company-title" onClick={(event) => event.stopPropagation()}>
      <button ref={companyCloseButtonRef} className="drawer-close" aria-label="Close company workspace" onClick={() => { setSelectedCompanyId(""); setCompanyDetail(null); setCompanyNote(""); }}>×</button>
      <header className="record-identity company-identity">
        <span aria-hidden="true">{selectedCompany.name.slice(0, 2).toUpperCase()}</span>
        <div><p className="eyebrow">ACCOUNT RELATIONSHIP GRAPH</p><h2 id="company-title">{selectedCompany.name}</h2><small>{companyDetail?.company.domain || "Domain not set"} · {companyDetail?.company.industry || "Industry not set"}</small></div>
        <mark>{companyDetail?.company.contacts ?? selectedCompany.contacts} people</mark>
      </header>
      <nav className="record-tabs" role="tablist" aria-label="Company workspace sections">
        {([
          { id: "overview", label: "Overview" },
          { id: "relationships", label: `Relationships ${(companyDetail?.contacts.length || 0) + (companyDetail?.opportunities.length || 0) + (companyDetail?.tasks.length || 0)}` },
          { id: "timeline", label: `Timeline ${companyTimeline.length}` },
        ] as Array<{ id: CompanyDrawerTab; label: string }>).map((tab) =>
          <button key={tab.id} id={`company-tab-${tab.id}`} role="tab" aria-selected={companyDrawerTab === tab.id} aria-controls={`company-panel-${tab.id}`} tabIndex={companyDrawerTab === tab.id ? 0 : -1} onKeyDown={(event) => moveCompanyDrawerTab(event, tab.id)} onClick={() => setCompanyDrawerTab(tab.id)}>{tab.label}</button>)}
      </nav>
      {error && <div className="record-feedback error" role="alert">{error}</div>}
      {!error && notice && <div className="record-feedback notice" role="status">{notice}</div>}
      {!companyDetail && <div className="drawer-loading">Loading account relationships…</div>}
      {companyDrawerTab === "overview" && companyDetail && <section id="company-panel-overview" className="record-panel" role="tabpanel" aria-labelledby="company-tab-overview">
        <dl className="record-facts company-facts"><div><dt>People</dt><dd>{companyDetail.company.contacts}</dd></div><div><dt>Open pipeline</dt><dd>{money(companyDetail.company.open_pipeline)}</dd></div>
          <div><dt>Weighted</dt><dd>{money(companyDetail.company.weighted_forecast)}</dd></div><div><dt>Won revenue</dt><dd>{money(companyDetail.company.won_revenue)}</dd></div></dl>
        <div className="company-context-card"><div><p className="eyebrow">ACCOUNT CONTEXT</p><h3>One identity across people, deals, tasks, and agents.</h3></div><mark>WORKSPACE SCOPED</mark></div>
        <div className="company-field-grid">
          <label>COMPANY NAME<input aria-label={`Company name for ${selectedCompany.name}`} disabled={control?.role !== "owner" && control?.role !== "admin"} title={control?.role === "owner" || control?.role === "admin" ? "Rename company" : "Only workspace admins can rename companies"} maxLength={200} placeholder="Company name" value={companyDraft.name} onChange={(event) => setCompanyDraft({ ...companyDraft, name: event.target.value })} /></label>
          <label>DOMAIN<input aria-label={`Domain for ${selectedCompany.name}`} maxLength={255} placeholder="company.com" value={companyDraft.domain} onChange={(event) => setCompanyDraft({ ...companyDraft, domain: event.target.value })} /></label>
          <label>WEBSITE<input aria-label={`Website for ${selectedCompany.name}`} type="url" maxLength={500} placeholder="https://company.com" value={companyDraft.website} onChange={(event) => setCompanyDraft({ ...companyDraft, website: event.target.value })} /></label>
          <label>INDUSTRY<input aria-label={`Industry for ${selectedCompany.name}`} maxLength={120} placeholder="Professional Services" value={companyDraft.industry} onChange={(event) => setCompanyDraft({ ...companyDraft, industry: event.target.value })} /></label>
          <label>OWNER<input aria-label={`Owner for ${selectedCompany.name}`} type="email" maxLength={254} placeholder="owner@company.com" value={companyDraft.owner} onChange={(event) => setCompanyDraft({ ...companyDraft, owner: event.target.value })} /></label>
        </div>
        {customFields.some((field) => field.object_type === "company" && field.active) && <section className="record-custom-fields">
          <div><p className="eyebrow">CUSTOM ACCOUNT DATA</p></div>
          <LayoutCustomFieldEditor layout={pageLayouts.find((layout) => layout.object_type === "company")}
            fields={customFields.filter((field) => field.object_type === "company" && field.active)}
            draft={companyCustomDraft} disabled={Boolean(mutating)} onChange={setCompanyCustomDraft} />
        </section>}
        <button className="company-save" disabled={Boolean(mutating) || (
          companyDraft.name.trim() === companyDetail.company.name &&
          companyDraft.domain === (companyDetail.company.domain || "") &&
          companyDraft.website === (companyDetail.company.website || "") &&
          companyDraft.industry === (companyDetail.company.industry || "") &&
          companyDraft.owner === (companyDetail.company.owner || "") &&
          JSON.stringify(companyCustomDraft) === JSON.stringify(contactCustomValues(companyDetail.company.custom_fields))
        )} onClick={() => void updateCompany()}>{mutating === `company:${companyDetail.company.id}` ? "SAVING…" : "SAVE ACCOUNT CONTEXT"}</button>
        {(control?.role === "owner" || control?.role === "admin") && <section className="company-identity-maintenance">
          <div><p className="eyebrow">IDENTITY MAINTENANCE</p><h3>Resolve duplicate account records.</h3><small>Merge moves people and account notes into the target, preserves its name, and removes this duplicate identity.</small></div>
          <label>TARGET COMPANY<select aria-label={`Merge target for ${selectedCompany.name}`} value={companyMergeTargetId} disabled={Boolean(mutating)} onChange={(event) => { setCompanyMergeTargetId(event.target.value); setCompanyMergeArmed(false); setCompanyMergePreview(null); }}>
            <option value="">Choose a different company</option>
            {(control?.companies || []).filter((item) => item.id !== companyDetail.company.id).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.contacts} people</option>)}
          </select></label>
          {!companyMergeArmed
            ? <button type="button" className="company-merge-review" disabled={!companyMergeTargetId || Boolean(mutating)} onClick={() => void reviewCompanyMerge()}>{mutating === `company-merge-review:${companyDetail.company.id}` ? "REVIEWING…" : "REVIEW MERGE"}</button>
            : companyMergePreview && <div className="company-merge-confirm" role="alert"><strong>Reviewed impact · this cannot be undone.</strong>
              <div className="merge-impact-grid"><span><b>{companyMergePreview.source_counts.contacts}</b> people move</span><span><b>{companyMergePreview.source_counts.notes}</b> notes move</span><span><b>{companyMergePreview.source_counts.opportunities}</b> opportunities follow</span><span><b>{companyMergePreview.source_counts.tasks}</b> tasks follow</span></div>
              <div className="merge-field-review">{companyMergePreview.field_resolutions.map((field) => <p key={field.field}><b>{field.field}</b><span>{field.resolved_value || "Empty"}</span><small>{field.resolution === "source_fallback" ? "FROM SOURCE" : field.resolution === "target" ? "KEEP TARGET" : "NO VALUE"}</small></p>)}</div>
              <p>{companyMergePreview.warnings.join(" ")}</p><div><button type="button" onClick={() => { setCompanyMergeArmed(false); setCompanyMergePreview(null); }}>CANCEL</button><button type="button" disabled={Boolean(mutating)} onClick={() => void mergeCompany()}>{mutating === `company-merge:${companyDetail.company.id}` ? "MERGING…" : "CONFIRM REVIEWED MERGE"}</button></div></div>}
        </section>}
      </section>}
      {companyDrawerTab === "relationships" && companyDetail && <section id="company-panel-relationships" className="record-panel company-relationships" role="tabpanel" aria-labelledby="company-tab-relationships">
        <div className="related-group"><div className="related-heading"><p className="eyebrow">PEOPLE</p><b>{companyDetail.contacts.length}</b></div>
          {companyDetail.contacts.map((contact) => <article key={contact.id}><mark>{stageLabels[contact.stage] || contact.stage}</mark><div><strong>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email}</strong><small>{contact.email} · score {contact.score}</small>{contact.owner && <p>Owned by {contact.owner}</p>}</div><button aria-label={`Open ${contact.email} contact record`} onClick={() => void openContact({ ...contact, company: selectedCompany.name, source_last: null, revenue: 0 }, true)}>OPEN</button></article>)}
          {!companyDetail.contacts.length && <div className="drawer-loading">No linked people.</div>}
        </div>
        <div className="related-group"><div className="related-heading"><p className="eyebrow">OPPORTUNITIES</p><b>{companyDetail.opportunities.length}</b></div>
          {companyDetail.opportunities.map((item) => <article key={item.id}><mark>{item.status}</mark><div><strong>{item.name}</strong><small>{item.stage_name} · {item.probability}% · {item.contact_first_name || item.contact_email}</small>{item.next_step && <p>{item.next_step}</p>}</div>
            <div className="company-opportunity-actions"><b>{money(item.value)}</b><button type="button"
              aria-label={`Open ${item.name} opportunity workspace`} onClick={() => void openOpportunityWorkspace(item)}>OPEN</button></div></article>)}
          {!companyDetail.opportunities.length && <div className="drawer-loading">No linked opportunities.</div>}
        </div>
        <div className="related-group"><div className="related-heading"><p className="eyebrow">EXECUTION</p><b>{companyDetail.tasks.length}</b></div>
          {companyDetail.tasks.map((task) => <article key={task.id}><mark>{task.status}</mark><div><strong>{task.title}</strong><small>{task.contact_email}{task.opportunity_name ? ` · ${task.opportunity_name}` : ""}</small>{task.due_at && <p>Due {new Date(task.due_at).toLocaleString()}</p>}</div>
            <TaskLifecycleControls task={task} disabled={Boolean(mutating)} deleteArmed={taskDeleteArmed === task.id}
              onStatus={(status) => void updateTaskStatus(task, status)} onDelete={() => void deleteTask(task)}
              onCancelDelete={() => setTaskDeleteArmed("")} /></article>)}
          {!companyDetail.tasks.length && <div className="drawer-loading">No linked tasks.</div>}
        </div>
      </section>}
      {companyDrawerTab === "timeline" && companyDetail && <section id="company-panel-timeline" className="record-panel" role="tabpanel" aria-labelledby="company-tab-timeline">
        <form className="note-form company-note-form" onSubmit={addCompanyNote}><label htmlFor="company-note">ADD ACCOUNT NOTE</label><textarea id="company-note" value={companyNote} onChange={(event) => setCompanyNote(event.target.value)} maxLength={4000} placeholder="What changed across this account, and what happens next?" /><button type="submit" disabled={!companyNote.trim() || Boolean(mutating)}>{mutating === `company-note:${companyDetail.company.id}` ? "SAVING…" : "SAVE ACCOUNT NOTE"}</button></form>
        <section className="activity-section company-timeline" aria-label="Chronological company timeline">
          {companyTimeline.map((item) => <article key={`${item.kind}:${item.id}`}><i>{item.kind === "company-note" ? "C" : item.kind === "contact-note" ? "N" : item.kind === "audit" ? "A" : "↗"}</i><div><strong>{item.title}</strong>
            {item.note && companyNoteEditing?.id === item.id
              ? <div className="company-note-editor"><textarea aria-label="Edit company note" maxLength={4000} value={companyNoteEditing.body} onChange={(event) => setCompanyNoteEditing({ id: item.id, body: event.target.value })} /><div><button type="button" onClick={() => setCompanyNoteEditing(null)}>CANCEL</button><button type="button" disabled={!companyNoteEditing.body.trim() || Boolean(mutating)} onClick={() => void updateCompanyNote(item.note!)}>{mutating === `company-note-edit:${item.id}` ? "SAVING…" : "SAVE EDIT"}</button></div></div>
              : item.body && <p>{item.body}</p>}
            <small>{new Date(item.occurred_at).toLocaleString()} · {item.actor}{item.note?.updated_at && item.note.updated_at !== item.note.created_at ? " · edited" : ""}</small>
            {item.contact_id && <button type="button" className="timeline-contact-link"
              aria-label={`Open contact from ${item.title}`} onClick={() => void openCompanyTimelineContact(item.contact_id!)}>OPEN CONTACT</button>}
            {item.note && (control?.role === "owner" || control?.role === "admin" || item.note.author === control?.current_user?.email) && companyNoteEditing?.id !== item.id && <div className="company-note-actions"><button type="button" onClick={() => { setCompanyNoteEditing({ id: item.id, body: item.note!.body }); setCompanyNoteDeleteArmed(""); }}>EDIT</button><button type="button" className={companyNoteDeleteArmed === item.id ? "danger" : ""} onClick={() => void deleteCompanyNote(item.note!)}>{companyNoteDeleteArmed === item.id ? "CONFIRM DELETE" : "DELETE"}</button>{companyNoteDeleteArmed === item.id && <button type="button" onClick={() => setCompanyNoteDeleteArmed("")}>CANCEL</button>}</div>}
          </div></article>)}
          {!companyTimeline.length && <div className="drawer-loading">No account activity recorded yet.</div>}
        </section>
      </section>}
    </aside></div>}
    {selected && !selectedOpportunity && <div className="drawer-backdrop" onClick={() => void closeContactWorkspace()}><aside ref={drawerRef} className="contact-drawer" role="dialog" aria-modal="true" aria-labelledby="contact-title" onClick={(event) => event.stopPropagation()}>
      <button ref={closeButtonRef} className="drawer-close" aria-label="Close contact details" onClick={() => void closeContactWorkspace()}>×</button>
      <header className="record-identity">
        <span aria-hidden="true">{selectedInitials}</span>
        <div><p className="eyebrow">CONTACT RECORD</p><h2 id="contact-title">{selectedName}</h2><a href={`mailto:${selected.email}`}>{selected.email}</a></div>
        <mark>{detail?.contact.status || selected.status}</mark>
      </header>
      <nav className="record-tabs" role="tablist" aria-label="Contact record sections">
        {([
          { id: "overview", label: "Overview" },
          { id: "timeline", label: `Timeline ${contactTimeline.length}` },
          { id: "related", label: `Related ${(detail?.opportunities.length || 0) + (detail?.tasks.length || 0)}` },
        ] as Array<{ id: ContactDrawerTab; label: string }>).map((tab) =>
          <button key={tab.id} id={`record-tab-${tab.id}`} role="tab" aria-selected={drawerTab === tab.id} aria-controls={`record-panel-${tab.id}`} tabIndex={drawerTab === tab.id ? 0 : -1} onKeyDown={(event) => moveDrawerTab(event, tab.id)} onClick={() => setDrawerTab(tab.id)}>{tab.label}</button>)}
      </nav>
      {error && <div className="record-feedback error" role="alert">{error}</div>}
      {!error && notice && <div className="record-feedback notice" role="status">{notice}</div>}
      {!detail && <div className="drawer-loading">Loading complete record…</div>}
      {drawerTab === "overview" && <section id="record-panel-overview" className="record-panel" role="tabpanel" aria-labelledby="record-tab-overview">
        <dl className="record-facts"><div><dt>Company</dt><dd>{selected.company || "—"}</dd></div><div><dt>Source</dt><dd>{selected.source_last || "Direct"}</dd></div>
          <div><dt>Revenue</dt><dd>{money(selected.revenue || 0)}</dd></div><div><dt>Score</dt><dd>{selected.score}</dd></div></dl>
        <div className="record-field-grid">
          <label htmlFor="contact-stage">LEAD LIFECYCLE<select id="contact-stage" disabled={Boolean(mutating)} value={detail?.contact.stage || selected.stage} onChange={(e) => void updateContact(selected, { stage: e.target.value })}>
            {Object.entries(stageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label htmlFor="contact-status">RECORD STATUS<select id="contact-status" disabled={Boolean(mutating)} value={detail?.contact.status || selected.status} onChange={(e) => void updateContact(selected, { status: e.target.value })}>
            <option value="lead">Lead</option><option value="customer">Customer</option><option value="inactive">Inactive</option>
          </select></label>
        </div>
        <label htmlFor="contact-owner">OWNER</label><div className="owner-editor"><input id="contact-owner" type="email" maxLength={254} placeholder="owner@company.com" disabled={Boolean(mutating)} value={contactOwnerDraft} onChange={(event) => setContactOwnerDraft(event.target.value)} /><button type="button" disabled={Boolean(mutating) || contactOwnerDraft.trim() === (detail?.contact.owner || selected.owner || "")} onClick={() => void updateContact(selected, { owner: contactOwnerDraft.trim() || null })}>SAVE OWNER</button></div>
        <label htmlFor="follow-up">NEXT FOLLOW-UP</label><input id="follow-up" disabled={Boolean(mutating)} type="datetime-local" value={detail?.contact.next_follow_up_at?.slice(0,16) || ""} onChange={(event) => void updateContact(selected, { next_follow_up_at: event.target.value ? new Date(event.target.value).toISOString() : null })} />
        {customFields.some((field) => field.object_type === "contact" && field.active) && <section className="record-custom-fields" aria-labelledby="record-custom-fields-title">
          <div><p className="eyebrow">CUSTOM RECORD DATA</p><h3 id="record-custom-fields-title">Workspace fields</h3></div>
          <LayoutCustomFieldEditor layout={pageLayouts.find((layout) => layout.object_type === "contact")}
            fields={customFields.filter((field) => field.object_type === "contact" && field.active)}
            draft={contactCustomDraft} disabled={Boolean(mutating)} onChange={setContactCustomDraft} />
          <button type="button" disabled={Boolean(mutating) || !detail} onClick={() => void saveContactCustomFields()}>
            {mutating === `contact:${selected.id}` ? "SAVING CUSTOM DATA…" : "SAVE CUSTOM DATA"}
          </button>
        </section>}
        {(detail?.contact.status || selected.status) === "lead" && detail && detail.opportunities.length === 0 &&
          <button className="qualify-action" type="button" disabled={Boolean(mutating)} onClick={() => qualifyContact(detail.contact)}>QUALIFY → CREATE OPPORTUNITY</button>}
        {detail && detail.opportunities.length > 0 &&
          <div className="pipeline-membership" role="status"><b>IN PIPELINE</b><span>{detail.opportunities.length} {detail.opportunities.length === 1 ? "opportunity" : "opportunities"}</span></div>}
        {canAdmin && <div className="delete-confirmation">
          <button className="danger-action" onClick={() => deleteArmed ? void deleteSelectedContact() : setDeleteArmed(true)}>
            {deleteArmed ? "CONFIRM PERMANENT DELETE" : "DELETE CONTACT + LINKED HISTORY"}
          </button>
          {deleteArmed && <button className="cancel-delete" onClick={() => setDeleteArmed(false)}>CANCEL</button>}
        </div>}
      </section>}
      {drawerTab === "timeline" && <section id="record-panel-timeline" className="record-panel" role="tabpanel" aria-labelledby="record-tab-timeline">
        <form className="note-form" onSubmit={addNote}><label htmlFor="contact-note">ADD NOTE</label><textarea id="contact-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} placeholder="What happened, and what happens next?" /><button type="submit" disabled={!note.trim() || Boolean(mutating)}>{mutating === "contact-note-create" ? "SAVING…" : "SAVE NOTE"}</button></form>
        <section className="activity-section" aria-label="Chronological contact timeline">
          {contactTimeline.map((item) => <article key={`${item.kind}:${item.id}`}><i>{item.kind === "note" ? "N" : "A"}</i><div><strong>{item.title}</strong>
            {item.note && contactNoteEditing?.id === item.id
              ? <div className="company-note-editor"><textarea aria-label="Edit contact note" maxLength={4000}
                value={contactNoteEditing.body}
                onChange={(event) => setContactNoteEditing({ id: item.id, body: event.target.value })} />
                <div><button type="button" onClick={() => setContactNoteEditing(null)}>CANCEL</button>
                  <button type="button" disabled={!contactNoteEditing.body.trim() || Boolean(mutating)}
                    onClick={() => void updateContactNote(item.note!)}>{mutating === `contact-note-edit:${item.id}` ? "SAVING…" : "SAVE EDIT"}</button></div></div>
              : item.body && <p>{item.body}</p>}
            <small>{new Date(item.occurred_at).toLocaleString()} · {item.actor}</small>
            {item.note && (control?.role === "owner" || control?.role === "admin" || item.note.author === control?.current_user?.email) &&
              contactNoteEditing?.id !== item.id && <div className="company-note-actions">
                <button type="button" onClick={() => {
                  setContactNoteEditing({ id: item.id, body: item.note!.body });
                  setContactNoteDeleteArmed("");
                }}>EDIT</button>
                <button type="button" className={contactNoteDeleteArmed === item.id ? "danger" : ""}
                  onClick={() => void deleteContactNote(item.note!)}>{contactNoteDeleteArmed === item.id ? "CONFIRM DELETE" : "DELETE"}</button>
                {contactNoteDeleteArmed === item.id && <button type="button" onClick={() => setContactNoteDeleteArmed("")}>CANCEL</button>}
              </div>}
          </div></article>)}
          {detail && !contactTimeline.length && <div className="drawer-loading">No activity recorded yet.</div>}
        </section>
      </section>}
      {drawerTab === "related" && <section id="record-panel-related" className="record-panel related-records" role="tabpanel" aria-labelledby="record-tab-related">
        <div className="related-group"><div className="related-heading"><p className="eyebrow">OPPORTUNITIES</p><b>{detail?.opportunities.length || 0}</b></div>
          {detail?.opportunities.map((item) => <article key={item.id}><mark>{item.status}</mark><div><strong>{item.name}</strong><small>{item.stage_name} · {item.probability}% probability</small>{item.next_step && <p>{item.next_step}</p>}</div>
            <div className="company-opportunity-actions"><b>{money(item.value)}</b><button type="button"
              aria-label={`Open ${item.name} opportunity workspace`} onClick={() => void openOpportunityWorkspace(item)}>OPEN</button></div></article>)}
          {detail && !detail.opportunities.length && <div className="drawer-loading">No linked opportunities.</div>}
        </div>
        <div className="related-group"><div className="related-heading"><p className="eyebrow">TASKS</p><b>{detail?.tasks.length || 0}</b></div>
          {detail?.tasks.map((item) => <article key={item.id}><mark>{item.status}</mark><div><strong>{item.title}</strong><small>{item.priority} priority{item.assignee ? ` · ${item.assignee}` : ""}</small>{item.due_at && <p>Due {new Date(item.due_at).toLocaleString()}</p>}</div>
            <TaskLifecycleControls task={item} disabled={Boolean(mutating)} deleteArmed={taskDeleteArmed === item.id}
              onStatus={(status) => void updateTaskStatus(item, status)} onDelete={() => void deleteTask(item)}
              onCancelDelete={() => setTaskDeleteArmed("")} /></article>)}
          {detail && !detail.tasks.length && <div className="drawer-loading">No linked tasks.</div>}
        </div>
      </section>}
    </aside></div>}
  </main>;
}
