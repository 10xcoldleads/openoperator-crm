import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { handleAgentMcp } from "./agent-mcp";
import {
  automationCatalog,
  integrationCatalog,
  pipelineCatalog,
  PRODUCT_CATALOG_VERSION,
  publicProductCatalog,
  type AutomationConditionField,
  type RecordType,
  validateProductCatalog,
} from "../contracts/productCatalog";

interface FrameworkEnv extends Env {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  ALLOW_INSECURE_LOCAL_AUTH?: string;
  WEBHOOK_ENCRYPTION_KEY?: string;
  RECOVERY_ENCRYPTION_KEY?: string;
  RECOVERY_PREVIOUS_ENCRYPTION_KEYS?: string;
  SCHEDULER_SECRET?: string;
  COMPOSIO_API_KEY?: string;
  COMPOSIO_GMAIL_AUTH_CONFIG_ID?: string;
  COMPOSIO_OUTLOOK_AUTH_CONFIG_ID?: string;
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

async function authenticatedRequest(request: Request, env: FrameworkEnv): Promise<Request> {
  if (env.ALLOW_INSECURE_LOCAL_AUTH === "true") {
    if (request.headers.get("oai-authenticated-user-email")) return request;
    const pathname = new URL(request.url).pathname;
    const acceptsHtml = !pathname.startsWith("/v1/") && pathname !== "/mcp" &&
      request.headers.get("accept")?.includes("text/html") === true;
    const isBrowserNavigation = request.headers.get("sec-fetch-mode") === "navigate" &&
      request.headers.get("sec-fetch-dest") === "document";
    const sameOriginBrowserRequest = request.headers.get("sec-fetch-site") === "same-origin";
    if (!acceptsHtml && !isBrowserNavigation && !sameOriginBrowserRequest) return request;
    const local = new Request(request);
    local.headers.set("oai-authenticated-user-email", "owner@example.com");
    return local;
  }
  if (env.TEAM_DOMAIN && env.POLICY_AUD) {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) throw new ApiError(401, "Cloudflare Access authentication required");
    try {
      const issuer = env.TEAM_DOMAIN.replace(/\/$/, "");
      const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: env.POLICY_AUD,
      });
      if (typeof payload.email !== "string" || !payload.email.includes("@")) {
        throw new Error("Access token has no email claim");
      }
      const verified = new Request(request);
      verified.headers.set("oai-authenticated-user-email", payload.email.toLowerCase());
      if (typeof payload.name === "string") {
        verified.headers.set("oai-authenticated-user-full-name", encodeURIComponent(payload.name));
        verified.headers.set("oai-authenticated-user-full-name-encoding", "percent-encoded-utf-8");
      }
      return verified;
    } catch (error) {
      console.warn("Cloudflare Access JWT validation failed", error instanceof Error ? error.message : "unknown error");
      throw new ApiError(401, "Invalid Cloudflare Access authentication");
    }
  }
  throw new ApiError(503, "Authentication is not configured");
}

function usesIndependentCredential(pathname: string): boolean {
  return pathname === "/v1/health" ||
    pathname === "/mcp" || pathname === "/v1/mcp" ||
    pathname === "/v1/contacts/upsert" ||
    pathname === "/v1/integrations/skool/events" ||
    pathname === "/v1/internal/jobs/webhook-retries" ||
    /^\/v1\/integrations\/audience-intake\/audiencelab\/vti_[a-f0-9]{64}$/.test(pathname) ||
    /^\/v1\/integrations\/visitor-intent\/(audiencelab|rb2b)\/vti_[a-f0-9]{64}$/.test(pathname) ||
    /^\/v1\/public\/forms\/[a-z0-9][a-z0-9-]{2,79}(?:\/submissions)?$/.test(pathname) ||
    /^\/f\/[a-z0-9][a-z0-9-]{2,79}$/.test(pathname) ||
    /^\/v1\/public\/booking\/[a-z0-9][a-z0-9-]{2,79}(?:\/appointments)?$/.test(pathname) ||
    pathname === "/v1/public/appointments/manage" ||
    /^\/book\/[a-z0-9][a-z0-9-]{2,79}(?:\/manage)?$/.test(pathname) ||
    /^\/v1\/hooks\/[^/]+$/.test(pathname);
}
type Json = Record<string, unknown>;
function isPlainObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
type WorkspaceAccess = { workspaceId: string; email: string; role: string };
const communicationSignalTypes = new Set([
  "sales.call_analyzed",
  "email.received",
  "email.sent",
  "calendar.meeting_scheduled",
  "calendar.meeting_completed",
]);

// Deliberately maintained beside the Worker implementation rather than derived
// from the catalog. Catalog validation therefore fails when product metadata is
// added without an explicit server-side lifecycle decision.
const workerCatalogHandlers = {
  automationExecutors: new Set([
    "create_task", "add_note", "update_opportunity",
    "update_contact", "request_agent", "publish_event",
  ]),
  integrationExecutors: new Set([
    "composio", "skool-ingest", "visitor-intake", "agent-mcp",
    "webhook-ingest", "webhook-delivery", "resend-email",
  ]),
  integrationHealthChecks: new Set([
    "composio-account", "source-last-used", "connector-last-event",
    "agent-run-observed", "delivery-history", "resend-verification",
  ]),
  integrationRevokers: new Set([
    "composio-revoke", "source-revoke", "visitor-connector-revoke",
    "agent-credential-revoke", "webhook-delete", "resend-local-revoke",
  ]),
};

function validateWorkerCatalogBindings() {
  const errors: string[] = [];
  for (const action of automationCatalog.actions) {
    if (!workerCatalogHandlers.automationExecutors.has(action.executor)) {
      errors.push(`Automation executor ${action.executor} is not registered in the Worker`);
    }
  }
  for (const integration of integrationCatalog.filter((item) => item.availability === "implemented")) {
    if (!integration.executor || !workerCatalogHandlers.integrationExecutors.has(integration.executor)) {
      errors.push(`Integration executor for ${integration.id} is not registered in the Worker`);
    }
    if (!integration.healthCheck || !workerCatalogHandlers.integrationHealthChecks.has(integration.healthCheck)) {
      errors.push(`Integration health check for ${integration.id} is not registered in the Worker`);
    }
    if (!integration.revoke || !workerCatalogHandlers.integrationRevokers.has(integration.revoke)) {
      errors.push(`Integration revoker for ${integration.id} is not registered in the Worker`);
    }
  }
  return errors;
}

type CommunicationMetadata = {
  sentiment: "positive" | "neutral" | "negative" | null;
  call_score: number | null;
  objections: string[];
  next_step_detected: boolean | null;
};

function communicationMetadata(value: unknown): CommunicationMetadata {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = typeof value === "string" ? JSON.parse(value) : value;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
  } catch {}
  const sentiment = ["positive", "neutral", "negative"].includes(String(parsed.sentiment))
    ? String(parsed.sentiment) as CommunicationMetadata["sentiment"] : null;
  const score = typeof parsed.call_score === "number" ? parsed.call_score : Number.NaN;
  const objections = Array.isArray(parsed.objections)
    ? parsed.objections.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 5)
    : [];
  return {
    sentiment,
    call_score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    objections,
    next_step_detected: typeof parsed.next_step_detected === "boolean" ? parsed.next_step_detected : null,
  };
}
type StoredProposalAction =
  | {
      type: "create_task";
      contact_id: string | null;
      opportunity_id: string | null;
      title: string;
      priority: "low" | "normal" | "high" | "urgent";
      due_at: string | null;
    }
  | {
      type: "update_opportunity";
      opportunity_id: string;
      expected_updated_at: string;
      changes: Json;
    }
  | {
      type: "update_contact";
      contact_id: string;
      expected_updated_at: string;
      changes: Json;
    }
  | {
      type: "run_workflow";
      workflow_id: string;
      workflow_updated_at: string;
      record_type: "contact" | "opportunity";
      record_id: string;
    }
  | {
      type: "promote_visitor";
      visitor_profile_id: string;
      expected_revision: number;
    }
  | {
      type: "open_intent_case";
      company_domain: string;
      expected_evidence_updated_at: string;
      priority: "low" | "normal" | "high" | "urgent";
      due_at: string;
    };

const encoder = new TextEncoder();
const allowedStages = new Set(["new", "registered", "confirmed", "attended", "offer", "booked", "won"]);
const allowedStatuses = new Set(["lead", "customer", "inactive"]);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_RECOVERY_BYTES = 1_500_000;
const MAX_IMPORT_BYTES = 64 * 1024;
const MAX_IMPORT_ROWS = 100;
const MAX_RECOVERY_PLAINTEXT_BYTES = 1_000_000;
const RECOVERY_FORMAT = "openoperator.workspace-backup";
const RECOVERY_VERSION = 1;
const RECOVERY_SCHEMA_VERSION = 29;
type RecoveryTable =
  | "pipelines" | "pipeline_stages" | "companies" | "company_redirects" | "contacts" | "activities" | "deals" | "notes" | "company_notes"
  | "custom_field_definitions"
  | "object_page_layouts"
  | "custom_object_definitions" | "custom_object_views" | "custom_object_records" | "custom_object_relations"
  | "saved_views" | "opportunities" | "tasks" | "automation_rules" | "automation_runs"
  | "visitor_connectors" | "audience_imports" | "visitor_profiles" | "audience_import_members"
  | "visitor_events" | "visitor_intent_cases" | "mailbox_connections"
  | "communication_consents" | "conversation_threads" | "conversation_messages"
  | "forms" | "form_versions" | "form_submissions"
  | "surveys" | "survey_versions" | "survey_responses"
  | "booking_calendars" | "booking_availability_rules" | "booking_appointments"
  | "payment_ledger_entries";
type RecoverySpec = { columns: string[] };
const recoverySpecs: Record<RecoveryTable, RecoverySpec> = {
  pipelines: { columns: ["id", "workspace_id", "name", "object_type", "active", "created_at", "updated_at"] },
  pipeline_stages: { columns: ["id", "workspace_id", "pipeline_id", "name", "position", "probability", "category", "color", "created_at"] },
  companies: { columns: ["id", "workspace_id", "name", "name_key", "domain", "website", "industry", "owner", "custom_fields", "created_at", "updated_at"] },
  company_redirects: { columns: ["id", "workspace_id", "source_company_id", "target_company_id", "source_name", "merged_at"] },
  contacts: { columns: ["id", "workspace_id", "email", "first_name", "last_name", "phone", "company", "company_id", "status", "stage", "score", "owner", "source_first", "source_last", "tags", "custom_fields", "last_activity_at", "next_follow_up_at", "created_at", "updated_at"] },
  custom_field_definitions: { columns: ["id", "workspace_id", "object_type", "field_key", "label", "field_type", "options", "required", "active", "position", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  object_page_layouts: { columns: ["id", "workspace_id", "object_type", "name", "sections", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  custom_object_definitions: { columns: ["id", "workspace_id", "slug", "singular_label", "plural_label", "description", "fields", "active", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  custom_object_views: { columns: ["id", "workspace_id", "object_id", "name", "visibility", "filters", "visible_fields", "sort_field", "sort_direction", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  custom_object_records: { columns: ["id", "workspace_id", "object_id", "display_name", "data", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  custom_object_relations: { columns: ["id", "workspace_id", "source_record_id", "target_type", "target_id", "label", "created_by", "created_at"] },
  activities: { columns: ["id", "workspace_id", "contact_id", "source_id", "type", "title", "body", "metadata", "external_id", "occurred_at", "created_at"] },
  deals: { columns: ["id", "workspace_id", "contact_id", "source_id", "name", "stage", "value", "currency", "external_id", "closed_at", "created_at", "updated_at"] },
  notes: { columns: ["id", "workspace_id", "contact_id", "author", "body", "created_at", "updated_at"] },
  company_notes: { columns: ["id", "workspace_id", "company_id", "author", "body", "created_at", "updated_at"] },
  saved_views: { columns: ["id", "workspace_id", "name", "object_type", "filters", "visibility", "columns", "sorts", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  opportunities: { columns: ["id", "workspace_id", "pipeline_id", "stage_id", "contact_id", "name", "status", "value", "currency", "probability", "owner", "expected_close_at", "last_activity_at", "next_step", "lost_reason", "custom_fields", "created_at", "updated_at"] },
  tasks: { columns: ["id", "workspace_id", "contact_id", "opportunity_id", "title", "description", "status", "priority", "assignee", "due_at", "completed_at", "created_by", "created_at", "updated_at"] },
  automation_rules: { columns: ["id", "workspace_id", "name", "trigger_type", "conditions", "actions", "else_actions", "status", "max_runs_per_record", "authority_manifest", "authority_hash", "created_by", "created_at", "updated_at"] },
  automation_runs: { columns: ["id", "workspace_id", "rule_id", "record_type", "record_id", "event_id", "retry_of_run_id", "principal_id", "trigger_actor_type", "trigger_actor_id", "authority_manifest", "authority_hash", "status", "step_count", "output", "error", "started_at", "finished_at"] },
  visitor_connectors: { columns: ["id", "workspace_id", "provider", "name", "token_hash", "token_prefix", "active", "consent_default", "created_by", "last_event_at", "change_id", "created_at", "updated_at"] },
  audience_imports: { columns: ["id", "workspace_id", "connector_id", "provider", "external_key", "list_name", "mode", "consent_basis", "tags", "requested_rows", "created_profiles", "updated_profiles", "repeated_rows", "created_by", "created_at"] },
  visitor_profiles: { columns: ["id", "workspace_id", "connector_id", "provider", "identity_key", "identity_kind", "email", "first_name", "last_name", "linkedin_url", "title", "company_name", "company_domain", "industry", "employee_count", "estimated_revenue", "city", "region", "postal_code", "consent_status", "review_status", "matched_contact_id", "visit_count", "high_intent_count", "first_seen_at", "last_seen_at", "latest_url", "latest_referrer", "tags", "revision", "review_change_id", "origin_import_id", "created_at", "updated_at"] },
  audience_import_members: { columns: ["id", "workspace_id", "import_id", "profile_id", "row_key", "outcome", "created_at"] },
  visitor_events: { columns: ["id", "workspace_id", "connector_id", "profile_id", "provider", "dedupe_key", "ingest_nonce", "occurred_at", "captured_url", "referrer", "tags", "is_repeat", "is_high_intent", "created_at"] },
  visitor_intent_cases: { columns: ["id", "workspace_id", "company_domain", "company_name", "status", "priority", "owner", "due_at", "evidence_updated_at", "intent_score", "evidence_snapshot", "resolution_note", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  mailbox_connections: { columns: ["id", "workspace_id", "owner_email", "provider", "toolkit", "alias", "auth_config_id", "composio_user_id", "connected_account_id", "status", "provider_status", "allowed_capabilities", "last_synced_at", "last_error", "revision", "change_id", "connect_expires_at", "created_by", "created_at", "updated_at"] },
  communication_consents: { columns: ["id", "workspace_id", "contact_id", "channel", "status", "basis", "evidence", "captured_at", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  conversation_threads: { columns: ["id", "workspace_id", "contact_id", "channel", "provider", "provider_thread_id", "participant_email", "subject", "status", "last_message_at", "unread_count", "revision", "change_id", "created_at", "updated_at"] },
  conversation_messages: { columns: ["id", "workspace_id", "thread_id", "direction", "provider", "provider_message_id", "idempotency_key", "from_email", "to_email", "subject", "body_text", "purpose", "status", "error", "sent_by", "occurred_at", "created_at", "updated_at"] },
  forms: { columns: ["id", "workspace_id", "name", "slug", "status", "title", "description", "fields", "consent_text", "success_message", "published_version_id", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  form_versions: { columns: ["id", "workspace_id", "form_id", "version", "title", "description", "fields", "consent_text", "success_message", "published_by", "published_at"] },
  form_submissions: { columns: ["id", "workspace_id", "form_id", "form_version_id", "idempotency_key", "contact_id", "payload", "email_consent", "consent_text", "ip_hash", "user_agent", "submitted_at"] },
  surveys: { columns: ["id", "workspace_id", "name", "slug", "status", "title", "description", "questions", "success_message", "published_version_id", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  survey_versions: { columns: ["id", "workspace_id", "survey_id", "version", "title", "description", "questions", "success_message", "published_by", "published_at"] },
  survey_responses: { columns: ["id", "workspace_id", "survey_id", "survey_version_id", "idempotency_key", "answers", "privacy_accepted", "started_at", "submitted_at", "duration_seconds", "ip_hash", "user_agent"] },
  booking_calendars: { columns: ["id", "workspace_id", "name", "slug", "status", "title", "description", "timezone", "duration_minutes", "buffer_before_minutes", "buffer_after_minutes", "minimum_notice_minutes", "maximum_days_ahead", "revision", "change_id", "created_by", "created_at", "updated_at"] },
  booking_availability_rules: { columns: ["id", "workspace_id", "calendar_id", "day_of_week", "start_minute", "end_minute", "created_at"] },
  booking_appointments: { columns: ["id", "workspace_id", "calendar_id", "contact_id", "idempotency_key", "name", "email", "phone", "visitor_timezone", "starts_at", "ends_at", "status", "manage_token_hash", "external_provider", "external_event_id", "sync_status", "cancelled_at", "cancellation_reason", "revision", "change_id", "created_at", "updated_at"] },
  payment_ledger_entries: { columns: ["id", "workspace_id", "contact_id", "opportunity_id", "parent_entry_id", "idempotency_key", "kind", "amount_minor", "currency", "description", "provider", "provider_reference", "occurred_at", "created_by", "created_at"] },
};
const recoveryTables = Object.keys(recoverySpecs) as RecoveryTable[];
const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
};
const faviconIcoBase64 = "AAABAAEAICAAAAEAIAA3AQAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAAlwSFlzAAALEwAACxMBAJqcGAAAAOlJREFUWIXtl7sKwjAUhs9TnIuDg9CpbuLaF/BSfKIOJtBnEry8jWOpFRwj0XrFLtU0RRr41pwvySHJD1AOQYyFcCeMR2EybrBz47ZHNIPnwYypu6KfYSb9WHnDxW8Q0RSu2+5HQBg3IEyFPwE6gMfiF6D1AvGgb1QY1OZrARUGJotGtekE5NdHsBoP/faAept0MZ+YVCeVOBdIdWJO+b6STkD+vgfE9VWsOoGwZRdR1j1GUcPPcez7QyKOgTYIFB4FcrBZzZ8ArsEGRV8CRDQpwynpxgWIli8J2QZFm9Uc90Rht/2+cgA4A3VP/dYsoqjhAAAAAElFTkSuQmCC";

function faviconResponse() {
  const binary = atob(faviconIcoBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "content-type": "image/x-icon",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
    },
  });
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...securityHeaders, ...extraHeaders } });
}
function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
async function mailboxComposioUserId(workspaceId: string, ownerEmail: string) {
  return `crm_${(await sha256(`${workspaceId}:${normalizeEmail(ownerEmail)}`)).slice(0, 40)}`;
}

const mailboxCapabilities = new Set(["mail.profile.read", "mail.drafts.create"]);
type MailboxProvider = "gmail" | "outlook";

function parseStringArray(value: unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeMailboxStatus(value: unknown) {
  const providerStatus = String(value || "").trim().toUpperCase();
  const status = providerStatus === "ACTIVE" ? "active"
    : providerStatus === "DISABLED" ? "disabled"
      : providerStatus === "REVOKED" ? "revoked"
        : providerStatus === "EXPIRED" ? "expired"
        : ["INITIATED", "PENDING"].includes(providerStatus) ? "pending"
          : "error";
  return { providerStatus: providerStatus || "UNKNOWN", status };
}

function composioAccountId(value: unknown) {
  if (!isPlainObject(value)) return null;
  const candidate = value.id ?? value.nanoid ?? value.connected_account_id;
  return typeof candidate === "string" && /^ca_[A-Za-z0-9_-]{4,120}$/.test(candidate) ? candidate : null;
}

type ComposioFailureReason =
  "provider_auth_rejected" | "provider_rate_limited" | "provider_unavailable" |
  "provider_request_rejected" | "provider_unreachable" | "provider_invalid_response";

class ComposioError extends Error {
  readonly status = 502;

  constructor(
    public reason: ComposioFailureReason,
    message: string,
    public upstreamStatus: number | null,
  ) {
    super(message);
    this.name = "ComposioError";
  }
}

async function composioRequest(env: FrameworkEnv, path: string, init: RequestInit = {}) {
  if (!env.COMPOSIO_API_KEY) throw new ApiError(503, "Mailbox connections are not configured");
  let response: Response;
  try {
    response = await fetch(`https://backend.composio.dev${path}`, {
      ...init,
      // Never follow a provider redirect with the project API key attached.
      // "manual" also preserves a 3xx response for accurate classification
      // instead of turning it into an indistinguishable network exception.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": env.COMPOSIO_API_KEY,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name.slice(0, 80) : "UnknownError";
    const transportCategory = error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)
      ? "timeout"
      : error instanceof Error && /redirect/i.test(error.message)
        ? "redirect_rejected"
        : error instanceof TypeError ? "network_or_runtime" : "unknown";
    console.error(JSON.stringify({
      event: "composio.request.transport_error",
      provider: "composio",
      path: path.slice(0, 200),
      method: String(init.method || "GET").toUpperCase(),
      error_name: errorName,
      transport_category: transportCategory,
    }));
    throw new ComposioError("provider_unreachable", "Composio could not be reached", null);
  }
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403 ? "provider_auth_rejected"
      : response.status === 429 ? "provider_rate_limited"
        : response.status >= 500 ? "provider_unavailable" : "provider_request_rejected";
    const providerMessage = reason === "provider_auth_rejected"
      ? `Composio rejected the project API key or its permissions (HTTP ${response.status})`
      : reason === "provider_rate_limited"
        ? "Composio rate-limited the connection request (HTTP 429)"
        : reason === "provider_unavailable"
          ? `Composio was unavailable (HTTP ${response.status})`
          : `Composio rejected the connection request (HTTP ${response.status})`;
    throw new ComposioError(reason, providerMessage, response.status);
  }
  if (!isPlainObject(body)) {
    throw new ComposioError("provider_invalid_response", "Composio returned an invalid response", response.status);
  }
  return body;
}

type MailboxConversation = {
  id: string; subject: string; sender_name: string; sender_email: string;
  received_at: string | null; snippet: string; unread: boolean;
};

function composioProxyData(value: Json) {
  if (typeof value.status === "number" && (value.status < 200 || value.status >= 300)) {
    throw new ComposioError(
      value.status === 401 || value.status === 403 ? "provider_auth_rejected"
        : value.status === 429 ? "provider_rate_limited"
          : value.status >= 500 ? "provider_unavailable" : "provider_request_rejected",
      value.status === 401 || value.status === 403
        ? "The mailbox needs to be reconnected with read permission"
        : value.status === 429 ? "The mailbox provider rate-limited this request"
          : "The mailbox provider could not return conversations",
      value.status,
    );
  }
  return isPlainObject(value.data) ? value.data : value;
}

async function composioProxy(
  env: FrameworkEnv,
  connectedAccountId: string,
  endpoint: string,
  parameters: Array<{ name: string; value: string; in: "query" | "header" }> = [],
) {
  return composioProxyData(await composioRequest(env, "/api/v3.1/tools/execute/proxy", {
    method: "POST",
    body: JSON.stringify({
      connected_account_id: connectedAccountId, endpoint, method: "GET", parameters,
    }),
  }));
}

function gmailHeader(message: Json, name: string) {
  const payload = isPlainObject(message.payload) ? message.payload : {};
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const header = headers.find((candidate) =>
    isPlainObject(candidate) && String(candidate.name || "").toLowerCase() === name.toLowerCase());
  return isPlainObject(header) ? String(header.value || "").slice(0, 500) : "";
}

function mailboxSender(value: string) {
  const match = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim().slice(0, 160), email: normalizeEmail(match[2]).slice(0, 254) };
  return { name: "", email: normalizeEmail(value).slice(0, 254) };
}

async function fetchMailboxConversations(
  env: FrameworkEnv,
  provider: MailboxProvider,
  connectedAccountId: string,
  limit: number,
) {
  if (provider === "outlook") {
    const data = await composioProxy(env, connectedAccountId, "/v1.0/me/messages", [
      { name: "$top", value: String(limit), in: "query" },
      { name: "$select", value: "id,conversationId,subject,sender,receivedDateTime,bodyPreview,isRead", in: "query" },
      { name: "$orderby", value: "receivedDateTime desc", in: "query" },
    ]);
    const values = Array.isArray(data.value) ? data.value : [];
    return values.filter(isPlainObject).slice(0, limit).map((message): MailboxConversation => {
      const sender = isPlainObject(message.sender) && isPlainObject(message.sender.emailAddress)
        ? message.sender.emailAddress : {};
      return {
        id: String(message.conversationId || message.id || "").slice(0, 500),
        subject: String(message.subject || "(no subject)").slice(0, 500),
        sender_name: String(sender.name || "").slice(0, 160),
        sender_email: normalizeEmail(sender.address).slice(0, 254),
        received_at: typeof message.receivedDateTime === "string" &&
          Number.isFinite(Date.parse(message.receivedDateTime)) ? message.receivedDateTime : null,
        snippet: String(message.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 280),
        unread: message.isRead === false,
      };
    }).filter((conversation) => conversation.id);
  }
  const listed = await composioProxy(env, connectedAccountId, "/gmail/v1/users/me/messages", [
    { name: "maxResults", value: String(limit), in: "query" },
    { name: "labelIds", value: "INBOX", in: "query" },
  ]);
  const messages = (Array.isArray(listed.messages) ? listed.messages : [])
    .filter(isPlainObject).slice(0, limit);
  const details = await Promise.all(messages.map((message) => composioProxy(
    env, connectedAccountId,
    `/gmail/v1/users/me/messages/${encodeURIComponent(String(message.id || ""))}`,
    [{ name: "format", value: "metadata", in: "query" }],
  )));
  return details.map((message): MailboxConversation => {
    const sender = mailboxSender(gmailHeader(message, "From"));
    const internalDate = Number(message.internalDate);
    const labelIds = Array.isArray(message.labelIds) ? message.labelIds.map(String) : [];
    return {
      id: String(message.threadId || message.id || "").slice(0, 500),
      subject: (gmailHeader(message, "Subject") || "(no subject)").slice(0, 500),
      sender_name: sender.name, sender_email: sender.email,
      received_at: Number.isFinite(internalDate) ? new Date(internalDate).toISOString() : null,
      snippet: String(message.snippet || "").replace(/\s+/g, " ").trim().slice(0, 280),
      unread: labelIds.includes("UNREAD"),
    };
  }).filter((conversation) => conversation.id);
}

async function bestEffortComposioRevoke(env: FrameworkEnv, connectedAccountId: string) {
  try {
    await composioRequest(env,
      `/api/v3.1/connected_accounts/${encodeURIComponent(connectedAccountId)}/revoke`,
      { method: "POST", body: "{}" });
    return true;
  } catch {
    return false;
  }
}

function composioToolkitSlug(body: Json) {
  const toolkit = isPlainObject(body.toolkit) ? body.toolkit : null;
  const candidate = toolkit?.slug ?? toolkit?.name ?? body.toolkit_slug ?? body.toolkit;
  return typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
}

function safeComposioRedirect(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
      !(url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"))) return null;
    return url.toString();
  } catch {
    return null;
  }
}
function crmMailboxStateToken(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type VisitorProvider = "audiencelab" | "rb2b";
type NormalizedVisitorEvent = {
  identityKey: string; identityKind: "person" | "company"; dedupeKey: string;
  email: string | null; firstName: string | null; lastName: string | null;
  linkedinUrl: string | null; title: string | null; companyName: string | null;
  companyDomain: string | null; industry: string | null; employeeCount: string | null;
  estimatedRevenue: string | null; city: string | null; region: string | null; postalCode: string | null;
  occurredAt: string; capturedUrl: string | null; referrer: string | null; tags: string[];
  isRepeat: boolean; isHighIntent: boolean; consentStatus: "unknown" | "granted" | "denied";
};

function visitorString(source: Json, names: string[], maximum = 500) {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, maximum);
    if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, maximum);
  }
  return null;
}

function visitorStringAcross(sources: Json[], names: string[], maximum = 500) {
  for (const source of sources) {
    const value = visitorString(source, names, maximum);
    if (value) return value;
  }
  return null;
}

function visitorEmailAcross(sources: Json[], names: string[]) {
  for (const source of sources) {
    for (const name of names) {
      const raw = source[name];
      const candidates = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
      for (const candidate of candidates) {
        const email = normalizeEmail(candidate);
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
      }
    }
  }
  return null;
}

function visitorEventHistory(sources: Json[]) {
  for (const source of sources) {
    const raw = source.Events ?? source.events;
    let events: unknown = raw;
    if (typeof raw === "string") {
      try { events = JSON.parse(raw); } catch { events = []; }
    }
    if (!Array.isArray(events)) continue;
    const normalized = events.slice(-1000).filter(isPlainObject) as Json[];
    if (!normalized.length) continue;
    const eventTime = (event: Json) => {
      const parsed = Date.parse(String(event.received_at || event.timestamp || event.occurred_at || ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const latest = [...normalized].sort((left, right) => {
      const timeDifference = eventTime(right) - eventTime(left);
      if (timeDifference) return timeDifference;
      return String(right.message_id || right.event_id || right.id || "")
        .localeCompare(String(left.message_id || left.event_id || left.id || ""));
    })[0];
    const properties = isPlainObject(latest.properties) ? latest.properties as Json : {};
    return {
      eventId: visitorString(latest, ["message_id", "event_id", "id"], 255),
      occurredAt: visitorString(latest, ["received_at", "timestamp", "occurred_at"], 60),
      url: visitorString(properties, ["url", "page_url", "full_url"], 2048),
    };
  }
  return { eventId: null, occurredAt: null, url: null };
}

function visitorUrl(value: string | null, field: string) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || value.length > 2048) throw new Error();
    parsed.hash = "";
    return parsed.toString();
  } catch {
    throw new ApiError(400, `${field} must be an HTTP or HTTPS URL`);
  }
}

function visitorTags(value: unknown) {
  const candidates = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(candidates.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase().slice(0, 80)).filter(Boolean))].slice(0, 20);
}

function visitorCompanyDomain(value: string | null, website: string | null) {
  const candidate = value || website;
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    const labels = hostname.split(".");
    if (hostname.length > 253 || labels.length < 2 || hostname.includes(":") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
      labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      throw new Error();
    }
    return hostname;
  } catch {
    throw new ApiError(400, "Visitor company domain must be a valid DNS hostname");
  }
}

function visitorConsent(source: Json, fallback: string): "unknown" | "granted" | "denied" {
  const value = source.consent_status ?? source.consent ?? source.has_consent;
  if (value === true || ["granted", "accepted", "true"].includes(String(value).toLowerCase())) return "granted";
  if (value === false || ["denied", "rejected", "false"].includes(String(value).toLowerCase())) return "denied";
  return fallback === "granted" || fallback === "denied" ? fallback : "unknown";
}

async function normalizeVisitorEvent(provider: VisitorProvider, body: Json, consentDefault: string): Promise<NormalizedVisitorEvent> {
  const nested = isPlainObject(body.data) ? body.data : isPlainObject(body.event) && isPlainObject(body.event.data)
    ? body.event.data : body;
  const source = nested as Json;
  const resolution = isPlainObject(source.resolution) ? source.resolution as Json
    : isPlainObject(body.resolution) ? body.resolution as Json : {};
  const traits = isPlainObject(resolution.traits) ? resolution.traits as Json : {};
  const eventData = isPlainObject(source.event_data) ? source.event_data as Json
    : isPlainObject(body.event_data) ? body.event_data as Json : {};
  const sources = [source, body, resolution, traits, eventData];
  const eventHistory = visitorEventHistory(sources);
  const email = visitorEmailAcross(sources, provider === "rb2b"
    ? ["Business Email", "Business Verified Emails", "business_email", "email", "EMAIL"]
    : ["Business Verified Emails", "Business Email", "business_email", "email", "EMAIL",
      "Personal Verified Emails", "Personal Emails", "PERSONAL_EMAILS"]) || null;
  const linkedinUrl = visitorUrl(visitorStringAcross(sources,
    ["LinkedIn URL", "Individual Linkedin Url", "individual_linkedin_url", "linkedin_url", "linkedin", "LINKEDIN_URL"], 2048), "linkedin_url");
  const website = visitorUrl(visitorStringAcross(sources,
    ["Website", "website", "company_website", "COMPANY_WEBSITE", "Company Website"], 2048), "website");
  const capturedUrl = visitorUrl(eventHistory.url || visitorStringAcross(sources,
    ["Captured URL", "Full Url", "full_url", "captured_url", "page_url", "url", "landing_page", "PAGE_URL"], 2048),
  "captured_url");
  const referrer = visitorUrl(visitorStringAcross(sources,
    ["Referrer", "Referrer Url", "referrer_url", "referrer", "referring_url", "REFERRER"], 2048), "referrer");
  const companyName = visitorStringAcross(sources, ["Company Name", "company_name", "company", "COMPANY"], 200);
  const companyDomain = visitorCompanyDomain(
    visitorStringAcross(sources, ["Company Domain", "company_domain", "domain", "COMPANY_DOMAIN"], 255),
    website,
  );
  const externalIdentity = visitorStringAcross(sources,
    ["Uuid", "uuid", "Edid", "edid", "profile_id", "universal_id", "cookie_id", "maid_id",
      "external_id", "id", "PROFILE_ID", "Hem Sha256", "hem_sha256"], 255);
  const identitySeed = linkedinUrl?.toLowerCase() || email || companyDomain || companyName?.toLowerCase() || externalIdentity;
  if (!identitySeed) throw new ApiError(400, "Visitor payload has no stable person or company identity");
  const identityKind: "person" | "company" = linkedinUrl || email ? "person" : "company";
  const occurredRaw = eventHistory.occurredAt || visitorStringAcross(sources,
    ["Event Timestamp", "event_timestamp", "Seen At", "seen_at", "occurred_at", "timestamp",
      "created_at", "Inserted At", "inserted_at", "TIMESTAMP"], 60);
  const occurredMs = occurredRaw ? Date.parse(occurredRaw) : Date.now();
  if (!Number.isFinite(occurredMs) || occurredMs < Date.parse("2000-01-01T00:00:00.000Z") ||
    occurredMs > Date.now() + 86_400_000) throw new ApiError(400, "Visitor event timestamp is invalid");
  const occurredAt = new Date(occurredMs).toISOString();
  const tagSource = sources.find((candidate) => candidate.Tags !== undefined ||
    candidate.tags !== undefined || candidate.TAGS !== undefined) || source;
  const tags = visitorTags(tagSource.Tags ?? tagSource.tags ?? tagSource.TAGS);
  const repeatSource = sources.find((candidate) => candidate.is_repeat_visit !== undefined ||
    candidate.is_repeat_visitor !== undefined || candidate.repeat_visit !== undefined) || source;
  const repeatValue = repeatSource.is_repeat_visit ?? repeatSource.is_repeat_visitor ?? repeatSource.repeat_visit;
  const isRepeat = repeatValue === true || String(repeatValue).toLowerCase() === "true";
  const highIntentTerms = new Set(["hot page", "hot pages", "hot lead", "high intent", "pricing", "demo", "contact"]);
  const highIntentPath = capturedUrl ? new URL(capturedUrl).pathname.toLowerCase() : "";
  const isHighIntent = tags.some((tag) => highIntentTerms.has(tag)) ||
    /(?:^|\/)(pricing|demo|book|contact|checkout)(?:\/|$)/.test(highIntentPath);
  const identityKey = await sha256(`${provider}\n${identityKind}\n${identitySeed}`);
  const providedEventId = visitorStringAcross(sources,
    ["event_id", "transaction_id", "visit_id", "EVENT_ID"], 255) || eventHistory.eventId;
  const dedupeKey = providedEventId
    ? await sha256(`${provider}\nexternal\n${providedEventId}`)
    : await sha256(`${provider}\n${identityKey}\n${occurredAt}\n${capturedUrl || ""}\n${isRepeat}`);
  return {
    identityKey, identityKind, dedupeKey, email,
    firstName: visitorStringAcross(sources, ["First Name", "first_name", "FIRST_NAME"], 100),
    lastName: visitorStringAcross(sources, ["Last Name", "last_name", "LAST_NAME"], 100),
    linkedinUrl, title: visitorStringAcross(sources, ["Job Title", "Title", "title", "job_title", "JOB_TITLE"], 240),
    companyName, companyDomain,
    industry: visitorStringAcross(sources, ["Company Industry", "Industry", "industry", "COMPANY_INDUSTRY"], 160),
    employeeCount: visitorStringAcross(sources, ["Company Employee Count", "Employee Count", "employee_count", "employees"], 60),
    estimatedRevenue: visitorStringAcross(sources, ["Company Revenue", "Estimate Revenue", "estimated_revenue", "revenue"], 80),
    city: visitorStringAcross(sources, ["Company City", "Personal City", "City", "city"], 120),
    region: visitorStringAcross(sources, ["Company State", "Personal State", "State", "state", "region"], 120),
    postalCode: visitorStringAcross(sources, ["Company Zip", "Personal Zip", "Zipcode", "zipcode", "postal_code"], 40),
    occurredAt, capturedUrl, referrer, tags, isRepeat, isHighIntent,
    consentStatus: visitorConsent(sources.find((candidate) =>
      candidate.consent_status !== undefined || candidate.consent !== undefined ||
      candidate.has_consent !== undefined) || source, consentDefault),
  };
}

type ImportContact = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  company: string | null;
  owner: string | null;
  custom_fields: string;
};

type AudienceImportRow = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  linkedinUrl: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  industry: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  consentStatus: "unknown" | "granted" | "denied";
};

function normalizeAudienceImport(body: Json) {
  const connectorId = optionalString(body.connector_id, "connector_id", 80);
  const externalKey = optionalString(body.external_key, "external_key", 200);
  const listName = optionalString(body.list_name, "list_name", 160);
  const mode = optionalString(body.mode, "mode", 30) || "interactive";
  const consentBasis = optionalString(body.consent_basis, "consent_basis", 20) || "unknown";
  const tags = visitorTags(body.tags);
  if (!connectorId || !/^vconn_[a-f0-9]{32}$/.test(connectorId)) throw new ApiError(400, "connector_id is invalid");
  if (!externalKey) throw new ApiError(400, "external_key is required");
  if (!listName) throw new ApiError(400, "list_name is required");
  if (!["interactive", "full_refresh", "incremental"].includes(mode)) throw new ApiError(400, "mode is invalid");
  if (!["unknown", "granted", "denied"].includes(consentBasis)) throw new ApiError(400, "consent_basis is invalid");
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_IMPORT_ROWS) {
    throw new ApiError(400, `Import must contain between 1 and ${MAX_IMPORT_ROWS} rows`);
  }
  const seen = new Set<string>();
  const rows = body.rows.map((value, index): AudienceImportRow => {
    if (!isPlainObject(value)) throw new ApiError(400, `Row ${index + 1} must be an object`);
    const email = normalizeEmail(value.email) || null;
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
      throw new ApiError(400, `Row ${index + 1} has an invalid email`);
    }
    const linkedinUrl = visitorUrl(optionalString(value.linkedin_url, `rows[${index}].linkedin_url`, 2048), "linkedin_url");
    const companyDomain = visitorCompanyDomain(
      optionalString(value.company_domain, `rows[${index}].company_domain`, 255),
      optionalString(value.company_website, `rows[${index}].company_website`, 2048),
    );
    const identitySeed = email || linkedinUrl?.toLowerCase() || companyDomain;
    if (!identitySeed) throw new ApiError(400, `Row ${index + 1} has no stable person or company identity`);
    const rowDedupe = `${email ? "person" : linkedinUrl ? "person-linkedin" : "company"}:${identitySeed}`;
    if (seen.has(rowDedupe)) throw new ApiError(400, `Row ${index + 1} duplicates another row`);
    seen.add(rowDedupe);
    const rowConsent = optionalString(value.consent_status, `rows[${index}].consent_status`, 20) || consentBasis;
    if (!["unknown", "granted", "denied"].includes(rowConsent)) {
      throw new ApiError(400, `Row ${index + 1} has invalid consent_status`);
    }
    return {
      email,
      firstName: optionalString(value.first_name, `rows[${index}].first_name`, 100),
      lastName: optionalString(value.last_name, `rows[${index}].last_name`, 100),
      linkedinUrl,
      title: optionalString(value.title, `rows[${index}].title`, 240),
      companyName: optionalString(value.company_name ?? value.company, `rows[${index}].company_name`, 200),
      companyDomain,
      industry: optionalString(value.industry, `rows[${index}].industry`, 160),
      city: optionalString(value.city, `rows[${index}].city`, 120),
      region: optionalString(value.region, `rows[${index}].region`, 120),
      postalCode: optionalString(value.postal_code, `rows[${index}].postal_code`, 40),
      consentStatus: rowConsent as AudienceImportRow["consentStatus"],
    };
  });
  return { connectorId, externalKey, listName, mode, consentBasis, tags, rows };
}

function importedCustomFieldValue(definition: CustomFieldDefinition, value: unknown, rowNumber: number) {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (definition.field_type === "number") {
      const parsed = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").trim());
      return customFieldValue(definition, parsed);
    }
    if (definition.field_type === "boolean" && typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(normalized)) return customFieldValue(definition, true);
      if (["false", "no", "0"].includes(normalized)) return customFieldValue(definition, false);
    }
    return customFieldValue(definition, value);
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError(400, `Row ${rowNumber}: ${error.message}`);
    throw error;
  }
}

async function normalizeImportRows(env: FrameworkEnv, workspaceId: string, body: Json): Promise<ImportContact[]> {
  if (!Array.isArray(body.rows)) throw new ApiError(400, "rows must be an array");
  if (!body.rows.length || body.rows.length > MAX_IMPORT_ROWS) {
    throw new ApiError(400, `Import must contain between 1 and ${MAX_IMPORT_ROWS} rows`);
  }
  const definitions = await env.DB.prepare(`SELECT * FROM custom_field_definitions
    WHERE workspace_id=? AND object_type='contact' AND active=1 ORDER BY position,id`)
    .bind(workspaceId).all<CustomFieldDefinition>();
  const byKey = new Map(definitions.results.map((definition) => [definition.field_key, definition]));
  const seen = new Set<string>();
  return body.rows.map((value, index) => {
    if (!isPlainObject(value)) throw new ApiError(400, `Row ${index + 1} must be an object`);
    const email = normalizeEmail(value.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new ApiError(400, `Row ${index + 1} has an invalid email`);
    }
    if (seen.has(email)) throw new ApiError(400, `Duplicate email in import: ${email}`);
    seen.add(email);
    const owner = optionalString(value.owner, `rows[${index}].owner`, 254);
    if (owner && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) {
      throw new ApiError(400, `Row ${index + 1} has an invalid owner email`);
    }
    if (value.custom_fields !== undefined && !isPlainObject(value.custom_fields)) {
      throw new ApiError(400, `Row ${index + 1} custom_fields must be an object`);
    }
    const customFields: Json = {};
    for (const [fieldKey, fieldValue] of Object.entries(isPlainObject(value.custom_fields) ? value.custom_fields : {})) {
      const definition = byKey.get(fieldKey);
      if (!definition) throw new ApiError(400, `Row ${index + 1} references unknown or inactive custom field: ${fieldKey}`);
      const normalized = importedCustomFieldValue(definition, fieldValue, index + 1);
      if (normalized !== null) customFields[fieldKey] = normalized;
    }
    for (const definition of definitions.results.filter((item) => item.required)) {
      if (customFields[definition.field_key] === undefined) {
        throw new ApiError(400, `Row ${index + 1}: ${definition.label} is required`);
      }
    }
    return {
      email,
      first_name: optionalString(value.first_name, `rows[${index}].first_name`, 100),
      last_name: optionalString(value.last_name, `rows[${index}].last_name`, 100),
      phone: optionalString(value.phone, `rows[${index}].phone`, 50),
      company: optionalString(value.company, `rows[${index}].company`, 200),
      owner,
      custom_fields: JSON.stringify(customFields),
    };
  });
}
function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

type CustomFieldType = "text" | "number" | "boolean" | "date" | "select";
type CustomFieldObject = "contact" | "company" | "opportunity";
type CustomFieldDefinition = {
  id: string; workspace_id: string; object_type: CustomFieldObject; field_key: string; label: string;
  field_type: CustomFieldType; options: string; required: number; active: number;
  position: number; revision: number; change_id: string; created_by: string; created_at: string; updated_at: string;
};
type PageLayoutSection = { id: string; title: string; fields: string[] };
type ObjectPageLayout = {
  id: string; workspace_id: string; object_type: CustomFieldObject; name: string; sections: string;
  revision: number; change_id: string; created_by: string; created_at: string; updated_at: string;
};
const customFieldTypes = new Set<CustomFieldType>(["text", "number", "boolean", "date", "select"]);
function parsePageLayoutSections(value: unknown, allowedKeys?: Set<string>, requireComplete = false): PageLayoutSection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new ApiError(400, "Layout requires 1-8 sections");
  const sectionIds = new Set<string>();
  const fieldKeys = new Set<string>();
  const sections = value.map((raw, index) => {
    if (!isPlainObject(raw)) throw new ApiError(400, `Layout section ${index + 1} is invalid`);
    const sectionId = optionalString(raw.id, `sections[${index}].id`, 40);
    const title = optionalString(raw.title, `sections[${index}].title`, 80);
    if (!sectionId || !/^[a-z][a-z0-9_-]{1,39}$/.test(sectionId) || sectionIds.has(sectionId) || !title) {
      throw new ApiError(400, `Layout section ${index + 1} requires a unique id and title`);
    }
    if (!Array.isArray(raw.fields)) throw new ApiError(400, `Layout section ${index + 1} fields are invalid`);
    const fields = raw.fields.map((field) => {
      if (typeof field !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(field) ||
        fieldKeys.has(field) || (allowedKeys && !allowedKeys.has(field))) {
        throw new ApiError(400, `Layout contains an unknown or duplicate field`);
      }
      fieldKeys.add(field);
      return field;
    });
    sectionIds.add(sectionId);
    return { id: sectionId, title, fields };
  });
  if (fieldKeys.size > 50) throw new ApiError(400, "Layout contains too many fields");
  if (requireComplete && allowedKeys && (fieldKeys.size !== allowedKeys.size ||
    [...allowedKeys].some((key) => !fieldKeys.has(key)))) {
    throw new ApiError(400, "Layout must place every active custom field exactly once");
  }
  return sections;
}
async function effectivePageLayout(env: FrameworkEnv, workspaceId: string, objectType: CustomFieldObject) {
  const [stored, definitions] = await Promise.all([
    env.DB.prepare("SELECT * FROM object_page_layouts WHERE workspace_id=? AND object_type=?")
      .bind(workspaceId, objectType).first<ObjectPageLayout>(),
    env.DB.prepare(`SELECT field_key FROM custom_field_definitions
      WHERE workspace_id=? AND object_type=? AND active=1 ORDER BY position,id`)
      .bind(workspaceId, objectType).all<{ field_key: string }>(),
  ]);
  const activeKeys = definitions.results.map((definition) => definition.field_key);
  const activeSet = new Set(activeKeys);
  let sections: PageLayoutSection[] = [];
  let storedSectionsValid = false;
  if (stored) {
    try {
      sections = parsePageLayoutSections(JSON.parse(stored.sections))
        .map((section) => ({ ...section, fields: section.fields.filter((key) => activeSet.has(key)) }));
      storedSectionsValid = true;
    } catch {
      sections = [];
    }
  }
  if (!sections.length) sections = [{ id: "additional_details", title: "Additional details", fields: storedSectionsValid ? [] : activeKeys }];
  const placed = new Set(sections.flatMap((section) => section.fields));
  const unplaced = activeKeys.filter((key) => !placed.has(key));
  if (unplaced.length) sections.push({ id: "unplaced_fields", title: "Unplaced fields", fields: unplaced });
  return {
    id: stored?.id || null, object_type: objectType, name: stored?.name || "Default layout",
    sections, revision: stored?.revision || 0, change_id: stored?.change_id || null,
    updated_at: stored?.updated_at || null,
  };
}
function customFieldValue(definition: CustomFieldDefinition, value: unknown) {
  if (value === null || value === undefined || value === "") {
    if (definition.required) throw new ApiError(400, `${definition.label} is required`);
    return null;
  }
  if (definition.field_type === "text") {
    if (typeof value !== "string" || value.length > 1000) throw new ApiError(400, `${definition.label} must be text under 1,000 characters`);
    return value;
  }
  if (definition.field_type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError(400, `${definition.label} must be a number`);
    return value;
  }
  if (definition.field_type === "boolean") {
    if (typeof value !== "boolean") throw new ApiError(400, `${definition.label} must be true or false`);
    return value;
  }
  if (definition.field_type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new ApiError(400, `${definition.label} must be a valid date`);
    }
    return value;
  }
  const options = parseStringArray(definition.options);
  if (typeof value !== "string" || !options.includes(value)) throw new ApiError(400, `${definition.label} must use an allowed option`);
  return value;
}
async function mergeCustomFieldValues(
  env: FrameworkEnv,
  workspaceId: string,
  objectType: CustomFieldObject,
  stored: unknown,
  updates: unknown,
) {
  if (!isPlainObject(updates)) throw new ApiError(400, "custom_fields must be an object");
  let current: Json = {};
  try {
    const parsed = JSON.parse(String(stored || "{}"));
    if (isPlainObject(parsed)) current = parsed;
  } catch { throw new ApiError(500, "Stored custom metadata is invalid"); }
  const definitions = await env.DB.prepare(`SELECT * FROM custom_field_definitions
    WHERE workspace_id=? AND object_type=? AND active=1`).bind(workspaceId, objectType).all<CustomFieldDefinition>();
  const byKey = new Map(definitions.results.map((definition) => [definition.field_key, definition]));
  for (const [key, value] of Object.entries(updates)) {
    const definition = byKey.get(key);
    if (!definition) throw new ApiError(400, `Unknown or inactive custom field: ${key}`);
    const validated = customFieldValue(definition, value);
    if (validated === null) delete current[key];
    else current[key] = validated;
  }
  return JSON.stringify(current);
}
type CustomObjectField = {
  key: string; label: string; type: CustomFieldType; required: boolean; options: string[];
};
function parseCustomObjectFields(value: unknown): CustomObjectField[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new ApiError(400, "Custom objects require 1-20 fields");
  }
  const keys = new Set<string>();
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) throw new ApiError(400, `Field ${index + 1} is invalid`);
    const key = String(raw.key || "").trim().toLowerCase();
    const label = String(raw.label || "").trim();
    const type = String(raw.type || "") as CustomFieldType;
    const required = raw.required === true;
    const options = Array.isArray(raw.options) ? raw.options.map((item) => String(item).trim()) : [];
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key) || keys.has(key) || !label || label.length > 80 ||
      !customFieldTypes.has(type) || options.some((option) => !option || option.length > 80) ||
      options.length !== new Set(options).size || options.length > 50 ||
      (type === "select" && options.length < 1) || (type !== "select" && options.length)) {
      throw new ApiError(400, `Field ${index + 1} has an invalid key, label, type, or options`);
    }
    keys.add(key);
    return { key, label, type, required, options };
  });
}
function customObjectRecordData(fields: CustomObjectField[], value: unknown) {
  if (!isPlainObject(value)) throw new ApiError(400, "data must be an object");
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(value)) {
    if (!byKey.has(key)) throw new ApiError(400, `Unknown custom-object field: ${key}`);
  }
  const output: Json = {};
  for (const field of fields) {
    const raw = value[field.key];
    if (raw === undefined || raw === null || raw === "") {
      if (field.required) throw new ApiError(400, `${field.label} is required`);
      continue;
    }
    const validated = customFieldValue({
      field_key: field.key, label: field.label, field_type: field.type,
      options: JSON.stringify(field.options), required: field.required ? 1 : 0,
    } as CustomFieldDefinition, raw);
    if (validated !== null) output[field.key] = validated;
  }
  return output;
}
type CustomObjectViewFilter = {
  field_key: string; operator: "equals" | "contains" | "gte" | "lte" | "before" | "after" | "is_empty";
  value?: string | number | boolean;
};
type CustomObjectViewDefinition = {
  name: string; visibility: "private" | "workspace"; filters: CustomObjectViewFilter[];
  visible_fields: string[]; sort_field: string; sort_direction: "asc" | "desc";
};
function validateCustomObjectView(body: Json, fields: CustomObjectField[], partial = false) {
  const result: Partial<CustomObjectViewDefinition> = {};
  const byKey = new Map(fields.map((field) => [field.key, field]));
  if (!partial || body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name || name.length > 100) throw new ApiError(400, "View name is required and cannot exceed 100 characters");
    result.name = name;
  }
  if (!partial || body.visibility !== undefined) {
    const visibility = body.visibility === undefined ? "private" : String(body.visibility);
    if (!["private", "workspace"].includes(visibility)) throw new ApiError(400, "View visibility must be private or workspace");
    result.visibility = visibility as CustomObjectViewDefinition["visibility"];
  }
  if (!partial || body.filters !== undefined) {
    if (!Array.isArray(body.filters) || body.filters.length > 5) throw new ApiError(400, "Views support 0-5 filters");
    const seen = new Set<string>();
    result.filters = body.filters.map((raw, index) => {
      if (!isPlainObject(raw) || Object.keys(raw).some((key) => !["field_key", "operator", "value"].includes(key))) {
        throw new ApiError(400, `View filter ${index + 1} is invalid`);
      }
      const fieldKey = String(raw.field_key || "");
      const operator = String(raw.operator || "") as CustomObjectViewFilter["operator"];
      const field = byKey.get(fieldKey);
      if (!field || seen.has(fieldKey)) throw new ApiError(400, "View filters require unique active fields");
      const operators: Record<CustomFieldType, Set<string>> = {
        text: new Set(["equals", "contains", "is_empty"]),
        select: new Set(["equals", "is_empty"]),
        number: new Set(["equals", "gte", "lte", "is_empty"]),
        boolean: new Set(["equals", "is_empty"]),
        date: new Set(["equals", "before", "after", "is_empty"]),
      };
      if (!operators[field.type].has(operator)) throw new ApiError(400, `Unsupported operator for ${field.label}`);
      seen.add(fieldKey);
      if (operator === "is_empty") {
        if (raw.value !== undefined && raw.value !== null && raw.value !== "") {
          throw new ApiError(400, "Empty filters cannot include a value");
        }
        return { field_key: fieldKey, operator };
      }
      const value = customFieldValue({
        field_key: field.key, label: field.label, field_type: field.type,
        options: JSON.stringify(field.options), required: field.required ? 1 : 0,
      } as CustomFieldDefinition, raw.value);
      if (value === null) throw new ApiError(400, `${field.label} requires a filter value`);
      return { field_key: fieldKey, operator, value } as CustomObjectViewFilter;
    });
  }
  if (!partial || body.visible_fields !== undefined) {
    const visible = body.visible_fields === undefined ? ["display_name", ...fields.slice(0, 4).map((field) => field.key)]
      : body.visible_fields;
    if (!Array.isArray(visible) || visible.length < 1 || visible.length > 12 ||
      visible[0] !== "display_name" || new Set(visible).size !== visible.length ||
      visible.some((key) => typeof key !== "string" || (key !== "display_name" && !byKey.has(key)))) {
      throw new ApiError(400, "Visible fields must be unique, start with record name, and contain active fields");
    }
    result.visible_fields = visible as string[];
  }
  if (!partial || body.sort_field !== undefined) {
    const sortField = body.sort_field === undefined ? "display_name" : String(body.sort_field);
    if (!["display_name", "updated_at", ...byKey.keys()].includes(sortField)) throw new ApiError(400, "View sort field is invalid");
    result.sort_field = sortField;
  }
  if (!partial || body.sort_direction !== undefined) {
    const direction = body.sort_direction === undefined ? "asc" : String(body.sort_direction);
    if (!["asc", "desc"].includes(direction)) throw new ApiError(400, "View sort direction is invalid");
    result.sort_direction = direction as "asc" | "desc";
  }
  return result;
}
function customObjectViewPayload(row: Record<string, unknown>, fields: CustomObjectField[]) {
  const definition = validateCustomObjectView({
    name: row.name,
    visibility: row.visibility,
    filters: JSON.parse(String(row.filters)),
    visible_fields: JSON.parse(String(row.visible_fields)),
    sort_field: row.sort_field,
    sort_direction: row.sort_direction,
  }, fields) as CustomObjectViewDefinition;
  return { ...row, ...definition };
}
type WorkspaceOperation = "revenue_analysis" | "workspace_restore";
type WorkspaceOperationLease = {
  operation: WorkspaceOperation;
  owner_id: string;
  lease_until: string;
};
async function acquireWorkspaceOperationLease(
  env: FrameworkEnv,
  workspaceId: string,
  operation: WorkspaceOperation,
  ownerId: string,
  startedAt: string,
  ttlMs = 10 * 60_000,
) {
  const leaseUntil = new Date(Date.parse(startedAt) + ttlMs).toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO workspace_operation_leases
    (workspace_id,operation,owner_id,lease_until,acquired_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(workspaceId, operation, ownerId, leaseUntil, startedAt, startedAt).run();
  const insertedLease = await env.DB.prepare(`SELECT operation,owner_id,lease_until
    FROM workspace_operation_leases WHERE workspace_id=?`).bind(workspaceId).first<WorkspaceOperationLease>();
  if (insertedLease?.owner_id !== ownerId || insertedLease.operation !== operation) {
    await env.DB.prepare(`UPDATE workspace_operation_leases
      SET operation=?,owner_id=?,lease_until=?,acquired_at=?,updated_at=?
      WHERE workspace_id=? AND lease_until<=?`)
      .bind(operation, ownerId, leaseUntil, startedAt, startedAt, workspaceId, startedAt).run();
  }
  const stored = await env.DB.prepare(`SELECT operation,owner_id,lease_until
    FROM workspace_operation_leases WHERE workspace_id=?`).bind(workspaceId).first<WorkspaceOperationLease>();
  const acquired = stored?.owner_id === ownerId && stored.operation === operation;
  const active = acquired ? null : stored;
  const activeLeaseTime = Date.parse(active?.lease_until || "");
  return {
    acquired,
    active,
    retryAfter: Number.isFinite(activeLeaseTime)
      ? Math.max(1, Math.min(600, Math.ceil((activeLeaseTime - Date.parse(startedAt)) / 1000)))
      : 60,
  };
}
async function releaseWorkspaceOperationLease(env: FrameworkEnv, workspaceId: string, ownerId: string) {
  await env.DB.prepare("DELETE FROM workspace_operation_leases WHERE workspace_id=? AND owner_id=?")
    .bind(workspaceId, ownerId).run();
}
function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: string) { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
function mailboxAuthConfigId(env: FrameworkEnv, provider: string) {
  return provider === "gmail" ? env.COMPOSIO_GMAIL_AUTH_CONFIG_ID
    : provider === "outlook" ? env.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID : undefined;
}
function companyNameKey(value: string) { return value.trim().toLowerCase(); }
function companyCompactNameKey(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function companyDomainKey(company: Record<string, unknown>) {
  const domain = String(company.domain || "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (domain) return domain;
  try { return new URL(String(company.website || "")).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
function companyNameTokens(value: unknown) {
  const legalSuffixes = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "company", "co", "plc", "gmbh"]);
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !legalSuffixes.has(token));
}
function companyDuplicateScore(left: Record<string, unknown>, right: Record<string, unknown>) {
  let score = 0;
  const reasons: Array<{ code: string; label: string; weight: number }> = [];
  const add = (code: string, label: string, weight: number) => { score += weight; reasons.push({ code, label, weight }); };
  const leftDomain = companyDomainKey(left);
  const rightDomain = companyDomainKey(right);
  if (leftDomain && leftDomain === rightDomain) add("same_domain", `Same domain: ${leftDomain}`, 55);
  const leftName = companyNameKey(String(left.name || ""));
  const rightName = companyNameKey(String(right.name || ""));
  const leftCompactName = companyCompactNameKey(left.name);
  const rightCompactName = companyCompactNameKey(right.name);
  if (leftName && leftName === rightName) add("same_name", "Exact normalized company name", 50);
  else if (leftCompactName.length >= 4 && leftCompactName === rightCompactName) {
    add("same_compact_name", "Same company name after spacing and punctuation", 45);
  }
  else {
    const leftTokens = companyNameTokens(left.name);
    const rightTokens = companyNameTokens(right.name);
    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
    const union = new Set([...leftTokens, ...rightTokens]).size;
    const similarity = union ? intersection / union : 0;
    if (similarity === 1 && leftTokens.length && rightTokens.length) add("same_name_root", "Same name after legal suffixes", 40);
    else if (similarity >= 0.75) add("strong_name_overlap", `${Math.round(similarity * 100)}% name-token overlap`, 30);
    else if (similarity >= 0.5) add("possible_name_overlap", `${Math.round(similarity * 100)}% name-token overlap`, 20);
  }
  if (left.owner && left.owner === right.owner) add("same_owner", "Same account owner", 5);
  return { score: Math.min(100, score), reasons };
}
function visitorAccountScoreReasons(row: Record<string, unknown>) {
  const reasons: Array<{ code: string; label: string; points: number }> = [];
  const add = (code: string, label: string, points: number) => { if (points > 0) reasons.push({ code, label, points }); };
  add("high_intent", `${Number(row.high_intent_count || 0)} high-intent visit(s)`, Math.min(Number(row.high_intent_count || 0), 3) * 12);
  add("repeat_visits", `${Number(row.repeat_visits || 0)} repeat visit(s)`, Math.min(Number(row.repeat_visits || 0), 4) * 5);
  add("visit_depth", `${Number(row.visit_count || 0)} total visit(s)`, Math.min(Number(row.visit_count || 0), 10));
  add("buying_group", `${Number(row.people_count || 0)} identified person profile(s)`, Math.min(Number(row.people_count || 0), 3) * 8);
  add("known_relationship", "Known CRM relationship", Number(row.known_contact_count || 0) > 0 ? 10 : 0);
  add("open_pipeline", "Open opportunity already exists", Number(row.open_opportunity_count || 0) > 0 ? 10 : 0);
  const recencyPoints = Number(row.recency_points || 0);
  add("recency", recencyPoints === 10 ? "Seen in the last 7 days" : "Seen in the last 30 days", recencyPoints);
  return reasons;
}
async function loadVisitorAccountEvidence(
  env: FrameworkEnv,
  workspaceId: string,
  companyDomain: string,
): Promise<Record<string, unknown> | null> {
  const [signal, relationship, touches] = await Promise.all([
    env.DB.prepare(`SELECT LOWER(TRIM(company_domain)) company_domain,
      COALESCE(MAX(NULLIF(TRIM(company_name),'')),LOWER(TRIM(company_domain))) company_name,
      COUNT(*) profile_count,SUM(CASE WHEN identity_kind='person' THEN 1 ELSE 0 END) people_count,
      SUM(visit_count) visit_count,SUM(high_intent_count) high_intent_count,
      SUM((SELECT COUNT(*) FROM visitor_events e WHERE e.workspace_id=p.workspace_id
        AND e.profile_id=p.id AND e.is_repeat=1)) repeat_visits,
      SUM(CASE WHEN matched_contact_id IS NOT NULL THEN 1 ELSE 0 END) known_contact_count,
      SUM(CASE WHEN consent_status='granted' THEN 1 ELSE 0 END) consent_granted_count,
      SUM(CASE WHEN consent_status='denied' THEN 1 ELSE 0 END) consent_denied_count,
      MIN(first_seen_at) first_seen_at,MAX(last_seen_at) last_seen_at,MAX(updated_at) evidence_updated_at
      FROM visitor_profiles p WHERE workspace_id=? AND LOWER(TRIM(company_domain))=?
        AND review_status IN ('new','reviewed') GROUP BY LOWER(TRIM(company_domain))`)
      .bind(workspaceId, companyDomain).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT
      (SELECT c.id FROM companies c WHERE c.workspace_id=? AND
        LOWER(TRIM(COALESCE(c.domain,'')))=? ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) crm_company_id,
      (SELECT c.name FROM companies c WHERE c.workspace_id=? AND
        LOWER(TRIM(COALESCE(c.domain,'')))=? ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) crm_company_name,
      (SELECT COUNT(*) FROM opportunities o JOIN contacts ct ON ct.workspace_id=o.workspace_id AND ct.id=o.contact_id
        LEFT JOIN companies c ON c.workspace_id=ct.workspace_id AND c.id=ct.company_id
        WHERE o.workspace_id=? AND o.status='open' AND LOWER(TRIM(COALESCE(c.domain,'')))=?) open_opportunity_count,
      (SELECT COALESCE(SUM(o.value),0) FROM opportunities o
        JOIN contacts ct ON ct.workspace_id=o.workspace_id AND ct.id=o.contact_id
        LEFT JOIN companies c ON c.workspace_id=ct.workspace_id AND c.id=ct.company_id
        WHERE o.workspace_id=? AND o.status='open' AND LOWER(TRIM(COALESCE(c.domain,'')))=?) open_pipeline_value`)
      .bind(workspaceId, companyDomain, workspaceId, companyDomain, workspaceId, companyDomain, workspaceId, companyDomain)
      .first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT e.captured_url,e.referrer,e.occurred_at,c.name connector_name,c.provider
      FROM visitor_events e
      JOIN visitor_profiles p ON p.workspace_id=e.workspace_id AND p.id=e.profile_id
      JOIN visitor_connectors c ON c.workspace_id=e.workspace_id AND c.id=e.connector_id
      WHERE e.workspace_id=? AND LOWER(TRIM(p.company_domain))=?
      ORDER BY e.occurred_at ASC,e.id ASC LIMIT 50`)
      .bind(workspaceId, companyDomain).all<Record<string, unknown>>(),
  ]);
  if (!signal) return null;
  const lastSeen = String(signal.last_seen_at || "");
  const age = Date.now() - Date.parse(lastSeen);
  const recencyPoints = age <= 7 * 86400000 ? 10 : age <= 30 * 86400000 ? 5 : 0;
  const evidence = { ...signal, ...relationship, recency_points: recencyPoints };
  const score = Math.min(100,
    Math.min(Number(signal.high_intent_count || 0), 3) * 12 +
    Math.min(Number(signal.repeat_visits || 0), 4) * 5 +
    Math.min(Number(signal.visit_count || 0), 10) +
    Math.min(Number(signal.people_count || 0), 3) * 8 +
    (Number(signal.known_contact_count || 0) > 0 ? 10 : 0) +
    (Number(relationship?.open_opportunity_count || 0) > 0 ? 10 : 0) + recencyPoints);
  const attributionTouches = touches.results.map((touch) => {
    const capturedUrl = touch.captured_url ? String(touch.captured_url) : null;
    let campaign: Record<string, string> = {};
    if (capturedUrl) {
      const parsed = new URL(capturedUrl);
      campaign = Object.fromEntries(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]
        .map((key) => [key, parsed.searchParams.get(key)?.slice(0, 200) || ""] as const)
        .filter(([, value]) => Boolean(value)));
    }
    return {
      connector: String(touch.connector_name), provider: String(touch.provider), occurred_at: String(touch.occurred_at),
      page_url: capturedUrl, referrer: touch.referrer ? String(touch.referrer) : null, campaign,
    };
  });
  const sourceNames = [...new Set(attributionTouches.map((touch) => touch.connector))];
  const pageUrls = [...new Set(attributionTouches.map((touch) => touch.page_url).filter(Boolean))].slice(-10);
  return {
    ...evidence, intent_score: score, score_reasons: visitorAccountScoreReasons(evidence),
    attribution: {
      first_touch: attributionTouches[0] || null,
      latest_touch: attributionTouches.at(-1) || null,
      contributing_sources: sourceNames,
      visited_pages: pageUrls,
      touch_count: attributionTouches.length,
    },
  };
}
async function companyMergeCounts(env: FrameworkEnv, workspaceId: string, companyId: string) {
  return env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM contacts WHERE workspace_id=? AND company_id=?) contacts,
    (SELECT COUNT(*) FROM company_notes WHERE workspace_id=? AND company_id=?) notes,
    (SELECT COUNT(*) FROM opportunities o JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
      WHERE o.workspace_id=? AND c.company_id=?) opportunities,
    (SELECT COUNT(*) FROM tasks t JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
      WHERE t.workspace_id=? AND c.company_id=?) tasks,
    (SELECT COUNT(*) FROM company_redirects WHERE workspace_id=? AND target_company_id=?) aliases`)
    .bind(workspaceId, companyId, workspaceId, companyId, workspaceId, companyId,
      workspaceId, companyId, workspaceId, companyId)
    .first<{ contacts: number; notes: number; opportunities: number; tasks: number; aliases: number }>();
}
async function companyMergeReviewToken(workspaceId: string, source: Record<string, unknown>, target: Record<string, unknown>,
  sourceCounts: Record<string, unknown>, targetCounts: Record<string, unknown>) {
  return sha256(JSON.stringify({
    contract: "company-merge-review:v1", workspace_id: workspaceId,
    source_id: source.id, source_updated_at: source.updated_at, source_counts: sourceCounts,
    target_id: target.id, target_updated_at: target.updated_at, target_counts: targetCounts,
  }));
}
async function companyIdentity(env: FrameworkEnv, workspaceId: string, name: string, now: string) {
  const nameKey = companyNameKey(name);
  const companyId = `cmp_${(await sha256(`${workspaceId}\n${nameKey}`)).slice(0, 32)}`;
  const canonical = await env.DB.prepare(`SELECT id,name,name_key FROM companies
    WHERE workspace_id=? AND id=? UNION ALL
    SELECT c.id,c.name,c.name_key FROM company_redirects r
    JOIN companies c ON c.workspace_id=r.workspace_id AND c.id=r.target_company_id
    WHERE r.workspace_id=? AND r.source_company_id=? LIMIT 1`).bind(workspaceId, companyId, workspaceId, companyId)
    .first<{ id: string; name: string; name_key: string }>();
  return canonical
    ? { id: canonical.id, name: canonical.name, nameKey: canonical.name_key, now }
    : { id: companyId, name: name.trim(), nameKey, now };
}
function insertCompanyStatement(env: FrameworkEnv, workspaceId: string, company: { id: string; name: string; nameKey: string; now: string }) {
  return env.DB.prepare(`INSERT OR IGNORE INTO companies
    (id,workspace_id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(company.id, workspaceId, company.name, company.nameKey, company.now, company.now);
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function webhookEncryptionKey(env: FrameworkEnv) {
  if (!env.WEBHOOK_ENCRYPTION_KEY || env.WEBHOOK_ENCRYPTION_KEY.length < 24) throw new Error("Webhook encryption is not configured");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(env.WEBHOOK_ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptSecret(env: FrameworkEnv, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await webhookEncryptionKey(env), encoder.encode(value));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}
async function decryptSecret(env: FrameworkEnv, value: string) {
  const [iv, ciphertext] = value.split(".");
  if (!iv || !ciphertext) throw new Error("Encrypted webhook secret is malformed");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await webhookEncryptionKey(env), base64ToBytes(ciphertext));
  return new TextDecoder().decode(plaintext);
}
function workspaceSecretAad(workspaceId: string, purpose: string, entityId: string) {
  return encoder.encode(`openoperator-secret:v1:${workspaceId}:${purpose}:${entityId}`);
}
async function encryptWorkspaceSecret(env: FrameworkEnv, workspaceId: string, purpose: string, entityId: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: workspaceSecretAad(workspaceId, purpose, entityId) },
    await webhookEncryptionKey(env), encoder.encode(value),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}
async function decryptWorkspaceSecret(env: FrameworkEnv, workspaceId: string, purpose: string, entityId: string, value: string) {
  const [iv, ciphertext] = value.split(".");
  if (!iv || !ciphertext) throw new Error("Encrypted workspace secret is malformed");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv), additionalData: workspaceSecretAad(workspaceId, purpose, entityId) },
    await webhookEncryptionKey(env), base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}
function safeResendConnection(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    id: row.id, label: row.label, api_key_prefix: row.api_key_prefix,
    from_email: row.from_email, from_name: row.from_name, reply_to: row.reply_to,
    status: row.status, last_verified_at: row.last_verified_at, last_error: row.last_error,
    revision: row.revision, change_id: row.change_id, created_at: row.created_at, updated_at: row.updated_at,
  };
}
function safeResendDelivery(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    id: row.id, connection_id: row.connection_id, idempotency_key: row.idempotency_key,
    recipient: row.recipient, subject: row.subject, body_excerpt: row.body_excerpt,
    provider_email_id: row.provider_email_id, status: row.status, response_status: row.response_status,
    error: row.error, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at,
  };
}
function safeCommunicationConsent(row: Record<string, unknown> | null) {
  if (!row) return { channel: "email", status: "unknown", basis: "unknown", evidence: null,
    captured_at: null, revision: 0, updated_at: null };
  return {
    id: row.id, contact_id: row.contact_id, channel: row.channel, status: row.status, basis: row.basis,
    evidence: row.evidence, captured_at: row.captured_at, revision: row.revision, updated_at: row.updated_at,
  };
}
function safeConversationThread(row: Record<string, unknown>) {
  return {
    id: row.id, contact_id: row.contact_id, channel: row.channel, participant_email: row.participant_email,
    subject: row.subject, status: row.status, last_message_at: row.last_message_at,
    unread_count: row.unread_count, revision: row.revision, contact_name: row.contact_name || null,
    consent: safeCommunicationConsent(row.consent_id ? {
      id: row.consent_id, contact_id: row.contact_id, channel: "email", status: row.consent_status,
      basis: row.consent_basis, evidence: row.consent_evidence, captured_at: row.consent_captured_at,
      revision: row.consent_revision, updated_at: row.consent_updated_at,
    } : null),
  };
}
function safeConversationMessage(row: Record<string, unknown>) {
  return {
    id: row.id, thread_id: row.thread_id, direction: row.direction, provider: row.provider,
    from_email: row.from_email, to_email: row.to_email, subject: row.subject, body_text: row.body_text,
    purpose: row.purpose, status: row.status, error: row.error, sent_by: row.sent_by,
    occurred_at: row.occurred_at,
  };
}
function resendErrorPayload(value: unknown, fallback: string) {
  if (!isPlainObject(value)) return fallback;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const candidate = name && message && message !== name ? `${name}: ${message}` : name || message;
  return candidate ? candidate.slice(0, 240) : fallback;
}
async function resendProviderSend(
  env: FrameworkEnv,
  connection: Record<string, unknown>,
  workspaceId: string,
  recipient: string,
  subject: string,
  text: string,
  idempotencyKey: string,
) {
  const apiKey = await decryptWorkspaceSecret(env, workspaceId, "resend", String(connection.id), String(connection.api_key_ciphertext));
  const fromEmail = String(connection.from_email);
  const fromName = typeof connection.from_name === "string" ? connection.from_name.trim() : "";
  const providerResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": `crm/${workspaceId}/${idempotencyKey}`,
      "user-agent": "OpenOperator-CRM/1.0",
    },
    body: JSON.stringify({
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: [recipient],
      subject,
      text,
      ...(connection.reply_to ? { reply_to: String(connection.reply_to) } : {}),
    }),
  });
  const responseText = (await providerResponse.text()).slice(0, 8_192);
  let responseBody: unknown = null;
  try { responseBody = responseText ? JSON.parse(responseText) : null; } catch {}
  if (!providerResponse.ok) {
    return {
      ok: false as const, status: providerResponse.status,
      error: resendErrorPayload(responseBody, `Resend returned HTTP ${providerResponse.status}`),
    };
  }
  const providerEmailId = isPlainObject(responseBody) && typeof responseBody.id === "string"
    && /^[A-Za-z0-9_-]{8,100}$/.test(responseBody.id) ? responseBody.id : null;
  if (!providerEmailId) return { ok: false as const, status: 502, error: "Resend returned an invalid email receipt" };
  return { ok: true as const, status: providerResponse.status, providerEmailId };
}
async function executeResendDelivery(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  connection: Record<string, unknown>,
  input: { recipient: string; subject: string; text: string; idempotencyKey: string },
  verification = false,
) {
  const requestHash = await sha256(JSON.stringify({
    contract: "resend-delivery:v1", connection_id: connection.id, connection_revision: connection.revision,
    recipient: input.recipient, subject: input.subject, text: input.text,
  }));
  const existing = await env.DB.prepare(`SELECT * FROM resend_deliveries
    WHERE workspace_id=? AND idempotency_key=?`).bind(access.workspaceId, input.idempotencyKey)
    .first<Record<string, unknown>>();
  if (existing) {
    if (existing.request_hash !== requestHash) return json({ error: "Idempotency key was already used for a different email" }, 409);
    if (existing.status === "succeeded") return json({ ok: true, replayed: true, delivery: safeResendDelivery(existing) });
    if (existing.status === "failed") return json({
      error: "This delivery already failed; retry with a new idempotency key", delivery: safeResendDelivery(existing),
    }, 409);
    const pendingAge = Date.now() - Date.parse(String(existing.updated_at));
    if (!Number.isFinite(pendingAge) || pendingAge < 10_000) return json({ error: "An email with this idempotency key is already processing" }, 409);
  } else {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const recent = await env.DB.prepare(`SELECT COUNT(*) total FROM resend_deliveries
      WHERE workspace_id=? AND created_at>=? AND status IN ('pending','succeeded')`)
      .bind(access.workspaceId, oneHourAgo).first<{ total: number }>();
    if (Number(recent?.total || 0) >= 50) return json({ error: "Workspace transactional email limit reached; try again later" }, 429);
    const deliveryId = id("rmail");
    const now = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO resend_deliveries
          (id,workspace_id,connection_id,idempotency_key,request_hash,recipient,subject,body_excerpt,status,
           created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)`)
          .bind(deliveryId, access.workspaceId, connection.id, input.idempotencyKey, requestHash,
            input.recipient, input.subject, input.text.slice(0, 300), access.email, now, now),
        await auditStatement(env, access, request, "resend.delivery_queued", "resend_delivery", deliveryId, null, {
          connection_id: connection.id, recipient: input.recipient, subject: input.subject, verification,
        }),
      ]);
    } catch {
      const raced = await env.DB.prepare(`SELECT * FROM resend_deliveries
        WHERE workspace_id=? AND idempotency_key=?`).bind(access.workspaceId, input.idempotencyKey)
        .first<Record<string, unknown>>();
      if (!raced || raced.request_hash !== requestHash) return json({ error: "Email idempotency conflict" }, 409);
      return json({ error: "An email with this idempotency key is already processing" }, 409);
    }
  }
  const delivery = await env.DB.prepare(`SELECT * FROM resend_deliveries
    WHERE workspace_id=? AND idempotency_key=?`).bind(access.workspaceId, input.idempotencyKey)
    .first<Record<string, unknown>>();
  if (!delivery) return json({ error: "Email delivery could not be initialized" }, 500);
  let provider: Awaited<ReturnType<typeof resendProviderSend>>;
  try {
    provider = await resendProviderSend(env, connection, access.workspaceId,
      input.recipient, input.subject, input.text, input.idempotencyKey);
  } catch {
    provider = { ok: false, status: 502, error: "Resend could not be reached" };
  }
  const completedAt = new Date().toISOString();
  if (!provider.ok) {
    const statements = [
      env.DB.prepare(`UPDATE resend_deliveries SET status='failed',response_status=?,error=?,updated_at=?
        WHERE id=? AND workspace_id=? AND status='pending'`)
        .bind(provider.status, provider.error, completedAt, delivery.id, access.workspaceId),
      await auditStatement(env, access, request, "resend.delivery_failed", "resend_delivery", String(delivery.id), null, {
        response_status: provider.status, error: provider.error, verification,
      }),
    ];
    if (verification) statements.push(env.DB.prepare(`UPDATE resend_connections
      SET status='error',last_error=?,revision=revision+1,change_id=?,updated_at=?
      WHERE id=? AND workspace_id=? AND status<>'revoked'`)
      .bind(provider.error, id("chg"), completedAt, connection.id, access.workspaceId));
    await env.DB.batch(statements);
    return json({ error: provider.error, code: "resend_provider_rejected" }, provider.status >= 400 && provider.status < 500 ? 422 : 502);
  }
  const statements = [
    env.DB.prepare(`UPDATE resend_deliveries SET status='succeeded',provider_email_id=?,response_status=?,error=NULL,updated_at=?
      WHERE id=? AND workspace_id=? AND status='pending'`)
      .bind(provider.providerEmailId, provider.status, completedAt, delivery.id, access.workspaceId),
    await auditStatement(env, access, request, "resend.delivery_succeeded", "resend_delivery", String(delivery.id), null, {
      provider_email_id: provider.providerEmailId, response_status: provider.status, verification,
    }),
  ];
  if (verification) statements.push(env.DB.prepare(`UPDATE resend_connections
    SET status='active',last_verified_at=?,last_error=NULL,revision=revision+1,change_id=?,updated_at=?
    WHERE id=? AND workspace_id=? AND status<>'revoked'`)
    .bind(completedAt, id("chg"), completedAt, connection.id, access.workspaceId));
  await env.DB.batch(statements);
  const completed = await env.DB.prepare("SELECT * FROM resend_deliveries WHERE id=? AND workspace_id=?")
    .bind(delivery.id, access.workspaceId).first();
  return json({ ok: true, replayed: false, delivery: safeResendDelivery(completed as Record<string, unknown> | null) }, 201);
}
async function recoveryKeyId(secret: string) {
  return (await sha256(secret)).slice(0, 16);
}
async function recoveryEncryptionKey(secret: string) {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function recoverySecrets(env: FrameworkEnv) {
  if (!env.RECOVERY_ENCRYPTION_KEY || env.RECOVERY_ENCRYPTION_KEY.length < 32) {
    throw new ApiError(503, "Workspace recovery is not configured");
  }
  const previous = (env.RECOVERY_PREVIOUS_ENCRYPTION_KEYS || "").split(",")
    .map((secret) => secret.trim()).filter((secret) => secret.length >= 32);
  return [env.RECOVERY_ENCRYPTION_KEY, ...previous];
}
function recoveryAad(workspaceId: string) {
  return encoder.encode(`openoperator-recovery:v${RECOVERY_VERSION}:${workspaceId}`);
}
async function encryptRecovery(env: FrameworkEnv, workspaceId: string, plaintext: string) {
  const secret = recoverySecrets(env)[0];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: recoveryAad(workspaceId) },
    await recoveryEncryptionKey(secret), encoder.encode(plaintext),
  );
  return {
    key_id: await recoveryKeyId(secret),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}
async function decryptRecovery(env: FrameworkEnv, workspaceId: string, keyId: string, iv: string, ciphertext: string) {
  try {
    const secrets = recoverySecrets(env);
    const secretIds = await Promise.all(secrets.map((secret) => recoveryKeyId(secret)));
    const secret = secrets[secretIds.indexOf(keyId)];
    if (!secret) throw new Error("Unknown recovery key");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv), additionalData: recoveryAad(workspaceId) },
      await recoveryEncryptionKey(secret), base64ToBytes(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new ApiError(400, "Backup authentication failed");
  }
}
async function webhookSignature(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
}
async function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, Uint8Array.from(signature.match(/.{2}/g) || [], (part) => Number.parseInt(part, 16)), encoder.encode(`${timestamp}.${body}`));
}
async function claimSchedulerRequest(request: Request, env: FrameworkEnv, job: string) {
  if (!env.SCHEDULER_SECRET || env.SCHEDULER_SECRET.length < 32) return false;
  if (request.headers.get("x-forwarded-ingest-edge") !== "openoperator") return false;
  const timestamp = request.headers.get("x-crm-scheduler-timestamp") || "";
  const nonce = request.headers.get("x-crm-scheduler-nonce") || "";
  const signature = request.headers.get("x-crm-scheduler-signature") || "";
  const timestampMs = Number(timestamp);
  if (!/^\d{13}$/.test(timestamp) || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 300_000) return false;
  if (!/^[0-9a-f-]{36}$/.test(nonce)) return false;
  if (!(await verifyWebhookSignature(env.SCHEDULER_SECRET, timestamp, `${job}.${nonce}`, signature))) return false;
  const now = new Date().toISOString();
  const claimed = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO scheduler_requests (nonce,job,requested_at,created_at) VALUES (?,?,?,?)")
      .bind(nonce, job, new Date(timestampMs).toISOString(), now),
    env.DB.prepare("DELETE FROM scheduler_requests WHERE created_at<?")
      .bind(new Date(Date.now() - 86_400_000).toISOString()),
  ]);
  return Boolean(claimed[0].meta.changes);
}
async function getWorkspaceAccess(request: Request, env: FrameworkEnv): Promise<WorkspaceAccess | null> {
  const authenticatedEmail = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
  if (!authenticatedEmail) return null;
  const requestedWorkspace = request.headers.get("x-crm-workspace-id")?.trim();
  const member = await env.DB.prepare(`SELECT workspace_id,role FROM workspace_members
    WHERE email=? AND active=1 AND (? IS NULL OR workspace_id=?)
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1`)
    .bind(authenticatedEmail, requestedWorkspace || null, requestedWorkspace || null).first<{ workspace_id: string; role: string }>();
  if (!member) return null;
  return { workspaceId: member.workspace_id, email: authenticatedEmail, role: member.role };
}
function bearer(request: Request) {
  const value = request.headers.get("x-crm-source-key") || request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
function isWorkspaceAdmin(access: WorkspaceAccess) {
  return access.role === "owner" || access.role === "admin";
}

const baseMemberContactGrantKeys = [
  "create", "note", "update",
  "update_field:stage", "update_field:status", "update_field:owner", "update_field:next_follow_up_at",
] as const;
const baseMemberOpportunityGrantKeys = [
  "read", "create", "update",
  "update_field:stage_id", "update_field:status", "update_field:value",
  "update_field:probability", "update_field:owner", "update_field:expected_close_at",
  "update_field:next_step", "update_field:lost_reason",
] as const;
async function memberContactGrantContract(env: FrameworkEnv, workspaceId: string) {
  const definitions = await env.DB.prepare(`SELECT field_key,label
    FROM custom_field_definitions
    WHERE workspace_id=? AND object_type='contact' AND active=1
    ORDER BY position,id LIMIT 50`).bind(workspaceId).all<{ field_key: string; label: string }>();
  const customFields = definitions.results.map((definition) => ({
    field_key: definition.field_key,
    label: definition.label,
    grant: `update_custom_field:${definition.field_key}`,
    read_grant: `read_custom_field:${definition.field_key}`,
  }));
  return {
    customFields,
    allowedGrants: [
      ...baseMemberContactGrantKeys,
      ...customFields.flatMap((field) => [field.read_grant, field.grant]),
    ],
  };
}

async function memberOpportunityGrantContract(env: FrameworkEnv, workspaceId: string) {
  const definitions = await env.DB.prepare(`SELECT field_key,label
    FROM custom_field_definitions
    WHERE workspace_id=? AND object_type='opportunity' AND active=1
    ORDER BY position,id LIMIT 50`).bind(workspaceId).all<{ field_key: string; label: string }>();
  const customFields = definitions.results.map((definition) => ({
    field_key: definition.field_key,
    label: definition.label,
    grant: `update_custom_field:${definition.field_key}`,
    read_grant: `read_custom_field:${definition.field_key}`,
  }));
  return {
    customFields,
    allowedGrants: [
      ...baseMemberOpportunityGrantKeys,
      ...customFields.flatMap((field) => [field.read_grant, field.grant]),
    ],
  };
}

async function memberCustomObjectGrantContract(env: FrameworkEnv, workspaceId: string) {
  const definitions = await env.DB.prepare(`SELECT id,slug,singular_label,plural_label,fields,active
    FROM custom_object_definitions WHERE workspace_id=?
    ORDER BY active DESC,plural_label COLLATE NOCASE,id LIMIT 10`)
    .bind(workspaceId).all<Record<string, unknown>>();
  return definitions.results.map((definition) => {
    const fields = parseCustomObjectFields(JSON.parse(String(definition.fields))).map((field) => ({
      field_key: field.key,
      label: field.label,
      required: field.required,
      read_grant: `read_field:${field.key}`,
      update_grant: `update_field:${field.key}`,
    }));
    return {
      object_id: String(definition.id),
      resource: `custom_object:${String(definition.id)}`,
      slug: String(definition.slug),
      singular_label: String(definition.singular_label),
      plural_label: String(definition.plural_label),
      active: Boolean(definition.active),
      fields,
      allowed_grants: [
        "read", "create", "update", "delete",
        ...fields.flatMap((field) => [field.read_grant, field.update_grant]),
      ],
    };
  });
}

async function readableContactCustomFieldKeys(
  env: FrameworkEnv,
  access: WorkspaceAccess,
): Promise<Set<string> | null> {
  if (isWorkspaceAdmin(access)) return null;
  const grants = await env.DB.prepare(`SELECT g.field_name
    FROM workspace_access_policies p
    JOIN workspace_role_grants g
      ON g.workspace_id=p.workspace_id AND g.revision=p.current_revision
    JOIN custom_field_definitions d
      ON d.workspace_id=g.workspace_id AND d.object_type='contact'
      AND d.field_key=g.field_name AND d.active=1
    WHERE p.workspace_id=? AND g.role=? AND g.resource='contact'
      AND g.action='read_custom_field'
    ORDER BY d.position,d.id LIMIT 50`)
    .bind(access.workspaceId, access.role).all<{ field_name: string }>();
  return new Set(grants.results.map((grant) => grant.field_name));
}

async function readableOpportunityCustomFieldKeys(
  env: FrameworkEnv,
  access: WorkspaceAccess,
): Promise<Set<string> | null> {
  if (isWorkspaceAdmin(access)) return null;
  const grants = await env.DB.prepare(`SELECT g.field_name
    FROM workspace_access_policies p
    JOIN workspace_role_grants g
      ON g.workspace_id=p.workspace_id AND g.revision=p.current_revision
    JOIN custom_field_definitions d
      ON d.workspace_id=g.workspace_id AND d.object_type='opportunity'
      AND d.field_key=g.field_name AND d.active=1
    WHERE p.workspace_id=? AND g.role=? AND g.resource='opportunity'
      AND g.action='read_custom_field'
    ORDER BY d.position,d.id LIMIT 50`)
    .bind(access.workspaceId, access.role).all<{ field_name: string }>();
  return new Set(grants.results.map((grant) => grant.field_name));
}

function redactContactCustomFields<T extends Record<string, unknown>>(
  record: T,
  readableKeys: Set<string> | null,
): T {
  if (readableKeys === null) return record;
  let stored: Record<string, unknown> = {};
  try {
    const parsed = typeof record.custom_fields === "string"
      ? JSON.parse(record.custom_fields)
      : record.custom_fields;
    if (isPlainObject(parsed)) stored = parsed;
  } catch { /* malformed legacy metadata is withheld */ }
  const filtered = Object.fromEntries(Object.entries(stored)
    .filter(([fieldName]) => readableKeys.has(fieldName)));
  return {
    ...record,
    custom_fields: typeof record.custom_fields === "string" ? JSON.stringify(filtered) : filtered,
  };
}

function redactOpportunityCustomFields<T extends Record<string, unknown>>(
  record: T,
  readableKeys: Set<string> | null,
): T {
  if (readableKeys === null) return record;
  let stored: Record<string, unknown> = {};
  try {
    const parsed = typeof record.custom_fields === "string"
      ? JSON.parse(record.custom_fields)
      : record.custom_fields;
    if (isPlainObject(parsed)) stored = parsed;
  } catch { /* malformed legacy metadata is withheld */ }
  const filtered = Object.fromEntries(Object.entries(stored)
    .filter(([fieldName]) => readableKeys.has(fieldName)));
  return {
    ...record,
    custom_fields: typeof record.custom_fields === "string" ? JSON.stringify(filtered) : filtered,
  };
}

async function hasWorkspaceGrant(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  resource: string,
  action: string,
  fieldName = "",
) {
  if (isWorkspaceAdmin(access)) return true;
  const grant = await env.DB.prepare(`SELECT 1 allowed
    FROM workspace_access_policies p
    JOIN workspace_role_grants g
      ON g.workspace_id=p.workspace_id AND g.revision=p.current_revision
    WHERE p.workspace_id=? AND g.role=? AND g.resource=? AND g.action=? AND g.field_name=?
    LIMIT 1`).bind(access.workspaceId, access.role, resource, action, fieldName).first();
  return Boolean(grant);
}

function customObjectResource(objectId: string) {
  return `custom_object:${objectId}`;
}

async function readableCustomObjectFieldKeys(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  objectId: string,
): Promise<Set<string> | null> {
  if (isWorkspaceAdmin(access)) return null;
  const grants = await env.DB.prepare(`SELECT g.field_name
    FROM workspace_access_policies p
    JOIN workspace_role_grants g
      ON g.workspace_id=p.workspace_id AND g.revision=p.current_revision
    WHERE p.workspace_id=? AND g.role=? AND g.resource=? AND g.action='read_field'
    ORDER BY g.field_name LIMIT 20`)
    .bind(access.workspaceId, access.role, customObjectResource(objectId))
    .all<{ field_name: string }>();
  return new Set(grants.results.map((grant) => grant.field_name));
}

function redactCustomObjectData(data: unknown, readableKeys: Set<string> | null) {
  const stored = isPlainObject(data) ? data : {};
  if (readableKeys === null) return stored;
  return Object.fromEntries(Object.entries(stored).filter(([key]) => readableKeys.has(key)));
}

function permissionDenied(resource: string, action: string, fieldName = "") {
  const capability = `${resource}.${action}${fieldName ? `:${fieldName}` : ""}`;
  return json({
    error: `Your workspace role does not allow ${capability}`,
    code: "permission_denied",
    capability,
  }, 403);
}

async function requireWorkspaceGrant(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  resource: string,
  action: string,
  fieldName = "",
) {
  return await hasWorkspaceGrant(env, access, resource, action, fieldName)
    ? null
    : permissionDenied(resource, action, fieldName);
}

function privateAllowedMethods(pathname: string): string[] | null {
  const exact: Record<string, string[]> = {
    "/v1/admin/workspaces": ["GET"],
    "/v1/admin/access-policy": ["GET", "PATCH"],
    "/v1/admin/onboarding/validate": ["POST"],
    "/v1/platform/workspaces": ["POST"],
    "/v1/admin/dashboard": ["GET"],
    "/v1/admin/calendar": ["GET"],
    "/v1/admin/product-catalog": ["GET"],
    "/v1/admin/custom-fields": ["GET", "POST"],
    "/v1/admin/custom-objects": ["GET", "POST"],
    "/v1/admin/custom-relation-targets": ["GET"],
    "/v1/admin/page-layouts": ["GET"],
    "/v1/admin/search": ["GET"],
    "/v1/admin/contacts": ["GET", "POST"],
    "/v1/admin/contacts/import/preview": ["POST"],
    "/v1/admin/contacts/import/commit": ["POST"],
    "/v1/admin/contact-imports": ["GET"],
    "/v1/admin/audience-imports": ["GET"],
    "/v1/admin/audience-imports/preview": ["POST"],
    "/v1/admin/audience-imports/commit": ["POST"],
    "/v1/admin/scoring/recalculate": ["POST"],
    "/v1/admin/briefing": ["GET"],
    "/v1/admin/contacts/bulk": ["PATCH"],
    "/v1/admin/saved-views": ["POST"],
    "/v1/admin/control-center": ["GET"],
    "/v1/admin/operations-health": ["GET"],
    "/v1/admin/operations-health-policy": ["GET", "PATCH"],
    "/v1/admin/opportunities": ["POST"],
    "/v1/admin/tasks": ["POST"],
    "/v1/admin/automations": ["POST"],
    "/v1/admin/webhooks": ["POST"],
    "/v1/admin/webhooks/retry": ["POST"],
    "/v1/admin/events/publish": ["POST"],
    "/v1/admin/agent/analyze": ["POST"],
    "/v1/admin/agent-policy": ["PATCH"],
    "/v1/admin/agent-credentials": ["GET", "POST"],
    "/v1/admin/sources": ["GET", "POST"],
    "/v1/admin/visitor-intent": ["GET"],
    "/v1/admin/visitor-intent/cases": ["GET", "POST"],
    "/v1/admin/visitor-connectors": ["POST"],
    "/v1/admin/companies/duplicates": ["GET"],
    "/v1/admin/recovery/backup": ["GET"],
    "/v1/admin/recovery/restore/validate": ["POST"],
    "/v1/admin/mailbox-connections": ["GET", "POST"],
    "/v1/admin/mailbox-connections/callback": ["GET"],
    "/v1/admin/mailbox-connections/connect-link": ["POST"],
    "/v1/admin/resend-connection": ["GET", "POST", "DELETE"],
    "/v1/admin/resend-connection/verify": ["POST"],
    "/v1/admin/resend-connection/send": ["POST"],
    "/v1/admin/conversations": ["GET"],
    "/v1/admin/conversations/send": ["POST"],
    "/v1/admin/forms": ["GET", "POST"],
    "/v1/admin/surveys": ["GET", "POST"],
    "/v1/admin/booking-calendars": ["GET", "POST"],
    "/v1/admin/reports/revenue-funnel": ["GET"],
    "/v1/admin/payments/ledger": ["GET", "POST"],
  };
  if (exact[pathname]) return exact[pathname];
  const patterns: Array<[RegExp, string[]]> = [
    [/^\/v1\/admin\/saved-views\/[^/]+$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/surveys\/survey_[a-f0-9]{32}$/, ["GET", "PATCH"]],
    [/^\/v1\/admin\/surveys\/survey_[a-f0-9]{32}\/(publish|revoke)$/, ["POST"]],
    [/^\/v1\/admin\/surveys\/survey_[a-f0-9]{32}\/responses$/, ["GET"]],
    [/^\/v1\/admin\/custom-fields\/cfld_[a-f0-9]{32}$/, ["PATCH"]],
    [/^\/v1\/admin\/custom-objects\/cobj_[a-f0-9]{32}$/, ["PATCH"]],
    [/^\/v1\/admin\/custom-objects\/cobj_[a-f0-9]{32}\/views$/, ["GET", "POST"]],
    [/^\/v1\/admin\/custom-objects\/cobj_[a-f0-9]{32}\/records$/, ["GET", "POST"]],
    [/^\/v1\/admin\/custom-object-views\/coview_[a-f0-9]{32}$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/custom-object-records\/corec_[a-f0-9]{32}$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/custom-object-records\/corec_[a-f0-9]{32}\/relations$/, ["POST"]],
    [/^\/v1\/admin\/custom-object-relations\/corel_[a-f0-9]{32}$/, ["DELETE"]],
    [/^\/v1\/admin\/page-layouts\/(contact|company|opportunity)$/, ["PATCH"]],
    [/^\/v1\/admin\/contacts\/[^/]+\/notes$/, ["POST"]],
    [/^\/v1\/admin\/notes\/note_[a-f0-9]{32}$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/contact-imports\/import_[a-f0-9]{32}\/rollback$/, ["POST"]],
    [/^\/v1\/admin\/companies\/[^/]+$/, ["GET", "PATCH"]],
    [/^\/v1\/admin\/companies\/[^/]+\/merge-preview$/, ["POST"]],
    [/^\/v1\/admin\/companies\/[^/]+\/merge$/, ["POST"]],
    [/^\/v1\/admin\/companies\/[^/]+\/notes$/, ["POST"]],
    [/^\/v1\/admin\/company-notes\/[^/]+$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/contacts\/[^/]+$/, ["GET", "PATCH", "DELETE"]],
    [/^\/v1\/admin\/contacts\/[^/]+\/communication-consent$/, ["GET", "PUT"]],
    [/^\/v1\/admin\/conversations\/thread_[a-f0-9]{32}$/, ["GET", "PATCH"]],
    [/^\/v1\/admin\/forms\/form_[a-f0-9]{32}$/, ["GET", "PATCH"]],
    [/^\/v1\/admin\/forms\/form_[a-f0-9]{32}\/(publish|revoke)$/, ["POST"]],
    [/^\/v1\/admin\/forms\/form_[a-f0-9]{32}\/submissions$/, ["GET"]],
    [/^\/v1\/admin\/booking-calendars\/bcal_[a-f0-9]{32}$/, ["GET", "PATCH"]],
    [/^\/v1\/admin\/booking-calendars\/bcal_[a-f0-9]{32}\/(publish|revoke)$/, ["POST"]],
    [/^\/v1\/admin\/booking-calendars\/bcal_[a-f0-9]{32}\/appointments$/, ["GET"]],
    [/^\/v1\/admin\/payments\/ledger\/pay_[a-f0-9]{32}\/adjustments$/, ["POST"]],
    [/^\/v1\/admin\/opportunities\/[^/]+\/intelligence$/, ["GET"]],
    [/^\/v1\/admin\/opportunities\/[^/]+$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/tasks\/[^/]+$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/agent-work-items\/[^/]+\/requeue$/, ["POST"]],
    [/^\/v1\/admin\/agent-work-items\/[^/]+\/cancel$/, ["POST"]],
    [/^\/v1\/admin\/automations\/[^/]+\/run$/, ["POST"]],
    [/^\/v1\/admin\/automations\/[^/]+$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/webhooks\/[^/]+\/test$/, ["POST"]],
    [/^\/v1\/admin\/webhooks\/[^/]+$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/agent\/proposals\/[^/]+\/decision$/, ["POST"]],
    [/^\/v1\/admin\/agent-credentials\/acred_[a-f0-9]{32}\/rotate$/, ["POST"]],
    [/^\/v1\/admin\/agent-credentials\/[^/]+$/, ["DELETE"]],
    [/^\/v1\/admin\/sources\/[^/]+\/purge$/, ["DELETE"]],
    [/^\/v1\/admin\/sources\/[^/]+$/, ["DELETE"]],
    [/^\/v1\/admin\/visitor-connectors\/vconn_[a-f0-9]{32}$/, ["PATCH", "DELETE"]],
    [/^\/v1\/admin\/visitor-profiles\/vpr_[a-f0-9]{32}\/research$/, ["POST"]],
    [/^\/v1\/admin\/mailbox-connections\/mbx_[a-f0-9]{32}\/reconnect$/, ["POST"]],
    [/^\/v1\/admin\/mailbox-connections\/mbx_[a-f0-9]{32}\/revoke$/, ["POST"]],
    [/^\/v1\/admin\/mailbox-connections\/mbx_[a-f0-9]{32}\/conversations$/, ["GET"]],
    [/^\/v1\/admin\/mailbox-connections\/mbx_[a-f0-9]{32}\/sync-conversations$/, ["POST"]],
    [/^\/v1\/admin\/mailbox-connections\/mbx_[a-f0-9]{32}$/, ["POST", "PATCH", "DELETE"]],
    [/^\/v1\/admin\/visitor-profiles\/vpr_[a-f0-9]{32}$/, ["PATCH"]],
    [/^\/v1\/admin\/visitor-profiles\/vpr_[a-f0-9]{32}\/promote$/, ["POST"]],
    [/^\/v1\/admin\/visitor-intent\/cases\/vicase_[a-f0-9]{32}$/, ["GET", "PATCH"]],
    [/^\/v1\/admin\/recovery\/restore\/[^/]+$/, ["POST", "DELETE"]],
  ];
  return patterns.find(([pattern]) => pattern.test(pathname))?.[1] || null;
}
async function authenticateSource(request: Request, env: FrameworkEnv) {
  const key = bearer(request);
  if (!key.startsWith("crm_") || key.length !== 68) return null;
  const keyHash = await sha256(key);
  const source = await env.DB.prepare("SELECT * FROM sources WHERE key_hash = ? AND active = 1").bind(keyHash).first<Record<string, unknown>>();
  if (!source) return null;
  await env.DB.prepare("UPDATE sources SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), source.id).run();
  return source;
}

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function mailboxProviderFailure(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const knownReasons = new Set<ComposioFailureReason>([
    "provider_auth_rejected", "provider_rate_limited", "provider_unavailable",
    "provider_request_rejected", "provider_unreachable", "provider_invalid_response",
  ]);
  if (record && typeof record.reason === "string" &&
    knownReasons.has(record.reason as ComposioFailureReason)) {
    return {
      code: record.reason as ComposioFailureReason,
      message: typeof record.message === "string"
        ? record.message.slice(0, 300) : "The mailbox provider rejected the connection request",
      providerStatus: record.reason.toUpperCase(),
      upstreamStatus: typeof record.upstreamStatus === "number" ? record.upstreamStatus : null,
    };
  }
  const message = record && typeof record.message === "string"
    ? record.message : error instanceof Error ? error.message : "";
  const fallbackReason: ComposioFailureReason | null =
    message.startsWith("Composio rejected the project API key") ? "provider_auth_rejected"
      : message.startsWith("Composio rate-limited") ? "provider_rate_limited"
        : message.startsWith("Composio was unavailable") ? "provider_unavailable"
          : message.startsWith("Composio rejected the connection request") ? "provider_request_rejected"
            : message === "Composio could not be reached" ? "provider_unreachable"
              : message === "Composio returned an invalid response" ? "provider_invalid_response" : null;
  if (fallbackReason) {
    const upstreamStatus = Number(message.match(/HTTP (\d{3})/)?.[1]);
    return {
      code: fallbackReason,
      message: message.slice(0, 300),
      providerStatus: fallbackReason.toUpperCase(),
      upstreamStatus: Number.isSafeInteger(upstreamStatus) ? upstreamStatus : null,
    };
  }
  return {
    code: "provider_link_failed",
    message: "The mailbox provider could not create a secure connection link",
    providerStatus: "LINK_FAILED",
    upstreamStatus: null,
  };
}

async function readJsonLimited(request: Request, maximumBytes: number, allowRecoveryMediaType = false): Promise<Json> {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json") &&
    !(allowRecoveryMediaType && contentType.startsWith("application/vnd.openoperator.backup+json"))) {
    throw new ApiError(415, "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ApiError(413, "Request body is too large");
  }
  if (!request.body) throw new ApiError(400, "A JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ApiError(413, "Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Json;
  } catch {
    throw new ApiError(400, "Request body must be a JSON object");
  }
}
async function readJson(request: Request): Promise<Json> {
  return readJsonLimited(request, MAX_JSON_BYTES);
}

async function readTextBody(request: Request): Promise<string> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "Content-Type must be application/json");
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) throw new ApiError(413, "Request body is too large");
  if (!request.body) throw new ApiError(400, "A JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) { await reader.cancel(); throw new ApiError(413, "Request body is too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ApiError(400, `${field} exceeds ${max} characters`);
  return trimmed || null;
}

function boundedNumber(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new ApiError(400, `${field} is invalid`);
  return number;
}

type ContactCustomFilter = { field_key: string; operator: string; value?: string | number | boolean };
const savedViewFilterKeys = new Set(["status", "stage", "owner", "source", "attention", "query", "sort", "direction", "custom"]);
const savedViewColumns = new Set(["identity", "company", "score", "stage", "owner", "source", "next_follow_up"]);
const savedViewSortFields = new Set(["recent", "name", "company", "score", "follow_up"]);
function validateContactCustomFilters(
  raw: unknown,
  definitions: CustomFieldDefinition[],
  readableKeys: Set<string> | null,
): ContactCustomFilter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 5) throw new ApiError(400, "Custom filters must contain at most 5 fields");
  const active = new Map(definitions.filter((definition) => definition.object_type === "contact" && Boolean(definition.active))
    .map((definition) => [definition.field_key, definition]));
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !["field_key", "operator", "value"].includes(key))) {
      throw new ApiError(400, `Custom filter ${index + 1} is invalid`);
    }
    const fieldKey = optionalString(item.field_key, `custom[${index}].field_key`, 40) || "";
    const operator = optionalString(item.operator, `custom[${index}].operator`, 20) || "";
    const definition = active.get(fieldKey);
    if (!definition || seen.has(fieldKey) || (readableKeys !== null && !readableKeys.has(fieldKey))) {
      throw new ApiError(400, "Custom filter references an unavailable field");
    }
    const operators: Record<CustomFieldType, Set<string>> = {
      text: new Set(["equals", "contains", "is_empty"]),
      select: new Set(["equals", "is_empty"]),
      number: new Set(["equals", "gte", "lte", "is_empty"]),
      boolean: new Set(["equals", "is_empty"]),
      date: new Set(["equals", "before", "after", "is_empty"]),
    };
    if (!operators[definition.field_type].has(operator)) throw new ApiError(400, `Unsupported operator for ${definition.label}`);
    if (operator === "is_empty") {
      if (item.value !== undefined && item.value !== null && item.value !== "") throw new ApiError(400, "Empty filters cannot include a value");
      seen.add(fieldKey);
      return { field_key: fieldKey, operator };
    }
    const value = customFieldValue(definition, item.value);
    if (value === null) throw new ApiError(400, `${definition.label} requires a filter value`);
    seen.add(fieldKey);
    return { field_key: fieldKey, operator, value };
  });
}
function validateSavedViewDefinition(
  body: Json,
  partial = false,
  customDefinitions: CustomFieldDefinition[] = [],
  readableKeys: Set<string> | null = null,
) {
  const result: { name?: string; filters?: Json; visibility?: string; columns?: string[]; sorts?: Array<{ field: string; direction: string }> } = {};
  if (!partial || body.name !== undefined) {
    const name = optionalString(body.name, "name", 100);
    if (!name) throw new ApiError(400, "A saved-view name is required");
    result.name = name;
  }
  if (!partial || body.filters !== undefined) {
    if (!body.filters || typeof body.filters !== "object" || Array.isArray(body.filters)) throw new ApiError(400, "Saved-view filters are invalid");
    const filters = body.filters as Json;
    if (Object.keys(filters).some((key) => !savedViewFilterKeys.has(key))) throw new ApiError(400, "Unsupported saved-view filter");
    if (filters.stage !== undefined && filters.stage !== null && (typeof filters.stage !== "string" || !allowedStages.has(filters.stage))) throw new ApiError(400, "Invalid saved-view stage");
    if (filters.status !== undefined && filters.status !== null && (typeof filters.status !== "string" || !allowedStatuses.has(filters.status))) throw new ApiError(400, "Invalid saved-view status");
    for (const field of ["owner", "source", "query"] as const) {
      const value = filters[field];
      const max = field === "owner" ? 254 : field === "source" ? 120 : 200;
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length > max)) throw new ApiError(400, `Invalid saved-view ${field}`);
    }
    if (filters.attention !== undefined && typeof filters.attention !== "boolean") throw new ApiError(400, "Invalid saved-view attention filter");
    if (filters.sort !== undefined && (typeof filters.sort !== "string" || !savedViewSortFields.has(filters.sort))) throw new ApiError(400, "Invalid saved-view sort");
    if (filters.direction !== undefined && (typeof filters.direction !== "string" || !["asc", "desc"].includes(filters.direction))) throw new ApiError(400, "Invalid saved-view direction");
    filters.custom = validateContactCustomFilters(filters.custom, customDefinitions, readableKeys);
    result.filters = filters;
  }
  if (!partial || body.visibility !== undefined) {
    const visibility = body.visibility === undefined ? "private" : body.visibility;
    if (visibility !== "private" && visibility !== "workspace") throw new ApiError(400, "Saved-view visibility must be private or workspace");
    result.visibility = visibility;
  }
  if (!partial || body.columns !== undefined) {
    const columns = body.columns === undefined ? ["identity", "company", "score", "stage", "owner"] : body.columns;
    const activeCustomKeys = new Set(customDefinitions.filter((definition) => definition.object_type === "contact" && Boolean(definition.active))
      .filter((definition) => readableKeys === null || readableKeys.has(definition.field_key))
      .map((definition) => `custom:${definition.field_key}`));
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > 12 ||
      columns.some((column) => typeof column !== "string" || (!savedViewColumns.has(column) && !activeCustomKeys.has(column))) ||
      new Set(columns).size !== columns.length || columns[0] !== "identity") {
      throw new ApiError(400, "Saved-view columns must be unique, supported, and start with identity");
    }
    result.columns = columns as string[];
  }
  if (!partial || body.sorts !== undefined) {
    const sorts = body.sorts === undefined
      ? [{ field: String((result.filters || body.filters as Json | undefined)?.sort || "recent"), direction: String((result.filters || body.filters as Json | undefined)?.direction || "desc") }]
      : body.sorts;
    if (!Array.isArray(sorts) || sorts.length !== 1) throw new ApiError(400, "Exactly one saved-view sort is required");
    const sort = sorts[0];
    if (!sort || typeof sort !== "object" || Array.isArray(sort) || !savedViewSortFields.has(String((sort as Json).field)) ||
      !["asc", "desc"].includes(String((sort as Json).direction)) || Object.keys(sort as Json).some((key) => !["field", "direction"].includes(key))) {
      throw new ApiError(400, "Saved-view sort is invalid");
    }
    result.sorts = [{ field: String((sort as Json).field), direction: String((sort as Json).direction) }];
  }
  return result;
}
function effectiveSavedView(
  row: Record<string, unknown>,
  activeCustomKeys: Set<string>,
) {
  let columns = ["identity", "company", "score", "stage", "owner"];
  let filters: Json = {};
  try {
    const parsedColumns = JSON.parse(String(row.columns || "[]"));
    if (Array.isArray(parsedColumns)) {
      const visible = parsedColumns.filter((column) => typeof column === "string" &&
        (!column.startsWith("custom:") || activeCustomKeys.has(column.slice(7))));
      if (visible[0] === "identity") columns = visible;
    }
    const parsedFilters = JSON.parse(String(row.filters || "{}"));
    if (isPlainObject(parsedFilters)) {
      filters = parsedFilters;
      const custom = Array.isArray(filters.custom) ? filters.custom.filter((filter) =>
        isPlainObject(filter) && typeof filter.field_key === "string" && activeCustomKeys.has(filter.field_key)) : [];
      filters.custom = custom;
    }
  } catch {
    filters = {};
  }
  return { ...row, columns: JSON.stringify(columns), filters: JSON.stringify(filters) };
}

const recoveryFingerprintSql = `SELECT json_object(${recoveryTables.map((table) => {
  const rowJson = `json_object(${recoverySpecs[table].columns.map((column) => `'${column}',${column}`).join(",")})`;
  return `'${table}',json((SELECT json_group_array(json(row_json)) FROM (SELECT ${rowJson} row_json FROM ${table} WHERE workspace_id=? ORDER BY id)))`;
}).join(",")}) fingerprint`;
function recoveryFingerprintBindings(workspaceId: string) {
  return recoveryTables.map(() => workspaceId);
}
async function workspaceRecoveryFingerprint(env: FrameworkEnv, workspaceId: string) {
  const row = await env.DB.prepare(recoveryFingerprintSql).bind(...recoveryFingerprintBindings(workspaceId))
    .first<{ fingerprint: string }>();
  if (!row?.fingerprint) throw new Error("Workspace fingerprint could not be calculated");
  return row.fingerprint;
}
async function validateRecoveryRows(env: FrameworkEnv, workspaceId: string, rawTables: unknown) {
  if (!rawTables || typeof rawTables !== "object" || Array.isArray(rawTables)) throw new ApiError(400, "Backup tables are malformed");
  const input = rawTables as Record<string, unknown>;
  if (Object.keys(input).length !== recoveryTables.length || recoveryTables.some((table) => !(table in input))) {
    throw new ApiError(400, "Backup table set is incompatible");
  }
  const tables = {} as Record<RecoveryTable, Json[]>;
  let totalRows = 0;
  for (const table of recoveryTables) {
    const rows = input[table];
    if (!Array.isArray(rows) || rows.length > 10_000) throw new ApiError(400, `${table} rows are invalid`);
    const expectedKeys = recoverySpecs[table].columns;
    const ids = new Set<string>();
    tables[table] = rows.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, `${table}[${index}] is invalid`);
      const row = raw as Json;
      const keys = Object.keys(row).sort();
      if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(row, key))) {
        throw new ApiError(400, `${table}[${index}] has incompatible fields`);
      }
      if (row.workspace_id !== workspaceId) throw new ApiError(400, `${table}[${index}] belongs to another workspace`);
      if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.id)) throw new ApiError(400, `${table}[${index}] has an invalid id`);
      if (ids.has(row.id)) throw new ApiError(400, `${table} contains duplicate ids`);
      ids.add(row.id);
      return row;
    });
    totalRows += rows.length;
  }
  if (totalRows > 25_000) throw new ApiError(400, "Backup contains too many rows");

  const idSets = Object.fromEntries(recoveryTables.map((table) => [table, new Set(tables[table].map((row) => String(row.id)))])) as Record<RecoveryTable, Set<string>>;
  const requireReference = (table: RecoveryTable, row: Json, field: string, target: RecoveryTable, nullable = false) => {
    const value = row[field];
    if (nullable && (value === null || value === undefined)) return;
    if (typeof value !== "string" || !idSets[target].has(value)) throw new ApiError(400, `${table}.${field} references a missing ${target} row`);
  };
  for (const row of tables.pipeline_stages) requireReference("pipeline_stages", row, "pipeline_id", "pipelines");
  for (const row of tables.company_redirects) requireReference("company_redirects", row, "target_company_id", "companies");
  for (const row of tables.contacts) requireReference("contacts", row, "company_id", "companies", true);
  for (const row of tables.activities) requireReference("activities", row, "contact_id", "contacts");
  for (const row of tables.deals) requireReference("deals", row, "contact_id", "contacts");
  for (const row of tables.notes) requireReference("notes", row, "contact_id", "contacts");
  for (const row of tables.company_notes) requireReference("company_notes", row, "company_id", "companies");
  for (const row of tables.custom_object_records) {
    requireReference("custom_object_records", row, "object_id", "custom_object_definitions");
  }
  for (const row of tables.custom_object_views) {
    requireReference("custom_object_views", row, "object_id", "custom_object_definitions");
  }
  for (const row of tables.custom_object_relations) {
    requireReference("custom_object_relations", row, "source_record_id", "custom_object_records");
    const targetType = String(row.target_type);
    const targetTable = targetType === "contact" ? "contacts" : targetType === "company" ? "companies"
      : targetType === "opportunity" ? "opportunities"
        : targetType === "custom_record" ? "custom_object_records" : null;
    if (!targetTable || !idSets[targetTable].has(String(row.target_id)) ||
      (targetType === "custom_record" && row.target_id === row.source_record_id)) {
      throw new ApiError(400, "custom_object_relations.target_id references a missing or invalid target");
    }
  }
  for (const row of tables.opportunities) {
    requireReference("opportunities", row, "pipeline_id", "pipelines");
    requireReference("opportunities", row, "stage_id", "pipeline_stages");
    requireReference("opportunities", row, "contact_id", "contacts");
    const stage = tables.pipeline_stages.find((candidate) => candidate.id === row.stage_id);
    if (stage?.pipeline_id !== row.pipeline_id) throw new ApiError(400, "Opportunity stage belongs to another pipeline");
  }
  for (const row of tables.tasks) {
    requireReference("tasks", row, "contact_id", "contacts", true);
    requireReference("tasks", row, "opportunity_id", "opportunities", true);
  }
  for (const row of tables.automation_runs) requireReference("automation_runs", row, "rule_id", "automation_rules");
  for (const row of tables.automation_runs) {
    if (row.retry_of_run_id !== null && row.retry_of_run_id !== undefined) {
      requireReference("automation_runs", row, "retry_of_run_id", "automation_runs");
    }
  }
  for (const row of tables.visitor_profiles) {
    requireReference("visitor_profiles", row, "connector_id", "visitor_connectors");
    requireReference("visitor_profiles", row, "matched_contact_id", "contacts", true);
    requireReference("visitor_profiles", row, "origin_import_id", "audience_imports", true);
  }
  for (const row of tables.audience_imports) {
    requireReference("audience_imports", row, "connector_id", "visitor_connectors");
  }
  for (const row of tables.audience_import_members) {
    requireReference("audience_import_members", row, "import_id", "audience_imports");
    requireReference("audience_import_members", row, "profile_id", "visitor_profiles");
  }
  for (const row of tables.visitor_events) {
    requireReference("visitor_events", row, "connector_id", "visitor_connectors");
    requireReference("visitor_events", row, "profile_id", "visitor_profiles");
  }
  for (const row of tables.communication_consents) {
    requireReference("communication_consents", row, "contact_id", "contacts");
  }
  for (const row of tables.conversation_threads) {
    requireReference("conversation_threads", row, "contact_id", "contacts", true);
  }
  for (const row of tables.conversation_messages) {
    requireReference("conversation_messages", row, "thread_id", "conversation_threads");
  }
  for (const row of tables.form_versions) requireReference("form_versions", row, "form_id", "forms");
  for (const row of tables.forms) requireReference("forms", row, "published_version_id", "form_versions", true);
  for (const row of tables.form_submissions) {
    requireReference("form_submissions", row, "form_id", "forms");
    requireReference("form_submissions", row, "form_version_id", "form_versions");
    requireReference("form_submissions", row, "contact_id", "contacts");
  }
  for (const row of tables.survey_versions) requireReference("survey_versions", row, "survey_id", "surveys");
  for (const row of tables.surveys) requireReference("surveys", row, "published_version_id", "survey_versions", true);
  for (const row of tables.survey_responses) {
    requireReference("survey_responses", row, "survey_id", "surveys");
    requireReference("survey_responses", row, "survey_version_id", "survey_versions");
  }
  for (const row of tables.booking_availability_rules) requireReference("booking_availability_rules", row, "calendar_id", "booking_calendars");
  for (const row of tables.booking_appointments) {
    requireReference("booking_appointments", row, "calendar_id", "booking_calendars");
    requireReference("booking_appointments", row, "contact_id", "contacts");
  }
  const bookingSlugs = new Set<string>();
  const bookingIdempotency = new Set<string>();
  const bookingTokens = new Set<string>();
  for (const row of tables.booking_calendars) {
    if (bookingSlugs.has(String(row.slug)) || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(String(row.slug)) ||
      !["draft", "published", "revoked"].includes(String(row.status)) || !validTimeZone(String(row.timezone)) ||
      !Number.isInteger(row.duration_minutes) || Number(row.duration_minutes) < 15 || Number(row.duration_minutes) > 180 ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid booking calendar");
    }
    bookingSlugs.add(String(row.slug));
  }
  for (const calendar of tables.booking_calendars) {
    validateBookingRules(tables.booking_availability_rules.filter((rule) => rule.calendar_id === calendar.id)
      .map((rule) => ({ day_of_week: rule.day_of_week, start_minute: rule.start_minute, end_minute: rule.end_minute })));
  }
  for (const row of tables.booking_appointments) {
    const replay = `${row.calendar_id}:${row.idempotency_key}`;
    if (bookingIdempotency.has(replay) || bookingTokens.has(String(row.manage_token_hash)) ||
      !/^[A-Za-z0-9._:-]{8,100}$/.test(String(row.idempotency_key)) || !/^[a-f0-9]{64}$/.test(String(row.manage_token_hash)) ||
      !["booked", "cancelled"].includes(String(row.status)) || !["local", "pending", "synced", "failed"].includes(String(row.sync_status)) ||
      !validEmail(normalizeEmail(row.email)) || !validTimeZone(String(row.visitor_timezone)) ||
      Date.parse(String(row.starts_at)) >= Date.parse(String(row.ends_at))) {
      throw new ApiError(400, "Backup contains an invalid booking appointment");
    }
    bookingIdempotency.add(replay);
    bookingTokens.add(String(row.manage_token_hash));
  }
  const paymentIdempotency = new Set<string>();
  const paymentProviderReferences = new Set<string>();
  for (const row of tables.payment_ledger_entries) {
    requireReference("payment_ledger_entries", row, "contact_id", "contacts", true);
    requireReference("payment_ledger_entries", row, "opportunity_id", "opportunities", true);
    requireReference("payment_ledger_entries", row, "parent_entry_id", "payment_ledger_entries", true);
    const kind = String(row.kind); const parent = row.parent_entry_id === null ? null :
      tables.payment_ledger_entries.find((candidate) => candidate.id === row.parent_entry_id);
    const providerIdentity = row.provider_reference === null ? null : `${row.provider}:${row.provider_reference}`;
    if (paymentIdempotency.has(String(row.idempotency_key)) || (providerIdentity && paymentProviderReferences.has(providerIdentity)) ||
      !/^[A-Za-z0-9._:-]{8,100}$/.test(String(row.idempotency_key)) || !["payment", "refund", "dispute", "dispute_reversal"].includes(kind) ||
      !Number.isSafeInteger(row.amount_minor) || Number(row.amount_minor) <= 0 || !/^[A-Z]{3}$/.test(String(row.currency)) ||
      row.provider !== "manual" || !Number.isFinite(Date.parse(String(row.occurred_at))) ||
      (kind === "payment" ? row.parent_entry_id !== null : !parent || parent.kind !== "payment" || parent.currency !== row.currency)) {
      throw new ApiError(400, "Backup contains an invalid payment ledger entry");
    }
    paymentIdempotency.add(String(row.idempotency_key));
    if (providerIdentity) paymentProviderReferences.add(providerIdentity);
  }
  for (const payment of tables.payment_ledger_entries.filter((row) => row.kind === "payment")) {
    const adjustments = tables.payment_ledger_entries.filter((row) => row.parent_entry_id === payment.id);
    const total = (kind: string) => adjustments.filter((row) => row.kind === kind)
      .reduce((sum, row) => sum + Number(row.amount_minor), 0);
    const refunds = total("refund"); const disputes = total("dispute"); const reversals = total("dispute_reversal");
    if (refunds > Number(payment.amount_minor) || disputes > Number(payment.amount_minor) || reversals > disputes) {
      throw new ApiError(400, "Backup contains over-allocated payment adjustments");
    }
  }
  const formSlugs = new Set<string>();
  for (const row of tables.forms) {
    if (formSlugs.has(String(row.slug)) || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(String(row.slug)) ||
      !["draft", "published", "revoked"].includes(String(row.status)) || !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid form");
    }
    formSlugs.add(String(row.slug));
    try { validateFormFields(JSON.parse(String(row.fields))); } catch { throw new ApiError(400, "Backup contains invalid form fields"); }
  }
  const formVersionNumbers = new Set<string>();
  for (const row of tables.form_versions) {
    const identity = `${row.form_id}:${row.version}`;
    if (formVersionNumbers.has(identity) || !Number.isInteger(row.version) || Number(row.version) < 1) {
      throw new ApiError(400, "Backup contains an invalid form version");
    }
    formVersionNumbers.add(identity);
    try { validateFormFields(JSON.parse(String(row.fields))); } catch { throw new ApiError(400, "Backup contains invalid form version fields"); }
  }
  const formIdempotency = new Set<string>();
  for (const row of tables.form_submissions) {
    const identity = `${row.form_id}:${row.idempotency_key}`;
    if (formIdempotency.has(identity) || !/^[A-Za-z0-9._:-]{8,100}$/.test(String(row.idempotency_key)) ||
      ![0, 1].includes(Number(row.email_consent))) throw new ApiError(400, "Backup contains an invalid form submission");
    formIdempotency.add(identity);
  }
  const surveySlugs = new Set<string>(); const surveyVersionNumbers = new Set<string>(); const surveyIdempotency = new Set<string>();
  for (const row of tables.surveys) {
    if (surveySlugs.has(String(row.slug)) || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(String(row.slug)) ||
      !["draft", "published", "revoked"].includes(String(row.status)) || !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid survey");
    }
    surveySlugs.add(String(row.slug));
    try { validateSurveyQuestions(JSON.parse(String(row.questions))); } catch { throw new ApiError(400, "Backup contains invalid survey questions"); }
  }
  for (const row of tables.survey_versions) {
    const identity = `${row.survey_id}:${row.version}`;
    if (surveyVersionNumbers.has(identity) || !Number.isInteger(row.version) || Number(row.version) < 1) throw new ApiError(400, "Backup contains an invalid survey version");
    surveyVersionNumbers.add(identity);
    try { validateSurveyQuestions(JSON.parse(String(row.questions))); } catch { throw new ApiError(400, "Backup contains invalid survey version questions"); }
  }
  for (const row of tables.survey_responses) {
    const identity = `${row.survey_id}:${row.idempotency_key}`;
    if (surveyIdempotency.has(identity) || !/^[A-Za-z0-9._:-]{8,100}$/.test(String(row.idempotency_key)) || Number(row.privacy_accepted) !== 1 ||
      !Number.isFinite(Date.parse(String(row.submitted_at))) || row.duration_seconds !== null && (!Number.isInteger(row.duration_seconds) || Number(row.duration_seconds) < 0 || Number(row.duration_seconds) > 86400)) {
      throw new ApiError(400, "Backup contains an invalid survey response");
    }
    surveyIdempotency.add(identity);
  }
  const emails = new Set<string>();
  const redirectSources = new Set<string>();
  for (const row of tables.company_redirects) {
    const sourceId = String(row.source_company_id);
    if (!/^cmp_[a-f0-9]{32}$/.test(sourceId) || sourceId === row.target_company_id ||
      idSets.companies.has(sourceId) || redirectSources.has(sourceId) ||
      typeof row.source_name !== "string" || !row.source_name.trim() ||
      typeof row.merged_at !== "string") {
      throw new ApiError(400, "Backup contains an invalid company redirect");
    }
    redirectSources.add(sourceId);
  }
  for (const row of tables.company_notes) {
    if (typeof row.updated_at !== "string") throw new ApiError(400, "Backup contains an invalid company note version");
  }
  const fieldKeys = new Set<string>();
  const fieldKeysByObject = new Map<string, Set<string>>([
    ["contact", new Set()], ["company", new Set()], ["opportunity", new Set()],
  ]);
  for (const row of tables.custom_field_definitions) {
    let options: unknown;
    try { options = JSON.parse(String(row.options)); } catch { throw new ApiError(400, "Backup contains invalid custom-field options"); }
    if (!["contact", "company", "opportunity"].includes(String(row.object_type)) || typeof row.field_key !== "string" ||
      !/^[a-z][a-z0-9_]{1,39}$/.test(row.field_key) || fieldKeys.has(`${row.object_type}:${row.field_key}`) ||
      typeof row.label !== "string" || !row.label.trim() || row.label.length > 80 ||
      !customFieldTypes.has(row.field_type as CustomFieldType) || !Array.isArray(options) ||
      options.some((option) => typeof option !== "string" || !option || option.length > 80) ||
      (row.field_type === "select" && (options.length < 1 || options.length > 50)) ||
      ![0, 1].includes(Number(row.required)) || ![0, 1].includes(Number(row.active)) ||
      !Number.isInteger(row.position) || !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid custom-field definition");
    }
    fieldKeys.add(`${row.object_type}:${row.field_key}`);
    fieldKeysByObject.get(String(row.object_type))?.add(String(row.field_key));
  }
  const layoutObjects = new Set<string>();
  for (const row of tables.object_page_layouts) {
    let sections: unknown;
    try { sections = JSON.parse(String(row.sections)); } catch { throw new ApiError(400, "Backup contains invalid page-layout sections"); }
    const objectType = String(row.object_type);
    if (!fieldKeysByObject.has(objectType) || layoutObjects.has(objectType) ||
      typeof row.name !== "string" || !row.name.trim() || row.name.length > 80 ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid page layout");
    }
    try { parsePageLayoutSections(sections, fieldKeysByObject.get(objectType)); } catch {
      throw new ApiError(400, "Backup contains invalid page-layout sections");
    }
    layoutObjects.add(objectType);
  }
  const recoveryDefinitions = tables.custom_field_definitions.map((row) => ({
    ...row, active: 1,
  })) as unknown as CustomFieldDefinition[];
  const customObjectSlugs = new Set<string>();
  const customObjectFields = new Map<string, CustomObjectField[]>();
  for (const row of tables.custom_object_definitions) {
    let fields: CustomObjectField[];
    try { fields = parseCustomObjectFields(JSON.parse(String(row.fields))); } catch {
      throw new ApiError(400, "Backup contains invalid custom-object fields");
    }
    const slug = String(row.slug);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(slug) || customObjectSlugs.has(slug) ||
      !String(row.singular_label).trim() || String(row.singular_label).length > 80 ||
      !String(row.plural_label).trim() || String(row.plural_label).length > 80 ||
      ![0, 1].includes(Number(row.active)) || !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid custom-object definition");
    }
    customObjectSlugs.add(slug);
    customObjectFields.set(String(row.id), fields);
  }
  const customRelationKeys = new Set<string>();
  for (const row of tables.custom_object_records) {
    if (!String(row.display_name).trim() || String(row.display_name).length > 200 ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid custom-object record");
    }
    let data: unknown;
    try { data = JSON.parse(String(row.data)); } catch {
      throw new ApiError(400, "Backup contains malformed custom-object record data");
    }
    try { customObjectRecordData(customObjectFields.get(String(row.object_id)) || [], data); } catch {
      throw new ApiError(400, "Backup contains invalid custom-object record data");
    }
  }
  const customObjectViewNames = new Set<string>();
  for (const row of tables.custom_object_views) {
    const key = `${row.object_id}:${row.name}`;
    if (customObjectViewNames.has(key) || !Number.isInteger(row.revision) || Number(row.revision) < 1 ||
      typeof row.created_by !== "string" || !row.created_by) {
      throw new ApiError(400, "Backup contains an invalid custom-object view");
    }
    customObjectViewNames.add(key);
    try {
      validateCustomObjectView({
        name: row.name,
        visibility: row.visibility,
        filters: JSON.parse(String(row.filters)),
        visible_fields: JSON.parse(String(row.visible_fields)),
        sort_field: row.sort_field,
        sort_direction: row.sort_direction,
      }, customObjectFields.get(String(row.object_id)) || []);
    } catch {
      throw new ApiError(400, "Backup contains an invalid custom-object view definition");
    }
  }
  for (const row of tables.custom_object_relations) {
    const key = `${row.source_record_id}:${row.target_type}:${row.target_id}:${row.label}`;
    if (customRelationKeys.has(key) || !String(row.label).trim() || String(row.label).length > 80) {
      throw new ApiError(400, "Backup contains an invalid custom-object relation");
    }
    customRelationKeys.add(key);
  }
  const viewNames = new Set<string>();
  for (const row of tables.saved_views) {
    if (row.object_type !== "contact" || typeof row.created_by !== "string" || !row.created_by ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid saved view");
    }
    const uniqueName = String(row.name);
    if (!uniqueName || viewNames.has(uniqueName)) throw new ApiError(400, "Backup contains duplicate saved-view names");
    let filters: unknown;
    let columns: unknown;
    let sorts: unknown;
    try {
      filters = JSON.parse(String(row.filters));
      columns = JSON.parse(String(row.columns));
      sorts = JSON.parse(String(row.sorts));
      validateSavedViewDefinition({
        name: row.name, filters, visibility: row.visibility, columns, sorts,
      }, false, recoveryDefinitions);
    } catch {
      throw new ApiError(400, "Backup contains an invalid saved-view definition");
    }
    viewNames.add(uniqueName);
  }
  for (const row of tables.contacts) {
    const email = normalizeEmail(row.email);
    if (!email || emails.has(email)) throw new ApiError(400, "Backup contains invalid or duplicate contact emails");
    emails.add(email);
    if (!allowedStatuses.has(String(row.status)) || !allowedStages.has(String(row.stage)) ||
      !Number.isInteger(row.score) || Number(row.score) < 0 || Number(row.score) > 100) {
      throw new ApiError(400, "Backup contains an invalid contact lifecycle");
    }
    try {
      if (!Array.isArray(JSON.parse(String(row.tags))) ||
        !isPlainObject(JSON.parse(String(row.custom_fields)))) throw new Error();
    } catch {
      throw new ApiError(400, "Backup contains invalid contact metadata");
    }
  }
  for (const row of [...tables.companies, ...tables.opportunities]) {
    try {
      if (!isPlainObject(JSON.parse(String(row.custom_fields)))) throw new Error();
    } catch {
      throw new ApiError(400, "Backup contains invalid core-object custom metadata");
    }
  }
  const consentContacts = new Set<string>();
  for (const row of tables.communication_consents) {
    const contactId = String(row.contact_id);
    if (consentContacts.has(contactId) || row.channel !== "email" ||
      !["unknown", "opted_in", "opted_out"].includes(String(row.status)) ||
      !["unknown", "express", "contractual", "inbound_request", "manual_suppression"].includes(String(row.basis)) ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1 ||
      (row.status === "opted_out" && row.basis !== "manual_suppression") ||
      (row.status === "opted_in" && !["express", "contractual", "inbound_request"].includes(String(row.basis)))) {
      throw new ApiError(400, "Backup contains invalid communication consent");
    }
    consentContacts.add(contactId);
  }
  const messageIdempotency = new Set<string>();
  const providerReceipts = new Set<string>();
  for (const row of tables.conversation_threads) {
    if (row.channel !== "email" || (row.provider !== null && !["gmail", "outlook"].includes(String(row.provider))) ||
      ((row.provider === null) !== (row.provider_thread_id === null)) || !validEmail(normalizeEmail(row.participant_email)) ||
      !String(row.subject).trim() || String(row.subject).length > 200 ||
      !["open", "closed"].includes(String(row.status)) || !Number.isInteger(row.unread_count) ||
      Number(row.unread_count) < 0 || !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid conversation thread");
    }
  }
  for (const row of tables.conversation_messages) {
    const idempotencyKey = String(row.idempotency_key);
    const providerReceipt = row.provider_message_id === null ? "" : `${row.provider}:${row.provider_message_id}`;
    if (messageIdempotency.has(idempotencyKey) || !/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey) ||
      !["inbound", "outbound"].includes(String(row.direction)) ||
      !["gmail", "outlook", "resend"].includes(String(row.provider)) ||
      !validEmail(normalizeEmail(row.from_email)) || !validEmail(normalizeEmail(row.to_email)) ||
      !String(row.subject).trim() || String(row.subject).length > 200 || String(row.body_text).length > 10_000 ||
      !["inbound", "transactional", "marketing"].includes(String(row.purpose)) ||
      !["received", "pending", "sent", "failed"].includes(String(row.status)) ||
      (providerReceipt && providerReceipts.has(providerReceipt))) {
      throw new ApiError(400, "Backup contains an invalid conversation message");
    }
    messageIdempotency.add(idempotencyKey);
    if (providerReceipt) providerReceipts.add(providerReceipt);
  }
  for (const row of tables.pipeline_stages) {
    if (!Number.isInteger(row.position) || !Number.isInteger(row.probability) ||
      Number(row.probability) < 0 || Number(row.probability) > 100 ||
      !["open", "won", "lost"].includes(String(row.category))) {
      throw new ApiError(400, "Backup contains an invalid pipeline stage");
    }
  }
  for (const row of tables.opportunities) {
    if (!["open", "won", "lost"].includes(String(row.status)) ||
      !Number.isFinite(Number(row.value)) || Number(row.value) < 0 ||
      !Number.isInteger(row.probability) || Number(row.probability) < 0 || Number(row.probability) > 100) {
      throw new ApiError(400, "Backup contains an invalid opportunity");
    }
  }
  for (const row of tables.tasks) {
    if (!["open", "completed", "cancelled"].includes(String(row.status)) ||
      !["low", "normal", "high", "urgent"].includes(String(row.priority))) {
      throw new ApiError(400, "Backup contains an invalid task");
    }
  }
  for (const row of tables.automation_rules) {
    let conditions: unknown;
    let actions: unknown;
    let elseActions: unknown;
    let authorityManifest: unknown;
    try {
      conditions = JSON.parse(String(row.conditions));
      actions = JSON.parse(String(row.actions));
      elseActions = JSON.parse(String(row.else_actions || "[]"));
      authorityManifest = JSON.parse(String(row.authority_manifest || "[]"));
    } catch {
      throw new ApiError(400, "Backup contains malformed automation JSON");
    }
    const customConditionError = Array.isArray(conditions)
      ? validateAutomationCustomMetadata(tables.custom_field_definitions as CustomFieldDefinition[],
        String(row.trigger_type), conditions, [
          ...(Array.isArray(actions) ? actions : []), ...(Array.isArray(elseActions) ? elseActions : []),
        ]) : "";
    if (!Array.isArray(conditions) || !Array.isArray(actions) || !Array.isArray(elseActions) ||
      !Array.isArray(authorityManifest) ||
      !["draft", "active", "paused"].includes(String(row.status)) ||
      !Number.isInteger(row.max_runs_per_record) || Number(row.max_runs_per_record) < 1 ||
      Number(row.max_runs_per_record) > 20 ||
      validateAutomationDefinition(String(row.trigger_type), conditions, actions) ||
      customConditionError ||
      validateAutomationDefinition(String(row.trigger_type), [], elseActions) ||
      JSON.stringify(authorityManifest) !== JSON.stringify(deriveWorkflowAuthority(actions, elseActions)) ||
      !/^[a-f0-9]{64}$/.test(String(row.authority_hash || ""))) {
      throw new ApiError(400, "Backup contains an invalid automation definition");
    }
  }
  const automationEvents = new Set<string>();
  for (const row of tables.automation_runs) {
    const key = `${row.rule_id}:${row.event_id}`;
    if (row.event_id !== null && automationEvents.has(key)) {
      throw new ApiError(400, "Backup contains duplicate automation events");
    }
    if (row.event_id !== null) automationEvents.add(key);
    let authorityManifest: unknown;
    try {
      authorityManifest = JSON.parse(String(row.authority_manifest || "[]"));
    } catch {
      throw new ApiError(400, "Backup contains malformed automation run authority");
    }
    if (!Array.isArray(authorityManifest) || !String(row.principal_id || "").startsWith("automation:") ||
      !["user", "integration", "agent"].includes(String(row.trigger_actor_type)) ||
      !String(row.trigger_actor_id || "") || !/^[a-f0-9]{64}$/.test(String(row.authority_hash || ""))) {
      throw new ApiError(400, "Backup contains invalid automation run authority");
    }
  }
  const connectorNames = new Set<string>();
  const connectorTokens = new Set<string>();
  for (const row of tables.visitor_connectors) {
    const nameKey = String(row.name).trim().toLowerCase();
    const tokenHash = String(row.token_hash);
    if (!["audiencelab", "rb2b"].includes(String(row.provider)) || !nameKey ||
      connectorNames.has(nameKey) || !/^[a-f0-9]{64}$/.test(tokenHash) ||
      connectorTokens.has(tokenHash) || ![0, 1].includes(Number(row.active)) ||
      !["unknown", "granted", "denied"].includes(String(row.consent_default))) {
      throw new ApiError(400, "Backup contains an invalid visitor connector");
    }
    connectorNames.add(nameKey);
    connectorTokens.add(tokenHash);
  }
  const activeMemberRows = await env.DB.prepare(
    "SELECT email FROM workspace_members WHERE workspace_id=? AND active=1",
  ).bind(workspaceId).all<{ email: string }>();
  const activeMemberEmails = new Set(activeMemberRows.results.map((row) => normalizeEmail(row.email)));
  const mailboxAliases = new Set<string>();
  const mailboxAccounts = new Set<string>();
  for (const row of tables.mailbox_connections) {
    const ownerEmail = normalizeEmail(row.owner_email);
    const aliasKey = `${row.provider}:${String(row.alias).trim().toLowerCase()}`;
    let capabilities: unknown;
    try { capabilities = JSON.parse(String(row.allowed_capabilities)); } catch {
      throw new ApiError(400, "Backup contains malformed mailbox capabilities");
    }
    const connectedAccountId = row.connected_account_id === null ? "" : String(row.connected_account_id);
    if (!["gmail", "outlook"].includes(String(row.provider)) || row.toolkit !== row.provider ||
      !ownerEmail || !activeMemberEmails.has(ownerEmail) || !String(row.alias).trim() ||
      mailboxAliases.has(aliasKey) || !String(row.auth_config_id).trim() ||
      row.composio_user_id !== await mailboxComposioUserId(workspaceId, ownerEmail) ||
      !["pending", "active", "expired", "disabled", "revoked", "error"].includes(String(row.status)) ||
      !Array.isArray(capabilities) || capabilities.some((capability) =>
        !mailboxCapabilities.has(String(capability))) ||
      capabilities.length !== new Set(capabilities.map(String)).size ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1 ||
      (connectedAccountId && mailboxAccounts.has(connectedAccountId))) {
      throw new ApiError(400, "Backup contains an invalid mailbox connection");
    }
    mailboxAliases.add(aliasKey);
    if (connectedAccountId) mailboxAccounts.add(connectedAccountId);
  }
  const audienceBatchKeys = new Set<string>();
  for (const row of tables.audience_imports) {
    const batchKey = `${row.connector_id}:${row.external_key}`;
    if (row.provider !== "audiencelab" || audienceBatchKeys.has(batchKey) ||
      !["interactive", "full_refresh", "incremental"].includes(String(row.mode)) ||
      !["unknown", "granted", "denied"].includes(String(row.consent_basis)) ||
      typeof row.list_name !== "string" || !row.list_name.trim() ||
      !Number.isInteger(row.requested_rows) || Number(row.requested_rows) < 1 ||
      !Number.isInteger(row.created_profiles) || Number(row.created_profiles) < 0 ||
      !Number.isInteger(row.updated_profiles) || Number(row.updated_profiles) < 0 ||
      !Number.isInteger(row.repeated_rows) || Number(row.repeated_rows) < 0 ||
      Number(row.created_profiles) + Number(row.updated_profiles) + Number(row.repeated_rows) !== Number(row.requested_rows)) {
      throw new ApiError(400, "Backup contains an invalid audience import");
    }
    try {
      if (!Array.isArray(JSON.parse(String(row.tags)))) throw new Error();
    } catch {
      throw new ApiError(400, "Backup contains invalid audience import tags");
    }
    audienceBatchKeys.add(batchKey);
  }
  const visitorIdentities = new Set<string>();
  for (const row of tables.visitor_profiles) {
    const identity = `${row.connector_id}:${row.identity_key}`;
    if (!["audiencelab", "rb2b"].includes(String(row.provider)) ||
      !["person", "company"].includes(String(row.identity_kind)) ||
      !["unknown", "granted", "denied"].includes(String(row.consent_status)) ||
      !["new", "reviewed", "promoted", "suppressed"].includes(String(row.review_status)) ||
      visitorIdentities.has(identity) || !Number.isInteger(row.visit_count) || Number(row.visit_count) < 0 ||
      !Number.isInteger(row.high_intent_count) || Number(row.high_intent_count) < 0 ||
      Number(row.high_intent_count) > Number(row.visit_count) ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1) {
      throw new ApiError(400, "Backup contains an invalid visitor profile");
    }
    try {
      if (!Array.isArray(JSON.parse(String(row.tags)))) throw new Error();
    } catch {
      throw new ApiError(400, "Backup contains invalid visitor profile tags");
    }
    visitorIdentities.add(identity);
  }
  const audienceRows = new Set<string>();
  const audienceMemberCounts = new Map<string, number>();
  for (const row of tables.audience_import_members) {
    const rowKey = `${row.import_id}:${row.row_key}`;
    if (audienceRows.has(rowKey) || !["created", "updated", "repeated"].includes(String(row.outcome))) {
      throw new ApiError(400, "Backup contains an invalid audience import member");
    }
    audienceRows.add(rowKey);
    audienceMemberCounts.set(String(row.import_id), (audienceMemberCounts.get(String(row.import_id)) || 0) + 1);
  }
  for (const row of tables.audience_imports) {
    if ((audienceMemberCounts.get(String(row.id)) || 0) !== Number(row.requested_rows)) {
      throw new ApiError(400, "Backup audience import row counts do not match membership");
    }
  }
  const visitorDedupeKeys = new Set<string>();
  for (const row of tables.visitor_events) {
    const dedupe = `${row.connector_id}:${row.dedupe_key}`;
    if (!["audiencelab", "rb2b"].includes(String(row.provider)) ||
      visitorDedupeKeys.has(dedupe) || ![0, 1].includes(Number(row.is_repeat)) ||
      ![0, 1].includes(Number(row.is_high_intent))) {
      throw new ApiError(400, "Backup contains an invalid visitor event");
    }
    try {
      if (!Array.isArray(JSON.parse(String(row.tags)))) throw new Error();
    } catch {
      throw new ApiError(400, "Backup contains invalid visitor event tags");
    }
    visitorDedupeKeys.add(dedupe);
  }
  const activeCaseDomains = new Set<string>();
  for (const row of tables.visitor_intent_cases) {
    let snapshot: unknown;
    try { snapshot = JSON.parse(String(row.evidence_snapshot)); } catch {
      throw new ApiError(400, "Backup contains malformed visitor intent case evidence");
    }
    const status = String(row.status);
    const domain = String(row.company_domain);
    if (!isPlainObject(snapshot) || !domain || visitorCompanyDomain(domain, null) !== domain ||
      !["new", "in_review", "resolved", "dismissed"].includes(status) ||
      !["low", "normal", "high", "urgent"].includes(String(row.priority)) ||
      !Number.isInteger(row.intent_score) || Number(row.intent_score) < 0 || Number(row.intent_score) > 100 ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1 ||
      (["new", "in_review"].includes(status) && activeCaseDomains.has(domain)) ||
      (["resolved", "dismissed"].includes(status) && !String(row.resolution_note || "").trim())) {
      throw new ApiError(400, "Backup contains an invalid visitor intent case");
    }
    if (["new", "in_review"].includes(status)) activeCaseDomains.add(domain);
  }
  return { tables, totalRows, counts: Object.fromEntries(recoveryTables.map((table) => [table, tables[table].length])) };
}
function recoveryInsertStatement(env: FrameworkEnv, table: RecoveryTable, sessionId: string, workspaceId: string) {
  const columns = recoverySpecs[table].columns;
  const projections = columns.map((column) => `json_extract(row_json,'$.${column}')`).join(",");
  return env.DB.prepare(`INSERT INTO ${table} (${columns.join(",")})
    SELECT ${projections} FROM recovery_rows
    WHERE session_id=? AND workspace_id=? AND table_name=? ORDER BY row_id`)
    .bind(sessionId, workspaceId, table);
}
function canonicalRecoveryRowSql(table: RecoveryTable, alias = table) {
  return `json_object(${recoverySpecs[table].columns.map((column) => `'${column}',${alias}.${column}`).join(",")})`;
}
function recoveryGuardCaptureStatement(env: FrameworkEnv, table: RecoveryTable, sessionId: string, workspaceId: string) {
  return env.DB.prepare(`INSERT INTO recovery_guard_rows (session_id,workspace_id,table_name,row_id,row_json)
    SELECT ?,?,? ,id,${canonicalRecoveryRowSql(table)} FROM ${table} WHERE workspace_id=? ORDER BY id`)
    .bind(sessionId, workspaceId, table, workspaceId);
}

async function ensureRecoveryStagingSchema(env: FrameworkEnv) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS recovery_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT DEFAULT 'ready' NOT NULL,
      backup_created_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      summary TEXT DEFAULT '{}' NOT NULL,
      expires_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE no action ON DELETE no action
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS recovery_sessions_workspace_status_idx
      ON recovery_sessions (workspace_id,status,expires_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS recovery_rows (
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (session_id,table_name,row_id),
      FOREIGN KEY (session_id) REFERENCES recovery_sessions(id) ON UPDATE no action ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE no action ON DELETE no action
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS recovery_rows_workspace_session_idx
      ON recovery_rows (workspace_id,session_id,table_name)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS recovery_guard_rows (
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (session_id,table_name,row_id),
      FOREIGN KEY (session_id) REFERENCES recovery_sessions(id) ON UPDATE no action ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON UPDATE no action ON DELETE no action
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS recovery_guard_rows_workspace_session_idx
      ON recovery_guard_rows (workspace_id,session_id,table_name)`),
  ]);
}
function exactRecoveryGuardSql(workspaceId: string, sessionId: string) {
  const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const workspaceParameter = sqlLiteral(workspaceId);
  const sessionParameter = sqlLiteral(sessionId);
  const tableGuards = recoveryTables.map((table) => `(
    NOT EXISTS(
      SELECT id,${canonicalRecoveryRowSql(table)} FROM ${table} WHERE workspace_id=${workspaceParameter}
      EXCEPT SELECT row_id,row_json FROM recovery_guard_rows WHERE session_id=${sessionParameter} AND workspace_id=${workspaceParameter} AND table_name='${table}'
    )
    AND NOT EXISTS(
      SELECT row_id,row_json FROM recovery_guard_rows WHERE session_id=${sessionParameter} AND workspace_id=${workspaceParameter} AND table_name='${table}'
      EXCEPT SELECT id,${canonicalRecoveryRowSql(table)} FROM ${table} WHERE workspace_id=${workspaceParameter}
    )
  )`);
  return tableGuards.join(" AND ");
}
async function exactRecoveryGuardMatches(env: FrameworkEnv, workspaceId: string, sessionId: string) {
  const result = await env.DB.prepare(`SELECT CASE WHEN ${exactRecoveryGuardSql(workspaceId, sessionId)} THEN 1 ELSE 0 END valid`)
    .first<{ valid: number }>();
  return result?.valid === 1;
}

function validateStoredProposalAction(raw: unknown): { action: StoredProposalAction } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw)); } catch { return { error: "Stored proposal action is malformed" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Stored proposal action is malformed" };
  const action = parsed as Json;
  if (action.type === "create_task") {
    const allowed = new Set(["type", "contact_id", "opportunity_id", "title", "priority", "due_at"]);
    if (Object.keys(action).some((key) => !allowed.has(key))) return { error: "Stored task action contains unsupported fields" };
    const title = typeof action.title === "string" ? action.title.trim() : "";
    const priority = action.priority === undefined ? "normal" : action.priority;
    const contactId = action.contact_id === undefined || action.contact_id === null ? null : action.contact_id;
    const opportunityId = action.opportunity_id === undefined || action.opportunity_id === null ? null : action.opportunity_id;
    const dueAt = action.due_at === undefined || action.due_at === null || action.due_at === "" ? null : action.due_at;
    if (!title || title.length > 200) return { error: "Stored task title is invalid" };
    if (!["low", "normal", "high", "urgent"].includes(String(priority))) return { error: "Stored task priority is invalid" };
    if (contactId !== null && (typeof contactId !== "string" || !/^con_[a-f0-9]{32}$/.test(contactId))) return { error: "Stored task contact is invalid" };
    if (opportunityId !== null && (typeof opportunityId !== "string" || !/^opp_[a-f0-9]{32}$/.test(opportunityId))) return { error: "Stored task opportunity is invalid" };
    if (dueAt !== null && (typeof dueAt !== "string" || !Number.isFinite(Date.parse(dueAt)))) return { error: "Stored task due date is invalid" };
    return {
      action: {
        type: "create_task", contact_id: contactId, opportunity_id: opportunityId, title,
        priority: priority as "low" | "normal" | "high" | "urgent", due_at: dueAt,
      },
    };
  }
  if (action.type === "update_opportunity") {
    const allowed = new Set(["type", "opportunity_id", "expected_updated_at", "changes"]);
    if (Object.keys(action).some((key) => !allowed.has(key))) return { error: "Stored opportunity action contains unsupported fields" };
    if (typeof action.opportunity_id !== "string" || !/^opp_[a-f0-9]{32}$/.test(action.opportunity_id)) {
      return { error: "Stored opportunity ID is invalid" };
    }
    if (typeof action.expected_updated_at !== "string" || !Number.isFinite(Date.parse(action.expected_updated_at))) {
      return { error: "Stored opportunity version is invalid" };
    }
    if (!action.changes || typeof action.changes !== "object" || Array.isArray(action.changes)) {
      return { error: "Stored opportunity changes are invalid" };
    }
    const input = action.changes as Json;
    const allowedChanges = new Set(["next_step", "owner", "expected_close_at", "value", "probability"]);
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !allowedChanges.has(key))) return { error: "Stored opportunity changes contain unsupported fields" };
    const changes: Json = {};
    for (const field of ["next_step", "owner", "expected_close_at"] as const) {
      if (!Object.hasOwn(input, field)) continue;
      const value = input[field];
      const max = field === "next_step" ? 500 : field === "owner" ? 200 : 50;
      if (value !== null && (typeof value !== "string" || value.trim().length > max)) return { error: `Stored ${field} is invalid` };
      const normalized = typeof value === "string" ? value.trim() : null;
      if (field === "expected_close_at" && normalized && !Number.isFinite(Date.parse(normalized))) {
        return { error: "Stored expected_close_at is invalid" };
      }
      changes[field] = normalized || null;
    }
    if (Object.hasOwn(input, "value")) {
      const value = input.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) return { error: "Stored value is invalid" };
      changes.value = value;
    }
    if (Object.hasOwn(input, "probability")) {
      const probability = input.probability;
      if (typeof probability !== "number" || !Number.isInteger(probability) || probability < 0 || probability > 100) {
        return { error: "Stored probability is invalid" };
      }
      changes.probability = probability;
    }
    return {
      action: {
        type: "update_opportunity", opportunity_id: action.opportunity_id,
        expected_updated_at: action.expected_updated_at, changes,
      },
    };
  }
  if (action.type === "update_contact") {
    const allowed = new Set(["type", "contact_id", "expected_updated_at", "changes"]);
    if (Object.keys(action).some((key) => !allowed.has(key))) return { error: "Stored contact action contains unsupported fields" };
    if (typeof action.contact_id !== "string" || !/^con_[a-f0-9]{32}$/.test(action.contact_id)) {
      return { error: "Stored contact ID is invalid" };
    }
    if (typeof action.expected_updated_at !== "string" || !Number.isFinite(Date.parse(action.expected_updated_at))) {
      return { error: "Stored contact version is invalid" };
    }
    if (!action.changes || typeof action.changes !== "object" || Array.isArray(action.changes)) {
      return { error: "Stored contact changes are invalid" };
    }
    const input = action.changes as Json;
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !["stage", "status", "owner", "custom_fields"].includes(key)) ||
      (keys.includes("custom_fields") && keys.length !== 1)) {
      return { error: "Stored contact changes contain unsupported fields" };
    }
    const changes: Json = {};
    if (Object.hasOwn(input, "stage")) {
      if (typeof input.stage !== "string" || !allowedStages.has(input.stage)) return { error: "Stored contact stage is invalid" };
      changes.stage = input.stage;
    }
    if (Object.hasOwn(input, "status")) {
      if (typeof input.status !== "string" || !allowedStatuses.has(input.status)) return { error: "Stored contact status is invalid" };
      changes.status = input.status;
    }
    if (Object.hasOwn(input, "owner")) {
      if (input.owner !== null && (typeof input.owner !== "string" || input.owner.trim().length > 254)) {
        return { error: "Stored contact owner is invalid" };
      }
      changes.owner = typeof input.owner === "string" ? input.owner.trim() || null : null;
    }
    if (Object.hasOwn(input, "custom_fields")) {
      if (!isPlainObject(input.custom_fields) || Object.keys(input.custom_fields).length !== 1) {
        return { error: "Stored contact custom-field changes are invalid" };
      }
      const [fieldKey, fieldValue] = Object.entries(input.custom_fields)[0];
      if (!/^[a-z][a-z0-9_]{1,39}$/.test(fieldKey) ||
        !["string", "number", "boolean"].includes(typeof fieldValue) ||
        (typeof fieldValue === "number" && !Number.isFinite(fieldValue))) {
        return { error: "Stored contact custom-field value is invalid" };
      }
      changes.custom_fields = { [fieldKey]: fieldValue };
    }
    return { action: { type: "update_contact", contact_id: action.contact_id,
      expected_updated_at: action.expected_updated_at, changes } };
  }
  if (action.type === "run_workflow") {
    const allowed = new Set(["type", "workflow_id", "workflow_updated_at", "record_type", "record_id"]);
    if (Object.keys(action).some((key) => !allowed.has(key))) return { error: "Stored workflow action contains unsupported fields" };
    if (typeof action.workflow_id !== "string" || !/^auto_[a-f0-9]{32}$/.test(action.workflow_id)) {
      return { error: "Stored workflow ID is invalid" };
    }
    if (typeof action.workflow_updated_at !== "string" || !Number.isFinite(Date.parse(action.workflow_updated_at))) {
      return { error: "Stored workflow version is invalid" };
    }
    if (!["contact", "opportunity"].includes(String(action.record_type))) return { error: "Stored workflow record type is invalid" };
    const recordPattern = action.record_type === "contact" ? /^con_[a-f0-9]{32}$/ : /^opp_[a-f0-9]{32}$/;
    if (typeof action.record_id !== "string" || !recordPattern.test(action.record_id)) return { error: "Stored workflow record ID is invalid" };
    return { action: {
      type: "run_workflow", workflow_id: action.workflow_id, workflow_updated_at: action.workflow_updated_at,
      record_type: action.record_type as "contact" | "opportunity", record_id: action.record_id,
    } };
  }
  if (action.type === "promote_visitor") {
    const allowed = new Set(["type", "visitor_profile_id", "expected_revision"]);
    if (Object.keys(action).some((key) => !allowed.has(key))) return { error: "Stored visitor promotion contains unsupported fields" };
    if (typeof action.visitor_profile_id !== "string" || !/^vpr_[a-f0-9]{32}$/.test(action.visitor_profile_id)) {
      return { error: "Stored visitor profile ID is invalid" };
    }
    if (typeof action.expected_revision !== "number" || !Number.isSafeInteger(action.expected_revision) || action.expected_revision < 1) {
      return { error: "Stored visitor profile revision is invalid" };
    }
    return { action: {
      type: "promote_visitor", visitor_profile_id: action.visitor_profile_id, expected_revision: action.expected_revision,
    } };
  }
  if (action.type === "open_intent_case") {
    const allowed = new Set(["type", "company_domain", "expected_evidence_updated_at", "priority", "due_at"]);
    if (Object.keys(action).some((key) => !allowed.has(key))) return { error: "Stored intent case action contains unsupported fields" };
    if (typeof action.company_domain !== "string" || visitorCompanyDomain(action.company_domain, null) !== action.company_domain) {
      return { error: "Stored intent case domain is invalid" };
    }
    if (typeof action.expected_evidence_updated_at !== "string" ||
      !Number.isFinite(Date.parse(action.expected_evidence_updated_at))) return { error: "Stored intent evidence version is invalid" };
    if (!["low", "normal", "high", "urgent"].includes(String(action.priority))) return { error: "Stored intent case priority is invalid" };
    if (typeof action.due_at !== "string" || !Number.isFinite(Date.parse(action.due_at))) return { error: "Stored intent case SLA is invalid" };
    return { action: {
      type: "open_intent_case", company_domain: action.company_domain,
      expected_evidence_updated_at: action.expected_evidence_updated_at,
      priority: action.priority as "low" | "normal" | "high" | "urgent", due_at: action.due_at,
    } };
  }
  return { error: "Stored proposal action type is unsupported" };
}

function contactScore(contact: Record<string, unknown>, revenue: number, now = Date.now()) {
  let score = 0;
  const reasons: string[] = [];
  if (contact.company) { score += 15; reasons.push("company identified"); }
  if (contact.phone) { score += 10; reasons.push("phone available"); }
  const stagePoints: Record<string, number> = { new: 0, registered: 15, confirmed: 25, attended: 35, offer: 45, booked: 55, won: 70 };
  const lifecyclePoints = stagePoints[String(contact.stage)] || 0;
  if (lifecyclePoints) { score += lifecyclePoints; reasons.push(`${String(contact.stage)} lifecycle`); }
  const activityAt = contact.last_activity_at ? Date.parse(String(contact.last_activity_at)) : 0;
  const ageDays = activityAt ? Math.floor((now - activityAt) / 86_400_000) : Number.POSITIVE_INFINITY;
  if (ageDays <= 3) { score += 15; reasons.push("active in the last 3 days"); }
  else if (ageDays <= 7) { score += 8; reasons.push("active in the last 7 days"); }
  if (revenue > 0) { score += 20; reasons.push("has attributed revenue"); }
  const followUpAt = contact.next_follow_up_at ? Date.parse(String(contact.next_follow_up_at)) : 0;
  if (followUpAt > now) { score += 5; reasons.push("follow-up scheduled"); }
  return { score: Math.min(100, score), reasons };
}

function jsonArray(value: unknown, field: string, maxItems = 50): unknown[] {
  if (!Array.isArray(value)) throw new ApiError(400, `${field} must be an array`);
  if (value.length > maxItems) throw new ApiError(400, `${field} cannot contain more than ${maxItems} items`);
  return value;
}

function requestId(request: Request) {
  return request.headers.get("cf-ray") || crypto.randomUUID();
}

async function audit(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown = null,
  after: unknown = null,
) {
  await (await auditStatement(env, access, request, action, entityType, entityId, before, after)).run();
}

async function auditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown = null,
  after: unknown = null,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id("audit"), access.workspaceId, "user", access.email, action, entityType, entityId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      requestId(request), ipHash, new Date().toISOString());
}

async function customObjectViewAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: "custom_object_view.created" | "custom_object_view.updated" | "custom_object_view.deleted",
  viewId: string,
  before: unknown,
  after: unknown,
  guard: { changeId?: string; revision?: number },
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  const guardSql = guard.changeId !== undefined ? "change_id=?" : "revision=?";
  const guardValue = guard.changeId !== undefined ? guard.changeId : guard.revision;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,?,'custom_object_view',?,?,?,?,?,?
    FROM custom_object_views WHERE workspace_id=? AND id=? AND ${guardSql}`)
    .bind(id("audit"), access.workspaceId, access.email, action, viewId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      requestId(request), ipHash, new Date().toISOString(),
      access.workspaceId, viewId, guardValue);
}

async function integrationAuditStatement(
  env: FrameworkEnv,
  workspaceId: string,
  connectorId: string,
  request: Request,
  action: string,
  entityType: string,
  entityId: string,
  after: unknown,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    VALUES(?,?,'integration',?,?,?,?,NULL,?,?,?,?)`)
    .bind(id("audit"), workspaceId, connectorId, action, entityType, entityId,
      JSON.stringify(after), requestId(request), ipHash, new Date().toISOString());
}

async function customFieldAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: string,
  definitionId: string,
  changeId: string,
  before: unknown,
  after: unknown,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,?,'custom_field',?,?,?,?,?,?
    FROM custom_field_definitions WHERE workspace_id=? AND id=? AND change_id=?`)
    .bind(id("audit"), access.workspaceId, access.email, action, definitionId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      requestId(request), ipHash, new Date().toISOString(),
      access.workspaceId, definitionId, changeId);
}

async function pageLayoutAuditStatement(
  env: FrameworkEnv, access: WorkspaceAccess, request: Request, layoutId: string,
  changeId: string, before: unknown, after: unknown,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,'workspace.page_layout_updated','page_layout',?,?,?,?,?,?
    FROM object_page_layouts WHERE workspace_id=? AND id=? AND change_id=?`)
    .bind(id("audit"), access.workspaceId, access.email, layoutId,
      before === null ? null : JSON.stringify(before), JSON.stringify(after),
      requestId(request), ipHash, new Date().toISOString(),
      access.workspaceId, layoutId, changeId);
}

type NormalizedAudienceImport = ReturnType<typeof normalizeAudienceImport>;
type AudienceImportConnector = { id: string; provider: string; name: string; active: number };

async function commitAudienceImport(
  env: FrameworkEnv,
  request: Request,
  workspaceId: string,
  connector: AudienceImportConnector,
  normalized: NormalizedAudienceImport,
  actor: { type: "user"; access: WorkspaceAccess } | { type: "integration"; connectorId: string },
) {
  const importId = id("aimp");
  const now = new Date().toISOString();
  const listTag = `audience:${normalized.listName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "list"}`;
  const importTags = [...new Set([listTag, ...normalized.tags])].slice(0, 20);
  const preparedRows = await Promise.all(normalized.rows.map(async (row) => {
    const identityKind = row.email || row.linkedinUrl ? "person" : "company";
    const identitySeed = row.linkedinUrl?.toLowerCase() || row.email || row.companyDomain;
    const identityKey = await sha256(`audiencelab\n${identityKind}\n${identitySeed}`);
    return { ...row, identityKind, identityKey, rowKey: await sha256(`${normalized.externalKey}\n${identityKey}`) };
  }));
  const createdBy = actor.type === "user" ? actor.access.email : `integration:${actor.connectorId}`;
  const auditAfter = {
    provider: "audiencelab", connector_id: connector.id, external_key: normalized.externalKey,
    list_name: normalized.listName, mode: normalized.mode, consent_basis: normalized.consentBasis,
    tags: importTags, requested_rows: preparedRows.length, contacts_created: 0, outreach_authorized: false,
  };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO audience_imports
      (id,workspace_id,connector_id,provider,external_key,list_name,mode,consent_basis,tags,requested_rows,
       created_profiles,updated_profiles,repeated_rows,created_by,created_at)
      VALUES(?,?,?,'audiencelab',?,?,?,?,?,?,0,0,0,?,?)`)
      .bind(importId, workspaceId, connector.id, normalized.externalKey, normalized.listName, normalized.mode,
        normalized.consentBasis, JSON.stringify(importTags), preparedRows.length, createdBy, now),
  ];
  for (const row of preparedRows) {
    const profileId = id("vpr");
    statements.push(
      env.DB.prepare(`INSERT INTO visitor_profiles
        (id,workspace_id,connector_id,provider,identity_key,identity_kind,email,first_name,last_name,linkedin_url,title,
         company_name,company_domain,industry,city,region,postal_code,consent_status,review_status,matched_contact_id,
         visit_count,high_intent_count,first_seen_at,last_seen_at,tags,revision,origin_import_id,created_at,updated_at)
        VALUES(?,?,?,'audiencelab',?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',
          (SELECT id FROM contacts WHERE workspace_id=? AND email=? LIMIT 1),0,0,?,?,?,1,?,?,?)
        ON CONFLICT(connector_id,identity_key) DO UPDATE SET
          email=COALESCE(excluded.email,visitor_profiles.email),
          first_name=COALESCE(excluded.first_name,visitor_profiles.first_name),
          last_name=COALESCE(excluded.last_name,visitor_profiles.last_name),
          linkedin_url=COALESCE(excluded.linkedin_url,visitor_profiles.linkedin_url),
          title=COALESCE(excluded.title,visitor_profiles.title),
          company_name=COALESCE(excluded.company_name,visitor_profiles.company_name),
          company_domain=COALESCE(excluded.company_domain,visitor_profiles.company_domain),
          industry=COALESCE(excluded.industry,visitor_profiles.industry),
          city=COALESCE(excluded.city,visitor_profiles.city),
          region=COALESCE(excluded.region,visitor_profiles.region),
          postal_code=COALESCE(excluded.postal_code,visitor_profiles.postal_code),
          consent_status=CASE
            WHEN visitor_profiles.consent_status='denied' OR excluded.consent_status='denied' THEN 'denied'
            WHEN visitor_profiles.consent_status='granted' OR excluded.consent_status='granted' THEN 'granted'
            ELSE 'unknown' END,
          matched_contact_id=COALESCE(visitor_profiles.matched_contact_id,excluded.matched_contact_id),
          tags=(SELECT json_group_array(value) FROM
            (SELECT value FROM json_each(visitor_profiles.tags)
             UNION SELECT value FROM json_each(excluded.tags) LIMIT 20)),
          revision=visitor_profiles.revision+1,updated_at=excluded.updated_at`)
        .bind(profileId, workspaceId, connector.id, row.identityKey, row.identityKind, row.email, row.firstName,
          row.lastName, row.linkedinUrl, row.title, row.companyName, row.companyDomain, row.industry, row.city,
          row.region, row.postalCode, row.consentStatus, workspaceId, row.email, now, now,
          JSON.stringify(importTags), importId, now, now),
      env.DB.prepare(`INSERT INTO audience_import_members
        (id,workspace_id,import_id,profile_id,row_key,outcome,created_at)
        SELECT ?,?,?,id,?,CASE WHEN origin_import_id=? THEN 'created' ELSE 'updated' END,?
        FROM visitor_profiles WHERE workspace_id=? AND connector_id=? AND identity_key=?`)
        .bind(id("aim"), workspaceId, importId, row.rowKey, importId, now, workspaceId, connector.id, row.identityKey),
    );
  }
  statements.push(
    env.DB.prepare(`UPDATE audience_imports SET
      created_profiles=(SELECT COUNT(*) FROM audience_import_members WHERE import_id=? AND outcome='created'),
      updated_profiles=(SELECT COUNT(*) FROM audience_import_members WHERE import_id=? AND outcome='updated'),
      repeated_rows=(SELECT COUNT(*) FROM audience_import_members WHERE import_id=? AND outcome='repeated')
      WHERE workspace_id=? AND id=?`).bind(importId, importId, importId, workspaceId, importId),
    actor.type === "user"
      ? await auditStatement(env, actor.access, request, "audience_import.committed", "audience_import", importId, null, auditAfter)
      : await integrationAuditStatement(env, workspaceId, actor.connectorId, request,
        "audience_import.committed", "audience_import", importId, auditAfter),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const duplicate = await env.DB.prepare(`SELECT id FROM audience_imports
      WHERE workspace_id=? AND connector_id=? AND external_key=?`)
      .bind(workspaceId, connector.id, normalized.externalKey).first<{ id: string }>();
    if (duplicate) {
      return actor.type === "integration"
        ? json({ ok: true, duplicate: true, import_id: duplicate.id })
        : json({ error: "This AudienceLab batch was already imported", code: "duplicate_batch", import_id: duplicate.id }, 409);
    }
    throw error;
  }
  const imported = await env.DB.prepare(`SELECT id,requested_rows,created_profiles,updated_profiles,repeated_rows
    FROM audience_imports WHERE workspace_id=? AND id=?`).bind(workspaceId, importId).first();
  return json({
    ok: true,
    import: imported,
    quarantine: { contacts_created: 0, outreach_authorized: false, promotion_requires_admin_review: true },
  }, 201);
}

async function proposalDecisionAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: string,
  proposalId: string,
  before: unknown,
  after: unknown,
  expectedStatus: string,
  reviewedAt: string,
  storedReviewedBy = access.email,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,?,'agent_proposal',?,?,?,?,?,?
    WHERE changes()>0 AND EXISTS(SELECT 1 FROM agent_proposals
      WHERE workspace_id=? AND id=? AND status=? AND reviewed_by=? AND reviewed_at=?)`)
    .bind(id("audit"), access.workspaceId, access.email, action, proposalId,
      JSON.stringify(before), JSON.stringify(after), requestId(request), ipHash, reviewedAt,
      access.workspaceId, proposalId, expectedStatus, storedReviewedBy, reviewedAt);
}

async function opportunityUpdateAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  opportunityId: string,
  before: unknown,
  after: unknown,
  expectedUpdatedAt: string,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,'opportunity.updated','opportunity',?,?,?,?,?,?
    WHERE changes()>0 AND EXISTS(SELECT 1 FROM opportunities WHERE workspace_id=? AND id=? AND updated_at=?)`)
    .bind(id("audit"), access.workspaceId, access.email, opportunityId,
      JSON.stringify(before), JSON.stringify(after), requestId(request), ipHash, expectedUpdatedAt,
      access.workspaceId, opportunityId, expectedUpdatedAt);
}

async function contactUpdateAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  contactId: string,
  before: unknown,
  after: unknown,
  expectedUpdatedAt: string,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,'contact.updated','contact',?,?,?,?,?,?
    WHERE changes()>0 AND EXISTS(SELECT 1 FROM contacts WHERE workspace_id=? AND id=? AND updated_at=?)`)
    .bind(id("audit"), access.workspaceId, access.email, contactId,
      JSON.stringify(before), JSON.stringify(after), requestId(request), ipHash, new Date().toISOString(),
      access.workspaceId, contactId, expectedUpdatedAt);
}

async function taskMutationAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: "task.updated" | "task.deleted",
  taskId: string,
  before: unknown,
  after: unknown,
  expectedUpdatedAt: string,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,?,'task',?,?,?,?,?,?
    WHERE (?=0 OR changes()>0) AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=? AND id=? AND updated_at=?)`)
    .bind(id("audit"), access.workspaceId, access.email, action, taskId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      requestId(request), ipHash, new Date().toISOString(), action === "task.updated" ? 1 : 0,
      access.workspaceId, taskId, expectedUpdatedAt);
}

async function automationMutationAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: "automation.definition_updated" | "automation.status_changed" | "automation.deleted",
  automationId: string,
  before: unknown,
  after: unknown,
  expectedUpdatedAt: string,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,?,'automation',?,?,?,?,?,?
    WHERE (?=0 OR changes()>0) AND EXISTS(SELECT 1 FROM automation_rules WHERE workspace_id=? AND id=? AND updated_at=?)`)
    .bind(id("audit"), access.workspaceId, access.email, action, automationId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      requestId(request), ipHash, new Date().toISOString(), action === "automation.deleted" ? 0 : 1,
      access.workspaceId, automationId, expectedUpdatedAt);
}

async function automationRunCancelAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  runId: string,
  before: unknown,
  expectedStatus: "running" | "canceled",
  finishedAt: string | null,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  const after = { ...(before as Record<string, unknown>), status: "canceled", finished_at: finishedAt };
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,'automation_run.canceled','automation_run',?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM automation_runs
      WHERE workspace_id=? AND id=? AND status=? AND (? IS NULL OR finished_at=?))`)
    .bind(id("audit"), access.workspaceId, access.email, runId, JSON.stringify(before), JSON.stringify(after),
      requestId(request), ipHash, finishedAt || new Date().toISOString(), access.workspaceId, runId,
      expectedStatus, finishedAt, finishedAt);
}

async function agentWorkItemRequeueAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  workItemId: string,
  before: unknown,
  after: unknown,
  expectedUpdatedAt: string,
  requeueAt: string,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,'agent.work_item_requeued','agent_work_item',?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM agent_work_items
      WHERE workspace_id=? AND id=? AND updated_at=?
        AND (status='failed' OR (status='claimed' AND claim_expires_at<=?)))`)
    .bind(id("audit"), access.workspaceId, access.email, workItemId, JSON.stringify(before), JSON.stringify(after),
      requestId(request), ipHash, requeueAt, access.workspaceId, workItemId, expectedUpdatedAt, requeueAt);
}

async function agentWorkItemCancelAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  workItemId: string,
  before: unknown,
  expectedUpdatedAt: string,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,'agent.work_item_canceled','agent_work_item',?,?,NULL,?,?,?
    WHERE EXISTS(SELECT 1 FROM agent_work_items
      WHERE workspace_id=? AND id=? AND status='queued' AND updated_at=?)`)
    .bind(id("audit"), access.workspaceId, access.email, workItemId, JSON.stringify(before),
      requestId(request), ipHash, new Date().toISOString(),
      access.workspaceId, workItemId, expectedUpdatedAt);
}

async function sourceMutationAuditStatement(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  request: Request,
  action: "source.revoked" | "source.purged",
  sourceId: string,
  before: unknown,
  after: unknown,
  expectedActive: 0 | 1,
) {
  const ip = request.headers.get("cf-connecting-ip");
  const ipHash = ip ? await sha256(ip) : null;
  return env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    SELECT ?,?,'user',?,?,'source',?,?,?,?,?,?
    WHERE (?=0 OR changes()>0) AND EXISTS(SELECT 1 FROM sources WHERE workspace_id=? AND id=? AND active=?)`)
    .bind(id("audit"), access.workspaceId, access.email, action, sourceId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      requestId(request), ipHash, new Date().toISOString(), action === "source.revoked" ? 1 : 0,
      access.workspaceId, sourceId, expectedActive);
}

async function systemAudit(
  env: FrameworkEnv,
  workspaceId: string,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  after: unknown,
) {
  await env.DB.prepare(`INSERT INTO audit_log
    (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id("audit"), workspaceId, "system", actorId, action, entityType, entityId,
      null, JSON.stringify(after), id("job"), null, new Date().toISOString()).run();
}

function isSafeWebhookUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
  return true;
}

function webhookRetryDelay(attempt: number, response?: Response) {
  const base = Math.min(3_600_000, 60_000 * 2 ** (attempt - 1));
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (!retryAfter) return base;
  const seconds = Number(retryAfter);
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(retryAfter) - Date.now();
  return Math.min(3_600_000, Math.max(base, Number.isFinite(requested) ? requested : 0));
}

function isRetryableWebhookStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function webhookProviderBody(
  endpoint: Record<string, unknown>,
  eventType: string,
  canonicalBody: string,
  providerCredential = "",
) {
  const preset = String(endpoint.payload_preset || "generic");
  if (preset === "slack" && eventType === "visitor_intent_case.created") {
    const event = JSON.parse(canonicalBody) as {
      id: string; created_at: string;
      data: {
        case_id: string; company_name: string; company_domain: string; priority: string; intent_score: number;
        attribution?: { contributing_sources?: string[]; visited_pages?: string[]; touch_count?: number };
        score_reasons?: Array<{ label: string }>;
      };
    };
    const escapeSlack = (value: unknown) => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const sources = (event.data.attribution?.contributing_sources || []).map(escapeSlack).join(", ") || "Unattributed";
    const pages = (event.data.attribution?.visited_pages || []).slice(-3).map((value) => {
      try { const url = new URL(value); return `${url.hostname}${url.pathname}`; } catch { return value; }
    }).map(escapeSlack).join(" · ") || "No page path retained";
    const reasons = (event.data.score_reasons || []).slice(0, 4).map((reason) => escapeSlack(reason.label)).join(" · ");
    const title = `${escapeSlack(event.data.company_name)} · intent ${Number(event.data.intent_score || 0)}/100`;
    return JSON.stringify({
      text: `Visitor research candidate: ${title}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Visitor research candidate*\n*${title}*\n${escapeSlack(event.data.company_domain)}` } },
        { type: "section", fields: [
          { type: "mrkdwn", text: `*Source*\n${sources}` },
          { type: "mrkdwn", text: `*Priority*\n${escapeSlack(event.data.priority)}` },
          { type: "mrkdwn", text: `*Touches*\n${Number(event.data.attribution?.touch_count || 0)}` },
          { type: "mrkdwn", text: `*Case*\n\`${escapeSlack(event.data.case_id)}\`` },
        ] },
        { type: "section", text: { type: "mrkdwn", text: `*Recent pages*\n${pages}${reasons ? `\n*Why it scored*\n${reasons}` : ""}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: "Research only · no person-level data · no outreach authorized" }] },
      ],
    });
  }
  if (preset === "generic" || !eventType.startsWith("operations.health.")) return canonicalBody;
  const event = JSON.parse(canonicalBody) as {
    id: string; created_at: string;
    data: {
      workspace_id: string; incident_id: string; component_ids: string[];
      escalation_step?: number; escalation_delay_minutes?: number;
    };
  };
  const recovered = eventType === "operations.health.recovered";
  const escalated = eventType === "operations.health.escalated";
  const state = recovered ? "RECOVERED" : escalated
    ? `ESCALATION ${event.data.escalation_step || ""}`.trim() : "ACTION REQUIRED";
  const components = event.data.component_ids.length ? event.data.component_ids.join(", ") : "operations";
  const delay = escalated && event.data.escalation_delay_minutes
    ? ` after ${event.data.escalation_delay_minutes} minutes` : "";
  const text = `OpenOperator CRM ${state}${delay}: ${components} · incident ${event.data.incident_id}`;
  if (preset === "pagerduty") {
    const base = {
      routing_key: providerCredential,
      event_action: recovered ? "resolve" : "trigger",
      dedup_key: event.data.incident_id,
    };
    if (recovered) return JSON.stringify(base);
    return JSON.stringify({
      ...base,
      payload: {
        summary: text.slice(0, 1024),
        source: "openoperator-crm",
        severity: "critical",
        timestamp: event.created_at,
        component: components.slice(0, 255),
        group: event.data.workspace_id.slice(0, 255),
        class: "operations-health",
        custom_details: {
          crm_incident_id: event.data.incident_id,
          escalation_step: event.data.escalation_step || null,
          escalation_delay_minutes: event.data.escalation_delay_minutes || null,
        },
      },
    });
  }
  if (preset === "slack") {
    return JSON.stringify({
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${state}* — OpenOperator CRM\n${components}\nIncident \`${event.data.incident_id}\`` } }],
    });
  }
  if (preset === "discord") return JSON.stringify({ content: text });
  if (preset === "teams") {
    return JSON.stringify({
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard", version: "1.4",
          body: [
            { type: "TextBlock", weight: "Bolder", text: `OpenOperator CRM · ${state}` },
            { type: "TextBlock", wrap: true, text: `Components: ${components}` },
            { type: "TextBlock", wrap: true, text: `Incident: ${event.data.incident_id}` },
          ],
        },
      }],
    });
  }
  return canonicalBody;
}

async function deliverOutboundWebhook(
  env: FrameworkEnv,
  endpoint: Record<string, unknown>,
  deliveryId: string,
  eventId: string,
  eventType: string,
  eventBody: string,
  attempt: number,
) {
  const destination = String(endpoint.url);
  const now = new Date().toISOString();
  try {
    if (!isSafeWebhookUrl(destination)) throw new Error("Destination is no longer allowed");
    const timestamp = String(Date.now());
    const secret = await decryptSecret(env, String(endpoint.secret_ciphertext));
    const providerCredential = endpoint.payload_preset === "pagerduty"
      ? await decryptSecret(env, String(endpoint.provider_credential_ciphertext || "")) : "";
    const providerBody = webhookProviderBody(endpoint, eventType, eventBody, providerCredential);
    const signature = await webhookSignature(secret, timestamp, providerBody);
    const response = await fetch(destination, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(8_000),
      headers: {
        "content-type": "application/json", "user-agent": "OpenOperator-Webhook/1.0",
        "x-crm-event-id": eventId, "x-crm-event-type": eventType,
        "x-crm-signature": `t=${timestamp},v1=${signature}`,
      },
      body: providerBody,
    });
    const excerpt = await responseExcerpt(response);
    const terminal = response.ok || !isRetryableWebhookStatus(response.status) || attempt >= 5;
    const status = response.ok ? "succeeded" : terminal ? "failed" : "retrying";
    const nextAttempt = terminal ? null : new Date(Date.now() + webhookRetryDelay(attempt, response)).toISOString();
    await env.DB.prepare(`UPDATE webhook_deliveries SET status=?,attempts=?,response_status=?,response_excerpt=?,
      next_attempt_at=?,updated_at=? WHERE id=?`)
      .bind(status, attempt, response.status, excerpt, nextAttempt, now, deliveryId).run();
    return { endpoint_id: String(endpoint.id), status, response_status: response.status };
  } catch (error) {
    const terminal = attempt >= 5;
    const status = terminal ? "failed" : "retrying";
    const nextAttempt = terminal ? null : new Date(Date.now() + webhookRetryDelay(attempt)).toISOString();
    await env.DB.prepare(`UPDATE webhook_deliveries SET status=?,attempts=?,response_status=NULL,response_excerpt=?,next_attempt_at=?,updated_at=? WHERE id=?`)
      .bind(status, attempt, error instanceof Error ? error.message.slice(0, 1000) : "Unknown delivery error",
        nextAttempt, now, deliveryId).run();
    return { endpoint_id: String(endpoint.id), status };
  }
}

async function processWebhookRetries(env: FrameworkEnv, workspaceId: string | null, limit: number) {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const terminalScope = workspaceId ? "workspace_id=? AND " : "";
  await env.DB.prepare(`UPDATE webhook_deliveries SET status='failed',
      response_excerpt='Delivery lease expired after the final attempt',next_attempt_at=NULL,updated_at=?
      WHERE ${terminalScope}direction='outbound' AND status='processing' AND updated_at<=? AND attempts>=5`)
    .bind(...(workspaceId ? [now, workspaceId, staleBefore] : [now, staleBefore])).run();
  const due = workspaceId
    ? await env.DB.prepare(`SELECT d.*,e.url,e.payload_preset,e.secret_ciphertext,e.provider_credential_ciphertext,e.active endpoint_active
        FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id AND e.workspace_id=d.workspace_id
        WHERE d.workspace_id=? AND d.direction='outbound'
          AND ((d.status='retrying' AND d.next_attempt_at<=?) OR (d.status='processing' AND d.updated_at<=?))
          AND d.attempts<5 AND e.active=1
        ORDER BY COALESCE(d.next_attempt_at,d.updated_at),d.id LIMIT ?`).bind(workspaceId, now, staleBefore, limit).all<Record<string, unknown>>()
    : await env.DB.prepare(`SELECT d.*,e.url,e.payload_preset,e.secret_ciphertext,e.provider_credential_ciphertext,e.active endpoint_active
        FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id AND e.workspace_id=d.workspace_id
        WHERE d.direction='outbound'
          AND ((d.status='retrying' AND d.next_attempt_at<=?) OR (d.status='processing' AND d.updated_at<=?))
          AND d.attempts<5 AND e.active=1
        ORDER BY COALESCE(d.next_attempt_at,d.updated_at),d.id LIMIT ?`).bind(now, staleBefore, limit).all<Record<string, unknown>>();
  const results: Array<{ workspace_id: string; endpoint_id: string; status: string; response_status?: number }> = [];
  for (const delivery of due.results) {
    const claimed = await env.DB.prepare(`UPDATE webhook_deliveries SET status='processing',attempts=attempts+1,updated_at=?
      WHERE workspace_id=? AND id=? AND status=? AND attempts=? AND updated_at=?`)
      .bind(new Date().toISOString(), delivery.workspace_id, delivery.id, delivery.status, delivery.attempts, delivery.updated_at).run();
    if (!claimed.meta.changes) continue;
    let event: { id?: string; type?: string };
    try {
      event = JSON.parse(String(delivery.request_body)) as { id?: string; type?: string };
    } catch {
      await env.DB.prepare("UPDATE webhook_deliveries SET status='failed',response_excerpt='Stored event is invalid',next_attempt_at=NULL,updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), delivery.id).run();
      results.push({ workspace_id: String(delivery.workspace_id), endpoint_id: String(delivery.endpoint_id), status: "failed" });
      continue;
    }
    const result = await deliverOutboundWebhook(
      env, { ...delivery, id: delivery.endpoint_id }, String(delivery.id),
      String(event.id || delivery.event_id), String(event.type || "unknown"),
      String(delivery.request_body), Number(delivery.attempts) + 1,
    );
    results.push({ workspace_id: String(delivery.workspace_id), ...result });
  }
  return { due: due.results.length, results };
}

async function responseExcerpt(response: Response, limit = 1000) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - total;
    chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value);
    total += Math.min(value.byteLength, remaining);
    if (value.byteLength > remaining) { await reader.cancel(); break; }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function automationConditionMatches(record: Record<string, unknown>, condition: unknown) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return false;
  const item = condition as Json;
  const field = typeof item.field === "string" ? item.field : "";
  const operator = typeof item.operator === "string" ? item.operator : "equals";
  const customKey = field.match(/^custom:([a-z][a-z0-9_]{1,39})$/)?.[1];
  if (!customKey && !automationCatalog.conditionFields.some((candidate) => candidate.id === field)) return false;
  let actual = record[field];
  if (customKey) {
    try {
      const parsed = typeof record.custom_fields === "string" ? JSON.parse(record.custom_fields) : record.custom_fields;
      if (!isPlainObject(parsed) || !Object.hasOwn(parsed, customKey)) return operator === "not_equals";
      actual = parsed[customKey];
    } catch { return false; }
  }
  if (operator === "equals") return actual === item.value;
  if (operator === "not_equals") return actual !== item.value;
  if (operator === "greater_than") return Number(actual) > Number(item.value);
  if (operator === "less_than") return Number(actual) < Number(item.value);
  return false;
}

const automationOpportunityVariables = new Set(
  automationCatalog.variables.opportunity.map((variable) => variable.token.slice(2, -2)),
);
const automationContactVariables = new Set(
  automationCatalog.variables.contact.map((variable) => variable.token.slice(2, -2)),
);

function automationRecordType(triggerType: string) {
  return triggerType.startsWith("contact.") ? "contact" : "opportunity";
}

const workflowStepIdPattern = /^step_[a-f0-9]{32}$/;
const automationCustomVariablePattern = /^(contact|opportunity)\.custom\.([a-z][a-z0-9_]{1,39})$/;
type WorkflowStepOutputs = Map<string, Record<string, string>>;

function automationCustomVariableReferences(value: unknown) {
  const references = new Set<string>();
  const visit = (candidate: unknown) => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/\{\{([^{}]+)\}\}/g)) {
        const variable = match[1].trim();
        if (automationCustomVariablePattern.test(variable)) references.add(variable);
      }
    } else if (Array.isArray(candidate)) candidate.forEach(visit);
    else if (isPlainObject(candidate)) Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...references].sort();
}

function normalizeAutomationActions(actions: unknown[]) {
  return actions.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const action = { ...(candidate as Json) };
    if (action.step_id === undefined) action.step_id = id("step");
    if (action.output_schema_version === undefined) action.output_schema_version = 1;
    return action;
  });
}

function validateAutomationTemplate(value: string, recordType: "contact" | "opportunity" = "opportunity",
  priorStepOutputs: WorkflowStepOutputs = new Map()) {
  const allowedVariables = recordType === "contact" ? automationContactVariables : automationOpportunityVariables;
  const matches = [...value.matchAll(/\{\{([^{}]+)\}\}/g)];
  for (const match of matches) {
    const variable = match[1].trim();
    if (allowedVariables.has(variable)) continue;
    const customReference = variable.match(automationCustomVariablePattern);
    if (customReference) {
      if (customReference[1] !== recordType) return `Automation variable belongs to another object: ${variable}`;
      continue;
    }
    const stepReference = variable.match(/^steps\.(step_[a-f0-9]{32})\.([a-z][a-z0-9_]*)$/);
    if (!stepReference) return `Unsupported automation variable: ${variable}`;
    const available = priorStepOutputs.get(stepReference[1]);
    if (!available) return `Automation variable must reference an earlier step in the same branch: ${variable}`;
    if (!Object.hasOwn(available, stepReference[2])) {
      return `Automation step output is unsupported: ${variable}`;
    }
  }
  const withoutKnownTokens = value.replace(/\{\{([^{}]+)\}\}/g, "");
  if (withoutKnownTokens.includes("{{") || withoutKnownTokens.includes("}}")) return "Automation variable syntax is invalid";
  return "";
}

function resolveAutomationTemplate(value: string, record: Record<string, unknown>, maxLength: number, field: string,
  recordType: "contact" | "opportunity" = "opportunity", stepOutputs: WorkflowStepOutputs = new Map()) {
  const allowedVariables = recordType === "contact" ? automationContactVariables : automationOpportunityVariables;
  const prefix = `${recordType}.`;
  const resolved = value.replace(/\{\{([^{}]+)\}\}/g, (_, rawVariable: string) => {
    const variable = rawVariable.trim();
    if (allowedVariables.has(variable)) {
      const recordValue = record[variable.slice(prefix.length)];
      return recordValue === null || recordValue === undefined ? "" : String(recordValue);
    }
    const customReference = variable.match(automationCustomVariablePattern);
    if (customReference && customReference[1] === recordType) {
      let customFields: unknown;
      try {
        customFields = typeof record.custom_fields === "string"
          ? JSON.parse(record.custom_fields) : record.custom_fields;
      } catch {
        throw new Error(`${field} cannot read malformed governed field data`);
      }
      if (!isPlainObject(customFields)) throw new Error(`${field} cannot read governed field data`);
      const recordValue = customFields[customReference[2]];
      return recordValue === null || recordValue === undefined ? "" : String(recordValue);
    }
    const stepReference = variable.match(/^steps\.(step_[a-f0-9]{32})\.([a-z][a-z0-9_]*)$/);
    if (!stepReference) throw new Error(`Unsupported automation variable: ${variable}`);
    const output = stepOutputs.get(stepReference[1]);
    if (!output || !Object.hasOwn(output, stepReference[2])) {
      throw new Error(`Automation step output is unavailable: ${variable}`);
    }
    return output[stepReference[2]];
  });
  if (!resolved.trim()) throw new Error(`${field} resolved to an empty value`);
  if (resolved.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters after variable resolution`);
  return resolved;
}

function validateAutomationDefinition(triggerType: string, conditions: unknown[], actions: unknown[]) {
  if (!automationCatalog.triggers.some((trigger) => trigger.id === triggerType)) return "Unsupported automation trigger";
  const recordType = automationRecordType(triggerType);
  const supportedConditionFields: AutomationConditionField[] = automationCatalog.conditionFields
    .filter((field) => (field.recordTypes as readonly RecordType[]).includes(recordType))
    .map((field) => field.id);
  for (const condition of conditions) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) return "Automation conditions must be objects";
    const item = condition as Json;
    if (Object.keys(item).some((key) => !["field", "operator", "value"].includes(key))) return "Automation condition contains unsupported fields";
    const customField = typeof item.field === "string" && /^custom:[a-z][a-z0-9_]{1,39}$/.test(item.field);
    if (typeof item.field !== "string" || (!customField && !supportedConditionFields.some((field) => field === item.field))) {
      return "Automation condition field is unsupported";
    }
    const conditionManifest = automationCatalog.conditionFields.find((field) => field.id === item.field);
    const supportedOperators = customField
      ? ["equals", "not_equals", "greater_than", "less_than"]
      : conditionManifest?.operators as readonly string[] | undefined;
    if (item.operator !== undefined && (typeof item.operator !== "string" ||
      !supportedOperators?.includes(item.operator))) {
      return "Automation condition operator is unsupported";
    }
    if (!Object.hasOwn(item, "value")) return "Automation condition value is required";
    const operator = item.operator === undefined ? "equals" : item.operator;
    if (!customField && conditionManifest?.valueType !== "number" &&
      !(conditionManifest?.operators as readonly string[] | undefined)?.includes(String(operator))) {
      return "Text automation conditions support only equals or not equals";
    }
    if (item.field === "status" && (typeof item.value !== "string" ||
      !(recordType === "contact" ? allowedStatuses : new Set(["open", "won", "lost", "abandoned"])).has(item.value))) {
      return `Automation ${recordType} status is invalid`;
    }
    if (item.field === "stage" && (typeof item.value !== "string" || !allowedStages.has(item.value))) return "Automation contact stage is invalid";
    if (item.field === "stage_id" && (typeof item.value !== "string" || !/^stage_[a-z0-9_]+$/.test(item.value))) {
      return "Automation pipeline stage is invalid";
    }
    if (item.field === "owner" && (typeof item.value !== "string" || !item.value.trim() || item.value.length > 254)) {
      return "Automation owner is invalid";
    }
    if (item.field === "source_last" && (typeof item.value !== "string" || !item.value.trim() || item.value.length > 160)) {
      return "Automation contact source is invalid";
    }
    if (item.field === "score" && (typeof item.value !== "number" || !Number.isFinite(item.value) ||
      item.value < 0 || item.value > 100)) return "Automation contact score is invalid";
    if (item.field === "probability" && (typeof item.value !== "number" || !Number.isFinite(item.value) ||
      item.value < 0 || item.value > 100)) {
      return "Automation probability is invalid";
    }
    if (item.field === "value" && (typeof item.value !== "number" || !Number.isFinite(item.value) ||
      item.value < 0 || item.value > 100_000_000)) {
      return "Automation opportunity value is invalid";
    }
  }
  const priorStepOutputs: WorkflowStepOutputs = new Map();
  const seenStepIds = new Set<string>();
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) return "Automation actions must be objects";
    const item = action as Json;
    if (item.step_id !== undefined && (typeof item.step_id !== "string" || !workflowStepIdPattern.test(item.step_id))) {
      return "Automation step ID is invalid";
    }
    if (item.step_id !== undefined && seenStepIds.has(item.step_id)) return "Automation step IDs must be unique within a branch";
    if (typeof item.step_id === "string") seenStepIds.add(item.step_id);
    if (item.output_schema_version !== undefined && item.output_schema_version !== 1) {
      return "Automation output schema version is unsupported";
    }
    const allowedIdentityFields = ["step_id", "output_schema_version"];
    if (item.type === "create_task") {
      if (Object.keys(item).some((key) => !["type", "title", "priority", "due_in_minutes", "approval_required", ...allowedIdentityFields].includes(key))) return "Automation task contains unsupported fields";
      if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 200) return "Automation task title is invalid";
      const templateError = validateAutomationTemplate(item.title, recordType, priorStepOutputs);
      if (templateError) return templateError;
      if (item.priority !== undefined && (typeof item.priority !== "string" || !["low", "normal", "high", "urgent"].includes(item.priority))) return "Automation task priority is invalid";
      if (item.due_in_minutes !== undefined && (typeof item.due_in_minutes !== "number" || !Number.isFinite(item.due_in_minutes) || item.due_in_minutes < 0 || item.due_in_minutes > 525_600)) return "Automation task delay is invalid";
      if (item.approval_required !== undefined && typeof item.approval_required !== "boolean") return "Automation approval setting is invalid";
      if (typeof item.step_id === "string") {
        priorStepOutputs.set(item.step_id, item.approval_required === true ? { proposal_id: "" } : { task_id: "" });
      }
      continue;
    }
    if (item.type === "add_note") {
      if (Object.keys(item).some((key) => !["type", "body", ...allowedIdentityFields].includes(key))) return "Automation note contains unsupported fields";
      if (typeof item.body !== "string" || !item.body.trim() || item.body.length > 4000) return "Automation note body is invalid";
      const templateError = validateAutomationTemplate(item.body, recordType, priorStepOutputs);
      if (templateError) return templateError;
      if (typeof item.step_id === "string") priorStepOutputs.set(item.step_id, { note_id: "" });
      continue;
    }
    if (item.type === "update_opportunity") {
      if (recordType !== "opportunity") return "Contact automations cannot update opportunities";
      if (Object.keys(item).some((key) => !["type", "field", "value", "approval_required", ...allowedIdentityFields].includes(key))) return "Automation opportunity update contains unsupported fields";
      if (!["next_step", "owner", "probability"].includes(String(item.field))) return "Automation opportunity update field is invalid";
      if (item.approval_required !== true) return "Automation opportunity updates require human approval";
      if (item.field === "probability" && (typeof item.value !== "number" || !Number.isInteger(item.value) || item.value < 0 || item.value > 100)) return "Automation opportunity probability is invalid";
      if (item.field !== "probability" && (typeof item.value !== "string" || !item.value.trim() || item.value.length > (item.field === "next_step" ? 500 : 254))) return "Automation opportunity update value is invalid";
      if (typeof item.value === "string") {
        const templateError = validateAutomationTemplate(item.value, recordType, priorStepOutputs);
        if (templateError) return templateError;
      }
      if (typeof item.step_id === "string") priorStepOutputs.set(item.step_id, { proposal_id: "" });
      continue;
    }
    if (item.type === "update_contact") {
      if (recordType !== "contact") return "Opportunity automations cannot update contacts";
      if (Object.keys(item).some((key) => !["type", "field", "value", "approval_required", ...allowedIdentityFields].includes(key))) {
        return "Automation contact update contains unsupported fields";
      }
      const customUpdate = typeof item.field === "string" && /^custom:[a-z][a-z0-9_]{1,39}$/.test(item.field);
      if (!customUpdate && !["stage", "status", "owner"].includes(String(item.field))) return "Automation contact update field is invalid";
      if (item.approval_required !== true) return "Automation contact updates require human approval";
      if (item.field === "stage" && (typeof item.value !== "string" || !allowedStages.has(item.value))) {
        return "Automation contact stage is invalid";
      }
      if (item.field === "status" && (typeof item.value !== "string" || !allowedStatuses.has(item.value))) {
        return "Automation contact status is invalid";
      }
      if (item.field === "owner" && (typeof item.value !== "string" || item.value.length > 254)) {
        return "Automation contact owner is invalid";
      }
      if (!customUpdate && typeof item.value === "string") {
        const templateError = validateAutomationTemplate(item.value, recordType, priorStepOutputs);
        if (templateError) return templateError;
      }
      if (typeof item.step_id === "string") priorStepOutputs.set(item.step_id, { proposal_id: "" });
      continue;
    }
    if (item.type === "request_agent") {
      if (Object.keys(item).some((key) => !["type", "objective", "instructions", "preferred_provider", ...allowedIdentityFields].includes(key))) return "Automation agent request contains unsupported fields";
      if (!["lead_research", "deal_review", "follow_up_draft", "call_brief"].includes(String(item.objective))) return "Automation agent objective is invalid";
      if (typeof item.instructions !== "string" || !item.instructions.trim() || item.instructions.length > 1000) return "Automation agent instructions are invalid";
      const templateError = validateAutomationTemplate(item.instructions, recordType, priorStepOutputs);
      if (templateError) return templateError;
      if (!["any", "openclaw", "hermes"].includes(String(item.preferred_provider))) return "Automation agent provider is invalid";
      if (typeof item.step_id === "string") priorStepOutputs.set(item.step_id, { work_item_id: "" });
      continue;
    }
    if (item.type === "publish_event") {
      if (Object.keys(item).some((key) => !["type", ...allowedIdentityFields].includes(key))) return "Automation integration event contains unsupported fields";
      if (typeof item.step_id === "string") priorStepOutputs.set(item.step_id, { event_id: "" });
      continue;
    }
    return "Unsupported automation action";
  }
  return "";
}

function validateAutomationCustomMetadata(
  definitions: CustomFieldDefinition[],
  triggerType: string,
  conditions: unknown[],
  actions: unknown[] = [],
) {
  const objectType = automationRecordType(triggerType);
  const byKey = new Map(definitions.filter((definition) =>
    definition.object_type === objectType && definition.active).map((definition) => [definition.field_key, definition]));
  for (const raw of conditions) {
    if (!isPlainObject(raw) || typeof raw.field !== "string" || !raw.field.startsWith("custom:")) continue;
    const key = raw.field.slice(7);
    const definition = byKey.get(key);
    if (!definition) return `Automation custom field is unknown, archived, or belongs to another object: ${key}`;
    const operator = typeof raw.operator === "string" ? raw.operator : "equals";
    const allowedOperators = definition.field_type === "number"
      ? ["equals", "not_equals", "greater_than", "less_than"] : ["equals", "not_equals"];
    if (!allowedOperators.includes(operator)) return `${definition.label} does not support ${operator.replaceAll("_", " ")}`;
    try { customFieldValue(definition, raw.value); }
    catch (error) { return error instanceof ApiError ? `Automation condition: ${error.message}` : "Automation custom-field condition is invalid"; }
  }
  for (const raw of actions) {
    if (!isPlainObject(raw) || raw.type !== "update_contact" || typeof raw.field !== "string" ||
      !raw.field.startsWith("custom:")) continue;
    if (objectType !== "contact") return "Only Contact workflows can update Contact custom fields";
    const key = raw.field.slice(7);
    const definition = byKey.get(key);
    if (!definition) return `Automation custom field is unknown, archived, or belongs to another object: ${key}`;
    try { customFieldValue(definition, raw.value); }
    catch (error) { return error instanceof ApiError ? `Automation action: ${error.message}` : "Automation custom-field action is invalid"; }
  }
  for (const variable of automationCustomVariableReferences(actions)) {
    const reference = variable.match(automationCustomVariablePattern);
    if (!reference || reference[1] !== objectType) {
      return `Automation variable belongs to another object: ${variable}`;
    }
    if (!byKey.has(reference[2])) {
      return `Automation variable references an unknown or archived field: ${reference[2]}`;
    }
  }
  return "";
}

async function validateStoredAutomationCustomMetadata(
  env: FrameworkEnv, workspaceId: string, triggerType: string, conditions: unknown[], actions: unknown[] = [],
) {
  const definitions = await env.DB.prepare(`SELECT * FROM custom_field_definitions
    WHERE workspace_id=? AND active=1`).bind(workspaceId).all<CustomFieldDefinition>();
  return validateAutomationCustomMetadata(definitions.results, triggerType, conditions, actions);
}

async function automationDefinitionHealth(
  rule: Record<string, unknown>,
  definitions: CustomFieldDefinition[],
) {
  try {
    const conditions = JSON.parse(String(rule.conditions || "[]"));
    const actions = JSON.parse(String(rule.actions || "[]"));
    const elseActions = JSON.parse(String(rule.else_actions || "[]"));
    if (!Array.isArray(conditions) || !Array.isArray(actions) || !Array.isArray(elseActions)) {
      return { metadata_status: "blocked", metadata_error: "Stored workflow definition is unreadable" };
    }
    const definitionError = validateAutomationDefinition(String(rule.trigger_type), conditions, actions) ||
      validateAutomationDefinition(String(rule.trigger_type), [], elseActions);
    if (definitionError) return { metadata_status: "blocked", metadata_error: definitionError };
    const metadataError = validateAutomationCustomMetadata(definitions, String(rule.trigger_type), conditions,
      [...actions, ...elseActions]);
    if (metadataError) return { metadata_status: "blocked", metadata_error: metadataError };
    const authority = await workflowAuthority(actions, elseActions);
    if (String(rule.authority_manifest || "[]") !== authority.serialized ||
      String(rule.authority_hash || "") !== authority.hash) {
      return { metadata_status: "blocked", metadata_error: "Workflow authority no longer matches its definition" };
    }
    return { metadata_status: "ready", metadata_error: null };
  } catch {
    return { metadata_status: "blocked", metadata_error: "Stored workflow definition is unreadable" };
  }
}

function validateWorkflowStepIdentity(actions: unknown[], elseActions: unknown[]) {
  const seen = new Set<string>();
  for (const candidate of [...actions, ...elseActions]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const stepId = (candidate as Json).step_id;
    if (typeof stepId !== "string") continue;
    if (seen.has(stepId)) return "Automation step IDs must be unique across MATCH and ELSE branches";
    seen.add(stepId);
  }
  return "";
}

function appendWorkflowActionOutput(
  output: Array<Record<string, unknown>>,
  stepOutputs: WorkflowStepOutputs,
  action: Json,
  entry: Record<string, unknown>,
) {
  const stepId = typeof action.step_id === "string" && workflowStepIdPattern.test(action.step_id)
    ? action.step_id
    : null;
  const traced = stepId ? { ...entry, step_id: stepId, output_schema_version: 1 } : entry;
  output.push(traced);
  if (!stepId) return;
  const values: Record<string, string> = {};
  for (const key of ["task_id", "proposal_id", "note_id", "work_item_id", "event_id"]) {
    if (typeof entry[key] === "string") values[key] = entry[key] as string;
  }
  stepOutputs.set(stepId, values);
}

function deriveWorkflowAuthority(actions: unknown[], elseActions: unknown[]) {
  const capabilities = new Set<string>();
  for (const candidate of [...actions, ...elseActions]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const action = candidate as Json;
    if (action.type === "create_task") {
      capabilities.add(action.approval_required === true ? "proposal.create:task" : "task.create");
    } else if (action.type === "add_note") {
      capabilities.add("note.create");
    } else if (action.type === "update_contact") {
      capabilities.add("proposal.create:contact_update");
    } else if (action.type === "update_opportunity") {
      capabilities.add("proposal.create:opportunity_update");
    } else if (action.type === "request_agent") {
      capabilities.add("agent_work.enqueue");
    } else if (action.type === "publish_event") {
      capabilities.add("integration.publish");
    }
  }
  for (const variable of automationCustomVariableReferences([actions, elseActions])) {
    const reference = variable.match(automationCustomVariablePattern);
    if (reference) capabilities.add(`custom_field.read:${reference[1]}:${reference[2]}`);
  }
  return [...capabilities].sort();
}

async function workflowAuthority(actions: unknown[], elseActions: unknown[]) {
  const manifest = deriveWorkflowAuthority(actions, elseActions);
  const serialized = JSON.stringify(manifest);
  return { manifest, serialized, hash: await sha256(`workflow-authority:v1:${serialized}`) };
}

function triggerActor(access: WorkspaceAccess) {
  return {
    type: access.role === "integration" ? "integration" : "user",
    id: access.email,
  };
}

async function assertWorkflowAuthority(rule: Record<string, unknown>, actions: unknown[], elseActions: unknown[]) {
  const expected = await workflowAuthority(actions, elseActions);
  if (String(rule.authority_manifest || "[]") !== expected.serialized ||
      String(rule.authority_hash || "") !== expected.hash) {
    throw new Error("Workflow authority does not match its action graph; pause and re-activate the workflow");
  }
  return expected;
}

async function prepareWorkflowEvent(
  env: FrameworkEnv,
  workspaceId: string,
  rule: Record<string, unknown>,
  runId: string,
  eventId: string,
  actionIndex: number,
  recordType: "contact" | "opportunity",
  record: Record<string, unknown>,
  now: string,
) {
  const eventType = `${recordType}.workflow_event`;
  const workflowEventId = `workflow:${runId}:${actionIndex}`;
  const safeRecord = recordType === "contact"
    ? {
        id: record.id, email: record.email, first_name: record.first_name, last_name: record.last_name,
        company: record.company, status: record.status, stage: record.stage, owner: record.owner,
        score: record.score, source_last: record.source_last,
      }
    : {
        id: record.id, contact_id: record.contact_id, name: record.name, status: record.status,
        stage_id: record.stage_id, value: record.value, currency: record.currency,
        probability: record.probability, owner: record.owner, next_step: record.next_step,
        expected_close_at: record.expected_close_at,
      };
  const eventBody = JSON.stringify({
    id: workflowEventId,
    type: eventType,
    created_at: now,
    data: {
      workspace_id: workspaceId,
      workflow: { id: rule.id, name: rule.name, run_id: runId, source_event_id: eventId, action_index: actionIndex },
      record_type: recordType,
      record: safeRecord,
    },
  });
  const endpoints = await env.DB.prepare(`SELECT id FROM webhook_endpoints
    WHERE workspace_id=? AND direction='outbound' AND active=1
      AND (event_types='[]' OR EXISTS (SELECT 1 FROM json_each(event_types) WHERE value IN (?, '*')))
    ORDER BY created_at LIMIT 20`).bind(workspaceId, eventType).all<{ id: string }>();
  const statements = endpoints.results.map((endpoint) => env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries
    (id,workspace_id,endpoint_id,event_id,direction,status,attempts,request_body,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,'retrying',0,?,?,?,?)`)
    .bind(id("delivery"), workspaceId, endpoint.id, workflowEventId, "outbound", eventBody, now, now, now));
  return { eventType, workflowEventId, endpointCount: endpoints.results.length, statements };
}

async function validateAutomationStageReferences(env: FrameworkEnv, workspaceId: string, conditions: unknown[]) {
  const stageIds = [...new Set(conditions.flatMap((condition) => {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) return [];
    const item = condition as Json;
    return item.field === "stage_id" && typeof item.value === "string" ? [item.value] : [];
  }))];
  if (!stageIds.length) return "";
  const result = await env.DB.prepare(`SELECT COUNT(*) total FROM pipeline_stages s
    JOIN json_each(?) requested ON requested.value=s.id WHERE s.workspace_id=?`)
    .bind(JSON.stringify(stageIds), workspaceId).first<{ total: number }>();
  return Number(result?.total || 0) === stageIds.length ? "" : "Automation pipeline stage is not available in this workspace";
}

async function runOpportunityAutomations(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  opportunity: Record<string, unknown>,
  eventId: string,
  triggerType: "opportunity.created" | "opportunity.stage_changed" | "opportunity.manual" = "opportunity.stage_changed",
  options: { onlyRuleId?: string; retryOfRunId?: string; actor?: { type: string; id: string } } = {},
) {
  const rules = await env.DB.prepare(`SELECT * FROM automation_rules
    WHERE workspace_id=? AND status='active' AND trigger_type=? AND (? IS NULL OR id=?)
    ORDER BY created_at LIMIT 50`)
    .bind(access.workspaceId, triggerType, options.onlyRuleId || null, options.onlyRuleId || null)
    .all<Record<string, unknown>>();
  const customDefinitions = await env.DB.prepare(`SELECT * FROM custom_field_definitions
    WHERE workspace_id=? AND object_type='opportunity' AND active=1`)
    .bind(access.workspaceId).all<CustomFieldDefinition>();
  const insertedRunIds: string[] = [];
  for (const rule of rules.results) {
    const priorRuns = await env.DB.prepare(`SELECT COUNT(*) total FROM automation_runs
      WHERE workspace_id=? AND rule_id=? AND record_type='opportunity' AND record_id=? AND status='succeeded'`)
      .bind(access.workspaceId, rule.id, opportunity.id).first<{ total: number }>();
    if ((priorRuns?.total || 0) >= Number(rule.max_runs_per_record)) continue;
    const conditions = JSON.parse(String(rule.conditions)) as unknown[];
    const allActions = JSON.parse(String(rule.actions)) as Json[];
    const allElseActions = JSON.parse(String(rule.else_actions || "[]")) as Json[];
    if (validateAutomationCustomMetadata(customDefinitions.results, triggerType, conditions,
      [...allActions, ...allElseActions])) continue;
    const matched = !conditions.length || conditions.every((condition) => automationConditionMatches(opportunity, condition));
    const actions = matched ? allActions : allElseActions;
    if (!actions.length) continue;
    const signedAuthority = {
      serialized: String(rule.authority_manifest || "[]"),
      hash: String(rule.authority_hash || ""),
    };
    const principalId = `automation:${String(rule.id)}`;
    const actor = options.actor || triggerActor(access);
    const runId = id("run");
    const startedAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO automation_runs
      (id,workspace_id,rule_id,record_type,record_id,event_id,retry_of_run_id,principal_id,
       trigger_actor_type,trigger_actor_id,authority_manifest,authority_hash,status,step_count,output,started_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'running',0,'{}',?
      WHERE (SELECT COUNT(*) FROM automation_runs
        WHERE workspace_id=? AND rule_id=? AND record_type='opportunity' AND record_id=? AND status IN ('running','succeeded')) < ?`)
      .bind(runId, access.workspaceId, rule.id, "opportunity", opportunity.id, eventId,
        options.retryOfRunId || null, principalId, actor.type, actor.id, signedAuthority.serialized, signedAuthority.hash,
        startedAt, access.workspaceId, rule.id, opportunity.id, rule.max_runs_per_record).run();
    if (!inserted.meta.changes) continue;
    insertedRunIds.push(runId);
    try {
      await assertWorkflowAuthority(rule, allActions, allElseActions);
      if (actions.length > 20) throw new Error("Automation exceeds the 20-step safety cap");
      const output: Array<Record<string, unknown>> = [{ action: "branch", outcome: matched ? "matched" : "else" }];
      const stepOutputs: WorkflowStepOutputs = new Map();
      const actionStatements: D1PreparedStatement[] = [];
      for (const [actionIndex, action] of actions.entries()) {
        const now = new Date().toISOString();
        if (action.type === "create_task") {
          const taskId = id("task");
          const titleTemplate = optionalString(action.title, "action.title", 200) || "Follow up on {{opportunity.name}}";
          const title = resolveAutomationTemplate(titleTemplate, opportunity, 200, "Automation task title", "opportunity", stepOutputs);
          const dueMinutes = boundedNumber(action.due_in_minutes, "action.due_in_minutes", 0, 525_600, 0);
          const priority = optionalString(action.priority, "action.priority", 20) || "normal";
          const dueAt = new Date(Date.now() + dueMinutes * 60_000).toISOString();
          if (action.approval_required === true) {
            const proposalId = id("proposal");
            const proposedAction = { type: "create_task", title, priority, due_at: dueAt, contact_id: opportunity.contact_id, opportunity_id: opportunity.id };
            actionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO agent_proposals
              (id,workspace_id,contact_id,opportunity_id,agent_type,title,rationale,confidence,risk_level,proposed_action,
               status,created_at,dedupe_key,category,priority,expires_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
              .bind(proposalId, access.workspaceId, opportunity.contact_id, opportunity.id, "workflow_operator", title,
                `Workflow ${rule.name} requested a human-reviewed task.`, 100, "low", JSON.stringify(proposedAction), now,
                `workflow:${rule.id}:${opportunity.id}:${eventId}:${actionIndex}`, "workflow_approval", 50,
                new Date(Date.now() + 7 * 86_400_000).toISOString()));
          appendWorkflowActionOutput(output, stepOutputs, action, { action: "propose_task", proposal_id: proposalId });
          } else {
            actionStatements.push(env.DB.prepare(`INSERT INTO tasks
              (id,workspace_id,contact_id,opportunity_id,title,status,priority,assignee,due_at,created_by,created_at,updated_at)
              VALUES(?,?,?,?,?,'open',?,?,?,?,?,?)`)
              .bind(taskId, access.workspaceId, opportunity.contact_id, opportunity.id, title,
                priority, opportunity.owner || principalId, dueAt, principalId, now, now));
            appendWorkflowActionOutput(output, stepOutputs, action, { action: "create_task", task_id: taskId });
          }
        } else if (action.type === "add_note") {
          const noteId = id("note");
          const bodyTemplate = optionalString(action.body, "action.body", 4000);
          if (!bodyTemplate) throw new Error("Automation note body is required");
          const body = resolveAutomationTemplate(bodyTemplate, opportunity, 4000, "Automation note body", "opportunity", stepOutputs);
          actionStatements.push(env.DB.prepare(`INSERT INTO notes(id,workspace_id,contact_id,author,body,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?)`).bind(noteId, access.workspaceId, opportunity.contact_id, principalId, body, now, now));
          appendWorkflowActionOutput(output, stepOutputs, action, { action: "add_note", note_id: noteId });
        } else if (action.type === "update_opportunity") {
          const proposalId = id("proposal");
          const field = String(action.field);
          const resolvedValue = typeof action.value === "string"
            ? resolveAutomationTemplate(action.value, opportunity, field === "next_step" ? 500 : 254,
              "Automation opportunity value", "opportunity", stepOutputs)
            : action.value;
          const proposedAction = { type: "update_opportunity", opportunity_id: opportunity.id,
            expected_updated_at: opportunity.updated_at, changes: { [field]: resolvedValue } };
          actionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO agent_proposals
            (id,workspace_id,contact_id,opportunity_id,agent_type,title,rationale,confidence,risk_level,proposed_action,
             status,created_at,dedupe_key,category,priority,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
            .bind(proposalId, access.workspaceId, opportunity.contact_id, opportunity.id, "workflow_operator", `Update ${field.replaceAll("_", " ")}`,
              `Workflow ${rule.name} requested a human-reviewed opportunity update.`, 100, "medium", JSON.stringify(proposedAction), now,
              `workflow:${rule.id}:${opportunity.id}:${eventId}:${actionIndex}`, "pipeline_execution", 70,
              new Date(Date.now() + 7 * 86_400_000).toISOString()));
          appendWorkflowActionOutput(output, stepOutputs, action,
            { action: "propose_opportunity_update", proposal_id: proposalId });
        } else if (action.type === "request_agent") {
          const workItemId = id("work");
          const instructions = resolveAutomationTemplate(String(action.instructions), opportunity, 1000,
            "Automation agent instructions", "opportunity", stepOutputs);
          actionStatements.push(env.DB.prepare(`INSERT INTO agent_work_items
            (id,workspace_id,automation_rule_id,automation_run_id,contact_id,opportunity_id,objective,instructions,
             preferred_provider,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)`).bind(workItemId, access.workspaceId, rule.id, runId,
              opportunity.contact_id, opportunity.id, action.objective, instructions, action.preferred_provider, now, now));
          appendWorkflowActionOutput(output, stepOutputs, action,
            { action: "request_agent", work_item_id: workItemId, provider: action.preferred_provider });
        } else if (action.type === "publish_event") {
          const prepared = await prepareWorkflowEvent(env, access.workspaceId, rule, runId, eventId, actionIndex,
            "opportunity", opportunity, now);
          actionStatements.push(...prepared.statements);
          appendWorkflowActionOutput(output, stepOutputs, action,
            { action: "publish_event", event_id: prepared.workflowEventId, event_type: prepared.eventType,
              subscribers: prepared.endpointCount });
        } else {
          throw new Error(`Unsupported automation action: ${String(action.type)}`);
        }
      }
      await env.DB.batch([
        ...actionStatements,
        env.DB.prepare(`UPDATE automation_runs SET status='succeeded',step_count=?,output=?,finished_at=? WHERE id=?`)
          .bind(actions.length, JSON.stringify(output), new Date().toISOString(), runId),
      ]);
      if (actions.some((action) => action.type === "publish_event")) {
        try {
          await processWebhookRetries(env, access.workspaceId, 20);
        } catch {
          // The durable retry scheduler owns queued delivery recovery. A
          // transport-dispatch failure must not relabel committed CRM actions.
        }
      }
    } catch (error) {
      await env.DB.prepare(`UPDATE automation_runs SET status='failed',error=?,finished_at=? WHERE id=?`)
        .bind(error instanceof Error ? error.message.slice(0, 1000) : "Unknown automation error", new Date().toISOString(), runId).run();
    }
  }
  return insertedRunIds;
}

async function runContactAutomations(
  env: FrameworkEnv,
  access: WorkspaceAccess,
  contact: Record<string, unknown>,
  eventId: string,
  triggerType: "contact.created" | "contact.lifecycle_changed" | "contact.manual",
  options: { onlyRuleId?: string; retryOfRunId?: string; actor?: { type: string; id: string } } = {},
) {
  const rules = await env.DB.prepare(`SELECT * FROM automation_rules
    WHERE workspace_id=? AND status='active' AND trigger_type=? AND (? IS NULL OR id=?)
    ORDER BY created_at LIMIT 50`).bind(access.workspaceId, triggerType, options.onlyRuleId || null, options.onlyRuleId || null)
    .all<Record<string, unknown>>();
  const customDefinitions = await env.DB.prepare(`SELECT * FROM custom_field_definitions
    WHERE workspace_id=? AND object_type='contact' AND active=1`)
    .bind(access.workspaceId).all<CustomFieldDefinition>();
  const insertedRunIds: string[] = [];
  for (const rule of rules.results) {
    const priorRuns = await env.DB.prepare(`SELECT COUNT(*) total FROM automation_runs
      WHERE workspace_id=? AND rule_id=? AND record_type='contact' AND record_id=? AND status='succeeded'`)
      .bind(access.workspaceId, rule.id, contact.id).first<{ total: number }>();
    if ((priorRuns?.total || 0) >= Number(rule.max_runs_per_record)) continue;
    const conditions = JSON.parse(String(rule.conditions)) as unknown[];
    const allActions = JSON.parse(String(rule.actions)) as Json[];
    const allElseActions = JSON.parse(String(rule.else_actions || "[]")) as Json[];
    if (validateAutomationCustomMetadata(customDefinitions.results, triggerType, conditions,
      [...allActions, ...allElseActions])) continue;
    const matched = !conditions.length || conditions.every((condition) => automationConditionMatches(contact, condition));
    const actions = matched ? allActions : allElseActions;
    if (!actions.length) continue;
    const signedAuthority = {
      serialized: String(rule.authority_manifest || "[]"),
      hash: String(rule.authority_hash || ""),
    };
    const principalId = `automation:${String(rule.id)}`;
    const actor = options.actor || triggerActor(access);
    const runId = id("run");
    const startedAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO automation_runs
      (id,workspace_id,rule_id,record_type,record_id,event_id,retry_of_run_id,principal_id,
       trigger_actor_type,trigger_actor_id,authority_manifest,authority_hash,status,step_count,output,started_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'running',0,'{}',?
      WHERE (SELECT COUNT(*) FROM automation_runs
        WHERE workspace_id=? AND rule_id=? AND record_type='contact' AND record_id=? AND status IN ('running','succeeded')) < ?`)
      .bind(runId, access.workspaceId, rule.id, "contact", contact.id, eventId, options.retryOfRunId || null,
        principalId, actor.type, actor.id, signedAuthority.serialized, signedAuthority.hash, startedAt,
        access.workspaceId, rule.id, contact.id, rule.max_runs_per_record).run();
    if (!inserted.meta.changes) continue;
    insertedRunIds.push(runId);
    try {
      await assertWorkflowAuthority(rule, allActions, allElseActions);
      if (actions.length > 20) throw new Error("Automation exceeds the 20-step safety cap");
      const output: Array<Record<string, unknown>> = [{ action: "branch", outcome: matched ? "matched" : "else" }];
      const stepOutputs: WorkflowStepOutputs = new Map();
      const actionStatements: D1PreparedStatement[] = [];
      for (const [actionIndex, action] of actions.entries()) {
        const now = new Date().toISOString();
        if (action.type === "create_task") {
          const taskId = id("task");
          const title = resolveAutomationTemplate(optionalString(action.title, "action.title", 200) || "Follow up", contact, 200,
            "Automation task title", "contact", stepOutputs);
          const dueMinutes = boundedNumber(action.due_in_minutes, "action.due_in_minutes", 0, 525_600, 0);
          const priority = optionalString(action.priority, "action.priority", 20) || "normal";
          const dueAt = new Date(Date.now() + dueMinutes * 60_000).toISOString();
          if (action.approval_required === true) {
            const proposalId = id("proposal");
            const proposedAction = { type: "create_task", title, priority, due_at: dueAt, contact_id: contact.id, opportunity_id: null };
            actionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO agent_proposals
              (id,workspace_id,contact_id,opportunity_id,agent_type,title,rationale,confidence,risk_level,proposed_action,
               status,created_at,dedupe_key,category,priority,expires_at)
              VALUES(?,?,?,NULL,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
              .bind(proposalId, access.workspaceId, contact.id, "workflow_operator", title,
                `Workflow ${rule.name} requested a human-reviewed task.`, 100, "low", JSON.stringify(proposedAction), now,
                `workflow:${rule.id}:${contact.id}:${eventId}:${actionIndex}`, "workflow_approval", 50,
                new Date(Date.now() + 7 * 86_400_000).toISOString()));
            appendWorkflowActionOutput(output, stepOutputs, action,
              { action: "propose_task", proposal_id: proposalId });
          } else {
            actionStatements.push(env.DB.prepare(`INSERT INTO tasks
              (id,workspace_id,contact_id,opportunity_id,title,status,priority,assignee,due_at,created_by,created_at,updated_at)
              VALUES(?,?,?,NULL,?,'open',?,?,?,?,?,?)`)
              .bind(taskId, access.workspaceId, contact.id, title, priority, contact.owner || principalId, dueAt,
                principalId, now, now));
            appendWorkflowActionOutput(output, stepOutputs, action, { action: "create_task", task_id: taskId });
          }
        } else if (action.type === "add_note") {
          const noteId = id("note");
          const bodyTemplate = optionalString(action.body, "action.body", 4000);
          if (!bodyTemplate) throw new Error("Automation note body is required");
          const body = resolveAutomationTemplate(bodyTemplate, contact, 4000, "Automation note body", "contact", stepOutputs);
          actionStatements.push(env.DB.prepare(`INSERT INTO notes(id,workspace_id,contact_id,author,body,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?)`).bind(noteId, access.workspaceId, contact.id, principalId, body, now, now));
          appendWorkflowActionOutput(output, stepOutputs, action, { action: "add_note", note_id: noteId });
        } else if (action.type === "update_contact") {
          const proposalId = id("proposal");
          const field = String(action.field);
          const rawValue = action.value;
          const customKey = field.startsWith("custom:") ? field.slice(7) : "";
          const resolvedValue = field === "owner" && rawValue === ""
            ? null
            : typeof rawValue === "string" && !customKey
              ? resolveAutomationTemplate(rawValue, contact, field === "owner" ? 254 : 30,
                "Automation contact value", "contact", stepOutputs)
              : rawValue;
          const proposedAction = { type: "update_contact", contact_id: contact.id,
            expected_updated_at: contact.updated_at,
            changes: customKey ? { custom_fields: { [customKey]: resolvedValue } } : { [field]: resolvedValue } };
          actionStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO agent_proposals
            (id,workspace_id,contact_id,opportunity_id,agent_type,title,rationale,confidence,risk_level,proposed_action,
             status,created_at,dedupe_key,category,priority,expires_at)
            VALUES(?,?,?,NULL,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
            .bind(proposalId, access.workspaceId, contact.id, "workflow_operator", `Update contact ${field.replaceAll("_", " ")}`,
              `Workflow ${rule.name} requested a human-reviewed contact update.`, 100, "medium", JSON.stringify(proposedAction), now,
              `workflow:${rule.id}:${contact.id}:${eventId}:${actionIndex}`, "lead_execution", 70,
              new Date(Date.now() + 7 * 86_400_000).toISOString()));
          appendWorkflowActionOutput(output, stepOutputs, action,
            { action: "propose_contact_update", proposal_id: proposalId });
        } else if (action.type === "request_agent") {
          const workItemId = id("work");
          const instructions = resolveAutomationTemplate(String(action.instructions), contact, 1000,
            "Automation agent instructions", "contact", stepOutputs);
          actionStatements.push(env.DB.prepare(`INSERT INTO agent_work_items
            (id,workspace_id,automation_rule_id,automation_run_id,contact_id,opportunity_id,objective,instructions,
             preferred_provider,status,created_at,updated_at)
            VALUES(?,?,?,?,?,NULL,?,?,?,'queued',?,?)`).bind(workItemId, access.workspaceId, rule.id, runId,
              contact.id, action.objective, instructions, action.preferred_provider, now, now));
          appendWorkflowActionOutput(output, stepOutputs, action,
            { action: "request_agent", work_item_id: workItemId, provider: action.preferred_provider });
        } else if (action.type === "publish_event") {
          const prepared = await prepareWorkflowEvent(env, access.workspaceId, rule, runId, eventId, actionIndex,
            "contact", contact, now);
          actionStatements.push(...prepared.statements);
          appendWorkflowActionOutput(output, stepOutputs, action,
            { action: "publish_event", event_id: prepared.workflowEventId, event_type: prepared.eventType,
              subscribers: prepared.endpointCount });
        } else {
          throw new Error(`Unsupported automation action: ${String(action.type)}`);
        }
      }
      await env.DB.batch([
        ...actionStatements,
        env.DB.prepare(`UPDATE automation_runs SET status='succeeded',step_count=?,output=?,finished_at=? WHERE id=?`)
          .bind(actions.length, JSON.stringify(output), new Date().toISOString(), runId),
      ]);
      if (actions.some((action) => action.type === "publish_event")) {
        try {
          await processWebhookRetries(env, access.workspaceId, 20);
        } catch {
          // The durable retry scheduler owns queued delivery recovery. A
          // transport-dispatch failure must not relabel committed CRM actions.
        }
      }
    } catch (error) {
      await env.DB.prepare(`UPDATE automation_runs SET status='failed',error=?,finished_at=? WHERE id=?`)
        .bind(error instanceof Error ? error.message.slice(0, 1000) : "Unknown automation error", new Date().toISOString(), runId).run();
    }
  }
  return insertedRunIds;
}

async function upsertContact(env: FrameworkEnv, source: Record<string, unknown>, payload: Json) {
  const rawContact = payload.contact || payload;
  if (!rawContact || typeof rawContact !== "object" || Array.isArray(rawContact)) throw new ApiError(400, "contact must be an object");
  const contactData = rawContact as Json;
  const email = normalizeEmail(contactData.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new ApiError(400, "A valid contact.email is required");
  const now = new Date().toISOString();
  const generatedId = id("con");
  const firstName = optionalString(contactData.first_name, "contact.first_name", 100);
  const lastName = optionalString(contactData.last_name, "contact.last_name", 100);
  const phone = optionalString(contactData.phone, "contact.phone", 50);
  const company = optionalString(contactData.company, "contact.company", 200);
  const status = optionalString(contactData.status, "contact.status", 30);
  const stage = optionalString(contactData.stage, "contact.stage", 30);
  if (status && !allowedStatuses.has(status)) throw new ApiError(400, "contact.status is invalid");
  if (stage && !allowedStages.has(stage)) throw new ApiError(400, "contact.stage is invalid");
  if (contactData.tags !== undefined && (!Array.isArray(contactData.tags) || contactData.tags.some((tag) => typeof tag !== "string" || tag.length > 60) || contactData.tags.length > 30)) {
    throw new ApiError(400, "contact.tags must contain at most 30 short strings");
  }
  if (contactData.custom_fields !== undefined && (!contactData.custom_fields || typeof contactData.custom_fields !== "object" || Array.isArray(contactData.custom_fields))) {
    throw new ApiError(400, "contact.custom_fields must be an object");
  }
  const tags = contactData.tags === undefined ? null : JSON.stringify(contactData.tags);
  const customFields = contactData.custom_fields === undefined ? null : JSON.stringify(contactData.custom_fields);
  const sourceSlug = String(source.slug);
  const workspaceId = String(source.workspace_id);
  const companyRecord = company ? await companyIdentity(env, workspaceId, company, now) : null;

  // Validate every nested object before the first write so a rejected request
  // cannot leave behind a contact or activity.
  const rawEvent = payload.event || {};
  if (typeof rawEvent !== "object" || Array.isArray(rawEvent)) throw new ApiError(400, "event must be an object");
  const event = rawEvent as Json;
  const eventType = optionalString(event.type, "event.type", 80) || "contact.upserted";
  const externalId = optionalString(event.external_id, "event.external_id", 255);
  const eventTitle = optionalString(event.title, "event.title", 200) || eventType.replaceAll(".", " ");
  const eventBody = optionalString(event.body, "event.body", 4000);
  if (event.metadata !== undefined && (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata))) throw new ApiError(400, "event.metadata must be an object");
  const eventOccurredAt = optionalString(event.occurred_at, "event.occurred_at", 50) || now;
  const eventOccurredTime = Date.parse(eventOccurredAt);
  if (!Number.isFinite(eventOccurredTime) || eventOccurredTime > Date.now() + 86_400_000) {
    throw new ApiError(400, "event.occurred_at must be a valid timestamp no more than 24 hours in the future");
  }

  let dealData: {
    externalId: string;
    stage: string;
    value: number;
    name: string;
    currency: string;
    closedAt: string | null;
  } | null = null;
  if (payload.deal !== undefined) {
    if (!payload.deal || typeof payload.deal !== "object" || Array.isArray(payload.deal)) throw new ApiError(400, "deal must be an object");
    const deal = payload.deal as Json;
    const dealExternalId = optionalString(deal.external_id, "deal.external_id", 255);
    if (!dealExternalId) throw new ApiError(400, "deal.external_id is required for idempotency");
    const dealStage = optionalString(deal.stage, "deal.stage", 30) || "open";
    if (!["open", "paid", "won", "lost", "refunded"].includes(dealStage)) throw new ApiError(400, "deal.stage is invalid");
    const value = Number(deal.value || 0);
    if (!Number.isFinite(value) || value < 0 || value > 100_000_000) throw new ApiError(400, "deal.value is invalid");
    dealData = {
      externalId: dealExternalId,
      stage: dealStage,
      value,
      name: optionalString(deal.name, "deal.name", 200) || "Opportunity",
      currency: (optionalString(deal.currency, "deal.currency", 3) || "USD").toUpperCase(),
      closedAt: ["paid", "won"].includes(dealStage) ? now : null,
    };
  }

  const contactInsert = env.DB.prepare(`INSERT OR IGNORE INTO contacts
    (id,workspace_id,email,first_name,last_name,phone,company,company_id,status,stage,source_first,source_last,tags,custom_fields,last_activity_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    RETURNING id`)
    .bind(generatedId, workspaceId, email, firstName, lastName, phone, companyRecord?.name || company, companyRecord?.id || null,
      status || "lead", stage || "new", sourceSlug, sourceSlug, tags || "[]", customFields || "{}", now, now, now);
  const initialWrites = await env.DB.batch([
    ...(companyRecord ? [insertCompanyStatement(env, workspaceId, companyRecord)] : []),
    contactInsert,
  ]);
  const insert = initialWrites.at(-1)!;
  if (!insert.results.length) {
    await env.DB.prepare(`UPDATE contacts SET
      first_name=COALESCE(?,first_name),last_name=COALESCE(?,last_name),phone=COALESCE(?,phone),
      company=COALESCE(?,company),company_id=COALESCE(?,company_id),status=COALESCE(?,status),stage=COALESCE(?,stage),
      source_last=?,tags=COALESCE(?,tags),custom_fields=COALESCE(?,custom_fields),
      last_activity_at=?,updated_at=? WHERE workspace_id=? AND email=?`)
      .bind(firstName, lastName, phone, companyRecord?.name || company, companyRecord?.id || null, status, stage, sourceSlug, tags, customFields,
        now, now, workspaceId, email).run();
  }
  const contact = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND email=?").bind(workspaceId, email).first<{ id: string }>();
  if (!contact) throw new Error("Contact upsert did not return a record");
  const contactId = contact.id;
  const created = insert.results.length > 0 && contactId === generatedId;

  await env.DB.prepare(`INSERT OR IGNORE INTO activities
    (id,workspace_id,contact_id,source_id,type,title,body,metadata,external_id,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id("act"), workspaceId, contactId, source.id, eventType, eventTitle, eventBody,
      JSON.stringify(event.metadata || {}), externalId, eventOccurredAt, now).run();

  if (dealData) {
    await env.DB.prepare(`INSERT INTO deals
      (id,workspace_id,contact_id,source_id,name,stage,value,currency,external_id,closed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id,external_id) DO UPDATE SET stage=excluded.stage,value=excluded.value,updated_at=excluded.updated_at,closed_at=excluded.closed_at`)
      .bind(id("deal"), workspaceId, contactId, source.id, dealData.name, dealData.stage, dealData.value,
        dealData.currency, dealData.externalId, dealData.closedAt, now, now).run();
    if (["paid", "won"].includes(dealData.stage)) {
      await env.DB.prepare("UPDATE contacts SET status='customer', stage=CASE WHEN stage='new' THEN 'confirmed' ELSE stage END, updated_at=? WHERE id=?").bind(now, contactId).run();
    }
  }
  if (created) {
    const createdContact = await env.DB.prepare("SELECT * FROM contacts WHERE workspace_id=? AND id=?")
      .bind(workspaceId, contactId).first<Record<string, unknown>>();
    if (createdContact) {
      await runContactAutomations(env, {
        workspaceId,
        email: `${sourceSlug.replace(/[^a-z0-9._-]/gi, "-")}@integration.local`,
        role: "integration",
      }, createdContact, externalId ? `source:${source.id}:${externalId}` : id("evt"), "contact.created");
    }
  }
  return { id: contactId, email, created };
}

type OperationsHealthComponent = {
  id: "scheduler" | "webhooks" | "automations" | "agents" | "email";
  label: string;
  status: "healthy" | "watch" | "action";
  summary: string;
  details: string;
  counts: Record<string, number>;
  last_event_at: string | null;
};

async function deriveOperationsHealth(env: FrameworkEnv, workspaceId: string, observedAt = new Date()) {
  const nowIso = observedAt.toISOString();
  const threeMinutesAgo = new Date(observedAt.getTime() - 3 * 60_000).toISOString();
  const tenMinutesAgo = new Date(observedAt.getTime() - 10 * 60_000).toISOString();
  const fifteenMinutesAgo = new Date(observedAt.getTime() - 15 * 60_000).toISOString();
  const dayAgo = new Date(observedAt.getTime() - 24 * 60 * 60_000).toISOString();
  const [scheduler, webhooks, automations, agentWork, resend, operationLease] = await Promise.all([
    env.DB.prepare(`SELECT job,MAX(created_at) last_seen_at,COUNT(*) retained_requests
      FROM scheduler_requests GROUP BY job ORDER BY job LIMIT 10`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='failed' AND updated_at>=? THEN 1 ELSE 0 END) failed_24h,
      SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) retrying,
      SUM(CASE WHEN status='retrying' AND next_attempt_at<=? THEN 1 ELSE 0 END) due,
      SUM(CASE WHEN status='processing' AND updated_at<=? THEN 1 ELSE 0 END) stale_processing,
      MAX(CASE WHEN status='succeeded' THEN updated_at END) last_succeeded_at
      FROM webhook_deliveries WHERE workspace_id=? AND direction='outbound'`)
      .bind(dayAgo, nowIso, tenMinutesAgo, workspaceId).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='failed' AND started_at>=? THEN 1 ELSE 0 END) failed_24h,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN status='running' AND started_at<=? THEN 1 ELSE 0 END) stale_running,
      MAX(CASE WHEN status='succeeded' THEN finished_at END) last_succeeded_at
      FROM automation_runs WHERE workspace_id=?`)
      .bind(dayAgo, new Date(observedAt.getTime() - 5 * 60_000).toISOString(), workspaceId)
      .first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
      MIN(CASE WHEN status='queued' THEN created_at END) oldest_queued_at,
      SUM(CASE WHEN status='claimed' AND claim_expires_at>? THEN 1 ELSE 0 END) active_claims,
      SUM(CASE WHEN status='claimed' AND claim_expires_at<=? THEN 1 ELSE 0 END) expired_claims,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      MAX(CASE WHEN status='completed' THEN completed_at END) last_completed_at
      FROM agent_work_items WHERE workspace_id=?`)
      .bind(nowIso, nowIso, workspaceId).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='failed' AND updated_at>=? THEN 1 ELSE 0 END) failed_24h,
      SUM(CASE WHEN status='pending' AND updated_at<=? THEN 1 ELSE 0 END) stale_pending,
      MAX(CASE WHEN status='succeeded' THEN updated_at END) last_succeeded_at
      FROM resend_deliveries WHERE workspace_id=?`)
      .bind(dayAgo, tenMinutesAgo, workspaceId).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT operation,lease_until,acquired_at FROM workspace_operation_leases
      WHERE workspace_id=? AND lease_until>?`).bind(workspaceId, nowIso).first<Record<string, unknown>>(),
  ]);
  const schedulerRow = scheduler.results.find((row) => row.job === "webhook-retries") || null;
  const schedulerLastSeen = schedulerRow?.last_seen_at ? String(schedulerRow.last_seen_at) : null;
  const schedulerStatus = !schedulerLastSeen || schedulerLastSeen < tenMinutesAgo
    ? "action" : schedulerLastSeen < threeMinutesAgo ? "watch" : "healthy";
  const webhookStatus = Number(webhooks?.stale_processing || 0) > 0 || Number(webhooks?.failed_24h || 0) > 0
    ? "action" : Number(webhooks?.due || 0) > 0 || Number(webhooks?.retrying || 0) > 0 ? "watch" : "healthy";
  const automationStatus = Number(automations?.stale_running || 0) > 0
    ? "action" : Number(automations?.failed_24h || 0) > 0 ? "watch" : "healthy";
  const oldestQueuedAt = agentWork?.oldest_queued_at ? String(agentWork.oldest_queued_at) : null;
  const agentStatus = Number(agentWork?.expired_claims || 0) > 0 || Number(agentWork?.failed || 0) > 0
    ? "action" : oldestQueuedAt && oldestQueuedAt <= fifteenMinutesAgo ? "watch" : "healthy";
  const resendStatus = Number(resend?.stale_pending || 0) > 0 || Number(resend?.failed_24h || 0) > 0
    ? "action" : "healthy";
  const components: OperationsHealthComponent[] = [
    {
      id: "scheduler", label: "Retry scheduler", status: schedulerStatus,
      summary: schedulerStatus === "healthy" ? "Heartbeat current"
        : schedulerStatus === "watch" ? "Heartbeat delayed" : "Heartbeat missing",
      details: schedulerLastSeen
        ? `Last signed retry sweep ${schedulerLastSeen}`
        : "No retained signed retry sweep was found",
      counts: { retained_requests: Number(schedulerRow?.retained_requests || 0) },
      last_event_at: schedulerLastSeen,
    },
    {
      id: "webhooks", label: "Outbound webhooks", status: webhookStatus,
      summary: `${Number(webhooks?.retrying || 0)} retrying · ${Number(webhooks?.failed_24h || 0)} failed in 24h`,
      details: `${Number(webhooks?.due || 0)} due now · ${Number(webhooks?.stale_processing || 0)} stale delivery lease(s)`,
      counts: {
        retrying: Number(webhooks?.retrying || 0), due: Number(webhooks?.due || 0),
        stale_processing: Number(webhooks?.stale_processing || 0), failed_24h: Number(webhooks?.failed_24h || 0),
      },
      last_event_at: webhooks?.last_succeeded_at ? String(webhooks.last_succeeded_at) : null,
    },
    {
      id: "automations", label: "Workflow runs", status: automationStatus,
      summary: `${Number(automations?.running || 0)} running · ${Number(automations?.failed_24h || 0)} failed in 24h`,
      details: `${Number(automations?.stale_running || 0)} run(s) beyond the five-minute execution lease`,
      counts: {
        running: Number(automations?.running || 0), stale_running: Number(automations?.stale_running || 0),
        failed_24h: Number(automations?.failed_24h || 0),
      },
      last_event_at: automations?.last_succeeded_at ? String(automations.last_succeeded_at) : null,
    },
    {
      id: "agents", label: "Agent work queue", status: agentStatus,
      summary: `${Number(agentWork?.queued || 0)} queued · ${Number(agentWork?.active_claims || 0)} claimed`,
      details: `${Number(agentWork?.failed || 0)} failed · ${Number(agentWork?.expired_claims || 0)} expired claim(s)`,
      counts: {
        queued: Number(agentWork?.queued || 0), active_claims: Number(agentWork?.active_claims || 0),
        expired_claims: Number(agentWork?.expired_claims || 0), failed: Number(agentWork?.failed || 0),
      },
      last_event_at: agentWork?.last_completed_at ? String(agentWork.last_completed_at) : oldestQueuedAt,
    },
    {
      id: "email", label: "Transactional email", status: resendStatus,
      summary: `${Number(resend?.failed_24h || 0)} failed in 24h`,
      details: `${Number(resend?.stale_pending || 0)} delivery attempt(s) pending longer than ten minutes`,
      counts: {
        failed_24h: Number(resend?.failed_24h || 0), stale_pending: Number(resend?.stale_pending || 0),
      },
      last_event_at: resend?.last_succeeded_at ? String(resend.last_succeeded_at) : null,
    },
  ];
  const status: "healthy" | "watch" | "action" = components.some((component) => component.status === "action")
    ? "action" : components.some((component) => component.status === "watch") ? "watch" : "healthy";
  return {
    generated_at: nowIso,
    status,
    attention_count: components.filter((component) => component.status !== "healthy").length,
    components,
    active_operation: operationLease ? {
      operation: String(operationLease.operation),
      acquired_at: String(operationLease.acquired_at),
      lease_until: String(operationLease.lease_until),
    } : null,
    safety: {
      admin_only: true,
      workspace_data_scoped: true,
      scheduler_heartbeat_global: true,
      record_content_included: false,
      derived_without_mutation: true,
    },
  };
}

async function queueOperationsHealthEvent(
  env: FrameworkEnv,
  workspaceId: string,
  eventId: string,
  eventType: "operations.health.action" | "operations.health.escalated" | "operations.health.recovered",
  incidentId: string,
  componentIds: string[],
  observedAt: string,
  escalation?: { step: number; delay_minutes: number },
) {
  const body = JSON.stringify({
    id: eventId,
    type: eventType,
    created_at: observedAt,
    data: {
      workspace_id: workspaceId, incident_id: incidentId, component_ids: componentIds,
      ...(escalation ? { escalation_step: escalation.step, escalation_delay_minutes: escalation.delay_minutes } : {}),
    },
  });
  const endpoints = await env.DB.prepare(`SELECT id FROM webhook_endpoints
    WHERE workspace_id=? AND direction='outbound' AND active=1
      AND (event_types='[]' OR EXISTS (SELECT 1 FROM json_each(event_types) WHERE value IN (?, '*')))
    ORDER BY created_at LIMIT 20`).bind(workspaceId, eventType).all<{ id: string }>();
  if (!endpoints.results.length) return 0;
  await env.DB.batch(endpoints.results.map((endpoint) => env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries
    (id,workspace_id,endpoint_id,event_id,direction,status,attempts,request_body,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,'retrying',0,?,?,?,?)`)
    .bind(id("delivery"), workspaceId, endpoint.id, eventId, "outbound", body, observedAt, observedAt, observedAt)));
  return endpoints.results.length;
}

type OperationsHealthPolicy = {
  target_healthy_percentage: number;
  incident_after_consecutive_action: number;
  notify_on_recovery: boolean;
  escalation_delays_minutes: number[];
  revision: number;
  change_id: string | null;
  updated_by: string;
  updated_at: string | null;
};

async function operationsHealthPolicy(env: FrameworkEnv, workspaceId: string): Promise<OperationsHealthPolicy> {
  const stored = await env.DB.prepare(`SELECT target_healthy_percentage,incident_after_consecutive_action,
    notify_on_recovery,escalation_delays_minutes,revision,change_id,updated_by,updated_at
    FROM operations_health_policies WHERE workspace_id=?`).bind(workspaceId).first<Record<string, unknown>>();
  return stored ? {
    target_healthy_percentage: Number(stored.target_healthy_percentage),
    incident_after_consecutive_action: Number(stored.incident_after_consecutive_action),
    notify_on_recovery: Boolean(stored.notify_on_recovery),
    escalation_delays_minutes: operationsEscalationDelays(stored.escalation_delays_minutes),
    revision: Number(stored.revision),
    change_id: String(stored.change_id),
    updated_by: String(stored.updated_by),
    updated_at: String(stored.updated_at),
  } : {
    target_healthy_percentage: 99,
    incident_after_consecutive_action: 1,
    notify_on_recovery: true,
    escalation_delays_minutes: [],
    revision: 0,
    change_id: null,
    updated_by: "system:default",
    updated_at: null,
  };
}

function operationsEscalationDelays(value: unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((delay): delay is number =>
      Number.isInteger(delay) && delay >= 1 && delay <= 1440).slice(0, 3);
  } catch {
    return [];
  }
}

async function queueDueOperationsEscalations(
  env: FrameworkEnv,
  workspaceId: string,
  incident: {
    id: string; component_ids: string; opened_at: string;
    escalation_delays_minutes: string; escalated_steps: string;
  },
  observedAt: Date,
) {
  const delays = operationsEscalationDelays(incident.escalation_delays_minutes);
  const sent = new Set(operationsEscalationDelays(incident.escalated_steps));
  const components = JSON.parse(incident.component_ids) as string[];
  const elapsedMinutes = Math.floor((observedAt.getTime() - Date.parse(incident.opened_at)) / 60_000);
  const escalated: number[] = [];
  for (let index = 0; index < delays.length; index += 1) {
    const step = index + 1;
    if (sent.has(step) || elapsedMinutes < delays[index]) continue;
    const eventId = `operations-health:${incident.id}:escalated:${step}`;
    await queueOperationsHealthEvent(env, workspaceId, eventId, "operations.health.escalated",
      incident.id, components, observedAt.toISOString(), { step, delay_minutes: delays[index] });
    const before = JSON.stringify([...sent].sort((left, right) => left - right));
    sent.add(step);
    const after = JSON.stringify([...sent].sort((left, right) => left - right));
    const marked = await env.DB.prepare(`UPDATE operations_health_incidents SET escalated_steps=?
      WHERE id=? AND workspace_id=? AND status='open' AND escalated_steps=?`)
      .bind(after, incident.id, workspaceId, before).run();
    if (marked.meta.changes) escalated.push(step);
  }
  return escalated;
}

async function retainOperationsHealth(env: FrameworkEnv, workspaceId: string, observedAt = new Date()) {
  const health = await deriveOperationsHealth(env, workspaceId, observedAt);
  const policy = await operationsHealthPolicy(env, workspaceId);
  const observedIso = observedAt.toISOString();
  const observedMinute = new Date(Math.floor(observedAt.getTime() / 60_000) * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO operations_health_snapshots
      (id,workspace_id,observed_minute,status,attention_count,components,created_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,observed_minute) DO UPDATE SET
        status=excluded.status,attention_count=excluded.attention_count,
        components=excluded.components,created_at=excluded.created_at`)
      .bind(id("ohs"), workspaceId, observedMinute, health.status, health.attention_count,
        JSON.stringify(health.components.map(({ id: componentId, status, counts }) => ({ id: componentId, status, counts }))), observedIso),
    env.DB.prepare("DELETE FROM operations_health_snapshots WHERE created_at<?")
      .bind(new Date(observedAt.getTime() - 30 * 24 * 60 * 60_000).toISOString()),
  ]);
  const open = await env.DB.prepare(`SELECT id,component_ids,opened_at,escalation_delays_minutes,escalated_steps
    FROM operations_health_incidents WHERE workspace_id=? AND status='open'`).bind(workspaceId).first<{
      id: string; component_ids: string; opened_at: string;
      escalation_delays_minutes: string; escalated_steps: string;
    }>();
  const actionComponents = health.components.filter((component) => component.status === "action").map((component) => component.id);
  if (health.status === "action") {
    if (open) {
      await env.DB.prepare(`UPDATE operations_health_incidents
        SET component_ids=?,last_observed_at=? WHERE id=? AND workspace_id=? AND status='open'`)
        .bind(JSON.stringify(actionComponents), observedIso, open.id, workspaceId).run();
      const escalated_steps = await queueDueOperationsEscalations(
        env, workspaceId, { ...open, component_ids: JSON.stringify(actionComponents) }, observedAt);
      return { health, transition: null, incident_id: open.id, escalated_steps };
    }
    const recent = await env.DB.prepare(`SELECT status FROM operations_health_snapshots
      WHERE workspace_id=? ORDER BY observed_minute DESC LIMIT ?`)
      .bind(workspaceId, policy.incident_after_consecutive_action).all<{ status: string }>();
    const consecutiveAction = recent.results.filter((snapshot) => snapshot.status === "action").length;
    if (recent.results.length < policy.incident_after_consecutive_action ||
        consecutiveAction < policy.incident_after_consecutive_action) {
      return {
        health, transition: null, incident_id: null,
        escalation: { observed: consecutiveAction, required: policy.incident_after_consecutive_action },
      };
    }
    const incidentId = id("ohi");
    const eventId = `operations-health:${incidentId}:opened`;
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO operations_health_incidents
      (id,workspace_id,status,severity,component_ids,opened_at,last_observed_at,opening_event_id,
       escalation_delays_minutes,escalated_steps)
      VALUES(?,?,'open','action',?,?,?,?,?,'[]')`)
      .bind(incidentId, workspaceId, JSON.stringify(actionComponents), observedIso, observedIso, eventId,
        JSON.stringify(policy.escalation_delays_minutes)).run();
    if (inserted.meta.changes) {
      await queueOperationsHealthEvent(env, workspaceId, eventId, "operations.health.action",
        incidentId, actionComponents, observedIso);
      return { health, transition: "opened" as const, incident_id: incidentId };
    }
  } else if (open) {
    const eventId = `operations-health:${open.id}:recovered`;
    const resolved = await env.DB.prepare(`UPDATE operations_health_incidents
      SET status='resolved',resolved_at=?,last_observed_at=?,recovery_event_id=?
      WHERE id=? AND workspace_id=? AND status='open'`)
      .bind(observedIso, observedIso, eventId, open.id, workspaceId).run();
    if (resolved.meta.changes) {
      const priorComponents = JSON.parse(open.component_ids) as string[];
      if (policy.notify_on_recovery) {
        await queueOperationsHealthEvent(env, workspaceId, eventId, "operations.health.recovered",
          open.id, priorComponents, observedIso);
      }
      return { health, transition: "resolved" as const, incident_id: open.id };
    }
  }
  return { health, transition: null, incident_id: null,
    escalation: { observed: 0, required: policy.incident_after_consecutive_action } };
}

async function retainScheduledOperationsHealth(env: FrameworkEnv, observedAt = new Date(), limit = 25) {
  const state = await env.DB.prepare(`SELECT cursor_workspace_id FROM operations_health_scheduler_state
    WHERE job='operations-health'`).first<{ cursor_workspace_id: string | null }>();
  const cursor = state?.cursor_workspace_id || "";
  const after = await env.DB.prepare(`SELECT id FROM workspaces
    WHERE status='active' AND id>? ORDER BY id LIMIT ?`).bind(cursor, limit).all<{ id: string }>();
  let selected = after.results;
  if (selected.length < limit) {
    const wrapped = await env.DB.prepare(`SELECT id FROM workspaces
      WHERE status='active' AND id<=? ORDER BY id LIMIT ?`)
      .bind(cursor, limit - selected.length).all<{ id: string }>();
    selected = [...selected, ...wrapped.results.filter((workspace) =>
      !selected.some((chosen) => chosen.id === workspace.id))];
  }
  const results: Awaited<ReturnType<typeof retainOperationsHealth>>[] = [];
  for (let offset = 0; offset < selected.length; offset += 5) {
    results.push(...await Promise.all(selected.slice(offset, offset + 5).map((workspace) =>
      retainOperationsHealth(env, workspace.id, observedAt))));
  }
  const lastWorkspaceId = selected.at(-1)?.id || cursor || null;
  await env.DB.prepare(`INSERT INTO operations_health_scheduler_state(job,cursor_workspace_id,updated_at)
    VALUES('operations-health',?,?)
    ON CONFLICT(job) DO UPDATE SET cursor_workspace_id=excluded.cursor_workspace_id,updated_at=excluded.updated_at`)
    .bind(lastWorkspaceId, observedAt.toISOString()).run();
  const total = await env.DB.prepare("SELECT COUNT(*) total FROM workspaces WHERE status='active'")
    .first<{ total: number }>();
  return { results, sampled: selected.length, total: Number(total?.total || 0), cursor_workspace_id: lastWorkspaceId };
}

type FormField = { key: "email" | "first_name" | "last_name" | "phone" | "company" | "message"; label: string; type: "email" | "text" | "tel" | "textarea"; required: boolean };
type SurveyQuestion = { id: string; label: string; type: "short_text" | "long_text" | "email" | "single_choice" | "multi_choice" | "rating"; required: boolean; options: string[] };
function validateSurveyQuestions(value: unknown): SurveyQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new ApiError(400, "questions must contain 1 to 30 supported questions");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => !["id", "label", "type", "required", "options"].includes(key))) throw new ApiError(400, "A survey question is malformed");
    const questionId = optionalString(raw.id, "question id", 40) || ""; const label = optionalString(raw.label, "question label", 160) || "";
    const type = optionalString(raw.type, "question type", 30) as SurveyQuestion["type"];
    const options = Array.isArray(raw.options) ? raw.options.map((option) => typeof option === "string" ? option.trim() : "") : [];
    if (!/^[a-z][a-z0-9_]{2,39}$/.test(questionId) || seen.has(questionId) || !label || typeof raw.required !== "boolean" ||
      !["short_text", "long_text", "email", "single_choice", "multi_choice", "rating"].includes(type) ||
      options.some((option) => !option || option.length > 100) || new Set(options).size !== options.length ||
      (["single_choice", "multi_choice"].includes(type) ? options.length < 2 || options.length > 12 : options.length !== 0)) {
      throw new ApiError(400, "A survey question is invalid or duplicated");
    }
    seen.add(questionId); return { id: questionId, label, type, required: raw.required, options };
  });
}
function safeSurvey(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, slug: row.slug, status: row.status, title: row.title, description: row.description,
    questions: JSON.parse(String(row.questions)), success_message: row.success_message, published_version_id: row.published_version_id,
    revision: row.revision, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at,
    public_path: row.status === "published" ? `/s/${row.slug}` : null };
}
function validateSurveyAnswers(questions: SurveyQuestion[], value: unknown) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !questions.some((question) => question.id === key))) throw new ApiError(400, "answers contain an unsupported question");
  const answers: Record<string, string | string[] | number> = {};
  for (const question of questions) {
    const raw = value[question.id];
    if (question.type === "multi_choice") {
      const selected = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
      if (question.required && selected.length === 0 || selected.length > question.options.length || new Set(selected).size !== selected.length || selected.some((item) => !question.options.includes(item))) throw new ApiError(400, `${question.label} has an invalid answer`);
      if (selected.length) answers[question.id] = selected;
    } else if (question.type === "rating") {
      const rating = Number(raw);
      if (question.required && !Number.isInteger(rating) || raw !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new ApiError(400, `${question.label} must be rated from 1 to 5`);
      if (Number.isInteger(rating) && rating >= 1 && rating <= 5) answers[question.id] = rating;
    } else {
      const answer = typeof raw === "string" ? raw.trim() : ""; const max = question.type === "long_text" ? 4000 : question.type === "email" ? 254 : 500;
      if (question.required && !answer || answer.length > max || question.type === "email" && answer && !validEmail(normalizeEmail(answer)) ||
        ["single_choice"].includes(question.type) && answer && !question.options.includes(answer)) throw new ApiError(400, `${question.label} has an invalid answer`);
      if (answer) answers[question.id] = question.type === "email" ? normalizeEmail(answer) : answer;
    }
  }
  return answers;
}
const formFieldDefaults: FormField[] = [
  { key: "email", label: "Email", type: "email", required: true },
  { key: "first_name", label: "First name", type: "text", required: false },
  { key: "last_name", label: "Last name", type: "text", required: false },
  { key: "phone", label: "Phone", type: "tel", required: false },
  { key: "company", label: "Company", type: "text", required: false },
  { key: "message", label: "How can we help?", type: "textarea", required: false },
];
function validateFormFields(value: unknown): FormField[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new ApiError(400, "fields must contain 1 to 6 supported fields");
  const seen = new Set<string>();
  const fields = value.map((raw) => {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => !["key", "label", "type", "required"].includes(key))) {
      throw new ApiError(400, "A form field is malformed");
    }
    const key = optionalString(raw.key, "field key", 30) as FormField["key"];
    const label = optionalString(raw.label, "field label", 80) || "";
    const type = optionalString(raw.type, "field type", 20) as FormField["type"];
    const allowedType: Record<FormField["key"], FormField["type"]> = { email: "email", first_name: "text", last_name: "text", phone: "tel", company: "text", message: "textarea" };
    if (!Object.hasOwn(allowedType, key) || allowedType[key] !== type || seen.has(key) || typeof raw.required !== "boolean" || !label) {
      throw new ApiError(400, "A form field is invalid or duplicated");
    }
    seen.add(key); return { key, label, type, required: raw.required };
  });
  const email = fields.find((field) => field.key === "email");
  if (!email?.required) throw new ApiError(400, "A required email field must be present");
  return fields;
}
function safeForm(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, slug: row.slug, status: row.status, title: row.title,
    description: row.description, fields: JSON.parse(String(row.fields)), consent_text: row.consent_text,
    success_message: row.success_message, published_version_id: row.published_version_id,
    revision: row.revision, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at,
    public_path: row.status === "published" ? `/f/${row.slug}` : null };
}
function safeFormSubmission(row: Record<string, unknown>) {
  return { id: row.id, form_id: row.form_id, form_version_id: row.form_version_id, contact_id: row.contact_id,
    payload: JSON.parse(String(row.payload)), email_consent: Boolean(row.email_consent), submitted_at: row.submitted_at };
}

type BookingRule = { day_of_week: number; start_minute: number; end_minute: number };
function validTimeZone(value: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); return value.length <= 100; } catch { return false; }
}
function validateBookingRules(value: unknown): BookingRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 21) throw new ApiError(400, "availability must contain 1 to 21 windows");
  const seen = new Set<string>();
  const rules = value.map((raw) => {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => !["day_of_week", "start_minute", "end_minute"].includes(key))) throw new ApiError(400, "An availability window is malformed");
    const day = Number(raw.day_of_week); const start = Number(raw.start_minute); const end = Number(raw.end_minute);
    const identity = `${day}:${start}:${end}`;
    if (!Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || start >= end || seen.has(identity)) {
      throw new ApiError(400, "An availability window is invalid or duplicated");
    }
    seen.add(identity); return { day_of_week: day, start_minute: start, end_minute: end };
  });
  for (const day of Array.from({ length: 7 }, (_, index) => index)) {
    const windows = rules.filter((rule) => rule.day_of_week === day).sort((a, b) => a.start_minute - b.start_minute);
    if (windows.some((window, index) => index > 0 && window.start_minute < windows[index - 1].end_minute)) throw new ApiError(400, "Availability windows cannot overlap");
  }
  return rules;
}
function zoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date).reduce<Record<string, number>>((result, part) => { if (part.type !== "literal") result[part.type] = Number(part.value); return result; }, {});
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}
function zonedWallTimeToUtc(year: number, month: number, day: number, minuteOfDay: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let result = guess - zoneOffsetMs(new Date(guess), timeZone);
  result = guess - zoneOffsetMs(new Date(result), timeZone);
  return new Date(result);
}
function parseLocalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return { year, month, day, date };
}
function localDateInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
    .reduce<Record<string, string>>((result, part) => { if (part.type !== "literal") result[part.type] = part.value; return result; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function safeBookingCalendar(row: Record<string, unknown>, rules: BookingRule[] = []) {
  return { id: row.id, name: row.name, slug: row.slug, status: row.status, title: row.title, description: row.description,
    timezone: row.timezone, duration_minutes: row.duration_minutes, buffer_before_minutes: row.buffer_before_minutes,
    buffer_after_minutes: row.buffer_after_minutes, minimum_notice_minutes: row.minimum_notice_minutes,
    maximum_days_ahead: row.maximum_days_ahead, revision: row.revision, availability: rules,
    public_path: row.status === "published" ? `/book/${row.slug}` : null, created_at: row.created_at, updated_at: row.updated_at };
}
function safeAppointment(row: Record<string, unknown>) {
  return { id: row.id, calendar_id: row.calendar_id, contact_id: row.contact_id, name: row.name, email: row.email, phone: row.phone,
    visitor_timezone: row.visitor_timezone, starts_at: row.starts_at, ends_at: row.ends_at, status: row.status,
    sync_status: row.sync_status, external_provider: row.external_provider, cancelled_at: row.cancelled_at,
    cancellation_reason: row.cancellation_reason, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at };
}
async function bookingAvailability(env: FrameworkEnv, calendar: Record<string, unknown>, dateFrom: string, days: number, excludeAppointmentId?: string) {
  const localStart = parseLocalDate(dateFrom); if (!localStart) throw new ApiError(400, "date_from must use YYYY-MM-DD");
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new ApiError(400, "days must be an integer from 1 to 14");
  const rules = await env.DB.prepare(`SELECT day_of_week,start_minute,end_minute FROM booking_availability_rules WHERE workspace_id=? AND calendar_id=? ORDER BY day_of_week,start_minute`)
    .bind(calendar.workspace_id, calendar.id).all<BookingRule>();
  const fromUtc = zonedWallTimeToUtc(localStart.year, localStart.month, localStart.day, 0, String(calendar.timezone));
  const rangeEnd = new Date(fromUtc.getTime() + (days + 2) * 86_400_000);
  const appointments = await env.DB.prepare(`SELECT starts_at,ends_at FROM booking_appointments WHERE workspace_id=? AND calendar_id=? AND status='booked' AND starts_at<? AND ends_at>? AND (? IS NULL OR id<>?)`)
    .bind(calendar.workspace_id, calendar.id, rangeEnd.toISOString(), fromUtc.toISOString(), excludeAppointmentId || null, excludeAppointmentId || null)
    .all<{ starts_at: string; ends_at: string }>();
  const now = Date.now(); const earliest = now + Number(calendar.minimum_notice_minutes) * 60_000;
  const latest = now + Number(calendar.maximum_days_ahead) * 86_400_000;
  const duration = Number(calendar.duration_minutes); const before = Number(calendar.buffer_before_minutes) * 60_000; const after = Number(calendar.buffer_after_minutes) * 60_000;
  const slots: Array<{ starts_at: string; ends_at: string }> = [];
  for (let offset = 0; offset < days; offset++) {
    const localDate = new Date(localStart.date.getTime() + offset * 86_400_000);
    const year = localDate.getUTCFullYear(); const month = localDate.getUTCMonth() + 1; const day = localDate.getUTCDate(); const weekday = localDate.getUTCDay();
    for (const rule of rules.results.filter((candidate) => candidate.day_of_week === weekday)) {
      for (let minute = rule.start_minute; minute + duration <= rule.end_minute; minute += duration) {
        const start = zonedWallTimeToUtc(year, month, day, minute, String(calendar.timezone)); const end = new Date(start.getTime() + duration * 60_000);
        if (start.getTime() < earliest || start.getTime() > latest) continue;
        const conflict = appointments.results.some((appointment) => Date.parse(appointment.starts_at) < end.getTime() + after && Date.parse(appointment.ends_at) > start.getTime() - before);
        if (!conflict) slots.push({ starts_at: start.toISOString(), ends_at: end.toISOString() });
      }
    }
  }
  return slots;
}

function safePaymentEntry(row: Record<string, unknown>) {
  return { id: row.id, contact_id: row.contact_id, opportunity_id: row.opportunity_id, parent_entry_id: row.parent_entry_id,
    kind: row.kind, amount_minor: row.amount_minor, currency: row.currency, description: row.description, provider: row.provider,
    provider_reference: row.provider_reference, occurred_at: row.occurred_at, created_by: row.created_by, created_at: row.created_at,
    contact_email: row.contact_email || null, contact_name: row.contact_name || null, opportunity_name: row.opportunity_name || null };
}
function paymentSignedAmount(kind: string, amount: number) {
  return ["refund", "dispute"].includes(kind) ? -amount : amount;
}
function validateMoneyInput(body: Json) {
  const amountMinor = Number(body.amount_minor); const currency = optionalString(body.currency, "currency", 3)?.toUpperCase() || "";
  const description = optionalString(body.description, "description", 300) || "";
  const occurredAt = optionalString(body.occurred_at, "occurred_at", 50) || "";
  const idempotencyKey = optionalString(body.idempotency_key, "idempotency_key", 100) || "";
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !/^[A-Z]{3}$/.test(currency) || !description ||
    !Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > Date.now() + 60_000 || !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
    throw new ApiError(400, "amount_minor, ISO currency, description, non-future occurred_at, and idempotency_key are required");
  }
  return { amountMinor, currency, description, occurredAt: new Date(occurredAt).toISOString(), idempotencyKey };
}

async function api(request: Request, env: FrameworkEnv, url: URL): Promise<Response | null> {
  const mcpResponse = await handleAgentMcp(request, env, url);
  if (mcpResponse) return mcpResponse;
  if (!url.pathname.startsWith("/v1/")) return null;

  if (url.pathname === "/v1/health") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    return json({ ok: true, service: "openoperator-crm", version: 1 });
  }

  const publicFormMatch = url.pathname.match(/^\/v1\/public\/forms\/([a-z0-9][a-z0-9-]{2,79})$/);
  if (publicFormMatch) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    const row = await env.DB.prepare(`SELECT f.slug,f.status,v.id version_id,v.version,v.title,v.description,v.fields,v.consent_text,v.success_message
      FROM forms f JOIN form_versions v ON v.id=f.published_version_id AND v.workspace_id=f.workspace_id
      WHERE f.slug=? AND f.status='published'`).bind(publicFormMatch[1]).first<Record<string, unknown>>();
    if (!row) return json({ error: "Published form not found" }, 404);
    return json({ form: { slug: row.slug, version: row.version, title: row.title, description: row.description,
      fields: JSON.parse(String(row.fields)), consent_text: row.consent_text, success_message: row.success_message },
      privacy: { data_use: "CRM follow-up requested by the submitter", email_marketing_optional: true } });
  }

  const publicFormSubmissionMatch = url.pathname.match(/^\/v1\/public\/forms\/([a-z0-9][a-z0-9-]{2,79})\/submissions$/);
  if (publicFormSubmissionMatch) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["values", "privacy_accepted", "email_consent", "idempotency_key", "website"].includes(key))) {
      return json({ error: "Submission contains unsupported fields" }, 400);
    }
    if (typeof body.website === "string" && body.website.trim()) return json({ ok: true, accepted: true }, 202);
    if (body.privacy_accepted !== true) return json({ error: "Privacy acknowledgement is required" }, 400);
    if (body.email_consent !== true && body.email_consent !== false) return json({ error: "email_consent must be true or false" }, 400);
    const idempotencyKey = optionalString(body.idempotency_key, "idempotency_key", 100) || "";
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) return json({ error: "idempotency_key is invalid" }, 400);
    if (!isPlainObject(body.values)) return json({ error: "values must be an object" }, 400);
    const published = await env.DB.prepare(`SELECT f.id form_id,f.workspace_id,f.slug,v.id version_id,v.fields,v.consent_text,v.success_message
      FROM forms f JOIN form_versions v ON v.id=f.published_version_id AND v.workspace_id=f.workspace_id
      WHERE f.slug=? AND f.status='published'`).bind(publicFormSubmissionMatch[1]).first<Record<string, unknown>>();
    if (!published) return json({ error: "Published form not found" }, 404);
    const fields = validateFormFields(JSON.parse(String(published.fields)));
    const allowedKeys = new Set(fields.map((field) => field.key));
    if (Object.keys(body.values).some((key) => !allowedKeys.has(key as FormField["key"]))) return json({ error: "values contain an unsupported field" }, 400);
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = typeof body.values[field.key] === "string" ? String(body.values[field.key]).trim() : "";
      const max = field.key === "message" ? 4000 : field.key === "email" ? 254 : 200;
      if (field.required && !value) return json({ error: `${field.label} is required` }, 400);
      if (value.length > max) return json({ error: `${field.label} is too long` }, 400);
      if (value) values[field.key] = value;
    }
    const email = normalizeEmail(values.email);
    if (!validEmail(email)) return json({ error: "A valid email is required" }, 400);
    values.email = email;
    const existingSubmission = await env.DB.prepare(`SELECT * FROM form_submissions WHERE workspace_id=? AND form_id=? AND idempotency_key=?`)
      .bind(published.workspace_id, published.form_id, idempotencyKey).first<Record<string, unknown>>();
    if (existingSubmission) {
      if (existingSubmission.payload !== JSON.stringify(values) || Boolean(existingSubmission.email_consent) !== body.email_consent) {
        return json({ error: "Idempotency key was already used for a different submission" }, 409);
      }
      return json({ ok: true, duplicate: true, submission_id: existingSubmission.id, success_message: published.success_message });
    }
    const ip = request.headers.get("cf-connecting-ip");
    const ipHash = ip ? await sha256(`${published.workspace_id}:${ip}`) : null;
    if (ipHash) {
      const recent = await env.DB.prepare(`SELECT COUNT(*) total FROM form_submissions WHERE workspace_id=? AND form_id=? AND ip_hash=? AND submitted_at>?`)
        .bind(published.workspace_id, published.form_id, ipHash, new Date(Date.now() - 600_000).toISOString()).first<{ total: number }>();
      if (Number(recent?.total || 0) >= 10) return json({ error: "Too many submissions. Try again later." }, 429, { "retry-after": "600" });
    }
    const existingContact = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND email=?")
      .bind(published.workspace_id, email).first<{ id: string }>();
    const contactId = existingContact?.id || `con_${(await sha256(`${published.workspace_id}:${email}`)).slice(0, 32)}`;
    const now = new Date().toISOString();
    const submissionId = id("fsub");
    const activityId = id("act");
    const consentId = id("consent");
    try {
      const statements = [
        env.DB.prepare(`INSERT INTO contacts(id,workspace_id,email,first_name,last_name,phone,company,status,stage,score,tags,custom_fields,source_first,source_last,last_activity_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'lead','new',0,'["form"]','{}',?,?,?, ?,?)
          ON CONFLICT(workspace_id,email) DO UPDATE SET first_name=COALESCE(NULLIF(contacts.first_name,''),excluded.first_name),
            last_name=COALESCE(NULLIF(contacts.last_name,''),excluded.last_name),phone=COALESCE(NULLIF(contacts.phone,''),excluded.phone),
            company=COALESCE(NULLIF(contacts.company,''),excluded.company),source_last=excluded.source_last,last_activity_at=excluded.last_activity_at,updated_at=excluded.updated_at`)
          .bind(contactId, published.workspace_id, email, values.first_name || null, values.last_name || null,
            values.phone || null, values.company || null, `form:${published.slug}`, `form:${published.slug}`, now, now, now),
        env.DB.prepare(`INSERT INTO form_submissions(id,workspace_id,form_id,form_version_id,idempotency_key,contact_id,payload,email_consent,consent_text,ip_hash,user_agent,submitted_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(submissionId, published.workspace_id, published.form_id, published.version_id,
          idempotencyKey, contactId, JSON.stringify(values), body.email_consent ? 1 : 0, String(published.consent_text), ipHash,
          (request.headers.get("user-agent") || "").slice(0, 300) || null, now),
        env.DB.prepare(`INSERT INTO activities(id,workspace_id,contact_id,source_id,type,title,body,metadata,external_id,occurred_at,created_at)
          VALUES(?,?,?,NULL,'form.submitted','Form submitted',?,?,?, ?,?)`).bind(activityId, published.workspace_id, contactId,
          values.message || "Public form submission", JSON.stringify({ form_id: published.form_id, version_id: published.version_id,
            email_consent: body.email_consent }), submissionId, now, now),
      ];
      if (body.email_consent) statements.push(env.DB.prepare(`INSERT INTO communication_consents
        (id,workspace_id,contact_id,channel,status,basis,evidence,captured_at,revision,change_id,created_by,created_at,updated_at)
        VALUES(?,?,?,'email','opted_in','express',?,?,1,?,'public-form',?,?)
        ON CONFLICT(workspace_id,contact_id,channel) DO UPDATE SET status='opted_in',basis='express',evidence=excluded.evidence,
          captured_at=excluded.captured_at,revision=communication_consents.revision+1,change_id=excluded.change_id,updated_at=excluded.updated_at
        WHERE communication_consents.status<>'opted_out'`)
        .bind(consentId, published.workspace_id, contactId, `Form ${published.form_id} version ${published.version_id}: ${published.consent_text}`,
          now, id("chg"), now, now));
      await env.DB.batch(statements);
    } catch {
      const raced = await env.DB.prepare(`SELECT id FROM form_submissions WHERE workspace_id=? AND form_id=? AND idempotency_key=?`)
        .bind(published.workspace_id, published.form_id, idempotencyKey).first<{ id: string }>();
      if (raced) return json({ ok: true, duplicate: true, submission_id: raced.id, success_message: published.success_message });
      return json({ error: "Submission could not be recorded" }, 500);
    }
    return json({ ok: true, duplicate: false, submission_id: submissionId, success_message: published.success_message }, 201);
  }

  const publicSurveyMatch = url.pathname.match(/^\/v1\/public\/surveys\/([a-z0-9][a-z0-9-]{2,79})$/);
  if (publicSurveyMatch) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    const row = await env.DB.prepare(`SELECT s.slug,v.id version_id,v.version,v.title,v.description,v.questions,v.success_message
      FROM surveys s JOIN survey_versions v ON v.id=s.published_version_id AND v.workspace_id=s.workspace_id
      WHERE s.slug=? AND s.status='published'`).bind(publicSurveyMatch[1]).first<Record<string, unknown>>();
    if (!row) return json({ error: "Published survey not found" }, 404);
    return json({ survey: { slug: row.slug, version: row.version, title: row.title, description: row.description,
      questions: JSON.parse(String(row.questions)), success_message: row.success_message },
      privacy: { data_use: "Aggregate survey analysis and individual response review", marketing_consent_requested: false } });
  }
  const publicSurveyResponseMatch = url.pathname.match(/^\/v1\/public\/surveys\/([a-z0-9][a-z0-9-]{2,79})\/responses$/);
  if (publicSurveyResponseMatch) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    let body: Json; try { body = await readJson(request); } catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400); }
    if (Object.keys(body).some((key) => !["answers", "privacy_accepted", "idempotency_key", "started_at", "website"].includes(key))) return json({ error: "Response contains unsupported fields" }, 400);
    if (typeof body.website === "string" && body.website.trim()) return json({ ok: true, accepted: true }, 202);
    if (body.privacy_accepted !== true) return json({ error: "Privacy acknowledgement is required" }, 400);
    const idempotencyKey = optionalString(body.idempotency_key, "idempotency_key", 100) || "";
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) return json({ error: "idempotency_key is invalid" }, 400);
    const published = await env.DB.prepare(`SELECT s.id survey_id,s.workspace_id,v.id version_id,v.questions,v.success_message
      FROM surveys s JOIN survey_versions v ON v.id=s.published_version_id AND v.workspace_id=s.workspace_id
      WHERE s.slug=? AND s.status='published'`).bind(publicSurveyResponseMatch[1]).first<Record<string, unknown>>();
    if (!published) return json({ error: "Published survey not found" }, 404);
    let answers; try { answers = validateSurveyAnswers(validateSurveyQuestions(JSON.parse(String(published.questions))), body.answers); }
    catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Answers are invalid" }, 400); }
    const encodedAnswers = JSON.stringify(answers);
    const existing = await env.DB.prepare("SELECT id,answers FROM survey_responses WHERE workspace_id=? AND survey_id=? AND idempotency_key=?")
      .bind(published.workspace_id, published.survey_id, idempotencyKey).first<Record<string, unknown>>();
    if (existing) return existing.answers === encodedAnswers ? json({ ok: true, duplicate: true, response_id: existing.id, success_message: published.success_message })
      : json({ error: "Idempotency key was already used for different answers" }, 409);
    const now = new Date(); const startedAt = typeof body.started_at === "string" && Number.isFinite(Date.parse(body.started_at)) && Date.parse(body.started_at) <= now.getTime()
      ? new Date(body.started_at).toISOString() : null;
    const duration = startedAt ? Math.min(86400, Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 1000))) : null;
    const ip = request.headers.get("cf-connecting-ip"); const ipHash = ip ? await sha256(`${published.workspace_id}:${ip}`) : null;
    if (ipHash) {
      const recent = await env.DB.prepare("SELECT COUNT(*) total FROM survey_responses WHERE workspace_id=? AND survey_id=? AND ip_hash=? AND submitted_at>?")
        .bind(published.workspace_id, published.survey_id, ipHash, new Date(now.getTime() - 600_000).toISOString()).first<{ total: number }>();
      if (Number(recent?.total || 0) >= 10) return json({ error: "Too many responses. Try again later." }, 429, { "retry-after": "600" });
    }
    const responseId = id("sresp");
    try { await env.DB.prepare(`INSERT INTO survey_responses(id,workspace_id,survey_id,survey_version_id,idempotency_key,answers,privacy_accepted,started_at,submitted_at,duration_seconds,ip_hash,user_agent)
      VALUES(?,?,?,?,?,?,1,?,?,?,?,?)`).bind(responseId, published.workspace_id, published.survey_id, published.version_id, idempotencyKey, encodedAnswers,
        startedAt, now.toISOString(), duration, ipHash, (request.headers.get("user-agent") || "").slice(0, 300) || null).run(); }
    catch {
      const raced = await env.DB.prepare("SELECT id,answers FROM survey_responses WHERE workspace_id=? AND survey_id=? AND idempotency_key=?")
        .bind(published.workspace_id, published.survey_id, idempotencyKey).first<Record<string, unknown>>();
      if (raced?.answers === encodedAnswers) return json({ ok: true, duplicate: true, response_id: raced.id, success_message: published.success_message });
      return json({ error: "Response could not be recorded" }, 500);
    }
    return json({ ok: true, duplicate: false, response_id: responseId, success_message: published.success_message }, 201);
  }

  const publicBookingMatch = url.pathname.match(/^\/v1\/public\/booking\/([a-z0-9][a-z0-9-]{2,79})$/);
  if (publicBookingMatch) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    const calendar = await env.DB.prepare("SELECT * FROM booking_calendars WHERE slug=? AND status='published'")
      .bind(publicBookingMatch[1]).first<Record<string, unknown>>();
    if (!calendar) return json({ error: "Published booking calendar not found" }, 404);
    const dateFrom = url.searchParams.get("date_from") || localDateInZone(new Date(), String(calendar.timezone));
    const days = Number(url.searchParams.get("days") || 7);
    try {
      const slots = await bookingAvailability(env, calendar, dateFrom, days);
      return json({ calendar: { slug: calendar.slug, title: calendar.title, description: calendar.description,
        timezone: calendar.timezone, duration_minutes: calendar.duration_minutes }, slots,
        range: { date_from: dateFrom, days }, provider: { mode: "local", external_sync: false } });
    } catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Availability could not be calculated" }, 500); }
  }
  const publicBookingCreateMatch = url.pathname.match(/^\/v1\/public\/booking\/([a-z0-9][a-z0-9-]{2,79})\/appointments$/);
  if (publicBookingCreateMatch) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["name", "email", "phone", "visitor_timezone", "starts_at", "privacy_accepted", "idempotency_key", "website"].includes(key))) {
      return json({ error: "Booking request contains unsupported fields" }, 400);
    }
    if (typeof body.website === "string" && body.website.trim()) return json({ ok: true, accepted: true }, 202);
    if (body.privacy_accepted !== true) return json({ error: "Privacy acknowledgement is required" }, 400);
    const name = optionalString(body.name, "name", 160) || ""; const email = normalizeEmail(body.email); const phone = optionalString(body.phone, "phone", 50);
    const visitorTimezone = optionalString(body.visitor_timezone, "visitor_timezone", 100) || ""; const startsAt = optionalString(body.starts_at, "starts_at", 50) || "";
    const idempotencyKey = optionalString(body.idempotency_key, "idempotency_key", 100) || "";
    if (!name || !validEmail(email) || !validTimeZone(visitorTimezone) || !Number.isFinite(Date.parse(startsAt)) || !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      return json({ error: "name, valid email, visitor timezone, start time, and idempotency key are required" }, 400);
    }
    const calendar = await env.DB.prepare("SELECT * FROM booking_calendars WHERE slug=? AND status='published'")
      .bind(publicBookingCreateMatch[1]).first<Record<string, unknown>>();
    if (!calendar) return json({ error: "Published booking calendar not found" }, 404);
    const canonicalStart = new Date(startsAt).toISOString();
    const existing = await env.DB.prepare("SELECT * FROM booking_appointments WHERE workspace_id=? AND calendar_id=? AND idempotency_key=?")
      .bind(calendar.workspace_id, calendar.id, idempotencyKey).first<Record<string, unknown>>();
    if (existing) {
      if (existing.email !== email || existing.starts_at !== canonicalStart || existing.name !== name) return json({ error: "Idempotency key was already used for a different booking" }, 409);
      return json({ ok: true, duplicate: true, appointment: safeAppointment(existing), manage_token: null });
    }
    const localDate = localDateInZone(new Date(canonicalStart), String(calendar.timezone));
    const offered = await bookingAvailability(env, calendar, localDate, 1);
    const slot = offered.find((candidate) => candidate.starts_at === canonicalStart);
    if (!slot) return json({ error: "That time is no longer available", code: "booking_conflict" }, 409);
    const contact = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND email=?").bind(calendar.workspace_id, email).first<{ id: string }>();
    const contactId = contact?.id || `con_${(await sha256(`${calendar.workspace_id}:${email}`)).slice(0, 32)}`;
    const appointmentId = id("appt"); const manageToken = `bman_${crmMailboxStateToken(32)}`; const manageHash = await sha256(manageToken);
    const now = new Date().toISOString(); const changeId = id("chg"); const beforeMs = Number(calendar.buffer_before_minutes) * 60_000; const afterMs = Number(calendar.buffer_after_minutes) * 60_000;
    const guardStart = new Date(Date.parse(slot.starts_at) - beforeMs).toISOString(); const guardEnd = new Date(Date.parse(slot.ends_at) + afterMs).toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM booking_calendars WHERE id=? AND workspace_id=? AND status='published')
          AND NOT EXISTS(SELECT 1 FROM booking_appointments WHERE workspace_id=? AND calendar_id=? AND status='booked' AND starts_at<? AND ends_at>?)
          THEN 1 ELSE json('booking_conflict') END`).bind(calendar.id, calendar.workspace_id, calendar.workspace_id, calendar.id, guardEnd, guardStart),
        env.DB.prepare(`INSERT INTO contacts(id,workspace_id,email,first_name,phone,status,stage,score,tags,custom_fields,source_first,source_last,last_activity_at,created_at,updated_at)
          VALUES(?,?,?,?,?,'lead','booked',0,'["booking"]','{}',?,?,?, ?,?)
          ON CONFLICT(workspace_id,email) DO UPDATE SET first_name=COALESCE(NULLIF(contacts.first_name,''),excluded.first_name),phone=COALESCE(NULLIF(contacts.phone,''),excluded.phone),
            stage='booked',source_last=excluded.source_last,last_activity_at=excluded.last_activity_at,updated_at=excluded.updated_at`)
          .bind(contactId, calendar.workspace_id, email, name, phone, `booking:${calendar.slug}`, `booking:${calendar.slug}`, now, now, now),
        env.DB.prepare(`INSERT INTO booking_appointments(id,workspace_id,calendar_id,contact_id,idempotency_key,name,email,phone,visitor_timezone,starts_at,ends_at,status,manage_token_hash,
          external_provider,external_event_id,sync_status,cancelled_at,cancellation_reason,revision,change_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'booked',?,NULL,NULL,'local',NULL,NULL,1,?,?,?)`)
          .bind(appointmentId, calendar.workspace_id, calendar.id, contactId, idempotencyKey, name, email, phone, visitorTimezone, slot.starts_at, slot.ends_at, manageHash, changeId, now, now),
        env.DB.prepare(`INSERT INTO activities(id,workspace_id,contact_id,source_id,type,title,body,metadata,external_id,occurred_at,created_at)
          VALUES(?,?,?,NULL,'calendar.meeting_scheduled','Meeting booked',?,?,?, ?,?)`).bind(id("act"), calendar.workspace_id, contactId,
          `${calendar.title} · ${slot.starts_at}`, JSON.stringify({ calendar_id: calendar.id, appointment_id: appointmentId, ends_at: slot.ends_at }), appointmentId, now, now),
        env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
          VALUES(?,?,'public',?,'booking.created','booking_appointment',?,NULL,?,?,?,?)`).bind(id("audit"), calendar.workspace_id, email, appointmentId,
          JSON.stringify({ calendar_id: calendar.id, starts_at: slot.starts_at, ends_at: slot.ends_at }), requestId(request),
          request.headers.get("cf-connecting-ip") ? await sha256(`${calendar.workspace_id}:${request.headers.get("cf-connecting-ip")}`) : null, now),
      ]);
    } catch {
      const raced = await env.DB.prepare("SELECT * FROM booking_appointments WHERE workspace_id=? AND calendar_id=? AND idempotency_key=?")
        .bind(calendar.workspace_id, calendar.id, idempotencyKey).first<Record<string, unknown>>();
      if (raced) return raced.email === email && raced.starts_at === canonicalStart ? json({ ok: true, duplicate: true, appointment: safeAppointment(raced), manage_token: null })
        : json({ error: "Idempotency key was already used for a different booking" }, 409);
      return json({ error: "That time is no longer available", code: "booking_conflict" }, 409);
    }
    const appointment = await env.DB.prepare("SELECT * FROM booking_appointments WHERE id=?").bind(appointmentId).first<Record<string, unknown>>();
    return json({ ok: true, duplicate: false, appointment: safeAppointment(appointment!), manage_token: manageToken }, 201);
  }
  if (url.pathname === "/v1/public/appointments/manage") {
    if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405, { allow: "GET, POST" });
    const token = bearer(request); if (!/^bman_[a-f0-9]{64}$/.test(token)) return json({ error: "Valid management token required" }, 401);
    const appointment = await env.DB.prepare("SELECT a.*,c.slug calendar_slug,c.title calendar_title,c.timezone calendar_timezone,c.duration_minutes,c.buffer_before_minutes,c.buffer_after_minutes,c.minimum_notice_minutes,c.maximum_days_ahead,c.status calendar_status,c.workspace_id calendar_workspace_id FROM booking_appointments a JOIN booking_calendars c ON c.id=a.calendar_id AND c.workspace_id=a.workspace_id WHERE a.manage_token_hash=?")
      .bind(await sha256(token)).first<Record<string, unknown>>();
    if (!appointment) return json({ error: "Booking not found" }, 404);
    if (request.method === "GET") return json({ appointment: safeAppointment(appointment), calendar: { slug: appointment.calendar_slug, title: appointment.calendar_title, timezone: appointment.calendar_timezone } });
    const body = await readJson(request); if (Object.keys(body).some((key) => !["action", "starts_at", "reason", "if_revision"].includes(key))) return json({ error: "Management request contains unsupported fields" }, 400);
    if (Number(body.if_revision) !== Number(appointment.revision)) return json({ error: "Booking changed since it was loaded", code: "edit_conflict" }, 409);
    const action = optionalString(body.action, "action", 20) || ""; const now = new Date().toISOString(); const changeId = id("chg");
    if (action === "cancel") {
      if (appointment.status !== "booked") return json({ error: "Booking is already cancelled" }, 409);
      const reason = optionalString(body.reason, "reason", 300);
      const changed = await env.DB.batch([
        env.DB.prepare(`UPDATE booking_appointments SET status='cancelled',cancelled_at=?,cancellation_reason=?,revision=revision+1,change_id=?,updated_at=?
          WHERE id=? AND revision=? AND status='booked'`).bind(now, reason, changeId, now, appointment.id, appointment.revision),
        env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'public',?,'booking.cancelled','booking_appointment',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM booking_appointments WHERE id=? AND change_id=?)`)
          .bind(id("audit"), appointment.workspace_id, appointment.email, appointment.id, JSON.stringify(safeAppointment(appointment)), JSON.stringify({ status: "cancelled", reason }), requestId(request), now, appointment.id, changeId),
      ]);
      if (!changed[0].meta.changes || !changed[1].meta.changes) return json({ error: "Booking changed before it could be cancelled", code: "edit_conflict" }, 409);
    } else if (action === "reschedule") {
      if (appointment.status !== "booked" || appointment.calendar_status !== "published") return json({ error: "Only an active booking on a published calendar can be rescheduled" }, 409);
      const startsAt = optionalString(body.starts_at, "starts_at", 50) || ""; if (!Number.isFinite(Date.parse(startsAt))) return json({ error: "A valid starts_at is required" }, 400);
      const canonical = new Date(startsAt).toISOString(); const calendar = { ...appointment, id: appointment.calendar_id, workspace_id: appointment.workspace_id,
        timezone: appointment.calendar_timezone, status: appointment.calendar_status };
      const offered = await bookingAvailability(env, calendar, localDateInZone(new Date(canonical), String(appointment.calendar_timezone)), 1, String(appointment.id));
      const slot = offered.find((candidate) => candidate.starts_at === canonical); if (!slot) return json({ error: "That time is no longer available", code: "booking_conflict" }, 409);
      const guardStart = new Date(Date.parse(slot.starts_at) - Number(appointment.buffer_before_minutes) * 60_000).toISOString();
      const guardEnd = new Date(Date.parse(slot.ends_at) + Number(appointment.buffer_after_minutes) * 60_000).toISOString();
      try {
        const results = await env.DB.batch([
          env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM booking_calendars WHERE id=? AND workspace_id=? AND status='published')
            AND EXISTS(SELECT 1 FROM booking_appointments WHERE id=? AND revision=? AND status='booked')
            AND NOT EXISTS(SELECT 1 FROM booking_appointments WHERE workspace_id=? AND calendar_id=? AND id<>? AND status='booked' AND starts_at<? AND ends_at>?)
            THEN 1 ELSE json('booking_conflict') END`).bind(appointment.calendar_id, appointment.workspace_id, appointment.id, appointment.revision,
              appointment.workspace_id, appointment.calendar_id, appointment.id, guardEnd, guardStart),
          env.DB.prepare(`UPDATE booking_appointments SET starts_at=?,ends_at=?,revision=revision+1,change_id=?,updated_at=? WHERE id=? AND revision=? AND status='booked'`)
            .bind(slot.starts_at, slot.ends_at, changeId, now, appointment.id, appointment.revision),
          env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
            SELECT ?,?,'public',?,'booking.rescheduled','booking_appointment',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM booking_appointments WHERE id=? AND change_id=?)`)
            .bind(id("audit"), appointment.workspace_id, appointment.email, appointment.id, JSON.stringify(safeAppointment(appointment)), JSON.stringify({ starts_at: slot.starts_at, ends_at: slot.ends_at }), requestId(request), now, appointment.id, changeId),
        ]);
        if (!results[1].meta.changes || !results[2].meta.changes) return json({ error: "Booking changed before it could be rescheduled", code: "edit_conflict" }, 409);
      } catch { return json({ error: "That time is no longer available", code: "booking_conflict" }, 409); }
    } else return json({ error: "action must be cancel or reschedule" }, 400);
    const updated = await env.DB.prepare("SELECT * FROM booking_appointments WHERE id=?").bind(appointment.id).first<Record<string, unknown>>();
    return json({ appointment: safeAppointment(updated!) });
  }

  if (url.pathname === "/v1/contacts/upsert") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    const source = await authenticateSource(request, env);
    if (!source) return json({ error: "Invalid source credential" }, 401);
    try {
      const result = await upsertContact(env, source, await readJson(request));
      return json({ ok: true, contact: result }, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ message: "contact ingestion failed", path: url.pathname, error: error instanceof Error ? error.message : "Unknown error" }));
      return json({ error: "Contact ingestion failed" }, 500);
    }
  }

  if (url.pathname === "/v1/integrations/skool/events") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    const source = await authenticateSource(request, env);
    if (!source) return json({ error: "Invalid source credential" }, 401);
    try {
      const body = await readJson(request);
      const eventType = optionalString(body.event_type, "event_type", 60);
      const externalId = optionalString(body.transaction_id || body.event_id || body.member_id, "transaction_id", 255);
      const email = normalizeEmail(body.email || body.member_email);
      const allowedEvents = new Set(["paid_member", "member_joined", "membership_questions", "member_cancelled"]);
      if (!eventType || !allowedEvents.has(eventType)) throw new ApiError(400, "event_type is invalid");
      if (!externalId) throw new ApiError(400, "transaction_id, event_id, or member_id is required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "A valid member email is required");
      const questions = body.questions === undefined ? {} : body.questions;
      if (!questions || typeof questions !== "object" || Array.isArray(questions)) throw new ApiError(400, "questions must be an object");
      const groupSlug = optionalString(body.group_slug, "group_slug", 160);
      const paidOrJoined = eventType === "paid_member" || eventType === "member_joined";
      const cancelled = eventType === "member_cancelled";
      const result = await upsertContact(env, source, {
        contact: {
          email,
          first_name: optionalString(body.first_name, "first_name", 100),
          last_name: optionalString(body.last_name, "last_name", 100),
          company: optionalString(body.company, "company", 200),
          status: cancelled ? "inactive" : paidOrJoined ? "customer" : "lead",
          stage: paidOrJoined ? "confirmed" : "new",
          tags: ["skool", `skool:${eventType}`],
          custom_fields: { skool: { group_slug: groupSlug, event_type: eventType, member_id: body.member_id || null, questions } },
        },
        event: {
          type: `skool.${eventType}`,
          external_id: externalId,
          title: `Skool ${eventType.replaceAll("_", " ")}`,
          metadata: { group_slug: groupSlug, questions },
          occurred_at: optionalString(body.created_at, "created_at", 50) || new Date().toISOString(),
        },
      });
      return json({ ok: true, contact: result, provider: "skool", event_type: eventType }, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ message: "Skool ingestion failed", error: error instanceof Error ? error.message : "Unknown error" }));
      return json({ error: "Skool ingestion failed" }, 500);
    }
  }

  const audienceIntakeMatch = url.pathname.match(
    /^\/v1\/integrations\/audience-intake\/audiencelab\/(vti_[a-f0-9]{64})$/,
  );
  if (audienceIntakeMatch) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    if (request.headers.get("x-forwarded-ingest-edge") !== "openoperator") return json({ error: "Not found" }, 404);
    const connector = await env.DB.prepare(`SELECT id,workspace_id,provider,name,active FROM visitor_connectors
      WHERE token_hash=? AND provider='audiencelab' AND active=1`)
      .bind(await sha256(audienceIntakeMatch[1]))
      .first<{ id: string; workspace_id: string; provider: string; name: string; active: number }>();
    if (!connector) return json({ error: "AudienceLab connector not found" }, 404);
    try {
      const body = await readJsonLimited(request, MAX_IMPORT_BYTES);
      const rows = Array.isArray(body.rows) ? body.rows
        : isPlainObject(body.record) ? [body.record]
        : null;
      if (!rows) throw new ApiError(400, "rows must be an array or record must be an object");
      const normalized = normalizeAudienceImport({ ...body, connector_id: connector.id, rows });
      if (!["full_refresh", "incremental"].includes(normalized.mode)) {
        throw new ApiError(400, "AudienceSync mode must be full_refresh or incremental");
      }
      return await commitAudienceImport(env, request, connector.workspace_id, connector, normalized, {
        type: "integration", connectorId: connector.id,
      });
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({
        message: "AudienceSync intake failed", connector_id: connector.id,
        error: error instanceof Error ? error.message : "Unknown error",
      }));
      return json({ error: "AudienceSync intake failed" }, 500);
    }
  }

  const visitorIntentMatch = url.pathname.match(
    /^\/v1\/integrations\/visitor-intent\/(audiencelab|rb2b)\/(vti_[a-f0-9]{64})$/,
  );
  if (visitorIntentMatch) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    if (request.headers.get("x-forwarded-ingest-edge") !== "openoperator") return json({ error: "Not found" }, 404);
    const provider = visitorIntentMatch[1] as VisitorProvider;
    const connector = await env.DB.prepare(`SELECT * FROM visitor_connectors
      WHERE token_hash=? AND provider=? AND active=1`)
      .bind(await sha256(visitorIntentMatch[2]), provider).first<Record<string, unknown>>();
    if (!connector) return json({ error: "Visitor connector not found" }, 404);
    try {
      const normalized = await normalizeVisitorEvent(provider, await readJson(request), String(connector.consent_default));
      const profileId = `vpr_${(await sha256(`${connector.id}\n${normalized.identityKey}`)).slice(0, 32)}`;
      const eventId = `vev_${(await sha256(`${connector.id}\n${normalized.dedupeKey}`)).slice(0, 32)}`;
      const ingestNonce = crypto.randomUUID();
      const now = new Date().toISOString();
      const tags = JSON.stringify(normalized.tags);
      const statements = await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO visitor_profiles
          (id,workspace_id,connector_id,provider,identity_key,identity_kind,email,first_name,last_name,
           linkedin_url,title,company_name,company_domain,industry,employee_count,estimated_revenue,
           city,region,postal_code,consent_status,review_status,matched_contact_id,visit_count,high_intent_count,
           first_seen_at,last_seen_at,latest_url,latest_referrer,tags,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',
            (SELECT id FROM contacts WHERE workspace_id=? AND email=? LIMIT 1),
            0,0,?,?,?,?,?,1,?,?)`)
          .bind(profileId, connector.workspace_id, connector.id, provider, normalized.identityKey, normalized.identityKind,
            normalized.email, normalized.firstName, normalized.lastName, normalized.linkedinUrl, normalized.title,
            normalized.companyName, normalized.companyDomain, normalized.industry, normalized.employeeCount,
            normalized.estimatedRevenue, normalized.city, normalized.region, normalized.postalCode, normalized.consentStatus,
            connector.workspace_id, normalized.email, normalized.occurredAt, normalized.occurredAt,
            normalized.capturedUrl, normalized.referrer, tags, now, now),
        env.DB.prepare(`INSERT OR IGNORE INTO visitor_events
          (id,workspace_id,connector_id,profile_id,provider,dedupe_key,ingest_nonce,occurred_at,captured_url,
           referrer,tags,is_repeat,is_high_intent,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(eventId, connector.workspace_id, connector.id, profileId, provider, normalized.dedupeKey, ingestNonce,
            normalized.occurredAt, normalized.capturedUrl, normalized.referrer, tags,
            normalized.isRepeat ? 1 : 0, normalized.isHighIntent ? 1 : 0, now),
        env.DB.prepare(`UPDATE visitor_profiles SET
          email=COALESCE(?,email),first_name=COALESCE(?,first_name),last_name=COALESCE(?,last_name),
          linkedin_url=COALESCE(?,linkedin_url),title=COALESCE(?,title),company_name=COALESCE(?,company_name),
          company_domain=COALESCE(?,company_domain),industry=COALESCE(?,industry),
          employee_count=COALESCE(?,employee_count),estimated_revenue=COALESCE(?,estimated_revenue),
          city=COALESCE(?,city),region=COALESCE(?,region),postal_code=COALESCE(?,postal_code),
          consent_status=CASE WHEN ?='unknown' THEN consent_status ELSE ? END,
          matched_contact_id=COALESCE(matched_contact_id,
            (SELECT id FROM contacts WHERE workspace_id=? AND email=? LIMIT 1)),
          visit_count=visit_count+1,high_intent_count=high_intent_count+?,
          first_seen_at=MIN(first_seen_at,?),
          latest_url=CASE WHEN ?>=last_seen_at THEN COALESCE(?,latest_url) ELSE latest_url END,
          latest_referrer=CASE WHEN ?>=last_seen_at THEN COALESCE(?,latest_referrer) ELSE latest_referrer END,
          tags=CASE WHEN ?>=last_seen_at THEN ? ELSE tags END,
          last_seen_at=MAX(last_seen_at,?),revision=revision+1,updated_at=?
          WHERE id=? AND EXISTS(
            SELECT 1 FROM visitor_events WHERE id=? AND ingest_nonce=?
          )`)
          .bind(normalized.email, normalized.firstName, normalized.lastName, normalized.linkedinUrl, normalized.title,
            normalized.companyName, normalized.companyDomain, normalized.industry, normalized.employeeCount,
            normalized.estimatedRevenue, normalized.city, normalized.region, normalized.postalCode,
            normalized.consentStatus, normalized.consentStatus, connector.workspace_id, normalized.email,
            normalized.isHighIntent ? 1 : 0, normalized.occurredAt,
            normalized.occurredAt, normalized.capturedUrl, normalized.occurredAt, normalized.referrer,
            normalized.occurredAt, tags, normalized.occurredAt, now, profileId, eventId, ingestNonce),
        env.DB.prepare(`UPDATE visitor_connectors
          SET last_event_at=MAX(COALESCE(last_event_at,''),?),updated_at=?
          WHERE id=? AND EXISTS(SELECT 1 FROM visitor_events WHERE id=? AND ingest_nonce=?)`)
          .bind(normalized.occurredAt, now, connector.id, eventId, ingestNonce),
      ]);
      const duplicate = !statements[1].meta.changes;
      const profile = await env.DB.prepare(`SELECT id,review_status,matched_contact_id,visit_count,high_intent_count
        FROM visitor_profiles WHERE id=?`).bind(profileId)
        .first<{ id: string; review_status: string; matched_contact_id: string | null; visit_count: number; high_intent_count: number }>();
      return json({
        ok: true, duplicate, profile_id: profileId, review_status: profile?.review_status,
        matched_contact: Boolean(profile?.matched_contact_id), high_intent: normalized.isHighIntent,
        visit_count: profile?.visit_count || 0,
      }, duplicate ? 200 : 202);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({
        message: "Visitor intent ingestion failed", provider,
        connector_id: connector.id, error: error instanceof Error ? error.message : "Unknown error",
      }));
      return json({ error: "Visitor intent ingestion failed" }, 500);
    }
  }

  const inboundWebhookMatch = url.pathname.match(/^\/v1\/hooks\/([^/]+)$/);
  if (inboundWebhookMatch) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    const endpoint = await env.DB.prepare(`SELECT * FROM webhook_endpoints
      WHERE id=? AND direction='inbound' AND active=1`).bind(inboundWebhookMatch[1]).first<Record<string, unknown>>();
    if (!endpoint) return json({ error: "Webhook endpoint not found" }, 404);
    try {
      const bodyText = await readTextBody(request);
      const eventId = optionalString(request.headers.get("x-crm-event-id"), "x-crm-event-id", 255);
      const signatureHeader = request.headers.get("x-crm-signature") || "";
      const timestamp = signatureHeader.match(/(?:^|,)t=(\d{10,13})(?:,|$)/)?.[1] || "";
      const signature = signatureHeader.match(/(?:^|,)v1=([a-f0-9]{64})(?:,|$)/)?.[1] || "";
      const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
      if (!eventId || !timestamp || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 300_000) return json({ error: "Invalid or expired webhook signature" }, 401);
      const secret = await decryptSecret(env, String(endpoint.secret_ciphertext));
      if (!(await verifyWebhookSignature(secret, timestamp, bodyText, signature))) return json({ error: "Invalid or expired webhook signature" }, 401);
      let payload: Json;
      try {
        const parsed = JSON.parse(bodyText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        payload = parsed as Json;
      } catch {
        return json({ error: "Request body must be a JSON object" }, 400);
      }
      const deliveryId = id("delivery");
      const now = new Date().toISOString();
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries
        (id,workspace_id,endpoint_id,event_id,direction,status,attempts,request_body,created_at,updated_at)
        VALUES(?,?,?,?,?,'processing',1,?,?,?)`)
        .bind(deliveryId, endpoint.workspace_id, endpoint.id, eventId, "inbound", bodyText, now, now).run();
      if (!inserted.meta.changes) return json({ ok: true, duplicate: true });
      try {
        const result = await upsertContact(env, {
          id: null, slug: `webhook:${endpoint.id}`, workspace_id: endpoint.workspace_id,
        }, payload);
        await env.DB.prepare("UPDATE webhook_deliveries SET status='succeeded',updated_at=? WHERE id=?").bind(new Date().toISOString(), deliveryId).run();
        return json({ ok: true, duplicate: false, contact: result }, result.created ? 201 : 200);
      } catch (error) {
        await env.DB.prepare("UPDATE webhook_deliveries SET status='failed',response_excerpt=?,updated_at=? WHERE id=?")
          .bind(error instanceof Error ? error.message.slice(0, 1000) : "Unknown error", new Date().toISOString(), deliveryId).run();
        throw error;
      }
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ message: "inbound webhook failed", endpoint_id: inboundWebhookMatch[1], error: error instanceof Error ? error.message : "Unknown error" }));
      return json({ error: "Webhook processing failed" }, 500);
    }
  }

  if (url.pathname === "/v1/internal/jobs/webhook-retries") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    if (!(await claimSchedulerRequest(request, env, "webhook-retries"))) return json({ error: "Unauthorized" }, 401);
    const batch = await processWebhookRetries(env, null, 50);
    const summaries = new Map<string, { processed: number; succeeded: number; failed: number; retrying: number }>();
    for (const result of batch.results) {
      const summary = summaries.get(result.workspace_id) || { processed: 0, succeeded: 0, failed: 0, retrying: 0 };
      summary.processed += 1;
      if (result.status === "succeeded") summary.succeeded += 1;
      else if (result.status === "failed") summary.failed += 1;
      else summary.retrying += 1;
      summaries.set(result.workspace_id, summary);
    }
    await Promise.all([...summaries].map(([workspaceId, summary]) => systemAudit(
      env, workspaceId, "webhook-retry-scheduler", "webhooks.retry_processed",
      "webhook_delivery_batch", id("batch"), summary,
    )));
    const scheduledHealth = await retainScheduledOperationsHealth(env);
    const healthResults = scheduledHealth.results;
    return json({
      ok: true,
      due: batch.due,
      processed: batch.results.length,
      health: {
        workspaces: healthResults.length,
        sampled: scheduledHealth.sampled,
        total_active: scheduledHealth.total,
        cursor_workspace_id: scheduledHealth.cursor_workspace_id,
        action: healthResults.filter((result) => result.health.status === "action").length,
        opened: healthResults.filter((result) => result.transition === "opened").length,
        resolved: healthResults.filter((result) => result.transition === "resolved").length,
      },
    });
  }

  const access = await getWorkspaceAccess(request, env);
  if (!access) return json({ error: "Unauthorized" }, 401);
  const workspaceId = access.workspaceId;
  const allowedPrivateMethods = privateAllowedMethods(url.pathname);
  if (allowedPrivateMethods && !allowedPrivateMethods.includes(request.method)) {
    return json({ error: "Method not allowed" }, 405, { allow: allowedPrivateMethods.join(", ") });
  }

  if (url.pathname === "/v1/admin/workspaces" && request.method === "GET") {
    const memberships = await env.DB.prepare(`SELECT w.id,w.slug,w.name,w.status,w.onboarding_status,m.role
      FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.email=? AND m.active=1 AND w.status='active'
      ORDER BY w.name`).bind(access.email).all();
    return json({ active_workspace_id: workspaceId, workspaces: memberships.results });
  }

  if (url.pathname === "/v1/admin/product-catalog" && request.method === "GET") {
    const catalogErrors = [...validateProductCatalog(), ...validateWorkerCatalogBindings()];
    if (catalogErrors.length) {
      console.error(JSON.stringify({
        event: "product_catalog.invalid",
        version: PRODUCT_CATALOG_VERSION,
        errors: catalogErrors,
      }));
      return json({ error: "The product catalog is invalid" }, 500);
    }
    const configuredBindings = new Set<string>();
    if (env.COMPOSIO_API_KEY) configuredBindings.add("COMPOSIO_API_KEY");
    if (env.COMPOSIO_GMAIL_AUTH_CONFIG_ID) configuredBindings.add("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
    if (env.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID) configuredBindings.add("COMPOSIO_OUTLOOK_AUTH_CONFIG_ID");
    if (env.WEBHOOK_ENCRYPTION_KEY && env.WEBHOOK_ENCRYPTION_KEY.length >= 24) configuredBindings.add("WEBHOOK_ENCRYPTION_KEY");
    return json({
      ...publicProductCatalog(),
      integrations: integrationCatalog.map((integration) => ({
        ...integration,
        runtime: {
          configured: integration.availability === "implemented" &&
            integration.requiredBindings.every((binding) => configuredBindings.has(binding)),
          missingBindings: integration.requiredBindings.filter((binding) => !configuredBindings.has(binding)),
        },
      })),
      pipeline: pipelineCatalog,
      currentUser: { role: access.role },
    });
  }

  if (url.pathname === "/v1/admin/reports/revenue-funnel" && request.method === "GET") {
    const now = new Date();
    const presetRaw = url.searchParams.get("preset") || "30";
    const startRaw = url.searchParams.get("start");
    const endRaw = url.searchParams.get("end");
    let start: Date; let end: Date; let preset: string;
    if (startRaw || endRaw) {
      const parsedStart = startRaw ? parseLocalDate(startRaw) : null;
      const parsedEnd = endRaw ? parseLocalDate(endRaw) : null;
      if (!parsedStart || !parsedEnd) {
        return json({ error: "Custom report ranges require start and end dates in YYYY-MM-DD format" }, 400);
      }
      start = parsedStart.date;
      end = parsedEnd.date;
      end.setUTCDate(end.getUTCDate() + 1);
      preset = "custom";
    } else {
      const days = Number(presetRaw);
      if (![7, 30, 90].includes(days)) return json({ error: "preset must be 7, 30, or 90" }, 400);
      end = now;
      start = new Date(end.getTime() - days * 86_400_000);
      preset = String(days);
    }
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start ||
      end.getTime() - start.getTime() > 366 * 86_400_000 || end.getTime() > now.getTime() + 86_400_000) {
      return json({ error: "Report range must be a valid interval of 366 days or fewer and cannot extend beyond today" }, 400);
    }
    const startIso = start.toISOString(); const endIso = end.toISOString();
    const canReadOpportunities = await hasWorkspaceGrant(env, access, "opportunity", "read");
    const [contactSummary, dailyContacts, lifecycle, sources, opportunitySummary, opportunityValues, dailyOpportunities, pipelineStages] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) new_contacts,
        SUM(CASE WHEN status='customer' THEN 1 ELSE 0 END) current_customers
        FROM contacts WHERE workspace_id=? AND created_at>=? AND created_at<?`).bind(workspaceId, startIso, endIso).first<Record<string, number>>(),
      env.DB.prepare(`SELECT substr(created_at,1,10) day,COUNT(*) contacts,
        SUM(CASE WHEN status='customer' THEN 1 ELSE 0 END) current_customers
        FROM contacts WHERE workspace_id=? AND created_at>=? AND created_at<? GROUP BY substr(created_at,1,10) ORDER BY day`)
        .bind(workspaceId, startIso, endIso).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT stage,COUNT(*) contacts FROM contacts WHERE workspace_id=? AND created_at>=? AND created_at<?
        GROUP BY stage ORDER BY contacts DESC,stage`).bind(workspaceId, startIso, endIso).all<Record<string, unknown>>(),
      canReadOpportunities ? env.DB.prepare(`SELECT COALESCE(NULLIF(c.source_first,''),'direct / unknown') source,
        COUNT(DISTINCT c.id) contacts,COUNT(DISTINCT CASE WHEN c.status='customer' THEN c.id END) current_customers,
        COUNT(DISTINCT CASE WHEN o.status='won' THEN c.id END) won_contacts
        FROM contacts c LEFT JOIN opportunities o ON o.workspace_id=c.workspace_id AND o.contact_id=c.id
        WHERE c.workspace_id=? AND c.created_at>=? AND c.created_at<? GROUP BY COALESCE(NULLIF(c.source_first,''),'direct / unknown')
        ORDER BY contacts DESC,source LIMIT 101`).bind(workspaceId, startIso, endIso).all<Record<string, unknown>>() :
        env.DB.prepare(`SELECT COALESCE(NULLIF(source_first,''),'direct / unknown') source,COUNT(*) contacts,
          SUM(CASE WHEN status='customer' THEN 1 ELSE 0 END) current_customers
          FROM contacts WHERE workspace_id=? AND created_at>=? AND created_at<?
          GROUP BY COALESCE(NULLIF(source_first,''),'direct / unknown') ORDER BY contacts DESC,source LIMIT 101`)
          .bind(workspaceId, startIso, endIso).all<Record<string, unknown>>(),
      canReadOpportunities ? env.DB.prepare(`SELECT COUNT(*) opportunities,
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_opportunities,
        SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) current_won,
        SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) current_lost
        FROM opportunities WHERE workspace_id=? AND created_at>=? AND created_at<?`).bind(workspaceId, startIso, endIso).first<Record<string, number>>() : null,
      canReadOpportunities ? env.DB.prepare(`SELECT currency,
        COALESCE(SUM(CASE WHEN status='open' THEN value ELSE 0 END),0) open_value,
        COALESCE(SUM(CASE WHEN status='won' THEN value ELSE 0 END),0) current_won_value
        FROM opportunities WHERE workspace_id=? AND created_at>=? AND created_at<? GROUP BY currency ORDER BY currency`)
        .bind(workspaceId, startIso, endIso).all<Record<string, unknown>>() : null,
      canReadOpportunities ? env.DB.prepare(`SELECT substr(created_at,1,10) day,COUNT(*) opportunities,
        SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) current_won,
        SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) current_lost
        FROM opportunities WHERE workspace_id=? AND created_at>=? AND created_at<? GROUP BY substr(created_at,1,10) ORDER BY day`)
        .bind(workspaceId, startIso, endIso).all<Record<string, unknown>>() : null,
      canReadOpportunities ? env.DB.prepare(`SELECT p.id pipeline_id,p.name pipeline_name,s.id stage_id,s.name stage_name,s.position,s.category,s.color,
        COUNT(o.id) opportunities
        FROM pipelines p JOIN pipeline_stages s ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id
        LEFT JOIN opportunities o ON o.workspace_id=p.workspace_id AND o.pipeline_id=p.id AND o.stage_id=s.id AND o.created_at>=? AND o.created_at<?
        WHERE p.workspace_id=? AND p.active=1 GROUP BY p.id,s.id ORDER BY p.created_at,s.position`)
        .bind(startIso, endIso, workspaceId).all<Record<string, unknown>>() : null,
    ]);
    const sourceRows = sources.results.slice(0, 100).map((row) => canReadOpportunities ? row : {
      source: row.source, contacts: row.contacts, current_customers: row.current_customers,
    });
    return json({
      range: { preset, start: startIso, end_exclusive: endIso, timezone: "UTC" },
      permissions: { contacts: true, opportunities: canReadOpportunities },
      summary: {
        new_contacts: Number(contactSummary?.new_contacts || 0), current_customers: Number(contactSummary?.current_customers || 0),
        ...(canReadOpportunities ? {
          opportunities: Number(opportunitySummary?.opportunities || 0), open_opportunities: Number(opportunitySummary?.open_opportunities || 0),
          current_won: Number(opportunitySummary?.current_won || 0), current_lost: Number(opportunitySummary?.current_lost || 0),
        } : {}),
      },
      values_by_currency: canReadOpportunities ? opportunityValues?.results || [] : null,
      daily: Array.from(new Set([...dailyContacts.results.map((row) => String(row.day)),
        ...(canReadOpportunities ? dailyOpportunities?.results.map((row) => String(row.day)) || [] : [])])).sort().map((day) => ({
          day, ...(dailyContacts.results.find((row) => row.day === day) || { contacts: 0, current_customers: 0 }),
          ...(canReadOpportunities ? dailyOpportunities?.results.find((row) => row.day === day) ||
            { opportunities: 0, current_won: 0, current_lost: 0 } : {}),
        })),
      lifecycle_distribution: lifecycle.results,
      source_first_touch: { rows: sourceRows, truncated: sources.results.length > 100 },
      pipeline_stage_snapshot: canReadOpportunities ? pipelineStages?.results || [] : null,
      methodology: {
        cohort: "Records created inside the selected UTC range, grouped by their current state.",
        conversion: "Snapshot distribution only; this is not historical stage-transition conversion.",
        attribution: "First-touch source grouping is directional and must not be interpreted as causal attribution.",
        currency: "Values retain each record's stored currency; totals are not FX-normalized.",
      },
      generated_at: now.toISOString(),
    });
  }

  if (url.pathname === "/v1/admin/payments/ledger" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const currency = (url.searchParams.get("currency") || "").toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) return json({ error: "currency must be a three-letter ISO code" }, 400);
    const rows = await env.DB.prepare(`SELECT e.*,c.email contact_email,trim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) contact_name,o.name opportunity_name
      FROM payment_ledger_entries e LEFT JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
      LEFT JOIN opportunities o ON o.workspace_id=e.workspace_id AND o.id=e.opportunity_id
      WHERE e.workspace_id=? AND (?='' OR e.currency=?) ORDER BY e.occurred_at DESC,e.id DESC LIMIT 501`)
      .bind(workspaceId, currency, currency).all<Record<string, unknown>>();
    const [balances, contacts, opportunities] = await Promise.all([
      env.DB.prepare(`SELECT currency,
      SUM(CASE kind WHEN 'payment' THEN amount_minor WHEN 'dispute_reversal' THEN amount_minor ELSE -amount_minor END) net_minor,
      SUM(CASE WHEN kind='payment' THEN amount_minor ELSE 0 END) gross_minor,
      SUM(CASE WHEN kind='refund' THEN amount_minor ELSE 0 END) refunded_minor,
      SUM(CASE WHEN kind='dispute' THEN amount_minor ELSE 0 END)-SUM(CASE WHEN kind='dispute_reversal' THEN amount_minor ELSE 0 END) disputed_minor
      FROM payment_ledger_entries WHERE workspace_id=? GROUP BY currency ORDER BY currency`).bind(workspaceId).all(),
      env.DB.prepare(`SELECT id,email,first_name,last_name FROM contacts WHERE workspace_id=? ORDER BY updated_at DESC,id LIMIT 200`)
        .bind(workspaceId).all(),
      env.DB.prepare(`SELECT id,contact_id,name,currency FROM opportunities WHERE workspace_id=? ORDER BY updated_at DESC,id LIMIT 200`)
        .bind(workspaceId).all(),
    ]);
    return json({ entries: rows.results.slice(0, 500).map(safePaymentEntry), balances: balances.results,
      links: { contacts: contacts.results, opportunities: opportunities.results },
      truncated: rows.results.length > 500, provider_boundary: { mode: "manual", external_providers: false },
      accounting: { amounts: "integer minor units", model: "append-only events", currency_conversion: false } });
  }
  if (url.pathname === "/v1/admin/payments/ledger" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["contact_id", "opportunity_id", "amount_minor", "currency", "description", "occurred_at", "idempotency_key", "provider_reference", "confirmation"].includes(key))) {
      return json({ error: "Payment request contains unsupported fields" }, 400);
    }
    if (body.confirmation !== "RECORD PAYMENT") return json({ error: "Explicit payment confirmation is required" }, 400);
    let money; try { money = validateMoneyInput(body); } catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Payment is invalid" }, 400); }
    const contactId = optionalString(body.contact_id, "contact_id", 100); const opportunityId = optionalString(body.opportunity_id, "opportunity_id", 100);
    const providerReference = optionalString(body.provider_reference, "provider_reference", 160);
    if (!contactId && !opportunityId) return json({ error: "A contact or opportunity link is required" }, 400);
    const [contact, opportunity] = await Promise.all([
      contactId ? env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=?").bind(workspaceId, contactId).first() : null,
      opportunityId ? env.DB.prepare("SELECT id,contact_id FROM opportunities WHERE workspace_id=? AND id=?").bind(workspaceId, opportunityId).first<{ id: string; contact_id: string }>() : null,
    ]);
    if (contactId && !contact || opportunityId && !opportunity || opportunity && contactId && opportunity.contact_id !== contactId) return json({ error: "Linked contact or opportunity is invalid" }, 400);
    const resolvedContactId = contactId || opportunity?.contact_id || null;
    const existing = await env.DB.prepare("SELECT * FROM payment_ledger_entries WHERE workspace_id=? AND idempotency_key=?").bind(workspaceId, money.idempotencyKey).first<Record<string, unknown>>();
    if (existing) {
      if (existing.kind !== "payment" || existing.amount_minor !== money.amountMinor || existing.currency !== money.currency || existing.contact_id !== resolvedContactId || existing.opportunity_id !== (opportunityId || null)) {
        return json({ error: "Idempotency key was already used for a different ledger event" }, 409);
      }
      return json({ entry: safePaymentEntry(existing), duplicate: true });
    }
    const entryId = id("pay"); const now = new Date().toISOString();
    try { await env.DB.batch([
      env.DB.prepare(`INSERT INTO payment_ledger_entries(id,workspace_id,contact_id,opportunity_id,parent_entry_id,idempotency_key,kind,amount_minor,currency,description,provider,provider_reference,occurred_at,created_by,created_at)
        VALUES(?,?,?,?,?,?,'payment',?,?,?,'manual',?,?,?,?)`).bind(entryId, workspaceId, resolvedContactId, opportunityId || null, null, money.idempotencyKey,
          money.amountMinor, money.currency, money.description, providerReference, money.occurredAt, access.email, now),
      await auditStatement(env, access, request, "payment.recorded", "payment_ledger_entry", entryId, null,
        { kind: "payment", amount_minor: money.amountMinor, currency: money.currency, contact_id: resolvedContactId, opportunity_id: opportunityId || null }),
    ]); } catch {
      const raced = await env.DB.prepare("SELECT * FROM payment_ledger_entries WHERE workspace_id=? AND idempotency_key=?").bind(workspaceId, money.idempotencyKey).first<Record<string, unknown>>();
      if (raced && raced.kind === "payment" && raced.amount_minor === money.amountMinor && raced.currency === money.currency && raced.contact_id === resolvedContactId && raced.opportunity_id === (opportunityId || null)) return json({ entry: safePaymentEntry(raced), duplicate: true });
      return providerReference ? json({ error: "Payment reference or idempotency key already exists" }, 409) : json({ error: "Payment could not be recorded" }, 500);
    }
    const created = await env.DB.prepare("SELECT * FROM payment_ledger_entries WHERE id=?").bind(entryId).first<Record<string, unknown>>();
    return json({ entry: safePaymentEntry(created!), duplicate: false }, 201);
  }
  const paymentAdjustmentMatch = url.pathname.match(/^\/v1\/admin\/payments\/ledger\/(pay_[a-f0-9]{32})\/adjustments$/);
  if (paymentAdjustmentMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["kind", "amount_minor", "currency", "description", "occurred_at", "idempotency_key", "provider_reference", "confirmation"].includes(key))) return json({ error: "Adjustment request contains unsupported fields" }, 400);
    const kind = optionalString(body.kind, "kind", 30) || "";
    if (!["refund", "dispute", "dispute_reversal"].includes(kind) || body.confirmation !== `RECORD ${kind.replace("_", " ").toUpperCase()}`) return json({ error: "Valid adjustment kind and explicit confirmation are required" }, 400);
    let money; try { money = validateMoneyInput(body); } catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Adjustment is invalid" }, 400); }
    const parent = await env.DB.prepare("SELECT * FROM payment_ledger_entries WHERE workspace_id=? AND id=? AND kind='payment'").bind(workspaceId, paymentAdjustmentMatch[1]).first<Record<string, unknown>>();
    if (!parent) return json({ error: "Original payment not found" }, 404);
    if (parent.currency !== money.currency) return json({ error: "Adjustment currency must match the original payment" }, 400);
    const existing = await env.DB.prepare("SELECT * FROM payment_ledger_entries WHERE workspace_id=? AND idempotency_key=?").bind(workspaceId, money.idempotencyKey).first<Record<string, unknown>>();
    if (existing) return existing.kind === kind && existing.parent_entry_id === parent.id && existing.amount_minor === money.amountMinor && existing.currency === money.currency
      ? json({ entry: safePaymentEntry(existing), duplicate: true }) : json({ error: "Idempotency key was already used for a different ledger event" }, 409);
    const totals = await env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='refund' THEN amount_minor ELSE 0 END),0) refunded,
      COALESCE(SUM(CASE WHEN kind='dispute' THEN amount_minor ELSE 0 END),0) disputed,
      COALESCE(SUM(CASE WHEN kind='dispute_reversal' THEN amount_minor ELSE 0 END),0) reversed
      FROM payment_ledger_entries WHERE workspace_id=? AND parent_entry_id=?`).bind(workspaceId, parent.id).first<Record<string, number>>();
    const remaining = kind === "refund" ? Number(parent.amount_minor) - Number(totals?.refunded || 0)
      : kind === "dispute" ? Number(parent.amount_minor) - Number(totals?.disputed || 0)
        : Number(totals?.disputed || 0) - Number(totals?.reversed || 0);
    if (money.amountMinor > remaining) return json({ error: "Adjustment exceeds the eligible remaining amount", remaining_minor: remaining }, 409);
    const entryId = id("pay"); const now = new Date().toISOString(); const providerReference = optionalString(body.provider_reference, "provider_reference", 160);
    try { await env.DB.batch([
      env.DB.prepare(`SELECT CASE WHEN ? <= (CASE ? WHEN 'refund' THEN CAST(? AS INTEGER)-COALESCE(SUM(CASE WHEN kind='refund' THEN amount_minor ELSE 0 END),0)
        WHEN 'dispute' THEN CAST(? AS INTEGER)-COALESCE(SUM(CASE WHEN kind='dispute' THEN amount_minor ELSE 0 END),0)
        ELSE COALESCE(SUM(CASE WHEN kind='dispute' THEN amount_minor ELSE 0 END),0)-COALESCE(SUM(CASE WHEN kind='dispute_reversal' THEN amount_minor ELSE 0 END),0) END)
        THEN 1 ELSE json('adjustment_conflict') END FROM payment_ledger_entries WHERE workspace_id=? AND (id=? OR parent_entry_id=?)`)
        .bind(money.amountMinor, kind, parent.amount_minor, parent.amount_minor, workspaceId, parent.id, parent.id),
      env.DB.prepare(`INSERT INTO payment_ledger_entries(id,workspace_id,contact_id,opportunity_id,parent_entry_id,idempotency_key,kind,amount_minor,currency,description,provider,provider_reference,occurred_at,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'manual',?,?,?,?)`).bind(entryId, workspaceId, parent.contact_id, parent.opportunity_id, parent.id, money.idempotencyKey, kind,
          money.amountMinor, money.currency, money.description, providerReference, money.occurredAt, access.email, now),
      await auditStatement(env, access, request, `payment.${kind}`, "payment_ledger_entry", entryId, null,
        { parent_entry_id: parent.id, kind, amount_minor: money.amountMinor, currency: money.currency }),
    ]); } catch {
      const raced = await env.DB.prepare("SELECT * FROM payment_ledger_entries WHERE workspace_id=? AND idempotency_key=?").bind(workspaceId, money.idempotencyKey).first<Record<string, unknown>>();
      if (raced && raced.kind === kind && raced.parent_entry_id === parent.id && raced.amount_minor === money.amountMinor) return json({ entry: safePaymentEntry(raced), duplicate: true });
      return json({ error: "Adjustment conflicts with a concurrent event or duplicate reference" }, 409);
    }
    const created = await env.DB.prepare("SELECT * FROM payment_ledger_entries WHERE id=?").bind(entryId).first<Record<string, unknown>>();
    return json({ entry: safePaymentEntry(created!), duplicate: false, signed_amount_minor: paymentSignedAmount(kind, money.amountMinor) }, 201);
  }

  if (url.pathname === "/v1/admin/booking-calendars" && request.method === "GET") {
    const rows = await env.DB.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM booking_appointments a WHERE a.workspace_id=c.workspace_id AND a.calendar_id=c.id AND a.status='booked') appointment_count,
      (SELECT MIN(starts_at) FROM booking_appointments a WHERE a.workspace_id=c.workspace_id AND a.calendar_id=c.id AND a.status='booked' AND starts_at>?) next_appointment_at
      FROM booking_calendars c WHERE c.workspace_id=? ORDER BY c.updated_at DESC,c.id`).bind(new Date().toISOString(), workspaceId).all<Record<string, unknown>>();
    const rules = await env.DB.prepare(`SELECT calendar_id,day_of_week,start_minute,end_minute FROM booking_availability_rules
      WHERE workspace_id=? ORDER BY calendar_id,day_of_week,start_minute`).bind(workspaceId).all<BookingRule & { calendar_id: string }>();
    return json({ calendars: rows.results.map((row) => ({ ...safeBookingCalendar(row, rules.results.filter((rule) => rule.calendar_id === row.id)),
      appointment_count: row.appointment_count, next_appointment_at: row.next_appointment_at })) });
  }
  if (url.pathname === "/v1/admin/booking-calendars" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["name", "title", "timezone"].includes(key))) return json({ error: "Calendar request contains unsupported fields" }, 400);
    const name = optionalString(body.name, "name", 120) || ""; const title = optionalString(body.title, "title", 160) || "";
    const timezone = optionalString(body.timezone, "timezone", 100) || "UTC";
    if (!name || !title || !validTimeZone(timezone)) return json({ error: "name, title, and a valid timezone are required" }, 400);
    const calendarId = id("bcal"); const now = new Date().toISOString(); const changeId = id("chg");
    const slugBase = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "calendar";
    const slug = `${slugBase}-${calendarId.slice(-8)}`;
    const defaults: BookingRule[] = [1, 2, 3, 4, 5].map((day_of_week) => ({ day_of_week, start_minute: 540, end_minute: 1020 }));
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO booking_calendars(id,workspace_id,name,slug,status,title,description,timezone,duration_minutes,buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,maximum_days_ahead,revision,change_id,created_by,created_at,updated_at)
        VALUES(?,?,?,?,'draft',?,'',?,30,0,0,60,60,1,?,?,?,?)`).bind(calendarId, workspaceId, name, slug, title, timezone, changeId, access.email, now, now),
      ...defaults.map((rule) => env.DB.prepare(`INSERT INTO booking_availability_rules(id,workspace_id,calendar_id,day_of_week,start_minute,end_minute,created_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(id("brule"), workspaceId, calendarId, rule.day_of_week, rule.start_minute, rule.end_minute, now)),
      await auditStatement(env, access, request, "booking_calendar.created", "booking_calendar", calendarId, null, { name, slug, title, timezone }),
    ]);
    const created = await env.DB.prepare("SELECT * FROM booking_calendars WHERE workspace_id=? AND id=?").bind(workspaceId, calendarId).first<Record<string, unknown>>();
    return json({ calendar: safeBookingCalendar(created!, defaults) }, 201);
  }
  const adminBookingMatch = url.pathname.match(/^\/v1\/admin\/booking-calendars\/(bcal_[a-f0-9]{32})$/);
  if (adminBookingMatch && request.method === "GET") {
    const calendar = await env.DB.prepare("SELECT * FROM booking_calendars WHERE workspace_id=? AND id=?").bind(workspaceId, adminBookingMatch[1]).first<Record<string, unknown>>();
    if (!calendar) return json({ error: "Booking calendar not found" }, 404);
    const rules = await env.DB.prepare(`SELECT day_of_week,start_minute,end_minute FROM booking_availability_rules WHERE workspace_id=? AND calendar_id=? ORDER BY day_of_week,start_minute`)
      .bind(workspaceId, calendar.id).all<BookingRule>();
    return json({ calendar: safeBookingCalendar(calendar, rules.results) });
  }
  if (adminBookingMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const allowed = ["name", "title", "description", "timezone", "duration_minutes", "buffer_before_minutes", "buffer_after_minutes", "minimum_notice_minutes", "maximum_days_ahead", "availability", "if_revision"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) return json({ error: "Calendar update contains unsupported fields" }, 400);
    const before = await env.DB.prepare("SELECT * FROM booking_calendars WHERE workspace_id=? AND id=?").bind(workspaceId, adminBookingMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Booking calendar not found" }, 404);
    if (Number(body.if_revision) !== Number(before.revision)) return json({ error: "Calendar changed since it was loaded", code: "edit_conflict" }, 409);
    const name = optionalString(body.name, "name", 120) || ""; const title = optionalString(body.title, "title", 160) || "";
    const description = optionalString(body.description, "description", 1000) || ""; const timezone = optionalString(body.timezone, "timezone", 100) || "";
    const duration = Number(body.duration_minutes); const bufferBefore = Number(body.buffer_before_minutes); const bufferAfter = Number(body.buffer_after_minutes);
    const notice = Number(body.minimum_notice_minutes); const maximum = Number(body.maximum_days_ahead); const rules = validateBookingRules(body.availability);
    if (!name || !title || !validTimeZone(timezone) || !Number.isInteger(duration) || duration < 15 || duration > 180 ||
      !Number.isInteger(bufferBefore) || bufferBefore < 0 || bufferBefore > 120 || !Number.isInteger(bufferAfter) || bufferAfter < 0 || bufferAfter > 120 ||
      !Number.isInteger(notice) || notice < 0 || notice > 43200 || !Number.isInteger(maximum) || maximum < 1 || maximum > 365) {
      return json({ error: "Calendar settings are invalid" }, 400);
    }
    const now = new Date().toISOString(); const changeId = id("chg");
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM booking_calendars WHERE workspace_id=? AND id=? AND revision=?) THEN 1 ELSE json('edit_conflict') END`)
          .bind(workspaceId, before.id, before.revision),
        env.DB.prepare(`UPDATE booking_calendars SET name=?,title=?,description=?,timezone=?,duration_minutes=?,buffer_before_minutes=?,buffer_after_minutes=?,minimum_notice_minutes=?,maximum_days_ahead=?,revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
          .bind(name, title, description, timezone, duration, bufferBefore, bufferAfter, notice, maximum, changeId, now, workspaceId, before.id, before.revision),
        env.DB.prepare("DELETE FROM booking_availability_rules WHERE workspace_id=? AND calendar_id=?").bind(workspaceId, before.id),
        ...rules.map((rule) => env.DB.prepare(`INSERT INTO booking_availability_rules(id,workspace_id,calendar_id,day_of_week,start_minute,end_minute,created_at) VALUES(?,?,?,?,?,?,?)`)
          .bind(id("brule"), workspaceId, before.id, rule.day_of_week, rule.start_minute, rule.end_minute, now)),
        env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'user',?,'booking_calendar.updated','booking_calendar',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM booking_calendars WHERE workspace_id=? AND id=? AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeBookingCalendar(before)), JSON.stringify({ name, title, timezone, duration_minutes: duration, availability: rules }), requestId(request), now, workspaceId, before.id, changeId),
      ]);
      if (!results[1].meta.changes || !results.at(-1)?.meta.changes) throw new Error("edit_conflict");
    } catch { return json({ error: "Calendar changed before it could be saved", code: "edit_conflict" }, 409); }
    const updated = await env.DB.prepare("SELECT * FROM booking_calendars WHERE workspace_id=? AND id=?").bind(workspaceId, before.id).first<Record<string, unknown>>();
    return json({ calendar: safeBookingCalendar(updated!, rules) });
  }
  const bookingLifecycleMatch = url.pathname.match(/^\/v1\/admin\/booking-calendars\/(bcal_[a-f0-9]{32})\/(publish|revoke)$/);
  if (bookingLifecycleMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["if_revision", "confirmation"].includes(key))) return json({ error: "Lifecycle request contains unsupported fields" }, 400);
    const before = await env.DB.prepare("SELECT * FROM booking_calendars WHERE workspace_id=? AND id=?").bind(workspaceId, bookingLifecycleMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Booking calendar not found" }, 404);
    const action = bookingLifecycleMatch[2]; const expected = action === "publish" ? "PUBLISH CALENDAR" : "REVOKE CALENDAR";
    if (Number(body.if_revision) !== Number(before.revision)) return json({ error: "Calendar changed since it was loaded", code: "edit_conflict" }, 409);
    if (body.confirmation !== expected) return json({ error: "Explicit lifecycle confirmation is required" }, 400);
    if (action === "revoke" && before.status !== "published") return json({ error: "Only a published calendar can be revoked" }, 409);
    const rules = await env.DB.prepare("SELECT day_of_week,start_minute,end_minute FROM booking_availability_rules WHERE workspace_id=? AND calendar_id=?")
      .bind(workspaceId, before.id).all<BookingRule>();
    validateBookingRules(rules.results);
    const status = action === "publish" ? "published" : "revoked"; const now = new Date().toISOString(); const changeId = id("chg");
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE booking_calendars SET status=?,revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
        .bind(status, changeId, now, workspaceId, before.id, before.revision),
      env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
        SELECT ?,?,'user',?,?,'booking_calendar',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM booking_calendars WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, `booking_calendar.${action}ed`, before.id, JSON.stringify(safeBookingCalendar(before)), JSON.stringify({ status }), requestId(request), now, workspaceId, before.id, changeId),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) return json({ error: `Calendar changed before it could be ${action}ed`, code: "edit_conflict" }, 409);
    const updated = await env.DB.prepare("SELECT * FROM booking_calendars WHERE workspace_id=? AND id=?").bind(workspaceId, before.id).first<Record<string, unknown>>();
    return json({ calendar: safeBookingCalendar(updated!, rules.results) });
  }
  const bookingAppointmentsMatch = url.pathname.match(/^\/v1\/admin\/booking-calendars\/(bcal_[a-f0-9]{32})\/appointments$/);
  if (bookingAppointmentsMatch && request.method === "GET") {
    const exists = await env.DB.prepare("SELECT id FROM booking_calendars WHERE workspace_id=? AND id=?").bind(workspaceId, bookingAppointmentsMatch[1]).first();
    if (!exists) return json({ error: "Booking calendar not found" }, 404);
    const rows = await env.DB.prepare(`SELECT * FROM booking_appointments WHERE workspace_id=? AND calendar_id=? ORDER BY starts_at DESC,id DESC LIMIT 200`)
      .bind(workspaceId, bookingAppointmentsMatch[1]).all<Record<string, unknown>>();
    return json({ appointments: rows.results.map(safeAppointment), truncated: rows.results.length === 200 });
  }

  if (url.pathname === "/v1/admin/forms" && request.method === "GET") {
    const rows = await env.DB.prepare(`SELECT f.*,(SELECT COUNT(*) FROM form_submissions s WHERE s.workspace_id=f.workspace_id AND s.form_id=f.id) submission_count,
      (SELECT MAX(submitted_at) FROM form_submissions s WHERE s.workspace_id=f.workspace_id AND s.form_id=f.id) last_submission_at
      FROM forms f WHERE f.workspace_id=? ORDER BY f.updated_at DESC,f.id`).bind(workspaceId).all<Record<string, unknown>>();
    return json({ forms: rows.results.map((row) => ({ ...safeForm(row), submission_count: row.submission_count, last_submission_at: row.last_submission_at })) });
  }
  if (url.pathname === "/v1/admin/forms" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["name", "title"].includes(key))) return json({ error: "Form request contains unsupported fields" }, 400);
    const name = optionalString(body.name, "name", 120) || "";
    const title = optionalString(body.title, "title", 160) || "";
    if (!name || !title) return json({ error: "name and title are required" }, 400);
    const slugBase = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "form";
    const formId = id("form"); const now = new Date().toISOString(); const changeId = id("chg");
    const slug = `${slugBase}-${formId.slice(-8)}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO forms(id,workspace_id,name,slug,status,title,description,fields,consent_text,success_message,published_version_id,revision,change_id,created_by,created_at,updated_at)
        VALUES(?,?,?,?,'draft',?,'',?,?,'Thanks — your request was received.',NULL,1,?,?,?,?)`)
        .bind(formId, workspaceId, name, slug, title, JSON.stringify(formFieldDefaults),
          "I agree to receive email updates and marketing messages. Consent is optional and can be withdrawn at any time.", changeId, access.email, now, now),
      await auditStatement(env, access, request, "form.created", "form", formId, null, { name, slug, title }),
    ]);
    const created = await env.DB.prepare("SELECT * FROM forms WHERE workspace_id=? AND id=?").bind(workspaceId, formId).first<Record<string, unknown>>();
    return json({ form: safeForm(created!) }, 201);
  }
  const adminFormMatch = url.pathname.match(/^\/v1\/admin\/forms\/(form_[a-f0-9]{32})$/);
  if (adminFormMatch && request.method === "GET") {
    const form = await env.DB.prepare("SELECT * FROM forms WHERE workspace_id=? AND id=?").bind(workspaceId, adminFormMatch[1]).first<Record<string, unknown>>();
    if (!form) return json({ error: "Form not found" }, 404);
    const versions = await env.DB.prepare(`SELECT id,version,published_by,published_at FROM form_versions WHERE workspace_id=? AND form_id=? ORDER BY version DESC`)
      .bind(workspaceId, form.id).all();
    return json({ form: safeForm(form), versions: versions.results });
  }
  if (adminFormMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["name", "title", "description", "fields", "consent_text", "success_message", "if_revision"].includes(key))) {
      return json({ error: "Form update contains unsupported fields" }, 400);
    }
    const before = await env.DB.prepare("SELECT * FROM forms WHERE workspace_id=? AND id=?").bind(workspaceId, adminFormMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Form not found" }, 404);
    if (Number(body.if_revision) !== Number(before.revision)) return json({ error: "Form changed since it was loaded", code: "edit_conflict" }, 409);
    const name = optionalString(body.name, "name", 120) || ""; const title = optionalString(body.title, "title", 160) || "";
    const description = optionalString(body.description, "description", 1000) || "";
    const consentText = optionalString(body.consent_text, "consent_text", 800) || "";
    const successMessage = optionalString(body.success_message, "success_message", 300) || "";
    if (!name || !title || !consentText || !successMessage) return json({ error: "name, title, consent_text, and success_message are required" }, 400);
    const fields = validateFormFields(body.fields); const now = new Date().toISOString(); const changeId = id("chg");
    const changed = await env.DB.batch([
      env.DB.prepare(`UPDATE forms SET name=?,title=?,description=?,fields=?,consent_text=?,success_message=?,revision=revision+1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=?`).bind(name, title, description, JSON.stringify(fields), consentText, successMessage,
        changeId, now, workspaceId, before.id, before.revision),
      env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
        SELECT ?,?,'user',?,'form.updated','form',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM forms WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeForm(before)), JSON.stringify({ name, title, description, fields }),
          requestId(request), now, workspaceId, before.id, changeId),
    ]);
    if (!changed[0].meta.changes || !changed[1].meta.changes) return json({ error: "Form changed before it could be saved", code: "edit_conflict" }, 409);
    const updated = await env.DB.prepare("SELECT * FROM forms WHERE workspace_id=? AND id=?").bind(workspaceId, before.id).first<Record<string, unknown>>();
    return json({ form: safeForm(updated!) });
  }
  const formLifecycleMatch = url.pathname.match(/^\/v1\/admin\/forms\/(form_[a-f0-9]{32})\/(publish|revoke)$/);
  if (formLifecycleMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["if_revision", "confirmation"].includes(key))) return json({ error: "Lifecycle request contains unsupported fields" }, 400);
    const before = await env.DB.prepare("SELECT * FROM forms WHERE workspace_id=? AND id=?").bind(workspaceId, formLifecycleMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Form not found" }, 404);
    if (Number(body.if_revision) !== Number(before.revision)) return json({ error: "Form changed since it was loaded", code: "edit_conflict" }, 409);
    const action = formLifecycleMatch[2];
    if (body.confirmation !== (action === "publish" ? "PUBLISH FORM" : "REVOKE FORM")) return json({ error: "Explicit lifecycle confirmation is required" }, 400);
    if (action === "revoke" && before.status !== "published") return json({ error: "Only a published form can be revoked" }, 409);
    validateFormFields(JSON.parse(String(before.fields)));
    const now = new Date().toISOString(); const changeId = id("chg");
    if (action === "publish") {
      const versionRow = await env.DB.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM form_versions WHERE workspace_id=? AND form_id=?")
        .bind(workspaceId, before.id).first<{ version: number }>();
      const versionId = id("fver");
      let results;
      try { results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO form_versions(id,workspace_id,form_id,version,title,description,fields,consent_text,success_message,published_by,published_at)
          SELECT ?,workspace_id,id,?,?,?,?,?,?,?,? FROM forms WHERE workspace_id=? AND id=? AND revision=?`)
          .bind(versionId, Number(versionRow?.version || 1), before.title, before.description, before.fields, before.consent_text,
            before.success_message, access.email, now, workspaceId, before.id, before.revision),
        env.DB.prepare(`UPDATE forms SET status='published',published_version_id=?,revision=revision+1,change_id=?,updated_at=?
          WHERE workspace_id=? AND id=? AND revision=?`).bind(versionId, changeId, now, workspaceId, before.id, before.revision),
        env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'user',?,'form.published','form',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM forms WHERE workspace_id=? AND id=? AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeForm(before)), JSON.stringify({ version_id: versionId, version: versionRow?.version }),
            requestId(request), now, workspaceId, before.id, changeId),
      ]); } catch {
        const raced = await env.DB.prepare("SELECT revision FROM forms WHERE workspace_id=? AND id=?")
          .bind(workspaceId, before.id).first<{ revision: number }>();
        if (Number(raced?.revision) !== Number(before.revision)) return json({ error: "Form changed before it could be published", code: "edit_conflict" }, 409);
        return json({ error: "Form could not be published" }, 500);
      }
      if (!results[0].meta.changes || !results[1].meta.changes || !results[2].meta.changes) return json({ error: "Form changed before it could be published", code: "edit_conflict" }, 409);
    } else {
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE forms SET status='revoked',revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
          .bind(changeId, now, workspaceId, before.id, before.revision),
        env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'user',?,'form.revoked','form',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM forms WHERE workspace_id=? AND id=? AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeForm(before)), JSON.stringify({ status: "revoked" }),
            requestId(request), now, workspaceId, before.id, changeId),
      ]);
      if (!results[0].meta.changes || !results[1].meta.changes) return json({ error: "Form changed before it could be revoked", code: "edit_conflict" }, 409);
    }
    const updated = await env.DB.prepare("SELECT * FROM forms WHERE workspace_id=? AND id=?").bind(workspaceId, before.id).first<Record<string, unknown>>();
    return json({ form: safeForm(updated!) });
  }
  const formSubmissionsMatch = url.pathname.match(/^\/v1\/admin\/forms\/(form_[a-f0-9]{32})\/submissions$/);
  if (formSubmissionsMatch && request.method === "GET") {
    const exists = await env.DB.prepare("SELECT id FROM forms WHERE workspace_id=? AND id=?").bind(workspaceId, formSubmissionsMatch[1]).first();
    if (!exists) return json({ error: "Form not found" }, 404);
    const rows = await env.DB.prepare(`SELECT * FROM form_submissions WHERE workspace_id=? AND form_id=? ORDER BY submitted_at DESC,id DESC LIMIT 100`)
      .bind(workspaceId, formSubmissionsMatch[1]).all<Record<string, unknown>>();
    return json({ submissions: rows.results.map(safeFormSubmission), truncated: rows.results.length === 100 });
  }

  if (url.pathname === "/v1/admin/surveys" && request.method === "GET") {
    const rows = await env.DB.prepare(`SELECT s.*,(SELECT COUNT(*) FROM survey_responses r WHERE r.workspace_id=s.workspace_id AND r.survey_id=s.id) response_count,
      (SELECT MAX(submitted_at) FROM survey_responses r WHERE r.workspace_id=s.workspace_id AND r.survey_id=s.id) last_response_at
      FROM surveys s WHERE s.workspace_id=? ORDER BY s.updated_at DESC,s.id`).bind(workspaceId).all<Record<string, unknown>>();
    return json({ surveys: rows.results.map((row) => ({ ...safeSurvey(row), response_count: row.response_count, last_response_at: row.last_response_at })) });
  }
  if (url.pathname === "/v1/admin/surveys" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request); if (Object.keys(body).some((key) => !["name", "title"].includes(key))) return json({ error: "Survey request contains unsupported fields" }, 400);
    const name = optionalString(body.name, "name", 120) || ""; const title = optionalString(body.title, "title", 160) || "";
    if (!name || !title) return json({ error: "name and title are required" }, 400);
    const surveyId = id("survey"); const now = new Date().toISOString(); const changeId = id("chg");
    const slugBase = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "survey";
    const slug = `${slugBase}-${surveyId.slice(-8)}`; const questions: SurveyQuestion[] = [{ id: "experience", label: "How would you rate your experience?", type: "rating", required: true, options: [] }];
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO surveys(id,workspace_id,name,slug,status,title,description,questions,success_message,published_version_id,revision,change_id,created_by,created_at,updated_at)
        VALUES(?,?,?,?,'draft',?,'',?,'Thanks — your response was recorded.',NULL,1,?,?,?,?)`).bind(surveyId, workspaceId, name, slug, title, JSON.stringify(questions), changeId, access.email, now, now),
      await auditStatement(env, access, request, "survey.created", "survey", surveyId, null, { name, slug, title }),
    ]);
    const created = await env.DB.prepare("SELECT * FROM surveys WHERE workspace_id=? AND id=?").bind(workspaceId, surveyId).first<Record<string, unknown>>();
    return json({ survey: safeSurvey(created!) }, 201);
  }
  const adminSurveyMatch = url.pathname.match(/^\/v1\/admin\/surveys\/(survey_[a-f0-9]{32})$/);
  if (adminSurveyMatch && request.method === "GET") {
    const survey = await env.DB.prepare("SELECT * FROM surveys WHERE workspace_id=? AND id=?").bind(workspaceId, adminSurveyMatch[1]).first<Record<string, unknown>>();
    if (!survey) return json({ error: "Survey not found" }, 404);
    const versions = await env.DB.prepare("SELECT id,version,published_by,published_at FROM survey_versions WHERE workspace_id=? AND survey_id=? ORDER BY version DESC")
      .bind(workspaceId, survey.id).all();
    return json({ survey: safeSurvey(survey), versions: versions.results });
  }
  if (adminSurveyMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request); if (Object.keys(body).some((key) => !["name", "title", "description", "questions", "success_message", "if_revision"].includes(key))) return json({ error: "Survey update contains unsupported fields" }, 400);
    const before = await env.DB.prepare("SELECT * FROM surveys WHERE workspace_id=? AND id=?").bind(workspaceId, adminSurveyMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Survey not found" }, 404);
    if (Number(body.if_revision) !== Number(before.revision)) return json({ error: "Survey changed since it was loaded", code: "edit_conflict" }, 409);
    const name = optionalString(body.name, "name", 120) || ""; const title = optionalString(body.title, "title", 160) || "";
    const description = optionalString(body.description, "description", 1000) || ""; const successMessage = optionalString(body.success_message, "success_message", 300) || "";
    if (!name || !title || !successMessage) return json({ error: "name, title, and success_message are required" }, 400);
    const questions = validateSurveyQuestions(body.questions); const now = new Date().toISOString(); const changeId = id("chg");
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE surveys SET name=?,title=?,description=?,questions=?,success_message=?,revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
        .bind(name, title, description, JSON.stringify(questions), successMessage, changeId, now, workspaceId, before.id, before.revision),
      env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
        SELECT ?,?,'user',?,'survey.updated','survey',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM surveys WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeSurvey(before)), JSON.stringify({ name, title, description, questions }), requestId(request), now, workspaceId, before.id, changeId),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) return json({ error: "Survey changed before it could be saved", code: "edit_conflict" }, 409);
    const updated = await env.DB.prepare("SELECT * FROM surveys WHERE workspace_id=? AND id=?").bind(workspaceId, before.id).first<Record<string, unknown>>();
    return json({ survey: safeSurvey(updated!) });
  }
  const surveyLifecycleMatch = url.pathname.match(/^\/v1\/admin\/surveys\/(survey_[a-f0-9]{32})\/(publish|revoke)$/);
  if (surveyLifecycleMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request); if (Object.keys(body).some((key) => !["if_revision", "confirmation"].includes(key))) return json({ error: "Lifecycle request contains unsupported fields" }, 400);
    const before = await env.DB.prepare("SELECT * FROM surveys WHERE workspace_id=? AND id=?").bind(workspaceId, surveyLifecycleMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Survey not found" }, 404);
    if (Number(body.if_revision) !== Number(before.revision)) return json({ error: "Survey changed since it was loaded", code: "edit_conflict" }, 409);
    const action = surveyLifecycleMatch[2]; if (body.confirmation !== (action === "publish" ? "PUBLISH SURVEY" : "REVOKE SURVEY")) return json({ error: "Explicit lifecycle confirmation is required" }, 400);
    if (action === "revoke" && before.status !== "published") return json({ error: "Only a published survey can be revoked" }, 409);
    validateSurveyQuestions(JSON.parse(String(before.questions))); const now = new Date().toISOString(); const changeId = id("chg");
    if (action === "publish") {
      const next = await env.DB.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM survey_versions WHERE workspace_id=? AND survey_id=?").bind(workspaceId, before.id).first<{ version: number }>();
      const versionId = id("sver");
      try { const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO survey_versions(id,workspace_id,survey_id,version,title,description,questions,success_message,published_by,published_at)
          SELECT ?,workspace_id,id,?,?,?,?,?,?,? FROM surveys WHERE workspace_id=? AND id=? AND revision=?`).bind(versionId, Number(next?.version || 1), before.title, before.description, before.questions, before.success_message, access.email, now, workspaceId, before.id, before.revision),
        env.DB.prepare("UPDATE surveys SET status='published',published_version_id=?,revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?")
          .bind(versionId, changeId, now, workspaceId, before.id, before.revision),
        env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'user',?,'survey.published','survey',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM surveys WHERE workspace_id=? AND id=? AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeSurvey(before)), JSON.stringify({ version_id: versionId, version: next?.version }), requestId(request), now, workspaceId, before.id, changeId),
      ]); if (results.some((result) => !result.meta.changes)) throw new Error("conflict"); }
      catch { return json({ error: "Survey changed before it could be published", code: "edit_conflict" }, 409); }
    } else {
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE surveys SET status='revoked',revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?").bind(changeId, now, workspaceId, before.id, before.revision),
        env.DB.prepare(`INSERT INTO audit_log(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'user',?,'survey.revoked','survey',?,?,?,?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM surveys WHERE workspace_id=? AND id=? AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeSurvey(before)), JSON.stringify({ status: "revoked" }), requestId(request), now, workspaceId, before.id, changeId),
      ]); if (results.some((result) => !result.meta.changes)) return json({ error: "Survey changed before it could be revoked", code: "edit_conflict" }, 409);
    }
    const updated = await env.DB.prepare("SELECT * FROM surveys WHERE workspace_id=? AND id=?").bind(workspaceId, before.id).first<Record<string, unknown>>();
    return json({ survey: safeSurvey(updated!) });
  }
  const surveyResponsesMatch = url.pathname.match(/^\/v1\/admin\/surveys\/(survey_[a-f0-9]{32})\/responses$/);
  if (surveyResponsesMatch && request.method === "GET") {
    const survey = await env.DB.prepare("SELECT id FROM surveys WHERE workspace_id=? AND id=?").bind(workspaceId, surveyResponsesMatch[1]).first<Record<string, unknown>>();
    if (!survey) return json({ error: "Survey not found" }, 404);
    const rows = await env.DB.prepare(`SELECT r.id,r.survey_version_id,r.answers,r.started_at,r.submitted_at,r.duration_seconds,v.version,v.questions
      FROM survey_responses r JOIN survey_versions v ON v.id=r.survey_version_id AND v.workspace_id=r.workspace_id
      WHERE r.workspace_id=? AND r.survey_id=? ORDER BY r.submitted_at DESC,r.id DESC LIMIT 101`)
      .bind(workspaceId, survey.id).all<Record<string, unknown>>();
    const evidence = rows.results.slice(0, 100).map((row) => ({ ...row, answers: JSON.parse(String(row.answers)) })) as Array<Record<string, unknown> & { answers: Record<string, unknown> }>;
    const versions = [...new Set(evidence.map((row) => Number(row.version)))];
    const versionSummaries = versions.map((version) => {
      const versionRows = evidence.filter((row) => Number(row.version) === version);
      const questions = validateSurveyQuestions(JSON.parse(String(versionRows[0].questions)));
      const summary = questions.map((question) => { const values = versionRows.map((row) => (row.answers as Record<string, unknown>)[question.id]).filter((value) => value !== undefined);
        const counts = question.type === "single_choice" || question.type === "multi_choice" ? question.options.map((option) => ({ option, count: values.filter((value) => Array.isArray(value) ? value.includes(option) : value === option).length })) : null;
        const average = question.type === "rating" && values.length ? values.reduce<number>((sum, value) => sum + Number(value), 0) / values.length : null;
        return { question_id: question.id, label: question.label, type: question.type, answered: values.length, counts, average }; });
      return { version, response_count: versionRows.length, summary };
    });
    const responses = evidence.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "questions")));
    return json({ responses, version_summaries: versionSummaries, truncated: rows.results.length > 100 });
  }

  const communicationConsentMatch = url.pathname.match(/^\/v1\/admin\/contacts\/([^/]+)\/communication-consent$/);
  if (communicationConsentMatch && request.method === "GET") {
    const contact = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=?")
      .bind(workspaceId, communicationConsentMatch[1]).first();
    if (!contact) return json({ error: "Contact not found" }, 404);
    const consent = await env.DB.prepare(`SELECT * FROM communication_consents
      WHERE workspace_id=? AND contact_id=? AND channel='email'`).bind(workspaceId, communicationConsentMatch[1])
      .first<Record<string, unknown>>();
    return json({ consent: safeCommunicationConsent(consent || null) });
  }
  if (communicationConsentMatch && request.method === "PUT") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["status", "basis", "evidence", "captured_at", "if_revision"].includes(key))) {
      return json({ error: "Consent request contains unsupported fields" }, 400);
    }
    const contact = await env.DB.prepare("SELECT id,email FROM contacts WHERE workspace_id=? AND id=?")
      .bind(workspaceId, communicationConsentMatch[1]).first<{ id: string; email: string }>();
    if (!contact) return json({ error: "Contact not found" }, 404);
    const status = optionalString(body.status, "status", 20) || "";
    const basis = optionalString(body.basis, "basis", 30) || "";
    const evidence = optionalString(body.evidence, "evidence", 500);
    const capturedAt = optionalString(body.captured_at, "captured_at", 50);
    if (!["opted_in", "opted_out"].includes(status)) return json({ error: "status must be opted_in or opted_out" }, 400);
    const allowedBases = status === "opted_in" ? ["express", "contractual", "inbound_request"] : ["manual_suppression"];
    if (!allowedBases.includes(basis)) return json({ error: "basis is incompatible with consent status" }, 400);
    if (!evidence) return json({ error: "evidence is required" }, 400);
    if (!capturedAt || !Number.isFinite(Date.parse(capturedAt)) || capturedAt > new Date(Date.now() + 60_000).toISOString()) {
      return json({ error: "captured_at must be a valid non-future timestamp" }, 400);
    }
    const before = await env.DB.prepare(`SELECT * FROM communication_consents
      WHERE workspace_id=? AND contact_id=? AND channel='email'`).bind(workspaceId, contact.id)
      .first<Record<string, unknown>>();
    const expectedRevision = before ? Number(body.if_revision) : 0;
    if (before && (!Number.isInteger(expectedRevision) || expectedRevision !== Number(before.revision))) {
      return json({ error: "Consent changed since it was loaded", code: "edit_conflict" }, 409);
    }
    const consentId = before ? String(before.id) : id("consent");
    const now = new Date().toISOString();
    const changeId = id("chg");
    const revision = before ? Number(before.revision) + 1 : 1;
    const after = { id: consentId, contact_id: contact.id, channel: "email", status, basis, evidence,
      captured_at: capturedAt, revision, updated_at: now };
    const ip = request.headers.get("cf-connecting-ip");
    const ipHash = ip ? await sha256(ip) : null;
    const changed = await env.DB.batch([
      env.DB.prepare(`INSERT INTO communication_consents
        (id,workspace_id,contact_id,channel,status,basis,evidence,captured_at,revision,change_id,created_by,created_at,updated_at)
        VALUES(?,?,?,'email',?,?,?,?,1,?,?,?,?)
        ON CONFLICT(workspace_id,contact_id,channel) DO UPDATE SET
          status=excluded.status,basis=excluded.basis,evidence=excluded.evidence,captured_at=excluded.captured_at,
          revision=communication_consents.revision+1,change_id=excluded.change_id,updated_at=excluded.updated_at
        WHERE communication_consents.revision=?`)
        .bind(consentId, workspaceId, contact.id, status, basis, evidence, capturedAt, changeId,
          access.email, now, now, expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'communication_consent.updated','communication_consent',?,?,?,?,?,?
        WHERE changes()>0 AND EXISTS(SELECT 1 FROM communication_consents WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, consentId, before ? JSON.stringify(safeCommunicationConsent(before)) : null,
          JSON.stringify(after), requestId(request), ipHash, now, workspaceId, consentId, changeId),
    ]);
    if (!changed[0].meta.changes || !changed[1].meta.changes) {
      return json({ error: "Consent changed before it could be saved", code: "edit_conflict" }, 409);
    }
    return json({ consent: after }, before ? 200 : 201);
  }

  if (url.pathname === "/v1/admin/conversations" && request.method === "GET") {
    const requestedLimit = Number(url.searchParams.get("limit") || 50);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      return json({ error: "limit must be an integer from 1 to 100" }, 400);
    }
    const limit = requestedLimit;
    const threads = await env.DB.prepare(`SELECT t.*,
      TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) contact_name,
      cc.id consent_id,cc.status consent_status,cc.basis consent_basis,cc.evidence consent_evidence,
      cc.captured_at consent_captured_at,cc.revision consent_revision,cc.updated_at consent_updated_at
      FROM conversation_threads t
      LEFT JOIN contacts c ON c.workspace_id=t.workspace_id AND c.id=t.contact_id
      LEFT JOIN communication_consents cc ON cc.workspace_id=t.workspace_id AND cc.contact_id=t.contact_id AND cc.channel='email'
      WHERE t.workspace_id=? ORDER BY t.last_message_at DESC,t.id DESC LIMIT ?`)
      .bind(workspaceId, limit).all<Record<string, unknown>>();
    return json({ threads: threads.results.map(safeConversationThread), truncated: threads.results.length === limit,
      limits: { threads: 100, messages_per_thread: 100, body_characters: 10_000 } });
  }

  const conversationThreadMatch = url.pathname.match(/^\/v1\/admin\/conversations\/(thread_[a-f0-9]{32})$/);
  if (conversationThreadMatch && request.method === "GET") {
    const thread = await env.DB.prepare(`SELECT t.*,
      TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) contact_name,
      cc.id consent_id,cc.status consent_status,cc.basis consent_basis,cc.evidence consent_evidence,
      cc.captured_at consent_captured_at,cc.revision consent_revision,cc.updated_at consent_updated_at
      FROM conversation_threads t
      LEFT JOIN contacts c ON c.workspace_id=t.workspace_id AND c.id=t.contact_id
      LEFT JOIN communication_consents cc ON cc.workspace_id=t.workspace_id AND cc.contact_id=t.contact_id AND cc.channel='email'
      WHERE t.workspace_id=? AND t.id=?`).bind(workspaceId, conversationThreadMatch[1])
      .first<Record<string, unknown>>();
    if (!thread) return json({ error: "Conversation not found" }, 404);
    const messages = await env.DB.prepare(`SELECT * FROM conversation_messages
      WHERE workspace_id=? AND thread_id=? ORDER BY occurred_at ASC,id ASC LIMIT 100`)
      .bind(workspaceId, conversationThreadMatch[1]).all<Record<string, unknown>>();
    return json({ thread: safeConversationThread(thread), messages: messages.results.map(safeConversationMessage),
      truncated: messages.results.length === 100 });
  }

  if (conversationThreadMatch && request.method === "PATCH") {
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["status", "mark_read", "if_revision"].includes(key))) {
      return json({ error: "Conversation update contains unsupported fields" }, 400);
    }
    const before = await env.DB.prepare("SELECT * FROM conversation_threads WHERE workspace_id=? AND id=?")
      .bind(workspaceId, conversationThreadMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Conversation not found" }, 404);
    if (Number(body.if_revision) !== Number(before.revision)) return json({ error: "Conversation changed since it was loaded", code: "edit_conflict" }, 409);
    const status = body.status === undefined ? String(before.status) : optionalString(body.status, "status", 10) || "";
    if (!["open", "closed"].includes(status)) return json({ error: "status must be open or closed" }, 400);
    if (body.mark_read !== undefined && body.mark_read !== true) return json({ error: "mark_read must be true" }, 400);
    const unreadCount = body.mark_read === true ? 0 : Number(before.unread_count);
    const now = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const changeId = id("chg");
    const after = { ...before, status, unread_count: unreadCount, revision: Number(before.revision) + 1,
      change_id: changeId, updated_at: now };
    const ip = request.headers.get("cf-connecting-ip");
    const changed = await env.DB.batch([
      env.DB.prepare(`UPDATE conversation_threads SET status=?,unread_count=?,revision=revision+1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=?`)
        .bind(status, unreadCount, changeId, now, workspaceId, before.id, before.revision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'conversation.updated','conversation_thread',?,?,?,?,?,?
        WHERE changes()>0 AND EXISTS(SELECT 1 FROM conversation_threads WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(before), JSON.stringify(after),
          requestId(request), ip ? await sha256(ip) : null, now, workspaceId, before.id, changeId),
    ]);
    if (!changed[0].meta.changes) return json({ error: "Conversation changed before it could be saved", code: "edit_conflict" }, 409);
    const updated = await env.DB.prepare("SELECT * FROM conversation_threads WHERE workspace_id=? AND id=?")
      .bind(workspaceId, before.id).first<Record<string, unknown>>();
    return json({ thread: safeConversationThread(updated!) });
  }

  if (url.pathname === "/v1/admin/conversations/send" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["contact_id", "thread_id", "subject", "text", "purpose", "idempotency_key", "confirmation"].includes(key))) {
      return json({ error: "Conversation send contains unsupported fields" }, 400);
    }
    const contactId = optionalString(body.contact_id, "contact_id", 80) || "";
    const threadIdInput = optionalString(body.thread_id, "thread_id", 80);
    const subject = optionalString(body.subject, "subject", 200) || "";
    const text = optionalString(body.text, "text", 10_000) || "";
    const purpose = optionalString(body.purpose, "purpose", 20) || "";
    const idempotencyKey = optionalString(body.idempotency_key, "idempotency_key", 100) || "";
    if (!contactId || !subject || !text) return json({ error: "contact_id, subject, and text are required" }, 400);
    if (!["transactional", "marketing"].includes(purpose)) return json({ error: "purpose must be transactional or marketing" }, 400);
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) return json({ error: "idempotency_key is invalid" }, 400);
    if (body.confirmation !== "SEND EMAIL") return json({ error: "Explicit send confirmation is required" }, 400);
    if (threadIdInput && !/^thread_[a-f0-9]{32}$/.test(threadIdInput)) return json({ error: "thread_id is invalid" }, 400);
    const contact = await env.DB.prepare("SELECT id,email FROM contacts WHERE workspace_id=? AND id=?")
      .bind(workspaceId, contactId).first<{ id: string; email: string }>();
    if (!contact || !validEmail(normalizeEmail(contact.email))) return json({ error: "Contact with a valid email was not found" }, 404);
    const consent = await env.DB.prepare(`SELECT * FROM communication_consents
      WHERE workspace_id=? AND contact_id=? AND channel='email'`).bind(workspaceId, contact.id)
      .first<Record<string, unknown>>();
    const consentAllows = consent && consent.status === "opted_in" && (purpose !== "marketing" || consent.basis === "express");
    if (!consentAllows) return json({ error: purpose === "marketing"
      ? "Marketing email requires current express opt-in evidence"
      : "Transactional email requires current recorded permission", code: "email_consent_required" }, 409);
    const existingMessage = await env.DB.prepare(`SELECT * FROM conversation_messages
      WHERE workspace_id=? AND idempotency_key=?`).bind(workspaceId, idempotencyKey).first<Record<string, unknown>>();
    if (existingMessage) {
      if (existingMessage.to_email !== normalizeEmail(contact.email) || existingMessage.subject !== subject ||
        existingMessage.body_text !== text || existingMessage.purpose !== purpose) {
        return json({ error: "Idempotency key was already used for a different conversation message" }, 409);
      }
      return json({ ok: existingMessage.status === "sent", replayed: true, message: safeConversationMessage(existingMessage) },
        existingMessage.status === "sent" ? 200 : 409);
    }
    const connection = await env.DB.prepare(`SELECT * FROM resend_connections
      WHERE workspace_id=? AND status='active' LIMIT 1`).bind(workspaceId).first<Record<string, unknown>>();
    if (!connection) return json({ error: "A verified Resend connection is required" }, 409);
    let thread: Record<string, unknown> | null = null;
    if (threadIdInput) {
      thread = await env.DB.prepare(`SELECT * FROM conversation_threads
        WHERE workspace_id=? AND id=? AND contact_id=? AND status='open'`).bind(workspaceId, threadIdInput, contact.id)
        .first<Record<string, unknown>>();
      if (!thread) return json({ error: "Open conversation was not found for this contact" }, 404);
    }
    const now = new Date().toISOString();
    const threadId = thread ? String(thread.id) : id("thread");
    const messageId = id("msg");
    try {
      const statements = [];
      if (!thread) statements.push(env.DB.prepare(`INSERT INTO conversation_threads
        (id,workspace_id,contact_id,channel,participant_email,subject,status,last_message_at,unread_count,revision,change_id,created_at,updated_at)
        VALUES(?,?,?,'email',?,?,'open',?,0,1,?,?,?)`)
        .bind(threadId, workspaceId, contact.id, normalizeEmail(contact.email), subject, now, id("chg"), now, now));
      else statements.push(env.DB.prepare(`UPDATE conversation_threads SET last_message_at=?,revision=revision+1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND status='open'`).bind(now, id("chg"), now, workspaceId, threadId));
      statements.push(env.DB.prepare(`INSERT INTO conversation_messages
        (id,workspace_id,thread_id,direction,provider,provider_message_id,idempotency_key,from_email,to_email,subject,
         body_text,purpose,status,error,sent_by,occurred_at,created_at,updated_at)
        VALUES(?,?,?,'outbound','resend',NULL,?,?,?,?,?,?,'pending',NULL,?,?,?,?)`)
        .bind(messageId, workspaceId, threadId, idempotencyKey, String(connection.from_email), normalizeEmail(contact.email),
          subject, text, purpose, access.email, now, now, now));
      statements.push(await auditStatement(env, access, request, "conversation.message_queued", "conversation_message", messageId, null,
        { thread_id: threadId, contact_id: contact.id, recipient: normalizeEmail(contact.email), subject, purpose }));
      await env.DB.batch(statements);
    } catch {
      const raced = await env.DB.prepare(`SELECT * FROM conversation_messages WHERE workspace_id=? AND idempotency_key=?`)
        .bind(workspaceId, idempotencyKey).first<Record<string, unknown>>();
      if (raced) return json({ error: "Conversation message is already processing", code: "message_processing" }, 409);
      return json({ error: "Conversation message could not be queued" }, 500);
    }
    const deliveryResponse = await executeResendDelivery(env, access, request, connection, {
      recipient: normalizeEmail(contact.email), subject, text, idempotencyKey: `conversation:${idempotencyKey}`,
    });
    const deliveryBody = await deliveryResponse.clone().json() as Json;
    const delivery = isPlainObject(deliveryBody.delivery) ? deliveryBody.delivery : null;
    const finalStatus = deliveryResponse.ok ? "sent" : "failed";
    const finalError = deliveryResponse.ok ? null : optionalString(deliveryBody.error, "error", 240) || "Email delivery failed";
    const finishedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE conversation_messages SET provider_message_id=?,status=?,error=?,updated_at=?
        WHERE workspace_id=? AND id=? AND status='pending'`)
        .bind(delivery?.provider_email_id || null, finalStatus, finalError, finishedAt, workspaceId, messageId),
      await auditStatement(env, access, request, deliveryResponse.ok ? "conversation.message_sent" : "conversation.message_failed",
        "conversation_message", messageId, null, { thread_id: threadId, status: finalStatus, error: finalError }),
    ]);
    const completedMessage = await env.DB.prepare("SELECT * FROM conversation_messages WHERE workspace_id=? AND id=?")
      .bind(workspaceId, messageId).first<Record<string, unknown>>();
    if (!deliveryResponse.ok) return json({ error: finalError, code: "conversation_delivery_failed",
      message: safeConversationMessage(completedMessage!) }, deliveryResponse.status);
    return json({ ok: true, replayed: false, thread_id: threadId, message: safeConversationMessage(completedMessage!) }, 201);
  }

  if (url.pathname === "/v1/admin/resend-connection" && request.method === "GET") {
    const connection = await env.DB.prepare(`SELECT * FROM resend_connections
      WHERE workspace_id=? AND status<>'revoked' ORDER BY created_at DESC LIMIT 1`)
      .bind(workspaceId).first<Record<string, unknown>>();
    const deliveries = isWorkspaceAdmin(access)
      ? await env.DB.prepare(`SELECT id,connection_id,idempotency_key,recipient,subject,body_excerpt,
          provider_email_id,status,response_status,error,created_by,created_at,updated_at
          FROM resend_deliveries WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 25`)
        .bind(workspaceId).all()
      : { results: [] };
    return json({
      connection: safeResendConnection(connection),
      deliveries: deliveries.results,
      history_visible: isWorkspaceAdmin(access),
      runtime: { encryption_configured: Boolean(env.WEBHOOK_ENCRYPTION_KEY && env.WEBHOOK_ENCRYPTION_KEY.length >= 24) },
      limits: { hourly_sends: 50, subject_characters: 200, body_characters: 10_000, history: 25 },
    });
  }

  if (url.pathname === "/v1/admin/resend-connection" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    if (!env.WEBHOOK_ENCRYPTION_KEY || env.WEBHOOK_ENCRYPTION_KEY.length < 24) {
      return json({ error: "Workspace secret encryption is not configured" }, 503);
    }
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["label", "api_key", "from_email", "from_name", "reply_to"].includes(key))) {
      return json({ error: "Resend setup contains unsupported fields" }, 400);
    }
    const label = optionalString(body.label, "label", 80) || "Transactional email";
    const apiKey = optionalString(body.api_key, "api_key", 200) || "";
    const fromEmail = normalizeEmail(body.from_email);
    const fromName = optionalString(body.from_name, "from_name", 100);
    const replyTo = normalizeEmail(body.reply_to) || null;
    if (!/^re_[A-Za-z0-9_-]{16,196}$/.test(apiKey)) return json({ error: "A valid Resend API key is required" }, 400);
    if (!validEmail(fromEmail)) return json({ error: "A valid verified sender email is required" }, 400);
    if (fromName && /[\r\n<>]/.test(fromName)) return json({ error: "from_name contains unsupported characters" }, 400);
    if (replyTo && !validEmail(replyTo)) return json({ error: "reply_to must be a valid email" }, 400);
    const existing = await env.DB.prepare(`SELECT id FROM resend_connections
      WHERE workspace_id=? AND status<>'revoked' LIMIT 1`).bind(workspaceId).first();
    if (existing) return json({ error: "Disconnect the current Resend connection before replacing it" }, 409);
    const connectionId = id("rsnd");
    const now = new Date().toISOString();
    const changeId = id("chg");
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO resend_connections
          (id,workspace_id,label,api_key_prefix,api_key_ciphertext,from_email,from_name,reply_to,status,
           revision,change_id,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'pending',1,?,?,?,?)`)
          .bind(connectionId, workspaceId, label, apiKey.slice(0, 10),
            await encryptWorkspaceSecret(env, workspaceId, "resend", connectionId, apiKey),
            fromEmail, fromName, replyTo, changeId, access.email, now, now),
        await auditStatement(env, access, request, "resend.connection_created", "resend_connection", connectionId, null, {
          label, api_key_prefix: apiKey.slice(0, 10), from_email: fromEmail, from_name: fromName, reply_to: replyTo,
          status: "pending",
        }),
      ]);
    } catch {
      return json({ error: "A Resend connection already exists" }, 409);
    }
    const created = await env.DB.prepare("SELECT * FROM resend_connections WHERE id=? AND workspace_id=?")
      .bind(connectionId, workspaceId).first<Record<string, unknown>>();
    return json({ ok: true, connection: safeResendConnection(created) }, 201);
  }

  if (url.pathname === "/v1/admin/resend-connection/verify" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["expected_revision", "idempotency_key"].includes(key))) {
      return json({ error: "Verification request contains unsupported fields" }, 400);
    }
    const connection = await env.DB.prepare(`SELECT * FROM resend_connections
      WHERE workspace_id=? AND status<>'revoked' LIMIT 1`).bind(workspaceId).first<Record<string, unknown>>();
    if (!connection) return json({ error: "Resend is not connected" }, 404);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(connection.revision)) {
      return json({ error: "Resend connection changed since it was loaded", code: "edit_conflict" }, 409);
    }
    const idempotencyKey = optionalString(body.idempotency_key, "idempotency_key", 100) || "";
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) return json({ error: "idempotency_key is invalid" }, 400);
    return executeResendDelivery(env, access, request, connection, {
      recipient: normalizeEmail(access.email),
      subject: "OpenOperator Resend connection verified",
      text: "Your workspace Resend connection can send transactional email. No AI agent was granted email authority.",
      idempotencyKey,
    }, true);
  }

  if (url.pathname === "/v1/admin/resend-connection/send" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["recipient", "subject", "text", "idempotency_key", "confirmation"].includes(key))) {
      return json({ error: "Email request contains unsupported fields" }, 400);
    }
    const recipient = normalizeEmail(body.recipient);
    const subject = optionalString(body.subject, "subject", 200) || "";
    const text = optionalString(body.text, "text", 10_000) || "";
    const idempotencyKey = optionalString(body.idempotency_key, "idempotency_key", 100) || "";
    if (!validEmail(recipient)) return json({ error: "A valid recipient is required" }, 400);
    if (!subject) return json({ error: "subject is required" }, 400);
    if (!text) return json({ error: "text is required" }, 400);
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) return json({ error: "idempotency_key is invalid" }, 400);
    if (body.confirmation !== "SEND TRANSACTIONAL EMAIL") return json({ error: "Explicit send confirmation is required" }, 400);
    const connection = await env.DB.prepare(`SELECT * FROM resend_connections
      WHERE workspace_id=? AND status='active' LIMIT 1`).bind(workspaceId).first<Record<string, unknown>>();
    if (!connection) return json({ error: "A verified Resend connection is required" }, 409);
    return executeResendDelivery(env, access, request, connection, { recipient, subject, text, idempotencyKey });
  }

  if (url.pathname === "/v1/admin/resend-connection" && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    if (Object.keys(body).some((key) => !["expected_revision", "confirmation"].includes(key))) {
      return json({ error: "Disconnect request contains unsupported fields" }, 400);
    }
    if (body.confirmation !== "DISCONNECT RESEND") return json({ error: "Explicit disconnect confirmation is required" }, 400);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return json({ error: "expected_revision is invalid" }, 400);
    const before = await env.DB.prepare(`SELECT * FROM resend_connections
      WHERE workspace_id=? AND status<>'revoked' LIMIT 1`).bind(workspaceId).first<Record<string, unknown>>();
    if (!before) return json({ error: "Resend is not connected" }, 404);
    const now = new Date().toISOString();
    const changeId = id("chg");
    const wiped = await encryptWorkspaceSecret(env, workspaceId, "resend", String(before.id),
      `revoked_${crypto.randomUUID().replaceAll("-", "")}`);
    const ip = request.headers.get("cf-connecting-ip");
    const ipHash = ip ? await sha256(ip) : null;
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE resend_connections SET api_key_prefix='revoked',api_key_ciphertext=?,status='revoked',
        last_error=NULL,revision=revision+1,change_id=?,updated_at=?
        WHERE id=? AND workspace_id=? AND revision=? AND status<>'revoked'`)
        .bind(wiped, changeId, now, before.id, workspaceId, expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'resend.connection_disconnected','resend_connection',?,?,?,?,?,?
        WHERE changes()>0 AND EXISTS(SELECT 1 FROM resend_connections WHERE id=? AND workspace_id=? AND change_id=? AND status='revoked')`)
        .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(safeResendConnection(before)),
          JSON.stringify({ status: "revoked", revision: expectedRevision + 1 }), requestId(request), ipHash, now,
          before.id, workspaceId, changeId),
    ]);
    if (Number(results[0].meta.changes || 0) !== 1 || Number(results[1].meta.changes || 0) !== 1) {
      return json({ error: "Resend connection changed since it was loaded", code: "edit_conflict" }, 409);
    }
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/page-layouts" && request.method === "GET") {
    const layouts = await Promise.all((["contact", "company", "opportunity"] as CustomFieldObject[])
      .map((objectType) => effectivePageLayout(env, workspaceId, objectType)));
    return json({ layouts, current_user: { role: access.role }, limits: { sections: 8, fields: 50 } });
  }

  const pageLayoutMatch = url.pathname.match(/^\/v1\/admin\/page-layouts\/(contact|company|opportunity)$/);
  if (pageLayoutMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    const objectType = pageLayoutMatch[1] as CustomFieldObject;
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return json({ error: "expected_revision must be a non-negative integer" }, 400);
    const definitions = await env.DB.prepare(`SELECT field_key FROM custom_field_definitions
      WHERE workspace_id=? AND object_type=? AND active=1 ORDER BY position,id`)
      .bind(workspaceId, objectType).all<{ field_key: string }>();
    const allowedKeys = new Set(definitions.results.map((definition) => definition.field_key));
    let sections: PageLayoutSection[];
    try { sections = parsePageLayoutSections(body.sections, allowedKeys, true); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid layout" }, 400);
    }
    const name = optionalString(body.name, "name", 80) || "Default layout";
    const before = await env.DB.prepare("SELECT * FROM object_page_layouts WHERE workspace_id=? AND object_type=?")
      .bind(workspaceId, objectType).first<ObjectPageLayout>();
    if ((before?.revision || 0) !== expectedRevision) {
      return json({ error: "Page layout changed since it was loaded", code: "edit_conflict" }, 409);
    }
    const now = new Date().toISOString();
    const layoutId = before?.id || id("layout");
    const changeId = id("chg");
    const after = {
      id: layoutId, workspace_id: workspaceId, object_type: objectType, name,
      sections: JSON.stringify(sections), revision: expectedRevision + 1, change_id: changeId,
      created_by: before?.created_by || access.email, created_at: before?.created_at || now, updated_at: now,
    };
    const write = before
      ? env.DB.prepare(`UPDATE object_page_layouts SET name=?,sections=?,revision=revision+1,change_id=?,updated_at=?
          WHERE workspace_id=? AND object_type=? AND revision=?`)
        .bind(name, after.sections, changeId, now, workspaceId, objectType, expectedRevision)
      : env.DB.prepare(`INSERT OR IGNORE INTO object_page_layouts
          (id,workspace_id,object_type,name,sections,revision,change_id,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,1,?,?,?,?)`)
        .bind(layoutId, workspaceId, objectType, name, after.sections, changeId, access.email, now, now);
    const results = await env.DB.batch([
      write,
      await pageLayoutAuditStatement(env, access, request, layoutId, changeId, before || null, after),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) {
      return json({ error: "Page layout changed since it was loaded", code: "edit_conflict" }, 409);
    }
    return json({ layout: { ...after, sections } });
  }

  if (url.pathname === "/v1/admin/custom-fields" && request.method === "GET") {
    const objectType = url.searchParams.get("object_type");
    if (objectType && !["contact", "company", "opportunity"].includes(objectType)) return json({ error: "Invalid object_type" }, 400);
    const definitions = await env.DB.prepare(`SELECT id,object_type,field_key,label,field_type,options,required,active,position,revision,change_id,created_by,created_at,updated_at
      FROM custom_field_definitions WHERE workspace_id=? AND (? IS NULL OR object_type=?)
      ORDER BY object_type,active DESC,position,id`).bind(workspaceId, objectType, objectType).all<CustomFieldDefinition>();
    const [readableContactFields, readableOpportunityFields] = await Promise.all([
      readableContactCustomFieldKeys(env, access),
      readableOpportunityCustomFieldKeys(env, access),
    ]);
    const visibleDefinitions = definitions.results.filter((definition) =>
      definition.object_type !== "contact" || readableContactFields === null ||
      (Boolean(definition.active) && readableContactFields.has(definition.field_key))).filter((definition) =>
      definition.object_type !== "opportunity" || readableOpportunityFields === null ||
      (Boolean(definition.active) && readableOpportunityFields.has(definition.field_key)));
    return json({ definitions: visibleDefinitions.map((definition) => ({
      ...definition, options: parseStringArray(definition.options),
      required: Boolean(definition.required), active: Boolean(definition.active),
    })), current_user: { role: access.role }, limits: { active_fields: 50, select_options: 50 } });
  }

  if (url.pathname === "/v1/admin/custom-fields" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    const label = optionalString(body.label, "label", 80);
    const objectType = optionalString(body.object_type, "object_type", 20) || "contact";
    const rawKey = optionalString(body.field_key, "field_key", 40);
    const fieldKey = rawKey?.trim().toLowerCase() || "";
    const fieldType = optionalString(body.field_type, "field_type", 20) as CustomFieldType | null;
    const required = body.required === true ? 1 : 0;
    const options = Array.isArray(body.options) ? body.options : [];
    if (!["contact", "company", "opportunity"].includes(objectType)) return json({ error: "Unsupported custom-field object" }, 400);
    if (!label || !/^[a-z][a-z0-9_]{1,39}$/.test(fieldKey)) return json({ error: "Field key must use 2-40 lowercase letters, numbers, or underscores" }, 400);
    if (!fieldType || !customFieldTypes.has(fieldType)) return json({ error: "Unsupported custom field type" }, 400);
    if (options.some((option) => typeof option !== "string" || !option.trim() || option.length > 80) ||
      new Set(options).size !== options.length || options.length > 50 ||
      (fieldType === "select" && options.length < 1) || (fieldType !== "select" && options.length)) {
      return json({ error: fieldType === "select" ? "Select fields require 1-50 unique options" : "Only select fields may define options" }, 400);
    }
    const activeCount = await env.DB.prepare("SELECT COUNT(*) total FROM custom_field_definitions WHERE workspace_id=? AND object_type=? AND active=1")
      .bind(workspaceId, objectType).first<{ total: number }>();
    if (Number(activeCount?.total || 0) >= 50) return json({ error: `${objectType} custom-field limit reached` }, 409);
    const nextPosition = await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 position FROM custom_field_definitions WHERE workspace_id=? AND object_type=?")
      .bind(workspaceId, objectType).first<{ position: number }>();
    const now = new Date().toISOString();
    const definition: CustomFieldDefinition = {
      id: id("cfld"), workspace_id: workspaceId, object_type: objectType as CustomFieldObject, field_key: fieldKey,
      label, field_type: fieldType, options: JSON.stringify(options.map((option) => String(option).trim())),
      required, active: 1, position: Number(nextPosition?.position || 0), revision: 1,
      change_id: id("chg"),
      created_by: access.email, created_at: now, updated_at: now,
    };
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO custom_field_definitions
          (id,workspace_id,object_type,field_key,label,field_type,options,required,active,position,revision,change_id,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...Object.values(definition)),
        await customFieldAuditStatement(env, access, request, "custom_field.created", definition.id, definition.change_id, null, definition),
      ]);
    } catch {
      return json({ error: "A field with this key already exists" }, 409);
    }
    return json({ definition: { ...definition, options: parseStringArray(definition.options), required: Boolean(required), active: true } }, 201);
  }

  const customFieldMatch = url.pathname.match(/^\/v1\/admin\/custom-fields\/(cfld_[a-f0-9]{32})$/);
  if (customFieldMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    const before = await env.DB.prepare("SELECT * FROM custom_field_definitions WHERE workspace_id=? AND id=?")
      .bind(workspaceId, customFieldMatch[1]).first<CustomFieldDefinition>();
    if (!before) return json({ error: "Custom field not found" }, 404);
    if (body.if_revision !== before.revision) return json({ error: "Custom field changed since it was loaded", code: "edit_conflict" }, 409);
    const label = body.label === undefined ? before.label : optionalString(body.label, "label", 80);
    const active = body.active === undefined ? before.active : body.active === true ? 1 : body.active === false ? 0 : -1;
    const required = body.required === undefined ? before.required : body.required === true ? 1 : body.required === false ? 0 : -1;
    const position = body.position === undefined ? before.position : Number(body.position);
    if (!label || active < 0 || required < 0 || !Number.isInteger(position) || position < 0 || position > 999) {
      return json({ error: "Invalid custom-field update" }, 400);
    }
    const updatedAt = new Date().toISOString();
    const changeId = id("chg");
    const after = { ...before, label, required, active, position, revision: before.revision + 1, change_id: changeId, updated_at: updatedAt };
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE custom_field_definitions SET label=?,required=?,active=?,position=?,revision=revision+1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=?`).bind(label, required, active, position, changeId, updatedAt, workspaceId, before.id, before.revision),
      await customFieldAuditStatement(env, access, request, active ? "custom_field.updated" : "custom_field.archived",
        before.id, changeId, before, after),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) {
      return json({ error: "Custom field changed since it was loaded", code: "edit_conflict" }, 409);
    }
    return json({ definition: { ...after, options: parseStringArray(after.options), required: Boolean(required), active: Boolean(active) } });
  }

  if (url.pathname === "/v1/admin/custom-relation-targets" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const targetType = String(url.searchParams.get("type") || "");
    const query = String(url.searchParams.get("query") || "").trim();
    if (!["contact", "company", "opportunity", "custom_record"].includes(targetType) ||
      query.length < 2 || query.length > 100) {
      return json({ error: "type is invalid or query must contain 2-100 characters" }, 400);
    }
    const escaped = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    let targets: D1Result<Record<string, unknown>>;
    if (targetType === "contact") {
      targets = await env.DB.prepare(`SELECT id,
        COALESCE(NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')),''),email) label,
        email detail FROM contacts WHERE workspace_id=? AND
        (email LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC,id DESC LIMIT 21`).bind(workspaceId, escaped, escaped, escaped).all();
    } else if (targetType === "company") {
      targets = await env.DB.prepare(`SELECT id,name label,COALESCE(domain,'') detail FROM companies
        WHERE workspace_id=? AND (name LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC,id DESC LIMIT 21`).bind(workspaceId, escaped, escaped).all();
    } else if (targetType === "opportunity") {
      targets = await env.DB.prepare(`SELECT id,name label,printf('$%.2f',value) detail FROM opportunities
        WHERE workspace_id=? AND name LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC,id DESC LIMIT 21`).bind(workspaceId, escaped).all();
    } else {
      targets = await env.DB.prepare(`SELECT r.id,r.display_name label,d.plural_label detail
        FROM custom_object_records r JOIN custom_object_definitions d
          ON d.workspace_id=r.workspace_id AND d.id=r.object_id
        WHERE r.workspace_id=? AND r.display_name LIKE ? ESCAPE '\\'
        ORDER BY r.updated_at DESC,r.id DESC LIMIT 21`).bind(workspaceId, escaped).all();
    }
    return json({ targets: targets.results.slice(0, 20), truncated: targets.results.length > 20 });
  }

  if (url.pathname === "/v1/admin/custom-objects" && request.method === "GET") {
    const definitions = await env.DB.prepare(`SELECT d.*,
      (SELECT COUNT(*) FROM custom_object_records r WHERE r.workspace_id=d.workspace_id AND r.object_id=d.id) record_count
      FROM custom_object_definitions d
      WHERE d.workspace_id=? AND (?=1 OR EXISTS(
        SELECT 1 FROM workspace_access_policies p JOIN workspace_role_grants g
          ON g.workspace_id=p.workspace_id AND g.revision=p.current_revision
        WHERE p.workspace_id=d.workspace_id AND g.role=? AND g.resource=('custom_object:' || d.id)
          AND g.action='read' AND g.field_name=''
      ))
      ORDER BY d.active DESC,d.plural_label COLLATE NOCASE,d.id`)
      .bind(workspaceId, isWorkspaceAdmin(access) ? 1 : 0, access.role)
      .all<Record<string, unknown>>();
    const hydratedDefinitions = await Promise.all(definitions.results.map(async (definition) => {
      const fields = parseCustomObjectFields(JSON.parse(String(definition.fields)));
      const readableFields = await readableCustomObjectFieldKeys(env, access, String(definition.id));
      return {
        ...definition,
        fields: readableFields === null ? fields : fields.filter((field) => readableFields.has(field.key)),
        active: Boolean(definition.active),
        authority: {
          configure: isWorkspaceAdmin(access),
          create: await hasWorkspaceGrant(env, access, customObjectResource(String(definition.id)), "create"),
          update: await hasWorkspaceGrant(env, access, customObjectResource(String(definition.id)), "update"),
          delete: await hasWorkspaceGrant(env, access, customObjectResource(String(definition.id)), "delete"),
          relations: isWorkspaceAdmin(access),
        },
      };
    }));
    return json({
      definitions: hydratedDefinitions,
      limits: { objects: 10, fields_per_object: 20, records_per_page: 100, relations_per_record: 50 },
      authority: { configure: isWorkspaceAdmin(access), agent_execution: false },
    });
  }

  if (url.pathname === "/v1/admin/custom-objects" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const slug = String(body.slug || "").trim().toLowerCase();
    const singularLabel = String(body.singular_label || "").trim();
    const pluralLabel = String(body.plural_label || "").trim();
    const description = body.description === undefined || body.description === null
      ? null : String(body.description).trim().slice(0, 500);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(slug) || !singularLabel || singularLabel.length > 80 ||
      !pluralLabel || pluralLabel.length > 80) {
      return json({ error: "Use a 2-40 character lowercase slug and labels under 80 characters" }, 400);
    }
    let fields: CustomObjectField[];
    try { fields = parseCustomObjectFields(body.fields); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid fields" }, 400);
    }
    const count = await env.DB.prepare("SELECT COUNT(*) total FROM custom_object_definitions WHERE workspace_id=? AND active=1")
      .bind(workspaceId).first<{ total: number }>();
    if (Number(count?.total || 0) >= 10) return json({ error: "Active custom-object limit reached" }, 409);
    const now = new Date().toISOString();
    const definition = {
      id: id("cobj"), workspace_id: workspaceId, slug, singular_label: singularLabel,
      plural_label: pluralLabel, description, fields: JSON.stringify(fields), active: 1,
      revision: 1, change_id: id("chg"), created_by: access.email, created_at: now, updated_at: now,
    };
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO custom_object_definitions
          (id,workspace_id,slug,singular_label,plural_label,description,fields,active,revision,change_id,
           created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(...Object.values(definition)),
        await auditStatement(env, access, request, "custom_object.created", "custom_object_definition",
          definition.id, null, { ...definition, fields }),
      ]);
    } catch {
      return json({ error: "A custom object with this slug already exists" }, 409);
    }
    return json({ definition: { ...definition, fields, active: true, record_count: 0 } }, 201);
  }

  const customObjectMatch = url.pathname.match(/^\/v1\/admin\/custom-objects\/(cobj_[a-f0-9]{32})$/);
  if (customObjectMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const before = await env.DB.prepare("SELECT * FROM custom_object_definitions WHERE workspace_id=? AND id=?")
      .bind(workspaceId, customObjectMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Custom object not found" }, 404);
    if (body.if_revision !== before.revision) return json({ error: "Custom object changed since it was loaded", code: "edit_conflict" }, 409);
    const singularLabel = body.singular_label === undefined ? String(before.singular_label)
      : String(body.singular_label || "").trim();
    const pluralLabel = body.plural_label === undefined ? String(before.plural_label)
      : String(body.plural_label || "").trim();
    const description = body.description === undefined ? before.description
      : body.description === null ? null : String(body.description).trim().slice(0, 500);
    const active = body.active === undefined ? Number(before.active) : body.active === true ? 1 : body.active === false ? 0 : -1;
    if (!singularLabel || singularLabel.length > 80 || !pluralLabel || pluralLabel.length > 80 || active < 0) {
      return json({ error: "Invalid custom-object update" }, 400);
    }
    if (!Number(before.active) && active) {
      const count = await env.DB.prepare("SELECT COUNT(*) total FROM custom_object_definitions WHERE workspace_id=? AND active=1")
        .bind(workspaceId).first<{ total: number }>();
      if (Number(count?.total || 0) >= 10) return json({ error: "Active custom-object limit reached" }, 409);
    }
    let fields = parseCustomObjectFields(JSON.parse(String(before.fields)));
    if (body.fields !== undefined) {
      let nextFields: CustomObjectField[];
      try { nextFields = parseCustomObjectFields(body.fields); } catch (error) {
        return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid fields" }, 400);
      }
      const nextByKey = new Map(nextFields.map((field) => [field.key, field]));
      if (fields.some((field) => !nextByKey.has(field.key) || nextByKey.get(field.key)?.type !== field.type) ||
        nextFields.some((field) => !fields.some((existing) => existing.key === field.key) && field.required)) {
        return json({ error: "Existing field keys and types are immutable; new fields must start optional" }, 409);
      }
      fields = nextFields;
    }
    const now = new Date().toISOString();
    const changeId = id("chg");
    const after = { ...before, singular_label: singularLabel, plural_label: pluralLabel, description,
      fields: JSON.stringify(fields), active, revision: Number(before.revision) + 1, change_id: changeId, updated_at: now };
    let results: D1Result<unknown>[];
    try {
      results = await env.DB.batch([
        await auditStatement(env, access, request, active ? "custom_object.updated" : "custom_object.archived",
          "custom_object_definition", String(before.id), before, after),
        env.DB.prepare(`UPDATE custom_object_definitions SET singular_label=?,plural_label=?,description=?,fields=?,
          active=?,revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
          .bind(singularLabel, pluralLabel, description, JSON.stringify(fields), active, changeId, now,
            workspaceId, before.id, before.revision),
        env.DB.prepare("INSERT INTO atomic_mutation_guard(ok) SELECT 0 WHERE changes()=0"),
      ]);
    } catch (error) {
      if (String(error).includes("atomic_mutation_must_win")) {
        return json({ error: "Custom object changed since it was loaded", code: "edit_conflict" }, 409);
      }
      throw error;
    }
    if (!results[0].meta.changes || !results[1].meta.changes) {
      return json({ error: "Custom object changed since it was loaded", code: "edit_conflict" }, 409);
    }
    return json({ definition: { ...after, fields, active: Boolean(active) } });
  }

  const customObjectRecordsMatch = url.pathname.match(
    /^\/v1\/admin\/custom-objects\/(cobj_[a-f0-9]{32})\/records$/,
  );
  const customObjectViewsMatch = url.pathname.match(
    /^\/v1\/admin\/custom-objects\/(cobj_[a-f0-9]{32})\/views$/,
  );
  if (customObjectViewsMatch && request.method === "GET") {
    const readDenied = await requireWorkspaceGrant(env, access,
      customObjectResource(customObjectViewsMatch[1]), "read");
    if (readDenied) return readDenied;
    const definition = await env.DB.prepare("SELECT fields FROM custom_object_definitions WHERE workspace_id=? AND id=?")
      .bind(workspaceId, customObjectViewsMatch[1]).first<{ fields: string }>();
    if (!definition) return json({ error: "Custom object not found" }, 404);
    const fields = parseCustomObjectFields(JSON.parse(definition.fields));
    const readableKeys = await readableCustomObjectFieldKeys(env, access, customObjectViewsMatch[1]);
    const views = await env.DB.prepare(`SELECT * FROM custom_object_views WHERE workspace_id=? AND object_id=?
      AND (visibility='workspace' OR (?=1 AND created_by=?))
      ORDER BY CASE WHEN created_by=? THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 50`)
      .bind(workspaceId, customObjectViewsMatch[1], isWorkspaceAdmin(access) ? 1 : 0, access.email, access.email)
      .all<Record<string, unknown>>();
    const visibleViews = views.results.map((view) => customObjectViewPayload(view, fields)).filter((view) =>
      readableKeys === null || (
        view.filters.every((filter) => readableKeys.has(filter.field_key)) &&
        (view.sort_field === "display_name" || view.sort_field === "updated_at" || readableKeys.has(view.sort_field)) &&
        view.visible_fields.every((field) => field === "display_name" || readableKeys.has(field))
      ));
    return json({ views: visibleViews, limit: 50 });
  }
  if (customObjectViewsMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const definition = await env.DB.prepare("SELECT fields,active FROM custom_object_definitions WHERE workspace_id=? AND id=?")
      .bind(workspaceId, customObjectViewsMatch[1]).first<{ fields: string; active: number }>();
    if (!definition) return json({ error: "Custom object not found" }, 404);
    if (!definition.active) return json({ error: "Archived custom objects are read-only" }, 409);
    const fields = parseCustomObjectFields(JSON.parse(definition.fields));
    let view: CustomObjectViewDefinition;
    try { view = validateCustomObjectView(body, fields) as CustomObjectViewDefinition; }
    catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid view" }, 400); }
    if (view.visibility === "workspace" && !isWorkspaceAdmin(access)) return json({ error: "Admin role required for workspace views" }, 403);
    const count = await env.DB.prepare("SELECT COUNT(*) total FROM custom_object_views WHERE workspace_id=? AND object_id=?")
      .bind(workspaceId, customObjectViewsMatch[1]).first<{ total: number }>();
    if (Number(count?.total || 0) >= 50) return json({ error: "Custom-object view limit reached" }, 409);
    const duplicate = await env.DB.prepare("SELECT id FROM custom_object_views WHERE workspace_id=? AND object_id=? AND name=?")
      .bind(workspaceId, customObjectViewsMatch[1], view.name).first<{ id: string }>();
    if (duplicate) return json({ error: "A view with that name already exists" }, 409);
    const now = new Date().toISOString();
    const created = {
      id: id("coview"), workspace_id: workspaceId, object_id: customObjectViewsMatch[1], name: view.name,
      visibility: view.visibility, filters: JSON.stringify(view.filters), visible_fields: JSON.stringify(view.visible_fields),
      sort_field: view.sort_field, sort_direction: view.sort_direction, revision: 1, change_id: id("chg"),
      created_by: access.email, created_at: now, updated_at: now,
    };
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO custom_object_views
          (id,workspace_id,object_id,name,visibility,filters,visible_fields,sort_field,sort_direction,
           revision,change_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(...Object.values(created)),
        await customObjectViewAuditStatement(env, access, request, "custom_object_view.created",
          created.id, null, { ...created, ...view }, { changeId: created.change_id }),
      ]);
      if (!results[0].meta.changes || !results[1].meta.changes) {
        return json({ error: "Custom-object view creation failed and was rolled back", code: "view_create_failed" }, 500);
      }
    } catch {
      return json({ error: "Custom-object view creation failed and was rolled back", code: "view_create_failed" }, 500);
    }
    return json({ view: { ...created, ...view } }, 201);
  }

  const customObjectViewMatch = url.pathname.match(/^\/v1\/admin\/custom-object-views\/(coview_[a-f0-9]{32})$/);
  if (customObjectViewMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const before = await env.DB.prepare(`SELECT v.*,d.fields,d.active FROM custom_object_views v
      JOIN custom_object_definitions d ON d.workspace_id=v.workspace_id AND d.id=v.object_id
      WHERE v.workspace_id=? AND v.id=?`).bind(workspaceId, customObjectViewMatch[1]).first<Record<string, unknown>>();
    if (!before || (before.visibility === "private" && before.created_by !== access.email)) {
      return json({ error: "Custom-object view not found" }, 404);
    }
    if (before.created_by !== access.email && !isWorkspaceAdmin(access)) return json({ error: "View creator or admin required" }, 403);
    if (!before.active) return json({ error: "Archived custom objects are read-only" }, 409);
    if (body.if_revision !== before.revision) return json({ error: "View changed since it was loaded", code: "edit_conflict" }, 409);
    const fields = parseCustomObjectFields(JSON.parse(String(before.fields)));
    let changes: Partial<CustomObjectViewDefinition>;
    try { changes = validateCustomObjectView(body, fields, true); }
    catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid view" }, 400); }
    if (!Object.keys(changes).length) return json({ error: "No supported view fields supplied" }, 400);
    const current = customObjectViewPayload(before, fields);
    const next = { name: changes.name ?? current.name, visibility: changes.visibility ?? current.visibility,
      filters: changes.filters ?? current.filters, visible_fields: changes.visible_fields ?? current.visible_fields,
      sort_field: changes.sort_field ?? current.sort_field, sort_direction: changes.sort_direction ?? current.sort_direction };
    const duplicate = await env.DB.prepare(`SELECT id FROM custom_object_views
      WHERE workspace_id=? AND object_id=? AND name=? AND id<>?`)
      .bind(workspaceId, before.object_id, next.name, before.id).first<{ id: string }>();
    if (duplicate) return json({ error: "A view with that name already exists" }, 409);
    const now = new Date(Math.max(Date.now(), (Date.parse(String(before.updated_at)) || 0) + 1)).toISOString();
    const changeId = id("chg");
    const after = { ...before, ...next, filters: JSON.stringify(next.filters), visible_fields: JSON.stringify(next.visible_fields),
      revision: Number(before.revision) + 1, change_id: changeId, updated_at: now };
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE custom_object_views SET name=?,visibility=?,filters=?,visible_fields=?,sort_field=?,
          sort_direction=?,revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
          .bind(next.name, next.visibility, JSON.stringify(next.filters), JSON.stringify(next.visible_fields),
            next.sort_field, next.sort_direction, changeId, now, workspaceId, before.id, before.revision),
        await customObjectViewAuditStatement(env, access, request, "custom_object_view.updated",
          String(before.id), current, { ...next, revision: Number(before.revision) + 1, change_id: changeId, updated_at: now },
          { changeId }),
      ]);
      if (!results[0].meta.changes) {
        return json({ error: "View changed since it was loaded", code: "edit_conflict" }, 409);
      }
      if (!results[1].meta.changes) {
        return json({ error: "Custom-object view update failed and was rolled back", code: "view_update_failed" }, 500);
      }
    } catch {
      return json({ error: "Custom-object view update failed and was rolled back", code: "view_update_failed" }, 500);
    }
    return json({ view: customObjectViewPayload(after, fields) });
  }
  if (customObjectViewMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const expectedRevision = Number(url.searchParams.get("expected_revision"));
    const before = await env.DB.prepare(`SELECT v.*,d.active FROM custom_object_views v
      JOIN custom_object_definitions d ON d.workspace_id=v.workspace_id AND d.id=v.object_id
      WHERE v.workspace_id=? AND v.id=?`)
      .bind(workspaceId, customObjectViewMatch[1]).first<Record<string, unknown>>();
    if (!before || (before.visibility === "private" && before.created_by !== access.email)) {
      return json({ error: "Custom-object view not found" }, 404);
    }
    if (!before.active) return json({ error: "Archived custom objects are read-only" }, 409);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return json({ error: "expected_revision is required", code: "version_required" }, 428);
    let results;
    try {
      results = await env.DB.batch([
        await customObjectViewAuditStatement(env, access, request, "custom_object_view.deleted",
          String(before.id), before, null, { revision: expectedRevision }),
        env.DB.prepare("DELETE FROM custom_object_views WHERE workspace_id=? AND id=? AND revision=?")
          .bind(workspaceId, before.id, expectedRevision),
      ]);
    } catch {
      return json({ error: "Custom-object view deletion failed and was rolled back", code: "view_delete_failed" }, 500);
    }
    if (!results[0].meta.changes || !results[1].meta.changes) {
      const latest = await env.DB.prepare("SELECT revision FROM custom_object_views WHERE workspace_id=? AND id=?")
        .bind(workspaceId, before.id).first<{ revision: number }>();
      if (latest && Number(latest.revision) === Number(before.revision)) {
        return json({ error: "Custom-object view deletion failed and was rolled back", code: "view_delete_failed" }, 500);
      }
      return json({ error: "View changed since it was loaded", code: "edit_conflict" }, 409);
    }
    return json({ ok: true });
  }

  if (customObjectRecordsMatch && request.method === "GET") {
    const readDenied = await requireWorkspaceGrant(env, access,
      customObjectResource(customObjectRecordsMatch[1]), "read");
    if (readDenied) return readDenied;
    const limit = Number(url.searchParams.get("limit") || "50");
    const query = String(url.searchParams.get("query") || "").trim();
    const viewId = String(url.searchParams.get("view_id") || "");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || query.length > 100) {
      return json({ error: "limit must be 1-100 and query cannot exceed 100 characters" }, 400);
    }
    const definition = await env.DB.prepare("SELECT * FROM custom_object_definitions WHERE workspace_id=? AND id=?")
      .bind(workspaceId, customObjectRecordsMatch[1]).first<Record<string, unknown>>();
    if (!definition) return json({ error: "Custom object not found" }, 404);
    const fields = parseCustomObjectFields(JSON.parse(String(definition.fields)));
    const readableKeys = await readableCustomObjectFieldKeys(env, access, String(definition.id));
    let appliedView: ReturnType<typeof customObjectViewPayload> | null = null;
    if (viewId) {
      if (!/^coview_[a-f0-9]{32}$/.test(viewId)) return json({ error: "view_id is invalid" }, 400);
      const view = await env.DB.prepare(`SELECT * FROM custom_object_views WHERE workspace_id=? AND object_id=? AND id=?
        AND (visibility='workspace' OR (?=1 AND created_by=?))`)
        .bind(workspaceId, definition.id, viewId, isWorkspaceAdmin(access) ? 1 : 0, access.email)
        .first<Record<string, unknown>>();
      if (!view) return json({ error: "Custom-object view not found" }, 404);
      appliedView = customObjectViewPayload(view, fields);
      if (readableKeys !== null && (
        appliedView.filters.some((filter) => !readableKeys.has(filter.field_key)) ||
        (!["display_name", "updated_at"].includes(appliedView.sort_field) && !readableKeys.has(appliedView.sort_field)) ||
        appliedView.visible_fields.some((field) => field !== "display_name" && !readableKeys.has(field))
      )) return permissionDenied(customObjectResource(String(definition.id)), "read_view_fields");
    }
    const where = ["r.workspace_id=?", "r.object_id=?"];
    const bindings: unknown[] = [workspaceId, definition.id];
    if (query) {
      where.push("r.display_name LIKE ? ESCAPE '\\'");
      bindings.push(`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    }
    for (const filter of appliedView?.filters || []) {
      const path = `$.${filter.field_key}`;
      if (filter.operator === "is_empty") {
        where.push("(json_type(r.data,?) IS NULL OR json_extract(r.data,?)='')");
        bindings.push(path, path);
      } else if (filter.operator === "contains") {
        where.push("CAST(json_extract(r.data,?) AS TEXT) LIKE ? ESCAPE '\\'");
        bindings.push(path, `%${String(filter.value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      } else if (filter.operator === "gte" || filter.operator === "lte") {
        where.push(`CAST(json_extract(r.data,?) AS REAL) ${filter.operator === "gte" ? ">=" : "<="} ?`);
        bindings.push(path, filter.value);
      } else if (filter.operator === "before" || filter.operator === "after") {
        where.push(`CAST(json_extract(r.data,?) AS TEXT) ${filter.operator === "before" ? "<" : ">"} ?`);
        bindings.push(path, filter.value);
      } else {
        where.push("json_extract(r.data,?)=?");
        bindings.push(path, filter.value);
      }
    }
    let order = "r.updated_at DESC,r.id DESC";
    if (appliedView) {
      const direction = appliedView.sort_direction === "asc" ? "ASC" : "DESC";
      if (appliedView.sort_field === "display_name") order = `r.display_name COLLATE NOCASE ${direction},r.id ${direction}`;
      else if (appliedView.sort_field === "updated_at") order = `r.updated_at ${direction},r.id ${direction}`;
      else {
        order = `json_extract(r.data,?) ${direction},r.id ${direction}`;
        bindings.push(`$.${appliedView.sort_field}`);
      }
    }
    const records = await env.DB.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM custom_object_relations rel WHERE rel.workspace_id=r.workspace_id AND rel.source_record_id=r.id) relation_count
      FROM custom_object_records r WHERE ${where.join(" AND ")}
      ORDER BY ${order} LIMIT ?`)
      .bind(...bindings, limit + 1)
      .all<Record<string, unknown>>();
    const visibleRecords = records.results.slice(0, limit);
    const recordIds = visibleRecords.map((record) => String(record.id));
    const relations = isWorkspaceAdmin(access) && recordIds.length ? await env.DB.prepare(`SELECT rel.*,
      CASE rel.target_type
        WHEN 'contact' THEN (SELECT COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')),''),c.email)
          FROM contacts c WHERE c.workspace_id=rel.workspace_id AND c.id=rel.target_id)
        WHEN 'company' THEN (SELECT c.name FROM companies c WHERE c.workspace_id=rel.workspace_id AND c.id=rel.target_id)
        WHEN 'opportunity' THEN (SELECT o.name FROM opportunities o WHERE o.workspace_id=rel.workspace_id AND o.id=rel.target_id)
        WHEN 'custom_record' THEN (SELECT r.display_name FROM custom_object_records r
          WHERE r.workspace_id=rel.workspace_id AND r.id=rel.target_id)
      END target_label,
      CASE rel.target_type
        WHEN 'contact' THEN (SELECT c.email FROM contacts c WHERE c.workspace_id=rel.workspace_id AND c.id=rel.target_id)
        WHEN 'company' THEN (SELECT COALESCE(c.domain,'') FROM companies c WHERE c.workspace_id=rel.workspace_id AND c.id=rel.target_id)
        WHEN 'opportunity' THEN (SELECT printf('$%.2f',o.value) FROM opportunities o WHERE o.workspace_id=rel.workspace_id AND o.id=rel.target_id)
        WHEN 'custom_record' THEN (SELECT d.plural_label FROM custom_object_records r JOIN custom_object_definitions d
          ON d.workspace_id=r.workspace_id AND d.id=r.object_id
          WHERE r.workspace_id=rel.workspace_id AND r.id=rel.target_id)
      END target_detail
      FROM custom_object_relations rel
      WHERE rel.workspace_id=? AND rel.source_record_id IN (${recordIds.map(() => "?").join(",")})
      ORDER BY rel.created_at,rel.id`).bind(workspaceId, ...recordIds).all<Record<string, unknown>>() : { results: [] };
    return json({
      definition: {
        ...definition,
        fields: readableKeys === null ? fields : fields.filter((field) => readableKeys.has(field.key)),
        active: Boolean(definition.active),
        authority: {
          configure: isWorkspaceAdmin(access),
          create: await hasWorkspaceGrant(env, access, customObjectResource(String(definition.id)), "create"),
          update: await hasWorkspaceGrant(env, access, customObjectResource(String(definition.id)), "update"),
          delete: await hasWorkspaceGrant(env, access, customObjectResource(String(definition.id)), "delete"),
          relations: isWorkspaceAdmin(access),
        },
      },
      records: visibleRecords.map((record) => ({
        ...record,
        relation_count: isWorkspaceAdmin(access) ? record.relation_count : 0,
        data: redactCustomObjectData(JSON.parse(String(record.data)), readableKeys),
        relations: relations.results.filter((relation) => relation.source_record_id === record.id),
      })),
      applied_view: appliedView,
      truncated: records.results.length > limit,
    });
  }

  if (customObjectRecordsMatch && request.method === "POST") {
    const createDenied = await requireWorkspaceGrant(env, access,
      customObjectResource(customObjectRecordsMatch[1]), "create");
    if (createDenied) return createDenied;
    const body = await readJson(request);
    const definition = await env.DB.prepare("SELECT * FROM custom_object_definitions WHERE workspace_id=? AND id=? AND active=1")
      .bind(workspaceId, customObjectRecordsMatch[1]).first<Record<string, unknown>>();
    if (!definition) return json({ error: "Active custom object not found" }, 404);
    const displayName = String(body.display_name || "").trim();
    if (!displayName || displayName.length > 200) return json({ error: "display_name is required and cannot exceed 200 characters" }, 400);
    let data: Json;
    try { data = customObjectRecordData(parseCustomObjectFields(JSON.parse(String(definition.fields))), body.data); }
    catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid record data" }, 400); }
    if (!isWorkspaceAdmin(access) && isPlainObject(data)) {
      for (const [fieldName, value] of Object.entries(data)) {
        if (value === null || value === undefined || value === "") continue;
        const fieldDenied = await requireWorkspaceGrant(env, access,
          customObjectResource(String(definition.id)), "update_field", fieldName);
        if (fieldDenied) return fieldDenied;
      }
    }
    const now = new Date().toISOString();
    const record = { id: id("corec"), workspace_id: workspaceId, object_id: definition.id,
      display_name: displayName, data: JSON.stringify(data), revision: 1, change_id: id("chg"),
      created_by: access.email, created_at: now, updated_at: now };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO custom_object_records
        (id,workspace_id,object_id,display_name,data,revision,change_id,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(...Object.values(record)),
      await auditStatement(env, access, request, "custom_object_record.created", "custom_object_record",
        record.id, null, { ...record, data }),
    ]);
    return json({ record: { ...record, data, relations: [], relation_count: 0 } }, 201);
  }

  const customRecordMatch = url.pathname.match(/^\/v1\/admin\/custom-object-records\/(corec_[a-f0-9]{32})$/);
  if (customRecordMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const before = await env.DB.prepare(`SELECT r.*,d.fields,d.active FROM custom_object_records r
      JOIN custom_object_definitions d ON d.workspace_id=r.workspace_id AND d.id=r.object_id
      WHERE r.workspace_id=? AND r.id=?`).bind(workspaceId, customRecordMatch[1])
      .first<Record<string, unknown>>();
    if (!before) return json({ error: "Custom-object record not found" }, 404);
    const updateDenied = await requireWorkspaceGrant(env, access,
      customObjectResource(String(before.object_id)), "update");
    if (updateDenied) return updateDenied;
    if (body.if_revision !== before.revision) return json({ error: "Record changed since it was loaded", code: "edit_conflict" }, 409);
    if (!before.active) return json({ error: "Archived custom objects are read-only" }, 409);
    const displayName = body.display_name === undefined ? String(before.display_name) : String(body.display_name || "").trim();
    if (!displayName || displayName.length > 200) return json({ error: "Invalid display name" }, 400);
    let nextData: Json;
    try {
      const current = JSON.parse(String(before.data));
      const updates = body.data === undefined ? current
        : !isWorkspaceAdmin(access) && isPlainObject(body.data) ? { ...current, ...body.data }
          : body.data;
      nextData = customObjectRecordData(parseCustomObjectFields(JSON.parse(String(before.fields))), updates);
    } catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid record data" }, 400); }
    if (!isWorkspaceAdmin(access)) {
      const currentData = JSON.parse(String(before.data)) as Record<string, unknown>;
      for (const [fieldName, value] of Object.entries(nextData as Record<string, unknown>)) {
        if (JSON.stringify(currentData[fieldName]) === JSON.stringify(value)) continue;
        const fieldDenied = await requireWorkspaceGrant(env, access,
          customObjectResource(String(before.object_id)), "update_field", fieldName);
        if (fieldDenied) return fieldDenied;
      }
    }
    const now = new Date().toISOString();
    const changeId = id("chg");
    const after = { id: before.id, display_name: displayName, data: nextData,
      revision: Number(before.revision) + 1, change_id: changeId, updated_at: now };
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE custom_object_records SET display_name=?,data=?,revision=revision+1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=?`).bind(displayName, JSON.stringify(nextData), changeId, now,
          workspaceId, before.id, before.revision),
      await auditStatement(env, access, request, "custom_object_record.updated", "custom_object_record",
        String(before.id), { display_name: before.display_name, data: JSON.parse(String(before.data)), revision: before.revision }, after),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) return json({ error: "Record changed since it was loaded", code: "edit_conflict" }, 409);
    const readableKeys = await readableCustomObjectFieldKeys(env, access, String(before.object_id));
    return json({ record: { ...after, data: redactCustomObjectData(nextData, readableKeys) } });
  }

  if (customRecordMatch && request.method === "DELETE") {
    const expectedRevision = Number(url.searchParams.get("expected_revision"));
    const before = await env.DB.prepare("SELECT * FROM custom_object_records WHERE workspace_id=? AND id=?")
      .bind(workspaceId, customRecordMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Custom-object record not found" }, 404);
    const deleteDenied = await requireWorkspaceGrant(env, access,
      customObjectResource(String(before.object_id)), "delete");
    if (deleteDenied) return deleteDenied;
    if (expectedRevision !== before.revision) return json({ error: "Record changed since it was loaded", code: "edit_conflict" }, 409);
    const results = await env.DB.batch([
      await auditStatement(env, access, request, "custom_object_record.deleted", "custom_object_record",
        String(before.id), before, null),
      env.DB.prepare("DELETE FROM custom_object_records WHERE workspace_id=? AND id=? AND revision=?")
        .bind(workspaceId, before.id, expectedRevision),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) return json({ error: "Record changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true });
  }

  const customRecordRelationsMatch = url.pathname.match(
    /^\/v1\/admin\/custom-object-records\/(corec_[a-f0-9]{32})\/relations$/,
  );
  if (customRecordRelationsMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const targetType = String(body.target_type || "");
    const targetId = String(body.target_id || "");
    const label = String(body.label || "").trim();
    if (!["contact", "company", "opportunity", "custom_record"].includes(targetType) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(targetId) || !label || label.length > 80) {
      return json({ error: "Relation target and label are invalid" }, 400);
    }
    const source = await env.DB.prepare(`SELECT r.id,d.active FROM custom_object_records r
      JOIN custom_object_definitions d ON d.workspace_id=r.workspace_id AND d.id=r.object_id
      WHERE r.workspace_id=? AND r.id=?`).bind(workspaceId, customRecordRelationsMatch[1])
      .first<{ id: string; active: number }>();
    if (!source) return json({ error: "Custom-object record not found" }, 404);
    if (!source.active) return json({ error: "Archived custom objects are read-only" }, 409);
    const targetTable = { contact: "contacts", company: "companies", opportunity: "opportunities",
      custom_record: "custom_object_records" }[targetType]!;
    const target = await env.DB.prepare(`SELECT id FROM ${targetTable} WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, targetId).first<{ id: string }>();
    if (!target || (targetType === "custom_record" && targetId === source.id)) {
      return json({ error: "Relation target was not found in this workspace" }, 404);
    }
    const relationCount = await env.DB.prepare("SELECT COUNT(*) total FROM custom_object_relations WHERE workspace_id=? AND source_record_id=?")
      .bind(workspaceId, source.id).first<{ total: number }>();
    if (Number(relationCount?.total || 0) >= 50) return json({ error: "Relation limit reached" }, 409);
    const relation = { id: id("corel"), workspace_id: workspaceId, source_record_id: source.id,
      target_type: targetType, target_id: targetId, label, created_by: access.email,
      created_at: new Date().toISOString() };
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO custom_object_relations
          (id,workspace_id,source_record_id,target_type,target_id,label,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?)`).bind(...Object.values(relation)),
        await auditStatement(env, access, request, "custom_object_relation.created", "custom_object_relation",
          relation.id, null, relation),
      ]);
    } catch {
      return json({ error: "This relation already exists" }, 409);
    }
    return json({ relation }, 201);
  }

  const customRelationMatch = url.pathname.match(/^\/v1\/admin\/custom-object-relations\/(corel_[a-f0-9]{32})$/);
  if (customRelationMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const before = await env.DB.prepare("SELECT * FROM custom_object_relations WHERE workspace_id=? AND id=?")
      .bind(workspaceId, customRelationMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Custom-object relation not found" }, 404);
    const results = await env.DB.batch([
      await auditStatement(env, access, request, "custom_object_relation.deleted", "custom_object_relation",
        String(before.id), before, null),
      env.DB.prepare("DELETE FROM custom_object_relations WHERE workspace_id=? AND id=?")
        .bind(workspaceId, before.id),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes) return json({ error: "Relation was already removed" }, 409);
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/access-policy" && request.method === "GET") {
    const [policy, grants, members, grantContract, opportunityGrantContract, customObjectGrantContract] = await Promise.all([
      env.DB.prepare(`SELECT current_revision,updated_by,updated_at
        FROM workspace_access_policies WHERE workspace_id=?`).bind(workspaceId)
        .first<{ current_revision: number; updated_by: string; updated_at: string }>(),
      env.DB.prepare(`SELECT g.resource,g.action,g.field_name
        FROM workspace_access_policies p JOIN workspace_role_grants g
          ON g.workspace_id=p.workspace_id AND g.revision=p.current_revision
        WHERE p.workspace_id=? AND g.role='member'
          AND (g.resource IN ('contact','opportunity') OR g.resource LIKE 'custom_object:%')
        ORDER BY g.resource,g.action,g.field_name`).bind(workspaceId)
        .all<{ resource: string; action: string; field_name: string }>(),
      isWorkspaceAdmin(access)
        ? env.DB.prepare(`SELECT email,role,active,created_at FROM workspace_members
            WHERE workspace_id=? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,email`)
          .bind(workspaceId).all()
        : Promise.resolve({ results: [] }),
      memberContactGrantContract(env, workspaceId),
      memberOpportunityGrantContract(env, workspaceId),
      memberCustomObjectGrantContract(env, workspaceId),
    ]);
    if (!policy) return json({ error: "Workspace access policy is not initialized" }, 503);
    const storedContactGrantKeys = grants.results.filter((grant) => grant.resource === "contact").map((grant) => grant.field_name
      ? `${grant.action}:${grant.field_name}`
      : grant.action);
    const storedOpportunityGrantKeys = grants.results.filter((grant) => grant.resource === "opportunity").map((grant) =>
      grant.field_name ? `${grant.action}:${grant.field_name}` : grant.action);
    const allowedGrantSet = new Set(grantContract.allowedGrants);
    const allowedOpportunityGrantSet = new Set(opportunityGrantContract.allowedGrants);
    const customObjects = customObjectGrantContract.map((definition) => {
      const stored = grants.results.filter((grant) => grant.resource === definition.resource).map((grant) =>
        grant.field_name ? `${grant.action}:${grant.field_name}` : grant.action);
      const allowed = new Set(definition.allowed_grants);
      return {
        ...definition,
        grants: stored.filter((grant) => allowed.has(grant)),
        stale_grants: stored.filter((grant) => !allowed.has(grant)),
      };
    });
    return json({
      policy: {
        revision: policy.current_revision,
        updated_by: policy.updated_by,
        updated_at: policy.updated_at,
        editable: access.role === "owner",
        subject_role: "member",
        resource: "contact",
        grants: storedContactGrantKeys.filter((grant) => allowedGrantSet.has(grant)),
        stale_grants: storedContactGrantKeys.filter((grant) => !allowedGrantSet.has(grant)),
        allowed_grants: grantContract.allowedGrants,
        custom_fields: grantContract.customFields,
        opportunity: {
          resource: "opportunity",
          grants: storedOpportunityGrantKeys.filter((grant) => allowedOpportunityGrantSet.has(grant)),
          stale_grants: storedOpportunityGrantKeys.filter((grant) => !allowedOpportunityGrantSet.has(grant)),
          allowed_grants: opportunityGrantContract.allowedGrants,
          custom_fields: opportunityGrantContract.customFields,
        },
        custom_objects: customObjects,
        invariants: {
          owners: "full_access",
          admins: "full_access",
          members: "deny_unlisted_writes",
          agents: "separate_scoped_credentials",
          destructive_contact_delete: "admin_only",
          custom_object_relations: "admin_only",
        },
      },
      current_user: { email: access.email, role: access.role },
      members: members.results,
    });
  }

  if (url.pathname === "/v1/admin/access-policy" && request.method === "PATCH") {
    if (access.role !== "owner") return json({ error: "Workspace owner role required" }, 403);
    const body = await readJson(request);
    if (!Number.isInteger(body.expected_revision) || Number(body.expected_revision) < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const [grantContract, opportunityGrantContract, customObjectGrantContract] = await Promise.all([
      memberContactGrantContract(env, workspaceId),
      memberOpportunityGrantContract(env, workspaceId),
      memberCustomObjectGrantContract(env, workspaceId),
    ]);
    const allowedGrantSet = new Set(grantContract.allowedGrants);
    if (!Array.isArray(body.member_contact_grants) ||
      body.member_contact_grants.some((grant) => typeof grant !== "string") ||
      new Set(body.member_contact_grants).size !== body.member_contact_grants.length ||
      body.member_contact_grants.some((grant) => !allowedGrantSet.has(String(grant)))) {
      return json({ error: "member_contact_grants contains an unsupported or duplicate grant" }, 400);
    }
    const requestedContactGrants = (body.member_contact_grants as string[]).sort();
    if (requestedContactGrants.some((grant) => grant.startsWith("update_field:") || grant.startsWith("update_custom_field:")) &&
      !requestedContactGrants.includes("update")) {
      return json({ error: "Field grants require the contact update grant" }, 400);
    }
    const current = await env.DB.prepare(`SELECT current_revision,updated_by,updated_at
      FROM workspace_access_policies WHERE workspace_id=?`).bind(workspaceId)
      .first<{ current_revision: number; updated_by: string; updated_at: string }>();
    if (!current) return json({ error: "Workspace access policy is not initialized" }, 503);
    const expectedRevision = Number(body.expected_revision);
    if (current.current_revision !== expectedRevision) {
      return json({
        error: "Access policy changed since it was loaded",
        code: "edit_conflict",
        current_revision: current.current_revision,
      }, 409);
    }
    const currentRows = await env.DB.prepare(`SELECT resource,action,field_name FROM workspace_role_grants
      WHERE workspace_id=? AND revision=? AND role='member'
        AND (resource IN ('contact','opportunity') OR resource LIKE 'custom_object:%')
      ORDER BY resource,action,field_name`).bind(workspaceId, current.current_revision)
      .all<{ resource: string; action: string; field_name: string }>();
    const beforeContactGrants = currentRows.results.filter((grant) => grant.resource === "contact").map((grant) => grant.field_name
      ? `${grant.action}:${grant.field_name}`
      : grant.action);
    const beforeOpportunityGrants = currentRows.results.filter((grant) => grant.resource === "opportunity").map((grant) =>
      grant.field_name ? `${grant.action}:${grant.field_name}` : grant.action);
    const beforeCustomObjectGrants = Object.fromEntries(customObjectGrantContract.map((definition) => [
      definition.object_id,
      currentRows.results.filter((grant) => grant.resource === definition.resource).map((grant) =>
        grant.field_name ? `${grant.action}:${grant.field_name}` : grant.action)
        .filter((grant) => definition.allowed_grants.includes(grant)).sort(),
    ]));
    const requestedOpportunityGrants = body.member_opportunity_grants === undefined
      ? beforeOpportunityGrants.filter((grant) => opportunityGrantContract.allowedGrants.includes(grant))
      : Array.isArray(body.member_opportunity_grants)
        ? [...body.member_opportunity_grants as string[]].sort()
        : [];
    const allowedOpportunityGrantSet = new Set(opportunityGrantContract.allowedGrants);
    if ((body.member_opportunity_grants !== undefined && !Array.isArray(body.member_opportunity_grants)) ||
      (Array.isArray(body.member_opportunity_grants) &&
        body.member_opportunity_grants.some((grant) => typeof grant !== "string")) ||
      requestedOpportunityGrants.some((grant) => !allowedOpportunityGrantSet.has(grant)) ||
      new Set(requestedOpportunityGrants).size !== requestedOpportunityGrants.length) {
      return json({ error: "member_opportunity_grants contains an unsupported or duplicate grant" }, 400);
    }
    if (requestedOpportunityGrants.some((grant) =>
      grant.startsWith("update_field:") || grant.startsWith("update_custom_field:")) &&
      !requestedOpportunityGrants.includes("update")) {
      return json({ error: "Field grants require the opportunity update grant" }, 400);
    }
    if (requestedOpportunityGrants.some((grant) => grant === "create" || grant === "update" ||
      grant.startsWith("update_field:") || grant.startsWith("update_custom_field:")) &&
      !requestedOpportunityGrants.includes("read")) {
      return json({ error: "Opportunity create and update grants require the read grant" }, 400);
    }
    const suppliedCustomObjectGrants = body.member_custom_object_grants;
    if (suppliedCustomObjectGrants !== undefined &&
      (!isPlainObject(suppliedCustomObjectGrants) ||
        Object.keys(suppliedCustomObjectGrants).some((objectId) =>
          !customObjectGrantContract.some((definition) => definition.object_id === objectId)))) {
      return json({ error: "member_custom_object_grants contains an unknown custom object" }, 400);
    }
    const requestedCustomObjectGrants: Record<string, string[]> = {};
    for (const definition of customObjectGrantContract) {
      const supplied = suppliedCustomObjectGrants === undefined
        ? beforeCustomObjectGrants[definition.object_id]
        : suppliedCustomObjectGrants[definition.object_id] ?? [];
      if (!Array.isArray(supplied) || supplied.some((grant) => typeof grant !== "string") ||
        new Set(supplied).size !== supplied.length ||
        supplied.some((grant) => !definition.allowed_grants.includes(String(grant)))) {
        return json({ error: `member_custom_object_grants.${definition.object_id} contains an unsupported or duplicate grant` }, 400);
      }
      const grantsForObject = [...supplied as string[]].sort();
      if (grantsForObject.some((grant) => grant !== "read" &&
        (grant === "create" || grant === "update" || grant === "delete" ||
          grant.startsWith("read_field:") || grant.startsWith("update_field:"))) &&
        !grantsForObject.includes("read")) {
        return json({ error: `${definition.plural_label} write and field grants require the read grant` }, 400);
      }
      if (grantsForObject.some((grant) => grant.startsWith("update_field:")) &&
        !grantsForObject.includes("update") && !grantsForObject.includes("create")) {
        return json({ error: `${definition.plural_label} field write grants require create or update access` }, 400);
      }
      for (const grant of grantsForObject.filter((grant) => grant.startsWith("update_field:"))) {
        if (!grantsForObject.includes(`read_field:${grant.slice("update_field:".length)}`)) {
          return json({ error: `${definition.plural_label} field edit grants require matching field read grants` }, 400);
        }
      }
      if (grantsForObject.includes("create")) {
        const missingRequiredField = definition.fields.find((field) => field.required &&
          !grantsForObject.includes(field.update_grant));
        if (missingRequiredField) {
          return json({ error: `${definition.plural_label} create requires edit access to required field ${missingRequiredField.label}` }, 400);
        }
      }
      requestedCustomObjectGrants[definition.object_id] = grantsForObject;
    }
    const nextRevision = expectedRevision + 1;
    const changeId = id("policy");
    const now = new Date().toISOString();
    const contactGrantStatements = requestedContactGrants.map((grant) => {
      const [action, fieldName = ""] = grant.split(":");
      return env.DB.prepare(`INSERT INTO workspace_role_grants
        (id,workspace_id,revision,role,resource,action,field_name,created_at)
        SELECT ?,?,?,'member','contact',?,?,?
        WHERE EXISTS(
          SELECT 1 FROM workspace_access_policy_versions
          WHERE workspace_id=? AND revision=? AND change_id=?
        )`)
        .bind(id("grant"), workspaceId, nextRevision, action, fieldName, now,
          workspaceId, nextRevision, changeId);
    });
    const opportunityGrantStatements = requestedOpportunityGrants.map((grant) => {
      const [action, fieldName = ""] = grant.split(":");
      return env.DB.prepare(`INSERT INTO workspace_role_grants
        (id,workspace_id,revision,role,resource,action,field_name,created_at)
        SELECT ?,?,?,'member','opportunity',?,?,?
        WHERE EXISTS(
          SELECT 1 FROM workspace_access_policy_versions
          WHERE workspace_id=? AND revision=? AND change_id=?
        )`)
        .bind(id("grant"), workspaceId, nextRevision, action, fieldName, now,
          workspaceId, nextRevision, changeId);
    });
    const customObjectGrantStatements = customObjectGrantContract.flatMap((definition) =>
      requestedCustomObjectGrants[definition.object_id].map((grant) => {
        const [action, fieldName = ""] = grant.split(":");
        return env.DB.prepare(`INSERT INTO workspace_role_grants
          (id,workspace_id,revision,role,resource,action,field_name,created_at)
          SELECT ?,?,?,'member',?,?,?,?
          WHERE EXISTS(
            SELECT 1 FROM workspace_access_policy_versions
            WHERE workspace_id=? AND revision=? AND change_id=?
          )`)
          .bind(id("grant"), workspaceId, nextRevision, definition.resource, action, fieldName, now,
            workspaceId, nextRevision, changeId);
      }));
    const ip = request.headers.get("cf-connecting-ip");
    const ipHash = ip ? await sha256(ip) : null;
    const policyAuditId = id("audit");
    const policyAudit = env.DB.prepare(`INSERT INTO audit_log
      (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
      SELECT ?,?,'user',?,'workspace.access_policy_updated','workspace',?,?,?,?,?,?
      WHERE EXISTS(
        SELECT 1 FROM workspace_access_policy_versions
        WHERE workspace_id=? AND revision=? AND change_id=?
      ) AND EXISTS(
        SELECT 1 FROM workspace_access_policies
        WHERE workspace_id=? AND current_revision=?
      )`)
      .bind(policyAuditId, workspaceId, access.email, workspaceId,
        JSON.stringify({
          revision: expectedRevision,
          member_contact_grants: beforeContactGrants,
          member_opportunity_grants: beforeOpportunityGrants,
          member_custom_object_grants: beforeCustomObjectGrants,
        }),
        JSON.stringify({
          revision: nextRevision,
          member_contact_grants: requestedContactGrants,
          member_opportunity_grants: requestedOpportunityGrants,
          member_custom_object_grants: requestedCustomObjectGrants,
        }),
        requestId(request), ipHash, now,
        workspaceId, nextRevision, changeId, workspaceId, nextRevision);
    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE workspace_access_policies
          SET current_revision=?,current_change_id=?,updated_by=?,updated_at=?
          WHERE workspace_id=? AND current_revision=?`)
          .bind(nextRevision, changeId, access.email, now, workspaceId, expectedRevision),
        env.DB.prepare(`INSERT INTO workspace_access_policy_versions
          (workspace_id,revision,change_id,created_by,created_at)
          SELECT ?,?,?,?,?
          WHERE EXISTS(
            SELECT 1 FROM workspace_access_policies
            WHERE workspace_id=? AND current_revision=? AND current_change_id=?
          )`)
          .bind(workspaceId, nextRevision, changeId, access.email, now,
            workspaceId, nextRevision, changeId),
        ...contactGrantStatements,
        ...opportunityGrantStatements,
        ...customObjectGrantStatements,
        policyAudit,
      ]);
      const committed = await env.DB.prepare(`SELECT
          p.current_revision,p.current_change_id,
          EXISTS(SELECT 1 FROM workspace_access_policy_versions v
            WHERE v.workspace_id=p.workspace_id AND v.revision=? AND v.change_id=?) version_exists,
          EXISTS(SELECT 1 FROM audit_log a
            WHERE a.workspace_id=p.workspace_id AND a.id=? AND a.action='workspace.access_policy_updated') audit_exists,
          (SELECT COUNT(*) FROM workspace_role_grants g
            WHERE g.workspace_id=p.workspace_id AND g.revision=?) grant_count
        FROM workspace_access_policies p WHERE p.workspace_id=?`)
        .bind(nextRevision, changeId, policyAuditId, nextRevision, workspaceId)
        .first<{ current_revision: number; current_change_id: string; version_exists: number; audit_exists: number; grant_count: number }>();
      if (!committed || committed.current_change_id !== changeId) {
        return json({ error: "Access policy changed since it was loaded", code: "edit_conflict" }, 409);
      }
      if (Number(committed.current_revision) !== nextRevision || !committed.version_exists ||
        !committed.audit_exists ||
        Number(committed.grant_count) !== requestedContactGrants.length + requestedOpportunityGrants.length +
          customObjectGrantStatements.length) {
        return json({
          error: "Access policy update failed and was rolled back",
          code: "policy_update_failed",
        }, 500);
      }
    } catch {
      return json({
        error: "Access policy update failed and was rolled back",
        code: "policy_update_failed",
      }, 500);
    }
    return json({
      ok: true,
      policy: {
        revision: nextRevision,
        updated_by: access.email,
        updated_at: now,
        editable: true,
        subject_role: "member",
        resource: "contact",
        grants: requestedContactGrants,
        allowed_grants: grantContract.allowedGrants,
        custom_fields: grantContract.customFields,
        opportunity: {
          resource: "opportunity",
          grants: requestedOpportunityGrants,
          allowed_grants: opportunityGrantContract.allowedGrants,
          custom_fields: opportunityGrantContract.customFields,
        },
        custom_objects: customObjectGrantContract.map((definition) => ({
          ...definition,
          grants: requestedCustomObjectGrants[definition.object_id],
          stale_grants: [],
        })),
      },
    });
  }

  if (url.pathname === "/v1/admin/recovery/backup" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const workspace = await env.DB.prepare("SELECT slug,name FROM workspaces WHERE id=?").bind(workspaceId)
      .first<{ slug: string; name: string }>();
    if (!workspace) return json({ error: "Workspace not found" }, 404);
    const results = await env.DB.batch(recoveryTables.map((table) => {
      const columns = recoverySpecs[table].columns.join(",");
      return env.DB.prepare(`SELECT ${columns} FROM ${table} WHERE workspace_id=? ORDER BY id`).bind(workspaceId);
    }));
    const createdAt = new Date().toISOString();
    const backup = {
      format: RECOVERY_FORMAT,
      version: RECOVERY_VERSION,
      schema_version: RECOVERY_SCHEMA_VERSION,
      workspace_id: workspaceId,
      workspace_slug: workspace.slug,
      workspace_name: workspace.name,
      created_at: createdAt,
      tables: Object.fromEntries(recoveryTables.map((table, index) => [table, results[index].results])),
    };
    const plaintext = JSON.stringify(backup);
    if (encoder.encode(plaintext).byteLength > MAX_RECOVERY_PLAINTEXT_BYTES) {
      return json({ error: "Workspace backup exceeds the in-app recovery limit; use D1 export and Time Travel" }, 413);
    }
    const encrypted = await encryptRecovery(env, workspaceId, plaintext);
    const envelope = JSON.stringify({
      format: `${RECOVERY_FORMAT}.encrypted`,
      version: RECOVERY_VERSION,
      workspace_id: workspaceId,
      created_at: createdAt,
      algorithm: "AES-256-GCM",
      ...encrypted,
    });
    await audit(env, access, request, "workspace.backup_exported", "workspace", workspaceId, null, {
      schema_version: RECOVERY_SCHEMA_VERSION,
      counts: Object.fromEntries(recoveryTables.map((table, index) => [table, results[index].results.length])),
    });
    const safeSlug = workspace.slug.replace(/[^a-z0-9-]/g, "-");
    return new Response(envelope, {
      status: 200,
      headers: {
        ...securityHeaders,
        "cache-control": "no-store",
        "content-type": "application/vnd.openoperator.backup+json",
        "content-disposition": `attachment; filename="${safeSlug}-backup-${createdAt.slice(0, 10)}.crbackup.json"`,
      },
    });
  }

  if (url.pathname === "/v1/admin/recovery/restore/validate" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const envelope = await readJsonLimited(request, MAX_RECOVERY_BYTES, true);
    if (envelope.format !== `${RECOVERY_FORMAT}.encrypted` || envelope.version !== RECOVERY_VERSION ||
      envelope.workspace_id !== workspaceId || envelope.algorithm !== "AES-256-GCM" ||
      typeof envelope.key_id !== "string" || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
      return json({ error: "Backup envelope is incompatible with this workspace" }, 400);
    }
    const plaintext = await decryptRecovery(env, workspaceId, envelope.key_id, envelope.iv, envelope.ciphertext);
    if (encoder.encode(plaintext).byteLength > MAX_RECOVERY_PLAINTEXT_BYTES) return json({ error: "Decrypted backup is too large" }, 413);
    let backup: Json;
    try {
      const parsed = JSON.parse(plaintext);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      backup = parsed as Json;
    } catch {
      return json({ error: "Decrypted backup is malformed" }, 400);
    }
    if (backup.format !== RECOVERY_FORMAT || backup.version !== RECOVERY_VERSION ||
      backup.schema_version !== RECOVERY_SCHEMA_VERSION || backup.workspace_id !== workspaceId ||
      backup.created_at !== envelope.created_at || typeof backup.created_at !== "string" ||
      !Number.isFinite(Date.parse(backup.created_at))) {
      return json({ error: "Backup contents are incompatible or metadata was altered" }, 400);
    }
    await ensureRecoveryStagingSchema(env);
    const validated = await validateRecoveryRows(env, workspaceId, backup.tables);
    const sourceIds = [...new Set([
      ...validated.tables.activities.map((row) => row.source_id),
      ...validated.tables.deals.map((row) => row.source_id),
    ].filter((value): value is string => typeof value === "string"))];
    if (sourceIds.length) {
      const existing = await env.DB.prepare(`SELECT COUNT(*) total FROM sources s
        JOIN json_each(?) requested ON requested.value=s.id WHERE s.workspace_id=?`)
        .bind(JSON.stringify(sourceIds), workspaceId).first<{ total: number }>();
      if (Number(existing?.total || 0) !== sourceIds.length) {
        return json({ error: "Backup references source integrations that no longer exist" }, 409);
      }
    }
    const fingerprint = await workspaceRecoveryFingerprint(env, workspaceId);
    const sessionId = id("rec");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const summary = JSON.stringify({ counts: validated.counts, total_rows: validated.totalRows });
    const statements = [
      env.DB.prepare("DELETE FROM recovery_sessions WHERE workspace_id=? AND expires_at<?").bind(workspaceId, now),
      env.DB.prepare(`INSERT INTO recovery_sessions
        (id,workspace_id,status,backup_created_at,fingerprint,summary,expires_at,created_by,created_at)
        VALUES(?,?,'ready',?,?,?,?,?,?)`)
        .bind(sessionId, workspaceId, backup.created_at, fingerprint, summary, expiresAt, access.email, now),
      ...recoveryTables.map((table) => env.DB.prepare(`INSERT INTO recovery_rows
        (session_id,workspace_id,table_name,row_id,row_json)
        SELECT ?,?,?,json_extract(value,'$.id'),value FROM json_each(?)`)
        .bind(sessionId, workspaceId, table, JSON.stringify(validated.tables[table]))),
      ...recoveryTables.map((table) => recoveryGuardCaptureStatement(env, table, sessionId, workspaceId)),
    ];
    await env.DB.batch(statements);
    await audit(env, access, request, "workspace.restore_validated", "recovery_session", sessionId, null, {
      backup_created_at: backup.created_at, counts: validated.counts, expires_at: expiresAt,
    });
    const workspace = await env.DB.prepare("SELECT slug FROM workspaces WHERE id=?").bind(workspaceId).first<{ slug: string }>();
    return json({
      ok: true,
      restore: {
        id: sessionId,
        backup_created_at: backup.created_at,
        expires_at: expiresAt,
        counts: validated.counts,
        total_rows: validated.totalRows,
        confirmation: `RESTORE ${workspace?.slug || workspaceId}`,
        preserved: ["workspace members and access policies", "source credentials", "webhook credentials and delivery history", "agent credentials and request logs", "audit history"],
        cleared: ["agent analysis runs, pending proposals, and queued agent work"],
      },
    });
  }

  const recoveryCommitMatch = url.pathname.match(/^\/v1\/admin\/recovery\/restore\/(rec_[a-f0-9]{32})$/);
  if (recoveryCommitMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const deleted = await env.DB.prepare("DELETE FROM recovery_sessions WHERE id=? AND workspace_id=? AND status='ready'")
      .bind(recoveryCommitMatch[1], workspaceId).run();
    if (!deleted.meta.changes) return json({ error: "Recovery session not found" }, 404);
    await audit(env, access, request, "workspace.restore_cancelled", "recovery_session", recoveryCommitMatch[1], null, null);
    return json({ ok: true });
  }
  if (recoveryCommitMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const workspace = await env.DB.prepare("SELECT slug FROM workspaces WHERE id=?").bind(workspaceId).first<{ slug: string }>();
    const confirmation = `RESTORE ${workspace?.slug || workspaceId}`;
    if (body.confirmation !== confirmation) return json({ error: `Type ${confirmation} to commit this restore` }, 400);
    const session = await env.DB.prepare(`SELECT * FROM recovery_sessions
      WHERE id=? AND workspace_id=? AND status='ready' AND expires_at>?`)
      .bind(recoveryCommitMatch[1], workspaceId, new Date().toISOString())
      .first<{ fingerprint: string; summary: string; backup_created_at: string }>();
    if (!session) return json({ error: "Recovery session is missing or expired" }, 410);
    const sessionId = recoveryCommitMatch[1];
    const restoreOwnerId = `restore:${sessionId}:${crypto.randomUUID().replaceAll("-", "")}`;
    const leaseStartedAt = new Date().toISOString();
    const lease = await acquireWorkspaceOperationLease(
      env, workspaceId, "workspace_restore", restoreOwnerId, leaseStartedAt,
    );
    if (!lease.acquired) {
      return json({
        error: lease.active?.operation === "revenue_analysis"
          ? "Revenue analysis is already running; wait for it to finish before restoring this workspace"
          : "A workspace restore is already running",
        code: "workspace_operation_in_progress",
        blocking_operation: lease.active?.operation || "unknown",
        retry_after_seconds: lease.retryAfter,
      }, 409, { "retry-after": String(lease.retryAfter) });
    }
    try {
    const currentFingerprint = await workspaceRecoveryFingerprint(env, workspaceId);
    if (currentFingerprint !== session.fingerprint) {
      return json({ error: "Workspace data changed after validation. Upload and validate the backup again.", code: "restore_conflict" }, 409);
    }
    const summary = JSON.parse(session.summary) as Json;
    const auditId = id("aud");
    const requestIdentifier = requestId(request);
    const createdAt = new Date().toISOString();
    const guardSql = `SELECT CASE WHEN EXISTS(
        SELECT 1 FROM recovery_sessions
        WHERE id=? AND workspace_id=? AND status='ready' AND expires_at>?
      ) AND ${exactRecoveryGuardSql(workspaceId, sessionId)}
      THEN 1 ELSE json('restore_conflict') END`;
    const statements = [
      env.DB.prepare(guardSql).bind(
        sessionId, workspaceId, createdAt,
      ),
      env.DB.prepare("DELETE FROM agent_work_items WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM agent_proposals WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM agent_runs WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM tasks WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM mailbox_connections WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM conversation_messages WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM conversation_threads WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM communication_consents WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM form_submissions WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM survey_responses WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM survey_versions WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM surveys WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM payment_ledger_entries WHERE workspace_id=? AND parent_entry_id IS NOT NULL").bind(workspaceId),
      env.DB.prepare("DELETE FROM payment_ledger_entries WHERE workspace_id=? AND parent_entry_id IS NULL").bind(workspaceId),
      env.DB.prepare("DELETE FROM booking_appointments WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM booking_availability_rules WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM booking_calendars WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM form_versions WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM forms WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM visitor_intent_cases WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM visitor_events WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM audience_import_members WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM visitor_profiles WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM audience_imports WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM visitor_connectors WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM automation_runs WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM automation_rules WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM opportunities WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM company_notes WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM notes WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM deals WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM activities WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM saved_views WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM contacts WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM company_redirects WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM companies WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM pipeline_stages WHERE workspace_id=?").bind(workspaceId),
      env.DB.prepare("DELETE FROM pipelines WHERE workspace_id=?").bind(workspaceId),
      ...recoveryTables.map((table) => recoveryInsertStatement(env, table, sessionId, workspaceId)),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
        VALUES(?,?,'user',?,'workspace.restored','workspace',?,NULL,?,?,?)`)
        .bind(auditId, workspaceId, access.email, workspaceId,
          JSON.stringify({ backup_created_at: session.backup_created_at, ...summary }), requestIdentifier, createdAt),
      env.DB.prepare("DELETE FROM recovery_sessions WHERE id=? AND workspace_id=?").bind(sessionId, workspaceId),
    ];
    try {
      await env.DB.batch(statements);
    } catch (error) {
      const [latestFingerprint, stillReady, exactGuardMatches] = await Promise.all([
        workspaceRecoveryFingerprint(env, workspaceId),
        env.DB.prepare(`SELECT 1 present FROM recovery_sessions
          WHERE id=? AND workspace_id=? AND status='ready' AND expires_at>?`)
          .bind(sessionId, workspaceId, new Date().toISOString()).first(),
        exactRecoveryGuardMatches(env, workspaceId, sessionId),
      ]);
      if (!stillReady || latestFingerprint !== session.fingerprint || !exactGuardMatches) {
        return json({ error: "Restore was already committed or workspace data changed. This request made no changes; validate again.", code: "restore_conflict" }, 409);
      }
      console.error(JSON.stringify({ message: "workspace restore failed", workspace_id: workspaceId, error: error instanceof Error ? error.message : "Unknown error" }));
      return json({ error: "Restore failed and was rolled back" }, 500);
    }
    return json({ ok: true, restored: summary, backup_created_at: session.backup_created_at });
    } finally {
      try {
        await releaseWorkspaceOperationLease(env, workspaceId, restoreOwnerId);
      } catch (leaseError) {
        console.error(JSON.stringify({
          message: "Workspace restore lease cleanup failed",
          recovery_session_id: sessionId,
          error: leaseError instanceof Error ? leaseError.message.slice(0, 500) : "Unknown lease cleanup error",
        }));
      }
    }
  }

  if (url.pathname === "/v1/admin/mailbox-connections" && request.method === "GET") {
    const connections = await env.DB.prepare(`SELECT id,owner_email,provider,toolkit,alias,connected_account_id,
      status,provider_status,allowed_capabilities,last_synced_at,last_error,revision,connect_expires_at,created_at,updated_at
      FROM mailbox_connections WHERE workspace_id=? AND (?=1 OR owner_email=?)
      ORDER BY updated_at DESC,id DESC`)
      .bind(workspaceId, isWorkspaceAdmin(access) ? 1 : 0, normalizeEmail(access.email))
      .all<Record<string, unknown>>();
    return json({
      connections: connections.results.map((connection) => ({
        ...connection,
        allowed_capabilities: parseStringArray(connection.allowed_capabilities),
      })),
      readiness: {
        composio: Boolean(env.COMPOSIO_API_KEY),
        gmail: Boolean(env.COMPOSIO_API_KEY && env.COMPOSIO_GMAIL_AUTH_CONFIG_ID),
        outlook: Boolean(env.COMPOSIO_API_KEY && env.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID),
        authority: "connection_only_no_execution",
      },
      contracts: {
        self_service: "mailbox_oauth_self_service_v1",
        advanced_link: "mailbox_connect_link_advanced_v1",
        reconnect: "mailbox_oauth_reconnect_v1",
      },
      authority: { draft: false, send: false, delete: false, execution: false },
    });
  }

  const mailboxConversationMatch = url.pathname.match(
    /^\/v1\/admin\/mailbox-connections\/(mbx_[a-f0-9]{32})\/conversations$/,
  );
  if (mailboxConversationMatch && request.method === "GET") {
    const limitValue = Number(url.searchParams.get("limit") || "10");
    if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 25) {
      return json({ error: "limit must be a whole number from 1 to 25" }, 400);
    }
    const connection = await env.DB.prepare(`SELECT id,owner_email,provider,connected_account_id,status
      FROM mailbox_connections WHERE workspace_id=? AND id=? AND (?=1 OR owner_email=?)`)
      .bind(workspaceId, mailboxConversationMatch[1], isWorkspaceAdmin(access) ? 1 : 0,
        normalizeEmail(access.email))
      .first<Record<string, unknown>>();
    if (!connection) return json({ error: "Mailbox connection not found" }, 404);
    if (connection.status !== "active" || !connection.connected_account_id) {
      return json({ error: "Only an active mailbox can show conversations", code: "mailbox_not_active" }, 409);
    }
    try {
      const conversations = await fetchMailboxConversations(
        env, connection.provider as MailboxProvider, String(connection.connected_account_id), limitValue,
      );
      return json({
        connection: { id: connection.id, owner_email: connection.owner_email, provider: connection.provider },
        conversations,
        privacy: { persisted: false, bodies_returned: false, attachments_returned: false, maximum_results: 25 },
        authority: { read_metadata: true, draft: false, send: false, delete: false },
      });
    } catch (error) {
      const failure = mailboxProviderFailure(error);
      return json({ error: failure.message, code: failure.code }, 502);
    }
  }

  const mailboxConversationSyncMatch = url.pathname.match(
    /^\/v1\/admin\/mailbox-connections\/(mbx_[a-f0-9]{32})\/sync-conversations$/,
  );
  if (mailboxConversationSyncMatch && request.method === "POST") {
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["limit", "confirmation"].includes(key))) {
      return json({ error: "Mailbox sync contains unsupported fields" }, 400);
    }
    if (body.confirmation !== "SYNC EMAIL METADATA") return json({ error: "Explicit sync confirmation is required" }, 400);
    const limitValue = body.limit === undefined ? 10 : Number(body.limit);
    if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 25) {
      return json({ error: "limit must be a whole number from 1 to 25" }, 400);
    }
    const connection = await env.DB.prepare(`SELECT id,owner_email,provider,connected_account_id,status
      FROM mailbox_connections WHERE workspace_id=? AND id=? AND (?=1 OR owner_email=?)`)
      .bind(workspaceId, mailboxConversationSyncMatch[1], isWorkspaceAdmin(access) ? 1 : 0, normalizeEmail(access.email))
      .first<Record<string, unknown>>();
    if (!connection) return json({ error: "Mailbox connection not found" }, 404);
    if (connection.status !== "active" || !connection.connected_account_id) {
      return json({ error: "Only an active mailbox can sync conversations", code: "mailbox_not_active" }, 409);
    }
    let providerConversations: MailboxConversation[];
    try {
      providerConversations = await fetchMailboxConversations(env, connection.provider as MailboxProvider,
        String(connection.connected_account_id), limitValue);
    } catch (error) {
      const failure = mailboxProviderFailure(error);
      return json({ error: failure.message, code: failure.code }, 502);
    }
    let imported = 0;
    let repeated = 0;
    let skipped = 0;
    for (const conversation of providerConversations) {
      const senderEmail = normalizeEmail(conversation.sender_email);
      const occurredAt = conversation.received_at && Number.isFinite(Date.parse(conversation.received_at))
        ? conversation.received_at : null;
      if (!validEmail(senderEmail) || !occurredAt) { skipped += 1; continue; }
      const receipt = `${connection.id}:${conversation.id}:${occurredAt}`;
      const providerMessageId = (await sha256(receipt)).slice(0, 64);
      const existing = await env.DB.prepare(`SELECT id FROM conversation_messages
        WHERE workspace_id=? AND provider=? AND provider_message_id=?`)
        .bind(workspaceId, connection.provider, providerMessageId).first();
      if (existing) { repeated += 1; continue; }
      const contact = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND email=?")
        .bind(workspaceId, senderEmail).first<{ id: string }>();
      const subject = (conversation.subject || "(no subject)").trim().slice(0, 200) || "(no subject)";
      const providerThreadId = `${connection.id}:${conversation.id}`;
      const thread = await env.DB.prepare(`SELECT * FROM conversation_threads WHERE workspace_id=? AND channel='email'
        AND provider=? AND provider_thread_id=? LIMIT 1`)
        .bind(workspaceId, connection.provider, providerThreadId).first<Record<string, unknown>>();
      const now = new Date().toISOString();
      const threadId = thread ? String(thread.id) : id("thread");
      const messageId = id("msg");
      const changeId = id("chg");
      const idempotencyKey = `mailbox:${providerMessageId}`;
      const statements = [];
      if (!thread) {
        statements.push(env.DB.prepare(`INSERT INTO conversation_threads
          (id,workspace_id,contact_id,channel,provider,provider_thread_id,participant_email,subject,status,last_message_at,unread_count,revision,change_id,created_at,updated_at)
          VALUES(?,?,?,'email',?,?,?,?,'open',?,1,1,?,?,?)`)
          .bind(threadId, workspaceId, contact?.id || null, connection.provider, providerThreadId,
            senderEmail, subject, occurredAt, changeId, now, now));
      } else {
        statements.push(env.DB.prepare(`UPDATE conversation_threads SET contact_id=COALESCE(contact_id,?),status='open',
          last_message_at=CASE WHEN last_message_at<? THEN ? ELSE last_message_at END,unread_count=unread_count+1,
          revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=?`)
          .bind(contact?.id || null, occurredAt, occurredAt, changeId, now, workspaceId, threadId));
      }
      statements.push(env.DB.prepare(`INSERT INTO conversation_messages
        (id,workspace_id,thread_id,direction,provider,provider_message_id,idempotency_key,from_email,to_email,subject,
         body_text,purpose,status,error,sent_by,occurred_at,created_at,updated_at)
        VALUES(?,?,?,'inbound',?,?,?,?,?,?,?,'inbound','received',NULL,NULL,?,?,?)`)
        .bind(messageId, workspaceId, threadId, connection.provider, providerMessageId, idempotencyKey,
          senderEmail, normalizeEmail(connection.owner_email), subject, String(conversation.snippet || "").slice(0, 1000),
          occurredAt, now, now));
      if (contact) statements.push(env.DB.prepare(`INSERT INTO communication_consents
        (id,workspace_id,contact_id,channel,status,basis,evidence,captured_at,revision,change_id,created_by,created_at,updated_at)
        VALUES(?,?,?,'email','opted_in','inbound_request',?,?,1,?,?,?,?)
        ON CONFLICT(workspace_id,contact_id,channel) DO UPDATE SET
          status='opted_in',basis='inbound_request',evidence=excluded.evidence,captured_at=excluded.captured_at,
          revision=communication_consents.revision+1,change_id=excluded.change_id,updated_at=excluded.updated_at
        WHERE communication_consents.status='unknown'`)
        .bind(id("consent"), workspaceId, contact.id, `Inbound email received by ${connection.owner_email}`,
          occurredAt, id("chg"), access.email, now, now));
      statements.push(await auditStatement(env, access, request, "conversation.message_received", "conversation_message",
        messageId, null, { thread_id: threadId, contact_id: contact?.id || null, provider: connection.provider,
          sender_email: senderEmail, subject }));
      try { await env.DB.batch(statements); imported += 1; }
      catch {
        const raced = await env.DB.prepare(`SELECT id FROM conversation_messages
          WHERE workspace_id=? AND provider=? AND provider_message_id=?`)
          .bind(workspaceId, connection.provider, providerMessageId).first();
        if (raced) repeated += 1; else throw new ApiError(500, "Conversation sync failed and was rolled back");
      }
    }
    return json({ ok: true, imported, repeated, skipped, received: providerConversations.length,
      privacy: { persisted: true, body_source: "provider snippet only", attachments_persisted: false } });
  }

  if (url.pathname === "/v1/admin/mailbox-connections" && request.method === "POST") {
    const body = await readJson(request);
    const provider = String(body.provider || "").trim().toLowerCase();
    const alias = String(body.alias || "").trim();
    if (!["gmail", "outlook"].includes(provider)) return json({ error: "provider must be gmail or outlook" }, 400);
    if (!alias || alias.length > 80) return json({ error: "alias is required and cannot exceed 80 characters" }, 400);
    if (!env.COMPOSIO_API_KEY || !mailboxAuthConfigId(env, provider)) {
      return json({ error: `${provider === "gmail" ? "Gmail" : "Microsoft 365"} connection is not configured`,
        code: "provider_not_configured" }, 503);
    }
    const member = await env.DB.prepare(`SELECT id,email FROM workspace_members
      WHERE workspace_id=? AND email=? COLLATE NOCASE AND active=1`)
      .bind(workspaceId, access.email).first<{ id: string; email: string }>();
    if (!member) return json({ error: "Active workspace membership required" }, 403);
    const ownerEmail = normalizeEmail(member.email);
    const connectionId = id("mbx");
    const state = crmMailboxStateToken();
    const stateHash = await sha256(state);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const toolkit = provider;
    const authConfigId = mailboxAuthConfigId(env, provider)!;
    const composioUserId = await mailboxComposioUserId(workspaceId, ownerEmail);
    const capabilities = ["mail.profile.read", "mail.drafts.create"];
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO mailbox_connections
          (id,workspace_id,owner_email,provider,toolkit,alias,auth_config_id,composio_user_id,status,
           allowed_capabilities,revision,change_id,connect_expires_at,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'pending',?,1,?,?,?,?,?)`)
          .bind(connectionId, workspaceId, ownerEmail, provider, toolkit, alias, authConfigId,
            composioUserId, JSON.stringify(capabilities), stateHash, expiresAt, access.email, now, now),
        await auditStatement(env, access, request, "mailbox.connection_requested", "mailbox_connection",
          connectionId, null, { provider, alias, owner_email: ownerEmail, capabilities }),
      ]);
    } catch {
      return json({ error: "A mailbox with that provider and alias already exists" }, 409);
    }
    const callbackUrl = `https://crm.example.com/v1/admin/mailbox-connections/callback?state=${state}`;
    let issuedAccountId: string | null = null;
    try {
      const linked = await composioRequest(env, "/api/v3.1/connected_accounts/link", {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: authConfigId, user_id: composioUserId, alias, callback_url: callbackUrl,
        }),
      });
      const redirectUrl = safeComposioRedirect(linked.redirect_url);
      const connectedAccountId = composioAccountId(linked) ||
        (isPlainObject(linked.connected_account) ? composioAccountId(linked.connected_account) : null);
      const providerExpiresAt = typeof linked.expires_at === "string" && Number.isFinite(Date.parse(linked.expires_at))
        ? linked.expires_at : null;
      if (!redirectUrl || !connectedAccountId || !providerExpiresAt) throw new Error("Unexpected Connect Link response");
      issuedAccountId = connectedAccountId;
      const linkedAt = new Date().toISOString();
      const linkedResults = await env.DB.batch([
        env.DB.prepare(`UPDATE mailbox_connections SET connected_account_id=?,provider_status='INITIATED',
          connect_expires_at=?,last_synced_at=?,revision=revision+1,updated_at=?
          WHERE workspace_id=? AND id=? AND status='pending' AND revision=1 AND change_id=?`)
          .bind(connectedAccountId, providerExpiresAt, linkedAt, linkedAt,
            workspaceId, connectionId, stateHash),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
          SELECT ?,?,'user',?,'mailbox.connection_link_issued','mailbox_connection',?,?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM mailbox_connections
            WHERE workspace_id=? AND id=? AND connected_account_id=? AND revision=2 AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, connectionId,
            JSON.stringify({ status: "pending", connected_account_id: null }),
            JSON.stringify({ status: "pending", connected_account_id: connectedAccountId,
              provider_status: "INITIATED", redirect_url_stored: false }),
            requestId(request), request.headers.get("cf-connecting-ip")
              ? await sha256(request.headers.get("cf-connecting-ip")!) : null, linkedAt,
            workspaceId, connectionId, connectedAccountId, stateHash),
      ]);
      if (!linkedResults[0].meta.changes) throw new Error("Connection changed before the link was recorded");
      return json({
        contract: "mailbox_oauth_self_service_v1",
        connection: { id: connectionId, owner_email: ownerEmail, provider, alias, status: "pending",
          connected_account_id: connectedAccountId, allowed_capabilities: capabilities,
          revision: 2, expires_at: providerExpiresAt },
        redirect_url: redirectUrl,
      }, 201);
    } catch (error) {
      const compensated = issuedAccountId ? await bestEffortComposioRevoke(env, issuedAccountId) : false;
      const providerFailure = mailboxProviderFailure(error);
      const failedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`UPDATE mailbox_connections SET status='error',connected_account_id=COALESCE(?,connected_account_id),
          provider_status=?,last_error=?,change_id=NULL,connect_expires_at=NULL,revision=revision+1,updated_at=?
          WHERE workspace_id=? AND id=? AND status='pending'`)
          .bind(issuedAccountId, issuedAccountId
            ? (compensated ? "REVOKED_AFTER_COMMIT_FAILURE" : "ORPHAN_REVOKE_FAILED")
            : providerFailure.providerStatus,
            issuedAccountId ? (compensated
              ? "Provider authority was revoked after the CRM could not commit the Connect Link"
              : "Provider authority may still be live after the CRM could not commit the Connect Link")
              : providerFailure.message,
            failedAt, workspaceId, connectionId),
        await auditStatement(env, access, request, "mailbox.connection_failed", "mailbox_connection",
          connectionId, { status: "pending" }, {
            status: "error", reason: issuedAccountId ? "link_commit_failed" : providerFailure.code,
            upstream_status: issuedAccountId ? null : providerFailure.upstreamStatus,
            connected_account_id: issuedAccountId, compensating_revoke_confirmed: compensated,
          }),
      ]);
      return json({
        error: issuedAccountId
          ? "The mailbox link could not be committed and provider authority was rolled back"
          : providerFailure.message,
        code: issuedAccountId ? "link_commit_failed" : providerFailure.code,
      }, issuedAccountId ? 500 : 502);
    }
  }

  if (url.pathname === "/v1/admin/mailbox-connections/callback" && request.method === "GET") {
    const state = url.searchParams.get("state") || "";
    if (!/^[a-f0-9]{64}$/.test(state)) {
      return json({ error: "Mailbox callback is invalid" }, 400);
    }
    const stateHash = await sha256(state);
    const connection = await env.DB.prepare(`SELECT * FROM mailbox_connections
      WHERE workspace_id=? AND owner_email=? COLLATE NOCASE AND change_id=? AND status='pending'`)
      .bind(workspaceId, access.email, stateHash).first<Record<string, unknown>>();
    if (!connection) return json({ error: "Mailbox connection request was not found" }, 404);
    if (!connection.connected_account_id || !connection.connect_expires_at ||
      Date.parse(String(connection.connect_expires_at)) <= Date.now()) {
      return json({ error: "Mailbox connection request expired or failed" }, 410);
    }
    const connectedAccountId = String(connection.connected_account_id);
    const providerAccount = await composioRequest(env,
      `/api/v3.1/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
    const providerToolkit = isPlainObject(providerAccount.toolkit) ? String(providerAccount.toolkit.slug || "") : "";
    const providerAuth = isPlainObject(providerAccount.auth_config) ? String(providerAccount.auth_config.id || "") : "";
    if (providerAccount.id !== connectedAccountId || providerAccount.user_id !== connection.composio_user_id ||
      providerToolkit !== connection.toolkit || providerAuth !== connection.auth_config_id ||
      providerAccount.status !== "ACTIVE") {
      return json({ error: "Mailbox provider identity did not match this connection request" }, 409);
    }
    const now = new Date().toISOString();
    const nextRevision = Number(connection.revision) + 1;
    const ip = request.headers.get("cf-connecting-ip");
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE mailbox_connections SET connected_account_id=?,status='active',
        provider_status='ACTIVE',last_synced_at=?,last_error=NULL,revision=?,change_id=NULL,
        connect_expires_at=NULL,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=? AND status='pending' AND change_id=?`)
        .bind(connectedAccountId, now, nextRevision, now, workspaceId, connection.id, connection.revision, stateHash),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'mailbox.connection_activated','mailbox_connection',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM mailbox_connections
          WHERE workspace_id=? AND id=? AND revision=? AND status='active' AND connected_account_id=?)`)
        .bind(id("audit"), workspaceId, access.email, connection.id, JSON.stringify({ status: "pending" }),
          JSON.stringify({ status: "active", provider: connection.provider, owner_email: connection.owner_email,
            capabilities: JSON.parse(String(connection.allowed_capabilities)) }),
          requestId(request), ip ? await sha256(ip) : null, now,
          workspaceId, connection.id, nextRevision, connectedAccountId),
    ]);
    if (!results[0].meta.changes) return json({ error: "Mailbox connection changed before activation", code: "edit_conflict" }, 409);
    return new Response(null, {
      status: 303,
      headers: { location: "/?view=integrations&mailbox=connected", "cache-control": "no-store", ...securityHeaders },
    });
  }

  if (url.pathname === "/v1/admin/onboarding/validate" && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const startedAt = Date.now();
    const [contactGrantContract, opportunityGrantContract] = await Promise.all([
      memberContactGrantContract(env, workspaceId),
      memberOpportunityGrantContract(env, workspaceId),
    ]);
    const [pipeline, approved, rejected, automationRun, inboundDelivery, outboundDelivery, accessPolicyRows,
      agentPolicy, activeAutomations, webhookIntegrity, safetyIndexes] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) total FROM pipelines WHERE workspace_id=?").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) total FROM agent_proposals WHERE workspace_id=? AND status='approved'").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) total FROM agent_proposals WHERE workspace_id=? AND status='rejected'").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) total FROM automation_runs WHERE workspace_id=? AND status='succeeded'").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) total FROM webhook_deliveries WHERE workspace_id=? AND direction='inbound' AND status='succeeded'").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) total FROM webhook_deliveries WHERE workspace_id=? AND direction='outbound' AND status='succeeded'").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare(`SELECT p.current_revision,g.resource,g.action,g.field_name
        FROM workspace_access_policies p
        LEFT JOIN workspace_role_grants g
          ON g.workspace_id=p.workspace_id AND g.revision=p.current_revision
          AND g.role='member' AND g.resource IN ('contact','opportunity')
        WHERE p.workspace_id=? ORDER BY g.resource,g.action,g.field_name`)
        .bind(workspaceId).all<{
          current_revision: number; resource: string | null; action: string | null; field_name: string | null;
        }>(),
      env.DB.prepare(`SELECT mode,require_approval,max_proposals_per_run FROM agent_policies
        WHERE workspace_id=?`).bind(workspaceId).first<{
          mode: string; require_approval: number; max_proposals_per_run: number;
        }>(),
      env.DB.prepare(`SELECT COUNT(*) total FROM automation_rules
        WHERE workspace_id=? AND status='active'`).bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN active=1 AND (secret_hash IS NULL OR secret_hash='') THEN 1 ELSE 0 END) unsafe
        FROM webhook_endpoints WHERE workspace_id=?`).bind(workspaceId).first<{
          total: number; active: number; unsafe: number;
        }>(),
      env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN (
        'automation_runs_event_unique','automation_runs_retry_once_unique','webhook_delivery_event_unique'
      )`).all<{ name: string }>(),
    ]);
    const currentPolicyRevision = accessPolicyRows.results[0]?.current_revision || null;
    const currentPolicyGrants = accessPolicyRows.results.filter((row) => row.resource && row.action).map((row) => ({
      resource: String(row.resource),
      grant: row.field_name ? `${row.action}:${row.field_name}` : String(row.action),
    }));
    const allowedPolicyGrants = new Map<string, Set<string>>([
      ["contact", new Set(contactGrantContract.allowedGrants)],
      ["opportunity", new Set(opportunityGrantContract.allowedGrants)],
    ]);
    const contactPolicyGrants = currentPolicyGrants.filter((row) => row.resource === "contact").map((row) => row.grant);
    const opportunityPolicyGrants = currentPolicyGrants.filter((row) => row.resource === "opportunity").map((row) => row.grant);
    const unsupportedPolicyGrants = currentPolicyGrants.filter((row) =>
      !allowedPolicyGrants.get(row.resource)?.has(row.grant));
    const policyDependenciesValid =
      (!contactPolicyGrants.some((grant) =>
        grant.startsWith("update_field:") || grant.startsWith("update_custom_field:")) ||
        contactPolicyGrants.includes("update")) &&
      (!opportunityPolicyGrants.some((grant) =>
        grant === "create" || grant === "update" || grant.startsWith("update_field:") ||
        grant.startsWith("update_custom_field:")) ||
        opportunityPolicyGrants.includes("read")) &&
      (!opportunityPolicyGrants.some((grant) =>
        grant.startsWith("update_field:") || grant.startsWith("update_custom_field:")) ||
        opportunityPolicyGrants.includes("update"));
    const accessPolicyHealthy = Boolean(currentPolicyRevision && currentPolicyRevision >= 1 &&
      unsupportedPolicyGrants.length === 0 && policyDependenciesValid);
    const safetyIndexNames = new Set(safetyIndexes.results.map((row) => row.name));
    const automationSafetyHealthy = safetyIndexNames.has("automation_runs_event_unique") &&
      safetyIndexNames.has("automation_runs_retry_once_unique");
    const webhookSafetyHealthy = safetyIndexNames.has("webhook_delivery_event_unique") &&
      Number(webhookIntegrity?.unsafe || 0) === 0;
    const agentApprovalHealthy = Boolean(agentPolicy?.require_approval === 1 &&
      agentPolicy.max_proposals_per_run >= 1 && agentPolicy.max_proposals_per_run <= 100);
    const loadStatements = Array.from({ length: 25 }, () =>
      env.DB.prepare("SELECT COUNT(*) total FROM contacts WHERE workspace_id=?").bind(workspaceId));
    const loadResults = await env.DB.batch(loadStatements);
    const elapsedMs = Date.now() - startedAt;
    const results: Record<string, { label: string; status: "passed" | "failed"; details: string }> = {
      identity_access: {
        label: "Owner identity and access policy",
        status: accessPolicyHealthy ? "passed" : "failed",
        details: currentPolicyRevision
          ? `Authenticated ${access.role}; access policy revision ${currentPolicyRevision} has ${currentPolicyGrants.length} supported member CRM grant(s)${accessPolicyHealthy ? "" : ` and ${unsupportedPolicyGrants.length || "dependency"} policy error(s)`}`
          : `Authenticated ${access.role}; workspace access policy is missing`,
      },
      pipeline_configured: {
        label: "At least one sales pipeline",
        status: (pipeline?.total || 0) > 0 ? "passed" : "failed",
        details: `${pipeline?.total || 0} pipeline(s) configured`,
      },
      agent_approval: {
        label: "Human approval policy",
        status: agentApprovalHealthy ? "passed" : "failed",
        details: agentApprovalHealthy
          ? `Approval required in ${agentPolicy?.mode || "configured"} mode with a ${agentPolicy?.max_proposals_per_run} proposal cap; historical evidence: ${approved?.total || 0} approved, ${rejected?.total || 0} rejected`
          : "Agent approval policy is missing, disabled, or has an unsafe proposal cap",
      },
      automation_safety: {
        label: "Automation idempotency and retry contract",
        status: automationSafetyHealthy ? "passed" : "failed",
        details: automationSafetyHealthy
          ? `Event deduplication and one-retry guards are present; ${activeAutomations?.total || 0} active workflow(s), ${automationRun?.total || 0} successful run(s) retained`
          : "One or more required automation uniqueness guards are missing",
      },
      webhook_security: {
        label: "Webhook secret and replay contract",
        status: webhookSafetyHealthy ? "passed" : "failed",
        details: webhookSafetyHealthy
          ? `Replay uniqueness and endpoint secret storage are intact; ${webhookIntegrity?.active || 0} active endpoint(s), ${inboundDelivery?.total || 0} inbound and ${outboundDelivery?.total || 0} outbound success record(s) retained`
          : "Webhook replay uniqueness is missing or an active endpoint has no stored secret hash",
      },
      load_test: {
        label: "Concurrency and load test",
        status: loadResults.length === 25 ? "passed" : "failed",
        details: `${loadResults.length}/25 concurrent database checks completed in ${elapsedMs}ms`,
      },
    };
    const checkedAt = new Date().toISOString();
    await env.DB.batch(Object.entries(results).map(([key, result]) => env.DB.prepare(
      "UPDATE onboarding_checks SET label=?,status=?,details=?,checked_at=? WHERE workspace_id=? AND check_key=?",
    ).bind(result.label, result.status, result.details, checkedAt, workspaceId, key)));
    await audit(env, access, request, "onboarding.validated", "workspace", workspaceId, null, results);
    return json({ ok: true, checks: results });
  }

  if (url.pathname === "/v1/platform/workspaces" && request.method === "POST") {
    if (workspaceId !== "ws_openoperator" || access.role !== "owner") return json({ error: "Platform owner required" }, 403);
    const body = await readJson(request);
    const name = optionalString(body.name, "name", 120);
    const ownerEmail = normalizeEmail(body.owner_email);
    const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    if (!name || !ownerEmail || !slug || slug.length > 80) return json({ error: "name, slug, and owner_email are required" }, 400);
    const provisionedWorkspaceId = id("ws");
    const pipelineId = id("pipe");
    const accessPolicyChangeId = id("policy");
    const now = new Date().toISOString();
    const stageDefinitions = [
      ["New lead", 0, 10, "open", "#827b70"],
      ["Qualified", 1, 25, "open", "#d7a938"],
      ["Call booked", 2, 45, "open", "#5f8dd3"],
      ["Proposal sent", 3, 70, "open", "#8a63d2"],
      ["Won", 4, 100, "won", "#39a968"],
      ["Lost", 5, 0, "lost", "#bd4b43"],
    ] as const;
    const statements = [
      env.DB.prepare(`INSERT INTO workspaces(id,slug,name,status,settings,onboarding_status,created_at,updated_at)
        VALUES(?,?,?,'active','{}','draft',?,?)`).bind(provisionedWorkspaceId, slug, name, now, now),
      env.DB.prepare(`INSERT INTO workspace_members(id,workspace_id,email,role,active,created_at)
        VALUES(?,?,?,'owner',1,?)`).bind(id("mem"), provisionedWorkspaceId, ownerEmail, now),
      env.DB.prepare(`INSERT INTO workspace_access_policies
        (workspace_id,current_revision,current_change_id,updated_by,updated_at)
        VALUES(?,1,?,?,?)`).bind(provisionedWorkspaceId, accessPolicyChangeId, access.email, now),
      env.DB.prepare(`INSERT INTO workspace_access_policy_versions(workspace_id,revision,change_id,created_by,created_at)
        VALUES(?,1,?,?,?)`).bind(provisionedWorkspaceId, accessPolicyChangeId, access.email, now),
      ...baseMemberContactGrantKeys.map((grant) => {
        const [action, fieldName = ""] = grant.split(":");
        return env.DB.prepare(`INSERT INTO workspace_role_grants
          (id,workspace_id,revision,role,resource,action,field_name,created_at)
          VALUES(?,?,1,'member','contact',?,?,?)`)
          .bind(id("grant"), provisionedWorkspaceId, action, fieldName, now);
      }),
      ...baseMemberOpportunityGrantKeys.map((grant) => {
        const [action, fieldName = ""] = grant.split(":");
        return env.DB.prepare(`INSERT INTO workspace_role_grants
          (id,workspace_id,revision,role,resource,action,field_name,created_at)
          VALUES(?,?,1,'member','opportunity',?,?,?)`)
          .bind(id("grant"), provisionedWorkspaceId, action, fieldName, now);
      }),
      env.DB.prepare(`INSERT INTO pipelines(id,workspace_id,name,object_type,active,created_at,updated_at)
        VALUES(?,?,?,'opportunity',1,?,?)`).bind(pipelineId, provisionedWorkspaceId, `${name} Sales`, now, now),
      env.DB.prepare(`INSERT INTO agent_policies
        (id,workspace_id,mode,require_approval,max_proposals_per_run,stale_after_days,high_value_threshold,
          agent_access_enabled,workspace_rate_limit_per_minute,created_at,updated_at)
        VALUES(?,?,'copilot',1,25,7,5000,1,120,?,?)`)
        .bind(id("policy"), provisionedWorkspaceId, now, now),
      ...stageDefinitions.map(([stageName, position, probability, category, color]) =>
        env.DB.prepare(`INSERT INTO pipeline_stages(id,workspace_id,pipeline_id,name,position,probability,category,color,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).bind(id("stage"), provisionedWorkspaceId, pipelineId, stageName, position, probability, category, color, now)),
      ...[
        ["identity_access", "Owner identity and access policy"],
        ["pipeline_configured", "At least one sales pipeline"],
        ["webhook_security", "Webhook secret and replay contract"],
        ["automation_safety", "Automation idempotency and retry contract"],
        ["agent_approval", "Human approval policy"],
        ["load_test", "Concurrency and load test"],
      ].map(([checkKey, label], position) =>
        env.DB.prepare(`INSERT INTO onboarding_checks(id,workspace_id,check_key,label,status,details,created_at)
          VALUES(?,?,?,?,?,'{}',?)`).bind(id("check"), provisionedWorkspaceId, checkKey, label, position < 2 ? "passed" : "pending", now)),
    ];
    try {
      await env.DB.batch(statements);
    } catch {
      return json({ error: "A workspace with that slug may already exist" }, 409);
    }
    await audit(env, access, request, "workspace.provisioned", "workspace", provisionedWorkspaceId, null, {
      slug, name, owner_email: ownerEmail, pipeline_id: pipelineId,
    });
    return json({ ok: true, workspace: { id: provisionedWorkspaceId, slug, name, owner_email: ownerEmail, pipeline_id: pipelineId } }, 201);
  }

  if (url.pathname === "/v1/admin/dashboard" && request.method === "GET") {
    const [contactCount, customerCount, revenue, followUps, stageRows, contactRows] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) total FROM contacts WHERE workspace_id=?").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) total FROM contacts WHERE workspace_id=? AND status='customer'").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COALESCE(SUM(value),0) total FROM deals WHERE workspace_id=? AND stage IN ('paid','won')").bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare("SELECT COUNT(*) total FROM tasks WHERE workspace_id=? AND status='open' AND due_at IS NOT NULL AND due_at <= ?")
        .bind(workspaceId, new Date().toISOString()).first<{ total: number }>(),
      env.DB.prepare("SELECT stage,COUNT(*) total FROM contacts WHERE workspace_id=? GROUP BY stage").bind(workspaceId).all<{ stage: string; total: number }>(),
      env.DB.prepare(`SELECT c.*,COALESCE(SUM(CASE WHEN d.stage IN ('paid','won') THEN d.value ELSE 0 END),0) revenue
        FROM contacts c LEFT JOIN deals d ON d.contact_id=c.id AND d.workspace_id=c.workspace_id
        WHERE c.workspace_id=? GROUP BY c.id ORDER BY COALESCE(c.last_activity_at,c.created_at) DESC LIMIT 500`).bind(workspaceId).all(),
    ]);
    const stages = Object.fromEntries(stageRows.results.map((row: { stage: string; total: number }) => [row.stage, row.total]));
    const readableContactFields = await readableContactCustomFieldKeys(env, access);
    return json({
      metrics: { contacts: contactCount?.total || 0, customers: customerCount?.total || 0, revenue: revenue?.total || 0, followUps: followUps?.total || 0 },
      stages,
      contacts: contactRows.results.map((contact) =>
        redactContactCustomFields(contact as Record<string, unknown>, readableContactFields)),
    });
  }

  if (url.pathname === "/v1/admin/calendar" && request.method === "GET") {
    const canReadOpportunities = await hasWorkspaceGrant(env, access, "opportunity", "read");
    const startRaw = url.searchParams.get("start") || "";
    const endRaw = url.searchParams.get("end") || "";
    const startMs = Date.parse(startRaw);
    const endMs = Date.parse(endRaw);
    const maximumRangeMs = 93 * 24 * 60 * 60 * 1000;
    if (!startRaw || !endRaw || startRaw.length > 40 || endRaw.length > 40 ||
      !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
      endMs <= startMs || endMs - startMs > maximumRangeMs) {
      return json({ error: "Calendar range must be a valid interval of 93 days or fewer" }, 400);
    }
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const perKindLimit = 201;
    const [taskRows, followUpRows, opportunityRows] = await Promise.all([
      env.DB.prepare(`SELECT t.id,t.contact_id,t.opportunity_id,t.title,t.status,t.priority,t.assignee,
          t.due_at starts_at,c.email contact_email,o.name opportunity_name
        FROM tasks t
        LEFT JOIN contacts c ON c.workspace_id=t.workspace_id AND c.id=t.contact_id
        LEFT JOIN opportunities o ON o.workspace_id=t.workspace_id AND o.id=t.opportunity_id
        WHERE t.workspace_id=? AND t.status='open' AND t.due_at>=? AND t.due_at<?
        ORDER BY t.due_at,t.id LIMIT ?`)
        .bind(workspaceId, start, end, perKindLimit).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT id,email,first_name,last_name,company,status,stage,owner,
          next_follow_up_at starts_at
        FROM contacts
        WHERE workspace_id=? AND next_follow_up_at>=? AND next_follow_up_at<?
        ORDER BY next_follow_up_at,id LIMIT ?`)
        .bind(workspaceId, start, end, perKindLimit).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT o.id,o.contact_id,o.name,o.status,o.value,o.currency,o.probability,o.owner,
          o.expected_close_at starts_at,c.email contact_email,c.first_name,c.last_name,c.company
        FROM opportunities o
        JOIN contacts c ON c.workspace_id=o.workspace_id AND c.id=o.contact_id
        WHERE o.workspace_id=? AND o.status='open' AND o.expected_close_at>=? AND o.expected_close_at<?
        ORDER BY o.expected_close_at,o.id LIMIT ?`)
        .bind(workspaceId, start, end, perKindLimit).all<Record<string, unknown>>(),
    ]);
    const visibleTaskRows = canReadOpportunities
      ? taskRows.results
      : taskRows.results.filter((row) => !row.opportunity_id);
    const tasks = visibleTaskRows.slice(0, 200).map((row) => ({
      id: `task:${row.id}`, kind: "task", record_id: row.id, contact_id: row.contact_id,
      opportunity_id: row.opportunity_id, title: row.title, starts_at: row.starts_at,
      status: row.status, priority: row.priority, owner: row.assignee,
      subtitle: row.opportunity_name || row.contact_email || "Unlinked task",
    }));
    const followUps = followUpRows.results.slice(0, 200).map((row) => {
      const person = [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email;
      return {
        id: `contact_follow_up:${row.id}`, kind: "contact_follow_up", record_id: row.id,
        contact_id: row.id, opportunity_id: null, title: `Follow up with ${person}`,
        starts_at: row.starts_at, status: row.status, priority: null, owner: row.owner,
        subtitle: row.company || row.email,
      };
    });
    const closes = (canReadOpportunities ? opportunityRows.results : []).slice(0, 200).map((row) => ({
      id: `opportunity_close:${row.id}`, kind: "opportunity_close", record_id: row.id,
      contact_id: row.contact_id, opportunity_id: row.id, title: row.name,
      starts_at: row.starts_at, status: row.status, priority: null, owner: row.owner,
      subtitle: `${row.currency} ${Number(row.value || 0).toLocaleString("en-US")} · ${row.probability}%`,
    }));
    const combined = [...tasks, ...followUps, ...closes]
      .sort((left, right) => String(left.starts_at).localeCompare(String(right.starts_at)) ||
        left.id.localeCompare(right.id));
    return json({
      range: { start, end, maximum_days: 93 },
      events: combined.slice(0, 500),
      counts: { tasks: tasks.length, follow_ups: followUps.length, opportunity_closes: closes.length },
      limits: { per_kind: 200, total: 500 },
      truncated: {
        tasks: visibleTaskRows.length > 200,
        follow_ups: followUpRows.results.length > 200,
        opportunity_closes: canReadOpportunities && opportunityRows.results.length > 200,
        total: combined.length > 500,
      },
      trust: { workspace_scoped: true, record_content_trusted: false, read_only: true },
    });
  }

  if (url.pathname === "/v1/admin/search" && request.method === "GET") {
    const canReadOpportunities = await hasWorkspaceGrant(env, access, "opportunity", "read");
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 100) {
      return json({ error: "Search queries must contain between 2 and 100 characters" }, 400);
    }
    const tokens = [...new Set((query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .map((token) => token.slice(0, 32)).filter(Boolean))].slice(0, 8);
    const matchQuery = tokens.map((token) => `"${token}"*`).join(" AND ");
    const emptyResult = {
      query,
      groups: { contacts: [], companies: [], opportunities: [] },
      returned: 0,
      limits: { per_group: 6, total: 18 },
      trust: { record_content_trusted: false, read_only: true, workspace_scoped: true },
      index: { strategy: "fts5_prefix", tokens: tokens.length, freshness: "transactional_triggers" },
    };
    if (!matchQuery) return json(emptyResult);
    const [contacts, companies, opportunities] = await Promise.all([
      env.DB.prepare(`WITH matched AS (
          SELECT record_id,bm25(crm_search_index,0,0,0,8,4,1) rank
          FROM crm_search_index
          WHERE crm_search_index MATCH ? AND workspace_id=? AND object_type='contact'
          ORDER BY rank,record_id LIMIT 6
        )
        SELECT c.id,c.email,c.first_name,c.last_name,c.company,c.stage,c.status,c.source_last,
          c.owner,c.next_follow_up_at,c.last_activity_at,c.created_at,c.updated_at,c.score,0 revenue
        FROM matched m JOIN contacts c ON c.workspace_id=? AND c.id=m.record_id
        ORDER BY m.rank,c.id`)
        .bind(matchQuery, workspaceId, workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`WITH matched AS (
          SELECT record_id,bm25(crm_search_index,0,0,0,8,4,1) rank
          FROM crm_search_index
          WHERE crm_search_index MATCH ? AND workspace_id=? AND object_type='company'
          ORDER BY rank,record_id LIMIT 6
        )
        SELECT co.id,co.name,co.domain,co.website,co.industry,co.owner,co.updated_at,
          (SELECT COUNT(*) FROM contacts c WHERE c.workspace_id=co.workspace_id AND c.company_id=co.id) contacts,
          (SELECT COUNT(*) FROM contacts c WHERE c.workspace_id=co.workspace_id AND c.company_id=co.id AND c.status='lead') leads,
          0 revenue,
          COALESCE((SELECT SUM(o.value) FROM opportunities o JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
            WHERE c.company_id=co.id AND o.workspace_id=co.workspace_id AND o.status='open'),0) open_pipeline,
          (SELECT MAX(c.last_activity_at) FROM contacts c WHERE c.workspace_id=co.workspace_id AND c.company_id=co.id) last_activity_at
        FROM matched m JOIN companies co ON co.workspace_id=? AND co.id=m.record_id
        ORDER BY m.rank,co.id`)
        .bind(matchQuery, workspaceId, workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`WITH matched AS (
          SELECT record_id,bm25(crm_search_index,0,0,0,8,4,1) rank
          FROM crm_search_index
          WHERE crm_search_index MATCH ? AND workspace_id=? AND object_type='opportunity'
          ORDER BY rank,record_id LIMIT 6
        )
        SELECT o.id,o.pipeline_id,o.stage_id,o.contact_id,o.name,o.status,o.value,o.currency,
          o.probability,o.next_step,o.expected_close_at,o.owner,o.last_activity_at,o.created_at,o.updated_at,
          c.email,c.first_name,c.last_name,c.company,s.name stage_name,s.color stage_color
        FROM matched m JOIN opportunities o ON o.workspace_id=? AND o.id=m.record_id
        JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
        JOIN pipeline_stages s ON s.id=o.stage_id AND s.workspace_id=o.workspace_id
        ORDER BY m.rank,o.id`)
        .bind(matchQuery, workspaceId, workspaceId).all<Record<string, unknown>>(),
    ]);
    return json({
      query,
      groups: {
        contacts: contacts.results,
        companies: canReadOpportunities ? companies.results : companies.results.map((company) => ({
          ...company, revenue: 0, open_pipeline: 0,
        })),
        opportunities: canReadOpportunities ? opportunities.results : [],
      },
      returned: contacts.results.length + companies.results.length +
        (canReadOpportunities ? opportunities.results.length : 0),
      limits: { per_group: 6, total: 18 },
      trust: { record_content_trusted: false, read_only: true, workspace_scoped: true },
      index: { strategy: "fts5_prefix", tokens: tokens.length, freshness: "transactional_triggers" },
    });
  }

  if (url.pathname === "/v1/admin/contacts" && request.method === "GET") {
    const page = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "50");
    if (!Number.isInteger(page) || page < 1 || page > 100_000 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return json({ error: "page and limit are outside the supported range" }, 400);
    }
    const query = (url.searchParams.get("query") || "").trim();
    const stage = (url.searchParams.get("stage") || "").trim();
    const status = (url.searchParams.get("status") || "").trim();
    const owner = (url.searchParams.get("owner") || "").trim();
    const source = (url.searchParams.get("source") || "").trim();
    const attention = url.searchParams.get("attention") === "1";
    const view = (url.searchParams.get("view") || "contacts").trim();
    const sort = (url.searchParams.get("sort") || "recent").trim();
    const direction = (url.searchParams.get("direction") || "desc").trim();
    const rawCustomFilters = url.searchParams.get("custom_filters");
    if (query.length > 200 || owner.length > 254 || source.length > 120) return json({ error: "A contact filter is too long" }, 400);
    if (rawCustomFilters && rawCustomFilters.length > 4000) return json({ error: "Custom filters are too large" }, 400);
    if (stage && !allowedStages.has(stage)) return json({ error: "Invalid stage" }, 400);
    if (status && !allowedStatuses.has(status)) return json({ error: "Invalid status" }, 400);
    if (!["contacts", "inbox"].includes(view)) return json({ error: "Invalid contact view" }, 400);
    if (!["recent", "name", "company", "score", "follow_up"].includes(sort) || !["asc", "desc"].includes(direction)) {
      return json({ error: "Invalid contact sort" }, 400);
    }

    const [contactDefinitions, readableContactFields] = await Promise.all([
      env.DB.prepare(`SELECT * FROM custom_field_definitions
        WHERE workspace_id=? AND object_type='contact' AND active=1 ORDER BY position,id`)
        .bind(workspaceId).all<CustomFieldDefinition>(),
      readableContactCustomFieldKeys(env, access),
    ]);
    let customFilters: ContactCustomFilter[] = [];
    if (rawCustomFilters) {
      try { customFilters = validateContactCustomFilters(JSON.parse(rawCustomFilters), contactDefinitions.results, readableContactFields); }
      catch (error) {
        return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Custom filters are invalid" }, 400);
      }
    }
    const conditions = ["c.workspace_id=?"];
    const bindings: unknown[] = [workspaceId];
    if (view === "inbox") {
      conditions.push("c.status='lead'");
      conditions.push("NOT EXISTS(SELECT 1 FROM opportunities o WHERE o.workspace_id=c.workspace_id AND o.contact_id=c.id)");
    } else if (status) {
      conditions.push("c.status=?"); bindings.push(status);
    }
    if (stage) { conditions.push("c.stage=?"); bindings.push(stage); }
    if (owner === "__unassigned__") conditions.push("(c.owner IS NULL OR c.owner='')");
    else if (owner) { conditions.push("c.owner=?"); bindings.push(owner); }
    if (source === "__direct__") conditions.push("(c.source_last IS NULL OR c.source_last='')");
    else if (source) { conditions.push("c.source_last=?"); bindings.push(source); }
    if (query) {
      const escaped = query.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      conditions.push(`LOWER(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'') || ' ' ||
        c.email || ' ' || COALESCE(c.company,'') || ' ' || COALESCE(c.source_last,'')) LIKE ? ESCAPE '\\'`);
      bindings.push(`%${escaped}%`);
    }
    if (attention) {
      conditions.push(`(c.next_follow_up_at<=? OR (c.next_follow_up_at IS NULL AND
        (c.last_activity_at IS NULL OR c.last_activity_at<?)))`);
      bindings.push(new Date().toISOString(), new Date(Date.now() - 7 * 86_400_000).toISOString());
    }
    for (const filter of customFilters) {
      const path = `$."${filter.field_key}"`;
      const customJson = "(CASE WHEN json_valid(c.custom_fields) THEN c.custom_fields ELSE '{}' END)";
      if (filter.operator === "is_empty") {
        conditions.push(`COALESCE(json_type(${customJson}, ?),'null')='null'`); bindings.push(path);
      } else if (filter.operator === "contains") {
        const escaped = String(filter.value).toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
        conditions.push(`LOWER(CAST(json_extract(${customJson}, ?) AS TEXT)) LIKE ? ESCAPE '\\'`);
        bindings.push(path, `%${escaped}%`);
      } else if (filter.operator === "gte" || filter.operator === "lte") {
        conditions.push(`json_type(${customJson}, ?) IN ('integer','real') AND
          CAST(json_extract(${customJson}, ?) AS REAL) ${filter.operator === "gte" ? ">=" : "<="} ?`);
        bindings.push(path, path, filter.value);
      } else if (filter.operator === "before" || filter.operator === "after") {
        conditions.push(`json_type(${customJson}, ?)='text' AND
          CAST(json_extract(${customJson}, ?) AS TEXT) ${filter.operator === "before" ? "<" : ">"} ?`);
        bindings.push(path, path, filter.value);
      } else {
        conditions.push(`json_extract(${customJson}, ?) = ?`); bindings.push(path, filter.value);
      }
    }
    const where = conditions.join(" AND ");
    const sortExpressions: Record<string, string> = {
      recent: "COALESCE(c.last_activity_at,c.created_at)",
      name: "LOWER(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'') || ' ' || c.email)",
      company: "LOWER(COALESCE(c.company,''))",
      score: "c.score",
      follow_up: "COALESCE(c.next_follow_up_at,'9999-12-31T23:59:59.999Z')",
    };
    const offset = (page - 1) * limit;
    const [countRow, rows, owners, sources] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) total FROM contacts c WHERE ${where}`).bind(...bindings).first<{ total: number }>(),
      env.DB.prepare(`SELECT c.*,COALESCE(SUM(CASE WHEN d.stage IN ('paid','won') THEN d.value ELSE 0 END),0) revenue
        FROM contacts c LEFT JOIN deals d ON d.contact_id=c.id AND d.workspace_id=c.workspace_id
        WHERE ${where} GROUP BY c.id
        ORDER BY ${sortExpressions[sort]} ${direction.toUpperCase()},c.id ASC LIMIT ? OFFSET ?`)
        .bind(...bindings, limit, offset).all(),
      env.DB.prepare(`SELECT owner,COUNT(*) total FROM contacts
        WHERE workspace_id=? AND owner IS NOT NULL AND owner<>'' GROUP BY owner ORDER BY owner LIMIT 200`)
        .bind(workspaceId).all(),
      env.DB.prepare(`SELECT source_last source,COUNT(*) total FROM contacts
        WHERE workspace_id=? AND source_last IS NOT NULL AND source_last<>'' GROUP BY source_last ORDER BY source_last LIMIT 200`)
        .bind(workspaceId).all(),
    ]);
    const total = Number(countRow?.total || 0);
    return json({
      contacts: rows.results.map((contact) =>
        redactContactCustomFields(contact as Record<string, unknown>, readableContactFields)),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      facets: { owners: owners.results, sources: sources.results },
    });
  }

  if (url.pathname === "/v1/admin/contacts" && request.method === "POST") {
    const denied = await requireWorkspaceGrant(env, access, "contact", "create");
    if (denied) return denied;
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const firstName = optionalString(body.first_name, "first_name", 100);
    const lastName = optionalString(body.last_name, "last_name", 100);
    const company = optionalString(body.company, "company", 200);
    const phone = optionalString(body.phone, "phone", 50);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "A valid email is required" }, 400);
    const contactId = id("con");
    const now = new Date().toISOString();
    const companyRecord = company ? await companyIdentity(env, workspaceId, company, now) : null;
    try {
      await env.DB.batch([
        ...(companyRecord ? [insertCompanyStatement(env, workspaceId, companyRecord)] : []),
        env.DB.prepare(`INSERT INTO contacts
        (id,workspace_id,email,first_name,last_name,phone,company,company_id,status,stage,score,owner,source_first,source_last,
          tags,custom_fields,last_activity_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'lead','new',0,?,'manual','manual','[]','{}',?,?,?)`).bind(
          contactId, workspaceId, email, firstName, lastName, phone, companyRecord?.name || company, companyRecord?.id || null,
          optionalString(body.owner, "owner", 254), now, now, now,
        ),
      ]);
    } catch {
      return json({ error: "A contact with that email already exists" }, 409);
    }
    await audit(env, access, request, "contact.created", "contact", contactId, null, {
      email, first_name: firstName, last_name: lastName, company: companyRecord?.name || company, source: "manual",
    });
    const createdContact = await env.DB.prepare("SELECT * FROM contacts WHERE workspace_id=? AND id=?")
      .bind(workspaceId, contactId).first<Record<string, unknown>>();
    if (createdContact) await runContactAutomations(env, access, createdContact, requestId(request), "contact.created");
    return json({ ok: true, contact: { id: contactId, email } }, 201);
  }

  if (url.pathname === "/v1/admin/contacts/import/preview" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin access required" }, 403);
    const rows = await normalizeImportRows(env, workspaceId, await readJsonLimited(request, MAX_IMPORT_BYTES));
    const placeholders = rows.map(() => "?").join(",");
    const existing = await env.DB.prepare(`SELECT email FROM contacts
      WHERE workspace_id=? AND email IN (${placeholders})`)
      .bind(workspaceId, ...rows.map((row) => row.email)).all<{ email: string }>();
    const existingEmails = new Set(existing.results.map((row) => row.email));
    return json({
      ok: true,
      preview: {
        total: rows.length,
        ready: rows.filter((row) => !existingEmails.has(row.email)).length,
        skipped_existing: existingEmails.size,
        rows: rows.map((row) => ({ ...row, outcome: existingEmails.has(row.email) ? "skip_existing" : "create" })),
      },
    });
  }

  if (url.pathname === "/v1/admin/contacts/import/commit" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin access required" }, 403);
    const rows = await normalizeImportRows(env, workspaceId, await readJsonLimited(request, MAX_IMPORT_BYTES));
    const now = new Date().toISOString();
    const importId = id("import");
    const contactIds = rows.map(() => id("con"));
    const companyRecords = await Promise.all(rows.map((row) => row.company ? companyIdentity(env, workspaceId, row.company, now) : null));
    const uniqueCompanies = [...new Map(companyRecords.filter((item) => item !== null).map((item) => [item.id, item])).values()];
    const companyStatements = uniqueCompanies.map((company) => insertCompanyStatement(env, workspaceId, company));
    const contactStatements = rows.map((row, index) => env.DB.prepare(`INSERT INTO contacts
      (id,workspace_id,email,first_name,last_name,phone,company,company_id,status,stage,score,owner,source_first,source_last,
        tags,custom_fields,last_activity_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'lead','new',0,?,'csv_import','csv_import','[]',?,?,?,?)
      ON CONFLICT(workspace_id,email) DO NOTHING
      RETURNING id`)
      .bind(contactIds[index], workspaceId, row.email, row.first_name, row.last_name, row.phone, companyRecords[index]?.name || row.company, companyRecords[index]?.id || null,
        row.owner, row.custom_fields, now, now, now));
    const memberStatements = rows.map((row, index) => env.DB.prepare(`INSERT INTO contact_import_members
      (id,workspace_id,import_id,contact_id,email,imported_updated_at,outcome,created_at)
      SELECT ?,?,?,?,?,?,'created',?
      WHERE EXISTS (
        SELECT 1 FROM contacts WHERE workspace_id=? AND id=? AND created_at=? AND updated_at=?
      )`).bind(id("imem"), workspaceId, importId, contactIds[index], row.email, now, now,
        workspaceId, contactIds[index], now, now));
    const statements = [
      ...companyStatements,
      env.DB.prepare(`INSERT INTO contact_imports
        (id,workspace_id,status,requested_rows,imported_rows,skipped_rows,created_by,created_at)
        VALUES(?,?,'committed',?,0,0,?,?)`)
        .bind(importId, workspaceId, rows.length, access.email, now),
      ...contactStatements,
      ...memberStatements,
      env.DB.prepare(`UPDATE contact_imports SET
        imported_rows=(SELECT COUNT(*) FROM contact_import_members WHERE import_id=?),
        skipped_rows=requested_rows-(SELECT COUNT(*) FROM contact_import_members WHERE import_id=?)
        WHERE workspace_id=? AND id=?`).bind(importId, importId, workspaceId, importId),
    ];
    statements.push(await auditStatement(env, access, request, "contacts.imported", "contact_import", importId, null, {
      requested: rows.length, duplicate_policy: "skip_existing", source: "csv_import",
    }));
    await env.DB.batch(statements);
    const imported = await env.DB.prepare(`SELECT id,status,requested_rows,imported_rows,skipped_rows,
      rollback_deleted_rows,rollback_conflict_rows,rollback_missing_rows,created_by,created_at,rolled_back_by,rolled_back_at
      FROM contact_imports WHERE workspace_id=? AND id=?`).bind(workspaceId, importId).first<Record<string, unknown>>();
    return json({
      ok: true,
      import_id: importId,
      imported: Number(imported?.imported_rows || 0),
      skipped_existing: Number(imported?.skipped_rows || 0),
      import: imported,
    }, 201);
  }

  if (url.pathname === "/v1/admin/contact-imports" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin access required" }, 403);
    const imports = await env.DB.prepare(`SELECT i.id,i.status,i.requested_rows,i.imported_rows,i.skipped_rows,
      i.rollback_deleted_rows,i.rollback_conflict_rows,i.rollback_missing_rows,i.created_by,i.created_at,
      i.rolled_back_by,i.rolled_back_at,
      CASE WHEN i.status='committed' THEN (
        SELECT COUNT(*) FROM contact_import_members m
        JOIN contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
        WHERE m.workspace_id=i.workspace_id AND m.import_id=i.id AND m.outcome='created'
          AND c.updated_at=m.imported_updated_at AND c.source_first='csv_import' AND c.source_last='csv_import'
          AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.workspace_id=i.workspace_id AND a.contact_id=c.id)
          AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.workspace_id=i.workspace_id AND d.contact_id=c.id)
          AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.workspace_id=i.workspace_id AND n.contact_id=c.id)
          AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.workspace_id=i.workspace_id AND o.contact_id=c.id)
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id=i.workspace_id AND t.contact_id=c.id)
          AND NOT EXISTS (SELECT 1 FROM visitor_profiles v WHERE v.workspace_id=i.workspace_id AND v.matched_contact_id=c.id)
      ) ELSE 0 END rollback_ready_rows,
      CASE WHEN i.status='committed' THEN (
        SELECT COUNT(*) FROM contact_import_members m
        JOIN contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
        WHERE m.workspace_id=i.workspace_id AND m.import_id=i.id AND m.outcome='created'
          AND (
            c.updated_at<>m.imported_updated_at OR c.source_first<>'csv_import' OR c.source_last<>'csv_import'
            OR EXISTS (SELECT 1 FROM activities a WHERE a.workspace_id=i.workspace_id AND a.contact_id=c.id)
            OR EXISTS (SELECT 1 FROM deals d WHERE d.workspace_id=i.workspace_id AND d.contact_id=c.id)
            OR EXISTS (SELECT 1 FROM notes n WHERE n.workspace_id=i.workspace_id AND n.contact_id=c.id)
            OR EXISTS (SELECT 1 FROM opportunities o WHERE o.workspace_id=i.workspace_id AND o.contact_id=c.id)
            OR EXISTS (SELECT 1 FROM tasks t WHERE t.workspace_id=i.workspace_id AND t.contact_id=c.id)
            OR EXISTS (SELECT 1 FROM visitor_profiles v WHERE v.workspace_id=i.workspace_id AND v.matched_contact_id=c.id)
          )
      ) ELSE 0 END rollback_conflicts_now,
      CASE WHEN i.status='committed' THEN (
        SELECT COUNT(*) FROM contact_import_members m
        WHERE m.workspace_id=i.workspace_id AND m.import_id=i.id AND m.outcome='created'
          AND NOT EXISTS (
            SELECT 1 FROM contacts c WHERE c.workspace_id=m.workspace_id AND c.id=m.contact_id
          )
      ) ELSE 0 END rollback_missing_now
      FROM contact_imports i WHERE i.workspace_id=?
      ORDER BY i.created_at DESC,i.id DESC LIMIT 50`).bind(workspaceId).all();
    return json({ imports: imports.results, limit: 50 });
  }

  const contactImportRollbackMatch = url.pathname.match(
    /^\/v1\/admin\/contact-imports\/(import_[a-f0-9]{32})\/rollback$/,
  );
  if (contactImportRollbackMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin access required" }, 403);
    const body = await readJsonLimited(request, 4096);
    const importId = contactImportRollbackMatch[1];
    if (body.confirmation !== importId) {
      return json({ error: "Type the exact import ID to confirm rollback", code: "confirmation_required" }, 400);
    }
    const current = await env.DB.prepare(`SELECT id,status,created_at FROM contact_imports
      WHERE workspace_id=? AND id=?`).bind(workspaceId, importId)
      .first<{ id: string; status: string; created_at: string }>();
    if (!current) return json({ error: "Contact import not found" }, 404);
    if (current.status !== "committed") {
      return json({ error: "This import was already rolled back", code: "already_rolled_back" }, 409);
    }
    if (body.expected_created_at !== current.created_at) {
      return json({ error: "Import history changed; reload before rollback", code: "edit_conflict" }, 409);
    }
    const rolledBackAt = new Date().toISOString();
    const result = await env.DB.prepare(`UPDATE contact_imports SET status='rolled_back',
      rolled_back_by=?,rolled_back_at=?,rollback_request_id=?,rollback_audit_id=?
      WHERE workspace_id=? AND id=? AND status='committed' AND created_at=? RETURNING id`)
      .bind(access.email, rolledBackAt, requestId(request), id("audit"), workspaceId, importId, current.created_at).first();
    if (!result) return json({ error: "This import was already rolled back", code: "already_rolled_back" }, 409);
    const rolledBack = await env.DB.prepare(`SELECT id,status,requested_rows,imported_rows,skipped_rows,
      rollback_deleted_rows,rollback_conflict_rows,rollback_missing_rows,created_by,created_at,rolled_back_by,rolled_back_at
      FROM contact_imports WHERE workspace_id=? AND id=?`).bind(workspaceId, importId).first();
    return json({ ok: true, import: rolledBack });
  }

  if (url.pathname === "/v1/admin/audience-imports" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin access required" }, 403);
    const rows = await env.DB.prepare(`SELECT ai.id,ai.connector_id,ai.provider,ai.external_key,ai.list_name,ai.mode,
      ai.consent_basis,ai.tags,ai.requested_rows,ai.created_profiles,ai.updated_profiles,ai.repeated_rows,
      ai.created_by,ai.created_at,vc.name connector_name
      FROM audience_imports ai JOIN visitor_connectors vc ON vc.workspace_id=ai.workspace_id AND vc.id=ai.connector_id
      WHERE ai.workspace_id=? ORDER BY ai.created_at DESC,ai.id DESC LIMIT 100`)
      .bind(workspaceId).all();
    return json({ imports: rows.results, limit: 100 });
  }

  if (url.pathname === "/v1/admin/audience-imports/preview" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin access required" }, 403);
    const normalized = normalizeAudienceImport(await readJsonLimited(request, MAX_IMPORT_BYTES));
    const connector = await env.DB.prepare(`SELECT id,provider,name,active,consent_default FROM visitor_connectors
      WHERE workspace_id=? AND id=?`).bind(workspaceId, normalized.connectorId)
      .first<{ id: string; provider: string; name: string; active: number; consent_default: string }>();
    if (!connector || connector.provider !== "audiencelab") return json({ error: "AudienceLab connector not found" }, 404);
    if (!connector.active) return json({ error: "AudienceLab connector is revoked" }, 409);
    const rows = await Promise.all(normalized.rows.map(async (row) => {
      const kind = row.email || row.linkedinUrl ? "person" : "company";
      const seed = row.linkedinUrl?.toLowerCase() || row.email || row.companyDomain;
      const identityKey = await sha256(`audiencelab\n${kind}\n${seed}`);
      const existing = await env.DB.prepare(`SELECT id,review_status,consent_status FROM visitor_profiles
        WHERE workspace_id=? AND connector_id=? AND identity_key=?`)
        .bind(workspaceId, connector.id, identityKey).first<Record<string, unknown>>();
      return {
        identity_kind: kind,
        identity_hint: row.email ? row.email.replace(/^(.{2}).*(@.*)$/, "$1…$2") : row.companyDomain,
        company_domain: row.companyDomain,
        consent_status: row.consentStatus,
        outcome: existing ? "update_quarantine" : "create_quarantine",
        existing_review_status: existing?.review_status || null,
      };
    }));
    return json({
      ok: true,
      preview: {
        connector: { id: connector.id, name: connector.name, provider: connector.provider },
        external_key: normalized.externalKey,
        list_name: normalized.listName,
        mode: normalized.mode,
        consent_basis: normalized.consentBasis,
        tags: normalized.tags,
        total: rows.length,
        create_quarantine: rows.filter((row) => row.outcome === "create_quarantine").length,
        update_quarantine: rows.filter((row) => row.outcome === "update_quarantine").length,
        contacts_created: 0,
        outreach_authorized: false,
        rows,
      },
    });
  }

  if (url.pathname === "/v1/admin/audience-imports/commit" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin access required" }, 403);
    const normalized = normalizeAudienceImport(await readJsonLimited(request, MAX_IMPORT_BYTES));
    const connector = await env.DB.prepare(`SELECT id,provider,name,active FROM visitor_connectors
      WHERE workspace_id=? AND id=?`).bind(workspaceId, normalized.connectorId)
      .first<{ id: string; provider: string; name: string; active: number }>();
    if (!connector || connector.provider !== "audiencelab") return json({ error: "AudienceLab connector not found" }, 404);
    if (!connector.active) return json({ error: "AudienceLab connector is revoked" }, 409);
    return commitAudienceImport(env, request, workspaceId, connector, normalized, { type: "user", access });
  }

  if (url.pathname === "/v1/admin/scoring/recalculate" && request.method === "POST") {
    const rows = await env.DB.prepare(`SELECT c.*,COALESCE(SUM(CASE WHEN d.stage IN ('paid','won') THEN d.value ELSE 0 END),0) revenue
      FROM contacts c LEFT JOIN deals d ON d.contact_id=c.id AND d.workspace_id=c.workspace_id
      WHERE c.workspace_id=? GROUP BY c.id LIMIT 1000`).bind(workspaceId).all<Record<string, unknown>>();
    const now = Date.now();
    const updatedAt = new Date(now).toISOString();
    const updates = rows.results.map((contact) => {
      const result = contactScore(contact, Number(contact.revenue || 0), now);
      return env.DB.prepare("UPDATE contacts SET score=?,updated_at=? WHERE workspace_id=? AND id=?")
        .bind(result.score, updatedAt, workspaceId, contact.id);
    });
    if (updates.length) await env.DB.batch(updates);
    await audit(env, access, request, "contacts.scored", "workspace", workspaceId, null, { contacts: updates.length, model: "deterministic-v1" });
    return json({ ok: true, scored: updates.length, model: "deterministic-v1" });
  }

  if (url.pathname === "/v1/admin/briefing" && request.method === "GET") {
    const canReadOpportunities = await hasWorkspaceGrant(env, access, "opportunity", "read");
    const now = Date.now();
    const staleCutoff = new Date(now - 7 * 86_400_000).toISOString();
    const [contacts, opportunities, tasks] = await Promise.all([
      env.DB.prepare(`SELECT c.*,COALESCE(SUM(CASE WHEN d.stage IN ('paid','won') THEN d.value ELSE 0 END),0) revenue
        FROM contacts c LEFT JOIN deals d ON d.contact_id=c.id AND d.workspace_id=c.workspace_id
        WHERE c.workspace_id=? GROUP BY c.id ORDER BY c.score DESC,COALESCE(c.last_activity_at,c.created_at) DESC LIMIT 500`).bind(workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT o.*,c.email,c.first_name,c.last_name,c.company,s.name stage_name
        FROM opportunities o JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
        JOIN pipeline_stages s ON s.id=o.stage_id AND s.workspace_id=o.workspace_id
        WHERE o.workspace_id=? AND o.status='open' ORDER BY o.value DESC`).bind(workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT t.*,c.email contact_email FROM tasks t LEFT JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
        WHERE t.workspace_id=? AND t.status='open' ORDER BY t.due_at LIMIT 250`).bind(workspaceId).all<Record<string, unknown>>(),
    ]);
    const scoredLeads = contacts.results.filter((contact) => contact.status === "lead").map((contact) => {
      const explanation = contactScore(contact, Number(contact.revenue || 0), now);
      return { id: contact.id, email: contact.email, first_name: contact.first_name, last_name: contact.last_name, company: contact.company, score: Number(contact.score), reasons: explanation.reasons };
    }).sort((a, b) => b.score - a.score).slice(0, 10);
    const visibleOpportunities = canReadOpportunities ? opportunities.results : [];
    const visibleTasks = canReadOpportunities
      ? tasks.results
      : tasks.results.filter((task) => !task.opportunity_id);
    const stalled = visibleOpportunities.filter((opportunity) =>
      !opportunity.next_step || String(opportunity.last_activity_at || opportunity.updated_at) < staleCutoff).slice(0, 10);
    const overdue = visibleTasks.filter((task) => task.due_at && Date.parse(String(task.due_at)) <= now).slice(0, 10);
    const dueToday = visibleTasks.filter((task) => {
      if (!task.due_at) return false;
      const due = new Date(String(task.due_at));
      const today = new Date(now);
      return due.getUTCFullYear() === today.getUTCFullYear() && due.getUTCMonth() === today.getUTCMonth() && due.getUTCDate() === today.getUTCDate();
    }).length;
    const openPipeline = visibleOpportunities.reduce((total, opportunity) => total + Number(opportunity.value || 0), 0);
    const weightedForecast = visibleOpportunities.reduce((total, opportunity) => total + Number(opportunity.value || 0) * Number(opportunity.probability || 0) / 100, 0);
    return json({
      generated_at: new Date(now).toISOString(),
      metrics: { open_pipeline: openPipeline, weighted_forecast: weightedForecast, overdue_tasks: overdue.length, due_today: dueToday, stalled_deals: stalled.length, unqualified_leads: contacts.results.filter((contact) => contact.status === "lead").length },
      top_leads: scoredLeads, stalled_opportunities: stalled, overdue_tasks: overdue,
    });
  }

  if (url.pathname === "/v1/admin/contacts/bulk" && request.method === "PATCH") {
    const denied = await requireWorkspaceGrant(env, access, "contact", "update");
    if (denied) return denied;
    const body = await readJson(request);
    const contactIds = jsonArray(body.ids, "ids", 100).filter((value): value is string => typeof value === "string" && /^con_[a-f0-9]{32}$/.test(value));
    if (!contactIds.length || contactIds.length !== (body.ids as unknown[]).length) return json({ error: "ids must contain valid contact IDs" }, 400);
    if (new Set(contactIds).size !== contactIds.length) return json({ error: "ids must not contain duplicates" }, 400);
    if (!body.versions || typeof body.versions !== "object" || Array.isArray(body.versions)) {
      return json({
        error: "This CRM tab is out of date. Refresh it, review the latest lead records, and try again.",
        code: "client_refresh_required",
      }, 428);
    }
    const versions = body.versions as Json;
    if (Object.keys(versions).length !== contactIds.length || contactIds.some((contactId) =>
      typeof versions[contactId] !== "string" || !String(versions[contactId]).trim())) {
      return json({ error: "versions must contain the loaded version of every contact" }, 400);
    }
    const stage = body.stage === undefined ? null : optionalString(body.stage, "stage", 30);
    const status = body.status === undefined ? null : optionalString(body.status, "status", 30);
    const owner = body.owner === undefined ? null : optionalString(body.owner, "owner", 254);
    for (const fieldName of ["stage", "status", "owner"] as const) {
      if (body[fieldName] !== undefined) {
        const fieldDenied = await requireWorkspaceGrant(env, access, "contact", "update_field", fieldName);
        if (fieldDenied) return fieldDenied;
      }
    }
    if (stage && !allowedStages.has(stage)) return json({ error: "Invalid stage" }, 400);
    if (status && !allowedStatuses.has(status)) return json({ error: "Invalid status" }, 400);
    if (!stage && !status && body.owner === undefined) return json({ error: "No supported fields supplied" }, 400);
    const available = await env.DB.prepare(`SELECT COUNT(*) total FROM contacts c
      JOIN json_each(?) requested ON c.id=requested.value
      WHERE c.workspace_id=?`)
      .bind(JSON.stringify(contactIds), workspaceId).first<{ total: number }>();
    if (Number(available?.total || 0) !== contactIds.length) {
      return json({ error: "One or more contacts were not found in this workspace" }, 404);
    }
    const expected = contactIds.map((contactId) => ({ id: contactId, updated_at: String(versions[contactId]) }));
    const latestExpected = expected.reduce((latest, record) => Math.max(latest, Date.parse(record.updated_at) || 0), 0);
    const now = new Date(Math.max(Date.now(), latestExpected + 1)).toISOString();
    const result = await env.DB.prepare(`WITH expected AS (
        SELECT json_extract(value,'$.id') id,json_extract(value,'$.updated_at') updated_at FROM json_each(?)
      ), version_guard AS (
        SELECT COUNT(*) matched FROM expected e JOIN contacts c
          ON c.workspace_id=? AND c.id=e.id AND c.updated_at=e.updated_at
      )
      UPDATE contacts SET stage=COALESCE(?,stage),status=COALESCE(?,status),
        owner=CASE WHEN ?=1 THEN ? ELSE owner END,updated_at=?
      WHERE workspace_id=? AND id IN (SELECT id FROM expected)
        AND (SELECT matched FROM version_guard)=?
      RETURNING id`)
      .bind(JSON.stringify(expected), workspaceId, stage, status, body.owner === undefined ? 0 : 1, owner, now,
        workspaceId, contactIds.length).all<{ id: string }>();
    const changed = result.results.length;
    if (changed !== contactIds.length) {
      await audit(env, access, request, "contacts.bulk_conflict", "contact_batch", id("batch"), null, { ids: contactIds, changed: 0 });
      return json({ error: "One or more contacts changed since they were loaded", code: "edit_conflict" }, 409);
    }
    await audit(env, access, request, "contacts.bulk_updated", "contact_batch", id("batch"), null, { ids: contactIds, stage, status, owner, changed });
    if (stage || status) {
      const moved = await env.DB.prepare(`SELECT c.* FROM contacts c JOIN json_each(?) selected ON selected.value=c.id
        WHERE c.workspace_id=?`).bind(JSON.stringify(contactIds), workspaceId).all<Record<string, unknown>>();
      const bulkEventId = requestId(request);
      for (const contact of moved.results) {
        await runContactAutomations(env, access, contact, `${bulkEventId}:${String(contact.id)}`, "contact.lifecycle_changed");
      }
    }
    return json({ ok: true, changed, updated_at: now });
  }

  if (url.pathname === "/v1/admin/saved-views" && request.method === "POST") {
    const body = await readJson(request);
    const objectType = optionalString(body.object_type, "object_type", 30) || "contact";
    if (objectType !== "contact") return json({ error: "A valid contact view is required" }, 400);
    const [customDefinitions, readableKeys] = await Promise.all([
      env.DB.prepare(`SELECT * FROM custom_field_definitions WHERE workspace_id=? AND object_type='contact' AND active=1 ORDER BY position,id`)
        .bind(workspaceId).all<CustomFieldDefinition>(),
      readableContactCustomFieldKeys(env, access),
    ]);
    const definition = validateSavedViewDefinition(body, false, customDefinitions.results, readableKeys);
    if (definition.visibility === "workspace" && !isWorkspaceAdmin(access)) return json({ error: "Only workspace admins can publish shared views" }, 403);
    const viewId = id("view");
    const now = new Date().toISOString();
    const created = {
      id: viewId, workspace_id: workspaceId, name: definition.name, object_type: objectType,
      filters: JSON.stringify(definition.filters), visibility: definition.visibility,
      columns: JSON.stringify(definition.columns), sorts: JSON.stringify(definition.sorts),
      revision: 1, change_id: null, created_by: access.email, created_at: now, updated_at: now,
    };
    try {
      await env.DB.batch([env.DB.prepare(`INSERT INTO saved_views
        (id,workspace_id,name,object_type,filters,visibility,columns,sorts,revision,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,?,?,?)`).bind(viewId, workspaceId, definition.name, objectType,
          JSON.stringify(definition.filters), definition.visibility, JSON.stringify(definition.columns),
          JSON.stringify(definition.sorts), access.email, now, now),
        await auditStatement(env, access, request, "saved_view.created", "saved_view", viewId, null, created),
      ]);
    } catch {
      return json({ error: "A view with that name already exists" }, 409);
    }
    return json({ ok: true, id: viewId, view: created }, 201);
  }
  const savedViewMatch = url.pathname.match(/^\/v1\/admin\/saved-views\/([^/]+)$/);
  if (savedViewMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const before = await env.DB.prepare("SELECT * FROM saved_views WHERE workspace_id=? AND id=?").bind(workspaceId, savedViewMatch[1]).first<Record<string, unknown>>();
    if (!before || (before.visibility === "private" && before.created_by !== access.email)) return json({ error: "Saved view not found" }, 404);
    if (before.created_by !== access.email && !isWorkspaceAdmin(access)) return json({ error: "Only the view creator or an admin can update this view" }, 403);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return json({ error: "expected_revision is required", code: "version_required" }, 428);
    const [customDefinitions, readableKeys] = await Promise.all([
      env.DB.prepare(`SELECT * FROM custom_field_definitions WHERE workspace_id=? AND object_type='contact' AND active=1 ORDER BY position,id`)
        .bind(workspaceId).all<CustomFieldDefinition>(),
      readableContactCustomFieldKeys(env, access),
    ]);
    const definition = validateSavedViewDefinition(body, true, customDefinitions.results, readableKeys);
    if (!Object.keys(definition).length) return json({ error: "No supported saved-view fields supplied" }, 400);
    if (definition.visibility === "workspace" && !isWorkspaceAdmin(access)) return json({ error: "Only workspace admins can publish shared views" }, 403);
    const nextName = definition.name ?? String(before.name);
    const nextFilters = definition.filters ?? JSON.parse(String(before.filters)) as Json;
    const nextVisibility = definition.visibility ?? String(before.visibility);
    const nextColumns = definition.columns ?? JSON.parse(String(before.columns)) as string[];
    const nextSorts = definition.sorts ?? JSON.parse(String(before.sorts)) as Array<{ field: string; direction: string }>;
    const latest = Date.parse(String(before.updated_at)) || 0;
    const now = new Date(Math.max(Date.now(), latest + 1)).toISOString();
    const changeId = id("change");
    const updated = { ...before, name: nextName, filters: JSON.stringify(nextFilters), visibility: nextVisibility,
      columns: JSON.stringify(nextColumns), sorts: JSON.stringify(nextSorts), revision: expectedRevision + 1, change_id: changeId, updated_at: now };
    let batch;
    try {
      batch = await env.DB.batch([env.DB.prepare(`UPDATE saved_views SET name=?,filters=?,visibility=?,columns=?,sorts=?,
        revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
        .bind(nextName, JSON.stringify(nextFilters), nextVisibility, JSON.stringify(nextColumns), JSON.stringify(nextSorts),
          changeId, now, workspaceId, savedViewMatch[1], expectedRevision),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'user',?,'saved_view.updated','saved_view',?,?,?,?,?
          FROM saved_views WHERE workspace_id=? AND id=? AND change_id=?`)
          .bind(id("audit"), workspaceId, access.email, savedViewMatch[1], JSON.stringify(before), JSON.stringify(updated),
            requestId(request), now, workspaceId, savedViewMatch[1], changeId),
      ]);
    } catch {
      return json({ error: "A view with that name already exists" }, 409);
    }
    if (!batch[0].meta.changes) return json({ error: "This saved view changed in another session", code: "edit_conflict" }, 409);
    return json({ ok: true, view: updated });
  }
  if (savedViewMatch && request.method === "DELETE") {
    const before = await env.DB.prepare("SELECT * FROM saved_views WHERE workspace_id=? AND id=?").bind(workspaceId, savedViewMatch[1]).first<Record<string, unknown>>();
    if (!before || (before.visibility === "private" && before.created_by !== access.email)) return json({ error: "Saved view not found" }, 404);
    if (!isWorkspaceAdmin(access) && before.created_by !== access.email) return json({ error: "Only the view creator or an admin can delete this view" }, 403);
    const expectedRevision = Number(url.searchParams.get("expected_revision"));
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return json({ error: "expected_revision is required", code: "version_required" }, 428);
    const now = new Date().toISOString();
    const deleted = await env.DB.batch([
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
        SELECT ?,?,'user',?,'saved_view.deleted','saved_view',?,?,NULL,?,?
        FROM saved_views WHERE workspace_id=? AND id=? AND revision=?`)
        .bind(id("audit"), workspaceId, access.email, savedViewMatch[1], JSON.stringify(before), requestId(request), now,
          workspaceId, savedViewMatch[1], expectedRevision),
      env.DB.prepare("DELETE FROM saved_views WHERE workspace_id=? AND id=? AND revision=?")
        .bind(workspaceId, savedViewMatch[1], expectedRevision),
    ]);
    if (!deleted[1].meta.changes) return json({ error: "This saved view changed in another session", code: "edit_conflict" }, 409);
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/companies/duplicates" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Only workspace admins can review duplicate companies" }, 403);
    const companies = await env.DB.prepare(`SELECT id,name,domain,website,industry,owner,created_at,updated_at
      FROM companies WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 501`).bind(workspaceId).all<Record<string, unknown>>();
    if (companies.results.length > 500) {
      return json({
        error: "Duplicate review is limited to workspaces with 500 companies. Narrowing controls are required before scanning a larger workspace.",
        code: "duplicate_scan_too_large",
        limit: 500,
      }, 422);
    }
    const candidates: Array<Record<string, unknown>> = [];
    for (let leftIndex = 0; leftIndex < companies.results.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < companies.results.length; rightIndex += 1) {
        const left = companies.results[leftIndex];
        const right = companies.results[rightIndex];
        const duplicate = companyDuplicateScore(left, right);
        if (duplicate.score < 40) continue;
        candidates.push({
          source: left,
          target: right,
          score: duplicate.score,
          reasons: duplicate.reasons,
        });
      }
    }
    candidates.sort((left, right) =>
      Number(right.score) - Number(left.score) ||
      String((left.source as Record<string, unknown>).name).localeCompare(String((right.source as Record<string, unknown>).name)));
    return json({
      candidates: candidates.slice(0, 50),
      scanned_companies: companies.results.length,
      candidate_count: candidates.length,
      returned_count: Math.min(candidates.length, 50),
      truncated: candidates.length > 50,
      scoring_contract: "company-duplicate-score:v2",
    });
  }

  const companyMatch = url.pathname.match(/^\/v1\/admin\/companies\/(cmp_[a-f0-9]{32})$/);
  if (companyMatch && request.method === "GET") {
    const canReadOpportunities = await hasWorkspaceGrant(env, access, "opportunity", "read");
    const requestedCompanyId = companyMatch[1];
    const redirect = await env.DB.prepare(`SELECT source_company_id,target_company_id,source_name,merged_at
      FROM company_redirects WHERE workspace_id=? AND source_company_id=?`)
      .bind(workspaceId, requestedCompanyId).first<Record<string, unknown>>();
    const companyId = redirect ? String(redirect.target_company_id) : requestedCompanyId;
    const [company, contacts, opportunities, tasks, companyNotes, contactNotes, activities, audits] = await Promise.all([
      env.DB.prepare(`SELECT co.*,
        COUNT(DISTINCT c.id) contacts,
        COALESCE(SUM(CASE WHEN o.status='open' THEN o.value ELSE 0 END),0) open_pipeline,
        COALESCE(SUM(CASE WHEN o.status='won' THEN o.value ELSE 0 END),0) won_revenue,
        COALESCE(SUM(CASE WHEN o.status='open' THEN o.value*o.probability/100.0 ELSE 0 END),0) weighted_forecast
        FROM companies co
        LEFT JOIN contacts c ON c.company_id=co.id AND c.workspace_id=co.workspace_id
        LEFT JOIN opportunities o ON o.contact_id=c.id AND o.workspace_id=co.workspace_id
        WHERE co.workspace_id=? AND co.id=? GROUP BY co.id`).bind(workspaceId, companyId).first(),
      env.DB.prepare(`SELECT id,email,first_name,last_name,phone,status,stage,score,owner,last_activity_at,
        next_follow_up_at,created_at,updated_at FROM contacts
        WHERE workspace_id=? AND company_id=? ORDER BY updated_at DESC LIMIT 250`).bind(workspaceId, companyId).all(),
      env.DB.prepare(`SELECT o.*,s.name stage_name,s.color stage_color,c.email contact_email,
        c.first_name contact_first_name,c.last_name contact_last_name
        FROM opportunities o
        JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
        JOIN pipeline_stages s ON s.id=o.stage_id AND s.workspace_id=o.workspace_id
        WHERE o.workspace_id=? AND c.company_id=? ORDER BY o.updated_at DESC LIMIT 250`).bind(workspaceId, companyId).all(),
      env.DB.prepare(`SELECT t.*,c.email contact_email,o.name opportunity_name
        FROM tasks t
        JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
        LEFT JOIN opportunities o ON o.id=t.opportunity_id AND o.workspace_id=t.workspace_id
        WHERE t.workspace_id=? AND c.company_id=? ORDER BY t.created_at DESC LIMIT 250`).bind(workspaceId, companyId).all(),
      env.DB.prepare("SELECT * FROM company_notes WHERE workspace_id=? AND company_id=? ORDER BY created_at DESC LIMIT 200")
        .bind(workspaceId, companyId).all(),
      env.DB.prepare(`SELECT n.*,c.id contact_id,c.email contact_email,c.first_name contact_first_name,c.last_name contact_last_name
        FROM notes n JOIN contacts c ON c.id=n.contact_id AND c.workspace_id=n.workspace_id
        WHERE n.workspace_id=? AND c.company_id=? ORDER BY n.created_at DESC LIMIT 200`).bind(workspaceId, companyId).all(),
      env.DB.prepare(`SELECT a.*,c.id contact_id,c.email contact_email,c.first_name contact_first_name,c.last_name contact_last_name
        FROM activities a JOIN contacts c ON c.id=a.contact_id AND c.workspace_id=a.workspace_id
        WHERE a.workspace_id=? AND c.company_id=? ORDER BY a.occurred_at DESC LIMIT 200`).bind(workspaceId, companyId).all(),
      env.DB.prepare(`SELECT l.* FROM audit_log l
        WHERE l.workspace_id=? AND (
          (l.entity_type='company' AND l.entity_id=?) OR
          (l.entity_type='contact' AND EXISTS(
            SELECT 1 FROM contacts c WHERE c.workspace_id=l.workspace_id AND c.id=l.entity_id AND c.company_id=?
          )) OR
          (l.entity_type='opportunity' AND EXISTS(
            SELECT 1 FROM opportunities o JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
            WHERE o.workspace_id=l.workspace_id AND o.id=l.entity_id AND c.company_id=?
          ))
        ) ORDER BY l.created_at DESC LIMIT 100`).bind(workspaceId, companyId, companyId, companyId).all(),
    ]);
    if (!company) return json({ error: "Company not found" }, 404);
    const opportunityReadableKeys = await readableOpportunityCustomFieldKeys(env, access);
    return json({
      company: canReadOpportunities ? company : {
        ...company as Record<string, unknown>,
        open_pipeline: 0,
        won_revenue: 0,
        weighted_forecast: 0,
      },
      canonical_company_id: companyId,
      redirected_from: redirect ? requestedCompanyId : null,
      redirect,
      contacts: contacts.results,
      opportunities: canReadOpportunities ? opportunities.results.map((opportunity) =>
        redactOpportunityCustomFields(opportunity as Record<string, unknown>, opportunityReadableKeys)) : [],
      tasks: canReadOpportunities ? tasks.results : tasks.results.filter((task) => !task.opportunity_id),
      company_notes: companyNotes.results,
      contact_notes: contactNotes.results,
      activities: activities.results,
      audits: canReadOpportunities ? audits.results : audits.results.filter((entry) =>
        entry.entity_type !== "opportunity" && entry.entity_type !== "opportunity_task"),
    });
  }
  if (companyMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const before = await env.DB.prepare("SELECT * FROM companies WHERE workspace_id=? AND id=?")
      .bind(workspaceId, companyMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Company not found" }, 404);
    const allowed = new Set(["name", "domain", "website", "industry", "owner", "custom_fields", "if_updated_at"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) return json({ error: "Unsupported company field" }, 400);
    if (!Object.keys(body).some((key) => key !== "if_updated_at")) return json({ error: "No supported fields supplied" }, 400);
    const name = body.name === undefined ? String(before.name) : optionalString(body.name, "name", 200);
    if (!name) return json({ error: "name is required" }, 400);
    const nameKey = companyNameKey(String(name));
    if (nameKey !== before.name_key && !isWorkspaceAdmin(access)) {
      return json({ error: "Only workspace admins can rename companies" }, 403);
    }
    const nameAliasId = `cmp_${(await sha256(`${workspaceId}\n${nameKey}`)).slice(0, 32)}`;
    const domain = body.domain === undefined ? before.domain : optionalString(body.domain, "domain", 255);
    const website = body.website === undefined ? before.website : optionalString(body.website, "website", 500);
    const industry = body.industry === undefined ? before.industry : optionalString(body.industry, "industry", 120);
    const owner = body.owner === undefined ? before.owner : optionalString(body.owner, "owner", 254);
    let customFields = String(before.custom_fields || "{}");
    if (body.custom_fields !== undefined) {
      try { customFields = await mergeCustomFieldValues(env, workspaceId, "company", before.custom_fields, body.custom_fields); }
      catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid custom fields" }, 400); }
    }
    const expectedUpdatedAt = optionalString(body.if_updated_at, "if_updated_at", 50);
    const duplicate = await env.DB.prepare("SELECT id FROM companies WHERE workspace_id=? AND name_key=? AND id<>?")
      .bind(workspaceId, nameKey, companyMatch[1]).first();
    if (duplicate) return json({ error: "A company with that name already exists. Merge these companies instead.", code: "company_name_conflict" }, 409);
    const alias = await env.DB.prepare("SELECT target_company_id FROM company_redirects WHERE workspace_id=? AND source_company_id=?")
      .bind(workspaceId, nameAliasId).first<{ target_company_id: string }>();
    if (alias && alias.target_company_id !== companyMatch[1]) {
      return json({ error: "That name is already an alias for another company. Merge these companies instead.", code: "company_name_conflict" }, 409);
    }
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(domain))) return json({ error: "domain is invalid" }, 400);
    if (website) {
      let parsed: URL;
      try { parsed = new URL(String(website)); } catch { return json({ error: "website is invalid" }, 400); }
      if (parsed.protocol !== "https:") return json({ error: "website must use HTTPS" }, 400);
    }
    if (owner && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(owner))) return json({ error: "owner must be a valid email" }, 400);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const after = { ...before, name, name_key: nameKey, domain, website, industry, owner, custom_fields: customFields, updated_at: updatedAt };
    const ip = request.headers.get("cf-connecting-ip") || "";
    const ipHash = ip ? await sha256(ip) : null;
    let changed;
    try {
      const statements = [
      env.DB.prepare(`UPDATE companies SET name=?,name_key=?,domain=?,website=?,industry=?,owner=?,custom_fields=?,updated_at=?
        WHERE workspace_id=? AND id=? AND (? IS NULL OR updated_at=?)`)
        .bind(name, nameKey, domain, website, industry, owner, customFields, updatedAt,
          workspaceId, companyMatch[1], expectedUpdatedAt, expectedUpdatedAt),
      env.DB.prepare(`UPDATE contacts SET company=?,updated_at=?
        WHERE workspace_id=? AND company_id=? AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        )`).bind(name, updatedAt, workspaceId, companyMatch[1], workspaceId, companyMatch[1], updatedAt),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'company.updated','company',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(id("aud"), workspaceId, access.email, companyMatch[1], JSON.stringify(before), JSON.stringify(after),
          requestId(request), ipHash, updatedAt, workspaceId, companyMatch[1], updatedAt),
      ];
      if (nameAliasId !== companyMatch[1] && !alias) {
        statements.splice(2, 0, env.DB.prepare(`INSERT INTO company_redirects
          (id,workspace_id,source_company_id,target_company_id,source_name,merged_at)
          SELECT ?,?,?,?,?,? WHERE EXISTS(
            SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
          )`).bind(id("cmpred"), workspaceId, nameAliasId, companyMatch[1], name, updatedAt,
            workspaceId, companyMatch[1], updatedAt));
      }
      changed = await env.DB.batch(statements);
    } catch (error) {
      if (String(error).toLowerCase().includes("unique") &&
        (String(error).includes("companies") || String(error).includes("company_redirects"))) {
        return json({ error: "A company with that name already exists. Merge these companies instead.", code: "company_name_conflict" }, 409);
      }
      throw error;
    }
    if (!changed[0].meta.changes) return json({ error: "Company changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true, company: after });
  }

  const companyMergePreviewMatch = url.pathname.match(/^\/v1\/admin\/companies\/(cmp_[a-f0-9]{32})\/merge-preview$/);
  if (companyMergePreviewMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Only workspace admins can review company merges" }, 403);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => key !== "target_company_id")) return json({ error: "Unsupported merge-preview field" }, 400);
    const sourceId = companyMergePreviewMatch[1];
    const targetId = optionalString(body.target_company_id, "target_company_id", 40);
    if (!targetId || !/^cmp_[a-f0-9]{32}$/.test(targetId) || targetId === sourceId) {
      return json({ error: "A different target company is required" }, 400);
    }
    const [source, target, sourceCounts, targetCounts] = await Promise.all([
      env.DB.prepare("SELECT * FROM companies WHERE workspace_id=? AND id=?").bind(workspaceId, sourceId).first<Record<string, unknown>>(),
      env.DB.prepare("SELECT * FROM companies WHERE workspace_id=? AND id=?").bind(workspaceId, targetId).first<Record<string, unknown>>(),
      companyMergeCounts(env, workspaceId, sourceId),
      companyMergeCounts(env, workspaceId, targetId),
    ]);
    if (!source || !target) return json({ error: "Source or target company not found" }, 404);
    const normalizedSourceCounts = { contacts: Number(sourceCounts?.contacts || 0), notes: Number(sourceCounts?.notes || 0),
      opportunities: Number(sourceCounts?.opportunities || 0), tasks: Number(sourceCounts?.tasks || 0), aliases: Number(sourceCounts?.aliases || 0) };
    const normalizedTargetCounts = { contacts: Number(targetCounts?.contacts || 0), notes: Number(targetCounts?.notes || 0),
      opportunities: Number(targetCounts?.opportunities || 0), tasks: Number(targetCounts?.tasks || 0), aliases: Number(targetCounts?.aliases || 0) };
    const fields = ["name", "domain", "website", "industry", "owner"].map((field) => ({
      field,
      source_value: source[field] || null,
      target_value: target[field] || null,
      resolved_value: field === "name" ? target[field] : target[field] || source[field] || null,
      resolution: field === "name" || target[field] ? "target" : source[field] ? "source_fallback" : "empty",
    }));
    const reviewToken = await companyMergeReviewToken(workspaceId, source, target, normalizedSourceCounts, normalizedTargetCounts);
    return json({
      source,
      target,
      source_counts: normalizedSourceCounts,
      target_counts: normalizedTargetCounts,
      resulting_counts: Object.fromEntries(Object.keys(normalizedSourceCounts).map((key) =>
        [key, normalizedSourceCounts[key as keyof typeof normalizedSourceCounts] + normalizedTargetCounts[key as keyof typeof normalizedTargetCounts]])),
      field_resolutions: fields,
      warnings: [
        "The source company will become a permanent alias of the target.",
        "The target keeps its populated profile fields; empty target fields inherit source values.",
        "This approval expires when either company or its relationship counts change.",
      ],
      source_if_updated_at: source.updated_at,
      target_if_updated_at: target.updated_at,
      review_token: reviewToken,
      review_contract: "company-merge-review:v1",
    });
  }

  const companyMergeMatch = url.pathname.match(/^\/v1\/admin\/companies\/(cmp_[a-f0-9]{32})\/merge$/);
  if (companyMergeMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Only workspace admins can merge companies" }, 403);
    const body = await readJson(request);
    const allowed = new Set(["target_company_id", "source_if_updated_at", "target_if_updated_at", "review_token"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) return json({ error: "Unsupported merge field" }, 400);
    const sourceId = companyMergeMatch[1];
    const targetId = optionalString(body.target_company_id, "target_company_id", 40);
    if (!targetId || !/^cmp_[a-f0-9]{32}$/.test(targetId) || targetId === sourceId) return json({ error: "A different target company is required" }, 400);
    const sourceVersion = optionalString(body.source_if_updated_at, "source_if_updated_at", 50);
    const targetVersion = optionalString(body.target_if_updated_at, "target_if_updated_at", 50);
    if (!sourceVersion || !targetVersion) return json({ error: "Both company versions are required" }, 400);
    const reviewToken = optionalString(body.review_token, "review_token", 64);
    if (!reviewToken || !/^[a-f0-9]{64}$/.test(reviewToken)) {
      return json({ error: "A current merge review token is required", code: "merge_review_required" }, 400);
    }
    const [source, target, sourceCounts, targetCounts] = await Promise.all([
      env.DB.prepare("SELECT * FROM companies WHERE workspace_id=? AND id=?").bind(workspaceId, sourceId).first<Record<string, unknown>>(),
      env.DB.prepare("SELECT * FROM companies WHERE workspace_id=? AND id=?").bind(workspaceId, targetId).first<Record<string, unknown>>(),
      companyMergeCounts(env, workspaceId, sourceId),
      companyMergeCounts(env, workspaceId, targetId),
    ]);
    if (!source || !target) return json({ error: "Source or target company not found" }, 404);
    const normalizedSourceCounts = { contacts: Number(sourceCounts?.contacts || 0), notes: Number(sourceCounts?.notes || 0),
      opportunities: Number(sourceCounts?.opportunities || 0), tasks: Number(sourceCounts?.tasks || 0), aliases: Number(sourceCounts?.aliases || 0) };
    const normalizedTargetCounts = { contacts: Number(targetCounts?.contacts || 0), notes: Number(targetCounts?.notes || 0),
      opportunities: Number(targetCounts?.opportunities || 0), tasks: Number(targetCounts?.tasks || 0), aliases: Number(targetCounts?.aliases || 0) };
    const expectedReviewToken = await companyMergeReviewToken(workspaceId, source, target, normalizedSourceCounts, normalizedTargetCounts);
    if (reviewToken !== expectedReviewToken) {
      return json({ error: "The merge review is stale. Review the current companies and impact again.", code: "merge_review_stale" }, 409);
    }
    if (source.updated_at !== sourceVersion || target.updated_at !== targetVersion) {
      return json({ error: "A company changed since the merge was prepared", code: "merge_conflict" }, 409);
    }
    const mergedAt = new Date(Math.max(Date.now(), Date.parse(String(source.updated_at)) + 1, Date.parse(String(target.updated_at)) + 1)).toISOString();
    const mergedTarget = {
      ...target,
      domain: target.domain || source.domain || null,
      website: target.website || source.website || null,
      industry: target.industry || source.industry || null,
      owner: target.owner || source.owner || null,
      updated_at: mergedAt,
    };
    const mergeSummary = {
      source_company_id: sourceId,
      source_name: source.name,
      target_company_id: targetId,
      target_name: target.name,
      contacts_moved: normalizedSourceCounts.contacts,
      notes_moved: normalizedSourceCounts.notes,
      opportunities_affected: normalizedSourceCounts.opportunities,
      tasks_affected: normalizedSourceCounts.tasks,
      aliases_repointed: normalizedSourceCounts.aliases,
    };
    const auditCreatedAt = mergedAt;
    const ip = request.headers.get("cf-connecting-ip") || "";
    const ipHash = ip ? await sha256(ip) : null;
    const merged = await env.DB.batch([
      env.DB.prepare(`UPDATE companies SET updated_at=? WHERE workspace_id=? AND id=? AND updated_at=?
        AND EXISTS(SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(mergedAt, workspaceId, sourceId, sourceVersion, workspaceId, targetId, targetVersion),
      env.DB.prepare(`UPDATE companies SET domain=?,website=?,industry=?,owner=?,updated_at=?
        WHERE workspace_id=? AND id=? AND updated_at=? AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        )`).bind(mergedTarget.domain, mergedTarget.website, mergedTarget.industry, mergedTarget.owner, mergedAt,
          workspaceId, targetId, targetVersion, workspaceId, sourceId, mergedAt),
      env.DB.prepare(`UPDATE contacts SET company_id=?,company=?,updated_at=?
        WHERE workspace_id=? AND company_id=? AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        ) AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        )`).bind(targetId, target.name, mergedAt, workspaceId, sourceId,
          workspaceId, sourceId, mergedAt, workspaceId, targetId, mergedAt),
      env.DB.prepare(`UPDATE company_notes SET company_id=?,updated_at=?
        WHERE workspace_id=? AND company_id=? AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        ) AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        )`).bind(targetId, mergedAt, workspaceId, sourceId,
          workspaceId, sourceId, mergedAt, workspaceId, targetId, mergedAt),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'company.merged_into','company',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?)
          AND EXISTS(SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(id("aud"), workspaceId, access.email, sourceId, JSON.stringify(source), JSON.stringify(mergeSummary),
          requestId(request), ipHash, auditCreatedAt, workspaceId, sourceId, mergedAt, workspaceId, targetId, mergedAt),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'company.merge_received','company',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?)
          AND EXISTS(SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(id("aud"), workspaceId, access.email, targetId, JSON.stringify(target), JSON.stringify({ ...mergedTarget, merge: mergeSummary }),
          requestId(request), ipHash, auditCreatedAt, workspaceId, sourceId, mergedAt, workspaceId, targetId, mergedAt),
      env.DB.prepare(`UPDATE company_redirects SET target_company_id=?,merged_at=?
        WHERE workspace_id=? AND target_company_id=? AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        ) AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        )`).bind(targetId, mergedAt, workspaceId, sourceId,
          workspaceId, sourceId, mergedAt, workspaceId, targetId, mergedAt),
      env.DB.prepare(`INSERT INTO company_redirects(id,workspace_id,source_company_id,target_company_id,source_name,merged_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        ) AND EXISTS(
          SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        )`).bind(id("cmpred"), workspaceId, sourceId, targetId, source.name, mergedAt,
          workspaceId, sourceId, mergedAt, workspaceId, targetId, mergedAt),
      env.DB.prepare(`DELETE FROM companies WHERE workspace_id=? AND id=? AND updated_at=?
        AND EXISTS(SELECT 1 FROM companies WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(workspaceId, sourceId, mergedAt, workspaceId, targetId, mergedAt),
    ]);
    if (!merged[0].meta.changes || !merged[7].meta.changes || !merged[8].meta.changes) {
      return json({ error: "A company changed since the merge was prepared", code: "merge_conflict" }, 409);
    }
    return json({ ok: true, company: mergedTarget, merge: mergeSummary });
  }

  const companyNoteMatch = url.pathname.match(/^\/v1\/admin\/companies\/(cmp_[a-f0-9]{32})\/notes$/);
  if (companyNoteMatch && request.method === "POST") {
    const body = await readJson(request);
    const noteBody = optionalString(body.body, "body", 4000);
    if (!noteBody) return json({ error: "A note is required" }, 400);
    const company = await env.DB.prepare("SELECT id FROM companies WHERE workspace_id=? AND id=?")
      .bind(workspaceId, companyNoteMatch[1]).first();
    if (!company) return json({ error: "Company not found" }, 404);
    const noteId = id("cnote");
    const createdAt = new Date().toISOString();
    const note = { id: noteId, company_id: companyNoteMatch[1], author: access.email, body: noteBody, created_at: createdAt, updated_at: createdAt };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO company_notes(id,workspace_id,company_id,author,body,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).bind(noteId, workspaceId, companyNoteMatch[1], access.email, noteBody, createdAt, createdAt),
      await auditStatement(env, access, request, "company.note_created", "company", companyNoteMatch[1], null, {
        note_id: noteId,
      }),
    ]);
    return json({ ok: true, note }, 201);
  }

  const companyNoteRecordMatch = url.pathname.match(/^\/v1\/admin\/company-notes\/(cnote_[a-f0-9]{32})$/);
  if (companyNoteRecordMatch && (request.method === "PATCH" || request.method === "DELETE")) {
    const body = await readJson(request);
    const before = await env.DB.prepare("SELECT * FROM company_notes WHERE workspace_id=? AND id=?")
      .bind(workspaceId, companyNoteRecordMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Company note not found" }, 404);
    if (!isWorkspaceAdmin(access) && before.author !== access.email) {
      return json({ error: "Only the note author or a workspace admin can change this note" }, 403);
    }
    const allowed = request.method === "PATCH" ? new Set(["body", "if_updated_at"]) : new Set(["if_updated_at"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) return json({ error: "Unsupported company note field" }, 400);
    const expectedUpdatedAt = optionalString(body.if_updated_at, "if_updated_at", 50);
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required" }, 400);
    const currentUpdatedAt = String(before.updated_at || before.created_at);
    if (expectedUpdatedAt !== currentUpdatedAt) return json({ error: "Company note changed since it was loaded", code: "edit_conflict" }, 409);
    const bodyFingerprint = async (value: unknown) => ({ sha256: await sha256(String(value || "")), length: String(value || "").length });
    const beforeState = { id: before.id, company_id: before.company_id, author: before.author, body: await bodyFingerprint(before.body), updated_at: currentUpdatedAt };
    const changedAt = new Date(Math.max(Date.now(), Date.parse(currentUpdatedAt) + 1)).toISOString();
    const ip = request.headers.get("cf-connecting-ip") || "";
    const ipHash = ip ? await sha256(ip) : null;
    if (request.method === "PATCH") {
      const noteBody = optionalString(body.body, "body", 4000);
      if (!noteBody) return json({ error: "A note is required" }, 400);
      const afterState = { ...beforeState, body: await bodyFingerprint(noteBody), updated_at: changedAt };
      const changed = await env.DB.batch([
        env.DB.prepare(`UPDATE company_notes SET body=?,updated_at=? WHERE workspace_id=? AND id=? AND COALESCE(updated_at,created_at)=?`)
          .bind(noteBody, changedAt, workspaceId, companyNoteRecordMatch[1], expectedUpdatedAt),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
          SELECT ?,?,'user',?,'company.note_updated','company',?,?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM company_notes WHERE workspace_id=? AND id=? AND updated_at=?)`)
          .bind(id("aud"), workspaceId, access.email, before.company_id, JSON.stringify(beforeState), JSON.stringify(afterState),
            requestId(request), ipHash, changedAt, workspaceId, companyNoteRecordMatch[1], changedAt),
      ]);
      if (!changed[0].meta.changes) return json({ error: "Company note changed since it was loaded", code: "edit_conflict" }, 409);
      return json({ ok: true, note: { ...before, body: noteBody, updated_at: changedAt } });
    }
    const deleted = await env.DB.batch([
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'company.note_deleted','company',?,?,NULL,?,?,?
        WHERE EXISTS(SELECT 1 FROM company_notes WHERE workspace_id=? AND id=? AND COALESCE(updated_at,created_at)=?)`)
        .bind(id("aud"), workspaceId, access.email, before.company_id, JSON.stringify(beforeState),
          requestId(request), ipHash, changedAt, workspaceId, companyNoteRecordMatch[1], expectedUpdatedAt),
      env.DB.prepare("DELETE FROM company_notes WHERE workspace_id=? AND id=? AND COALESCE(updated_at,created_at)=?")
        .bind(workspaceId, companyNoteRecordMatch[1], expectedUpdatedAt),
    ]);
    if (!deleted[1].meta.changes) return json({ error: "Company note changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true });
  }

  const contactMatch = url.pathname.match(/^\/v1\/admin\/contacts\/([^/]+)$/);
  if (contactMatch && request.method === "GET") {
    const canReadOpportunities = await hasWorkspaceGrant(env, access, "opportunity", "read");
    const [contact, activities, deals, notes, opportunities, tasks] = await Promise.all([
      env.DB.prepare("SELECT * FROM contacts WHERE workspace_id=? AND id=?").bind(workspaceId, contactMatch[1]).first(),
      env.DB.prepare("SELECT * FROM activities WHERE workspace_id=? AND contact_id=? ORDER BY occurred_at DESC LIMIT 200").bind(workspaceId, contactMatch[1]).all(),
      env.DB.prepare("SELECT * FROM deals WHERE workspace_id=? AND contact_id=? ORDER BY created_at DESC").bind(workspaceId, contactMatch[1]).all(),
      env.DB.prepare("SELECT * FROM notes WHERE workspace_id=? AND contact_id=? ORDER BY created_at DESC").bind(workspaceId, contactMatch[1]).all(),
      env.DB.prepare("SELECT * FROM opportunities WHERE workspace_id=? AND contact_id=? ORDER BY updated_at DESC").bind(workspaceId, contactMatch[1]).all(),
      env.DB.prepare("SELECT * FROM tasks WHERE workspace_id=? AND contact_id=? ORDER BY created_at DESC").bind(workspaceId, contactMatch[1]).all(),
    ]);
    if (!contact) return json({ error: "Contact not found" }, 404);
    const [readableContactFields, readableOpportunityFields] = await Promise.all([
      readableContactCustomFieldKeys(env, access),
      readableOpportunityCustomFieldKeys(env, access),
    ]);
    return json({
      contact: redactContactCustomFields(contact as Record<string, unknown>, readableContactFields),
      activities: activities.results, deals: deals.results, notes: notes.results,
      opportunities: canReadOpportunities ? opportunities.results.map((opportunity) =>
        redactOpportunityCustomFields(opportunity as Record<string, unknown>, readableOpportunityFields)) : [],
      tasks: canReadOpportunities ? tasks.results : tasks.results.filter((task) => !task.opportunity_id),
    });
  }
  if (contactMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const contact = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=?").bind(workspaceId, contactMatch[1]).first();
    if (!contact) return json({ error: "Contact not found" }, 404);
    const deleted = await env.DB.batch([
      env.DB.prepare("DELETE FROM agent_work_items WHERE workspace_id=? AND contact_id=?").bind(workspaceId, contactMatch[1]),
      env.DB.prepare("DELETE FROM agent_proposals WHERE workspace_id=? AND contact_id=?").bind(workspaceId, contactMatch[1]),
      env.DB.prepare("DELETE FROM tasks WHERE workspace_id=? AND contact_id=?").bind(workspaceId, contactMatch[1]),
      env.DB.prepare("DELETE FROM opportunities WHERE workspace_id=? AND contact_id=?").bind(workspaceId, contactMatch[1]),
      env.DB.prepare("DELETE FROM notes WHERE workspace_id=? AND contact_id=?").bind(workspaceId, contactMatch[1]),
      env.DB.prepare("DELETE FROM deals WHERE workspace_id=? AND contact_id=?").bind(workspaceId, contactMatch[1]),
      env.DB.prepare("DELETE FROM activities WHERE workspace_id=? AND contact_id=?").bind(workspaceId, contactMatch[1]),
      env.DB.prepare("DELETE FROM contacts WHERE workspace_id=? AND id=?").bind(workspaceId, contactMatch[1]),
    ]);
    if (!deleted.at(-1)?.meta.changes) return json({ error: "Contact not found" }, 404);
    await audit(env, access, request, "contact.deleted", "contact", contactMatch[1], contact, null);
    return json({ ok: true });
  }
  if (contactMatch && request.method === "PATCH") {
    const denied = await requireWorkspaceGrant(env, access, "contact", "update");
    if (denied) return denied;
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    const stage = body.stage === undefined ? null : optionalString(body.stage, "stage", 30);
    const status = body.status === undefined ? null : optionalString(body.status, "status", 30);
    const owner = body.owner === undefined ? null : optionalString(body.owner, "owner", 254);
    const followUp = body.next_follow_up_at === undefined ? null : optionalString(body.next_follow_up_at, "next_follow_up_at", 50);
    const expectedUpdatedAt = body.if_updated_at === undefined ? null : optionalString(body.if_updated_at, "if_updated_at", 50);
    for (const fieldName of ["stage", "status", "owner", "next_follow_up_at"] as const) {
      if (body[fieldName] !== undefined) {
        const fieldDenied = await requireWorkspaceGrant(env, access, "contact", "update_field", fieldName);
        if (fieldDenied) return fieldDenied;
      }
    }
    if (stage && !allowedStages.has(stage)) return json({ error: "Invalid stage" }, 400);
    if (status && !allowedStatuses.has(status)) return json({ error: "Invalid status" }, 400);
    if (body.custom_fields !== undefined && !isPlainObject(body.custom_fields)) return json({ error: "custom_fields must be an object" }, 400);
    if (body.custom_fields !== undefined) {
      for (const fieldName of Object.keys(body.custom_fields)) {
        const fieldDenied = await requireWorkspaceGrant(env, access, "contact", "update_custom_field", fieldName);
        if (fieldDenied) return fieldDenied;
      }
    }
    if (!stage && !status && body.owner === undefined && body.next_follow_up_at === undefined && body.custom_fields === undefined) return json({ error: "No supported fields supplied" }, 400);
    const before = await env.DB.prepare("SELECT * FROM contacts WHERE workspace_id=? AND id=?")
      .bind(workspaceId, contactMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Contact not found" }, 404);
    let nextCustomFields = String(before.custom_fields || "{}");
    if (body.custom_fields !== undefined) {
      try { nextCustomFields = await mergeCustomFieldValues(env, workspaceId, "contact", before.custom_fields, body.custom_fields); }
      catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid custom fields" }, 400); }
    }
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const after = {
      ...before, stage: stage || before.stage, status: status || before.status,
      owner: body.owner === undefined ? before.owner : owner,
      next_follow_up_at: body.next_follow_up_at === undefined ? before.next_follow_up_at : followUp,
      custom_fields: body.custom_fields === undefined ? before.custom_fields : nextCustomFields,
      updated_at: updatedAt,
    };
    const originalUpdatedAt = expectedUpdatedAt || String(before.updated_at);
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE contacts SET
        stage=COALESCE(?,stage),status=COALESCE(?,status),
        owner=CASE WHEN ?=1 THEN ? ELSE owner END,
        next_follow_up_at=CASE WHEN ?=1 THEN ? ELSE next_follow_up_at END,
        custom_fields=CASE WHEN ?=1 THEN ? ELSE custom_fields END,
        updated_at=? WHERE workspace_id=? AND id=? AND updated_at=?`)
        .bind(stage, status, body.owner === undefined ? 0 : 1, owner,
          body.next_follow_up_at === undefined ? 0 : 1, followUp,
          body.custom_fields === undefined ? 0 : 1, nextCustomFields, updatedAt,
          workspaceId, contactMatch[1], originalUpdatedAt),
      await contactUpdateAuditStatement(env, access, request, contactMatch[1], before, after, updatedAt),
    ]);
    if (!result[0].meta.changes) return json({ error: "Contact changed since it was loaded", code: "edit_conflict" }, 409);
    if ((stage && stage !== before.stage) || (status && status !== before.status)) {
      await runContactAutomations(env, access, after, requestId(request), "contact.lifecycle_changed");
    }
    const readableContactFields = await readableContactCustomFieldKeys(env, access);
    const visibleCustomFields = redactContactCustomFields(
      { custom_fields: nextCustomFields },
      readableContactFields,
    ).custom_fields;
    return json({ ok: true, updated_at: updatedAt, custom_fields: visibleCustomFields });
  }

  const noteMatch = url.pathname.match(/^\/v1\/admin\/contacts\/([^/]+)\/notes$/);
  if (noteMatch && request.method === "POST") {
    const denied = await requireWorkspaceGrant(env, access, "contact", "note");
    if (denied) return denied;
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    const noteBody = optionalString(body.body, "body", 4000);
    if (!noteBody) return json({ error: "A note is required" }, 400);
    const exists = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=?").bind(workspaceId, noteMatch[1]).first();
    if (!exists) return json({ error: "Contact not found" }, 404);
    const authenticatedEmail = access.email;
    const createdAt = new Date().toISOString();
    const noteId = id("note");
    await env.DB.prepare("INSERT INTO notes(id,workspace_id,contact_id,author,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .bind(noteId, workspaceId, noteMatch[1], authenticatedEmail, noteBody, createdAt, createdAt).run();
    await audit(env, access, request, "note.created", "note", noteId, null, { contact_id: noteMatch[1] });
    return json({ ok: true, note: { id: noteId, body: noteBody, author: authenticatedEmail, created_at: createdAt, updated_at: createdAt } }, 201);
  }

  const contactNoteRecordMatch = url.pathname.match(/^\/v1\/admin\/notes\/(note_[a-f0-9]{32})$/);
  if (contactNoteRecordMatch && (request.method === "PATCH" || request.method === "DELETE")) {
    const denied = await requireWorkspaceGrant(env, access, "contact", "note");
    if (denied) return denied;
    const body = await readJson(request);
    const before = await env.DB.prepare("SELECT * FROM notes WHERE workspace_id=? AND id=?")
      .bind(workspaceId, contactNoteRecordMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Contact note not found" }, 404);
    if (!isWorkspaceAdmin(access) && before.author !== access.email) {
      return json({ error: "Only the note author or a workspace admin can change this note" }, 403);
    }
    const allowed = request.method === "PATCH" ? new Set(["body", "if_updated_at"]) : new Set(["if_updated_at"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) return json({ error: "Unsupported contact note field" }, 400);
    const expectedUpdatedAt = optionalString(body.if_updated_at, "if_updated_at", 50);
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required" }, 400);
    const currentUpdatedAt = String(before.updated_at || before.created_at);
    if (expectedUpdatedAt !== currentUpdatedAt) {
      return json({ error: "Contact note changed since it was loaded", code: "edit_conflict" }, 409);
    }
    const bodyFingerprint = async (value: unknown) => ({
      sha256: await sha256(String(value || "")),
      length: String(value || "").length,
    });
    const beforeState = {
      id: before.id,
      contact_id: before.contact_id,
      author: before.author,
      body: await bodyFingerprint(before.body),
      updated_at: currentUpdatedAt,
    };
    const changedAt = new Date(Math.max(Date.now(), Date.parse(currentUpdatedAt) + 1)).toISOString();
    const ip = request.headers.get("cf-connecting-ip") || "";
    const ipHash = ip ? await sha256(ip) : null;
    if (request.method === "PATCH") {
      const noteBody = optionalString(body.body, "body", 4000);
      if (!noteBody) return json({ error: "A note is required" }, 400);
      const afterState = { ...beforeState, body: await bodyFingerprint(noteBody), updated_at: changedAt };
      const changed = await env.DB.batch([
        env.DB.prepare(`UPDATE notes SET body=?,updated_at=? WHERE workspace_id=? AND id=? AND COALESCE(updated_at,created_at)=?`)
          .bind(noteBody, changedAt, workspaceId, contactNoteRecordMatch[1], expectedUpdatedAt),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
          SELECT ?,?,'user',?,'contact.note_updated','contact',?,?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM notes WHERE workspace_id=? AND id=? AND updated_at=?)`)
          .bind(id("aud"), workspaceId, access.email, before.contact_id, JSON.stringify(beforeState), JSON.stringify(afterState),
            requestId(request), ipHash, changedAt, workspaceId, contactNoteRecordMatch[1], changedAt),
      ]);
      if (!changed[0].meta.changes) return json({ error: "Contact note changed since it was loaded", code: "edit_conflict" }, 409);
      return json({ ok: true, note: { ...before, body: noteBody, updated_at: changedAt } });
    }
    const deleted = await env.DB.batch([
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'contact.note_deleted','contact',?,?,NULL,?,?,?
        WHERE EXISTS(SELECT 1 FROM notes WHERE workspace_id=? AND id=? AND COALESCE(updated_at,created_at)=?)`)
        .bind(id("aud"), workspaceId, access.email, before.contact_id, JSON.stringify(beforeState),
          requestId(request), ipHash, changedAt, workspaceId, contactNoteRecordMatch[1], expectedUpdatedAt),
      env.DB.prepare("DELETE FROM notes WHERE workspace_id=? AND id=? AND COALESCE(updated_at,created_at)=?")
        .bind(workspaceId, contactNoteRecordMatch[1], expectedUpdatedAt),
    ]);
    if (!deleted[1].meta.changes) return json({ error: "Contact note changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/operations-health-policy" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    return json({
      policy: await operationsHealthPolicy(env, workspaceId),
      contract: {
        target_range: { min: 90, max: 100 },
        consecutive_action_range: { min: 1, max: 10 },
        escalation: { maximum_steps: 3, delay_minutes: { min: 1, max: 1440 } },
        recovery_notifications_optional: true,
        incident_severity: "action",
      },
    });
  }

  if (url.pathname === "/v1/admin/operations-health-policy" && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const allowed = new Set([
      "expected_revision", "target_healthy_percentage",
      "incident_after_consecutive_action", "notify_on_recovery", "escalation_delays_minutes",
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return json({ error: "Unsupported operations health policy field" }, 400);
    }
    const expectedRevision = Number(body.expected_revision);
    const target = Number(body.target_healthy_percentage);
    const consecutive = Number(body.incident_after_consecutive_action);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return json({ error: "expected_revision must be a non-negative integer" }, 400);
    }
    if (!Number.isFinite(target) || target < 90 || target > 100) {
      return json({ error: "target_healthy_percentage must be between 90 and 100" }, 400);
    }
    if (!Number.isInteger(consecutive) || consecutive < 1 || consecutive > 10) {
      return json({ error: "incident_after_consecutive_action must be between 1 and 10" }, 400);
    }
    if (typeof body.notify_on_recovery !== "boolean") {
      return json({ error: "notify_on_recovery must be boolean" }, 400);
    }
    const escalationDelays = body.escalation_delays_minutes;
    if (!Array.isArray(escalationDelays) || escalationDelays.length > 3 ||
        escalationDelays.some((delay) => !Number.isInteger(delay) || delay < 1 || delay > 1440) ||
        escalationDelays.some((delay, index) => index > 0 && delay <= escalationDelays[index - 1])) {
      return json({ error: "escalation_delays_minutes must contain up to three increasing whole minutes from 1 to 1440" }, 400);
    }
    const before = await operationsHealthPolicy(env, workspaceId);
    if (before.revision !== expectedRevision) {
      return json({ error: "Operations health policy changed since it was loaded", code: "edit_conflict" }, 409);
    }
    const now = new Date().toISOString();
    const changeId = id("ohpchange");
    const nextRevision = expectedRevision + 1;
    const after: OperationsHealthPolicy = {
      target_healthy_percentage: target,
      incident_after_consecutive_action: consecutive,
      notify_on_recovery: body.notify_on_recovery,
      escalation_delays_minutes: escalationDelays,
      revision: nextRevision,
      change_id: changeId,
      updated_by: access.email,
      updated_at: now,
    };
    const mutation = expectedRevision === 0
      ? env.DB.prepare(`INSERT OR IGNORE INTO operations_health_policies
          (workspace_id,target_healthy_percentage,incident_after_consecutive_action,notify_on_recovery,
           escalation_delays_minutes,revision,change_id,updated_by,created_at,updated_at)
          VALUES(?,?,?,?,?,1,?,?,?,?)`)
        .bind(workspaceId, target, consecutive, body.notify_on_recovery ? 1 : 0,
          JSON.stringify(escalationDelays), changeId, access.email, now, now)
      : env.DB.prepare(`UPDATE operations_health_policies SET
          target_healthy_percentage=?,incident_after_consecutive_action=?,notify_on_recovery=?,
          escalation_delays_minutes=?,revision=revision+1,change_id=?,updated_by=?,updated_at=?
          WHERE workspace_id=? AND revision=?`)
        .bind(target, consecutive, body.notify_on_recovery ? 1 : 0,
          JSON.stringify(escalationDelays), changeId, access.email, now, workspaceId, expectedRevision);
    const ip = request.headers.get("cf-connecting-ip");
    const policyAudit = env.DB.prepare(`INSERT INTO audit_log
      (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
      SELECT ?,?,'user',?,'operations.health_policy_updated','workspace',?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM operations_health_policies
        WHERE workspace_id=? AND revision=? AND change_id=?)`)
      .bind(id("audit"), workspaceId, access.email, workspaceId, JSON.stringify(before), JSON.stringify(after),
        requestId(request), ip ? await sha256(ip) : null, now, workspaceId, nextRevision, changeId);
    const changed = await env.DB.batch([mutation, policyAudit]);
    if (!changed[0].meta.changes || !changed[1].meta.changes) {
      return json({ error: "Operations health policy changed since it was loaded", code: "edit_conflict" }, 409);
    }
    return json({ ok: true, policy: after });
  }

  if (url.pathname === "/v1/admin/operations-health" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const now = new Date();
    const nowIso = now.toISOString();
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60_000).toISOString();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000).toISOString();
    const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60_000).toISOString();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const [scheduler, webhooks, automations, agentWork, resend, operationLease] = await Promise.all([
      env.DB.prepare(`SELECT job,MAX(created_at) last_seen_at,COUNT(*) retained_requests
        FROM scheduler_requests GROUP BY job ORDER BY job LIMIT 10`).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT
        SUM(CASE WHEN status='failed' AND updated_at>=? THEN 1 ELSE 0 END) failed_24h,
        SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) retrying,
        SUM(CASE WHEN status='retrying' AND next_attempt_at<=? THEN 1 ELSE 0 END) due,
        SUM(CASE WHEN status='processing' AND updated_at<=? THEN 1 ELSE 0 END) stale_processing,
        MAX(CASE WHEN status='succeeded' THEN updated_at END) last_succeeded_at
        FROM webhook_deliveries WHERE workspace_id=? AND direction='outbound'`)
        .bind(dayAgo, nowIso, tenMinutesAgo, workspaceId).first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT
        SUM(CASE WHEN status='failed' AND started_at>=? THEN 1 ELSE 0 END) failed_24h,
        SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
        SUM(CASE WHEN status='running' AND started_at<=? THEN 1 ELSE 0 END) stale_running,
        MAX(CASE WHEN status='succeeded' THEN finished_at END) last_succeeded_at
        FROM automation_runs WHERE workspace_id=?`)
        .bind(dayAgo, new Date(now.getTime() - 5 * 60_000).toISOString(), workspaceId)
        .first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT
        SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
        MIN(CASE WHEN status='queued' THEN created_at END) oldest_queued_at,
        SUM(CASE WHEN status='claimed' AND claim_expires_at>? THEN 1 ELSE 0 END) active_claims,
        SUM(CASE WHEN status='claimed' AND claim_expires_at<=? THEN 1 ELSE 0 END) expired_claims,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        MAX(CASE WHEN status='completed' THEN completed_at END) last_completed_at
        FROM agent_work_items WHERE workspace_id=?`)
        .bind(nowIso, nowIso, workspaceId).first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT
        SUM(CASE WHEN status='failed' AND updated_at>=? THEN 1 ELSE 0 END) failed_24h,
        SUM(CASE WHEN status='pending' AND updated_at<=? THEN 1 ELSE 0 END) stale_pending,
        MAX(CASE WHEN status='succeeded' THEN updated_at END) last_succeeded_at
        FROM resend_deliveries WHERE workspace_id=?`)
        .bind(dayAgo, tenMinutesAgo, workspaceId).first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT operation,lease_until,acquired_at FROM workspace_operation_leases
        WHERE workspace_id=? AND lease_until>?`).bind(workspaceId, nowIso).first<Record<string, unknown>>(),
    ]);
    const schedulerRow = scheduler.results.find((row) => row.job === "webhook-retries") || null;
    const schedulerLastSeen = schedulerRow?.last_seen_at ? String(schedulerRow.last_seen_at) : null;
    const schedulerStatus = !schedulerLastSeen || schedulerLastSeen < tenMinutesAgo
      ? "action" : schedulerLastSeen < threeMinutesAgo ? "watch" : "healthy";
    const webhookStatus = Number(webhooks?.stale_processing || 0) > 0 || Number(webhooks?.failed_24h || 0) > 0
      ? "action" : Number(webhooks?.due || 0) > 0 || Number(webhooks?.retrying || 0) > 0 ? "watch" : "healthy";
    const automationStatus = Number(automations?.stale_running || 0) > 0
      ? "action" : Number(automations?.failed_24h || 0) > 0 ? "watch" : "healthy";
    const oldestQueuedAt = agentWork?.oldest_queued_at ? String(agentWork.oldest_queued_at) : null;
    const agentStatus = Number(agentWork?.expired_claims || 0) > 0 || Number(agentWork?.failed || 0) > 0
      ? "action" : oldestQueuedAt && oldestQueuedAt <= fifteenMinutesAgo ? "watch" : "healthy";
    const resendStatus = Number(resend?.stale_pending || 0) > 0 || Number(resend?.failed_24h || 0) > 0
      ? "action" : "healthy";
    const components = [
      {
        id: "scheduler", label: "Retry scheduler", status: schedulerStatus,
        summary: schedulerStatus === "healthy" ? "Heartbeat current"
          : schedulerStatus === "watch" ? "Heartbeat delayed" : "Heartbeat missing",
        details: schedulerLastSeen
          ? `Last signed retry sweep ${schedulerLastSeen}`
          : "No retained signed retry sweep was found",
        counts: { retained_requests: Number(schedulerRow?.retained_requests || 0) },
        last_event_at: schedulerLastSeen,
      },
      {
        id: "webhooks", label: "Outbound webhooks", status: webhookStatus,
        summary: `${Number(webhooks?.retrying || 0)} retrying · ${Number(webhooks?.failed_24h || 0)} failed in 24h`,
        details: `${Number(webhooks?.due || 0)} due now · ${Number(webhooks?.stale_processing || 0)} stale delivery lease(s)`,
        counts: {
          retrying: Number(webhooks?.retrying || 0), due: Number(webhooks?.due || 0),
          stale_processing: Number(webhooks?.stale_processing || 0), failed_24h: Number(webhooks?.failed_24h || 0),
        },
        last_event_at: webhooks?.last_succeeded_at ? String(webhooks.last_succeeded_at) : null,
      },
      {
        id: "automations", label: "Workflow runs", status: automationStatus,
        summary: `${Number(automations?.running || 0)} running · ${Number(automations?.failed_24h || 0)} failed in 24h`,
        details: `${Number(automations?.stale_running || 0)} run(s) beyond the five-minute execution lease`,
        counts: {
          running: Number(automations?.running || 0), stale_running: Number(automations?.stale_running || 0),
          failed_24h: Number(automations?.failed_24h || 0),
        },
        last_event_at: automations?.last_succeeded_at ? String(automations.last_succeeded_at) : null,
      },
      {
        id: "agents", label: "Agent work queue", status: agentStatus,
        summary: `${Number(agentWork?.queued || 0)} queued · ${Number(agentWork?.active_claims || 0)} claimed`,
        details: `${Number(agentWork?.failed || 0)} failed · ${Number(agentWork?.expired_claims || 0)} expired claim(s)`,
        counts: {
          queued: Number(agentWork?.queued || 0), active_claims: Number(agentWork?.active_claims || 0),
          expired_claims: Number(agentWork?.expired_claims || 0), failed: Number(agentWork?.failed || 0),
        },
        last_event_at: agentWork?.last_completed_at ? String(agentWork.last_completed_at) : oldestQueuedAt,
      },
      {
        id: "email", label: "Transactional email", status: resendStatus,
        summary: `${Number(resend?.failed_24h || 0)} failed in 24h`,
        details: `${Number(resend?.stale_pending || 0)} delivery attempt(s) pending longer than ten minutes`,
        counts: {
          failed_24h: Number(resend?.failed_24h || 0), stale_pending: Number(resend?.stale_pending || 0),
        },
        last_event_at: resend?.last_succeeded_at ? String(resend.last_succeeded_at) : null,
      },
    ];
    const status = components.some((component) => component.status === "action")
      ? "action" : components.some((component) => component.status === "watch") ? "watch" : "healthy";
    const [snapshots, incidents, alertEndpoints, healthWindows] = await Promise.all([
      env.DB.prepare(`SELECT observed_minute,status,attention_count,components
        FROM operations_health_snapshots WHERE workspace_id=?
        ORDER BY observed_minute DESC LIMIT 168`).bind(workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT id,status,severity,component_ids,opened_at,last_observed_at,resolved_at,
          escalation_delays_minutes,escalated_steps
        FROM operations_health_incidents WHERE workspace_id=?
        ORDER BY opened_at DESC LIMIT 20`).bind(workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT COUNT(*) total FROM webhook_endpoints
        WHERE workspace_id=? AND direction='outbound' AND active=1
          AND (event_types='[]' OR EXISTS (
            SELECT 1 FROM json_each(event_types)
            WHERE value IN ('operations.health.action','operations.health.escalated','operations.health.recovered','*')
          ))`).bind(workspaceId).first<{ total: number }>(),
      env.DB.prepare(`SELECT
        SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) total_24h,
        SUM(CASE WHEN created_at>=? AND status='healthy' THEN 1 ELSE 0 END) healthy_24h,
        SUM(CASE WHEN created_at>=? AND status='watch' THEN 1 ELSE 0 END) watch_24h,
        SUM(CASE WHEN created_at>=? AND status='action' THEN 1 ELSE 0 END) action_24h,
        SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) total_7d,
        SUM(CASE WHEN created_at>=? AND status='healthy' THEN 1 ELSE 0 END) healthy_7d,
        SUM(CASE WHEN created_at>=? AND status='watch' THEN 1 ELSE 0 END) watch_7d,
        SUM(CASE WHEN created_at>=? AND status='action' THEN 1 ELSE 0 END) action_7d,
        COUNT(*) total_30d,
        SUM(CASE WHEN status='healthy' THEN 1 ELSE 0 END) healthy_30d,
        SUM(CASE WHEN status='watch' THEN 1 ELSE 0 END) watch_30d,
        SUM(CASE WHEN status='action' THEN 1 ELSE 0 END) action_30d
        FROM operations_health_snapshots WHERE workspace_id=?`)
        .bind(
          new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
          new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
          new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
          new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
          new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString(),
          new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString(),
          new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString(),
          new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString(),
          workspaceId,
        ).first<Record<string, unknown>>(),
    ]);
    const history = snapshots.results.map((snapshot) => ({
      observed_at: String(snapshot.observed_minute),
      status: String(snapshot.status),
      attention_count: Number(snapshot.attention_count || 0),
      components: JSON.parse(String(snapshot.components || "[]")),
    }));
    const healthPolicy = await operationsHealthPolicy(env, workspaceId);
    return json({
      generated_at: nowIso,
      status,
      attention_count: components.filter((component) => component.status !== "healthy").length,
      components,
      history,
      history_window: {
        retained_days: 30,
        returned_snapshots: history.length,
        healthy: history.filter((snapshot) => snapshot.status === "healthy").length,
        watch: history.filter((snapshot) => snapshot.status === "watch").length,
        action: history.filter((snapshot) => snapshot.status === "action").length,
      },
      slo_windows: [
        { label: "24H", total: Number(healthWindows?.total_24h || 0), healthy: Number(healthWindows?.healthy_24h || 0),
          watch: Number(healthWindows?.watch_24h || 0), action: Number(healthWindows?.action_24h || 0) },
        { label: "7D", total: Number(healthWindows?.total_7d || 0), healthy: Number(healthWindows?.healthy_7d || 0),
          watch: Number(healthWindows?.watch_7d || 0), action: Number(healthWindows?.action_7d || 0) },
        { label: "30D", total: Number(healthWindows?.total_30d || 0), healthy: Number(healthWindows?.healthy_30d || 0),
          watch: Number(healthWindows?.watch_30d || 0), action: Number(healthWindows?.action_30d || 0) },
      ].map((window) => ({
        ...window,
        healthy_percentage: window.total ? Math.round((window.healthy / window.total) * 10_000) / 100 : null,
      })),
      incidents: incidents.results.map((incident) => ({
        id: String(incident.id),
        status: String(incident.status),
        severity: String(incident.severity),
        component_ids: JSON.parse(String(incident.component_ids || "[]")),
        opened_at: String(incident.opened_at),
        last_observed_at: String(incident.last_observed_at),
        resolved_at: incident.resolved_at ? String(incident.resolved_at) : null,
        escalation_delays_minutes: operationsEscalationDelays(incident.escalation_delays_minutes),
        escalated_steps: operationsEscalationDelays(incident.escalated_steps),
      })),
      alerting: {
        destination: "outbound_webhook",
        subscribed_endpoints: Number(alertEndpoints?.total || 0),
        event_types: ["operations.health.action", "operations.health.escalated", "operations.health.recovered"],
        retry_contract: "signed outbound webhook delivery",
      },
      policy: healthPolicy,
      active_operation: operationLease ? {
        operation: String(operationLease.operation),
        acquired_at: String(operationLease.acquired_at),
        lease_until: String(operationLease.lease_until),
      } : null,
      safety: {
        admin_only: true,
        workspace_data_scoped: true,
        scheduler_heartbeat_global: true,
        record_content_included: false,
        derived_without_mutation: true,
      },
    });
  }

  if (url.pathname === "/v1/admin/control-center" && request.method === "GET") {
    const canReadOpportunities = await hasWorkspaceGrant(env, access, "opportunity", "read");
    const [workspace, pipelines, stages, opportunities, tasks, automations, runs, webhooks, deliveries, proposals, agentRuns, agentPolicy, checks, audits, companies, savedViews, agentWorkItems] = await Promise.all([
      env.DB.prepare("SELECT id,slug,name,status,settings,onboarding_status FROM workspaces WHERE id=?").bind(workspaceId).first(),
      env.DB.prepare("SELECT * FROM pipelines WHERE workspace_id=? AND active=1 ORDER BY created_at").bind(workspaceId).all(),
      env.DB.prepare("SELECT * FROM pipeline_stages WHERE workspace_id=? ORDER BY pipeline_id,position").bind(workspaceId).all(),
      env.DB.prepare(`SELECT o.*,c.email,c.first_name,c.last_name,c.company,s.name stage_name,s.color stage_color
        FROM opportunities o JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
        JOIN pipeline_stages s ON s.id=o.stage_id AND s.workspace_id=o.workspace_id
        WHERE o.workspace_id=? ORDER BY o.updated_at DESC LIMIT 500`).bind(workspaceId).all(),
      env.DB.prepare(`SELECT t.*,c.email contact_email,o.name opportunity_name FROM tasks t
        LEFT JOIN contacts c ON c.id=t.contact_id AND c.workspace_id=t.workspace_id
        LEFT JOIN opportunities o ON o.id=t.opportunity_id AND o.workspace_id=t.workspace_id
        WHERE t.workspace_id=? ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END,t.due_at LIMIT 500`).bind(workspaceId).all(),
      env.DB.prepare("SELECT * FROM automation_rules WHERE workspace_id=? ORDER BY updated_at DESC").bind(workspaceId).all(),
      env.DB.prepare(`SELECT r.*,a.name automation_name,a.trigger_type
        FROM automation_runs r JOIN automation_rules a ON a.id=r.rule_id AND a.workspace_id=r.workspace_id
        WHERE r.workspace_id=? ORDER BY r.started_at DESC LIMIT 100`).bind(workspaceId).all(),
      env.DB.prepare("SELECT id,name,direction,url,event_types,payload_preset,secret_prefix,provider_credential_prefix,active,created_at,updated_at FROM webhook_endpoints WHERE workspace_id=? ORDER BY created_at DESC").bind(workspaceId).all(),
      env.DB.prepare(`SELECT d.*,e.name endpoint_name,e.url endpoint_url
        FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id AND e.workspace_id=d.workspace_id
        WHERE d.workspace_id=? ORDER BY d.created_at DESC LIMIT 100`).bind(workspaceId).all(),
      env.DB.prepare(`SELECT p.*,a.name origin_credential_name,a.provider origin_provider,
          vp.email visitor_email,vp.first_name visitor_first_name,vp.last_name visitor_last_name,
          vp.company_name visitor_company_name,vp.provider visitor_provider,vp.consent_status visitor_consent_status,
          vp.visit_count visitor_visit_count,vp.high_intent_count visitor_high_intent_count,
          vp.last_seen_at visitor_last_seen_at,vp.latest_url visitor_latest_url,vp.revision visitor_revision
        FROM agent_proposals p
        LEFT JOIN agent_credentials a ON a.id=p.credential_id AND a.workspace_id=p.workspace_id
        LEFT JOIN visitor_profiles vp ON vp.workspace_id=p.workspace_id
          AND vp.id=json_extract(p.proposed_action,'$.visitor_profile_id')
        WHERE p.workspace_id=? ORDER BY p.created_at DESC LIMIT 100`).bind(workspaceId).all(),
      env.DB.prepare("SELECT * FROM agent_runs WHERE workspace_id=? ORDER BY started_at DESC LIMIT 25").bind(workspaceId).all(),
      env.DB.prepare("SELECT * FROM agent_policies WHERE workspace_id=?").bind(workspaceId).first(),
      env.DB.prepare("SELECT * FROM onboarding_checks WHERE workspace_id=? ORDER BY created_at").bind(workspaceId).all(),
      env.DB.prepare("SELECT * FROM audit_log WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").bind(workspaceId).all(),
      env.DB.prepare(`SELECT co.id,co.name,co.domain,co.website,co.industry,co.owner,co.updated_at,
        COUNT(DISTINCT c.id) contacts,
        COUNT(DISTINCT CASE WHEN c.status='lead' THEN c.id END) leads,
        COALESCE(SUM(CASE WHEN o.status='won' THEN o.value ELSE 0 END),0) revenue,
        COALESCE(SUM(CASE WHEN o.status='open' THEN o.value ELSE 0 END),0) open_pipeline,
        MAX(COALESCE(o.updated_at,c.last_activity_at,c.updated_at,co.updated_at)) last_activity_at
        FROM companies co
        LEFT JOIN contacts c ON c.company_id=co.id AND c.workspace_id=co.workspace_id
        LEFT JOIN opportunities o ON o.contact_id=c.id AND o.workspace_id=co.workspace_id
        WHERE co.workspace_id=?
        GROUP BY co.id ORDER BY last_activity_at DESC,co.name LIMIT 250`).bind(workspaceId).all(),
      env.DB.prepare(`SELECT * FROM saved_views WHERE workspace_id=? AND object_type='contact'
        AND (visibility='workspace' OR created_by=?) ORDER BY CASE WHEN created_by=? THEN 0 ELSE 1 END,updated_at DESC`)
        .bind(workspaceId, access.email, access.email).all(),
      env.DB.prepare(`SELECT w.*,r.name automation_name,c.email contact_email,o.name opportunity_name,
        a.name claimed_by_name,a.provider claimed_by_provider
        FROM agent_work_items w
        LEFT JOIN automation_rules r ON r.id=w.automation_rule_id AND r.workspace_id=w.workspace_id
        LEFT JOIN contacts c ON c.id=w.contact_id AND c.workspace_id=w.workspace_id
        LEFT JOIN opportunities o ON o.id=w.opportunity_id AND o.workspace_id=w.workspace_id
        LEFT JOIN agent_credentials a ON a.id=w.claimed_by_credential_id AND a.workspace_id=w.workspace_id
        WHERE w.workspace_id=? ORDER BY w.created_at DESC LIMIT 100`).bind(workspaceId).all(),
    ]);
    const [viewDefinitions, viewReadableKeys, opportunityReadableKeys, automationDefinitions] = await Promise.all([
      env.DB.prepare(`SELECT field_key FROM custom_field_definitions
        WHERE workspace_id=? AND object_type='contact' AND active=1 ORDER BY position,id`)
        .bind(workspaceId).all<{ field_key: string }>(),
      readableContactCustomFieldKeys(env, access),
      readableOpportunityCustomFieldKeys(env, access),
      env.DB.prepare(`SELECT * FROM custom_field_definitions
        WHERE workspace_id=? AND active=1 ORDER BY object_type,position,id`)
        .bind(workspaceId).all<CustomFieldDefinition>(),
    ]);
    const visibleViewCustomKeys = new Set(viewDefinitions.results
      .map((definition) => definition.field_key)
      .filter((key) => viewReadableKeys === null || viewReadableKeys.has(key)));
    const automationHealth = await Promise.all(automations.results.map(async (automation) => ({
      ...automation,
      ...(await automationDefinitionHealth(automation, automationDefinitions.results)),
    })));
    return json({
      workspace, role: access.role, current_user: { email: access.email, role: access.role },
      pipelines: pipelines.results, stages: stages.results,
      opportunities: canReadOpportunities ? opportunities.results.map((opportunity) =>
        redactOpportunityCustomFields(opportunity as Record<string, unknown>, opportunityReadableKeys)) : [],
      tasks: canReadOpportunities ? tasks.results : tasks.results.filter((task) => !task.opportunity_id),
      automations: automationHealth.map((automation) => ({
        ...automation,
        metadata_error: isWorkspaceAdmin(access) ? automation.metadata_error : automation.metadata_status === "blocked"
          ? "Workflow definition needs administrator review" : null,
      })),
      runs: canReadOpportunities ? runs.results : runs.results.filter((run) => run.record_type !== "opportunity"),
      webhooks: webhooks.results, deliveries: deliveries.results,
      proposals: canReadOpportunities ? proposals.results : proposals.results.filter((proposal) => !proposal.opportunity_id),
      agent_runs: agentRuns.results, agent_policy: agentPolicy,
      checks: checks.results,
      audits: canReadOpportunities ? audits.results : audits.results.filter((entry) =>
        entry.entity_type !== "opportunity" && entry.entity_type !== "opportunity_task"),
      companies: canReadOpportunities ? companies.results : companies.results.map((company) => ({
        ...company, revenue: 0, open_pipeline: 0,
      })),
      saved_views: savedViews.results.map((view) =>
        effectiveSavedView(view as Record<string, unknown>, visibleViewCustomKeys)),
      agent_work_items: canReadOpportunities ? agentWorkItems.results :
        agentWorkItems.results.filter((item) => !item.opportunity_id),
    });
  }

  if (url.pathname === "/v1/admin/agent-policy" && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    if (body.agent_access_enabled === undefined && body.workspace_rate_limit_per_minute === undefined) {
      return json({ error: "An agent policy field is required" }, 400);
    }
    if (body.agent_access_enabled !== undefined && typeof body.agent_access_enabled !== "boolean") {
      return json({ error: "agent_access_enabled must be a boolean" }, 400);
    }
    const before = await env.DB.prepare("SELECT * FROM agent_policies WHERE workspace_id=?")
      .bind(workspaceId).first<Record<string, unknown>>();
    if (!before) return json({ error: "Revenue-agent policy is not configured" }, 409);
    const enabled = body.agent_access_enabled === undefined ? Number(before.agent_access_enabled) : Number(body.agent_access_enabled);
    const workspaceLimit = body.workspace_rate_limit_per_minute === undefined
      ? Number(before.workspace_rate_limit_per_minute)
      : boundedNumber(body.workspace_rate_limit_per_minute, "workspace_rate_limit_per_minute", 1, 1000, 120);
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE agent_policies
      SET agent_access_enabled=?,workspace_rate_limit_per_minute=?,updated_at=? WHERE workspace_id=?`)
      .bind(enabled, workspaceLimit, updatedAt, workspaceId).run();
    const after = { ...before, agent_access_enabled: enabled, workspace_rate_limit_per_minute: workspaceLimit, updated_at: updatedAt };
    await audit(env, access, request, "agent_policy.updated", "agent_policy", String(before.id), before, after);
    return json({ ok: true, policy: after });
  }

  if (url.pathname === "/v1/admin/opportunities" && request.method === "POST") {
    const denied = await requireWorkspaceGrant(env, access, "opportunity", "create");
    if (denied) return denied;
    const body = await readJson(request);
    const contactId = optionalString(body.contact_id, "contact_id", 80);
    const pipelineId = optionalString(body.pipeline_id, "pipeline_id", 80);
    const stageId = optionalString(body.stage_id, "stage_id", 80);
    const name = optionalString(body.name, "name", 200);
    if (!contactId || !pipelineId || !stageId || !name) return json({ error: "contact_id, pipeline_id, stage_id, and name are required" }, 400);
    const valid = await env.DB.prepare(`SELECT s.probability,s.category FROM pipeline_stages s
      JOIN pipelines p ON p.id=s.pipeline_id AND p.workspace_id=s.workspace_id
      JOIN contacts c ON c.id=? AND c.workspace_id=s.workspace_id
      WHERE s.workspace_id=? AND s.id=? AND p.id=?`).bind(contactId, workspaceId, stageId, pipelineId).first<{ probability: number; category: string }>();
    if (!valid) return json({ error: "Contact, pipeline, or stage is invalid" }, 400);
    const opportunityId = id("opp");
    const now = new Date().toISOString();
    const value = boundedNumber(body.value, "value", 0, 100_000_000, 0);
    const probability = ["won", "lost"].includes(valid.category)
      ? valid.probability
      : boundedNumber(body.probability, "probability", 0, 100, valid.probability);
    const initialStatus = valid.category === "won" ? "won" : valid.category === "lost" ? "lost" : "open";
    const expectedCloseAt = optionalString(body.expected_close_at, "expected_close_at", 50);
    if (expectedCloseAt && !Number.isFinite(Date.parse(expectedCloseAt))) return json({ error: "expected_close_at is invalid" }, 400);
    const createdOpportunity = {
      id: opportunityId, workspace_id: workspaceId, pipeline_id: pipelineId, stage_id: stageId, contact_id: contactId,
      name, status: initialStatus, value, currency: (optionalString(body.currency, "currency", 3) || "USD").toUpperCase(),
      probability, owner: optionalString(body.owner, "owner", 254),
      expected_close_at: expectedCloseAt,
      last_activity_at: now, next_step: optionalString(body.next_step, "next_step", 500),
      created_at: now, updated_at: now,
    };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO opportunities
        (id,workspace_id,pipeline_id,stage_id,contact_id,name,status,value,currency,probability,owner,expected_close_at,last_activity_at,next_step,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(opportunityId, workspaceId, pipelineId, stageId, contactId, name, initialStatus, value,
          (optionalString(body.currency, "currency", 3) || "USD").toUpperCase(), probability,
          optionalString(body.owner, "owner", 254), expectedCloseAt,
          now, optionalString(body.next_step, "next_step", 500), now, now),
      await auditStatement(env, access, request, "opportunity.created", "opportunity", opportunityId, null,
        { name, value, pipeline_id: pipelineId, stage_id: stageId }),
    ]);
    await runOpportunityAutomations(env, access, createdOpportunity, requestId(request), "opportunity.created");
    return json({
      ok: true,
      id: opportunityId,
      opportunity: createdOpportunity,
    }, 201);
  }

  const opportunityMatch = url.pathname.match(/^\/v1\/admin\/opportunities\/([^/]+)$/);
  const opportunityIntelligenceMatch = url.pathname.match(/^\/v1\/admin\/opportunities\/([^/]+)\/intelligence$/);
  if (opportunityIntelligenceMatch && request.method === "GET") {
    const denied = await requireWorkspaceGrant(env, access, "opportunity", "read");
    if (denied) return denied;
    const opportunity = await env.DB.prepare(`SELECT o.*,s.position stage_position
      FROM opportunities o JOIN pipeline_stages s ON s.id=o.stage_id AND s.workspace_id=o.workspace_id
      WHERE o.workspace_id=? AND o.id=?`)
      .bind(workspaceId, opportunityIntelligenceMatch[1]).first<Record<string, unknown>>();
    if (!opportunity) return json({ error: "Opportunity not found" }, 404);
    const [signalRows, latestCallRow] = await Promise.all([
      env.DB.prepare(`SELECT id,type,title,body,metadata,occurred_at
      FROM activities WHERE workspace_id=? AND contact_id=?
      AND type IN ('sales.call_analyzed','email.received','email.sent','calendar.meeting_scheduled','calendar.meeting_completed')
      ORDER BY occurred_at DESC,id DESC LIMIT 50`)
        .bind(workspaceId, opportunity.contact_id).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT id,type,title,body,metadata,occurred_at
        FROM activities WHERE workspace_id=? AND contact_id=? AND type='sales.call_analyzed'
        ORDER BY occurred_at DESC,id DESC LIMIT 1`)
        .bind(workspaceId, opportunity.contact_id).first<Record<string, unknown>>(),
    ]);
    const callAlreadyVisible = Boolean(latestCallRow && signalRows.results.some((signal) => signal.id === latestCallRow.id));
    const boundedRows = callAlreadyVisible || !latestCallRow
      ? [...signalRows.results]
      : [...signalRows.results.slice(0, 49), latestCallRow];
    boundedRows.sort((left, right) => {
      const occurredDelta = Date.parse(String(right.occurred_at)) - Date.parse(String(left.occurred_at));
      return occurredDelta || String(right.id).localeCompare(String(left.id));
    });
    const signals = boundedRows.slice(0, 50).filter((signal) => communicationSignalTypes.has(String(signal.type))).map((signal) => ({
      id: String(signal.id),
      type: String(signal.type),
      title: String(signal.title || "").slice(0, 200),
      body: signal.body === null ? null : String(signal.body).slice(0, 1000),
      occurred_at: String(signal.occurred_at),
      metadata: communicationMetadata(signal.metadata),
    }));
    const staleDays = Number((await env.DB.prepare("SELECT stale_after_days FROM agent_policies WHERE workspace_id=?")
      .bind(workspaceId).first<{ stale_after_days: number }>())?.stale_after_days || 7);
    const latestSignalAt = signals[0]?.occurred_at ? Date.parse(String(signals[0].occurred_at)) : 0;
    const recordActivityAt = Date.parse(String(opportunity.last_activity_at || opportunity.updated_at));
    const activityAt = Math.max(Number.isFinite(latestSignalAt) ? latestSignalAt : 0, Number.isFinite(recordActivityAt) ? recordActivityAt : 0);
    const ageDays = activityAt ? Math.max(0, Math.floor((Date.now() - activityAt) / 86_400_000)) : staleDays;
    const latestCall = signals.find((signal) => signal.type === "sales.call_analyzed") || null;
    const reasons: Array<{ code: string; label: string; impact: number; evidence: string }> = [];
    if (!opportunity.next_step) reasons.push({ code: "missing_next_step", label: "No next step", impact: -20, evidence: "The opportunity has no recorded next commitment." });
    if (!opportunity.owner) reasons.push({ code: "unowned", label: "No owner", impact: -15, evidence: "No operator owns this opportunity." });
    if (opportunity.expected_close_at && Date.parse(String(opportunity.expected_close_at)) < Date.now()) {
      reasons.push({ code: "close_overdue", label: "Close date passed", impact: -20, evidence: "The expected close date is in the past." });
    } else if (Number(opportunity.stage_position) >= 2 && !opportunity.expected_close_at) {
      reasons.push({ code: "missing_close_date", label: "Close date missing", impact: -10, evidence: "This later-stage opportunity has no expected close date." });
    }
    if (ageDays >= staleDays) reasons.push({ code: "stale", label: "Activity is stale", impact: -20, evidence: `${ageDays} days have passed since the latest CRM or communication signal.` });
    if (latestCall?.metadata.sentiment === "negative") {
      reasons.push({ code: "negative_call", label: "Negative latest call", impact: -10, evidence: "The latest analyzed sales call was marked negative by the connected source." });
    }
    if ((latestCall?.metadata.objections.length || 0) > 0) {
      reasons.push({ code: "open_objections", label: "Objections detected", impact: -10, evidence: `${latestCall!.metadata.objections.length} objection${latestCall!.metadata.objections.length === 1 ? "" : "s"} were reported on the latest analyzed call.` });
    }
    if (latestCall?.metadata.next_step_detected === false) {
      reasons.push({ code: "call_next_step_missing", label: "No call commitment", impact: -10, evidence: "The connected call analysis did not detect a next-step commitment." });
    }
    const score = Math.max(0, Math.min(100, 100 + reasons.reduce((total, reason) => total + reason.impact, 0)));
    return json({
      opportunity_id: opportunity.id,
      generated_at: new Date().toISOString(),
      health: {
        score,
        status: score >= 90 ? "strong" : score >= 60 ? "watch" : "at_risk",
        coverage: signals.length ? "connected" : "not_connected",
        last_signal_at: signals[0]?.occurred_at || null,
        reasons,
      },
      summary: {
        total: signals.length,
        analyzed_calls: signals.filter((signal) => signal.type === "sales.call_analyzed").length,
        emails: signals.filter((signal) => signal.type === "email.received" || signal.type === "email.sent").length,
        meetings: signals.filter((signal) => signal.type.startsWith("calendar.")).length,
      },
      signals,
      safety: {
        source_content_trusted: false,
        score_is_deterministic: true,
        mutations_require_human_approval: true,
        bounded_to: 50,
      },
    });
  }
  if (opportunityMatch && request.method === "PATCH") {
    const denied = await requireWorkspaceGrant(env, access, "opportunity", "update");
    if (denied) return denied;
    const body = await readJson(request);
    for (const fieldName of [
      "stage_id", "status", "value", "probability", "owner", "expected_close_at", "next_step", "lost_reason",
    ] as const) {
      if (body[fieldName] !== undefined) {
        const fieldDenied = await requireWorkspaceGrant(env, access, "opportunity", "update_field", fieldName);
        if (fieldDenied) return fieldDenied;
      }
    }
    if (body.custom_fields !== undefined && !isPlainObject(body.custom_fields)) {
      return json({ error: "custom_fields must be an object" }, 400);
    }
    if (body.custom_fields !== undefined) {
      for (const fieldName of Object.keys(body.custom_fields)) {
        const fieldDenied = await requireWorkspaceGrant(env, access, "opportunity", "update_custom_field", fieldName);
        if (fieldDenied) return fieldDenied;
      }
    }
    const before = await env.DB.prepare("SELECT * FROM opportunities WHERE workspace_id=? AND id=?").bind(workspaceId, opportunityMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Opportunity not found" }, 404);
    const expectedUpdatedAt = body.if_updated_at === undefined ? null : optionalString(body.if_updated_at, "if_updated_at", 50);
    const stageId = body.stage_id === undefined ? String(before.stage_id) : optionalString(body.stage_id, "stage_id", 80);
    if (!stageId) return json({ error: "stage_id is invalid" }, 400);
    const stage = await env.DB.prepare("SELECT probability,category FROM pipeline_stages WHERE workspace_id=? AND pipeline_id=? AND id=?")
      .bind(workspaceId, before.pipeline_id, stageId).first<{ probability: number; category: string }>();
    if (!stage) return json({ error: "Stage does not belong to this pipeline" }, 400);
    const requestedStatus = body.status === undefined ? String(before.status) : optionalString(body.status, "status", 20);
    const status = stageId !== before.stage_id
      ? stage.category === "won" ? "won" : stage.category === "lost" ? "lost" : "open"
      : requestedStatus;
    if (!status || !["open", "won", "lost", "abandoned"].includes(status)) return json({ error: "status is invalid" }, 400);
    if ((stage.category === "won" && status !== "won") || (stage.category === "lost" && status !== "lost")
      || (!["won", "lost"].includes(stage.category) && ["won", "lost"].includes(status))) {
      return json({ error: "status does not match the selected stage" }, 400);
    }
    const value = body.value === undefined ? Number(before.value) : boundedNumber(body.value, "value", 0, 100_000_000);
    const probability = ["won", "lost"].includes(stage.category)
      ? stage.probability
      : body.probability === undefined
        ? (stageId !== before.stage_id ? stage.probability : Number(before.probability))
        : boundedNumber(body.probability, "probability", 0, 100);
    const nextStep = body.next_step === undefined ? before.next_step : optionalString(body.next_step, "next_step", 500);
    const expectedClose = body.expected_close_at === undefined ? before.expected_close_at : optionalString(body.expected_close_at, "expected_close_at", 50);
    if (expectedClose && !Number.isFinite(Date.parse(String(expectedClose)))) return json({ error: "expected_close_at is invalid" }, 400);
    const owner = body.owner === undefined ? before.owner : optionalString(body.owner, "owner", 254);
    const lostReason = body.lost_reason === undefined ? before.lost_reason : optionalString(body.lost_reason, "lost_reason", 500);
    let customFields = String(before.custom_fields || "{}");
    if (body.custom_fields !== undefined) {
      try { customFields = await mergeCustomFieldValues(env, workspaceId, "opportunity", before.custom_fields, body.custom_fields); }
      catch (error) { return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid custom fields" }, 400); }
    }
    const now = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const after = { ...before, stage_id: stageId, status, value, probability, next_step: nextStep, expected_close_at: expectedClose, owner, lost_reason: lostReason, custom_fields: customFields, updated_at: now };
    const claimed = await env.DB.batch([
      env.DB.prepare(`UPDATE opportunities SET stage_id=?,status=?,value=?,probability=?,next_step=?,
        expected_close_at=?,owner=?,lost_reason=?,custom_fields=?,updated_at=? WHERE workspace_id=? AND id=? AND (? IS NULL OR updated_at=?)`)
        .bind(stageId, status, value, probability, nextStep, expectedClose, owner, lostReason, customFields, now,
          workspaceId, opportunityMatch[1], expectedUpdatedAt, expectedUpdatedAt),
      await opportunityUpdateAuditStatement(env, access, request, opportunityMatch[1], before, after, now),
    ]);
    if (!claimed[0].meta.changes) return json({ error: "Opportunity changed since it was loaded", code: "edit_conflict" }, 409);
    if (stageId !== before.stage_id) await runOpportunityAutomations(env, access, after, requestId(request));
    const readableOpportunityFields = await readableOpportunityCustomFieldKeys(env, access);
    return json({ ok: true, opportunity: redactOpportunityCustomFields(after, readableOpportunityFields) });
  }
  if (opportunityMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const before = await env.DB.prepare("SELECT * FROM opportunities WHERE workspace_id=? AND id=?")
      .bind(workspaceId, opportunityMatch[1]).first();
    if (!before) return json({ error: "Opportunity not found" }, 404);
    const deleted = await env.DB.batch([
      env.DB.prepare("DELETE FROM agent_work_items WHERE workspace_id=? AND opportunity_id=?").bind(workspaceId, opportunityMatch[1]),
      env.DB.prepare("DELETE FROM agent_proposals WHERE workspace_id=? AND opportunity_id=?").bind(workspaceId, opportunityMatch[1]),
      env.DB.prepare("DELETE FROM tasks WHERE workspace_id=? AND opportunity_id=?").bind(workspaceId, opportunityMatch[1]),
      env.DB.prepare("DELETE FROM opportunities WHERE workspace_id=? AND id=?").bind(workspaceId, opportunityMatch[1]),
    ]);
    if (!deleted.at(-1)?.meta.changes) return json({ error: "Opportunity not found" }, 404);
    await audit(env, access, request, "opportunity.deleted", "opportunity", opportunityMatch[1], before, null);
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/tasks" && request.method === "POST") {
    const body = await readJson(request);
    const title = optionalString(body.title, "title", 200);
    if (!title) return json({ error: "title is required" }, 400);
    const contactId = optionalString(body.contact_id, "contact_id", 80);
    const opportunityId = optionalString(body.opportunity_id, "opportunity_id", 80);
    if (opportunityId) {
      const opportunityDenied = await requireWorkspaceGrant(env, access, "opportunity", "read");
      if (opportunityDenied) return opportunityDenied;
    }
    if (contactId && !(await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=?").bind(workspaceId, contactId).first())) return json({ error: "Contact not found" }, 404);
    const taskOpportunity = opportunityId
      ? await env.DB.prepare("SELECT id,contact_id FROM opportunities WHERE workspace_id=? AND id=?")
        .bind(workspaceId, opportunityId).first<{ id: string; contact_id: string }>()
      : null;
    if (opportunityId && !taskOpportunity) return json({ error: "Opportunity not found" }, 404);
    if (contactId && taskOpportunity && taskOpportunity.contact_id !== contactId) {
      return json({ error: "Opportunity does not belong to the selected contact" }, 400);
    }
    const effectiveContactId = contactId || taskOpportunity?.contact_id || null;
    const taskId = id("task");
    const now = new Date().toISOString();
    const priority = optionalString(body.priority, "priority", 20) || "normal";
    if (!["low", "normal", "high", "urgent"].includes(priority)) return json({ error: "priority is invalid" }, 400);
    const dueAt = optionalString(body.due_at, "due_at", 50);
    if (dueAt && !Number.isFinite(Date.parse(dueAt))) return json({ error: "due_at is invalid" }, 400);
    const assignee = optionalString(body.assignee, "assignee", 254);
    if (assignee && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignee)) return json({ error: "assignee must be a valid email" }, 400);
    const created = { title, contact_id: effectiveContactId, opportunity_id: opportunityId };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tasks
        (id,workspace_id,contact_id,opportunity_id,title,description,status,priority,assignee,due_at,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(taskId, workspaceId, effectiveContactId, opportunityId, title, optionalString(body.description, "description", 4000),
          "open", priority, assignee, dueAt,
          access.email, now, now),
      await auditStatement(env, access, request, "task.created", "task", taskId, null, created),
    ]);
    return json({ ok: true, id: taskId }, 201);
  }

  const taskMatch = url.pathname.match(/^\/v1\/admin\/tasks\/([^/]+)$/);
  if (taskMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const before = await env.DB.prepare("SELECT * FROM tasks WHERE workspace_id=? AND id=?").bind(workspaceId, taskMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Task not found" }, 404);
    if (before.opportunity_id) {
      const opportunityDenied = await requireWorkspaceGrant(env, access, "opportunity", "read");
      if (opportunityDenied) return opportunityDenied;
    }
    const expectedUpdatedAt = optionalString(body.if_updated_at, "if_updated_at", 50);
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required", code: "version_required" }, 400);
    const status = body.status === undefined ? String(before.status) : optionalString(body.status, "status", 20);
    if (!status || !["open", "completed", "cancelled"].includes(status)) return json({ error: "status is invalid" }, 400);
    const now = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const after = { ...before, status, completed_at: status === "completed" ? now : null, updated_at: now };
    const claimed = await env.DB.batch([
      env.DB.prepare(`UPDATE tasks SET status=?,completed_at=?,updated_at=?
        WHERE workspace_id=? AND id=? AND updated_at=?`)
        .bind(status, status === "completed" ? now : null, now, workspaceId, taskMatch[1], expectedUpdatedAt),
      await taskMutationAuditStatement(env, access, request, "task.updated", taskMatch[1], before, after, now),
    ]);
    if (!claimed[0].meta.changes) return json({ error: "Task changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true, task: after });
  }
  if (taskMatch && request.method === "DELETE") {
    const expectedUpdatedAt = url.searchParams.get("if_updated_at");
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required", code: "version_required" }, 400);
    const before = await env.DB.prepare("SELECT * FROM tasks WHERE workspace_id=? AND id=?")
      .bind(workspaceId, taskMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Task not found" }, 404);
    if (before.opportunity_id) {
      const opportunityDenied = await requireWorkspaceGrant(env, access, "opportunity", "read");
      if (opportunityDenied) return opportunityDenied;
    }
    if (before.status !== "completed") return json({ error: "Complete the task before deleting it", code: "task_not_completed" }, 409);
    const deleted = await env.DB.batch([
      await taskMutationAuditStatement(env, access, request, "task.deleted", taskMatch[1], before, null, expectedUpdatedAt),
      env.DB.prepare("DELETE FROM tasks WHERE workspace_id=? AND id=? AND updated_at=? AND status='completed'")
        .bind(workspaceId, taskMatch[1], expectedUpdatedAt),
    ]);
    if (!deleted[1].meta.changes) return json({ error: "Task changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true });
  }

  const agentWorkItemRequeueMatch = url.pathname.match(/^\/v1\/admin\/agent-work-items\/([^/]+)\/requeue$/);
  if (agentWorkItemRequeueMatch && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedUpdatedAt = optionalString(body.if_updated_at, "if_updated_at", 50);
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required", code: "version_required" }, 400);
    const before = await env.DB.prepare(`SELECT * FROM agent_work_items WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, agentWorkItemRequeueMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Agent work item not found" }, 404);
    const requeueAt = new Date().toISOString();
    const expiredClaim = before.status === "claimed" && typeof before.claim_expires_at === "string" &&
      before.claim_expires_at <= requeueAt;
    if (before.status !== "failed" && !expiredClaim) {
      return json({ error: "Only failed or lease-expired agent work can be requeued", code: "work_item_not_requeueable" }, 409);
    }
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const after = { ...before, status: "queued", claimed_by_credential_id: null, claim_expires_at: null,
      result: null, completed_at: null, updated_at: updatedAt };
    let requeued: D1Result<unknown>[];
    try {
      requeued = await env.DB.batch([
        await agentWorkItemRequeueAuditStatement(env, access, request,
          agentWorkItemRequeueMatch[1], before, after, expectedUpdatedAt, requeueAt),
        env.DB.prepare(`UPDATE agent_work_items
          SET status='queued',claimed_by_credential_id=NULL,claim_expires_at=NULL,result=NULL,completed_at=NULL,updated_at=?
          WHERE workspace_id=? AND id=? AND updated_at=?
            AND (status='failed' OR (status='claimed' AND claim_expires_at<=?))`)
          .bind(updatedAt, workspaceId, agentWorkItemRequeueMatch[1], expectedUpdatedAt, requeueAt),
        env.DB.prepare("INSERT INTO atomic_mutation_guard(ok) SELECT 0 WHERE changes()=0"),
      ]);
    } catch (error) {
      if (String(error).includes("atomic_mutation_must_win")) {
        return json({ error: "Agent work item changed before it could be requeued", code: "edit_conflict" }, 409);
      }
      throw error;
    }
    if (!requeued[1].meta.changes) return json({ error: "Agent work item changed before it could be requeued", code: "edit_conflict" }, 409);
    return json({ ok: true, work_item: after });
  }

  const agentWorkItemCancelMatch = url.pathname.match(/^\/v1\/admin\/agent-work-items\/([^/]+)\/cancel$/);
  if (agentWorkItemCancelMatch && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedUpdatedAt = optionalString(body.if_updated_at, "if_updated_at", 50);
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required", code: "version_required" }, 400);
    const before = await env.DB.prepare("SELECT * FROM agent_work_items WHERE workspace_id=? AND id=?")
      .bind(workspaceId, agentWorkItemCancelMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Agent work item not found" }, 404);
    if (before.status !== "queued") {
      return json({ error: "Only queued agent work can be canceled", code: "work_item_not_cancelable" }, 409);
    }
    const canceled = await env.DB.batch([
      await agentWorkItemCancelAuditStatement(env, access, request,
        agentWorkItemCancelMatch[1], before, expectedUpdatedAt),
      env.DB.prepare(`DELETE FROM agent_work_items
        WHERE workspace_id=? AND id=? AND status='queued' AND updated_at=?`)
        .bind(workspaceId, agentWorkItemCancelMatch[1], expectedUpdatedAt),
    ]);
    if (!canceled[1].meta.changes) {
      return json({ error: "Agent work item changed before it could be canceled", code: "edit_conflict" }, 409);
    }
    return json({ ok: true });
  }

  const automationRunOperationMatch = url.pathname.match(/^\/v1\/admin\/automation-runs\/([^/]+)\/(retry|cancel)$/);
  if (automationRunOperationMatch && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const [runId, operation] = automationRunOperationMatch.slice(1);
    const before = await env.DB.prepare(`SELECT r.*,a.status rule_status,a.trigger_type,a.max_runs_per_record
      FROM automation_runs r JOIN automation_rules a ON a.id=r.rule_id AND a.workspace_id=r.workspace_id
      WHERE r.workspace_id=? AND r.id=?`).bind(workspaceId, runId).first<Record<string, unknown>>();
    if (!before) return json({ error: "Automation run not found" }, 404);

    if (operation === "cancel") {
      if (before.status !== "running") return json({ error: "Only a running automation can be canceled", code: "run_not_running" }, 409);
      const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
      if (String(before.started_at) > staleBefore) {
        return json({ error: "This run is still inside its five-minute execution lease", code: "run_still_active" }, 409);
      }
      const finishedAt = new Date().toISOString();
      let canceled: D1Result<unknown>[];
      try {
        canceled = await env.DB.batch([
          await automationRunCancelAuditStatement(env, access, request, runId, before, "running", null),
          env.DB.prepare(`UPDATE automation_runs SET status='canceled',error=?,finished_at=?
            WHERE workspace_id=? AND id=? AND status='running' AND started_at<=?`)
            .bind(`Canceled as stale by ${access.email}`, finishedAt, workspaceId, runId, staleBefore),
          env.DB.prepare("INSERT INTO atomic_mutation_guard(ok) SELECT 0 WHERE changes()=0"),
        ]);
      } catch (error) {
        if (String(error).includes("atomic_mutation_must_win")) {
          return json({ error: "Automation run changed before cancellation", code: "run_conflict" }, 409);
        }
        throw error;
      }
      if (!canceled[1].meta.changes) return json({ error: "Automation run changed before cancellation", code: "run_conflict" }, 409);
      return json({ ok: true, run: { ...before, status: "canceled", error: `Canceled as stale by ${access.email}`, finished_at: finishedAt } });
    }

    if (before.status !== "failed") return json({ error: "Only a failed automation can be retried", code: "run_not_failed" }, 409);
    if (before.rule_status !== "active") return json({ error: "Activate the workflow before retrying its failed run", code: "workflow_not_active" }, 409);
    const triggerType = String(before.trigger_type);
    const recordType = String(before.record_type);
    if (!["opportunity", "contact"].includes(recordType) ||
      !(recordType === "opportunity"
        ? ["opportunity.created", "opportunity.stage_changed", "opportunity.manual"]
        : ["contact.created", "contact.lifecycle_changed", "contact.manual"]).includes(triggerType)) {
      return json({ error: "This trigger type cannot be retried", code: "trigger_unsupported" }, 409);
    }
    const record = await env.DB.prepare(`SELECT * FROM ${recordType === "contact" ? "contacts" : "opportunities"} WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, before.record_id).first<Record<string, unknown>>();
    if (!record) return json({ error: `The ${recordType} no longer exists`, code: "record_missing" }, 409);
    const [retryRule, retryDefinitions] = await Promise.all([
      env.DB.prepare("SELECT * FROM automation_rules WHERE workspace_id=? AND id=?")
        .bind(workspaceId, before.rule_id).first<Record<string, unknown>>(),
      env.DB.prepare("SELECT * FROM custom_field_definitions WHERE workspace_id=? AND active=1")
        .bind(workspaceId).all<CustomFieldDefinition>(),
    ]);
    const retryHealth = retryRule
      ? await automationDefinitionHealth(retryRule, retryDefinitions.results)
      : { metadata_status: "blocked", metadata_error: "Workflow no longer exists" };
    if (retryHealth.metadata_status === "blocked") {
      return json({ error: retryHealth.metadata_error, code: "workflow_metadata_drift" }, 409);
    }
    const priorSucceeded = await env.DB.prepare(`SELECT COUNT(*) total FROM automation_runs
      WHERE workspace_id=? AND rule_id=? AND record_type=? AND record_id=? AND status='succeeded'`)
      .bind(workspaceId, before.rule_id, recordType, before.record_id).first<{ total: number }>();
    if (Number(priorSucceeded?.total || 0) >= Number(before.max_runs_per_record)) {
      return json({ error: "This record has reached the workflow run limit", code: "run_limit_reached" }, 409);
    }
    const retriedRunIds = recordType === "contact"
      ? await runContactAutomations(env, access, record, `retry:${runId}`,
        triggerType as "contact.created" | "contact.lifecycle_changed" | "contact.manual",
        { onlyRuleId: String(before.rule_id), retryOfRunId: runId })
      : await runOpportunityAutomations(env, access, record, `retry:${runId}`,
        triggerType as "opportunity.created" | "opportunity.stage_changed" | "opportunity.manual",
        { onlyRuleId: String(before.rule_id), retryOfRunId: runId });
    if (!retriedRunIds.length) {
      const existing = await env.DB.prepare("SELECT id,status FROM automation_runs WHERE workspace_id=? AND retry_of_run_id=?")
        .bind(workspaceId, runId).first();
      if (existing) return json({ error: "This failed run has already been retried", code: "run_already_retried", retry: existing }, 409);
      return json({ error: "The current workflow branch has no executable actions", code: "no_executable_branch" }, 409);
    }
    const retry = await env.DB.prepare("SELECT * FROM automation_runs WHERE workspace_id=? AND id=?")
      .bind(workspaceId, retriedRunIds[0]).first();
    await audit(env, access, request, "automation_run.retried", "automation_run", runId, before,
      { retry_run_id: retriedRunIds[0], retry_status: retry?.status });
    return json({ ok: true, run: retry });
  }

  if (url.pathname === "/v1/admin/automations" && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const name = optionalString(body.name, "name", 200);
    const triggerType = optionalString(body.trigger_type, "trigger_type", 80);
    if (!name || !triggerType) return json({ error: "name and trigger_type are required" }, 400);
    const conditions = jsonArray(body.conditions || [], "conditions", 20);
    const actions = normalizeAutomationActions(jsonArray(body.actions || [], "actions", 20));
    const elseActions = normalizeAutomationActions(jsonArray(body.else_actions || [], "else_actions", 20));
    if (!actions.length) return json({ error: "At least one action is required" }, 400);
    if (actions.length + elseActions.length > 20) return json({ error: "Workflow branches cannot contain more than 20 total actions" }, 400);
    if (elseActions.length && !conditions.length) return json({ error: "An else branch requires at least one condition" }, 400);
    const definitionError = validateAutomationDefinition(triggerType, conditions, actions);
    if (definitionError) return json({ error: definitionError }, 400);
    const customConditionError = await validateStoredAutomationCustomMetadata(env, workspaceId, triggerType, conditions,
      [...actions, ...elseActions]);
    if (customConditionError) return json({ error: customConditionError }, 400);
    const elseDefinitionError = validateAutomationDefinition(triggerType, [], elseActions);
    if (elseDefinitionError) return json({ error: `Else branch: ${elseDefinitionError}` }, 400);
    const identityError = validateWorkflowStepIdentity(actions, elseActions);
    if (identityError) return json({ error: identityError }, 400);
    const stageReferenceError = await validateAutomationStageReferences(env, workspaceId, conditions);
    if (stageReferenceError) return json({ error: stageReferenceError }, 400);
    const authority = await workflowAuthority(actions, elseActions);
    const ruleId = id("auto");
    const now = new Date().toISOString();
    const created = { name, trigger_type: triggerType, status: "draft" };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO automation_rules
        (id,workspace_id,name,trigger_type,conditions,actions,else_actions,status,max_runs_per_record,
         authority_manifest,authority_hash,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(ruleId, workspaceId, name, triggerType, JSON.stringify(conditions), JSON.stringify(actions), JSON.stringify(elseActions), "draft",
          boundedNumber(body.max_runs_per_record, "max_runs_per_record", 1, 20, 1), authority.serialized, authority.hash,
          access.email, now, now),
      await auditStatement(env, access, request, "automation.created", "automation", ruleId, null, created),
    ]);
    return json({ ok: true, id: ruleId }, 201);
  }

  const automationManualRunMatch = url.pathname.match(/^\/v1\/admin\/automations\/([^/]+)\/run$/);
  if (automationManualRunMatch && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const recordId = optionalString(body.record_id, "record_id", 100);
    if (!recordId) return json({ error: "record_id is required" }, 400);
    const rule = await env.DB.prepare(`SELECT * FROM automation_rules WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, automationManualRunMatch[1]).first<Record<string, unknown>>();
    if (!rule) return json({ error: "Automation not found" }, 404);
    if (rule.status !== "active") return json({ error: "Activate the workflow before running it", code: "workflow_not_active" }, 409);
    const triggerType = String(rule.trigger_type);
    if (!["contact.manual", "opportunity.manual"].includes(triggerType)) {
      return json({ error: "Only manual workflows can be run on demand", code: "trigger_not_manual" }, 409);
    }
    const recordType = automationRecordType(triggerType);
    const record = await env.DB.prepare(`SELECT * FROM ${recordType === "contact" ? "contacts" : "opportunities"} WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, recordId).first<Record<string, unknown>>();
    if (!record) return json({ error: `${recordType === "contact" ? "Lead" : "Opportunity"} not found` }, 404);
    const currentDefinitions = await env.DB.prepare(`SELECT * FROM custom_field_definitions
      WHERE workspace_id=? AND active=1`).bind(workspaceId).all<CustomFieldDefinition>();
    const health = await automationDefinitionHealth(rule, currentDefinitions.results);
    if (health.metadata_status === "blocked") {
      return json({ error: health.metadata_error, code: "workflow_metadata_drift" }, 409);
    }
    const priorSucceeded = await env.DB.prepare(`SELECT COUNT(*) total FROM automation_runs
      WHERE workspace_id=? AND rule_id=? AND record_type=? AND record_id=? AND status='succeeded'`)
      .bind(workspaceId, rule.id, recordType, recordId).first<{ total: number }>();
    if (Number(priorSucceeded?.total || 0) >= Number(rule.max_runs_per_record)) {
      return json({ error: "This record has reached the workflow run limit", code: "run_limit_reached" }, 409);
    }
    const eventId = `manual:${String(rule.id)}:${requestId(request)}`;
    const runIds = recordType === "contact"
      ? await runContactAutomations(env, access, record, eventId, "contact.manual", { onlyRuleId: String(rule.id) })
      : await runOpportunityAutomations(env, access, record, eventId, "opportunity.manual", { onlyRuleId: String(rule.id) });
    if (!runIds.length) {
      const admittedRuns = await env.DB.prepare(`SELECT COUNT(*) total FROM automation_runs
        WHERE workspace_id=? AND rule_id=? AND record_type=? AND record_id=? AND status IN ('running','succeeded')`)
        .bind(workspaceId, rule.id, recordType, recordId).first<{ total: number }>();
      if (Number(admittedRuns?.total || 0) >= Number(rule.max_runs_per_record)) {
        return json({ error: "This record has reached the workflow run limit", code: "run_limit_reached" }, 409);
      }
      return json({ error: "The selected record produced no executable branch", code: "no_executable_branch" }, 409);
    }
    const run = await env.DB.prepare("SELECT * FROM automation_runs WHERE workspace_id=? AND id=?")
      .bind(workspaceId, runIds[0]).first();
    await audit(env, access, request, "automation.manual_run", "automation", String(rule.id), null,
      { run_id: runIds[0], record_type: recordType, record_id: recordId, status: run?.status });
    return json({ ok: true, run });
  }

  const automationMatch = url.pathname.match(/^\/v1\/admin\/automations\/([^/]+)$/);
  if (automationMatch && request.method === "PATCH") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedUpdatedAt = body.if_updated_at === undefined ? null : optionalString(body.if_updated_at, "if_updated_at", 50);
    const before = await env.DB.prepare("SELECT * FROM automation_rules WHERE workspace_id=? AND id=?")
      .bind(workspaceId, automationMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Automation not found" }, 404);
    const definitionEdit = ["name", "trigger_type", "conditions", "actions", "else_actions", "max_runs_per_record"]
      .some((field) => body[field] !== undefined);
    if (definitionEdit && before.status === "active") return json({ error: "Pause the workflow before editing it" }, 409);
    const status = body.status === undefined ? String(before.status) : optionalString(body.status, "status", 20);
    if (!status || !["draft", "active", "paused"].includes(status)) return json({ error: "status is invalid" }, 400);
    const name = body.name === undefined ? String(before.name) : optionalString(body.name, "name", 200);
    const triggerType = body.trigger_type === undefined ? String(before.trigger_type) : optionalString(body.trigger_type, "trigger_type", 80);
    if (!name || !triggerType) return json({ error: "name and trigger_type are required" }, 400);
    let serializedConditions = String(before.conditions);
    let serializedActions = String(before.actions);
    let serializedElseActions = String(before.else_actions || "[]");
    if (definitionEdit || status === "active") {
      let conditions: unknown[];
      let actions: unknown[];
      let elseActions: unknown[];
      try {
        const parsedConditions = body.conditions === undefined ? JSON.parse(serializedConditions) : jsonArray(body.conditions, "conditions", 20);
        const parsedActions = body.actions === undefined ? JSON.parse(serializedActions) : jsonArray(body.actions, "actions", 20);
        const parsedElseActions = body.else_actions === undefined ? JSON.parse(serializedElseActions) : jsonArray(body.else_actions, "else_actions", 20);
        if (!Array.isArray(parsedConditions) || !Array.isArray(parsedActions) || !Array.isArray(parsedElseActions)) throw new Error("Stored definition is not an array");
        conditions = parsedConditions;
        actions = normalizeAutomationActions(parsedActions);
        elseActions = normalizeAutomationActions(parsedElseActions);
      } catch {
        return json({ error: "Stored automation definition is unreadable" }, 422);
      }
      if (!actions.length) return json({ error: "At least one action is required" }, 400);
      if (actions.length + elseActions.length > 20) return json({ error: "Workflow branches cannot contain more than 20 total actions" }, status === "active" ? 422 : 400);
      if (elseActions.length && !conditions.length) return json({ error: "An else branch requires at least one condition" }, status === "active" ? 422 : 400);
      const definitionError = validateAutomationDefinition(triggerType, conditions, actions);
      if (definitionError) return json({ error: definitionError }, status === "active" ? 422 : 400);
      const customConditionError = await validateStoredAutomationCustomMetadata(env, workspaceId, triggerType, conditions,
        [...actions, ...elseActions]);
      if (customConditionError) return json({ error: customConditionError }, status === "active" ? 422 : 400);
      const elseDefinitionError = validateAutomationDefinition(triggerType, [], elseActions);
      if (elseDefinitionError) return json({ error: `Else branch: ${elseDefinitionError}` }, status === "active" ? 422 : 400);
      const identityError = validateWorkflowStepIdentity(actions, elseActions);
      if (identityError) return json({ error: identityError }, status === "active" ? 422 : 400);
      const stageReferenceError = await validateAutomationStageReferences(env, workspaceId, conditions);
      if (stageReferenceError) return json({ error: stageReferenceError }, status === "active" ? 422 : 400);
      serializedConditions = JSON.stringify(conditions);
      serializedActions = JSON.stringify(actions);
      serializedElseActions = JSON.stringify(elseActions);
    }
    const maxRuns = body.max_runs_per_record === undefined ? Number(before.max_runs_per_record)
      : boundedNumber(body.max_runs_per_record, "max_runs_per_record", 1, 20, 1);
    const authority = await workflowAuthority(
      JSON.parse(serializedActions) as unknown[],
      JSON.parse(serializedElseActions) as unknown[],
    );
    if (status === "active" && before.status !== "active") {
      const active = await env.DB.prepare("SELECT COUNT(*) total FROM automation_rules WHERE workspace_id=? AND status='active'")
        .bind(workspaceId).first<{ total: number }>();
      if (Number(active?.total || 0) >= 50) {
        return json({ error: "Pause another workflow before activating this one", code: "active_automation_limit" }, 409);
      }
    }
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const after = { ...before, name, trigger_type: triggerType, conditions: serializedConditions,
      actions: serializedActions, else_actions: serializedElseActions, status, max_runs_per_record: maxRuns, updated_at: updatedAt };
    const auditAction = definitionEdit ? "automation.definition_updated" : "automation.status_changed";
    const claimed = await env.DB.batch([
      env.DB.prepare(`UPDATE automation_rules
        SET name=?,trigger_type=?,conditions=?,actions=?,else_actions=?,status=?,max_runs_per_record=?,
            authority_manifest=?,authority_hash=?,updated_at=?
        WHERE workspace_id=? AND id=? AND (? IS NULL OR updated_at=?)
        AND (status='active' OR ?<>'active' OR
          (SELECT COUNT(*) FROM automation_rules WHERE workspace_id=? AND status='active')<50)`)
        .bind(name, triggerType, serializedConditions, serializedActions, serializedElseActions, status, maxRuns,
          authority.serialized, authority.hash, updatedAt,
          workspaceId, automationMatch[1], expectedUpdatedAt, expectedUpdatedAt, status, workspaceId),
      await automationMutationAuditStatement(env, access, request, auditAction,
        automationMatch[1], before, after, updatedAt),
    ]);
    if (!claimed[0].meta.changes) return json({ error: "Automation changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true, automation: after });
  }
  if (automationMatch && request.method === "DELETE") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const expectedUpdatedAt = url.searchParams.get("if_updated_at");
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required", code: "version_required" }, 400);
    const before = await env.DB.prepare("SELECT * FROM automation_rules WHERE workspace_id=? AND id=?")
      .bind(workspaceId, automationMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Automation not found" }, 404);
    if (before.status === "active") return json({ error: "Pause the automation before deleting it" }, 409);
    const deleted = await env.DB.batch([
      await automationMutationAuditStatement(env, access, request, "automation.deleted",
        automationMatch[1], before, null, expectedUpdatedAt),
      env.DB.prepare(`DELETE FROM agent_work_items
        WHERE workspace_id=? AND automation_rule_id=? AND status='queued'
        AND EXISTS(SELECT 1 FROM automation_rules WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(workspaceId, automationMatch[1], workspaceId, automationMatch[1], expectedUpdatedAt),
      env.DB.prepare(`UPDATE agent_work_items SET automation_rule_id=NULL,automation_run_id=NULL
        WHERE workspace_id=? AND automation_rule_id=?
        AND EXISTS(SELECT 1 FROM automation_rules WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(workspaceId, automationMatch[1], workspaceId, automationMatch[1], expectedUpdatedAt),
      env.DB.prepare(`DELETE FROM automation_runs WHERE workspace_id=? AND rule_id=?
        AND EXISTS(SELECT 1 FROM automation_rules WHERE workspace_id=? AND id=? AND updated_at=?)`)
        .bind(workspaceId, automationMatch[1], workspaceId, automationMatch[1], expectedUpdatedAt),
      env.DB.prepare("DELETE FROM automation_rules WHERE workspace_id=? AND id=? AND updated_at=?")
        .bind(workspaceId, automationMatch[1], expectedUpdatedAt),
    ]);
    if (!deleted.at(-1)?.meta.changes) return json({ error: "Automation changed since it was loaded", code: "edit_conflict" }, 409);
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/webhooks" && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const name = optionalString(body.name, "name", 120);
    const direction = optionalString(body.direction, "direction", 20);
    if (!name || !direction || !["inbound", "outbound"].includes(direction)) return json({ error: "Valid name and direction are required" }, 400);
    const eventTypes = jsonArray(body.event_types || [], "event_types", 50);
    const payloadPreset = optionalString(body.payload_preset || "generic", "payload_preset", 20) || "generic";
    if (!["generic", "slack", "teams", "discord", "pagerduty"].includes(payloadPreset)) {
      return json({ error: "payload_preset is invalid" }, 400);
    }
    const submittedUrl = optionalString(body.url, "url", 1000);
    const endpointUrl = payloadPreset === "pagerduty"
      ? "https://events.pagerduty.com/v2/enqueue" : submittedUrl;
    if (direction === "outbound" && (!endpointUrl || !isSafeWebhookUrl(endpointUrl))) {
      return json({ error: "A public HTTPS destination URL is required" }, 400);
    }
    const providerPresetEventAllowed = (eventType: unknown) =>
      String(eventType).startsWith("operations.health.") ||
      (payloadPreset === "slack" && eventType === "visitor_intent_case.created");
    if (payloadPreset !== "generic" &&
        (direction !== "outbound" || !eventTypes.length || eventTypes.some((eventType) => !providerPresetEventAllowed(eventType)))) {
      return json({ error: "Provider preset event subscription is invalid" }, 400);
    }
    const providerCredential = optionalString(body.provider_credential, "provider_credential", 200);
    if (payloadPreset === "pagerduty" && (!providerCredential || !/^[A-Za-z0-9]{32}$/.test(providerCredential))) {
      return json({ error: "PagerDuty requires a 32-character Events API v2 routing key" }, 400);
    }
    if (payloadPreset !== "pagerduty" && providerCredential) {
      return json({ error: "provider_credential is only supported for PagerDuty" }, 400);
    }
    const secret = `whsec_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const webhookId = id("hook");
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO webhook_endpoints
      (id,workspace_id,name,direction,url,event_types,payload_preset,secret_prefix,secret_hash,secret_ciphertext,
       provider_credential_prefix,provider_credential_ciphertext,active,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
      .bind(webhookId, workspaceId, name, direction, endpointUrl, JSON.stringify(eventTypes), payloadPreset,
        secret.slice(0, 12), await sha256(secret), await encryptSecret(env, secret),
        providerCredential ? providerCredential.slice(0, 6) : null,
        providerCredential ? await encryptSecret(env, providerCredential) : null, now, now).run();
    await audit(env, access, request, "webhook.created", "webhook", webhookId, null,
      { name, direction, url: endpointUrl, payload_preset: payloadPreset });
    return json({ ok: true, webhook: { id: webhookId, secret: payloadPreset === "pagerduty" ? null : secret } }, 201);
  }

  const webhookAdminMatch = url.pathname.match(/^\/v1\/admin\/webhooks\/([^/]+)$/);
  if (webhookAdminMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const destination = optionalString(body.url, "url", 1000);
    const expectedUpdatedAt = optionalString(body.expected_updated_at, "expected_updated_at", 40);
    if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      return json({ error: "expected_updated_at is required" }, 400);
    }
    const before = await env.DB.prepare(`SELECT id,name,direction,url,event_types,payload_preset,secret_prefix,
        provider_credential_prefix,active,created_at,updated_at
      FROM webhook_endpoints WHERE workspace_id=? AND id=?`).bind(workspaceId, webhookAdminMatch[1]).first<Record<string, unknown>>();
    if (!before || before.direction !== "outbound") return json({ error: "Outbound webhook not found" }, 404);
    if (before.payload_preset === "pagerduty") {
      if (Object.keys(body).some((key) => !["provider_credential", "expected_updated_at"].includes(key))) {
        return json({ error: "PagerDuty uses a fixed Events API endpoint" }, 400);
      }
      const providerCredential = optionalString(body.provider_credential, "provider_credential", 200);
      if (!providerCredential || !/^[A-Za-z0-9]{32}$/.test(providerCredential)) {
        return json({ error: "PagerDuty requires a 32-character Events API v2 routing key" }, 400);
      }
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
      const updated = await env.DB.prepare(`UPDATE webhook_endpoints
        SET provider_credential_prefix=?,provider_credential_ciphertext=?,updated_at=?
        WHERE workspace_id=? AND id=? AND direction='outbound' AND payload_preset='pagerduty' AND updated_at=?`)
        .bind(providerCredential.slice(0, 6), await encryptSecret(env, providerCredential), updatedAt,
          workspaceId, webhookAdminMatch[1], expectedUpdatedAt).run();
      if (!updated.meta.changes) {
        return json({ error: "Webhook changed since it was loaded", code: "edit_conflict" }, 409);
      }
      const after = {
        ...before, provider_credential_prefix: providerCredential.slice(0, 6), updated_at: updatedAt,
      };
      await audit(env, access, request, "webhook.provider_credential_rotated",
        "webhook", webhookAdminMatch[1], before, after);
      return json({ ok: true, webhook: after });
    }
    if (!destination || !isSafeWebhookUrl(destination)) return json({ error: "A public HTTPS destination URL is required" }, 400);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1)).toISOString();
    const updated = await env.DB.prepare(`UPDATE webhook_endpoints SET url=?,updated_at=?
      WHERE workspace_id=? AND id=? AND direction='outbound' AND updated_at=?`)
      .bind(destination, updatedAt, workspaceId, webhookAdminMatch[1], expectedUpdatedAt).run();
    if (!updated.meta.changes) return json({ error: "Webhook changed since it was loaded", code: "edit_conflict" }, 409);
    const after = { ...before, url: destination, updated_at: updatedAt };
    await audit(env, access, request, "webhook.destination_changed", "webhook", webhookAdminMatch[1], before, after);
    return json({ ok: true, webhook: after });
  }
  if (webhookAdminMatch && request.method === "DELETE") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const before = await env.DB.prepare("SELECT * FROM webhook_endpoints WHERE workspace_id=? AND id=?")
      .bind(workspaceId, webhookAdminMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Webhook not found" }, 404);
    const deleted = await env.DB.batch([
      env.DB.prepare("DELETE FROM webhook_deliveries WHERE workspace_id=? AND endpoint_id=?").bind(workspaceId, webhookAdminMatch[1]),
      env.DB.prepare("DELETE FROM webhook_endpoints WHERE workspace_id=? AND id=?").bind(workspaceId, webhookAdminMatch[1]),
    ]);
    if (!deleted.at(-1)?.meta.changes) return json({ error: "Webhook not found" }, 404);
    await audit(env, access, request, "webhook.deleted", "webhook", webhookAdminMatch[1], {
      id: before.id, name: before.name, direction: before.direction, url: before.url,
    }, null);
    return json({ ok: true });
  }

  const webhookTestMatch = url.pathname.match(/^\/v1\/admin\/webhooks\/([^/]+)\/test$/);
  if (webhookTestMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const endpoint = await env.DB.prepare(`SELECT * FROM webhook_endpoints
      WHERE workspace_id=? AND id=? AND direction='outbound' AND active=1`)
      .bind(workspaceId, webhookTestMatch[1]).first<Record<string, unknown>>();
    if (!endpoint) return json({ error: "Active outbound webhook not found" }, 404);
    const eventId = id("event_test");
    const providerPreset = String(endpoint.payload_preset || "generic");
    const subscribedEvents = JSON.parse(String(endpoint.event_types || "[]")) as string[];
    const eventType = providerPreset === "generic" ? "contact.created"
      : providerPreset === "slack" && subscribedEvents.includes("visitor_intent_case.created")
        ? "visitor_intent_case.created" : "operations.health.action";
    const eventBody = JSON.stringify({
      id: eventId,
      type: eventType,
      created_at: new Date().toISOString(),
      data: providerPreset === "generic"
        ? { test: true, source: "openoperator_crm_operator" }
        : eventType === "visitor_intent_case.created"
          ? {
            test: true, workspace_id: workspaceId, case_id: `test:${eventId}`,
            company_name: "Example Company", company_domain: "example.test", priority: "normal", intent_score: 72,
            attribution: { contributing_sources: ["Operator test"], visited_pages: ["https://example.test/pricing"], touch_count: 2 },
            score_reasons: [{ label: "Test event only" }],
            isolation: { person_data_included: false, outreach_authorized: false },
          }
        : {
          test: true, workspace_id: workspaceId, incident_id: `test:${eventId}`,
          component_ids: ["operator-test"],
        },
    });
    const deliveryId = id("delivery");
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO webhook_deliveries
      (id,workspace_id,endpoint_id,event_id,direction,status,attempts,request_body,created_at,updated_at)
      VALUES(?,?,?,?,?,'processing',1,?,?,?)`)
      .bind(deliveryId, workspaceId, endpoint.id, eventId, "outbound", eventBody, now, now).run();
    const result = await deliverOutboundWebhook(env, endpoint, deliveryId, eventId, eventType, eventBody, 1);
    let cleanupDelivery: { endpoint_id: string; status: string; response_status?: number } | null = null;
    if (providerPreset === "pagerduty" && result.status === "succeeded") {
      const cleanupEventId = `${eventId}:resolved`;
      const cleanupBody = JSON.stringify({
        id: cleanupEventId,
        type: "operations.health.recovered",
        created_at: new Date().toISOString(),
        data: {
          test: true, workspace_id: workspaceId, incident_id: `test:${eventId}`,
          component_ids: ["operator-test"],
        },
      });
      const cleanupDeliveryId = id("delivery");
      const cleanupNow = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO webhook_deliveries
        (id,workspace_id,endpoint_id,event_id,direction,status,attempts,request_body,created_at,updated_at)
        VALUES(?,?,?,?,?,'processing',1,?,?,?)`)
        .bind(cleanupDeliveryId, workspaceId, endpoint.id, cleanupEventId, "outbound",
          cleanupBody, cleanupNow, cleanupNow).run();
      cleanupDelivery = await deliverOutboundWebhook(
        env, endpoint, cleanupDeliveryId, cleanupEventId,
        "operations.health.recovered", cleanupBody, 1);
    }
    await audit(env, access, request, "webhook.test_sent", "webhook", String(endpoint.id), null, {
      event_id: eventId, delivery_id: deliveryId, status: result.status,
    });
    return json({ ok: true, event_id: eventId, delivery: result, cleanup_delivery: cleanupDelivery }, 202);
  }

  if (url.pathname === "/v1/admin/webhooks/retry" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const batch = await processWebhookRetries(env, workspaceId, 20);
    const results = batch.results.map((result) => ({
      endpoint_id: result.endpoint_id,
      status: result.status,
      ...(result.response_status === undefined ? {} : { response_status: result.response_status }),
    }));
    await audit(env, access, request, "webhooks.retry_processed", "webhook_delivery_batch", id("batch"), null, {
      due: batch.due, claimed: results.length, succeeded: results.filter((result) => result.status === "succeeded").length,
    });
    return json({ ok: true, due: batch.due, processed: results.length, deliveries: results });
  }

  if (url.pathname === "/v1/admin/events/publish" && request.method === "POST") {
    if (!["owner", "admin"].includes(access.role)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const eventType = optionalString(body.type, "type", 120);
    if (!eventType || !/^[a-z0-9_.-]+$/i.test(eventType)) return json({ error: "A valid event type is required" }, 400);
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return json({ error: "data must be an object" }, 400);
    const eventId = optionalString(body.id, "id", 255) || id("event");
    const event = { id: eventId, type: eventType, created_at: new Date().toISOString(), data: body.data };
    const eventBody = JSON.stringify(event);
    const endpoints = await env.DB.prepare(`SELECT * FROM webhook_endpoints
      WHERE workspace_id=? AND direction='outbound' AND active=1 ORDER BY created_at LIMIT 20`).bind(workspaceId).all<Record<string, unknown>>();
    const results: Array<{ endpoint_id: string; status: string; response_status?: number }> = [];
    for (const endpoint of endpoints.results) {
      const eventTypes = JSON.parse(String(endpoint.event_types)) as string[];
      if (eventTypes.length && !eventTypes.includes(eventType) && !eventTypes.includes("*")) continue;
      const deliveryId = id("delivery");
      const now = new Date().toISOString();
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries
        (id,workspace_id,endpoint_id,event_id,direction,status,attempts,request_body,created_at,updated_at)
        VALUES(?,?,?,?,?,'processing',1,?,?,?)`).bind(deliveryId, workspaceId, endpoint.id, eventId, "outbound", eventBody, now, now).run();
      if (!inserted.meta.changes) { results.push({ endpoint_id: String(endpoint.id), status: "duplicate" }); continue; }
      results.push(await deliverOutboundWebhook(env, endpoint, deliveryId, eventId, eventType, eventBody, 1));
    }
    await audit(env, access, request, "event.published", "event", eventId, null, { type: eventType, deliveries: results.length });
    return json({ ok: true, event_id: eventId, deliveries: results }, 202);
  }

  if (url.pathname === "/v1/admin/agent/analyze" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const startedAt = new Date().toISOString();
    const runId = id("arun");
    const policy = await env.DB.prepare("SELECT * FROM agent_policies WHERE workspace_id=?")
      .bind(workspaceId).first<Record<string, unknown>>();
    if (!policy) return json({ error: "Revenue-agent policy is not configured" }, 409);
    if (!policy.agent_access_enabled) return json({ error: "Agent access is disabled for this workspace" }, 403);
    const policySnapshot = {
      mode: policy.mode,
      require_approval: Boolean(policy.require_approval),
      max_proposals_per_run: Number(policy.max_proposals_per_run),
      stale_after_days: Number(policy.stale_after_days),
      high_value_threshold: Number(policy.high_value_threshold),
    };
    const lease = await acquireWorkspaceOperationLease(env, workspaceId, "revenue_analysis", runId, startedAt);
    if (!lease.acquired) {
      return json({
        error: lease.active?.operation === "workspace_restore"
          ? "A workspace restore is already running; revenue analysis is temporarily paused"
          : "A revenue-agent analysis is already running for this workspace",
        code: "agent_run_in_progress",
        blocking_operation: lease.active?.operation || "unknown",
        retry_after_seconds: lease.retryAfter,
      }, 409, { "retry-after": String(lease.retryAfter) });
    }
    try {
    await env.DB.prepare(`INSERT INTO agent_runs
      (id,workspace_id,agent_type,trigger_type,status,policy_snapshot,started_at)
      VALUES(?,?,'revenue_operator','manual','running',?,?)`)
      .bind(runId, workspaceId, JSON.stringify(policySnapshot), startedAt).run();
    const opportunities = await env.DB.prepare(`SELECT o.*,c.first_name,c.last_name,c.email,c.score contact_score,
      s.name stage_name,s.position stage_position
      FROM opportunities o JOIN contacts c ON c.id=o.contact_id AND c.workspace_id=o.workspace_id
      JOIN pipeline_stages s ON s.id=o.stage_id
      WHERE o.workspace_id=? AND o.status='open'
      ORDER BY o.updated_at DESC,o.id DESC LIMIT 250`).bind(workspaceId).all<Record<string, unknown>>();
    const leads = await env.DB.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM opportunities o WHERE o.workspace_id=c.workspace_id AND o.contact_id=c.id AND o.status='open') open_opportunities
      FROM contacts c WHERE c.workspace_id=? AND c.status='lead'`).bind(workspaceId).all<Record<string, unknown>>();
    const evaluatedContactsCte = `WITH evaluated_opportunities AS (
        SELECT contact_id FROM opportunities
        WHERE workspace_id=? AND status='open'
        ORDER BY updated_at DESC,id DESC LIMIT 250
      ), evaluated_contacts AS (
        SELECT DISTINCT contact_id FROM evaluated_opportunities
      )`;
    const [communicationRows, latestCallRows] = await Promise.all([
      env.DB.prepare(`${evaluatedContactsCte}, ranked AS (
          SELECT a.contact_id,a.type,a.metadata,a.occurred_at,a.id,
            ROW_NUMBER() OVER (PARTITION BY a.contact_id ORDER BY a.occurred_at DESC,a.id DESC) row_number
          FROM activities a JOIN evaluated_contacts e ON e.contact_id=a.contact_id
          WHERE a.workspace_id=?
          AND a.type IN ('sales.call_analyzed','email.received','email.sent','calendar.meeting_scheduled','calendar.meeting_completed')
        ) SELECT contact_id,type,metadata,occurred_at FROM ranked WHERE row_number=1`)
        .bind(workspaceId, workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`${evaluatedContactsCte}, ranked AS (
          SELECT a.contact_id,a.type,a.metadata,a.occurred_at,a.id,
            ROW_NUMBER() OVER (PARTITION BY a.contact_id ORDER BY a.occurred_at DESC,a.id DESC) row_number
          FROM activities a JOIN evaluated_contacts e ON e.contact_id=a.contact_id
          WHERE a.workspace_id=? AND a.type='sales.call_analyzed'
        ) SELECT contact_id,type,metadata,occurred_at FROM ranked WHERE row_number=1`)
        .bind(workspaceId, workspaceId).all<Record<string, unknown>>(),
    ]);
    const latestCommunicationByContact = new Map<string, Record<string, unknown>>();
    const latestCallByContact = new Map<string, { metadata: CommunicationMetadata; occurred_at: string }>();
    for (const row of communicationRows.results) {
      const contactId = String(row.contact_id);
      latestCommunicationByContact.set(contactId, row);
    }
    for (const row of latestCallRows.results) {
      latestCallByContact.set(String(row.contact_id), {
        metadata: communicationMetadata(row.metadata),
        occurred_at: String(row.occurred_at),
      });
    }
    let created = 0;
    let refreshed = 0;
    let healthy = 0;
    let evaluated = 0;
    const reasons = { missing_next_step: 0, stale: 0, overdue: 0, unowned: 0, missing_close_date: 0, zero_value: 0, lead_follow_up: 0, call_risk: 0 };
    const candidates: Array<{
      dedupeKey: string; contactId: string; opportunityId: string | null; title: string; rationale: string;
      category: string; priority: number; confidence: number; risk: string; action: Json;
    }> = [];
    const staleDays = Number(policy.stale_after_days);
    const highValue = Number(policy.high_value_threshold);
    for (const opportunity of opportunities.results) {
      evaluated++;
      const latestCommunication = latestCommunicationByContact.get(String(opportunity.contact_id));
      const latestCall = latestCallByContact.get(String(opportunity.contact_id));
      const crmActivityTime = Date.parse(String(opportunity.last_activity_at || opportunity.updated_at));
      const communicationTime = latestCommunication ? Date.parse(String(latestCommunication.occurred_at)) : 0;
      const activityTime = Math.max(Number.isFinite(crmActivityTime) ? crmActivityTime : 0, Number.isFinite(communicationTime) ? communicationTime : 0);
      const ageDays = Number.isFinite(activityTime) ? Math.max(0, Math.floor((Date.now() - activityTime) / 86_400_000)) : staleDays;
      const missingNextStep = !opportunity.next_step;
      const closeOverdue = Boolean(opportunity.expected_close_at && Date.parse(String(opportunity.expected_close_at)) < Date.now());
      const missingCloseDate = Number(opportunity.stage_position) >= 2 && !opportunity.expected_close_at;
      const zeroValue = Number(opportunity.stage_position) >= 1 && Number(opportunity.value) <= 0;
      const unowned = !opportunity.owner;
      const stale = ageDays >= staleDays;
      const callRisk = latestCall?.metadata.sentiment === "negative" ||
        (latestCall?.metadata.objections.length || 0) > 0 ||
        latestCall?.metadata.next_step_detected === false;
      if (!missingNextStep && !closeOverdue && !missingCloseDate && !zeroValue && !unowned && !stale && !callRisk) { healthy++; continue; }
      if (missingNextStep) reasons.missing_next_step++;
      if (stale) reasons.stale++;
      if (closeOverdue) reasons.overdue++;
      if (unowned) reasons.unowned++;
      if (missingCloseDate) reasons.missing_close_date++;
      if (zeroValue) reasons.zero_value++;
      if (callRisk) reasons.call_risk++;
      const contactName = [opportunity.first_name, opportunity.last_name].filter(Boolean).join(" ") || String(opportunity.email);
      const detailReasons = [
        missingNextStep ? "no next step is recorded" : null,
        stale ? `the deal has had no activity for ${ageDays} days` : null,
        closeOverdue ? "the expected close date has passed" : null,
        missingCloseDate ? "a late-stage deal has no expected close date" : null,
        zeroValue ? "a qualified deal has no value" : null,
        unowned ? "the deal has no owner" : null,
        latestCall?.metadata.sentiment === "negative" ? "the latest analyzed call was negative" : null,
        (latestCall?.metadata.objections.length || 0) > 0 ? `${latestCall!.metadata.objections.length} call objection${latestCall!.metadata.objections.length === 1 ? "" : "s"} need review` : null,
        latestCall?.metadata.next_step_detected === false ? "the latest call had no detected next-step commitment" : null,
      ].filter(Boolean);
      const dataQuality = missingCloseDate || zeroValue || unowned;
      const priority = Math.min(100, 45 + (closeOverdue ? 25 : 0) + (missingNextStep ? 15 : 0) +
        (Number(opportunity.value) >= highValue ? 10 : 0) + (dataQuality ? 10 : 0) + (callRisk ? 15 : 0));
      candidates.push({
        dedupeKey: `opportunity:${opportunity.id}:next-best-action`,
        contactId: String(opportunity.contact_id),
        opportunityId: String(opportunity.id),
        title: `${dataQuality ? "Repair" : "Advance"} ${opportunity.name}`,
        rationale: `${contactName} needs attention because ${detailReasons.join(", ")}.`,
        category: dataQuality ? "data_quality" : callRisk ? "communication_risk" : "pipeline_execution",
        priority,
        confidence: Math.min(95, 60 + detailReasons.length * 8 + Math.min(ageDays, 10)),
        risk: Number(opportunity.value) >= highValue ? "medium" : "low",
        action: {
          type: "create_task",
          title: `${dataQuality ? "Review pipeline data for" : callRisk ? "Review sales-call risk for" : "Follow up on"} ${opportunity.name}`,
          priority: closeOverdue || priority >= 80 ? "urgent" : "high",
          due_at: startedAt,
          contact_id: opportunity.contact_id,
          opportunity_id: opportunity.id,
        },
      });
    }
    for (const lead of leads.results.slice(0, 250)) {
      if (Number(lead.open_opportunities) > 0) continue;
      evaluated++;
      const activityTime = lead.last_activity_at ? Date.parse(String(lead.last_activity_at)) : Date.parse(String(lead.created_at));
      const ageDays = Number.isFinite(activityTime) ? Math.max(0, Math.floor((Date.now() - activityTime) / 86_400_000)) : staleDays;
      const followUpOverdue = Boolean(lead.next_follow_up_at && Date.parse(String(lead.next_follow_up_at)) <= Date.now());
      const unowned = !lead.owner;
      const stale = ageDays >= staleDays;
      if (!followUpOverdue && !unowned && !stale) { healthy++; continue; }
      reasons.lead_follow_up++;
      if (unowned) reasons.unowned++;
      if (stale) reasons.stale++;
      const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || String(lead.email);
      const why = [followUpOverdue ? "follow-up is overdue" : null, unowned ? "no owner is assigned" : null, stale ? `${ageDays} days without activity` : null].filter(Boolean);
      candidates.push({
        dedupeKey: `contact:${lead.id}:qualification`,
        contactId: String(lead.id),
        opportunityId: null,
        title: `Qualify ${leadName}`,
        rationale: `This lead is outside the opportunity pipeline and ${why.join(", ")}.`,
        category: "lead_qualification",
        priority: Math.min(90, 50 + (followUpOverdue ? 20 : 0) + (unowned ? 10 : 0) + Math.min(ageDays, 10)),
        confidence: Math.min(90, 65 + why.length * 7),
        risk: "low",
        action: {
          type: "create_task",
          title: `Qualify ${leadName}`,
          priority: followUpOverdue ? "high" : "normal",
          due_at: startedAt,
          contact_id: lead.id,
          opportunity_id: null,
        },
      });
    }
    const ranked = candidates.sort((a, b) => b.priority - a.priority).slice(0, Number(policy.max_proposals_per_run));
    for (const candidate of ranked) {
      const pending = await env.DB.prepare(`SELECT id FROM agent_proposals
        WHERE workspace_id=? AND dedupe_key=? AND status='pending' LIMIT 1`)
        .bind(workspaceId, candidate.dedupeKey).first<{ id: string }>();
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      if (pending) {
        await env.DB.prepare(`UPDATE agent_proposals SET run_id=?,title=?,rationale=?,confidence=?,risk_level=?,
          proposed_action=?,category=?,priority=?,expires_at=?,created_at=? WHERE workspace_id=? AND id=?`)
          .bind(runId, candidate.title, candidate.rationale, candidate.confidence, candidate.risk,
            JSON.stringify(candidate.action), candidate.category, candidate.priority, expiresAt, startedAt, workspaceId, pending.id).run();
        refreshed++;
      } else {
        await env.DB.prepare(`INSERT INTO agent_proposals
          (id,workspace_id,contact_id,opportunity_id,agent_type,title,rationale,confidence,risk_level,proposed_action,status,created_at,
           run_id,dedupe_key,category,priority,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`)
          .bind(id("proposal"), workspaceId, candidate.contactId, candidate.opportunityId, "revenue_operator",
            candidate.title, candidate.rationale, candidate.confidence, candidate.risk, JSON.stringify(candidate.action), startedAt,
            runId, candidate.dedupeKey, candidate.category, candidate.priority, expiresAt).run();
        created++;
      }
    }
    const expired = await env.DB.prepare(`UPDATE agent_proposals SET status='expired'
      WHERE workspace_id=? AND agent_type='revenue_operator' AND status='pending' AND (run_id IS NULL OR run_id<>?)`)
      .bind(workspaceId, runId).run();
    const observations = {
      opportunities: opportunities.results.length,
      leads_without_open_opportunity: leads.results.filter((lead) => Number(lead.open_opportunities) === 0).length,
      healthy,
      reasons,
      candidate_count: candidates.length,
      capped: candidates.length > ranked.length,
    };
    const finishedAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE agent_runs SET status='succeeded',observations=?,proposals_created=?,
      proposals_refreshed=?,proposals_expired=?,finished_at=? WHERE id=?`)
      .bind(JSON.stringify(observations), created, refreshed, expired.meta.changes || 0, finishedAt, runId).run();
    const summary = {
      analysis_id: runId, analyzed: evaluated, proposals_created: created, proposals_refreshed: refreshed,
      proposals_expired: expired.meta.changes || 0, healthy, reasons, policy: policySnapshot,
    };
    await audit(env, access, request, "agent.run_completed", "agent_run", runId, null, summary);
    return json({ ok: true, ...summary });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown revenue-agent error";
      await env.DB.prepare("UPDATE agent_runs SET status='failed',error=?,finished_at=? WHERE id=?")
        .bind(message, new Date().toISOString(), runId).run();
      console.error(JSON.stringify({ message: "Revenue agent run failed", run_id: runId, error: message }));
      return json({ error: "The revenue agent run failed", run_id: runId }, 500);
    } finally {
      try {
        await releaseWorkspaceOperationLease(env, workspaceId, runId);
      } catch (leaseError) {
        console.error(JSON.stringify({
          message: "Revenue agent lease cleanup failed",
          run_id: runId,
          error: leaseError instanceof Error ? leaseError.message.slice(0, 500) : "Unknown lease cleanup error",
        }));
      }
    }
  }

  const proposalMatch = url.pathname.match(/^\/v1\/admin\/agent\/proposals\/([^/]+)\/decision$/);
  if (proposalMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const decision = optionalString(body.decision, "decision", 20);
    if (!decision || !["approved", "rejected"].includes(decision)) return json({ error: "decision must be approved or rejected" }, 400);
    const proposal = await env.DB.prepare("SELECT * FROM agent_proposals WHERE workspace_id=? AND id=?")
      .bind(workspaceId, proposalMatch[1]).first<Record<string, unknown>>();
    if (!proposal) return json({ error: "Proposal not found" }, 404);
    if (proposal.status !== "pending" && !(proposal.status === "executing" && decision === "approved")) {
      return json({ error: "Proposal was already decided" }, 409);
    }
    const reviewedAt = new Date().toISOString();
    if (proposal.status === "pending" && proposal.expires_at &&
      Date.parse(String(proposal.expires_at)) <= Date.parse(reviewedAt)) {
      const executionResult = { executed: false, expired: true, message: "This proposal expired before a human decision." };
      const expired = await env.DB.batch([
        env.DB.prepare(`UPDATE agent_proposals
          SET status='expired',reviewed_by=?,reviewed_at=?,execution_result=?
          WHERE workspace_id=? AND id=? AND status='pending' AND expires_at<=?`)
          .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1], reviewedAt),
        await proposalDecisionAuditStatement(env, access, request, "agent.proposal_expired", proposalMatch[1],
          proposal, executionResult, "expired", reviewedAt),
      ]);
      if (!expired[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
      return json({ error: executionResult.message, code: "proposal_expired", status: "expired", result: executionResult }, 410);
    }
    if (decision === "rejected") {
      const executionResult = { executed: false, rejected: true };
      const rejected = await env.DB.batch([
        env.DB.prepare(`UPDATE agent_proposals
          SET status='rejected',reviewed_by=?,reviewed_at=?,execution_result=?
          WHERE workspace_id=? AND id=? AND status='pending'`)
          .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
        await proposalDecisionAuditStatement(env, access, request, "agent.proposal_rejected", proposalMatch[1],
          proposal, executionResult, "rejected", reviewedAt),
      ]);
      if (!rejected[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
      return json({ ok: true, status: "rejected", result: executionResult });
    }
    const agentPolicy = await env.DB.prepare("SELECT agent_access_enabled FROM agent_policies WHERE workspace_id=?")
      .bind(workspaceId).first<{ agent_access_enabled: number }>();
    if (proposal.status === "pending" && !agentPolicy?.agent_access_enabled) {
      return json({
        error: "Agent access is disabled for this workspace. Re-enable it before approving pending actions.",
        code: "agent_access_disabled",
      }, 409);
    }

    const validation = validateStoredProposalAction(proposal.proposed_action);
    if ("error" in validation) {
      const executionResult = { executed: false, invalid: true, message: validation.error };
      const invalidated = await env.DB.batch([
        env.DB.prepare(`UPDATE agent_proposals
          SET status='invalid',reviewed_by=?,reviewed_at=?,execution_result=?
          WHERE workspace_id=? AND id=? AND status='pending'`)
          .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
        await proposalDecisionAuditStatement(env, access, request, "agent.proposal_invalid", proposalMatch[1],
          proposal, executionResult, "invalid", reviewedAt),
      ]);
      if (!invalidated[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
      return json({ error: validation.error, code: "invalid_proposal_action", result: executionResult }, 422);
    }

    const action = validation.action;
    const now = new Date().toISOString();
    if (action.type === "open_intent_case") {
      const [evidence, originAuthorization, activeCase] = await Promise.all([
        loadVisitorAccountEvidence(env, workspaceId, action.company_domain),
        env.DB.prepare(`SELECT c.id FROM agent_credentials c
          WHERE c.workspace_id=? AND c.id=? AND c.active=1 AND (c.expires_at IS NULL OR c.expires_at>?)
            AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='crm:visitor-intent:propose')`)
          .bind(workspaceId, proposal.credential_id, now).first<{ id: string }>(),
        env.DB.prepare(`SELECT id FROM visitor_intent_cases
          WHERE workspace_id=? AND company_domain=? AND status IN ('new','in_review')`)
          .bind(workspaceId, action.company_domain).first<{ id: string }>(),
      ]);
      const eligible = originAuthorization && evidence &&
        evidence.evidence_updated_at === action.expected_evidence_updated_at && !activeCase;
      if (!eligible) {
        const executionResult = {
          executed: false, conflict: true,
          message: !originAuthorization ? "The originating credential is revoked, expired, or no longer authorized for visitor proposals."
            : !evidence ? "The intent account no longer has reviewable evidence."
            : activeCase ? "An active Intent Case already exists for this account."
            : "The account received new evidence after this proposal was created.",
        };
        const conflicted = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals SET status='conflicted',reviewed_by=?,reviewed_at=?,execution_result=?
            WHERE workspace_id=? AND id=? AND status='pending'`)
            .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
            proposal, executionResult, "conflicted", reviewedAt),
        ]);
        if (!conflicted[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
        return json({ error: executionResult.message, code: "execution_conflict", status: "conflicted", result: executionResult }, 409);
      }
      const caseId = id("vicase");
      const changeId = id("vchange");
      const snapshot = JSON.stringify(evidence);
      const executionResult = {
        executed: true, intent_case_id: caseId, company_domain: action.company_domain,
        outreach_authorized: false,
      };
      const ip = request.headers.get("cf-connecting-ip");
      try {
        const results = await env.DB.batch([
          env.DB.prepare(`INSERT INTO visitor_intent_cases
            (id,workspace_id,company_domain,company_name,status,priority,owner,due_at,evidence_updated_at,
             intent_score,evidence_snapshot,revision,change_id,created_by,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?, ?,?,?,1,?,?,?,? FROM agent_proposals p
            WHERE p.workspace_id=? AND p.id=? AND p.status='pending' AND (p.expires_at IS NULL OR p.expires_at>?)
              AND EXISTS(SELECT 1 FROM agent_policies WHERE workspace_id=? AND agent_access_enabled=1)
              AND EXISTS(SELECT 1 FROM agent_credentials c WHERE c.workspace_id=? AND c.id=?
                AND c.active=1 AND (c.expires_at IS NULL OR c.expires_at>?)
                AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='crm:visitor-intent:propose'))
              AND EXISTS(SELECT 1 FROM visitor_profiles vp WHERE vp.workspace_id=? AND LOWER(TRIM(vp.company_domain))=?
                AND vp.review_status IN ('new','reviewed')
                GROUP BY LOWER(TRIM(vp.company_domain)) HAVING MAX(vp.updated_at)=?)
              AND NOT EXISTS(SELECT 1 FROM visitor_intent_cases vic WHERE vic.workspace_id=?
                AND vic.company_domain=? AND vic.status IN ('new','in_review'))`)
            .bind(caseId, workspaceId, action.company_domain, String(evidence.company_name || action.company_domain),
              "new", action.priority, null, action.due_at, action.expected_evidence_updated_at,
              Number(evidence.intent_score), snapshot, changeId, `agent:${proposal.credential_id || proposal.agent_type}`, now, now,
              workspaceId, proposalMatch[1], now, workspaceId, workspaceId, proposal.credential_id, now,
              workspaceId, action.company_domain, action.expected_evidence_updated_at, workspaceId, action.company_domain),
          env.DB.prepare(`INSERT INTO audit_log
            (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
            SELECT ?,?,'user',?,'visitor_intent_case.created','visitor_intent_case',?,NULL,?,?,?,?
            WHERE EXISTS(SELECT 1 FROM visitor_intent_cases WHERE workspace_id=? AND id=? AND change_id=?)`)
            .bind(id("audit"), workspaceId, access.email, caseId,
              JSON.stringify({ company_domain: action.company_domain, status: "new", priority: action.priority,
                evidence_updated_at: action.expected_evidence_updated_at, intent_score: evidence.intent_score, via: "agent_proposal" }),
              requestId(request), ip ? await sha256(ip) : null, now, workspaceId, caseId, changeId),
          env.DB.prepare(`UPDATE agent_proposals SET status='approved',reviewed_by=?,reviewed_at=?,execution_result=?
            WHERE workspace_id=? AND id=? AND status='pending'
              AND EXISTS(SELECT 1 FROM visitor_intent_cases WHERE workspace_id=? AND id=? AND change_id=?)`)
            .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1],
              workspaceId, caseId, changeId),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_approved", proposalMatch[1],
            proposal, executionResult, "approved", reviewedAt),
        ]);
        if (!results[2].meta.changes) {
          return json({ error: "Intent evidence changed or another reviewer opened a case.", code: "execution_conflict" }, 409);
        }
      } catch {
        const currentCase = await env.DB.prepare(`SELECT id FROM visitor_intent_cases
          WHERE workspace_id=? AND company_domain=? AND status IN ('new','in_review')`)
          .bind(workspaceId, action.company_domain).first<{ id: string }>();
        if (currentCase) {
          return json({ error: "An active Intent Case already exists for this account.", code: "execution_conflict" }, 409);
        }
        throw new ApiError(500, "The approved Intent Case could not be recorded");
      }
      return json({ ok: true, status: "approved", result: executionResult }, 201);
    }
    if (action.type === "promote_visitor") {
      const [profile, originAuthorization] = await Promise.all([
        env.DB.prepare(`SELECT * FROM visitor_profiles WHERE workspace_id=? AND id=?`)
          .bind(workspaceId, action.visitor_profile_id).first<Record<string, unknown>>(),
        env.DB.prepare(`SELECT c.id FROM agent_credentials c
          WHERE c.workspace_id=? AND c.id=? AND c.active=1 AND (c.expires_at IS NULL OR c.expires_at>?)
            AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='crm:visitor-intent:propose')`)
          .bind(workspaceId, proposal.credential_id, now).first<{ id: string }>(),
      ]);
      const email = normalizeEmail(profile?.email);
      const eligible = originAuthorization && profile && Number(profile.revision) === action.expected_revision &&
        ["new", "reviewed"].includes(String(profile.review_status)) &&
        profile.identity_kind === "person" && profile.consent_status !== "denied" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!eligible) {
        const executionResult = {
          executed: false, conflict: true,
          message: !originAuthorization ? "The originating agent credential is revoked, expired, or no longer authorized for visitor proposals."
            : !profile ? "The visitor profile no longer exists."
            : Number(profile.revision) !== action.expected_revision ? "The visitor received new data after this proposal was created."
              : "The visitor is no longer eligible for person promotion.",
        };
        const conflicted = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals SET status='conflicted',reviewed_by=?,reviewed_at=?,execution_result=?
            WHERE workspace_id=? AND id=? AND status='pending'`)
            .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
            proposal, executionResult, "conflicted", reviewedAt),
        ]);
        if (!conflicted[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
        return json({ error: executionResult.message, code: "execution_conflict", status: "conflicted", result: executionResult }, 409);
      }
      const generatedContactId = id("con");
      const companyName = String(profile.company_name || "").trim();
      const companyRecord = companyName ? await companyIdentity(env, workspaceId, companyName, now) : null;
      const changeId = id("vchange");
      const nextRevision = action.expected_revision + 1;
      const executionResult = {
        executed: true, visitor_profile_id: profile.id,
        outreach_authorized: false, consent_warning: profile.consent_status === "unknown",
      };
      const profileGate = `EXISTS(SELECT 1 FROM visitor_profiles
        WHERE workspace_id=? AND id=? AND revision=? AND review_status IN ('new','reviewed')
          AND identity_kind='person' AND consent_status<>'denied')`;
      const proposalGate = `EXISTS(SELECT 1 FROM agent_proposals
        WHERE workspace_id=? AND id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)
          AND EXISTS(SELECT 1 FROM agent_policies WHERE workspace_id=? AND agent_access_enabled=1)
          AND EXISTS(SELECT 1 FROM agent_credentials c
            WHERE c.workspace_id=? AND c.id=? AND c.active=1 AND (c.expires_at IS NULL OR c.expires_at>?)
              AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='crm:visitor-intent:propose')))`;
      const insertCompany = companyRecord
        ? env.DB.prepare(`INSERT OR IGNORE INTO companies(id,workspace_id,name,name_key,domain,website,industry,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?,? WHERE ${profileGate} AND ${proposalGate}`)
          .bind(companyRecord.id, workspaceId, companyRecord.name, companyRecord.nameKey, profile.company_domain,
            profile.company_domain ? `https://${profile.company_domain}` : null, profile.industry, now, now,
            workspaceId, profile.id, action.expected_revision,
            workspaceId, proposalMatch[1], now, workspaceId, workspaceId, proposal.credential_id, now)
        : env.DB.prepare("SELECT 1");
      const ip = request.headers.get("cf-connecting-ip");
      const ipHash = ip ? await sha256(ip) : null;
      let results: D1Result<unknown>[];
      try {
        results = await env.DB.batch([
          insertCompany,
          env.DB.prepare(`INSERT OR IGNORE INTO contacts
            (id,workspace_id,email,first_name,last_name,company,company_id,status,stage,score,source_first,source_last,
             tags,custom_fields,last_activity_at,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,'lead','new',0,?,?,?, ?,?,?,?
            WHERE ${profileGate} AND ${proposalGate}`)
            .bind(generatedContactId, workspaceId, email, profile.first_name, profile.last_name,
              companyRecord?.name || companyName || null, companyRecord?.id || null,
              `visitor:${profile.provider}`, `visitor:${profile.provider}`,
              JSON.stringify(["website-visitor", `visitor:${profile.provider}`]),
              JSON.stringify({ visitor_intent: { profile_id: profile.id, consent_status: profile.consent_status } }),
              profile.last_seen_at, now, now,
              workspaceId, profile.id, action.expected_revision,
              workspaceId, proposalMatch[1], now, workspaceId, workspaceId, proposal.credential_id, now),
          env.DB.prepare(`UPDATE visitor_profiles SET review_status='promoted',
              matched_contact_id=(SELECT id FROM contacts WHERE workspace_id=? AND email=? LIMIT 1),
              review_change_id=?,revision=revision+1,updated_at=?
            WHERE workspace_id=? AND id=? AND revision=? AND review_status IN ('new','reviewed')
              AND identity_kind='person' AND consent_status<>'denied' AND ${proposalGate}`)
            .bind(workspaceId, email, changeId, now, workspaceId, profile.id, action.expected_revision,
              workspaceId, proposalMatch[1], now, workspaceId, workspaceId, proposal.credential_id, now),
          env.DB.prepare(`INSERT INTO audit_log
            (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,
             request_id,ip_hash,created_at)
            SELECT ?,?,'user',?,'visitor_profile.promoted','visitor_profile',?,?,?,?,?,?
            WHERE EXISTS(SELECT 1 FROM visitor_profiles
              WHERE workspace_id=? AND id=? AND revision=? AND review_status='promoted' AND review_change_id=?)`)
            .bind(id("audit"), workspaceId, access.email, profile.id,
              JSON.stringify({ review_status: profile.review_status, revision: profile.revision }),
              JSON.stringify({ review_status: "promoted", revision: nextRevision, email, via: "agent_proposal" }),
              requestId(request), ipHash, now, workspaceId, profile.id, nextRevision, changeId),
          env.DB.prepare(`UPDATE agent_proposals SET status='approved',reviewed_by=?,reviewed_at=?,
              execution_result=json_set(?, '$.contact_id',
                (SELECT matched_contact_id FROM visitor_profiles WHERE workspace_id=? AND id=?))
            WHERE workspace_id=? AND id=? AND status='pending' AND EXISTS(
              SELECT 1 FROM visitor_profiles WHERE workspace_id=? AND id=? AND revision=?
                AND review_status='promoted' AND review_change_id=?
            )`).bind(access.email, reviewedAt, JSON.stringify(executionResult),
              workspaceId, profile.id, workspaceId, proposalMatch[1],
              workspaceId, profile.id, nextRevision, changeId),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_approved", proposalMatch[1],
            proposal, executionResult, "approved", reviewedAt),
        ]);
      } catch (error) {
        if (String(error).includes("audit_log_visitor_profile_promoted_once")) {
          const conflictResult = {
            executed: false, conflict: true,
            message: "The visitor was promoted by another decision before this proposal committed.",
          };
          await env.DB.batch([
            env.DB.prepare(`UPDATE agent_proposals
              SET status='conflicted',reviewed_by=?,reviewed_at=?,execution_result=?
              WHERE workspace_id=? AND id=? AND status='pending'`)
              .bind(access.email, reviewedAt, JSON.stringify(conflictResult), workspaceId, proposalMatch[1]),
            await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
              proposal, conflictResult, "conflicted", reviewedAt),
          ]);
          return json({
            error: conflictResult.message, code: "execution_conflict",
            status: "conflicted", result: conflictResult,
          }, 409);
        }
        throw error;
      }
      if (!results[4].meta.changes) {
        return json({ error: "Agent access changed, the visitor changed, or another reviewer decided first.", code: "execution_conflict" }, 409);
      }
      const contact = await env.DB.prepare("SELECT * FROM contacts WHERE workspace_id=? AND email=?")
        .bind(workspaceId, email).first<Record<string, unknown>>();
      if (!contact) throw new Error("Promoted visitor contact was not resolved");
      const created = Boolean(results[1].meta.changes) && contact.id === generatedContactId;
      if (created) {
        await runContactAutomations(env, access, contact, `visitor-proposal:${proposalMatch[1]}:${nextRevision}`, "contact.created");
      }
      return json({
        ok: true, status: "approved",
        result: { ...executionResult, created, contact_id: contact.id },
      }, created ? 201 : 200);
    }
    if (action.type === "run_workflow") {
      const eventId = `agent-proposal:${proposalMatch[1]}`;
      const existingRun = await env.DB.prepare(`SELECT id,status,step_count,error FROM automation_runs
        WHERE workspace_id=? AND rule_id=? AND event_id=?`)
        .bind(workspaceId, action.workflow_id, eventId).first<Record<string, unknown>>();
      const finalizeRun = async (run: Record<string, unknown>) => {
        const executionResult = {
          executed: true, workflow_id: action.workflow_id, run_id: run.id,
          run_status: run.status, step_count: run.step_count,
        };
        const reviewTime = String(proposal.reviewed_at || reviewedAt);
        const finalized = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals SET status='approved',execution_result=?
            WHERE workspace_id=? AND id=? AND status='executing'`)
            .bind(JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_approved", proposalMatch[1],
            proposal, executionResult, "approved", reviewTime, String(proposal.reviewed_by || access.email)),
        ]);
        if (!finalized[0].meta.changes) {
          const current = await env.DB.prepare("SELECT status,execution_result FROM agent_proposals WHERE workspace_id=? AND id=?")
            .bind(workspaceId, proposalMatch[1]).first<{ status: string; execution_result: string | null }>();
          if (current?.status === "approved") return JSON.parse(current.execution_result || JSON.stringify(executionResult));
          throw new Error("Workflow proposal finalization failed");
        }
        return executionResult;
      };
      if (proposal.status === "executing") {
        if (existingRun) {
          const executionResult = await finalizeRun(existingRun);
          return json({ ok: true, status: "approved", result: executionResult });
        }
        const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
        if (String(proposal.reviewed_at || "") >= staleBefore) {
          return json({ error: "Workflow proposal execution is still in progress", code: "execution_in_progress" }, 409);
        }
        const executionResult = {
          executed: false, conflict: true,
          message: "Workflow execution was interrupted before a run was recorded. Create a fresh proposal to retry.",
        };
        const conflicted = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals SET status='conflicted',execution_result=?
            WHERE workspace_id=? AND id=? AND status='executing' AND reviewed_at<? AND NOT EXISTS(
              SELECT 1 FROM automation_runs WHERE workspace_id=? AND rule_id=? AND event_id=?
            )`).bind(JSON.stringify(executionResult), workspaceId, proposalMatch[1], staleBefore,
              workspaceId, action.workflow_id, eventId),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
            proposal, executionResult, "conflicted", String(proposal.reviewed_at || reviewedAt),
            String(proposal.reviewed_by || access.email)),
        ]);
        if (!conflicted[0].meta.changes) {
          return json({ error: "Workflow proposal execution state changed; reload and inspect the run.", code: "execution_conflict" }, 409);
        }
        return json({ error: executionResult.message, code: "execution_interrupted", status: "conflicted", result: executionResult }, 409);
      }
      const workflow = await env.DB.prepare(`SELECT * FROM automation_rules
        WHERE workspace_id=? AND id=? AND updated_at=? AND status='active' AND trigger_type=?`)
        .bind(workspaceId, action.workflow_id, action.workflow_updated_at, `${action.record_type}.manual`)
        .first<Record<string, unknown>>();
      const record = workflow
        ? await env.DB.prepare(`SELECT * FROM ${action.record_type === "contact" ? "contacts" : "opportunities"}
            WHERE workspace_id=? AND id=?`).bind(workspaceId, action.record_id).first<Record<string, unknown>>()
        : null;
      if (!workflow || !record) {
        const executionResult = {
          executed: false, conflict: true,
          message: !workflow
            ? "The workflow changed, was paused, or is no longer manual."
            : "The selected workflow record no longer exists.",
        };
        const conflicted = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals
            SET status='conflicted',reviewed_by=?,reviewed_at=?,execution_result=?
            WHERE workspace_id=? AND id=? AND status='pending'`)
            .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
            proposal, executionResult, "conflicted", reviewedAt),
        ]);
        if (!conflicted[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
        return json({ error: executionResult.message, code: "execution_conflict", status: "conflicted", result: executionResult }, 409);
      }
      const claimed = await env.DB.prepare(`UPDATE agent_proposals
        SET status='executing',reviewed_by=?,reviewed_at=?
        WHERE workspace_id=? AND id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)
          AND EXISTS(SELECT 1 FROM agent_policies WHERE workspace_id=? AND agent_access_enabled=1)`)
        .bind(access.email, reviewedAt, workspaceId, proposalMatch[1], now, workspaceId).run();
      if (!claimed.meta.changes) {
        return json({ error: "Agent access changed, the proposal expired, or another reviewer already decided it.", code: "execution_conflict" }, 409);
      }
      const runOptions = {
        onlyRuleId: action.workflow_id,
        actor: { type: "agent", id: String(proposal.credential_id || proposal.agent_type) },
      };
      let run: Record<string, unknown> | null = null;
      try {
        const runIds = action.record_type === "contact"
          ? await runContactAutomations(env, access, record, eventId, "contact.manual", runOptions)
          : await runOpportunityAutomations(env, access, record, eventId, "opportunity.manual", runOptions);
        run = runIds.length
          ? await env.DB.prepare("SELECT id,status,step_count,error FROM automation_runs WHERE workspace_id=? AND id=?")
            .bind(workspaceId, runIds[0]).first<Record<string, unknown>>()
          : await env.DB.prepare(`SELECT id,status,step_count,error FROM automation_runs
              WHERE workspace_id=? AND rule_id=? AND event_id=?`)
            .bind(workspaceId, action.workflow_id, eventId).first<Record<string, unknown>>();
      } catch (error) {
        run = await env.DB.prepare(`SELECT id,status,step_count,error FROM automation_runs
          WHERE workspace_id=? AND rule_id=? AND event_id=?`)
          .bind(workspaceId, action.workflow_id, eventId).first<Record<string, unknown>>();
        if (!run) {
          const executionResult = {
            executed: false, conflict: true,
            message: "Workflow execution failed before a run was recorded. Create a fresh proposal to retry.",
          };
          await env.DB.batch([
            env.DB.prepare(`UPDATE agent_proposals SET status='conflicted',execution_result=?
              WHERE workspace_id=? AND id=? AND status='executing'`)
              .bind(JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
            await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
              proposal, executionResult, "conflicted", reviewedAt),
          ]);
          console.error(JSON.stringify({
            message: "Workflow proposal execution failed before run admission",
            proposal_id: proposalMatch[1],
            error: error instanceof Error ? error.message.slice(0, 500) : "Unknown workflow execution error",
          }));
          return json({ error: executionResult.message, code: "execution_failed", status: "conflicted", result: executionResult }, 500);
        }
      }
      const executionResult = run
        ? { executed: true, workflow_id: action.workflow_id, run_id: run.id, run_status: run.status, step_count: run.step_count }
        : { executed: false, conflict: true, message: "The workflow run limit was reached or no branch was executable." };
      if (!run) {
        const finalized = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals SET status='conflicted',execution_result=?
            WHERE workspace_id=? AND id=? AND status='executing' AND reviewed_by=? AND reviewed_at=?`)
            .bind(JSON.stringify(executionResult), workspaceId, proposalMatch[1], access.email, reviewedAt),
          await proposalDecisionAuditStatement(env, access, request,
            "agent.proposal_conflicted", proposalMatch[1], proposal, executionResult, "conflicted", reviewedAt),
        ]);
        if (!finalized[0].meta.changes) return json({ error: "Workflow proposal finalization failed", code: "execution_conflict" }, 409);
        return json({ error: executionResult.message, code: "execution_conflict", status: "conflicted", result: executionResult }, 409);
      }
      const finalizedResult = await finalizeRun(run);
      return json({ ok: true, status: "approved", result: finalizedResult });
    }
    if (action.type === "create_task") {
      if (action.contact_id && !(await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=?")
        .bind(workspaceId, action.contact_id).first())) {
        const executionResult = { executed: false, invalid: true, message: "The proposed contact no longer exists." };
        const invalidated = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals
            SET status='invalid',reviewed_by=?,reviewed_at=?,execution_result=?
            WHERE workspace_id=? AND id=? AND status='pending'`)
            .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_invalid", proposalMatch[1],
            proposal, executionResult, "invalid", reviewedAt),
        ]);
        if (!invalidated[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
        return json({ error: executionResult.message, code: "invalid_proposal_action", result: executionResult }, 422);
      }
      const linkedOpportunity = action.opportunity_id
        ? await env.DB.prepare("SELECT contact_id FROM opportunities WHERE workspace_id=? AND id=?")
          .bind(workspaceId, action.opportunity_id).first<{ contact_id: string }>()
        : null;
      if (action.opportunity_id && (!linkedOpportunity || (action.contact_id && linkedOpportunity.contact_id !== action.contact_id))) {
        const executionResult = {
          executed: false,
          invalid: true,
          message: !linkedOpportunity
            ? "The proposed opportunity no longer exists."
            : "The proposed contact no longer matches the opportunity.",
        };
        const invalidated = await env.DB.batch([
          env.DB.prepare(`UPDATE agent_proposals
            SET status='invalid',reviewed_by=?,reviewed_at=?,execution_result=?
            WHERE workspace_id=? AND id=? AND status='pending'`)
            .bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1]),
          await proposalDecisionAuditStatement(env, access, request, "agent.proposal_invalid", proposalMatch[1],
            proposal, executionResult, "invalid", reviewedAt),
        ]);
        if (!invalidated[0].meta.changes) return json({ error: "Proposal was already decided" }, 409);
        return json({ error: executionResult.message, code: "invalid_proposal_action", result: executionResult }, 422);
      }
      const taskId = id("task");
      const executionResult = { executed: true, task_id: taskId };
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO tasks
          (id,workspace_id,contact_id,opportunity_id,title,status,priority,assignee,due_at,created_by,created_at,updated_at)
          SELECT ?,?,?,?,?, 'open',?,?,?,?,?,? FROM agent_proposals
          WHERE workspace_id=? AND id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)
            AND EXISTS(SELECT 1 FROM agent_policies WHERE workspace_id=? AND agent_access_enabled=1)`)
          .bind(taskId, workspaceId, action.contact_id, action.opportunity_id, action.title,
            action.priority, access.email, action.due_at || now, `agent:${proposal.agent_type}`, now, now,
            workspaceId, proposalMatch[1], now, workspaceId),
        env.DB.prepare(`UPDATE agent_proposals SET status='approved',reviewed_by=?,reviewed_at=?,execution_result=?
          WHERE workspace_id=? AND id=? AND status='pending' AND EXISTS(
            SELECT 1 FROM tasks WHERE workspace_id=? AND id=?
          )`).bind(access.email, reviewedAt, JSON.stringify(executionResult), workspaceId, proposalMatch[1], workspaceId, taskId),
        await proposalDecisionAuditStatement(env, access, request, "agent.proposal_approved", proposalMatch[1],
          proposal, executionResult, "approved", reviewedAt),
      ]);
      if (!results[1].meta.changes) {
        return json({ error: "Agent access changed, the proposal expired, or another reviewer already decided it.", code: "execution_conflict" }, 409);
      }
      return json({ ok: true, status: "approved", result: executionResult });
    }

    if (action.type === "update_contact") {
      const allowedFields: Record<string, string> = { stage: "stage", status: "status", owner: "owner" };
      let entries = Object.entries(action.changes);
      if (Object.hasOwn(action.changes, "custom_fields")) {
        const current = await env.DB.prepare(`SELECT custom_fields,updated_at FROM contacts
          WHERE workspace_id=? AND id=?`).bind(workspaceId, action.contact_id)
          .first<{ custom_fields: string; updated_at: string }>();
        if (!current || current.updated_at !== action.expected_updated_at) {
          return json({ error: "The contact changed after this proposal was created.", code: "execution_conflict" }, 409);
        }
        let merged: string;
        try {
          merged = await mergeCustomFieldValues(env, workspaceId, "contact", current.custom_fields,
            action.changes.custom_fields);
        } catch (error) {
          return error instanceof ApiError
            ? json({ error: error.message, code: "proposal_metadata_drift" }, 409)
            : json({ error: "Custom-field proposal is no longer executable", code: "proposal_metadata_drift" }, 409);
        }
        entries = [["custom_fields", merged]];
        allowedFields.custom_fields = "custom_fields";
      }
      const assignments = entries.map(([field]) => `${allowedFields[field]}=?`);
      const successResult = { executed: true, contact_id: action.contact_id, updated_at: now };
      const conflictResult = { executed: false, conflict: true, message: "The contact changed after this proposal was created." };
      const execution = await env.DB.batch([
        env.DB.prepare(`UPDATE agent_proposals SET status='executing',reviewed_by=?,reviewed_at=?
          WHERE workspace_id=? AND id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)
            AND EXISTS(SELECT 1 FROM agent_policies WHERE workspace_id=? AND agent_access_enabled=1)`)
          .bind(access.email, reviewedAt, workspaceId, proposalMatch[1], now, workspaceId),
        env.DB.prepare(`UPDATE contacts SET ${assignments.join(",")},updated_at=?
          WHERE workspace_id=? AND id=? AND updated_at=? AND EXISTS(
            SELECT 1 FROM agent_proposals WHERE workspace_id=? AND id=? AND status='executing'
              AND reviewed_by=? AND reviewed_at=?
          )`).bind(
          ...entries.map(([, value]) => value), now, workspaceId, action.contact_id, action.expected_updated_at,
          workspaceId, proposalMatch[1], access.email, reviewedAt,
        ),
        env.DB.prepare(`UPDATE agent_proposals
          SET status=CASE WHEN EXISTS(
            SELECT 1 FROM contacts WHERE workspace_id=? AND id=? AND updated_at=?
          ) THEN 'approved' ELSE 'conflicted' END,
          execution_result=CASE WHEN EXISTS(
            SELECT 1 FROM contacts WHERE workspace_id=? AND id=? AND updated_at=?
          ) THEN ? ELSE ? END
          WHERE workspace_id=? AND id=? AND status='executing' AND reviewed_by=? AND reviewed_at=?`)
          .bind(
            workspaceId, action.contact_id, now,
            workspaceId, action.contact_id, now,
            JSON.stringify(successResult), JSON.stringify(conflictResult),
            workspaceId, proposalMatch[1], access.email, reviewedAt,
          ),
        await proposalDecisionAuditStatement(env, access, request, "agent.proposal_approved", proposalMatch[1],
          proposal, successResult, "approved", reviewedAt),
        await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
          proposal, conflictResult, "conflicted", reviewedAt),
      ]);
      if (!execution[0].meta.changes) {
        return json({ error: "Agent access changed, the proposal expired, or another reviewer already decided it.", code: "execution_conflict" }, 409);
      }
      if (!execution[1].meta.changes) {
        return json({ error: conflictResult.message, code: "execution_conflict", status: "conflicted", result: conflictResult }, 409);
      }
      if (entries.some(([field]) => field === "stage" || field === "status")) {
        const updatedContact = await env.DB.prepare("SELECT * FROM contacts WHERE workspace_id=? AND id=?")
          .bind(workspaceId, action.contact_id).first<Record<string, unknown>>();
        if (updatedContact) {
          await runContactAutomations(env, access, updatedContact, `proposal:${proposalMatch[1]}`, "contact.lifecycle_changed");
        }
      }
      return json({ ok: true, status: "approved", result: successResult });
    }

    const allowedFields: Record<string, string> = {
      next_step: "next_step", owner: "owner", expected_close_at: "expected_close_at", value: "value", probability: "probability",
    };
    const entries = Object.entries(action.changes);
    const assignments = entries.map(([field]) => `${allowedFields[field]}=?`);
    const successResult = { executed: true, opportunity_id: action.opportunity_id, updated_at: now };
    const conflictResult = { executed: false, conflict: true, message: "The opportunity changed after this proposal was created." };
    const execution = await env.DB.batch([
      env.DB.prepare(`UPDATE agent_proposals SET status='executing',reviewed_by=?,reviewed_at=?
        WHERE workspace_id=? AND id=? AND status='pending' AND (expires_at IS NULL OR expires_at>?)
          AND EXISTS(SELECT 1 FROM agent_policies WHERE workspace_id=? AND agent_access_enabled=1)`)
        .bind(access.email, reviewedAt, workspaceId, proposalMatch[1], now, workspaceId),
      env.DB.prepare(`UPDATE opportunities SET ${assignments.join(",")},updated_at=?
        WHERE workspace_id=? AND id=? AND updated_at=? AND EXISTS(
          SELECT 1 FROM agent_proposals WHERE workspace_id=? AND id=? AND status='executing'
            AND reviewed_by=? AND reviewed_at=?
        )`).bind(
        ...entries.map(([, value]) => value), now, workspaceId, action.opportunity_id, action.expected_updated_at,
        workspaceId, proposalMatch[1], access.email, reviewedAt,
      ),
      env.DB.prepare(`UPDATE agent_proposals
        SET status=CASE WHEN EXISTS(
          SELECT 1 FROM opportunities WHERE workspace_id=? AND id=? AND updated_at=?
        ) THEN 'approved' ELSE 'conflicted' END,
        execution_result=CASE WHEN EXISTS(
          SELECT 1 FROM opportunities WHERE workspace_id=? AND id=? AND updated_at=?
        ) THEN ? ELSE ? END
        WHERE workspace_id=? AND id=? AND status='executing' AND reviewed_by=? AND reviewed_at=?`)
        .bind(
          workspaceId, action.opportunity_id, now,
          workspaceId, action.opportunity_id, now,
          JSON.stringify(successResult), JSON.stringify(conflictResult),
          workspaceId, proposalMatch[1], access.email, reviewedAt,
        ),
      await proposalDecisionAuditStatement(env, access, request, "agent.proposal_approved", proposalMatch[1],
        proposal, successResult, "approved", reviewedAt),
      await proposalDecisionAuditStatement(env, access, request, "agent.proposal_conflicted", proposalMatch[1],
        proposal, conflictResult, "conflicted", reviewedAt),
    ]);
    if (!execution[0].meta.changes) {
      return json({ error: "Agent access changed, the proposal expired, or another reviewer already decided it.", code: "execution_conflict" }, 409);
    }
    if (!execution[1].meta.changes) {
      return json({ error: conflictResult.message, code: "execution_conflict", status: "conflicted", result: conflictResult }, 409);
    }
    return json({ ok: true, status: "approved", result: successResult });
  }

  if (url.pathname === "/v1/admin/agent-credentials" && request.method === "GET") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const now = new Date().toISOString();
    const credentials = await env.DB.prepare(`SELECT id,name,provider,key_prefix,scopes,active,rate_limit_per_minute,
      last_used_at,expires_at,created_by,created_at,revoked_at,
      CASE WHEN active=0 THEN 'revoked'
        WHEN expires_at IS NOT NULL AND expires_at<=? THEN 'expired'
        ELSE 'active' END lifecycle_status
      FROM agent_credentials WHERE workspace_id=?
      ORDER BY CASE WHEN active=1 AND (expires_at IS NULL OR expires_at>?) THEN 0
        WHEN active=1 THEN 1 ELSE 2 END,
        COALESCE(revoked_at,expires_at,created_at) DESC, id DESC`).bind(now, workspaceId, now).all();
    return json({ credentials: credentials.results });
  }
  if (url.pathname === "/v1/admin/agent-credentials" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const name = optionalString(body.name, "name", 120);
    const provider = optionalString(body.provider, "provider", 30) || "custom";
    if (!name || !["openclaw", "hermes", "custom"].includes(provider)) return json({ error: "A valid name and provider are required" }, 400);
    const requestedScopes = jsonArray(body.scopes, "scopes", 10);
    const allowedAgentScopes = new Set([
      "crm:summary:read", "crm:companies:read", "crm:contacts:read", "crm:opportunities:read",
      "crm:automations:read", "crm:visitor-intent:read", "crm:visitor-intent:propose",
      "crm:visitor-research:execute", "crm:propose",
    ]);
    if (requestedScopes.includes("crm:read")) {
      return json({
        error: "crm:read is a legacy broad scope. Choose granular summary, company, contact, or opportunity read access.",
        code: "legacy_scope_not_allowed",
      }, 400);
    }
    if (!requestedScopes.length || requestedScopes.some((scope) => typeof scope !== "string" || !allowedAgentScopes.has(scope))) {
      return json({ error: "At least one valid agent scope is required" }, 400);
    }
    const uniqueScopes = [...new Set(requestedScopes as string[])];
    const rateLimit = boundedNumber(body.rate_limit_per_minute, "rate_limit_per_minute", 1, 120, 60);
    const expiresAt = optionalString(body.expires_at, "expires_at", 50);
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      return json({ error: "expires_at must be a future timestamp" }, 400);
    }
    const credentialId = id("acred");
    const rawKey = `crai_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO agent_credentials
      (id,workspace_id,name,provider,key_prefix,key_hash,scopes,active,rate_limit_per_minute,expires_at,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,1,?,?,?,?)`).bind(
      credentialId, workspaceId, name, provider, rawKey.slice(0, 13), await sha256(rawKey),
      JSON.stringify(uniqueScopes), rateLimit, expiresAt, access.email, now,
    ).run();
    await audit(env, access, request, "agent_credential.created", "agent_credential", credentialId, null, {
      name, provider, scopes: uniqueScopes, rate_limit_per_minute: rateLimit, expires_at: expiresAt,
    });
    return json({ ok: true, credential: { id: credentialId, name, provider, scopes: uniqueScopes, api_key: rawKey } }, 201);
  }
  const agentCredentialRotateMatch = url.pathname.match(/^\/v1\/admin\/agent-credentials\/(acred_[a-f0-9]{32})\/rotate$/);
  if (agentCredentialRotateMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedKeyPrefix = optionalString(body.expected_key_prefix, "expected_key_prefix", 20);
    if (!expectedKeyPrefix || !/^crai_[a-f0-9]{8}$/.test(expectedKeyPrefix)) {
      return json({ error: "expected_key_prefix is required" }, 400);
    }
    const credentialId = agentCredentialRotateMatch[1];
    const before = await env.DB.prepare(`SELECT id,name,provider,key_prefix,key_hash,scopes,active,rate_limit_per_minute,
      last_used_at,expires_at,created_by,created_at,revoked_at FROM agent_credentials
      WHERE workspace_id=? AND id=?`).bind(workspaceId, credentialId)
      .first<Record<string, unknown>>();
    if (!before) return json({ error: "Agent credential not found" }, 404);
    if (!before.active) return json({ error: "Revoked credentials cannot be rotated" }, 409);
    if (before.key_prefix !== expectedKeyPrefix) {
      return json({ error: "The credential changed in another session. Reload and try again.", code: "rotation_conflict" }, 409);
    }
    const rawKey = `crai_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const keyHash = await sha256(rawKey);
    const keyPrefix = rawKey.slice(0, 13);
    const rotatedAt = new Date().toISOString();
    const safeBefore = {
      id: before.id, name: before.name, provider: before.provider, key_prefix: before.key_prefix,
      scopes: JSON.parse(String(before.scopes || "[]")), active: before.active,
      rate_limit_per_minute: before.rate_limit_per_minute, last_used_at: before.last_used_at,
      expires_at: before.expires_at,
    };
    const safeAfter = { ...safeBefore, key_prefix: keyPrefix, last_used_at: null, rotated_at: rotatedAt };
    const ip = request.headers.get("cf-connecting-ip");
    const ipHash = ip ? await sha256(ip) : null;
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE agent_credentials SET key_prefix=?,key_hash=?,last_used_at=NULL,revoked_at=NULL
        WHERE workspace_id=? AND id=? AND active=1 AND key_prefix=? AND key_hash=?`)
        .bind(keyPrefix, keyHash, workspaceId, credentialId, expectedKeyPrefix, before.key_hash),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'agent_credential.rotated','agent_credential',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM agent_credentials WHERE workspace_id=? AND id=? AND key_hash=?)`)
        .bind(id("audit"), workspaceId, access.email, credentialId, JSON.stringify(safeBefore), JSON.stringify(safeAfter),
          requestId(request), ipHash, rotatedAt, workspaceId, credentialId, keyHash),
    ]);
    if (!results[0].meta.changes) {
      return json({ error: "The credential changed in another session. Reload and try again.", code: "rotation_conflict" }, 409);
    }
    return json({
      ok: true,
      credential: {
        id: credentialId, name: before.name, provider: before.provider,
        scopes: safeBefore.scopes, rate_limit_per_minute: before.rate_limit_per_minute,
        expires_at: before.expires_at, key_prefix: keyPrefix, api_key: rawKey,
      },
    });
  }
  const agentCredentialMatch = url.pathname.match(/^\/v1\/admin\/agent-credentials\/([^/]+)$/);
  if (agentCredentialMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const before = await env.DB.prepare(`SELECT id,name,provider,key_prefix,scopes,active,rate_limit_per_minute,
      last_used_at,expires_at,created_by,created_at,revoked_at FROM agent_credentials WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, agentCredentialMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Agent credential not found" }, 404);
    const revokedAt = new Date().toISOString();
    const revoked = await env.DB.prepare("UPDATE agent_credentials SET active=0,revoked_at=? WHERE workspace_id=? AND id=? AND active=1")
      .bind(revokedAt, workspaceId, agentCredentialMatch[1]).run();
    if (!revoked.meta.changes) return json({ error: "Agent credential was already revoked" }, 409);
    await audit(env, access, request, "agent_credential.revoked", "agent_credential", agentCredentialMatch[1], before, { ...before, active: 0, revoked_at: revokedAt });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/admin/visitor-intent/cases" && request.method === "GET") {
    const status = url.searchParams.get("status") || "active";
    const priority = url.searchParams.get("priority") || "";
    const owner = (url.searchParams.get("owner") || "").trim();
    const query = (url.searchParams.get("query") || "").trim().toLowerCase();
    const page = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "25");
    if (!["active", "new", "in_review", "resolved", "dismissed", "all"].includes(status)) {
      return json({ error: "status is invalid" }, 400);
    }
    if (priority && !["low", "normal", "high", "urgent"].includes(priority)) {
      return json({ error: "priority is invalid" }, 400);
    }
    if (owner.length > 254 || query.length > 200) return json({ error: "A case filter is too long" }, 400);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return json({ error: "page or limit is invalid" }, 400);
    }
    const conditions = [
      "workspace_id=?",
      "(?='all' OR (?='active' AND status IN ('new','in_review')) OR status=?)",
    ];
    const bindings: unknown[] = [workspaceId, status, status, status];
    if (priority) { conditions.push("priority=?"); bindings.push(priority); }
    if (owner === "__unassigned__") conditions.push("(owner IS NULL OR owner='')");
    else if (owner) { conditions.push("LOWER(owner)=LOWER(?)"); bindings.push(owner); }
    if (query) {
      const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      conditions.push("(LOWER(company_name) LIKE ? ESCAPE '\\' OR LOWER(company_domain) LIKE ? ESCAPE '\\')");
      bindings.push(pattern, pattern);
    }
    const where = conditions.join(" AND ");
    const [count, cases] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) total FROM visitor_intent_cases WHERE ${where}`)
        .bind(...bindings).first<{ total: number }>(),
      env.DB.prepare(`SELECT * FROM visitor_intent_cases WHERE ${where}
      ORDER BY CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
        CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at ASC,updated_at DESC,id DESC LIMIT ? OFFSET ?`)
        .bind(...bindings, limit, (page - 1) * limit).all<Record<string, unknown>>(),
    ]);
    const total = Number(count?.total || 0);
    return json({
      cases: cases.results.map((item) => ({
        ...item,
        evidence_snapshot: JSON.parse(String(item.evidence_snapshot || "{}")),
      })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      filters: { status, priority: priority || null, owner: owner || null, query: query || null },
      isolation: { contacts_created: false, companies_created: false, opportunities_created: false, outreach_authorized: false },
    });
  }

  if (url.pathname === "/v1/admin/visitor-intent/cases" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const rawDomain = optionalString(body.company_domain, "company_domain", 255);
    const companyDomain = visitorCompanyDomain(rawDomain, null);
    if (!companyDomain) return json({ error: "company_domain is required" }, 400);
    const expectedEvidenceUpdatedAt = optionalString(body.expected_evidence_updated_at, "expected_evidence_updated_at", 50);
    if (!expectedEvidenceUpdatedAt || !Number.isFinite(Date.parse(expectedEvidenceUpdatedAt))) {
      return json({ error: "expected_evidence_updated_at is required" }, 400);
    }
    const priority = optionalString(body.priority, "priority", 20) || "normal";
    let owner = optionalString(body.owner, "owner", 254);
    const dueAt = optionalString(body.due_at, "due_at", 50);
    if (!["low", "normal", "high", "urgent"].includes(priority)) return json({ error: "priority is invalid" }, 400);
    if (owner && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) return json({ error: "owner is invalid" }, 400);
    if (owner) {
      const member = await env.DB.prepare(`SELECT email FROM workspace_members
        WHERE workspace_id=? AND LOWER(email)=LOWER(?) AND active=1`).bind(workspaceId, owner).first<{ email: string }>();
      if (!member) return json({ error: "owner must be an active workspace member", code: "invalid_case_owner" }, 400);
      owner = member.email;
    }
    if (dueAt && !Number.isFinite(Date.parse(dueAt))) return json({ error: "due_at is invalid" }, 400);
    const evidence = await loadVisitorAccountEvidence(env, workspaceId, companyDomain);
    if (!evidence) return json({ error: "Intent account not found or no longer reviewable" }, 404);
    if (evidence.evidence_updated_at !== expectedEvidenceUpdatedAt) {
      return json({ error: "Intent evidence changed before the case was opened", code: "evidence_conflict",
        current_evidence_updated_at: evidence.evidence_updated_at }, 409);
    }
    const caseId = id("vicase");
    const now = new Date().toISOString();
    const snapshot = JSON.stringify(evidence);
    try {
      const eventType = "visitor_intent_case.created";
      const eventId = `visitor-intent-case:${caseId}`;
      const eventBody = JSON.stringify({
        id: eventId, type: eventType, created_at: now,
        data: {
          workspace_id: workspaceId, case_id: caseId,
          company_domain: companyDomain, company_name: String(evidence.company_name || companyDomain),
          status: "new", priority, intent_score: Number(evidence.intent_score || 0),
          attribution: evidence.attribution || null, score_reasons: evidence.score_reasons || [],
          isolation: { person_data_included: false, outreach_authorized: false },
        },
      });
      const alertEndpoints = await env.DB.prepare(`SELECT id FROM webhook_endpoints
        WHERE workspace_id=? AND direction='outbound' AND active=1
          AND (event_types='[]' OR EXISTS (SELECT 1 FROM json_each(event_types) WHERE value IN (?, '*')))
        ORDER BY created_at LIMIT 20`).bind(workspaceId, eventType).all<{ id: string }>();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO visitor_intent_cases
          (id,workspace_id,company_domain,company_name,status,priority,owner,due_at,evidence_updated_at,
           intent_score,evidence_snapshot,created_by,created_at,updated_at)
          VALUES(?,?,?,?,'new',?,?,?,?,?,?,?, ?,?)`)
          .bind(caseId, workspaceId, companyDomain, String(evidence.company_name || companyDomain), priority,
            owner, dueAt, evidence.evidence_updated_at, evidence.intent_score, snapshot, access.email, now, now),
        await auditStatement(env, access, request, "visitor_intent_case.created", "visitor_intent_case", caseId, null, {
          company_domain: companyDomain, status: "new", priority, owner, due_at: dueAt,
          evidence_updated_at: evidence.evidence_updated_at, intent_score: evidence.intent_score,
        }),
        ...alertEndpoints.results.map((endpoint) => env.DB.prepare(`INSERT OR IGNORE INTO webhook_deliveries
          (id,workspace_id,endpoint_id,event_id,direction,status,attempts,request_body,next_attempt_at,created_at,updated_at)
          VALUES(?,?,?,?,?,'retrying',0,?,?,?,?)`)
          .bind(id("delivery"), workspaceId, endpoint.id, eventId, "outbound", eventBody, now, now, now)),
      ]);
    } catch {
      const existing = await env.DB.prepare(`SELECT id FROM visitor_intent_cases
        WHERE workspace_id=? AND company_domain=? AND status IN ('new','in_review')`)
        .bind(workspaceId, companyDomain).first<{ id: string }>();
      if (existing) return json({ error: "An active case already exists for this intent account", code: "active_case_exists",
        case_id: existing.id }, 409);
      throw new ApiError(500, "The intent case could not be recorded");
    }
    return json({ ok: true, case: {
      id: caseId, company_domain: companyDomain, company_name: evidence.company_name, status: "new", priority,
      owner, due_at: dueAt, evidence_updated_at: evidence.evidence_updated_at, intent_score: evidence.intent_score,
      evidence_snapshot: evidence, revision: 1, created_at: now, updated_at: now,
    } }, 201);
  }

  const visitorCaseMatch = url.pathname.match(/^\/v1\/admin\/visitor-intent\/cases\/(vicase_[a-f0-9]{32})$/);
  if (visitorCaseMatch && request.method === "GET") {
    const [intentCase, timeline] = await Promise.all([
      env.DB.prepare(`SELECT * FROM visitor_intent_cases WHERE workspace_id=? AND id=?`)
        .bind(workspaceId, visitorCaseMatch[1]).first<Record<string, unknown>>(),
      env.DB.prepare(`SELECT id,actor_type,actor_id,action,before_state,after_state,request_id,created_at
        FROM audit_log WHERE workspace_id=? AND entity_type='visitor_intent_case' AND entity_id=?
        ORDER BY created_at DESC,id DESC LIMIT 100`).bind(workspaceId, visitorCaseMatch[1]).all<Record<string, unknown>>(),
    ]);
    if (!intentCase) return json({ error: "Intent case not found" }, 404);
    const parseState = (value: unknown) => {
      if (!value) return null;
      try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch { return null; }
    };
    const caseAuditState = (value: unknown) => {
      const state = parseState(value) as Record<string, unknown> | null;
      if (!state) return null;
      return Object.fromEntries([
        "company_domain", "company_name", "status", "priority", "owner", "due_at",
        "evidence_updated_at", "intent_score", "resolution_note", "revision", "created_at", "updated_at",
      ].filter((field) => Object.hasOwn(state, field)).map((field) => [field, state[field]]));
    };
    return json({
      case: { ...intentCase, evidence_snapshot: parseState(intentCase.evidence_snapshot) || {} },
      timeline: timeline.results.map((entry) => ({
        id: entry.id, actor_type: entry.actor_type, actor_id: entry.actor_id, action: entry.action,
        before: caseAuditState(entry.before_state), after: caseAuditState(entry.after_state), created_at: entry.created_at,
      })),
      limits: { timeline: 100 },
      isolation: { contacts_created: false, companies_created: false, opportunities_created: false, outreach_authorized: false },
    });
  }
  if (visitorCaseMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const before = await env.DB.prepare(`SELECT * FROM visitor_intent_cases WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, visitorCaseMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Intent case not found" }, 404);
    if (Number(before.revision) !== expectedRevision) {
      return json({ error: "Intent case changed before this update", code: "edit_conflict" }, 409);
    }
    const status = optionalString(body.status, "status", 20) || String(before.status);
    const priority = optionalString(body.priority, "priority", 20) || String(before.priority);
    let owner = Object.hasOwn(body, "owner") ? optionalString(body.owner, "owner", 254) : before.owner as string | null;
    const dueAt = Object.hasOwn(body, "due_at") ? optionalString(body.due_at, "due_at", 50) : before.due_at as string | null;
    const resolutionNote = Object.hasOwn(body, "resolution_note")
      ? optionalString(body.resolution_note, "resolution_note", 1000) : before.resolution_note as string | null;
    if (!["new", "in_review", "resolved", "dismissed"].includes(status)) return json({ error: "status is invalid" }, 400);
    if (!["low", "normal", "high", "urgent"].includes(priority)) return json({ error: "priority is invalid" }, 400);
    if (owner && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) return json({ error: "owner is invalid" }, 400);
    if (Object.hasOwn(body, "owner") && owner) {
      const member = await env.DB.prepare(`SELECT email FROM workspace_members
        WHERE workspace_id=? AND LOWER(email)=LOWER(?) AND active=1`).bind(workspaceId, owner).first<{ email: string }>();
      if (!member) return json({ error: "owner must be an active workspace member", code: "invalid_case_owner" }, 400);
      owner = member.email;
    }
    if (dueAt && !Number.isFinite(Date.parse(dueAt))) return json({ error: "due_at is invalid" }, 400);
    if (["resolved", "dismissed"].includes(status) && (!resolutionNote || resolutionNote.length < 3)) {
      return json({ error: "resolution_note is required for a terminal case state" }, 400);
    }
    if (status === before.status && priority === before.priority && owner === before.owner &&
      dueAt === before.due_at && resolutionNote === before.resolution_note) {
      return json({ error: "No intent case changes were supplied" }, 400);
    }
    const now = new Date().toISOString();
    const changeId = id("vchange");
    const after = { ...before, status, priority, owner, due_at: dueAt, resolution_note: resolutionNote,
      revision: expectedRevision + 1, change_id: changeId, updated_at: now };
    const ip = request.headers.get("cf-connecting-ip");
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE visitor_intent_cases SET status=?,priority=?,owner=?,due_at=?,resolution_note=?,
          revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
          .bind(status, priority, owner, dueAt, resolutionNote, changeId, now, workspaceId, visitorCaseMatch[1], expectedRevision),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
          SELECT ?,?,'user',?,'visitor_intent_case.updated','visitor_intent_case',?,?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM visitor_intent_cases WHERE workspace_id=? AND id=? AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, visitorCaseMatch[1], JSON.stringify(before), JSON.stringify(after),
            requestId(request), ip ? await sha256(ip) : null, now, workspaceId, visitorCaseMatch[1], changeId),
      ]);
      if (!results[0].meta.changes) return json({ error: "Intent case changed before this update", code: "edit_conflict" }, 409);
    } catch {
      const active = await env.DB.prepare(`SELECT id FROM visitor_intent_cases WHERE workspace_id=? AND company_domain=?
        AND status IN ('new','in_review') AND id<>?`).bind(workspaceId, before.company_domain, visitorCaseMatch[1]).first();
      if (active) return json({ error: "Another active case already exists for this account", code: "active_case_exists" }, 409);
      throw new ApiError(500, "The intent case update could not be recorded");
    }
    return json({ ok: true, case: after });
  }

  if (url.pathname === "/v1/admin/visitor-intent" && request.method === "GET") {
    const reviewStatus = url.searchParams.get("review_status") || "new";
    const provider = url.searchParams.get("provider") || "";
    if (!["new", "reviewed", "promoted", "suppressed", "all"].includes(reviewStatus)) {
      return json({ error: "review_status is invalid" }, 400);
    }
    if (provider && !["audiencelab", "rb2b"].includes(provider)) return json({ error: "provider is invalid" }, 400);
    const [connectors, profiles, accounts, counts] = await Promise.all([
      env.DB.prepare(`SELECT id,provider,name,token_prefix,active,consent_default,last_event_at,created_at,updated_at
        FROM visitor_connectors WHERE workspace_id=? ORDER BY created_at DESC,id DESC`)
        .bind(workspaceId).all(),
      env.DB.prepare(`SELECT p.*,
          c.email matched_contact_email,
          (SELECT COUNT(*) FROM visitor_events e WHERE e.profile_id=p.id) event_count,
          (SELECT COUNT(*) FROM visitor_events e WHERE e.profile_id=p.id AND e.is_repeat=1) repeat_visits,
          (SELECT occurred_at FROM visitor_events e WHERE e.profile_id=p.id ORDER BY occurred_at DESC,id DESC LIMIT 1) latest_event_at
        FROM visitor_profiles p
        LEFT JOIN contacts c ON c.workspace_id=p.workspace_id AND c.id=p.matched_contact_id
        WHERE p.workspace_id=? AND (?='all' OR p.review_status=?) AND (?='' OR p.provider=?)
        ORDER BY (p.high_intent_count>0) DESC,p.last_seen_at DESC,p.id DESC LIMIT 100`)
        .bind(workspaceId, reviewStatus, reviewStatus, provider, provider).all(),
      env.DB.prepare(`WITH grouped AS (
        SELECT LOWER(TRIM(p.company_domain)) company_domain,
          COALESCE(MAX(NULLIF(TRIM(p.company_name),'')),LOWER(TRIM(p.company_domain))) company_name,
          COUNT(*) profile_count,SUM(CASE WHEN p.identity_kind='person' THEN 1 ELSE 0 END) people_count,
          SUM(p.visit_count) visit_count,SUM(p.high_intent_count) high_intent_count,
          SUM((SELECT COUNT(*) FROM visitor_events e WHERE e.workspace_id=p.workspace_id
            AND e.profile_id=p.id AND e.is_repeat=1)) repeat_visits,
          SUM(CASE WHEN p.matched_contact_id IS NOT NULL THEN 1 ELSE 0 END) known_contact_count,
          SUM(CASE WHEN p.consent_status='granted' THEN 1 ELSE 0 END) consent_granted_count,
          SUM(CASE WHEN p.consent_status='denied' THEN 1 ELSE 0 END) consent_denied_count,
          MIN(p.first_seen_at) first_seen_at,MAX(p.last_seen_at) last_seen_at,MAX(p.updated_at) evidence_updated_at,
          (SELECT vp.latest_url FROM visitor_profiles vp WHERE vp.workspace_id=p.workspace_id
            AND LOWER(TRIM(vp.company_domain))=LOWER(TRIM(p.company_domain))
            ORDER BY vp.last_seen_at DESC,vp.id DESC LIMIT 1) latest_url
        FROM visitor_profiles p
        WHERE p.workspace_id=? AND p.company_domain IS NOT NULL AND TRIM(p.company_domain)<>''
          AND (?='all' OR p.review_status=?) AND (?='' OR p.provider=?)
        GROUP BY LOWER(TRIM(p.company_domain))
      ), enriched AS (
        SELECT g.*,
          (SELECT c.id FROM companies c WHERE c.workspace_id=? AND
            LOWER(TRIM(COALESCE(c.domain,'')))=g.company_domain ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) crm_company_id,
          (SELECT c.name FROM companies c WHERE c.workspace_id=? AND
            LOWER(TRIM(COALESCE(c.domain,'')))=g.company_domain ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) crm_company_name,
          (SELECT COUNT(*) FROM opportunities o JOIN contacts ct ON ct.workspace_id=o.workspace_id AND ct.id=o.contact_id
            LEFT JOIN companies c ON c.workspace_id=ct.workspace_id AND c.id=ct.company_id
            WHERE o.workspace_id=? AND o.status='open' AND
              LOWER(TRIM(COALESCE(c.domain,'')))=g.company_domain) open_opportunity_count,
          (SELECT COALESCE(SUM(o.value),0) FROM opportunities o
            JOIN contacts ct ON ct.workspace_id=o.workspace_id AND ct.id=o.contact_id
            LEFT JOIN companies c ON c.workspace_id=ct.workspace_id AND c.id=ct.company_id
            WHERE o.workspace_id=? AND o.status='open' AND
              LOWER(TRIM(COALESCE(c.domain,'')))=g.company_domain) open_pipeline_value,
          (SELECT vic.id FROM visitor_intent_cases vic WHERE vic.workspace_id=? AND
            vic.company_domain=g.company_domain AND vic.status IN ('new','in_review') LIMIT 1) active_case_id,
          (SELECT vic.status FROM visitor_intent_cases vic WHERE vic.workspace_id=? AND
            vic.company_domain=g.company_domain AND vic.status IN ('new','in_review') LIMIT 1) active_case_status
        FROM grouped g
      ), signals AS (
        SELECT e.*,CASE WHEN julianday(e.last_seen_at)>=julianday('now','-7 days') THEN 10
          WHEN julianday(e.last_seen_at)>=julianday('now','-30 days') THEN 5 ELSE 0 END recency_points
        FROM enriched e
      )
      SELECT e.*,MIN(100,
        MIN(e.high_intent_count,3)*12 + MIN(e.repeat_visits,4)*5 + MIN(e.visit_count,10) +
        MIN(e.people_count,3)*8 + CASE WHEN e.known_contact_count>0 THEN 10 ELSE 0 END +
        CASE WHEN e.open_opportunity_count>0 THEN 10 ELSE 0 END + e.recency_points) intent_score
      FROM signals e ORDER BY intent_score DESC,last_seen_at DESC,company_domain ASC LIMIT 100`)
        .bind(workspaceId, reviewStatus, reviewStatus, provider, provider,
          workspaceId, workspaceId, workspaceId, workspaceId, workspaceId, workspaceId).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT review_status,COUNT(*) total FROM visitor_profiles
        WHERE workspace_id=? GROUP BY review_status`).bind(workspaceId).all<{ review_status: string; total: number }>(),
    ]);
    return json({
      connectors: connectors.results,
      profiles: profiles.results,
      accounts: accounts.results.map((account) => ({ ...account, score_reasons: visitorAccountScoreReasons(account) })),
      counts: Object.fromEntries(counts.results.map((row) => [row.review_status, row.total])),
      limits: { profiles: 100, accounts: 100 },
      isolation: {
        contacts_created_automatically: false,
        companies_created_automatically: false,
        domainless_profiles_excluded_from_accounts: true,
        payload_content_trusted: false,
        promotion_requires_admin_review: true,
      },
    });
  }

  // Advanced operator/API contract: callers explicitly stage capabilities and
  // reconcile the returned account reference. The UI uses the self-service
  // callback contract above; these contracts are intentionally versioned.
  if (url.pathname === "/v1/admin/mailbox-connections/connect-link" && request.method === "POST") {
    if (!env.COMPOSIO_API_KEY) return json({ error: "Mailbox connections are not configured" }, 503);
    const body = await readJson(request);
    const provider = optionalString(body.provider, "provider", 20) as MailboxProvider | null;
    const ownerEmail = normalizeEmail(body.owner_email);
    const alias = optionalString(body.alias, "alias", 50)?.toLowerCase() || "";
    const requestedCapabilities = jsonArray(body.allowed_capabilities, "allowed_capabilities", 5);
    if (!provider || !["gmail", "outlook"].includes(provider)) return json({ error: "provider is invalid" }, 400);
    if (ownerEmail !== normalizeEmail(access.email)) {
      return json({ error: "A member can only connect their own mailbox" }, 403);
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,49}$/.test(alias)) {
      return json({ error: "alias must be 2-50 lowercase letters, numbers, underscores, or hyphens" }, 400);
    }
    if (!requestedCapabilities.length ||
      requestedCapabilities.some((capability) => !mailboxCapabilities.has(String(capability)))) {
      return json({
        error: "allowed_capabilities must contain only mail.profile.read or mail.drafts.create",
      }, 400);
    }
    const capabilities = [...new Set(requestedCapabilities.map(String))].sort();
    const authConfigId = mailboxAuthConfigId(env, provider);
    if (!authConfigId) return json({ error: `The ${provider} auth config is not configured` }, 503);
    const owner = await env.DB.prepare(`SELECT id FROM workspace_members
      WHERE workspace_id=? AND email=? AND active=1`).bind(workspaceId, ownerEmail).first();
    if (!owner) return json({ error: "owner_email must be an active workspace member" }, 400);

    const authConfig = await composioRequest(env, `/api/v3.1/auth_configs/${encodeURIComponent(authConfigId)}`);
    const toolkit = composioToolkitSlug(authConfig);
    if (toolkit !== provider) {
      return json({ error: "The auth config toolkit does not match the requested mailbox provider" }, 400);
    }
    const connectionId = id("mbx");
    const now = new Date().toISOString();
    const composioUserId = await mailboxComposioUserId(workspaceId, ownerEmail);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO mailbox_connections
          (id,workspace_id,owner_email,provider,toolkit,alias,auth_config_id,composio_user_id,status,
           provider_status,allowed_capabilities,revision,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'NOT_LINKED',?,1,?,?,?)`)
          .bind(connectionId, workspaceId, ownerEmail, provider, provider, alias, authConfigId, composioUserId,
            "pending", JSON.stringify(capabilities), access.email, now, now),
        await auditStatement(env, access, request, "mailbox_connection.initiated", "mailbox_connection",
          connectionId, null, {
            owner_email: ownerEmail, provider, toolkit: provider, alias,
            auth_config_id: authConfigId, allowed_capabilities: capabilities,
            credentials_stored_in_crm: false, execution_authorized: false,
          }),
      ]);
    } catch (error) {
      const duplicate = await env.DB.prepare(`SELECT id,status,revision FROM mailbox_connections
        WHERE workspace_id=? AND provider=? AND alias=?`).bind(workspaceId, provider, alias).first();
      if (duplicate) return json({
        error: "A mailbox connection with this provider and alias already exists",
        code: "mailbox_alias_exists", connection: duplicate,
      }, 409);
      throw error;
    }

    let link: Json;
    try {
      link = await composioRequest(env, "/api/v3.1/connected_accounts/link", {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: authConfigId,
          user_id: composioUserId,
          alias,
          callback_url: "https://crm.example.com/?mailbox_connected=1",
        }),
      });
    } catch (error) {
      const failedAt = new Date().toISOString();
      const providerFailure = mailboxProviderFailure(error);
      await env.DB.batch([
        env.DB.prepare(`UPDATE mailbox_connections SET status='error',provider_status=?,
          last_error=?,last_synced_at=?,revision=revision+1,updated_at=?
          WHERE workspace_id=? AND id=? AND status='pending'`)
          .bind(providerFailure.providerStatus, providerFailure.message, failedAt, failedAt, workspaceId, connectionId),
        await auditStatement(env, access, request, "mailbox_connection.link_failed", "mailbox_connection",
          connectionId, { status: "pending" }, {
            status: "error", provider_status: providerFailure.providerStatus,
            reason: providerFailure.code, upstream_status: providerFailure.upstreamStatus,
          }),
      ]);
      return json({ error: providerFailure.message, code: providerFailure.code }, 502);
    }
    const redirectUrl = safeComposioRedirect(link.redirect_url);
    const connectedAccountId = composioAccountId(link) ||
      (isPlainObject(link.connected_account) ? composioAccountId(link.connected_account) : null);
    const expiresAt = typeof link.expires_at === "string" && Number.isFinite(Date.parse(link.expires_at))
      ? link.expires_at : null;
    if (!redirectUrl || !connectedAccountId || !expiresAt) {
      const failedAt = new Date().toISOString();
      const compensated = connectedAccountId ? await bestEffortComposioRevoke(env, connectedAccountId) : false;
      await env.DB.batch([
        env.DB.prepare(`UPDATE mailbox_connections SET status='error',connected_account_id=COALESCE(?,connected_account_id),
          provider_status=?,last_error='Composio returned an invalid Connect Link',last_synced_at=?,
          revision=revision+1,updated_at=? WHERE workspace_id=? AND id=?`)
          .bind(connectedAccountId, compensated ? "REVOKED_INVALID_LINK" : "INVALID_LINK_RESPONSE",
            failedAt, failedAt, workspaceId, connectionId),
        await auditStatement(env, access, request, "mailbox_connection.invalid_link_response", "mailbox_connection",
          connectionId, { status: "pending" }, {
            status: "error", connected_account_id: connectedAccountId,
            compensating_revoke_confirmed: compensated,
          }),
      ]);
      return json({ error: "Composio returned an invalid Connect Link" }, 502);
    }
    const linkedAt = new Date().toISOString();
    const changeId = id("mbxchg");
    let committed: D1Result<unknown>[];
    try {
      committed = await env.DB.batch([
        env.DB.prepare(`UPDATE mailbox_connections SET connected_account_id=?,provider_status='INITIATED',
          last_error=NULL,last_synced_at=?,connect_expires_at=?,revision=revision+1,change_id=?,updated_at=?
          WHERE workspace_id=? AND id=? AND status='pending' AND connected_account_id IS NULL`)
          .bind(connectedAccountId, linkedAt, expiresAt, changeId, linkedAt, workspaceId, connectionId),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
          SELECT ?,?,'user',?,'mailbox_connection.link_issued','mailbox_connection',?,?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM mailbox_connections WHERE workspace_id=? AND id=? AND change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, connectionId,
            JSON.stringify({ status: "pending", connected_account_id: null }),
            JSON.stringify({ status: "pending", connected_account_id: connectedAccountId,
              provider_status: "INITIATED", redirect_url_stored: false }),
            requestId(request), request.headers.get("cf-connecting-ip")
              ? await sha256(request.headers.get("cf-connecting-ip")!) : null, linkedAt,
            workspaceId, connectionId, changeId),
      ]);
    } catch {
      const compensated = await bestEffortComposioRevoke(env, connectedAccountId);
      const failedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`UPDATE mailbox_connections SET status='error',connected_account_id=?,
          provider_status=?,last_error=?,last_synced_at=?,revision=revision+1,updated_at=?
          WHERE workspace_id=? AND id=? AND status='pending'`)
          .bind(connectedAccountId, compensated ? "REVOKED_AFTER_COMMIT_FAILURE" : "ORPHAN_REVOKE_FAILED",
            compensated ? "Provider authority was revoked after the CRM commit failed"
              : "Provider authority may still be live after the CRM commit failed",
            failedAt, failedAt, workspaceId, connectionId),
        await auditStatement(env, access, request, "mailbox_connection.link_commit_failed", "mailbox_connection",
          connectionId, { status: "pending" }, {
            status: "error", connected_account_id: connectedAccountId,
            compensating_revoke_confirmed: compensated,
          }),
      ]);
      return json({ error: "The mailbox link could not be committed and provider authority was rolled back" }, 500);
    }
    if (!committed[0].meta.changes) {
      return json({ error: "Mailbox connection changed before the link could be recorded", code: "edit_conflict" }, 409);
    }
    return json({
      ok: true,
      contract: "mailbox_connect_link_advanced_v1",
      connection: {
        id: connectionId, owner_email: ownerEmail, provider, alias, status: "pending",
        connected_account_id: connectedAccountId, revision: 2,
        allowed_capabilities: capabilities,
      },
      connect_link: { redirect_url: redirectUrl, expires_at: expiresAt },
      authority: { draft: false, send: false, delete: false, execution: false },
    }, 201);
  }

  const mailboxReconnectMatch = url.pathname.match(
    /^\/v1\/admin\/mailbox-connections\/(mbx_[a-f0-9]{32})\/reconnect$/,
  );
  if (mailboxReconnectMatch && request.method === "POST") {
    const body = await readJson(request);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const before = await env.DB.prepare(`SELECT id,owner_email,provider,toolkit,alias,auth_config_id,
      composio_user_id,connected_account_id,status,provider_status,allowed_capabilities,last_synced_at,
      last_error,revision,connect_expires_at,created_by,created_at,updated_at
      FROM mailbox_connections WHERE workspace_id=? AND id=? AND (?=1 OR owner_email=?)`)
      .bind(workspaceId, mailboxReconnectMatch[1], isWorkspaceAdmin(access) ? 1 : 0, normalizeEmail(access.email))
      .first<Record<string, unknown>>();
    if (!before) return json({ error: "Mailbox connection not found" }, 404);
    if (Number(before.revision) !== expectedRevision) {
      return json({ error: "Mailbox connection changed before reconnect", code: "edit_conflict" }, 409);
    }
    if (!before.connected_account_id) {
      return json({ error: "Mailbox connection has no provider account to reconnect" }, 409);
    }
    if (before.status !== "expired" && before.status !== "error") {
      return json({ error: "Only expired or failed provider accounts can be reconnected" }, 409);
    }
    const state = crmMailboxStateToken();
    const stateHash = await sha256(state);
    const callbackUrl = `https://crm.example.com/v1/admin/mailbox-connections/callback?state=${state}`;
    const requestedAt = new Date().toISOString();
    const requestedExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const requested = {
      ...before,
      status: "pending",
      provider_status: "REAUTH_REQUESTED",
      last_synced_at: requestedAt,
      last_error: null,
      revision: expectedRevision + 1,
      change_id: stateHash,
      connect_expires_at: requestedExpiresAt,
      updated_at: requestedAt,
    };
    const reserved = await env.DB.batch([
      env.DB.prepare(`UPDATE mailbox_connections SET status='pending',provider_status='REAUTH_REQUESTED',
        last_synced_at=?,last_error=NULL,revision=revision+1,change_id=?,connect_expires_at=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=? AND status IN ('expired','error')
          AND connected_account_id IS NOT NULL`)
        .bind(requestedAt, stateHash, requestedExpiresAt, requestedAt,
          workspaceId, mailboxReconnectMatch[1], expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'mailbox_connection.reconnect_requested','mailbox_connection',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM mailbox_connections
          WHERE workspace_id=? AND id=? AND change_id=? AND status='pending')`)
        .bind(id("audit"), workspaceId, access.email, mailboxReconnectMatch[1], JSON.stringify(before),
          JSON.stringify(requested), requestId(request), request.headers.get("cf-connecting-ip")
            ? await sha256(request.headers.get("cf-connecting-ip")!) : null, requestedAt,
          workspaceId, mailboxReconnectMatch[1], stateHash),
    ]);
    if (!reserved[0].meta.changes || !reserved[1].meta.changes) {
      return json({ error: "Mailbox connection changed before reconnect could start", code: "edit_conflict" }, 409);
    }
    let refreshed: Record<string, unknown>;
    try {
      refreshed = await composioRequest(env,
        `/api/v3.1/connected_accounts/${encodeURIComponent(String(before.connected_account_id))}/refresh`, {
          method: "POST",
          body: JSON.stringify({ redirect_url: callbackUrl }),
        });
      const remoteId = composioAccountId(refreshed);
      if (remoteId && remoteId !== before.connected_account_id) {
        throw new ApiError(502, "Composio returned the wrong connected account");
      }
      if (!safeComposioRedirect(refreshed.redirect_url)) {
        throw new ApiError(502, "Composio did not return a secure reconnect URL");
      }
    } catch (error) {
      const failedAt = new Date().toISOString();
      const providerFailure = mailboxProviderFailure(error);
      await env.DB.batch([
        env.DB.prepare(`UPDATE mailbox_connections SET status=?,provider_status='REAUTH_FAILED',
          last_error='Provider reconnection could not be started',revision=revision+1,change_id=NULL,
          connect_expires_at=NULL,updated_at=?
          WHERE workspace_id=? AND id=? AND revision=? AND change_id=? AND status='pending'`)
          .bind(String(before.status), failedAt, workspaceId, mailboxReconnectMatch[1],
            expectedRevision + 1, stateHash),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,created_at)
          SELECT ?,?,'user',?,'mailbox_connection.reconnect_failed','mailbox_connection',?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM mailbox_connections
            WHERE workspace_id=? AND id=? AND revision=? AND provider_status='REAUTH_FAILED')`)
          .bind(id("audit"), workspaceId, access.email, mailboxReconnectMatch[1], JSON.stringify(requested),
            JSON.stringify({ status: before.status, provider_status: "REAUTH_FAILED" }),
            requestId(request), failedAt, workspaceId, mailboxReconnectMatch[1], expectedRevision + 2),
      ]);
      return json({ error: providerFailure.message, code: providerFailure.code }, 502);
    }
    const redirectUrl = safeComposioRedirect(refreshed.redirect_url)!;
    const expiresAt = typeof refreshed.expires_at === "string" && Number.isFinite(Date.parse(refreshed.expires_at))
      ? refreshed.expires_at : requestedExpiresAt;
    const initiatedAt = new Date().toISOString();
    const initiated = await env.DB.prepare(`UPDATE mailbox_connections
      SET provider_status='REAUTH_INITIATED',connect_expires_at=?,last_synced_at=?,updated_at=?
      WHERE workspace_id=? AND id=? AND revision=? AND change_id=? AND status='pending'`)
      .bind(expiresAt, initiatedAt, initiatedAt, workspaceId, mailboxReconnectMatch[1],
        expectedRevision + 1, stateHash).run();
    if (!initiated.meta.changes) {
      return json({ error: "Mailbox connection changed before reconnect could be issued", code: "edit_conflict" }, 409);
    }
    return json({
      ok: true,
      contract: "mailbox_oauth_reconnect_v1",
      connection: {
        id: before.id,
        owner_email: before.owner_email,
        provider: before.provider,
        alias: before.alias,
        status: "pending",
        connected_account_id: before.connected_account_id,
        revision: expectedRevision + 1,
        expires_at: expiresAt,
      },
      redirect_url: redirectUrl,
      authority: { draft: false, send: false, delete: false, execution: false },
    });
  }

  const mailboxConnectionMatch = url.pathname.match(/^\/v1\/admin\/mailbox-connections\/(mbx_[a-f0-9]{32})$/);
  if (mailboxConnectionMatch && request.method === "DELETE") {
    // DELETE is still a body-bearing mutation in this API. Parse it first so
    // media-type and size protections are identical across every mutation.
    await readJson(request);
    const expectedRevision = Number(url.searchParams.get("expected_revision"));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const before = await env.DB.prepare(`SELECT id,owner_email,provider,alias,status,provider_status,
      connected_account_id,revision FROM mailbox_connections
      WHERE workspace_id=? AND id=? AND (?=1 OR owner_email=?)`)
      .bind(workspaceId, mailboxConnectionMatch[1], isWorkspaceAdmin(access) ? 1 : 0, normalizeEmail(access.email))
      .first<Record<string, unknown>>();
    if (!before) return json({ error: "Mailbox connection not found" }, 404);
    if (Number(before.revision) !== expectedRevision) {
      return json({ error: "Mailbox connection changed before removal", code: "edit_conflict" }, 409);
    }
    if (before.status !== "error" || before.connected_account_id) {
      return json({
        error: "Only a failed setup with no provider account can be removed. Disable or revoke connected mailboxes instead.",
      }, 409);
    }
    const changeId = id("mbxchg");
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE mailbox_connections SET change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=? AND status='error' AND connected_account_id IS NULL`)
        .bind(changeId, now, workspaceId, before.id, expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,
         request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'mailbox_connection.failed_setup_removed','mailbox_connection',?,
          ?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM mailbox_connections
          WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, before.id, JSON.stringify(before),
          JSON.stringify({ removed: true, provider_authority_existed: false }), requestId(request),
          request.headers.get("cf-connecting-ip")
            ? await sha256(request.headers.get("cf-connecting-ip")!) : null,
          now, workspaceId, before.id, changeId),
      env.DB.prepare(`DELETE FROM mailbox_connections
        WHERE workspace_id=? AND id=? AND change_id=? AND status='error' AND connected_account_id IS NULL`)
        .bind(workspaceId, before.id, changeId),
    ]);
    if (!results[0].meta.changes || !results[2].meta.changes) {
      return json({ error: "Mailbox connection changed before removal", code: "edit_conflict" }, 409);
    }
    return json({
      ok: true,
      removed: { id: before.id, provider: before.provider, alias: before.alias },
      provider_tokens_revoked: false,
      provider_authority_existed: false,
    });
  }
  if (mailboxConnectionMatch && request.method === "POST") {
    const body = await readJson(request);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const before = await env.DB.prepare(`SELECT id,owner_email,provider,toolkit,alias,auth_config_id,composio_user_id,
      connected_account_id,status,provider_status,allowed_capabilities,last_synced_at,last_error,revision,connect_expires_at,
      created_by,created_at,updated_at FROM mailbox_connections
      WHERE workspace_id=? AND id=? AND (?=1 OR owner_email=?)`)
      .bind(workspaceId, mailboxConnectionMatch[1], isWorkspaceAdmin(access) ? 1 : 0, normalizeEmail(access.email))
      .first<Record<string, unknown>>();
    if (!before) return json({ error: "Mailbox connection not found" }, 404);
    if (Number(before.revision) !== expectedRevision) {
      return json({ error: "Mailbox connection changed before reconciliation", code: "edit_conflict" }, 409);
    }
    if (!before.connected_account_id) return json({ error: "Mailbox connection has no provider account to reconcile" }, 409);
    const remote = await composioRequest(env,
      `/api/v3.1/connected_accounts/${encodeURIComponent(String(before.connected_account_id))}`);
    const remoteId = composioAccountId(remote);
    if (remoteId !== before.connected_account_id) throw new ApiError(502, "Composio returned the wrong connected account");
    const remoteAuth = isPlainObject(remote.auth_config) ? String(remote.auth_config.id || "") : "";
    if (remote.user_id !== before.composio_user_id || composioToolkitSlug(remote) !== before.toolkit ||
      remoteAuth !== before.auth_config_id) {
      throw new ApiError(409, "The provider account does not belong to this mailbox connection");
    }
    const normalized = normalizeMailboxStatus(remote.status);
    const now = new Date().toISOString();
    const changeId = id("mbxchg");
    const after = {
      ...before, status: normalized.status, provider_status: normalized.providerStatus,
      last_synced_at: now, last_error: normalized.status === "error" ? "Provider account is not usable" : null,
      revision: expectedRevision + 1, updated_at: now,
    };
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE mailbox_connections SET status=?,provider_status=?,last_synced_at=?,last_error=?,
        connect_expires_at=CASE WHEN ?='pending' THEN connect_expires_at ELSE NULL END,
        revision=revision+1,change_id=?,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
        .bind(normalized.status, normalized.providerStatus, now, after.last_error, normalized.status, changeId, now,
          workspaceId, mailboxConnectionMatch[1], expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'mailbox_connection.reconciled','mailbox_connection',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM mailbox_connections WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, mailboxConnectionMatch[1], JSON.stringify(before),
          JSON.stringify(after), requestId(request), request.headers.get("cf-connecting-ip")
            ? await sha256(request.headers.get("cf-connecting-ip")!) : null, now,
          workspaceId, mailboxConnectionMatch[1], changeId),
    ]);
    if (!results[0].meta.changes) return json({ error: "Mailbox connection changed before reconciliation", code: "edit_conflict" }, 409);
    return json({ ok: true, connection: after, authority: { draft: false, send: false, execution: false } });
  }

  if (mailboxConnectionMatch && request.method === "PATCH") {
    const body = await readJson(request);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const before = await env.DB.prepare(`SELECT * FROM mailbox_connections
      WHERE workspace_id=? AND id=? AND (?=1 OR owner_email=?)`)
      .bind(workspaceId, mailboxConnectionMatch[1], isWorkspaceAdmin(access) ? 1 : 0, normalizeEmail(access.email))
      .first<Record<string, unknown>>();
    if (!before) return json({ error: "Mailbox connection not found" }, 404);
    const now = new Date().toISOString();
    const changeId = id("mbxchg");
    const after = { ...before, status: "disabled", revision: expectedRevision + 1, updated_at: now };
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE mailbox_connections SET status='disabled',revision=revision+1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=? AND status NOT IN ('disabled','revoked')`)
        .bind(changeId, now, workspaceId, mailboxConnectionMatch[1], expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'mailbox_connection.disabled','mailbox_connection',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM mailbox_connections WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, mailboxConnectionMatch[1], JSON.stringify(before),
          JSON.stringify(after), requestId(request), request.headers.get("cf-connecting-ip")
            ? await sha256(request.headers.get("cf-connecting-ip")!) : null, now,
          workspaceId, mailboxConnectionMatch[1], changeId),
    ]);
    if (!results[0].meta.changes) return json({ error: "Mailbox connection changed or is already disabled", code: "edit_conflict" }, 409);
    return json({
      ok: true, connection: after,
      provider_tokens_revoked: false,
      warning: "Local disablement blocks CRM use but does not revoke provider tokens.",
    });
  }

  const mailboxRevokeMatch = url.pathname.match(/^\/v1\/admin\/mailbox-connections\/(mbx_[a-f0-9]{32})\/revoke$/);
  if (mailboxRevokeMatch && request.method === "POST") {
    const body = await readJson(request);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const before = await env.DB.prepare(`SELECT * FROM mailbox_connections
      WHERE workspace_id=? AND id=? AND (?=1 OR owner_email=?)`)
      .bind(workspaceId, mailboxRevokeMatch[1], isWorkspaceAdmin(access) ? 1 : 0, normalizeEmail(access.email))
      .first<Record<string, unknown>>();
    if (!before) return json({ error: "Mailbox connection not found" }, 404);
    if (Number(before.revision) !== expectedRevision) {
      return json({ error: "Mailbox connection changed before revocation", code: "edit_conflict" }, 409);
    }
    if (!before.connected_account_id) return json({ error: "Mailbox connection has no provider account to revoke" }, 409);
    const remote = await composioRequest(env,
      `/api/v3.1/connected_accounts/${encodeURIComponent(String(before.connected_account_id))}/revoke`,
      { method: "POST", body: "{}" });
    const remoteAccount = isPlainObject(remote.connected_account) ? remote.connected_account : remote;
    if (composioAccountId(remoteAccount) !== before.connected_account_id ||
      String(remoteAccount.status || "").toUpperCase() !== "REVOKED") {
      throw new ApiError(502, "Composio did not confirm provider revocation");
    }
    const revokedTokens = Array.isArray(remote.revoked_tokens)
      ? remote.revoked_tokens.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
    const now = new Date().toISOString();
    const changeId = id("mbxchg");
    const after = {
      ...before, status: "revoked", provider_status: "REVOKED", last_synced_at: now,
      last_error: null, revision: expectedRevision + 1, updated_at: now,
    };
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE mailbox_connections SET status='revoked',provider_status='REVOKED',last_synced_at=?,
        last_error=NULL,connect_expires_at=NULL,revision=revision+1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=? AND status<>'revoked'`)
        .bind(now, changeId, now, workspaceId, mailboxRevokeMatch[1], expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'mailbox_connection.revoked','mailbox_connection',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM mailbox_connections WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, mailboxRevokeMatch[1], JSON.stringify(before),
          JSON.stringify({ ...after, revoked_tokens: revokedTokens }), requestId(request),
          request.headers.get("cf-connecting-ip") ? await sha256(request.headers.get("cf-connecting-ip")!) : null,
          now, workspaceId, mailboxRevokeMatch[1], changeId),
    ]);
    if (!results[0].meta.changes) return json({ error: "Mailbox connection changed before revocation", code: "edit_conflict" }, 409);
    return json({
      ok: true, connection: after, provider_tokens_revoked: true, revoked_tokens: revokedTokens,
      authority: { draft: false, send: false, execution: false },
    });
  }

  if (url.pathname === "/v1/admin/visitor-connectors" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const provider = optionalString(body.provider, "provider", 30);
    const name = optionalString(body.name, "name", 120);
    const consentDefault = optionalString(body.consent_default, "consent_default", 20) || "unknown";
    if (!provider || !["audiencelab", "rb2b"].includes(provider)) return json({ error: "provider is invalid" }, 400);
    if (!name) return json({ error: "name is required" }, 400);
    if (!["unknown", "granted", "denied"].includes(consentDefault)) return json({ error: "consent_default is invalid" }, 400);
    const token = `vti_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const connectorId = id("vconn");
    const now = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO visitor_connectors
          (id,workspace_id,provider,name,token_hash,token_prefix,active,consent_default,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,1,?,?,?,?)`)
          .bind(connectorId, workspaceId, provider, name, await sha256(token), token.slice(0, 12),
            consentDefault, access.email, now, now),
        await auditStatement(env, access, request, "visitor_connector.created", "visitor_connector", connectorId, null,
          { provider, name, token_prefix: token.slice(0, 12), consent_default: consentDefault }),
      ]);
    } catch (error) {
      const duplicate = await env.DB.prepare("SELECT 1 present FROM visitor_connectors WHERE workspace_id=? AND name=?")
        .bind(workspaceId, name).first();
      if (duplicate) return json({ error: "A visitor connector with that name already exists" }, 409);
      throw error;
    }
    return json({
      ok: true,
      connector: {
        id: connectorId, provider, name, token_prefix: token.slice(0, 12),
        consent_default: consentDefault,
        webhook_url: `https://ingest.example.com/v1/integrations/visitor-intent/${provider}/${token}`,
        audience_sync_url: provider === "audiencelab"
          ? `https://ingest.example.com/v1/integrations/audience-intake/audiencelab/${token}`
          : null,
      },
    }, 201);
  }

  const visitorConnectorMatch = url.pathname.match(/^\/v1\/admin\/visitor-connectors\/(vconn_[a-f0-9]{32})$/);
  if (visitorConnectorMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedUpdatedAt = optionalString(body.expected_updated_at, "expected_updated_at", 50);
    if (!expectedUpdatedAt) return json({ error: "expected_updated_at is required" }, 400);
    const before = await env.DB.prepare(`SELECT id,provider,name,token_prefix,active,consent_default,last_event_at,created_at,updated_at
      FROM visitor_connectors WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, visitorConnectorMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Visitor connector not found" }, 404);
    const token = `vti_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const changeId = id("vchange");
    const after = { ...before, token_prefix: token.slice(0, 12), active: 1, updated_at: now };
    const ip = request.headers.get("cf-connecting-ip");
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE visitor_connectors SET token_hash=?,token_prefix=?,active=1,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND updated_at=?`)
        .bind(await sha256(token), token.slice(0, 12), changeId, now, workspaceId, visitorConnectorMatch[1], expectedUpdatedAt),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'visitor_connector.rotated','visitor_connector',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM visitor_connectors WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, visitorConnectorMatch[1], JSON.stringify(before),
          JSON.stringify(after), requestId(request), ip ? await sha256(ip) : null, now,
          workspaceId, visitorConnectorMatch[1], changeId),
    ]);
    if (!results[0].meta.changes) {
      return json({ error: "Visitor connector changed before rotation", code: "edit_conflict" }, 409);
    }
    return json({
      ok: true,
      connector: {
        id: visitorConnectorMatch[1], provider: before.provider, token_prefix: token.slice(0, 12), updated_at: now,
        webhook_url: `https://ingest.example.com/v1/integrations/visitor-intent/${before.provider}/${token}`,
        audience_sync_url: before.provider === "audiencelab"
          ? `https://ingest.example.com/v1/integrations/audience-intake/audiencelab/${token}`
          : null,
      },
    });
  }

  if (visitorConnectorMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const expectedUpdatedAt = url.searchParams.get("if_updated_at");
    if (!expectedUpdatedAt) return json({ error: "if_updated_at is required" }, 400);
    const before = await env.DB.prepare(`SELECT id,provider,name,token_prefix,active,consent_default,last_event_at,created_at,updated_at
      FROM visitor_connectors WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, visitorConnectorMatch[1]).first<Record<string, unknown>>();
    if (!before) return json({ error: "Visitor connector not found" }, 404);
    const now = new Date().toISOString();
    const changeId = id("vchange");
    const after = { ...before, active: 0, updated_at: now };
    const ip = request.headers.get("cf-connecting-ip");
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE visitor_connectors SET active=0,change_id=?,updated_at=?
        WHERE workspace_id=? AND id=? AND updated_at=? AND active=1`)
        .bind(changeId, now, workspaceId, visitorConnectorMatch[1], expectedUpdatedAt),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'visitor_connector.revoked','visitor_connector',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM visitor_connectors WHERE workspace_id=? AND id=? AND change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, visitorConnectorMatch[1], JSON.stringify(before),
          JSON.stringify(after), requestId(request), ip ? await sha256(ip) : null, now,
          workspaceId, visitorConnectorMatch[1], changeId),
    ]);
    if (!results[0].meta.changes) {
      return json({ error: "Visitor connector changed or was already revoked", code: "edit_conflict" }, 409);
    }
    return json({ ok: true, active: false, updated_at: now });
  }

  const visitorResearchMatch = url.pathname.match(/^\/v1\/admin\/visitor-profiles\/(vpr_[a-f0-9]{32})\/research$/);
  if (visitorResearchMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedRevision = Number(body.expected_revision);
    const researchType = optionalString(body.research_type, "research_type", 40);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    if (!researchType || !["company_research", "person_enrichment"].includes(researchType)) {
      return json({ error: "research_type must be company_research or person_enrichment" }, 400);
    }
    const profile = await env.DB.prepare(`SELECT id,provider,identity_kind,email,first_name,last_name,linkedin_url,title,
      company_name,company_domain,industry,employee_count,estimated_revenue,city,region,consent_status,review_status,
      visit_count,high_intent_count,last_seen_at,latest_url,tags,revision
      FROM visitor_profiles WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, visitorResearchMatch[1]).first<Record<string, unknown>>();
    if (!profile) return json({ error: "Visitor profile not found" }, 404);
    if (Number(profile.revision) !== expectedRevision) {
      return json({ error: "Visitor evidence changed before research was requested", code: "edit_conflict" }, 409);
    }
    if (profile.review_status === "suppressed") return json({ error: "Suppressed profiles cannot be researched" }, 409);
    if (researchType === "company_research" && !profile.company_domain) {
      return json({ error: "A company domain is required for account research" }, 409);
    }
    if (researchType === "person_enrichment" &&
      (profile.identity_kind !== "person" || profile.consent_status !== "granted")) {
      return json({ error: "Person enrichment requires deterministic person identity and granted consent" }, 409);
    }
    const evidence = researchType === "company_research"
      ? {
          profile_id: profile.id, provider: profile.provider, identity_kind: profile.identity_kind,
          company_name: profile.company_name, company_domain: profile.company_domain, industry: profile.industry,
          employee_count: profile.employee_count, estimated_revenue: profile.estimated_revenue,
          visit_count: profile.visit_count, high_intent_count: profile.high_intent_count,
          last_seen_at: profile.last_seen_at, latest_url: profile.latest_url,
          consent_status: profile.consent_status, review_status: profile.review_status, revision: profile.revision,
        }
      : {
          profile_id: profile.id, provider: profile.provider, identity_kind: profile.identity_kind,
          email: profile.email, first_name: profile.first_name, last_name: profile.last_name,
          linkedin_url: profile.linkedin_url, title: profile.title, company_name: profile.company_name,
          company_domain: profile.company_domain, city: profile.city, region: profile.region,
          consent_status: profile.consent_status, review_status: profile.review_status, revision: profile.revision,
        };
    const workItemId = id("work");
    const now = new Date().toISOString();
    const objective = researchType === "company_research"
      ? `Research account ${String(profile.company_domain)}`
      : `Enrich consented person ${String(profile.email || profile.linkedin_url)}`;
    const instructions = researchType === "company_research"
      ? "Research this company using public business sources. Return claims with source URLs and confidence. Do not identify a person from IP data, create CRM records, or contact anyone."
      : "Verify the supplied consented identity using public professional sources. Return claims with source URLs and confidence. Do not create CRM records or contact anyone.";
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO agent_work_items
          (id,workspace_id,visitor_profile_id,work_item_type,evidence_revision,evidence_snapshot,objective,instructions,
           preferred_provider,status,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,'any','queued',?,?
          WHERE EXISTS(SELECT 1 FROM visitor_profiles WHERE workspace_id=? AND id=? AND revision=?)`)
          .bind(workItemId, workspaceId, profile.id, researchType, expectedRevision, JSON.stringify(evidence),
            objective, instructions, now, now, workspaceId, profile.id, expectedRevision),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,request_id,ip_hash,created_at)
          SELECT ?,?,'user',?,'visitor_research.queued','agent_work_item',?,NULL,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM agent_work_items WHERE workspace_id=? AND id=? AND status='queued')`)
          .bind(id("audit"), workspaceId, access.email, workItemId,
            JSON.stringify({ visitor_profile_id: profile.id, research_type: researchType,
              evidence_revision: expectedRevision, outreach_authorized: false }),
            requestId(request), request.headers.get("cf-connecting-ip")
              ? await sha256(request.headers.get("cf-connecting-ip")!) : null, now,
            workspaceId, workItemId),
      ]);
      if (!results[0].meta.changes) return json({ error: "Visitor evidence changed before research was queued", code: "edit_conflict" }, 409);
    } catch {
      const existing = await env.DB.prepare(`SELECT id FROM agent_work_items WHERE workspace_id=? AND visitor_profile_id=?
        AND work_item_type=? AND status IN ('queued','claimed') ORDER BY created_at,id LIMIT 1`)
        .bind(workspaceId, profile.id, researchType).first<{ id: string }>();
      if (existing) return json({ error: "An active research job already exists", code: "active_research_exists", work_item_id: existing.id }, 409);
      throw new ApiError(500, "The research job could not be queued");
    }
    return json({
      ok: true,
      work_item: { id: workItemId, type: researchType, status: "queued", evidence_revision: expectedRevision },
      authority: { crm_mutation: false, outreach: false, consent_change: false, human_review_required: true },
    }, 201);
  }

  const visitorProfileMatch = url.pathname.match(/^\/v1\/admin\/visitor-profiles\/(vpr_[a-f0-9]{32})$/);
  if (visitorProfileMatch && request.method === "PATCH") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const reviewStatus = optionalString(body.review_status, "review_status", 20);
    const expectedRevision = Number(body.expected_revision);
    if (!reviewStatus || !["reviewed", "suppressed"].includes(reviewStatus)) {
      return json({ error: "review_status must be reviewed or suppressed" }, 400);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const profile = await env.DB.prepare(`SELECT id,review_status,revision FROM visitor_profiles
      WHERE workspace_id=? AND id=?`).bind(workspaceId, visitorProfileMatch[1])
      .first<{ id: string; review_status: string; revision: number }>();
    if (!profile) return json({ error: "Visitor profile not found" }, 404);
    if (profile.review_status === "promoted") return json({ error: "Promoted profiles cannot be suppressed" }, 409);
    const now = new Date().toISOString();
    const reviewChangeId = id("vchange");
    const ip = request.headers.get("cf-connecting-ip");
    const ipHash = ip ? await sha256(ip) : null;
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE visitor_profiles SET review_status=?,review_change_id=?,revision=revision+1,updated_at=?
        WHERE workspace_id=? AND id=? AND revision=? AND review_status<>'promoted'`)
        .bind(reviewStatus, reviewChangeId, now, workspaceId, profile.id, expectedRevision),
      env.DB.prepare(`INSERT INTO audit_log
        (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,
         request_id,ip_hash,created_at)
        SELECT ?,?,'user',?,'visitor_profile.${reviewStatus}','visitor_profile',?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM visitor_profiles
          WHERE workspace_id=? AND id=? AND revision=? AND review_status=? AND review_change_id=?)`)
        .bind(id("audit"), workspaceId, access.email, profile.id,
          JSON.stringify({ review_status: profile.review_status, revision: profile.revision }),
          JSON.stringify({ review_status: reviewStatus, revision: expectedRevision + 1 }),
          requestId(request), ipHash, now, workspaceId, profile.id, expectedRevision + 1, reviewStatus, reviewChangeId),
    ]);
    if (!results[0].meta.changes) {
      return json({ error: "Visitor profile changed before review", code: "edit_conflict" }, 409);
    }
    return json({ ok: true, review_status: reviewStatus, revision: expectedRevision + 1 });
  }

  const visitorPromoteMatch = url.pathname.match(/^\/v1\/admin\/visitor-profiles\/(vpr_[a-f0-9]{32})\/promote$/);
  if (visitorPromoteMatch && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const body = await readJson(request);
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return json({ error: "expected_revision must be a positive integer" }, 400);
    }
    const profile = await env.DB.prepare(`SELECT * FROM visitor_profiles WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, visitorPromoteMatch[1]).first<Record<string, unknown>>();
    if (!profile) return json({ error: "Visitor profile not found" }, 404);
    if (profile.review_status === "suppressed") return json({ error: "Suppressed profiles must be reviewed before promotion" }, 409);
    if (profile.consent_status === "denied") return json({ error: "A denied-consent profile cannot be promoted" }, 409);
    const email = normalizeEmail(profile.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "A verified email is required before person-level promotion" }, 409);
    }
    const generatedContactId = id("con");
    const companyName = String(profile.company_name || "").trim();
    const companyRecord = companyName ? await companyIdentity(env, workspaceId, companyName, new Date().toISOString()) : null;
    const now = new Date().toISOString();
    const nextRevision = expectedRevision + 1;
    const reviewChangeId = id("vchange");
    const profileGate = `EXISTS(SELECT 1 FROM visitor_profiles
      WHERE workspace_id=? AND id=? AND revision=? AND review_status<>'suppressed' AND consent_status<>'denied')`;
    const insertCompany = companyRecord
      ? env.DB.prepare(`INSERT OR IGNORE INTO companies(id,workspace_id,name,name_key,domain,website,industry,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE ${profileGate}`)
        .bind(companyRecord.id, workspaceId, companyRecord.name, companyRecord.nameKey, profile.company_domain,
          profile.company_domain ? `https://${profile.company_domain}` : null, profile.industry, now, now,
          workspaceId, profile.id, expectedRevision)
      : env.DB.prepare("SELECT 1");
    const ip = request.headers.get("cf-connecting-ip");
    const ipHash = ip ? await sha256(ip) : null;
    let results: D1Result<unknown>[];
    try {
      results = await env.DB.batch([
        insertCompany,
        env.DB.prepare(`INSERT OR IGNORE INTO contacts
          (id,workspace_id,email,first_name,last_name,company,company_id,status,stage,score,source_first,source_last,
           tags,custom_fields,last_activity_at,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,'lead','new',0,?,?,?, ?,?,?,? WHERE ${profileGate}`)
          .bind(generatedContactId, workspaceId, email, profile.first_name, profile.last_name,
            companyRecord?.name || companyName || null, companyRecord?.id || null,
            `visitor:${profile.provider}`, `visitor:${profile.provider}`,
            JSON.stringify(["website-visitor", `visitor:${profile.provider}`]),
            JSON.stringify({ visitor_intent: { profile_id: profile.id, consent_status: profile.consent_status } }),
            profile.last_seen_at, now, now, workspaceId, profile.id, expectedRevision),
        env.DB.prepare(`UPDATE visitor_profiles SET review_status='promoted',
            matched_contact_id=(SELECT id FROM contacts WHERE workspace_id=? AND email=? LIMIT 1),
            review_change_id=?,revision=revision+1,updated_at=?
          WHERE workspace_id=? AND id=? AND revision=? AND review_status<>'suppressed' AND consent_status<>'denied'`)
          .bind(workspaceId, email, reviewChangeId, now, workspaceId, profile.id, expectedRevision),
        env.DB.prepare(`INSERT INTO audit_log
          (id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,before_state,after_state,
           request_id,ip_hash,created_at)
          SELECT ?,?,'user',?,'visitor_profile.promoted','visitor_profile',?,?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM visitor_profiles
            WHERE workspace_id=? AND id=? AND revision=? AND review_status='promoted' AND review_change_id=?)`)
          .bind(id("audit"), workspaceId, access.email, profile.id,
            JSON.stringify({ review_status: profile.review_status, revision: profile.revision }),
            JSON.stringify({ review_status: "promoted", revision: nextRevision, email }),
            requestId(request), ipHash, now, workspaceId, profile.id, nextRevision, reviewChangeId),
      ]);
    } catch (error) {
      if (String(error).includes("audit_log_visitor_profile_promoted_once")) {
        return json({ error: "Visitor profile changed before promotion", code: "edit_conflict" }, 409);
      }
      throw error;
    }
    if (!results[2].meta.changes) {
      return json({ error: "Visitor profile changed before promotion", code: "edit_conflict" }, 409);
    }
    const contact = await env.DB.prepare("SELECT * FROM contacts WHERE workspace_id=? AND email=?")
      .bind(workspaceId, email).first<Record<string, unknown>>();
    if (!contact) throw new Error("Promoted visitor contact was not resolved");
    const created = Boolean(results[1].meta.changes) && contact.id === generatedContactId;
    if (created) {
      await runContactAutomations(env, access, contact, `visitor-promotion:${profile.id}:${nextRevision}`, "contact.created");
    }
    return json({
      ok: true, created, contact_id: contact.id, review_status: "promoted", revision: nextRevision,
      consent_warning: profile.consent_status === "unknown",
    }, created ? 201 : 200);
  }

  if (url.pathname === "/v1/admin/sources" && request.method === "GET") {
    const sources = await env.DB.prepare("SELECT id,slug,name,key_prefix,allowed_origins,active,last_used_at,created_at FROM sources WHERE workspace_id=? ORDER BY created_at DESC").bind(workspaceId).all();
    return json({ sources: sources.results });
  }
  if (url.pathname === "/v1/admin/sources" && request.method === "POST") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    let body: Json;
    try { body = await readJson(request); } catch (error) {
      return error instanceof ApiError ? json({ error: error.message }, error.status) : json({ error: "Invalid request" }, 400);
    }
    const slug = String(body.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const sourceName = optionalString(body.name, "name", 120);
    if (!slug || slug.length > 80 || !sourceName) return json({ error: "name and slug are required" }, 400);
    if (body.allowed_origins !== undefined && (!Array.isArray(body.allowed_origins) || body.allowed_origins.some((origin) => typeof origin !== "string" || origin.length > 300))) {
      return json({ error: "allowed_origins must be an array of URLs" }, 400);
    }
    const rawKey = `crm_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const sourceId = id("src");
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO sources(id,workspace_id,slug,name,key_prefix,key_hash,allowed_origins,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)")
          .bind(sourceId, workspaceId, slug, sourceName, rawKey.slice(0, 12), await sha256(rawKey), JSON.stringify(body.allowed_origins || []), now),
        await auditStatement(env, access, request, "source.created", "source", sourceId, null,
          { slug, name: sourceName, allowed_origins: body.allowed_origins || [] }),
      ]);
    } catch (error) {
      const duplicate = await env.DB.prepare("SELECT 1 present FROM sources WHERE workspace_id=? AND slug=?")
        .bind(workspaceId, slug).first();
      if (duplicate) return json({ error: "A source with that slug already exists" }, 409);
      throw error;
    }
    return json({ ok: true, source: { slug, name: sourceName, api_key: rawKey } }, 201);
  }
  const sourcePurgeMatch = url.pathname.match(/^\/v1\/admin\/sources\/([^/]+)\/purge$/);
  if (sourcePurgeMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const source = await env.DB.prepare("SELECT id,slug,name,active FROM sources WHERE workspace_id=? AND id=?").bind(workspaceId, sourcePurgeMatch[1]).first<Record<string, unknown>>();
    if (!source) return json({ error: "Source not found" }, 404);
    if (source.active) return json({ error: "Revoke the source before purging it" }, 409);
    const references = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM activities WHERE source_id=?) +
      (SELECT COUNT(*) FROM deals WHERE source_id=?) total`)
      .bind(sourcePurgeMatch[1], sourcePurgeMatch[1]).first<{ total: number }>();
    if (references?.total) return json({ error: "Source still has CRM history" }, 409);
    const deleted = await env.DB.batch([
      await sourceMutationAuditStatement(env, access, request, "source.purged", sourcePurgeMatch[1], source, null, 0),
      env.DB.prepare("DELETE FROM sources WHERE workspace_id=? AND id=? AND active=0").bind(workspaceId, sourcePurgeMatch[1]),
    ]);
    if (!deleted[1].meta.changes) return json({ error: "Source changed before it could be purged" }, 409);
    return json({ ok: true });
  }
  const sourceMatch = url.pathname.match(/^\/v1\/admin\/sources\/([^/]+)$/);
  if (sourceMatch && request.method === "DELETE") {
    if (!isWorkspaceAdmin(access)) return json({ error: "Admin role required" }, 403);
    const source = await env.DB.prepare("SELECT id,slug,name,active FROM sources WHERE workspace_id=? AND id=?").bind(workspaceId, sourceMatch[1]).first<Record<string, unknown>>();
    if (!source) return json({ error: "Source not found" }, 404);
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE sources SET active=0 WHERE workspace_id=? AND id=? AND active=1").bind(workspaceId, sourceMatch[1]),
      await sourceMutationAuditStatement(env, access, request, "source.revoked", sourceMatch[1], source, { ...source, active: 0 }, 0),
    ]);
    if (!result[0].meta.changes) return json({ error: "Source was already revoked" }, 409);
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

const worker = {
  async fetch(request: Request, env: FrameworkEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if ((url.pathname === "/robots.txt" || url.pathname === "/sitemap.xml") && request.method === "GET") {
        return new Response("User-agent: *\nDisallow: /\n", {
          status: url.pathname === "/robots.txt" ? 200 : 404,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
          },
        });
      }
      if (url.pathname === "/favicon.ico" && request.method === "GET") return faviconResponse();
      if (usesIndependentCredential(url.pathname)) {
        const independentlyAuthenticated = await api(request, env, url);
        if (independentlyAuthenticated) return independentlyAuthenticated;
        if ((/^\/f\/[a-z0-9][a-z0-9-]{2,79}$/.test(url.pathname) ||
          /^\/book\/[a-z0-9][a-z0-9-]{2,79}(?:\/manage)?$/.test(url.pathname)) && request.method === "GET") {
          const response = await handler.fetch(request, env, ctx);
          const headers = new Headers(response.headers);
          for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
          headers.set("cache-control", "public, max-age=60, stale-while-revalidate=300");
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
      }
      request = await authenticatedRequest(request, env);
      const apiResponse = await api(request, env, url);
      if (apiResponse) return apiResponse;
      if (url.pathname === "/_vinext/image") {
        return handleImageOptimization(request, {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) =>
            (await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality })).response(),
        }, [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES]);
      }
      const response = await handler.fetch(request, env, ctx);
      if (response.headers.get("content-type")?.startsWith("text/html")) {
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
        headers.set("cache-control", "private, no-store");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({
        message: "unhandled request error",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      }));
      return json({ error: "Internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<FrameworkEnv>;
export default worker;
