> 中文请往下划 · Chinese version below

# agy-capsule · Antigravity IDE

For **Antigravity IDE (the Standalone editor) 2.8.0**. The desktop App's install script does not install this extension.

**Most users:** search for `agy-capsule-ide` in the IDE's Extensions view and install it ([Open VSX page](https://open-vsx.org/extension/lumidarin/agy-capsule-ide/)), then continue with step 3.

**Building it yourself:**

1. From the repository root, run `python scripts/package-ide.py` (packaging needs Node and pnpm; using the extension does not).
2. In the IDE, run **Extensions: Install from VSIX…** and pick the generated package, or run:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension .\dist\agy-capsule-ide-0.2.3.vsix --force
   ```

3. Quit the IDE completely, then start it once with these arguments (a Windows Start-menu shortcut can keep them too):

   ```powershell
   & "$env:LOCALAPPDATA\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0
   ```

Look at the **bottom edge of the chat composer, next to the model picker**, for context usage and generation speed. Hover for details, click to pin, click again or press Esc to close. A new conversation with no measured values never borrows the previous one's data, and the numbers in the composer always follow their own conversation. The second capsule reads the IDE's native quota panel: the clock is the remaining 5-hour quota and the calendar is the remaining weekly quota. Click it for each quota pool and its reset countdown; windows that do not exist are hidden, and an exhausted one shows 0%. The third, alert capsule stays hidden until a request fails or the wait for the first token passes the threshold. The 5-hour and weekly values show the percentages returned by the host. If reading drops out briefly, the last successful value is kept and its age is shown in the details; it refreshes automatically once reading recovers. A stale value is kept for at most two minutes, and is hidden immediately when the host explicitly returns an empty list.

By default only the **composer capsules** are shown: starting up, reloading, pinning a past conversation or a brief disconnect never makes duplicate readings flash in the window's status bar. The side panel still works without a debugging port. Only an explicit `agyCapsule.location = statusBar` switches to the window status bar. Composer mode only matches the Google chat page of the current window and workspace in the local IDE.

**Open the side panel:** click the capsule icon in the left activity bar, or run **agy-capsule: Show Details**.

- **Stats:** context, cache, the current turn's requests and quota, plus a Token activity heatmap (day/week, on by default) and per-model statistics (day/week/month, pageable).
- **Settings:** adjust language, layout, alert thresholds, footer display and stats blocks. On first use they are initialized from the desktop preferences and are then saved in the IDE extension's own settings. You can click "Check for plugin updates", "Install VSIX locally" or "Set where conversation records are read", and toggle update reminders. On Windows the IDE launch shortcut can be repaired on demand. Since 0.2.2, a manual check reads Open VSX directly; when a new version is found, click "Update now" instead of downloading from GitHub. If the IDE marketplace index has not caught up yet, the extension fetches the same version from Open VSX, verifies its SHA-256 and hands it to the IDE to install. Update reminders never install or restart anything on their own.
- **Models:** the enhanced picker and effort slider are on by default. You can restore the native ones, show or hide models, and adjust labels, dots and the slider's look. Listing the selectable models needs a connected composer.
- **Pinning a past conversation:** **agy-capsule: Select Conversation** only pins the side panel / status bar and never changes the current chat composer. Embedded chat statistics use `~/.gemini/antigravity/conversations`, which also holds the desktop App's records; the older native chat uses `~/.gemini/antigravity-ide/conversations`.

**Quota without a debugging port:** when the native IDE quota is unavailable, the Stats page offers **Read the CLI account's current quota**. Clicking it runs the installed official `agy /usage`; it is not a background poll. The CLI and the IDE may be signed in to different accounts, so the source and read time are shown, and an inactive window with no number is not guessed. If the CLI asks you to sign in or confirm a workspace, the extension does not do it for you. When the native source explicitly returns an empty list and the account is confirmed as Vertex pay-as-you-go, it says plainly that there is no subscription quota pool; a failed read is not evidence of the billing mode.

**Data location and cloud:** set `agyCapsule.dataDirectory` in the IDE user settings to the **absolute path of the product root** that contains `conversations/`, not a single database or project folder. Left unset, it follows the host default. A workspace override of this option is ignored, and the side panel tells a wrong directory, a new session and "no local record yet" apart. A main chat without a local DB tries to read the records already loaded in the page (the composer must be connected); without timing it shows no estimated speed. Cloud fragments are used only for the current conversation: they are not written to the local DB and are not added to Token activity or model history. A WSL/SSH remote database does not automatically become a local data source because of this option.

**Uninstall:** remove **agy-capsule** in the IDE's Extensions view, or run `antigravity-ide --uninstall-extension lumidarin.agy-capsule-ide`. The desktop version is unaffected.

---

# agy-capsule · Antigravity IDE（中文）

适用于 **Antigravity IDE（Standalone 独立编辑器）2.8.0**。桌面 App 的安装脚本不安装这个扩展。

**普通用户**：在 IDE 的扩展面板搜索 `agy-capsule-ide` 安装（[Open VSX 页面](https://open-vsx.org/extension/lumidarin/agy-capsule-ide/)），然后跳到第 3 步。

**自行打包**：

1. 从仓库根目录运行 `python scripts/package-ide.py`（打包需要 Node 和 pnpm，使用插件不需要另装它们）。
2. 用 IDE 的 **Extensions: Install from VSIX…** 选择生成的安装包，或运行：

   ```powershell
   & "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension .\dist\agy-capsule-ide-0.2.3.vsix --force
   ```

3. 完全退出 IDE，再用下列参数启动一次（Windows 开始菜单快捷方式也可保留这两个参数）：

   ```powershell
   & "$env:LOCALAPPDATA\Programs\Antigravity IDE\Antigravity IDE.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=0
   ```

在对话**输入框底边、模型选择器旁**查看上下文占比和生成速度。悬停看明细，点击固定，再点或按 Esc 收起；新对话没有实测值时不会借用上一条的数据。输入框里的数字始终跟随它自己的对话。第二颗胶囊读取 IDE 原生额度面板的数据：时钟表示 5 小时剩余额度，日历表示每周剩余额度。点击查看各额度池和重置倒计时；没有的窗口不显示，耗尽则显示 0%。第三颗告警胶囊平时隐藏，请求失败或首字等待超过阈值时才出现。5 小时和每周分别显示宿主返回的百分比。临时断读时保留上次成功读数，详情标明更新时间；恢复后自动刷新。旧值最多保留两分钟，宿主明确返回空列表时立即隐藏。

默认只显示**输入框胶囊**：启动、重载、固定历史对话或暂时断连都不会让窗口底栏闪出重复读数。没有调试端口时左侧面板仍可使用。只有显式设置 `agyCapsule.location = statusBar` 才会改用窗口状态栏。输入框模式仅匹配本机 IDE 中当前窗口、当前工作区的 Google 聊天页面。

**打开侧栏：** 点击左侧活动栏的胶囊图标。也可以执行 **agy-capsule: Show Details**。

- **统计**：上下文、缓存、本轮请求和额度，以及默认开启的 Token 活动热力图（日/周）和按模型统计（日/周/月，可翻页）。
- **设置**：调整语言、布局、提醒阈值、底栏显示和统计区块。首次使用从桌面版偏好初始化，之后保存在 IDE 扩展自己的配置里。可点「检查插件更新」「本地安装VSIX」或「设置对话记录的读取位置」，也可切换更新提醒。Windows 可按需修复 IDE 启动快捷方式。从 0.2.2 起，手动检查直接读取 Open VSX；发现新版后点「立即更新」，不用去 GitHub 下载。若 IDE 商店索引尚未同步，扩展会从 Open VSX 取同一版本的包、核对 SHA-256，再交给 IDE 安装。更新提醒不会擅自安装或重启。
- **模型**：默认启用增强选择器和思考强度滑条，可恢复原生、显示/隐藏模型、调整标签、圆点及滑条外观。展示可选模型依赖已连接的输入框。
- **固定历史对话**：**agy-capsule: Select Conversation** 只固定侧栏 / 状态栏，不改变当前聊天输入框。内嵌聊天统计使用 `~/.gemini/antigravity/conversations`，该目录也包含桌面 App 记录；旧原生聊天使用 `~/.gemini/antigravity-ide/conversations`。

**无调试端口的额度：** 原生 IDE 额度不可用时，统计页提供 **读取 CLI 当前账号额度**。点击后运行已安装的官方 `agy /usage`，不是后台定时抓取。CLI 和 IDE 可能登录不同账号，因此标明来源和读取时间；停用窗口若没有数字就不猜。CLI 要求登录或确认工作区时，扩展不会替你操作。原生来源明确返回空列表且账号确认为 Vertex 按量计费时，会明确提示没有订阅额度池；读取失败不是计费模式证据。

**数据位置与云端：** 在 IDE 用户设置 `agyCapsule.dataDirectory` 填写包含 `conversations/` 的**产品根目录绝对路径**，不是某个数据库或项目目录。不设置时跟随宿主默认值。不读取工作区对该选项的覆盖；侧栏区分目录错误、新会话、尚无本地记录。没有本地 DB 的主聊天会尝试读取当前已加载的页面记录（需要输入框连接）；缺少计时就不显示推算速度。云端片段只用于当前对话，不写本地 DB，不加入 Token 活动或模型历史。WSL/SSH 远端数据库不因这项改动自动成为本机数据源。

**Uninstall:** 在 IDE 的 Extensions 中卸载 **agy-capsule**，或运行 `antigravity-ide --uninstall-extension lumidarin.agy-capsule-ide`。桌面版不受影响。
