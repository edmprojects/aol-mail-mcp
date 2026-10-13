# AOL Mail Codex plugin

Local AOL tools for read-only mail search, receipt research, account migration notes, and unread Inbox triage. The only writes are to private local records; the plugin never changes AOL mail or external accounts. Mail credentials and local data stay outside this repository. The credential setup uses macOS Keychain, so this plugin currently requires macOS.

## Development

```sh
npm ci
npm test
```

## Install from a clone

Run `npm ci` and `npm run build` in the clone, then register it as a local Codex marketplace and install the plugin:

```sh
codex plugin marketplace add /absolute/path/to/aol-mail
codex plugin add aol-mail@aol-mail-local
./scripts/setup-credentials.sh
```

The setup script stores the AOL address in the user's config directory and the app password in macOS Keychain. Neither is saved in this repository. Codex may need a new session to expose newly added MCP tools.

If the clone is already registered under a different marketplace name, refresh that installed copy with `codex plugin add aol-mail@<marketplace-name>`.

`list_mailboxes` returns selectable folder paths. `search_messages` searches read and unread mail in one folder using a required `field` (`from`, `subject`, or `text`) and `term`; omit `mailbox` for Inbox. Use `beforeUid` to page older results in the same folder. `get_any_message` reads one exact UID in a chosen folder. All reads preserve read state. Existing unread Inbox triage and approval-gated spam logging remain separate.

`search_across_mailboxes` searches up to five selected folders using combined sender, subject, and text filters. It returns independent results and cursors per folder. `get_message_details` returns sanitized text plus attachment metadata; message source is capped at 256 KiB, and attachment content is not returned. For a selected message, `save_research_record` stores receipt details or an account migration item under the private local data directory. `list_research_records` pages through saved findings, and `update_migration_status` updates a local queue item even if the source mail moved. Saved records include a mailbox, UID, UIDVALIDITY, and Message-ID as a source reference; IMAP UIDs are not Webmail URLs. Extracted details are review notes, not verified account changes.

## Inbox cleanup research

`list_mailbox_details` returns selectable IMAP paths and special-use labels. Confirm which path corresponds to AOL Webmail's native Spam folder before using `review_spam_folder` or `verify_spam_reports`; a custom folder named Spam may be different. `review_spam_folder` pages through that folder and labels messages matching the local reported log by Message-ID. It preserves unread state. `save_spam_review` records local spam, false-positive, or uncertain verdicts for exact folder messages without moving them.

For native spam reporting, `list_spam_candidates` now includes Message-ID, and `prepare_spam_reports` refreshes exact selected candidates against Inbox before Webmail matching. Use AOL Webmail's Spam button for the approved exact messages. `verify_spam_reports` checks whether each Message-ID left Inbox and appeared in the selected Spam folder. That check proves location only: a manual move could produce the same result. Use `record_report_results` with `reported` only after visible Webmail confirmation of the native Spam action.

`group_recent_senders` samples a bounded page of read and unread mail and groups exact sender addresses for newsletter and migration research. `get_message_details` also returns `List-Unsubscribe` mailto/HTTPS targets and the one-click header indicator. Those targets are untrusted data; the plugin never opens them or unsubscribes. `recommend_filters` groups repeated local spam classifications by exact address as suggestions. Inspect account-related mail and mixed-purpose senders before creating any AOL filter. These tools do not change AOL mail or accounts.

`list_inbox_batch` pages through read and unread Inbox messages from a chosen date range. `since` is inclusive, `before` is exclusive, and `nextBeforeUid` advances through scanned messages even when all were already classified. Use `get_any_message` for a longer preview of either kind. `save_classifications` accepts both read and unread Inbox messages; pass the batch's `scope.uidValidity` as `expectedUidValidity` and each selected message's `messageId` to reject stale selections. Classification remains a private local record and never changes AOL's read state.
