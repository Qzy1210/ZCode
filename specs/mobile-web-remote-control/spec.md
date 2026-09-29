# 移动端远程控制 · 局域网直连配对协议 Spec

> 状态:已实现(v1 垂直切片) · 版本:v1 · 2026-09-26
>
> 实现清单:
> - 协议:`packages/shared/src/mobilePairing.ts`(浏览器安全)+ `mobilePairingCrypto.ts`(Node,子入口 `@zcode/shared/mobilePairingCrypto`)
> - 桌面:`packages/desktop/src/main/mobilePairing{Manager,Server,Controller,WebAssets}.ts`;IPC 通道 `MobilePairingCreateQr`/`MobilePairingStop`
> - UI:`packages/ui/src/WebRemoteControlDialog.tsx` 二维码区块
> - 手机:`packages/web/src/remote/`(transport + 页面);`main.tsx` `/remote` 路由
> - 验证:`pnpm typecheck` ✓ · `pnpm lint` 0 error ✓ · `pnpm architecture:check --changed` 0 违规 ✓ · `pnpm --filter @zcode/web build` ✓(运行时 bundle 无 node:crypto)

## 1. 目标与边界

本地编译的桌面客户端(官方 relay 代码未开源)恢复"扫码打开手机 Web,同步任务并继续工作"的能力。

**方案**:局域网直连(同网段,零外部服务)。

- 桌面 main 进程起一个绑 LAN IP 的 HTTP+WS 服务,二维码编码 `http://<lan-ip>:<port>/remote?sid=...&hash=...&t=...&mid=...&name=...&app_version=...`。
- 手机扫码打开 Web 页,从 URL 取配对材料,经挑战-响应 HMAC 认证后建立 WS。
- Main 把手机 WS 桥接到目标 workspace 的窗口 Host(`attach-service-port`,scope `local`,clientMode `web-remote-replayable`),复用既有 RPC 与 replayable 语义。

**非目标**:跨广域网(需自建 relay,后续扩展)、Bot Channel(已存在)、多桌面并发配对。

## 2. 角色与单一所有者

| 状态 | 所有者 | 说明 |
|---|---|---|
| 配对会话(sid/secret/过期/状态) | `mobilePairingManager`(main 进程,单例) | 生成、校验、状态机、注销 |
| 本地 HTTP/WS 端口与连接 | `mobilePairingServer`(main 进程,单例) | 监听、路由、桥接、限连 |
| 工作区 Host attachment | 既有 `windowHostAttachmentRegistry`(host 进程) | **不新增所有者** |
| 桥接路由(手机连接 → Host port) | `desktopRemoteSessions` 既有 API | **不新增所有者** |
| 手机端 UI 状态 | `packages/web` 新 `/remote` 路由 | 只读呈现,不写桌面状态 |

## 3. 协议

### 3.1 二维码 URL(桌面 → 手机,单向)

```
http://<lan-ip>:<port>/remote
  ?sid=<d_+22字符nanoid>          # 配对会话 ID(device_sid)
  &hash=<base64url(secret,32B)>   # HMAC 密钥材料
  &t=<ms>                         # 签发时间,有效期 10 分钟
  &mid=<deviceMid UUID>           # 桌面设备 ID
  &name=<hostname>                # 展示用
  &app_version=<version>
```

`hash` 是 32 字节随机 secret 的 base64url(URL-safe,与官方一致)。secret 只存在于桌面内存与二维码中;手机仅在认证握手中用它计算 proof,**不再回传明文**。

### 3.2 认证握手(手机 WS → 桌面 server)

沿用官方挑战-响应结构(role 用 `terminal`):

```
手机 → 桌面:  auth_init    {role:"terminal", device_sid:sid, meta:{platform:"web", name:"mobile-browser"}}   (JSON 文本帧)
桌面 → 手机:  auth_challenge {nonce}                      # 32B random,一次性,90s 过期
手机 → 桌面:  auth_response {device_sid, proof, client_ts}
              proof = base64url( HMAC-SHA256(K, `${nonce}|terminal|${device_sid}`) )
              K = hash 字符串(base64url)的 UTF-8 字节   # 与官方 bundle H2t 逐字一致
桌面 → 手机:  auth_ack {pair_status:"paired"}             # 校验通过
   (失败)     error {code:"auth_failed"|"auth_expired"|"pair_expired"}
之后:         控制面继续走 JSON 文本帧(bridge_request/bridge_ready);
              数据面走 WS 二进制帧,内容为 SocketProtocol 帧头(13B)+ RPC body,
              与 packages/client websocket.ts 的线格式一致。
```

- proof 公式与官方 bundle 完全一致(逆向自 `zcode.z.ai/remote/v4` 主包 `H2t`)。
- 防重放:nonce 一次性消费;`client_ts` 与桌面时钟偏差 ≤ 5 分钟;同一 sid 认证失败 3 次即注销会话。

