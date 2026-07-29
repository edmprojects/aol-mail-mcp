import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Candidate,
  ClassificationEvent,
  ClassificationLabel,
  LegacyReportEvent,
  MailboxScope,
  MessageSummary,
  ReportEvent,
  ReportStatus,
  StateEvent,
} from "./types.js";

export function messageKey(scope: MailboxScope, uid: number): string {
  return `${scope.accountId}:${scope.mailbox}:${scope.uidValidity}:${uid}`;
}

export class StateStore {
  private static readonly lockTimeoutMs = 5_000;
  private static readonly ownerlessLockMs = 1_000;
  private readonly classifications = new Map<string, ClassificationEvent>();
  private readonly reports = new Map<string, ReportEvent>();
  private readonly legacyReports: LegacyReportEvent[] = [];

  constructor(private readonly path: string) {}

  static atDataDirectory(directory: string): StateStore {
    return new StateStore(join(directory, "events.jsonl"));
  }

  /**
   * Rebuilds this process's index after all writes completed by other MCP
   * processes. The filesystem lock also serializes recovery of a partial line.
   */
  async load(): Promise<void> {
    await this.withLock(() => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<void> {
    this.classifications.clear();
    this.reports.clear();
    this.legacyReports.length = 0;
    let content = "";
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        this.apply(JSON.parse(line) as StateEvent);
      } catch {
        const isFinalNonEmptyLine = index === lines.length - 1 && !content.endsWith("\n");
        if (!isFinalNonEmptyLine) {
          throw new Error(`Invalid state event at line ${index + 1}`);
        }
        await truncate(this.path, content.lastIndexOf("\n") + 1);
      }
    }
  }

  /**
   * Coordinates state access across independently spawned Codex MCP processes.
   * An abandoned lock is recoverable after the bounded write window expires.
   */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    const deadline = Date.now() + StateStore.lockTimeoutMs;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

    while (Date.now() < deadline) {
      const owner = { pid: process.pid, token: randomUUID() };
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const existingOwner = await this.readLockOwner(ownerPath);
        if (existingOwner && !this.isProcessAlive(existingOwner.pid)) {
          await this.removeLockOwnedBy(lockPath, existingOwner.token);
          continue;
        }
        if (!existingOwner && await this.isOwnerlessLockExpired(lockPath)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await delay(25);
        continue;
      }

      try {
        await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      try {
        return await operation();
      } finally {
        await this.removeLockOwnedBy(lockPath, owner.token);
      }
    }
    throw new Error("Timed out waiting for the AOL Mail state lock.");
  }

