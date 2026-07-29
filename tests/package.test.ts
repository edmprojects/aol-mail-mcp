import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the package start command points to the built MCP entrypoint", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { scripts: { start: string } };
  const relativeEntrypoint = packageJson.scripts.start.replace(/^node\s+/, "");

  assert.equal(relativeEntrypoint, "build/src/index.js");
  await access(join(root, relativeEntrypoint));
});
