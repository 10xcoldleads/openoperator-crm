interface IngestEnv {
  CRM_ORIGIN: string;
  SITES_BYPASS_TOKEN: string;
  SCHEDULER_SECRET: string;
  INGEST_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  INGEST_RATE_GATE: {
    getByName(name: string): {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  };
}

type UpstreamFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MCP_BODY_BYTES = 32 * 1024;
const ACTOR_RATE_LIMIT = 120;
const CLIENT_RATE_LIMIT = 240;
const RATE_WINDOW_MS = 60_000;
const responseHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(data, { status, headers: { ...responseHeaders, ...headers } });
}

function sourceCredential(request: Request) {
  const value = request.headers.get("authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  return /^crm_[a-f0-9]{64}$/.test(token) ? token : "";
}

function agentCredential(request: Request) {
  const value = request.headers.get("authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  return /^crai_[a-f0-9]{64}$/.test(token) ? token : "";
}

async function digestRateKey(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function schedulerSignature(secret: string, timestamp: string, job: string, nonce: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${job}.${nonce}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class IngestRateGate {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp-tools") {
      if (request.method === "GET") {
        const cached = await this.state.storage.get<{ tools: unknown[]; expiresAt: number }>("mcp-tools");
        if (!cached || cached.expiresAt <= Date.now()) {
          if (cached) await this.state.storage.delete("mcp-tools");
          return new Response(null, { status: 404 });
        }
        return Response.json({ tools: cached.tools });
      }
      if (request.method === "PUT") {
        const payload = await request.json<{ tools?: unknown[] }>();
        if (!Array.isArray(payload.tools)) return new Response(null, { status: 400 });
        await this.state.storage.put("mcp-tools", {
          tools: payload.tools,
          // This cache only bridges initialize -> tools/list. Data-bearing tool
          // calls always re-authenticate against the private CRM.
          expiresAt: Date.now() + 15_000,
        });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    }
    if (url.pathname !== "/check") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const limit = Number(url.searchParams.get("limit"));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      return Response.json({ success: false }, { status: 400 });
    }
    const now = Date.now();
    const current = await this.state.storage.get<{ windowStart: number; count: number }>("window");
    const windowStart = current && now - current.windowStart < RATE_WINDOW_MS ? current.windowStart : now;
    const count = current && windowStart === current.windowStart ? current.count + 1 : 1;
    await this.state.storage.put("window", { windowStart, count });
    return Response.json({ success: count <= limit });
  }
}

async function exactRateCheck(env: IngestEnv, identity: string, limit: number) {
  const rateKey = await digestRateKey(identity);
  const gate = env.INGEST_RATE_GATE.getByName(rateKey);
  const response = await gate.fetch(`https://rate-gate.internal/check?limit=${limit}`, { method: "POST" });
  if (!response.ok) throw new Error(`Exact rate gate failed with status ${response.status}`);
  const result = await response.json<{ success?: boolean }>();
  if (typeof result.success !== "boolean") throw new Error("Exact rate gate returned an invalid response");
  return { gate, rateKey, success: result.success };
}

async function boundedBody(request: Request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createIngestionHandler(upstreamFetch: UpstreamFetch = fetch) {
  return async function handle(request: Request, env: IngestEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "openoperator-ingest-edge" });
    }
    const inboundWebhook = url.pathname.match(/^\/v1\/hooks\/(hook_[a-f0-9]{32})$/);
    const visitorIntent = url.pathname.match(/^\/v1\/integrations\/visitor-intent\/(audiencelab|rb2b)\/(vti_[a-f0-9]{64})$/);
    const audienceIntake = url.pathname.match(/^\/v1\/integrations\/audience-intake\/audiencelab\/(vti_[a-f0-9]{64})$/);
    const sourceIntegration = url.pathname === "/v1/contacts/upsert" || url.pathname === "/v1/integrations/skool/events";
    const agentMcp = url.pathname === "/mcp";
    if (!sourceIntegration && !inboundWebhook && !visitorIntent && !audienceIntake && !agentMcp) return json({ error: "Not found" }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    if (request.headers.has("origin")) {
      return json({ error: "Browser-origin requests are not accepted; use a server-side integration" }, 403);
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }
    const routeClass = agentMcp ? "mcp" : sourceIntegration ? "source" : visitorIntent ? "visitor" : audienceIntake ? "audience" : "hook";
    const clientAddress = request.headers.get("cf-connecting-ip") || "unknown";
    let clientLimit: Awaited<ReturnType<typeof exactRateCheck>>;
    try {
      clientLimit = await exactRateCheck(env, `client:${routeClass}:${clientAddress}`, CLIENT_RATE_LIMIT);
    } catch {
      return json({ error: "Rate limiter unavailable" }, 503, { "retry-after": "1", "x-ratelimit-scope": "client" });
    }
    if (!clientLimit.success) {
      return json({ error: "Rate limit exceeded" }, 429, { "retry-after": "60", "x-ratelimit-scope": "client" });
    }
    const credential = sourceIntegration ? sourceCredential(request) : "";
    const agentToken = agentMcp ? agentCredential(request) : "";
    if (sourceIntegration && !credential) return json({ error: "Invalid source credential" }, 401);
    if (agentMcp && !agentToken) {
      return json({ error: "Invalid agent credential" }, 401, { "www-authenticate": 'Bearer realm="openoperator-mcp"' });
    }
    const rateIdentity = sourceIntegration
      ? `source:${credential}`
      : agentMcp
        ? `agent:${agentToken}`
        : visitorIntent
          ? `visitor:${visitorIntent[2]}`
          : audienceIntake
            ? `audience:${audienceIntake[1]}`
          : `hook:${inboundWebhook?.[1]}:${request.headers.get("cf-connecting-ip") || "unknown"}`;
    let exactLimit: Awaited<ReturnType<typeof exactRateCheck>>;
    try {
      exactLimit = await exactRateCheck(env, rateIdentity, ACTOR_RATE_LIMIT);
    } catch {
      return json({ error: "Rate limiter unavailable" }, 503, { "retry-after": "1", "x-ratelimit-scope": "actor" });
    }
    const fastLimit = await env.INGEST_RATE_LIMITER.limit({ key: exactLimit.rateKey });
    const rateGate = exactLimit.gate;
    if (!fastLimit.success || !exactLimit.success) {
      return json({ error: "Rate limit exceeded" }, 429, { "retry-after": "60", "x-ratelimit-scope": "actor" });
    }
    const body = await boundedBody(request, agentMcp ? MAX_MCP_BODY_BYTES : MAX_BODY_BYTES);
    if (!body) return json({ error: "Request body is missing or too large" }, 413);
    let mcpRequest: { id?: unknown; method?: unknown } | null = null;
    if (agentMcp) {
      try {
        mcpRequest = JSON.parse(new TextDecoder().decode(body)) as { id?: unknown; method?: unknown };
      } catch {
        // The private MCP handler returns the canonical JSON-RPC parse error.
      }
      if (mcpRequest?.method === "tools/list") {
        const cached = await rateGate.fetch("https://rate-gate.internal/mcp-tools");
        if (cached.ok) {
          const payload = await cached.json<{ tools: unknown[] }>();
          return json({ jsonrpc: "2.0", id: mcpRequest.id ?? null, result: { tools: payload.tools } });
        }
      }
    }
    const origin = new URL(env.CRM_ORIGIN);
    origin.pathname = agentMcp ? "/v1/mcp" : url.pathname;
    origin.search = "";
    const upstreamHeaders = new Headers({
      "content-type": "application/json",
      "oai-sites-authorization": `Bearer ${env.SITES_BYPASS_TOKEN}`,
      "x-forwarded-ingest-edge": "openoperator",
    });
    if (sourceIntegration) {
      upstreamHeaders.set("x-crm-source-key", `Bearer ${credential}`);
    } else if (agentMcp) {
      upstreamHeaders.set("authorization", `Bearer ${agentToken}`);
    } else {
      for (const name of ["x-crm-event-id", "x-crm-signature"]) {
        const value = request.headers.get(name);
        if (value) upstreamHeaders.set(name, value);
      }
    }
    const upstream = await upstreamFetch(origin, {
      method: "POST",
      redirect: "manual",
      headers: upstreamHeaders,
      body,
    });
    if (agentMcp && mcpRequest?.method === "initialize" && upstream.ok) {
      const warmBody = new TextEncoder().encode(JSON.stringify({
        jsonrpc: "2.0",
        id: "edge-prewarm",
        method: "tools/list",
        params: {},
      }));
      const warmed = await upstreamFetch(origin, {
        method: "POST",
        redirect: "manual",
        headers: upstreamHeaders,
        body: warmBody,
      });
      if (warmed.ok) {
        const payload = await warmed.clone().json<{ result?: { tools?: unknown[] } }>().catch(() => null);
        if (Array.isArray(payload?.result?.tools)) {
          await rateGate.fetch("https://rate-gate.internal/mcp-tools", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tools: payload.result.tools }),
          });
        }
      }
    }
    const headers = new Headers(responseHeaders);
    headers.set("content-type", upstream.headers.get("content-type") || "application/json");
    const requestId = upstream.headers.get("x-request-id");
    if (requestId) headers.set("x-request-id", requestId);
    for (const name of ["allow", "retry-after", "www-authenticate"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  };
}

