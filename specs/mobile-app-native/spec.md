# ZCode 原生手机 App(Expo/RN) · Spec

> 状态:P0-P5 已完成 · P6(真机反馈批次二)已实现,只读场景真机 12/12,观感项待人工确认 · 2026-09-30
>
> 实现清单:
> - App:`packages/mobile-app/`(Expo SDK 57 / RN 0.86,`index.ts` → `App.tsx`)
> - 传输:`src/pairingTransport.ts`(扫码配对 + 设备凭证双模式,与桌面 `mobilePairingSession` 对偶)
> - 凭证:`src/deviceCredential.ts`(expo-secure-store,Android Keystore)
> - 任务列表:`src/taskStore.ts` + `src/screens/TaskListScreen.tsx`(controller v4 订阅)
> - 会话(本次):`src/conversation/`(传输 + 聚合)与 `src/screens/SessionScreen.tsx`
> - 构建:`scripts/patch-android-build.mjs`(prebuild 后重打 ndk/JDK17/ABI 补丁)
> - 协议基础:`packages/shared/src/mobilePairing.ts`、`mobilePairingCrypto.ts`、`zcode-protocol-v4/`
> - 桌面侧:见 `specs/mobile-web-remote-control/spec.md`(配对协议、relay 模式、桥接语义)

## 1. 目标与边界

把桌面端"扫码远控"的 Web 页升级为原生 App:更快、可常驻、**免扫码自动连接**,两端可同时使用同一会话。

- **连接**:首次扫码配对后由桌面签发长期设备凭证;之后 App 打开即连(relay 按 `hostId` 路由)。
- **数据面**:复用桌面 Host 的 `attach-service-port`(scope `local`、`clientMode` `web-remote-replayable`),与手机 Web 页同一条 RPC 通道,不新增服务端能力。
- **非目标**:离线缓存与本地写入(P2 不做离线只读);多桌面并发;Bot Channel。

分期:

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 扫码配对 + 原生任务列表 | 已完成 |
| P1 | 设备凭证(免扫码)+ relay `hostId` 路由 + 设备吊销 | 已完成(真机验证) |
| P2 | 会话视图:历史消息 + 实时流式 + 发送输入 | 已完成 |
| P3 | 会话内推进:审批/问答/计划批准 + 中断 + 子代理下钻 | 已完成 |
| P4 | 断线感知与自动重连 + 会话命令面 | 已完成 |
| P5 | 推进能力 + 富工具卡片 + 倒计时 + markdown + 只读展示收尾 | 已完成 |
| P6 | 真机反馈批次二:列表折叠/新建入口、安全区、键盘避让、表格、订阅竞态 | 已完成 |
| P6-3 | 截图反馈:列表卡片化(文件夹/更新于/状态徽标)+ 会话占位语义 | 已完成 |
| P6-4 | 截图反馈二:输入区图标工具条(＋/权限/用量/模型/思考级别) | 本次 |

## 2. 角色与单一所有者

| 状态 | 所有者 | 说明 |
|---|---|---|
| 连接生命周期(建连/断线/重连/代际) | `connectionRuntime`(App 侧单例) | 唯一所有者;建连流程在 `connectionFlows`,探活计时在 `connectionWatchdog` |
| 设备凭证 | `deviceCredential`(SecureStore) | 仅首次扫码后写入;`device_unknown`/`device_revoked` 时清除 |
| 任务/工作区快照 | `taskStore`(controller v4 订阅) | 只读聚合;gap 由 `isWindowHostControllerFrameGap` 判定后重拉 |
| **会话行与水位** | `conversationStore`(App 侧,单一所有者) | rows / seq / logEpoch / status / hasOlder;不写桌面状态 |
| 会话订阅 | `conversationTransport`(每连接一次握手) | subscribe/resync/rowsRange;ACK 与首帧顺序由共享屏障保证 |
| 发送命令 | 桌面 CLI `CommandInbox` | App 只发 v4 命令信封,不做本地队列或重试写入 |

## 3. 协议复用(不新增自有协议)

App 只使用既有 v4 面,不发明私有帧:

1. **握手**(连接级一次):`v4/conversation/hello` → `helloConversationV4()`;`initializeConversationV4({kind:"clientHello", protocolVersion, clientId, clientKind:"mobileApp", appVersion, capabilities})`。
   - `capabilities.workflowRunDeltas` 是**单向声明**:仅当 Host 的 hello 已宣告时才回带,否则老 Host 会因 `.strict()` 解析失败导致整条连接握不上手。
   - 未声明 `workspaceHookReviewUi`(App 无 hook review UI),由桌面按缺省语义处理。
2. **订阅**:`v4/conversation/subscribe { topic: "conversation/<taskId>", sessionId, workspacePath, workspaceIdentity?, visibility:"foreground" }`。
   - 响应只有 ACK(`subscriptionId/mode/logEpoch`);**首帧 snapshot 是 ACK 之后的 notification**,因此必须先有屏障再消费帧。
   - `taskId === sessionId`(controller 任务行的 `meta.taskId`)。
3. **帧**:`v4/conversation/frame` notification → `ConversationTopicWireCandidate`(物理分片)→ `TopicWireFrameAssembler` 组装为逻辑帧 → `conversationTopicFrameSchema` 校验。
4. **增量**:`applyConversationDeltas`(shared 纯函数)应用 7 种 op;文本增量仅 4 条路径(`text`/`inputText`/`output.text`/`summaryText`)。
5. **断档修复**:`frame.fromSeq !== localSeq` 即 gap → `resyncConversationV4({subscriptionId, base:{logEpoch, seq}})`;重同步失败或 `base` 不可用时重新 `subscribe`。
6. **分页**:`conversationRowsRangeV4({sessionId, beforeRowId, limit<=200})`,按 `atLogEpoch` 判定陈旧后前插。
7. **发送**:`sendConversationCommandV4({workspace..., envelope})`,`type:"sendText"`(不需要 `baseRevision`);ACK 状态 `accepted|rejected|stale|duplicate|noop|failed`。
   - 本地只做乐观一行(pending),收到 ACK 后按 `status` 决定保留或回滚,不参与服务端定序。

## 4. 事件顺序

