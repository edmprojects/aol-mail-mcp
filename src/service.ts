import { dataDirectory } from "./config.js";
import { exportEvents } from "./export.js";
import type { MailGateway } from "./mail.js";
import { messageKey, StateStore } from "./state.js";
import type {
  ClassificationLabel,
  MailSearch,
  MultiMailboxSearch,
  ReportStatus,
  ResearchInput,
  ResearchKind,
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

  async getMessageDetails(uid: number, mailbox?: string): Promise<Record<string, unknown>> {
    return this.gateway.fetchMessageDetails(uid, mailbox);
  }

  async searchAcrossMailboxes(query: MultiMailboxSearch): Promise<Record<string, unknown>> {
    if (!query.from && !query.subject && !query.text) {
      throw new Error("At least one of from, subject, or text is required.");
    }
    if (new Set(query.mailboxes).size !== query.mailboxes.length) {
      throw new Error("Each mailbox may appear only once.");
    }
    const results = [];
    const errors = [];
    for (const mailbox of query.mailboxes) {
      try {
        results.push(await this.gateway.searchMailbox({
          mailbox,
          from: query.from,
          subject: query.subject,
          text: query.text,
          since: query.since,
          before: query.before,
          beforeUid: query.beforeUidByMailbox?.[mailbox],
          limit: query.limitPerMailbox,
        }));
      } catch (error) {
        errors.push({ mailbox, error: error instanceof Error ? error.message : "Search failed." });
      }
    }
    return { results, errors };
  }

  async saveResearchRecord(input: ResearchInput): Promise<Record<string, unknown>> {
    if (input.kind === "migration" && (!input.currentEmail || !input.targetEmail)) {
      throw new Error("Migration records require currentEmail and targetEmail.");
    }
    const fetched = await this.gateway.fetchMessage(input.uid, 500, input.mailbox);
    const record = await this.state.saveResearch({
      type: "research_record",
      key: `${messageKey(fetched.scope, input.uid)}:${input.kind}`,
      kind: input.kind,
      scope: fetched.scope,
      message: fetched.message,
      organization: input.organization,
      ...(input.note !== undefined && { note: input.note }),
      ...(input.orderNumber && { orderNumber: input.orderNumber }),
      ...(input.orderDate && { orderDate: input.orderDate }),
      ...(input.amount && { amount: input.amount }),
      ...(input.currentEmail && { currentEmail: input.currentEmail }),
      ...(input.targetEmail && { targetEmail: input.targetEmail }),
      ...(input.kind === "migration" && input.status && { status: input.status }),
    });
    return { record };
  }

  async listResearchRecords(kind?: ResearchKind, offset = 0, limit = 50): Promise<Record<string, unknown>> {
    await this.state.load();
    const all = this.state.researchRecords(kind);
    const records = all.slice(offset, offset + limit);
    return { records, total: all.length, nextOffset: offset + records.length < all.length ? offset + records.length : null };
  }

  async updateMigrationStatus(
    key: string,
    status: "to_review" | "updated" | "skipped",
    note: string,
  ): Promise<Record<string, unknown>> {
    return { record: await this.state.updateResearchStatus(key, status, note) };
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
