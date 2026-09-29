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
| P2 | 会话视图:历史消息 + 实时流式 + 发送输入 | 已实现(待真机验收) |
| P3 | 会话内高级操作(审批/计划/文件改动/子代理下钻) | 未开始 |

## 2. 角色与单一所有者

| 状态 | 所有者 | 说明 |
|---|---|---|
| 连接(WS/认证/桥接) | `pairingTransport`(App 单例) | 认证帧 → 二进制数据面;连接代际 `generation` 自增作废在途回调 |
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
| 连接断开(WS 关闭) | 回到 App 级 connecting 状态,由 `pairingTransport` 重建连接;会话屏订阅随连接代际重建 |
| 桌面侧会话被删 | 订阅收到错误 → 显示"会话不可用"并提供返回 |
| 发送失败 | ACK `status !== "accepted"` 时展示 `reasonCode/message`,输入内容保留在输入框 |
| 历史不足 | 列表顶部"加载更早";`hasMore=false` 时隐藏 |

## 6. 安全边界

- 设备凭证只存 Android Keystore(SecureStore);不落日志。
- App 不持有 workspace 文件系统路径之外的能力:全部 RPC 走既有 attachment 门禁(replayable profile、clientId 绑定、订阅 ownership)。
- 发送命令的 `envelope.clientId` 必须等于握手绑定的 clientId,否则桌面回 `fault.command.clientMismatch`。
- 不在 App 内实现"绕过审批/自动确认"路径;审批继续由桌面承担。

## 7. 验收场景

1. 免扫码连接后点任务 → 会话屏出现历史消息(用户气泡 + 助手文本 + 工具卡片)。
2. 桌面端正在跑的任务:App 上文本逐字增长,工具状态从 running → success。
3. 上滑加载更早:行前插且不重复、不跳位。
4. 断网重连(切飞行模式再恢复):会话屏自动恢复并补齐缺失行,不出现重复行。
5. 发送一条消息:输入框清空、出现乐观用户行;桌面端会话同步出现同一行;ACK 失败时给出原因且文本不丢。
6. 任务空闲时发送 → 触发新 turn;任务运行中发送 → 服务端 admission 决定排队或立即,App 如实反映 ACK。

## 8. 构建与验证

- 类型与静态检查:`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`;App 侧另有 `npx tsc -p packages/mobile-app/tsconfig.json --noEmit` 与 `npx oxlint App.tsx index.ts src`。
- 会话聚合逻辑:`pnpm --filter @zcode/mobile-app verify:conversation`(esbuild 打单文件后 node 执行,覆盖快照/重复帧/delta/gap/分页前插/发送 ACK/dispose)。
- 真机:`bash packages/mobile-app/scripts/build-android-release.sh --install`(prebuild → 重打补丁 → gradle → adb install);桌面端需为已含 P1 host 的构建。

**P2 验证记录(2026-09-29)**:
- 会话聚合脚本 15/15 通过;首轮执行时抓到两个真缺陷并修复:
  1) 水位未随帧推进——`applyConversationDeltas` 只改窗口内容,不回写 `seq`,漏写会让下一帧的 `fromSeq` 永远对不上而误判断档;
  2) 合并通知的 `pendingNotify` 未置真,导致流式行更新永远不触发重渲染(界面停在首快照)。
- 静态检查:根 `typecheck` 通过、`lint` 0 error(72 warning 为既有)、架构检查 0 违规;App `tsc`/`oxlint` 干净。
- 产物:APK 已构建(`android/app/build/outputs/apk/release/app-release.apk`,37MB),bundle 内含 `conversation/`、`sendText`、`mobileApp` clientKind 与共享屏障标记,旧占位提示已消失。
