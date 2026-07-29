import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { csvCell, exportEvents } from "../src/export.js";
import type { ClassificationEvent } from "../src/types.js";

test("neutralizes spreadsheet formulas", () => {
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell("@command"), '"\'@command"');
  assert.equal(csvCell("Normal"), '"Normal"');
});

test("writes private CSV exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aol-export-"));
  const event: ClassificationEvent = {
    type: "classification",
    eventId: "event",
    recordedAt: "2026-07-29T12:00:00.000Z",
    key: "key",
    scope: { accountId: "account", mailbox: "INBOX", uidValidity: "1" },
    message: {
      uid: 1,
      messageId: "<1@example.com>",
      date: "2026-07-29T12:00:00.000Z",
      sender: "=Bad",
      senderAddress: "bad@example.com",
      subject: "Subject",
      preview: "Preview",
    },
    label: "spam",
    confidence: 1,
    reason: "Spam",
  };

  const path = await exportEvents(directory, [event], "csv");
  const content = await readFile(path, "utf8");

  assert.match(content, /"'=Bad"/);
});