```
App 启动 ─ connect ─→ auth(pairing|device) ─→ bridge_ready ─→ RPC 可用
                                                                  │
任务行点击 ─→ conversationTransport.subscribe(sessionId)          │
                     │                                            │
                     ├─ barrier.begin(topic)  ← 先建屏障           │
                     ├─ v4/subscribe ──ACK(subscriptionId)─────────┤
                     └─ barrier.bind                              │
                                     │                            │
store: subscription = ACK(ownership 先写)                          │
       └─→ transport.activate(subscriptionId) → 回放暂存首帧       │
                                                                  │
notification: frame(snapshot) ──────┴─→ store.replaceRows(rows.window, seq)
notification: frame(deltas)  ─────────→ store.applyDeltas → 推进 seq
                                          │
                              fromSeq !== seq ─→ resync(base) ─→ 失败则重订阅
```

- **屏障不可省**:notification 与 RPC response 无先后保证,缺屏障会静默丢掉首帧快照(表现为"进去永远空白")。
- **activate 必须在 ownership 之后**(P5 真机反馈修复):首帧若先于 ACK 到达,barrier 暂存并在 activate 时同步回放;activate 若发生在 store 写入 `subscription` 之前,回放帧会被 `applyFrame` 的 subscriptionId 检查丢弃,界面停在"正在加载会话…"直到下一次 resync——新建草稿会话在桌面端必现(服务端零延迟回 initial frame)。顺序:store 写 ownership → `transport.activate`,与桌面 `conversationProjectionStore` 同序;resync 的重订阅路径同规则(`adoptSubscription` 统一收口)。
- replayable profile 下 `row.delta` 仅保留 `text` 路径;工具输出/参数等靠 `row.upserted` 定稿补齐,UI 必须容忍字段"跳变"而非逐字增长。

## 5. 生命周期与失败语义

| 事件 | 行为 |
|---|---|
| 进入会话屏 | 订阅 topic;先渲染骨架,首帧到达后填充 |
| 离开会话屏 | `unsubscribeConversationV4`;屏障 `forget(subscriptionId)`;保留已渲染行到下次进入(不缓存到磁盘) |
| 收到 gap / resync 失败 | 显示"正在同步"并重试(指数退避),连续失败显示错误与手动重试 |
| **连接断开(WS close)** | 读取 relay 的 `CloseEvent.code/reason` 分类:可恢复 → 拆死连接(在途 RPC fail-closed)+ 保留最后画面加横条 + 退避重连;`superseded` → 终止态提示"已在另一台手机上接管" |
| **退避上限按原因分档** | 对端瞬时不可用(`pair_unknown`/`host_disconnected`/`closed_by_host`/`relay_shutdown`)封顶 **10s**:relay 重启后桌面端要按它自己的退避重新注册(实测可滞后数十秒),手机沿用 30s 上限会把组合延迟翻倍;网络类原因(`probe_timeout`/异常关闭)仍封顶 30s,避免手机反复重连耗电 |
| **凭证/身份真的失效** | 横条提供两个出口:「重新扫码」(清凭证回扫码页)与「停止重连」(停退避,停在错误页可手动重试)。不做"N 次后自动回扫码页"——那会在桌面端只是慢时误清有效凭证 |
| **半开连接(静默假死)** | 前台且 30s 无入站帧 → 发一次 `helloConversationV4` 探针(15s 超时);超时即按断线处理。后台不探活 |
| **重连成功** | 连接代际自增 → 屏幕按 key 重建 → 会话重新拉快照、任务列表重新订阅;横条消失 |
| **重连耗尽?** | 不耗尽:1s→2s→4s→8s→15s→30s 后固定 30s 无限重试;用户可点横条上"停止重连"停在错误页手动重试 |
| 重连期间交互 | 横条 + 禁用发送/审批/中断(避免在死连接上发命令永久挂起);只读浏览保留 |
| 桌面侧会话被删 | 订阅收到错误 → 显示"会话不可用"并提供返回 |
| 发送失败 | ACK `status !== "accepted"` 时展示 `reasonCode/message`,输入内容保留在输入框 |
| 历史不足 | 列表顶部"加载更早";`hasMore=false` 时隐藏 |

连接健康状态机(单一所有者 `connectionRuntime`):

```
idle ──start(有凭证)──> connecting ──成功──> ready(banner=null)
  │                          │                 │
  └─start(无凭证)──> pair     └─失败(凭证失效)─┴─> error(清凭证)
                                 │                 ↑
                     WS close 可恢复 / 探针超时      │停止重连
                                 ↓                 │
                        ready(banner=正在重连) ──重连成功──> ready(新 generation)
                                 └─ 4000/superseded ──> error(终止,不重连)
```

## 6. 安全边界

- 设备凭证只存 Android Keystore(SecureStore);不落日志。
- App 不持有 workspace 文件系统路径之外的能力:全部 RPC 走既有 attachment 门禁(replayable profile、clientId 绑定、订阅 ownership)。
- 发送命令的 `envelope.clientId` 必须等于握手绑定的 clientId,否则桌面回 `fault.command.clientMismatch`。
- 不在 App 内实现"绕过审批/自动确认"路径;审批继续由桌面承担。

## 6.1 P3:会话内推进(审批/问答/计划/中断/下钻)

手机要能"推进"任务,而不只是看。全部复用既有命令面,**不新增协议**:

| 能力 | 数据来源 | 命令 |
|---|---|---|
| 命令/文件编辑审批 | `snapshot.pendingInteractions[kind=permission]` | `resolveInteraction{interactionId, answer:{optionId, freeText?}}` |
| AskUserQuestion 问答 | `pendingInteractions[kind=userInput]` + `payload.questions` | `resolveInteraction{action:"accept", content:{answers}}` |
| 计划批准(ExitPlanMode) | `userInput` 且 `payload.toolName` 为 `ExitPlanMode` | `resolveInteraction{action:"accept", content:{answer:"approve"}}` / `{action:"decline"}` |
| 中断当前 turn | `control.canStop` / `control.activeWorks[].foregroundExecutionId` | `stop{expectedForegroundExecutionId?}` |
| 子代理下钻 | `subagentRow.childSessionId` | 无命令;新订阅 `conversation/<childSessionId>` |
| 计划进度 | `snapshot.plan`(只读) | 无 |

关键约束:

