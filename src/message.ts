import { simpleParser } from "mailparser";
import type { MessageSummary } from "./types.js";

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function htmlToText(html: string): string {
  return collapseWhitespace(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

export async function parseMessage(
  uid: number,
  source: Buffer,
  previewLimit: number,
): Promise<MessageSummary> {
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const senderEntry = parsed.from?.value[0];
  const senderAddress = senderEntry?.address ?? "";
  const sender = senderEntry?.name || senderAddress;
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const body = collapseWhitespace(parsed.text ?? "") || htmlToText(html);

  return {
    uid,
    messageId: parsed.messageId ?? "",
    date: parsed.date?.toISOString() ?? "",
    sender,
    senderAddress,
    subject: parsed.subject ?? "",
    preview: body.slice(0, previewLimit),
  };
}
