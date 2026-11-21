# 项目简报：kui-workers-pro

## 项目背景与目标

`kui-workers-pro` 克隆自 `yuanlam/kui-workers-pro`，作为独立本地项目进行持续稳定性、安全性、云端资源效率、VPS 运行性能与前端加载体验优化，同时保持现有的单 Cloudflare Worker 集成部署形态与外部契约不变。

## 技术栈与组成

- **边缘后端与实时通信**：Cloudflare Worker（`src/worker.js`）、API 路由与持久化（`functions/api/[[path]].js`）、D1 SQLite 数据库、Durable Objects WebSocket Hibernation（`realtime/src/index.js`）。
- **前端面板**：Vue 3 + Vite + Tailwind CSS（源码位于 `frontend/`，生产产物输出至 `static/`）。
- **VPS 守护进程**：Python 3（`static/vps/agent.py`、`static/vps/proxy_server.py`、`static/vps/proxy_agent.py`）与 Shell 部署脚本（`static/vps/*.sh`）。

## 改造路线概览

完整改造设计与验收标准记录在 `docs/optimization-plan.md`，阶段任务拆解见 `plan/tasks.md`：

1. **第一批（P0 稳定与安全 + P1 D1/DO 减负）**：解除 DO `serializeAttachment` 2 KiB 超限风险、对齐动态 `stale`/住宅出口新鲜度窗口、补齐禁用/删除用户会话吊销与普通用户 VPS 列表隔离、消除 `/api/data` 的 N+1 查询与冷启动冗余 DDL。
2. **第二批（P1 VPS 性能）**：为 `proxy_server.py` 增加带 TTL 的有界 DNS 缓存、备用 DNS 与 IPv4-only `AAAA` 跳过（并评估/实施 `asyncio` 转发），将 `agent.py` 端口流量采样从 `N × 4` 次子进程合并为固定 4 次批量导出。
3. **第三批（P2 前端与工程质量）**：将重型外部 CDN 库改为按需懒加载、为 Vite 构建产物启用内容哈希与分层缓存、清理 `useKuiState.js` 缺陷与补齐 `realtime` / `proxy_server.py` 单元测试。

## 已安装的精选专家角色（agency-agents-zh）

角色已同时安装为 Codex 可调用配置（`.codex/agents/*.toml`）和 `workflow-runner` 源参考文档（`.agents/roles/agency-agents-zh/`）：

| 角色 | 源文件路径 | 承担职责与选用原因 |
| --- | --- | --- |
| 后端架构师 | `.agents/roles/agency-agents-zh/engineering/engineering-backend-architect.md` | 负责 Cloudflare Worker、D1、Durable Objects 状态生命周期与 VPS Python 守护进程改造设计。 |
| 前端开发者 | `.agents/roles/agency-agents-zh/engineering/engineering-frontend-developer.md` | 负责 Vue 3 / Vite 懒加载、资源哈希缓存与 Composable 清理，同时守住固定 DOM ID 与主题兼容类契约。 |
| 应用安全工程师 | `.agents/roles/agency-agents-zh/security/security-appsec-engineer.md` | 负责会话吊销、RBAC 最小权限边界、Agent/Proxy 鉴权及敏感信息防泄露审查。 |
| 最小变更工程师 | `.agents/roles/agency-agents-zh/engineering/engineering-minimal-change-engineer.md` | 约束 2,700+ 行单文件的改动范围，防止修复扩散为失控重写。 |
| 性能基准师 | `.agents/roles/agency-agents-zh/testing/testing-performance-benchmarker.md` | 量化验证 D1 查询次数、DO 状态包体积、VPS DNS 延迟/子进程数与前端首屏加载改善。 |
| 现实检验者 | `.agents/roles/agency-agents-zh/testing/testing-reality-checker.md` | 负责每批次交付验收，要求基于 `npm run check` 与新增单测证据放行。 |

## 角色与工作流使用方式

- **单角色调用**：在项目目录启动新 Codex 会话后，可直接指定 `.codex/agents/` 下的角色（例如请 `engineering-backend-architect` 设计第一批方案，请 `security-appsec-engineer` 审查权限修复，请 `testing-reality-checker` 做验收检查）。
- **多角色审查工作流**：仓库已预置 `workflows/refactor-review.yaml`，每批次实施前或完成后可通过 `workflow-runner` 触发六角色联合评审。
- **新会话开场建议**：直接说明「阅读 `AGENTS.md`、`docs/optimization-plan.md` 和 `plan/tasks.md`，按第一批任务开始实施并补齐单元测试」。

## 运行数据与本地环境约定

- 本地 Wrangler 状态、测试临时文件、日志与缓存目录不提交入库，通过本地环境变量（如 `TMPDIR`、`WRANGLER_LOG_PATH`）指向外接盘运行数据目录，并在测试完成后清理临时子目录。