- **答案形状必须与桌面一致**(由 CLI `interaction-broker` 归一):
  - 问答:`content.answers` 以**问题原文**为 key,值是多选项以 `", "` 连接的字符串(数组亦可被归一,但按桌面形式发送);
  - 计划反馈的语义反直觉但必须照抄:反馈文本走 `{action:"accept", content:{answer:<反馈>}}`,由 CLI 映射为 `deny + reasonSource=plan_approval_feedback`;真正的拒绝是 `{action:"decline"}`。**不能**把反馈发成 `{action:"decline"}`(会丢失反馈),也不能把非 approve 文本发成 `accept` 之外的动作。
  - 批准计划必须带 `content.answer === "approve"`(哨兵值),否则被当成反馈而拒绝。
- **不渲染 privileged `fullAccessOption`**:它走 `host.interactions.resolveFullAccess` 特权路径,手机上误触代价过高,留给桌面。
- `workspaceHookReview` 交互**不在手机渲染**(握手未声明 `workspaceHookReviewUi`),但它在 `pendingInteractions` 里的存在不得阻塞其它交互的渲染与响应。
- 命令均不需要 `baseRevision`(不在 CAS/行目标集合内);`resolveInteraction` 是 first-writer-wins,重复回答幂等成功。
- 队列命令(`sendQueuedNow`/`editQueueItem`/`reorderQueueItem`/`deleteQueueItem`/`setAutoDrain`)需要 `baseRevision`,P3 不做,留 P4。
- 文件回滚(`applyFileRewind`)是破坏性行目标命令,P3 不做。

交互模型与答案构造放在纯函数模块(`src/conversation/interactionModel.ts`),由验证脚本覆盖;
UI 只消费模型,不自己拼协议字段。

## 7. 验收场景

1. 免扫码连接后点任务 → 会话屏出现历史消息(用户气泡 + 助手文本 + 工具卡片)。
2. 桌面端正在跑的任务:App 上文本逐字增长,工具状态从 running → success。
3. 上滑加载更早:行前插且不重复、不跳位。
4. 断网重连(切飞行模式再恢复):会话屏自动恢复并补齐缺失行,不出现重复行。
5. 发送一条消息:输入框清空;ACK 失败时给出原因且文本不丢。
6. 任务空闲时发送 → 触发新 turn;任务运行中发送 → 服务端 admission 决定排队或立即,App 如实反映 ACK。
7. 桌面弹出命令审批 → 手机出现审批卡片;点"允许一次" → 桌面侧该工具开始运行(桌面与手机状态一致)。
8. 桌面弹出计划批准 → 手机可批准(开始实施)或拒绝;填反馈后拒绝时,反馈出现在桌面会话里。
9. AskUserQuestion 多选 → 手机勾选若干项提交,桌面收到以 ", " 连接的答案。
10. 跑了很久的 turn:手机点中断 → turn 结束(状态变为已中断),排队消息不被清空(桌面语义)。
11. 点工具卡片里的子代理 → 进入子会话视图,返回后父会话仍是最新状态。
12. 手机在运行中的会话里看到计划进度(已完成/总数),并随子任务推进更新。
12a. 计划明细默认收起(只显示「计划 N/M」摘要行),点「展开 ▾」看全列表;状态条其余区块不变。
13. 杀掉桌面端:手机在 1s 内出现横条(显示"桌面端已离线"+ 下次重试倒计时),画面保留;重开桌面后自动连上、内容跟上,无需任何手动操作。
14. 手机开飞行模式:30s+15s 内探针超时发现断线并出横条(原因"网络无响应");关掉飞行模式后自动恢复。
15. relay 重启后手机自动恢复;恢复耗时含**桌面端重新注册**的时间(实测可达数十秒),横条上能看到原因与倒计时,不会误判为卡死。
16. 凭证/身份真的失效(例如桌面端登记表被重建):横条可"重新扫码",不用干等退避。
17. 上滑会话历史时**自动加载更早**的消息(顶部只显示"正在加载更早…"),前插时视口不跳位。
18. 已完成的轮折叠为一行「已工作 N 秒 / 已处理 / 已停止」,点开看过程;运行中的轮默认展开;中断/失败强制展开;最终助手正文常显。
19. 从会话返回任务列表:列表内容仍在、继续实时更新,不需要重建订阅;若订阅超时/失败,列表给出"重试"。
20. 返回列表后再进入**另一个**会话:发送、审批、中断都必须成功(此前会因 clientId 未绑定被拒)。
21. 每个工作区可"＋ 新建任务":进入会话屏输入首条消息,发送后该任务出现在列表里(草稿会话不落库,与桌面一致)。
22. 会话头部可切换模型与权限模式(含计划开关),选择在**下次发送**时生效(与桌面 composer 同语义)。
23. 后台有长跑任务时,会话顶部状态条列出并可直接取消;取消后该项从状态条消失。
24. 排队消息可见,可"立即发送"或"删除";并发修改导致 `stale` 时自动用服务端 revision 重试,重试耗尽给出明确提示。
26. AskUserQuestion 这类会自动收尾的交互显示"还剩 N 秒自动处理";用户一动(点选项/填文本/提交)倒计时即暂停(只发一次 snooze,失败静默)。
28. 完成的一轮在摘要行显示文件改动(`3 个文件 +12 −4`,已还原时显示"已还原");用户消息带附件时显示附件数量与文件名(不拉取图片)。
29. 有工作流在跑时会话顶部显示"工作流 <id> · 运行中 · 已用 N 步 · X tokens";结束后该行消失。
27. 助手正文按 markdown 渲染:代码块等宽展示、行内代码高亮、链接可点开、列表/标题/引用有层次;不支持的语法原样保留文本(不吞内容)。
25. 工具卡片与桌面同信息量:文件编辑显示 `+新增 −删除` 与逐行 diff(带 +/- 上色),Bash 显示命令与输出(运行中跟随后台输出),读取/搜索显示文件名与命中行数;点"展开"看正文,内容被截断时标注(含完整输出位置)。
16. 断线期间发送/审批/中断均不可用(按钮禁用),界面不卡死;`superseded` 时提示已由另一台手机接管且不再重连。
30. 项目列表:点项目行展开/收起其下任务(默认展开,行首箭头指示状态);「＋ 新建任务」收进项目行尾的小圆钮,不再占一整块按钮。
30a. 项目卡片化:每个项目一张卡(文件夹图标 + 名称 + 类型徽标 / 路径 / 「更新于 X」+「N 个任务 ▾」+「＋」),任务行在卡片内缩进一级(标题 + 相对时间在左,状态徽标右对齐)。
30b. 启动器图标与桌面版同款(`assets/icon.png`,桌面 `packages/desktop/build/icon.png` 的拷贝;prebuild 重置后由 `patch-android-build.mjs` 重打 mipmap)。
31. 会话屏顶部(返回/中断按钮)与底部输入框不被系统状态栏/导航条遮挡(edge-to-edge 由 App 自行让出安全区)。
32. 唤起键盘后输入框抬到键盘上方,输入内容可见;收起键盘恢复。
33. 助手正文中的 markdown 表格按表格渲染(表头加粗底色、分隔线、列对齐);不是合法表格的竖线文本原样保留。
34. 新建任务进入会话后**立即**脱离"正在加载会话…"(首帧先于 ACK 到达时由 barrier 暂存、ownership 就位后回放);运行中的会话随时可见「中断」按钮。
35. 会话输入框占位文案与桌面 composer 同语义:无历史 →「向 ZCode 提问…」;有历史空闲 →「提出后续修改要求」;处理中 →「继续输入以排队后续修改」。
36. 会话输入区底部是图标工具条(与桌面 composer 同构,单色线性图标 `MaterialCommunityIcons`——不用彩色 emoji):plus 添加上下文(移动端暂不支持,点击给一次性提示)· shield-alert 权限模式 · chart-donut 上下文用量(已用/上限/剩余%/距自动压缩)· cube 模型 · brain 思考级别(关闭/低/高/最高等,取值来自 `config.thoughtLevels`,provider 未知档位原样显示),右侧发送。选择仍只随下次发送提交:
    - 思考级别住在 `modelSelection.options.reasoningLevel`;只改档位时用会话当前模型补齐 provider/model(`resolveBaseModel`),没有基线模型则不下发(不伪造 provider);换模型会清掉草稿级档位(旧档位可能不被新模型支持)。

