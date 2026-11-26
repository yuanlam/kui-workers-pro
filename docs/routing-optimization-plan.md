# 出口精简、协议栈开关、精准分流与实时分流日志优化方案

本方案基于基准提交 `016f62f` 的源码审计与用户确认需求，覆盖 Cloudflare Worker API（`functions/api/[[path]].js`）、自建 Node 入口（`server/index.js`）、Realtime Durable Object（`realtime/src/index.js`）、VPS `sing-box` Agent（`static/vps/agent.py`，线上实测 `sing-box 1.13.14`）及 Vue 3 管理面板（`frontend/src/`）。

---

## 1. 目标与约束

### 1.1 四项目标

1. **出口模式精简 + 代码存档**：仅保留 `原生直连`、`全局住宅`、`直连/住宅分流` 3 种模式；WARP（含隧道优选）、手动 SOCKS5、旧 Mesh 链式转发从生产代码移除，完整代码存档到 `archive/legacy-egress/`，需要时可按归档说明恢复。
2. **IPv4 / IPv6 协议栈开关**：节点级支持 `仅 IPv4`（`ipv4_only`）、`仅 IPv6`（`ipv6_only`）、`双栈`（`dual`），并修复现有分流模式误拦截直连 IPv6 的缺陷。
3. **精准分流与防泄漏**：内置分流收敛为 `AI`、`油管`、`流媒体`、`谷歌` + `自定义黑白名单`；优先级为 `自定义（白名单 → 黑名单） → AI → 油管 → 流媒体 → 谷歌`；路由与 DNS 规则 1:1 对齐，住宅故障 Fail-Close。油管、谷歌规则源由用户另行提供。
4. **实时分流匹配日志页**：面板新增管理员页面「分流日志」。**先出预览图（亮色桌面 / 暗色桌面 / 移动端），用户确认后再实施。**

### 1.2 交付红线

- `static/index.html`、`static/ui-assets/`、`static/tailwind.css` 只能由 `npm run build` 生成。
- 保留 `frontend/src/proxy/legacyProxy.js` 与 `ResidentialProxyPage.vue` 的固定 DOM ID 与探针主题兼容类。
- `ws.serializeAttachment()` 严格小于 2,048 字节；分流日志、活跃连接、规则列表不得写入 Attachment、DO Storage 或 D1。
- 新旧 Agent 消息字段向后兼容；Worker 与自建 Node 入口路径保持一致（新增内部 POST 路径同步加入 `server/index.js` 的 `INTERNAL_REALTIME_POST_PATHS`）。
- 预览图、临时目录写入工作区指定的外接盘运行数据目录，结束后用 `trash` 清理临时目录；仓库内不出现本机绝对路径或 Secrets。
- 不修改、不提交工作区已有的未提交文件（`AGENTS.md`、`.codex/agents/*.toml`）。

---

## 2. 模块一：出口模式精简与代码存档

### 2.1 保留的 3 种模式

| 面板名称 | `egress_mode` | `proxy_mode` | 行为 |
| --- | --- | --- | --- |
| 原生直连 | `native` | `global`（忽略） | 全部流量走 `direct-out` |
| 全局住宅 | `residential` | `global` | 局域网外全部流量走住宅 `socks5-outbound`，`route.final` 为住宅 |
| 直连/住宅分流 | `residential` | `selective` | 命中规则走住宅，其余走 `direct-out` |

### 2.2 存档目录 `archive/legacy-egress/`

`package.json` 的 `build` / `test` / `check` 只扫描显式源码目录（`frontend/`、`tests/*.test.js`、`tests/test_*.py`、`static/vps/*.py|*.sh` 等），存档目录不参与构建与测试。实施时需再次确认 Vite、Tailwind `content`、Wrangler assets 均不扫描 `archive/`。

```text
archive/legacy-egress/
├── README.md                         # 基准提交 016f62f、各片段原始位置、恢复步骤、依赖字段说明
├── frontend/
│   ├── WarpTunnelPage.vue            # 原页面完整副本
│   └── ui-snippets.md                # ServersPage / useKuiState / useApi / 导航 / app.css 中移除的片段
├── backend/
│   └── warp-socks5-mesh-api.js       # API 中移除的 WARP 优选、手动 SOCKS5 校验与存储、mesh 处理
├── realtime/
│   └── warp-do-handlers.js           # /warp-optimize 转发、WARP 状态压缩与广播
├── vps/
│   └── agent-warp-socks5-mesh.py     # WARP 注册/优选/WireGuard、手动 SOCKS5、mesh 链式转发
└── tests/
    └── warp-optimizer.test.js        # 原 WARP 单测副本及其它被删除用例
```

