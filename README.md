# KUI x Server Monitor Pro

> 本项目 Fork 自 [a6216abcd/K-UI-workers](https://github.com/a6216abcd/K-UI-workers)，并在此基础上持续维护。

KUI 是代理节点管理与服务器探针面板，支持 **Cloudflare Worker 单体部署** 与 **Docker Compose + Nginx 自托管部署** 两种运行方式，共用同一套 API、实时通道与前端代码。

## 快速部署

### 方式一：连接当前 GitHub 仓库自动部署（维护仓库推荐）

直接绑定当前仓库的 `main` 分支，后续推送自动构建上线，不会创建副本仓库。

1. 在 **Cloudflare Dashboard → Workers & Pages → 创建应用 → 导入存储库** 选择本仓库与 `main` 分支，Worker 名称保持与 `wrangler.jsonc` 中的 `name` 一致（默认 `kui-worker`）。
2. 填写构建配置：`Build command` 填 `npm run build`，`Deploy command` 填 `npx wrangler deploy`（Node.js 版本选 `22`），保存并触发首次部署。
3. 进入 **Settings → Bindings**，确认 `DB`、`VPS_PRESENCE`、`DASHBOARD_HUB` 已绑定。若首次部署未自动创建 D1，先在 **Storage & Databases → D1** 建库后绑定为 `DB` 并重新部署。
4. 进入 **Settings → Variables and Secrets**，添加 `ADMIN_PASSWORD`（类型选 **Secret**）；使用住宅代理时再同时添加 `PROXY_USER`、`PROXY_PASS`（类型均选 **Secret**）。
5. 进入 **Settings → Domains & Routes → Add → Custom Domain** 绑定 Cloudflare 托管的自定义域名（默认关闭 `workers.dev`）。访问 `https://你的域名/health` 确认返回 `{"ok":true,"service":"kui-realtime","version":1}` 后，打开首页以 `admin` 登录。

### 方式二：Cloudflare 一键部署（独立新建副本）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yuanlam/kui-workers-pro)

1. 点击上方 **Deploy to Cloudflare Workers**。
2. 登录 Cloudflare，选择账户并确认部署。
3. 在 **Settings → Domains & Routes → Add → Custom Domain** 绑定自定义域名。
4. 在 **Settings → Variables and Secrets** 添加 `ADMIN_PASSWORD`（Secret）；需住宅代理时再添加 `PROXY_USER` 和 `PROXY_PASS`（Secret）。
5. 访问自定义域名，使用用户名 `admin` 登录。

> 一键部署会在你的 GitHub 账号下创建仓库副本。需要手动 CLI 部署或详细排障，见 [部署与故障排查](docs/deployment.md)。

### 方式三：Docker Compose + Nginx 自托管部署

适合在自有 VPS 上独立运行（基于 Node.js 24 内置 SQLite 与 WebSocket 适配层，默认仅监听 `127.0.0.1:8787`，与 Cloudflare Workers 部署互不影响）。

```bash
git clone https://github.com/yuanlam/kui-workers-pro.git
cd kui-workers-pro
cp .env.example .env
# 编辑 .env，至少填写 PUBLIC_ORIGIN 和 ADMIN_PASSWORD
docker compose up -d --build
```

1. 参考 [`deploy/nginx-kui.conf.example`](deploy/nginx-kui.conf.example) 为域名配置 HTTPS 反向代理到 `http://127.0.0.1:8787`（需启用 WebSocket 升级头并关闭 `proxy_buffering`）。
2. 执行 `curl -fsS https://你的域名/health` 确认返回 `{"ok":true,"service":"kui-realtime","version":1}`。
3. 打开 `https://你的域名`，使用 `ADMIN_USERNAME`（默认 `admin`）与 `ADMIN_PASSWORD` 登录。

日常更新、数据备份与排障见 [部署与故障排查](docs/deployment.md)。

### 删除旧 Worker 重建

1. 先解绑旧 Worker 的自定义域名，再删除旧 Worker，并确认 DNS 中无残留冲突记录。
2. 按上方**方式一**新建 Worker 并完成部署。
3. 选择数据策略：
   - **保留原数据**：删除 Worker 不会删除 D1，在 **Settings → Bindings** 将 `DB` 重新绑定到原 D1 数据库并重新部署，已有 VPS 和订阅会自动恢复。
   - **全新部署（新 D1）**：按下方「旧 VPS 重新接入」步骤覆盖重装 VPS Agent 并重新创建节点。

## 核心能力

- VPS、代理节点、多用户、订阅令牌、流量配额和到期管理。
- CPU、内存、磁盘、网络、连接数和线路延迟实时探针。
- XTLS-Reality、Hysteria2、TUIC、Shadowsocks 2022、Trojan、AnyTLS、MTProxy 等协议。
- 普通链接、Mihomo/Clash 和 Surge 配置导出。
- 原生、WARP、住宅代理和手动 SOCKS5 出口。
- 实时状态同步、公开探针、Telegram 告警和定时离线检查。

## 配置说明

### 首次部署需要设置

敏感信息只在 Cloudflare Dashboard 中设置，不要写入代码或提交到仓库；项目不内置默认密码。

| 配置 | 类型 | 何时需要 | 用途 |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | 必需 | 管理员登录密码，请使用独立强密码 |
| `PROXY_USER` / `PROXY_PASS` | Secret | 使用住宅代理时 | SOCKS5 认证凭据，两项必须同时设置 |

### 用户可调变量

以下普通变量由 `wrangler.jsonc` 提供默认值，通常无需修改；`keep_vars: true` 会保留你在 Dashboard 中设置的变量与 Secrets。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | 管理员登录用户名 |
| `PROXY_PUBLIC_LISTENER` | `false` | 新接入 VPS 的住宅代理公网监听默认值（建议保持 `false`，在面板按单机开启） |

### 系统内置资源（无需填写）

以下配置由 `wrangler.jsonc` 管理，一键部署时自动创建或绑定。它们不是用户变量，请勿修改 binding 名称。

| 内置配置 | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 Binding | 业务数据库 |
| `ASSETS` | Worker Assets Binding | 前端和 VPS 安装文件 |
| `VPS_PRESENCE` | Durable Object Binding | VPS 实时状态 |
| `DASHBOARD_HUB` | Durable Object Binding | 面板实时推送 |
| `*/5 * * * *` | Cron Trigger | 每 5 分钟执行离线检查 |

### 高级兼容配置

- 集成部署已内置实时服务和住宅代理控制器，**不要**设置 `REALTIME_URL`、`PROXY_CTRL_URL`、`PROXY_CTRL_USER`、`PROXY_CTRL_PASS` 或 `PROXY_CTRL_TOKEN`。
- 仅旧版分离 Realtime 部署需要在两端配置相同的 `REALTIME_AUTH_SECRET`（至少 32 个随机字符，不得复用管理员密码）。
- Telegram 通知直接在面板内设置即可；`TG_BOT_TOKEN`、`TG_CHAT_ID`、`TG_WEBHOOK_SECRET` 和 `CRON_SECRET` 仅用于环境变量回退或外部调用 `/api/cron_check`。

## VPS 接入

### 新接入 VPS

1. 登录 KUI，进入 **服务器与节点**。
2. 添加 VPS 名称和公网 IP。
3. 复制页面生成的 Full Deploy Command，以 `root` 在目标 VPS 执行。
4. 等待 Agent 回连后创建节点或执行批量部署。

### 全新部署后，旧 VPS 重新接入

- **直接覆盖重装（推荐）**：在新面板添加该 VPS 并直接以 `root` 执行新的 Full Deploy Command。脚本会自动停止旧服务、替换新面板 Token、拉取最新版 Agent 与代理组件、复用已安装的 `sing-box`，并保留本机 WARP 状态文件；上线后重新创建节点并更新客户端订阅即可。
- **彻底清零重装**：若不保留旧 WARP/流量/住宅配置，先在 VPS 上停用并删除 `kui-agent`、`sing-box`、`proxy-lite`、`kui-mtproxy-*` 服务及 `/opt/kui`、`/etc/sing-box`、`/opt/proxy_lite`、`/etc/proxy-lite` 目录，再执行新的 Full Deploy Command。

国内 VPS 无法从 GitHub 下载 sing-box 时，可使用自有 HTTPS 对象存储或自建 GitHub 代理。镜像配置、卸载、备份和完整清理行为见 [VPS Agent 管理](docs/vps-agent.md)。

## 常见问题

- 页面空白、显示 `Hello World` 或出现 1101：检查 Worker Assets、`DB` 和 Durable Objects bindings。
- 点击登录后无响应：确认已部署最新 `main`，检查 `ADMIN_PASSWORD` 和 `DB`，重新部署后强制刷新浏览器。
- 住宅代理不可用：确认已配置代理凭据，并检查 VPS 上 `proxy-lite` 的状态与实时日志。

完整排查步骤见 [部署与故障排查](docs/deployment.md)。

## 文档

- [部署与故障排查](docs/deployment.md)
- [住宅代理与 Docker 接入](docs/residential-proxy.md)
- [VPS Agent 管理](docs/vps-agent.md)
- [安全配置](docs/security.md)
- [开发与验证](docs/development.md)

## 架构

```text
浏览器 / VPS Agent
        |
Cloudflare Worker  或  Nginx -> Docker (server/index.js)
  |- Worker Assets: 前端与安装文件
  |- /api/*: KUI 后端接口
  |- WebSocket: 实时状态与面板推送
  |- Cron: 离线检查
  |- D1 (DB) / SQLite (/data/kui.db): 配置、用户、节点、流量和探针数据
  `- Durable Objects / Local DO (/data/do-state.db): VPS Presence 与 Dashboard Hub
```

## 开发验证

```bash
npm ci
npm run check
```

前端采用 Vue 3 SFC + Vite，构建产出带内容哈希的 `/ui-assets/` 静态资源（由 Worker 下发 `immutable` 缓存头，HTML 使用 `no-cache`）。`npm run check` 会自动构建并运行全部测试与语法检查，更多说明见 [开发与验证](docs/development.md)。

## License

MIT
