# 部署与故障排查

## 推荐：Cloudflare 一键部署

新用户应优先使用一键部署，无需克隆仓库、安装 Wrangler 或手动创建 Cloudflare 资源。

1. 在 [README](../README.md) 中点击 **Deploy to Cloudflare Workers**。
2. 登录 Cloudflare，选择账户并确认部署。
3. 在 Worker 的 **Settings → Domains & Routes → Add → Custom Domain** 中绑定 Cloudflare 托管的自定义域名。项目默认关闭 `workers.dev`，未绑定域名时不会提供公共入口。
4. 在 **Settings → Variables and Secrets** 中添加 `ADMIN_PASSWORD`，类型选择 **Secret**。
5. 打开已绑定的 HTTPS 自定义域名，使用用户名 `admin` 和刚设置的密码登录。

如需住宅代理，再添加 `PROXY_USER` 和 `PROXY_PASS` 两个 Secret。管理员和代理凭据应使用不同的独立强密码。

一键部署适合快速创建独立实例，但 Cloudflare 会在登录用户的 GitHub 账号中创建项目副本。如果希望修改当前仓库后自动更新同一个 Cloudflare Worker，请使用下一节的手动连接方式。

## 连接现有 GitHub 仓库并自动部署

该方式不会复制或新建 GitHub 仓库。Cloudflare 会监听所选仓库的 `main` 分支，每次推送后自动构建并部署。

### 1. 准备 GitHub 仓库

1. 确认要持续维护的代码已经保存在自己的 GitHub 仓库中。
2. 确认生产代码位于 `main` 分支，并且该分支包含 `package.json`、`wrangler.jsonc`、`src/` 和 `frontend/`。
3. 不要把 `ADMIN_PASSWORD`、代理凭据、Telegram Token 或其他 Secret 写入仓库。

本项目自带的 GitHub Actions 只负责检查代码，不会部署 Cloudflare；自动部署必须在 Cloudflare Dashboard 中连接仓库。

### 2. 确认 Worker 名称

仓库中的 `wrangler.jsonc` 默认包含：

```json
{
  "name": "kui-worker"
}
```

该名称就是 `wrangler deploy` 的目标 Worker。创建新 Worker 时建议直接使用 `kui-worker`；如果要使用其他名称，先在自己的仓库中修改此处并提交。

如果要连接已经运行的 Worker，必须把 `name` 改为该 Worker 的准确名称。名称不一致可能导致构建成功却额外创建第二个 Worker，原来的 D1 数据、自定义域名和 Secrets 也不会自动迁移过去。

### 3. 在 Cloudflare 创建并连接 Worker

全新部署：

1. 登录 **Cloudflare Dashboard → Workers & Pages**。
2. 选择 **Create application / 创建应用 → Import a repository / 导入存储库**。如果界面先要求创建 Worker，可先创建名称与 `wrangler.jsonc` 一致的 Worker，再进入 **Settings → Builds** 连接 Git 仓库。
3. 授权 Cloudflare GitHub App 读取目标仓库；私有仓库需要在 GitHub App 权限中显式勾选。
4. 选择需要维护的现有仓库，生产分支选择 `main`。

复用已部署实例：

1. 打开现有 Worker，不要再创建应用。
2. 进入 **Settings → Builds**，选择 **Connect repository / 连接存储库**。
3. 选择现有 GitHub 仓库和 `main` 分支。
4. 再次确认 Worker 名称与 `wrangler.jsonc` 的 `name` 完全一致。

Cloudflare 不同版本的控制台文案可能略有差异；核心是让目标 Worker 的 **Builds** 页面显示正确的仓库和生产分支。

### 4. 配置构建

使用以下配置：

| 项目 | 配置值 |
| --- | --- |
| Production branch | `main` |
| Root directory | `/` 或留空 |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Node.js version | `22`（如控制台提供该选项） |

保存并触发首次部署。此后向 `main` 推送提交，就会自动执行相同的构建和部署流程。

### 5. 检查自动创建的资源

首次成功部署时，Wrangler 会根据 `wrangler.jsonc` 上传或配置以下内容：

| 资源 | 预期结果 |
| --- | --- |
| Worker Assets | 自动上传 `static/` 中的前端和 VPS 安装文件 |
| D1 | 自动配置 `DB` binding；首次部署后必须确认数据库已经创建并绑定 |
| Durable Objects | 自动创建并绑定 `VPS_PRESENCE`、`DASHBOARD_HUB` |
| Cron Trigger | 自动添加 `*/5 * * * *` |

正常情况下无需提前手动创建这些资源。如果首次部署提示 D1 无法自动预配，可在 **Storage & Databases → D1** 创建数据库，然后回到 Worker 的 **Settings → Bindings**，使用固定名称 `DB` 绑定该数据库后重新部署。

