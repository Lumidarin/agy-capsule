# agy-capsule

[中文](./README.md) | **English**

Context usage, multi-model quotas, cache status and generation speed in the Antigravity composer footer. Hover a capsule to see the details.

<p align="center">
  <img src="assets/readme/hero.gif" width="100%" alt="Hovering the context, quota and request-failure capsules in turn to open their panels" />
</p>

- [Context capsule](#context-capsule)
- [Context panel](#context-panel)
- [Quota capsule and panel](#quota-capsule-and-panel)
- [Error capsule](#error-capsule)
- [Languages](#languages)
- [Also](#also)
- [Settings](#settings)
- [Installation](#installation)
- [Metric definitions](#metric-definitions)
- [Notices](#notices)

## Context capsule

The first footer capsule: how full the context is, whether the cache is still warm, and how fast the latest request generated.

- **Cache alerts**: Turns yellow with a countdown before the cache expires, red after, and back to normal on the next turn; the panel's Cache row changes with it.

  <img src="assets/readme/cap-cache.gif" width="100%" alt="Cache goes from fresh to a yellow countdown, then red when expired, and back to normal after a new turn" />

  <sub>Yellow with a countdown (~1m) three minutes after the last turn, red at four. A local time-based estimate; actual cache hits depend on the server.</sub>

- **Usage warning**: The capsule number turns yellow, then red, as the context fills up, and returns to normal in a new conversation.

  <img src="assets/readme/cap-usage.gif" width="80%" alt="Context usage from 31% to 76% in yellow, 93% in red, then 8% back to normal in a new conversation" />

  <sub>Yellow at 75%, red at 90% and above.</sub>

- **Speed and effects**: Shows the latest request's speed; with effects on, a dot breathes while generating, keeps its color for a while after stopping, then grays out.

  <img src="assets/readme/cap-speed.gif" width="80%" alt="Speed appears, the dot breathes while generating, stays green after stopping, then grays out" />

  <sub>Shows — until the first request completes. Dot color: red below 10 tok/s, yellow from 10 to under 25, green at 25+; it keeps its color for 15 seconds after stopping. Effects are off by default.</sub>

## Context panel

Hover or click the context capsule: what fills the context, and what the latest request and this turn cost.

<sub>The limit is read live for the current session and model (e.g. 256K / 512K); before the first turn it shows 0 / --. The breakdown is turn0 (first turn), read, think and write. See <a href="#metric-definitions">Metric definitions</a>.</sub>

- **Columns or rows, squares or dots**: The context breakdown and turn metrics each choose; rows mode adds a square or dot marker.

  <img src="assets/readme/panel-layout.gif" width="60%" alt="Breakdown switching between columns, rows with squares and rows with dots" />

- **Which fields columns show**: Toggle name, value and percent, and reorder them (see [Settings](#settings)).

  <img src="assets/readme/panel-fields.gif" width="60%" alt="Column fields: adding percent, reordering, hiding names" />

- **Label casing**: Lowercase or title case, across all panels.

  <img src="assets/readme/panel-case.gif" width="100%" alt="Context and quota panels switching between lowercase and title case" />

- **Spacing**: Compact, standard or spacious.

  <img src="assets/readme/panel-spacing.gif" width="100%" alt="Both panels switching between compact, standard and spacious spacing" />

- **Panel height**: Natural fits each panel to its content; matched gives every panel one height, so switching doesn't jump.

  <img src="assets/readme/panel-height.gif" width="100%" alt="Switching between natural and matched height; the context panel stretches to match the quota panel" />

## Quota capsule and panel

The capsule shows the current model's remaining 5-hour and weekly quota; the panel lists every quota pool with reset countdowns.

<sub>The capsule follows the model selected in the footer. Hover a panel row for the exact reset date, time and timezone. Optionally mark the current model's pool in the panel.</sub>

- **Hide idle windows**: When a pool only has a weekly quota (Argon below), hide the empty 5-hour placeholder in the capsule.

  <img src="assets/readme/quota-hide.gif" width="60%" alt="With Argon selected, turning the option on removes the --% placeholder" />

  <sub>A real 0% is never hidden; if both windows are unknown, the placeholders stay. Off by default.</sub>

- **Ring or bar**:

  <img src="assets/readme/quota-indicator.gif" width="60%" alt="Quota panel switching between rings and bars" />

## Error capsule

Appears only when a request fails, and tells you why without digging through logs.

- **Six kinds of errors**: Quota exhausted, rate limited (429), disconnected, authentication error, service busy and unknown reason, each with an explanation and the raw error.

  <img src="assets/readme/error-kinds.gif" width="60%" alt="The six error kinds shown in turn with their explanations" />

  <sub>Stopping generation yourself is not a failure and shows nothing. Context overflow is covered by the usage warning instead. Can be turned off in settings.</sub>

## Languages

- **Three display languages**: English, Simplified Chinese and Traditional Chinese, switching every panel at once.

  <img src="assets/readme/lang-panels.gif" width="100%" alt="Context and quota panels switching between English, Simplified and Traditional Chinese" />

- **Localized countdowns**: Reset countdowns can be compact (4h 11m) or follow the display language (4 hr 11 min, 4小时11分, 4小時11分).

  <img src="assets/readme/lang-countdown.gif" width="60%" alt="Countdown switching between compact and English, Simplified and Traditional Chinese localized formats" />

  <sub>The settings page has its own language, Simplified Chinese by default. Numbers and countdowns are marked do-not-translate, so page-translation extensions cannot scramble them.</sub>

## Also

- **Click to pin**: Click a capsule and its panel stays open; click again, click outside or press Esc to close.
- **Narrow-footer folding**: Stays tidy in narrow windows, keeping the most important information longest.

  <img src="assets/readme/feature-narrow.gif" width="100%" alt="The composer narrows and capsules fold step by step" />

  <sub>The Turbo selector folds to its icon first, then speed, error text and quota numbers fold and the model name shortens, keeping the context and error entry points visible. Widening restores everything.</sub>

<sub>Also: follows Antigravity's light and dark themes; panels stay close to their capsule and inside the composer in narrow footers; mounts through a native Sidecar and CDP with styles isolated in Shadow DOM, so the client is never modified and keeps working after updates.</sub>

## Settings

<img align="right" src="assets/readme/settings-en.png" width="300" alt="Sidebar settings tab" />

Open **… → Extensions → agy-capsule** from the conversation header, then switch between the Statistics and Settings tabs at the top.

| Setting | Default | What it does |
|---|---|---|
| Display language | English | Language of footer panels and sidebar statistics |
| Settings language | Simplified Chinese | Language of the settings page itself |
| Highlight active model | Off | Marks the current model's group in the quota panel |
| Hide absent quota windows | Off | When only 5h or only weekly data exists, hide the empty placeholder |
| Cache expiry warning | On | Yellow at 3 minutes, red at 4 |
| Context overload warning | On | Yellow at 75% usage, red at 90% |
| Request failure capsule | On | Shows a third capsule when a request fails |
| Effective speed / Effects | On / Off | Speed in the footer; effects make the dot breathe while generating |
| Context breakdown | On | The four-part breakdown in the context panel |
| Last request | On | Speed, TTFT and request duration |
| Turn metrics | On | Turn time, requests, thinking and write tokens |

<br clear="right" />

Edit column fields right in the preview: the switch on the right shows or hides a row (hidden rows gray out and move to the bottom), and the handle on the left drags rows into a new order.

<p align="center">
  <img src="assets/readme/settings-fields-en.gif" width="480" alt="Toggling percent and reordering fields in the preview" />
</p>

<sub>Preferences live in <code>~/.gemini/config/agy-capsule/settings.json</code> (<code>%USERPROFILE%\.gemini\config\agy-capsule\settings.json</code> on Windows), outside the plugin directory, so updates and uninstalls keep them. Options missing from older files fall back to defaults.</sub>

## Installation

1. Download or pull this repository, then run the appropriate script:

   | Action | Windows | macOS / Linux |
   |---|---|---|
   | Install | `install.bat` | `sh install.sh` |
   | Update | `update.bat` (pull the latest code first) | `sh update.sh` (pull the latest code first) |
   | Uninstall | `uninstall.bat` | `sh uninstall.sh` |

   <sub>Installation/updates sync to <code>~/.gemini/config/plugins/agy-capsule</code> (<code>%USERPROFILE%\.gemini\config\plugins\agy-capsule</code> on Windows), removing stale plugin files. Uninstall removes the plugin directory but keeps preferences.</sub>
2. Enable **agy-capsule** in Antigravity's **Plugins** panel.
3. Open **… → Extensions → agy-capsule** from the conversation header.

<sub>The UI prefers Source Han Sans and falls back to the system font; nothing extra to download.</sub>

### Automatic reload

The running plugin checks its installed code/configuration every second. Once changes settle for about 1.5 seconds, it cleans up its injected UI and exits so AGY can restart it and reconnect open sidebars. The installer holds a marker to prevent restarts during a copy. This does not restart AGY, resend chat requests, or copy files from the repository automatically.

The first update from an older version without automatic reload needs one manual plugin restart. After uninstalling, reload any open page that still shows the old UI. Scripts do not modify the host installation. Copying the [`agy-capsule`](./agy-capsule) folder manually also remains supported.

## Metric definitions

- **Effective speed** = total output ÷ (TTFT + streaming time). It includes the wait for the first token, so it is not a pure streaming rate.
- **Latest request** covers only the most recent model request, not the whole turn; missing values show `—` rather than borrowing older ones.
- **Turn metrics** start at your latest message; elapsed time includes queueing, waiting and tools.
- **Cache expiry** is a local time-based estimate, not the server's actual cache state.

<details>
<summary>Details</summary>

#### Latest request

- **Scope**: The latest model request's metadata, not the entire user turn. Missing values remain unknown rather than borrowing older measurements.
- **Output**: `usage.outputTokens` is total output = response (including tool calls) + thinking. The four-part context breakdown keeps its existing accounting.
- **TTFT / duration**: AGY's recorded `timeToFirstToken` and `streamingDuration`; request duration is their sum and excludes tool execution. TTFT's exact timer start, source and first-token boundary are unverified; it is not a prefill-only measurement.
- **Speed**: `total output ÷ (TTFT + streamingDuration)`, an effective throughput. Incomplete or zero timings produce no speed.
- **Footer speed**: Scoped to the turn started by your latest message; shows `—` until a request completes, then keeps this turn's latest completed result. With effects on, the dot breathes while the turn runs (including tools), keeps its color for 15 seconds after stopping, then grays out. Red below 10 tok/s, yellow from 10 to under 25, green at 25+.
- **Cross-check**: Counts and timings for 22 local Gemini Hydrogen/Argon requests matched Language Server RPC. The plugin reads SQLite and does no RPC polling.

#### Turn metrics

- Starts at the latest sent user message, including queueing; each new message resets the totals.
- Requests include recorded retries, excluding pure preflight and injected responses. Steps are not requests, and unrecorded backend calls are not claimed to be covered.
- Thinking and write totals sum each request's reported usage. Write covers responses/tool-call instructions, not thinking or tool results, and differs from the context breakdown's write.
- Elapsed time uses wall-clock boundaries, including waits and tools, never summed request durations. It advances locally while running and freezes at a known end. Missing cancellation timestamps remain unknown.
- Missing usage makes the affected total `—`; hover shows the recorded subtotal. A conversation without a user message hides the block.

#### Cache

- The Cache row shows cached input as a share of total input, plus how long ago the latest record was (`<1m`, `5m`, `1h 5m`). This is record age, not remaining cache lifetime.

#### Implementation

- Database reads are reused until the DB/WAL changes. Renderer code installs once and receives changed data only, while local clocks keep refreshing.
- Native Turbo/model-name folding uses footer-scoped runtime styles only, without modifying host files or button behavior.

</details>

## Notices

- Many features in this version come from [z21100644's PR #1](https://github.com/Lumidarin/agy-capsule/pull/1), picked item by item and reimplemented rather than merged as a whole: multiple languages, parts of the panel visual design, active-model highlighting, click-to-pin, generation metrics and speed effects, Cache and quota tooltips, usage warnings and error classification, absent quota-window hiding, plus ideas for style isolation, cached reads, incremental CDP pushes and install maintenance. Separate display/settings languages, independent appearance controls, the third failure capsule, folding priority, turn metrics and the later sidebar interactions were designed separately. Seven-category context estimates and attachment scanning were not adopted.
- The quota popover overflow under page-translation extensions was reported, with a proposed fix, in [Krwaby123's PR #2](https://github.com/Lumidarin/agy-capsule/pull/2). This version solves it with column alignment and do-not-translate markers instead of merging that PR directly.
- Images and GIFs in this README are rendered from the plugin's real code with demo data, not from a live session.
- Currently tested only on **Windows**. Testing, feedback and PRs on **macOS** are very welcome!

## License

[MIT](./LICENSE)