存档文件以「代码片段 + 原位置注释」保存，不要求可直接运行；README 写明恢复时需要同步还原的接口、字段与测试。

### 2.3 生产代码清理与存量兼容

- **API**：`EGRESS_MODES` 收敛为 `native`、`residential`；写接口拒绝 `warp_*`、`socks5`；移除 `/api/vps/warp-optimize`。
- **存量数据**：不删除 `servers.socks5_*` 等历史列；读取时 `egress_mode` / `egress_applied_mode` / `egress_desired_config.mode` 为 `warp_ipv4|warp_ipv6|warp_dual|socks5` 的记录归一化为 `native`，并在列表返回 `egress_legacy_migrated: true`，面板提示「原模式已下线，已切换为原生直连」。下发给 Agent 的配置始终是归一化后的结果。
- **Realtime / 自建入口**：移除 `/warp-optimize` 路径、`core.warp` 状态压缩与 `core_warp_result` 广播；收到旧 Agent 上报的 `warp` 字段时静默丢弃。
- **Agent**：移除 WARP、手动 SOCKS5、mesh 构建逻辑；`build_singbox_config` 签名去掉 `peers`、`mesh`、`warp_mode`；收到旧字段时忽略。升级时清理遗留的 `warp-out` endpoint 配置与 WARP profile 文件（备份后移除）。
- **前端**：删除 `WarpTunnelPage.vue` 及 `AppShell.vue`、`DesktopNavigation.vue`、`MobileNavigation.vue`、`TopBar.vue`、`useKuiState.js`（`warpTargetIp` 等状态与优选函数）、`useApi.js`、`egressState.js`（`shouldSuggestWarpOptimization`、`warp` 遥测字段）、`ServersPage.vue`（WARP 准备中状态、SOCKS5 表单）、`app.css` 中的相关代码；`egressModeLabel` 仅保留 3 种模式文案。
- **测试**：删除或改写 `tests/warp-optimizer.test.js`、`tests/egress.test.js`、`tests/realtime-do.test.js`、`tests/test_agent*.py`、`tests/ui-navigation.test.js` 中的 WARP / SOCKS5 / mesh 用例，新增存量映射用例。

---

## 3. 模块二：IPv4 / IPv6 协议栈开关（`ip_stack`）

### 3.1 数据模型

- 字段 `ip_stack ∈ {"ipv4_only", "ipv6_only", "dual"}`，默认 `dual`。
- 写入 `egress_desired_config` / `egress_applied_config` JSON；新增幂等迁移列 `servers.ip_stack TEXT NOT NULL DEFAULT 'dual'` 便于列表返回。
- 修改 `ip_stack` 与修改出口模式一样递增 `egress_revision`，走现有 pending → applied/failed 回执流程。

### 3.2 行为矩阵

住宅 SOCKS5 通道为 IPv4 出口，因此住宅流量统一 `ipv4_only`。

| 模式 | `ipv4_only` | `ipv6_only` | `dual`（默认） |
| --- | --- | --- | --- |
| 原生直连 | DNS `ipv4_only`；拒绝 `ip_version: 6` | DNS `ipv6_only`；拒绝 `ip_version: 4` | DNS `prefer_ipv4`；IPv4/IPv6 均直连 |
| 全局住宅 | 住宅 DNS `ipv4_only`；拒绝 IPv6；其余走住宅 | **禁止组合**，前后端都校验 | 住宅 DNS `ipv4_only`；拒绝非局域网 IPv6，避免绕过住宅；其余走住宅 |
| 直连/住宅分流 | 两类 DNS 均 `ipv4_only`；拒绝 IPv6 | 直连 DNS `ipv6_only` 且直连拒绝 IPv4；命中住宅规则的流量走 `proxy-dns`（`ipv4_only`）并拒绝其 IPv6 | 直连 DNS `prefer_ipv4`，IPv4/IPv6 正常直连；命中住宅规则的流量走 `proxy-dns`（`ipv4_only`）并先拒绝其 IPv6 |

同时修复 `static/vps/agent.py:1140`：分流模式末尾无差别追加 `{"ip_version": 6, "action": "reject"}` 会误杀直连 IPv6。IPv6 拒绝规则改为只挂在住宅命中规则组上，或者由 `ip_stack` 生成。

节点探测：Agent 上报本机 IPv4/IPv6 出口可用性（`has_ipv4`、`has_ipv6`）；VPS 无 IPv6 时，面板禁用 `ipv6_only` 并对 `dual` 显示提示。

---

## 4. 模块三：分流规则体系与防泄漏