### 3.3 手机 RPC 通道(桥接)

认证通过后:

1. 手机发 `bridge_request {workspaceKey}`(或首连时 server 直接用默认工作区)。
2. Main 调 `desktopRemoteSessions` 既有桥接 API 取 window Host 的 `MessagePortMain`(scope local / clientMode `web-remote-replayable`),复用"刷新/手机 attachment 复用同一 Host"路径。
3. 之后手机 WS 帧 ↔ MessagePort 双向泵,RPC 帧透传(既有 `SocketProtocol` 语义),server 不解析业务帧。

### 3.4 生命周期与失败语义

| 事件 | 行为 |
|---|---|
| 二维码生成 | 新 sid+secret,T+10min 过期;已配对会话重新生成则旧会话注销 |
| 重开桌面弹窗 | 复用未过期二维码(控制器缓存 URL+签发时间);不顶掉已连接手机 |
| 关闭桌面弹窗 | **不停服务**:手机连接保持(桌面应用退出或显式"停止远控"才断开) |
| 重新生成二维码 | 签发新 sid:旧码作废,已连接手机需重新扫码(与官方 refreshQr 语义一致) |
| 显式"停止远控" | 停止 LAN server / relay 注册并注销全部配对会话;UI 进入停止态 |
| 认证失败 | 回 `error` 帧并关闭 WS;累计 3 次注销 sid |
| WS 断开 | 注销手机连接,`detach-service-port` 精确清理 attachment;配对会话保留(可重连,直至过期) |
| 桌面休眠/退出 | server 关闭,手机端提示 `desktop-disconnected` |
| 端口被占 | 服务启动失败,UI 明确报错,不静默禁用 |
| 桥接目标工作区已关 | 回 `error {code:"workspace_unavailable"}` |

### 3.5 事件顺序(desktop vs mobile 交付语义)

```
desktop: desktop-continuous ── 窗口 Host 直连 live stream ──┐
                                                            ├─ 同一 Host owner + attachment
mobile:  web-remote-replayable ── 桥接 port + snapshot/gap repair ┘
```

- 手机 attachment 必须显式 `web-remote-replayable`(Host 侧 `pendingStartupAttachments` 等待数据库 ready,与桌面刷新同语义)。
- 手机端发送的命令经同一 admission(CommandInbox 串行),不另建队列。
- 幂等:attachmentId 使用 `mob_<uuid>` 前缀唯一生成;重连时新 attachmentId,旧 port 先 detach。

## 4. 安全边界

- 服务只绑 LAN 网卡(非 0.0.0.0),启动日志打印实际 IP:port。
- 认证前不暴露任何业务路由;`/remote` 静态页之外全部 404。
- secret 不落盘、不进日志(日志只记 sid 前 6 位)。
- WS 连接上限 2(同一手机断线重连期间短暂并存),超限拒绝。
- Host attachment 鉴权沿用 Host 内既有 `clientMode` 门禁,Main 不放宽。

## 6. Relay 模式(v1.1,公网中继)

LAN 模式要求同网段;relay 模式把传输层换成自托管公网中继,认证与桥接状态机不变。

**组件**:
- `packages/relay/src/main.ts`:独立部署的哑管道 relay(静态页 + 双端 WS + sid 路由 + 心跳)。部署见 `packages/relay/README.md`。
- `packages/desktop/src/main/mobilePairingRelayClient.ts`:桌面出站客户端(注册 sid、指数退避重连 1s→30s、`phone_open`/`phone_closed` 驱动 session 生命周期)。
- `mobilePairingController.ts`:双模式选择——`ZCODE_MOBILE_RELAY_URL`+`ZCODE_MOBILE_RELAY_TOKEN` env 或 `~/.zcode/mobile-relay.json` 配置任一存在即 relay 模式,否则 LAN。

**信任边界**:
- 认证校验始终在桌面 `pairingManager` 完成,relay 不持有 secret;
- relay 可见 RPC 帧明文(与官方 zcode.z.ai 行为一致),生产部署必须 TLS(README 提供 Let's Encrypt 步骤);
- 同 sid 新手机连接自动顶替旧连接(断线重连);桌面重连时 relay 侧同 sid 顶替旧 host 连接。

**帧协议(relay ↔ 桌面,文本控制帧)**:
`host_register{token,sid}` → `host_registered` / `host_error`;
`phone_open` / `phone_closed`(手机 WS 生命周期);`phone_close`(桌面请求关闭当前手机)。
其余文本/二进制帧按 sid 原样转发。

## 7. 迁移与兼容

- 纯新增模块,不改既有消息类型;`attach-service-port` 的 local scope + replayable 组合已存在(桌面刷新路径),无协议版本 bump。
- 官方 `remoteControlToken` 恢复路径暂不实现;后续自建 relay 时再扩展。
