<template>
  <div v-if="isLoggedIn && role === 'admin' && activeTab === 'proxy'" class="pc-body">
                  <div class="pc-shell">
                      <div class="pc-page-intro">
                          <div><h2>双通道住宅出口</h2><p>管理候选地区、主备隧道与出口质量。</p></div>
                      </div>

                      <div class="pc-section-stack">
                          <div class="pc-overview-grid">
                              <article class="pc-overview-card">
                                  <span>当前目标 VPS</span>
                                  <strong id="pc-overview-target">—</strong>
                                  <small id="pc-overview-target-sub">等待节点同步</small>
                              </article>
                              <article class="pc-overview-card">
                                  <span>主备隧道状态</span>
                                  <strong id="pc-overview-channels" class="is-muted">—</strong>
                                  <small id="pc-overview-channels-sub">tun_main / tun_backup</small>
                              </article>
                              <article class="pc-overview-card">
                                  <span>当前业务出口</span>
                                  <strong id="pc-overview-exit" class="pc-font-mono">—</strong>
                                  <small id="pc-overview-exit-sub">等待出口上报</small>
                              </article>
                              <article class="pc-overview-card">
                                  <span>调度策略</span>
                                  <strong id="pc-overview-policy" class="pc-font-mono">JP · :7920</strong>
                                  <small id="pc-overview-policy-sub">本机/网桥默认</small>
                              </article>
                          </div>

                          <div class="pc-panel pc-scheduler-panel">
                              <div class="pc-panel-head">
                                  <div>
                                      <h3 class="pc-panel-title">主备双活调度引擎 <span class="pc-mode-badge">Active-Standby</span></h3>
                                      <p class="pc-panel-subtitle">单路端口锁定，内置主备双路隧道 (tun_main / tun_backup)，主通道异常时自动切换热备。</p>
                                  </div>
                                  <span id="pc-config-dirty-badge" class="pc-dirty-badge" style="display: none;">有未下发更改</span>
                              </div>

                              <div class="pc-scheduler-form">
                                  <label class="pc-field pc-field-target">
                                      <span>目标 VPS</span>
                                      <select id="slot-target-ip" @change="pcInvalidateLoadedConfig(); pcLoadConfig(); pcFetchNodes()"></select>
                                  </label>
                                  <label class="pc-field pc-field-region">
                                      <span>目标地区</span>
                                      <input type="text" id="slot-cfg-0" value="JP" maxlength="3" class="pc-input-center uppercase font-bold" placeholder="US / ANY" title="输入 2 位国家码，或输入 ANY 自动优选全球最快节点" autocomplete="off" />
                                  </label>
                                  <label class="pc-field pc-field-port">
                                      <span>服务端口</span>
                                      <input type="number" id="slot-port" value="7920" min="1024" max="65535" class="pc-input-center font-bold" placeholder="7920" />
                                  </label>
                                  <label class="pc-field pc-field-listen">
                                      <span>监听地址</span>
                                      <input type="text" id="slot-listen-host" value="" maxlength="15" class="pc-font-mono" placeholder="172.17.0.1 / *" title="填写 Docker 网桥 IPv4、*（公网监听）或留空" />
                                  </label>
                              </div>

                              <div class="pc-scheduler-actions">
                                  <button type="button" @click="pcSaveConfig" class="pc-btn pc-btn-primary">
                                      <span>下发策略</span>
                                  </button>
                                  <div class="pc-scheduler-switch-group">
                                      <button type="button" id="pc-hot-switch-btn" @click="pcSwitchIP('hot')" title="秒级热切至已预热备用隧道" class="pc-btn pc-btn-hot">
                                          <span>切换 IP</span>
                                          <span class="pc-btn-tag">HOT</span>
                                      </button>
                                      <button type="button" @click="pcSwitchIP('full')" title="清空现有通道并重新拉取测速" class="pc-btn pc-btn-full">
                                          <span>全量重拨</span>
                                          <span class="pc-btn-tag">FULL</span>
                                      </button>
                                  </div>
                              </div>
                          </div>

                          <div class="pc-panel pc-node-matrix">
                              <div class="pc-panel-head pc-panel-head-bordered">
                                  <div>
                                      <h3 class="pc-panel-title"><span class="pc-live-dot"></span>活跃节点矩阵</h3>
                                      <p class="pc-panel-subtitle">点击任意行切换调度目标，点击出口 IP 可直接复制。</p>
                                  </div>
                              </div>
                              <div class="overflow-x-auto">
                                  <table class="w-full text-left border-collapse">
                                      <thead>
                                          <tr>
                                              <th class="py-3 px-4 font-medium">主机名</th>
                                              <th class="py-3 px-4 font-medium">IP</th>
                                              <th class="py-3 px-4 font-medium w-24">心跳</th>
                                              <th class="py-3 px-4 font-medium w-16">通道</th>
                                              <th class="py-3 px-4 font-medium">主备出口</th>
                                              <th class="py-3 px-4 font-medium w-32">状态</th>
                                          </tr>
                                      </thead>
                                      <tbody id="pc-nodes-table" class="text-sm">
                                          <tr><td colspan="6" class="py-10 text-center text-slate-500">正在同步住宅代理节点状态...</td></tr>
                                      </tbody>
                                  </table>
                              </div>
                              <div id="pc-purity-attribution" style="display: none;" class="pc-attribution">
                                  出口纯净度与风险数据参考 IPPure / <a href="https://ipok.io" target="_blank" rel="noopener noreferrer">IPOK</a>
                              </div>
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
