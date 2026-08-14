import { spawnSync } from "node:child_process";

const stressPattern = "\\[stress\\]";
const extendedPattern = "\\[extended\\]";
const marketingPattern = "\\[marketing\\]";
const reviewsPattern = "\\[reviews\\]";
const estimatesPattern = "\\[estimates\\]";
const authDomainPattern = "\\[auth-domain\\]";
const authContractPattern = "\\[auth-contract\\]";
const isolatedPattern = `(${stressPattern}|${extendedPattern}|${marketingPattern}|${reviewsPattern}|${estimatesPattern}|${authDomainPattern}|${authContractPattern})`;
const domainPattern = "(automation|workflow|contact|opportunity|pipeline|task|recovery|webhook)";
const platformBoundaryPatterns = [
  "authorization and transport security",
  "OpenClaw and Hermes MCP boundary",
];
const platformBoundaryPattern = `(${platformBoundaryPatterns.join("|")})`;
const shards = [
  ["stress", stressPattern],
  ["extended", extendedPattern],
  ["marketing", marketingPattern],
  ["reviews", reviewsPattern],
  ["estimates", estimatesPattern],
  ["auth-domain", `^(?!.*${marketingPattern})(?!.*${reviewsPattern})(?!.*${estimatesPattern}).*${authDomainPattern}.*$`],
  ["auth-contract", authContractPattern],
  ["core-domain", `^(?!.*${isolatedPattern}).*${domainPattern}.*$`],
  ...platformBoundaryPatterns.map((pattern) => [
    `core-${pattern.replaceAll(" ", "-")}`,
    `^(?!.*${isolatedPattern})(?!.*${domainPattern}).*${pattern}.*$`,
  ]),
  [
    "core-platform-data",
    `^(?!.*${isolatedPattern})(?!.*${domainPattern})(?!.*${platformBoundaryPattern}).*$`,
  ],
];

for (const [name, pattern] of shards) {
  process.stdout.write(`\nWorker test shard: ${name}\n`);
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts", "-t", pattern],
    { cwd: process.cwd(), stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
