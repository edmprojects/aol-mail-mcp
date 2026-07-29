import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dataDirectory } from "./config.js";
import { StateStore } from "./state.js";
import type { LegacyReportEvent } from "./types.js";

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function legacyEvents(content: string): LegacyReportEvent[] {
  const [header = [], ...rows] = parseCsv(content);
  const positions = new Map(header.map((name, index) => [name, index]));
  const required = ["moved_at", "message_date", "sender", "subject", "reason"];
  if (required.some((name) => !positions.has(name))) {
    throw new Error("Legacy CSV is missing required columns.");
  }

  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => {
      const value = (name: string) => row[positions.get(name)!] ?? "";
      const identity = required.map(value).join("\u0000");
      return {
        type: "legacy_report",
        eventId: `legacy-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
        recordedAt: new Date(`${value("moved_at")}T00:00:00-07:00`).toISOString(),
        source: "legacy_ui_log",
        messageDate: value("message_date"),
        sender: value("sender"),
        subject: value("subject"),
        reason: value("reason"),
      };
    });
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    throw new Error("Usage: npm run import-legacy -- /absolute/path/to/log.csv");
  }
  const state = StateStore.atDataDirectory(dataDirectory());
  await state.load();
  const imported = await state.importLegacy(legacyEvents(await readFile(path, "utf8")));
  console.log(JSON.stringify({ imported, path }, null, 2));
}

if (process.argv[1]?.endsWith("import-legacy.js")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown import error";
    console.error(message);
    process.exit(1);
  });
}
