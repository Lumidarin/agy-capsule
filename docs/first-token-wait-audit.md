# agy-capsule v1.2.0 首字等待提醒审查

固定版本为 2026-11-19 发布的 `v1.2.0`，提交 `f5907c0909b106e93e32e3292f36b05381b162e1`。建议保留慢等待提醒，把对外名称改为「首字等待提醒」，并将实时值标为本地估算。它适合回答「这一轮等了多久、是否值得提醒」，现有读数无法回答「Vertex 把请求排了多久」。[发行说明](https://github.com/Lumidarin/agy-capsule/releases/tag/v1.2.0) · [版本 README 的指标边界](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/README.md#L118-L134)

## 从会话数据库到第三胶囊

1. 注入器按当前页面的会话 ID 调用 `inspectConversation(id, true)`。Sidecar 按 ID 定位会话 DB，以只读模式打开。按 DB 和 WAL 的 inode、大小、mtime 及本轮统计开关复用快照。未就绪时可能暂用同库同模式上一次成功的结果，下一轮再读。缓存保存数据库结果，页面独立计时。[会话定位与读取](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/server.mjs#L269-L352) · [缓存](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/sqlite_cache.mjs)
2. 从 `gen_metadata` 按 idx 升序读取二进制 data。顶层字段 1 的子字段 11 为 TTFT，子字段 12 为 streaming，单位均为秒加纳秒除以 1e9。缺失 TTFT 返回 null，空 duration 解为 0。顶层字段 2 提供生成的 step 索引，1.20 中的 `last_step_index` 提供请求的输入边界，缺失时为 −1。1.17 是重试列表，错误分类读取最后一条。等待统计直接接收所有可解析请求，不要求有输出或成功，也不要求上下文 token 大于零。[解析](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/server.mjs#L167-L265) · [快照组装](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/server.mjs#L395-L463)
3. 用最新的 `steps.step_type=14 AND status!=11` 定义等待提醒的轮次起点。刚入队、仍为 11 的下一条用户输入不会重置提醒。读取边界之后的 steps，metadata 字段 1 是创建时间，8 是记录的完成时间，另有一个 completedAtMs 取字段 7 或 8。字段 26 的状态转换取最早进入 8 的时刻作为 generatingAtMs，取进入 3/6/7/12 的最晚时刻作为 terminalAtMs。可选表 executor_metadata 提供 reason、lastStepIndex 和 executionId。关闭「本轮统计」仍会生成 turnQueue。[SQL 与解码](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/server.mjs#L334-L375)
4. `summarizeTurnQueue` 缺少合法用户边界时返回 null。请求的 lastStepIndex 达到当前边界、TTFT 有限且非负，便向 waits 加入一项，并标记该行关联的所有 step。再对本轮索引范围内未覆盖的 Planner（类型 15），在时间有效且顺序合理时加入「最早开始生成减去创建」的秒数。两种来源混在同一个数组里。请求 TTFT 写入后，可取代此前利用同一 Planner 算出的估值。程序不按秒数去重，也不按 retry_infos 拆分 TTFT。[历史样本](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/metrics.mjs#L47-L80)
5. 实时路径同时检查终止、工具和流式状态。任一非用户步骤为 1/2/8/9/11 视为活跃；其中非 Planner 会阻止实时估算。Planner 已是 8 也会阻止实时估算。无活跃步骤时，匹配的 executor 结束记录（reason 排除 0/7/12，后面没有新的执行步骤），或只有用户步骤且用户状态为 6/12，可将轮次判为终止。其余情况下优先使用最后一个状态为 1/2 的 Planner 的创建时间。没有 pending Planner 时跳过排队中的用户输入和类型 101/17，改用末步锚点：用户取创建时刻，已完成 Planner 取完成或终态，其他类型先取完成或终态，最后可退回创建时刻。这里完全可能尚无请求记录。[实时锚点](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/metrics.mjs#L53-L109)
6. 注入器通常每秒轮询，renderer 每秒用当前快照和本地 Date.now() 重算。底栏以输入框附近存在取消按钮或有 pending Planner 作为 Working 信号。UI 要求未终止且锚点有效，以当前时刻减锚点得到实时秒数。有效整数阈值为 1–999，默认 30。历史逐项及实时值均按原始秒数 **≥** 阈值判定。计数是「达到阈值的历史项数 + 达到阈值的实时项（0 或 1）」。仅实时项达到阈值时，胶囊才带当前秒数（向下取整）；历史数字在详情中四舍五入，实时项带 +。轮次终止只停表，历史黄标可继续显示。有可显示的请求错误且开关开启时，红色错误优先。该错误来自最后解析的请求行，未按对应用户轮次过滤。[页面时钟与 Working 判定](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/deck_injector.mjs#L788-L794) · [阈值、计数、标题与渲染](https://github.com/Lumidarin/agy-capsule/blob/v1.2.0/agy-capsule/sidecars/agy_capsule/ui.mjs#L464-L517)

## 回放结果与可识别范围

`scripts/replay-wait-audit.mjs` 将 protobuf 写入临时 SQLite，再用正式的 readConversationSnapshot 和 alertView 回放。模拟 Working 信号和时钟，只验证到展示模型及其文字。没有启动真实 UI。回放脚本逐行输出各场景的 JSON 结果。直接可核验的是本地记录的数值、step 状态及时间戳、两次快照的轮次边界和告警输出。Planner 时间差本身可算，其作为首字等待的含义是估计。实时锚点甚至可能早于 RPC 发出。网络上传输的首包、首次生成的 token、首次显示的文字在这条路径中没有独立时间戳。

| 合成输入（阈值 30s） | v1.2.0 结果与解释 |
|---|---|
| 同一已完成请求 TTFT=40s，Planner 也差 40s。分别假设原因是排队、预填充、网络 | 三份相同输入均只显示「排队」，详情 40s。原因只在用例名称中。没有将任何一项假设当作服务端真值，不能确定网络延迟是否落入该 TTFT 的计时窗口。 |
| 29.999s 与 30.000s | 历史与实时均在 30.000s 达阈。实时显示「排队 30s」，只有历史时显示「排队」。 |
| 工具在运行；同一场景已有一个 40s 慢请求 | 前者隐藏；后者保留历史黄标，工具时间不继续累加。 |
| 工具已结束，Working 继续，尚无下一条请求 | 工具结束 40s 后显示「排队 40s」。若只有工具创建时间，例中可显示 85s，其中可能包括整个工具执行期。 |
| Planner 已进入流式，未写请求行；随后写入关联 TTFT=2s | 先按创建到生成的 40s 显示历史黄标，后来快照变为 [2]，黄标消失；流式期间没有继续跳秒。 |
| 同一行有两条失败 retry 加一次成功，且 TTFT=40s | 本轮请求统计识别 3 次尝试，等待计数 1。两条请求行分别报 40s/45s 时计为 2。两条各 20s 均不计，三个 retry 若无 TTFT、无 Planner 生成时间且实时条件不成立则为 0。 |
| 新输入仍为状态 11，随后被消费 | 入队时保留旧轮次；消费时切换边界并清除普通旧 TTFT。假如仍沿用旧的用户创建时间且显示 Working，例中可立刻显示累计 47s。真实消费时点无法从该锚点确定。 |
| 旧请求 lastStepIndex=10，明确关联新用户 idx=20 后才出现的 Planner 21 | 旧 TTFT 被过滤，但旧 Planner 的 40s 又被当成新轮历史。旧轮有 429 且还没有新的请求行时，红标也可遮住新轮的实时黄标。 |
| TTFT 已到、同一 Planner 仍写作 pending；或 TTFT 行缺少 step 关联 | 前者显示「排队×2 40s」（40s 历史 + 40s 实时）；后者可显示「排队×2」（40s TTFT + 40s Planner）。后一种情况下，仅凭两个耗时相等无法确认两者是否同源。 |
| 记录有 TTFT=40s，缺少 last_step_index，Planner 亦无生成时间 | 无法得到历史样本。历史无告警也不能排除发生过长等待。 |

真实服务端排队、模型预填充、网络传输、客户端退避或步骤调度的各自耗时无法从这些观测反推。有 429 或 retry-after 时可以报告该错误或服务方给出的重试间隔，这两者均不提供该请求实际排了多久。要确认服务端排队时长，需要同一请求或尝试 ID 可关联的服务端入队和出队时间，或语义明确的服务端队列时长指标。此审查不估算真实环境的误报率。

## 建议的最小改动

- 设置项「首字等待提醒」，阈值「等待提醒阈值（秒）」，历史胶囊「首字等待×2」，实时胶囊可写「等待×2 约40s」。详情建议「本轮有 {count} 段等待达到 {sec} 秒。耗时来自请求 TTFT 或本地步骤估算；具体原因未知。」仅在实时项达到阈值时附加「当前已等待约 {sec} 秒」。若单独标记弱锚点，工具结束或用户输入后的没有请求证据的间隔可显示「等待下一步」，保留 Working 慢提醒。
- 同步 UI 的 en、zh-CN、zh-TW 词条和三份 README，更新现有测试的旧文案断言。英文可用 First-token wait alert / Wait×2，繁中可用「首字等待提醒／等待×2」。多次计数统一称「达到阈值的等待段」，真实错误保留原优先级。保留已有设置键、默认值及黄色样式，避免影响用户已有配置。修订文档中「超过」「不会误报」「新发消息即清零」的绝对表述。
- 最小测试补丁只增加三个失败用例。对应修复建议为：① 若当前 pending Planner 已有明确关联的有效 TTFT，停止该步的 live 计时，并避免重新落入前一步锚点；② 在 Planner 回填和实时选取前，排除已明确只属于旧请求的 Planner，继续保留归属未知的独立 Planner 信号；③ 对已结束的工具，只认可结束证据作为结束后计时的起点，字段 7 的语义未经核实也应谨慎使用。三种改动均可保留既有正常 TTFT 和 Planner 等待提醒。
- 缺少关联时，优先在详情区别「已记录 TTFT」「Planner 估算」「本地实时估算」。如需把 ×N 升格为去重请求数，必须有可靠的请求与步骤身份映射。按相同时长去重会误吞两个确实相同的慢请求。

## 分支修复与复核

审查基线是 v1.2.0，修复移植到提交 `b5d6cdc`（1.2.3）。本分支更新英文、简中、繁中提醒及文档，并递增 `PANEL_VERSION` 以触发已打开侧栏自动刷新。胶囊短标签为「等待」，实时秒数保持简洁不加前缀（详情与说明中仍注明估算）。保留原配置键、阈值及错误优先级。已有 TTFT 或生成时间证据时停止同一步的实时估算且不再记为 `hasPendingPlanner`；明确只属于旧轮的 Planner 从本轮计算中排除；工具与已完成 Planner 结束后只使用明确的完成或终态时刻（不再退回未核实的字段 7 或创建时间）。回归用例在 [request-alerts.test.mjs](../test/request-alerts.test.mjs)。

后续回归覆盖了四种交错情况：旧轮 Planner 仍在运行时，不用 Working 信号推算新轮等待；已明确属于旧轮的错误不抢占新轮黄标；没有明确的消息处理时间时，不从消息入队时间起算；缺少请求输入索引时，仍可用无冲突的 Planner 关联认领 TTFT 并停表。完全缺少步骤关联时，两种历史来源仍可能重复；归属未知的请求错误仍可显示。实时读数仍是本地估算。

使用 Node.js 24.22.3。从本分支仓库根目录执行以下命令，第一组测试当前分支，第二组在单独的 v1.2.0 副本复现旧行为。回放只写入临时合成 SQLite 文件并在结束后清理。脚本中的中文断言特意与原版文字一致。

```sh
node --test test/*.test.mjs
git clone --depth 1 --branch v1.2.0 https://github.com/Lumidarin/agy-capsule.git ../agy-capsule-audit-v120
node scripts/replay-wait-audit.mjs ../agy-capsule-audit-v120
```

v1.2.0 的 26 个合成快照全部复现。原版 62 项单测中，59 通过，3 个 Windows 专用用例在 Linux 跳过。三项新增回归在原版均失败，在修复分支均通过。
