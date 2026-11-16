# Changelog

All notable changes to `agy-capsule` will be documented in this file.

## [1.0.0] - 2026-11-16 (`CAPSULE_VERSION = 15`)

Official `1.0.0` release of the standalone native Google Antigravity 2.x composer footer plugin.

### Features & Design
- **Composer Footer Dual Capsules (Shadow DOM)**:
  - Context occupancy capsule (`%` / `~%` estimate) with contextual icon tinting and `tok/s` 3-stage smooth cooling (colored pulse while in-flight -> solid tier tint for 15s upon completion -> static muted gray when idle, with zero capsule width jump) synced across capsule and popover via unified tier colors (`fast`/`smooth`, `fair`, `slow`).
  - Active model-matched `5h` / `Weekly` quota capsule synced via `MutationObserver`, with dynamic warning (`<=25%`) and danger (`<=10%`) tones and automatic hiding of absent single-window pools (e.g., Weekly-only pools).
  - 9-stage narrow-footer adaptive degradation keeping inline controls aligned without overlapping right-side composer buttons.
- **Minimalist Context Popover (`~248px`)**:
  - Variant A 3-tier visual hierarchy across 7 categories (`System`, `Tools`, `Model`, `Think`, `User`, `Summary`, `Files`) with largest-remainder convergence to `100.0%` and a `4px` segmented progress track.
  - Unified 1-decimal uppercase `K` / `M` compact token formatting across all popover rows and hover tooltips (cache, summary, categories, output).
  - Minute-granular Prompt Cache TTL status (`<1m`, `1m`, `Xh Ym`; `<3m` warm checkmark, `3m–4m` amber warning, `>=4m` expired strikethrough) refreshing on popover open and every `30s` with idempotent DOM/tooltip updates, paired with ghost action controls (`↻`, `EN / 简 / 繁`, `Auto / Light / Dark`).
  - 2-line unboxed generation telemetry (`tok/s` + speed tier, `Out` reply/thinking split, `TTFT · Duration`, active `steps`) with halfwidth-punctuation tooltips.
- **Unified Quota Popover (`240px`)**:
  - Matches context card styling with `4px` linear progress bars, hairline dividers, right-aligned `Active` badge for the matched pool, dimmed secondary pools, low-quota tones, and live reset countdowns.
- **Headless Native Sidecar & Hardening**:
  - Zero `app.asar` patches (`has_web_ui: false`, `restart_policy: always`), single-injection CDP (`https://127.0.0.1` UI pages only) with WebSocket cleanup and `/json/list` timeout protection.
  - Stat-gated read-only `node:sqlite` + Language Server RPC hybrid telemetry resilient to empty/unready DBs (with settled step/timestamp in-flight lifecycle tracking to halt idle RPC polling, preflight `maxContextTokens` capture across `gen_metadata` / RPC tail, and `0 / --` pre-Turn-1 display eliminating false `256K` fallbacks), plus `64 KiB` image-header sizing (`attachment_scan.py` & `core.mjs`).
