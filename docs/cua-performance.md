# Cua performance investigation

Measured on 2026-10-21 against Brandon's existing Bonsai llama.cpp endpoint.
No additional model was installed. Server `/props` confirmed one slot, 131,072
tokens of context, and vision support. These are diagnostic measurements, not a
promise about the duration of a flight search.

## Findings and changes

1. The pinned Cua desktop advertises 63 tools. Their model-facing descriptions
   and input schemas occupied roughly 142,000 characters before OpenAI wrapping.
   Sage previously offered all of them on every request. Eight common browser
   and observation tools now remain immediately available; Pi Durable's native
   `tool_search` discovers and loads other desktop tools on demand. Loaded tools
   persist on the conversation branch. No tools or permissions were removed.
2. The MCP bridge discarded `structuredContent` whenever text content existed.
   Cua sometimes returns only a sentence of text while putting live tab IDs,
   browser targets, action refs, and capture metadata in its structured result.
   Sage now includes both, avoiding an exact duplicate JSON text block.
3. Cua supports typed browser navigation and semantic page reads in the existing
   pinned desktop image. Guidance now prefers those tools, explicit consistent
   session labels, focused queries, and brief outcome reports. Screenshots and
   native input remain available when visual evidence is necessary.

## Controlled catalog measurement

Four consecutive requests used the same synthetic instruction to select
`get_desktop_state`, thinking disabled, temperature zero, and at most 96 output
tokens. No returned action was executed. The first pair offered all 63 tools;
the second pair offered the eight common tools. This initial prototype comparison
did not include the small native `tool_search` schema in the focused catalog.
The checked-in benchmark includes it to represent the final implementation.

| Catalog | Prompt tokens | Cached tokens | Wall time | Time to first token |
| --- | ---: | ---: | ---: | ---: |
| All, first request | 35,842 | 0 | 62.656 s | 62.534 s |
| All, repeated request | 35,842 | 35,838 | 0.767 s | 0.619 s |
| Focused, first request | 3,879 | 0 | 6.581 s | 6.474 s |
| Focused, repeated request | 3,879 | 3,875 | 0.533 s | 0.410 s |

All four selected the requested tool. The server attributed 61.174 seconds of
the first full-catalog request to prompt processing, compared with 5.662 seconds
for the first focused request. Cached repeats were fast in both cases: the
approximately 9.5x initial-request improvement must not be presented as a 9.5x
speedup for an entire conversation or flight search. Loading additional deferred
tools changes the catalog and can incur more prompt processing; discover only
the tools needed for the task.

## Browser and native Pi check

A disposable Cua desktop on the Mac, using the same pinned multi-architecture
image, supported browser preparation, exact window binding, navigation to Delta,
and semantic observation. The native ARM image was used for browser checks because
AMD64 emulation changes process executable identity and prevents Cua's browser
recognition. These tool timings are not measurements on the Umbrel host.

With structured results preserved and tool discovery enabled, a native Pi
conversation using real Bonsai reached Delta and confirmed flight-search controls
in 56.4 seconds. Browser navigation took 396 ms; browser observations took 55–192 ms.
The loaded page produced roughly 14,000 new model input tokens in one broad read,
which motivated the more explicit focused-read and concise-report guidance.
This test opened a fresh isolated profile and did not log in, search flights,
or book anything. A follow-up run encountered Cua setup/session errors and was
stopped; this is not evidence that all browser reliability issues are solved.

## Reproduce catalog measurements

Run `npm run test:cua-performance` explicitly with `CUA_MCP_URL`, `CUA_ENV_TOKEN`,
and the existing `LLM_BASE_URL`, `LLM_MODEL`, and optional `LLM_API_KEY` configured
for a test endpoint. The MCP endpoint must be reachable from the process running
the benchmark. It lists tools and sends four real model requests, but executes
no desktop actions. It prints metrics, not credentials, prompts, or image data.
The reported usage/cache counters determine whether a request was actually cold.

## Remaining validation

No timing trace was available from the original ten-minute homelab flight search.
That delay cannot be attributed entirely to tool-catalog overhead. The actual
Delta workflow still needs a fresh conversation on the deployed gateway, with
model time, page-load time, action failures, and retries recorded separately.
The gateway image must be rebuilt and redeployed to use the bridge changes;
updating only the Mac client cannot apply server-side optimizations.
