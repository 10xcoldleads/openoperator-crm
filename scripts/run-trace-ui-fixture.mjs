import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import app from "../dist/server/index.js";

const port = 4242;
const now = "2026-07-28T20:00:00.000Z";
let mailboxMode = "error";
let roleMode = "owner";
let agentMode = "idle";
let proposalDecisions = [];
const response = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const contacts = {
  contacts: [],
  pagination: { page: 1, limit: 50, total: 0, pages: 1 },
  facets: { owners: [], sources: [] },
};
const sources = [
  { id: "src_1", slug: "agent-factory-waitlist", name: "Agent Factory Waitlist", key_prefix: "crm_fixture1", active: 1, last_used_at: now, created_at: now },
  { id: "src_2", slug: "prompt-to-agent-funnel", name: "Prompt-to-Agent Funnel", key_prefix: "crm_fixture2", active: 1, last_used_at: now, created_at: now },
  { id: "src_3", slug: "ai-agent-workshop-97", name: "$97 AI Agent Workshop", key_prefix: "crm_fixture3", active: 1, last_used_at: now, created_at: now },
  { id: "src_4", slug: "old-waitlist", name: "Old Waitlist", key_prefix: "crm_fixture4", active: 0, last_used_at: null, created_at: now },
];
const fixtureProposals = [
  {
    id: "prop_11111111111111111111111111111111", workspace_id: "ws_fixture",
    contact_id: null, opportunity_id: null, agent_type: "revenue_operator",
    title: "Review primary follow-up", rationale: "The primary lead needs a bounded next action.",
    confidence: 82, risk_level: "low",
    proposed_action: JSON.stringify({ type: "create_task", title: "Call primary lead" }),
    status: "pending", created_at: now, run_id: "arun_fixture",
    dedupe_key: "fixture:one", category: "pipeline_execution", priority: 80,
    expires_at: "2026-08-05T20:00:00.000Z", execution_result: null, credential_id: null,
  },
  {
    id: "prop_22222222222222222222222222222222", workspace_id: "ws_fixture",
    contact_id: null, opportunity_id: null, agent_type: "revenue_operator",
    title: "Review secondary follow-up", rationale: "The secondary lead needs a distinct bounded next action.",
    confidence: 77, risk_level: "low",
    proposed_action: JSON.stringify({ type: "create_task", title: "Email secondary lead" }),
    status: "pending", created_at: now, run_id: "arun_fixture",
    dedupe_key: "fixture:two", category: "pipeline_execution", priority: 70,
    expires_at: "2026-08-05T20:00:00.000Z", execution_result: null, credential_id: null,
  },
];
const control = {
  workspace: { id: "ws_fixture", name: "Trace proof", onboarding_status: "active" },
  role: "owner",
  current_user: { email: "owner@example.com", role: "owner" },
  pipelines: [], stages: [], opportunities: [], tasks: [],
  automations: [{
    id: "rule_1", name: "Publish lead event", trigger_type: "contact.created", status: "active",
    conditions: "[]", actions: '[{"type":"publish_event"}]', else_actions: "[]",
    max_runs_per_record: 20, authority_manifest: '["integration.publish"]',
    authority_hash: "fixture", updated_at: now,
  }],
  runs: [{
    id: "run_1", rule_id: "rule_1", record_type: "contact", record_id: "contact_1",
    retry_of_run_id: null, automation_name: "Publish lead event", trigger_type: "contact.created",
    principal_id: "automation:rule_1", trigger_actor_type: "user", trigger_actor_id: "owner@example.com",
    authority_manifest: '["integration.publish"]', authority_hash: "fixture",
    status: "succeeded", step_count: 1,
    output: JSON.stringify([
      { action: "branch", outcome: "matched" },
      {
        action: "publish_event", event_id: "workflow-event-proof",
        event_type: "contact.workflow_event", subscribers: 1,
        step_id: "notify_crm", output_schema_version: 1,
        raw_payload: "<script>must-not-render()</script>",
      },
    ]),
    error: null, started_at: now, finished_at: now,
  }],
  webhooks: [{
    id: "hook_1", name: "Pixel Skool bridge", direction: "inbound", url: null,
    event_types: '["contact.created","opportunity.updated"]', secret_prefix: "whsec_fixture",
    active: 1, updated_at: now,
  }], deliveries: [], proposals: [], agent_runs: [],
  agent_policy: {
    mode: "copilot", require_approval: 1, max_proposals_per_run: 25,
    stale_after_days: 7, high_value_threshold: 5000,
    agent_access_enabled: 1, workspace_rate_limit_per_minute: 120,
  },
  checks: [], audits: [], companies: [], saved_views: [], agent_work_items: [],
};

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  console.log(`${req.method || "GET"} ${url.pathname}${url.search}`);
  if (url.pathname === "/" && ["error", "empty", "active", "revoked", "data_error", "loading"].includes(url.searchParams.get("mailbox_state") || "")) {
    mailboxMode = url.searchParams.get("mailbox_state");
    roleMode = url.searchParams.get("role") === "member" ? "member" : "owner";
    agentMode = ["busy", "restore"].includes(url.searchParams.get("agent_state") || "")
      ? url.searchParams.get("agent_state") : "idle";
    if (url.searchParams.get("reset_proposals") === "1") {
      proposalDecisions = [];
      for (const proposal of fixtureProposals) {
        proposal.status = "pending";
        proposal.execution_result = null;
      }
    }
  }
  if (url.pathname === "/v1/admin/dashboard") {
    return response(res, { metrics: { contacts: 0, customers: 0, revenue: 0, followUps: 0 }, stages: {}, contacts: [] });
  }
  if (url.pathname === "/v1/admin/sources") return response(res, { sources });
  if (url.pathname === "/v1/admin/control-center") return response(res, {
    ...control,
    proposals: fixtureProposals,
    role: roleMode,
    current_user: { email: roleMode === "member" ? "member@example.com" : "owner@example.com", role: roleMode },
  });
  if (url.pathname === "/fixture/proposal-decisions") return response(res, { decisions: proposalDecisions });
  if (url.pathname === "/v1/admin/briefing") {
    return response(res, {
      generated_at: now,
      metrics: { open_pipeline: 0, weighted_forecast: 0, overdue_tasks: 0, due_today: 0, stalled_deals: 0, unqualified_leads: 0 },
      top_leads: [], stalled_opportunities: [], overdue_tasks: [],
    });
  }
  if (url.pathname === "/v1/admin/access-policy") {
    return response(res, {
      policy: {
        revision: 1, updated_by: "owner@example.com", updated_at: now, editable: true,
        subject_role: "member", resource: "contact", grants: [], allowed_grants: [], invariants: {},
      },
      current_user: {
        email: roleMode === "member" ? "member@example.com" : "owner@example.com",
        role: roleMode,
      }, members: [],
    });
  }
  if (url.pathname === "/v1/admin/agent-credentials") return response(res, { credentials: roleMode === "member" ? [] : [{
    id: "cred_1", name: "Executive CRM Agent", provider: "hermes", key_prefix: "crai_fixture",
    scopes: '["crm:summary:read","crm:contacts:read","crm:propose"]', active: 1,
    lifecycle_status: "active", rate_limit_per_minute: 60, last_used_at: null,
    expires_at: null, created_at: now, created_by: "owner@example.com", revoked_at: null,
  }] });
  if (url.pathname === "/v1/admin/agent/analyze" && req.method === "POST") {
    if (roleMode === "member") return response(res, { error: "Admin role required" }, 403);
    if (agentMode === "restore") {
      res.setHeader("retry-after", "24");
      return response(res, {
        error: "A workspace restore is already running; revenue analysis is temporarily paused",
        code: "agent_run_in_progress",
        blocking_operation: "workspace_restore",
        retry_after_seconds: 24,
      }, 409);
    }
    if (agentMode === "busy") {
      res.setHeader("retry-after", "37");
      return response(res, {
        error: "A revenue-agent analysis is already running for this workspace",
        code: "agent_run_in_progress",
        retry_after_seconds: 37,
      }, 409);
    }
    return response(res, {
      ok: true, analysis_id: "arun_fixture", analyzed: 0, proposals_created: 0,
      proposals_refreshed: 0, proposals_expired: 0, healthy: 0,
      reasons: {
        missing_next_step: 0, stale: 0, overdue: 0, unowned: 0,
        missing_close_date: 0, zero_value: 0, lead_follow_up: 0, call_risk: 0,
      },
      policy: { mode: "copilot", require_approval: true, max_proposals_per_run: 25 },
    });
  }
  const proposalDecisionMatch = url.pathname.match(/^\/v1\/admin\/agent\/proposals\/([^/]+)\/decision$/);
  if (proposalDecisionMatch && req.method === "POST") {
    if (roleMode === "member") return response(res, { error: "Admin role required" }, 403);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { return response(res, { error: "Invalid JSON" }, 400); }
    if (!["approved", "rejected"].includes(body.decision)) return response(res, { error: "Invalid decision" }, 400);
    const proposal = fixtureProposals.find((item) => item.id === proposalDecisionMatch[1]);
    if (!proposal || proposal.status !== "pending") return response(res, { error: "Proposal is no longer pending" }, 409);
    proposalDecisions.push({ id: proposal.id, decision: body.decision });
    proposal.status = body.decision;
    proposal.execution_result = JSON.stringify(body.decision === "approved"
      ? { executed: true, message: "Fixture action executed." }
      : { executed: false, rejected: true, message: "Rejected — nothing executed." });
    return response(res, { ok: true, executed: body.decision === "approved" });
  }
  if (url.pathname === "/v1/admin/contacts") return response(res, contacts);
  if (url.pathname === "/v1/admin/mailbox-connections") {
    if (mailboxMode === "data_error") return response(res, { error: "Fixture mailbox read failed" }, 503);
    if (mailboxMode === "loading") await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
    const connection = {
      id: "mbx_11111111111111111111111111111111", owner_email: "owner@example.com",
      provider: "gmail", toolkit: "gmail", alias: "Primary inbox", status: mailboxMode,
      connected_account_id: mailboxMode === "empty" || mailboxMode === "error" ? null : "ca_fixture",
      connect_expires_at: null,
      provider_status: mailboxMode === "active" ? "ACTIVE" : mailboxMode === "revoked" ? "REVOKED" : "PROVIDER_UNAVAILABLE",
      allowed_capabilities: ["mail.profile.read", "mail.drafts.create"], last_synced_at: now,
      last_error: mailboxMode === "error" ? "Composio was unavailable (HTTP 503)" : null,
      revision: 2, created_at: now, updated_at: now,
    };
    return response(res, {
    connections: mailboxMode === "empty" ? [] : [connection],
    readiness: { composio: true, gmail: true, outlook: false, authority: "connection_only_no_execution" },
    contracts: {
      self_service: "mailbox_oauth_self_service_v1",
      advanced_link: "mailbox_connect_link_advanced_v1",
    },
    });
  }
  if (url.pathname.startsWith("/v1/admin/")) return response(res, { error: "Fixture route is not configured" }, 404);

  if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico") {
    try {
      const assetPath = url.pathname === "/favicon.ico"
        ? resolve("dist/client/favicon.ico")
        : resolve("dist/client", `.${url.pathname}`);
      const mime = {
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".ico": "image/x-icon",
      }[extname(assetPath)] || "application/octet-stream";
      const asset = await readFile(assetPath);
      res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
      return res.end(asset);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
  }
  const upstreamResponse = await app.fetch(
    new Request(`http://fixture.local${url.pathname}${url.search}`, {
      headers: { accept: req.headers.accept || "text/html" },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  const headers = Object.fromEntries(upstreamResponse.headers.entries());
  delete headers["content-encoding"];
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  res.writeHead(upstreamResponse.status, headers);
  res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
}).listen(port, "127.0.0.1", () => {
  console.log(`Trace UI fixture running at http://127.0.0.1:${port}`);
});
