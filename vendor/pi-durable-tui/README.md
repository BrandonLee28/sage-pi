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
- Render `personal.scheduled` inputs alongside regular user inputs.
- Refresh the local provider's model catalog before opening its model picker.

Keep presentation changes upstream where possible. Our application logic belongs
in `src/` and native Pi extensions, not this file.
