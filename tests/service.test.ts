import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MailGateway, MailboxSnapshot } from "../src/mail.js";
import { AolMailService } from "../src/service.js";
import { StateStore } from "../src/state.js";
import type { MailboxScope, MailSearch, MessageSummary } from "../src/types.js";

class FakeGateway implements MailGateway {
  async listMailboxes() { return ["INBOX", "Archive"]; }
  scope: MailboxScope = {
    accountId: "account123",
    mailbox: "INBOX",
    uidValidity: "10",
  };
  unreadUids = [105, 104, 103, 102, 101];

  async snapshot(): Promise<MailboxSnapshot> {
    return { scope: this.scope, unreadUids: this.unreadUids };
  }

  async searchMessages(query: MailSearch) {
    const uids = [105, 104, 103].filter(
      (uid) => query.beforeUid === undefined || uid < query.beforeUid,
    ).slice(0, query.limit);
    const fetched = await this.fetchUnreadMany(uids, 500);
    return { ...fetched, nextBeforeUid: uids.at(-1) ?? null };
  }

  async fetchMessage(uid: number, previewLimit: number) {
    return this.fetchUnread(uid, previewLimit);
  }

  async fetchUnread(uid: number, previewLimit: number) {
    const result = await this.fetchUnreadMany([uid], previewLimit);
    return { scope: this.scope, message: result.messages[0]! };
  }

  async fetchUnreadMany(uids: number[], previewLimit: number) {
    const messages = uids.map((uid): MessageSummary => ({
      uid,
      messageId: `<${uid}@example.com>`,
      date: "2026-07-29T12:00:00.000Z",
      sender: `Sender ${uid}`,
      senderAddress: `sender${uid}@example.com`,
      subject: `Subject ${uid}`,
      preview: "x".repeat(previewLimit),
    }));
    return { scope: this.scope, messages };
  }
}

async function createService(gateway = new FakeGateway()) {
  const directory = await mkdtemp(join(tmpdir(), "aol-service-"));
  const state = new StateStore(join(directory, "events.jsonl"));
  const service = new AolMailService(gateway, state, directory);
  await service.initialize();
  return { service, gateway, state };
}

test("paginates newest unread messages and enforces the cursor", async () => {
  const { service } = await createService();

  const first = await service.listUnread(undefined, 2);
  const second = await service.listUnread(104, 2);

  assert.deepEqual(
    (first.messages as MessageSummary[]).map((message) => message.uid),
    [105, 104],
  );
  assert.deepEqual(
    (second.messages as MessageSummary[]).map((message) => message.uid),
    [103, 102],
  );
});

test("excludes classified messages and reopens them after UIDVALIDITY changes", async () => {
  const { service, gateway } = await createService();
  await service.saveClassifications([
    { uid: 105, label: "not_spam", confidence: 1, reason: "Personal mail" },
  ]);

  const current = await service.listUnread(undefined, 5);
  gateway.scope = { ...gateway.scope, uidValidity: "11" };
  const changed = await service.listUnread(undefined, 5);

  assert.doesNotMatch(
    JSON.stringify(current.messages),
    /"uid":105/,
  );
  assert.match(JSON.stringify(changed.messages), /"uid":105/);
});

test("handles an empty unread mailbox", async () => {
  const gateway = new FakeGateway();
  gateway.unreadUids = [];
  const { service } = await createService(gateway);

  const result = await service.listUnread();

  assert.deepEqual(result.messages, []);
  assert.equal(result.nextBeforeUid, null);
});

test("search and exact reads do not depend on unread triage state", async () => {
  const { service, gateway } = await createService();
  gateway.unreadUids = [];

  const results = await service.searchMessages({ field: "from", term: "rh.com", limit: 2 });
  const exact = await service.getAnyMessage(105);

  assert.deepEqual(
    (results.messages as MessageSummary[]).map((message) => message.uid),
    [105, 104],
  );
  assert.equal(results.nextBeforeUid, 104);
  assert.equal((exact.message as MessageSummary).uid, 105);
});
