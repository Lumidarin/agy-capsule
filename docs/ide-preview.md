# Antigravity IDE：预览版与桌面 App 有什么不同？

适用版本：Standalone IDE 2.8.0。在 IDE 的扩展面板搜索 `agy-capsule-ide` 安装，或从 [Open VSX](https://open-vsx.org/extension/lumidarin/agy-capsule-ide/) 获取。桌面 App 不用安装这个扩展。

## 五处实现差异

| 使用时的区别 | 桌面 App | Standalone IDE |
| --- | --- | --- |
| 5 小时／每周额度从哪来 | 后台插件直接询问 App 的本地服务，不依赖输入框。 | 输入框读当前 IDE 聊天的原生额度。没连上时，统计页可手动查询官方 CLI 的账号；来源和时间会标明，两个账号不一定相同。 |
| 一时读不到额度 | 本地服务的成功结果缓存 10 秒；之后刷新失败，会继续返回进程里上一次成功值，没有设最长保留时间。 | 一次读取失败，已有数字就标为旧值，详情显示上次读取时间；距成功读取满 2 分钟仍没新值就隐藏。成功读到空列表立即清除；真实的 0% 仍显示 0%。 |
| 跟随哪条对话 | 从宿主拿对话标识及数据目录，再读取相应记录。 | 要匹配窗口、工作区和聊天页。侧栏可以固定历史对话，输入框仍跟随自己的对话；用户可指定包含 `conversations/` 的产品根目录。无本地记录时，可用当前页已加载的信息，但不把片段算进模型历史或 Token 活动。 |
| 入口和设置 | 从 App 的插件入口打开侧栏，使用 App 的偏好。 | 从左侧活动栏打开「统计／设置／模型」。首次从 App 初始化偏好，之后分别保存。默认只在输入框显示胶囊；窗口状态栏须手动开启。 |
| 更新和修复 | App 的更新器读取桌面版 Latest，更新桌面插件。 | 从 0.2.2 起设置页查 Open VSX，点「立即更新」交给 IDE 安装；0.2.1 及更早的已发版本仍查 GitHub。Windows 快捷方式修复只针对 IDE，不会改 App。 |

**为什么断读不完全一样？** IDE 重载聊天页时，额度读取可能短暂中断，账号额度并没有因此变成零。保留上次的数，能避免胶囊闪掉；注明时间并设两分钟上限，能避免半小时前的数字看起来还像实时值。这是 IDE 的显示取舍，不是额度的重置规则，也不是两端必须不同。App 的 10 秒是「多久再尝试刷新」，不是「10 秒后就丢弃旧值」。

## 两个宿主入口

- **新建云端对话**：Standalone IDE 2.8.0 中未找到新建 Remote Agent 对话的入口。要新建，可走 [Google 说明中的 App、网页或 CLI](https://antigravity.google/docs/remote-agents/)。胶囊能读已加载的页面数据，不代表它能创建远程会话。
- **Vertex AI / Google Cloud 登录**：当前 Standalone IDE 未找到使用自有 Cloud 项目按量付费的登录入口；[官方也明确把 Standalone 排除在 Enterprise 部署之外](https://antigravity.google/docs/enterprise/)。其他编辑器中的 Antigravity 扩展是另一种产品。要用自有项目计费，请看 [App / CLI 的 Pay As You Go 指引](https://antigravity.google/docs/pay-as-you-go/)。胶囊识别已有账号的计费类型，不负责登录。

## 分支下载、正式发布和商店是三件事

1. **分支预览（本次）**：源码与 VSIX 放在 `codex/ide-preview`；无需合并 main、创建 Release 或上架。测试时用独立的 `--user-data-dir` 和 `--extensions-dir` 安装旧版，再从 GitHub 下载上方的包，核对 SHA-256 后安装。用相同目录运行 `--list-extensions --show-versions`，看 `lumidarin.agy-capsule-ide` 是否由旧版本变为 0.2.1。此路径验证手动在线升级；插件不会把分支文件当成正式更新。
2. **让「检查插件更新」发现商店新版（从 0.2.2 起）**：将更高版本发布到 Open VSX 即可，不需要 GitHub Release。手动检查重新读取商店版本，不复用之前的空结果；网络异常或商店尚不可见时会提示稍后再查，而不是报“已是最新”。点「立即更新」先走 IDE 原生的指定版本安装；仅当索引找不到该版本时，才从 Open VSX 下载并校验同版安装包，由 IDE 安装。未上架的分支预览不触发更新。旧版用户首次迁移请走 IDE 的扩展页或本地 VSIX，旧按钮不会自动改变。
3. **要从 IDE 扩展商店安装**：本机 Standalone 2.8.0 使用 Open VSX。按 [Open VSX 发布指南](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions) 完成发布者协议、确认对 `lumidarin` 命名空间的权限，使用发布令牌上传同一份 VSIX。保留扩展 ID，并在下一次发布时提高版本号。商店的在线安装／更新需在上架后单独验证。
