# Cua tool discovery

Sage exposes the Cua desktop tools through Pi Durable's native `tool_search`, so
only the tools needed for a task are loaded. Direct web tools are preferred for
public research when configured. Browser and desktop actions still count as
computer use and respect the user's instructions.

The MCP bridge preserves structured results alongside text summaries, including
browser targets and action references. Existing loaded tools remain available
within their conversation; start a new session to test the initial catalog.

`npm run test:cua-performance` is an opt-in benchmark. Set `CUA_MCP_URL`,
`CUA_ENV_TOKEN`, `LLM_BASE_URL`, and `LLM_MODEL` for a test environment. It
measures model tool selection and prints timing and usage; it performs no desktop
actions. Results vary with the model, endpoint, and cache state.
