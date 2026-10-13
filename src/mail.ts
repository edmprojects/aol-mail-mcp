import { ImapFlow } from "imapflow";
import { accountIdentifier, loadConfig, loadKeychainPassword } from "./config.js";
import { extractUnsubscribe, parseMessage } from "./message.js";
import type { MailboxScope, MailSearch, MailCriteriaSearch, MessageDetails, MessageSummary, AttachmentMetadata } from "./types.js";

export interface MailboxSnapshot {
  scope: MailboxScope;
  unreadUids: number[];
}

export interface MailGateway {
  listMailboxes(): Promise<string[]>;
  listMailboxDetails(): Promise<Array<{ path: string; specialUse: string | null; specialUseSource: string | null }>>;
  snapshot(): Promise<MailboxSnapshot>;
  searchMessages(query: MailSearch): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
    nextBeforeUid: number | null;
  }>;
  searchMailbox(query: MailCriteriaSearch): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
    nextBeforeUid: number | null;
  }>;
  listRecent(mailbox: string, limit: number, beforeUid?: number, since?: string, before?: string): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
    nextBeforeUid: number | null;
  }>;
  findMessageId(mailbox: string, messageId: string): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
  }>;
  fetchMessageDetails(uid: number, mailbox?: string): Promise<{
    scope: MailboxScope;
    message: MessageDetails;
  }>;
  fetchMessage(uid: number, previewLimit: number, mailbox?: string): Promise<{
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
  fetchInboxMany(
    uids: number[],
    previewLimit: number,
  ): Promise<{ scope: MailboxScope; messages: MessageSummary[] }>;
}

