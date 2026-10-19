# Prime Agent design reference

Sage's compact brand/metadata header, soft selection bands, and muted menu layout
are adapted from Prime Agent's `chrome.rs`, `menu_panel.rs`, and
`onboarding_choice.rs` at commit
[`7cbffa77b38facd7c87277fa3c82bcadbe816880`](https://github.com/PrimeIntellect-ai/prime-agent/tree/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-tui/src).

`sage.json` copies its `crates/pa-types/themes/prime.json` palette, changes the
theme name, and removes tokens outside the installed Pi theme schema. The upstream
MIT license is retained in `LICENSE`. Sage's wordmark is original; Prime's
butterfly and product identity are not used. The Rust UI/runtime is not vendored.

The implementation uses the already installed Pi terminal components. Pi still
owns the conversation editor, transcript, model selection, tools, and generation.
