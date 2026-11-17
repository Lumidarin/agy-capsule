# agy-capsule

[中文](./README.md) | **English**

Context usage, multi-model quotas, cache status and generation speed in the Antigravity composer footer. Hover a capsule to see its panel; click it to pin the panel open.

<p align="center">
  <img src="assets/readme/hero.gif" width="100%" alt="Hovering the context, quota and request-failure capsules in turn to open their panels" />
</p>

## Context

Shows context usage, cache hit rate and cache status. The limit is read live for the current session and model. **Everything below is optional.**

- **Cache expiry alert**: The capsule icon turns yellow three minutes after the last turn and red at four, meaning the `Cache` has expired. The panel's Cache row changes with it.

- **Context overload alert**: The capsule number turns yellow above 75% and red above 90%.

- **Generation speed**: Shows the speed of this turn's latest request, updated each time a request completes.

- **Speed effects**: A dot that breathes while the model is generating. Red below 10 tok/s, yellow from 10 to under 25, green at 25 and above. After generation stops it keeps its color for 15 seconds, then grays out.

- **Context breakdown**: Splits the context into turn0 (first turn), read, think and write, showing each value and share. Choose rows or columns. Rows can use square or dot markers; columns let you toggle name, value and percent and reorder them.
- **Last request**: Shows the range from first token to the end of the latest request (e.g. `4.5s–8.6s`) and its generation speed.
- **Turn metrics**: Shows this turn's elapsed time, requests, thinking and write.

## Quota

Shows the 5-hour and weekly remaining quota and the reset countdown for the current pool or all pools. **Everything below is optional.**

- **Highlight active model**: Highlights the pool of the selected model and dims the others.
- **Hide absent quota windows**: For example, AI Pro users' Argon pool has no 5-hour quota, so that empty window is hidden.

## Error alerts

A capsule appears only when a request fails; hover or click it to see the raw error and an explanation in the panel. Reasons shown: quota exhausted, rate limited (429), disconnected, authentication error, service busy and unknown. **Optional.**

## Language and appearance

- **Settings language**: English, Simplified Chinese, Traditional Chinese. The language of the settings page.

- **Display language**: English, Simplified Chinese, Traditional Chinese. The language of the panels.

- **Panel height**: Natural height sizes each panel to its content; matched height gives every panel the same height.

- **Panel spacing**: Compact, standard, spacious.

- **Label casing**: Lowercase, title case.

- **Quota indicator**: Ring, bar.

- **Reset countdown**: Compact, localized.

## Settings

Open **… → Extensions → agy-capsule** from the conversation header, then switch between the Statistics and Settings tabs at the top.

Preferences live in <code>~/.gemini/config/agy-capsule/settings.json</code> (<code>%USERPROFILE%\.gemini\config\agy-capsule\settings.json</code> on Windows). Updates and uninstalls keep them; options missing from older files fall back to defaults.

## Installation

1. Download or pull this repository, then run the appropriate script:

   | Action | Windows | macOS / Linux |
   |---|---|---|
   | Install | `install.bat` | `sh install.sh` |
   | Update | `update.bat` (pull the latest code first) | `sh update.sh` (pull the latest code first) |
   | Uninstall | `uninstall.bat` | `sh uninstall.sh` |

   Install and update sync to <code>~/.gemini/config/plugins/agy-capsule</code> (<code>%USERPROFILE%\.gemini\config\plugins\agy-capsule</code> on Windows) and remove stale files from older versions. Uninstall removes the plugin directory but keeps your preferences.
2. Enable **agy-capsule** in Antigravity's **Plugins** panel.
3. Open **… → Extensions → agy-capsule** from the conversation header.

After an update the plugin restarts itself and reconnects the sidebar, with nothing to do by hand. The first update from an older version without automatic reload needs one manual plugin restart.

## Metric definitions

- **Generation speed** = total output ÷ (TTFT + streaming time). It includes the wait for the first token.
- **Last request** covers only the most recent model request, not the whole turn; missing values show `—`.
- **Turn metrics** start at your latest message; elapsed time includes queueing, waiting and tool execution.
- **Cache expiry alerts are only a guide**: the cache state (yellow at 3 minutes, expired at 4) is estimated locally from the time since the last turn; actual cache hits depend on the server.

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

## Notices

- Many features in this version come from [z21100644's PR #1](https://github.com/Lumidarin/agy-capsule/pull/1), picked item by item and reimplemented rather than merged as a whole: multiple languages, parts of the panel visual design, active-model highlighting, click-to-pin, generation metrics and speed effects, Cache and quota tooltips, context overload alerts and error classification, absent quota-window hiding, plus ideas for style isolation, cached reads, incremental CDP pushes and install maintenance. Separate display/settings languages, independent appearance controls, the third failure capsule, folding priority, turn metrics and the later sidebar interactions were designed separately. Seven-category context estimates and attachment scanning were not adopted.
- The quota popover overflow under page-translation extensions was reported, with a proposed fix, in [Krwaby123's PR #2](https://github.com/Lumidarin/agy-capsule/pull/2). This version solves it with column alignment and do-not-translate markers instead of merging that PR directly.

## License

[MIT](./LICENSE)
