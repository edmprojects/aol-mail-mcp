import { ImapFlow } from "imapflow";
import { accountIdentifier, loadConfig, loadKeychainPassword } from "./config.js";
import { parseMessage } from "./message.js";
import type { MailboxScope, MailSearch, MessageSummary } from "./types.js";

export interface MailboxSnapshot {
  scope: MailboxScope;
  unreadUids: number[];
}

export interface MailGateway {
  snapshot(): Promise<MailboxSnapshot>;
  searchMessages(query: MailSearch): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
    nextBeforeUid: number | null;
  }>;
  fetchMessage(uid: number, previewLimit: number): Promise<{
    scope: MailboxScope;
    message: MessageSummary;
  }>;
  fetchUnread(uid: number, previewLimit: number): Promise<{
    scope: MailboxScope;
    message: MessageSummary;
  }>;
  fetchUnreadMany(
    uids: number[],
    previewLimit: number,
  ): Promise<{ scope: MailboxScope; messages: MessageSummary[] }>;
}

interface ReadOnlyImapClient {
  connect(): Promise<void>;
  mailboxOpen(
    path: string,
    options: { readOnly: boolean },
  ): Promise<{ readOnly?: boolean; uidValidity: bigint }>;
  search(
    query: {
      uid?: string;
      seen?: boolean;
      from?: string;
      subject?: string;
      text?: string;
      since?: string;
      before?: string;
    },
    options: { uid: boolean },
  ): Promise<number[] | false>;
  fetchOne(
    uid: number,
    query: { source: { start: number; maxLength: number }; uid: boolean },
    options: { uid: boolean },
  ): Promise<{ source?: Buffer } | false>;
  logout(): Promise<void>;
  close(): void;
}

interface GatewayDependencies {
  loadAccount: () => Promise<{ account: string }>;
  loadPassword: (account: string) => Promise<string>;
  createClient: (account: string, password: string) => ReadOnlyImapClient;
}

const defaultDependencies: GatewayDependencies = {
  loadAccount: loadConfig,
  loadPassword: loadKeychainPassword,
  createClient: (account, password) =>
    new ImapFlow({
      host: "export.imap.aol.com",
      port: 993,
      secure: true,
      auth: { user: account, pass: password },
      logger: false,
    }),
};

export class AolImapGateway implements MailGateway {
  constructor(private readonly dependencies: GatewayDependencies = defaultDependencies) {}

  private async withMailbox<T>(
    operation: (client: ReadOnlyImapClient, scope: MailboxScope) => Promise<T>,
  ): Promise<T> {
    const { account } = await this.dependencies.loadAccount();
    const password = await this.dependencies.loadPassword(account);
    const client = this.dependencies.createClient(account, password);

    try {
      await client.connect();
      const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
      if (!mailbox.readOnly) {
        throw new Error("server did not confirm read-only mode");
      }
      const scope: MailboxScope = {
        accountId: accountIdentifier(account),
        mailbox: "INBOX",
        uidValidity: mailbox.uidValidity.toString(),
      };
      return await operation(client, scope);
    } catch {
      throw new Error(
        "AOL IMAP operation failed. Verify the app password and account configuration.",
      );
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  async snapshot(): Promise<MailboxSnapshot> {
    return this.withMailbox(async (client, scope) => {
      const result = await client.search({ seen: false }, { uid: true });
      return {
        scope,
        unreadUids: result === false ? [] : result.sort((a, b) => b - a),
      };
    });
  }

  async searchMessages(query: MailSearch): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
    nextBeforeUid: number | null;
  }> {
    return this.withMailbox(async (client, scope) => {
      if (query.beforeUid === 1) {
        return { scope, messages: [], nextBeforeUid: null };
      }
      const result = await client.search(
        {
          ...(query.beforeUid && { uid: `1:${query.beforeUid - 1}` }),
          [query.field]: query.term,
          ...(query.since && { since: query.since }),
          ...(query.before && { before: query.before }),
        },
        { uid: true },
      );
      const uids = (result === false ? [] : result)
        .sort((a, b) => b - a)
        .slice(0, query.limit);
      const messages = await this.fetchSources(client, uids, 500, 32768);
      return { scope, messages, nextBeforeUid: uids.at(-1) ?? null };
    });
  }

  async fetchMessage(
    uid: number,
    previewLimit: number,
  ): Promise<{ scope: MailboxScope; message: MessageSummary }> {
    return this.withMailbox(async (client, scope) => {
      const messages = await this.fetchSources(client, [uid], previewLimit, 262144);
      return { scope, message: messages[0]! };
    });
  }

  async fetchUnread(
    uid: number,
    previewLimit: number,
  ): Promise<{ scope: MailboxScope; message: MessageSummary }> {
    const result = await this.fetchUnreadMany([uid], previewLimit);
    const message = result.messages[0];
    if (!message) {
      throw new Error(`UID ${uid} is not an unread Inbox message.`);
    }
    return { scope: result.scope, message };
  }

  async fetchUnreadMany(
    uids: number[],
    previewLimit: number,
  ): Promise<{ scope: MailboxScope; messages: MessageSummary[] }> {
    return this.withMailbox(async (client, scope) => {
      const unread = await client.search(
        { uid: uids.join(","), seen: false },
        { uid: true },
      );
      const unreadSet = new Set(unread === false ? [] : unread);
      const unknown = uids.filter((uid) => !unreadSet.has(uid));
      if (unknown.length > 0) {
        throw new Error(`UIDs are not unread Inbox messages: ${unknown.join(", ")}`);
      }

      const messages = await this.fetchSources(client, uids, previewLimit, 32768);
      return { scope, messages };
    });
  }

  private async fetchSources(
    client: ReadOnlyImapClient,
    uids: number[],
    previewLimit: number,
    sourceLimit: number,
  ): Promise<MessageSummary[]> {
    const messages: MessageSummary[] = [];
    for (const uid of uids) {
      const fetched = await client.fetchOne(
        uid,
        { source: { start: 0, maxLength: sourceLimit }, uid: true },
        { uid: true },
      );
      if (!fetched || !fetched.source) {
        throw new Error(`UID ${uid} returned no message source.`);
      }
      messages.push(await parseMessage(uid, fetched.source, previewLimit));
    }
    return messages;
  }
}
