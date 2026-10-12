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

export interface MailSearch {
  mailbox?: string;
  field: "from" | "subject" | "text";
  term: string;
  since?: string;
  before?: string;
  beforeUid?: number;
  limit: number;
}

export interface MailCriteriaSearch {
  mailbox: string;
  from?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  beforeUid?: number;
  limit: number;
}

export interface MultiMailboxSearch {
  mailboxes: string[];
  from?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  beforeUidByMailbox?: Record<string, number>;
  limitPerMailbox: number;
}

export interface AttachmentMetadata {
  filename: string;
  contentType: string;
  size: number | null;
  disposition: string;
}

export interface MessageDetails extends MessageSummary {
  attachments: AttachmentMetadata[];
  sourceTruncated: boolean | null;
}

export type ResearchKind = "receipt" | "migration";

export interface ResearchInput {
  kind: ResearchKind;
  mailbox?: string;
  uid: number;
  organization: string;
  note?: string;
  orderNumber?: string;
  orderDate?: string;
  amount?: string;
  currentEmail?: string;
  targetEmail?: string;
  status?: "to_review" | "updated" | "skipped";
}

export interface ResearchRecord {
  type: "research_record";
  eventId: string;
  recordedAt: string;
  key: string;
  kind: ResearchKind;
  scope: MailboxScope;
  message: MessageSummary;
  organization: string;
  note: string;
  orderNumber?: string;
  orderDate?: string;
  amount?: string;
  currentEmail?: string;
  targetEmail?: string;
  status?: "to_review" | "updated" | "skipped";
}

export interface MailboxScope {
  accountId: string;
  mailbox: string;
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

export type ActionEvent = ClassificationEvent | ReportEvent | LegacyReportEvent;
export type StateEvent = ActionEvent | ResearchRecord;

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