### 6. 设置 Secrets

首次部署完成后，在目标 Worker 的 **Settings → Variables and Secrets** 中添加：

- `ADMIN_PASSWORD`：必需，类型选择 **Secret**。
- `PROXY_USER`、`PROXY_PASS`：仅使用住宅代理时添加，均选择 **Secret**。

普通变量 `ADMIN_USERNAME` 和 `PROXY_PUBLIC_LISTENER` 已在仓库配置中提供默认值。`keep_vars: true` 会在后续部署中保留 Dashboard 中未写入仓库的变量和 Secrets。

### 7. 验证自动更新

1. 在仓库 `main` 分支提交一个可识别的小改动并推送。
2. 打开 Worker 的 **Builds / Deployments**，确认新构建由该提交触发并成功完成。
3. 检查 Worker 地址和 `/health`：

```bash
curl -fsS https://你的-worker-域名/health
```

4. 确认原有 D1 数据、Secrets、自定义域名和 `DB`、`VPS_PRESENCE`、`DASHBOARD_HUB` bindings 仍然存在。

不要在验证过程中修改 Worker 名称或 binding 名称。自动部署只更新代码和配置，不会把另一个 Worker 的数据自动搬到新实例。

## 变量与内置配置

### 用户需要设置的 Secrets

| 配置 | 何时需要 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 必需 | 管理员登录密码，无默认值 |
| `PROXY_USER` | 使用住宅代理时 | SOCKS5 用户名，需与 `PROXY_PASS` 同时设置 |
| `PROXY_PASS` | 使用住宅代理时 | SOCKS5 密码，需与 `PROXY_USER` 同时设置 |

### 用户可调变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `PROXY_PUBLIC_LISTENER` | `false` | 新 VPS 的公网监听默认值，面板中的单 VPS 设置优先 |

这些变量已有安全默认值，一键部署后通常无需修改。`PROXY_PUBLIC_LISTENER` 建议保持 `false`。

### 高级兼容变量

| 变量 | 使用场景 |
| --- | --- |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | Telegram 通知的环境变量回退配置，通常直接在面板设置 |
| `TG_WEBHOOK_SECRET` | 校验 Telegram Webhook 请求 |
| `CRON_SECRET` | 保护外部调用的 `/api/cron_check`；内置 Cron 不需要 |
| `REALTIME_URL` | 对接旧版分离实时服务；集成部署不需要 |
| `REALTIME_AUTH_SECRET` | 旧版分离实时服务的专用认证 Secret，Worker 与 Realtime 两端保持一致且至少 32 字符 |
| `PROXY_CTRL_URL` / `PROXY_CTRL_USER` / `PROXY_CTRL_PASS` / `PROXY_CTRL_TOKEN` | 对接外部住宅代理控制器；内置控制器不需要 |

### 系统内置资源

以下内容由 `wrangler.jsonc` 定义，一键部署时自动处理，不是在 **Variables and Secrets** 中填写的环境变量。

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 Binding | 业务数据库 |
| `ASSETS` | Worker Assets Binding | 静态前端和 VPS 安装文件 |
| `VPS_PRESENCE` | Durable Object Binding | VPS 实时状态 |
| `DASHBOARD_HUB` | Durable Object Binding | 面板实时推送 |
| `*/5 * * * *` | Cron Trigger | 每 5 分钟检查离线状态 |

这些 binding 名称属于代码接口，使用已有资源时也不要改名。只有部署异常时才需要到 **Settings → Bindings** 核对它们。

## 开发者手动部署

仅在需要本地开发、命令行管理或自定义仓库时使用本节。普通用户请使用一键部署。

### 1. 准备环境

```bash
git clone https://github.com/yuanlam/kui-workers-pro.git
cd kui-workers-pro
npm ci
npx wrangler login
```

### 2. 创建 D1

```bash
npx wrangler d1 create kui-worker-db
```

将输出的 `database_id` 写入本地 `wrangler.jsonc`，不要提交到公开仓库：

```json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "kui-worker-db",
    "database_id": "替换为你的 database_id"
  }
]
```

`DB` 是固定 binding 名称。项目会在首次相关 API 请求时自动创建表结构，不需要单独执行 SQL migration；登录仅初始化认证表，其余结构按需批量初始化。

