import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

async function loadWorker() {
  const workerUrl = new URL("../.test-dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  ALLOW_INSECURE_LOCAL_AUTH: "true",
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

test("server-renders the OpenOperator CRM shell", async () => {
  const [layout, favicon, styles] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/favicon.ico", import.meta.url)),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /shortcut: "\/favicon\.ico"/);
  assert.match(layout, /openoperator_asset_recovery/);
  assert.match(layout, /failed to fetch dynamically imported module/);
  assert.match(layout, /next\.searchParams\.has\("__asset_retry"\)/);
  assert.match(layout, /next\.searchParams\.set\("__asset_retry"/);
  assert.match(layout, /window\.location\.replace\(next\.toString\(\)\)/);
  assert.deepEqual([...favicon.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/", {
    headers: { accept: "text/html" },
  }), env, ctx);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>OpenOperator CRM<\/title>/);
  assert.match(html, /openoperator_asset_recovery/);
  assert.match(html, /aria-label="CRM workspace"/);
  assert.match(html, /aria-label="Dashboard" title="Dashboard" aria-current="page"><i aria-hidden="true">D<\/i><span>Dashboard<\/span>/);
  assert.match(html, /<span>Contacts<\/span>/);
  assert.match(html, /<span>Opportunities<\/span>/);
  assert.match(html, /data-view="dashboard"/);
  assert.match(html, /id="lead-inbox" hidden/);
  assert.match(html, /id="opportunities" hidden/);
  assert.match(html, /Isolated and audited/);
  assert.match(styles, /--chrome-surface:rgba\(255,255,255,.72\)/);
  assert.match(styles, /\.metrics article \{[\s\S]*backdrop-filter:blur\(22px\) saturate\(125%\)/);
  assert.match(styles, /Glass chrome v2: lead operating workspace/);
  assert.match(styles, /\.sales-execution,\.companies-panel \{[\s\S]*backdrop-filter:blur\(22px\) saturate\(118%\)/);
  assert.match(styles, /\.bulk-panel \{[\s\S]*linear-gradient\(150deg,#24272e,#17191e 76%\)/);
  assert.match(styles, /@media \(max-width:680px\) \{[\s\S]*\.sidebar \{[\s\S]*position:fixed;[\s\S]*inset:auto 10px 10px/);
  assert.match(styles, /grid-template-columns:repeat\(3,max-content\)/);
  assert.match(styles, /\.sidebar nav \.nav-group button \{ flex:0 0 48px; width:48px; min-width:48px; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \*,\*::before,\*::after/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships a functional responsive secure forms surface", async () => {
  const [dashboard, workspace, publicForm, styles, migration] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/FormsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/f/[slug]/PublicForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0049_secure_forms.sql", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /id: "forms", label: "Forms"/);
  assert.match(dashboard, /<FormsWorkspace active=\{activeView === "forms"\}/);
  assert.match(workspace, /PUBLISH FORM/);
  assert.match(workspace, /REVOKE FORM/);
  assert.match(workspace, /OPEN PUBLIC FORM/);
  assert.match(publicForm, /privacy_accepted: privacyAccepted/);
  assert.match(publicForm, /email_consent: emailConsent/);
  assert.match(publicForm, /className="form-honeypot"/);
  assert.match(styles, /\.forms-layout \{ display:grid; grid-template-columns:250px minmax\(390px,1fr\) 290px/);
  assert.match(styles, /@media \(max-width:760px\) \{ \.forms-workspace[\s\S]*\.forms-layout,\.form-editor \{ grid-template-columns:1fr/);
  assert.match(migration, /form_submissions_form_idempotency_unique/);
  assert.match(migration, /form_versions_form_version_unique/);
});

test("ships a functional responsive local-first booking surface", async () => {
  const [dashboard, workspace, publicBooking, manageBooking, styles, migration] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/BookingWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/book/[slug]/PublicBooking.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/book/[slug]/manage/ManageBooking.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0050_booking_core.sql", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /id: "booking", label: "Booking"/);
  assert.match(dashboard, /<BookingWorkspace active=\{activeView === "booking"\}/);
  assert.match(workspace, /PUBLISH CALENDAR/);
  assert.match(workspace, /REVOKE CALENDAR/);
  assert.match(publicBooking, /privacy_accepted: privacy/);
  assert.match(publicBooking, /location\.origin.*\/manage#token=/);
  assert.match(publicBooking, /No marketing consent is requested/);
  assert.match(manageBooking, /authorization: `Bearer \$\{token\}`/);
  assert.match(manageBooking, /"reschedule"/);
  assert.match(manageBooking, /"cancel"/);
  assert.match(styles, /@media\(max-width:760px\)\{\.booking-grid\{grid-template-columns:1fr\}/);
  assert.match(migration, /booking_appointments_calendar_idempotency_unique/);
  assert.match(migration, /booking_appointments_manage_token_unique/);
});

test("serves hashed client assets before the Worker while keeping dynamic routes Worker-first", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"run_worker_first": \["\/\*", "!\/assets\/\*"\]/);
  assert.doesNotMatch(config, /"run_worker_first": true/);
});

test("fails closed for HTML and platform APIs when production authentication is absent", async () => {
  const worker = await loadWorker();
  const productionLikeEnv = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const [html, spoofedPlatform] = await Promise.all([
    worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), productionLikeEnv, ctx),
    worker.fetch(new Request("http://localhost/v1/platform/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "oai-authenticated-user-email": "owner@example.com" },
      body: JSON.stringify({ name: "Spoofed", slug: "spoofed", owner_email: "attacker@example.com" }),
    }), productionLikeEnv, ctx),
  ]);
  assert.equal(html.status, 503);
  assert.equal(spoofedPlatform.status, 503);
  assert.deepEqual(await spoofedPlatform.json(), { error: "Authentication is not configured" });
});

test("accepts only cryptographically valid Cloudflare Access JWTs", async () => {
  const worker = await loadWorker();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "access-test-key", alg: "RS256", use: "sig" };
  const jwks = createServer((request, response) => {
    if (request.url !== "/cdn-cgi/access/certs") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  jwks.listen(0, "127.0.0.1");
  await once(jwks, "listening");
  const address = jwks.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const issuer = `http://127.0.0.1:${address.port}`;
  const accessEnv = {
    ASSETS: env.ASSETS,
    TEAM_DOMAIN: issuer,
    POLICY_AUD: "openoperator-test-policy",
  };
  const sign = (audience) => new SignJWT({ email: "Owner@Example.com", name: "Test Owner" })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);
  try {
    const [validToken, wrongAudienceToken] = await Promise.all([
      sign(accessEnv.POLICY_AUD),
      sign("wrong-policy"),
    ]);
    const [valid, wrongAudience] = await Promise.all([
      worker.fetch(new Request("http://localhost/", {
        headers: { accept: "text/html", "cf-access-jwt-assertion": validToken },
      }), accessEnv, ctx),
      worker.fetch(new Request("http://localhost/", {
        headers: { accept: "text/html", "cf-access-jwt-assertion": wrongAudienceToken },
      }), accessEnv, ctx),
    ]);
    assert.equal(valid.status, 200);
    assert.equal(wrongAudience.status, 401);
    assert.deepEqual(await wrongAudience.json(), { error: "Invalid Cloudflare Access authentication" });
  } finally {
    jwks.close();
    await once(jwks, "close");
  }
});

test("lets independently authenticated routes reach their own credential checks", async () => {
  const worker = await loadWorker();
  const productionLikeEnv = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const [source, agent, scheduler] = await Promise.all([
    worker.fetch(new Request("http://localhost/v1/contacts/upsert", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid" },
      body: "{}",
    }), productionLikeEnv, ctx),
    worker.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }), productionLikeEnv, ctx),
    worker.fetch(new Request("http://localhost/v1/internal/jobs/webhook-retries", {
      method: "POST",
    }), productionLikeEnv, ctx),
  ]);
  assert.equal(source.status, 401);
  assert.equal(agent.status, 401);
  assert.equal(scheduler.status, 401);
});

test("does not turn the local browser convenience flag into a raw API authentication bypass", async () => {
  const worker = await loadWorker();
  const localEnv = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    ALLOW_INSECURE_LOCAL_AUTH: "true",
  };
  const [direct, htmlSpoof] = await Promise.all([
    worker.fetch(new Request("http://localhost/v1/admin/dashboard"), localEnv, ctx),
    worker.fetch(new Request("http://localhost/v1/admin/dashboard", {
      headers: { accept: "text/html" },
    }), localEnv, ctx),
  ]);
  assert.equal(direct.status, 401);
  assert.equal(htmlSpoof.status, 401);
  const navigation = await worker.fetch(new Request("http://localhost/", {
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  }), localEnv, ctx);
  assert.equal(navigation.status, 200);
});

test("keeps the governed task lifecycle consistent in list and linked-record workspaces", async () => {
  const [dashboard, styles, vitestConfig] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../vitest.config.ts", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /function TaskLifecycleControls/);
  assert.equal((dashboard.match(/<TaskLifecycleControls task=/g) || []).length, 4);
  assert.match(dashboard, /aria-label=\{`Complete \$\{task\.title\}`\}/);
  assert.match(dashboard, /aria-label=\{`Cancel \$\{task\.title\}`\}/);
  assert.match(dashboard, /aria-label=\{`Reopen \$\{task\.title\}`\}/);
  assert.match(dashboard, /deleteArmed \? "CONFIRM DELETE" : "DELETE"/);
  assert.match(dashboard, /refreshOpenContactDetail\(task\.contact_id\)/);
  assert.match(dashboard, /refreshOpenCompanyTaskDetail\(task\.id\)/);
  assert.match(dashboard, /companyDetail\?\.tasks\.length \|\| 0/);
  assert.match(dashboard, /setDetail\(\(current\) => current \? \{[\s\S]*tasks: current\.tasks\.map/);
  assert.match(dashboard, /setCompanyDetail\(\(current\) => current \? \{[\s\S]*tasks: current\.tasks\.map/);
  assert.match(dashboard, /tasks: current\.tasks\.filter\(\(item\) => item\.id !== task\.id\)/);
  assert.match(styles, /\.task-lifecycle-controls \{/);
  assert.match(styles, /\.related-records \.task-lifecycle-controls/);
  assert.match(styles, /\.company-relationships \.task-lifecycle-controls/);
  assert.match(vitestConfig, /hookTimeout: 30_000/);
  assert.match(vitestConfig, /testTimeout: 60_000/);
});

test("derives launch readiness from current safety contracts instead of retained history", async () => {
  const [dashboard, worker, styles] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /automation_runs_event_unique','automation_runs_retry_once_unique','webhook_delivery_event_unique/);
  assert.match(worker, /const automationSafetyHealthy = safetyIndexNames\.has/);
  assert.match(worker, /const webhookSafetyHealthy = safetyIndexNames\.has/);
  assert.match(worker, /const agentApprovalHealthy = Boolean\(agentPolicy\?\.require_approval === 1/);
  assert.match(worker, /label: "Automation idempotency and retry contract"/);
  assert.match(worker, /label: "Webhook secret and replay contract"/);
  assert.doesNotMatch(worker, /status: \(automationRun\?\.total \|\| 0\) > 0/);
  assert.doesNotMatch(worker, /status: \(inboundDelivery\?\.total \|\| 0\) > 0/);
  assert.match(dashboard, /Checks current configuration and safety guards without creating test leads, runs, or deliveries\./);
  assert.match(dashboard, /RUN READINESS CHECKS/);
  assert.match(dashboard, /Launch readiness refreshed from current policy and safety contracts\./);
  assert.match(dashboard, /Checked \{new Date\(check\.checked_at\)\.toLocaleString\(\)\}/);
  assert.match(styles, /\.launch-actions \{/);
  assert.match(styles, /\.check-list article time \{/);
});

test("exposes simple admin-only background operations health in launch readiness", async () => {
  const [dashboard, worker, styles, migration, policyMigration, escalationMigration, pagerDutyMigration] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0041_operations_health_history.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0042_operations_health_policy.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0043_operations_health_escalation.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0044_pagerduty_alert_destination.sql", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /"\/v1\/admin\/operations-health": \["GET"\]/);
  assert.match(worker, /if \(!isWorkspaceAdmin\(access\)\) return json\(\{ error: "Admin role required" \}, 403\)/);
  assert.match(worker, /record_content_included: false/);
  assert.match(worker, /derived_without_mutation: true/);
  assert.match(dashboard, /aria-label="Background operations health"/);
  assert.match(dashboard, /Is the CRM doing its work\?/);
  assert.match(dashboard, /loadOperationsHealth/);
  assert.match(dashboard, /no record content inspected or changed/);
  assert.match(dashboard, /Recent operations health history/);
  assert.match(dashboard, /incident, escalation, and recovery events/);
  assert.match(dashboard, /webhookOperationsAlerts/);
  assert.match(dashboard, /OPERATIONS ALERTS/);
  assert.match(dashboard, /Slack incoming webhook/);
  assert.match(dashboard, /Microsoft Teams workflow/);
  assert.match(dashboard, /Discord webhook/);
  assert.match(dashboard, /PagerDuty Events API v2/);
  assert.match(dashboard, /EVENTS API V2 ROUTING KEY/);
  assert.match(dashboard, /TEST ALERT \+ RESOLVE/);
  assert.match(dashboard, /incident-opened, escalation, and recovery events through this signed, retryable destination/);
  assert.match(dashboard, /setActiveView\("integrations"\); setIntegrationDomain\("webhooks"\)/);
  assert.doesNotMatch(dashboard, /setVisibleIntegrationDomain\(/);
  assert.match(dashboard, /aria-label="Operations alert policy"/);
  assert.match(dashboard, /CONFIRM FUTURE ALERT BEHAVIOR/);
  assert.match(dashboard, /No record, snapshot, or existing incident will be changed/);
  assert.match(styles, /\.operations-health-grid \{/);
  assert.match(styles, /\.operations-health-grid article\.action/);
  assert.match(styles, /\.operations-history-strip \{/);
  assert.match(styles, /\.operations-history \{[\s\S]*grid-template-columns/);
  assert.match(styles, /\.webhook-alert-option \{/);
  assert.match(styles, /\.operations-policy-fields \{/);
  assert.match(styles, /\.operations-policy-review \{/);
  assert.match(migration, /CREATE TABLE `operations_health_snapshots`/);
  assert.match(migration, /operations_health_snapshots_workspace_minute_unique/);
  assert.match(migration, /CREATE TABLE `operations_health_incidents`/);
  assert.match(migration, /operations_health_incidents_workspace_open_unique/);
  assert.match(worker, /retainScheduledOperationsHealth\(env\)/);
  assert.match(worker, /offset \+= 5/);
  assert.match(worker, /operations\.health\.action/);
  assert.match(worker, /operations\.health\.escalated/);
  assert.match(worker, /operations\.health\.recovered/);
  assert.match(worker, /"\/v1\/admin\/operations-health-policy": \["GET", "PATCH"\]/);
  assert.match(worker, /incident_after_consecutive_action/);
  assert.match(worker, /function webhookProviderBody/);
  assert.match(worker, /application\/vnd\.microsoft\.card\.adaptive/);
  assert.match(worker, /https:\/\/events\.pagerduty\.com\/v2\/enqueue/);
  assert.match(worker, /event_action: recovered \? "resolve" : "trigger"/);
  assert.match(worker, /dedup_key: event\.data\.incident_id/);
  assert.match(policyMigration, /CREATE TABLE `operations_health_policies`/);
  assert.match(policyMigration, /target_healthy_percentage/);
  assert.match(policyMigration, /incident_after_consecutive_action/);
  assert.match(policyMigration, /ADD COLUMN `payload_preset`/);
  assert.match(escalationMigration, /ADD COLUMN `escalation_delays_minutes`/);
  assert.match(escalationMigration, /ADD COLUMN `escalated_steps`/);
  assert.match(dashboard, /ESCALATION REMINDERS/);
  assert.match(dashboard, /15,60,240/);
  assert.match(worker, /queueDueOperationsEscalations/);
  assert.match(pagerDutyMigration, /ADD COLUMN `provider_credential_ciphertext`/);
});

test("transitions from a Company opportunity into its workspace without stacking modal focus traps", async () => {
  const [dashboard, styles] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /if \(!selectedCompanyId \|\| selectedOpportunityId \|\| selected\) return/);
  assert.match(dashboard, /\}, \[selectedCompanyId, selectedOpportunityId, selected\]\)/);
  assert.match(dashboard, /\{selectedCompany && !selectedOpportunity && !selected && <div className="drawer-backdrop company-backdrop"/);
  assert.match(dashboard, /aria-label=\{`Open \$\{item\.name\} opportunity workspace`\}/);
  assert.match(dashboard, /openOpportunityWorkspace\(item\)/);
  assert.match(dashboard, /async function refreshSelectedCompanyGraph\(\)/);
  assert.ok((dashboard.match(/refreshSelectedCompanyGraph\(\)/g) || []).length >= 6);
  assert.match(dashboard, /load\(\), loadContacts\(\), refreshSelectedCompanyGraph\(\)/);
  assert.match(styles, /\.company-opportunity-actions \{/);
  assert.match(styles, /\.company-opportunity-actions>button \{/);
});

test("returns from a Company person to a freshly reconciled account graph", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /async function openContact\(contact: Contact, preserveCompany = Boolean\(selectedCompanyId\)\)/);
  assert.match(dashboard, /const closeContactWorkspace = useCallback\(async \(\) =>/);
  assert.match(dashboard, /fetch\(`\/v1\/admin\/companies\/\$\{selectedCompanyId\}`/);
  assert.match(dashboard, /\}, \[selectedCompanyId\]\)/);
  assert.match(dashboard, /if \(!selectedCompanyId \|\| selectedOpportunityId \|\| selected\) return/);
  assert.match(dashboard, /selectedCompany && !selectedOpportunity && !selected/);
  assert.match(dashboard, /openContact\(\{ \.\.\.contact,[\s\S]*\}, true\)/);
  assert.match(dashboard, /onClick=\{\(\) => void closeContactWorkspace\(\)\}/);
  assert.match(dashboard, /selectedCompanyId \? refreshCompanyDetail\(selectedCompanyId\) : Promise\.resolve\(null\)/);
  assert.match(dashboard, /setSelectedCompanyId\(""\); setCompanyDetail\(null\);[\s\S]*setActiveView\("pipeline"\)/);
});

test("opens person-linked Company timeline events by authoritative Contact identity", async () => {
  const [dashboard, worker, styles] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /SELECT n\.\*,c\.id contact_id,c\.email contact_email/);
  assert.match(worker, /SELECT a\.\*,c\.id contact_id,c\.email contact_email/);
  assert.match(dashboard, /async function openCompanyTimelineContact\(contactId: string\)/);
  assert.match(dashboard, /companyDetail\?\.contacts\.find\(\(item\) => item\.id === contactId\)/);
  assert.match(dashboard, /await openContact\(\{[\s\S]*company: selectedCompany\.name,[\s\S]*\}, true\)/);
  assert.match(dashboard, /contact_id: item\.contact_id \|\| null/);
  assert.match(dashboard, /contact_id: item\.contact_id,/);
  assert.match(dashboard, /className="timeline-contact-link"/);
  assert.match(dashboard, /aria-label=\{`Open contact from \$\{item\.title\}`\}/);
  assert.match(styles, /\.company-timeline \.timeline-contact-link \{/);
  assert.match(styles, /\.company-timeline \.timeline-contact-link:focus-visible/);
});

test("preserves nested Contact and Company origins while operating an Opportunity", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /if \(!selected \|\| selectedOpportunityId\) return/);
  assert.match(dashboard, /\[selected, selectedCompanyId, selectedOpportunityId, closeContactWorkspace\]/);
  assert.match(dashboard, /\{selected && !selectedOpportunity && <div className="drawer-backdrop"/);
  assert.match(dashboard, /async function refreshSelectedContactDetail\(\)/);
  assert.ok((dashboard.match(/refreshSelectedContactDetail\(\)/g) || []).length >= 6);
  assert.match(dashboard, /load\(\), loadContacts\(\), refreshSelectedCompanyGraph\(\), refreshSelectedContactDetail\(\)/);
  assert.ok((dashboard.match(/aria-label=\{`Open \$\{item\.name\} opportunity workspace`\}/g) || []).length >= 2);
});

test("turns executive briefing attention lists into record-level actions", async () => {
  const [dashboard, styles] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /async function openContactById\(contactId: string, destination: WorkspaceView = "leads"\)/);
  assert.match(dashboard, /async function openBriefingTask\(task: Task\)/);
  assert.match(dashboard, /aria-label=\{`Open \$\{lead\.email\} contact record`\}/);
  assert.match(dashboard, /aria-label=\{`Open \$\{opportunity\.name\} opportunity workspace`\}/);
  assert.match(dashboard, /aria-label=\{`Open work for \$\{task\.title\}`\}/);
  assert.match(dashboard, /task\.opportunity_id[\s\S]*openOpportunityWorkspace\(opportunity\)/);
  assert.match(dashboard, /task\.contact_id[\s\S]*openContactById\(task\.contact_id\)/);
  assert.match(dashboard, /setActiveView\("tasks"\);[\s\S]*setTaskView\("list"\)/);
  assert.match(styles, /\.brief-row \{ width:100%; display:grid; grid-template-columns:32px minmax\(0,1fr\) auto/);
  assert.match(styles, /\.brief-row:focus-visible/);
});

test("opens proposal source records without abandoning the Agent Inbox decision context", async () => {
  const [dashboard, styles] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /async function openContactById\(contactId: string, destination: WorkspaceView = "leads"\)/);
  assert.match(dashboard, /async function openProposalRecord\(proposal: AgentProposal\)/);
  assert.match(dashboard, /proposal\.opportunity_id[\s\S]*openOpportunityWorkspace\(opportunity\)/);
  assert.match(dashboard, /proposal\.contact_id[\s\S]*openContactById\(proposal\.contact_id, "agent"\)/);
  assert.match(dashboard, /proposal\.category === "visitor_promotion"[\s\S]*setLeadView\("visitors"\)/);
  assert.match(dashboard, /className="proposal-record-link"/);
  assert.match(dashboard, /"OPEN VISITOR INTENT" : "OPEN SOURCE RECORD"/);
  assert.match(styles, /\.proposal-list button\.proposal-record-link/);
  assert.match(styles, /\.proposal-list button\.proposal-record-link:focus-visible/);
});

test("opens agent work source records from the execution queue", async () => {
  const [dashboard, styles] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /async function openAgentWorkRecord\(item: AgentWorkItem\)/);
  assert.match(dashboard, /item\.opportunity_id[\s\S]*openOpportunityWorkspace\(opportunity\)/);
  assert.match(dashboard, /item\.contact_id[\s\S]*openContactById\(item\.contact_id, "automations"\)/);
  assert.match(dashboard, /className="agent-work-actions"/);
  assert.match(dashboard, />OPEN RECORD<\/button>/);
  assert.match(dashboard, /The agent work source record is no longer available\./);
  assert.match(dashboard, /async function cancelAgentWorkItem\(item: AgentWorkItem\)/);
  assert.match(dashboard, /agent-work-items\/\$\{item\.id\}\/cancel/);
  assert.match(dashboard, /agentWorkCancelArmed === item\.id \? "CONFIRM CANCEL" : "CANCEL QUEUED"/);
  assert.match(dashboard, /Queued agent work canceled before any runtime claimed it\./);
  assert.match(styles, /\.agent-work-queue \.agent-work-actions \{ display:flex/);
  assert.match(styles, /\.agent-work-actions button:focus-visible/);
  assert.match(styles, /\.agent-work-queue>article>\.agent-work-actions\{grid-column:1\/-1;display:grid\}/);
});

test("exposes a public health check without exposing CRM data", async () => {
  const worker = await loadWorker();
  const favicon = await worker.fetch(new Request("http://localhost/favicon.ico"), env, ctx);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/x-icon");
  assert.equal((await favicon.arrayBuffer()).byteLength, 333);
  const response = await worker.fetch(new Request("http://localhost/v1/health"), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "openoperator-crm", version: 1 });

  const dashboard = await worker.fetch(new Request("http://localhost/v1/admin/dashboard", {
    headers: { "oai-authenticated-user-email": "spoofed@example.com" },
  }), { ASSETS: env.ASSETS }, ctx);
  assert.equal(dashboard.status, 503);

  const robots = await worker.fetch(new Request("http://localhost/robots.txt"), env, ctx);
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
  assert.match(robots.headers.get("x-robots-tag") || "", /noindex/);

  const sitemap = await worker.fetch(new Request("http://localhost/sitemap.xml"), env, ctx);
  assert.equal(sitemap.status, 404);
  assert.match(sitemap.headers.get("x-robots-tag") || "", /noindex/);
});

test("renders a bounded responsive CRM calendar inside Tasks", async () => {
  const [worker, dashboard, styles, schema, migration] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0037_calendar_range_indexes.sql", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /url\.pathname === "\/v1\/admin\/calendar"/);
  assert.match(worker, /maximumRangeMs = 93 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(worker, /limits: \{ per_kind: 200, total: 500 \}/);
  assert.match(worker, /record_content_trusted: false, read_only: true/);
  assert.match(dashboard, /aria-label="Task workspace view"/);
  assert.match(dashboard, /Every commitment\. One calendar\./);
  assert.match(dashboard, /calendarEventsByDay/);
  assert.match(dashboard, /No dated tasks, follow-ups, or open opportunity closes in this month/);
  assert.match(styles, /\.calendar-grid \{ display:grid; grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width:760px\) \{[\s\S]*\.calendar-grid \{ display:grid; grid-template-columns:1fr/);
  assert.match(styles, /\.calendar-grid>section:not\(:has\(\.calendar-event\)\):not\(\.today\) \{ display:none; \}/);
  assert.match(schema, /opportunities_workspace_close_idx/);
  assert.match(migration, /opportunities_workspace_close_idx/);
});

test("keeps visitor identity quarantined behind replay-safe vendor receivers", async () => {
  const [worker, agentMcp, ingress, dashboard, migration, accountMigration, caseMigration, intakeMigration, researchMigration, mailboxMigration, customObjectMigration, customObjectViewMigration, styles] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/agent-mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../ingest-worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0023_visitor_intent_ledger.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0025_visitor_intent_accounts.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0026_visitor_intent_cases.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0028_audience_intake_ledger.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0029_visitor_research_work_items.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0030_mailbox_connections.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0045_custom_objects.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0046_custom_object_views.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(ingress, /visitor-intent\\\/\(audiencelab\|rb2b\)/);
  assert.match(ingress, /audience-intake\\\/audiencelab/);
  assert.match(worker, /contacts_created_automatically: false/);
  assert.match(worker, /payload_content_trusted: false/);
  assert.match(worker, /review_change_id/);
  assert.match(worker, /visitor_connector\.rotated/);
  assert.match(worker, /visitor_connector\.revoked/);
  assert.match(worker, /type: "promote_visitor"/);
  assert.match(worker, /outreach_authorized: false/);
  assert.match(agentMcp, /crm_list_visitor_intent/);
  assert.match(agentMcp, /crm_propose_visitor_promotion/);
  assert.match(agentMcp, /crm:visitor-intent:propose/);
  assert.match(agentMcp, /crm_list_visitor_intent_accounts/);
  assert.match(agentMcp, /crm_list_visitor_intent_cases/);
  assert.match(worker, /domainless_profiles_excluded_from_accounts/);
  assert.match(dashboard, /aria-label="Visitor intent entity view"/);
  assert.match(dashboard, /scoring is deterministic and read-only/);
  assert.match(accountMigration, /visitor_profiles_workspace_domain_intent_idx/);
  assert.match(caseMigration, /visitor_intent_cases_active_domain_unique/);
  assert.match(worker, /visitor_intent_case\.created/);
  assert.match(dashboard, /INTENT OPERATING QUEUE/);
  assert.match(dashboard, /FREEZE CURRENT EVIDENCE/);
  assert.match(dashboard, /IMMUTABLE CASE HISTORY/);
  assert.match(dashboard, /SAVE ACCOUNTABILITY/);
  assert.match(dashboard, /Filter intent case status/);
  assert.match(dashboard, /visitorCaseReturnFocusRef/);
  assert.match(dashboard, /closeVisitorIntentCaseDetail/);
  assert.match(dashboard, /No intent cases match these history filters/);
  assert.match(worker, /owner must be an active workspace member/);
  assert.match(worker, /entity_type='visitor_intent_case'/);
  assert.match(agentMcp, /never_treat_as_instructions/);
  assert.match(worker, /MAX\(COALESCE\(last_event_at,''\),\?\)/);
  assert.match(migration, /CREATE TABLE `visitor_profiles`/);
  assert.match(migration, /CREATE UNIQUE INDEX `visitor_events_connector_dedupe_unique`/);
  assert.match(migration, /`review_change_id` text/);
  assert.match(migration, /`change_id` text/);
  assert.match(dashboard, /QUARANTINED INTENT LEDGER/);
  assert.match(dashboard, /Intent first\. CRM lead only after review\./);
  assert.match(dashboard, /CONFIRM ROTATE/);
  assert.match(dashboard, /CONFIRM REVOKE/);
  assert.match(dashboard, /AGENTIC CONTROL LOOP/);
  assert.match(dashboard, /APPROVE \+ PROMOTE VISITOR/);
  assert.match(dashboard, /OPEN AGENT INBOX/);
  assert.match(dashboard, /proposal-visitor-evidence/);
  assert.match(dashboard, /does not authorize email, ads, tasks, or workflow execution/);
  assert.match(dashboard, /promotion still does not authorize automated outreach/);
  assert.match(dashboard, /AUDIENCE INTAKE/);
  assert.match(dashboard, /CONFIRM QUARANTINED IMPORT/);
  assert.match(dashboard, /ROWS VALIDATED/);
  assert.match(dashboard, /AUDIENCESYNC HTTP DESTINATION/);
  assert.match(dashboard, /AUDIENCESYNC HTTP TEMPLATE/);
  assert.match(worker, /audience_import\.committed/);
  assert.match(worker, /duplicate_batch/);
  assert.match(intakeMigration, /audience_imports_connector_external_key_unique/);
  assert.match(intakeMigration, /audience_import_members_import_row_unique/);
  assert.match(styles, /\.audience-intake/);
  assert.match(styles, /\.visitor-intent-panel\s*\{[\s\S]*grid-template-columns:minmax\(0,1fr\);[\s\S]*min-width:0/);
  assert.match(dashboard, /RESEARCH ACCOUNT/);
  assert.match(dashboard, /FREEZE EVIDENCE FOR RESEARCH/);
  assert.match(worker, /visitor_research\.queued/);
  assert.match(agentMcp, /Visitor research results cannot propose CRM execution/);
  assert.match(researchMigration, /agent_work_items_active_visitor_research_unique/);
  assert.match(mailboxMigration, /mailbox_connections_composio_account_unique/);
  assert.match(mailboxMigration, /connect_expires_at/);
  assert.match(customObjectMigration, /CREATE TABLE custom_object_definitions/);
  assert.match(customObjectMigration, /CREATE TABLE custom_object_relations/);
  assert.match(customObjectViewMigration, /CREATE TABLE custom_object_views/);
  assert.match(customObjectViewMigration, /CHECK\(visibility IN \('private','workspace'\)\)/);
  assert.match(dashboard, /Model the business without changing the codebase/);
  assert.match(dashboard, /EVOLVE SCHEMA SAFELY/);
  assert.match(dashboard, /Agent execution remains disabled/);
  assert.match(dashboard, /ARCHIVE OBJECT/);
  assert.match(dashboard, /SAVE CHANGES/);
  assert.match(dashboard, /Search name, email, or domain/);
  assert.match(dashboard, /FINDING…/);
  assert.doesNotMatch(dashboard, /Target record ID/);
  assert.match(dashboard, /target_label \|\| "Removed target"/);
  assert.match(dashboard, /WORKING VIEWS/);
  assert.match(dashboard, /Every filter is combined with AND/);
  assert.match(dashboard, /VISIBLE COLUMNS/);
  assert.match(dashboard, /ADD FILTER/);
  assert.match(styles, /\.custom-object-view-builder/);
  assert.match(dashboard, /CUSTOM OBJECT ACCESS/);
  assert.match(dashboard, /Grant one business object at a time/);
  assert.match(dashboard, /selectedCustomObject\.authority\.create/);
  assert.match(dashboard, /selectedCustomObject\.authority\.relations/);
  assert.match(worker, /memberCustomObjectGrantContract/);
  assert.match(worker, /readableCustomObjectFieldKeys/);
  assert.match(worker, /custom_object_relations: "admin_only"/);
  assert.match(styles, /\.custom-object-access-list/);
  assert.match(dashboard, /See the inbox context\. Keep every action human-gated\./);
  assert.match(dashboard, /RECHECK PROVIDER/);
  assert.match(dashboard, /CONFIRM PROVIDER REVOKE/);
  assert.match(dashboard, /REMOVE FAILED SETUP/);
  assert.match(dashboard, /connection\.status === "active" && connection\.last_synced_at/);
  assert.match(dashboard, /Provider authority revoked/);
  assert.match(dashboard, /CRM use disabled; provider authority retained/);
  assert.match(dashboard, /connection\.connected_account_id && connection\.status !== "revoked"/);
  assert.match(dashboard, /No provider account or token was created/);
  assert.match(dashboard, /MAILBOX CONTROL UNAVAILABLE/);
  assert.match(dashboard, /Loading private mailbox controls/);
  assert.match(dashboard, /mailboxes && !mailboxesError && !mailboxes\.connections\.length/);
  assert.match(dashboard, /Every system\. One governed boundary\./);
  assert.match(dashboard, /WORKSPACE CONTROLS FIRST/);
  assert.match(dashboard, /BROWSE CONNECTORS/);
  assert.match(dashboard, /aria-expanded=\{integrationCatalogOpen\}/);
  assert.match(dashboard, /hidden=\{!integrationCatalogOpen\}/);
  assert.match(dashboard, /setIntegrationCatalogOpen\(false\)/);
  assert.match(dashboard, /aria-label="Integration categories" role="tablist"/);
  assert.match(dashboard, /id="integration-tab-mailboxes" role="tab"/);
  assert.match(dashboard, /\{canAdmin && <button type="button" id="integration-tab-agents"/);
  assert.match(dashboard, /moveIntegrationDomain\(event, "webhooks"\)/);
  assert.match(dashboard, /visibleIntegrationDomain = !canAdmin && integrationDomain === "agents"/);
  assert.match(dashboard, /hidden=\{visibleIntegrationDomain !== "mailboxes"\}/);
  assert.match(dashboard, /hidden=\{visibleIntegrationDomain !== "agents"\}/);
  assert.match(dashboard, /hidden=\{visibleIntegrationDomain !== "sources"\}/);
  assert.match(dashboard, /hidden=\{visibleIntegrationDomain !== "webhooks"\}/);
  assert.match(dashboard, /INBOUND IDENTITY \+ LEAD FLOW/);
  assert.match(dashboard, /SIGNED EVENT TRANSPORT/);
  assert.match(dashboard, /Load up to 10 recent conversation previews on demand/);
  assert.match(dashboard, /VIEW RECENT CONVERSATIONS/);
  assert.match(dashboard, /Bodies, attachments, drafts, sending, and deletion are outside this view/);
  assert.match(dashboard, /\{canAdmin && <button className="agent-run"/);
  assert.match(dashboard, /Only an owner or admin can start analysis or decide proposals/);
  assert.match(dashboard, /READ-ONLY INTELLIGENCE/);
  assert.match(dashboard, /An owner or admin can generate new human-gated actions/);
  assert.match(dashboard, /proposal\.status === "pending" && !canAdmin/);
  assert.match(dashboard, /proposalDecisionArmed\?\.id !== proposalId \|\| proposalDecisionArmed\.decision !== decision/);
  assert.match(dashboard, /setProposalDecisionArmed\(\{ id: proposalId, decision \}\);\s+return;/);
  assert.match(dashboard, /CONFIRM EXECUTION/);
  assert.match(dashboard, /CONFIRM REJECTION/);
  assert.equal([...dashboard.matchAll(/CONFIRM EXECUTION/g)].length, 2);
  assert.equal([...dashboard.matchAll(/CONFIRM REJECTION/g)].length, 2);
  assert.equal([...dashboard.matchAll(/className="proposal-confirmation"/g)].length, 2);
  assert.match(dashboard, /setProposalDecisionArmed\(null\)/);
  assert.match(dashboard, /\[activeView, selectedOpportunityId, opportunityDrawerTab\]/);
  assert.match(dashboard, /result\.blocking_operation === "workspace_restore"/);
  assert.match(dashboard, /A workspace restore is running\. Revenue analysis is paused/);
  assert.match(dashboard, /result\.code === "workspace_operation_in_progress"/);
  assert.match(dashboard, /This validated restore remains staged/);
  assert.match(dashboard, /result\.code === "restore_conflict"/);
  assert.match(styles, /Glass chrome v13: governed Integrations control center/);
  assert.match(styles, /\.mailbox-command-copy h2 \{ color:#fff/);
  assert.match(dashboard, /await loadMailboxes\(\);\s*setError\(result\.error/);
  assert.match(dashboard, /REMOVE FAILED SETUP/);
  assert.match(worker, /provider_auth_rejected/);
  assert.match(worker, /provider_unreachable/);
  assert.match(worker, /mailbox_connection\.failed_setup_removed/);
  assert.match(styles, /\.integration-status-strip/);
  assert.match(styles, /\.integration-catalog-disclosure/);
  assert.match(styles, /\.integration-status-strip button\.active/);
  assert.match(styles, /\.integration-domain/);
  assert.match(styles, /Glass chrome v12: quarantined website-visitor intent workspace/);
  assert.match(dashboard, /Visitor intent entity view/);
  assert.match(dashboard, /NO MATCHING CRM ACCOUNT/);
  assert.match(dashboard, /OPEN CRM ACCOUNT/);
  assert.match(styles, /visitor-account-card/);
  assert.match(styles, /\.visitor-connector-actions/);
  assert.match(styles, /\.visitor-agent-loop/);
  assert.match(styles, /\.proposal-visitor-evidence/);
  assert.match(styles, /\.proposal-confirmation/);
});

test("keeps modular ingestion source-scoped and contact data centralized", async () => {
  const [worker, schema, migration, dashboard, agentMcp, permissionMigration, savedViewMigration, operationLeaseMigration, styles] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_premium_texas_twister.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/agent-mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0018_member_contact_permissions.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0027_versioned_saved_views.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0032_workspace_operation_lease.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /authenticateSource/);
  assert.match(worker, /Invalid source credential/);
  assert.match(worker, /contacts\/upsert/);
  assert.match(worker, /INSERT OR IGNORE INTO activities/);
  assert.match(schema, /contacts_workspace_email_unique/);
  assert.match(schema, /workspaceMembers/);
  assert.match(schema, /sources_key_hash_unique/);
  assert.match(schema, /workspaceOperationLeases/);
  assert.match(worker, /acquireWorkspaceOperationLease/);
  assert.match(worker, /"revenue_analysis" \| "workspace_restore"/);
  assert.match(operationLeaseMigration, /CREATE TABLE `workspace_operation_leases`/);
  assert.match(operationLeaseMigration, /CHECK \(`operation` IN \('revenue_analysis','workspace_restore'\)\)/);
  assert.match(operationLeaseMigration, /SELECT `workspace_id`,'revenue_analysis',`run_id`/);
  assert.match(migration, /CREATE TABLE `contacts`/);
  assert.match(migration, /CREATE TABLE `sources`/);
  assert.match(dashboard, /MCP endpoint: https:\/\/ingest\.example\.com\/mcp/);
  assert.doesNotMatch(dashboard, /MCP endpoint: https:\/\/crm\.openoperator\.ai\/mcp/);
  assert.match(dashboard, /ROTATE KEY/);
  assert.match(dashboard, /current key will stop working immediately/);
  assert.match(dashboard, /CONFIRM ROTATE \+ INVALIDATE OLD KEY/);
  assert.doesNotMatch(dashboard, /window\.confirm\(\s*`Rotate \$\{credential\.name\}/);
  assert.match(dashboard, /CONFIRM REVOKE \+ STOP INGESTION/);
  assert.match(dashboard, /CONFIRM PURGE UNUSED CONFIG/);
  assert.match(dashboard, /Source key revoked\. Connected submissions now fail authentication\./);
  assert.match(dashboard, /savedViewDeleteArmed === view\.id \? "CONFIRM"/);
  assert.match(dashboard, /expected_revision=\$\{view\.revision\}/);
  assert.match(dashboard, /Private · only me/);
  assert.match(dashboard, /Workspace · all members/);
  assert.match(dashboard, /VISIBLE FIELDS/);
  assert.match(worker, /Only workspace admins can publish shared views/);
  assert.match(worker, /This saved view changed in another session/);
  assert.match(savedViewMigration, /`visibility` text NOT NULL DEFAULT 'private'/);
  assert.match(savedViewMigration, /`revision` integer NOT NULL DEFAULT 1/);
  assert.match(styles, /\.view-definition-form/);
  assert.match(dashboard, /refreshContactTotals/);
  assert.match(dashboard, /view=inbox/);
  assert.doesNotMatch(dashboard, /window\.confirm/);
  assert.match(worker, /agent_credential\.rotated/);
  assert.match(worker, /code: "rotation_conflict"/);
  assert.match(dashboard, /Rejected — nothing executed\./);
  assert.match(dashboard, /APPROVE \+ UPDATE OPPORTUNITY/);
  assert.match(dashboard, /CONFIRM DISABLE ALL/);
  assert.match(dashboard, /ACCESS PRESET/);
  assert.match(dashboard, /Executive assistant/);
  assert.match(dashboard, /Read-only analyst/);
  assert.match(dashboard, /Contact researcher/);
  assert.match(dashboard, /Pipeline analyst/);
  assert.match(dashboard, /crm:summary:read/);
  assert.match(worker, /legacy_scope_not_allowed/);
  assert.match(agentMcp, /crm:contacts:read/);
  assert.match(agentMcp, /crm:opportunities:read/);
  assert.match(dashboard, /Approval is paused while workspace agent access is disabled/);
  assert.match(dashboard, /proposal\.expires_at/);
  assert.match(dashboard, /Status: \{proposal\.status\}/);
  assert.match(worker, /code: "agent_access_disabled"/);
  assert.match(worker, /code: "proposal_expired"/);
  assert.match(worker, /url\.pathname === "\/v1\/admin\/access-policy"/);
  assert.match(worker, /requireWorkspaceGrant\(env, access, "contact", "update_field", fieldName\)/);
  assert.match(worker, /requireWorkspaceGrant\(env, access, "contact", "update_custom_field", fieldName\)/);
  assert.match(worker, /memberContactGrantContract/);
  assert.match(worker, /readableContactCustomFieldKeys/);
  assert.match(worker, /redactContactCustomFields/);
  assert.match(worker, /current_change_id/);
  assert.match(worker, /policyAuditId/);
  assert.match(worker, /committed\.current_change_id !== changeId/);
  assert.match(permissionMigration, /CREATE TABLE `workspace_access_policies`/);
  assert.match(permissionMigration, /CREATE UNIQUE INDEX `workspace_role_grants_unique`/);
  assert.doesNotMatch(permissionMigration, /UNION ALL/);
  assert.match(dashboard, /HUMAN ACCESS GOVERNANCE/);
  assert.match(dashboard, /Deny-by-default CRM collaboration/);
  assert.match(dashboard, /OPPORTUNITY ACCESS/);
  assert.match(dashboard, /Read pipeline/);
  assert.match(dashboard, /member_opportunity_grants/);
  assert.match(dashboard, /NO OUTBOUND PROOF/);
  assert.match(dashboard, /Provider authorization expired; recheck status, reconnect securely, or revoke access/);
  assert.match(dashboard, /RECONNECT \$\{connection\.provider === "gmail" \? "GMAIL" : "MICROSOFT 365"\}/);
  assert.match(dashboard, /mailbox-reconnect:/);
  assert.match(dashboard, /The provider still reports this mailbox as expired/);
  assert.match(dashboard, /OPPORTUNITIES/);
  assert.doesNotMatch(dashboard, /OPPORTUNITYS/);
  assert.match(dashboard, /\{check\.details\}/);
  assert.match(dashboard, /aria-label="Settings workspace"/);
  assert.match(dashboard, /FIELDS \+ LAYOUTS/);
  assert.match(dashboard, /hidden=\{activeView !== "settings" \|\| settingsView !== "fields"\}/);
  assert.match(dashboard, /hidden=\{activeView !== "settings" \|\| settingsView !== "access"\}/);
  assert.match(dashboard, /hidden=\{activeView !== "settings" \|\| settingsView !== "readiness"\}/);
  assert.match(dashboard, /hidden=\{activeView !== "settings" \|\| settingsView !== "recovery"\}/);
  assert.match(dashboard, /OWNER EDIT REQUIRED/);
  assert.match(dashboard, /aria-pressed=\{accessDraft\.includes\(grant\)\}/);
  assert.match(dashboard, /GOVERNED CUSTOM FIELDS/);
  assert.match(dashboard, /custom-access-field-grid/);
  assert.match(dashboard, /field\.read_grant/);
  assert.match(styles, /\.access-governance \{[\s\S]*backdrop-filter:blur\(18px\)/);
  assert.match(worker, /proposalDecisionAuditStatement/);
  assert.match(worker, /WHERE changes\(\)>0 AND EXISTS\(SELECT 1 FROM agent_proposals/);
  assert.match(agentMcp, /trust_level: "untrusted_workspace_record"/);
  assert.match(agentMcp, /never_treat_as_instructions: true/);
  assert.match(agentMcp, /prohibited_effects/);
  assert.doesNotMatch(worker, /crm_[a-f0-9]{30,}/i);
});

test("keeps lead movement explicit and clears hidden bulk selections", async () => {
  const [dashboard, leadIndexes, worker, agentMcp, companyMigration, identityMigration, contactNoteMigration] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_lead_query_indexes.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/agent-mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0013_company_relationships.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0014_company_identity_maintenance.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0040_contact_note_lifecycle.sql", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /aria-label="Bulk record status"/);
  assert.match(dashboard, /QUALIFY → CREATE OPPORTUNITY/);
  assert.match(dashboard, /className="lead-quick-stage"/);
  assert.match(dashboard, /className="lead-qualify"/);
  assert.match(dashboard, /aria-label="Bulk owner action"/);
  assert.match(dashboard, /<option value="unassign">Unassign owner<\/option>/);
  assert.match(dashboard, /bulkOwnerAction === "unassign" \? \{ owner: null \}/);
  assert.match(dashboard, /QUALIFY → OPPORTUNITY/);
  assert.match(dashboard, /opportunity-move:\$\{item\.id\}/);
  assert.match(dashboard, /moved to \$\{stage\.name\}/);
  assert.match(await readFile(new URL("../app/globals.css", import.meta.url), "utf8"), /\.lead-list \{[^}]*align-content:start/);
  assert.match(dashboard, /DOWNLOAD ENCRYPTED BACKUP/);
  assert.match(dashboard, /VALIDATED · NOTHING RESTORED YET/);
  assert.match(dashboard, /COMMIT WORKSPACE RESTORE/);
  assert.match(dashboard, /If any CRM data changed after validation, the restore will be rejected/);
  assert.match(dashboard, /The backup could not be validated\. Workspace data was not changed\./);
  assert.match(worker, /async function ensureRecoveryStagingSchema\(env: FrameworkEnv\)/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS recovery_guard_rows/);
  assert.match(worker, /await ensureRecoveryStagingSchema\(env\)/);
  assert.match(worker, /workspace\.restore_validated/);
  assert.match(worker, /Restore failed and was rolled back/);
  assert.doesNotMatch(agentMcp, /recovery\/backup|recovery\/restore|workspace\.restored/);
  assert.match(dashboard, /className="lead-open"/);
  assert.match(dashboard, /setQuery\(e\.target\.value\); setContactPage\(1\); setSelectedIds\(\[\]\)/);
  assert.match(dashboard, /setLeadView\(view\); setContactPage\(1\); setContactRows\(\[\]\); setSelectedIds\(\[\]\)/);
  assert.match(dashboard, /The latest record has been loaded; review it before saving again\./);
  assert.match(dashboard, /setActiveView\(view\.id\); setError\(""\); setNotice\(""\)/);
  assert.match(dashboard, /setNotice\("Opportunity created\."\)/);
  assert.match(dashboard, /aria-label="Lead inbox pages"/);
  assert.match(dashboard, /aria-label="All contact pages"/);
  assert.match(dashboard, /contactPagination\.total === 1 \? "RECORD" : "RECORDS"/);
  assert.match(dashboard, /aria-label="Filter contact owner"/);
  assert.match(dashboard, /aria-label="Filter contact source"/);
  assert.match(dashboard, /aria-expanded=\{advancedFiltersOpen\}/);
  assert.match(dashboard, /MORE FILTERS/);
  assert.match(dashboard, /FEWER FILTERS/);
  assert.match(dashboard, /setAdvancedFiltersOpen\(Boolean\(filters\.owner/);
  assert.match(dashboard, /aria-label="Outbound webhook health"/);
  assert.match(dashboard, /PROCESS \$\{webhookDueCount\} DUE NOW/);
  assert.match(dashboard, /Automatic retry is scheduled\. No delivery is due right now\./);
  assert.match(dashboard, /delivery\.response_excerpt\.slice\(0, 180\)/);
  assert.match(dashboard, /className=\{`delivery-\$\{delivery\.status\}`\}/);
  assert.match(dashboard, /CHANGE DESTINATION/);
  assert.match(dashboard, /SAVE DESTINATION/);
  assert.match(dashboard, /expected_updated_at: webhook\.updated_at/);
  assert.match(dashboard, /webhook changed in another session/i);
  assert.match(dashboard, /CONFIRM DELETE \+ HISTORY/);
  assert.match(dashboard, /Webhook and delivery history deleted\./);
  assert.doesNotMatch(dashboard, /window\.confirm\("Delete this webhook credential/);
  assert.match(dashboard, /REVIEW BEFORE APPLYING/);
  assert.match(dashboard, /SAVE OWNER/);
  assert.match(dashboard, /IN PIPELINE/);
  assert.match(dashboard, /detail\.opportunities\.length === 0/);
  assert.match(dashboard, /aria-label="Contact record sections"/);
  assert.match(dashboard, /role="tab" aria-selected=\{drawerTab === tab\.id\}/);
  assert.match(dashboard, /tabIndex=\{drawerTab === tab\.id \? 0 : -1\}/);
  assert.match(dashboard, /if \(event\.key === "ArrowRight"\)/);
  assert.match(dashboard, /Chronological contact timeline/);
  assert.match(dashboard, /aria-label="Edit contact note"/);
  assert.match(dashboard, /updateContactNote/);
  assert.match(dashboard, /deleteContactNote/);
  assert.match(dashboard, /if_updated_at: contactNote\.updated_at \|\| contactNote\.created_at/);
  assert.match(dashboard, /\.sort\(\(left, right\) => Date\.parse\(right\.occurred_at\) - Date\.parse\(left\.occurred_at\)\)/);
  assert.match(dashboard, /detail\?\.opportunities\.map/);
  assert.match(dashboard, /detail\?\.tasks\.map/);
  assert.match(dashboard, /className="record-feedback error" role="alert"/);
  const recordStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const searchMigration = await readFile(new URL("../drizzle/0017_workspace_search_fts.sql", import.meta.url), "utf8");
  assert.match(recordStyles, /Glass chrome v3: relationship-rich contact record/);
  assert.match(recordStyles, /\.drawer-backdrop \{\s*z-index:60;/);
  assert.match(recordStyles, /\.contact-drawer \{[\s\S]*width:min\(720px,100%\)/);
  assert.match(recordStyles, /\.record-facts \{[\s\S]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(dashboard, /id="active-pipeline"/);
  assert.match(dashboard, /contact lifecycle stays separate/);
  assert.match(dashboard, /const contactId = selectedOpportunityContactId/);
  assert.match(dashboard, /value=\{selectedOpportunityContactId\}/);
  assert.doesNotMatch(dashboard, /opportunityContactId \|\| data\?\.contacts\[0\]\?\.id/);
  assert.match(dashboard, /Choose the contact this revenue record belongs to\./);
  assert.match(dashboard, /pendingTerminalMove/);
  assert.match(dashboard, /CONFIRM MOVE/);
  assert.match(dashboard, /This changes forecast status immediately/);
  assert.match(dashboard, /pendingTerminalMove\?\.opportunityId === item\.id && selectedOpportunityId !== item\.id/);
  assert.match(dashboard, /aria-label=\{`Open \$\{item\.name\} workspace`\}/);
  assert.match(dashboard, /aria-label="Opportunity workspace sections"/);
  assert.match(dashboard, /tabIndex=\{opportunityDrawerTab === tab\.id \? 0 : -1\}/);
  assert.match(dashboard, /moveOpportunityDrawerTab/);
  assert.match(dashboard, /selectedOpportunityTasks = selectedOpportunity/);
  assert.match(dashboard, /selectedOpportunityWork = selectedOpportunity/);
  assert.match(dashboard, /selectedOpportunityProposals = selectedOpportunity/);
  assert.match(dashboard, /selectedOpportunityAudits = selectedOpportunity/);
  assert.match(dashboard, /ADD TO EXECUTION QUEUE/);
  assert.match(dashboard, /if \(!selectedOpportunityId\) \{ setTaskContactId\(""\); setTaskOpportunityId\(""\); \}/);
  assert.match(dashboard, /HUMAN-GATED PROPOSALS/);
  assert.match(dashboard, /EXPLAINABLE DEAL HEALTH/);
  assert.match(dashboard, /COMMUNICATION JOURNEY/);
  assert.match(dashboard, /GENERATE HUMAN-GATED NEXT ACTIONS/);
  assert.match(dashboard, /UNTRUSTED SOURCE CONTENT/);
  assert.match(worker, /sales\.call_analyzed/);
  assert.match(worker, /mutations_require_human_approval: true/);
  assert.match(worker, /category: dataQuality \? "data_quality" : callRisk \? "communication_risk"/);
  assert.match(worker, /score >= 90 \? "strong"/);
  assert.match(worker, /url\.pathname === "\/v1\/admin\/search"/);
  assert.match(worker, /limits: \{ per_group: 6, total: 18 \}/);
  assert.match(worker, /record_content_trusted: false, read_only: true, workspace_scoped: true/);
  assert.match(worker, /strategy: "fts5_prefix"/);
  assert.match(worker, /freshness: "transactional_triggers"/);
  assert.match(worker, /query\.normalize\("NFKC"\)/);
  assert.match(worker, /crm_search_index MATCH \?/);
  assert.match(worker, /bm25\(crm_search_index,0,0,0,8,4,1\)/);
  assert.doesNotMatch(worker, /FROM contacts c[\s\S]{0,500}LIKE \? ESCAPE '\\\\'[\s\S]{0,500}LIMIT 6/);
  assert.match(searchMigration, /CREATE VIRTUAL TABLE `crm_search_index` USING fts5/);
  assert.match(searchMigration, /tokenize='unicode61 remove_diacritics 2'/);
  assert.match(searchMigration, /AFTER UPDATE OF `email`,`first_name`,`last_name`,`company`,`company_id`,`owner`,`stage`,`status`/);
  assert.match(searchMigration, /CREATE TRIGGER `crm_search_companies_update`/);
  assert.match(searchMigration, /CREATE TRIGGER `crm_search_pipeline_stages_update`/);
  assert.match(dashboard, /className="command-trigger"/);
  assert.match(dashboard, /UNIVERSAL COMMAND/);
  assert.match(dashboard, /role="combobox"/);
  assert.match(dashboard, /aria-activedescendant=/);
  assert.match(dashboard, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(dashboard, /event\.key === "ArrowDown"/);
  assert.match(dashboard, /MAX 18 RECORDS/);
  assert.match(dashboard, /commandTriggerRef\.current\?\.focus/);
  assert.match(dashboard, /closeCommandCenter\(entry\.kind === "navigation"\)/);
  assert.match(dashboard, /if \(restoreTriggerFocus\) window\.requestAnimationFrame/);
  assert.match(dashboard, /commandCenterRef\.current\.querySelectorAll/);
  assert.match(dashboard, /document\.body\.style\.overflow = "hidden"/);
  assert.match(recordStyles, /\.command-center \{/);
  assert.equal((recordStyles.match(/^\.command-center \{/gm) || []).length, 1);
  assert.equal((recordStyles.match(/^\.command-backdrop \{/gm) || []).length, 1);
  assert.match(recordStyles, /backdrop-filter:blur\(15px\)/);
  assert.match(recordStyles, /\.command-center \{ max-height:calc\(100vh - 36px\)/);
  assert.match(dashboard, /IMMUTABLE AUDIT TRACE/);
  assert.match(dashboard, /Forecast status and probability change immediately/);
  assert.match(dashboard, /type="date" value=\{opportunityDraft\.expectedClose\} onInput=/);
  assert.match(recordStyles, /Glass chrome v4: opportunity command workspace/);
  assert.match(recordStyles, /\.opportunity-workspace \{ width:min\(760px,100%\); \}/);
  assert.match(recordStyles, /\.execution-brief \{[\s\S]*linear-gradient\(145deg,#252830,#15171c\)/);
  assert.match(recordStyles, /\.deal-health \{[\s\S]*radial-gradient/);
  assert.match(dashboard, /aria-label=\{`Open \$\{company\.name\} account workspace`\}/);
  assert.match(dashboard, /aria-label="Company workspace sections"/);
  assert.match(dashboard, /tabIndex=\{companyDrawerTab === tab\.id \? 0 : -1\}/);
  assert.match(dashboard, /Chronological company timeline/);
  assert.match(dashboard, /SAVE ACCOUNT CONTEXT/);
  assert.match(dashboard, /SAVE ACCOUNT NOTE/);
  assert.match(dashboard, /SCAN DUPLICATES/);
  assert.match(dashboard, /explainable, deterministic signals/);
  assert.match(dashboard, /reviewCompanyMerge/);
  assert.match(dashboard, /source_counts\.opportunities/);
  assert.match(dashboard, /REVIEW MERGE/);
  assert.match(dashboard, /CONFIRM REVIEWED MERGE/);
  assert.match(dashboard, /Edit company note/);
  assert.match(dashboard, /CONFIRM DELETE/);
  assert.match(recordStyles, /Glass chrome v5: first-class company relationship workspace/);
  assert.match(recordStyles, /\.company-workspace \{ width:min\(780px,100%\); \}/);
  assert.match(companyMigration, /CREATE TABLE `companies`/);
  assert.match(companyMigration, /ALTER TABLE `contacts` ADD COLUMN `company_id`/);
  assert.match(companyMigration, /CREATE TABLE `company_notes`/);
  assert.match(identityMigration, /CREATE TABLE `company_redirects`/);
  assert.match(identityMigration, /ALTER TABLE `company_notes` ADD COLUMN `updated_at`/);
  assert.match(contactNoteMigration, /ALTER TABLE `notes` ADD COLUMN `updated_at`/);
  assert.match(worker, /Only the note author or a workspace admin can change this note/);
  assert.match(worker, /contact\.note_updated/);
  assert.match(worker, /contact\.note_deleted/);
  assert.match(worker, /companyIdentity/);
  assert.match(worker, /company-duplicate-score:v2/);
  assert.match(worker, /company-merge-review:v1/);
  assert.match(worker, /merge_review_stale/);
  assert.match(worker, /company\.note_created/);
  assert.match(worker, /company\.merge_received/);
  assert.match(worker, /company\.note_updated/);
  assert.match(worker, /company\.note_deleted/);
  assert.match(agentMcp, /crm_list_companies/);
  assert.match(agentMcp, /crm_get_company/);
  assert.match(agentMcp, /crm_list_my_proposals/);
  assert.match(agentMcp, /p\.credential_id=\?/);
  assert.match(agentMcp, /agent-record-cursor:v1/);
  assert.match(agentMcp, /best_effort_keyset/);
  assert.match(agentMcp, /SCHEDULER_SECRET/);
  assert.match(agentMcp, /redirected_from/);
  assert.match(agentMcp, /"crm:companies:read"/);
  assert.match(dashboard, /BOUNDED AGENT DISCOVERY/);
  assert.match(dashboard, /opportunities, workflows, and workflow runs return at most 50 records per call/);
  assert.match(dashboard, /Cursors are signed, workspace- and credential-bound/);
  assert.match(dashboard, /REVOKED \+ EXPIRED HISTORY/);
  assert.match(dashboard, /showAgentCredentialHistory/);
  assert.match(dashboard, /effectiveCredentialStatus/);
  assert.match(dashboard, /No AI agent currently has usable CRM access/);
  assert.match(dashboard, /ORIGIN · \{proposalOrigin\(proposal\)\}/);
  assert.match(worker, /origin_credential_name/);
  assert.match(dashboard, /opportunityIntelligenceAbortRef/);
  assert.match(dashboard, /controller\.signal/);
  assert.match(worker, /lifecycle_status/);
  assert.match(dashboard, /Task added to the execution queue\./);
  assert.match(dashboard, /setMutating\("lead"\); setError\(""\); setNotice\(""\)/);
  assert.match(dashboard, /setNotice\("Lead created\."\)/);
  assert.match(dashboard, /\{!error && notice && <div className="notice-banner" role="status">/);
  assert.match(dashboard, /\{!error && notice && <div className="record-feedback notice" role="status">/);
  assert.match(dashboard, /onStatus\("cancelled"\)/);
  assert.match(dashboard, /onStatus\("open"\)/);
  assert.match(dashboard, /task\.opportunity_name/);
  assert.match(dashboard, /availableContacts\.map\(\(contact\)/);
  assert.match(worker, /const effectiveContactId = contactId \|\| taskOpportunity\?\.contact_id \|\| null/);
  assert.match(worker, /assignee must be a valid email/);
  assert.match(dashboard, /versions: Object\.fromEntries\(contactRows/);
  assert.match(worker, /NOT EXISTS\(SELECT 1 FROM opportunities o WHERE o\.workspace_id=c\.workspace_id AND o\.contact_id=c\.id\)/);
  assert.match(worker, /opportunityUpdateAuditStatement/);
  assert.match(leadIndexes, /contacts_workspace_status_stage_idx/);
  assert.match(leadIndexes, /contacts_workspace_owner_idx/);
  assert.match(leadIndexes, /contacts_workspace_follow_up_idx/);
});

test("keeps pipeline drag movement guarded and accessibly recoverable", async () => {
  const [dashboard, styles, packageJson, catalog] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../contracts/productCatalog.ts", import.meta.url), "utf8"),
  ]);
  assert.match(packageJson, /@dnd-kit\/core/);
  assert.match(dashboard, /<DndContext sensors=\{pipelineSensors\}/);
  assert.match(dashboard, /useDroppable\(\{/);
  assert.match(dashboard, /useDraggable\(\{/);
  assert.match(dashboard, /activationConstraint: \{ distance: 7 \}/);
  assert.match(dashboard, /Drag cards between stages/i);
  assert.match(dashboard, /Use left and right arrow keys to move stages/);
  assert.match(dashboard, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/);
  assert.match(dashboard, /setControl\(\(current\) => current \? \{/);
  assert.match(dashboard, /Its previous stage has been restored/);
  assert.match(dashboard, /if_updated_at: opportunity\.updated_at/);
  assert.match(dashboard, /pendingTerminalMove/);
  assert.match(dashboard, /<select aria-label=\{`Move \$\{item\.name\}`\}/);
  assert.match(styles, /\.kanban-column\.drop-target/);
  assert.match(styles, /\.opportunity-card\.dragging/);
  assert.match(styles, /\.opportunity-drag-handle:focus-visible/);
  assert.match(styles, /@media \(max-width:760px\)[\s\S]*\.opportunity-drag-handle \{ display:none/);
  assert.match(catalog, /cardDrag: true/);
  assert.match(catalog, /keyboardDrag: true/);
  assert.match(catalog, /optimisticConcurrency: "updated_at"/);
});

test("uses restrained, reduced-motion-safe gradient emphasis on the homepage", async () => {
  const [dashboard, component, componentCss] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GradientText.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GradientText.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /activeView === "dashboard"[\s\S]*<GradientText/);
  assert.match(dashboard, /pauseOnHover>Dashboard<\/GradientText>/);
  assert.match(component, /Math\.max\(animationSpeed, 0\.5\)/);
  assert.match(component, /"--gradient-colors"/);
  assert.match(component, /pauseOnHover \? "pause-on-hover"/);
  assert.match(componentCss, /background-clip: text/);
  assert.match(componentCss, /@keyframes gradient-text-shift/);
  assert.match(componentCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("renders integrations from the shared catalog with truthful lifecycle states", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(dashboard, /integrationCatalogView/);
  assert.match(dashboard, /installedIntegrationIds/);
  assert.match(dashboard, /mailboxAttentionStatuses/);
  assert.match(dashboard, /attentionIntegrationIds/);
  assert.match(dashboard, /ATTENTION REQUIRED/);
  assert.match(dashboard, /Existing connection requires owner attention/);
  assert.match(dashboard, /catalogIntegrations\.map/);
  assert.match(dashboard, /Roadmap only — no executable handlers/);
  assert.match(dashboard, /RUNTIME SETUP REQUIRED/);
  assert.match(dashboard, /openIntegrationSetup\(integration\.id, event\.currentTarget\)/);
  assert.match(dashboard, /selectedIntegrationId/);
  assert.match(dashboard, /integration-setup-title/);
  assert.match(dashboard, /GOVERNED AUTHORITY/);
  assert.match(dashboard, /ROADMAP ONLY/);
  assert.match(dashboard, /continueIntegrationSetup/);
  assert.match(dashboard, /id === "audiencelab" \|\| id === "rb2b"/);
  assert.match(dashboard, /setLeadView\("visitors"\)/);
  assert.match(dashboard, /document\.getElementById\("visitor-provider"\)/);
  assert.match(dashboard, /id === "audiencelab" \|\| id === "rb2b" \? "VISITOR INTENT"/);
  assert.match(dashboard, /integrationDestinationFor/);
  assert.match(dashboard, /focusIntegrationDestination/);
  assert.match(dashboard, /window\.setTimeout\(\(\) =>/);
  assert.match(dashboard, /data-mailbox-provider/);
  assert.match(dashboard, /data-agent-provider/);
  assert.match(dashboard, /id="skool-connector" tabIndex=\{-1\}/);
  assert.match(dashboard, /data-webhook-direction/);
  assert.match(dashboard, /id="webhook-direction"/);
  assert.match(dashboard, /webhookDirection === "outbound"/);
  assert.doesNotMatch(dashboard, /DESTINATION URL \(BLANK = INBOUND\)/);
  assert.match(dashboard, /Resend delivery control/);
  assert.match(dashboard, /SENDING-ONLY API KEY/);
  assert.match(dashboard, /SEND VERIFICATION TO ME/);
  assert.match(dashboard, /CONFIRM SEND TRANSACTIONAL EMAIL/);
  assert.match(dashboard, /DISCONNECT LOCAL AUTHORITY/);
  assert.match(styles, /\.integration-catalog-grid/);
  assert.match(styles, /\.integration-catalog-card\.integration-installed/);
  assert.match(styles, /\.integration-catalog-card\.integration-attention/);
  assert.match(styles, /\.integration-setup-drawer/);
  assert.match(styles, /\.integration-catalog-card\.integration-planned/);
  assert.match(styles, /\.resend-grid/);
  assert.match(styles, /\.resend-history/);
});

test("exposes governed contact metadata in settings and record editing", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0033_contact_field_definitions.sql", import.meta.url), "utf8");
  assert.match(dashboard, /Core object field manager/);
  assert.match(dashboard, /CREATE \{customFieldObject\.toUpperCase\(\)\} FIELD/);
  assert.match(dashboard, /CUSTOM RECORD DATA/);
  assert.match(dashboard, /saveContactCustomFields/);
  assert.match(worker, /url\.pathname === "\/v1\/admin\/custom-fields"/);
  assert.match(worker, /Unknown or inactive custom field/);
  assert.match(worker, /custom_field\.archived/);
  assert.match(migration, /CREATE TABLE custom_field_definitions/);
  assert.match(migration, /UNIQUE\(workspace_id, object_type, field_key\)/);
  assert.match(styles, /\.custom-field-layout/);
  assert.match(styles, /\.record-custom-field-grid/);
  assert.match(styles, /\.settings-view-switcher \{/);
  assert.match(styles, /@media \(max-width: 560px\) \{[\s\S]*\.settings-view-switcher \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("extends governed fields across contacts, accounts, and opportunities", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../worker/agent-mcp.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0034_core_object_field_metadata.sql", import.meta.url), "utf8");
  assert.match(dashboard, /Core object field manager/);
  assert.match(dashboard, /CUSTOM ACCOUNT DATA/);
  assert.match(dashboard, /CUSTOM OPPORTUNITY DATA/);
  assert.match(dashboard, /object_type === "company"/);
  assert.match(worker, /mergeCustomFieldValues\(env, workspaceId, "company"/);
  assert.match(worker, /mergeCustomFieldValues\(env, workspaceId, "opportunity"/);
  assert.match(agent, /crm_describe_company_fields/);
  assert.match(agent, /crm_describe_opportunity_fields/);
  assert.match(migration, /ALTER TABLE companies ADD COLUMN custom_fields/);
  assert.match(migration, /ALTER TABLE opportunities ADD COLUMN custom_fields/);
});

test("renders versioned metadata-driven page layouts for every core record editor", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0035_object_page_layouts.sql", import.meta.url), "utf8");
  assert.match(dashboard, /RECORD PAGE LAYOUT/);
  assert.match(dashboard, /LayoutCustomFieldEditor/);
  assert.match(dashboard, /savePageLayout/);
  assert.match(dashboard, /expected_revision: layout\.revision/);
  assert.match(worker, /effectivePageLayout/);
  assert.match(worker, /Layout must place every active custom field exactly once/);
  assert.match(worker, /workspace\.page_layout_updated/);
  assert.match(migration, /CREATE TABLE object_page_layouts/);
  assert.match(migration, /UNIQUE\(workspace_id, object_type\)/);
  assert.match(styles, /\.page-layout-manager/);
  assert.match(styles, /\.record-layout-section/);
});

test("uses governed contact fields as typed filters and permission-aware list columns", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(dashboard, /function CustomFilterEditor/);
  assert.match(dashboard, /function CustomColumnPicker/);
  assert.match(dashboard, /custom_filters/);
  assert.match(dashboard, /custom:\$\{field\.field_key\}/);
  assert.match(dashboard, /Complete or remove every custom-field filter/);
  assert.match(worker, /function validateContactCustomFilters/);
  assert.match(worker, /Custom filter references an unavailable field/);
  assert.match(worker, /CASE WHEN json_valid\(c\.custom_fields\)/);
  assert.match(worker, /effectiveSavedView/);
  assert.match(styles, /\.custom-filter-editor/);
  assert.match(styles, /\.custom-column-picker/);
});

test("maps CSV columns before governed contact and audience imports", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(dashboard, /function CsvMappingEditor/);
  assert.match(dashboard, /Each destination field can only be mapped once/);
  assert.match(dashboard, /GOVERNED CONTACT IMPORT/);
  assert.match(dashboard, /Typed custom fields are checked by the server/);
  assert.match(dashboard, /Map at least one identity field/);
  assert.match(worker, /async function normalizeImportRows/);
  assert.match(worker, /Row \$\{rowNumber\}: \$\{error\.message\}/);
  assert.match(worker, /references unknown or inactive custom field/);
  assert.match(worker, /ON CONFLICT\(workspace_id,email\) DO NOTHING/);
});

test("keeps visual workflows bounded, accessible, and wired to validated drafts", async () => {
  const [dashboard, builder, worker, packageJson, css, runOperationsMigration, agentMcp, accessMigration, workflowPrincipalMigration, unsignedWorkflowMigration, workflowTraversalMigration] = await Promise.all([
    readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/VisualAutomationBuilder.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0012_automation_run_operations.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/agent-mcp.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0018_member_contact_permissions.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0020_workflow_principals.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0021_pause_unsigned_workflows.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0022_agent_workflow_traversal_indexes.sql", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /<VisualAutomationBuilder/);
  assert.match(dashboard, /automationBuilderOpen \? "builder-active" : ""/);
  assert.match(dashboard, /automationBuilderOpen \? "Workflow builder\." : "Rules and run state\."/);
  assert.match(dashboard, /!automationBuilderOpen && <div className="automation-list">/);
  assert.match(dashboard, /stages=\{\(control\?\.stages/);
  assert.match(dashboard, /if_updated_at: automationEditing\.updated_at/);
  assert.match(dashboard, /setAutomationBuilderOpen\(false\); setAutomationName\(""\)/);
  assert.match(dashboard, /operator: condition\.operator \|\| "equals"/);
  assert.match(dashboard, /priority: action\.priority \|\| "normal"/);
  assert.match(dashboard, /due_in_minutes: action\.due_in_minutes \?\? 0/);
  assert.match(dashboard, /CONFIRM DELETE \+ HISTORY/);
  assert.doesNotMatch(dashboard, /window\.confirm\("Delete this inactive automation/);
  assert.match(builder, /aria-label="Draggable workflow canvas"/);
  assert.match(builder, /UNSAVED WORK/);
  assert.match(builder, /builderDirtyRef\.current = true/);
  assert.match(builder, /if \(!builderDirtyRef\.current\)/);
  assert.match(builder, /DISCARD \+ CLOSE/);
  assert.match(builder, /REPLACE WORKFLOW/);
  assert.match(builder, /HANDOFF WILL QUEUE/);
  assert.match(builder, /RUNTIME OBSERVED/);
  assert.match(builder, /CREDENTIAL READY · RUNTIME UNVERIFIED/);
  assert.match(builder, /PICKUP PAUSED/);
  assert.match(builder, /availableAgentProviders/);
  assert.match(builder, /observedAgentProviders/);
  assert.match(builder, /WORKFLOW PRINCIPAL/);
  assert.match(builder, /Least privilege, derived from this graph/);
  assert.match(dashboard, /debug-authority/);
  assert.match(dashboard, /automationDebugRun\.principal_id/);
  assert.match(dashboard, /AGENTIC CONTROL LOOP/);
  assert.match(dashboard, /APPROVE \+ RUN WORKFLOW/);
  assert.match(dashboard, /crm:automations:read/);
  assert.match(agentMcp, /name: "crm_list_workflows"/);
  assert.match(agentMcp, /name: "crm_list_workflow_runs"/);
  assert.match(agentMcp, /rejectUnknownArgs\(args, \["status", "manual_only", "limit", "cursor"\]\)/);
  assert.match(agentMcp, /rejectUnknownArgs\(args, \["workflow_id", "status", "limit", "cursor"\]\)/);
  assert.match(agentMcp, /"started_at_desc,id_desc"/);
  assert.match(agentMcp, /name: "crm_propose_workflow_run"/);
  assert.match(agentMcp, /This never launches directly and always requires current human approval/);
  assert.match(worker, /workflow-authority:v1:/);
  assert.match(worker, /assertWorkflowAuthority/);
  assert.match(worker, /principalId = `automation:\$\{String\(rule\.id\)\}`/);
  assert.match(worker, /action\.type === "run_workflow"/);
  assert.match(worker, /execution_in_progress/);
  assert.match(worker, /execution_interrupted/);
  assert.match(workflowPrincipalMigration, /ALTER TABLE `automation_rules` ADD COLUMN `authority_manifest`/);
  assert.match(workflowPrincipalMigration, /ALTER TABLE `automation_runs` ADD COLUMN `principal_id`/);
  assert.match(unsignedWorkflowMigration, /SET `status`='paused'/);
  assert.match(unsignedWorkflowMigration, /`authority_hash` IS NULL/);
  assert.match(unsignedWorkflowMigration, /length\(`authority_hash`\) != 64/);
  assert.match(workflowTraversalMigration, /automation_rules_workspace_cursor_idx/);
  assert.match(workflowTraversalMigration, /automation_runs_workspace_cursor_idx/);
  assert.match(workflowPrincipalMigration, /automation_runs_workspace_principal_idx/);
  assert.match(dashboard, /Date\.parse\(credential\.expires_at\) <= taskClock \? "expired"/);
  assert.match(dashboard, /effectiveCredentialStatus\(credential\) === "active"/);
  assert.match(dashboard, /automationAgentReadiness/);
  assert.match(dashboard, /lazy\(\(\) => import\("\.\/VisualAutomationBuilder"\)\)/);
  assert.match(dashboard, /<Suspense fallback=\{<div className="builder-loading" role="status">Loading workflow builder/);
  assert.match(css, /\.builder-loading \{/);
  assert.match(dashboard, /Connect \$\{missing\.join\(" \+ "\)\} before activation/);
  assert.match(dashboard, /Agent pickup paused by workspace policy/);
  assert.match(dashboard, /Agent credential active · runtime has never checked in/);
  assert.match(dashboard, /Agent runtime previously observed/);
  assert.match(builder, /aria-pressed=\{data\.selected\}/);
  assert.match(builder, /Choose a stage/);
  assert.match(builder, /definition\.conditions\.every/);
  assert.match(builder, /@xyflow\/react/);
  assert.match(builder, /ReactFlowProvider/);
  assert.match(builder, /animated: true/);
  assert.match(builder, /<MiniMap pannable zoomable/);
  assert.match(builder, /snapToGrid/);
  assert.match(builder, /onNodeDragStop=\{handleNodeDragStop\}/);
  assert.match(builder, /reorder\("else-action-"/);
  assert.match(builder, /preservePositions = prior\.length === cards\.length/);
  assert.match(builder, /useReactFlow/);
  assert.match(builder, /topologySignature/);
  assert.match(builder, /prefers-reduced-motion: reduce/);
  assert.match(builder, /workflow-step-badge/);
  assert.match(builder, /Opportunity is created/);
  assert.match(builder, /triggerLabels\[definition\.trigger_type\]/);
  assert.match(worker, /"opportunity\.created", "opportunity\.stage_changed"/);
  assert.match(builder, /INSERT RECORD DATA/);
  assert.match(builder, /Insert record data into \$\{props\.label\}/);
  assert.match(builder, /\{\{opportunity\.name\}\}/);
  assert.match(builder, /Unknown fields fail closed/);
  assert.match(builder, /EARLIER STEPS/);
  assert.match(builder, /Stable workflow step identity/);
  assert.match(builder, /Output schema v1/);
  assert.match(builder, /unsafe reorderings block save/i);
  assert.match(worker, /automationOpportunityVariables/);
  assert.match(worker, /resolveAutomationTemplate/);
  assert.match(css, /workflow-variable-picker:focus-within/);
  assert.match(dashboard, /RETRY FAILED RUN/);
  assert.match(dashboard, /automationRetryByParent/);
  assert.match(dashboard, /Retried as \{retryChild\.id\}/);
  assert.match(dashboard, /run\.status === "failed" && !retryChild/);
  assert.match(dashboard, /CANCEL STALE RUN/);
  assert.match(dashboard, /Execution lease active/);
  assert.match(dashboard, /operateAutomationRun/);
  assert.match(dashboard, /aria-label="Automation run health"/);
  assert.match(dashboard, /aria-label="Filter automation runs"/);
  assert.match(dashboard, /No runs match this status/);
  assert.match(dashboard, /parseAutomationTrace/);
  assert.match(dashboard, /Stored run output is empty or unreadable/);
  assert.match(dashboard, /trace-\$\{step\.status\}/);
  assert.match(dashboard, /STEP \{step\.stepId\}/);
  assert.match(css, /\.automation-debugger li\.trace-warning/);
  assert.match(css, /\.automation-debugger li code/);
  assert.match(worker, /a\.name automation_name/);
  assert.match(worker, /run_already_retried/);
  assert.match(worker, /run_still_active/);
  assert.match(worker, /automationRunCancelAuditStatement/);
  assert.match(runOperationsMigration, /automation_runs_retry_once_unique/);
  assert.match(agentMcp, /crm_renew_work_item/);
  assert.match(agentMcp, /crm_fail_work_item/);
  assert.match(agentMcp, /agent\.work_item_renewed/);
  assert.match(agentMcp, /agent\.work_item_failed/);
  assert.match(worker, /agent\.work_item_requeued/);
  assert.match(dashboard, /aria-label="Agent work health"/);
  assert.match(dashboard, /The runtime stopped renewing this lease/);
  assert.match(dashboard, /Runtime marked this retryable/);
  assert.match(dashboard, /requeueAgentWorkItem/);
  assert.match(css, /\.agent-work-queue>article\.failed/);
  assert.match(runOperationsMigration, /automation_runs_workspace_status_idx/);
  assert.match(css, /run-actions button:hover/);
  assert.match(css, /run-health-failed/);
  assert.match(css, /run-health label\{width:100%/);
  assert.match(css, /@keyframes workflow-node-in/);
  assert.match(css, /workflow-discard-review/);
  assert.match(css, /workflow-runtime-readiness/);
  assert.match(css, /workflow-preflight span:hover/);
  assert.match(css, /\.automation-panel\.builder-active \.run-health/);
  assert.match(css, /@keyframes workflow-enter/);
  assert.match(css, /workflow-preflight strong\{grid-column:1\/-1\}/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(builder, /High-value copilot/);
  assert.match(builder, /Lead progression/);
  assert.match(builder, /New lead registration review/);
  assert.match(builder, /type: "update_contact", field: "stage", value: "registered", approval_required: true/);
  assert.match(builder, /HUMAN GATE REQUIRED/);
  assert.match(builder, /aria-label="Workflow preflight"/);
  assert.match(builder, /MATCH ACTIONS/);
  assert.match(builder, /ELSE ACTIONS/);
  assert.match(builder, /HUMAN GATES/);
  assert.match(builder, /AGENT HANDOFFS/);
  assert.match(builder, /ACTIVATION PREFLIGHT PASSED/);
  assert.match(builder, /ADD A WORKFLOW NAME/);
  assert.match(builder, /AGENT PICKUP IS PAUSED/);
  assert.match(dashboard, /APPROVE \+ UPDATE LEAD/);
  assert.match(dashboard, /Go anywhere\. Find anything\./);
  assert.match(dashboard, /aria-activedescendant/);
  assert.match(dashboard, /trapCommandFocus/);
  assert.match(dashboard, /record_content_trusted: false/);
  assert.match(css, /\.command-center/);
  assert.match(css, /backdrop-filter:blur\(15px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(worker, /action\.type === "update_contact"/);
  assert.match(builder, /VALID · READY TO SAVE/);
  assert.match(builder, /label: index \? undefined : "ELSE"/);
  assert.match(packageJson, /@xyflow\/react/);
  assert.match(worker, /validateAutomationStageReferences/);
  assert.match(worker, /automationMutationAuditStatement/);
  assert.match(worker, /if_updated_at is required/);
  assert.match(worker, /url\.pathname === "\/v1\/admin\/access-policy"/);
  assert.match(worker, /permission_denied/);
  assert.match(worker, /requireWorkspaceGrant\(env, access, "contact", "update_field", fieldName\)/);
  assert.match(accessMigration, /workspace_access_policy_versions/);
  assert.match(accessMigration, /workspace_role_grants_lookup/);
  assert.match(dashboard, /HUMAN ACCESS GOVERNANCE/);
  assert.match(dashboard, /CONFIRM MEMBER AUTHORITY/);
  assert.match(dashboard, /accessPolicyReviewOpen/);
  assert.match(css, /\.access-governance \{[\s\S]*backdrop-filter:blur\(18px\)/);
  assert.match(css, /\.access-policy-review/);
});

test("reuses governed typed fields across automation conditions, actions, and merge variables", async () => {
  const builder = await readFile(new URL("../app/VisualAutomationBuilder.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(builder, /`custom:\$\{field\.field_key\}`/);
  assert.match(builder, /This governed field is unavailable/);
  assert.match(builder, /GOVERNED FIELDS/);
  assert.match(builder, /`\{\{\$\{props\.recordType\}\.custom\.\$\{field\.field_key\}\}\}`/);
  assert.match(builder, /HUMAN GATE REQUIRED/);
  assert.match(dashboard, /customFields=\{customFields\}/);
  assert.match(dashboard, /PAUSE \+ REPAIR/);
  assert.match(dashboard, /automation-metadata-gap/);
  assert.match(worker, /function validateAutomationCustomMetadata/);
  assert.match(worker, /function automationDefinitionHealth/);
  assert.match(worker, /custom_field\.read:\$\{reference\[1\]\}:\$\{reference\[2\]\}/);
  assert.match(worker, /code: "workflow_metadata_drift"/);
  assert.match(worker, /proposal_metadata_drift/);
  assert.match(worker, /validateAutomationCustomMetadata\(customDefinitions\.results/);
  assert.match(worker, /changes: customKey \? \{ custom_fields:/);
});

test("renders a governed contact-import history with conflict-aware rollback", async () => {
  const dashboard = await readFile(new URL("../app/CrmDashboard.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0038_contact_import_rollback.sql", import.meta.url), "utf8");
  assert.match(dashboard, /RECENT IMPORTS/);
  assert.match(dashboard, /Undo only what is still untouched/);
  assert.match(dashboard, /Changed or related contacts will stay in the CRM/);
  assert.match(dashboard, /CONFIRM SAFE ROLLBACK/);
  assert.match(dashboard, /expected_created_at: batch\.created_at/);
  assert.match(worker, /url\.pathname === "\/v1\/admin\/contact-imports"/);
  assert.match(worker, /contactImportRollbackMatch/);
  assert.match(worker, /Type the exact import ID to confirm rollback/);
  assert.match(worker, /status='committed' AND created_at=\? RETURNING id/);
  assert.match(migration, /CREATE TRIGGER `contact_import_rollback`/);
  assert.match(migration, /c\.updated_at <> contact_import_members\.imported_updated_at/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM opportunities/);
  assert.match(migration, /'contacts\.import_rolled_back'/);
  assert.match(css, /\.contact-import-history article/);
  assert.match(css, /\.contact-import-rollback/);
  assert.match(css, /grid-template-columns:1fr/);
  assert.match(css, /\.lead-view-switcher \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.contacts-panel > \.section-head \{ align-items:stretch; flex-direction:column/);
});
