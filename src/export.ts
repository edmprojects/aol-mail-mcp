import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionEvent } from "./types.js";

function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function eventRow(event: ActionEvent): Record<string, unknown> {
  if (event.type === "classification") {
    return {
      event_type: event.type,
      recorded_at: event.recordedAt,
      key: event.key,
      uid: event.message.uid,
      sender: event.message.sender,
      sender_address: event.message.senderAddress,
      subject: event.message.subject,
      message_date: event.message.date,
      label: event.label,
      confidence: event.confidence,
      reason: event.reason,
      status: "",
      detail: "",
      source: "codex",
    };
  }
  if (event.type === "report_result") {
    return {
      event_type: event.type,
      recorded_at: event.recordedAt,
      key: event.key,
      uid: "",
      sender: "",
      sender_address: "",
      subject: "",
      message_date: "",
      label: "",
      confidence: "",
      reason: "",
      status: event.status,
      detail: event.detail,
      source: "codex",
    };
  }
  return {
    event_type: event.type,
    recorded_at: event.recordedAt,
    key: "",
    uid: "",
    sender: event.sender,
    sender_address: "",
    subject: event.subject,
    message_date: event.messageDate,
    label: "spam",
    confidence: "",
    reason: event.reason,
    status: "reported",
    detail: "",
    source: event.source,
  };
}

export async function exportEvents(
  directory: string,
  events: ActionEvent[],
  format: "jsonl" | "csv",
): Promise<string> {
  const exportDirectory = join(directory, "exports");
  await mkdir(exportDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const path = join(exportDirectory, `aol-mail-actions-${timestamp}.${format}`);

  let content: string;
  if (format === "jsonl") {
    content = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  } else {
    const rows = events.map(eventRow);
    const headers = [
      "event_type",
      "recorded_at",
      "key",
      "uid",
      "sender",
      "sender_address",
      "subject",
      "message_date",
      "label",
      "confidence",
      "reason",
      "status",
      "detail",
      "source",
    ];
    content =
      headers.map(csvCell).join(",") +
      "\n" +
      rows
        .map((row) => headers.map((header) => csvCell(row[header])).join(","))
        .join("\n") +
      "\n";
  }
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

export { csvCell };
