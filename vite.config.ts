import vinext from "vinext";
import { defineConfig } from "vite";

const LOCAL_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  name: "openoperator-crm",
  main: "./worker/index.ts",
  compatibility_date: "2026-07-25",
  compatibility_flags: ["nodejs_compat"],
  vars: {
    ADMIN_EMAILS: "owner@example.com",
    WEBHOOK_ENCRYPTION_KEY: "local-development-only-webhook-key",
    ALLOW_INSECURE_LOCAL_AUTH: "true",
  },
  observability: {
    enabled: true,
    logs: { head_sampling_rate: 1 },
    traces: { enabled: true, head_sampling_rate: 0.05 },
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "openoperator-crm-local",
      database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
      migrations_dir: "drizzle",
    },
  ],
};

const productionBindingConfig = {
  name: "openoperator-crm",
  main: "./worker/index.ts",
  compatibility_date: "2026-08-13",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [
    {
      binding: "DB",
      database_name: "openoperator-crm",
      database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
      migrations_dir: "drizzle",
    },
  ],
};

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: command === "serve" ? localBindingConfig : productionBindingConfig,
      }),
    ],
  };
});