### 4.1 规则组清单

| 优先级 | 规则组 key | 名称 | 出口 | 来源 |
| --- | --- | --- | --- | --- |
| 0 | `lan` | 局域网/保留地址 | `direct-out` | `ruleset.skk.moe/sing-box/non_ip/lan.json` + `ip/lan.json`（系统内置，不可关闭） |
| 1 | `custom_direct` | 自定义直连（白名单） | `direct-out` | 用户配置 |
| 2 | `custom_proxy` | 自定义住宅（黑名单） | `socks5-outbound` | 用户配置（兼容旧 `proxy_custom_domains`） |
| 3 | `ai` | AI | `socks5-outbound` | `https://ruleset.skk.moe/sing-box/non_ip/ai.json` + `https://ruleset.skk.moe/sing-box/ip/ai.json`（`format: "source"`） |
| 4 | `youtube` | 油管 | `socks5-outbound` | **用户另行提供** |
| 5 | `streaming` | 流媒体 | `socks5-outbound` | `https://ruleset.skk.moe/sing-box/non_ip/stream.json` + `https://ruleset.skk.moe/sing-box/ip/stream.json`（`format: "source"`） |
| 6 | `google` | 谷歌 | `socks5-outbound` | **用户另行提供** |

- `ruleset.skk.moe` 只提供 sing-box `source` JSON（`.srs` 返回 404），按 `non_ip/*.json`（域名，可用于 DNS）+ `ip/*.json`（仅 route）成对使用。
- 规则源统一写在 `SELECTIVE_PROXY_RULE_SETS` 注册表中，字段为 `tag`、`format`（`source|binary`）、`url`、`use`（`route|dns|both`）、`group`；油管、谷歌只需补注册表条目，不改匹配逻辑。移除现有写死 commit hash 的 GitHub URL。
- 分类 key 保持 `ai`、`youtube`、`streaming`、`google`、`custom`；`custom` 表示启用自定义住宅名单，自定义直连名单在分流模式下始终生效。

### 4.2 匹配顺序（route 与 DNS 1:1 对齐）

sing-box 按首条命中执行。每个规则组生成独立规则项，`/connections` 返回的 `rule` / `rulePayload` 可以直接对应到规则组。

1. `sniff`（继续跳过 TUIC 入站以免 Surge 断流，面板注明 TUIC 只能按 IP/DNS 匹配）→ `hijack-dns`。
2. `lan` → `direct-out`；DNS → `local-dns`。
3. `custom_direct` → `direct-out`；DNS → `local-dns`（按直连 `ip_stack` 策略）。
4. `custom_proxy`：QUIC/UDP443 → `reject`（开关开启时）；`ip_version: 6` → `reject`；其余 → `socks5-outbound`。DNS → `proxy-dns`（`ipv4_only`）。
5. 内置组按 `AI → 油管 → 流媒体 → 谷歌` 依次生成。每组规则依次为：QUIC → `reject`（开关开启时），IPv6 → `reject`，其余 → `socks5-outbound`，DNS → `proxy-dns`（`ipv4_only`）。
   - **排除保护**：启用宽泛组但未启用更高优先级的细分组时，在该宽泛组之前插入细分组的直连排除（route `direct-out` + DNS `local-dns`），使细分组流量保持直连。规则为：启用 `google` 且未启用 `ai` 时排除 `ai`；启用 `streaming` 或 `google` 且未启用 `youtube` 时排除 `youtube`。
6. 协议栈约束：`ipv4_only` 拒绝 IPv6；`ipv6_only` 下直连拒绝 IPv4。
7. `route.final`：全局住宅为 `socks5-outbound`，分流 / 原生直连为 `direct-out`。DNS `final`：全局住宅为 `proxy-dns`，其余为 `local-dns`。

全局住宅模式执行前两步，仅局域网直连，其余流量走住宅出口。自定义直连和自定义住宅名单仅在直连/住宅分流模式生效。

### 4.3 自定义黑白名单语法

前后端共用同一套解析与上限（每个列表 ≤ 200 条、≤ 32 KiB），空行与 `#` 开头的注释行会被忽略：

| 写法 | 示例 | sing-box 字段 | 参与 DNS |
| --- | --- | --- | --- |
| 后缀（默认） | `openai.com`、`*.openai.com` | `domain_suffix` | 是 |
| 精确 | `full:api.openai.com` | `domain` | 是 |
| 关键词 | `keyword:chatgpt` | `domain_keyword` | 是 |
| IP / CIDR | `1.1.1.1`、`104.18.0.0/16`、`2606:4700::/32` | `ip_cidr`（单 IP 补 `/32`、`/128`） | 否 |

