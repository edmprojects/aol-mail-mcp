import { dataDirectory } from "./config.js";
import { exportEvents } from "./export.js";
import type { MailGateway } from "./mail.js";
import { StateStore } from "./state.js";
import type {
  ClassificationLabel,
  MailSearch,
  ReportStatus,
} from "./types.js";

export class AolMailService {
  constructor(
    private readonly gateway: MailGateway,
    private readonly state: StateStore,
    private readonly directory = dataDirectory(),
  ) {}

  async initialize(): Promise<void> {
    await this.state.load();
  }

  async getMailboxStatus(): Promise<Record<string, unknown>> {
    const snapshot = await this.gateway.snapshot();
    await this.state.load();
    return {
      accountId: snapshot.scope.accountId,
      mailbox: snapshot.scope.mailbox,
      uidValidity: snapshot.scope.uidValidity,
      unread: snapshot.unreadUids.length,
      ...this.state.counts(snapshot.scope),
    };
  }

  async listUnread(
    beforeUid?: number,
    limit = 50,
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.gateway.snapshot();
    await this.state.load();
    const selected = snapshot.unreadUids
      .filter((uid) => beforeUid === undefined || uid < beforeUid)
      .filter((uid) => !this.state.hasClassification(snapshot.scope, uid))
      .slice(0, limit);
    if (selected.length === 0) {
      return {
        scope: snapshot.scope,
        messages: [],
        nextBeforeUid: null,
      };
    }
    const fetched = await this.gateway.fetchUnreadMany(selected, 500);
    return {
      scope: fetched.scope,
      messages: fetched.messages,
      nextBeforeUid: selected.at(-1),
    };
  }

  async getMessage(uid: number): Promise<Record<string, unknown>> {
    const fetched = await this.gateway.fetchUnread(uid, 2000);
    return { scope: fetched.scope, message: fetched.message };
  }

  async searchMessages(query: MailSearch): Promise<Record<string, unknown>> {
    return this.gateway.searchMessages(query);
  }

  async listMailboxes(): Promise<Record<string, unknown>> {
    return { mailboxes: await this.gateway.listMailboxes() };
  }

  async getAnyMessage(uid: number, mailbox?: string): Promise<Record<string, unknown>> {
    const fetched = await this.gateway.fetchMessage(uid, 12000, mailbox);
    return { scope: fetched.scope, message: fetched.message };
  }

  async saveClassifications(
    decisions: Array<{
      uid: number;
      label: ClassificationLabel;
      confidence: number;
      reason: string;
    }>,
  ): Promise<Record<string, unknown>> {
    const fetched = await this.gateway.fetchUnreadMany(
      decisions.map((decision) => decision.uid),
      500,
    );
    const byUid = new Map(fetched.messages.map((message) => [message.uid, message]));
    await this.state.saveClassifications(
      fetched.scope,
      decisions.map((decision) => ({
        ...decision,
        message: byUid.get(decision.uid)!,
      })),
    );
    return {
      saved: decisions.length,
      counts: this.state.counts(fetched.scope),
    };
  }

  async listSpamCandidates(
    beforeUid?: number,
    limit = 25,
    uids?: number[],
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.gateway.snapshot();
    await this.state.load();
    return {
      scope: snapshot.scope,
      candidates: this.state.candidates(snapshot.scope, beforeUid, limit, uids),
    };
  }

  async recordReportResults(
    results: Array<{ key: string; status: ReportStatus; detail: string }>,
  ): Promise<Record<string, unknown>> {
    await this.state.recordReportResults(results);
    return { recorded: results.length };
  }

  async exportActionLog(format: "jsonl" | "csv"): Promise<Record<string, unknown>> {
    await this.state.load();
    const path = await exportEvents(this.directory, this.state.allEvents(), format);
    return { path, format, eventCount: this.state.allEvents().length };
  }
}
