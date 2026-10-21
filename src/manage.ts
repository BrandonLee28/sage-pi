import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { access, constants, mkdir } from "node:fs/promises";
import { readConfig } from "./config.ts";
import { httpUrl, readSettings, saveSettings, validateServer, type McpServer } from "./settings.ts";
import { connectMcp } from "../extensions/mcp.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { SageHeader, registerSageTheme, selectOption, textPrompt } from "./cli-ui.ts";
const help = `sage                         Open the gateway TUI (first run asks for connection)
sage setup                   Configure/connect to the gateway
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
sage --headless              Alias for sage gateway (server only)
sage gateway                 Run the persistent gateway (LAN/Tailscale API)
sage connect [URL]           Connect and remember a gateway; prompt for token once
sage connect --forget        Remove the saved client connection
sage voice model PATH        Remember the Mac speech model folder (or hf:// URL)

Settings: DATA_DIR/settings.json. Secrets stay in .env/environment.
Client connection/token: CLIENT_DATA_DIR/settings.json (default ~/.sage), owner-only.
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
  registerSageTheme();
  const header = new SageHeader();
  const printHeader = () => console.log(header.render(process.stdout.columns ?? 80).map((row) => process.stdout.isTTY && !process.env.NO_COLOR ? row : stripTerminalSequences(row)).join("\n"));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    url: { type: "string" }, env: { type: "string", multiple: true },
    "token-env": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals[0] === "help") { printHeader(); console.log(help); return; }
  const cancelled = Symbol("cancelled");
  const ask = async (prompt: string) => {
    const result = await textPrompt(header, prompt);
    if (result === undefined) throw cancelled;
    return result;
  };
  try {
    const config = readConfig();
    const settings = readSettings(config.dataDir);
    header.details = { model: config.modelId, cwd: join(config.dataDir, "workspace"), section: "Setup" };
    let [command, action, ...rest] = positionals;
    if (command === "model") {
      if (rest.length) throw new Error("Usage: sage model [ID] [--url URL]");
      if (action === "reset") {
        delete settings.model;
      } else {
        const baseUrl = httpUrl(values.url ?? config.baseUrl);
        let id = action;
        if (!id) {
          header.details.section = "Models";
          const ids = await advertisedModels(baseUrl, config.apiKey);
          const choices = ids.map((id) => ({ value: id, label: id, description: id === config.modelId ? "Current model" : "Available" }));
          const custom = "\0custom";
          const choice = await selectOption(header, "Select a model", [...choices, { value: custom, label: "Enter a model ID…", description: "Configure a model manually" }], baseUrl, config.modelId);
          if (choice === undefined) return;
          id = choice === custom ? await ask("Model ID") : choice;
        }
        if (!id.trim()) throw new Error("Model ID cannot be empty.");
        settings.model = { id, baseUrl, revision: randomUUID() };
      }
    } else if (command === "mcp") {
      header.details.section = "MCP servers";
      if (!action) {
        const choice = await selectOption(header, "Manage MCP servers", [
          { value: "list", label: "Configured servers", description: "Show saved connections" },
          { value: "add", label: "Add a server", description: "Connect stdio or HTTP tools" },
          { value: "test", label: "Test a connection", description: "Check a server and list its tools" },
          { value: "remove", label: "Remove a server", description: "Delete a saved connection" },
        ]);
        if (choice === undefined) return;
        action = choice;
        if (action === "add") rest = [await ask("Name this server")];
        if (action === "remove" || action === "test") {
          const names = Object.keys(settings.mcpServers ?? {});
          if (!names.length) { console.log("No MCP servers configured. Use sage mcp to add one."); return; }
          const name = await selectOption(header, "Select a server", names.map((name) => ({ value: name, label: name })));
          if (name === undefined) return;
          rest = [name];
        }
      }
      const servers = settings.mcpServers ??= {};
      if (action === "list") {
        printHeader();
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
          const transport = await selectOption(header, "How does this server connect?", [
            { value: "stdio", label: "Local process", description: "Run a command over stdio" },
            { value: "http", label: "Remote server", description: "Connect to a Streamable HTTP URL" },
          ]);
          if (transport === undefined) return;
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
      header.details.section = "Diagnostics";
      printHeader();
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
  } catch (error) { if (error !== cancelled) throw error; }
}
