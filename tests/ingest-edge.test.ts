import { describe, expect, it, vi } from "vitest";
import { createIngestionHandler, createWebhookRetryScheduler } from "../ingest-worker/index";

const validKey = `crm_${"a".repeat(64)}`;
const validAgentKey = `crai_${"b".repeat(64)}`;
function exactRateGate(limitOverride?: number) {
  const counts = new Map<string, number>();
  const toolCaches = new Map<string, unknown[]>();
  return {
    getByName(name: string) {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const url = new URL(String(input));
          if (url.pathname === "/mcp-tools") {
            if ((init?.method || "GET") === "PUT") {
              const payload = JSON.parse(String(init?.body || "{}")) as { tools?: unknown[] };
              if (!Array.isArray(payload.tools)) return new Response(null, { status: 400 });
              toolCaches.set(name, payload.tools);
              return new Response(null, { status: 204 });
            }
            const tools = toolCaches.get(name);
            return tools ? Response.json({ tools }) : new Response(null, { status: 404 });
          }
          const limit = limitOverride ?? Number(url.searchParams.get("limit"));
          const count = (counts.get(name) || 0) + 1;
          counts.set(name, count);
          return Response.json({ success: count <= limit });
        },
      };
    },
  };
}
const env = {
  CRM_ORIGIN: "https://crm.example.test",
  SITES_BYPASS_TOKEN: "test-bypass",
  SCHEDULER_SECRET: "test-only-scheduler-secret-with-32-characters",
  INGEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
  INGEST_RATE_GATE: exactRateGate(),
};

