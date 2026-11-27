<template>
  <div v-if="role === 'admin' && activeTab === 'nodes'" class="kui-servers-page space-y-8">
                  <div class="kui-server-stats grid grid-cols-2 md:grid-cols-4 gap-4">
                      <article class="kui-stat-card"><span>在线服务器</span><strong :class="globalOnline > 0 ? 'is-good' : ''">{{ globalOnline }} / {{ servers.length }}</strong><small>节点 {{ enabledNodesCount }} / {{ nodes.length }} 启用</small></article>
                      <article class="kui-stat-card"><span>累计流量</span><strong>{{ formatBytes(globalTraffic) }}</strong><small>所有服务器汇总</small></article>
                      <article class="kui-stat-card"><span>实时下载</span><strong class="is-download">↓ {{ formatBytes(globalSpeedIn) }}/s</strong><small>集群当前入站带宽</small></article>
                      <article class="kui-stat-card"><span>实时上传</span><strong class="is-upload">↑ {{ formatBytes(globalSpeedOut) }}/s</strong><small>集群当前出站带宽</small></article>
                  </div>

                  <form class="kui-vps-onboarding" @submit.prevent="addVps">
                      <label><span>主机名 <b class="kui-required">*</b></span><input v-model.trim="newVps.name" required placeholder="例如：日本软银 01"></label>
                      <label><span>公网 IP <b class="kui-required">*</b></span><input v-model.trim="newVps.ip" required inputmode="decimal" placeholder="8.8.8.8"></label>
                      <label><span>系统架构 <b class="kui-required">*</b></span><select v-model="newVps.os" required><option value="debian">Ubuntu / Debian</option><option value="alpine">Alpine Linux</option></select></label>
                      <button type="submit" :disabled="addingVps"><span v-if="addingVps" class="kui-spin">↻</span>{{ addingVps ? '正在接入' : '确认接入' }}</button>
                  </form>

                  <div v-if="servers.length > 0" class="kui-server-toolbar">
                      <input v-model.trim="serverSearch" type="search" class="kui-server-search" placeholder="搜索主机名或 IP..." aria-label="搜索主机名或 IP">
                      <select v-model="serverStatusFilter" aria-label="按在线状态筛选">
                          <option value="all">全部状态</option>
                          <option value="online">在线</option>
                          <option value="stale">心跳延迟</option>
                          <option value="offline">离线</option>
                      </select>
                      <select v-model="serverEgressFilter" aria-label="按出口模式筛选">
                          <option value="all">全部出口</option>
                          <option value="native">原生直连</option>
                          <option value="global">全局住宅</option>
                          <option value="selective">直连/住宅分流</option>
                      </select>
                      <div class="kui-server-toolbar-meta">
                          <span>显示 {{ visibleServersCount }} / {{ servers.length }} 台</span>
                          <button v-if="hasServerFilter" type="button" class="kui-server-filter-reset" @click="resetServerFilters">重置</button>
                      </div>
                  </div>

                  <div v-if="servers.length > 0 && visibleServersCount === 0" class="kui-server-filter-empty">
                      <span>当前筛选条件下没有匹配的服务器</span>
                      <button type="button" @click="resetServerFilters">清空筛选</button>
                  </div>

                  <div class="kui-server-grid grid grid-cols-1 xl:grid-cols-2 gap-6">
                      <div v-for="vps in servers" :key="vps.ip" v-show="matchesServerFilter(vps)" class="kui-server-card flex flex-col overflow-hidden transition-all">
                          <div class="p-5 md:p-6 relative">
                              <div class="flex justify-between items-start mb-3 gap-2">
                                  <div class="kui-server-heading min-w-0 flex-1 pr-2">
                                      <h3 class="font-black text-2xl text-slate-800 flex items-center gap-2 min-w-0">
                                          <span class="kui-server-name truncate">{{ vps.name }}</span>
                                          <span :class="vps.realtime_state === 'stale' ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]' : (isOnline(vps.last_report, vps.realtime_state) ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.8)]')" class="kui-server-status-dot w-3 h-3 rounded-full inline-block"></span>
                                          <span class="kui-server-ip text-xs font-mono text-slate-400 font-medium">{{ vps.ip }}</span>
                                      </h3>
                                      <div class="kui-server-meta-row">
                                          <span class="kui-meta-pill" :class="serverStatusTone(vps)">{{ serverStatusText(vps) }}</span>
                                          <span class="kui-meta-pill is-egress">{{ egressPresetLabel(appliedPreset(vps)) }}</span>
                                          <span class="kui-meta-pill">{{ ipStackLabel(appliedEgressConfigOf(vps).ip_stack) }}</span>
                                          <span v-if="vps.residential_ready && Number.isFinite(formatExitPurityMeta(vps.residential_active_purity)?.fraudScore)" class="kui-meta-pill is-purity" :title="'主出口 ' + (vps.residential_active_exit_ip || '')">IPPure {{ formatExitPurityMeta(vps.residential_active_purity)?.fraudScore }}</span>
                                          <span class="kui-meta-pill is-count">{{ getEnabledNodesCount(vps.ip) }}/{{ getNodesByIp(vps.ip).length }} 节点</span>
                                      </div>
                                  </div>
                                  <details class="kui-server-menu">
                                      <summary class="kui-card-menu" title="服务器操作" aria-label="打开服务器操作菜单">•••</summary>
                                      <div class="kui-server-menu-panel">
                                          <div class="kui-server-menu-label">所有协议</div>
                                          <button @click="copyCommand(generateSubLink(vps.ip, ''), '该服务器全部协议的普通订阅已复制！', $event)">复制所有协议普通订阅</button>
                                          <button @click="copyCommand(generateSubLink(vps.ip, 'clash'), '该服务器全部协议的 Clash 订阅已复制！', $event)">复制所有协议 Clash 订阅</button>
                                          <button @click="copySurgeConfig(vps.ip, '', $event)">复制所有协议 Surge 配置段</button>
                                          <details class="kui-server-command-menu">
                                              <summary>部署与卸载命令 <span aria-hidden="true">›</span></summary>
                                              <div class="kui-server-command-panel">
                                                  <div class="kui-server-command-heading">
                                                      <strong>部署与卸载命令</strong>
                                                      <div>
                                                          <label><input type="radio" v-model="deployOsMap[vps.ip]" @change="saveOsMap" value="debian"> Ubuntu/Debian</label>
                                                          <label><input type="radio" v-model="deployOsMap[vps.ip]" @change="saveOsMap" value="alpine"> Alpine</label>
                                                      </div>
                                                  </div>
                                                  <button @click="copyDeployCommand(vps, $event)" class="kui-copy-deploy-button">复制完整部署命令</button>
                                                  <button @click="copyUninstallCommand(vps, $event)" class="kui-copy-agent-uninstall-button">复制 Agent 卸载命令（保留住宅代理）</button>
                                                  <button @click="copyPurgeCommand(vps, $event)" class="kui-copy-purge-button" title="卸载全部组件并移除面板记录">复制完整卸载命令</button>
                                              </div>
                                          </details>
                                      </div>
                                  </details>
                              </div>
                              <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                                  <div class="kui-server-metric p-3 rounded-xl border flex flex-col justify-between"><div class="text-[10px] text-slate-400 font-bold tracking-wider mb-1">CPU</div><div class="font-black text-lg text-slate-700">{{ vps.cpu || 0 }}%</div><div class="w-full bg-slate-200/50 rounded-full h-1 mt-1 overflow-hidden"><div class="bg-indigo-400 h-1 rounded-full" :style="{ width: (vps.cpu || 0) + '%' }"></div></div></div>
                                  <div class="kui-server-metric p-3 rounded-xl border flex flex-col justify-between"><div class="text-[10px] text-slate-400 font-bold tracking-wider mb-1">内存</div><div class="font-black text-lg text-slate-700">{{ vps.mem || 0 }}%</div><div class="w-full bg-slate-200/50 rounded-full h-1 mt-1 overflow-hidden"><div class="bg-purple-400 h-1 rounded-full" :style="{ width: (vps.mem || 0) + '%' }"></div></div></div>
                                  <div class="kui-server-metric p-3 rounded-xl border flex flex-col justify-between"><div class="text-[10px] text-slate-400 font-bold tracking-wider mb-1">磁盘</div><div class="font-black text-lg text-slate-700">{{ vps.disk || 0 }}%</div><div class="w-full bg-slate-200/50 rounded-full h-1 mt-1 overflow-hidden"><div class="bg-emerald-400 h-1 rounded-full" :style="{ width: (vps.disk || 0) + '%' }"></div></div></div>
                                  <div class="kui-server-metric p-2.5 rounded-xl border flex flex-col justify-center"><div class="text-[10px] text-slate-400 font-bold tracking-wider mb-1">实时速率</div><div class="text-[11px] font-black text-emerald-500 truncate">↓ {{ formatBytes(vps.net_in_speed || 0) }}/s</div><div class="text-[11px] font-black text-blue-500 truncate mt-0.5">↑ {{ formatBytes(vps.net_out_speed || 0) }}/s</div></div>
                              </div>
                              <div class="kui-server-chart p-3.5 rounded-xl border"><div class="text-[10px] text-slate-400 font-bold tracking-wider mb-1.5">近 7 天流量趋势</div><div :id="'chart-' + vps.ip" class="w-full h-24"></div></div>
                              <div class="kui-egress-panel mt-3">
                                  <div class="kui-egress-summary-bar">
                                      <div class="min-w-0 flex-1">
                                          <div class="flex flex-wrap items-center gap-2">
                                              <div class="kui-egress-heading">节点出口与分流配置</div>
                                              <span data-kui-egress-status class="kui-egress-status-pill" :class="'is-' + (vps.egress_status || 'idle')">
                                                  <template v-if="vps.egress_status === 'pending'">正在应用新配置</template>
                                                  <template v-else-if="vps.egress_status === 'preparing'">节点正在准备出口</template>
                                                  <template v-else-if="vps.egress_status === 'applied'">配置已同步 · {{ egressPresetLabel(appliedPreset(vps)) }}</template>
                                                  <template v-else-if="vps.egress_status === 'failed'">新配置应用失败</template>
                                                  <template v-else>等待 VPS 上线后同步</template>
                                              </span>
                                              <span v-if="egressHasDraft(vps)" class="kui-egress-draft-pill">待应用变更</span>
                                          </div>
                                          <div class="kui-egress-summary-meta">
                                              <span v-if="vps.egress_status === 'applied' && vps.egress_applied_mode !== 'residential'" class="inline-flex flex-wrap items-center gap-1.5">
                                                  <span>最近验证：<span class="break-all font-mono text-indigo-500">{{ vps.egress_ip || '--' }}</span></span>
                                                  <button type="button" @click="refreshVpsEgressIp(vps)" :disabled="egressIpRefreshing[vps.ip]" class="kui-inline-link kui-control-size-exempt" aria-label="刷新 VPS 实际出口 IP">{{ egressIpRefreshing[vps.ip] ? '验证中…' : '重新验证' }}</button>
                                              </span>
                                              <span v-else-if="vps.egress_status === 'pending'">当前：{{ egressPresetLabel(appliedPreset(vps)) }} → 目标：{{ egressPresetLabel(egressPresetOf(vps)) }}</span>
                                              <span v-if="vps.egress_legacy_migrated">历史出口已映射为原生直连</span>
                                              <span v-if="vps.egress_status === 'failed'" class="text-rose-500">{{ vps.egress_error || '节点未报告失败原因' }}</span>
                                              <span class="kui-egress-rev">
                                                  <template v-if="vps.egress_status === 'applied'">版本 {{ vps.egress_applied_revision || 0 }}</template>
                                                  <template v-else-if="['pending', 'preparing'].includes(vps.egress_status)">版本 {{ vps.egress_applied_revision || 0 }} → {{ vps.egress_revision || 0 }}</template>
                                                  <template v-else>当前版本 {{ vps.egress_applied_revision || 0 }} / 目标 {{ vps.egress_revision || 0 }}</template>
                                              </span>
                                          </div>
                                      </div>
                                      <div class="kui-egress-summary-actions">
                                          <button data-kui-egress-open-logs type="button" class="kui-egress-jump-btn kui-control-size-exempt" @click="openRouteLogs(vps.ip)">查看分流日志</button>
                                          <button v-if="egressModeOf(vps) === 'residential' || vps.egress_applied_mode === 'residential' || vps.residential_ready" type="button" class="kui-egress-jump-btn kui-control-size-exempt" @click="openResidentialProxy(vps.ip)">管理住宅通道 →</button>
                                          <button type="button" class="kui-egress-toggle-btn kui-control-size-exempt" :aria-expanded="isEgressExpanded(vps)" @click="toggleEgressExpanded(vps)">{{ isEgressExpanded(vps) ? '收起配置' : '配置出口' }}</button>
                                      </div>
                                  </div>

                                  <div v-if="vps.egress_applied_mode === 'residential' || egressModeOf(vps) === 'residential'" class="kui-residential-brief mt-2.5" :class="vps.residential_ready ? 'is-ready' : 'is-unready'">
                                      <template v-if="vps.residential_ready">
                                          <div class="kui-residential-brief-head">
                                              <span>当前实时住宅出口</span>
                                              <span class="kui-residential-ready-tag">通道已就绪</span>
                                          </div>
                                          <div class="kui-residential-lines">
                                              <div class="kui-residential-line">
                                                  <span class="font-mono">主 {{ vps.residential_active_exit_ip || '等待就绪' }}</span>
                                                  <template v-if="formatExitPurityMeta(vps.residential_active_purity)">
                                                      <span v-if="formatExitPurityMeta(vps.residential_active_purity).typeLabel" :class="purityPillClass(formatExitPurityMeta(vps.residential_active_purity).typeTone)" :title="formatExitPurityMeta(vps.residential_active_purity).asnOrg || ''">{{ formatExitPurityMeta(vps.residential_active_purity).typeLabel }}</span>
                                                      <span v-if="formatExitPurityMeta(vps.residential_active_purity).fraudScore !== null" :class="purityPillClass(formatExitPurityMeta(vps.residential_active_purity).fraudTone)">IPPure {{ formatExitPurityMeta(vps.residential_active_purity).fraudScore }}</span>
                                                      <span v-if="formatExitPurityMeta(vps.residential_active_purity).ipokRisk !== null" :class="purityPillClass(formatExitPurityMeta(vps.residential_active_purity).ipokTone)">IPOK {{ formatExitPurityMeta(vps.residential_active_purity).ipokRisk }}</span>
                                                  </template>
                                              </div>
                                              <div class="kui-residential-line">
                                                  <span class="font-mono">备 {{ vps.residential_standby_exit_ip || '等待就绪' }}</span>
                                                  <template v-if="formatExitPurityMeta(vps.residential_standby_purity)">
                                                      <span v-if="formatExitPurityMeta(vps.residential_standby_purity).typeLabel" :class="purityPillClass(formatExitPurityMeta(vps.residential_standby_purity).typeTone)" :title="formatExitPurityMeta(vps.residential_standby_purity).asnOrg || ''">{{ formatExitPurityMeta(vps.residential_standby_purity).typeLabel }}</span>
                                                      <span v-if="formatExitPurityMeta(vps.residential_standby_purity).fraudScore !== null" :class="purityPillClass(formatExitPurityMeta(vps.residential_standby_purity).fraudTone)">IPPure {{ formatExitPurityMeta(vps.residential_standby_purity).fraudScore }}</span>
                                                      <span v-if="formatExitPurityMeta(vps.residential_standby_purity).ipokRisk !== null" :class="purityPillClass(formatExitPurityMeta(vps.residential_standby_purity).ipokTone)">IPOK {{ formatExitPurityMeta(vps.residential_standby_purity).ipokRisk }}</span>
                                                  </template>
                                              </div>
                                              <div v-if="formatExitPurityMeta(vps.residential_active_purity)?.hasIpok || formatExitPurityMeta(vps.residential_standby_purity)?.hasIpok" class="text-[10px] font-semibold opacity-80">
                                                  风险数据参考 IPPure / <a href="https://ipok.io" target="_blank" rel="noopener noreferrer" class="underline">IPOK</a>
                                              </div>
                                          </div>
                                          <div v-if="vps.egress_status === 'applied' && vps.egress_applied_mode === 'residential'" class="kui-residential-verify">
                                              <span>最近验证：<span class="font-mono break-all">{{ vps.egress_ip || '--' }}</span></span>
                                              <button type="button" @click="refreshVpsEgressIp(vps)" :disabled="egressIpRefreshing[vps.ip]" class="kui-inline-link kui-control-size-exempt" aria-label="刷新 VPS 实际出口 IP">{{ egressIpRefreshing[vps.ip] ? '验证中…' : '重新验证' }}</button>
                                              <div v-if="egressProbeInfo[vps.ip]?.failed" class="w-full text-rose-600">验证失败，显示上次结果</div>
                                              <div v-else-if="egressProbeInfo[vps.ip]?.at" class="w-full opacity-80">验证于 {{ new Date(egressProbeInfo[vps.ip].at).toLocaleString() }}</div>
                                              <div v-if="egressProbeInfo[vps.ip]?.at && vps.egress_ip && vps.residential_active_exit_ip && vps.egress_ip !== vps.residential_active_exit_ip" class="w-full text-amber-700">验证结果与当前主出口不同，出口可能已变化</div>
                                          </div>
                                      </template>
                                      <span v-else>住宅通道未就绪：{{ vps.residential_reason || '等待状态上报' }}。住宅流量将被阻断。</span>
                                  </div>

                                  <div v-show="isEgressExpanded(vps)" class="kui-egress-editor">
                                      <p class="kui-egress-description">修改保存在本地草稿，应用后由 VPS 校验并生效。</p>
                                      <fieldset :disabled="['pending', 'preparing'].includes(vps.egress_status) || vps._egress_saving">
                                          <legend>出口模式</legend>
                                          <div class="kui-routing-modes">
                                              <button v-for="(description, preset) in modeDescriptions" :data-kui-egress-mode="preset" :key="preset" type="button" class="kui-egress-mode-button" :class="{ 'is-active': egressPresetOf(vps) === preset }" :aria-pressed="egressPresetOf(vps) === preset" @click="setEgressPreset(vps, preset)">
                                                  <strong>{{ egressPresetLabel(preset) }}</strong><small>{{ description }}</small>
                                              </button>
                                          </div>
                                      </fieldset>
                                      <fieldset :disabled="vps._egress_saving">
                                          <legend>IPv4 / IPv6 协议栈</legend>
                                          <div class="kui-routing-row">
                                              <button v-for="stack in selectableIpStacks(vps)" :data-kui-egress-ip-stack="stack.key" :key="stack.key" type="button" class="kui-egress-mode-button" :class="{ 'is-active': ipStackOf(vps) === stack.key }" :aria-pressed="ipStackOf(vps) === stack.key" :disabled="stack.disabled" :title="stack.reason" @click="setIpStack(vps, stack.key)">{{ stack.label }}</button>
                                              <small v-if="vps.has_ipv6 === false">此节点未检测到 IPv6 出口，双栈时直连使用 IPv4。</small>
                                              <small v-else-if="egressPresetOf(vps) === 'global'">住宅通道仅支持 IPv4。</small>
                                          </div>
                                      </fieldset>
                                      <fieldset v-if="egressPresetOf(vps) === 'selective'" :disabled="vps._egress_saving">
                                          <legend>精准分流规则</legend>
                                          <p class="kui-routing-order">局域网 → 自定义直连 → 自定义住宅 → AI → 油管 → 流媒体 → 谷歌 → 兜底直连</p>
                                          <div class="kui-routing-row">
                                              <button v-for="cat in proxyCategoryOptions" :data-kui-egress-category="cat.key" :key="cat.key" type="button" class="kui-egress-category-button" :aria-pressed="proxyCategoryActive(vps, cat.key)" :class="{ 'is-active': proxyCategoryActive(vps, cat.key) }" @click="toggleProxyCategory(vps, cat.key)">{{ cat.key === 'youtube' ? '油管' : cat.label }}</button>
                                          </div>
                                          <div class="kui-routing-lists">
                                              <label v-for="list in ruleLists" :key="list.key" :class="['kui-routing-list', 'is-' + list.key, { 'is-invalid': egressRuleState(vps).conflicts.length || egressRuleState(vps)[list.error] }]">
                                                  <span>{{ list.label }} <small>{{ egressRuleState(vps)[list.entries].length }} / 200 条</small></span>
                                                  <textarea :data-kui-egress-direct-rules="list.key === 'direct' ? '' : null" :data-kui-egress-custom-rules="list.key === 'custom' ? '' : null" class="kui-egress-control" rows="4" spellcheck="false" :placeholder="list.example" :value="list.key === 'direct' ? directRulesOf(vps) : customRulesOf(vps)" @input="editRoutingList(vps, list.field, $event.target.value)"></textarea>
                                              </label>
                                          </div>
                                          <small>每行一条，支持域名后缀、full:、keyword: 和 IP/CIDR。TUIC 入站按 IP 或 DNS 匹配。</small>
                                      </fieldset>
                                      <label v-if="egressModeOf(vps) === 'residential'" class="kui-routing-quic">
                                          <span><strong>住宅禁用 QUIC（UDP 443）</strong><small>仅对住宅流量生效，允许客户端回落 TCP。</small></span>
                                          <input type="checkbox" data-kui-egress-quic role="switch" :checked="blockResidentialQuicOf(vps)" :disabled="vps._egress_saving" @change="toggleBlockResidentialQuic(vps)">
                                      </label>
                                      <div v-if="egressHasDraft(vps)" class="kui-routing-draft">
                                          <p v-for="reason in egressValidation(vps).errors" :key="reason" role="alert">{{ reason }}</p>
                                          <p v-if="vps._egress_conflict_message || vps._egress_save_error" role="alert">{{ vps._egress_conflict_message || vps._egress_save_error }}</p>
                                          <div class="kui-routing-row">
                                              <button type="button" class="kui-egress-mode-button" :disabled="vps._egress_saving" data-kui-egress-cancel @click="cancelEgressDraft(vps)">放弃草稿</button>
                                              <button type="button" class="kui-egress-mode-button is-active" :disabled="!egressValidation(vps).valid || vps._egress_conflict || ['pending', 'preparing'].includes(vps.egress_status) || vps._egress_saving" data-kui-egress-apply @click="applyEgressDraft(vps)">{{ vps._egress_saving ? '应用中…' : '应用配置到节点' }}</button>
                                          </div>
                                      </div>
                                  </div>
                                  <button v-if="!egressHasDraft(vps) && !['pending', 'preparing'].includes(vps.egress_status) && (vps.egress_status === 'failed' || Number(vps.egress_revision || 0) !== Number(vps.egress_applied_revision || 0))" data-kui-egress-retry @click="forceReapplyEgress(vps)" class="kui-egress-retry mt-2 w-full">重新下发当前出口配置</button>
                              </div>
                          </div>

                          <details class="kui-server-tools">
                              <summary><span>配置与节点管理</span><small>{{ getNodesByIp(vps.ip).length }} 个节点</small></summary>
                              <div class="px-6 md:px-8 pb-4">
                              <div v-if="vps.config_result?.component === 'config'" class="mb-3 rounded-xl border px-4 py-3 text-xs font-bold" :class="vps.config_result.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'">
                                  <span v-if="vps.config_result.success">● 最近节点配置已在 VPS 生效</span>
                                  <span v-else>● 最近节点配置应用失败：{{ vps.config_result.error || '未知错误，VPS 保留原配置' }}</span>
                              </div>
                              <div class="kui-deploy-tabs" role="tablist">
                                  <button type="button" role="tab" :aria-selected="getDeployTab(vps.ip) === 'single'" :class="{ 'is-active': getDeployTab(vps.ip) === 'single' }" @click="setDeployTab(vps.ip, 'single')">添加单节点</button>
                                  <button type="button" role="tab" :aria-selected="getDeployTab(vps.ip) === 'quick'" :class="{ 'is-active': getDeployTab(vps.ip) === 'quick' }" @click="setDeployTab(vps.ip, 'quick')">极速 9 合 1</button>
                              </div>
                              <div v-show="getDeployTab(vps.ip) === 'single'" class="kui-node-deploy-panel">
                                  <div class="kui-node-panel-heading"><div><strong>添加单节点</strong><span>按协议填写必要参数</span></div><small><b class="kui-required">*</b> 必填</small></div>
                                  <div class="kui-node-form-grid kui-node-form-primary">
                                      <label><span>归属用户 <b class="kui-required">*</b></span><select v-model="newNodeParams[vps.ip].username" required><option value="admin">管理员自身</option><option v-for="u in users" :value="u.username">{{ u.username }}</option></select></label>
                                      <label><span>协议 <b class="kui-required">*</b></span><select v-model="newNodeParams[vps.ip].protocol" required><option value="AnyTLS">AnyTLS</option><option value="gRPC-Reality">gRPC + Reality</option><option value="H2-Reality">H2 + Reality</option><option value="Hysteria2">Hysteria2</option><option value="Naive">Naive</option><option value="Shadowsocks2022">Shadowsocks 2022</option><option value="Socks5">SOCKS5</option><option value="Trojan">Trojan</option><option value="TUIC">TUIC v5</option><option value="VLESS">VLESS</option><option value="XTLS-Reality">XTLS + Reality</option><option disabled>──────────</option><option value="VLESS-Argo">VLESS Argo</option><option value="dokodemo-door">Dokodemo</option><option value="MTProxy">MTProxy</option></select></label>
                                      <label class="is-port"><span>端口 <b class="kui-required">*</b></span><input v-model="newNodeParams[vps.ip].port" type="number" min="1" max="65535" placeholder="443" required></label>
                                  </div>
                                  <div v-if="newNodeParams[vps.ip].protocol === 'VLESS-Argo'" class="kui-node-protocol-note">公网域名由 VPS 建立 Argo 隧道后自动回传。</div>
                                  <div v-if="newNodeParams[vps.ip].protocol === 'dokodemo-door'" class="kui-node-protocol-fields">
                                      <label><span>转发类型 <b class="kui-required">*</b></span><select v-model="newNodeParams[vps.ip].relay_type" required><option value="external">外部目标地址</option><option value="internal">面板内部节点</option></select></label>
                                      <div v-if="newNodeParams[vps.ip].relay_type === 'external'" class="kui-node-form-grid"><label><span>目标 IP / 域名 <b class="kui-required">*</b></span><input v-model="newNodeParams[vps.ip].target_ip" placeholder="example.com" required></label><label><span>目标端口 <b class="kui-required">*</b></span><input v-model.number="newNodeParams[vps.ip].target_port" type="number" min="1" max="65535" placeholder="443" required></label></div>
                                      <label v-else><span>目标节点 <b class="kui-required">*</b></span><select v-model="newNodeParams[vps.ip].target_id" required><option value="">选择本 VPS 的目标节点</option><option v-for="target in nodes.filter(n => n.id && n.vps_ip === vps.ip && n.enable && ['VLESS', 'XTLS-Reality', 'Reality', 'Hysteria2', 'TUIC', 'Shadowsocks2022', 'Trojan', 'H2-Reality', 'gRPC-Reality', 'AnyTLS'].includes(n.protocol))" :value="target.id">{{ target.protocol }}:{{ target.port }}</option></select></label>
                                  </div>
                                  <div v-if="newNodeParams[vps.ip].protocol === 'MTProxy'" class="kui-node-protocol-fields kui-node-form-grid">
                                      <label><span>TLS 伪装域名 <b class="kui-required">*</b></span><input v-model.trim="newNodeParams[vps.ip].mtproxy_domain" type="text" spellcheck="false" placeholder="与 VPS 网络身份相符的域名" required></label>
                                      <label><span>FakeTLS 密钥 <em>留空随机生成</em></span><input v-model.trim="newNodeParams[vps.ip].mtproxy_secret" type="text" spellcheck="false" autocomplete="off" placeholder="ee 开头的十六进制密钥"></label>
                                  </div>
                                  <details class="kui-node-advanced">
                                      <summary><span>高级与可选参数</span><small>流量配额、到期日期、自定义密钥（留空自动生成）</small></summary>
                                      <div class="kui-node-advanced-body">
                                          <div class="kui-node-form-grid kui-node-form-optional">
                                              <label><span>流量配额 <em>GB，0 为无限</em></span><input v-model="newNodeParams[vps.ip].traffic_limit_gb" type="number" min="0" placeholder="0"></label>
                                              <label><span>到期日期 <em>留空为永久</em></span><input v-model="newNodeParams[vps.ip].expire_date" type="date"></label>
                                          </div>
                                          <div v-if="['VLESS', 'XTLS-Reality', 'H2-Reality', 'gRPC-Reality', 'TUIC', 'VLESS-Argo'].includes(newNodeParams[vps.ip].protocol)" class="kui-node-protocol-fields">
                                              <label><span>UUID <em>留空随机生成</em></span><input v-model.trim="newNodeParams[vps.ip].node_uuid" type="text" spellcheck="false" autocomplete="off" placeholder="自动生成 UUID"></label>
                                          </div>
                                          <div v-if="['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'].includes(newNodeParams[vps.ip].protocol)" class="kui-node-protocol-fields kui-node-reality-fields">
                                              <label><span>Reality 伪装域名 <em>留空使用默认</em></span><input v-model.trim="newNodeParams[vps.ip].sni" :list="'sni-rec-' + vps.ip" placeholder="addons.mozilla.org"><datalist :id="'sni-rec-' + vps.ip"><option value="addons.mozilla.org"></option><option value="www.apple.com"></option><option value="gateway.icloud.com"></option><option value="itunes.apple.com"></option><option value="www.microsoft.com"></option></datalist></label>
                                              <label><span>短 ID <em>留空随机生成</em></span><input v-model.trim="newNodeParams[vps.ip].reality_short_id" type="text" maxlength="32" spellcheck="false" autocomplete="off" placeholder="十六进制短 ID"></label>
                                              <label><span>Reality 私钥 <em>与公钥同时留空自动生成</em></span><input v-model.trim="newNodeParams[vps.ip].reality_private_key" type="text" maxlength="43" spellcheck="false" autocomplete="off" placeholder="X25519 私钥"></label>
                                              <label><span>Reality 公钥 <em>与私钥配对</em></span><input v-model.trim="newNodeParams[vps.ip].reality_public_key" type="text" maxlength="43" spellcheck="false" autocomplete="off" placeholder="X25519 公钥"></label>
                                          </div>
                                          <div v-if="['Hysteria2', 'Trojan', 'AnyTLS', 'Naive'].includes(newNodeParams[vps.ip].protocol)" class="kui-node-protocol-fields">
                                              <label><span>SNI / 主机名 <em>留空使用默认</em></span><input v-model.trim="newNodeParams[vps.ip].sni" placeholder="addons.mozilla.org"></label>
                                          </div>
                                          <div v-if="['Hysteria2', 'TUIC', 'Trojan', 'AnyTLS'].includes(newNodeParams[vps.ip].protocol)" class="kui-node-protocol-fields">
                                              <label><span>密码 <em>留空随机生成</em></span><input v-model.trim="newNodeParams[vps.ip].node_password" type="text" spellcheck="false" autocomplete="off" placeholder="自动生成安全密码"></label>
                                          </div>
                                          <div v-if="['Naive', 'Socks5'].includes(newNodeParams[vps.ip].protocol)" class="kui-node-protocol-fields">
                                              <label><span>用户名 <em>留空随机生成</em></span><input v-model.trim="newNodeParams[vps.ip].node_username" type="text" spellcheck="false" autocomplete="off" placeholder="自动生成用户名"></label>
                                              <label><span>密码 <em>留空随机生成</em></span><input v-model.trim="newNodeParams[vps.ip].node_password" type="text" spellcheck="false" autocomplete="off" placeholder="自动生成安全密码"></label>
                                          </div>
                                          <div v-if="newNodeParams[vps.ip].protocol === 'Shadowsocks2022'" class="kui-node-protocol-fields kui-node-form-grid">
                                              <label><span>加密方式</span><select v-model="newNodeParams[vps.ip].ss_method" @change="newNodeParams[vps.ip].ss_password = ''"><option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option><option value="2022-blake3-aes-128-gcm">2022-blake3-aes-128-gcm</option></select></label>
                                              <label><span>传输网络</span><select v-model="newNodeParams[vps.ip].ss_network"><option value="tcp,udp">TCP + UDP（默认）</option><option value="tcp">仅 TCP</option><option value="udp">仅 UDP</option></select></label>
                                              <label><span>Base64 密钥 <em>留空随机生成</em></span><div class="kui-node-input-action"><input v-model.trim="newNodeParams[vps.ip].ss_password" type="text" spellcheck="false" autocomplete="off" placeholder="自动生成匹配长度的密钥"><button type="button" @click="newNodeParams[vps.ip].ss_password = generateSs2022Password(newNodeParams[vps.ip].ss_method)">随机</button></div></label>
                                          </div>
                                      </div>
                                  </details>
                                  <button @click="addNode(vps.ip)" :disabled="addingNode[vps.ip]" class="kui-node-submit">{{ addingNode[vps.ip] ? '正在添加…' : '添加节点' }}</button>
                              </div>
                              <div v-show="getDeployTab(vps.ip) === 'quick'" class="kui-quick-deploy-panel">
                                  <div class="kui-node-panel-heading"><div><strong>极速 9 合 1</strong><span>按起始端口连续创建 9 个协议节点</span></div><small>QUICK</small></div>
                                  <div class="kui-quick-deploy-grid">
                                      <label><span>归属用户 <b class="kui-required">*</b></span><select v-model="batchUser[vps.ip]" required><option value="admin">管理员自身</option><option v-for="u in users" :value="u.username">{{ u.username }}</option></select></label>
                                      <label><span>起始端口 <b class="kui-required">*</b> <em>建议 8881</em></span><input v-model="batchStartPort[vps.ip]" type="number" min="10" max="65527" placeholder="8881" required></label>
                                      <button @click="deployAllProtocols(vps.ip)">批量下发</button>
                                  </div>
                              </div>
                              </div>
                          </details>

                          <div class="kui-node-list-section p-5 md:p-6 bg-slate-50/50 border-t border-white flex-1">
                              <div v-if="getNodesByIp(vps.ip).length > 4" class="kui-node-filter-bar">
                                  <input :value="getNodeFilter(vps.ip).query" @input="setNodeFilter(vps.ip, 'query', $event.target.value)" type="search" placeholder="筛选协议 / 端口 / 用户..." aria-label="筛选节点">
                                  <select :value="getNodeFilter(vps.ip).protocol" @change="setNodeFilter(vps.ip, 'protocol', $event.target.value)" aria-label="按协议筛选">
                                      <option value="all">全部协议</option>
                                      <option v-for="proto in getNodeProtocols(vps.ip)" :key="proto" :value="proto">{{ proto }}</option>
                                  </select>
                                  <select :value="getNodeFilter(vps.ip).status" @change="setNodeFilter(vps.ip, 'status', $event.target.value)" aria-label="按启用状态筛选">
                                      <option value="all">全部状态</option>
                                      <option value="enabled">已启用</option>
                                      <option value="disabled">已停用</option>
                                  </select>
                              </div>
                              <details v-for="node in getNodesByIp(vps.ip)" :key="node.id" v-show="matchesNodeFilter(vps.ip, node)" class="kui-node-card mb-2.5">
                                  <summary class="kui-node-summary">
                                      <span class="kui-node-summary-main">
                                          <i class="kui-node-status-dot" :class="node.enable === 1 ? 'is-enabled' : 'is-disabled'" :title="node.enable === 1 ? '已启用' : '已停用'"></i>
                                          <span class="kui-node-summary-protocol">{{ node.protocol }}</span>
                                          <span class="kui-node-summary-port">:{{ node.port }}</span>
                                      </span>
                                      <span class="kui-node-summary-user">👤 {{ node.username }}</span>
                                      <span class="kui-node-summary-traffic">
                                          <span>已用流量 {{ formatBytes(node.traffic_used) }}<template v-if="node.traffic_limit > 0"> / {{ formatBytes(node.traffic_limit) }}</template></span>
                                          <span v-if="node.traffic_limit > 0" class="kui-node-mini-bar"><i :class="{ 'is-exhausted': node.traffic_used >= node.traffic_limit }" :style="{ width: getTrafficPercent(node.traffic_used, node.traffic_limit) + '%' }"></i></span>
                                      </span>
                                      <button type="button" class="kui-node-quick-copy kui-control-size-exempt" @click.stop.prevent="quickCopyNode(vps, node)" title="复制节点链接">复制</button>
                                      <span class="kui-node-summary-chevron" aria-hidden="true">⌄</span>
                                  </summary>
                                  <div class="kui-node-details">
                                      <div class="kui-node-details-heading">
                                          <div>
                                              <strong>节点详细配置</strong>
                                              <span :class="node.enable === 1 ? 'is-enabled' : 'is-disabled'">{{ node.enable === 1 ? '已启用' : '已停用' }}</span>
                                          </div>
                                          <div class="kui-node-actions">
                                              <button v-if="!nodeEditDrafts[node.id]" @click="startEditNode(node)">修改</button>
                                              <button v-if="!nodeEditDrafts[node.id]" @click="toggleNode(node.id, node.enable === 1 ? 0 : 1)">{{ node.enable === 1 ? '停用' : '启用' }}</button>
                                              <button v-if="!nodeEditDrafts[node.id]" class="is-danger" @click="deleteNode(node.id)">删除</button>
                                              <button v-else @click="cancelEditNode(node.id)">取消修改</button>
                                          </div>
                                      </div>
                                      <div v-if="nodeEditDrafts[node.id]" class="kui-node-edit-form">
                                          <div class="kui-node-form-grid kui-node-form-primary">
                                              <label><span>归属用户 <b class="kui-required">*</b></span><select v-model="nodeEditDrafts[node.id].username"><option value="admin">管理员自身</option><option v-for="u in users" :value="u.username">{{ u.username }}</option></select></label>
                                              <label><span>协议 <b class="kui-required">*</b></span><select v-model="nodeEditDrafts[node.id].protocol"><option value="VLESS">VLESS</option><option value="XTLS-Reality">XTLS + Reality</option><option value="Hysteria2">Hysteria2</option><option value="TUIC">TUIC v5</option><option value="Shadowsocks2022">Shadowsocks 2022</option><option value="Trojan">Trojan</option><option value="H2-Reality">H2 + Reality</option><option value="gRPC-Reality">gRPC + Reality</option><option value="AnyTLS">AnyTLS</option><option value="Naive">Naive</option><option value="Socks5">SOCKS5</option><option value="VLESS-Argo">VLESS Argo</option><option value="dokodemo-door">Dokodemo</option><option value="MTProxy">MTProxy</option></select></label>
                                              <label><span>端口 <b class="kui-required">*</b></span><input v-model.number="nodeEditDrafts[node.id].port" type="number" min="1" max="65535"></label>
                                          </div>
                                          <div class="kui-node-form-grid kui-node-form-optional"><label><span>流量配额 <em>GB，0 为无限</em></span><input v-model="nodeEditDrafts[node.id].traffic_limit_gb" type="number" min="0" placeholder="0"></label><label><span>到期日期 <em>留空为永久</em></span><input v-model="nodeEditDrafts[node.id].expire_date" type="date"></label></div>
                                          <div v-if="['VLESS', 'XTLS-Reality', 'H2-Reality', 'gRPC-Reality', 'TUIC', 'VLESS-Argo'].includes(nodeEditDrafts[node.id].protocol)" class="kui-node-protocol-fields"><label><span>UUID <em>留空重新生成</em></span><input v-model.trim="nodeEditDrafts[node.id].node_uuid" type="text" spellcheck="false"></label></div>
                                          <div v-if="['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'].includes(nodeEditDrafts[node.id].protocol)" class="kui-node-protocol-fields kui-node-reality-fields">
                                              <label><span>Reality 伪装域名 <em>留空使用默认</em></span><input v-model.trim="nodeEditDrafts[node.id].sni" placeholder="addons.mozilla.org"></label><label><span>短 ID <em>留空重新生成</em></span><input v-model.trim="nodeEditDrafts[node.id].reality_short_id" maxlength="32"></label>
                                              <label><span>Reality 私钥 <em>与公钥同时留空重新生成</em></span><input v-model.trim="nodeEditDrafts[node.id].reality_private_key" maxlength="43"></label><label><span>Reality 公钥 <em>与私钥配对</em></span><input v-model.trim="nodeEditDrafts[node.id].reality_public_key" maxlength="43"></label>
                                          </div>
                                          <div v-if="['Hysteria2', 'Trojan', 'AnyTLS', 'Naive'].includes(nodeEditDrafts[node.id].protocol)" class="kui-node-protocol-fields"><label><span>SNI / 主机名 <em>留空使用默认</em></span><input v-model.trim="nodeEditDrafts[node.id].sni" placeholder="addons.mozilla.org"></label></div>
                                          <div v-if="['Hysteria2', 'TUIC', 'Trojan', 'AnyTLS'].includes(nodeEditDrafts[node.id].protocol)" class="kui-node-protocol-fields"><label><span>密码 <em>留空重新生成</em></span><input v-model.trim="nodeEditDrafts[node.id].node_password" type="text"></label></div>
                                          <div v-if="['Naive', 'Socks5'].includes(nodeEditDrafts[node.id].protocol)" class="kui-node-protocol-fields"><label><span>用户名 <em>留空重新生成</em></span><input v-model.trim="nodeEditDrafts[node.id].node_username" type="text"></label><label><span>密码 <em>留空重新生成</em></span><input v-model.trim="nodeEditDrafts[node.id].node_password" type="text"></label></div>
                                          <div v-if="nodeEditDrafts[node.id].protocol === 'Shadowsocks2022'" class="kui-node-protocol-fields"><label><span>加密方式</span><select v-model="nodeEditDrafts[node.id].ss_method" @change="nodeEditDrafts[node.id].ss_password = ''"><option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option><option value="2022-blake3-aes-128-gcm">2022-blake3-aes-128-gcm</option></select></label><label><span>传输网络</span><select v-model="nodeEditDrafts[node.id].ss_network"><option value="tcp,udp">TCP + UDP（默认）</option><option value="tcp">仅 TCP</option><option value="udp">仅 UDP</option></select></label><label><span>Base64 密钥 <em>留空重新生成</em></span><div class="kui-node-input-action"><input v-model.trim="nodeEditDrafts[node.id].ss_password" type="text"><button type="button" @click="nodeEditDrafts[node.id].ss_password = generateSs2022Password(nodeEditDrafts[node.id].ss_method)">随机</button></div></label></div>
                                          <div v-if="nodeEditDrafts[node.id].protocol === 'dokodemo-door'" class="kui-node-protocol-fields"><label><span>转发类型 <b class="kui-required">*</b></span><select v-model="nodeEditDrafts[node.id].relay_type"><option value="external">外部目标地址</option><option value="internal">面板内部节点</option></select></label><div v-if="nodeEditDrafts[node.id].relay_type === 'external'" class="kui-node-form-grid"><label><span>目标 IP / 域名 <b class="kui-required">*</b></span><input v-model="nodeEditDrafts[node.id].target_ip"></label><label><span>目标端口 <b class="kui-required">*</b></span><input v-model.number="nodeEditDrafts[node.id].target_port" type="number" min="1" max="65535"></label></div><label v-else><span>目标节点 <b class="kui-required">*</b></span><select v-model="nodeEditDrafts[node.id].target_id"><option value="">选择本 VPS 的目标节点</option><option v-for="target in nodes.filter(n => n.id !== node.id && n.vps_ip === node.vps_ip && n.enable && ['VLESS', 'XTLS-Reality', 'Reality', 'Hysteria2', 'TUIC', 'Shadowsocks2022', 'Trojan', 'H2-Reality', 'gRPC-Reality', 'AnyTLS'].includes(n.protocol))" :value="target.id">{{ target.protocol }}:{{ target.port }}</option></select></label></div>
                                          <div v-if="nodeEditDrafts[node.id].protocol === 'MTProxy'" class="kui-node-protocol-fields"><label><span>TLS 伪装域名 <b class="kui-required">*</b></span><input v-model.trim="nodeEditDrafts[node.id].mtproxy_domain" type="text" required></label><label><span>FakeTLS 密钥 <em>留空重新生成</em></span><input v-model.trim="nodeEditDrafts[node.id].mtproxy_secret" type="text" spellcheck="false"></label></div>
                                          <div class="kui-node-edit-actions"><button @click="cancelEditNode(node.id)">取消</button><button class="is-primary" @click="saveNodeEdit(node)">保存并应用</button></div>
                                      </div>
                                      <template v-else>
                                      <dl class="kui-node-detail-grid">
                                          <div v-for="row in buildNodeDetailRows(node)" :key="row.label">
                                              <dt>{{ row.label }}</dt>
                                              <dd>{{ row.value }}</dd>
                                          </div>
                                      </dl>
                                      <div class="kui-node-usage">
                                          <div class="kui-node-usage-labels">
                                              <span>流量：{{ formatBytes(node.traffic_used) }}<template v-if="node.traffic_limit > 0"> / {{ formatBytes(node.traffic_limit) }}</template><template v-else> / 不限</template></span>
                                              <span>到期：{{ node.expire_time > 0 ? formatDate(node.expire_time) : '永久' }}</span>
                                          </div>
                                          <div class="kui-node-usage-bar"><i :class="(node.traffic_limit > 0 && node.traffic_used >= node.traffic_limit) ? 'is-exhausted' : ''" :style="{ width: getTrafficPercent(node.traffic_used, node.traffic_limit) + '%' }"></i></div>
                                          <button v-if="node.traffic_used > 0" @click="resetTraffic(node.id)">清零已用流量</button>
                                      </div>
                                      <div class="kui-node-export-actions">
                                          <button v-if="node.protocol === 'MTProxy'" @click="copyCommand(generateMtproxyLink(node), 'Telegram MTProxy 链接已复制！')">复制 Telegram 链接</button>
                                          <template v-else>
                                              <button @click="copyCommand(generateSubLink(vps.ip, '', node.id), '该节点普通订阅已复制！')">复制普通订阅</button>
                                              <button @click="copyCommand(generateSubLink(vps.ip, 'clash', node.id), '该节点 Clash 订阅已复制！')">复制 Clash 订阅</button>
                                              <button @click="copySurgeConfig(vps.ip, node.id)">复制 Surge 配置段</button>
                                          </template>
                                      </div>
                                      </template>
                                  </div>
                              </details>
                              <div v-if="getNodesByIp(vps.ip).length > 0 && getVisibleNodesCount(vps.ip) === 0" class="kui-node-filter-empty">当前筛选条件下无匹配节点</div>
                              <div v-if="getNodesByIp(vps.ip).length === 0" class="text-center text-slate-400 text-xs py-6 border-2 border-dashed border-slate-200 rounded-2xl font-medium">节点矩阵为空，请在上方一键下发建立</div>
                          </div>
                      </div>
                  </div>
              </div>
