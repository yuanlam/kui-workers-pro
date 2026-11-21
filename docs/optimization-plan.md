# kui-workers-pro 三批优化改造方案

本方案基于对当前仓库（基准提交 `55b0990`）的源码审计整理，分为三个独立可验收的实施批次。改造保持单 Cloudflare Worker 集成部署形态、外部代理接口与前端集成契约不变。

---

## 第一批：P0 运行稳定性与安全修复 + P1 D1/DO 读写减负

### 1.1 解除 Durable Object `serializeAttachment` 2 KiB 超限隐患

- **问题定位**：`realtime/src/index.js:348,493-494` 将完整的 `compactRoleState(role, nextRoleState)` 写入 `ws.serializeAttachment(attachment)`。其中：
  - `proxy` 状态允许携带最高 16 KiB `logs`（`realtime/src/index.js:133`）；
  - `core` 状态的 `warp.optimizer` 最多包含 48 个候选节点与 12 条切换历史（`realtime/src/index.js:99-107`）。
  - Cloudflare WebSocket Hibernation `serializeAttachment` 单条硬上限为 2,048 字节，超限会抛出异常导致状态包被丢弃或连接异常。
- **改造设计**：
  1. 收敛 `ws.serializeAttachment` 为纯轻量元数据对象：`{ ip, role, connected_at, bootId, lastSeq, lastSeen }`，彻底移除 `attachment.state`。
  2. 全量角色状态保留在内存 `this.snapshot` 中，并由 DO Storage（`this.ctx.storage.put("state", ...)`，单键上限 128 KiB）负责休眠恢复；检查 `VpsPresence` 构造/唤醒路径（含 `realtime/src/index.js:564,614` 等读取 `deserializeAttachment()` 处），确认休眠恢复统一从 `this.ctx.storage.get("state")` 与轻量 `attachment` 重建状态，不再依赖 `attachment.state`。
  3. 对 `serializeAttachment` 写入做字节数保护测试（UTF-8 编码后严格小于 2,048 字节，建议 < 512 字节）。
- **验收标准**：
  - 新增 `tests/realtime-do.test.js`，构造带 16 KiB `proxy` 日志和 48 项 WARP 候选的 `core` 状态包，验证 `serializeAttachment` 体积始终远小于 2,048 字节且 `snapshot` 完整保留并可从 DO Storage 恢复。

### 1.2 对齐 `stale` 超时阈值与住宅出口持久化新鲜度窗口

- **问题定位**：
  - **动态 `stale` 冲突**：`STATUS_STALE_AFTER` 写死为 `20_000` ms（`realtime/src/index.js:8`），前端定时器同样写死 `now - server.last_report > 20000`（`frontend/src/composables/useKuiState.js:1212`）。而 `IDLE_STATUS_INTERVAL` 为 `30_000` ms，管理员频率策略 `validFrequencyPolicy` 允许将 `admin` 设为最高 60 秒、`public` 设为最高 120 秒（`realtime/src/index.js:18-24`），导致健康节点周期性显示 `stale`。
  - **住宅出口 300 秒边缘误报**：`PROXY_DB_PERSIST_INTERVAL` 为 `300_000` ms（`realtime/src/index.js:12`），而 API 判定住宅出口新鲜度的截止时间同样为 `300_000` ms（`functions/api/[[path]].js:1838`、`2308`），在 300 秒刷新边界会出现短暂误报「状态已过期」。
- **改造设计**：
  1. 在 `realtime/src/index.js` 中按当前有效上报间隔动态计算 `staleAfter`：`Math.max(20_000, activeInterval * 2 + 5_000)`，并将 `stale_after_ms`（或当前 `interval_ms`）随实时快照下发给前端。
  2. 在 `frontend/src/composables/useKuiState.js` 中优先读取服务端下发的 `stale_after_ms`（缺省回退至按当前频率策略计算的值或 `20_000` ms），消除前后端写死 20 秒的冲突。
  3. 将 `functions/api/[[path]].js:1838,2308` 的住宅出口新鲜度窗口放宽至 `Math.max(PROXY_DB_PERSIST_INTERVAL * 2 + 60_000, 11 * 60 * 1000)`（或在已连接 `VpsPresence` 时同步参考实时状态），消除 300 秒持久化周期边缘的假性过期。
