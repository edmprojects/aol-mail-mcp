# AOL Mail Codex plugin

Local, read-only AOL IMAP tools for searching Inbox mail and triaging unread messages. Mail credentials and triage data stay outside this repository. The credential setup uses macOS Keychain, so this plugin currently requires macOS.

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

`search_messages` searches read and unread Inbox mail using a required `field` (`from`, `subject`, or `text`) and `term`. `get_any_message` reads one exact Inbox UID. Both open IMAP read-only and preserve read state. Existing unread triage and approval-gated spam logging remain separate.
