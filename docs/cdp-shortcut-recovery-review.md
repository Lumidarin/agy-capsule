# CDP 快捷方式恢复回归审查

v1.2.0 引入了侧栏一键修复。本次审查确认了一处状态误判，并给实际执行修复的 PowerShell 补充了 Windows 隔离测试。分支基于 v1.2.3（`b5d6cdc`），代码提交为 `775faa3`。

## 确认的问题与修复

先让快捷方式扫描返回 `missing`，再依次向管理器报告 CDP `ok` 和 `unreachable`。在 v1.2.0 和 v1.2.3 上，最后的 `info()` 都错误地返回 `shortcutState: 'ok'` 和 `canFixShortcut: false`。原因是连接成功时，`observe('ok')` 同时覆盖了上一次快捷方式扫描结果。一次成功连接只能说明当前进程的调试端口可用。

补丁删除了这行赋值。按上述顺序复测，快捷方式仍为 `missing`，侧栏可以提供修复按钮。如果后续扫描发现参数正确，按钮会隐藏，此时连接状态仍可为 `unreachable`。v1.2.3 的同会话关机通知抑制逻辑继续由原测试验证。

## 侧栏 PowerShell 的测试范围

原测试用模拟的 `execFile` 返回修复计数。已有 Windows 用例执行的是独立的 `scripts/enable-cdp.ps1`。新增的 `test/cdp-shortcut-recovery.test.mjs` 从侧栏调用的 `checkShortcuts()` 和 `fixShortcuts()` 进入，通过真实的 `powershell.exe` 和 `WScript.Shell` 创建、修改并重新读取临时 `.lnk`。测试只替换扫描根目录，运行前检查命令未引用默认桌面、开始菜单或任务栏目录。

| Windows 场景 | 验收条件 |
|---|---|
| 多个目录、嵌套菜单、同名干扰项 | 三个目标链接中两个需要修复，返回 `updated=2, failed=0, total=3`。指向卸载程序的链接保持原参数。 |
| 原有参数与重复修复 | 保留带引号的参数和中间的连续空格。第二次返回 `updated=0`，回读只出现一个调试参数。 |
| 写入权限不足 | 在临时目录给当前账户设置拒写 ACL，先确认写打开确实被拒绝。修复报告一项成功、一项失败。撤销 ACL 后重试，只更新先前失败的链接。 |
| 找不到目标 | 删除临时目标链接，只留下卸载程序链接。扫描返回 `unknown`，修复返回 `ok=false, total=0`。 |
| 参数正确、端口不可达 | 真实扫描返回 `ok` 后，向管理器输入 `unreachable`。连接状态保持不可达，`canFixShortcut=false`。此项显式输入连接状态；测试不启动 Antigravity。 |

## 已执行与待执行

Linux、Node.js 24.22.3 上运行全套 `node --test "test/*.test.mjs"`，结果为 **75 通过、0 失败、5 跳过**。跨平台的状态误判用例已在基线失败、在分支通过。五个跳过项均限 Windows，其中两个是本次新增的侧栏 PowerShell 用例。真实 Windows 的 COM 写入、权限拒绝及重试结果仍待验证。

在 Windows 本地仓库检出本分支后，用普通用户 PowerShell 运行：

```powershell
node --test test/cdp-shortcut-recovery.test.mjs test/cdp-setup.test.mjs
```

当前分支预期执行 8 个用例，全部通过且跳过数为 0。请重点核对部分成功时的计数、磁盘上的实际参数，以及撤销 ACL 后的重试。测试自行建立和清理临时目录，无需修改个人快捷方式或提升权限。

## 单独发现的界面提示问题

`server.mjs` 的一键修复回调把所有 `ok=false` 的结果都映射到管理员权限提示。可在隔离界面测试中先返回扫描结果 `missing`，再让修复回调收到 `{ ok: false, shortcutState: 'unknown', total: 0, updated: 0, failed: 0 }`，模拟链接在点击前已被删除。按现有代码会显示权限提示。本分支未改动这段文案。建议修复接口显式区分「扫描完成但没有匹配项」与「脚本执行失败」，并为前者显示“未找到可修复的快捷方式”。
