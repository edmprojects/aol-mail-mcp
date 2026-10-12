import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MailGateway } from "../src/mail.js";
import { buildServer } from "../src/server.js";
import { AolMailService } from "../src/service.js";
import { StateStore } from "../src/state.js";

test("lists the complete tool surface and rejects oversized inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aol-mcp-"));
  const gateway: MailGateway = {
    async listMailboxes() { return ["INBOX", "Archive"]; },
    async listMailboxDetails() { return []; },
    async snapshot() {
      return {
        scope: { accountId: "account", mailbox: "INBOX", uidValidity: "1" },
        unreadUids: [],
      };
    },
    async fetchUnread() {
      throw new Error("not expected");
    },
    async fetchUnreadMany() {
      throw new Error("not expected");
    },
    async searchMessages() {
      throw new Error("not expected");
    },
    async searchMailbox() {
      throw new Error("not expected");
    },
    async listRecent() {
      throw new Error("not expected");
    },
    async findMessageId() {
      throw new Error("not expected");
    },
    async fetchMessage() {
      throw new Error("not expected");
    },
    async fetchMessageDetails() {
      throw new Error("not expected");
    },
  };
  const service = new AolMailService(
    gateway,
    new StateStore(join(directory, "events.jsonl")),
    directory,
  );
  await service.initialize();
  const server = buildServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "export_action_log",
        "get_any_message",
        "get_mailbox_status",
        "get_message",
        "get_message_details",
        "group_recent_senders",
        "list_mailbox_details",
        "list_mailboxes",
        "list_research_records",
        "list_spam_candidates",
        "list_unread",
        "prepare_spam_reports",
        "recommend_filters",
        "record_report_results",
        "review_spam_folder",
        "save_classifications",
        "save_research_record",
        "save_spam_review",
        "search_across_mailboxes",
        "search_messages",
        "update_migration_status",
        "verify_spam_reports",
      ],
    );
    const searchTool = tools.tools.find((tool) => tool.name === "search_messages");
    assert.deepEqual(searchTool?.inputSchema.required?.sort(), ["field", "term"]);

    const invalid = await client.callTool({
      name: "list_unread",
      arguments: { limit: 51 },
    });
    assert.equal(invalid.isError, true);

    const unbounded = await client.callTool({
      name: "search_messages",
      arguments: { limit: 25 },
    });
    assert.equal(unbounded.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