- **验收标准**：
  - 单测覆盖 `admin=5s/30s/60s`、`public=10s/60s`、`idle=30s` 场景下 `stale` 判定准确，且住宅出口在 300s 节流周期内不会误判过期。

### 1.3 用户禁用/删除立即吊销会话 & 普通用户 `/api/data` 最小权限隔离

- **问题定位**：
  - `PUT /api/users`（禁用用户）与 `DELETE /api/users`（删除用户）在 `functions/api/[[path]].js:2414-2415` 中未清理 `auth_sessions`，且 `verifyAuth`（`functions/api/[[path]].js:1069`）只查询 `auth_sessions` 未校验用户是否仍存在且 `enable = 1`，导致已禁用或已删除账号在 12 小时会话期内仍可访问接口。
  - 非管理员调用 `/api/data` 时，`functions/api/[[path]].js:2306` 直接执行 `SELECT ... FROM servers` 返回全表 VPS 记录，泄露未授权给该用户的主机 IP 与指标。
- **改造设计**：
  1. 在 `PUT /api/users` 中当 `Number(enable) === 0`（或 `!enable`）时，在同一个 `db.batch` 中追加 `DELETE FROM auth_sessions WHERE username = ?`；在 `DELETE /api/users` 的 `db.batch` 中同样追加 `DELETE FROM auth_sessions WHERE username = ?`。
  2. 在 `verifyAuth` 的 Bearer Token 校验分支中，对非管理员账号联表或二次核验 `users` 表 `enable = 1`（管理员账号 `env.ADMIN_USERNAME || 'admin'` 保持独立校验），若账号不存在或已禁用则拒绝请求并顺带清理失效会话。
  3. 在 `/api/data` 非管理员分支中，先查询该用户可见的 `nodes`（`functions/api/[[path]].js:2336`）以及通过 `user_group_resources` 直接授权给该用户的 `resource_type = 'vps'`，将 `servers` 过滤为仅包含用户有权访问的 VPS（`ip IN (...)`）；无任何授权节点/VPS 时直接返回空数组 `[]`。同时核对公开探针页面（`is_public`）走独立探针接口，不受此过滤影响。
- **验收标准**：
  - 新增/扩展 `tests/` API 单测：验证禁用用户、删除用户后原 Bearer Token 立即返回 `401`；验证普通用户调用 `/api/data` 仅能看到自己节点/分组关联的 `servers`，无法看到无关 VPS IP。

### 1.4 消除 `/api/data` N+1 查询与 Worker 冷启动冗余 DDL

- **问题定位**：
  - `functions/api/[[path]].js:2311-2314` 在 `for (const server of servers)` 循环内逐台调用 `await getProxySlotConfig(db, server.ip)`，每台服务器执行 1–2 次 D1 查询（N 台 VPS 触发最多 `2N` 次串行查询）。
  - `ensureDbSchema(db)`（`functions/api/[[path]].js:917-1049`）虽然在单个 Isolate 生命周期内通过 `schemaReadyPromise` 缓存，但每次 Worker 冷启动仍会批量执行 ~30 条 `CREATE TABLE` / `ALTER TABLE` / 种子校验语句，且在缺少 `cached_nodes_data` 时同步发外部 GitHub 请求。
- **改造设计**：
  1. 新增批量加载函数 `getProxySlotConfigMap(db)`：一次查询 `SELECT key, value FROM probe_settings WHERE key = 'proxy_slot_map' OR key LIKE 'proxy_slot_map_%'`，在内存中解析全局默认与按 IP 覆盖配置，替换 `/api/data` 循环内的逐台查库。
  2. 引入明确的 `SCHEMA_VERSION` 常量，存入 `sys_config`（如 `key = 'schema_version'`）。Worker 冷启动时先做一次轻量 `SELECT val FROM sys_config WHERE key = 'schema_version'`；版本匹配即直接跳过全量 DDL 与 `ALTER TABLE` 迁移（表不存在或版本不一致时再执行完整 `initializeDbSchema` 并写入最新 `schema_version`）。
  3. 将 `cached_nodes_data` 外部 GitHub 拉取与核心 Schema 初始化解耦（仅在首次访问探针测速或后台 `context.waitUntil` 异步补种），避免外部网络波动拖慢冷启动首包。
