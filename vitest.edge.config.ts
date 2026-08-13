import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/ingest-edge.test.ts", "tests/automation-trace.test.ts"],
  },
});
