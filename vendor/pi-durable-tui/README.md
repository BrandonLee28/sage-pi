# Upstream Pi Durable TUI

`tui.ts` is the actual durable demo TUI from Pi v1.0.0:
https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/experimental/durable/tui.ts

It was fetched from the official repository, not reimplemented. The demo was
excluded from the published coding-agent package, so it is included here under
its MIT license. Its terminal components and helpers come from the pinned
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 1.3.0 packages;
the original demo's component API is compatible with these versions.

Local adaptations:

- Resolve its existing helper imports to their installed compiled package files.
- Import its view/controller contract from `src/tui-adapter.ts` instead of the
  demo's model/session setup.
- Render `personal.telegram` and `personal.scheduled` inputs alongside regular user inputs.
- Refresh the local provider's model catalog before opening its model picker.
- Use Sage's compact brand header, Prime-derived palette, and shared Pi pickers
  from `src/cli-ui.ts`. Pin the header outside the transcript so it stays visible
  when reopening a long chat, and align model/context and shortcuts below the input.
- Skin Pi's native `CustomEditor` with a shaded `> ` composer and placeholder.
  Its protected border-rendering hooks retain working/scroll status while removing
  the horizontal rules. Editing, mouse coordinates, history, paste, and completion
  remain native; the four-column input padding reserves space for the prompt.
- Offer the existing slash commands through Pi's native autocomplete. Enter and
  Alt+Enter share command dispatch. Keep the task graph opt-in through `/tasks`
  and label sleeping routines as waiting for their next scheduled run.
  Editor, message/tool rendering, and execution stay upstream.
- Add `/new` and a **New session** row to the session picker (`/sessions`, with
  `/agents` retained). The app adapter creates native Pi conversations and stores
  their local navigation index/selection in a native session document.
- Add `/skills`, `/memory`, and `/schedules` (alias `/crons`) as read-only panels
  in the bottom input area: a shared picker and plain-text detail viewer, bounded
  to half the terminal height.
  All chat pickers use this compact dock layout; setup keeps its full menu layout.
  Data is read on opening through the app adapter;
  inspection does not enter the model transcript or invoke tools.
- Advertise `/speak` through the existing native slash completion; its lifecycle,
  speech bindings, and Pi event consumption live in the application adapter.

See [Prime design provenance](../prime-design/README.md) for the reference and license.

Keep presentation changes upstream where possible. Our application logic belongs
in `src/` and native Pi extensions, not this file.
