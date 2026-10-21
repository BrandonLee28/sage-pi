import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readSettings, saveSettings } from "../src/settings.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("CLI manages models and MCP without opening a conversation or running a server", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-cli-"));
  const run = (...args: string[]) => exec(process.execPath, [cli, ...args], {
    env: { ...process.env, DATA_DIR: dataDir, GATEWAY_TOKEN: "", GATEWAY_URL: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", LLM_BASE_URL: "http://127.0.0.1:1/v1" }, timeout: 15000,
  });
  try {
    const help = (await run("--help")).stdout;
    assert.match(help, /sage[\s\S]*sage model/);
    assert.doesNotMatch(help, /\x1b\[/);
    await run("model", "other-model", "--url", "http://127.0.0.1:1/v1");
    let settings = readSettings(dataDir);
    assert.equal(settings.model?.id, "other-model");
    assert.equal(settings.model?.baseUrl, "http://127.0.0.1:1/v1");
    await run("mcp", "add", "local", "--env", "TEST_TOKEN", "--", "does-not-exist", "--flag", "a b");
    assert.deepEqual(readSettings(dataDir).mcpServers?.local, { command: "does-not-exist", args: ["--flag", "a b"], env: ["TEST_TOKEN"] });
    await run("mcp", "add", "remote", "--url", "https://example.invalid/mcp", "--token-env", "MCP_TOKEN");
    assert.match((await run("mcp", "list")).stdout, /local \(stdio\)[\s\S]*remote \(HTTP\)/);
    await assert.rejects(run("mcp", "add", "local", "--", "replacement"), /Server already exists/);
    await assert.rejects(run("mcp", "add", "bad name", "--", "node"), /Server names/);
    await assert.rejects(run("model", "bad", "--url", "file:///tmp"), /HTTP/);
    await assert.rejects(run("modle"), /Unknown command/);
    await assert.rejects(run("model"), /Interactive setup needs a terminal|fetch failed/);
    await assert.rejects(run("gateway"), /GATEWAY_TOKEN/);
    await assert.rejects(run("connect", "http://127.0.0.1:1"), /needs a local terminal/);
    await run("mcp", "remove", "local");
    await run("model", "reset");
    settings = readSettings(dataDir);
    assert.equal(settings.model, undefined);
    assert.equal(settings.mcpServers?.local, undefined);
    assert.ok(settings.mcpServers?.remote);
    await assert.rejects(readFile(join(dataDir, "agent.sqlite")), { code: "ENOENT" });
    await writeFile(join(dataDir, "settings.json"), "broken json");
    await assert.rejects(run("model", "anything"), /Cannot read settings.json/);
    assert.equal(await readFile(join(dataDir, "settings.json"), "utf8"), "broken json");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("doctor checks model discovery against a local mock and reports failures", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sage-doctor-"));
  let valid = true;
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: valid ? [{ id: "test-model" }] : [] }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await saveSettings(dataDir, { model: { id: "test-model", baseUrl: `http://127.0.0.1:${address.port}/v1`, revision: "test" } });
  const run = () => exec(process.execPath, [cli, "doctor"], {
    env: { ...process.env, DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }, timeout: 15000,
  });
  try {
    assert.match((await run()).stdout, /Setup looks good/);
    valid = false;
    await assert.rejects(run(), /Endpoint advertised no models/);
  } finally { server.close(); await rm(dataDir, { recursive: true, force: true }); }
});
