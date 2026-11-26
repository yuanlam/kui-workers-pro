# 历史出口实现

归档基准为 `016f62f`。以下文件是移除 WARP、手动 SOCKS5 和旧 Mesh 前的完整源码快照，保留了相关函数的调用上下文。

| 归档文件 | 原位置与用途 |
| --- | --- |
| `frontend/WarpTunnelPage.vue` | `frontend/src/pages/WarpTunnelPage.vue`，隧道优选页面 |
| `original/frontend/` | 同路径的页面、状态、API、导航与样式，见 [前端索引](frontend/ui-snippets.md) |
| `backend/warp-socks5-mesh-api.js` | `functions/api/[[path]].js`，配置写入、下发、回执与优选接口 |
| `realtime/warp-do-handlers.js` | `realtime/src/index.js`，状态压缩、命令与回执转发 |
| `vps/agent-warp-socks5-mesh.py` | `static/vps/agent.py`，注册、WireGuard 配置、出口验证、优选与 Mesh 路由 |
| `original/src/`、`original/server/`、`original/static/` | 对应同路径的 Worker 和自建入口、安装与升级脚本、实时客户端及住宅组件 |
| `tests/`、`original/tests/` | 同名原测试，包含 WARP 优选、出口、实时、住宅和导航契约 |

恢复某个模式时，先对照基准提交提取该模式的处理分支及其测试。依次恢复数据库读写、Agent 配置、回执持久化、两种部署入口的转发和页面入口。`egress_mode`、`egress_applied_mode` 与两份配置 JSON 描述期望和已应用模式，revision 约束异步回执。手动 SOCKS5 依赖 `servers.socks5_*` 历史列，住宅代理有独立的配置与就绪检查。WARP 还依赖 wgcf、本机私有 profile、WireGuard endpoint 和实时 `warp.optimize` 消息。恢复时应将相关配置合并到当前版本，并重新运行相应的出口、实时、Agent 测试与 `npm run check`。

Vite 以 `frontend/` 为根，Tailwind 只扫描前端源码，Wrangler 发布 `static/`。Docker 镜像按目录显式复制，测试入口只发现根 `tests/` 中的用例。
