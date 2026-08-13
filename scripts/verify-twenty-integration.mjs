import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(projectRoot, "docs", "TWENTY_INTEGRATION_MANIFEST.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const referenceRoot = resolve(projectRoot, "..", "twenty-reference");

const git = (...args) => execFileSync("git", args, {
  cwd: referenceRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

const failures = [];
const head = git("rev-parse", "HEAD");
if (head !== manifest.upstream.commit) {
  failures.push(`Twenty reference HEAD ${head} does not match pinned ${manifest.upstream.commit}`);
}

for (const integration of manifest.integrations) {
  if (!integration.upstream.length || !integration.local_contracts.length || !integration.behavioral_tests.length) {
    failures.push(`${integration.id} is missing upstream, local, or behavioral evidence`);
    continue;
  }
  for (const upstream of integration.upstream) {
    const row = git("ls-tree", manifest.upstream.commit, "--", upstream.path);
    const match = row.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || match[1] !== upstream.blob_sha || match[2] !== upstream.path) {
      failures.push(`${integration.id}: upstream blob mismatch for ${upstream.path}`);
      continue;
    }
    const source = readFileSync(resolve(referenceRoot, upstream.path), "utf8");
    if (!source.includes(upstream.export)) {
      failures.push(`${integration.id}: export ${upstream.export} is absent from ${upstream.path}`);
    }
  }
  for (const evidence of [...integration.local_contracts, ...integration.behavioral_tests]) {
    const source = readFileSync(resolve(projectRoot, evidence.path), "utf8");
    if (!source.includes(evidence.contains)) {
      failures.push(`${integration.id}: local evidence '${evidence.contains}' is absent from ${evidence.path}`);
    }
  }
}

if (manifest.policy.runtime_dependency !== false || manifest.policy.copied_upstream_code !== false) {
  failures.push("Manifest must truthfully preserve the contract-adaptation/no-runtime-dependency boundary");
}
if (failures.length) {
  throw new Error(`Twenty integration verification failed:\n- ${failures.join("\n- ")}`);
}

console.log(`Twenty provenance verified at ${head}: ${manifest.integrations.length} contract adaptations, each with upstream blobs, local contracts, and behavioral tests.`);
