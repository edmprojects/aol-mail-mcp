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

  async listMailboxDetails(): Promise<Record<string, unknown>> {
    return { mailboxes: await this.gateway.listMailboxDetails() };
  }

  async reviewSpamFolder(mailbox: string, limit = 25, beforeUid?: number): Promise<Record<string, unknown>> {
    const page = await this.gateway.listRecent(mailbox, limit, beforeUid);
    await this.state.load();
    const reportedIds = new Set(this.state.reportedMessages(page.scope.accountId)
      .map(({ message }) => message.messageId).filter(Boolean));
    return {
      ...page,
      messages: page.messages.map((message) => ({
        ...message,
        locallyReported: Boolean(message.messageId && reportedIds.has(message.messageId)),
        review: this.state.spamReview(page.scope, message.uid)?.verdict ?? null,
      })),
    };
  }

  async saveSpamReview(
    mailbox: string,
    uid: number,
    verdict: "spam" | "false_positive" | "uncertain",
    note: string,
  ): Promise<Record<string, unknown>> {
    if (mailbox === "INBOX") throw new Error("Choose a Spam folder message.");
    const fetched = await this.gateway.fetchMessage(uid, 500, mailbox);
    return { review: await this.state.saveSpamReview(fetched.scope, fetched.message, verdict, note) };
  }

  async senderGroups(mailbox: string, limit = 100, beforeUid?: number, since?: string): Promise<Record<string, unknown>> {
    const page = await this.gateway.listRecent(mailbox, limit, beforeUid, since);
    const groups = new Map<string, { count: number; latestDate: string; subjects: string[]; uids: number[] }>();
    for (const message of page.messages) {
      const address = message.senderAddress.trim().toLowerCase();
      if (!address) continue;
      const group = groups.get(address) ?? { count: 0, latestDate: message.date, subjects: [], uids: [] };
      group.count++;
      if (message.date > group.latestDate) group.latestDate = message.date;
      if (group.subjects.length < 3 && !group.subjects.includes(message.subject)) group.subjects.push(message.subject);
      group.uids.push(message.uid);
      groups.set(address, group);
    }
    return {
      scope: page.scope,
      sampled: page.messages.length,
      nextBeforeUid: page.nextBeforeUid,
      groups: [...groups.entries()].map(([senderAddress, group]) => ({ senderAddress, ...group }))
        .sort((a, b) => b.count - a.count || a.senderAddress.localeCompare(b.senderAddress)),
    };
  }

  async filterRecommendations(minimumSpam = 3): Promise<Record<string, unknown>> {
    const snapshot = await this.gateway.snapshot();
    await this.state.load();
    return {
      scope: snapshot.scope,
      basis: "Current Inbox's local Codex classifications only; no AOL filter has been created.",
      recommendations: this.state.filterRecommendations(snapshot.scope, minimumSpam),
    };
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

  async prepareSpamReports(keys: string[]): Promise<Record<string, unknown>> {
    const snapshot = await this.gateway.snapshot();
    await this.state.load();
    const candidates = [];
    for (const key of keys) {
      const candidate = this.state.candidateByKey(key);
      if (!candidate || key !== messageKey(snapshot.scope, candidate.uid)) {
        throw new Error(`Unknown current Inbox spam candidate: ${key}`);
      }
      try {
        const fetched = await this.gateway.fetchMessage(candidate.uid, 500);
        const matches = Boolean(candidate.messageId) &&
          fetched.scope.uidValidity === snapshot.scope.uidValidity &&
          fetched.message.messageId === candidate.messageId &&
          fetched.message.senderAddress === candidate.senderAddress &&
          fetched.message.subject === candidate.subject &&
          fetched.message.date === candidate.date;
        candidates.push({ ...candidate, ready: matches, note: matches ? "" : "Inbox message changed or UID was reused." });
      } catch {
        candidates.push({ ...candidate, ready: false, note: "Message is no longer accessible in Inbox." });
      }
    }
    return { scope: snapshot.scope, candidates };
  }

  async verifySpamReports(keys: string[], spamMailbox: string): Promise<Record<string, unknown>> {
    if (spamMailbox === "INBOX") throw new Error("Choose the verified AOL Spam mailbox.");
    const snapshot = await this.gateway.snapshot();
    await this.state.load();
    const results = [];
    for (const key of keys) {
      const candidate = this.state.candidateByKey(key);
      if (!candidate || key !== messageKey(snapshot.scope, candidate.uid) || !candidate.messageId) {
        throw new Error(`Unknown current Inbox spam candidate with Message-ID: ${key}`);
      }
      const [inbox, spam] = await Promise.all([
        this.gateway.findMessageId("INBOX", candidate.messageId),
        this.gateway.findMessageId(spamMailbox, candidate.messageId),
      ]);
      const inInbox = inbox.messages.length > 0;
      const spamMatches = spam.messages.filter((message) =>
        message.senderAddress === candidate.senderAddress &&
        message.subject === candidate.subject && message.date === candidate.date);
      results.push({
        key,
        verified: !inInbox && spamMatches.length === 1,
        inInbox,
        spamUids: spamMatches.map((message) => message.uid),
      });
    }
    return {
      spamMailbox,
      results,
      note: "IMAP location confirms the move, not whether AOL's native Report Spam button was used. Record that action only after visible Webmail confirmation.",
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
