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
    async list() { return [{ path: "INBOX", flags: new Set<string>() }]; },
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
      async list() { return []; },
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

test("searches read mail and fetches an exact message without changing flags", async () => {
  const calls: Array<{ name: string; value: unknown }> = [];
  const source = Buffer.from(
    "From: clientservices@rh.com\r\nSubject: Order Confirmation\r\nContent-Type: text/plain\r\n\r\nCloud couch order",
  );
  const client = {
    async connect() {},
    async list() {
      calls.push({ name: "list", value: null });
      return [
        { path: "INBOX", flags: new Set<string>() },
        { path: "Archive", flags: new Set<string>() },
        { path: "Parent", flags: new Set(["\\Noselect"]) },
      ];
    },
    async mailboxOpen(path: string, options: { readOnly: boolean }) {
      calls.push({ name: "mailboxOpen", value: { path, options } });
      return { readOnly: true, uidValidity: 77n };
    },
    async search(query: unknown) {
      calls.push({ name: "search", value: query });
      return [8, 9];
    },
    async fetchOne(uid: number, query: unknown, options: unknown) {
      calls.push({ name: "fetchOne", value: { uid, query, options } });
      return {
        source,
        size: source.length + 1000,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { type: "text/plain" },
            {
              type: "application/pdf", size: 2048, disposition: "attachment",
              dispositionParameters: { filename: "receipt.pdf" },
            },
          ],
        },
      };
    },
    async logout() {},
    close() {},
  };
  const gateway = new AolImapGateway({
    loadAccount: async () => ({ account: "old@example.com" }),
    loadPassword: async () => "secret",
    createClient: () => client,
  });

  const search = await gateway.searchMessages({ field: "text", term: "Cloud", limit: 1, beforeUid: 10 });
  const exhausted = await gateway.searchMessages({ field: "text", term: "Cloud", limit: 1, beforeUid: 1 });
  const exact = await gateway.fetchMessage(9, 12000);

  assert.deepEqual(search.messages.map((message) => message.uid), [9]);
  assert.equal(search.nextBeforeUid, 9);
  assert.deepEqual(exhausted.messages, []);
  assert.match(exact.message.preview, /Cloud couch order/);
  assert.deepEqual(calls.find((call) => call.name === "search")?.value, {
    uid: "1:9",
    text: "Cloud",
  });
  assert.deepEqual(
    calls.filter((call) => call.name === "fetchOne").at(-1)?.value,
    {
      uid: 9,
      query: { source: { start: 0, maxLength: 262144 }, uid: true },
      options: { uid: true },
    },
  );
  assert.equal(
    calls.filter((call) => call.name === "mailboxOpen").every(
      (call) => (call.value as { options: { readOnly: boolean } }).options.readOnly,
    ),
    true,
  );

  assert.deepEqual(await gateway.listMailboxes(), ["INBOX", "Archive"]);
  const archived = await gateway.searchMessages({
    mailbox: "Archive", field: "subject", term: "Order", limit: 1,
  });
  await gateway.searchMailbox({
    mailbox: "Archive", from: "rh.com", subject: "Order", text: "Cloud", limit: 1,
  });
  assert.deepEqual(calls.filter((call) => call.name === "search").at(-1)?.value, {
    from: "rh.com", subject: "Order", text: "Cloud",
  });
  const archivedMessage = await gateway.fetchMessage(9, 12000, "Archive");
  const details = await gateway.fetchMessageDetails(9, "Archive");
  assert.equal(archived.scope.mailbox, "Archive");
  assert.equal(archivedMessage.scope.mailbox, "Archive");
  assert.deepEqual(details.message.attachments, [{
    filename: "receipt.pdf", contentType: "application/pdf", size: 2048, disposition: "attachment",
  }]);
  assert.equal(details.message.sourceTruncated, true);
  assert.equal(
    (calls.filter((call) => call.name === "mailboxOpen").at(-1)?.value as { path: string }).path,
    "Archive",
  );
  await assert.rejects(
    gateway.fetchMessage(9, 12000, "Parent"),
    /IMAP operation failed/,
  );
  await assert.rejects(
    gateway.fetchMessage(9, 12000, "Missing"),
    /IMAP operation failed/,
  );
});