</template>

<script>
import { computed, inject, reactive, ref, watch } from 'vue';
import { KUI_KEY } from '../app/context.js';
import { formatExitPurityMeta } from '../utils/egressState.js';
import { appliedEgressConfigOf, appliedEgressPresetOf as appliedPreset, ipStackLabel, selectableIpStacks } from '../utils/routeLog.js';
import { buildNodeDetailRows } from '../utils/nodeDetails.js';

function purityPillClass(tone) {
  const tones = {
    emerald: 'border-emerald-300 bg-emerald-100 text-emerald-800',
    sky: 'border-sky-300 bg-sky-100 text-sky-800',
    amber: 'border-amber-300 bg-amber-100 text-amber-800',
    rose: 'border-rose-300 bg-rose-100 text-rose-800',
  };
  return `inline-flex items-center rounded border px-1.5 py-0.5 font-sans text-[10px] font-bold leading-none ${tones[tone] || 'border-slate-300 bg-slate-100 text-slate-700'}`;
}

export default {
  setup() {
    const state = inject(KUI_KEY);
    const serverSearch = ref('');
    const serverStatusFilter = ref('all');
    const serverEgressFilter = ref('all');
    const egressExpandedMap = reactive({});
    const deployTabMap = reactive({});
    const nodeFilters = reactive({});

    const enabledNodesCount = computed(() => (state.nodes.value || []).filter(n => n.enable === 1).length);
    const hasServerFilter = computed(() => Boolean(serverSearch.value || serverStatusFilter.value !== 'all' || serverEgressFilter.value !== 'all'));

    const serverStatusKey = (vps) => {
      if (vps.realtime_state === 'stale') return 'stale';
      return state.isOnline(vps.last_report, vps.realtime_state) ? 'online' : 'offline';
    };
    const serverStatusText = (vps) => ({ online: '在线', stale: '心跳延迟', offline: '离线' }[serverStatusKey(vps)] || '离线');
    const serverStatusTone = (vps) => ({ online: 'is-online', stale: 'is-stale', offline: 'is-offline' }[serverStatusKey(vps)] || 'is-offline');

    const matchesServerFilter = (vps) => {
      const query = serverSearch.value.trim().toLowerCase();
      if (query) {
        const name = String(vps.name || '').toLowerCase();
        const ip = String(vps.ip || '').toLowerCase();
        if (!name.includes(query) && !ip.includes(query)) return false;
      }
      if (serverStatusFilter.value !== 'all' && serverStatusKey(vps) !== serverStatusFilter.value) return false;
      if (serverEgressFilter.value !== 'all' && appliedPreset(vps) !== serverEgressFilter.value) return false;
      return true;
    };

    const visibleServersCount = computed(() => (state.servers.value || []).filter(matchesServerFilter).length);
    const resetServerFilters = () => {
      serverSearch.value = '';
      serverStatusFilter.value = 'all';
      serverEgressFilter.value = 'all';
    };

    watch([serverSearch, serverStatusFilter, serverEgressFilter], () => {
      state.renderKUICharts?.();
    });

    const isEgressExpanded = (vps) => egressExpandedMap[vps.ip] ?? (state.egressHasDraft(vps) || ['pending', 'preparing', 'failed'].includes(vps.egress_status));
    const toggleEgressExpanded = (vps) => {
      egressExpandedMap[vps.ip] = !isEgressExpanded(vps);
    };

    const getDeployTab = (ip) => deployTabMap[ip] || 'single';
    const setDeployTab = (ip, tab) => { deployTabMap[ip] = tab; };

    const getEnabledNodesCount = (ip) => state.getNodesByIp(ip).filter(n => n.enable === 1).length;
    const getNodeFilter = (ip) => nodeFilters[ip] || { query: '', protocol: 'all', status: 'all' };
    const setNodeFilter = (ip, key, value) => {
      if (!nodeFilters[ip]) nodeFilters[ip] = { query: '', protocol: 'all', status: 'all' };
      nodeFilters[ip][key] = value;
    };
    const getNodeProtocols = (ip) => [...new Set(state.getNodesByIp(ip).map(n => n.protocol).filter(Boolean))];
    const matchesNodeFilter = (ip, node) => {
      const filter = getNodeFilter(ip);
      const query = String(filter.query || '').trim().toLowerCase();
      if (query) {
        const haystack = `${node.protocol || ''} ${node.port || ''} ${node.username || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (filter.protocol !== 'all' && node.protocol !== filter.protocol) return false;
      if (filter.status === 'enabled' && node.enable !== 1) return false;
      if (filter.status === 'disabled' && node.enable === 1) return false;
      return true;
    };
    const getVisibleNodesCount = (ip) => state.getNodesByIp(ip).filter(node => matchesNodeFilter(ip, node)).length;

    const quickCopyNode = async (vps, node) => {
      const link = node.protocol === 'MTProxy'
        ? state.generateMtproxyLink(node)
        : state.generateSubLink(vps.ip, '', node.id);
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(link);
          state.showToast?.(`已复制 ${node.protocol}:${node.port} 链接`, 'success');
          return;
        }
      } catch {
        // Fallback to existing copyCommand helper below.
      }
      state.copyCommand(link, `${node.protocol}:${node.port} 链接已复制！`);
    };

    return {
      ...state,
      appliedPreset,
      appliedEgressConfigOf,
      ipStackLabel,
      editRoutingList(vps, field, value) {
        state.markEgressDirty(vps);
        vps[field] = value;
      },
      modeDescriptions: { native: '使用 VPS 本机网络', global: '局域网外全部走住宅', selective: '命中规则走住宅，其余直连' },
      selectableIpStacks,
      ruleLists: [
        { key: 'direct', field: '_proxy_direct_rules', label: '自定义直连（白名单）', entries: 'directRules', error: 'directError', example: 'example.org' },
        { key: 'custom', field: '_proxy_custom_rules', label: '自定义住宅（黑名单）', entries: 'customRules', error: 'customError', example: 'full:api.example.org' },
      ],
      buildNodeDetailRows,
      formatExitPurityMeta,
      purityPillClass,
      serverSearch,
      serverStatusFilter,
      serverEgressFilter,
      enabledNodesCount,
      hasServerFilter,
      visibleServersCount,
      serverStatusText,
      serverStatusTone,
      matchesServerFilter,
      resetServerFilters,
      isEgressExpanded,
      toggleEgressExpanded,
      getDeployTab,
      setDeployTab,
      getEnabledNodesCount,
      getNodeFilter,
      setNodeFilter,
      getNodeProtocols,
      matchesNodeFilter,
      getVisibleNodesCount,
      quickCopyNode,
    };
  },
};
</script>

<style scoped>
.kui-egress-editor { display: grid; gap: 12px; }
.kui-egress-editor fieldset { min-width: 0; border-block-start: 1px solid #94a3b84d; padding-top: 8px; }
.kui-egress-editor legend, .kui-routing-list span { font-size: 12px; font-weight: 750; }
.kui-routing-modes, .kui-routing-lists { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.kui-routing-modes button { height: auto; text-align: start; padding-block: 6px; }
.kui-egress-editor small { font-size: 11px; font-weight: 500; opacity: .85; }
.kui-routing-modes small, .kui-routing-quic small { display: block; }
.kui-routing-row, .kui-routing-quic, .kui-routing-list span { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kui-routing-quic, .kui-routing-list span { justify-content: space-between; }
.kui-routing-order { margin-bottom: 8px; font-size: 11px; line-height: 1.6; }
.kui-routing-lists { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-block: 8px; }
.kui-routing-list { display: grid; gap: 4px; padding: 8px; border: 1px solid #818cf880; border-radius: 10px; }
.kui-routing-list.is-direct { border-color: #10b98180; }
.kui-routing-list.is-invalid { border-color: #f43f5e; }
.kui-routing-list textarea { width: 100%; height: auto; padding: 6px 8px; resize: vertical; font-family: monospace; }
.kui-routing-quic { padding-block: 6px; font-size: 12px; }
.kui-routing-quic input { width: 2.1rem; height: 1.2rem; appearance: none; border-radius: 1rem; background: #64748b; cursor: pointer; }
.kui-routing-quic input::after { content: ''; display: block; margin: .15rem; width: .9rem; height: .9rem; border-radius: 50%; background: white; }
.kui-routing-quic input:checked { background: #059669; }
.kui-routing-quic input:checked::after { transform: translateX(.9rem); }
.kui-routing-draft [role="alert"] { color: #e11d48; font-size: 12px; overflow-wrap: anywhere; }
.kui-egress-editor :disabled { opacity: .55; }
@media (max-width: 640px) {
  .kui-routing-modes, .kui-routing-lists { grid-template-columns: 1fr; }
}
</style>
