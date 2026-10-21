![Sage wordmark](docs/assets/sage-logo.svg)

# Sage Pi

Private personal assistant built on Pi Durable, with a terminal UI and optional
Telegram access. The npm package and data volume keep their existing personal-pi names.

**Development:** [Request a feature](https://github.com/BrandonLee28/sage-pi/issues/new/choose)
· [Review pull requests](https://github.com/BrandonLee28/sage-pi/pulls)
· [Automated checks](https://github.com/BrandonLee28/sage-pi/actions)
· [Contributor workflow](CONTRIBUTING.md) · [Agent standards](AGENTS.md)

Each feature gets its own branch and PR. Describe the outcome you want; agents
implement it, run checks, and provide a short PR for you to review and merge.
Open issues are the backlog, open PRs are work ready or underway, and merged PRs
are the change history.

| Current capability | Implementation |
| --- | --- |
| Terminal conversations and durable recovery | Upstream Pi TUI and native Pi storage |
| Memory, responsibilities, and recurring routines | Native documents and tasks |
| Owner-only Telegram topics, uploads, and progress | Optional Telegram gateway |
| Calendar, document reading, and transcript recall | Native Pi extensions |
| Local model, search, scraping, and optional Gmail | Configured services and native tools |

## Terminal build

The **actual Pi Durable demo TUI** connected to our personal harness.
No web UI, HTTP server, or listening port.

```text
Your terminal / SSH / docker attach
                 ↕
     Pi's original durable TUI
                 ↕
   Pi Durable → your llama.cpp server
       ↕
SQLite · memory · responsibilities · skills
       ↕
   Optional Telegram gateway
```

## Run locally

Node 24.2+ is required. From this directory:

```sh
npm ci
# Only if .env doesn't exist yet:
cp .env.example .env
npm start
```

`npm start` opens the TUI in your terminal. It automatically reopens the existing
SQLite conversation and resumes pending work. Existing memories and responsibilities
from the first build are preserved in `data/`.

## Sage CLI

Run `npm link` once in this checkout to make `sage` available on your PATH.
Without linking, use `npm run sage -- <command>`. The launcher reads this checkout's
`.env` and resolves relative `DATA_DIR` paths from here, even when called elsewhere.
`sage` opens the existing Pi TUI with a compact Sage wordmark and model/workspace
header that remains visible above saved chat history. The chat composer uses a
shaded `>` prompt with native Pi editing and a model/context tray underneath.
`sage setup` opens the matching setup menu. Use **↑/↓** to move,
**Enter** to select, type to filter, and **Esc** to cancel. Model and conversation
pickers inside chat use the same design; type `/` to discover chat commands.
The muted palette and selection bands are adapted from
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), with its MIT license
and source reference preserved in [vendor/prime-design](vendor/prime-design/README.md).

```sh
sage setup                 # Model, MCP servers, or diagnostics
sage model                 # Pick from the endpoint's advertised models
sage model MODEL_ID --url http://localhost:8080/v1
sage model reset           # Return to .env model defaults
sage mcp                   # Interactive add/list/remove/test menu
sage mcp add NAME --env TOKEN_ENV -- COMMAND ARGUMENTS
sage mcp add NAME --url https://your-server/mcp --token-env TOKEN_ENV
sage mcp list
sage mcp test NAME          # Connect/list tools; never calls a tool
sage mcp remove NAME
sage doctor                # Check config, data access, and model discovery
sage --help
```

Settings are saved atomically to `DATA_DIR/settings.json`; `.env`, conversations,
and workspace instructions are preserved. CLI model settings override `LLM_MODEL`
and `LLM_BASE_URL`. Explicit model IDs can be saved while offline; `sage doctor`
checks whether the server advertises the selection. Restart Sage after a change.
A new CLI selection applies to existing main and Telegram conversations once;
later native `/model` choices remain saved until another CLI selection/reset.
Endpoint and API key settings must match; `LLM_API_KEY` stays in `.env`/environment.

MCP uses the [official TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/client)
for stdio and Streamable HTTP, exposing server tools as native Pi tools named
`mcp__NAME__TOOL`. MCP adds one concrete dependency; Pi still owns validation,
execution, cancellation, output limits, and recovery. Calls are never automatically
replayed after a crash. Adding a server saves configuration; startup and
`sage mcp test NAME` run the configured executable/connect to its URL. Stdio commands
run in `DATA_DIR/workspace`, with the local `node_modules/.bin` on PATH. Use absolute
paths for scripts outside that workspace. Server logs appear during the explicit
connection test, and stay out of the conversation TUI.

MCP servers whose generated tool names collide with an installed tool are skipped
with a startup diagnostic; rename the conflicting server and restart.

`--env` is repeatable and passes only named environment variables in addition to
the SDK's basic process environment. `--token-env` reads an HTTP bearer token by
name. Store secret values in `.env`/environment, not command arguments or URLs.
The current MCP bridge supports tools, text, images, and embedded text resources;
it does not browse MCP resources/prompts, perform OAuth, or reconnect automatically.
Unavailable servers produce a startup notice; test the connection and restart
after fixing it. `sage doctor` does not launch MCP processes or call model inference.

The provider defaults to your supplied `http://100.94.249.19:8080/v1` llama.cpp endpoint.
Startup and `/model` discover the models it advertises (currently `bonsai-27b`).
Model discovery also reads llama.cpp's `/props` modalities. Vision-enabled servers
offer image input, using Pi's native image reader and image resizing; your current
Bonsai server reports vision enabled.
`LLM_MODEL` is the preferred initial model and the fallback if discovery is offline.
Your saved model choice is retained while the server still advertises it.

Reasoning defaults to **Low**. Press **Shift+Tab** to cycle **Low → Medium → XHigh
→ Off**, using Pi's native saved thinking level for the selected conversation.
Both model and reasoning choices survive restart. New Telegram threads start at Low.
The adapter sends `enable_thinking` and `reasoning_effort` through Pi's native
chat-template compatibility settings. Its supported levels match your current
Bonsai template; review `src/model.ts` if you load a model with different controls.
Low/Medium/XHigh also send an enforced `thinking_budget_tokens` cap of 512/2048/6144
through Pi's native compatibility field. Pi clamps these budgets to leave at least
1024 tokens for the answer under a smaller output limit. Low's prompt hint alone
does not reliably shorten Bonsai's reasoning; the hard budget is what bounds it.
`LLM_MAX_TOKENS` defaults to 8192 and includes reasoning as well as the visible answer.
The model stream timeout is five minutes. An empty model answer now produces an
explicit Telegram failure notice rather than being silently marked delivered.

Try: “Remember that I prefer short messages and one clear next action.”
Then: “Remind me to stretch in one minute. Save the check-in time.”

| Control                   | Action                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| Enter                     | Submit, or steer current work                                          |
| Alt+Enter                 | Queue a follow-up                                                      |
| Esc                       | Stop current work; scheduled check-ins remain                          |
| Ctrl+O                    | Expand/collapse tool output                                            |
| Shift+Tab                 | Change reasoning level for the selected conversation                   |
| `/tasks`                  | Toggle Pi's native live task graph                                     |
| `/compact [instructions]` | Compact while idle                                                     |
| `/model`                  | Refresh and select models advertised by your llama.cpp server          |
| `/new`                    | Create and switch to a fresh saved chat with the current model/reasoning |
| `/speak` / `/speak off`   | Start/stop the optional local hands-free voice prototype (macOS)        |
| `/sessions`               | Create a session or return to a saved local chat or Telegram thread     |
| `/skills`                 | Inspect available skills, descriptions, paths, and full files           |
| `/memory`                 | Inspect saved memory, sources, timestamps, prompt inclusion, and USER.md |
| `/schedules` or `/crons`   | Inspect recurring routines, cron expressions, and one-time reminders    |
| `/agents`                 | Alias for `/sessions`                                                  |
| `/help`                   | Show the short help notice                                             |
| Ctrl+C / Ctrl+D           | Exit; unfinished durable work resumes on next start                    |

Closing the local TUI stops this process. To keep the agent alive while disconnected,
use tmux on your server or detach from the running container as described below.

`/new` starts a separate native Pi conversation without clearing or copying the
previous transcript. Workspace files, memory, tools, and responsibilities stay
shared. Choose **+ New session** in `/sessions` (also available through `/agents`)
to do the same thing. Saved chats appear as **Session 1**, **Session 2**, and so on.
Switching chats leaves any ongoing work in the previous conversation running.
Restart reopens your last selected local chat; viewing a Telegram thread does not
change that local startup choice. Telegram's existing main/topic routing stays intact.

Slash-command suggestions and menus live in the bottom input area. `/skills` and
`/memory` open read-only snapshots there, refreshed whenever you open them.
Type to filter, press Enter for full details, use arrows/Page Up/Page Down to scroll,
and Esc to go back. Inspection does not call the model, execute a skill, change
memory, or add inspected content to chat history. Memory marks the last eight
pinned facts included on the next request separately from facts retrieved on demand.
The profile view shows the full `USER.md` and its 2,000-character prompt limit.
Skills show the same workspace catalog advertised to Sage; their presence does not
mean their full instructions have been read in the current session.

The task graph is hidden at startup; `/tasks` shows or hides it. Background
`personal.routine` entries waiting for their next scheduled run are durable timers.
Hiding the panel leaves those schedules running.

`/schedules` (also `/crons`) shows Sage's recurring routines, including paused
ones, and reminders with a scheduled wake. Select one for its cron expression,
timezone, next run, last result, saved instructions, or reminder details. Times
show the routine's saved timezone (the configured timezone for reminders), with
UTC timestamps in the details. Due dates without a wake are not scheduled reminders.
This read-only snapshot refreshes on opening and does not run or change schedules.

## Local hands-free voice prototype (macOS)

`/speak` in the existing Pi TUI opens the Mac's microphone after local speech models
load. Stay quiet for a **two-second room-noise calibration** each time voice starts.
An animated ASCII orb in Sage's palette shows the live microphone level and the
current state: loading, calibrating, listening, hearing you, transcribing, thinking,
or speaking. It stays above the input and stops animating when voice closes.
Speak naturally; a 400 ms pause ends a turn. Sustained speech detection interrupts local
playback and aborts the current Pi run, then the recognized text enters the same
saved conversation. Sage speaks phrases from Pi's committed response stream while
the rest of the response is still generating. Thinking and tool arguments/results
are never spoken. Native Pi continues to own inference, tools, cancellation, and
storage. There is no web UI, HTTP server, or second agent loop.

Capture and playback share macOS's native `AVAudioEngine` with
[voice processing](https://developer.apple.com/videos/play/wwdc2019/510/) enabled,
so echo cancellation has a reference for Sage's speaker output. The mic stays open
during playback for interruption. Use the Mac's default input/output devices, selected
in System Settings. Headphones can still help in noisy rooms or at high speaker volume.
This is a turn-based ASR → existing LLM → TTS pipeline with interruption.

Install optional speech bindings once (requires `uv`, Apple's Command Line Tools,
and macOS 10.15+). Rerun setup after updates to the native audio helper:

```sh
brew install uv
# If Apple's compiler is missing: xcode-select --install
npm run voice:setup
```

The primary application remains TypeScript. A small stdio subprocess uses pinned
native bindings for [whisper.cpp](https://github.com/absadiki/pywhispercpp),
[WebRTC VAD](https://github.com/daanzu/py-webrtcvad-wheels), and
[Phonon](https://github.com/gradium-ai/xn-ptts/tree/v0.4.0). Both speech models stay
loaded across turns. A small Swift helper handles only native audio I/O and echo
cancellation; setup compiles it to `DATA_DIR/voice/audio`. There is no Swift app UI
or agent logic, and no FFmpeg/FFplay requirement. Optional Python packages live in `DATA_DIR/voice/runtime`,
separate from npm dependencies. Setup preserves an existing runtime and does not
start the microphone. Whisper `base.en` downloads on first use and caches in the
voice directory; `VOICE_ASR_MODEL` can select another model or local model file.

For Phonon 40M, accept its terms on the
[model page](https://huggingface.co/gradium/phonon-40m-en). Either sign in locally
with `uvx --from huggingface-hub hf auth login`, or download these four files from
the website into one folder, retaining their names:

- `config.json`
- `tokenizer.json`
- `model.q8.gguf`
- `default-voice.safetensors`

For a downloaded model, set `VOICE_TTS_MODEL` to that folder in `.env`, or for one run:

```sh
VOICE_TTS_MODEL="/absolute/path/to/phonon-40m-en" npm run voice:try
```

`voice:try` opens a disposable chat with your configured LLM and starts voice mode.
Telegram, shell, calendar, web services, and configured MCP servers are disabled.
Its workspace/transcript is deleted on exit; the speech runtime and model cache
are retained. This is the quickest way to judge latency without using your normal
conversation or account tools. Hugging Face browser login and the Codex connector
are separate from the speech subprocess's authentication; a local model folder
requires no Hugging Face token at runtime. Models and credentials never belong in Git.

In normal `npm start`, use `/speak` or `/speak on`. `/speak off`, Esc, typing a chat
message, switching conversations, or exiting closes microphone/playback. Voice mode
temporarily sets the selected conversation's native thinking level to Off; its prior
level is restored on exit or restart, unless you chose another level yourself.
Model calls and context still use the same backend and single inference stream.

The orb reports time to the first PCM chunk since detected end of speech,
pause + ASR time, and model time to first text.
**First PCM is not measured speaker latency**: sentence buffering and playback
buffering add delay. The speaking state remains active until native playback finishes.
The recognizer waits for a pause before decoding; this version does not provide live
partial transcription or semantic end-of-turn detection. Change `VOICE_SILENCE_MS`
(200–2000, in 20 ms steps) to compare responsiveness with tolerance for pauses.
The calibrated energy gate and WebRTC VAD require sustained speech above room noise;
brief bursts are discarded before transcription, and low-confidence recognition is
ignored. macOS may request microphone permission for your terminal.
SSH does not forward your Mac's microphone. Echo cancellation depends on the audio
route and environment; it is not a guarantee against every speaker-induced trigger.
New speech supersedes an unfinished voice turn; an older transcription that has
not yet been admitted to Pi is discarded to avoid a late, out-of-order request.

Raw microphone/audio buffers stay in memory; normal sessions save transcribed text
and generated answers. Microphone sessions never auto-resume after a crash. Pi's
abort waits for tools to respond and cannot undo effects already completed. Very
long speech is split into bounded utterances, and excessive queued output stops
voice with an error. Streaming words already heard cannot be taken back if a model
request later fails/retries. Terminal errors keep the text transcript available.

## Homelab container

```sh
docker compose up --build -d
docker attach --sig-proxy=false "$(docker compose ps -q agent)"
```

Detach with **Ctrl+P, then Ctrl+Q**. The container, scheduled tasks, and Telegram
continue running. Attach again to the same TUI later. Connect over SSH when remote;
no application network port is exposed. Stop with `docker compose down`.

The container's TTY and stdin stay open. Its named volume `personal-pi` persists data.
For headless operation instead of the TUI, set the Compose command to
`["node", "src/cli.ts", "--headless"]`. Locally, use `npm run daemon`.
Docker execution still needs testing on a machine with its daemon running.

## What is native Pi

- Generation/tool loop, inbox/steering, compaction, SQLite persistence, recovery.
- File and shell tools (`read`, `write`, `edit`, `bash`).
- Documents for individual memories, sources, and responsibilities.
- Background tasks for durable scheduled check-ins and Telegram delivery.
- The TUI, editor, message/tool components, theme, and keybindings.

There is no separate cron server, queue database, vector store, or custom agent loop.
Each Telegram topic has a separate native Pi conversation. Saved memory,
responsibilities, instructions, and skills are shared. Model requests share one
inference slot even when several threads have pending work; background compaction
is disabled. Due dates and wake times are separate. Commitments use one-shot wakes;
recurring routines use native durable tasks that automatically schedule the next run.

## Edit and extend

| Change                        | Where                                               |
| ----------------------------- | --------------------------------------------------- |
| Sage's personality and voice  | `data/workspace/SOUL.md`                            |
| User profile and preferences  | `data/workspace/USER.md`                            |
| Agent instructions            | `data/workspace/AGENTS.md`                          |
| Skills                        | `data/workspace/skills/<name>/SKILL.md`             |
| Add tools/hooks/tasks         | Native Pi extension `.ts` files under `extensions/` |
| Model and service connections | `.env`                                              |

`SOUL.md` defines Sage's personality; `USER.md` describes you; `AGENTS.md` defines how it works.
These files and skill descriptions refresh before the next model request, across
the TUI and every Telegram thread.
`instructions/` contains first-run templates; startup preserves existing workspace
edits. See [extensions/README.md](extensions/README.md) for a native Pi tool example.

The personality section in `instructions/SOUL.md` is copied verbatim from the
`kawaii` entry in [Hermes Agent's built-in personalities](https://github.com/NousResearch/hermes-agent/blob/ddabd3837862022a6053331fe3ba97cf9716b9e3/hermes_cli/personality.py#L22)
(commit `ddabd3837862022a6053331fe3ba97cf9716b9e3`). Hermes defines it as a
personality preset, not a separate SOUL.md file. It is distinct from its `uwu`
preset. The text is unmodified, with the upstream [MIT license](vendor/hermes-personality/LICENSE)
retained. Sage keeps its own identity and the original accountability and trust
guidance, with normal spelling in the accountability example. Other custom voice
and playfulness instructions are removed. Telegram follows SOUL.md for personality.

For an existing workspace, edit `data/workspace/SOUL.md` using
`instructions/SOUL.md` as the reference; update `data/workspace/TELEGRAM.md` from
its template too if you use Telegram. Keep any personal edits you want. Updating
the templates alone does not change an existing workspace. The next model request
picks up edits to the runtime files.

Keep `USER.md` to a few user-confirmed facts: preferred name, communication needs,
enduring goals, and useful constraints. The template contains no personal facts.
Edit it yourself or explicitly ask Sage to update it. The new template is also
copied into existing workspaces when missing; existing files are never overwritten.
Existing runtime `AGENTS.md` files stay untouched, so add the profile guidance from
`instructions/AGENTS.md` yourself if you want it in an older workspace.

The profile occupies context on every request. Only its first 2,000 characters
(JavaScript string length, not a token count) are automatically included, plus a
short notice when truncated. The full file stays intact and can be read with the
native `read` tool when relevant. Empty or missing profiles add no profile section.
The section explicitly identifies `USER.md` as the shared profile file, including
in older workspaces whose `AGENTS.md` has no profile guidance. Other filenames,
such as `user_profile.md`, are ordinary files and are not automatically loaded.
Keep the most useful facts first and use memory for details, avoiding duplicate
pinned facts. Pi refreshes the same prompt section instead of appending the profile
as a new chat message each turn. Profile edits can still accumulate system changes
in history until compaction; stable text helps provider caching but still uses context.
This cap covers the profile, not the other instruction, memory, or task sections.

## Recall

Ask: **“Find what we discussed about my calculus assignment.”**
`recall` searches the original saved text across the main conversation and Telegram
topics, including history before a reset or compaction. Hits include exact conversation
and entry IDs; `read` opens a hit with neighboring entries. Histories stay separate.
It uses bounded keyword scans of Pi's existing storage, with a continuation cursor
for older results. Thinking, system prompts, and tool arguments are excluded;
execution results require `includeTools=true`. Try shorter alternative keywords
when a search misses something. This is not semantic search.

Skills stay in ordinary `data/workspace/skills/<name>/SKILL.md` files for you to
manage. Sage reads them when relevant and only changes them when you explicitly ask.
There is no automatic skill review, improvement hook, or background reflection.

## Recurring routines

Just tell Sage: **“Every weekday at 8 AM, check my calendar and help me pick my first task.”**
The native `routine` tool creates, updates, lists, pauses, resumes, or deletes the
schedule. Sage translates your request into a five-field cron expression and an
IANA timezone, defaults to your configured timezone, and confirms the next local run.
It asks when your timing or scope is unclear. You do not need to write cron yourself.

Pi owns the sleeps, persistence, and recovery. [cron-parser](https://github.com/harrisiirak/cron-parser)
calculates occurrences and handles timezone/daylight-saving rules. Each run replies
to the conversation/topic where the routine was created, even if you edit it elsewhere.
A routine waits for its current run to finish before scheduling another. After
downtime, it performs one overdue run and then skips missed slots, avoiding a backlog.
The next run is scheduled even if the model request settles unanswered; the routine's
saved state records that status. Pause/delete prevents future admissions; already
admitted work can be stopped with `/stop` in that topic. The process must be running.

Try **“Show my routines”**, **“Move my morning check to 9”**, or **“Pause my morning check.”**
These routines are separate from skills and do not change skill files.

## Telegram documents and photos

Upload a document or photo with a caption such as **“Summarize this syllabus”** or
**“What does this screenshot say?”**. The owner-only gateway saves it under
`data/workspace/uploads/telegram-<chat>-<message>/`, retains the caption, and submits
it to the same native Pi conversation as its Telegram topic. Files persist across
restart. Stable message paths and submission IDs avoid duplicate ingestion.

- Plain text/code/CSV: Pi's native `read` tool.
- Photos/screenshots: native `read` returns an image to a vision-capable model;
  Pi's bundled Photon processor resizes/converts it when needed.
- PDF: `document_read` extracts a selected page range with [unpdf](https://github.com/unjs/unpdf).
- Word `.docx`: `document_read` extracts text with [Mammoth](https://github.com/mwilliamson/mammoth.js).
- Other documents are saved, with no promise they can be parsed. Telegram voice/audio input is not enabled; local TUI voice is separate.

Downloads are limited to 20 MB, matching the hosted [Telegram file API](https://core.telegram.org/bots/api#getfile).
Documents are read as source content; macros and uploaded executables are not run.
Document output is capped at 20,000 characters per read, with continuation offsets;
PDF reads additionally accept page ranges. Scanned PDFs need OCR, which is not
included here. Upload the page as a photo for vision instead. No external OCR or
cloud vision service is used. `npm audit` currently flags Mammoth's CLI-only
argument-formatting dependency; the document extraction API does not load that CLI.

## Optional services

Set these in `.env`, then restart:

| Configuration                                 | Purpose                                           |
| --------------------------------------------- | ------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`      | Owner-only private chat using grammY long polling |
| `SEARXNG_URL`                                 | Search; enable JSON in your host                  |
| `FIRECRAWL_URL`, optional `FIRECRAWL_API_KEY` | `/v1/scrape` Markdown; no extraction LLM          |
| `LIGHTPANDA_URL`                              | CDP WebSocket endpoint for browser tools          |
| `APPLE_ID`, `APPLE_APP_PASSWORD`               | iCloud CalDAV authentication                     |
| `APPLE_CALENDAR_URL`                           | Selected iCloud calendar for new/changed events  |

Unconfigured web tools are absent. Telegram replies and scheduled updates return to
their originating topic. Each topic starts a separate conversation history when
first used; the existing main transcript stays in the main conversation. Unthreaded
Telegram messages use main. Use `/agents` in the TUI to inspect a thread or work in
it. Send the bot a message first so it can deliver proactive updates.
Telegram receives the completed reply; the TUI can show text while it streams.
For inputs that request Telegram delivery, `data/workspace/TELEGRAM.md` supplies a native
system-prompt section for short, natural plain-text replies and scheduled check-ins.
It gives a concrete schedule example and discourages forced slang and unsolicited
follow-up offers. Edit this file to tune the voice; changes load on the next model
request. Startup seeds it from `instructions/TELEGRAM.md` without overwriting an
existing copy. TUI-only inputs skip both Telegram prompt sections and the rewrite
hook, even in main or a Telegram topic. This follows the active native run and
survives queued inputs and restarts.

`TELEGRAM-BREVITY.md` adds the default of 1–3 short sentences, usually under 60
words: answer the current point and give at most one useful next step. It is seeded
into existing workspaces without changing their `TELEGRAM.md`. Full recaps,
repeated schedules, and extra alternative plans are discouraged; requested detail
and complete lists are still allowed.

If a final draft contains common Markdown (bold markers, headings, code fences,
or formatted web links) or a JSON object/array, a native Pi `onYield` hook asks for
one plain-text rewrite before delivery. Plain-text drafts over 80 words also get
one shortening request, with an exception in the instruction for explicitly
requested detail or complete lists. Tools are unavailable during that correction
so it cannot repeat actions. Common explicit requests such as “reply in JSON” opt
out. The retry stops after one attempt even if the model still ignores the style;
this is a limited correction, not a full Markdown parser or a tone guarantee.
When viewing a Telegram reply, the TUI can show the original draft and the
correction in its native transcript.
The gateway itself does not rewrite replies, and status bubbles are unaffected.
To inspect actual wording with your configured model, opt in locally with
`node --env-file-if-exists=.env test/telegram-style.live.ts`. It uses a disposable
workspace and a supplied test agenda, disables tools, and never contacts Telegram
or your calendar. It prints the replies for tone review and checks plain formatting
and the length of an ordinary planning response.

Structured data, code, and long reports belong in workspace files with a brief
chat summary and saved path. Outbound file attachments are not yet supported, so
a saved file is not automatically uploaded to Telegram. Restart Sage after updating
to load the new hook and instruction template.
Telegram shows “typing…” while Sage handles your message, including uploads and
tool work, with renewal in the originating topic. Presence stops on completion,
`/stop`, or gateway shutdown; a presence API failure does not prevent the reply.
It also posts one quiet status message per active topic, edited about every four
seconds with Pi's current phase, elapsed time, and completed/failed tool counts.
After 20 seconds without new observed model/tool activity it says so; this is an
activity indicator, not a claim the model is stuck. The final label is “Reply ready”
(model finished, delivery may still be pending), “Stopped,” or a failure/shutdown
notice. It never includes reasoning text, tool arguments, or document contents.
Status updates are best-effort and do not change the native agent loop.
`/stop` in Telegram stops work in that thread; scheduled check-ins remain.
Topic routing uses Telegram's native [`message_thread_id`](https://core.telegram.org/bots/api#sendmessage).
SearXNG and Firecrawl have passed checks
through the real model and native tool loop. The existing Telegram bot and owner
chat credentials have been validated, and Hermes's gateway has been stopped.
Restart an already-open TUI to load the new Telegram settings, then send the bot
a message to verify replies. Gmail sign-in and Lightpanda are deferred.
If the existing bot is used by Hermes, stop its Telegram gateway before starting
ours: two polling clients cannot share the same bot. Send the bot a message first.

## iCloud Calendar

Calendar uses [tsdav](https://github.com/natelindev/tsdav) for CalDAV and
[ical.js](https://github.com/kewisch/ical.js) for event parsing/serialization, on
both macOS and the homelab container. Your local configuration selects **Personal**.

Set these in `.env`:

```dotenv
APPLE_ID=your-apple-account-email
APPLE_APP_PASSWORD=your-app-specific-password
APPLE_CALENDAR_URL=the-discovered-calendar-url
```

Create the app-specific password under Sign-In and Security at
[account.apple.com](https://account.apple.com). Apple requires two-factor
authentication; see its [instructions](https://support.apple.com/en-us/102654).
After adding credentials, ask Sage to list calendars and select the exact returned
URL. Credentials and calendar URLs stay in the ignored `.env` file.

`calendar_read` lists calendars and reads agendas in windows of at most 31 days;
iCloud expands recurring events. `calendar_write` creates, edits, and deletes
non-recurring events in the selected calendar. Updates preserve existing metadata
and use version checks to avoid overwriting concurrent edits. Meeting invitations
and recurring-series edits are handled in Apple Calendar for now. All-day event
end dates are exclusive. Interrupted writes are not replayed automatically.

Restart after first setup, then try: “Read my calendar skill and show my week.”
Calendar events do not automatically schedule a Sage wakeup or subscribe to changes;
use a delegated responsibility and an explicit check-in for proactive reviews.
Real connectivity and agenda reads have been verified. Automated tests simulate
all calendar writes and never mutate a real account.

## Gmail setup

The installed [Google Workspace CLI](https://github.com/googleworkspace/cli)
handles OAuth and Gmail commands. Pi uses its native bash tool with a small Gmail
skill; there is no custom email connector. Gmail needs `ENABLE_SHELL=true`.
Calendar uses iCloud independently of this optional Gmail setup.

Run these from this project directory:

```sh
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PWD/data/google"
npm exec -- gws auth login --scopes https://www.googleapis.com/auth/gmail.modify
```

Before login, create a **Desktop app** OAuth client in a Google Cloud project,
enable the Gmail API, configure the consent screen, and add yourself as a test
user if the app is in testing. Save the downloaded client JSON to
`data/google/client_secret.json` (create the directory first). If you already
have `gcloud`, `npm exec -- gws auth setup` can guide the project setup instead.
See the upstream [OAuth instructions](https://github.com/googleworkspace/cli#manual-oauth-setup-google-cloud-console).

For read-only access initially, use `--scopes https://www.googleapis.com/auth/gmail.readonly`
instead; archiving and label changes then require signing in again with modify access.
After login, verify with `npm exec -- gws auth status`. Restart the agent and ask
it to read its Gmail skill and summarize five unread messages. Automated tests
never access your real Gmail account or send Telegram messages.

Gmail credentials stay under `data/google` by default, including inside the
container's data volume. `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` can override this with
an absolute path. Complete login locally before exporting credentials for a
headless server; follow the upstream headless instructions and keep credentials private.

## Small code map

- `src/cli.ts`: TUI/headless entry, Telegram, shutdown.
- `src/tui-adapter.ts`: Connect our existing harness to the upstream TUI's view/controller.
- `vendor/pi-durable-tui/tui.ts`: Actual upstream demo renderer, with provenance and MIT license.
- `src/assistant.ts`: Assemble native Pi; load extensions, instructions, and skills.
- `src/voice.ts`, `src/voice-reply.ts`, `scripts/voice-worker.py`, `scripts/voice-audio.swift`: Local speech, macOS echo cancellation, and native Pi stream observation.
- `src/personal.ts`: Individual memory records, responsibilities, native wake task.
- `src/model.ts`: Local OpenAI-compatible provider.
- `src/telegram.ts`, `src/web.ts`: Optional service adapters.
- `extensions/calendar.ts`: iCloud calendar tools using CalDAV and standard iCalendar data.
- `extensions/recall.ts`: Bounded search/read of native transcript history.
- `extensions/routines.ts`: Recurring schedules backed by native Pi tasks/documents.
- `extensions/documents.ts`: Read PDF/DOCX text with existing native file tools for other inputs.

The demo TUI is not exported by the npm package, so its original source is included
under `vendor/` with minimal import adaptations. See its [provenance notes](vendor/pi-durable-tui/README.md).
The Pi packages are pinned at 1.3.0. Use the installed package README and types;
GitHub main can be ahead of npm. The published timer API is `runtime.sleep()`.

## Checks and current limits

```sh
npm run check
npm test
npm run test:live
# Also exercise search, extraction, and topics (Telegram sending is simulated):
npm run test:live -- --web --topics
# Exercise all reasoning levels with the real local model:
npm run test:live -- --reasoning
# Exercise transcript recall in a disposable workspace:
npm run test:live -- --recall
# Exercise real local vision and chat-created routines in a disposable workspace:
npm run test:live -- --media-routines
```

Tests use Pi's faux provider and isolated temporary databases. They cover persistence,
retrieval, timer recovery/cancellation, TUI state/submission, date handling, durable
delivery, topic isolation, shared personal state, chunk routing, and queued inference
cancellation. They also check outgoing reasoning parameters, model discovery,
and saved model/thinking choices. `test:live` explicitly uses your model in a temporary workspace.

Native file/shell tools use the server user's permissions; cwd is not a sandbox.
`ENABLE_SHELL=false` removes bash. The container runs as non-root; mount only the
workspace/data it should access. Agent operating boundaries are instructions, not a
hard approval system.

Memory and transcript retrieval are keyword-based. Forgetting removes active memory
retrieval, while past transcript/history copies remain searchable with recall.
Skills are user-controlled. Browser sessions are ephemeral. Telegram can duplicate a
last chunk if a crash occurs immediately after Telegram accepts it.

Run one process per data directory. Pi does not lock storage between processes.
Stop the process before backing up its data volume, including SQLite WAL files.

[Pi Durable overview](https://earendil.com/posts/pi-durable/) ·
[Original TUI](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/experimental/durable/tui.ts)
