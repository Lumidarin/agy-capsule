# agy-capsule

**English** | [繁體中文](./README.zh-TW.md) | [简体中文](./README.zh-CN.md)

A zero-dependency native Google Antigravity 2.x plugin that embeds real-time **context window**, **generation telemetry (`tok/s` & `TTFT`)**, **prompt cache TTL**, **7-category breakdown**, and **matched multi-model quota** dual capsules directly inside the composer footer.

## Key Capabilities

- **Composer Footer Dual Capsules (Shadow DOM)**:
  - **Context Capsule**: Shows a calm single percentage (`%` or `~%` estimate) with contextual icon tinting (high occupancy / cache warning / cache expired), paired with `tok/s` using 3-stage smooth cooling (colored pulse while generating -> solid tier color for 15s on completion -> static muted gray when idle, zero width jump).
  - **Model Quota Capsule**: Observes the adjacent composer model selector (`Gemini`, `Claude`, `Argon`, `Carbon`, `Hydrogen`, `Flash`, etc.) and automatically surfaces matching `5h` and `Weekly` remaining quota percentages.
- **Minimalist Upward Popovers (Hover & Click-to-Pin)**:
  - **Context Telemetry Popover (~248px compact card)**:
    - **Prompt Cache Cooling & Quiet Ghost Controls**: Tracks minute-level idle time since the last step (`<1m`, `1m`, `Xh Ym`; refreshes on popover open and every 30s, with `<3m` checkmark, `3m–4m` amber `~1m` warning, and `>=4m` expired strikethrough), paired with subtle ghost buttons (`↻`, `EN / 简 / 繁`, `Auto / Light / Dark`).
    - **Summary Row & `4px` Segmented Track**: Clean `used %` and `used / budget` ratio (hover shows exact `Cache · Input · Output · Remaining` tokens) with sub-pixel confetti filtering; compact alert banner appears only on `>=90%`, unparsed files, or API errors.
    - **7-Category 3-Column Tabular List**: Crisp `dot + label | % | k` rows converged strictly to `100%` across `System`, `Tools`, `Model`, `Think`, `User`, `Summary`, and `Files` (hover shows full category names and attachments).
    - **2-Line Minimalist Generation Telemetry**: Unboxed typography below a hairline divider showing `tok/s` + inline speed tier (`Fast`/`Smooth`/`Fair`/`Slow`), `Out`, `TTFT · Duration`, and active `steps`.
  - **Multi-Model Quota Popover**: Lists all quota groups, marks the active matched pool with a green `Active` badge (dimming inactive pools), and displays `4px` linear `5 Hours` / `Weekly` progress bars with low-quota amber/red tones, live reset countdowns, and automatic hiding of absent single-window rows (e.g., Weekly-only `Argon`).
- **9-Stage Narrow Composer Degradation**: Automatically collapses inline speed, secondary quota, numeric labels, and truncates model text cleanly on narrow panes without overlapping right-side controls.
- **Native Sidecar + Zero-Patch Architecture**:
  - Runs as a headless Antigravity plugin sidecar (`has_web_ui: false`, `restart_policy: always`) with zero `app.asar` modifications—survives Antigravity client updates.
  - Uses file-stat-gated `node:sqlite` (`gen_metadata` + `steps` checkpoints) and single-injection CDP (`https://127.0.0.1` UI pages only, revision-diffed updates).

## Installation

1. **Windows**: Run `install.bat` (syncs `plugins/agy-capsule` to `%USERPROFILE%\.gemini\config\plugins\agy-capsule`).
   To remove, run `uninstall.bat`.
2. **macOS / Linux**: Run `./install.sh` (syncs to `~/.gemini/config/plugins/agy-capsule`).
   To remove, run `./uninstall.sh`.
3. Open Antigravity's **Plugins** panel and enable **agy-capsule**.

## Architecture

```text
agy-capsule/
├── plugins/agy-capsule/
│   ├── plugin.json
│   ├── assets/logo.svg
│   └── sidecars/agy_capsule/
│       ├── sidecar.json          # Headless sidecar descriptor (has_web_ui: false)
│       ├── server.mjs            # Sidecar entry + optional /api/context endpoint
│       ├── core.mjs              # Protobuf decoder + isomorphic core shared with UI
│       ├── telemetry.mjs         # Stat-gated SQLite + LS RPC + Tier-3 scan scheduler
│       ├── attachment_scan.py    # Optional stdlib Python Office/PDF sizing helper
│       ├── renderer_client.js    # One-time Shadow DOM composer capsule & popovers
│       └── deck_injector.mjs     # Revision-diffed CDP injector for UI pages
└── test/capsule.test.mjs         # Automated unit & integration tests
```

## License

[MIT](./LICENSE)
