import assert from "node:assert/strict";
import test from "node:test";
import { legacyEvents } from "../src/import-legacy.js";

test("parses quoted legacy rows with commas and stable identities", () => {
  const csv =
    '"moved_at","message_date","sender","subject","reason"\n' +
    '"2026-07-29","Jul 20, 2026","Sender","Offer, today","Clear spam"\n';

  const first = legacyEvents(csv);
  const second = legacyEvents(csv);

  assert.equal(first.length, 1);
  assert.equal(first[0]?.subject, "Offer, today");
  assert.equal(first[0]?.eventId, second[0]?.eventId);
  assert.equal(first[0]?.source, "legacy_ui_log");
});