## 8. 构建与验证
- 类型与静态检查:`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`;App 侧另有 `npx tsc -p packages/mobile-app/tsconfig.json --noEmit` 与 `npx oxlint App.tsx index.ts src`。
- 会话聚合、交互语义、连接生命周期与展示收敛:`pnpm --filter @zcode/mobile-app verify:conversation`(= `node scripts/verify.mjs all`),共七组:
  - `verify-store.ts`(32 项):快照/重复帧/delta/gap/分页前插/发送 ACK/交互应答下发/中断命令/dispose/**首帧先于 ACK 的订阅竞态**(`pushBeforeAck` 模拟 barrier 暂存回放);
  - `verify-model.ts`(16 项):交互卡片识别与答案形状(审批、计划哨兵值、问答 ", " 连接、hook review 跳过、计划进度);
  - `verify-connection-policy.ts`(25 项):断线分类表、退避封顶与按原因分档(10s/30s)、探活阈值/前台抑制、显式超时;
  - `verify-runtime.ts`(31 项):注入假 transport 与假时钟,覆盖断线保留画面+横条、退避重连、代际自增、`superseded` 终止不再重连、凭证失效清库、停止重连、重复断线不叠加、**一次断线只允许一条重试链**、**迟到定时器不得拆掉已恢复的连接**、`pair_unknown` 反复失败后仍能收敛;
  - `verify-markdown.ts`(21 项):行内代码/加粗/链接、代码块原样保留、未闭合围栏不吞内容、标题/引用/有序无序列表、列表项内行内标记、CRLF 归一、**表格**(对齐/行内标记/缺列补空/非法表格按段落保留/转义竖线);
  - `verify-tool-cards.ts`(25 项):工具卡片取值优先级(error → output.display → row.display → outputPreview → output.text)、六类工具摘要、diff 行前缀与截断标注、半截 JSON 入参、未知工具兜底;
  - `verify-turn-model.ts`(23 项):轮分组与过程收敛(完成轮折叠/运行轮展开/中断失败强制展开/无最终正文不折叠/带 actions 的正文优先/时长文案),以及草稿级模型与模式的选项表与发送载荷。
  - 脚手架与夹具在 `verify-harness.ts`(按 schema 推最小合法值,避免手写巨型 fixture 与 schema 漂移)。
- 真机:`bash packages/mobile-app/scripts/build-android-release.sh --install`(prebuild → 重打补丁 → gradle → adb install);桌面端需为已含 P1 host 的构建。

**P3 验证记录(2026-09-29)**:会话与交互用例 38/38 通过;根 typecheck 通过、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净。协议前提已核对:`state.updated` 补丁(含 `pendingInteractions`/`control`/`plan`)不受 replayable profile 过滤,手机能拿到交互与控制面。

**P4-1 验证记录(2026-09-29,断线感知与自动恢复)**:
- 用例 94/94 通过(store 22 + model 16 + policy 25 + runtime 31);根 typecheck 通过、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净。
- 修复的真缺陷:① ready 之后无人监听连接(device 模式从未订阅 phase、pairing 模式的监听器只认 connecting 态),断线后界面永久"假在线";② 自然断连时没人 dispose `ChannelClient`,而其 `write` 在 socket 非 OPEN 时静默丢帧 → 在途与后续 RPC 永久挂起(连"重试"按钮都不响应);③ relay 的 `CloseEvent.code/reason` 被直接丢弃,重连策略拿不到事实;④ `onPhaseChange` 返回的退订函数是 `() => undefined`,每次重连都会叠加监听器。
- 探针的 RPC 往返依赖真实 host,由真机飞行模式场景覆盖;判定规则由 policy 用例覆盖(不谎称已实测)。

**P4-1 真机排障结论(同日,含一处被推翻的假设)**:
- 现象:手机上横条显示"第 8 次 · 30 秒后重试",且计数在多次测试中都停在 8,一度怀疑计数残留。
- 排障:给横条临时接入诊断字段(运行时实例 id / 连接代际 / 原始关闭次数 / 计数变更轨迹与时间戳),真机跑出 `fire#5@41624/wait=15016/d=15000` → `retry-fail#6@41648` → `fire#6@71668/wait=30020/d=30000`,证明**退避与计数完全正确**。
- 真实根因:relay 重启后**桌面端要数十秒才重新注册 hostId**(实测滞后 85s),这段时间 relay 对手机的 `app_auth_init` 只回 `pair_unknown`,手机按 30s 上限重试 → 计数真实爬到 8。**不是计数 bug**;被推翻的"并发重试链/定时器泄漏"假设不作为结论。
- 保留的加固(与上述结论无关但确有价值):一次断线只允许一条重试链(`reconnectScheduled` 门)、迟到定时器不得拆掉已恢复的连接、失败尝试也要 dispose 自己创建的 transport。
- 由此新增:按原因分档的退避上限(10s/30s)、横条「重新扫码」出口、横条显示断开原因与倒计时。
- **结案**:计数复位本身由 `verify-runtime.ts` 覆盖(重连成功后从 1 重新计数),真机上观察到的"恒为 8"来自长命进程累积的真实失败次数(排查中确认 `adb shell am force-stop` 在华为机型上不生效,此前所谓"冷启动"复用的仍是同一进程),无需再复现。

**P2 验证记录(2026-09-29)**:
- 会话聚合脚本 15/15 通过;首轮执行时抓到两个真缺陷并修复:
  1) 水位未随帧推进——`applyConversationDeltas` 只改窗口内容,不回写 `seq`,漏写会让下一帧的 `fromSeq` 永远对不上而误判断档;
  2) 合并通知的 `pendingNotify` 未置真,导致流式行更新永远不触发重渲染(界面停在首快照)。
- 静态检查:根 `typecheck` 通过、`lint` 0 error(72 warning 为既有)、架构检查 0 违规;App `tsc`/`oxlint` 干净。
- 产物:APK 已构建(`android/app/build/outputs/apk/release/app-release.apk`,37MB),bundle 内含 `conversation/`、`sendText`、`mobileApp` clientKind 与共享屏障标记,旧占位提示已消失。


**P4-2 验证记录(2026-09-29,真机反馈批次)**:
- 用例 124/124 通过(store 22 + model 23 + policy 25 + runtime 31 + turns 23);根 typecheck、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净。
- 修复的真缺陷(均来自真机反馈):
  1. **clientId 未绑定**(必现):会话屏每个实例各自生成 `client-<uuid>`,而桌面 facade 在握手时绑定它 → 返回列表再进会话后,发送/审批/中断都被以 `fault.command.clientMismatch` 拒绝(表现为点了没反应)。现改为连接级稳定 clientId(由 connectionRuntime 下发),握手与信封统一走 `agentCommandClient`。
  2. **列表订阅无出口**:订阅 RPC 在"已死但未判定"的连接上永久 pending → 界面永远停在"正在同步项目与任务…";连接已拆时又直接失败且**没有重试入口**;gap 的 resync 失败被吞掉 → 列表静默停更。现在:订阅超时 10s 转错误态 + 列表"重试"按钮,gap 失败改为退订重订阅。
  3. **列表随屏幕卸载**:进入会话即卸载任务列表、返回时重建订阅(与桌面/Web 的常驻侧栏相反)。现改为列表常驻、会话作为上层覆盖。
  4. "加载更早"按钮错放在列表底部;改为滚动到顶部自动加载 + `maintainVisibleContentPosition` 防跳位。
- 新增能力:轮级过程收敛(与桌面同规则)、草稿级模型/权限切换(与桌面 composer 同语义)、每工作区"＋ 新建任务"(`createSession`,草稿会话)。
- 未在真机验证:以上均只跑了用例与静态检查——本批构建完成时手机已断开(`adb: no devices/emulators found`),需插上后执行 `bash packages/mobile-app/scripts/build-android-release.sh --install` 并按验收场景 17-22 逐条确认。


**P5 验证记录(2026-09-30,推进能力 + 富工具卡片)**:
- 用例 166/166 通过(store 29 + model 33 + policy 25 + runtime 31 + turns 23 + tools 25);根 typecheck、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净;APK 已构建(08:32)。
- **P5-1 推进能力**:后台工作取消(`cancelBackgroundWork`)、队列可见与操作(`sendQueuedNow`/`deleteQueueItem`,CAS + stale 收敛);判定与文案在 `conversation/runtimeActions.ts`,展示在 `screens/SessionStatusBar.tsx`。为守住单文件行数上限并理顺分层,顺带拆出 `conversation/sessionCommands.ts`(命令下发层,含 sending/rejected 操作态收口)与 `conversation/conversationView.ts`(对外视图契约)。
- **P5-2 富工具卡片**:`conversation/toolCardModel.ts` 统一取值优先级(与桌面 `toolCallRowAdapter` 一致:`error → output.display → row.display → outputPreview → output.text → input`),按 6 类工具给"折叠摘要 + 可展开正文";diff 直接用 `structuredPatch[].lines`(内容自带 `+`/`-`/空格前缀)按前缀上色,不引入 diff 渲染库;截断标注读 schema 的 `truncated` 字段而非猜字数;流式期用 shared 的 `buildZCodeStreamingToolInputPreview` 从半截 JSON 恢复 `command/file_path/pattern`。渲染在 `screens/ToolCallCard.tsx`(每张卡独立展开态)。
- 仍未在真机验证(P4-2 与 P5 两批):手机在两次构建期间均处于断开状态;需插上后 `bash packages/mobile-app/scripts/build-android-release.sh --install` 并按场景 17-25 逐条确认。


**P5-3/P5-4 验证记录(2026-09-30)**:
- 用例 184/184 通过(store 30 + model 38 + policy 25 + runtime 31 + turns 23 + tools 25 + markdown 12);根 typecheck、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净;APK 已构建(08:39)。
- **P5-4 审批倒计时**:`describeAutoResolution` 纯函数区分 `hiddenGrace`(宽限期内不显示,避免惊扰)/`visibleCountdown`(显示"还剩 N 秒自动处理",不足 1 秒也显示 1 秒)/`snoozed`;用户首次交互即发一次 `snoozeInteractionAutoResolution`(幂等、失败静默,与服务端 first-writer-wins 一致)。
- **P5-3 markdown**:自研轻量解析(不引第三方库,理由:只需 7 种语法、需与主题一致、需可单测),代码块原样保留(含内部 `**` 等符号与空行),未闭合围栏退化为段落保证不吞内容。
- 仍未在真机验证(P4-2 + P5 共三批):手机在多次构建期间均处于断开状态。


**P5-5 验证记录(2026-09-30,只读展示收尾)**:
- 用例 194/194 通过(store 30 + model 45 + policy 25 + runtime 31 + turns 26 + tools 25 + markdown 12);根 typecheck、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净。
- 每轮文件改动:取 `turnHeader.fileChanges` 合并进过程块摘要行(`3 个文件 +12 −4`,已还原时改文案),**只读**——`applyFileRewind` 是破坏性 + CAS + 行目标命令,手机端不做。
- 工作流运行:只展示 `pending`/`running` 的 run(最多 3 条),含 `usage.nodesUsed` 与 `spentTokens`;结束后自动消失。
- 附件:用户消息行显示"📎 N 个附件 · 文件名…",**不拉取字节**(图片预览需要附件传输接口,留给后续;桌面仍负责预览与分享)。
- P5 功能项至此全部完成(推进能力/富工具卡片/倒计时/markdown/文件改动/workflow/附件摘要)。剩余:真机回归(P4-2 + P5 共五批改动)与运维债(relay TLS、Web 页同类缺口、桌面端在线态呈现、preload 既有类型错误)。


**真机验证记录(2026-09-30 09:2x,构建 09:23:46,华为 ALN-AL00)**
已在真机确认:
- 场景 21:任务列表每个工作区都有「＋ 新建任务」;场景 17:无底部「加载更早的消息」按钮(自动加载已生效)。
- 连接:免扫码直连正常(状态行「已连接(免扫码) · 4 个工作区 · 6 个任务」)。
- 场景 22:会话头部出现模型切换条(「模型 · deepseek/deepseek-v4-flash-vision-exp」)与模式(「完全放行」)。
- 场景 18:完成轮折叠为一行「已工作 351 秒」;过程块有「查看过程」入口,展开后出现 3 张 Bash 工具卡片(各带「展开」与状态词)。
- 场景 25(摘要部分):工具卡片摘要显示命令(`cd … && wc -l …`)与输出末尾预览,与设计一致。
- 场景 19:返回列表正常,列表常驻未卡在同步态。

尚未在真机确认(手机被用户占用,自动化已停止):
- 场景 20(返回后再进会话发消息的 clientId 回归)、场景 23/24(后台工作取消、队列操作,需现场有排队或后台任务)、场景 26(倒计时,需现场有 AskUserQuestion)、场景 27(markdown 实际观感)、场景 28/29(文件改动与工作流行)、场景 25 的卡片正文展开。
- 可用一条命令跑完只读场景:`bash packages/mobile-app/scripts/verify-device-scenarios.sh`(加 `--send` 会额外在新建草稿会话里发一条消息,验证命令链路)。

排查备注:本机 `uiautomator` 给出的 `bounds` 是**窗口相对坐标**,直接按中心点点击会落在系统状态栏上,需加约 95px 偏移——新脚本已做"先原点、失败再加偏移重试"的自适应。


**真机复验记录(2026-09-30 09:5x,构建 09:55:16)**
- 只读场景 **9/9 通过**(脚本 `verify-device-scenarios.sh`):任务列表「＋ 新建任务」、无底部「加载更早」、未卡同步、会话头部模型切换条、完成轮折叠摘要、过程块「查看过程」、展开后出现工具卡片、返回列表正常。
- **场景 20(clientId 回归)已验证**:`createSession` 在真机成功(草稿会话正常打开、无「新建任务失败」提示)。它与发送/审批/中断走**完全相同的命令链路**(`conversation/agentCommandClient` 的连接级 clientId + 握手 + 信封),若 clientId 未绑定,桌面会以 `fault.command.clientMismatch` 拒绝——因此该回归在协议层已确证。逐字输入消息那一步无法自动化:实测华为输入法不接受 `adb shell input text`,留给人工确认观感。
- **真机上新发现并修复的两个真缺陷**:
  1. **常驻列表仍在无障碍树里**:会话作为覆盖层打开后,被覆盖的列表控件仍可被读屏/自动化聚焦,点上去无效(设备脚本先踩到,随即暴露读屏用户同样会聚焦到不可见控件)。修法:会话打开时给列表层加 `importantForAccessibility="no-hide-descendants"` / `accessibilityElementsHidden` / `pointerEvents="none"`。
  2. **Android 硬件返回键未接管**:按返回会直接退出 App,与安卓用户预期不符。修法:`BackHandler` 逐层退出会话;**必须在事件回调里同步返回布尔**,用 ref 读栈长——在 setState 更新器里赋值再返回拿不到新值,handler 会返回 false 让应用退出(此坑已踩过一次)。
- 仍未人工确认:场景 23/24(后台取消、队列;需现场有排队或后台任务)、26(倒计时;需现场有 AskUserQuestion)、27(markdown 观感)、28/29(文件改动与工作流行)、卡片正文展开观感。

**P6 验证记录(2026-09-30,真机反馈批次二:列表交互 + 安全区/键盘 + 表格 + 订阅竞态)**
- 用例 205/205 通过(store 32 + model 45 + policy 25 + runtime 31 + turns 26 + tools 25 + markdown 21);根 typecheck 通过、lint 0 error(71 warning 为既有)、架构检查 0 违规;App tsc/oxlint 干净。
- **订阅竞态(场景 34,含"新建会话卡在正在加载"与"运行中无中断按钮"两个表象)**:根因是 transport 在 `subscribeSession` 内部就 `barrier.activate`,回放发生在 store 写入 `subscription` 之前,先于 ACK 到达的首帧快照被 `applyFrame` 的 ownership 检查丢弃;新建草稿会话服务端零延迟回 initial frame,必现。修法:activate 拆成独立方法,由 store 在 ownership 就位后调用(`adoptSubscription` 收口,含 resync 重订阅路径),与桌面 `conversationProjectionStore` 同序。回归用例:`pushBeforeAck` 模拟首帧先于 ACK,断言快照落地且不触发 resync;夹具语义与真实 barrier(begin→bind→activate 暂存回放)一致。
- **列表交互(场景 30)**:项目行点击展开/收起(折叠是纯本地 UI 状态,`ReadonlySet<workspaceKey>`,不碰订阅);「＋ 新建任务」改为项目行尾 28dp 小圆钮(带 accessibilityLabel 与 hitSlop)。
- **安全区(场景 31)**:会话覆盖层 `absolute top:0` 逸出外层 SafeAreaView 的 padding(absolute 定位以 padding box 为参照),返回/中断按钮压在状态栏下。修法:SessionScreen 用 `useSafeAreaInsets` 自管——header `paddingTop: insets.top`、composer `paddingBottom: insets.bottom`;ConfigPickerSheet 是 Modal(不吃外层 padding),同样自管。Expo 57 / RN 0.86 / targetSdk 35 下 `updateEdgeToEdgeFeatureFlag` 对所有设备 `enableEdgeToEdge()`,系统栏透明是常态,自管安全区是唯一可靠做法。
- **键盘避让(场景 32)**:edge-to-edge 后 `adjustResize` 不再收窄窗口,原 `behavior: undefined`(Android 不避让)导致输入框被键盘盖住。修法:两端统一 `behavior="padding"`——RN 0.86 的位移计算是 `frame.y+frame.height−keyboardY`,本屏铺满整屏,位移恰等于键盘高度,composer 精确抬到键盘上沿。
- **markdown 表格(场景 33)**:解析表头行+分隔行+数据行(列数不齐按段落保留,不吞内容;`\|` 转义;缺列补空/多列截断);渲染等宽列 + 表头底色 + 分隔线 + 按分隔行冒号对齐。9 条新用例覆盖。
- 未在真机验证:本批全部改动(构建时手机未连接);需 `bash packages/mobile-app/scripts/build-android-release.sh --install` 后按场景 30-34 逐条确认,顺带补 P4-2/P5 遗留的场景 23/24、26、27、28/29。

**P6 真机验证记录(2026-09-30 11:10,构建 11:10,华为 ALN-AL00)**
- 只读场景 **12/12 通过**(脚本 `verify-device-scenarios.sh`,已同步更新为新 UI):项目行尾「＋」入口、无「加载更早」、未卡同步、**场景 30 收起/展开(箭头 ▾→▸ 翻转 + 任务行移出/恢复)**、模型切换条、完成轮折叠摘要、「查看过程」入口、展开后工具卡片、**场景 34 未出现「正在加载会话…」**、返回列表正常。
- 场景 34 的竞态修复在真机确证:新建/进入会话不再停留加载态(此前必现)。
- 仍需人工确认(无法自动化):场景 31/32 的观感(状态栏遮挡是否消除、键盘唤起后输入框位置——华为输入法不吃 `adb input text`,键盘弹出无法脚本驱动)、场景 33(表格渲染观感,需现场有带表格的回复)、场景 34 的中断按钮(需现场有运行中的任务)。
- 设备脚本两处判定修正:①折叠判定改用「箭头翻转 + 首行任务移出」而非全局计数(视口滚动会让计数漂移);②辅助函数必须重新 uiautomator dump,读旧文件会把点击前状态当点击后(假失败)。

**P6-2 验证记录(2026-09-30,真机反馈批次三:计划收起 + 列表层级 + 图标)**
- 用例 205/205 通过(无新增用例:三处均为纯展示/构建资产改动,协议层无变化);App tsc/oxlint 干净。
- **计划明细默认收起(场景 12a)**:状态条只显示「计划 N/M · X 进行中」摘要行,点「展开 ▾/收起 ▴」切换明细;`useState` 必须在早退 `return null` 之前(状态条内容出现/消失不能改变 hook 数量,否则 React 崩)。
- **列表层级(场景 30a)**:项目行加 📁 图标,任务行 `paddingLeft: 48` 缩进到项目内容之下。
- **启动器图标(场景 30b)**:桌面 `build/icon.png`(1024×1024)拷贝为 `assets/icon.png`;app.json 加 `icon` 字段;`patch-android-build.mjs` 新增第 6 步——prebuild 每次重置 mipmap 回 Expo 默认,脚本用 macOS `sips` 缩放出 5 个密度(48/72/96/144/192)的 `ic_launcher(.png)` 与 `ic_launcher_round`,有 `cwebp` 时转 webp(无则保留 png,AGP 按资源名引用不看扩展名)。**不依赖网络**,与既有 NDK/ABI 补丁同一重打机制。
- 待真机确认:三处观感(计划展开收起、列表图标与缩进、新图标在桌面上的样子)。

**P6-3 验证记录(2026-09-30,截图反馈批次:列表卡片化 + 会话占位语义)**
- 用例 209/209 通过(store 32 + model 45 + policy 25 + runtime 31 + turns 30 + tools 25 + markdown 21);根 typecheck、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净。
- **背景**:用户给的两张截图本会话模型无法直接查看,用 macOS Vision 本地 OCR + 矩形/配色分析还原(`scripts/ocr-image.py`、`scripts/ocr-layout.py`,依赖仓库内 `.venv-ocr`,已入 gitignore)。图 1 是任务列表目标设计,图 2 是会话页(其占位文案「提出后续修改要求」与桌面 `chat.placeholder.followUpAsk` 一致)。
- **列表卡片化(场景 30a,按图 1)**:每个项目一张卡(边框 + card 背景 + 圆角),头部 = 文件夹图标 + 名称 + 类型徽标 / 路径 / 「更新于 X」(该项目下最近任务更新时间,无任务不显示)+「N 个任务 ▾」+「＋」;任务行在同一张卡内缩进(paddingLeft 40),标题 + 相对时间在左、**状态徽标右对齐**(按 liveStatus 上色)。折叠箭头并入「N 个任务 ▾/▸」文本。
- **会话占位语义(场景 35,按图 2)**:新增纯函数 `resolveComposerPlaceholder({hasHistory, streaming})`(conversation/draftConfig.ts),与桌面 `resolveChatPlaceholderKey` 同语义;4 条用例覆盖(含"空会话即使 streaming 也按提问")。
- 未落地(截图里属于 Web 页形态、与 App 场景不符,待确认):顶部连接说明卡与「当前设备上的工作区和任务」分区标题;列表的「按项目/按时间」「排序」「展开全部/全部收起」工具条。
- 设备脚本同步:`verify-device-scenarios.sh` 场景 30 改为读「个任务 ▾/▸」文本节点(箭头不再是独立节点)。

**P6-4 验证记录(2026-09-30,截图反馈批次二:输入区图标工具条)**
- 用例 219/219 通过(store 32 + model 55 + policy 25 + runtime 31 + turns 30 + tools 25 + markdown 21);根 typecheck、lint 0 error、架构检查 0 违规;App tsc/oxlint 干净。
- **输入区重构(场景 36)**:删除头部「模型 · X / 模式」chips,composer 改为「输入框 + 底部图标工具条」,与桌面 composer 同构:＋/🛡/◯/📦/🧠 + 右侧发送。拆分:`SessionComposer.tsx`(展示 + 回调)从 `SessionScreen.tsx` 抽出,后者回到行数上限内(425→~370)。
- **新增能力**:
  - 思考级别(🧠):`DraftConfig.reasoningLevel` + `thoughtLevelLabel`(关闭/最低/低/中/高/很高/最高;provider 未知档位原样显示);档位集合来自 `config.thoughtLevels`(会话快照的模型能力),空集合时面板给「当前模型不支持思考级别」。
  - 上下文用量(◯):`conversationView.usage` 暴露 `snapshot.usage`(state patch 的 `usage` 键整键替换,非增量);`describeContextUsage` 给已用/上限/剩余百分比/距自动压缩阈值(上限为 0 或超限都收敛,剩余不为负)。
  - 工具条的 ＋(添加上下文)在移动端没有附件/引用设施:点击给一次性提示(「请在桌面端 @ 文件或引用选区」),不静默失败也不伪装可用。
- **门禁**:10 条新用例覆盖档位标签、档位补齐 modelSelection(含无基线不下发)、基线模型解析、用量概要(含超限与无事实)。
- 设备脚本:`dump_texts` 同时收 `content-desc`(图标按钮只有 accessibilityLabel),场景 22 改为校验四个入口标签并逐个点开「思考级别/上下文用量」面板确认可开。

**P6-4 真机补验(2026-09-30 16:0x,构建 16:09,华为 ALN-AL00)**
- 只读场景 **15/15 通过**(单色图标版构建)。另做了两项**手动**端到端确认:
  - 思考级别:面板列出模型声明的档位(低/高/最高,当前会话=最高);选「高」后工具条 accessibilityLabel 变为 `思考级别:高`,再选「跟随会话默认」复位为 `思考级别:最高` ✓
  - 上下文用量:面板显示真实数据(已用 2,861 / 上限 1,000,000 / 剩余 99%),`snapshot.usage` 链路在真机确证 ✓
- 顺带修:用量面板不再显示「选择在下次发送时生效」(只读事实没有该语义)。
- 待真机确认:五个图标的观感与面板可用性(手机未连接,构建后需插上验证)。

**P6-4 真机验证记录(2026-09-30 14:59,构建 14:57,华为 ALN-AL00)**
- 只读场景 **15/15 通过**:新工具条四入口(权限模式/上下文用量/模型/思考级别)都以 accessibilityLabel 出现在无障碍树里,「思考级别」「上下文用量」面板都能点开;列表卡片折叠/展开、完成轮折叠摘要、过程块展开、「中断」按钮、返回列表全部正常。
- 场景 34 的「中断」按钮首次在真机确证(此前因订阅竞态看不到,只跑过用例)。

**P6-5 变更记录(2026-09-30,图标从彩色 emoji 换为单色线性)**
- 动因:真机观感反馈「四个图标有点儿浮夸」——彩色 emoji 在深色工具条里过亮、与主题脱节。
- 做法:引入 `@expo/vector-icons`(Expo 官方图标包,只引 `MaterialCommunityIcons` 一个字体,APK +0.8MB:37.29→38.07MB),五个入口改为单色线性图标并统一用 `theme.foregroundSubtle`:plus / shield-alert-outline(盾牌+叹号)/ chart-donut(用量环)/ cube-outline(立方体)/ brain(脑子)。
- 一致性:列表的项目图标同时从彩色 📁 换成 `folder-outline`(同色同尺寸);附件行的 📎 保留(行内文本,不构成图标排)。
- 门禁:用例 219/219、App tsc/oxlint 干净、根 typecheck、lint 0 error、架构检查 0 违规;APK 构建(15:10)并 **adb 安装成功**。
- **验证边界(如实记录)**:装机后设备 USB 反复掉线,只跑出部分场景——树上能读到图标节点、列表显示「已连接(免扫码) · 4 个工作区 · 9 个任务」,但完整 15 场景未跑满(最后一次完整通过是 emoji 版构建)。手机稳定后需重跑 `bash packages/mobile-app/scripts/verify-device-scenarios.sh`。

**P6-6 变更记录(2026-09-30,去掉启动占位图)**
- 现象:打开 App 时闪过一张白底「横竖线网格 + 圆形」的图。
- 定位:那是 prebuild 生成的 **splash 占位图**——`Theme.App.SplashScreen` 的 `windowBackground` 指向 `@drawable/splashscreen_logo`(1152² 白底位图,5 个密度),`splashscreen_background` 还是 `#FFFFFF`,与 App 的 `#161616` 背景割裂,所以启动瞬间白底图一闪。
- 修法:`app.json` 用 `expo-splash-screen` 插件声明**只要背景色**(`{ backgroundColor: "#161616" }`,不配 image);`patch-android-build.mjs` 新增第 7 步保证最终资源状态——写 `drawable/splashscreen_logo.xml`(仅含 `@color/splashscreen_background` 的 layer-list)、删掉所有密度的 `splashscreen_logo.png`、把 `colors.xml` 的 `splashscreen_background` 对齐成 `#161616`。
  - 为什么要补丁:插件 v57 在「无 image」时把纯色 layer-list 写进了 `drawable/ic_launcher_background.xml`(路径复用),而 styles 引用的 `@drawable/splashscreen_logo` 反而缺失——不补会资源解析失败。
- 产物验证(APK 资源表,非真机):`drawable/splashscreen_logo` = XML(color-only),`color/splashscreen_background` = `#ff161616`,APK 内**无任何 splash 位图**;构建成功(15:23)。真机观感(启动不再闪图)待设备恢复连接后确认。
- **真机确认(2026-09-30 用户反馈)**:重装新包后启动不再闪图 ✓。
- 顺带:启动主题改用 `Theme.SplashScreen`(Android 12+ 启动画面 API,由 expo-splash-screen 提供),不再是旧式 windowBackground 贴图。
