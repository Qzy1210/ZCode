# ZCode 原生手机 App(Expo/RN) · Spec

> 状态:P0/P1 已实现并真机验证 · P2 已实现(待真机验收) · 2026-09-29
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
| P2 | 会话视图:历史消息 + 实时流式 + 发送输入 | 已实现(已提交) |
| P3 | 会话内推进:审批/问答/计划批准 + 中断 + 子代理下钻 | 本次 |
| P4 | 队列编辑、文件回滚、富文本与更完整的工具卡片 | 未开始 |

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
                     └─ barrier.bind → activate → 回放暂存帧         │
                                     │                             │
notification: frame(snapshot) ──────┴─→ store.replaceRows(rows.window, seq)
notification: frame(deltas)  ─────────→ store.applyDeltas → 推进 seq
                                          │
                              fromSeq !== seq ─→ resync(base) ─→ 失败则重订阅
```

- **屏障不可省**:notification 与 RPC response 无先后保证,缺屏障会静默丢掉首帧快照(表现为"进去永远空白")。
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
13. 杀掉桌面端:手机在 1s 内出现横条(显示"桌面端已离线"+ 下次重试倒计时),画面保留;重开桌面后自动连上、内容跟上,无需任何手动操作。
14. 手机开飞行模式:30s+15s 内探针超时发现断线并出横条(原因"网络无响应");关掉飞行模式后自动恢复。
15. relay 重启后手机自动恢复;恢复耗时含**桌面端重新注册**的时间(实测可达数十秒),横条上能看到原因与倒计时,不会误判为卡死。
16. 凭证/身份真的失效(例如桌面端登记表被重建):横条可"重新扫码",不用干等退避。
16. 断线期间发送/审批/中断均不可用(按钮禁用),界面不卡死;`superseded` 时提示已由另一台手机接管且不再重连。

## 8. 构建与验证
- 类型与静态检查:`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`;App 侧另有 `npx tsc -p packages/mobile-app/tsconfig.json --noEmit` 与 `npx oxlint App.tsx index.ts src`。
- 会话聚合、交互语义与连接生命周期:`pnpm --filter @zcode/mobile-app verify:conversation`(= `node scripts/verify.mjs all`),共四组:
  - `verify-store.ts`(22 项):快照/重复帧/delta/gap/分页前插/发送 ACK/交互应答下发/中断命令/dispose;
  - `verify-model.ts`(16 项):交互卡片识别与答案形状(审批、计划哨兵值、问答 ", " 连接、hook review 跳过、计划进度);
  - `verify-connection-policy.ts`(25 项):断线分类表、退避封顶与按原因分档(10s/30s)、探活阈值/前台抑制、显式超时;
  - `verify-runtime.ts`(31 项):注入假 transport 与假时钟,覆盖断线保留画面+横条、退避重连、代际自增、`superseded` 终止不再重连、凭证失效清库、停止重连、重复断线不叠加、**一次断线只允许一条重试链**、**迟到定时器不得拆掉已恢复的连接**、`pair_unknown` 反复失败后仍能收敛。
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

**P2 验证记录(2026-09-29)**:
- 会话聚合脚本 15/15 通过;首轮执行时抓到两个真缺陷并修复:
  1) 水位未随帧推进——`applyConversationDeltas` 只改窗口内容,不回写 `seq`,漏写会让下一帧的 `fromSeq` 永远对不上而误判断档;
  2) 合并通知的 `pendingNotify` 未置真,导致流式行更新永远不触发重渲染(界面停在首快照)。
- 静态检查:根 `typecheck` 通过、`lint` 0 error(72 warning 为既有)、架构检查 0 违规;App `tsc`/`oxlint` 干净。
- 产物:APK 已构建(`android/app/build/outputs/apk/release/app-release.apk`,37MB),bundle 内含 `conversation/`、`sendText`、`mobileApp` clientKind 与共享屏障标记,旧占位提示已消失。
