#!/bin/zsh
set -euo pipefail

config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/aol-mail-mcp"
config_path="$config_dir/config.json"

read "account?AOL email address: "
if [[ "$account" != *@* ]]; then
  print -u2 "Enter a complete AOL email address."
  exit 1
fi

umask 077
mkdir -p "$config_dir"
node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ account: process.argv[2] }, null, 2) + "\n", { mode: 0o600 });
' "$config_path" "$account"
chmod 600 "$config_path"

print "macOS Keychain will now prompt for the AOL app password."
security add-generic-password \
  -a "$account" \
  -s "codex-aol-mail-mcp" \
  -l "Codex AOL Mail MCP" \
  -U \
  -w

print "AOL Mail MCP credentials configured."
