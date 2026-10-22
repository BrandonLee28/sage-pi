// Disposable OpenAI-compatible model for container tests. No external model calls.
import { createServer } from "node:http";
createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "gateway-test-model" }] })); return;
  }
  if (request.url === "/props") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ modalities: { vision: true } })); return;
  }
  if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
  let input = "";
  for await (const chunk of request) input += chunk;
  const body = JSON.parse(input);
  const last = body.messages.at(-1);
  const desktop = last?.role === "user" && JSON.stringify(last.content).includes("Inspect the disposable desktop");
  const name = body.tools?.find((tool) => tool.function.name === "mcp__desktop__get_desktop_state")?.function.name;
  const search = body.tools?.find((tool) => tool.function.name === "tool_search")?.function.name;
  const previous = body.messages.findLast((message) => message.role === "assistant")?.tool_calls?.at(-1)?.function?.name;
  const tool = desktop ? name || search : last?.role === "tool" && previous === search ? name : undefined;
  const args = tool === search ? { query: "mcp__desktop__get_desktop_state", limit: 1 } : {};
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => response.write("data: " + JSON.stringify({
    id: "mock-completion", object: "chat.completion.chunk", created: 0, model: "gateway-test-model",
    choices: [{ index: 0, delta, finish_reason }],
  }) + "\n\n");
  chunk(tool ? { role: "assistant", tool_calls: [{ index: 0, id: tool === search ? "search-call" : "desktop-call", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
    : { role: "assistant", content: "Mock gateway reply." });
  chunk({}, tool ? "tool_calls" : "stop");
  response.end("data: [DONE]\n\n");
}).listen(8080, "0.0.0.0");
