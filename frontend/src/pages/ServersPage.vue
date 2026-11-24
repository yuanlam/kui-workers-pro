<template>
  <div v-if="role === 'admin' && activeTab === 'nodes'" class="kui-servers-page space-y-8">
                  <div class="kui-server-stats grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div class="bg-white/60 backdrop-blur-xl p-5 rounded-[2rem] border border-white shadow-lg shadow-indigo-100/30 text-center"><div class="text-[10px] text-slate-400 font-bold mb-1 tracking-widest">在线服务器</div><div class="text-3xl font-black text-slate-700">{{ globalOnline }} / {{ servers.length }}</div></div>
                      <div class="bg-white/60 backdrop-blur-xl p-5 rounded-[2rem] border border-white shadow-lg shadow-indigo-100/30 text-center"><div class="text-[10px] text-slate-400 font-bold mb-1 tracking-widest">累计流量</div><div class="text-3xl font-black text-slate-700">{{ formatBytes(globalTraffic) }}</div></div>
                      <div class="bg-white/60 backdrop-blur-xl p-5 rounded-[2rem] border border-white shadow-lg shadow-indigo-100/30 text-center"><div class="text-[10px] text-slate-400 font-bold mb-1 tracking-widest">实时下载</div><div class="text-2xl font-black text-emerald-500 truncate">↓ {{ formatBytes(globalSpeedIn) }}/s</div></div>
                      <div class="bg-white/60 backdrop-blur-xl p-5 rounded-[2rem] border border-white shadow-lg shadow-indigo-100/30 text-center"><div class="text-[10px] text-slate-400 font-bold mb-1 tracking-widest">实时上传</div><div class="text-2xl font-black text-blue-500 truncate">↑ {{ formatBytes(globalSpeedOut) }}/s</div></div>
                  </div>

                  <form class="kui-vps-onboarding" @submit.prevent="addVps">
                      <label><span>主机名 <b class="kui-required">*</b></span><input v-model.trim="newVps.name" required placeholder="例如：日本软银 01"></label>
                      <label><span>公网 IP <b class="kui-required">*</b></span><input v-model.trim="newVps.ip" required inputmode="decimal" placeholder="8.8.8.8"></label>
                      <label><span>系统架构 <b class="kui-required">*</b></span><select v-model="newVps.os" required><option value="debian">Ubuntu / Debian</option><option value="alpine">Alpine Linux</option></select></label>
                      <button type="submit" :disabled="addingVps"><span v-if="addingVps" class="kui-spin">↻</span>{{ addingVps ? '正在接入' : '确认接入' }}</button>
                  </form>

                  <div class="kui-server-grid grid grid-cols-1 xl:grid-cols-2 gap-8">
                      <div v-for="vps in servers" :key="vps.ip" class="kui-server-card bg-white/70 backdrop-blur-xl rounded-[2rem] border border-white shadow-xl shadow-slate-200/40 flex flex-col overflow-hidden transition-all hover:shadow-2xl">
                          <div class="p-6 md:p-8 relative">
                              <div class="flex justify-between items-start mb-4">
                                  <div class="kui-server-heading min-w-0 flex-1 pr-2">
                                      <h3 class="font-black text-2xl text-slate-800 flex items-center gap-2 min-w-0">
                                          <span class="kui-server-name truncate">{{ vps.name }}</span>
                                          <span :class="vps.realtime_state === 'stale' ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]' : (isOnline(vps.last_report, vps.realtime_state) ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.8)]')" class="kui-server-status-dot w-3 h-3 rounded-full inline-block"></span>
                                          <span class="kui-server-ip text-xs font-mono text-slate-400 font-medium">{{ vps.ip }}</span>
                                      </h3>
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
                              <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
                                  <div class="kui-server-metric bg-white/50 p-3 rounded-2xl border border-white shadow-sm flex flex-col justify-between"><div class="text-[9px] text-slate-400 font-bold tracking-wider mb-1">CPU</div><div class="font-black text-lg text-slate-700">{{ vps.cpu || 0 }}%</div><div class="w-full bg-slate-200/50 rounded-full h-1 mt-1 overflow-hidden"><div class="bg-indigo-400 h-1 rounded-full" :style="{ width: (vps.cpu || 0) + '%' }"></div></div></div>
                                  <div class="kui-server-metric bg-white/50 p-3 rounded-2xl border border-white shadow-sm flex flex-col justify-between"><div class="text-[9px] text-slate-400 font-bold tracking-wider mb-1">MEM</div><div class="font-black text-lg text-slate-700">{{ vps.mem || 0 }}%</div><div class="w-full bg-slate-200/50 rounded-full h-1 mt-1 overflow-hidden"><div class="bg-purple-400 h-1 rounded-full" :style="{ width: (vps.mem || 0) + '%' }"></div></div></div>
                                  <div class="kui-server-metric bg-white/50 p-3 rounded-2xl border border-white shadow-sm flex flex-col justify-between"><div class="text-[9px] text-slate-400 font-bold tracking-wider mb-1">DISK</div><div class="font-black text-lg text-slate-700">{{ vps.disk || 0 }}%</div><div class="w-full bg-slate-200/50 rounded-full h-1 mt-1 overflow-hidden"><div class="bg-emerald-400 h-1 rounded-full" :style="{ width: (vps.disk || 0) + '%' }"></div></div></div>
                                  <div class="kui-server-metric bg-white/50 p-2 rounded-2xl border border-white shadow-sm flex flex-col justify-center text-center"><div class="text-[9px] text-slate-400 font-bold tracking-wider mb-1">SPEED</div><div class="text-[10px] font-black text-emerald-500 truncate">↓ {{ formatBytes(vps.net_in_speed || 0) }}/s</div><div class="text-[10px] font-black text-blue-500 truncate mt-0.5">↑ {{ formatBytes(vps.net_out_speed || 0) }}/s</div></div>
                              </div>
                              <div class="kui-server-chart bg-white/40 p-4 rounded-2xl border border-white"><div class="text-[10px] text-slate-400 font-bold tracking-wider mb-2">7-DAY TRAFFIC TREND</div><div :id="'chart-' + vps.ip" class="w-full h-32"></div></div>
                              <div class="kui-egress-panel mt-3">
                                  <div class="mb-3"><div class="kui-egress-heading">节点出口</div><div class="kui-egress-description mt-0.5">选择和修改仅保存在本地，点击“应用”后才会下发到 VPS</div></div>
                                  <select :value="egressModeOf(vps)" @change="onEgressModeChange(vps, $event.target.value)" :disabled="['pending', 'preparing'].includes(vps.egress_status) || vps._egress_saving" class="kui-egress-control w-full disabled:opacity-50">
                                      <option value="native">原生出口</option>
                                      <option value="warp_ipv4">WARP IPv4</option>
                                      <option value="warp_ipv6">WARP IPv6</option>
                                      <option value="warp_dual">WARP 双栈</option>
                                      <option value="residential">住宅 IP 代理</option>
                                      <option value="socks5">手动 SOCKS5</option>
                                  </select>
                                  <div v-if="egressModeOf(vps) === 'residential'" class="mt-3">
                                      <div class="flex gap-2 mb-2">
                                          <button @click="setProxyMode(vps, 'residential', 'global')" :class="{ 'is-active': proxyModeOf(vps) === 'global' }" class="kui-egress-mode-button flex-1">全局代理</button>
                                          <button @click="setProxyMode(vps, 'residential', 'selective')" :class="{ 'is-active': proxyModeOf(vps) === 'selective' }" class="kui-egress-mode-button flex-1">局部代理</button>
                                      </div>
                                      <div v-if="proxyModeOf(vps) === 'selective'" class="flex flex-wrap gap-1.5 mb-2">
                                          <button v-for="cat in proxyCategoryOptions" :key="cat.key" @click="toggleProxyCategory(vps, cat.key)" :class="{ 'is-active': proxyCategoryActive(vps, cat.key) }" class="kui-egress-category-button">{{ cat.label }}</button>
                                      </div>
                                      <div v-if="proxyModeOf(vps) === 'selective' && proxyCategoryActive(vps, 'custom')" class="mb-2 rounded-xl border border-indigo-200 bg-indigo-50 p-2.5">
                                          <div class="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-black text-indigo-700"><span>自定义代理域名（每行一个）</span><button @click="clearProxyCustomDomains(vps)" class="text-indigo-500 hover:text-indigo-700">清空</button></div>
                                          <textarea v-model="vps._proxy_custom_domains" @input="markProxyCustomDomainsDirty(vps)" rows="5" maxlength="32768" spellcheck="false" placeholder="netflix.com&#10;api.example.com&#10;*.example.org" class="w-full resize-y rounded-lg border border-indigo-200 bg-white px-2.5 py-2 font-mono text-xs leading-5 text-slate-700 outline-none focus:border-indigo-400"></textarea>
                                          <div class="mt-1 flex items-center justify-between gap-2 text-[10px] font-bold text-indigo-600"><span>支持根域名和 *.通配写法；切换出口或关闭自定义后仍会保留，但不参与分流</span><span>{{ proxyCustomDomainCount(vps) }} 条</span></div>
                                          <div class="mt-1 text-[10px] font-bold text-amber-600">自定义域名优先级最高，即使对应内置分类未勾选，也会走住宅出口。</div>
                                      </div>
                                      <div class="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-black text-amber-700">⚠ “全局代理”仅覆盖 KUI Agent 管理的节点入站流量，不会接管 VPS 系统默认路由；局部代理仅覆盖所选服务分类。综合分类与具体服务重叠时，未勾选的 YouTube / AI 保持原生直连。</div>
                                      <div class="mt-2 rounded-xl px-3 py-2 text-[10px] font-black" :class="vps.residential_ready ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-rose-200 bg-rose-50 text-rose-700'">
                                          <template v-if="vps.residential_ready">
                                              <div>住宅通道已就绪</div>
                                              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
                                                  <span class="font-sans">当前实时住宅出口：</span>
                                                  <span class="w-full">主 {{ vps.residential_active_exit_ip || '等待就绪' }}</span>
                                                  <span class="w-full">备 {{ vps.residential_standby_exit_ip || '等待就绪' }}</span>
                                              </div>
                                              <div v-if="vps.egress_status === 'applied' && vps.egress_applied_mode === 'residential'" class="mt-2 border-t border-emerald-200 pt-2">
                                                  <span>最近验证：<span class="font-mono break-all">{{ vps.egress_ip || '--' }}</span></span>
                                                  <button @click="refreshVpsEgressIp(vps)" :disabled="egressIpRefreshing[vps.ip]" class="ml-2 text-indigo-500 disabled:opacity-60" aria-label="刷新 VPS 实际出口 IP">{{ egressIpRefreshing[vps.ip] ? '验证中…' : '重新验证' }}</button>
                                                  <div v-if="egressProbeInfo[vps.ip]?.failed" class="mt-1 text-rose-600">验证失败，显示上次结果</div>
                                                  <div v-else-if="egressProbeInfo[vps.ip]?.at" class="mt-1">验证于 {{ new Date(egressProbeInfo[vps.ip].at).toLocaleString() }}</div>
                                                  <div v-if="egressProbeInfo[vps.ip]?.at && vps.egress_ip && vps.residential_active_exit_ip && vps.egress_ip !== vps.residential_active_exit_ip" class="mt-1 text-amber-700">验证结果与当前主出口不同，出口可能已变化</div>
                                              </div>
                                          </template>
                                          <span v-else>住宅通道未就绪：{{ vps.residential_reason || '等待状态上报' }}</span>
                                      </div>
                                  </div>
                                  <div v-if="egressModeOf(vps) === 'socks5'" class="mt-3 space-y-2">
                                      <div class="grid grid-cols-3 gap-2">
                                          <input v-model="vps._socks5_addr" @input="markEgressDirty(vps)" placeholder="地址" class="kui-egress-control col-span-2">
                                          <input v-model.number="vps._socks5_port" @input="markEgressDirty(vps)" placeholder="端口" type="number" class="kui-egress-control">
                                      </div>
                                      <div class="grid grid-cols-2 gap-2">
                                          <input v-model="vps._socks5_user" @input="markEgressDirty(vps)" placeholder="用户名（可选）" class="kui-egress-control">
                                          <input v-model="vps._socks5_pass" @input="markEgressDirty(vps)" :placeholder="vps.socks5_password_set ? '密码（留空保留现有密码）' : '密码（可选）'" type="password" autocomplete="new-password" class="kui-egress-control">
                                      </div>
                                      <label v-if="vps.socks5_password_set" class="flex items-center gap-2 px-1 text-[10px] font-bold text-slate-500"><input v-model="vps._socks5_clear_password" @change="markEgressDirty(vps)" type="checkbox" class="rounded border-slate-300">清除已保存用户名和密码，改为无认证</label>
                                      <div class="flex gap-2 mb-1">
                                          <button @click="setProxyMode(vps, 'socks5', 'global')" :class="{ 'is-active': proxyModeOf(vps) === 'global' }" class="kui-egress-mode-button flex-1">全局代理</button>
                                          <button @click="setProxyMode(vps, 'socks5', 'selective')" :class="{ 'is-active': proxyModeOf(vps) === 'selective' }" class="kui-egress-mode-button flex-1">局部代理</button>
                                      </div>
                                      <div v-if="proxyModeOf(vps) === 'selective'" class="flex flex-wrap gap-1.5 mb-1">
                                          <button v-for="cat in proxyCategoryOptions" :key="cat.key" @click="toggleProxyCategory(vps, cat.key)" :class="{ 'is-active': proxyCategoryActive(vps, cat.key) }" class="kui-egress-category-button">{{ cat.label }}</button>
                                      </div>
                                      <div v-if="proxyModeOf(vps) === 'selective' && proxyCategoryActive(vps, 'custom')" class="mb-2 rounded-xl border border-indigo-200 bg-indigo-50 p-2.5">
                                          <div class="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-black text-indigo-700"><span>自定义代理域名（每行一个）</span><button @click="clearProxyCustomDomains(vps)" class="text-indigo-500 hover:text-indigo-700">清空</button></div>
                                          <textarea v-model="vps._proxy_custom_domains" @input="markProxyCustomDomainsDirty(vps)" rows="5" maxlength="32768" spellcheck="false" placeholder="netflix.com&#10;api.example.com&#10;*.example.org" class="w-full resize-y rounded-lg border border-indigo-200 bg-white px-2.5 py-2 font-mono text-xs leading-5 text-slate-700 outline-none focus:border-indigo-400"></textarea>
                                          <div class="mt-1 flex items-center justify-between gap-2 text-[10px] font-bold text-indigo-600"><span>支持根域名和 *.通配写法；切换出口或关闭自定义后仍会保留，但不参与分流</span><span>{{ proxyCustomDomainCount(vps) }} 条</span></div>
                                          <div class="mt-1 text-[10px] font-bold text-amber-600">自定义域名优先级最高，即使对应内置分类未勾选，也会走 SOCKS5 出口。</div>
                                      </div>
                                      <div class="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-black text-amber-700">⚠ 填写 SOCKS5 代理地址并选择代理范围后，点击下方“应用”统一下发。综合分类与具体服务重叠时，未勾选的 YouTube / AI 保持原生直连。</div>
                                  </div>
                                  <div v-if="egressModeOf(vps) === 'native'" class="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-black text-amber-700">VPS 本机原生网络出口，不经过任何代理或隧道。</div>
                                  <div v-if="egressModeOf(vps).startsWith('warp_')" class="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-black text-amber-700">⚠ WARP、住宅代理和手动 SOCKS5 是互斥的节点出口模式。切换到 WARP 不会停止住宅通道服务，但当前节点流量只使用 WARP。</div>
                                  <div v-if="egressHasDraft(vps)" class="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[10px] font-bold text-indigo-700">
                                      当前生效：{{ egressModeLabel(vps.egress_applied_mode || vps.egress_mode) }}；待应用：{{ egressModeLabel(egressModeOf(vps)) }}
                                  </div>
                                  <div v-if="egressHasDraft(vps)" class="mt-2 flex gap-2">
                                      <button @click="cancelEgressDraft(vps)" :disabled="vps._egress_saving" class="kui-egress-mode-button flex-1 disabled:cursor-not-allowed disabled:opacity-50">取消</button>
                                      <button @click="applyEgressDraft(vps)" :disabled="['pending', 'preparing'].includes(vps.egress_status) || vps._egress_saving" class="kui-egress-mode-button is-active flex-1 disabled:cursor-not-allowed disabled:opacity-50">{{ vps._egress_saving ? '正在应用' : '应用' }}</button>
                                  </div>
                                  <div class="mt-3 text-[10px] font-bold" :class="['pending', 'preparing'].includes(vps.egress_status) ? 'text-amber-500' : (vps.egress_status === 'failed' ? 'text-rose-500' : (vps.egress_status === 'applied' ? 'text-emerald-500' : 'text-slate-500'))">
                                      <span v-if="vps.egress_status === 'pending'">● 正在应用新配置</span>
                                      <span v-else-if="vps.egress_status === 'preparing'">● WARP 环境准备中</span>
                                      <span v-else-if="vps.egress_status === 'applied'">● 配置已同步<span class="ml-1 text-slate-500">· {{ egressModeLabel(vps.egress_applied_mode) }}</span></span>
                                      <span v-else-if="vps.egress_status === 'failed'">● 新配置应用失败，当前配置保持不变</span>
                                      <span v-else>● 等待 VPS 上线后同步</span>
                                      <div v-if="vps.egress_status === 'pending'" class="mt-1 text-slate-500">当前出口：{{ egressModeLabel(vps.egress_applied_mode) }}；目标：{{ egressModeLabel(vps.egress_mode) }}</div>
                                      <div v-else-if="vps.egress_status === 'preparing'" class="mt-1 text-slate-500">首次启用正在后台注册 WARP，住宅通道与当前出口保持运行。</div>
                                      <div v-else-if="vps.egress_status === 'failed'" class="mt-1">当前出口：{{ egressModeLabel(vps.egress_applied_mode) }}；原因：{{ vps.egress_error || '未知错误' }}</div>
                                      <div v-if="vps.egress_status === 'applied'" class="mt-1 flex items-end justify-between gap-3 text-slate-500">
                                          <span v-if="vps.egress_applied_mode !== 'residential'" class="min-w-0 flex flex-1 items-center gap-1">最近验证：<span class="break-all font-mono text-indigo-500">{{ vps.egress_ip || '--' }}</span><button @click="refreshVpsEgressIp(vps)" :disabled="egressIpRefreshing[vps.ip]" class="text-indigo-500 disabled:opacity-60" aria-label="重新验证出口 IP">{{ egressIpRefreshing[vps.ip] ? '验证中…' : '重新验证' }}</button></span>
                                          <span class="ml-auto whitespace-nowrap font-mono text-slate-400">版本 {{ vps.egress_applied_revision || 0 }}</span>
                                      </div>
                                      <div v-else-if="['pending', 'preparing'].includes(vps.egress_status)" class="mt-1 font-mono text-slate-400">版本 {{ vps.egress_applied_revision || 0 }} → {{ vps.egress_revision || 0 }}</div>
                                      <div v-else class="mt-1 font-mono text-slate-400">当前版本 {{ vps.egress_applied_revision || 0 }}，目标版本 {{ vps.egress_revision || 0 }}</div>
                                  </div>
                                  <button v-if="!egressHasDraft(vps) && !['pending', 'preparing'].includes(vps.egress_status) && (vps.egress_status === 'failed' || Number(vps.egress_revision || 0) !== Number(vps.egress_applied_revision || 0))" @click="forceReapplyEgress(vps)" class="kui-egress-retry mt-2 w-full">重新下发当前出口配置</button>
                              </div>
                          </div>

                          <details class="kui-server-tools">
                              <summary><span>配置与节点管理</span><small>{{ getNodesByIp(vps.ip).length }} 个节点</small></summary>
                              <div class="px-6 md:px-8 pb-4">
                              <div v-if="vps.config_result?.component === 'config'" class="mb-3 rounded-xl border px-4 py-3 text-xs font-bold" :class="vps.config_result.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'">
                                  <span v-if="vps.config_result.success">● 最近节点配置已在 VPS 生效</span>
                                  <span v-else>● 最近节点配置应用失败：{{ vps.config_result.error || '未知错误，VPS 保留原配置' }}</span>
                              </div>
                              <div class="kui-quick-deploy-panel">
                                  <div class="kui-node-panel-heading"><div><strong>极速 9 合 1</strong><span>按起始端口连续创建 9 个协议节点</span></div><small>QUICK</small></div>
                                  <div class="kui-quick-deploy-grid">
                                      <label><span>归属用户 <b class="kui-required">*</b></span><select v-model="batchUser[vps.ip]" required><option value="admin">管理员自身</option><option v-for="u in users" :value="u.username">{{ u.username }}</option></select></label>
                                      <label><span>起始端口 <b class="kui-required">*</b> <em>建议 8881</em></span><input v-model="batchStartPort[vps.ip]" type="number" min="10" max="65527" placeholder="8881" required></label>
                                      <button @click="deployAllProtocols(vps.ip)">批量下发</button>
                                  </div>
                              </div>

                              <div class="kui-node-deploy-panel">
                                  <div class="kui-node-panel-heading"><div><strong>添加单节点</strong><span>按协议填写必要参数</span></div><small><b class="kui-required">*</b> 必填</small></div>
                                  <div class="kui-node-form-grid kui-node-form-primary">
                                      <label><span>归属用户 <b class="kui-required">*</b></span><select v-model="newNodeParams[vps.ip].username" required><option value="admin">管理员自身</option><option v-for="u in users" :value="u.username">{{ u.username }}</option></select></label>
                                      <label><span>协议 <b class="kui-required">*</b></span><select v-model="newNodeParams[vps.ip].protocol" required><option value="AnyTLS">AnyTLS</option><option value="gRPC-Reality">gRPC + Reality</option><option value="H2-Reality">H2 + Reality</option><option value="Hysteria2">Hysteria2</option><option value="Naive">Naive</option><option value="Shadowsocks2022">Shadowsocks 2022</option><option value="Socks5">SOCKS5</option><option value="Trojan">Trojan</option><option value="TUIC">TUIC v5</option><option value="VLESS">VLESS</option><option value="XTLS-Reality">XTLS + Reality</option><option disabled>──────────</option><option value="VLESS-Argo">VLESS Argo</option><option value="dokodemo-door">Dokodemo</option><option value="MTProxy">MTProxy</option></select></label>
                                      <label class="is-port"><span>端口 <b class="kui-required">*</b></span><input v-model="newNodeParams[vps.ip].port" type="number" min="1" max="65535" placeholder="443" required></label>
                                  </div>
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
                                  <button @click="addNode(vps.ip)" :disabled="addingNode[vps.ip]" class="kui-node-submit">{{ addingNode[vps.ip] ? '正在添加…' : '添加节点' }}</button>
                              </div>
                              </div>
                          </details>

                          <div class="kui-node-list-section p-6 md:p-8 bg-slate-50/50 border-t border-white flex-1">
                              <details v-for="node in getNodesByIp(vps.ip)" :key="node.id" class="kui-node-card mb-3">
                                  <summary class="kui-node-summary">
                                      <span class="kui-node-summary-protocol">{{ node.protocol }}</span>
                                      <span class="kui-node-summary-user">👤 {{ node.username }}</span>
                                      <span class="kui-node-summary-traffic">已用流量 {{ formatBytes(node.traffic_used) }}</span>
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
                              <div v-if="getNodesByIp(vps.ip).length === 0" class="text-center text-slate-400 text-xs py-6 border-2 border-dashed border-slate-200 rounded-2xl font-medium">节点矩阵为空，请在上方一键下发建立</div>
                          </div>
                      </div>
                  </div>
              </div>
</template>

<script>
import { inject } from 'vue';
import { KUI_KEY } from '../app/context.js';
import { buildNodeDetailRows } from '../utils/nodeDetails.js';

export default {
  setup() {
    return { ...inject(KUI_KEY), buildNodeDetailRows };
  },
};
</script>
