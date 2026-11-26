<template>
  <div v-if="role === 'admin' && activeTab === 'route-logs'" class="kui-route-log-page">
      <section class="kui-route-log-toolbar">
          <div class="kui-route-log-toolbar-main">
              <select id="kui-route-log-vps" v-model="selectedVpsIp" class="kui-egress-control" aria-label="选择要查看分流日志的 VPS">
                  <option v-for="vps in servers" :key="vps.ip" :value="vps.ip">{{ vps.name || vps.ip }}（{{ vps.ip }}）</option>
              </select>
              <template v-if="currentVps">
                  <span class="kui-meta-pill is-egress" data-kui-route-log-applied-mode>{{ egressPresetLabel(appliedPreset) }}</span>
                  <span class="kui-meta-pill" data-kui-route-log-applied-stack>{{ ipStackLabel(appliedStack) }}</span>
              </template>
              <span class="kui-route-log-status" :class="'is-' + (routeLogStatus || 'idle')">
                  <i aria-hidden="true"></i>{{ statusText }}
              </span>
          </div>
          <div class="kui-route-log-toolbar-actions">
              <button type="button" class="kui-button kui-button-ghost" @click="togglePaused">{{ routeLogPaused ? '▶ 继续' : '❚❚ 暂停' }}</button>
              <button type="button" class="kui-button kui-button-ghost" @click="clearRouteLogs">清空</button>
              <button type="button" class="kui-button kui-button-ghost" :class="{ 'is-active': autoScroll }" @click="autoScroll = !autoScroll">↓ 自动滚动：{{ autoScroll ? '开' : '关' }}</button>
          </div>
      </section>

      <section v-if="routeLogStatus === 'unsupported'" class="kui-alert kui-alert-danger kui-route-log-alert">
          <div>⚠ 该节点 Agent 版本不支持分流日志，请更新 Agent 后重试。</div>
          <div v-if="routeLogStatusMessage">{{ routeLogStatusMessage }}</div>
      </section>

      <section class="kui-route-log-stats">
          <article class="kui-stat-card">
              <span>当前窗口匹配</span>
              <strong>{{ summary.total }}</strong>
              <small>环形缓冲上限 500 条</small>
          </article>
          <article class="kui-stat-card">
              <span>住宅出口</span>
              <strong class="is-residential">{{ summary.residential }}</strong>
              <small>占比 {{ summary.percent('residential') }}%</small>
          </article>
          <article class="kui-stat-card">
              <span>原生直连</span>
              <strong class="is-direct">{{ summary.direct }}</strong>
              <small>占比 {{ summary.percent('direct') }}%</small>
          </article>
          <article class="kui-stat-card">
              <span>规则拒绝</span>
              <strong class="is-reject">{{ summary.reject }}</strong>
              <small>{{ rejectBreakdown }}</small>
          </article>
          <article class="kui-stat-card">
              <span>活跃连接</span>
              <strong>{{ activeConnections.length }}</strong>
              <small>{{ activeTrafficText }}</small>
          </article>
      </section>

      <section class="kui-route-log-test">
          <div class="kui-route-log-test-row">
              <label for="kui-route-test-target">域名 / IP 命中测试</label>
              <input id="kui-route-test-target" v-model.trim="routeTestTarget" type="text" placeholder="chatgpt.com" @keyup.enter="runRouteTest">
              <button type="button" class="kui-button kui-button-primary" :disabled="routeTestPending" @click="runRouteTest">{{ routeTestPending ? '测试中…' : '测试命中' }}</button>
          </div>
          <div v-if="routeTestError" class="kui-route-log-test-result is-error">{{ routeTestError }}</div>
          <div v-else-if="routeTestResult" class="kui-route-log-test-result">
              <span class="kui-route-log-badge" :class="'is-group-' + routeTestResult.rule_group">命中: {{ ruleGroupLabel(routeTestResult.rule_group) }}</span>
              <span class="kui-route-log-badge" :class="'is-' + routeTestResult.outbound">预期出口: {{ outboundLabel(routeTestResult.outbound) }}</span>
              <code v-if="routeTestResult.rule" class="kui-route-log-test-rule">{{ routeTestResult.rule }}</code>
              <span class="kui-route-log-test-scope">{{ routeScopeLabel(routeTestResult.scope) }}</span>
              <div v-if="routeTestResult.reason" class="kui-route-log-test-note">{{ routeTestResult.reason }}</div>
              <div v-for="(note, index) in routeTestResult.notes" :key="index" class="kui-route-log-test-note">{{ note }}</div>
          </div>
      </section>

      <section class="kui-route-log-panel">
          <div class="kui-route-log-filters">
              <div class="kui-route-log-counter">
                  <button type="button" :class="{ 'is-active': filter.outbound === 'all' }" @click="setOutboundFilter('all')">全部 {{ summary.total }}</button>
                  <button type="button" :class="{ 'is-active': filter.outbound === 'residential' }" @click="setOutboundFilter('residential')">住宅 {{ summary.residential }}</button>
                  <button type="button" :class="{ 'is-active': filter.outbound === 'direct' }" @click="setOutboundFilter('direct')">直连 {{ summary.direct }}</button>
                  <button type="button" :class="{ 'is-active': filter.outbound === 'reject' }" @click="setOutboundFilter('reject')">拒绝 {{ summary.reject }}</button>
              </div>
              <div class="kui-route-log-filter-controls">
                  <select v-model="filter.ruleGroup" class="kui-egress-control" aria-label="按规则组筛选">
                      <option value="all">全部规则组</option>
                      <option v-for="(label, key) in ruleGroupLabels" :key="key" :value="key">{{ label }}</option>
                  </select>
                  <input v-model.trim="filter.query" type="search" class="kui-egress-control" placeholder="筛选域名 / IP / 入站..." aria-label="按域名或 IP 筛选">
              </div>
          </div>

          <div class="kui-route-log-tabs" role="tablist">
              <button type="button" role="tab" :aria-selected="activeTabName === 'events'" :class="{ 'is-active': activeTabName === 'events' }" @click="activeTabName = 'events'">实时匹配流（{{ filteredEvents.length }}）</button>
              <button type="button" role="tab" :aria-selected="activeTabName === 'connections'" :class="{ 'is-active': activeTabName === 'connections' }" @click="activeTabName = 'connections'">活跃连接（{{ activeConnections.length }}）</button>
              <span class="kui-route-log-tabs-hint">页面离开自动退订</span>
          </div>

          <div v-if="hasDraft" class="kui-route-log-draft">
              <span>待应用分流草稿：{{ draftNotice || '当前节点存在未下发的分流修改' }}</span>
              <span v-if="currentVps && egressPresetOf(currentVps) !== 'selective'">名单仅在分流模式生效；当前草稿模式为{{ egressPresetLabel(egressPresetOf(currentVps)) }}，请切换分流后使用名单。</span>
              <div class="kui-route-log-draft-actions">
                  <button type="button" class="kui-button kui-button-ghost" :disabled="!currentVps" @click="discardDraft">撤销</button>
                  <button type="button" class="kui-button kui-button-primary" :disabled="!currentVps || applyingDraft" @click="applyDraft">{{ applyingDraft ? '应用中…' : '应用到节点' }}</button>
              </div>
          </div>
          <div v-if="draftError" class="kui-route-log-draft-error">{{ draftError }}</div>

          <div v-show="activeTabName === 'events'" ref="eventScroller" class="kui-route-log-table-wrap">
              <table class="kui-route-log-table">
                  <thead>
                      <tr>
                          <th>时间</th>
                          <th>入站 / 协议</th>
                          <th>目标域名 / IP</th>
                          <th>规则组 &amp; 命中规则</th>
                          <th>出口</th>
                          <th>快捷操作</th>
                      </tr>
                  </thead>
                  <tbody>
                      <tr v-if="filteredEvents.length === 0">
                          <td colspan="6" class="kui-route-log-empty">{{ emptyEventText }}</td>
                      </tr>
                      <tr v-for="event in filteredEvents" :key="event.id">
                          <td class="kui-route-log-time">{{ formatRouteClock(event.ts) }}</td>
                          <td>
                              <strong class="kui-route-log-inbound">{{ event.inbound || '--' }}</strong>
                              <small class="kui-route-log-sub">{{ (event.network || '--').toUpperCase() }}</small>
                          </td>
                          <td>
                              <strong class="kui-route-log-target">{{ targetOf(event).primary }}</strong>
                              <small v-if="targetOf(event).secondary" class="kui-route-log-sub">{{ targetOf(event).secondary }} · {{ ipVersionText(event) }}</small>
                          </td>
                          <td>
                              <span class="kui-route-log-badge" :class="'is-group-' + event.rule_group">{{ ruleGroupLabel(event.rule_group) }}</span>
                              <small v-if="event.rule" class="kui-route-log-sub">{{ event.rule }}</small>
                          </td>
                          <td><span class="kui-route-log-badge" :class="'is-' + event.outbound">{{ outboundLabel(event.outbound) }}</span></td>
                          <td>
                              <span v-if="inResidentialList(event)" class="kui-route-log-badge is-listed">已在住宅名单</span>
                              <button v-else-if="event.outbound === 'residential'" type="button" class="kui-route-log-quick is-direct" @click="addToList(event, 'direct')">+ 自定义直连</button>
                              <button v-else type="button" class="kui-route-log-quick is-residential" @click="addToList(event, 'custom')">+ 自定义住宅</button>
                          </td>
                      </tr>
                  </tbody>
              </table>
              <div class="kui-route-log-mobile-list">
                  <article v-for="event in filteredEvents" :key="'m-' + event.id" class="kui-route-log-mobile-card">
                      <div class="kui-route-log-mobile-head">
                          <strong class="kui-route-log-target">{{ targetOf(event).primary }}</strong>
                          <span class="kui-route-log-badge" :class="'is-' + event.outbound">{{ outboundLabel(event.outbound) }}</span>
                      </div>
                      <div class="kui-route-log-mobile-meta">
                          <span class="kui-route-log-badge" :class="'is-group-' + event.rule_group">{{ ruleGroupLabel(event.rule_group) }}</span>
                          <small v-if="event.rule" class="kui-route-log-sub">{{ event.rule }}</small>
                      </div>
                      <div class="kui-route-log-mobile-foot">
                          <span class="kui-route-log-sub">{{ formatRouteClock(event.ts) }} · {{ event.inbound || '--' }} · {{ (event.network || '--').toUpperCase() }}</span>
                          <span v-if="inResidentialList(event)" class="kui-route-log-badge is-listed">已在住宅名单</span>
                          <button v-else-if="event.outbound === 'residential'" type="button" class="kui-route-log-quick is-direct" @click="addToList(event, 'direct')">+ 自定义直连</button>
                          <button v-else type="button" class="kui-route-log-quick is-residential" @click="addToList(event, 'custom')">+ 自定义住宅</button>
                      </div>
                  </article>
                  <div v-if="filteredEvents.length === 0" class="kui-route-log-empty">{{ emptyEventText }}</div>
              </div>
          </div>

          <div v-show="activeTabName === 'connections'" class="kui-route-log-table-wrap">
              <table class="kui-route-log-table">
                  <thead>
                      <tr>
                          <th>目标地址</th>
                          <th>入站</th>
                          <th>命中规则组</th>
                          <th>出口</th>
                          <th>上行 / 下行</th>
                          <th>持续时长</th>
                      </tr>
                  </thead>
                  <tbody>
                      <tr v-if="activeConnections.length === 0">
                          <td colspan="6" class="kui-route-log-empty">暂无活跃连接</td>
                      </tr>
                      <tr v-for="connection in activeConnections" :key="connection.id || connection.host">
                          <td><strong class="kui-route-log-target">{{ connection.host || connection.target_ip || '--' }}</strong></td>
                          <td><strong class="kui-route-log-inbound">{{ connection.inbound || '--' }}</strong><small class="kui-route-log-sub">{{ (connection.network || '--').toUpperCase() }}</small></td>
                          <td><span class="kui-route-log-badge" :class="'is-group-' + connection.rule_group">{{ ruleGroupLabel(connection.rule_group) }}</span></td>
                          <td><span class="kui-route-log-badge" :class="'is-' + connection.outbound">{{ outboundLabel(connection.outbound) }}</span></td>
                          <td class="kui-route-log-traffic">↑ {{ formatRouteTraffic(connection.upload) }} / ↓ {{ formatRouteTraffic(connection.download) }}</td>
                          <td>{{ formatRouteDuration(connection.duration_ms) }}</td>
                      </tr>
                  </tbody>
              </table>
              <div class="kui-route-log-mobile-list">
                  <article v-for="connection in activeConnections" :key="'mc-' + (connection.id || connection.host)" class="kui-route-log-mobile-card">
                      <div class="kui-route-log-mobile-head">
                          <strong class="kui-route-log-target">{{ connection.host || connection.target_ip || '--' }}</strong>
                          <span class="kui-route-log-badge" :class="'is-' + connection.outbound">{{ outboundLabel(connection.outbound) }}</span>
                      </div>
                      <div class="kui-route-log-mobile-meta">
                          <span class="kui-route-log-badge" :class="'is-group-' + connection.rule_group">{{ ruleGroupLabel(connection.rule_group) }}</span>
                          <small class="kui-route-log-sub">{{ connection.inbound || '--' }} · {{ (connection.network || '--').toUpperCase() }} · {{ formatRouteDuration(connection.duration_ms) }}</small>
                      </div>
                      <div class="kui-route-log-mobile-foot">
                          <span class="kui-route-log-sub">↑ {{ formatRouteTraffic(connection.upload) }} / ↓ {{ formatRouteTraffic(connection.download) }}</span>
                      </div>
                  </article>
                  <div v-if="activeConnections.length === 0" class="kui-route-log-empty">暂无活跃连接</div>
              </div>
          </div>
      </section>

      <section v-if="activeTabName === 'events'" class="kui-route-log-connections-preview">
          <header class="kui-route-log-preview-head">
              <h3>活跃连接</h3>
              <span class="kui-meta-pill is-egress">当前 {{ activeConnections.length }} 条</span>
          </header>
          <div class="kui-route-log-table-wrap">
              <table class="kui-route-log-table">
                  <thead>
                      <tr>
                          <th>目标地址</th>
                          <th>入站</th>
                          <th>命中规则组</th>
                          <th>出口</th>
                          <th>上行 / 下行</th>
                          <th>持续时长</th>
                      </tr>
                  </thead>
                  <tbody>
                      <tr v-if="activeConnections.length === 0">
                          <td colspan="6" class="kui-route-log-empty">暂无活跃连接</td>
                      </tr>
                      <tr v-for="connection in activeConnections.slice(0, 8)" :key="'p-' + (connection.id || connection.host)">
                          <td><strong class="kui-route-log-target">{{ connection.host || connection.target_ip || '--' }}</strong></td>
                          <td><strong class="kui-route-log-inbound">{{ connection.inbound || '--' }}</strong><small class="kui-route-log-sub">{{ (connection.network || '--').toUpperCase() }}</small></td>
                          <td><span class="kui-route-log-badge" :class="'is-group-' + connection.rule_group">{{ ruleGroupLabel(connection.rule_group) }}</span></td>
                          <td><span class="kui-route-log-badge" :class="'is-' + connection.outbound">{{ outboundLabel(connection.outbound) }}</span></td>
                          <td class="kui-route-log-traffic">↑ {{ formatRouteTraffic(connection.upload) }} / ↓ {{ formatRouteTraffic(connection.download) }}</td>
                          <td>{{ formatRouteDuration(connection.duration_ms) }}</td>
                      </tr>
                  </tbody>
              </table>
          </div>
      </section>
  </div>
