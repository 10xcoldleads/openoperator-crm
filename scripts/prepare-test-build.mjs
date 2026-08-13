import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.resolve(root, "dist");
const target = path.resolve(root, ".test-dist");

if (path.dirname(target) !== root || path.basename(target) !== ".test-dist") {
  throw new Error("Refusing to prepare a test build outside .test-dist");
}
if (!(await stat(path.join(source, "server", "index.js"))).isFile()) {
  throw new Error("Build dist/server/index.js before preparing the test snapshot");
}

// Never remove the live snapshot first. Multiple validation runs can overlap in
// this workspace; a delete-then-copy window made an otherwise immutable Worker
// entrypoint disappear while Miniflare was still importing it.
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
