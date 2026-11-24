# 住宅代理与 Docker 接入

## 用户需要配置的 Secrets

在 Worker 的 **Settings → Variables and Secrets** 中设置：

```text
PROXY_USER=使用独立用户名
PROXY_PASS=使用独立强密码
```

缺少任一项时，住宅代理接口不会下发凭据。修改后需要重新部署 Worker。

集成版已内置住宅代理控制器，不需要设置 `PROXY_CTRL_URL`、`PROXY_CTRL_USER`、`PROXY_CTRL_PASS` 或 `PROXY_CTRL_TOKEN`。这些变量仅用于兼容独立的外部控制器。

## 节点选择与切换

住宅 IP 代理页面支持输入两位国家代码，或选择 `ANY` 在所有可用国家中筛选。proxy-lite 结合候选节点信息、入口 TCP 连通性、出口首包延迟和下载吞吐进行优选，并维护主备隧道；面板展示可用的实测指标。

“切换 IP”优先切换到已就绪的备用隧道；“全量重拨”会清退现有隧道并重新选点。切换后新连接使用新的出口，原有连接可能中断。测速结果反映 VPS 到测速目标的当前链路质量，不同目标网站和时间的实际速度可能不同。

## 监听范围

住宅 SOCKS 默认只监听 VPS 本机 `127.0.0.1`，供 KUI Agent 链式出口使用。除非确实需要从公网直连，否则不要开启公网监听。

`PROXY_PUBLIC_LISTENER` 是用户可调的普通变量。如需将新接入 VPS 默认设为公网监听，可设置：

```text
PROXY_PUBLIC_LISTENER=true
```

更推荐保持默认值 `false`，然后在管理员面板的 **公网监听** 页面按 VPS 单独开启。面板设置会覆盖该变量的默认值，并触发对应 VPS 的 proxy-lite 自动刷新监听范围。开启前应先轮换代理凭据，并通过防火墙或云安全组限制来源地址；面板会持续显示公网监听安全告警。

## Docker 容器接入

Docker 容器不需要开启公网监听。在面板的 **住宅 IP 代理** 页面填写该 VPS 的 Docker 网桥地址，通常为 `172.17.0.1`，然后下发策略。

该地址同时用于：

- `proxy-lite`：端口 `7920`
- Agent sing-box 检查入口：端口 `39482`

Compose 服务需要加入宿主机别名：

```yaml
services:
  your-service:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

容器内使用：

```text
socks5h://代理用户名:代理密码@host.docker.internal:7920
```

`39482` 是本机无认证检查入口，不应暴露到公网。清空面板中的 Docker 网桥字段后，服务会恢复为仅监听 `127.0.0.1`。

## 排查建议

1. 确认面板显示 `residential_outbound.ready=true`。
2. 检查 VPS 实时日志中的主备通道和出口 IP。
3. 确认 `proxy-lite` 正常运行，端口与面板配置一致。
4. Docker 场景下确认网桥地址存在，且容器能解析 `host.docker.internal`。
5. 不要为解决容器访问问题直接开启公网监听。
