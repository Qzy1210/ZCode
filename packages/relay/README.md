# ZCode 移动端远控 Relay(自托管公网中继)

让手机在**任意网络**(蜂窝/公司 WiFi/外地)远控桌面 ZCode,不要求同一局域网。桌面与手机都出站连接本服务;认证校验始终在桌面端完成,relay 只按 `sid` 转发帧,不持有配对密钥。

## 架构

```
桌面(NAT 后,无需公网)              本服务(CentOS 服务器)              手机(任意网络)
  │ ── host_register(sid) ──────→ │                                   │
  │                               │ ←── auth_init(sid) ────────────── │ (扫码打开 /remote)
  │ ←── 帧转发(挑战/响应/桥接) ─── │ ─── 帧转发 ─────────────────────→ │
  │ ←══ RPC 二进制帧双向管道 ═════→ │ ═══════════════════════════════→ │
```

- 手机端页面与协议**与局域网模式完全一致**(二维码 origin 指向 relay 即可),`packages/web` 无需任何改动
- 同一 `sid` 同时只允许一个手机连接;新连接到达自动顶替旧连接(断线重连)
- 心跳 30s,僵尸连接自动清理

## 部署(CentOS)

### 1. 安装 Node.js 20+

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
node -v   # 应 >= 20
```

### 2. 在开发机构建

```bash
# 仓库根目录
pnpm install
pnpm --filter @zcode/relay build          # 产出 packages/relay/dist/relay.cjs(单文件)
pnpm --filter @zcode/web build            # 产出 packages/web/dist(手机页面)
```

### 3. 上传到服务器

```bash
SERVER=user@your-server-ip
ssh $SERVER "mkdir -p ~/zcode-relay/web-dist"
scp packages/relay/dist/relay.cjs $SERVER:~/zcode-relay/
scp -r packages/web/dist/* $SERVER:~/zcode-relay/web-dist/
```

### 4. 生成令牌并启动

```bash
TOKEN=$(openssl rand -hex 24)   # 记下来,桌面端要用同一个
cd ~/zcode-relay
RELAY_HOST_TOKEN=$token RELAY_PORT=8787 node relay.cjs
# 验证: curl http://your-server-ip:8787/mobile-pairing/health
```

### 5. systemd 常驻

```bash
sudo tee /etc/systemd/system/zcode-relay.service > /dev/null <<EOF
[Unit]
Description=ZCode Mobile Relay
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/zcode-relay
Environment=RELAY_HOST_TOKEN=把令牌粘这里
Environment=RELAY_PORT=8787
ExecStart=/usr/bin/node relay.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now zcode-relay
```

### 6. 防火墙放行

```bash
sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload
```

## 桌面端启用 relay 模式

在**运行桌面端的电脑**上创建 `~/.zcode/mobile-relay.json`:

```json
{
  "relayUrl": "http://your-server-ip:8787",
  "hostToken": "第 4 步生成的令牌"
}
```

重启桌面端,打开"移动端远程控制"弹窗——二维码将指向 relay,提示文案变为"经自托管中继连接,任意网络可用"。

也可用环境变量替代配置文件:`ZCODE_MOBILE_RELAY_URL` + `ZCODE_MOBILE_RELAY_TOKEN`(优先级更高)。

## TLS(强烈建议)

裸 HTTP 模式下 RPC 流量(含你的代码内容)**明文过公网**。有域名时建议加证书:

```bash
# Let's Encrypt(需域名 A 记录指向服务器)
sudo yum install -y certbot
sudo certbot certonly --standalone -d relay.example.com
# systemd Environment 追加:
#   RELAY_TLS_CERT=/etc/letsencrypt/live/relay.example.com/fullchain.pem
#   RELAY_TLS_KEY=/etc/letsencrypt/live/relay.example.com/privkey.pem
```

之后 `relayUrl` 改为 `https://relay.example.com:8787`。仅有 IP 无域名时,可先跑 HTTP,尽快补域名;或用自签证书(手机浏览器需手动信任,体验差,不推荐)。

## 环境变量一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_HOST_TOKEN` | (必填) | 桌面注册令牌 |
| `RELAY_PORT` | 8787 | 监听端口 |
| `RELAY_HOST` | 0.0.0.0 | 监听地址 |
| `RELAY_WEB_DIST` | ./web-dist | 手机页面目录 |
| `RELAY_TLS_CERT` / `RELAY_TLS_KEY` | (无) | 提供时启用 HTTPS/WSS |
