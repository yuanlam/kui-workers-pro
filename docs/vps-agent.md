# VPS Agent 管理

## 接入 VPS

1. 登录 KUI，进入 **服务器与节点**。
2. 添加 VPS 名称和公网 IP。
3. 复制页面生成的 Full Deploy Command。
4. 以 `root` 在目标 VPS 执行命令。
5. 等待 Agent 回连后创建节点或使用批量部署。

支持 XTLS-Reality、Hysteria2、TUIC、Shadowsocks 2022、Trojan、H2/gRPC-Reality、AnyTLS、Naive、VLESS-Argo、Socks5 和 Dokodemo-door。

## 国内 VPS 下载 sing-box

安装器默认从 GitHub Releases 下载固定版本的 sing-box。国内 VPS 无法访问 GitHub 时，建议将对应的官方压缩包**原样**同步到自己的 HTTPS 对象存储，再在面板复制的部署命令末尾追加：

```bash
--sing-box-url "https://你的对象存储域名/sing-box-1.13.14-linux-amd64-glibc.tar.gz"
```

压缩包必须与 VPS 系统和架构匹配：

| VPS 环境 | 官方压缩包后缀 |
| --- | --- |
| Debian/Ubuntu x86_64 | `linux-amd64-glibc` |
| Debian/Ubuntu aarch64 | `linux-arm64-glibc` |
| Alpine x86_64 | `linux-amd64-musl` |
| Alpine aarch64 | `linux-arm64-musl` |

如果已有自建的 GitHub HTTPS 代理，也可以在部署命令末尾追加：

```bash
--github-proxy "https://你的-github-代理域名"
```

代理地址会作为完整 GitHub Release URL 的前缀。也可分别通过环境变量 `KUI_SING_BOX_URL`、`KUI_GITHUB_PROXY` 传入相同配置。安装器依次尝试自定义完整地址、GitHub 代理、GitHub 官方源；所有下载文件都必须通过项目内固定的 SHA256 校验，校验失败不会安装。若 VPS 已安装准确版本 `1.13.14`，安装器会直接复用。

不要依赖来源不明的公共加速站，也不要重新打包压缩文件，否则 SHA256 校验会失败。

## 节点出口与分流日志

在 **服务器与节点** 的出口面板选择原生直连、全局住宅或直连/住宅分流，再选择协议栈。住宅通道使用 IPv4。全局住宅支持双栈或仅 IPv4，局域网直连，其余流量走住宅。自定义名单仅在分流模式生效。分流模式下，双栈直连可使用 IPv6。

分流规则依次匹配局域网、自定义直连、自定义住宅、AI、油管、流媒体、谷歌，最后使用默认出口。名单支持域名后缀、`full:` 精确域名、`keyword:` 关键词和 CIDR。住宅禁用 QUIC 后，匹配住宅策略的 UDP 443 或 QUIC 连接会被拒绝。

住宅 DNS 使用 IPv4，经住宅 SOCKS5 发送加密查询。每次应用或刷新配置时，Agent 先测试 Cloudflare，再按需测试 Google；主服务恢复后会切回。两者均不可用时，面板会收到配置应用失败的原因。

节点需要从镜像下载规则时，管理员可在 **系统设置 → 分流规则集镜像前缀** 填写 HTTPS 地址。镜像按原域名和路径存放文件，例如配置 `https://mirror.example/base` 后，局域网 IP 规则对应 `https://mirror.example/base/ruleset.skk.moe/sing-box/ip/lan.json`。留空使用原始规则源。节点每 24 小时检查一次规则更新，更换镜像后会在下次刷新时重新下载。新规则校验失败时继续使用上次可用的版本。

管理员可从出口面板打开 **分流日志**，查看该 VPS 的实时匹配和活跃连接，或测试域名与 IP 的预期出口。快捷加名单先写入草稿，确认应用后才会下发给节点。使用实时日志需要支持 `route_log` 的新版 Agent。

旧 WARP 或手动 SOCKS5 节点升级后使用原生直连。Agent 通过升级健康检查后，会在成功刷新时将遗留的三个 WARP 状态文件移至节点的 `/opt/kui/archive/legacy-warp/`，供管理员恢复时使用。

## 卸载与清理

每台 VPS 卡片提供两种清理命令。

### 仅卸载 Agent

- 停止并删除 `kui-agent`。
- 删除 KUI 安装的 `sing-box`、节点配置和证书。
- 保留 `proxy-lite`、OpenVPN 通道和面板记录。

### 卸载全部组件

- 删除 Agent、`sing-box`、`proxy-lite`、OpenVPN 通道和相关配置。
- 本机清理成功后，使用该 VPS 的 Agent Token 删除面板中的 VPS、节点、探针和住宅状态记录。

## 安全与恢复

- 清理前会创建 `/root/kui-agent-backup-时间戳.tar.gz`，权限为 `600`。
- 命令会核对目标 IP 与本机 Agent 记录，在错误 VPS 上执行时会拒绝卸载。
- 全量清理遵循“先清理 VPS、后删除面板记录”。如果 VPS 无法访问 Worker，面板记录会保留；修复网络或 DNS 后可重新执行同一条命令。
