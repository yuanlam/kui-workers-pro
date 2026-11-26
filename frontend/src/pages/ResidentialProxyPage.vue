<template>
  <div v-if="isLoggedIn && role === 'admin' && activeTab === 'proxy'" class="pc-body">
    <div class="pc-shell">
      <div class="pc-page-intro">
        <div>
          <h2>住宅 IP 代理</h2>
          <p>管理候选地区、主备隧道与出口质量。</p>
        </div>
      </div>

      <div class="pc-section-stack">
        <section id="pc-node-overview-section" class="pc-panel pc-node-overview-panel">
          <div class="pc-panel-head pc-node-overview-head">
            <div>
              <h3 class="pc-panel-title">
                节点总览
                <span id="pc-node-overview-count" class="pc-count-pill">同步中</span>
              </h3>
              <p class="pc-panel-subtitle">点击节点切换下方详情；批量模式会同时操作全部纳管节点。</p>
            </div>
            <button
              type="button"
              id="pc-batch-mode-btn"
              class="pc-btn pc-btn-ghost pc-batch-mode-btn"
              aria-pressed="false"
              @click="pcToggleBatchMode"
            >全部节点批量模式</button>
          </div>
          <div id="pc-node-overview-grid" class="pc-node-overview-grid">
            <div class="pc-node-overview-empty">正在同步节点...</div>
          </div>
        </section>

        <section class="pc-detail-section">
          <div class="pc-section-heading">
            <div class="pc-section-heading-main">
              <h3>节点详情</h3>
              <span id="pc-detail-target-badge" class="pc-target-badge">等待节点同步</span>
            </div>
            <p>管理当前节点的调度策略、主备通道、出口画像与实时负载。</p>
          </div>

          <div id="pc-nodes-table" class="pc-overview-grid">
            <article class="pc-overview-card pc-target-card">
              <div class="pc-card-head">
                <label for="slot-target-ip" class="pc-card-title">目标 VPS</label>
                <span id="pc-config-dirty-badge" class="pc-dirty-badge" style="display: none;">有未下发更改</span>
              </div>
              <div class="pc-card-body">
                <label class="pc-field pc-target-select">
                  <select id="slot-target-ip" @change="pcInvalidateLoadedConfig(); pcLoadConfig(); pcFetchNodes()"></select>
                </label>
                <div class="pc-target-fields">
                  <label class="pc-field">
                    <span>目标地区</span>
                    <input
                      type="text"
                      id="slot-cfg-0"
                      value="JP"
                      maxlength="32"
                      class="pc-input-center uppercase font-bold"
                      placeholder="日本 / JP / ANY"
                      title="输入中文地区名、2 位国家码或 ANY"
                      autocomplete="off"
                    />
                  </label>
                  <label class="pc-field">
                    <span>服务端口</span>
                    <input type="number" id="slot-port" value="7920" min="1024" max="65535" class="pc-input-center font-bold" placeholder="7920" />
                  </label>
                </div>
                <label class="pc-field">
                  <span>监听地址</span>
                  <input type="text" id="slot-listen-host" value="" maxlength="15" class="pc-font-mono" placeholder="172.17.0.1 / *" title="填写 Docker 网桥 IPv4、*（公网监听）或留空" />
                </label>
                <div class="pc-target-actions">
                  <button type="button" @click="pcSaveConfig" class="pc-btn pc-btn-primary">
                    <span>下发策略</span>
                  </button>
                  <button type="button" @click="pcSwitchIP('full')" aria-describedby="pc-full-redial-hint" class="pc-btn pc-btn-full">
                    <span>全量重拨</span>
                  </button>
                </div>
                <span id="pc-full-redial-hint" class="pc-action-warning">清空并重拨全部隧道，连接会中断。</span>
              </div>
            </article>

            <article class="pc-overview-card pc-current-target-card">
              <div class="pc-card-title">当前目标 VPS</div>
              <strong id="pc-overview-target">—</strong>
              <div id="pc-overview-target-sub" class="pc-status-list">
                <span class="pc-status-placeholder">等待节点同步</span>
              </div>
              <div class="pc-card-divider"></div>
              <div class="pc-card-title">调度策略</div>
              <strong id="pc-overview-policy">—</strong>
              <div id="pc-overview-policy-sub" class="pc-status-list">
                <span class="pc-status-placeholder">本机/网桥默认</span>
              </div>
              <div class="pc-channel-summary">
                <span class="pc-card-title">主备通道</span>
                <strong id="pc-overview-channels" class="is-muted">—</strong>
                <div id="pc-overview-channels-sub">等待通道上报</div>
              </div>
              <div class="pc-status-list pc-target-metrics">
                <div class="pc-status-row">
                  <span class="pc-status-label">并发连接</span>
                  <span id="pc-overview-connections" class="pc-status-value">--</span>
                </div>
                <div class="pc-status-row">
                  <span class="pc-status-label">累计流量</span>
                  <span id="pc-overview-traffic" class="pc-status-value">--</span>
                </div>
              </div>
            </article>

            <article class="pc-overview-card pc-exit-card pc-exit-card-active">
              <div class="pc-exit-card-head">
                <span>主出口</span>
                <span id="pc-overview-active-status" class="pc-exit-status" data-tone="neutral" role="status" aria-live="polite">等待上报</span>
              </div>
              <div class="pc-exit-address">
                <strong id="pc-overview-exit" class="pc-font-mono pc-exit-ip">—</strong>
                <button type="button" id="pc-active-copy" class="pc-exit-copy" hidden @click="pcCopyOverviewExit('active')" aria-label="复制主出口 IP">复制</button>
              </div>
              <div id="pc-overview-exit-sub" class="pc-status-list">
                <span class="pc-status-placeholder">质量待上报 · 等待主通道</span>
              </div>
              <details id="pc-active-details" class="pc-channel-details" hidden>
                <summary>通道详情</summary>
                <div id="pc-active-detail-rows" class="pc-status-list"></div>
              </details>
            </article>

            <article class="pc-overview-card pc-exit-card pc-exit-card-standby">
              <div class="pc-exit-card-head">
                <span>备用出口</span>
                <span id="pc-overview-standby-status" class="pc-exit-status" data-tone="neutral" role="status" aria-live="polite">未就绪</span>
              </div>
              <div class="pc-exit-address">
                <strong id="pc-overview-standby" class="pc-font-mono pc-exit-ip">—</strong>
                <button type="button" id="pc-standby-copy" class="pc-exit-copy" hidden @click="pcCopyOverviewExit('standby')" aria-label="复制备用出口 IP">复制</button>
              </div>
              <div id="pc-overview-standby-sub" class="pc-status-list">
                <span class="pc-status-placeholder">质量待上报 · 等待备用通道预热</span>
              </div>
              <details id="pc-standby-details" class="pc-channel-details" hidden>
                <summary>通道详情</summary>
                <div id="pc-standby-detail-rows" class="pc-status-list"></div>
              </details>
              <div class="pc-hot-switch-group">
                <button type="button" id="pc-hot-switch-btn" @click="pcSwitchIP('hot')" title="切换至备用出口" class="pc-btn pc-btn-hot" aria-describedby="pc-hot-switch-hint" disabled>
                  <span>切换至备用</span>
                </button>
                <span id="pc-hot-switch-hint" class="pc-action-warning">备用失效或更改地区时会重新拨号，现有连接可能中断。</span>
              </div>
            </article>
          </div>
        </section>

        <section id="pc-ip-score-section" class="pc-panel pc-score-panel" style="display: none;">
          <div class="pc-panel-head pc-panel-head-bordered pc-profile-head">
            <div>
              <h3 class="pc-panel-title">出口 IP 详情</h3>
              <p class="pc-panel-subtitle">展示当前选中出口的综合纯净度、平台可用参考、归属信息与实测链路质量。</p>
            </div>
            <div class="pc-profile-head-actions">
              <div class="pc-profile-role-switch" role="group" aria-label="切换出口画像">
                <button type="button" id="pc-profile-role-active" class="is-active" aria-pressed="true" @click="pcSetProfileRole('active')">主出口 <span>—</span></button>
                <button type="button" id="pc-profile-role-standby" aria-pressed="false" @click="pcSetProfileRole('standby')">备用出口 <span>—</span></button>
              </div>
              <a id="pc-ip-score-link" href="https://ipok.io" target="_blank" rel="noopener noreferrer" class="pc-link-btn">IPOK 详报 ↗</a>
            </div>
          </div>
          <div id="pc-native-score-container" class="pc-profile-content">
            <div class="pc-profile-loading">正在构建出口 IP 详情...</div>
          </div>
        </section>

        <div class="pc-panel pc-country-panel">
          <div class="pc-panel-head">
            <div>
              <h3 class="pc-panel-title">国家地区与候选节点</h3>
              <p class="pc-panel-subtitle">数量来自 VPN Gate 当前可见候选池，不等于已建立隧道。点击地区芯片填入调度策略，支持中文或 2 位代码搜索。</p>
            </div>
            <div class="pc-country-controls">
              <span id="pc-country-count" class="pc-count-pill">同步中</span>
              <input
                id="pc-country-search"
                v-model="countryQuery"
                type="search"
                class="pc-country-search"
                placeholder="搜索国家/地区（如 日本 / JP）..."
                aria-label="搜索国家/地区"
                @input="pcSetCountryFilter(countryQuery)"
              />
            </div>
          </div>
          <div id="countries-list" class="pc-country-list flex flex-wrap content-start gap-1.5">
            <span class="text-slate-500 text-sm">正在同步候选池...</span>
          </div>
          <div class="pc-country-footer">
            <button type="button" id="pc-country-toggle" class="pc-btn pc-btn-ghost" style="display: none;" @click="pcToggleCountriesExpanded">展开全部地区</button>
          </div>
        </div>

        <div class="pc-panel pc-log-panel">
          <div class="pc-panel-head pc-panel-head-bordered pc-log-head">
            <div>
              <h3 class="pc-panel-title">VPS 实时运行日志</h3>
              <p class="pc-panel-subtitle">按当前选中目标自动同步，支持按级别过滤与一键复制。</p>
            </div>
            <div class="pc-log-toolbar">
              <div class="pc-log-filters" role="group" aria-label="日志级别筛选">
                <button type="button" :class="{ 'is-active': logFilter === 'all' }" @click="setLogFilter('all')">全部</button>
                <button type="button" :class="{ 'is-active': logFilter === 'warn' }" @click="setLogFilter('warn')">警告/错误</button>
                <button type="button" :class="{ 'is-active': logFilter === 'error' }" @click="setLogFilter('error')">仅错误</button>
              </div>
              <button type="button" class="pc-btn pc-btn-ghost" :class="{ 'is-active': logPaused }" @click="toggleLogPause">{{ logPaused ? '继续滚动' : '暂停滚动' }}</button>
              <button type="button" class="pc-btn pc-btn-ghost" @click="pcCopyLogs">复制日志</button>
            </div>
          </div>
          <div class="pc-terminal-output pc-font-mono" id="pc-terminal-output">
            <div class="text-slate-500">等待 VPS 心跳回传日志数据...</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { inject, ref } from 'vue';
