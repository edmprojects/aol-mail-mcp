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
