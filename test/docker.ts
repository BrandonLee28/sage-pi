// Opt-in local Docker smoke test. Only disposable containers, mock inference, and fresh volumes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { connectGateway } from "../src/gateway-client.ts";

const exec = promisify(execFile);
const docker = async (...args: string[]) => (await exec("docker", args, { timeout: 240000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const prefix = `sage-smoke-${randomUUID().slice(0, 8)}`;
const gateway = prefix + "-gateway", model = prefix + "-model", desktop = prefix + "-desktop";
const data = prefix + "-data", home = prefix + "-home";
const token = "disposable-gateway-smoke-token-00000000", cuaToken = "disposable-desktop-smoke-token-00000000";
const image = process.env.SAGE_TEST_IMAGE ?? "sage-pi-gateway:local";
const cuaImage = "ghcr.io/trycua/linux:24.04-slim@sha256:5f45887ef1db1c5dd35dabf5482bfad58986f0fa37115c7ad52d14f7d1452291";
let remote: Awaited<ReturnType<typeof connectGateway>> | undefined;
async function until(check: () => Promise<boolean>, label: string, attempts = 180) {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await pause(1000); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await docker("image", "inspect", image);
  await docker("network", "create", prefix);
  await docker("volume", "create", data); await docker("volume", "create", home);
  await docker("run", "-d", "--platform", "linux/amd64", "--name", model, "--network", prefix, "--network-alias", "model",
    "--mount", `type=bind,src=${fileURLToPath(new URL("./gateway-model.mjs", import.meta.url))},dst=/mock.mjs,readonly`, image, "node", "/mock.mjs");
  await docker("run", "-d", "--platform", "linux/amd64", "--name", desktop, "--network", prefix, "--network-alias", "desktop", "--shm-size=512m",
    "-e", `CUA_ENV_TOKEN=${cuaToken}`, "-e", "DO_NOT_TRACK=1", "--mount", `type=volume,src=${home},dst=/home/cua`, cuaImage);
  await until(async () => (await docker("inspect", desktop, "--format", "{{.State.Health.Status}}")) === "healthy", "Cua desktop health");
  await docker("run", "-d", "--platform", "linux/amd64", "--init", "--name", gateway, "--network", prefix,
    "-p", "127.0.0.1::8787", "--mount", `type=volume,src=${data},dst=/app/data`,
    "-e", `GATEWAY_TOKEN=${token}`, "-e", "LLM_BASE_URL=http://model:8080/v1", "-e", "LLM_MODEL=gateway-test-model",
    "-e", "ENABLE_SHELL=false", "-e", "CUA_MCP_URL=http://desktop:3211/mcp", "-e", `CUA_ENV_TOKEN=${cuaToken}`, image);
  const origin = async () => `http://127.0.0.1:${(await docker("port", gateway, "8787/tcp")).split(":").at(-1)}`;
  let url = await origin();
  await until(async () => { try { return (await fetch(url + "/health")).ok; } catch { return false; } }, "gateway health");
  assert.equal((await fetch(url + "/v1/attach")).status, 401);
  remote = await connectGateway(url, token, "/private/tmp/sage-smoke-client-unused");
  await remote.controller.submit("Inspect the disposable desktop.", "steer");
  await until(async () => JSON.stringify(remote!.source.current().conversation.entries).includes("Mock gateway reply."), "native model/tool completion");
  const entries = remote.source.current().conversation.entries;
  assert.match(JSON.stringify(entries), /mcp__desktop__get_desktop_state/);
  assert.ok(entries.some((entry) => entry.model?.some((item) => item.role === "toolResult" && !item.isError && item.content.some((part) => part.type === "image"))),
    "Cua must return a real desktop screenshot through Pi: " + JSON.stringify(entries.flatMap((entry) => entry.model?.filter((item) => item.role === "toolResult").map((item) => ({
      name: item.toolName, error: item.isError, text: item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 700),
    })) ?? [])));
  assert.doesNotMatch(await docker("logs", gateway), /\[MCP\].*unavailable/);
  console.log("PASS: authentication and a real Cua screenshot through Pi's native model/tool loop.");
  const root = remote.source.current().conversation.conversation.id;
  await remote.dispose(); remote = undefined;
  await docker("restart", gateway);
  url = await origin();
  await until(async () => { try { return (await fetch(url + "/health")).ok; } catch { return false; } }, "gateway restart");
  remote = await connectGateway(url, token, "/private/tmp/sage-smoke-client-unused");
  assert.equal(remote.source.current().conversation.conversation.id, root);
  assert.match(JSON.stringify(remote.source.current().conversation.entries), /Mock gateway reply/);
  await remote.dispose(); remote = undefined;
  // SIGTERM must finish cleanly, rather than Docker needing SIGKILL.
  await docker("stop", "--time", "15", gateway);
  assert.equal(await docker("inspect", gateway, "--format", "{{.State.ExitCode}}"), "0");
  console.log("PASS: AMD64 gateway + Cua desktop, auth, native screenshot tool, disconnect, persistence, restart, graceful stop.");
} finally {
  await remote?.dispose();
  await Promise.all([gateway, model, desktop].map((name) => docker("rm", "-f", name).catch(() => {})));
  await Promise.all([data, home].map((name) => docker("volume", "rm", name).catch(() => {})));
  await docker("network", "rm", prefix).catch(() => {});
}