- **验收标准**：
  - 单测验证 `/api/data` 无论返回多少台 `servers`，`probe_settings` 仅查询 1 次；验证 `schema_version` 命中时冷启动不再执行全量 `CREATE/ALTER` 语句，且首次建库与版本升级路径均正常。

---

## 第二批：P1 VPS 代理性能优化与 Agent 采样减负

### 2.1 `proxy_server.py` 增加带 TTL 的有界 DNS 缓存、备用 DNS 与 IPv4-only 跳过 `AAAA`

- **问题定位**：`static/vps/proxy_server.py:183-204` 的 `resolve_on_landing` 无任何缓存，且对每个域名串行经 OpenVPN 隧道向单一上游 `1.1.1.1:53` 查询 `A`（type=1）与 `AAAA`（type=28）。每次 TCP 建连及 UDP 转发循环中每个带域名的数据包（`static/vps/proxy_server.py:290`）都会触发同步网络 DNS 查询，且 `1.1.1.1` 不可达时单次解析阻塞长达数秒。
- **改造设计**：
  1. 解析 DNS 响应中的记录 TTL（提取最小有效 TTL 并夹紧到合理区间，如 `30s ~ 600s`），实现线程安全、带过期时间与容量上限（如 1,024 条）的 LRU 缓存，缓存键包含 `(host, interface, ipv6_enabled)`；切换 `ACTIVE_BIND` 隧道接口时自动按接口隔离或主动清空旧接口缓存。
  2. 支持主备 DNS 上游列表（默认 `["1.1.1.1", "8.8.8.8"]`，允许通过环境变量覆盖），主 DNS 超时或报错时立即降级至备用 DNS，并缩短单次查询超时避免长阻塞。
  3. 探测或按接口能力判断当前绑定隧道是否具备 IPv6 路由；IPv4-only 隧道跳过 `AAAA`（type=28）查询，消除一半无效 DNS 往返。
  4. **可选进阶（按基准收益决定）**：评估将 `relay` 每连接双线程模型（`static/vps/proxy_server.py:256-259`）迁移为标准库 `asyncio`（零第三方依赖），降低 256 并发下的线程与 GIL 争用；若迁移则保持现有 SOCKS5 TCP/UDP、认证、`SO_BINDTODEVICE` 与热切换 `ACTIVE_BIND` 语义完全一致。
- **验收标准**：
  - 新增 `tests/test_proxy_server.py`，覆盖：TTL 解析与缓存命中/过期、LRU 淘汰、接口切换隔离、主 DNS 失败自动切备用 DNS、IPv4-only 跳过 `AAAA`、UDP 域名包高频转发复用缓存。

### 2.2 `agent.py` 流量采样合并为固定 4 次 `iptables`/`ip6tables` 批量导出

- **问题定位**：`static/vps/agent.py:1462-1499` 的 `_read_iptables_port_bytes(port, protocol)` 在每轮采集时针对每个节点 × 每种传输协议分别执行 4 次子进程（`iptables/ip6tables` × `INPUT/OUTPUT`）。10 个双栈/双协议节点单轮产生 40–80 个子进程。
- **改造设计**：
  1. 新增快照读取函数（如 `_collect_iptables_port_bytes_snapshot()`），每轮统计仅执行固定 4 次子进程（`iptables -nvxL INPUT/OUTPUT`、`ip6tables -nvxL INPUT/OUTPUT`），一次性解析 `ACCEPT` 规则中 `dpt:<port>` / `spt:<port>` 与协议字段，聚合为 `{(protocol, port): total_bytes}` 映射表。
  2. 在主采集循环中复用同一份轮次快照传入 `get_port_traffic(..., snapshot=snapshot)`；保留无快照参数时的回退兼容，确保单点调用与现有测试不破坏。
- **验收标准**：
  - 扩展 `tests/test_agent.py`，验证多节点、多协议（`tcp`、`udp`、`tcp,udp`）混合采集时子进程总调用次数恒为 4 次，且字节统计结果与原实现逐端口一致。

---

