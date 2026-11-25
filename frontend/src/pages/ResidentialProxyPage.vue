<template>
  <div v-if="isLoggedIn && role === 'admin' && activeTab === 'proxy'" class="pc-body">
                  <div class="pc-shell">
                      <div class="pc-page-intro">
                          <div><h2>双通道住宅出口</h2><p>管理候选地区、主备隧道与出口质量。</p></div>
                      </div>

                      <div class="pc-section-stack">
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
                                              <input type="text" id="slot-cfg-0" value="JP" maxlength="3" class="pc-input-center uppercase font-bold" placeholder="US / ANY" title="输入 2 位国家码，或输入 ANY 自动优选全球最快节点" autocomplete="off" />
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
                          <div id="pc-purity-attribution" style="display: none;" class="pc-attribution">
                              出口纯净度与风险数据参考 IPPure / <a href="https://ipok.io" target="_blank" rel="noopener noreferrer">IPOK</a>
                          </div>

                          <div class="pc-panel pc-country-panel">
                              <div class="pc-panel-head">
                                  <div>
                                      <h3 class="pc-panel-title">国家代码与候选节点</h3>
                                      <p class="pc-panel-subtitle">数量来自 VPN Gate 当前可见候选池，不等于已建立隧道。点击地区代码填入调度策略。</p>
                                  </div>
                                  <div class="pc-country-controls">
                                      <span id="pc-country-count" class="pc-count-pill">同步中</span>
                                      <input v-model="countryQuery" type="search" class="pc-country-search" placeholder="搜索国家代码 (如 JP / US)..." aria-label="搜索候选国家代码" @input="pcSetCountryFilter(countryQuery)">
                                  </div>
                              </div>
                              <div id="countries-list" class="pc-country-list flex flex-wrap content-start gap-1.5">
                                  <span class="text-slate-500 text-sm">正在同步候选池...</span>
                              </div>
                              <div class="pc-country-footer">
                                  <button type="button" id="pc-country-toggle" class="pc-btn pc-btn-ghost" style="display: none;" @click="pcToggleCountriesExpanded">展开全部地区</button>
                              </div>
                          </div>

                          <div class="pc-diag-bar">
                              <span class="pc-diag-label">诊断与观测</span>
                              <div class="pc-diag-tabs" role="tablist">
                                  <button type="button" role="tab" :aria-selected="diagView === 'all'" :class="{ 'is-active': diagView === 'all' }" @click="diagView = 'all'">全部视图</button>
                                  <button type="button" role="tab" :aria-selected="diagView === 'score'" :class="{ 'is-active': diagView === 'score' }" @click="diagView = 'score'">深度质检</button>
                                  <button type="button" role="tab" :aria-selected="diagView === 'logs'" :class="{ 'is-active': diagView === 'logs' }" @click="diagView = 'logs'">实时日志</button>
                              </div>
                          </div>

                          <div v-show="diagView !== 'logs'">
                              <div id="pc-ip-score-section" style="display: none;" class="pc-panel pc-score-panel">
                                  <div class="pc-panel-head pc-panel-head-bordered">
                                      <div>
                                          <h3 class="pc-panel-title">原生深度质检报告 (testisp.info)</h3>
                                          <p class="pc-panel-subtitle">针对当前选中 VPS 活跃住宅出口的原生质检与风险画像。</p>
                                      </div>
                                      <a id="pc-ip-score-link" href="#" class="pc-link-btn">原版页面 ↗</a>
                                  </div>
                                  <div id="pc-native-score-container" class="pc-score-grid p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                      <div class="col-span-full py-12 flex flex-col items-center justify-center text-slate-500">
                                          <span>正在构建原生质检报告...</span>
                                      </div>
                                  </div>
                              </div>
                          </div>

                          <div v-show="diagView !== 'score'" class="pc-panel pc-log-panel">
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
  pcSwitchIP,
  pcToggleCountriesExpanded,
  pcToggleLogPause,
} from '../proxy/legacyProxy.js';

export default {
  setup() {
    const diagView = ref('all');
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
      diagView,
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
      pcSwitchIP,
      pcToggleCountriesExpanded,
    };
  },
};
</script>
