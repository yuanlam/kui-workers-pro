<template>
  <section v-if="isLoggedIn && role === 'admin' && activeTab === 'warp'" class="warp-page">
    <header class="warp-page-intro">
      <div><h2>WARP 隧道优化</h2><p>检测 Cloudflare WireGuard 入口质量，确认后再应用到节点出口。</p></div>
      <label class="warp-server-picker"><span>目标 VPS</span><select v-model="warpTargetIp"><option v-for="server in servers" :key="server.ip" :value="server.ip">{{ server.name || server.ip }} · {{ server.ip }}</option></select></label>
    </header>

    <div v-if="!selectedServer" class="warp-empty kui-panel"><strong>暂无可管理的 VPS</strong><p>请先在“服务器与节点”页面接入服务器。</p><button class="kui-button kui-button-primary" @click="activeTab = 'nodes'">前往接入</button></div>
    <template v-else>
      <div class="warp-stat-grid">
        <article class="warp-stat-card"><span>WARP 状态</span><strong :class="warp.configured ? 'is-good' : 'is-muted'">{{ warp.configured ? modeLabel(warp.active_mode) : '未配置' }}</strong><small>{{ selectedServer.realtime_state === 'online' ? 'Agent 在线' : 'Agent 未在线' }}</small></article>
        <article class="warp-stat-card"><span>当前 Endpoint</span><strong class="warp-mono">{{ endpointText(warp.peer_address, warp.peer_port) }}</strong><small>{{ warp.peer_family || '等待 Agent 上报' }}</small></article>
        <article class="warp-stat-card"><span>Cloudflare 节点</span><strong>{{ currentCandidate?.colo || recommended?.colo || '—' }}</strong><small>来自真实 WARP Trace</small></article>
        <article class="warp-stat-card"><span>隧道质量</span><strong>{{ currentCandidate?.latency_ms ? `${currentCandidate.latency_ms} ms` : '—' }}</strong><small>{{ currentCandidate?.success ? `失败率 ${currentCandidate.loss_pct}%` : '尚未检测' }}</small></article>
      </div>

      <div v-if="!warp.configured" class="warp-empty kui-panel">
        <strong>该 VPS 尚未生成 WARP 身份</strong><p>请先在“服务器与节点”选择 WARP 出口并点击应用，身份准备完成后再进行 Endpoint 优选。</p>
        <button class="kui-button kui-button-primary" @click="activeTab = 'nodes'">前往启用 WARP</button>
      </div>

      <div v-else class="warp-section-stack">
        <article class="warp-panel">
          <div class="warp-panel-heading"><div><h3>当前隧道</h3><p>只展示运行信息，WARP 私钥不会离开 VPS。</p></div><span class="warp-status-badge" :class="`is-${optimizer.status}`">{{ statusLabel(optimizer.status) }}</span></div>
          <div class="warp-detail-grid">
            <div><span>主机</span><strong>{{ selectedServer.name || selectedServer.ip }}</strong><small>{{ selectedServer.ip }}</small></div>
            <div><span>WireGuard Endpoint</span><strong class="warp-mono">{{ endpointText(warp.peer_address, warp.peer_port) }}</strong><small>{{ warp.peer_family || '—' }}</small></div>
            <div><span>隧道 IPv4</span><strong class="warp-mono">{{ warp.tunnel_ipv4 || '—' }}</strong><small>Cloudflare 虚拟地址</small></div>
            <div><span>隧道 IPv6</span><strong class="warp-mono">{{ warp.tunnel_ipv6 || '—' }}</strong><small>Cloudflare 虚拟地址</small></div>
            <div><span>实际业务出口</span><strong class="warp-mono">{{ selectedServer.egress_ip || '—' }}</strong><small>{{ modeLabel(warp.active_mode) }}</small></div>
            <div><span>最近检测</span><strong>{{ optimizer.last_scan_at ? formatDate(optimizer.last_scan_at) : '尚未检测' }}</strong><small>{{ optimizer.stage || '等待操作' }}</small></div>
          </div>
        </article>

        <article class="warp-panel warp-control-panel">
          <div class="warp-panel-heading"><div><h3>Endpoint 优选</h3><p>使用独立测速身份，不干扰当前 WARP 会话；手动检测后必须点击应用。</p></div></div>
          <div class="warp-control-row">
            <label><span>恢复策略</span><select :value="optimizer.policy" :disabled="warpActionPending" @change="updateWarpPolicy($event.target.value)"><option value="manual">手动优化</option><option value="on_failure">连续失败时自动优化</option><option value="first_enable">首次启用后检测一次</option></select></label>
            <div class="warp-actions">
              <button class="kui-button kui-button-primary" :disabled="busy" @click="startWarpOptimization"><span>⌁</span>开始检测</button>
              <button class="kui-button kui-button-success" :disabled="busy || !recommended?.refined" @click="applyWarpCandidate">{{ warpSelectedCandidate ? '应用所选端点' : '应用推荐端点' }}</button>
              <button class="kui-button kui-button-ghost" :disabled="warpActionPending || (!busy && !recommended)" @click="cancelWarpOptimization">取消</button>
              <button class="kui-button kui-button-ghost" :disabled="busy || !optimizer.previous" @click="restoreWarpEndpoint">恢复上一个端点</button>
            </div>
          </div>
          <div v-if="optimizer.status !== 'idle'" class="warp-progress-wrap">
            <div><span>{{ optimizer.stage || statusLabel(optimizer.status) }}</span><strong>{{ optimizer.progress || 0 }}%</strong></div>
            <div class="warp-progress"><i :style="{ width: `${optimizer.progress || 0}%` }"></i></div>
            <p v-if="optimizer.error" class="warp-error">{{ optimizer.error }}</p>
          </div>
        </article>

        <article class="warp-panel warp-candidate-panel">
          <div class="warp-panel-heading"><div><h3>候选端点矩阵</h3><p>先比较失败率，再比较请求中位延迟；首轮结果仅用于筛选，复测通过后才允许应用。</p></div><span>{{ candidates.length }} 个候选</span></div>
          <div class="warp-table-wrap">
            <table><thead><tr><th>选择</th><th>Endpoint</th><th>地址族</th><th>Colo</th><th>延迟</th><th>失败率</th><th>出口</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-if="!candidates.length"><td colspan="8" class="warp-table-empty">点击“开始检测”生成候选结果</td></tr>
                <tr v-for="candidate in candidates" :key="`${candidate.address}:${candidate.port}`" :class="{ 'is-recommended': sameCandidate(candidate, recommended), 'is-current': candidate.current }" @click="candidate.success && candidate.refined && (warpSelectedCandidate = `${candidate.address}:${candidate.port}`)">
                  <td><input type="radio" name="warp-candidate" :disabled="!candidate.success || !candidate.refined || busy" :value="`${candidate.address}:${candidate.port}`" v-model="warpSelectedCandidate" :aria-label="`选择 ${candidate.address}:${candidate.port}`"></td>
                  <td class="warp-mono">{{ endpointText(candidate.address, candidate.port) }}</td><td>{{ candidate.family || '—' }}</td><td>{{ candidate.colo || '—' }}</td><td>{{ candidate.latency_ms ? `${candidate.latency_ms} ms` : '—' }}</td><td>{{ candidate.loss_pct }}%</td><td class="warp-mono">{{ candidate.exit_ipv4 || candidate.exit_ipv6 || '—' }}</td>
                  <td><span class="warp-result-badge" :class="candidate.success && candidate.refined ? 'is-success' : candidate.success ? '' : 'is-failed'">{{ sameCandidate(candidate, recommended) ? '推荐' : candidate.current ? '当前' : candidate.success ? (candidate.refined ? '可用' : '初测') : '失败' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article class="warp-panel">
          <div class="warp-panel-heading"><div><h3>优化历史</h3><p>保留最近 12 次成功切换记录。</p></div></div>
          <div class="warp-history-list"><p v-if="!optimizer.history?.length" class="warp-table-empty">暂无端点切换记录</p><div v-for="item in optimizer.history" :key="`${item.at}-${item.to_address}-${item.to_port}`"><span>{{ formatDate(item.at) }}</span><strong class="warp-mono">{{ endpointText(item.from_address, item.from_port) }} → {{ endpointText(item.to_address, item.to_port) }}</strong><small>{{ item.reason === 'restore' ? '手动恢复' : item.reason === 'failure' ? '故障恢复' : '手动应用' }}</small></div></div>
        </article>
      </div>
    </template>
  </section>
</template>

<script>
import { computed, inject } from 'vue';
import { KUI_KEY } from '../app/context.js';

export default {
  setup() {
    const state = inject(KUI_KEY);
    const selectedServer = computed(() => state.servers.value.find(server => server.ip === state.warpTargetIp.value) || state.servers.value[0] || null);
    const warp = computed(() => selectedServer.value?.warp || { configured: false, active_mode: 'native', optimizer: {} });
    const optimizer = computed(() => warp.value.optimizer || {});
    const candidates = computed(() => optimizer.value.candidates || []);
    const recommended = computed(() => optimizer.value.recommended || null);
    const currentCandidate = computed(() => candidates.value.find(candidate => candidate.current) || null);
    const busy = computed(() => state.warpActionPending.value || ['scanning', 'applying'].includes(optimizer.value.status));
    const endpointText = (address, port) => address ? `${address.includes(':') ? `[${address}]` : address}:${port || '—'}` : '—';
    const sameCandidate = (left, right) => !!left && !!right && left.address === right.address && Number(left.port) === Number(right.port);
    const modeLabel = mode => ({ native: '当前未启用', warp_ipv4: 'WARP IPv4', warp_ipv6: 'WARP IPv6', warp_dual: 'WARP 双栈' }[mode] || mode || '未知');
    const statusLabel = status => ({ idle: '待检测', scanning: '检测中', ready: '等待应用', applying: '应用中', success: '已应用', failed: '失败' }[status] || '待检测');
    return { ...state, busy, candidates, currentCandidate, endpointText, modeLabel, optimizer, recommended, sameCandidate, selectedServer, statusLabel, warp };
  },
};
</script>
