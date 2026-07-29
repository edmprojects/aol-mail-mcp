import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dataDirectory } from "./config.js";
import { AolImapGateway } from "./mail.js";
import { buildServer } from "./server.js";
import { AolMailService } from "./service.js";
import { StateStore } from "./state.js";

async function main(): Promise<void> {
  const directory = dataDirectory();
  const service = new AolMailService(
    new AolImapGateway(),
    StateStore.atDataDirectory(directory),
    directory,
  );
  await service.initialize();
  const server = buildServer(service);
  await server.connect(new StdioServerTransport());

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`AOL Mail MCP failed to start: ${message}`);
  process.exit(1);
});
