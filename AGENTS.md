# kui-workers-pro

本文件定义 `kui-workers-pro` 仓库的长期协作约定、代码边界与验证门禁。

本项目使用全局已启用的官方 `superpowers` 插件处理需求澄清、方案设计、计划拆解、TDD、调试、审查与交付验证，并按需配合中文增强 skills。本文件只维护本仓库特有的稳定规则，一次性改造任务与阶段清单见 `docs/optimization-plan.md` 和 `plan/tasks.md`。

## 项目概况

- 架构形态：Cloudflare Worker 单体集成部署（Worker Assets + API + D1 + Durable Objects `VpsPresence` / `DashboardHub`）+ Vue 3 前端 + Linux VPS Python 守护进程（`agent.py`、`proxy_agent.py`、`proxy_server.py`）与安装脚本。
- 核心目录：
  - `src/worker.js`：Worker 入口与路由分发
  - `functions/api/[[path]].js`：API、鉴权、D1 持久化与节点/代理管理逻辑
  - `realtime/src/index.js`：Durable Objects WebSocket Hibernation 实时通道与状态同步
  - `frontend/`：Vue 3 + Vite + Tailwind CSS 前端源码
  - `static/vps/`：VPS 侧 Python 守护进程与 Shell 脚本
  - `static/index.html`、`static/ui-assets/`、`static/tailwind.css`：前端构建产物（禁止手改，修改 `frontend/` 或 `src/tailwind.css` 后由 `npm run build` 生成）
  - `tests/`：Node 测试（`tests/*.test.js`）与 Python 单元测试（`tests/test_*.py`）

## 常用命令

- 安装依赖：`npm ci`
- 前端构建：`npm run build`
- 前端开发服务：`npm run dev:ui`
- 本地 Worker 开发：`npm run dev`
- 运行测试：`npm test`
- 完整交付检查：`npm run check`（依次执行前端构建、Node 与 Python 测试、JS 语法检查、Python 编译检查、Shell 语法检查、`wrangler deploy --dry-run`）

## 关键边界与外部契约

- 禁止直接编辑 `static/index.html`、`static/ui-assets/` 和 `static/tailwind.css`。
- 重构前端时必须保留住宅代理页面（`frontend/src/proxy/legacyProxy.js` 及相关视图）依赖的固定 DOM ID 与探针主题兼容类，不破坏现有外部集成契约。
- 调整 `realtime/src/index.js` 与 `static/vps/agent.py` / `proxy_agent.py` 交互时，保持现有消息类型、字段向后兼容，避免已部署旧版 Agent 失联。
- Cloudflare Durable Object WebSocket Attachment 受 2,048 字节上限约束，禁止把大体积状态体、完整日志或候选列表写入 `ws.serializeAttachment()`。
- 仓库内不提交 Secrets、真实 `.env`、D1 数据库 ID、SQLite 文件或本机绝对路径。本地临时测试目录、Wrangler 状态、缓存和日志通过未提交的本地环境变量（如 `TMPDIR`、`WRANGLER_LOG_PATH`）指向外接盘运行数据目录，任务完成后清理一次性临时文件。

## 项目级专家角色与工作流

- 精选专家角色已安装到 `.codex/agents/`，对应源角色文档保留在 `.agents/roles/agency-agents-zh/`：
  - `engineering-backend-architect`：Worker API、D1、Durable Objects 与 VPS Python 后端架构
  - `engineering-frontend-developer`：Vue 3、Vite、Tailwind 与前端首屏/资源缓存优化
  - `security-appsec-engineer`：鉴权、会话吊销、最小权限隔离与代理安全审查
  - `engineering-minimal-change-engineer`：控制大文件改造 diff 边界，防止范围蔓延
  - `testing-performance-benchmarker`：量化 D1/DO、DNS 缓存、iptables 采样与前端加载收益
  - `testing-reality-checker`：交付门禁与证据核验
- 多角色编排审查工作流位于 `workflows/refactor-review.yaml`，可在需要跨维度评审时通过 `workflow-runner` 执行。
- 本地项目特有 skill 扩展点位于 `.agents/skills/`。

## 验证与交付要求

- 涉及后端 JS、Realtime DO、VPS Python 或前端修改时，先运行针对性的单测（`node --test tests/<file>.test.js` 或 `python3 -m unittest tests/<file>.py`），再执行 `npm run check` 与 `git diff --check`。
- 新增逻辑（特别是 `realtime/src/index.js` 和 `static/vps/proxy_server.py`）应补充对应单元测试。
- 提交前确认未引入未跟踪构建垃圾、密钥或本地绝对路径。