export function createWebhookRetryScheduler(upstreamFetch: UpstreamFetch = fetch) {
  return async function scheduled(env: IngestEnv): Promise<void> {
    const job = "webhook-retries";
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const signature = await schedulerSignature(env.SCHEDULER_SECRET, timestamp, job, nonce);
    const origin = new URL(env.CRM_ORIGIN);
    origin.pathname = "/v1/internal/jobs/webhook-retries";
    origin.search = "";
    const response = await upstreamFetch(origin, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "oai-sites-authorization": `Bearer ${env.SITES_BYPASS_TOKEN}`,
        "x-forwarded-ingest-edge": "openoperator",
        "x-crm-scheduler-timestamp": timestamp,
        "x-crm-scheduler-nonce": nonce,
        "x-crm-scheduler-signature": signature,
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`Webhook retry scheduler failed with status ${response.status}`);
    const result: { due?: number; processed?: number } = await response.clone()
      .json<{ due?: number; processed?: number }>()
      .catch(() => ({}));
    console.log(JSON.stringify({
      event: "webhook_retry_scheduler.completed",
      due: Number(result.due || 0),
      processed: Number(result.processed || 0),
    }));
  };
}

const handle = createIngestionHandler();
const runWebhookRetries = createWebhookRetryScheduler();

export default {
  fetch(request: Request, env: IngestEnv) {
    return handle(request, env);
  },
  scheduled(_controller: ScheduledController, env: IngestEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runWebhookRetries(env));
  },
} satisfies ExportedHandler<IngestEnv>;