interface ReadOnlyImapClient {
  connect(): Promise<void>;
  list(): Promise<Array<{ path: string; flags: Set<string>; specialUse?: string; specialUseSource?: string }>>;
  mailboxOpen(
    path: string,
    options: { readOnly: boolean },
  ): Promise<{ readOnly?: boolean; uidValidity: bigint }>;
  search(
    query: {
      uid?: string;
      all?: boolean;
      header?: Record<string, string>;
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
    query: { source: { start: number; maxLength: number }; uid: boolean; bodyStructure?: boolean; size?: boolean },
    options: { uid: boolean },
  ): Promise<{ source?: Buffer; size?: number; bodyStructure?: MailStructure } | false>;
  logout(): Promise<void>;
  close(): void;
}

interface MailStructure {
  type: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: MailStructure[];
}

function attachmentMetadata(structure?: MailStructure): AttachmentMetadata[] {
  if (!structure) return [];
  const children = structure.childNodes?.flatMap(attachmentMetadata) ?? [];
  const filename = structure.dispositionParameters?.filename ?? structure.parameters?.name;
  if (!filename && structure.disposition?.toLowerCase() !== "attachment") return children;
  return [{
    filename: filename ?? "",
    contentType: structure.type,
    size: structure.size ?? null,
    disposition: structure.disposition ?? "",
  }, ...children];
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
    mailboxPath = "INBOX",
  ): Promise<T> {
    const { account } = await this.dependencies.loadAccount();
    const password = await this.dependencies.loadPassword(account);
    const client = this.dependencies.createClient(account, password);

    try {
      await client.connect();
      if (mailboxPath !== "INBOX") {
        const folders = await client.list();
        const selected = folders.find((folder) => folder.path === mailboxPath);
        if (!selected || selected.flags.has("\\Noselect")) {
          throw new Error("Mailbox is unavailable or cannot be selected.");
        }
      }
      const mailbox = await client.mailboxOpen(mailboxPath, { readOnly: true });
      if (!mailbox.readOnly) {
        throw new Error("server did not confirm read-only mode");
      }
      const scope: MailboxScope = {
        accountId: accountIdentifier(account),
        mailbox: mailboxPath,
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

  async listMailboxes(): Promise<string[]> {
    return (await this.listMailboxDetails()).map((folder) => folder.path);
  }

  async listMailboxDetails(): Promise<Array<{ path: string; specialUse: string | null; specialUseSource: string | null }>> {
    const { account } = await this.dependencies.loadAccount();
    const password = await this.dependencies.loadPassword(account);
    const client = this.dependencies.createClient(account, password);
    try {
      await client.connect();
      const folders = await client.list();
      return folders
        .filter((folder) => !folder.flags.has("\\Noselect"))
        .map((folder) => ({
          path: folder.path,
          specialUse: folder.specialUse ?? null,
          specialUseSource: folder.specialUseSource ?? null,
        }));
    } catch {
      throw new Error("AOL IMAP operation failed. Verify the app password and account configuration.");
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
    return this.searchMailbox({
      mailbox: query.mailbox ?? "INBOX",
      [query.field]: query.term,
      since: query.since,
      before: query.before,
      beforeUid: query.beforeUid,
      limit: query.limit,
    });
  }

  async listRecent(mailbox: string, limit: number, beforeUid?: number, since?: string, before?: string): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
    nextBeforeUid: number | null;
  }> {
    return this.withMailbox(async (client, scope) => {
      if (beforeUid === 1) return { scope, messages: [], nextBeforeUid: null };
      const result = await client.search({
        all: true,
        ...(beforeUid && { uid: `1:${beforeUid - 1}` }),
        ...(since && { since }),
        ...(before && { before }),
      }, { uid: true });
      const uids = (result === false ? [] : result).sort((a, b) => b - a).slice(0, limit);
      return {
        scope,
        messages: await this.fetchSources(client, uids, 500, 32768),
        nextBeforeUid: uids.at(-1) ?? null,
      };
    }, mailbox);
  }

  async findMessageId(mailbox: string, messageId: string): Promise<{
    scope: MailboxScope;
    messages: MessageSummary[];
  }> {
    return this.withMailbox(async (client, scope) => {
      const result = await client.search({ header: { "Message-ID": messageId } }, { uid: true });
      const uids = (result === false ? [] : result).sort((a, b) => b - a).slice(0, 10);
      const messages = await this.fetchSources(client, uids, 500, 32768);
      return { scope, messages: messages.filter((message) => message.messageId === messageId) };
    }, mailbox);
  }

  async searchMailbox(query: MailCriteriaSearch): Promise<{
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
          ...(query.from && { from: query.from }),
          ...(query.subject && { subject: query.subject }),
          ...(query.text && { text: query.text }),
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
    }, query.mailbox);
  }

  async fetchMessageDetails(
    uid: number,
    mailbox?: string,
  ): Promise<{ scope: MailboxScope; message: MessageDetails }> {
    return this.withMailbox(async (client, scope) => {
      const fetched = await client.fetchOne(
        uid,
        { source: { start: 0, maxLength: 262144 }, bodyStructure: true, size: true, uid: true },
        { uid: true },
      );
      if (!fetched || !fetched.source) {
        throw new Error(`UID ${uid} returned no message source.`);
      }
      const summary = await parseMessage(uid, fetched.source, 12000);
      return {
        scope,
        message: {
          ...summary,
          attachments: attachmentMetadata(fetched.bodyStructure),
          sourceTruncated: fetched.size === undefined ? null : fetched.size > fetched.source.length,
          unsubscribe: extractUnsubscribe(fetched.source),
        },
      };
    }, mailbox);
  }

  async fetchMessage(
    uid: number,
    previewLimit: number,
    mailbox?: string,
  ): Promise<{ scope: MailboxScope; message: MessageSummary }> {
    return this.withMailbox(async (client, scope) => {
      const messages = await this.fetchSources(client, [uid], previewLimit, 262144);
      return { scope, message: messages[0]! };
    }, mailbox);
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

  async fetchInboxMany(
    uids: number[],
    previewLimit: number,
  ): Promise<{ scope: MailboxScope; messages: MessageSummary[] }> {
    return this.withMailbox(async (client, scope) => ({
      scope,
      messages: await this.fetchSources(client, uids, previewLimit, 32768),
    }));
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