## 第三批：P2 前端首屏加载优化、构建哈希与工程可维护性

### 3.1 重型外部 CDN 库改为按需懒加载 & 评估统一图表库

- **问题定位**：`frontend/index.html:11-17` 在 `<head>` 同步阻塞加载 `tweetnacl`、`echarts`（~1 MB）、`qrious`、`chart.js`（~200 KB）、`leaflet` 及 Google Fonts，导致登录页和常规节点管理页首屏加载受阻。其中：
  - `echarts` 仅在管理员节点流量趋势图使用（`frontend/src/composables/useKuiState.js:515`）；
  - `chart.js` 与 `leaflet` 仅在探针详情/地图视图使用；
  - `qrious` 仅在打开节点二维码弹窗时使用（`frontend/src/composables/useKuiState.js:901`）；
  - `tweetnacl` 仅在生成 Reality 密钥对时按需使用。
- **改造设计**：
  1. 新增 `frontend/src/utils/externalDeps.js`：封装幂等的脚本/样式动态加载器（保留现有 CDN URL 与 SRI `integrity`、`crossorigin="anonymous"` 校验属性，失败可重试且并发调用复用同一 Promise）。
  2. 从 `frontend/index.html` `<head>` 移除阻塞性的重型库 `<script>` / `<link>`（Google Fonts 使用 `preconnect` + 异步加载），改为在进入对应 Tab、打开弹窗或点击密钥生成时按需加载。
  3. 若将 `echarts` 或 `chart.js` 合并为单一图表库，需在实施前核对两处图表样式与交互是否完全等价；如存在差异，先完成按需懒加载再单独评估合并。

### 3.2 Vite 产物内容哈希与缓存策略

- **问题定位**：`vite.config.js:14-15` 固定输出 `ui-assets/app.js` 与 `ui-assets/[name][extname]`，缺少内容哈希；同时 `emptyOutDir: false` 需要避免每次构建残留过期的旧哈希文件。
- **改造设计**：
  1. 将 `vite.config.js` 调整为 `ui-assets/[name]-[hash].js` 与 `ui-assets/[name]-[hash][extname]`，并增加构建前清理 `static/ui-assets/` 的钩子或 npm script（仅清理 `static/ui-assets/`，绝对不动 `static/vps/` 等其他静态目录）。
  2. 在 `src/worker.js` 静态资源响应头中为 `/ui-assets/*` 哈希资源设置 `Cache-Control: public, max-age=31536000, immutable`，为 `/` 与 `/index.html` 设置 `Cache-Control: no-cache, must-revalidate`。
  3. 同步检查现有测试（如 `tests/` 中是否断言了固定文件名 `ui-assets/app.js`），更新为匹配构建后 `static/index.html` 引用或正则匹配。

### 3.3 `useKuiState.js` 清理与低风险模块化

- **问题定位**：
  - `frontend/src/composables/useKuiState.js:1262-1263` 重复导出 `copyPurgeCommand`。
  - `frontend/src/composables/useKuiState.js:1256` 注册的 `document.addEventListener('visibilitychange', ...)` 未在 `onBeforeUnmount` 中移除。
  - 文件内嵌 18 套主题 CSS 字符串，影响可读性与维护性。
- **改造设计**：
  1. 去重 `copyPurgeCommand`，将 `visibilitychange` 监听抽取为具名函数并在 `onBeforeUnmount` 正确解绑。
  2. 将 18 套内联主题 CSS 抽离至独立模块（如 `frontend/src/styles/probeThemes.js`），严格保持全部 CSS 类名与住宅代理固定 DOM ID 不变。
  3. 重新运行 `npm run build` 与 `npm run check`，验证产物、主题切换、二维码、图表、地图及住宅代理兼容脚本全部正常。

---

## 全局验证与交付门禁

每一批次完成后均需执行：
1. 针对本批次改动编写并运行新增/修改的单元测试（Node 与 Python）。
2. 运行 `npm run check`（包含 `npm run build`、`npm test`、语法检查、Python 编译、Shell 检查、`wrangler deploy --dry-run`）。
3. 运行 `git diff --check` 确认无空白符或格式错误。
4. 可选运行 `workflows/refactor-review.yaml` 进行多角色审查后进入下一批次。
