# agy-capsule

[中文](./README.md) | **English**

Context usage, multi-model quotas, cache status and generation speed in the Antigravity composer footer. Hover a capsule to see its panel; click it to pin the panel open.

<p align="center">
  <img src="assets/readme/hero.gif" width="100%" alt="Hovering the context, quota and request-failure capsules in turn to open their panels" />
</p>

Promo video (v1.1, also on [Bilibili](https://www.bilibili.com/video/BV1ggsy6rEQM/)):

https://github.com/user-attachments/assets/9f5bf1c6-1284-4e17-a380-defdee83f60c

For a simpler footer like 1.0, turn off Generation speed, Last request, Turn metrics, Request failure capsule, and First-token wait alert in the sidebar [Settings](#settings). Turn off Context breakdown as well if you only want the key numbers.

## Context

Shows context usage, cache hit rate and cache status. The limit is read live for the current session and model. **Everything below is optional.**

- **Cache expiry alert**: The capsule icon turns yellow at 3 minutes after the last turn and red at 4 by default, meaning the `Cache` has expired. Both thresholds can be customized inline in Settings (up to 998 / 999 minutes). The panel's Cache row updates with it.

- **Context overload alert**: The capsule number turns yellow above 75% and red above 90%.

- **Generation speed**: Shows the speed of this turn's latest request, updated each time a request completes.

- **Speed effects**: A dot that breathes while the model is generating. Red below 10 tok/s, yellow from 10 to under 25, green at 25 and above. After generation stops it keeps its color for 15 seconds, then grays out.

- **Context breakdown**: Splits the context into turn0 (first turn), read, think and write, showing each value and share. Choose rows or columns. Rows can use square or dot markers; columns let you toggle name, value and percent and reorder them.
- **Last request**: Shows the range from first token to the end of the latest request (e.g. `4.5s–8.6s`) and its generation speed.
- **Turn metrics (off by default)**: Shows this turn's elapsed time, requests, thinking and write.

## Quota

Shows the remaining 5-hour and weekly quotas and their reset countdowns for the current pool or all pools.

**Vertex AI (Google Cloud pay-as-you-go):** When no subscription quota is returned and Antigravity confirms the account uses Cloud pay-as-you-go billing, the entire quota capsule is hidden.

**Everything below is optional.**

- **Highlight active model**: Highlights the pool of the selected model and dims the others.
- **Hide absent quota windows (on by default)**: For example, AI Pro users' Argon pool has no 5-hour quota, so that empty window is hidden.

## Error & first-token wait alerts

**Both are optional** and share the third footer capsule (request failures take priority when both are active):

- **Request failure capsule**: Appears in red only when a request fails; hover or click it to see the raw error and an explanation in the panel. Reasons shown: quota exhausted, rate limited (429), disconnected, authentication error, service busy and unknown.
- **First-token wait alert**: An amber capsule appears when a wait reaches the threshold (default `30s`, range `1–999s`). `Wait×2 40s` means two intervals reached the threshold this turn, including a current estimate of 40 seconds. Active tools and streaming stop the live clock. Earlier slow waits remain visible in the panel.

## Enhanced model capsule

**Off by default.** When enabled, adds a native-styled model and effort selector to the composer footer (for both existing and new conversations): hover any multi-tier model to pick an effort level in one step from the side submenu, or click a model row directly to switch while inheriting your current effort (downgrading `XHigh`/`Extra`/`Max` to `High` if unsupported). Falls back to the native trigger automatically if the host interface does not match or the footer collapses on very narrow widths.

- **Keep native button (on by default)**: Shrinks the native trigger into a `⋯` bubble next to the capsule so the native menu stays one click away; turn off to replace the native button in place.
- **Hide model tags**: Hides tag badges such as `New` and `Notice` inside the dropdown.
- **Hide default effort**: Hides effort previews in the model dropdown list (the footer button and hover effort submenu still show tiers, and direct clicks still inherit your current effort).
- **Customize models**: Expands the list of models discovered from the host so you can toggle individual models on or off (at least one model always remains visible).

Subagent conversations show the model used in their last request (read-only), context usage, and request alerts. Each capsule stays hidden when its own data is unavailable; it never substitutes data from the parent conversation.

## Usage history

An optional block at the bottom of the sidebar statistics (controlled from a dedicated section at the bottom of Settings) that adds up the token usage recorded in this product folder's local conversations. **Everything below is optional.**

- **Token activity (off by default)**: Shows today's, this week's, this month's and all-time usage, and an activity map of the past year that switches between Daily (one cell per day) and Weekly (one cell per week); a darker cell means more usage. A narrow sidebar keeps only the most recent weeks. Point at a summary total or a cell to see its request count and the split across uncached input, cache reads, cache writes and output.
- **Usage by model (off by default)**: Stacked bars that split usage by model family, by Day (14 days a page), Week (12 weeks) or Month (12 months); ‹ › page back to earlier periods. Below the bars, each model family on the page is listed with its tokens and share; effort-tier suffixes are grouped under their model family by default, and pointing at a model shows its four-part token breakdown plus per-tier usage.

## Language and appearance

- **Settings language**: English, Simplified Chinese, Traditional Chinese. The language of the settings page.

- **Display language**: English, Simplified Chinese, Traditional Chinese. The language of the panels.

  Both language settings only affect agy-capsule's own interface. They don't translate Antigravity itself.

- **Panel height**: Natural height sizes each panel to its content; matched height gives every panel the same height.

- **Panel spacing**: Compact, standard, spacious.

- **Label casing**: Lowercase, title case.

- **Quota indicator**: Ring, bar.

- **Cache indicator**: Icon, ring, bar. Ring and bar fill linearly over time since the last activity, turning yellow then red, and stay full once expired.

- **Reset countdown**: Compact, localized.

## Settings

Open **… → Extensions → agy-capsule** from the conversation header, then switch between the Statistics and Settings tabs at the top.

Preferences live in <code>~/.gemini/config/agy-capsule/settings.json</code> (<code>%USERPROFILE%\.gemini\config\agy-capsule\settings.json</code> on Windows). Updates and uninstalls keep them; options missing from older files fall back to defaults.

## Installation

### Windows

Follow the [Windows installation guide](./docs/windows-install.md#english). It covers downloading, installing, the footer capsule setup, updating, uninstalling and troubleshooting.

To have an AI install it, send this to Antigravity:

```text
Please install agy-capsule for me following https://github.com/Lumidarin/agy-capsule/blob/main/docs/windows-install.md
```

### macOS

Follow the [macOS installation guide](./docs/macos-install.md#english). It covers downloading, installing, the footer capsule setup, updating, uninstalling and troubleshooting.

If you don't use Terminal, send this to Antigravity and let it install for you:

```text
Please install agy-capsule for me following https://github.com/Lumidarin/agy-capsule/blob/main/docs/macos-install.md
```

### Linux

From the repository folder, run `sh install.sh` to install, `sh update.sh` to update (pull the latest code first) and `sh uninstall.sh` to uninstall. The plugin lives in <code>~/.gemini/config/plugins/agy-capsule</code>. Enable it in the **Plugins** panel afterwards. The footer capsule needs Antigravity started with `--remote-debugging-port=0`.

### FAQ

> **The capsule disappeared after an Antigravity update — do I need to update agy-capsule?**
> **No.** Antigravity's auto-update restarts itself without going through your shortcut (or your macOS launcher), so the debugging port isn't open for that launch. Just **quit Antigravity completely and reopen it from your shortcut** to restore the capsule. Once the capsule has worked on your machine before, agy-capsule recognizes this automatically: the sidebar banner clarifies no plugin update is needed (on Windows it also checks whether the installer wiped your shortcut switch and offers a one-click restore button), and an optional one-shot desktop notification alerts you once per launch (on by default in Settings).

## Metric definitions

- **Generation speed** = total output ÷ (TTFT + streaming time). It includes the wait for the first token.
- **Last request** covers only the most recent model request, not the whole turn; missing values show `—`.
- **Turn metrics** start at your latest message; elapsed time includes queueing, waiting and tool execution.
- **Cache expiry alerts are only a guide**: the cache state (yellow at 3 minutes, expired at 4 by default; configurable in Settings) is estimated locally from the time since the last turn; actual cache hits depend on the server.
- **First-token wait alert** combines reported request TTFT with local step timing. The live estimate may start when processing the message begins or after a previous step finishes; it does not use the time the message was queued. The cause is unknown. The count resets when processing the next message begins.
- **Usage history** adds up the uncached input, cache reads, cache writes and output that each model request recorded in the current product folder's local conversation databases. Totals include cache reads (which usually dominate long conversations and do not convert directly to quota consumption) and are not a bill. Only conversations in the current product folder are counted; deleted conversations are excluded (so all-time totals drop if chats are removed), and a response stored in more than one conversation file counts once. Days follow the local time zone and weeks start on Monday. Point at a summary total or activity cell to see the four-part breakdown. Conversations are read incrementally only while at least one usage option is on and the sidebar statistics are open: idle closed databases without a non-empty `-wal` are opened with `immutable=1` to avoid leaving stray `-wal`/`-shm` files, while active or recently modified databases use plain read-only with before/after `.db`/`-wal` fingerprint verification (discarding torn mid-read writes for the next scan). Totals stay in memory and are neither written to disk nor sent anywhere. Usage by model prefers `model_display_name`, falling back to `response_model` (or "Unknown model"), and merges effort-tier suffixes into their model family by default (tier splits appear in the hover tooltip); with more than 6 model families, those with the least all-time usage are combined as "Other models".

<details>
<summary>Details</summary>

**Last request**

- The speed's numerator is total output: response (including tool-call instructions) plus thinking. Incomplete or zero timings produce no speed.
- TTFT and streaming time come from Antigravity's records, and request duration is their sum, excluding tool execution. TTFT's timer start and first-token boundary are unverified, so it is not a prefill-only measurement.

**Turn metrics**

- Starts at the latest sent user message, including queueing; each new message resets the totals.
- Elapsed time uses wall-clock boundaries, including waits and tools. It advances locally while running and freezes at a known end; if a cancellation has no clear timestamp it shows unknown.
- Requests include recorded retries, excluding pure preflight and injected responses; unrecorded backend calls are not guaranteed to be covered.

</details>

## Development tests

Run the Node tests from the repository root. Playwright is not required:

```sh
node --test "test/*.test.mjs"
```

Browser regression tests are optional. With Playwright and Chromium installed, run `node test/browser-regressions.mjs` separately.

## Next stops

Directions we may explore later, with no committed timeline:

- **Sub-agent turn metrics**: Count each sub-agent execution as a turn to show turn duration, request count, and token totals.
- **More effort bar styles**: Offer more optional effort bar looks for the model capsule, keeping the current style as the default.
- **WSL, SSH, and cloud projects**: Show capsules in WSL and SSH remote windows. Cloud project conversations already show the footer capsules, but the host does not offer the plugin sidebar there yet.

## Contributing

Issues and pull requests are welcome. See the [contribution guide](./CONTRIBUTING.md#english).

## Notices

1. **Inspired by @z21100644 ([PR #1](https://github.com/Lumidarin/agy-capsule/pull/1))**: Thanks for the ideas behind multilingual support, parts of the panel design, click-to-pin, active-model highlighting, generation metrics and speed effects, consistent `K` / `M` token formatting, cache and quota tooltips, context overload alerts, request error classification, and hiding absent quota windows. This version also drew on style isolation, SQLite read caching, incremental CDP updates, installation and maintenance, and Sidecar auto-reload, reimplemented to fit this project. It does not include seven-category context estimates or attachment scanning. Separate settings and display languages, independent appearance controls, the request failure capsule, the new footer's collapse order, turn metrics, and Sidebar interactions were designed separately for this release.
2. **Inspired by @Krwaby123 ([PR #2](https://github.com/Lumidarin/agy-capsule/pull/2))**: Thanks for reporting quota panel overflow with page-translation extensions and proposing shared column alignment with widths that adapt to longer translations. This version uses a different grid across quota groups and marks percentages and countdowns as not translatable. Chinese countdowns are still available in Settings.
3. **Inspired by [antigravity-Codex-Claude-effort-slider](https://github.com/LLYSH-HANNARI/antigravity-Codex-Claude-effort-slider)**: Thanks for the approach of reading host model options from the Antigravity model button's React fiber tree and submitting a model + effort pair in one step. Reimplemented here on top of agy-capsule's CDP injector with Antigravity 2.33 and new-conversation support, hover effort submenus, effort inheritance, and customizable model visibility.
4. **Inspired by [wycocoyu/agy-context-dashboard](https://github.com/wycocoyu/agy-context-dashboard) (MIT)**: The daily / weekly activity map and usage-by-model bars of the usage history follow the idea of that project's usage window, reimplemented to fit this project: it reads the local conversation databases directly, without calling the local API or keeping a ledger of its own.

## License

[MIT](./LICENSE)
