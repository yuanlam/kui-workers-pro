# 改造任务清单

每完成一个批次先通过该批次单测与 `npm run check`，再推进下一批次。完整设计依据见 `docs/optimization-plan.md`。

## 第一批：P0 稳定与安全修复 + P1 D1/DO 减负

- [x] **DO Attachment 瘦身**（`realtime/src/index.js`）
  - [x] 从 `ws.serializeAttachment` 移除 `state`，仅保留 `ip / role / bootId / lastSeq / lastSeen / connected_at`
  - [x] 核查休眠恢复与所有 `deserializeAttachment()` 调用点，统一以内存 `snapshot` + DO Storage 为状态源
  - [x] 新增 `tests/realtime-do.test.js`，验证 16 KiB `proxy` 日志与 48 项 WARP 候选下 Attachment 体积 < 2,048 字节且恢复无损
- [x] **动态 `stale` 与住宅出口新鲜度对齐**（`realtime/src/index.js`、`functions/api/[[path]].js`、`frontend/src/composables/useKuiState.js`）
  - [x] 后端按当前频率策略动态计算 `stale_after_ms`（`Math.max(20_000, interval * 2 + 5_000)`）并下发前端
  - [x] 前端使用服务端下发或动态计算的超时阈值，移除硬编码 20 秒判定
  - [x] 放宽住宅出口 D1 新鲜度窗口至 `PROXY_DB_PERSIST_INTERVAL` 的 2 倍以上，消除 300 秒边缘假过期
- [x] **会话吊销与普通用户 VPS 隔离**（`functions/api/[[path]].js`）
  - [x] `PUT /api/users` 禁用用户与 `DELETE /api/users` 删除用户时同步删除 `auth_sessions`
  - [x] `verifyAuth` 校验非管理员会话对应的 `users.enable = 1`
  - [x] 非管理员 `/api/data` 仅返回已授权节点/分组关联的 `servers`
  - [x] 补充对应权限与会话吊销自动化测试
- [x] **D1 读写减负**（`functions/api/[[path]].js`）
  - [x] 合并 `/api/data` 中 `getProxySlotConfig` N+1 查询为单次批量加载 `getProxySlotConfigMap`
  - [x] 为 `ensureDbSchema` 引入 `schema_version` 快速短路，解耦冷启动外部 GitHub 种子请求
  - [x] 补充查询次数与版本短路单测
- [x] **第一批验收**：运行 `npm run check`、`git diff --check`，按需通过 `workflows/refactor-review.yaml` 评审

## 第二批：P1 VPS 代理性能与 Agent 采样优化

- [x] **`proxy_server.py` DNS 与并发优化**（`static/vps/proxy_server.py`、`static/vps/lite_manager.py`）
  - [x] 实现线程安全、带 TTL 夹紧和容量上限的 LRU DNS 缓存（按绑定接口与隧道世代隔离，并在 `lite_manager.py` 切线/重拨/踢线时失效缓存）
  - [x] 支持主备 DNS 列表自动故障切换，IPv4-only 隧道跳过 `AAAA` 查询，补齐 QNAME/owner/CNAME 标签边界校验与 TCP 共享截止时间
  - [x] 新增 `tests/test_proxy_server.py` 覆盖 DNS 缓存、TTL、回退、IPv4-only、世代隔离、双栈故障恢复与 UDP 转发复用
  - [x] 评估是否将每连接双线程 `relay` 改写为标准库 `asyncio`（经六角色评审确认维持现有线程模型符合最小变更原则，暂缓迁移并记录后续 Linux 压测指标）
- [x] **`agent.py` 端口流量批量采样**（`static/vps/agent.py`）
  - [x] 每轮统一执行 4 次 `iptables`/`ip6tables -nvxL` 并构建 `(proto, port) -> bytes` 映射，按 IPv4/IPv6 固定列边界隔离注释与接口列，区分 IPv6 未部署与瞬时采样降级以防止重复计费
  - [x] 保持 `get_port_traffic` 向后兼容并扩展 `tests/test_agent.py` 验证子进程数固定为 4 次、统计精确一致及降级/恢复基线保护
- [x] **第二批验收**：运行 `npm run check`、`git diff --check`，通过 `workflows/refactor-review.yaml` 六角色评审并获 `GPT-6.2-Astra` `APPROVED`

## 第三批：P2 前端首屏优化、构建哈希与工程清理

- [x] **外部 CDN 懒加载**（`frontend/index.html`、`frontend/src/utils/externalDeps.js`、`frontend/src/composables/useAuth.js`、`frontend/src/composables/useKuiState.js`、`frontend/src/main.js`）
  - [x] 封装带 SRI 与匿名 CORS 校验的按需加载器，将 `echarts`、`chart.js`、`leaflet`、`qrious`、`tweetnacl` 移出 `<head>` 同步阻塞链路
  - [x] 新增 `tests/batch3-assets.test.js`、`tests/batch3-frontend.test.js` 覆盖按需加载、错误重试、节点流量图、探针详情/地图、二维码弹窗与 Reality 密钥生成链路
- [x] **构建哈希与缓存头**（`vite.config.js`、`src/worker.js`）
  - [x] 启用 `ui-assets/[name]-[hash]` 输出，在 `buildStart`/`writeBundle` 拒绝 `ui-assets` 符号链接并仅清理 `static/ui-assets/` 旧普通文件
  - [x] 为哈希 `/ui-assets/*` 设置长期 `immutable` 缓存、为 HTML 入口设置 `no-cache, must-revalidate`，保留上游 `private`/`no-store`/`no-cache` 限制并统一重建不可变响应头与 `304/204/205/HEAD` 空响应体
- [x] **Composable 清理与主题抽离**（`frontend/src/composables/useKuiState.js`、`frontend/src/styles/probeThemes.js`）
  - [x] 移除重复导出的 `copyPurgeCommand`，提前注册并在 `onBeforeUnmount` 清理 `visibilitychange` 及各类定时器/Socket/图表/地图资源；补齐登出私有态清理、跨会话代次拦截与并发实时 ticket 去重/中止
  - [x] 将 18 套探针主题兼容性样式与背景 URL 净化（拒绝 C0 控制字符与 DEL）抽离至 `frontend/src/styles/probeThemes.js`，保留全部主题类名与住宅代理固定 DOM ID
- [x] **第三批验收**：运行 `npm run build`、`npm run check`（281 项 Node 单测 + 109 项 Python 单测 + 语法检查 + `wrangler deploy --dry-run`）、`git diff --check`，通过 `workflows/refactor-review.yaml` 六角色评审并获 `GPT-6.2-Astra` `APPROVED`