### 3. 设置 Secrets

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put PROXY_USER
npx wrangler secret put PROXY_PASS
```

后两项仅在使用住宅代理时需要。

### 4. 部署

```bash
npx wrangler deploy --name my-kui-worker
```

部署后检查实时服务：

```bash
curl -fsS https://你的-worker-域名/health
```

后续更新执行 `git pull` 和 `npx wrangler deploy`。仓库已启用 `keep_vars: true`，更新同一个 Worker 时会保留 Dashboard 中未写入配置文件的变量。手动部署不会自动创建或修改 GitHub 仓库。

## 更新现有部署

- 通过 Cloudflare 连接 Git 仓库部署：在 Cloudflare Dashboard 中触发最新提交的构建。
- 通过命令行部署：拉取最新代码后运行 `npm ci` 和 `npx wrangler deploy`。
- 更新前确认目标 Worker 名称与原实例一致，避免意外创建第二个实例。
- 常规更新不会删除已保存的 Secrets；不要把真实凭据写入 `wrangler.jsonc`。

## 自定义域名

项目默认关闭 `workers.dev` 公共入口，以减少面板和管理接口暴露。首次部署前必须准备 Cloudflare 托管的域名，并在 Worker 的 **Settings → Domains & Routes → Add → Custom Domain** 中绑定域名或子域名；未绑定自定义域名时，部署成功后也没有可访问的公共入口。

绑定完成后，请将 `PAGES_ORIGIN`、Agent 安装命令和回调地址统一设置为该 HTTPS 自定义域名，不要重新开启 `workers.dev`。

## 故障排查

### 页面空白、Hello World 或 1101

1. 在 **Settings → Bindings** 确认 D1 binding 名称为 `DB`。
2. 确认 `VPS_PRESENCE` 和 `DASHBOARD_HUB` 两个 Durable Objects bindings 存在。
3. 必要时添加兼容性标志 `assets_navigation_prefer_worker` 并重新部署。
4. 在 **Quick Edit** 中确认运行代码来自当前仓库的 `src/worker.js`。

### 登录按钮无响应

1. 确认部署的是仓库 `main` 分支最新版本。新版按钮会显示“登录中”，15 秒后会明确提示超时。
2. 确认 `ADMIN_PASSWORD` Secret 和 `DB` binding 均已配置。
3. 重新部署后强制刷新浏览器，避免继续使用旧 Worker Assets。
4. 在开发者工具 Network 中检查 `/api/login`：

| 状态 | 含义 |
| --- | --- |
| `200` | 登录成功 |
| `401` | 用户名或密码错误 |
| `429` | 失败次数过多，等待 15 分钟 |
| `503` | 未配置 `ADMIN_PASSWORD` |
| 超时 | 通常仍在运行旧版本，或 `DB` binding 异常 |

### 使用已有 D1

在 Worker 的 **Settings → Bindings** 中将 `DB` 重新绑定到目标数据库并部署。不要修改 binding 名称。

## Docker Compose + Nginx 自托管部署

自托管模式直接复用仓库的 `src/worker.js`、`functions/api/[[path]].js`、`realtime/src/index.js` 和 `static/` 构建产物，通过 `server/` 适配层提供 SQLite（D1 兼容）、本地 Durable Object 存储、静态资产与 WebSocket 实时通道，同时保持 Cloudflare Worker 部署完整可用。

### 1. 准备环境与配置文件

要求宿主机已安装 Docker 与 Docker Compose 插件（`docker compose version`）。

```bash
git clone https://github.com/yuanlam/kui-workers-pro.git
cd kui-workers-pro
cp .env.example .env
```

编辑 `.env`：

- `PUBLIC_ORIGIN`：对外访问的完整 HTTPS 地址，例如 `https://kui.example.com`（末尾不加斜杠）。
- `ADMIN_PASSWORD`：管理员独立强密码。
- `PROXY_USER` / `PROXY_PASS`：使用住宅代理时填写，两项需同时配置。
- `KUI_PORT`：宿主机本地监听端口，默认 `8787`（仅绑定 `127.0.0.1`）。

### 2. 构建并启动容器

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8787/health
```

返回 `{"ok":true,"service":"kui-realtime","version":1}` 即表示后端就绪。

### 3. 配置 Nginx 反向代理

1. 将 [`deploy/nginx-kui.conf.example`](../deploy/nginx-kui.conf.example) 复制到 `/etc/nginx/conf.d/kui.conf`（或 `/etc/nginx/sites-available/kui.conf`），替换域名与 SSL 证书路径。
2. 确认 Nginx `http {}` 块中已定义 `$connection_upgrade` 映射（模板末尾附有示例）。
3. 校验并重载配置：

```bash
nginx -t && systemctl reload nginx
curl -fsS https://你的域名/health
```

### 4. 日常更新与数据备份

- 更新代码并重建容器：

```bash
git pull
docker compose up -d --build
```

- 备份 SQLite 数据（命名卷 `kui_data` 挂载在容器 `/data`，包含 `kui.db` 与 `do-state.db`）：

```bash
docker compose exec kui sh -lc 'tar -czf - -C /data .' > kui-data-backup-$(date +%F).tar.gz
```
