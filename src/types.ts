export type ClassificationLabel = "spam" | "not_spam" | "uncertain";
export type ReportStatus = "reported" | "failed" | "skipped";

export interface MessageSummary {
  uid: number;
  messageId: string;
  date: string;
  sender: string;
  senderAddress: string;
  subject: string;
  preview: string;
}

export interface MailboxScope {
  accountId: string;
  mailbox: "INBOX";
  uidValidity: string;
}

export interface ClassificationEvent {
  type: "classification";
  eventId: string;
  recordedAt: string;
  key: string;
  scope: MailboxScope;
  message: MessageSummary;
  label: ClassificationLabel;
  confidence: number;
  reason: string;
}

export interface ReportEvent {
  type: "report_result";
  eventId: string;
  recordedAt: string;
  key: string;
  status: ReportStatus;
  detail: string;
}

export interface LegacyReportEvent {
  type: "legacy_report";
  eventId: string;
  recordedAt: string;
  source: "legacy_ui_log";
  messageDate: string;
  sender: string;
  subject: string;
  reason: string;
}

export type StateEvent = ClassificationEvent | ReportEvent | LegacyReportEvent;

export interface Candidate {
  key: string;
  uid: number;
  sender: string;
  senderAddress: string;
  subject: string;
  date: string;
  confidence: number;
  reason: string;
}
