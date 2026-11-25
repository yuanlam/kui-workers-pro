<template>
  <div v-if="isLoggedIn && role === 'admin' && activeTab === 'proxy'" class="pc-body min-h-screen relative overflow-x-hidden selection:bg-indigo-500/30">
                  <div class="fixed top-[-20%] left-[-10%] w-[50%] h-[50%] bg-indigo-600/20 blur-[120px] rounded-full pointer-events-none z-0"></div>
                  <div class="fixed bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none z-0"></div>

                  <div class="max-w-7xl mx-auto p-6 relative z-10">
                      <div class="pc-page-intro">
                          <div><h2>双通道住宅出口</h2><p>管理候选地区、主备隧道与出口质量。</p></div>
                      </div>

                      <div class="pc-section-stack">
                          <div class="pc-panel pc-country-panel bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl p-5 shadow-xl shadow-black/20">
                              <div class="flex items-center gap-2 mb-3">
                                  <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                              <h2 class="text-lg font-bold text-slate-200">国家代码与候选节点</h2>
                          </div>
                              <p class="text-xs text-slate-500 mb-3 leading-relaxed">数量来自 VPN Gate 当前可见节点，仅代表可尝试的候选池，不等于已建立的住宅隧道。点击代码可填入目标地区。</p>
                              <div id="countries-list" class="pc-country-list flex flex-wrap content-start gap-1.5 pr-1">
                                  <span class="text-slate-600 text-sm animate-pulse">正在同步数据库...</span>
                              </div>
                          </div>

                          <div class="pc-panel pc-scheduler-panel bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl p-5 shadow-xl shadow-black/20 flex flex-col justify-center relative overflow-hidden">
                              <div class="absolute top-0 right-0 p-6 opacity-5 pointer-events-none">
                                  <svg class="w-32 h-32" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                              </div>

                              <div class="mb-4 relative z-10">
                                  <h2 class="text-xl font-bold text-slate-100 tracking-wide mb-1 flex items-center gap-2">主备双活调度引擎 <span class="bg-indigo-500/20 text-indigo-400 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border border-indigo-500/30">Active-Standby</span></h2>
                                  <p class="text-xs text-slate-400">单路端口锁定，内置主备双路隧道 (tun_main / tun_backup)，通道死活将由软开关瞬间接管。</p>
                              </div>

                              <div class="flex flex-wrap items-center bg-slate-950/50 border border-slate-800/80 rounded-xl p-4 relative z-10 gap-y-3">
                                  <div class="flex items-center gap-3 mr-3 border-r border-slate-700/50 pr-4">
                                      <span class="text-slate-400 text-sm font-medium whitespace-nowrap">目标 VPS:</span>
                                      <select id="slot-target-ip" @change="pcInvalidateLoadedConfig(); pcLoadConfig(); pcFetchNodes()" class="bg-slate-900 border border-slate-700 rounded-lg py-2 px-3 w-52 sm:w-64 max-w-full text-white font-mono text-sm focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 outline-none transition-all shadow-inner"></select>
                                  </div>
                                  <div class="flex items-center gap-3 mr-3 border-r border-slate-700/50 pr-4">
                                      <span class="text-slate-400 text-sm font-medium whitespace-nowrap">目标地区:</span>
                                      <input type="text" id="slot-cfg-0" value="JP" maxlength="3" class="bg-slate-900 border border-slate-700 rounded-lg py-2 w-16 text-white font-bold text-lg uppercase text-center focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 outline-none transition-all shadow-inner" placeholder="US / ANY" title="输入 2 位国家码，或输入 ANY 自动优选全球最快节点" autocomplete="off" />
                                  </div>

                                  <div class="flex items-center gap-3 mr-4">
                                      <span class="text-slate-400 text-sm font-medium whitespace-nowrap">服务端口:</span>
                                      <input type="number" id="slot-port" value="7920" min="1024" max="65535" class="bg-slate-900 border border-slate-700 rounded-lg py-2 w-24 text-white font-bold text-lg text-center focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 outline-none transition-all shadow-inner" placeholder="7920" />
                                  </div>

                                  <div class="flex items-center gap-3 mr-4">
                                      <span class="text-slate-400 text-sm font-medium whitespace-nowrap">监听地址:</span>
                                      <input type="text" id="slot-listen-host" value="" maxlength="15" class="bg-slate-900 border border-slate-700 rounded-lg py-2 w-36 text-white font-mono text-sm text-center focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 outline-none transition-all shadow-inner" placeholder="172.17.0.1 / *" title="填写 Docker 网桥 IPv4、*（公网监听）或留空" />
                                  </div>

                                  <button @click="pcSaveConfig" class="group relative px-6 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-bold shadow-lg shadow-blue-900/20 hover:shadow-indigo-900/40 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden ml-auto">
                                      <div class="absolute inset-0 bg-white/20 group-hover:translate-x-full -translate-x-full transform transition-transform duration-300 ease-in-out skew-x-12"></div>
                                      <span class="flex items-center gap-2">
                                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path></svg>
                                          下发策略
                                      </span>
                                  </button>

                                  <div class="h-8 w-px bg-slate-800 mx-2 hidden sm:block"></div>

                                  <button @click="pcSwitchIP('hot')" title="秒级热切至已预热备用隧道" class="group relative px-5 py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 text-white text-sm font-bold shadow-lg shadow-purple-900/20 hover:shadow-pink-900/40 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden">
                                      <div class="absolute inset-0 bg-white/20 group-hover:translate-x-full -translate-x-full transform transition-transform duration-300 ease-in-out skew-x-12"></div>
                                      <span class="flex items-center gap-2">
                                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                          切换 IP
                                          <span class="rounded-full border border-white/20 bg-white/10 px-1.5 py-0.5 text-[9px] font-black tracking-wider">HOT</span>
                                      </span>
                                  </button>

                                  <button @click="pcSwitchIP('full')" title="清空现有通道并重新拉取测速" class="group relative px-5 py-2.5 rounded-lg border border-slate-600 bg-slate-800 text-slate-200 text-sm font-bold hover:border-amber-500/60 hover:bg-slate-700 hover:text-amber-300 transition-all duration-200 overflow-hidden">
                                      <span class="flex items-center gap-2">
                                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v6h6M20 20v-6h-6M5.07 15A8 8 0 0019 9M18.93 9A8 8 0 005 15"></path></svg>
                                          全量重拨
                                          <span class="rounded-full border border-slate-500/50 bg-slate-900/60 px-1.5 py-0.5 text-[9px] font-black tracking-wider text-slate-400">FULL</span>
                                      </span>
                                  </button>
                              </div>
                          </div>

                      <div class="pc-panel pc-node-matrix bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-xl overflow-hidden shadow-black/20">
                          <div class="px-5 py-3 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
                              <h3 class="font-semibold text-slate-200 flex items-center gap-2">
                                  <div class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse"></div>
                                  活跃节点矩阵
                              </h3>
                          </div>
                          <div class="overflow-x-auto">
                              <table class="w-full text-left border-collapse">
                                  <thead>
                                      <tr class="bg-slate-900/80 text-slate-400 text-xs uppercase tracking-wider">
                                          <th class="py-3 px-4 font-medium">主机名</th>
                                          <th class="py-3 px-4 font-medium">IP</th>
                                          <th class="py-3 px-4 font-medium w-24">心跳</th>
                                          <th class="py-3 px-4 font-medium w-16">通道</th>
                                          <th class="py-3 px-4 font-medium">主备出口</th>
                                          <th class="py-3 px-4 font-medium w-32">状态</th>
                                      </tr>
                                  </thead>
                                  <tbody id="pc-nodes-table" class="divide-y divide-slate-800/50 text-sm">
                                      <tr><td colspan="6" class="py-12 text-center text-slate-500">正在与 D1 数据库建立量子纠缠...</td></tr>
                                  </tbody>
                              </table>
                          </div>
                          <div id="pc-purity-attribution" style="display: none;" class="px-5 py-2 border-t border-slate-800/80 bg-slate-900/40 text-[11px] text-slate-400">
                              出口纯净度与风险数据参考 IPPure / <a href="https://ipok.io" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300 underline decoration-indigo-400/50">IPOK</a>
                          </div>
                      </div>

                      <div id="pc-ip-score-section" style="display: none;" class="pc-panel pc-score-panel bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-xl overflow-hidden shadow-black/20">
                          <div class="px-5 py-3 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
                              <h3 class="font-semibold text-slate-200 flex items-center gap-2">
                                  <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                                  原生深度质检报告 (testisp.info)
                              </h3>
                              <a id="pc-ip-score-link" href="#" class="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors">
                                  原版页面 <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                              </a>
                          </div>

                          <div id="pc-native-score-container" class="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 bg-[#090E17]">
                              <div class="col-span-full py-16 flex flex-col items-center justify-center text-slate-500">
                                  <svg class="animate-spin h-8 w-8 text-indigo-500 mb-4" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                  <span>穿透请求中，正在构建原生质检报告...</span>
                              </div>
                          </div>
                      </div>

                      <div class="pc-panel pc-log-panel bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-xl overflow-hidden shadow-black/20">
                          <div class="px-4 py-3 border-b border-slate-800 bg-slate-900/80 flex justify-between items-center">
                              <span class="text-xs text-slate-400 font-mono flex items-center gap-2">
                                  <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M4 17h16a2 2 0 002-2V5a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                                  VPS 实时运行日志 (Auto-Sync)
                              </span>
                              <span class="flex gap-1.5">
                                  <div class="w-3 h-3 rounded-full bg-rose-500/80 shadow-[0_0_5px_rgba(244,63,94,0.5)]"></div>
                                  <div class="w-3 h-3 rounded-full bg-amber-500/80 shadow-[0_0_5px_rgba(245,158,11,0.5)]"></div>
                                  <div class="w-3 h-3 rounded-full bg-emerald-500/80 shadow-[0_0_5px_rgba(16,185,129,0.5)]"></div>
                              </span>
                          </div>
                          <div class="p-4 h-64 overflow-y-auto bg-[#0D1117] pc-font-mono text-[13px] leading-relaxed text-slate-300" id="pc-terminal-output">
                              <div class="text-slate-500 animate-pulse">等待 VPS 心跳回传日志数据...</div>
                          </div>
                      </div>
                      </div>
                  </div>
              </div>
</template>

<script>
import { inject } from 'vue';
import { KUI_KEY } from '../app/context.js';
import { pcFetchNodes, pcInvalidateLoadedConfig, pcLoadConfig, pcSaveConfig, pcSwitchIP } from '../proxy/legacyProxy.js';

export default {
  setup() {
    return { ...inject(KUI_KEY), pcFetchNodes, pcInvalidateLoadedConfig, pcLoadConfig, pcSaveConfig, pcSwitchIP };
  },
};
</script>