import { KUI_KEY } from '../app/context.js';
import {
  pcCopyLogs,
  pcCopyOverviewExit,
  pcFetchNodes,
  pcInvalidateLoadedConfig,
  pcLoadConfig,
  pcSaveConfig,
  pcSetCountryFilter,
  pcSetLogFilter,
  pcSetProfileRole,
  pcSwitchIP,
  pcToggleBatchMode,
  pcToggleCountriesExpanded,
  pcToggleLogPause,
} from '../proxy/legacyProxy.js';

export default {
  setup() {
    const countryQuery = ref('');
    const logFilter = ref('all');
    const logPaused = ref(false);

    const setLogFilter = (mode) => {
      logFilter.value = mode;
      pcSetLogFilter(mode);
    };
    const toggleLogPause = () => {
      logPaused.value = pcToggleLogPause();
    };

    return {
      ...inject(KUI_KEY),
      countryQuery,
      logFilter,
      logPaused,
      setLogFilter,
      toggleLogPause,
      pcCopyLogs,
      pcCopyOverviewExit,
      pcFetchNodes,
      pcInvalidateLoadedConfig,
      pcLoadConfig,
      pcSaveConfig,
      pcSetCountryFilter,
      pcSetProfileRole,
      pcSwitchIP,
      pcToggleBatchMode,
      pcToggleCountriesExpanded,
    };
  },
};
</script>