  private async readLockOwner(
    ownerPath: string,
  ): Promise<{ pid: number; token: string } | undefined> {
    try {
      const value = JSON.parse(await readFile(ownerPath, "utf8")) as {
        pid?: unknown;
        token?: unknown;
      };
      if (
        typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        value.pid > 0 &&
        typeof value.token === "string" &&
        value.token.length > 0
      ) {
        return { pid: value.pid, token: value.token };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    return undefined;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async isOwnerlessLockExpired(lockPath: string): Promise<boolean> {
    try {
      const lock = await stat(lockPath);
      return Date.now() - lock.mtimeMs > StateStore.ownerlessLockMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async removeLockOwnedBy(lockPath: string, token: string): Promise<void> {
    const owner = await this.readLockOwner(join(lockPath, "owner.json"));
    if (owner?.token === token) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private apply(event: StateEvent): void {
    if (event.type === "classification") {
      this.classifications.set(event.key, event);
    } else if (event.type === "report_result") {
      this.reports.set(event.key, event);
    } else if (
      !this.legacyReports.some((existing) => existing.eventId === event.eventId)
    ) {
      this.legacyReports.push(event);
    }
  }

  private async appendUnlocked(events: StateEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(
        events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    events.forEach((event) => this.apply(event));
  }

  hasClassification(scope: MailboxScope, uid: number): boolean {
    return this.classifications.has(messageKey(scope, uid));
  }

  async saveClassifications(
    scope: MailboxScope,
    decisions: Array<{
      message: MessageSummary;
      label: ClassificationLabel;
      confidence: number;
      reason: string;
    }>,
  ): Promise<void> {
    await this.withLock(async () => {
      await this.loadUnlocked();
      const now = new Date().toISOString();
      const events: ClassificationEvent[] = decisions.map((decision) => ({
        type: "classification",
        eventId: randomUUID(),
        recordedAt: now,
        key: messageKey(scope, decision.message.uid),
        scope,
        ...decision,
      }));
      await this.appendUnlocked(events);
    });
  }

  async recordReportResults(
    results: Array<{ key: string; status: ReportStatus; detail: string }>,
  ): Promise<void> {
    await this.withLock(async () => {
      await this.loadUnlocked();
      for (const result of results) {
        const classification = this.classifications.get(result.key);
        if (!classification || classification.label !== "spam") {
          throw new Error(`Unknown spam candidate key: ${result.key}`);
        }
      }
      const now = new Date().toISOString();
      const events: ReportEvent[] = results
        .filter((result) => {
          const existing = this.reports.get(result.key);
          return !(
            existing?.status === "reported" &&
            result.status === "reported"
          );
        })
        .map((result) => ({
          type: "report_result",
          eventId: randomUUID(),
          recordedAt: now,
          ...result,
        }));
      await this.appendUnlocked(events);
    });
  }

  async importLegacy(events: LegacyReportEvent[]): Promise<number> {
    return this.withLock(async () => {
      await this.loadUnlocked();
      const existing = new Set(this.legacyReports.map((event) => event.eventId));
      const fresh = events.filter((event) => !existing.has(event.eventId));
      await this.appendUnlocked(fresh);
      return fresh.length;
    });
  }

  candidates(
    scope: MailboxScope,
    beforeUid?: number,
    limit = 25,
    uids?: number[],
  ): Candidate[] {
    const uidFilter = uids ? new Set(uids) : undefined;
    return [...this.classifications.values()]
      .filter((event) => {
        if (event.label !== "spam") {
          return false;
        }
        if (
          event.scope.accountId !== scope.accountId ||
          event.scope.mailbox !== scope.mailbox ||
          event.scope.uidValidity !== scope.uidValidity
        ) {
          return false;
        }
        if (uidFilter && !uidFilter.has(event.message.uid)) {
          return false;
        }
        if (beforeUid !== undefined && event.message.uid >= beforeUid) {
          return false;
        }
        const status = this.reports.get(event.key)?.status;
        return status !== "reported" && status !== "skipped";
      })
      .sort((a, b) => b.message.uid - a.message.uid)
      .slice(0, limit)
      .map((event) => ({
        key: event.key,
        uid: event.message.uid,
        sender: event.message.sender,
        senderAddress: event.message.senderAddress,
        subject: event.message.subject,
        date: event.message.date,
        confidence: event.confidence,
        reason: event.reason,
      }));
  }

  counts(scope?: MailboxScope): {
    classified: Record<ClassificationLabel, number>;
    pendingCandidates: number;
    reported: number;
    legacyReported: number;
  } {
    const classifications = [...this.classifications.values()].filter(
      (event) =>
        !scope ||
        (event.scope.accountId === scope.accountId &&
          event.scope.mailbox === scope.mailbox &&
          event.scope.uidValidity === scope.uidValidity),
    );
    const classified: Record<ClassificationLabel, number> = {
      spam: 0,
      not_spam: 0,
      uncertain: 0,
    };
    classifications.forEach((event) => {
      classified[event.label] += 1;
    });
    const candidateKeys = classifications
      .filter((event) => event.label === "spam")
      .map((event) => event.key);
    return {
      classified,
      pendingCandidates: candidateKeys.filter(
        (key) => {
          const status = this.reports.get(key)?.status;
          return status !== "reported" && status !== "skipped";
        },
      ).length,
      reported: candidateKeys.filter(
        (key) => this.reports.get(key)?.status === "reported",
      ).length,
      legacyReported: this.legacyReports.length,
    };
  }

  allEvents(): StateEvent[] {
    return [
      ...this.classifications.values(),
      ...this.reports.values(),
      ...this.legacyReports,
    ].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
}
