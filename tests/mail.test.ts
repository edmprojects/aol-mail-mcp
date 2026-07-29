import assert from "node:assert/strict";
import test from "node:test";
import { AolImapGateway } from "../src/mail.js";

test("opens INBOX read-only and fetches message source with peek-safe semantics", async () => {
  const calls: Array<{ name: string; value: unknown }> = [];
  const source = Buffer.from(
    "From: sender@example.com\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nBody",
  );
  const client = {
    async connect() {
      calls.push({ name: "connect", value: null });
    },
    async mailboxOpen(path: string, options: { readOnly: boolean }) {
      calls.push({ name: "mailboxOpen", value: { path, options } });
      return { readOnly: true, uidValidity: 77n };
    },
    async search(query: { uid?: string; seen: boolean }) {
      calls.push({ name: "search", value: query });
      return [9];
    },
    async fetchOne(
      uid: number,
      query: { source: { start: number; maxLength: number }; uid: boolean },
      options: { uid: boolean },
    ) {
      calls.push({ name: "fetchOne", value: { uid, query, options } });
      return { source };
    },
    async logout() {
      calls.push({ name: "logout", value: null });
    },
    close() {},
  };
  const gateway = new AolImapGateway({
    loadAccount: async () => ({ account: "old@example.com" }),
    loadPassword: async () => "secret",
    createClient: () => client,
  });

  const result = await gateway.fetchUnread(9, 500);

  assert.equal(result.scope.uidValidity, "77");
  assert.equal(result.message.subject, "Hello");
  assert.deepEqual(
    calls.find((call) => call.name === "mailboxOpen")?.value,
    { path: "INBOX", options: { readOnly: true } },
  );
  assert.deepEqual(
    calls.find((call) => call.name === "fetchOne")?.value,
    {
      uid: 9,
      query: { source: { start: 0, maxLength: 32768 }, uid: true },
      options: { uid: true },
    },
  );
  assert.equal(
    calls.some((call) => /store|move|delete|copy|expunge/i.test(call.name)),
    false,
  );
});

test("redacts raw IMAP errors", async () => {
  const gateway = new AolImapGateway({
    loadAccount: async () => ({ account: "old@example.com" }),
    loadPassword: async () => "secret",
    createClient: () => ({
      async connect() {
        throw new Error("server echoed secret");
      },
      async mailboxOpen() {
        return { readOnly: true, uidValidity: 1n };
      },
      async search() {
        return [];
      },
      async fetchOne() {
        return false;
      },
      async logout() {},
      close() {},
    }),
  });

  await assert.rejects(gateway.snapshot(), (error: Error) => {
    assert.doesNotMatch(error.message, /secret|old@example/);
    assert.match(error.message, /IMAP operation failed/);
    return true;
  });
});
