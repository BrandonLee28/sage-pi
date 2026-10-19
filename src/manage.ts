import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { access, constants, mkdir } from "node:fs/promises";
import { readConfig } from "./config.ts";
import { httpUrl, readSettings, saveSettings, validateServer, type McpServer } from "./settings.ts";
import { connectMcp } from "../extensions/mcp.ts";

export const banner = String.raw`
  ____    _    ____ _____
 / ___|  / \  / ___| ____|
 \___ \ / _ \| |  _|  _|
  ___) / ___ \ |_| | |___
 |____/_/   \_\____|_____|
       your personal assistant
`;
const help = `sage                         Open Pi's conversation TUI
sage setup                   Open the setup menu
sage model [ID] [--url URL]   Choose a model / OpenAI-compatible endpoint
sage model reset             Use .env model defaults again
sage mcp                     Manage MCP servers interactively
sage mcp list                List configured servers
sage mcp add NAME -- COMMAND [ARGS...]
sage mcp add NAME --url URL [--token-env ENV_NAME]
                             Add a server; stdio supports --env ENV_NAME
sage mcp remove NAME         Remove a server
sage mcp test NAME           Connect and list tools without calling them
sage doctor                  Check local setup and model discovery
sage --headless              Run in the background (no TUI)

Settings: DATA_DIR/settings.json. Secrets stay in .env/environment.
Restart Sage after changes; running conversations are updated on restart.`;

async function advertisedModels(baseUrl: string, apiKey: string) {
  const response = await fetch(httpUrl(baseUrl) + "/models", {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Model endpoint returned HTTP ${response.status}.`);
  const body = await response.json() as { data?: { id?: unknown }[] };
  const ids = body.data?.map((item) => item.id).filter((id): id is string => typeof id === "string" && !!id.trim());
  if (!ids?.length) throw new Error("Endpoint advertised no models.");
  return [...new Set(ids)];
}

export async function manage(args: string[]) {
  console.log(banner);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    url: { type: "string" }, env: { type: "string", multiple: true },
    "token-env": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals[0] === "help") { console.log(help); return; }
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = async (prompt: string) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive setup needs a terminal. Run sage --help for direct commands.");
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(prompt)).trim();
  };
  try {
    const config = readConfig();
    const settings = readSettings(config.dataDir);
    let [command, action, ...rest] = positionals;
    if (command === "setup") {
      console.log("  1  Model\n  2  MCP servers\n  3  Diagnose setup\n");
      const choice = await ask("Choose [1–3, Enter to exit]: ");
      if (!choice) return;
      command = ({ "1": "model", "2": "mcp", "3": "doctor" } as Record<string, string>)[choice];
    }
    if (command === "model") {
      if (rest.length) throw new Error("Usage: sage model [ID] [--url URL]");
      if (action === "reset") {
        delete settings.model;
      } else {
        const baseUrl = httpUrl(values.url ?? config.baseUrl);
        let id = action;
        if (!id) {
          console.log(`Current: ${config.modelId}\nEndpoint: ${baseUrl}`);
          const ids = await advertisedModels(baseUrl, config.apiKey);
          ids.forEach((model, index) => console.log(`  ${index + 1}  ${model}`));
          const choice = await ask("Model number or ID [Enter to cancel]: ");
          if (!choice) return;
          id = /^\d+$/.test(choice) ? ids[Number(choice) - 1] : choice;
          if (!id) throw new Error("Choose a listed number or enter a model ID.");
        }
        if (!id.trim()) throw new Error("Model ID cannot be empty.");
        settings.model = { id, baseUrl, revision: randomUUID() };
      }
    } else if (command === "mcp") {
      if (!action) {
        console.log("  1  List\n  2  Add\n  3  Remove\n  4  Test connection\n");
        const choice = await ask("Choose [1–4, Enter to exit]: ");
        if (!choice) return;
        action = ({ "1": "list", "2": "add", "3": "remove", "4": "test" } as Record<string, string>)[choice];
        if (["add", "remove", "test"].includes(action)) rest = [await ask("Server name: ")];
      }
      const servers = settings.mcpServers ??= {};
      if (action === "list") {
        const names = Object.keys(servers);
        console.log(names.length ? names.map((name) => `${name} (${ "url" in servers[name]! ? "HTTP" : "stdio" })`).join("\n") : "No MCP servers. Use sage mcp add NAME -- COMMAND [ARGS...]");
        return;
      }
      const [name, ...serverArgs] = rest;
      if (!name) throw new Error("Provide an MCP server name. Run sage --help.");
      if (action === "add") {
        if (Object.hasOwn(servers, name)) throw new Error("Server already exists; remove it first to replace it.");
        let server: McpServer;
        if (values.url) {
          if (serverArgs.length || values.env?.length) throw new Error("HTTP servers use --url and optionally --token-env.");
          server = { url: httpUrl(values.url), ...(values["token-env"] ? { bearerTokenEnv: values["token-env"] } : {}) };
        } else if (serverArgs.length) {
          if (values["token-env"]) throw new Error("Use --env with stdio servers.");
          server = { command: serverArgs[0]!, args: serverArgs.slice(1), ...(values.env ? { env: values.env } : {}) };
        } else {
          const transport = await ask("Transport [stdio/http]: ");
          if (transport === "http") {
            const url = httpUrl(await ask("Server URL: "));
            const bearerTokenEnv = await ask("Bearer token environment variable [optional]: ");
            server = { url, ...(bearerTokenEnv ? { bearerTokenEnv } : {}) };
          } else if (transport === "stdio") {
            const executable = await ask("Executable: ");
            const args = JSON.parse(await ask('Arguments as a JSON array [e.g. ["-y", "your-package"]]: '));
            const env = (await ask("Environment variable names [comma separated, optional]: ")).split(",").map((key) => key.trim()).filter(Boolean);
            server = { command: executable, args, env };
          } else throw new Error("Choose stdio or http.");
        }
        validateServer(name, server);
        // Adding is configuration only; the user-supplied executable runs at startup/test.
        Object.defineProperty(servers, name, { value: server, enumerable: true, writable: true, configurable: true });
      } else if (action === "remove" || action === "test") {
        if (serverArgs.length) throw new Error("Provide one server name.");
        if (!Object.hasOwn(servers, name)) throw new Error("No MCP server with that name.");
        if (action === "test") {
          const workspace = join(config.dataDir, "workspace");
          await mkdir(workspace, { recursive: true });
          const connection = await connectMcp(name, servers[name]!, workspace, true);
          try { console.log(connection.extension.tools?.map((tool) => tool.name).join("\n") || "Connected; no tools advertised."); }
          finally { await connection.close(); }
          return;
        }
        delete servers[name];
      } else throw new Error("Use sage mcp list, add, remove or test.");
    } else if (command === "doctor") {
      console.log(`Node ${process.versions.node}\nData: ${config.dataDir}\nModel: ${config.modelId}`);
      const ids = await advertisedModels(config.baseUrl, config.apiKey);
      console.log(`Model endpoint reachable: ${ids.length} model(s)`);
      if (!ids.includes(config.modelId)) throw new Error("Selected model is not advertised. Run sage model.");
      try { await access(config.dataDir, constants.R_OK | constants.W_OK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Data directory is not readable/writable."); }
      console.log(`MCP: ${Object.keys(config.mcpServers).length} configured. Use sage mcp test NAME to check a server.\nSetup looks good.`);
      return;
    } else throw new Error("Unknown command. Run sage --help.");
    await saveSettings(config.dataDir, settings);
    console.log("Saved. Restart Sage to apply changes.");
  } finally { rl?.close(); }
}
