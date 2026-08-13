import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "drizzle")),
          ADMIN_EMAILS: "owner@example.com",
          WEBHOOK_ENCRYPTION_KEY: "test-only-webhook-encryption-key",
          RECOVERY_ENCRYPTION_KEY: "test-only-recovery-encryption-key-with-32-characters",
          SCHEDULER_SECRET: "test-only-scheduler-secret-with-32-characters",
          ALLOW_INSECURE_LOCAL_AUTH: "true",
          COMPOSIO_API_KEY: "test-only-composio-api-key",
          COMPOSIO_GMAIL_AUTH_CONFIG_ID: "ac_test_gmail",
          COMPOSIO_OUTLOOK_AUTH_CONFIG_ID: "ac_test_outlook",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./tests/apply-migrations.ts"],
    include: ["tests/**/*.worker.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 60_000,
  },
});
