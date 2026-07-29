import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore, messageKey } from "../src/state.js";
import type { MailboxScope, MessageSummary } from "../src/types.js";

const scope: MailboxScope = {
  accountId: "account123",
  mailbox: "INBOX",
  uidValidity: "10",
};
const message: MessageSummary = {
  uid: 100,
  messageId: "<100@example.com>",
  date: "2026-07-29T12:00:00.000Z",
  sender: "Sender",
  senderAddress: "sender@example.com",
  subject: "Subject",
  preview: "Preview",
};

async function createStore(): Promise<{ store: StateStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "aol-state-"));
  const path = join(directory, "events.jsonl");
  const store = new StateStore(path);
  await store.load();
  return { store, path };
}

test("persists classifications and scopes them by UIDVALIDITY", async () => {
  const { store, path } = await createStore();
  await store.saveClassifications(scope, [
    { message, label: "spam", confidence: 0.98, reason: "Deceptive bulk offer" },
  ]);

  const reloaded = new StateStore(path);
  await reloaded.load();

  assert.equal(reloaded.hasClassification(scope, 100), true);
  assert.equal(
    reloaded.hasClassification({ ...scope, uidValidity: "11" }, 100),
    false,
  );
  assert.equal(reloaded.candidates(scope).length, 1);
});

test("reported results are idempotent and remove pending candidates", async () => {
  const { store } = await createStore();
  await store.saveClassifications(scope, [
    { message, label: "spam", confidence: 1, reason: "Clear spam" },
  ]);
  const key = messageKey(scope, message.uid);

  await store.recordReportResults([{ key, status: "reported", detail: "" }]);
  await store.recordReportResults([{ key, status: "reported", detail: "" }]);

  assert.equal(store.candidates(scope).length, 0);
  assert.equal(
    store.allEvents().filter((event) => event.type === "report_result").length,
    1,
  );
});

test("ignores an interrupted final JSONL line", async () => {
  const { store, path } = await createStore();
  await store.saveClassifications(scope, [
    { message, label: "not_spam", confidence: 0.9, reason: "Receipt" },
  ]);
  await appendFile(path, '{"type":"classification"');

  const reloaded = new StateStore(path);
  await reloaded.load();
  await reloaded.saveClassifications(scope, [
    {
      message: { ...message, uid: 101 },
      label: "uncertain",
      confidence: 0.5,
      reason: "Needs review",
    },
  ]);
  const loadedAgain = new StateStore(path);
  await loadedAgain.load();

  assert.equal(loadedAgain.counts(scope).classified.not_spam, 1);
  assert.equal(loadedAgain.counts(scope).classified.uncertain, 1);
});

test("intentionally skipped candidates do not return to the approval queue", async () => {
  const { store } = await createStore();
  await store.saveClassifications(scope, [
    { message, label: "spam", confidence: 1, reason: "Clear spam" },
  ]);
  await store.recordReportResults([
    {
      key: messageKey(scope, message.uid),
      status: "skipped",
      detail: "User declined this candidate",
    },
  ]);

  assert.equal(store.candidates(scope).length, 0);
  assert.equal(store.counts(scope).pendingCandidates, 0);
});

test("rejects report results for unknown candidates", async () => {
  const { store } = await createStore();

  await assert.rejects(
    store.recordReportResults([
      { key: "unknown", status: "reported", detail: "" },
    ]),
    /Unknown spam candidate/,
  );
});

test("restricts candidates to an explicit reviewed UID set", async () => {
  const { store } = await createStore();
  await store.saveClassifications(scope, [
    { message, label: "spam", confidence: 1, reason: "First" },
    {
      message: { ...message, uid: 101 },
      label: "spam",
      confidence: 1,
      reason: "Second",
    },
  ]);

  assert.deepEqual(
    store.candidates(scope, undefined, 25, [101]).map((candidate) => candidate.uid),
    [101],
  );
});

test("isolates candidate UIDs by account and UIDVALIDITY", async () => {
  const { store } = await createStore();
  const oldScope = { ...scope, uidValidity: "9" };
  const otherAccount = { ...scope, accountId: "other-account" };
  await store.saveClassifications(oldScope, [
    { message, label: "spam", confidence: 1, reason: "Old mailbox" },
  ]);
  await store.saveClassifications(otherAccount, [
    { message, label: "spam", confidence: 1, reason: "Other account" },
  ]);
  await store.saveClassifications(scope, [
    { message, label: "spam", confidence: 1, reason: "Current mailbox" },
  ]);

  assert.deepEqual(
    store.candidates(scope, undefined, 25, [message.uid]).map((candidate) => ({
      key: candidate.key,
      reason: candidate.reason,
    })),
    [
      {
        key: messageKey(scope, message.uid),
        reason: "Current mailbox",
      },
    ],
  );
});

test("refreshes state written by another live MCP process", async () => {
  const { store: writer, path } = await createStore();
  const reader = new StateStore(path);
  await reader.load();

  await writer.saveClassifications(scope, [
    { message, label: "spam", confidence: 1, reason: "Clear spam" },
  ]);
  assert.equal(reader.hasClassification(scope, message.uid), false);

  await reader.load();

  assert.equal(reader.hasClassification(scope, message.uid), true);
  assert.equal(reader.candidates(scope).length, 1);
});

test("serializes concurrent writes from separate MCP processes", async () => {
  const { store: first, path } = await createStore();
  const second = new StateStore(path);
  await second.load();

  await Promise.all([
    first.saveClassifications(scope, [
      { message, label: "spam", confidence: 1, reason: "First process" },
    ]),
    second.saveClassifications(scope, [
      {
        message: { ...message, uid: 101 },
        label: "not_spam",
        confidence: 1,
        reason: "Second process",
      },
    ]),
  ]);
  await first.load();

  assert.equal(first.counts(scope).classified.spam, 1);
  assert.equal(first.counts(scope).classified.not_spam, 1);
});

test("recovers a lock owned by a terminated process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aol-stale-lock-"));
  const path = join(directory, "events.jsonl");
  const lockPath = `${path}.lock`;
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token: "terminated-owner" }),
  );

  const store = new StateStore(path);
  await store.load();
  await store.saveClassifications(scope, [
    { message, label: "spam", confidence: 1, reason: "Recovered state" },
  ]);

  assert.equal(store.hasClassification(scope, message.uid), true);
});

test("does not steal an old lock from a live process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aol-live-lock-"));
  const path = join(directory, "events.jsonl");
  const lockPath = `${path}.lock`;
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "live-owner" }),
  );
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(new StateStore(path).load(), /Timed out waiting/);

  assert.equal((await stat(lockPath)).isDirectory(), true);
});