- 存储字段：`proxy_direct_rules`、`proxy_custom_rules`（JSON 数组，保存规范化后的字符串）；旧 `proxy_custom_domains` 读取时映射为后缀规则。
- 同一条目同时出现在两个名单时，API 返回 `400` 并列出冲突项，前端实时标红。
- 拒绝 `localhost`、`.local`、私网/保留 IP 段写入住宅名单（这些流量已由 `lan` 直连）；关键词限制为 `[a-z0-9-]`，长度 ≥ 3。

### 4.4 防泄漏与稳定性

1. **双 DoH**：`proxy-dns`（`1.1.1.1`）+ `proxy-dns-backup`（`8.8.8.8`），均 `detour: socks5-outbound`、`ipv4_only`；`local-dns` 保持系统解析。
2. **Fail-Close**：住宅模式下 SOCKS5 未就绪时，住宅命中流量直接失败，不回退 `direct-out`；面板显示告警。保留现有 `egress-check-in` 校验入站与出口 IP 验证。
3. **住宅禁用 QUIC**：布尔字段 `block_residential_quic`（默认 `true`），只拒绝住宅命中的 QUIC / UDP443，使客户端回落 TCP，提升 SNI 匹配准确度。
4. **规则集缓存与镜像**：开启 `experimental.cache_file`；新增可选 `ruleset_mirror_prefix`（全局设置，校验为 `https://` URL 前缀）；`download_detour` 固定 `direct-out`。
5. **原子应用**：保留 `sing-box check` 预检 + 原子替换 + 启动失败回滚；规则集首次下载失败时把错误回执给面板，不覆盖当前可用配置。

---

## 5. 模块四：实时分流匹配日志页

### 5.1 预览门禁

编码前先生成预览图并等待用户确认：

1. `ServersPage.vue` 节点出口配置面板：3 模式切换、协议栈开关、4 个内置分类 + 自定义直连/住宅名单、禁用 QUIC 开关、「查看分流日志」入口。
2. 「分流日志」页：亮色桌面、暗色桌面、移动端。

预览图保存在运行数据目录下的 `artifacts/kui-workers-pro/routing-optimization-preview/`。

### 5.2 VPS 侧按需采集

- sing-box 开启 `experimental.clash_api`：`external_controller` 只监听 `127.0.0.1:39483`；`secret` 由 Agent 每次生成配置时用 `secrets.token_urlsafe(24)` 生成，不写日志、不上报。
- **数据源**：
  - 主数据源 `GET /connections`（1 秒轮询）：新出现的连接 ID 生成「匹配事件」，取 `metadata.host`、`destinationIP`、`destinationPort`、`network`、`inboundTag`、`rule`、`rulePayload`、`chains`；同时生成活跃连接列表（上下行、时长）。
  - 补充数据源 `/logs?level=debug`：只解析 reject 与 DNS 相关事件（被拒绝的连接不会出现在 `/connections` 中），解析失败则丢弃。
- Agent 把 `rule` / `rulePayload` / `chains` 映射为 `rule_group`（`lan`、`custom_direct`、`custom_proxy`、`ai`、`youtube`、`streaming`、`google`、`final`、`stack_reject`、`quic_reject`）与 `outbound`（`residential` / `direct` / `reject`），映射表由生成配置时同步记录的「规则序号 → 规则组」索引提供。
- **按需启停**：无订阅时不连接 `clash_api`。收到 `route_log.subscribe` 后启动采集；内存环形缓冲 `deque(maxlen=300)`；每 500 ms 合并上报 `route_log.batch`（单批 ≤ 50 条），每 2 秒上报 `route_log.connections`（≤ 100 条）。收到 `route_log.unsubscribe` 或 90 秒无续期时停止。
- 事件结构：

```json
{
  "id": "c9f1…",
  "ts": 1732630001234,
  "inbound": "in-abc123",
  "network": "tcp",
  "host": "chatgpt.com",
  "target_ip": "104.18.32.47",
  "port": 443,
  "ip_version": 4,
  "rule_group": "ai",
  "rule": "rule_set=kui-ai-domain",
  "outbound": "residential",
  "action": "route"
}
```

### 5.3 Realtime DO 与权限

