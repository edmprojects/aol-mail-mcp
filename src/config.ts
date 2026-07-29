import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "codex-aol-mail-mcp";
type KeychainExecutor = (
  file: string,
  args: string[],
) => Promise<{ stdout: string | Buffer }>;

export interface AccountConfig {
  account: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "aol-mail-mcp", "config.json");
}

export function dataDirectory(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "aol-mail-mcp");
}

export async function loadConfig(path = configPath()): Promise<AccountConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AccountConfig>;
    if (!parsed.account || !parsed.account.includes("@")) {
      throw new Error("configured account is invalid");
    }
    return { account: parsed.account };
  } catch {
    throw new Error(
      "AOL Mail MCP is not configured. Run scripts/setup-credentials.sh.",
    );
  }
}

export async function loadKeychainPassword(
  account: string,
  executor: KeychainExecutor = execFileAsync,
): Promise<string> {
  try {
    const { stdout } = await executor("/usr/bin/security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    const password = stdout.toString().trimEnd();
    if (!password) {
      throw new Error("empty credential");
    }
    return password;
  } catch {
    throw new Error(
      "AOL app password is unavailable in macOS Keychain. Run scripts/setup-credentials.sh.",
    );
  }
}

export function accountIdentifier(account: string): string {
  return createHash("sha256").update(account.toLowerCase()).digest("hex").slice(0, 12);
}
