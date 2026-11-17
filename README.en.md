# agy-capsule

[中文](./README.md) | **English**

Context and quota capsules in the Antigravity composer footer.

<p align="center">
  <img src="assets/composer-quota-light.png" width="100%" alt="Light composer with inline capsules and multi-model quota panel" />
</p>
<p align="center">
  <img src="assets/composer-context-dark.png" width="100%" alt="Dark composer with context breakdown, plus yellow cache warning at 3 minutes and red expiry at 4 minutes" />
</p>

## Features

- **Inline dual capsules**: Embedded in the composer footer to show the current session's context usage against the model's live context limit (e.g. `256k` / `512k`, or `0 / --` before the first turn) and remaining 5h / Weekly quotas in real time.
- **Token breakdown**: Hover to see the proportions and token counts for `Turn0`, `Read`, `Think`, and `Write`.
- **Sidebar display settings**: Switch between statistics and settings at the top. Choose the display language (English / Simplified / Traditional Chinese, default English), independent appearance options and optional active-model highlighting. Settings language is selected separately, defaulting to Simplified Chinese; theme always follows the app. Defaults are compact spacing, ring quotas, square markers and no highlighting; four-category token calculations stay unchanged. Style options sit next to the feature switch they belong to, with a live preview below.
- **Breakdown layouts**: The context breakdown can be turned off entirely. When on, choose columns (four side by side) or rows (GitHub-style, one item per line); turn metrics choose their own layout. In rows mode, context and turn markers (square/dot) are set separately. In columns mode, toggle name, value and percent per field in the preview and drag to reorder; hidden fields gray out and move to the bottom.
- **Click-to-pin popovers**: Click a capsule to keep its popover open. Click again, click outside, or press `Esc` to close it; hover still works.
- **Popover placement**: The context popover aligns to the footer's left edge; the quota and failure popovers sit as far left as possible while still covering their own capsule's right edge. With matched height, the failure popover matches the other two. In narrow footers, popovers stay inside the composer's visible area instead of being clipped.
- **Generation metrics**: The latest model request's effective tok/s, TTFT, recorded duration, output/response/thinking tokens, and conversation steps appear in the context popover and sidebar, with an inline speed readout. Token values use one-decimal uppercase K/M, or integers below 1,000. An independent sidebar switch enables speed breathing/cooldown, off by default: a footer dot breathes during UI activity, keeps its speed color for 15 seconds after stopping, then grays out. Red: <10 tok/s; yellow: 10–<25; green: ≥25. Speed calculations and Cache state are unchanged.
- **Cache expiry alerts**: Turn yellow 3 minutes after the last turn with a countdown (`~1m`), and turn red at 4 minutes to mark `Cache` as expired.
- **Cache tooltips**: Footer and sidebar Cache rows show cached/total input tokens and the age of the latest recorded activity as `<1m`, `5m`, or `1h 5m`. Opening the footer popover refreshes the tooltip immediately. This is record age, not remaining cache lifetime; the existing 3/4-minute reminder thresholds are unchanged.
- **Detail tooltips**: Context totals and the progress track show remaining capacity and cached/uncached input. Four-category rows explain their existing accounting, and quota rows include the exact reset date/time and local timezone. Footer and sidebar share the wording without seven-category estimates or attachment scanning.
- **Multi-model quota panel**: Automatically match the model selected in the footer (such as `Gemini`, `Claude`, `Argon`, or `Carbon`). Hover to see each group's remaining 5h and weekly quotas, plus reset countdowns. Percentages and bars align in columns; countdowns use a compact (`4h 55m`) or localized (`4 hr 55 min`) format. Numbers and countdowns are marked do-not-translate so page-translation extensions cannot rewrite and misalign them.
- **Optional absent-window hiding**: The sidebar's “Hide absent quota windows” switch defaults to off. When only Weekly or 5h has data, hide the other footer placeholder. Real 0% values stay visible; both placeholders remain if both windows are unknown.
- **Context warning colors**: A separate, default-on switch colors only the capsule percentage yellow at 75% and red at 90%+. Icons and panel rows retain cache-status colors. No automatic popup or warning banner, even at 100%+.
- **Third request-failure capsule**: A separate, default-on switch shows quota exhaustion, 429, network, authentication, service or unknown failures. User cancellation is hidden; context overflow belongs to the context color warning. Details open on hover/click, the label folds to an icon in narrow footers, and the context percentage stays intact.
- **Responsive narrow layout**: Collapse the native Turbo selector to its shield before folding any capsule, then hide speed, quota windows and numbers or shorten the model label as needed. Context/failure entry points are prioritized. Turbo styling is applied by the plugin at runtime, without modifying the host installation or button behavior.
- **Local font fallbacks**: Prefer Source Han Sans, falling back to the system UI font when unavailable; no font downloads or extra installation required.
- **Light / dark adaptation & cross-version compatibility**: Reuse the host's CSS variables directly; mount via a native Sidecar and CDP without modifying client source code, so it keeps working after client updates.

## Metric definitions

