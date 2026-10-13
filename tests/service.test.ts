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
  async listMailboxDetails() { return [{ path: "INBOX", specialUse: null, specialUseSource: null }]; }
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

  async searchMailbox(query: { mailbox: string; limit: number }) {
    const result = await this.searchMessages({ field: "subject", term: "Order", limit: query.limit });
    return { ...result, scope: { ...this.scope, mailbox: query.mailbox } };
  }

  async listRecent(mailbox: string, limit: number, beforeUid?: number) {
    const uids = [105, 104, 103].filter((uid) => beforeUid === undefined || uid < beforeUid).slice(0, limit);
    return {
      scope: { ...this.scope, mailbox },
      messages: (await this.fetchUnreadMany(uids, 500)).messages,
      nextBeforeUid: uids.at(-1) ?? null,
    };
  }

  async findMessageId(mailbox: string, messageId: string) {
    const uid = Number(messageId.match(/^<(\d+)@/)?.[1]);
    return {
      scope: { ...this.scope, mailbox },
      messages: Number.isInteger(uid) && mailbox !== "INBOX"
        ? (await this.fetchUnreadMany([uid], 500)).messages : [],
    };
  }

  async fetchMessageDetails(uid: number, mailbox?: string) {
    const fetched = await this.fetchMessage(uid, 12000);
    return {
      scope: { ...fetched.scope, mailbox: mailbox ?? "INBOX" },
      message: { ...fetched.message, attachments: [], sourceTruncated: false, unsubscribe: { mailto: [], urls: [], oneClick: false } },
    };
  }

  async fetchMessage(uid: number, previewLimit: number, mailbox?: string) {
    const fetched = await this.fetchUnread(uid, previewLimit);
    return { ...fetched, scope: { ...fetched.scope, mailbox: mailbox ?? "INBOX" } };
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

  async fetchInboxMany(uids: number[], previewLimit: number) {
    return this.fetchUnreadMany(uids.filter((uid) => uid <= 105), previewLimit);
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

test("pages read and unread Inbox mail and rejects stale classification selections", async () => {
  const { service, gateway } = await createService();
  const first = await service.listInboxBatch("2025-08-01", "2026-12-31", undefined, 2);
  assert.equal(first.scanned, 2);
  assert.deepEqual((first.messages as MessageSummary[]).map((message) => message.uid), [105, 104]);
  assert.equal(first.nextBeforeUid, 104);

  await assert.rejects(service.saveClassifications([
    { uid: 105, messageId: "<105@example.com>", label: "spam", confidence: 1, reason: "Offer" },
  ], "old"), /UIDVALIDITY changed/);
  await assert.rejects(service.saveClassifications([
    { uid: 105, messageId: "<different@example.com>", label: "spam", confidence: 1, reason: "Offer" },
  ], gateway.scope.uidValidity), /message 105 changed/);
  await assert.rejects(service.saveClassifications([
    { uid: 999, label: "spam", confidence: 1, reason: "Offer" },
  ], gateway.scope.uidValidity), /message 999 changed/);

  await service.saveClassifications([
    { uid: 105, messageId: "<105@example.com>", label: "spam", confidence: 1, reason: "Offer" },
  ], gateway.scope.uidValidity);
  const again = await service.listInboxBatch("2025-08-01", "2026-12-31", undefined, 2);
  assert.equal(again.scanned, 2);
  assert.deepEqual((again.messages as MessageSummary[]).map((message) => message.uid), [104]);
  await assert.rejects(service.listInboxBatch("2026-12-31", "2025-08-01", undefined, 2), /before must be later/);
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

test("searches selected folders independently and reports a failed folder", async () => {
  const { service, gateway } = await createService();
  const searchMailbox = gateway.searchMailbox.bind(gateway);
  gateway.searchMailbox = async (query) => {
    if (query.mailbox === "Archive") throw new Error("Archive unavailable");
    return searchMailbox(query);
  };

  const result = await service.searchAcrossMailboxes({
    mailboxes: ["INBOX", "Archive"],
    from: "rh.com",
    subject: "Order",
    limitPerMailbox: 2,
  });

  assert.deepEqual(
    (result.results as Array<{ scope: MailboxScope }>).map((item) => item.scope.mailbox),
    ["INBOX"],
  );
  assert.deepEqual(result.errors, [{ mailbox: "Archive", error: "Archive unavailable" }]);
  await assert.rejects(
    service.searchAcrossMailboxes({ mailboxes: ["INBOX"], limitPerMailbox: 1 }),
    /At least one/,
  );
});

test("persists selected receipt and migration findings without altering the action log", async () => {
  const { service } = await createService();
  await service.saveResearchRecord({
    kind: "receipt", uid: 105, organization: "Restoration Hardware", note: "Cloud couch",
    orderNumber: "RH-123", amount: "$100.00",
  });
  const savedMigration = await service.saveResearchRecord({
    kind: "migration", uid: 104, organization: "Example account", note: "Change account email",
    currentEmail: "old@example.com", targetEmail: "new@example.com",
  });
  const migration = await service.listResearchRecords("migration");
  const records = migration.records as Array<{ status: string; scope: MailboxScope }>;
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "to_review");
  assert.equal(records[0]?.scope.uidValidity, "10");

  const key = (savedMigration.record as { key: string }).key;
  await service.updateMigrationStatus(key, "updated", "Updated externally");
  await service.saveResearchRecord({
    kind: "receipt", uid: 105, organization: "Restoration Hardware", note: "Check warranty",
  });
  await service.saveResearchRecord({
    kind: "migration", uid: 104, organization: "Example account",
    currentEmail: "old@example.com", targetEmail: "new@example.com",
  });
  const receipts = await service.listResearchRecords("receipt");
  const receipt = (receipts.records as Array<{ orderNumber?: string; amount?: string; note: string }>)[0];
  assert.equal(receipt?.orderNumber, "RH-123");
  assert.equal(receipt?.amount, "$100.00");
  assert.equal(receipt?.note, "Check warranty");
  const updated = await service.listResearchRecords("migration");
  assert.equal((updated.records as Array<{ status: string }>).length, 1);
  assert.equal((updated.records as Array<{ status: string }>)[0]?.status, "updated");
  assert.equal((updated.records as Array<{ note: string }>)[0]?.note, "Updated externally");
  const firstPage = await service.listResearchRecords(undefined, 0, 1);
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.nextOffset, 1);
  const secondPage = await service.listResearchRecords(undefined, 1, 1);
  assert.equal((secondPage.records as unknown[]).length, 1);
  assert.equal(secondPage.nextOffset, null);
});

test("refreshes exact spam candidates and checks location without recording a native report", async () => {
  const { service, state } = await createService();
  await service.saveClassifications([{ uid: 105, label: "spam", confidence: 0.99, reason: "Unsolicited offer" }]);
  const listed = await service.listSpamCandidates();
  const key = (listed.candidates as Array<{ key: string }>)[0]!.key;
  const prepared = await service.prepareSpamReports([key]);
  assert.equal((prepared.candidates as Array<{ ready: boolean }>)[0]?.ready, true);
  const checked = await service.verifySpamReports([key], "Spam");
  assert.equal((checked.results as Array<{ verified: boolean }>)[0]?.verified, true);
  assert.equal(state.counts().reported, 0);
  await assert.rejects(service.verifySpamReports([key], "INBOX"), /Spam mailbox/);
});

test("groups bounded recent senders and reviews reported matches", async () => {
  const { service } = await createService();
  const groups = await service.senderGroups("INBOX", 2);
  assert.equal(groups.sampled, 2);
  assert.equal((groups.groups as unknown[]).length, 2);
  await service.saveClassifications([{ uid: 105, label: "spam", confidence: 1, reason: "Spam" }]);
  const key = ((await service.listSpamCandidates()).candidates as Array<{ key: string }>)[0]!.key;
  await service.recordReportResults([{ key, status: "reported", detail: "Observed Webmail Spam action" }]);
  const review = await service.reviewSpamFolder("Spam", 2);
  assert.equal((review.messages as Array<{ locallyReported: boolean }>)[0]?.locallyReported, true);
  await service.saveSpamReview("Spam", 105, "false_positive", "Looks like an account notice");
  const reviewed = await service.reviewSpamFolder("Spam", 2);
  assert.equal((reviewed.messages as Array<{ review: string }>)[0]?.review, "false_positive");
  await assert.rejects(service.saveSpamReview("INBOX", 105, "spam", ""), /Spam folder/);
});