</template>

<script>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { KUI_KEY } from '../app/context.js';
import {
    ROUTE_RULE_GROUP_LABELS,
    filterRouteEvents,
    formatRouteClock,
    formatRouteDuration,
    formatRouteTraffic,
    ipStackLabel,
    outboundLabel,
    routeScopeLabel,
    ruleGroupLabel,
    suggestCustomRule,
    summarizeRouteEvents,
    appliedEgressConfigOf,
    appliedEgressPresetOf,
} from '../utils/routeLog.js';

export default {
  setup() {
    const state = inject(KUI_KEY);
    const filter = ref({ outbound: 'all', ruleGroup: 'all', query: '' });
    const activeTabName = ref('events');
    const autoScroll = ref(true);
    const applyingDraft = ref(false);
    const draftError = ref('');
    const eventScroller = ref(null);

    const selectedVpsIp = computed({
        get: () => state.routeLogTargetIp.value || (state.servers.value?.[0]?.ip || ''),
        set: (value) => { state.routeLogTargetIp.value = value || ''; },
    });
    const currentVps = computed(() => (state.servers.value || []).find(vps => vps.ip === selectedVpsIp.value) || null);
    const appliedConfig = computed(() => appliedEgressConfigOf(currentVps.value));
    const appliedPreset = computed(() => appliedEgressPresetOf(currentVps.value));
    const appliedStack = computed(() => appliedConfig.value.ip_stack);
    const summary = computed(() => summarizeRouteEvents(state.routeLogEvents.value || []));
    const filteredEvents = computed(() => filterRouteEvents(state.routeLogEvents.value || [], filter.value));
    const activeConnections = computed(() => state.routeLogConnections.value || []);
    const draftNotice = computed(() => state.routeLogDraftNotice.value || '');
    const hasDraft = computed(() => Boolean(currentVps.value) && state.egressHasDraft(currentVps.value));
    const ruleGroupLabels = ROUTE_RULE_GROUP_LABELS;

    const statusText = computed(() => {
        const status = state.routeLogStatus.value || 'idle';
        const map = {
            idle: '未订阅',
            connecting: '正在连接实时分流日志…',
            subscribed: '实时订阅中',
            unsupported: '该节点 Agent 版本不支持分流日志，请更新',
            offline: '节点离线',
            error: '订阅失败',
            disconnected: '实时连接已断开，正在重连…',
        };
        return state.routeLogStatusMessage.value || map[status] || status;
    });

    const rejectBreakdown = computed(() => {
        const events = state.routeLogEvents.value || [];
        let quic = 0;
        let stack = 0;
        for (const event of events) {
            if (event.outbound !== 'reject' && event.action !== 'reject') continue;
            if (event.rule_group === 'quic_reject') quic += 1;
            else if (event.rule_group === 'stack_reject') stack += 1;
        }
        const parts = [];
        if (quic) parts.push(`QUIC ${quic}`);
        if (stack) parts.push(`协议栈 ${stack}`);
        if (!parts.length) return summary.value.total ? `占比 ${summary.value.percent('reject')}%` : '暂无拒绝';
        return `${parts.join(' · ')}（${summary.value.percent('reject')}%）`;
    });

    const activeTrafficText = computed(() => {
        const up = activeConnections.value.reduce((sum, item) => sum + (Number(item.upload) || 0), 0);
        const down = activeConnections.value.reduce((sum, item) => sum + (Number(item.download) || 0), 0);
        return `↑ ${formatRouteTraffic(up)} / ↓ ${formatRouteTraffic(down)}`;
    });

    const emptyEventText = computed(() => {
        if (state.routeLogStatus.value === 'unsupported') return '该节点 Agent 版本不支持分流日志，请更新';
        if (state.routeLogStatus.value === 'connecting') return '正在连接实时分流日志…';
        if (state.routeLogPaused.value) return '已暂停接收，清空或继续后恢复';
        if (!selectedVpsIp.value) return '暂无可查看的 VPS';
        return '当前窗口没有匹配的流量事件';
    });

    const setOutboundFilter = (value) => { filter.value = { ...filter.value, outbound: value }; };
    const togglePaused = () => { state.routeLogPaused.value = !state.routeLogPaused.value; };
    const targetOf = event => {
        const host = String(event?.host || '').trim();
        const ip = String(event?.target_ip || '').trim();
        const port = Number(event?.port) > 0 ? `:${event.port}` : '';
        if (host && ip && host !== ip) return { primary: `${host}${port}`, secondary: ip };
        return { primary: `${host || ip}${port}`, secondary: '' };
    };
    const ipVersionText = event => {
        if (Number(event?.ip_version) === 6) return 'IPv6';
        if (Number(event?.ip_version) === 4) return 'IPv4';
        return '';
    };
    const residentialRuleSet = computed(() => {
        const vps = currentVps.value;
        if (!vps) return new Set();
        return new Set(String(state.customRulesOf(vps) || '').split(/\r?\n/).map(item => item.trim().toLowerCase()).filter(Boolean));
    });
    const inResidentialList = (event) => {
        const rule = suggestCustomRule(event);
        if (!rule) return false;
        return residentialRuleSet.value.has(rule.toLowerCase());
    };
    const addToList = (event, list) => {
        const vps = currentVps.value;
        if (!vps) return;
        const rule = suggestCustomRule(event);
        if (!rule) {
            state.showToast?.('该事件没有可用于名单的域名或 IP', 'error');
            return;
        }
        const result = state.quickAddRouteRule(vps.ip, list, rule);
        if (!result?.ok) {
            state.showToast?.(result?.message || '加入名单失败', 'error');
            return;
        }
        draftError.value = '';
        state.showToast?.(result.message, 'success');
    };
    const applyDraft = async () => {
        const vps = currentVps.value;
        if (!vps) return;
        applyingDraft.value = true;
        draftError.value = '';
        try {
            const saved = await state.applyEgressDraft(vps);
            if (saved) {
                state.routeLogDraftNotice.value = '';
                return;
            }
            draftError.value = vps._egress_conflict
                ? '配置已被其他管理员更新（409），请刷新节点配置后重新应用草稿。'
                : (vps._egress_save_error || '草稿应用失败，请检查分流配置。');
        } finally {
            applyingDraft.value = false;
        }
    };
    const discardDraft = () => {
        const vps = currentVps.value;
        if (!vps) return;
        state.cancelEgressDraft(vps);
        state.routeLogDraftNotice.value = '';
        draftError.value = '';
    };
    const runRouteTest = async () => {
        await state.testRouteTarget(state.routeTestTarget.value, selectedVpsIp.value);
    };

    watch(() => state.routeLogEvents.value?.length, async (length) => {
        if (!autoScroll.value || !length) return;
        await nextTick();
        const element = eventScroller.value;
        if (element) element.scrollTop = 0;
    });

    return {
        ...state,
        filter,
        activeTabName,
        autoScroll,
        applyingDraft,
        draftError,
        eventScroller,
        selectedVpsIp,
        currentVps,
        appliedPreset,
        appliedStack,
        summary,
        filteredEvents,
        activeConnections,
        draftNotice,
        hasDraft,
        ruleGroupLabels,
        statusText,
        rejectBreakdown,
        activeTrafficText,
        emptyEventText,
        setOutboundFilter,
        togglePaused,
        targetOf,
        ipVersionText,
        inResidentialList,
        addToList,
        applyDraft,
        discardDraft,
        runRouteTest,
        formatRouteClock,
        formatRouteDuration,
        formatRouteTraffic,
        ipStackLabel,
        outboundLabel,
        routeScopeLabel,
        ruleGroupLabel,
    };
  },
};
</script>