Appearance controls independently select natural/matched height, compact/standard/spacious spacing, panel label case, ring/bar quotas, reset countdown format, and separate column/row layouts and markers for the context breakdown and turn metrics. The sidebar and web page share these individual settings; preset management and settings import/export are not included.

Capsules/popovers use Shadow DOM isolation; native Turbo/model folding retains only footer-scoped runtime styles. Database reads are reused until DB/WAL changes. Renderer code installs once and receives changed data only, while local clocks keep refreshing. Seven-category estimates and attachment scanning are excluded.

Footer speed is scoped to the turn started by the latest user message: show `—` until a completed request supplies valid speed, then retain this turn's latest completed result until another request completes. The dot indicates turn activity, including tools; the number is neither live speed nor a turn average. Popover/sidebar metrics retain the request scope below.

Each latest-request metric has its own row: effective speed, total output, first-token wait and request duration, all enabled by default. Turn metrics have their own group and master switch; step-record counts and an Advanced section are not included. Settings and panels share names, without static numeric samples or permanent fine print; only the existing tooltips remain. The speed switch also controls the footer readout; Speed effects is a default-off child option. Existing choices for the former details switch carry over to the three remaining detail switches.

- Scope is the latest model request, not the entire user turn. Missing values remain unknown rather than borrowing older measurements.
- Output is total output tokens = response (including tool calls) + thinking. Existing four-category context arithmetic is unchanged.
- Request duration = TTFT + streaming duration. Effective speed = total output / request duration, including the TTFT wait but excluding tool execution. Incomplete or zero timings produce no speed.
- TTFT is AGY's recorded `timeToFirstToken`; its exact timer start, measurement source and first-token boundary are unverified. It is not a prefill-only measurement.
- Counts and nanosecond timings were cross-checked against Language Server RPC for 22 local Gemini Hydrogen/Argon requests. The implementation reads SQLite and adds no RPC polling.

### Turn metrics

A separate “This turn” block in the context popover and sidebar shows model requests, Read (R), Write (W), Think and elapsed time. Its master switch defaults to on. Existing latest-request metrics and footer speed retain their original scopes.

- Starts at the latest sent user message, including queueing; each new message resets the totals.
- Requests include recorded retry attempts, excluding pure preflight and injected responses. Steps are not requests, and unrecorded backend calls are not claimed to be covered.
- R sums cached + uncached input across attempts, counting repeated history again. W includes responses/tool-call instructions, not thinking or tool results; these are not the four-category context allocations.
- Elapsed time uses wall-clock boundaries, including waits and tools, never summed request durations. It advances locally while running and freezes at a known end. Missing cancellation timestamps remain unknown.
- Missing usage makes the affected total `—`; hover shows the recorded subtotal. A conversation without a user message hides the block.

## Installation

1. Download or pull this repository, then run the appropriate script:

   | Action | Windows | macOS / Linux |
   |---|---|---|
   | Install | `install.bat` | `sh install.sh` |
   | Update | `update.bat` (pull the latest code first) | `sh update.sh` (pull the latest code first) |
   | Uninstall | `uninstall.bat` | `sh uninstall.sh` |

   Installation/updates sync to `~/.gemini/config/plugins/agy-capsule` (`%USERPROFILE%\.gemini\config\plugins\agy-capsule` on Windows), removing stale plugin files. Uninstall removes the plugin directory but keeps preferences.
2. Enable **agy-capsule** in Antigravity's **Plugins** panel.
3. Open **… → Extensions → agy-capsule** from the conversation header. Switch between the Statistics and Settings tabs at the top of the sidebar.

### Automatic reload

The running plugin checks its installed code/configuration every second. Once changes settle for about 1.5 seconds, it cleans up its injected UI and exits so AGY can restart it and reconnect open sidebars. The installer holds a marker to prevent restarts during a copy. This does not restart AGY, resend chat requests, or copy files from the repository automatically.

The first update from an older version without automatic reload needs one manual plugin restart. After uninstalling, reload any open page that still shows the old UI. Scripts do not modify the host installation. Copying the [`agy-capsule`](./agy-capsule) folder manually also remains supported.

## Notices

- Preferences live in `~/.gemini/config/agy-capsule/settings.json` (`%USERPROFILE%\.gemini\config\agy-capsule\settings.json` on Windows), outside the plugin directory, so updates and uninstalls keep them. Options missing from older files fall back to defaults.
- Modern presentation and language options were inspired by [z21100644's PR #1](https://github.com/Lumidarin/agy-capsule/pull/1). Seven-category estimates and attachment scanning are not included; the PR has not been merged as a whole.
- The quota popover overflow under page-translation extensions was reported, with a proposed fix, in [Krwaby123's PR #2](https://github.com/Lumidarin/agy-capsule/pull/2). This version solves it with column alignment and do-not-translate markers instead of merging that PR directly.

- **Cache expiry is an estimate**: The cache status indicator (yellow warning at 3 minutes / red expired at 4 minutes) is estimated locally based on elapsed time since the last turn and is for reference only; actual cache hits depend on the server.
- **Tested environments & feedback**: Currently tested only on **Windows**. Testing, feedback, and PRs on **macOS** are very welcome!

## License

[MIT](./LICENSE)
