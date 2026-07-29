import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loadKeychainPassword } from "../src/config.js";

test("loads a valid account without a stored password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aol-config-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({ account: "old@example.com" }));

  assert.deepEqual(await loadConfig(path), { account: "old@example.com" });
});

test("keychain lookup returns the secret without adding it to arguments", async () => {
  let observedArgs: string[] = [];
  const password = await loadKeychainPassword(
    "old@example.com",
    async (_file, args) => {
      observedArgs = args;
      return { stdout: "app-secret\n" };
    },
  );

  assert.equal(password, "app-secret");
  assert.doesNotMatch(observedArgs.join(" "), /app-secret/);
});

test("keychain failures are redacted", async () => {
  await assert.rejects(
    loadKeychainPassword("old@example.com", async () => {
      throw new Error("raw secret server response");
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /raw secret/);
      assert.match(error.message, /Keychain/);
      return true;
    },
  );
});
