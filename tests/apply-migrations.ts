import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll } from "vitest";

declare global {
  // TypeScript's Cloudflare runtime uses a global namespace for injected bindings.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      ADMIN_EMAILS: string;
      WEBHOOK_ENCRYPTION_KEY: string;
      ALLOW_INSECURE_LOCAL_AUTH: string;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