describe("public ingestion edge", () => {
  it("exposes only health and the ingestion route", async () => {
    const handler = createIngestionHandler();
    expect((await handler(new Request("https://ingest.test/health"), env)).status).toBe(200);
    expect((await handler(new Request("https://ingest.test/v1/admin/dashboard"), env)).status).toBe(404);
    expect((await handler(new Request("https://ingest.test/v1/contacts/upsert"), env)).status).toBe(405);
  });

  it("rejects browser, malformed credential, content-type, and oversized requests", async () => {
    const handler = createIngestionHandler();
    expect((await handler(new Request("https://ingest.test/v1/contacts/upsert", {
      method: "POST", headers: { origin: "https://evil.test", authorization: `Bearer ${validKey}`, "content-type": "application/json" }, body: "{}",
    }), env)).status).toBe(403);
    expect((await handler(new Request("https://ingest.test/v1/contacts/upsert", {
      method: "POST", headers: { authorization: "Bearer bad", "content-type": "application/json" }, body: "{}",
    }), env)).status).toBe(401);
    expect((await handler(new Request("https://ingest.test/v1/contacts/upsert", {
      method: "POST", headers: { authorization: `Bearer ${validKey}`, "content-type": "text/plain" }, body: "{}",
    }), env)).status).toBe(415);
    expect((await handler(new Request("https://ingest.test/v1/contacts/upsert", {
      method: "POST", headers: { authorization: `Bearer ${validKey}`, "content-type": "application/json", "content-length": "70000" }, body: "{}",
    }), env)).status).toBe(413);
  });

  it("rate limits by a non-reversible credential digest", async () => {
    let observedKey = "";
    const handler = createIngestionHandler(async () => new Response("unexpected"));
    const response = await handler(new Request("https://ingest.test/v1/contacts/upsert", {
      method: "POST", headers: { authorization: `Bearer ${validKey}`, "content-type": "application/json" }, body: "{}",
    }), { ...env, INGEST_RATE_LIMITER: { limit: async ({ key }) => { observedKey = key; return { success: false }; } } });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-ratelimit-scope")).toBe("actor");
    expect(observedKey).not.toContain(validKey);
    expect(observedKey).toHaveLength(24);
  });

  it("enforces the persistent gate when the fast limiter admits a burst", async () => {
    const handler = createIngestionHandler(async () => Response.json({ error: "Unknown webhook" }, { status: 404 }));
    const hookId = `hook_${"9".repeat(32)}`;
    const burstEnv = { ...env, INGEST_RATE_GATE: exactRateGate(5) };
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => handler(new Request(
      `https://ingest.test/v1/hooks/${hookId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.25",
          "x-crm-event-id": `event_${index}`,
          "x-crm-signature": `t=1234567890,v1=${"c".repeat(64)}`,
        },
        body: "{}",
      },
    ), burstEnv)));
    expect(responses.filter((response) => response.status === 404)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
  });

  it("bounds credential rotation by client before private authentication", async () => {
    let upstreamCalls = 0;
    const handler = createIngestionHandler(async () => {
      upstreamCalls++;
      return Response.json({ error: "Invalid agent credential" }, { status: 401 });
    });
    const rotatingEnv = { ...env, INGEST_RATE_GATE: exactRateGate(5) };
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => handler(new Request(
      "https://ingest.test/mcp",
      {
        method: "POST",
        headers: {
          authorization: `Bearer crai_${index.toString(16).padStart(64, "0")}`,
          "cf-connecting-ip": "198.51.100.40",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/list", params: {} }),
      },
    ), rotatingEnv)));
    expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
    expect(responses.find((response) => response.status === 429)?.headers.get("x-ratelimit-scope")).toBe("client");
    expect(upstreamCalls).toBe(5);
  });

  it("fails closed with a bounded response when the exact limiter is unavailable", async () => {
    const handler = createIngestionHandler(async () => new Response("unexpected"));
    const unavailable = {
      ...env,
      INGEST_RATE_GATE: {
        getByName() {
          return { fetch: async () => { throw new Error("Durable Object unavailable"); } };
        },
      },
    };
    const response = await handler(new Request("https://ingest.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${validAgentKey}`,
        "cf-connecting-ip": "198.51.100.41",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), unavailable);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("x-ratelimit-scope")).toBe("client");
  });

  it("forwards the source credential separately from the private-site bypass", async () => {
    let forwarded: Request | undefined;
    const handler = createIngestionHandler(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ ok: true }, { status: 201, headers: { "x-request-id": "req_1" } });
    });
    const response = await handler(new Request("https://ingest.test/v1/contacts/upsert", {
      method: "POST", headers: { authorization: `Bearer ${validKey}`, "content-type": "application/json" },
      body: JSON.stringify({ contact: { email: "lead@example.com" } }),
    }), env);
    expect(response.status).toBe(201);
    expect(forwarded?.url).toBe("https://crm.example.test/v1/contacts/upsert");
    expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");
    expect(forwarded?.headers.get("x-crm-source-key")).toBe(`Bearer ${validKey}`);
    expect(forwarded?.headers.get("authorization")).toBeNull();
  });

  it("forwards signed inbound webhooks without exposing the private CRM", async () => {
    let forwarded: Request | undefined;
    const handler = createIngestionHandler(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ ok: true, duplicate: false }, { status: 201 });
    });
    const hookId = `hook_${"b".repeat(32)}`;
    const response = await handler(new Request(`https://ingest.test/v1/hooks/${hookId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-crm-event-id": "event_1",
        "x-crm-signature": `t=1234567890,v1=${"c".repeat(64)}`,
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ contact: { email: "hook@example.com" } }),
    }), env);
    expect(response.status).toBe(201);
    expect(forwarded?.url).toBe(`https://crm.example.test/v1/hooks/${hookId}`);
    expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");
    expect(forwarded?.headers.get("x-crm-event-id")).toBe("event_1");
    expect(forwarded?.headers.get("x-crm-signature")).toContain("v1=");
    expect(forwarded?.headers.get("x-crm-source-key")).toBeNull();
  });

  it("forwards source-authenticated Skool events to the private connector", async () => {
    let forwarded: Request | undefined;
    const handler = createIngestionHandler(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ ok: true, provider: "skool" }, { status: 201 });
    });
    const response = await handler(new Request("https://ingest.test/v1/integrations/skool/events", {
      method: "POST", headers: { authorization: `Bearer ${validKey}`, "content-type": "application/json" },
      body: JSON.stringify({ event_type: "paid_member", transaction_id: "txn_1", email: "member@example.com" }),
    }), env);
    expect(response.status).toBe(201);
    expect(forwarded?.url).toBe("https://crm.example.test/v1/integrations/skool/events");
    expect(forwarded?.headers.get("x-crm-source-key")).toBe(`Bearer ${validKey}`);
    expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");
  });

  it("forwards self-contained AudienceLab and RB2B visitor receivers without granting source authority", async () => {
    const token = `vti_${"a".repeat(64)}`;
    for (const provider of ["audiencelab", "rb2b"]) {
      let forwarded: Request | undefined;
      const handler = createIngestionHandler(async (input, init) => {
        forwarded = new Request(input, init);
        return Response.json({ ok: true, duplicate: false }, { status: 202 });
      });
      const response = await handler(new Request(
        `https://ingest.test/v1/integrations/visitor-intent/${provider}/${token}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: '{"event_id":"proof"}' },
      ), env);
      expect(response.status).toBe(202);
      expect(forwarded?.url).toBe(`https://crm.example.test/v1/integrations/visitor-intent/${provider}/${token}`);
      expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");
      expect(forwarded?.headers.get("x-forwarded-ingest-edge")).toBe("openoperator");
      expect(forwarded?.headers.get("x-crm-source-key")).toBeNull();
      expect(forwarded?.headers.get("authorization")).toBeNull();
    }
  });

  it("forwards AudienceSync batches without granting source or agent authority", async () => {
    const token = `vti_${"b".repeat(64)}`;
    let forwarded: Request | undefined;
    const handler = createIngestionHandler(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ ok: true, import: { requested_rows: 1 } }, { status: 201 });
    });
    const path = `/v1/integrations/audience-intake/audiencelab/${token}`;
    const response = await handler(new Request(`https://ingest.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.40" },
      body: JSON.stringify({
        external_key: "audiencesync:test:1", list_name: "Test", mode: "incremental",
        consent_basis: "unknown", record: { email: "test@example.com" },
      }),
    }), env);
    expect(response.status).toBe(201);
    expect(forwarded?.url).toBe(`https://crm.example.test${path}`);
    expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");
    expect(forwarded?.headers.get("x-forwarded-ingest-edge")).toBe("openoperator");
    expect(forwarded?.headers.get("x-crm-source-key")).toBeNull();
    expect(forwarded?.headers.get("authorization")).toBeNull();
  });

  it("forwards AudienceSync batches with connector-scoped rate identity and no user or source authority", async () => {
    const token = `vti_${"c".repeat(64)}`;
    let forwarded: Request | undefined;
    const handler = createIngestionHandler(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ ok: true, import: { requested_rows: 1 } }, { status: 201 });
    });
    const response = await handler(new Request(
      `https://ingest.test/v1/integrations/audience-intake/audiencelab/${token}`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          external_key: "cursor:1", list_name: "Proof", mode: "incremental",
          record: { email: "proof@example.com" },
        }),
      },
    ), env);
    expect(response.status).toBe(201);
    expect(forwarded?.url).toBe(
      `https://crm.example.test/v1/integrations/audience-intake/audiencelab/${token}`,
    );
    expect(forwarded?.headers.get("x-forwarded-ingest-edge")).toBe("openoperator");
    expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("x-crm-source-key")).toBeNull();

    expect((await handler(new Request(
      `https://ingest.test/v1/integrations/audience-intake/rb2b/${token}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ), env)).status).toBe(404);
    expect((await handler(new Request(
      `https://ingest.test/v1/integrations/audience-intake/audiencelab/${token}`,
      { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: "{}" },
    ), env)).status).toBe(403);
  });

  it("exposes a bounded credential-scoped MCP bridge without forwarding source authority", async () => {
    let forwarded: Request | undefined;
    const handler = createIngestionHandler(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    });
    const response = await handler(new Request("https://ingest.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${validAgentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), env);
    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe("https://crm.example.test/v1/mcp");
    expect(forwarded?.headers.get("authorization")).toBe(`Bearer ${validAgentKey}`);
    expect(forwarded?.headers.get("x-crm-source-key")).toBeNull();
    expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");

    const malformed = await handler(new Request("https://ingest.test/mcp", {
      method: "POST", headers: { authorization: "Bearer bad", "content-type": "application/json" }, body: "{}",
    }), env);
    expect(malformed.status).toBe(401);
    expect(malformed.headers.get("www-authenticate")).toContain("openoperator-mcp");
    const oversized = await handler(new Request("https://ingest.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${validAgentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(33_000) }),
    }), env);
    expect(oversized.status).toBe(413);
  });

  it("prewarms credential-scoped tool discovery for OpenClaw's bounded list timeout", async () => {
    const upstreamMethods: string[] = [];
    const handler = createIngestionHandler(async (_input, init) => {
      const rpc = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { id: unknown; method: string };
      upstreamMethods.push(rpc.method);
      if (rpc.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18" } });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { tools: [{ name: "crm_get_briefing", inputSchema: { type: "object" } }] },
      });
    });
    const qaEnv = { ...env, INGEST_RATE_GATE: exactRateGate() };
    const request = (id: number, method: string) => new Request("https://ingest.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${validAgentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
    });

    expect((await handler(request(1, "initialize"), qaEnv)).status).toBe(200);
    const listed = await handler(request(2, "tools/list"), qaEnv);
    expect(await listed.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "crm_get_briefing", inputSchema: { type: "object" } }] },
    });
    expect(upstreamMethods).toEqual(["initialize", "tools/list"]);
  });

  it("rejects browser-origin webhook requests", async () => {
    const handler = createIngestionHandler();
    const hookId = `hook_${"d".repeat(32)}`;
    const response = await handler(new Request(`https://ingest.test/v1/hooks/${hookId}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      body: "{}",
    }), env);
    expect(response.status).toBe(403);
  });

  it("signs scheduled retries for the private CRM without exposing the job publicly", async () => {
    const schedulerLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let forwarded: Request | undefined;
    const scheduler = createWebhookRetryScheduler(async (input, init) => {
      forwarded = new Request(input, init);
      return Response.json({ ok: true, due: 0, processed: 0 });
    });
    await scheduler(env);
    expect(forwarded?.url).toBe("https://crm.example.test/v1/internal/jobs/webhook-retries");
    expect(forwarded?.headers.get("oai-sites-authorization")).toBe("Bearer test-bypass");
    expect(forwarded?.headers.get("x-forwarded-ingest-edge")).toBe("openoperator");
    expect(forwarded?.headers.get("x-crm-scheduler-timestamp")).toMatch(/^\d{13}$/);
    expect(forwarded?.headers.get("x-crm-scheduler-nonce")).toMatch(/^[0-9a-f-]{36}$/);
    expect(forwarded?.headers.get("x-crm-scheduler-signature")).toMatch(/^[a-f0-9]{64}$/);
    const handler = createIngestionHandler();
    expect((await handler(new Request("https://ingest.test/v1/internal/jobs/webhook-retries", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), env)).status).toBe(404);
    expect(schedulerLog).toHaveBeenCalledWith(JSON.stringify({
      event: "webhook_retry_scheduler.completed", due: 0, processed: 0,
    }));
    schedulerLog.mockRestore();
  });

  it("surfaces private scheduler failures to waitUntil", async () => {
    const scheduler = createWebhookRetryScheduler(async () => new Response("unavailable", { status: 503 }));
    await expect(scheduler(env)).rejects.toThrow("status 503");
  });
});
