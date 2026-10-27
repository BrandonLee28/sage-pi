import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, access, chmod, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readSettings, saveSettings } from "../src/settings.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("installer links Sage on PATH and refuses to overwrite an installation", async () => {
  const home = await mkdtemp(join(tmpdir(), "sage-install-"));
  const commands = join(home, "commands");
  try {
    await mkdir(commands);
    await writeFile(join(commands, "git"), '#!/bin/sh\nfor arg do target="$arg"; done\nmkdir -p "$target/bin"\nprintf "fixture" > "$target/bin/sage.mjs"\n');
    await writeFile(join(commands, "npm"), "#!/bin/sh\nexit 0\n");
    for (const name of ["git", "npm"]) await chmod(join(commands, name), 0o755);
    await writeFile(join(home, ".zshrc"), "# existing settings\n");
    const env = { ...process.env, HOME: home, PATH: `${commands}:${process.env.PATH}` };
    const script = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
    await exec("sh", [script], { env });
    assert.equal(await readlink(join(home, ".local/bin/sage")), join(home, ".local/share/sage/bin/sage.mjs"));
    assert.match(await readFile(join(home, ".zshrc"), "utf8"), /# existing settings[\s\S]*export PATH="\$HOME\/\.local\/bin:\$PATH"/);
    await assert.rejects(exec("sh", [script], { env }), /already exists/);
    assert.equal(await readFile(join(home, ".local/share/sage/bin/sage.mjs"), "utf8"), "fixture");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("update pulls the managed checkout and propagates failures without opening storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sage-update-"));
  const log = join(directory, "args"), server = join(directory, "server");
  const managed = join(directory, ".local", "share", "sage", "src");
  try {
    await mkdir(managed, { recursive: true });
    for (const name of ["cli.ts", "settings.ts"]) await writeFile(join(managed, name), await readFile(new URL(`../src/${name}`, import.meta.url)));
    for (const command of ["git", "npm"]) {
      await writeFile(join(directory, command), `#!/bin/sh\nprintf '${command} %s\\n' "$*" >> "$SAGE_TEST_ARGS"\nexit "\${SAGE_TEST_EXIT:-0}"\n`);
      await chmod(join(directory, command), 0o755);
    }
    const env = { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, SAGE_TEST_ARGS: log, DATA_DIR: server, CLIENT_DATA_DIR: join(directory, "client") };
    const installedCli = join(managed, "cli.ts");
    await exec(process.execPath, [installedCli, "update"], { env });
    assert.equal(await readFile(log, "utf8"), "git pull --ff-only\nnpm ci --omit=dev\n");
    await writeFile(log, "");
    await assert.rejects(exec(process.execPath, [installedCli, "update"], { env: { ...env, SAGE_TEST_EXIT: "7" } }), { code: 7 });
    assert.doesNotMatch(await readFile(log, "utf8"), /npm/);
    await assert.rejects(exec(process.execPath, [cli, "update"], { env }), /managed installation/);
    await assert.rejects(exec(process.execPath, [installedCli, "update", "extra"], { env }), /Usage: sage update/);
    await assert.rejects(access(server), { code: "ENOENT" });
    await assert.rejects(access(env.CLIENT_DATA_DIR), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Mac voice model setup persists beside the connection without opening server storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sage-client-voice-"));
  const client = join(directory, "client"), server = join(directory, "server");
  const model = join(directory, "speech model");
  const run = (...args: string[]) => exec(process.execPath, [cli, "voice", ...args], {
    env: { ...process.env, CLIENT_DATA_DIR: client, DATA_DIR: server },
  });
  try {
    await saveSettings(client, { gateway: { url: "http://localhost:8787", token: "test-token".repeat(4) } });
    await mkdir(model);
    await assert.rejects(run("model", model), /missing config.json/);
    for (const name of ["config.json", "tokenizer.json", "model.q8.gguf", "default-voice.safetensors"])
      await writeFile(join(model, name), "fixture");
    await run("model", model);
    assert.equal(readSettings(client).voice?.ttsModel, model);
    assert.equal(readSettings(client).gateway?.url, "http://localhost:8787");
    await run("model", "hf://gradium/phonon-40m-en");
    assert.equal(readSettings(client).voice?.ttsModel, "hf://gradium/phonon-40m-en");
    await assert.rejects(run("model"), /Usage/);
    await assert.rejects(access(server), { code: "ENOENT" });
    await writeFile(join(client, "settings.json"), JSON.stringify({ voice: { ttsModel: 42 } }));
    assert.throws(() => readSettings(client), /Invalid saved voice model/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("client launch ignores server dotenv configuration and all normal npm commands use the same launcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sage-client-launch-"));
  try {
    const launcher = await readFile(new URL("../bin/sage.mjs", import.meta.url), "utf8");
    await mkdir(join(directory, "bin")); await mkdir(join(directory, "src"));
    await writeFile(join(directory, "bin", "sage.mjs"), launcher);
    await writeFile(join(directory, "src", "cli.ts"), 'console.log(process.env.SAGE_TEST_SERVER_ENV ?? "not-loaded");');
    await writeFile(join(directory, ".env"), "SAGE_TEST_SERVER_ENV=server-only\n");
    const env = { ...process.env }; delete env.SAGE_TEST_SERVER_ENV;
    for (const args of [[], ["connect"], ["setup"]]) {
      assert.equal((await exec(process.execPath, [join(directory, "bin", "sage.mjs"), ...args], { env })).stdout.trim(), "not-loaded");
    }
    assert.equal((await exec(process.execPath, [join(directory, "bin", "sage.mjs"), "gateway"], { env })).stdout.trim(), "server-only");
    const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const name of ["sage", "start", "dev"]) assert.equal(scripts[name], "node bin/sage.mjs");
    assert.equal(scripts.connect, "node bin/sage.mjs connect");
    assert.equal(scripts["voice:try"], scripts.connect);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unconfigured client startup never creates a local workspace or database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sage-client-empty-"));
  try {
    const server = join(directory, "server"), client = join(directory, "client");
    for (const args of [[], ["connect"], ["setup"]]) {
      await assert.rejects(exec(process.execPath, [cli, ...args], { env: {
        ...process.env, DATA_DIR: server, CLIENT_DATA_DIR: client, GATEWAY_URL: "", GATEWAY_TOKEN: "",
        TELEGRAM_BOT_TOKEN: "invalid-unpaired-server-setting", TELEGRAM_CHAT_ID: "",
      } }), /needs a local terminal/);
    }
    await assert.rejects(access(server), { code: "ENOENT" });
    await assert.rejects(access(client), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