- 只有已鉴权的管理员 Dashboard WebSocket 可以发送 `route_log.subscribe` / `route_log.unsubscribe` / `route_log.ping`（字段：`vps_ip`）；普通用户与公开探针连接的请求一律忽略。
- `DashboardHub` 在内存维护 `Map<vpsIp, Set<ws>>`，只向订阅者转发；订阅者归零或断开时通知 `VpsPresence` 下发 `route_log.unsubscribe`。休眠唤醒后订阅表为空，由前端 ping 重建。
- 旧版 Agent 不认识 `route_log.*` 时，页面显示「该节点 Agent 版本不支持分流日志，请更新」（依据 Agent 上报的能力字段 `capabilities: ["route_log"]`）。
- 日志与连接数据只做内存透传，单条消息按字段截断（host ≤ 253、rule ≤ 128）。

### 5.4 前端页面 `frontend/src/pages/RouteLogPage.vue`

- 导航：原「WARP 隧道」位置替换为「分流日志」（`id: 'route-logs'`，仅管理员可见）；`ServersPage.vue` 出口卡片增加「查看分流日志」跳转并自动选中该 VPS。
- 页面结构：
  1. 控制栏：VPS 选择（显示模式 + 协议栈徽章）、连接状态、暂停/继续、清空、自动滚动。
  2. 统计条：当前窗口匹配总数，住宅 / 直连 / 拒绝的数量与占比，活跃连接数。
  3. 筛选：出口（全部/住宅/直连/拒绝）、规则组、域名/IP 关键字。
  4. 域名命中测试：输入域名或 IP，后端接口 `POST /api/vps/route-test`（管理员）按已应用配置和匹配顺序返回命中规则组、预期出口、IP 栈动作；自定义名单与局域网在后端本地判定，内置规则集由 Agent 侧 `route_log.test` 精确匹配（Agent 不支持时退回「仅自定义/局域网判定」并注明）。
  5. Tab：「实时匹配流」（时间、入站、目标、规则组徽章、出口徽章、「+ 自定义住宅」「+ 自定义直连」快捷操作，写入草稿并确认后应用，自动去重与冲突提示）与「活跃连接」。
- 前端缓冲上限 500 条；页面隐藏或离开时自动退订。

---

## 6. 实施阶段与验收

### 6.1 阶段

| 阶段 | 内容 | 门禁 |
| --- | --- | --- |
| Phase 0 | 接收油管、谷歌规则源；生成 UI 预览图 | 用户确认预览图与规则源 |
| Phase 1 | 创建 `archive/legacy-egress/` 存档 | 确认存档不进入构建/测试 |
| Phase 2 | API + Realtime + 自建入口：3 模式、`ip_stack`、黑白名单、存量映射、`route_log` 透传、`route-test` | Node 单测 |
| Phase 3 | Agent：清理旧模式、协议栈矩阵、规则注册表与匹配顺序、防泄漏、`clash_api` 采集 | Python 单测 + `sing-box check` 样例配置 |
| Phase 4 | 前端：出口面板、`RouteLogPage.vue`、清理 WARP、`npm run build` | 前端单测 |
| Phase 5 | `npm run check`、`git diff --check`；`group/reviewergroup` 只读审查 | 阻塞项清零，清理临时目录 |

### 6.2 分工

- `engineering-backend-architect`（`group/codergroup`）：`functions/api/[[path]].js`、`realtime/src/index.js`、`server/index.js`、`static/vps/agent.py`、`static/vps/kui.sh` 及对应测试。
- `engineering-frontend-developer`（`group/codergroup`）：预览图、`ServersPage.vue`、`RouteLogPage.vue`、导航与状态清理、前端测试、构建。
- `security-appsec-engineer` + `testing-reality-checker`（`group/reviewergroup`）：`clash_api` 本机绑定与密钥隔离、管理员权限边界、Attachment < 2 KiB、Fail-Close、自定义规则注入、存量兼容、固定 DOM ID。

### 6.3 验收用例

1. API 只接受 `native` / `residential`；存量 `warp_*` / `socks5` 读出为 `native` 且带迁移标记；`archive/legacy-egress/` 内容完整。
2. 3 模式 × 3 协议栈共 9 种组合单测全覆盖；「全局住宅 + 仅 IPv6」被拦截；「分流 + 双栈」下直连 IPv6 放行，住宅命中域名的 IPv6 被拒绝，且其 DNS 走 `proxy-dns`（`ipv4_only`）。
3. route 与 DNS 规则顺序断言为 `lan → 自定义直连 → 自定义住宅 → AI → 油管 → 流媒体 → 谷歌 → final`；排除保护、名单冲突、QUIC 开关、Fail-Close 均有单测。
4. `clash_api` 只绑定 `127.0.0.1` 且带随机 secret；无订阅时不连接；退订/超时释放；非管理员无法订阅；Attachment 体积断言 < 2,048 字节。
5. `npm run check` 与 `git diff --check` 全部通过。
