import { ImapFlow } from "imapflow";
import { accountIdentifier, loadConfig, loadKeychainPassword } from "./config.js";
import { parseMessage } from "./message.js";
import type { MailboxScope, MessageSummary } from "./types.js";

export interface MailboxSnapshot {
  scope: MailboxScope;
  unreadUids: number[];
}

export interface MailGateway {
  snapshot(): Promise<MailboxSnapshot>;
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
    query: { uid?: string; seen: boolean },
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

      const messages: MessageSummary[] = [];
      for (const uid of uids) {
        const fetched = await client.fetchOne(
          uid,
          { source: { start: 0, maxLength: 32768 }, uid: true },
          { uid: true },
        );
        if (!fetched || !fetched.source) {
          throw new Error(`UID ${uid} returned no message source.`);
        }
        messages.push(await parseMessage(uid, fetched.source, previewLimit));
      }
      return { scope, messages };
    });
  }
}
