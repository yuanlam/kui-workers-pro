import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { pcFetchNodes, pcInitProxy, pcStopProxy } from '../proxy/legacyProxy.js';
import { createApiClient } from './useApi.js';
import { generateRealityKeys, generateSs2022Password } from './useAuth.js';
import { countryCoords, iso2To3 } from './useProbe.js';
import { nextRealtimeRetryDelay, normalizeRealtimeKey } from './useRealtime.js';
import { applyEgressProbeResult, applyEgressRealtimeResult, mergeServerRealtimeTelemetry, resolveCurrentServer, shouldSuggestWarpOptimization } from '../utils/egressState.js';


export function useKuiState() {
                  const isLoggedIn = ref(false); const showLoginModal = ref(false); 
                  const loginUser = ref(''); const password = ref(''); const loginPending = ref(false);
                  localStorage.removeItem('kui_auth_key'); localStorage.removeItem('kui_user'); localStorage.removeItem('kui_role');
                  const currentUser = ref(sessionStorage.getItem('kui_user') || ''); const authKey = ref(sessionStorage.getItem('kui_auth_key') || ''); const role = ref(sessionStorage.getItem('kui_role') || '');
                  const preferredTab = localStorage.getItem('monitor_preferred_tab') || 'probe';
                  const activeTab = ref(['services', 'realm'].includes(preferredTab) ? (role.value === 'admin' ? 'nodes' : 'dashboard') : preferredTab);
                  const savedColorMode = localStorage.getItem('kui_color_mode');
                  const colorMode = ref(['system', 'light', 'dark'].includes(savedColorMode) ? savedColorMode : 'system');
                  const systemColorQuery = window.matchMedia('(prefers-color-scheme: dark)');
                  const systemPrefersDark = ref(systemColorQuery.matches);
                  const effectiveColorMode = computed(() => colorMode.value === 'system' ? (systemPrefersDark.value ? 'dark' : 'light') : colorMode.value);
                  const applyColorMode = () => {
                      document.documentElement.dataset.kuiTheme = effectiveColorMode.value;
                      document.documentElement.style.colorScheme = effectiveColorMode.value;
                  };
                  const syncSystemColor = event => { systemPrefersDark.value = event.matches; };
                  systemColorQuery.addEventListener('change', syncSystemColor);
                  onBeforeUnmount(() => systemColorQuery.removeEventListener('change', syncSystemColor));
                  applyColorMode();
                  const currentDomain = window.location.origin;

                  const servers = ref([]); const nodes = ref([]); const users = ref([]); const groups = ref([]); const securityWarnings = ref([]);
                  const trafficTotals = ref({}); const trafficSeries = ref({});
                  let trafficFetchPromise = null; let trafficStatsLastFetchedAt = 0;
                  const addingVps = ref(false);
                  const proxyCredentialsReady = ref(false); const proxyPublicListenerManageable = ref(true); const publicListenerSaving = reactive({});
                  const realtimeUrl = ref('');
                  const realtimeConnected = ref(false);
                  const refreshing = ref(false);
                  let realtimeSocket = null; let realtimeReconnectTimer = null; let realtimeFallbackTimer = null; let realtimeConnectTimer = null; let realtimePingTimer = null; let realtimeGeneration = 0; let realtimeDisconnectedAt = 0; let lastRealtimePing = 0; let realtimeRetryDelay = 5000;
                  let publicRealtimeSocket = null; let publicRealtimeReconnectTimer = null; let publicRealtimeFallbackTimer = null; let publicRealtimeConnectTimer = null; let publicRealtimeActivityTimer = null; let publicRealtimeDisconnectedAt = 0; let publicRealtimeRetryDelay = 10000;
                  const newVps = ref({ name: '', ip: '', os: 'debian' }); const newNodeParams = reactive({}); const nodeEditDrafts = reactive({}); const addingNode = reactive({}); const newUser = reactive({ username: '', password: '', traffic_limit_gb: '', expire_date: '' }); const newGroupName = ref(''); const groupDrafts = reactive({});
                  const mySubToken = ref(''); const siteTitle = ref(''); const siteTitleInput = ref(''); const userNewPassword = ref('');
                  const siteTitleDirty = ref(false); const probeSettingsDirty = ref(false);
                  const siteTitleSaving = ref(false); const probeSettingsSaving = ref(false); const subscriptionProtectionSaving = ref(false);
                  const subTokenResetting = ref(false); const passwordSaving = ref(false); const githubNodesPulling = ref(false);
                  const batchStartPort = reactive({}); const batchUser = reactive({}); 
                  const thirdPartySubscriptions = ref([]); const newThirdParty = reactive({ name: '', url: '' }); const loadingThirdParty = ref(false);
                  
                  let initOsMap = {}; try { initOsMap = JSON.parse(localStorage.getItem('kui_deploy_os') || '{}'); } catch(e) {}
                  const deployOsMap = reactive(initOsMap);
                  const egressIpRefreshing = reactive({});
                  const egressRefreshRequests = reactive({});
                  const egressRefreshTimers = new Map();
                  const egressRefreshSilent = new Map();
                  const egressAutoRefreshMarkers = new Map();
                  const warpTargetIp = ref('');
                  const warpSelectedCandidate = ref('');
                  const warpActionPending = ref(false);

                  // --- 动态拉取核心 ---
                  const availableThemes = ref([
                      { id: "theme1", name: "1. 默认清爽白 (Classic)", is_dark: false, css: "" },
                      { id: "theme2", name: "2. 暗黑极客 (Dark)", is_dark: true, css: "" },
                      { id: "theme3", name: "3. 新粗野主义 (Brutalism)", is_dark: false, css: "" },
                      { id: "theme4", name: "4. 动态渐变毛玻璃 (Glass)", is_dark: true, css: "" },
                      { id: "theme5", name: "5. 赛博朋克 (Cyberpunk)", is_dark: true, css: "" },
                      { id: "theme6", name: "6. 完全自定义 CSS", is_dark: true, has_custom_css: true, css: "" }
                  ]);
                  const pingNodes = reactive({ ct: [], cu: [], cm: [] });

                  const probeSys = reactive({ theme: 'theme1', is_public: 'false', subscription_protection: 'true', site_title: 'Server Monitor Pro', custom_bg: '', custom_css: '', report_interval: '5', realtime_admin_interval: '5', realtime_public_interval: '10', realtime_idle_interval: '30', visits_total: '0', visits_today: '0', ping_node_ct: 'default', ping_node_cu: 'default', ping_node_cm: 'default', enable_popup: 'false', popup_content: '', tg_notify: 'false', tg_bot_token: '', tg_chat_id: '' });
                  const FALLBACK_DATA_INTERVAL = 15000;
                  const FALLBACK_PROBE_INTERVAL = 30000;
                  const FALLBACK_UI_PING_INTERVAL = 60000;
                  const publicProbeServers = ref([]);
                  const probeView = ref(localStorage.getItem('monitor_preferred_view') || 'card');
                  const probeDetailId = ref(null); const probeDetail = ref({});
                  let probeCharts = {};
                  const currentFilter = ref('all');

                  const adminProbeServers = ref([]);
                  const probeEditModalOpen = ref(false); const editingProbeNode = ref({});
                  
                  const qrModalOpen = ref(false);
                  const qrCodeImage = ref('');
                  
                  const showWelcomePopup = ref(false);

                  watch(activeTab, (val) => { localStorage.setItem('monitor_preferred_tab', val); if (val === 'proxy' && isLoggedIn.value) { loadProxyPool(); setTimeout(pcInitProxy, 0); } else { pcStopProxy(); } if (val === 'nodes' && isLoggedIn.value && role.value === 'admin') loadTrafficStats(true); if (val === 'warp' && !warpTargetIp.value && servers.value.length) warpTargetIp.value = servers.value[0].ip; if (val === 'warp' && realtimeSocket?.readyState === WebSocket.OPEN) realtimeSocket.send(JSON.stringify({ type: 'resync' })); if (val === 'thirdparty') loadThirdPartySubscriptions(); if (val === 'settings' && isLoggedIn.value && role.value === 'admin') loadAdminProbeServers(); if (val === 'probe') updateCustomStyles(); else { document.body.className = ''; document.getElementById('kui-custom-styles')?.remove(); } });
                  watch(colorMode, (val) => localStorage.setItem('kui_color_mode', val));
                  watch(effectiveColorMode, applyColorMode);
                  watch(probeView, (val) => localStorage.setItem('monitor_preferred_view', val));
                  watch(warpTargetIp, () => { warpSelectedCandidate.value = ''; });

                  const hasCustomCssFlag = computed(() => {
                      const t = availableThemes.value.find(x => x.id === probeSys.theme);
                      return t ? t.has_custom_css : false;
                  });

                  const parseCachedNodes = (dataStr) => {
                      if (!dataStr) return;
                      try {
                          const parsed = JSON.parse(dataStr);
                          if (parsed.themes && Array.isArray(parsed.themes)) availableThemes.value = parsed.themes;
                          if (parsed.ct) pingNodes.ct = parsed.ct;
                          if (parsed.cu) pingNodes.cu = parsed.cu;
                          if (parsed.cm) pingNodes.cm = parsed.cm;
                      } catch(e) {}
                  };

                  const themeCompatibilityCss = `
  /* KUI compatibility layer for legacy cloud preset themes. */
  body.theme2 .probe-body, body.theme5 .probe-body, body.theme7 .probe-body, body.theme10 .probe-body, body.theme15 .probe-body, body.theme18 .probe-body { color: #e5e7eb; }
  body.theme8 .probe-body { color: #fff; }
  body.theme11, body.theme13, body.theme14, body.theme15, body.theme18 { position: relative; isolation: isolate; }
  body.theme11::before, body.theme13::before, body.theme14::before, body.theme15::before, body.theme18::before { z-index: 0 !important; }
  body.theme11 #app, body.theme13 #app, body.theme14 #app, body.theme15 #app, body.theme18 #app { position: relative; z-index: 1; }
  .theme2 .item-right-bag { border-top-color: #27272a !important; }
  .theme4 .global-stats, .theme12 .global-stats { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
  .theme4 .probe-header-card, .theme4 .probe-chart-card { background: rgba(255,255,255,.78) !important; color: #1d1d1f !important; }
  .theme5 .item-title { max-width: calc(100% + 2px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .theme7 .probe-header-card, .theme7 .probe-chart-card, .theme15 .probe-header-card, .theme15 .probe-chart-card, .theme18 .probe-header-card, .theme18 .probe-chart-card { background: rgba(10,10,12,.72) !important; border: 1px solid rgba(255,255,255,.12) !important; color: #fff !important; }
  .theme8 .ping-box { justify-content: center !important; }
  .theme8 .stat-subtext, .theme8 .item-sysinfo, .theme8 .item-speed { color: rgba(255,255,255,.82) !important; }
  .theme8 .probe-header-card, .theme8 .probe-chart-card { background: rgba(255,255,255,.16) !important; border-color: rgba(255,255,255,.3) !important; color: #fff !important; }
  .theme12 .card-meta-list, .theme13 .card-meta-list { display: contents !important; }
  .theme12 .probe-header-card, .theme12 .probe-chart-card { background: #fdfcf9 !important; border: 1px solid #eaddcf !important; box-shadow: 0 4px 6px rgba(0,0,0,.02) !important; color: #5d5449 !important; }
  .theme12 .item-sysinfo { grid-area: sysinfo; }
  .theme12 .item-meta-price, .theme12 .item-badges { display: none !important; }
  .theme12 .item-status.is-online { background: #6da183 !important; }
  .theme12 .item-status.is-offline { background: #d66b6b !important; }
  .theme12 .item-title.is-online::after { content: 'ONLINE' !important; color: #6da183 !important; }
  .theme12 .item-title.is-offline::after { content: 'OFFLINE' !important; color: #d66b6b !important; }
  .theme13 .item-ping { display: contents; }
  .theme13 .probe-header-card, .theme13 .probe-chart-card { background: rgba(255,255,255,.75) !important; border-color: rgba(255,255,255,.5) !important; color: #222 !important; }
  .theme14 .probe-header-card, .theme14 .probe-chart-card, .theme17 .probe-header-card, .theme17 .probe-chart-card { background: rgba(255,255,255,.7) !important; border: 1px solid rgba(255,255,255,.75) !important; color: #333 !important; }
  .theme16 .card-right { display: flex !important; flex-flow: row wrap !important; justify-content: center !important; }
  .theme16 .stat-group { flex: 0 1 30% !important; }
  .theme16 .probe-header-card, .theme16 .probe-chart-card { background: rgba(255,255,255,.88) !important; color: #111 !important; }
  .theme17 .card-meta-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 16px; padding-top: 16px; border-top: 1px dashed #e5e7eb; }
  .theme17 .card-meta-list .card-meta { display: block !important; margin: 0 !important; padding: 0 !important; border: 0 !important; }
  .theme18 .probe-card-meta, .theme18 .probe-stat-subtext, .theme18 .item-sysinfo, .theme18 .item-speed { color: rgba(230,255,239,.78) !important; }
  .theme15 .probe-info-label, .theme15 .info-value, .theme18 .probe-info-label, .theme18 .info-value { color: rgba(255,255,255,.82) !important; }
  @media (max-width: 640px) {
    .theme4 .global-stats, .theme12 .global-stats { grid-template-columns: 1fr !important; }
    .theme7 .vps-card { flex-direction: column !important; }
    .theme7 .item-left-bag { flex: auto !important; width: 100% !important; margin: 0 0 8px !important; padding: 0 0 8px !important; border-right: 0 !important; border-bottom: 1px solid #333 !important; }
    .theme7 .item-right-bag { width: 100% !important; display: flex !important; flex-direction: column !important; gap: 8px !important; }
    .theme9 .vps-card { grid-template-columns: 1fr !important; gap: 12px !important; }
    .theme9 .item-right-bag { border-left: 0 !important; border-top: 2px solid #e9e9e7 !important; padding: 12px 0 0 !important; }
    .theme10 .vps-card { flex-direction: column !important; }
    .theme10 .item-left-bag { border-left: 0 !important; border-top: 2px dashed #8b6914 !important; padding: 12px 0 0 !important; }
    .theme11 .vps-card { min-height: 0 !important; }
    .theme11 .item-left-bag, .theme11 .item-right-bag { float: none !important; width: 100% !important; }
    .theme11 .item-ping { position: static !important; width: auto !important; margin-top: 12px; }
    .theme14 .card-right { grid-template-columns: 1fr !important; }
    .theme16 .stat-group { flex-basis: 45% !important; }
  }
  `;

                  const updateCustomStyles = () => {
                      if (isLoggedIn.value && activeTab.value !== 'probe') return;
                      document.body.className = probeSys.theme || 'theme1';

                      let styleTag = document.getElementById('kui-custom-styles');
                      if (!styleTag) { styleTag = document.createElement('style'); styleTag.id = 'kui-custom-styles'; document.head.appendChild(styleTag); }
                      
                      const currentTheme = availableThemes.value.find(t => t.id === probeSys.theme) || availableThemes.value[0];
                      let css = '';
                      if (currentTheme && currentTheme.css) css += currentTheme.css + '\n';
                      css += themeCompatibilityCss;
                      
                      if (probeSys.custom_css && (probeSys.theme === 'theme6' || (currentTheme && currentTheme.has_custom_css))) {
                          css += probeSys.custom_css + '\n';
                      }

                      if (probeSys.custom_bg) css += `body { background: url('${probeSys.custom_bg}') no-repeat center center fixed !important; background-size: cover !important; } .probe-vps-card, .probe-global-stats, .probe-header-card, .probe-chart-card, .probe-custom-table, .probe-filter-tag, .probe-view-controls { background: rgba(255, 255, 255, 0.4) !important; backdrop-filter: blur(12px) !important; -webkit-backdrop-filter: blur(12px) !important; border: 1px solid rgba(255, 255, 255, 0.6) !important; box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.1) !important; color: #111 !important; } .probe-vps-card:hover { background: rgba(255, 255, 255, 0.6) !important; transform: translateY(-3px); } .probe-group-header { color: #fff !important; text-shadow: 0 2px 5px rgba(0,0,0,0.6) !important; border-left-color: #fff !important; } .probe-g-val, .probe-card-title { color: #000 !important; font-weight: 800 !important; } .probe-g-label, .probe-g-sub, .probe-card-meta { color: #333 !important; font-weight: 600 !important; } .probe-stat-bar-full { background: rgba(0,0,0,0.1) !important; }`;
                      styleTag.textContent = css;

                  };

                  watch(() => probeSys.theme, updateCustomStyles);
                  watch(() => probeSys.custom_css, updateCustomStyles);
                  watch(() => probeSys.custom_bg, updateCustomStyles);

                  const isOnline = (lastReport, realtimeState = '') => realtimeState ? realtimeState === 'online' : !!lastReport && (Date.now() - lastReport) < 1200000;
                  const formatBytes = (bytes) => { const b = parseInt(bytes); if (isNaN(b) || b === 0) return '0 B'; const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(b) / Math.log(k)); return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]; };
                  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
                  const formatDate = (ts) => { if (!ts) return '永久'; const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
                  const getExpireText = (dateStr) => { if(!dateStr) return '永久'; const d = new Date(dateStr).getTime(); if(isNaN(d)) return '永久'; const diff = d - Date.now(); return diff > 0 ? Math.ceil(diff/86400000) + '天' : '已过期'; };
                  const getTrafficPercent = (used, limit) => { if (!limit || limit === 0) return 0; return Math.min((used / limit) * 100, 100); };
                  const getPingColor = (ping) => { const p = parseInt(ping); if (p === 0 || isNaN(p)) return '#9ca3af'; if (p < 100) return '#10b981'; if (p < 200) return '#f59e0b'; return '#ef4444'; };

                  const globalOnline = computed(() => servers.value.filter(s => isOnline(s.last_report, s.realtime_state)).length);
                  const globalTraffic = computed(() => Object.values(trafficTotals.value).reduce((sum, total) => sum + (Number(total) || 0), 0));
                  const globalSpeedIn = computed(() => servers.value.reduce((sum, s) => sum + (parseFloat(s.net_in_speed) || 0), 0));
                  const globalSpeedOut = computed(() => servers.value.reduce((sum, s) => sum + (parseFloat(s.net_out_speed) || 0), 0));

                  const filteredProbeServers = computed(() => {
                      if (currentFilter.value === 'all') return publicProbeServers.value;
                      return publicProbeServers.value.filter(s => {
                          let c = (s.country || 'xx').toUpperCase();
                          if (c === 'TW') c = 'CN';
                          return c === currentFilter.value;
                      });
                  });

                  const probeGlobalOnline = computed(() => publicProbeServers.value.filter(s => isOnline(s.last_updated, s.realtime_state)).length);
                  const probeGlobalOffline = computed(() => publicProbeServers.value.length - probeGlobalOnline.value);
                  const probeGlobalSpeedIn = computed(() => publicProbeServers.value.reduce((sum, s) => sum + (parseFloat(s.net_in_speed)||0), 0));
                  const probeGlobalSpeedOut = computed(() => publicProbeServers.value.reduce((sum, s) => sum + (parseFloat(s.net_out_speed)||0), 0));
                  const probeGlobalNetRx = computed(() => publicProbeServers.value.reduce((sum, s) => sum + (parseFloat(s[probeSys.auto_reset_traffic === 'true' ? 'monthly_rx' : 'net_rx'])||0), 0));
                  const probeGlobalNetTx = computed(() => publicProbeServers.value.reduce((sum, s) => sum + (parseFloat(s[probeSys.auto_reset_traffic === 'true' ? 'monthly_tx' : 'net_tx'])||0), 0));
                  
                  const filteredProbeGroups = computed(() => { 
                      const groups = {}; 
                      filteredProbeServers.value.forEach(s => { const g = s.server_group || '默认分组'; if(!groups[g]) groups[g] = []; groups[g].push(s); }); 
                      return groups; 
                  });

                  const probeCountryStats = computed(() => { const stats = {}; publicProbeServers.value.forEach(s => { let code = (s.country || 'xx').toUpperCase(); if(code === 'TW') code = 'CN'; if(code !== 'XX') stats[code] = (stats[code] || 0) + 1; }); return stats; });

                  let authGeneration = 0;
                  const fetchApi = createApiClient({
                      getSession: () => ({ generation: authGeneration, user: currentUser.value, key: authKey.value }),
                      isSessionCurrent: session => session.generation === authGeneration && session.user === currentUser.value,
                      onMutation: targetIp => notifyRealtime(targetIp),
                      onUnauthorized: () => logout(),
                  });
                  const openProxyList = async () => {
                      const popup = window.open('', '_blank');
                      if (!popup) return alert('浏览器阻止了新窗口，请允许本站打开弹窗');
                      try {
                          const response = await fetchApi('/api/proxy/proxies');
                          const text = await response.text();
                          popup.document.title = 'KUI Proxy List';
                          const pre = popup.document.createElement('pre');
                          pre.textContent = text;
                          popup.document.body.replaceChildren(pre);
                      } catch (error) {
                          popup.close();
                      }
                  };
                  window.kuiAdminAuthHeader = async () => {
                      if (!authKey.value || !currentUser.value || role.value !== 'admin') return {};
                      return { 'Authorization': `Bearer ${authKey.value}` };
                  };
                  window.kuiManagedServers = () => servers.value.map(server => ({ name: String(server.name || '').trim(), ip: server.ip })).filter(server => server.ip);
                  window.kuiManagedServerIps = () => servers.value.map(server => server.ip).filter(Boolean);

                  const login = async () => {
                      if (loginPending.value) return;
                      if (!loginUser.value) loginUser.value = 'admin';
                      loginPending.value = true;
                      try {
                          const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: loginUser.value, password: password.value }), signal: AbortSignal.timeout(15000) });
                          if (res.ok) {
                              authGeneration++;
                              const data = await res.json(); authKey.value = data.token; currentUser.value = loginUser.value; role.value = data.role;
                              sessionStorage.setItem('kui_auth_key', authKey.value); sessionStorage.setItem('kui_user', currentUser.value); sessionStorage.setItem('kui_role', role.value);
                              isLoggedIn.value = true; showLoginModal.value = false; password.value = ''; const publicSocket = publicRealtimeSocket; publicRealtimeSocket = null; publicSocket?.close(); clearTimeout(publicRealtimeReconnectTimer); clearTimeout(publicRealtimeFallbackTimer); clearInterval(publicRealtimeActivityTimer);
                              activeTab.value = role.value === 'admin' ? 'nodes' : 'dashboard';
                              startPolling(); fetchProbeData(); queueMicrotask(connectRealtime);
                          } else {
                              const data = await res.json().catch(() => ({}));
                              alert(res.status === 503 ? '⚠️ Worker 尚未配置 ADMIN_PASSWORD Secret' : `⚠️ ${data.error || '账户名或密码错误'}`);
                          }
                      } catch (e) {
                          alert(e?.name === 'TimeoutError' ? '登录请求超时，请稍后重试' : '登录异常');
                      } finally {
                          loginPending.value = false;
                      }
                  };
                  
                  const clearPrivateState = () => { servers.value = []; nodes.value = []; users.value = []; groups.value = []; trafficTotals.value = {}; trafficSeries.value = {}; trafficStatsLastFetchedAt = 0; addingVps.value = false; adminProbeServers.value = []; mySubToken.value = ''; probeDetailId.value = null; probeDetail.value = {}; window.kuiRealtimeProxySnapshots = {}; };
                  const logout = () => { const token = authKey.value; if (token) fetch('/api/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, keepalive: true }).catch(() => {}); authGeneration++; sessionStorage.removeItem('kui_auth_key'); sessionStorage.removeItem('kui_user'); sessionStorage.removeItem('kui_role'); isLoggedIn.value = false; currentUser.value = ''; authKey.value = ''; clearPrivateState(); activeTab.value = 'probe'; realtimeGeneration++; realtimeDisconnectedAt = 0; clearTimeout(realtimeFallbackTimer); clearTimeout(realtimeReconnectTimer); clearTimeout(realtimeConnectTimer); clearInterval(realtimePingTimer); const socket = realtimeSocket; realtimeSocket = null; socket?.close(); realtimeConnected.value = false; window.kuiRealtimeConnected = false; stopPolling(); startProbePolling();};
                  const sendUiPing = async () => { try { await fetchApi('/api/ui_ping', { method: 'POST' }); } catch(e) {} };

                  let mapInitialized = false; let myMap = null; let markersLayer = null; let geoJsonLayer = null; let worldGeoJson = null; let currentMapDataStr = "";
                  const initMap = async () => {
                      if (myMap) return;
                      myMap = L.map('map-container', { zoomControl: true, attributionControl: false, minZoom: 1 }).setView([30, 10], 2);
                      try { const res = await fetch('https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json'); worldGeoJson = await res.json(); drawMarkers(); } catch (e) {}
                  };
                  const drawMarkers = () => {
                      if(!myMap || !worldGeoJson) return;
                      const newDataStr = JSON.stringify(probeCountryStats.value);
                      if (currentMapDataStr === newDataStr) return; currentMapDataStr = newDataStr;
                      if(geoJsonLayer) myMap.removeLayer(geoJsonLayer); if(markersLayer) markersLayer.clearLayers(); else markersLayer = L.layerGroup().addTo(myMap);
                      const activeTheme = availableThemes.value.find(theme => theme.id === probeSys.theme);
                      const isDark = Boolean(activeTheme?.is_dark);
                      const activeIso3 = {}; for (const code in probeCountryStats.value) { if (iso2To3[code]) activeIso3[iso2To3[code]] = true; }
                      
                      if (activeIso3['CHN'] || activeIso3['TWN'] || activeIso3['HKG'] || activeIso3['MAC']) {
                          activeIso3['CHN'] = true; activeIso3['TWN'] = true; activeIso3['HKG'] = true; activeIso3['MAC'] = true;
                      }
                      geoJsonLayer = L.geoJSON(worldGeoJson, { style: function(feature) { const isActive = activeIso3[feature.id]; return { fillColor: isActive ? '#10b981' : (isDark ? '#2a303c' : '#d5dce2'), weight: 1, opacity: 1, color: isDark ? '#1a202c' : '#ffffff', fillOpacity: 1 }; } }).addTo(myMap);
                      for (const [code, count] of Object.entries(probeCountryStats.value)) { if(countryCoords[code]) { const icon = L.divIcon({ className: 'probe-custom-map-badge', html: `<div>${count}</div>`, iconSize: [22,22] }); L.marker(countryCoords[code], {icon: icon}).addTo(markersLayer); } }
                  };

                  const setProbeView = (view) => { probeView.value = view; if(view === 'map') { nextTick(()=>{ if(!mapInitialized){initMap(); mapInitialized=true;} else myMap.invalidateSize(); drawMarkers(); }); } };

                  const initProbeDetailCharts = () => {
                      const commonOptions = { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { beginAtZero: true, border: { display: false } } }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, elements: { point: { radius: 0 }, line: { tension: 0.4, borderWidth: 2 } } };
                      const pingOptions = { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: true, ticks: { maxTicksLimit: 15, color: '#9ca3af', font: { size: 10 } } }, y: { beginAtZero: true, border: { display: false } } }, plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { enabled: true, mode: 'index', intersect: false } }, elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 }, line: { tension: 0.3, borderWidth: 2 } } };
                      const createChart = (ctxId, color, bgColor) => new Chart(document.getElementById(ctxId).getContext('2d'), { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: bgColor, fill: true }] }, options: commonOptions });
                      if(probeCharts.cpu) { Object.values(probeCharts).forEach(c=>c.destroy()); }
                      probeCharts.cpu = createChart('probeChartCPU', '#3b82f6', 'rgba(59, 130, 246, 0.1)');
                      probeCharts.ram = createChart('probeChartRAM', '#8b5cf6', 'rgba(139, 92, 246, 0.1)');
                      probeCharts.proc = createChart('probeChartProc', '#ec4899', 'rgba(236, 72, 153, 0.1)');
                      probeCharts.net = new Chart(document.getElementById('probeChartNet').getContext('2d'), { type: 'line', data: { labels: [], datasets: [ { label: 'In', data: [], borderColor: '#10b981', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'Out', data: [], borderColor: '#3b82f6', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
                      probeCharts.conn = new Chart(document.getElementById('probeChartConn').getContext('2d'), { type: 'line', data: { labels: [], datasets: [ { label: 'TCP', data: [], borderColor: '#6366f1', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'UDP', data: [], borderColor: '#d946ef', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
                      probeCharts.ping = new Chart(document.getElementById('probeChartPing').getContext('2d'), { type: 'line', data: { labels: [], datasets: [ { label: '电信', data: [], borderColor: '#10b981', backgroundColor: 'transparent' }, { label: '联通', data: [], borderColor: '#f59e0b', backgroundColor: 'transparent' }, { label: '移动', data: [], borderColor: '#3b82f6', backgroundColor: 'transparent' }, { label: '字节', data: [], borderColor: '#8b5cf6', backgroundColor: 'transparent' } ] }, options: pingOptions });
                  };

                  const updateProbeDetailCharts = (data) => {
                      let hist = {}; try { if(data.history) hist = JSON.parse(data.history); } catch(e) {}
                      if (hist.time && hist.time.length > 0 && probeCharts.cpu) {
                          const nowTime = new Date(); const timeLabel = nowTime.getHours().toString().padStart(2, '0') + ':' + String(nowTime.getMinutes()).padStart(2, '0');
                          const rtLabels = [...hist.time, timeLabel];
                          const updateChartSync = (chart, histArray, rtValue) => { chart.data.labels = rtLabels; chart.data.datasets[0].data = histArray ? [...histArray, rtValue] : []; chart.update('none'); };
                          const updateMultiChartSync = (chart, histArrays, rtValues) => { chart.data.labels = rtLabels; histArrays.forEach((hArr, i) => { chart.data.datasets[i].data = hArr ? [...hArr, rtValues[i]] : []; }); chart.update('none'); };
                          updateChartSync(probeCharts.cpu, hist.cpu, parseFloat(data.cpu) || 0); updateChartSync(probeCharts.ram, hist.ram, parseFloat(data.ram) || 0); updateChartSync(probeCharts.proc, hist.proc, parseInt(data.processes) || 0);
                          updateMultiChartSync(probeCharts.net, [hist.net_in, hist.net_out], [parseFloat(data.net_in_speed) || 0, parseFloat(data.net_out_speed) || 0]);
                          updateMultiChartSync(probeCharts.conn, [hist.tcp, hist.udp], [parseInt(data.tcp_conn) || 0, parseInt(data.udp_conn) || 0]);
                          updateMultiChartSync(probeCharts.ping, [hist.ping_ct, hist.ping_cu, hist.ping_cm, hist.ping_bd], [parseInt(data.ping_ct) || 0, parseInt(data.ping_cu) || 0, parseInt(data.ping_cm) || 0, parseInt(data.ping_bd) || 0]);
                      }
                  };

                  const openProbeDetail = async (id) => {
                      const server = publicProbeServers.value.find(item => item.id === id);
                      if (!server || server.details_available === false) return;
                      probeDetailId.value = id;
                      await nextTick();
                      initProbeDetailCharts();
                      fetchProbeData(true);
                  };

                  const closePopup = () => {
                      localStorage.setItem('kui_popup_seen', Date.now().toString());
                      showWelcomePopup.value = false;
                  };

                  // --- GitHub 动态拉取 ---
                  const pullGithubNodes = async () => {
                      if (githubNodesPulling.value) return;
                      githubNodesPulling.value = true;
                      try {
                          const res = await fetchApi('/api/probe/admin/pull_github', { method: 'POST' });
                          if (res.ok) {
                              alert('✅ 云端主题与测速节点数据拉取成功！');
                              await loadAdminProbeServers();
                          }
                      } catch(e) {
                          console.error('[settings] failed to pull probe presets', e);
                      } finally {
                          githubNodesPulling.value = false;
                      }
                  };

                  let isFirstLoad = true;
                  let isFetchingProbe = false;
                  let probeDetailRequestGeneration = 0;
                  const fetchProbeData = async (isDetail = false, throwOnError = false) => {
                      const detailRequest = !!probeDetailId.value;
                      if (!detailRequest && isFetchingProbe) {
                          if (throwOnError) throw new Error('探针数据正在刷新，请稍后重试');
                          return;
                      }
                      if (!detailRequest) isFetchingProbe = true;
                      try {
                          let authHeader = {};
                          if (isLoggedIn.value) authHeader = { 'Authorization': `Bearer ${authKey.value}` };
                          
                          if (probeDetailId.value) {
                              const requestedId = probeDetailId.value;
                              const generation = ++probeDetailRequestGeneration;
                              const res = await fetch(`/api/probe/detail?id=${encodeURIComponent(requestedId)}`, {headers: authHeader});
                              if(!res.ok) { if (probeDetailId.value === requestedId && generation === probeDetailRequestGeneration) probeDetailId.value = null; throw new Error("Detail fetch failed"); }
                              const detail = await res.json();
                              if (probeDetailId.value !== requestedId || generation !== probeDetailRequestGeneration) return;
                              const live = normalizeRealtimeKey(probeDetail.value?.id) === normalizeRealtimeKey(requestedId) ? probeDetail.value : null;
                              probeDetail.value = live && Number(live._realtime_ts || 0) > Number(detail.last_updated || 0) ? { ...detail, ...live } : detail;
                              updateProbeDetailCharts(probeDetail.value);
                          } else {
                              const ajaxParam = isFirstLoad ? '' : '?ajax=1';
                              isFirstLoad = false;
                              const res = await fetch(`/api/probe/public${ajaxParam}`, {headers: authHeader});
                              if (!res.ok) { if(res.status===401) showLoginModal.value = true; throw new Error("Private Dashboard"); }
                              const data = await res.json(); 
                              Object.assign(probeSys, data.settings); 
                              if (data.settings.cached_nodes_data) parseCachedNodes(data.settings.cached_nodes_data);
                              const liveByIp = new Map(publicProbeServers.value.filter(item => item._realtime_ts).map(item => [normalizeRealtimeKey(item.id), item]));
                              publicProbeServers.value = (data.servers || []).map(item => {
                                  const live = liveByIp.get(normalizeRealtimeKey(item.id));
                                  return live && live._realtime_ts > Number(item.last_updated || 0) ? { ...item, ...live } : item;
                              });
                              if (data.realtime_url !== realtimeUrl.value) realtimeUrl.value = data.realtime_url || '';
                              // A logged-in admin must use the Dashboard channel even
                              // while viewing the probe page. Re-check after every
                              // probe load to avoid the login/realtime URL race.
                              if (isLoggedIn.value && role.value === 'admin' && realtimeUrl.value) queueMicrotask(connectRealtime);
                              else if (!isLoggedIn.value && data.settings.is_public === 'true') queueMicrotask(connectPublicRealtime);
                              updateCustomStyles();
                              if (probeView.value === 'map') drawMarkers();
                              if (probeSys.is_public !== 'true' && !isLoggedIn.value) showLoginModal.value = true;
                              
                              // 弹窗逻辑
                              if (probeSys.enable_popup === 'true') {
                                  const lastSeen = localStorage.getItem('kui_popup_seen');
                                  if (!lastSeen || Date.now() - parseInt(lastSeen) > 86400000) showWelcomePopup.value = true;
                              }
                          }
                      } catch(e) {
                          console.error('[probe] refresh failed', e);
                          if (throwOnError) throw e;
                      } finally { if (!detailRequest) isFetchingProbe = false; }
                  };

                  let kuiFetchPromise = null;
                  let isLoadingAdminProbeServers = false;
                  const loadAdminProbeServers = async () => {
                      if (isLoadingAdminProbeServers || !isLoggedIn.value || role.value !== 'admin') return;
                      isLoadingAdminProbeServers = true;
                      try {
                          const probeRes = await fetchApi('/api/probe/admin/data');
                          if (!probeRes.ok) throw new Error(`Probe data request failed: ${probeRes.status}`);
                          const probeData = await probeRes.json();
                          if (!probeSettingsDirty.value) Object.assign(probeSys, probeData.settings || {});
                          if (probeData.settings?.cached_nodes_data) parseCachedNodes(probeData.settings.cached_nodes_data);
                          adminProbeServers.value = probeData.servers || [];
                      } catch (error) {
                          console.error('[settings] failed to load probe servers', error);
                      } finally {
                          isLoadingAdminProbeServers = false;
                      }
                  };
                  const refreshData = async (throwOnError = false) => {
                      if (!kuiFetchPromise) kuiFetchPromise = (async () => {
                      try {
                          const res = await fetchApi('/api/data'); const data = await res.json();
                          const previousByIp = new Map(servers.value.map(item => [normalizeRealtimeKey(item.ip), item]));
                          const draftFields = ['_egress_mode_draft', '_egress_dirty', '_egress_saving', '_proxy_mode_draft', '_proxy_categories_draft', '_socks5_addr', '_socks5_port', '_socks5_user', '_socks5_pass', '_socks5_clear_password', '_proxy_custom_domains'];
                          servers.value = (data.servers || []).map(item => {
                              const previous = previousByIp.get(normalizeRealtimeKey(item.ip));
                              const merged = mergeServerRealtimeTelemetry(item, previous);
                              if (previous?.warp) merged.warp = previous.warp;
                              if (previous) for (const field of draftFields) if (previous[field] !== undefined) merged[field] = previous[field];
                              if (merged._proxy_custom_domains === undefined) {
                                  let domains = merged.proxy_custom_domains;
                                  if (typeof domains === 'string') { try { domains = JSON.parse(domains || '[]'); } catch { domains = []; } }
                                  merged._proxy_custom_domains = Array.isArray(domains) ? domains.join('\n') : '';
                              }
                              return merged;
                          }); nodes.value = data.nodes || []; users.value = data.users || []; groups.value = (data.groups || []).map(group => { let members = []; let resources = []; try { members = JSON.parse(group.members || '[]'); } catch (e) {} try { resources = JSON.parse(group.resources || '[]'); } catch (e) {} if (!groupDrafts[group.id]) groupDrafts[group.id] = { members: Array.isArray(members) ? members : [], resources: Array.isArray(resources) ? resources.map(resource => `${resource.type}:${resource.id}`) : [] }; return group; });
                          if (data.siteTitle) { siteTitle.value = data.siteTitle; if (!siteTitleDirty.value) siteTitleInput.value = data.siteTitle; }
                          if (data.mySubToken) mySubToken.value = data.mySubToken;
                          securityWarnings.value = data.securityWarnings || [];
                          proxyCredentialsReady.value = data.proxyCredentialsReady === true;
                          proxyPublicListenerManageable.value = data.proxyPublicListenerManageable !== false;
                          if (data.realtimeUrl && data.realtimeUrl !== realtimeUrl.value) { realtimeUrl.value = data.realtimeUrl; connectRealtime(); }
                          servers.value.forEach(s => { 
                              if(!newNodeParams[s.ip]) newNodeParams[s.ip] = { protocol: 'XTLS-Reality', port: 443, username: 'admin', sni: 'addons.mozilla.org', node_uuid: '', node_username: '', node_password: '', reality_private_key: '', reality_public_key: '', reality_short_id: '', ss_method: '2022-blake3-aes-256-gcm', ss_password: '', ss_network: 'tcp,udp', mtproxy_domain: '', mtproxy_secret: '', relay_type: 'external', target_ip: '', target_port: '', target_id: '', traffic_limit_gb: '', expire_date: '' };
                              if(!deployOsMap[s.ip]) deployOsMap[s.ip] = 'debian'; if(!batchStartPort[s.ip]) batchStartPort[s.ip] = ''; if(!batchUser[s.ip]) batchUser[s.ip] = 'admin';
                              if ((s.egress_mode === 'socks5' || s.socks5_addr) && s._socks5_addr === undefined) { s._socks5_addr = s.socks5_addr || ''; s._socks5_port = s.socks5_port || 1080; s._socks5_user = s.socks5_user || ''; s._socks5_pass = ''; s._socks5_clear_password = false; }
                          });
                          if (!warpTargetIp.value && servers.value.length) warpTargetIp.value = servers.value[0].ip;
                          if (warpTargetIp.value && !servers.value.some(server => server.ip === warpTargetIp.value)) warpTargetIp.value = servers.value[0]?.ip || '';
                      if (activeTab.value === 'nodes' && !throwOnError) await loadTrafficStats();
                      
                      if (activeTab.value === 'thirdparty') loadThirdPartySubscriptions();
                      
                      if (activeTab.value === 'settings' && role.value === 'admin') loadAdminProbeServers();
                      } finally {
                          kuiFetchPromise = null;
                      }
                      })();
                      try {
                          return await kuiFetchPromise;
                      } catch (error) {
                          console.error('[panel] data refresh failed', error);
                          if (throwOnError) throw error;
                      }
                  };
                  const refreshPanel = async () => {
                      if (refreshing.value) return;
                      refreshing.value = true;
                      try {
                          await refreshData(true);
                          if (activeTab.value === 'nodes') await loadTrafficStats(true, true);
                          await fetchProbeData(false, true);
                          if (activeTab.value === 'proxy') {
                              // Realtime mode stops the proxy polling timer, so a
                              // manual refresh must explicitly reload this page's
                              // HTTP snapshots and form values.
                              await Promise.all([
                                  window.pcFetchCountries?.(true),
                                  window.pcLoadConfig?.(true),
                                  window.pcFetchNodes?.(true),
                              ]);
                          }
                      } catch (error) {
                          console.error('[panel] refresh failed', error);
                          alert(`刷新失败：${error.message || error}`);
                      } finally {
                          refreshing.value = false;
                      }
                  };

                  const renderKUICharts = async () => {
                      await nextTick();
                      for (let vps of servers.value) {
                          const chartDom = document.getElementById('chart-' + vps.ip); if (!chartDom) continue;
                          let myChart = echarts.getInstanceByDom(chartDom) || echarts.init(chartDom);
                          const stats = trafficSeries.value[vps.ip] || [];
                          myChart.setOption({ grid: { left: '8%', right: '5%', top: '5%', bottom: '15%' }, tooltip: { trigger: 'axis', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderColor: '#e2e8f0', textStyle: { color: '#334155' } }, xAxis: { type: 'category', data: stats.map(s=>s.day), axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: '#cbd5e1' } } }, yAxis: { type: 'value', show: false }, series: [{ data: stats.map(s=>(s.total_bytes/1024/1024).toFixed(2)), type: 'line', smooth: true, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(99, 102, 241, 0.2)' }, { offset: 1, color: 'rgba(99, 102, 241, 0)' }]) }, itemStyle: { color: '#6366f1' }, lineStyle: { width: 3 }, symbol: 'none' }] });
                      }
                  };

                  const loadTrafficStats = async (force = false, throwOnError = false) => {
                      if (!isLoggedIn.value || role.value !== 'admin') return;
                      if (!force && Date.now() - trafficStatsLastFetchedAt < 120000) {
                          if (activeTab.value === 'nodes') await renderKUICharts();
                          return;
                      }
                      if (!trafficFetchPromise) trafficFetchPromise = (async () => {
                          const response = await fetchApi('/api/stats');
                          const data = await response.json();
                          trafficTotals.value = data.totals || {};
                          trafficSeries.value = data.series || {};
                          trafficStatsLastFetchedAt = Date.now();
                          if (activeTab.value === 'nodes') await renderKUICharts();
                      })().finally(() => { trafficFetchPromise = null; });
                      try {
                          await trafficFetchPromise;
                      } catch (error) {
                          console.error('[traffic] statistics refresh failed', error);
                          if (throwOnError) throw error;
                      }
                  };

                  const generateUUIDForNewUser = () => { newUser.password = crypto.randomUUID(); };
                  const expiryTimestamp = (date) => date ? new Date(`${date}T23:59:59.999`).getTime() : 0;
                  const addUser = async () => { const username = String(newUser.username || '').trim(); if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username) || username === currentUser.value || username.toLowerCase() === 'admin') return alert('用户名仅允许字母、数字、点、横线和下划线，且不能使用管理员名'); if (!newUser.password || newUser.password.length < 12) return alert('密码至少 12 位'); const parsedLimit = Number(newUser.traffic_limit_gb || 0); if (!Number.isFinite(parsedLimit) || parsedLimit < 0) return alert('流量配额必须为大于或等于 0 的数字'); const limit = Math.floor(parsedLimit * 1073741824); const expire = expiryTimestamp(newUser.expire_date); await fetchApi('/api/users', { method: 'POST', body: JSON.stringify({ ...newUser, username, traffic_limit: limit, expire_time: expire }) }); Object.assign(newUser, { username: '', password: '', traffic_limit_gb: '', expire_date: '' }); await refreshData(); };
                  const toggleUser = async (username, status) => { await fetchApi('/api/users', { method: 'PUT', body: JSON.stringify({ username, enable: status }) }); await refreshData(); };
                  const deleteUser = async (username) => { if(confirm(`⚠️ 确定删除用户“${username}”？节点将归还给管理员。`)) { await fetchApi(`/api/users?username=${encodeURIComponent(username)}`, { method: 'DELETE' }); await refreshData(); } };
                  const resetUserTraffic = async (username) => { await fetchApi('/api/users', { method: 'PUT', body: JSON.stringify({ username, reset_traffic: true }) }); await refreshData(); };
                  const groupDraft = group => groupDrafts[group.id] || (groupDrafts[group.id] = { members: [], resources: [] });
                  const addGroup = async () => { const name = newGroupName.value.trim(); if (!name) return alert('请输入用户组名称'); await fetchApi('/api/groups', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) }); newGroupName.value = ''; await refreshData(); };
                  const saveGroup = async group => { const draft = groupDraft(group); const resources = draft.resources.map(value => { const separator = value.indexOf(':'); return { type: value.slice(0, separator), id: value.slice(separator + 1) }; }).filter(resource => resource.type && resource.id); await fetchApi('/api/groups', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: group.id, members: draft.members, resources }) }); await refreshData(); };
                  const deleteGroup = async group => { if (confirm(`确定删除用户组“${group.name}”？不会删除其中的用户或节点。`)) { await fetchApi(`/api/groups?id=${encodeURIComponent(group.id)}`, { method: 'DELETE' }); delete groupDrafts[group.id]; await refreshData(); } };
                  const addVps = async () => {
                      if (addingVps.value) return false;
                      if (!newVps.value.ip || !newVps.value.name) { alert('请输入主机名和公网 IP'); return false; }
                      addingVps.value = true;
                      try {
                          deployOsMap[newVps.value.ip] = newVps.value.os; saveOsMap();
                          await fetchApi('/api/vps', { method: 'POST', body: JSON.stringify({ ip: newVps.value.ip, name: newVps.value.name }) });
                          newVps.value = { name: '', ip: '', os: 'debian' };
                          await refreshData(); fetchProbeData();
                          return true;
                      } finally {
                          addingVps.value = false;
                      }
                  };
                  const egressModeLabel = mode => ({ native: '原生出口', residential: '住宅 IP 代理', warp_ipv4: 'WARP IPv4', warp_ipv6: 'WARP IPv6', warp_dual: 'WARP 双栈', socks5: '手动 SOCKS5' }[mode] || mode);
                  const egressModeOf = vps => vps._egress_mode_draft || vps.egress_mode || 'native';
                  const proxyModeOf = vps => vps._proxy_mode_draft ?? vps.proxy_mode ?? 'global';
                  const proxyCategoriesOf = vps => vps._proxy_categories_draft ?? vps.proxy_categories ?? '';
                  const proxyCustomDomainsText = vps => {
                      let domains = vps.proxy_custom_domains;
                      if (typeof domains === 'string') { try { domains = JSON.parse(domains || '[]'); } catch { domains = []; } }
                      return Array.isArray(domains) ? domains.join('\n') : '';
                  };
                  const initializeSocks5Draft = vps => {
                      if (vps._socks5_addr === undefined) vps._socks5_addr = vps.socks5_addr || '';
                      if (vps._socks5_port === undefined) vps._socks5_port = vps.socks5_port || 1080;
                      if (vps._socks5_user === undefined) vps._socks5_user = vps.socks5_user || '';
                      if (vps._socks5_pass === undefined) vps._socks5_pass = '';
                      if (vps._socks5_clear_password === undefined) vps._socks5_clear_password = false;
                  };
                  const beginEgressDraft = vps => {
                      if (vps._proxy_mode_draft === undefined) vps._proxy_mode_draft = vps.proxy_mode || 'global';
                      if (vps._proxy_categories_draft === undefined) vps._proxy_categories_draft = vps.proxy_categories || '';
                      if (vps._proxy_custom_domains === undefined) vps._proxy_custom_domains = proxyCustomDomainsText(vps);
                      initializeSocks5Draft(vps);
                  };
                  const markEgressDirty = vps => { beginEgressDraft(vps); vps._egress_dirty = true; };
                  const egressHasDraft = vps => vps._egress_dirty === true;
                  const onEgressModeChange = (vps, mode) => {
                      beginEgressDraft(vps);
                      vps._egress_mode_draft = mode;
                      if (mode === 'socks5') {
                          initializeSocks5Draft(vps);
                      }
                      vps._egress_dirty = true;
                  };
                  const proxyCategoryOptions = [ { key: 'youtube', label: 'YouTube' }, { key: 'ai', label: 'AI' }, { key: 'google', label: 'Google 搜索' }, { key: 'streaming', label: '流媒体' }, { key: 'custom', label: '自定义' } ];
                  const proxyCategoryActive = (vps, cat) => proxyCategoriesOf(vps).split(',').filter(Boolean).includes(cat);
                  const toggleProxyCategory = (vps, cat) => {
                      if (!['residential','socks5'].includes(egressModeOf(vps))) return;
                      beginEgressDraft(vps);
                      const current = proxyCategoriesOf(vps).split(',').filter(Boolean);
                      const idx = current.indexOf(cat);
                      if (idx >= 0) current.splice(idx, 1); else current.push(cat);
                      vps._proxy_categories_draft = current.join(',');
                      vps._egress_dirty = true;
                  };
                  const markProxyCustomDomainsDirty = vps => markEgressDirty(vps);
                  const clearProxyCustomDomains = vps => { beginEgressDraft(vps); vps._proxy_custom_domains = ''; vps._egress_dirty = true; };
                  const proxyCustomDomainCount = vps => new Set(String(vps._proxy_custom_domains || '').split(/\r?\n/).map(item => item.trim().toLowerCase()).filter(Boolean)).size;
                  const setProxyMode = (vps, mode, proxyMode) => {
                      beginEgressDraft(vps);
                      vps._egress_mode_draft = mode;
                      vps._proxy_mode_draft = proxyMode;
                      vps._egress_dirty = true;
                  };
                  const cancelEgressDraft = vps => {
                      vps._egress_mode_draft = '';
                      vps._proxy_mode_draft = undefined;
                      vps._proxy_categories_draft = undefined;
                      vps._proxy_custom_domains = proxyCustomDomainsText(vps);
                      vps._socks5_addr = vps.socks5_addr || '';
                      vps._socks5_port = vps.socks5_port || 1080;
                      vps._socks5_user = vps.socks5_user || '';
                      vps._socks5_pass = '';
                      vps._socks5_clear_password = false;
                      vps._egress_dirty = false;
                  };
                  const applyEgressDraft = async vps => {
                      if (!egressHasDraft(vps) || vps._egress_saving) return;
                      const categories = proxyCategoriesOf(vps);
                      if (['residential', 'socks5'].includes(egressModeOf(vps)) && proxyModeOf(vps) === 'selective' && !categories) return alert('请至少选择一个局部代理分类，或切换为全局代理');
                      await updateVpsEgress(vps, egressModeOf(vps), proxyModeOf(vps), categories);
                  };
                  const updateVpsEgress = async (vps, mode, proxy_mode, proxy_categories) => {
                      if (['pending', 'preparing'].includes(vps.egress_status) || vps._egress_saving) return;
                      const targetMode = mode || egressModeOf(vps);
                      const targetProxyMode = proxy_mode ?? proxyModeOf(vps);
                      const targetProxyCategories = proxy_categories ?? proxyCategoriesOf(vps);
                      const prevMode = vps.egress_mode || 'native'; const prevStatus = vps.egress_status; const prevProxyMode = vps.proxy_mode || 'global'; const prevCats = vps.proxy_categories || ''; const prevCustomDomains = vps.proxy_custom_domains;
                      vps._egress_saving = true;
                      vps.egress_status = 'pending';
                      vps.egress_mode = targetMode;
                      vps.proxy_mode = targetProxyMode;
                      vps.proxy_categories = targetProxyCategories;
                      try {
                          const body = { ip: vps.ip, egress_mode: targetMode, proxy_custom_domains: vps._proxy_custom_domains || '' };
                          if (targetMode === 'residential') { body.proxy_mode = targetProxyMode || 'global'; body.proxy_categories = targetProxyCategories || ''; }
                          if (targetMode === 'socks5') {
                              body.proxy_mode = targetProxyMode || 'global'; body.proxy_categories = targetProxyCategories || '';
                              body.socks5_addr = vps._socks5_addr || ''; body.socks5_port = vps._socks5_port || 1080;
                              body.socks5_user = vps._socks5_user || ''; body.socks5_pass = vps._socks5_pass || '';
                              body.socks5_clear_password = vps._socks5_clear_password === true;
                          }
                          const res = await fetchApi('/api/vps', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
                          const saved = await res.json();
                          const activeVps = resolveCurrentServer(servers.value, vps);
                          const savedRevision = Number(saved.egress_revision || 0);
                          const alreadyApplied = activeVps.egress_status === 'applied' && Number(activeVps.egress_applied_revision || 0) === savedRevision;
                          activeVps.egress_mode = saved.egress_mode || mode; activeVps.egress_revision = savedRevision;
                          if (!alreadyApplied) activeVps.egress_status = saved.egress_status || 'pending';
                          activeVps.proxy_mode = saved.proxy_mode || (activeVps.egress_mode === 'residential' || activeVps.egress_mode === 'socks5' ? 'global' : '');
                          activeVps.proxy_categories = saved.proxy_categories || '';
                          activeVps.proxy_custom_domains = saved.proxy_custom_domains || [];
                          activeVps.socks5_addr = saved.socks5_addr || ''; activeVps.socks5_port = saved.socks5_port || 0;
                          activeVps.socks5_user = saved.socks5_user || ''; activeVps.socks5_password_set = saved.socks5_password_set === true;
                          cancelEgressDraft(activeVps);
                      } catch (error) { const activeVps = resolveCurrentServer(servers.value, vps); activeVps.egress_mode = prevMode; activeVps.proxy_mode = prevProxyMode; activeVps.proxy_categories = prevCats; activeVps.proxy_custom_domains = prevCustomDomains; activeVps.egress_status = prevStatus; }
                      finally { vps._egress_saving = false; resolveCurrentServer(servers.value, vps)._egress_saving = false; }
                  };
                  const forceReapplyEgress = async vps => {
                      await updateVpsEgress(vps, vps.egress_mode || 'native', vps.proxy_mode || 'global', vps.proxy_categories || '');
                  };
                  const refreshVpsEgressIp = async (vps, silent = false) => {
                      if (egressIpRefreshing[vps.ip]) return;
                      egressIpRefreshing[vps.ip] = true;
                      egressRefreshSilent.set(vps.ip, silent);
                      clearTimeout(egressRefreshTimers.get(vps.ip));
                      const requestId = crypto.randomUUID();
                      egressRefreshRequests[vps.ip] = requestId;
                      egressRefreshTimers.set(vps.ip, setTimeout(() => {
                          if (egressIpRefreshing[vps.ip] && !egressRefreshSilent.get(vps.ip)) alert(`刷新 ${vps.name || vps.ip} 实际出口 IP 超时，请确认 Agent 在线且出口可访问。`);
                          egressIpRefreshing[vps.ip] = false;
                          egressRefreshRequests[vps.ip] = '';
                          egressRefreshTimers.delete(vps.ip);
                          egressRefreshSilent.delete(vps.ip);
                      }, 90000));
                      try {
                          await fetchApi('/api/vps/egress-refresh', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ip: vps.ip, request_id: requestId }) });
                      } catch (error) {
                          clearTimeout(egressRefreshTimers.get(vps.ip)); egressRefreshTimers.delete(vps.ip);
                          egressIpRefreshing[vps.ip] = false;
                          egressRefreshRequests[vps.ip] = '';
                          egressRefreshSilent.delete(vps.ip);
                      }
                  };

                  const buildNodePayload = (ip, p, id) => {
                      if (!p.port) { alert('请填写端口!'); return null; }
                      const optionalText = value => String(value || '').trim();
                      const randomSecret = (bytes = 18) => { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); };
                      const generateMtproxySecret = domain => { const random = new Uint8Array(16); crypto.getRandomValues(random); const toHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); return `ee${toHex(random)}${toHex(new TextEncoder().encode(domain))}`; };
                      let limitBytes = p.traffic_limit_gb ? Math.floor(parseFloat(p.traffic_limit_gb) * 1073741824) : 0; let expireTs = expiryTimestamp(p.expire_date);
                      const payload = { id, uuid: optionalText(p.node_uuid) || crypto.randomUUID(), vps_ip: ip, protocol: p.protocol, port: p.port, username: p.username, traffic_limit: limitBytes, expire_time: expireTs, sni: optionalText(p.sni) };
                      if (p.protocol === 'TUIC') payload.sni = '';
                      else if (p.protocol === 'MTProxy') { payload.sni = optionalText(p.mtproxy_domain).toLowerCase(); if (!payload.sni) { alert('请填写 MTProxy TLS 伪装域名'); return null; } }
                      else if (['XTLS-Reality', 'H2-Reality', 'gRPC-Reality', 'Hysteria2', 'Trojan', 'AnyTLS', 'Naive'].includes(p.protocol) && !payload.sni) payload.sni = 'addons.mozilla.org';
                      if (['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'].includes(p.protocol)) {
                          const privateKey = optionalText(p.reality_private_key); const publicKey = optionalText(p.reality_public_key);
                          if (!!privateKey !== !!publicKey) { alert('Reality 私钥与公钥必须同时填写，或同时留空自动生成'); return null; }
                          const keys = privateKey ? { privateKey, publicKey, shortId: optionalText(p.reality_short_id) || crypto.randomUUID().replace(/-/g, '').substring(0, 16) } : generateRealityKeys();
                          payload.private_key = keys.privateKey; payload.public_key = keys.publicKey; payload.short_id = optionalText(p.reality_short_id) || keys.shortId;
                      } else if (p.protocol === 'Hysteria2') {
                          payload.uuid = optionalText(p.node_password) || randomSecret();
                      } else if (p.protocol === 'TUIC') {
                          payload.private_key = optionalText(p.node_password) || randomSecret();
                      } else if (p.protocol === 'Shadowsocks2022') {
                          const method = p.ss_method || '2022-blake3-aes-256-gcm'; const password = optionalText(p.ss_password) || generateSs2022Password(method); const expectedBytes = method.includes('128') ? 16 : 32; let decoded;
                          try { decoded = atob(password); } catch (_) { alert('SS2022 密钥必须是有效的 Base64 原始密钥'); return null; }
                          if (decoded.length !== expectedBytes || btoa(decoded) !== password) { alert(`SS2022 密钥必须是 ${expectedBytes} 字节原始密钥的标准 Base64 值`); return null; }
                          payload.uuid = method; payload.private_key = password; payload.network = ['tcp', 'udp', 'tcp,udp'].includes(p.ss_network) ? p.ss_network : 'tcp,udp';
                      } else if (p.protocol === 'Trojan' || p.protocol === 'AnyTLS') {
                          payload.uuid = optionalText(p.node_uuid) || crypto.randomUUID(); payload.private_key = optionalText(p.node_password) || randomSecret();
                      } else if (p.protocol === 'Naive' || p.protocol === 'Socks5') {
                          payload.uuid = optionalText(p.node_username) || `user_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`; payload.private_key = optionalText(p.node_password) || randomSecret();
                      } else if (p.protocol === 'MTProxy') {
                          payload.private_key = optionalText(p.mtproxy_secret) || generateMtproxySecret(payload.sni);
                      } else if (p.protocol === 'VLESS-Argo') {
                          payload.sni = optionalText(p.sni) || '⏳ 正在等待 VPS 自动回传穿透域名...';
                      } else if (p.protocol === 'dokodemo-door') {
                          payload.relay_type = p.relay_type; if (p.relay_type === 'external') { if (!p.target_ip || !p.target_port) { alert('请填写外部目标地址和端口'); return null; } payload.target_ip = p.target_ip; payload.target_port = p.target_port; } else { if (!p.target_id) { alert('请选择内部目标节点'); return null; } payload.target_id = p.target_id; }
                      }
                      return payload;
                  };

                  const addNode = async (ip) => {
                      if (addingNode[ip]) return;
                      const payload = buildNodePayload(ip, newNodeParams[ip], crypto.randomUUID());
                      if (!payload) return;
                      addingNode[ip] = true;
                      try {
                          await fetchApi('/api/nodes', { method: 'POST', body: JSON.stringify(payload) });
                          await refreshData();
                      } finally { addingNode[ip] = false; }
                  };

                  const editDraftFromNode = node => ({
                      protocol: node.protocol, port: Number(node.port), username: node.username === currentUser.value ? 'admin' : node.username, sni: node.sni || '',
                      node_uuid: ['VLESS', 'XTLS-Reality', 'Reality', 'H2-Reality', 'gRPC-Reality', 'TUIC', 'VLESS-Argo'].includes(node.protocol) ? node.uuid || '' : '',
                      node_username: ['Naive', 'Socks5'].includes(node.protocol) ? node.uuid || '' : '',
                      node_password: node.protocol === 'Hysteria2' ? node.uuid || '' : (['TUIC', 'Trojan', 'AnyTLS', 'Naive', 'Socks5'].includes(node.protocol) ? node.private_key || '' : ''),
                      reality_private_key: ['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'].includes(node.protocol) ? node.private_key || '' : '',
                      reality_public_key: ['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'].includes(node.protocol) ? node.public_key || '' : '',
                      reality_short_id: ['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'].includes(node.protocol) ? node.short_id || '' : '',
                      ss_method: node.protocol === 'Shadowsocks2022' ? node.uuid : '2022-blake3-aes-256-gcm', ss_password: node.protocol === 'Shadowsocks2022' ? node.private_key || '' : '', ss_network: node.protocol === 'Shadowsocks2022' ? node.network || 'tcp,udp' : 'tcp,udp',
                      mtproxy_secret: node.protocol === 'MTProxy' ? node.private_key || '' : '',
                      mtproxy_domain: node.protocol === 'MTProxy' ? node.sni || '' : '',
                      relay_type: node.relay_type || 'external', target_ip: node.target_ip || '', target_port: node.target_port || '', target_id: node.target_id || '',
                      traffic_limit_gb: node.traffic_limit > 0 ? Number((node.traffic_limit / 1073741824).toFixed(3)) : '', expire_date: node.expire_time > 0 ? formatDate(node.expire_time) : '',
                  });
                  const startEditNode = node => { nodeEditDrafts[node.id] = editDraftFromNode(node); };
                  const cancelEditNode = id => { delete nodeEditDrafts[id]; };
                  const saveNodeEdit = async node => {
                      const payload = buildNodePayload(node.vps_ip, nodeEditDrafts[node.id], node.id);
                      if (!payload) return;
                      await fetchApi('/api/nodes', { method: 'PUT', body: JSON.stringify(payload) });
                      delete nodeEditDrafts[node.id]; await refreshData();
                  };
                  
                  const deployAllProtocols = async (ip) => {
                      let startPort = parseInt(batchStartPort[ip]); if (!startPort || startPort < 10 || startPort + 8 > 65535) return alert('⚠️ 请输入有效的起始端口 (推荐: 8881)');
                      const defaultSni = 'addons.mozilla.org'; const commonUser = batchUser[ip] || 'admin'; const commonUUID = crypto.randomUUID(); 
                      const protocolSequence = [ { protocol: 'XTLS-Reality', offset: 0, sni: defaultSni, type: 'reality' }, { protocol: 'Hysteria2', offset: 1, sni: defaultSni }, { protocol: 'TUIC', offset: 2 }, { protocol: 'Shadowsocks2022', offset: 3, method: '2022-blake3-aes-256-gcm' }, { protocol: 'Trojan', offset: 4, sni: defaultSni }, { protocol: 'H2-Reality', offset: 5, sni: defaultSni, type: 'reality' }, { protocol: 'gRPC-Reality', offset: 6, sni: defaultSni, type: 'reality' }, { protocol: 'AnyTLS', offset: 7, sni: defaultSni }, { protocol: 'Naive', offset: 8, sni: defaultSni } ];
                      if (!confirm(`🚀 极速部署确认：\n\n系统将按照 FSCARMEN 模式，向该服务器并发下发完整 ${protocolSequence.length} 个协议矩阵：\n` + protocolSequence.map(p => `- ${p.protocol} (端口: ${startPort + p.offset})`).join('\n') + `\n\n所有节点归属: ${commonUser}\n\n确认立刻组建节点矩阵吗？`)) return;
                      const failures = [];
                      for (let item of protocolSequence) {
                          const payload = { id: Date.now().toString() + Math.floor(Math.random() * 10000), uuid: commonUUID, vps_ip: ip, protocol: item.protocol, port: startPort + item.offset, username: commonUser, traffic_limit: 0, expire_time: 0, sni: item.sni || '', network: item.protocol === 'H2-Reality' ? 'http' : (item.protocol === 'gRPC-Reality' ? 'grpc' : 'tcp') };
                          if (item.type === 'reality') { const keys = generateRealityKeys(); payload.private_key = keys.privateKey; payload.public_key = keys.publicKey; payload.short_id = keys.shortId; } else if (item.protocol === 'Shadowsocks2022') { const key = new Uint8Array(32); crypto.getRandomValues(key); payload.uuid = item.method; payload.private_key = btoa(String.fromCharCode(...key)); payload.network = 'tcp,udp'; } else if (item.protocol === 'Naive') { payload.uuid = commonUUID.replace(/-/g, '').substring(0, 16); payload.private_key = payload.uuid; } else { const array = new Uint8Array(16); crypto.getRandomValues(array); payload.private_key = btoa(String.fromCharCode.apply(null, array)); }
                          try { await fetchApi('/api/nodes', { method: 'POST', body: JSON.stringify(payload) }); } catch(e) { failures.push(`${item.protocol}: ${e.message || '失败'}`); }
                      }
                      batchStartPort[ip] = ''; alert(failures.length ? `⚠️ 部分协议部署失败：\n${failures.join('\n')}` : "✅ 极速 9合1 全家桶部署指令已实时发送！"); refreshData();
                  };

                  const deleteNode = async (id) => { await fetchApi(`/api/nodes?id=${id}`, { method: 'DELETE' }); refreshData(); };
                  const toggleNode = async (id, status) => { await fetchApi('/api/nodes', { method: 'PUT', body: JSON.stringify({ id: id, enable: status }) }); refreshData(); };
                  const resetTraffic = async (id) => { await fetchApi('/api/nodes', { method: 'PUT', body: JSON.stringify({ id: id, reset_traffic: true }) }); refreshData(); };
                  const getNodesByIp = (ip) => nodes.value.filter(n => n.vps_ip === ip).sort((a, b) => a.port - b.port);
                  const getVpsName = (ip) => servers.value.find(s => s.ip === ip)?.name || ip;
                  
                  const saveOsMap = () => { localStorage.setItem('kui_deploy_os', JSON.stringify(deployOsMap)); };
                  const requireBootstrapToken = (token) => {
                      const value = String(token || '');
                      if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new Error('后端未返回有效的一次性引导令牌，请刷新页面后重试');
                      return value;
                  };
                  const requestAgentBootstrapToken = async (ip, component) => {
                      const response = await fetchApi('/api/agent_bootstrap', { method: 'POST', body: JSON.stringify({ ip, component }) });
                      const payload = await response.json().catch(() => { throw new Error('后端返回了无效的引导令牌响应'); });
                      return requireBootstrapToken(payload?.token);
                  };
                  const generateCmd = (ip, token) => { token = requireBootstrapToken(token); const osType = deployOsMap[ip] || 'debian'; const scriptUrl = `${currentDomain}/api/agent_update?ip=${encodeURIComponent(ip)}&component=full-installer`; if (osType === 'alpine') return `apk update && apk add curl && curl -fsSL -H "Authorization: Bootstrap ${token}" "${scriptUrl}" | sh -s -- --api "${currentDomain}" --ip "${ip}" --bootstrap "${token}"`; return `apt-get update -y && apt-get install -y curl && bash <(curl -fsSL -H "Authorization: Bootstrap ${token}" "${scriptUrl}") --api "${currentDomain}" --ip "${ip}" --bootstrap "${token}"`; };
                  const generateUninstallCmd = (ip, token, purge = false) => { token = requireBootstrapToken(token); const scriptUrl = `${currentDomain}/api/agent_update?ip=${encodeURIComponent(ip)}&component=uninstaller`; return `( tmp=$(mktemp /tmp/kui-uninstall.XXXXXX) && curl -fsSL -H "Authorization: Bootstrap ${token}" "${scriptUrl}" -o "$tmp" && chmod 700 "$tmp" && sh "$tmp" --yes ${purge ? '--all ' : ''}--ip "${ip}"${purge ? ` --api "${currentDomain}" --bootstrap "${token}"` : ''}; status=$?; rm -f "\${tmp:-}"; exit $status )`; };
                  const copyDeployCommand = async (vps, event) => { const trigger = event?.currentTarget; try { const token = await requestAgentBootstrapToken(vps.ip, 'full-installer'); await copyCommand(generateCmd(vps.ip, token), '部署指令已复制，有效期 5 分钟！', trigger); } catch (error) { alert(`生成部署命令失败：${error.message || error}`); } };
                  const copyUninstallCommand = async (vps, event) => { const trigger = event?.currentTarget; if (!confirm(`⚠️ 将生成 ${vps.name || vps.ip} 的 Agent 卸载命令。执行后会删除 KUI Agent 与 KUI sing-box，但保留 proxy-lite、OpenVPN 和面板记录。是否继续复制？`)) return; try { const token = await requestAgentBootstrapToken(vps.ip, 'uninstaller'); await copyCommand(generateUninstallCmd(vps.ip, token), '✅ Agent 卸载命令已复制，有效期 5 分钟！', trigger); } catch (error) { alert(`生成卸载命令失败：${error.message || error}`); } };
                  const copyPurgeCommand = async (vps, event) => { const trigger = event?.currentTarget; if (!confirm(`🧨 高危操作：将生成 ${vps.name || vps.ip} 的全量清理命令。执行后会删除 Agent、sing-box、proxy-lite、OpenVPN 配置，并在清理成功后自动删除面板中的 VPS、节点和探针记录。是否继续复制？`)) return; try { const token = await requestAgentBootstrapToken(vps.ip, 'uninstaller'); await copyCommand(generateUninstallCmd(vps.ip, token, true), '✅ 全量清理命令已复制，有效期 5 分钟！', trigger); } catch (error) { alert(`生成完整卸载命令失败：${error.message || error}`); } };

                  const markSiteTitleDirty = () => { siteTitleDirty.value = true; };
                  const markProbeSettingsDirty = () => { probeSettingsDirty.value = true; };
                  const saveSiteTitle = async () => {
                      const title = siteTitleInput.value.trim();
                      if (!title) return alert('名称不能为空！');
                      if (title.length > 100) return alert('名称不能超过 100 个字符！');
                      if (siteTitleSaving.value) return;
                      siteTitleSaving.value = true;
                      try {
                          await fetchApi('/api/settings', { method: 'POST', body: JSON.stringify({ site_title: title }) });
                          siteTitle.value = title; siteTitleInput.value = title; siteTitleDirty.value = false;
                          alert('✅ KUI 聚合面板名称保存成功！');
                      } catch (error) {
                          console.error('[settings] failed to save site title', error);
                      } finally { siteTitleSaving.value = false; }
                  };
                  const updateUserPassword = async () => {
                      if (userNewPassword.value.length < 12) return alert('新密码至少需要 12 位！');
                      if (userNewPassword.value.length > 128) return alert('新密码不能超过 128 位！');
                      if (passwordSaving.value) return;
                      passwordSaving.value = true;
                      try {
                          await fetchApi('/api/user/password', { method: 'PUT', body: JSON.stringify({ password: userNewPassword.value }) });
                          userNewPassword.value = '';
                          alert('✅ 密码修改成功！请使用新密码重新登录。');
                          logout();
                      } catch (error) {
                          console.error('[settings] failed to update password', error);
                      } finally { passwordSaving.value = false; }
                  };
                  const resetMySubLink = async () => {
                      if (subTokenResetting.value || !confirm('🚨 危险操作！重置后旧订阅链接将立即作废，确定继续吗？')) return;
                      subTokenResetting.value = true;
                      try {
                          const response = await fetchApi('/api/user/sub_token', { method: 'PUT' });
                          const data = await response.json();
                          if (data.token) mySubToken.value = data.token;
                          alert('✅ 订阅令牌已刷新！');
                      } catch (error) {
                          console.error('[settings] failed to reset subscription token', error);
                      } finally { subTokenResetting.value = false; }
                  };
                  
                  const generateSubLink = (ip='', format='', nodeId='') => {
                      const tokenToUse = mySubToken.value || authKey.value; 
                      let link = `${currentDomain}/api/sub?user=${encodeURIComponent(currentUser.value)}&token=${encodeURIComponent(tokenToUse)}`;
                      if (ip) link += `&ip=${encodeURIComponent(ip)}`;
                      if (format) link += `&format=${encodeURIComponent(format)}`;
                      if (nodeId) link += `&node=${encodeURIComponent(nodeId)}`;
                      return link;
                  };
                  const generateMtproxyLink = node => `tg://proxy?${new URLSearchParams({ server: String(node.vps_ip || '').replace(/^\[|\]$/g, ''), port: String(node.port), secret: node.private_key || '' }).toString()}`;
                  
                  const writeClipboard = async text => {
                      if (navigator.clipboard?.writeText) {
                          try { await navigator.clipboard.writeText(text); return; } catch (_) {}
                      }
                      const textarea = document.createElement('textarea');
                      textarea.value = text; textarea.setAttribute('readonly', '');
                      textarea.style.position = 'fixed'; textarea.style.opacity = '0';
                      document.body.appendChild(textarea); textarea.select();
                      const copied = document.execCommand('copy'); textarea.remove();
                      if (!copied) throw new Error('浏览器拒绝访问剪贴板，请使用 HTTPS 或手动复制');
                  };
                  const closeCopyOverlays = trigger => {
                      let current = trigger;
                      while (current) {
                          const details = current.closest?.('details.kui-server-command-menu[open], details.kui-server-menu[open], details.kui-action-menu[open]');
                          if (!details) break;
                          details.removeAttribute('open');
                          current = details.parentElement;
                      }
                  };
                  const copyCommand = async (txt, msg, eventOrTrigger) => { const trigger = eventOrTrigger?.currentTarget || eventOrTrigger; try { await writeClipboard(txt); closeCopyOverlays(trigger); alert(msg); } catch (error) { alert(error.message || '复制失败'); } };
                  const copySurgeConfig = async (ip='', nodeId='', event) => {
                      const trigger = event?.currentTarget;
                      try {
                          const headers = authKey.value ? { 'Authorization': `Bearer ${authKey.value}` } : {};
                          const response = await fetch(generateSubLink(ip, 'surge', nodeId), { cache: 'no-store', headers });
                          if (!response.ok) throw new Error(`HTTP ${response.status}`);
                          const config = await response.text();
                          if (!config.trimStart().startsWith('[Proxy]')) throw new Error('返回内容不是 Surge 配置段');
                          await writeClipboard(config);
                          closeCopyOverlays(trigger);
                          alert(nodeId ? '✅ 该节点的 Surge 配置段已复制！' : (ip ? '✅ 该 VPS 的 Surge 配置段已复制！' : '✅ 全量 Surge 配置段已复制！'));
                      } catch (error) {
                          alert(`复制 Surge 配置段失败：${error.message}`);
                      }
                  };

                  const showQrCode = (text) => {
                      try {
                          const qr = new QRious({ value: text, size: 300, level: 'L', background: '#ffffff', foreground: '#1e293b' });
                          qrCodeImage.value = qr.toDataURL(); qrModalOpen.value = true;
                      } catch (err) { alert('生成二维码失败！请检查链接长度或浏览器控制台。'); }
                  };

                  const saveProbeSettings = async () => {
                      const adminInterval = Number(probeSys.realtime_admin_interval);
                      const publicInterval = Number(probeSys.realtime_public_interval);
                      const idleInterval = Number(probeSys.realtime_idle_interval);
                      const reportInterval = Number(probeSys.report_interval);
                      if (![adminInterval, publicInterval, idleInterval, reportInterval].every(Number.isInteger)) return alert('所有频率必须填写整数！');
                      if (adminInterval < 5 || adminInterval > 60 || publicInterval < 10 || publicInterval > 120 || idleInterval < 30 || idleInterval > 600) return alert('Realtime 频率超出允许范围！');
                      if (publicInterval < adminInterval || idleInterval < publicInterval) return alert('公开探针不得快于管理员后台，空闲频率不得快于公开探针！');
                      if (reportInterval < 1 || reportInterval > 3600) return alert('客户端上报间隔必须在 1–3600 秒之间！');
                      if (!String(probeSys.site_title || '').trim()) return alert('大盘展示标题不能为空！');
                      if (String(probeSys.site_title).trim().length > 100) return alert('大盘展示标题不能超过 100 个字符！');
                      if (probeSettingsSaving.value) return;
                      probeSettingsSaving.value = true;
                      try {
                          const editableProbeSettingKeys = ['theme', 'is_public', 'site_title', 'show_price', 'show_expire', 'show_bw', 'show_tf', 'custom_css', 'custom_bg', 'report_interval', 'enable_popup', 'popup_content', 'auto_reset_traffic', 'ping_node_ct', 'ping_node_cu', 'ping_node_cm', 'tg_notify', 'tg_bot_token', 'tg_chat_id', 'realtime_admin_interval', 'realtime_public_interval', 'realtime_idle_interval'];
                          const settings = Object.fromEntries(editableProbeSettingKeys.filter(key => probeSys[key] !== undefined).map(key => [key, probeSys[key]]));
                          await fetchApi('/api/probe/admin/settings', { method: 'POST', body: JSON.stringify({ settings }) });
                          probeSettingsDirty.value = false;
                          alert('✅ 探针大盘配置已生效！');
                          await Promise.allSettled([refreshData(), fetchProbeData()]);
                      } catch (error) {
                          console.error('[settings] failed to save probe settings', error);
                      } finally { probeSettingsSaving.value = false; }
                  };
                  const saveSubscriptionProtection = async () => {
                      if (subscriptionProtectionSaving.value) return;
                      const value = probeSys.subscription_protection;
                      subscriptionProtectionSaving.value = true;
                      try {
                          await fetchApi('/api/probe/admin/settings', { method: 'POST', body: JSON.stringify({ settings: { subscription_protection: value } }) });
                      } catch (error) {
                          probeSys.subscription_protection = value === 'true' ? 'false' : 'true';
                      } finally { subscriptionProtectionSaving.value = false; }
                  };
                  const openProbeEditModal = (s) => { editingProbeNode.value = JSON.parse(JSON.stringify(s)); if(!editingProbeNode.value.is_hidden) editingProbeNode.value.is_hidden = 'false'; if(!editingProbeNode.value.reset_day) editingProbeNode.value.reset_day = '1'; probeEditModalOpen.value = true; };
                  const saveProbeEdit = async () => { await fetchApi('/api/probe/admin/server', { method: 'PUT', body: JSON.stringify(editingProbeNode.value) }); probeEditModalOpen.value = false; refreshData(); fetchProbeData(); };
                  const deleteProbeNode = async (id) => {
                      if (!confirm('⚠️ 确定彻底删除这台 VPS？\n删除后，“服务器与节点”中的服务器卡片及其关联节点也会一并移除。')) return;
                      await fetchApi(`/api/probe/admin/server?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
                      adminProbeServers.value = adminProbeServers.value.filter(item => item.id !== id);
                      servers.value = servers.value.filter(item => item.ip !== id);
                      nodes.value = nodes.value.filter(item => item.vps_ip !== id);
                      await Promise.allSettled([refreshData(true), fetchProbeData(false, true)]);
                  };
                  
                  const loadThirdPartySubscriptions = async () => {
                      try {
                          const res = await fetchApi('/api/thirdparty');
                          thirdPartySubscriptions.value = await res.json();
                      } catch(e) { thirdPartySubscriptions.value = []; }
                  };
                  
                  const addThirdPartySubscription = async () => {
                      if (!newThirdParty.url) return alert('请填写订阅链接！');
                      loadingThirdParty.value = true;
                      try {
                          const res = await fetchApi('/api/thirdparty', { method: 'POST', body: JSON.stringify({ name: newThirdParty.name, url: newThirdParty.url }) });
                          if (res.ok) {
                              const data = await res.json();
                              let msg = `✅ 订阅添加成功！成功解析 ${data.parsedCount || 0} 个节点。`;
                              if (data.debug) {
                                  const d = data.debug;
                                  if (d.protocolCounts) msg += `\n协议分布: ${JSON.stringify(d.protocolCounts)}`;
                                  if (d.debug && d.debug.allPrefixes) msg += `\n所有行前缀: ${JSON.stringify(d.debug.allPrefixes)}`;
                                  if (d.debug && d.debug.contentPreview) msg += `\n订阅原始内容前800字符:\n${d.debug.contentPreview}`;
                                  if (d.debug && d.debug.hy2Found && (!d.protocolCounts || !d.protocolCounts.Hysteria2)) {
                                      msg += `\n⚠️ 订阅中发现 hysteria2 行但解析失败！hy2原始行: ${d.debug.hy2Line || '(空)'}`;
                                  }
                                  if (d.debug && d.debug.unmatchedPrefixes && Object.keys(d.debug.unmatchedPrefixes).length > 0) {
                                      msg += `\n⚠️ 未匹配行的前缀分布: ${JSON.stringify(d.debug.unmatchedPrefixes)}`;
                                  }
                                  if (d.fetchError) msg += `\n❌ 拉取订阅失败: ${d.fetchError}`;
                              }
                              alert(msg);
                              newThirdParty.name = ''; newThirdParty.url = '';
                              loadThirdPartySubscriptions();
                          }
                      } catch(e) { alert('添加失败: ' + e.message); }
                      loadingThirdParty.value = false;
                  };
                  
                  const toggleThirdPartySubscription = async (id, isEnable) => {
                      try {
                          await fetchApi('/api/thirdparty', { method: 'PUT', body: JSON.stringify({ id, enable: isEnable }) });
                          loadThirdPartySubscriptions();
                      } catch(e) {}
                  };
                  
                  const deleteThirdPartySubscription = async (id) => {
                      if (!confirm('确定删除该订阅？关联的解析节点也会被一并删除！')) return;
                      try {
                          await fetchApi(`/api/thirdparty?id=${id}`, { method: 'DELETE' });
                          loadThirdPartySubscriptions();
                      } catch(e) { alert('删除失败: ' + e.message); }
                  };

                  // --- 住宅IP代理控制器方法 ---
                  const proxyConfig = reactive({ ip: '', country: 'JP', port: 7920, mesh: { enabled: false, country: 'ANY', mode: 'all', nodes: '', exit: 'ANY' } });
                  const proxyPool = ref([]);

                  const loadProxyPool = async () => {
                      try {
                          const res = await fetchApi('/api/proxy/pool');
                          proxyPool.value = await res.json();
                      } catch (e) { proxyPool.value = []; }
                  };

                  const toggleNodeProxy = async (ip, currentState) => {
                      try {
                          await fetchApi('/api/proxy/config', {
                              method: 'POST',
                              body: JSON.stringify({ ip, enabled: !currentState, port: proxyConfig.port, country: proxyConfig.country, mesh: proxyConfig.mesh })
                          });
                          alert(`✅ 节点 ${ip} 代理已${currentState ? '关闭' : '开启'}！`);
                          loadProxyPool();
                      } catch (e) {
                          alert('❌ 代理开关切换失败: ' + e.message);
                      }
                  };

                  const saveProxyConfig = async () => {
                      const targets = proxyConfig.ip ? [proxyConfig.ip] : (servers.value || []).map(s => s.ip);
                      if (targets.length === 0) { alert('⚠️ 暂无可下发的 VPS，请先在「服务器与节点」接入机器。'); return; }
                      try {
                          for (const ip of targets) {
                              await fetchApi('/api/proxy/config', {
                                  method: 'POST',
                                  body: JSON.stringify({ ip, enabled: true, port: parseInt(proxyConfig.port) || 7920, country: proxyConfig.country.toUpperCase(), mesh: proxyConfig.mesh })
                              });
                          }
                          alert(`✅ 代理配置已下发到 ${targets.length} 台 VPS！Agent 下次心跳即生效。`);
                          loadProxyPool();
                      } catch (e) {
                          alert('❌ 配置下发失败: ' + e.message);
                      }
                  };

                  const setProxyPublicListener = async (vps, enabled) => {
                      if (!vps?.ip || publicListenerSaving[vps.ip]) return;
                      if (!proxyPublicListenerManageable.value) return alert('当前使用外部住宅控制器，无法从本面板修改 VPS 监听范围。');
                      if (enabled && !proxyCredentialsReady.value) return alert('请先在 Cloudflare 配置 PROXY_USER 与 PROXY_PASS Secret。');
                      if (enabled && !confirm(`⚠️ 即将开放 ${vps.name || vps.ip} (${vps.ip}) 的住宅代理公网入口。\n\n请确认代理凭据足够强，并已通过防火墙或云安全组限制允许访问的来源 IP。是否继续？`)) return;
                      const previous = vps.proxy_public_listener === true;
                      publicListenerSaving[vps.ip] = true;
                      try {
                          const response = await fetchApi('/api/proxy/config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ ip: vps.ip, public_listener: enabled }),
                          });
                          const result = await response.json();
                          vps.proxy_public_listener = result.proxy?.public_listener === true;
                          await refreshData();
                          alert(enabled ? '公网监听已开启，proxy-lite 将自动重启监听器。' : '公网监听已关闭，proxy-lite 将恢复为本机或 Docker 网桥监听。');
                      } catch (error) {
                          vps.proxy_public_listener = previous;
                      } finally {
                          publicListenerSaving[vps.ip] = false;
                      }
                  };

                  const switchProxyIP = async () => {
                      if (!proxyConfig.ip) { alert('⚠️ 请先在上方选择一台目标 VPS。'); return; }
                      try {
                          await fetchApi('/api/proxy/switch', {
                              method: 'POST',
                              body: JSON.stringify({ ip: proxyConfig.ip })
                          });
                          alert('✅ 强制更换IP指令已发送！（VPS 公网 IP 固定时仅记录切换并触发重新上报）');
                          loadProxyPool();
                      } catch (e) {
                          alert('❌ 指令发送失败: ' + e.message);
                      }
                  };

                  const sendWarpOptimizerCommand = async (action, extra = {}) => {
                      const ip = warpTargetIp.value;
                      if (!ip) return alert('请先选择目标 VPS。');
                      if (warpActionPending.value) return;
                      warpActionPending.value = true;
                      try {
                          const response = await fetchApi('/api/vps/warp-optimize', {
                              method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ ip, action, ...extra }),
                          });
                          const result = await response.json();
                          const server = servers.value.find(item => item.ip === ip);
                          if (server?.warp?.optimizer) {
                              if (action === 'scan') Object.assign(server.warp.optimizer, { status: 'scanning', stage: '指令已发送，等待 Agent 开始检测', progress: 1, error: '' });
                              if (action === 'apply' || action === 'restore') Object.assign(server.warp.optimizer, { status: 'applying', stage: '指令已发送，等待 Agent 验证', progress: 95, error: '' });
                          }
                          return result;
                      } finally { warpActionPending.value = false; }
                  };
                  const startWarpOptimization = () => { warpSelectedCandidate.value = ''; return sendWarpOptimizerCommand('scan'); };
                  const applyWarpCandidate = () => {
                      const server = servers.value.find(item => item.ip === warpTargetIp.value);
                      const candidates = server?.warp?.optimizer?.candidates || [];
                      const selected = candidates.find(item => `${item.address}:${item.port}` === warpSelectedCandidate.value) || server?.warp?.optimizer?.recommended;
                      if (!selected?.success || !selected?.refined) return alert('当前没有可应用的复测 Endpoint。');
                      if (!confirm(`应用 WARP Endpoint ${selected.address}:${selected.port}？\n正在使用 WARP 时会短暂重载 sing-box，失败将自动回滚。`)) return;
                      return sendWarpOptimizerCommand('apply', { address: selected.address, port: selected.port });
                  };
                  const cancelWarpOptimization = () => { warpSelectedCandidate.value = ''; return sendWarpOptimizerCommand('cancel'); };
                  const restoreWarpEndpoint = () => {
                      const server = servers.value.find(item => item.ip === warpTargetIp.value);
                      const previous = server?.warp?.optimizer?.previous;
                      if (!previous?.address || !confirm(`恢复上一个 WARP Endpoint ${previous.address}:${previous.port}？`)) return;
                      return sendWarpOptimizerCommand('restore');
                  };
                  const updateWarpPolicy = policy => sendWarpOptimizerCommand('policy', { policy });

                  const suggestWarpOptimization = (resultServer, result) => {
                      if (!resultServer || !shouldSuggestWarpOptimization(result)) return;
                      const marker = `${result.deployment_id || ''}:${result.revision}:${result.applied_at}`;
                      const storageKey = `kui_warp_optimizer_suggest:${resultServer.ip}`;
                      try {
                          if (localStorage.getItem(storageKey) === marker) return;
                          localStorage.setItem(storageKey, marker);
                      } catch {}
                      if (activeTab.value === 'warp') return;
                      if (confirm('WARP 出口已生效。建议前往「WARP 隧道」页面检测并应用更优 Endpoint。现在前往？')) {
                          warpTargetIp.value = resultServer.ip;
                          activeTab.value = 'warp';
                      }
                  };

                  let dataTimer = null; let pingTimer = null; let probeTimer = null;
                  const applyRealtimeSnapshot = (snapshot) => {
                      if (!snapshot?.ip) return;
                      const key = normalizeRealtimeKey(snapshot.ip);
                      const resultServer = servers.value.find(item => normalizeRealtimeKey(item.ip) === key);
                      const egressResult = snapshot.core_egress_result || snapshot.core_config_result;
                      if (applyEgressRealtimeResult(resultServer, egressResult)) {
                          suggestWarpOptimization(resultServer, egressResult);
                          if (egressResult.success && !egressResult.egress_ip) {
                              const marker = `${egressResult.deployment_id || ''}:${egressResult.revision}`;
                              if (egressAutoRefreshMarkers.get(resultServer.ip) !== marker) {
                                  egressAutoRefreshMarkers.set(resultServer.ip, marker);
                                  setTimeout(() => refreshVpsEgressIp(resultServer, true), 0);
                              }
                          }
                      }
                      const egressProbe = snapshot.core_egress_probe_result;
                      if (resultServer && egressProbe?.request_id && egressProbe.request_id === egressRefreshRequests[resultServer.ip]) {
                          const silent = egressRefreshSilent.get(resultServer.ip) === true;
                          clearTimeout(egressRefreshTimers.get(resultServer.ip)); egressRefreshTimers.delete(resultServer.ip);
                          egressRefreshSilent.delete(resultServer.ip);
                          egressIpRefreshing[resultServer.ip] = false; egressRefreshRequests[resultServer.ip] = '';
                          const probeApplied = applyEgressProbeResult(resultServer, egressProbe);
                          if (!probeApplied && !silent) alert(`刷新实际出口 IP 失败：${egressProbe.error || 'VPS 未返回与当前配置匹配的有效出口 IP'}`);
                      }
                      if (snapshot.core) {
                          const timestamp = Number(snapshot.core_last_seen || snapshot.updated_at || 0);
                          const server = servers.value.find(item => normalizeRealtimeKey(item.ip) === key);
                          if (server && timestamp >= Number(server._realtime_ts || server.last_report || 0)) {
                              const core = snapshot.core;
                              Object.assign(server, { cpu: core.cpu, mem: core.mem, disk: core.disk, load: core.load, uptime: core.uptime, net_in_speed: core.net_in_speed, net_out_speed: core.net_out_speed, tcp_conn: core.tcp_conn, udp_conn: core.udp_conn, warp: core.warp || server.warp, last_report: timestamp, realtime_state: snapshot.core_state, boot_id: snapshot.boot_id?.core, sequence: snapshot.sequence?.core, config_result: snapshot.core_config_result, config_result_at: snapshot.core_config_result_at, _realtime_ts: timestamp });
                          }
                          const core = snapshot.core;
                          const probe = publicProbeServers.value.find(item => normalizeRealtimeKey(item.id) === key);
                          if (probe && timestamp >= Number(probe._realtime_ts || probe.last_updated || 0)) Object.assign(probe, { cpu: core.cpu, ram: core.mem, disk: core.disk, load_avg: core.load, uptime: core.uptime, net_in_speed: core.net_in_speed, net_out_speed: core.net_out_speed, tcp_conn: core.tcp_conn, udp_conn: core.udp_conn, last_updated: timestamp, realtime_state: snapshot.core_state, _realtime_ts: timestamp });
                          if (normalizeRealtimeKey(probeDetail.value?.id) === key && timestamp >= Number(probeDetail.value?._realtime_ts || probeDetail.value?.last_updated || 0)) { Object.assign(probeDetail.value, { cpu: core.cpu, ram: core.mem, disk: core.disk, load_avg: core.load, uptime: core.uptime, net_in_speed: core.net_in_speed, net_out_speed: core.net_out_speed, tcp_conn: core.tcp_conn, udp_conn: core.udp_conn, last_updated: timestamp, realtime_state: snapshot.core_state, _realtime_ts: timestamp }); updateProbeDetailCharts(probeDetail.value); }
                      }
                      if (resultServer && snapshot.core_warp_result?.warp) resultServer.warp = snapshot.core_warp_result.warp;
                      if (resultServer && snapshot.core_warp_result?.egress_ip) applyEgressProbeResult(resultServer, { success: true, ...snapshot.core_warp_result });
                      if (resultServer && Array.isArray(snapshot.proxy?.details)) {
                          const details = snapshot.proxy.details;
                          const active = details.find(item => item?.active && (item.exit_ip || item.node_ip));
                          const standby = details.find(item => !item?.active && (item.exit_ip || item.node_ip));
                          const blockingReason = ['Worker 未配置住宅代理凭据', '外部住宅控制器模式不支持本机住宅出口'].includes(resultServer.residential_reason);
                          Object.assign(resultServer, {
                              residential_active_exit_ip: active?.exit_ip || active?.node_ip || '',
                              residential_standby_exit_ip: standby?.exit_ip || standby?.node_ip || '',
                              residential_ready: !!active && !blockingReason,
                              residential_reason: active && !blockingReason ? '' : (resultServer.residential_reason || '住宅 OpenVPN 主通道尚未就绪'),
                              residential_last_seen: Number(snapshot.proxy_last_seen || snapshot.updated_at || Date.now()),
                          });
                      }
                      window.kuiRealtimeProxySnapshots = window.kuiRealtimeProxySnapshots || {};
                      if (snapshot.proxy || snapshot.proxy_state || snapshot.proxy_config_result) { const previous = window.kuiRealtimeProxySnapshots[snapshot.ip] || {}; window.kuiRealtimeProxySnapshots[snapshot.ip] = { ...previous, ...snapshot, proxy: snapshot.proxy || previous.proxy }; if (activeTab.value === 'proxy') setTimeout(pcFetchNodes, 0); }
                  };
                  const scheduleRealtimeFallback = () => {
                      clearTimeout(realtimeFallbackTimer);
                      if (!realtimeDisconnectedAt) realtimeDisconnectedAt = Date.now();
                      const remaining = Math.max(0, 30000 - (Date.now() - realtimeDisconnectedAt));
                      realtimeFallbackTimer = setTimeout(() => { if (!document.hidden && !realtimeConnected.value && isLoggedIn.value) { stopPolling(); startPolling(); startProbePolling(); if (activeTab.value === 'proxy') pcInitProxy(); } }, remaining);
                  };
                  const connectRealtime = async () => {
                      if (!isLoggedIn.value || role.value !== 'admin' || !realtimeUrl.value || document.hidden) return;
                      if (realtimeSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(realtimeSocket.readyState)) return;
                      const generation = ++realtimeGeneration;
                      scheduleRealtimeFallback();
                      try {
                          const authHeaders = await window.kuiAdminAuthHeader();
                          const ticketController = new AbortController();
                          const ticketTimeout = setTimeout(() => ticketController.abort(), 30000);
                          const ticketRes = await fetch(`${realtimeUrl.value}/dashboard/ticket`, { method: 'POST', headers: authHeaders, signal: ticketController.signal }).finally(() => clearTimeout(ticketTimeout));
                          if (!ticketRes.ok) throw new Error(`ticket ${ticketRes.status}`);
                          const { ticket } = await ticketRes.json();
                          if (generation !== realtimeGeneration || !isLoggedIn.value || role.value !== 'admin' || document.hidden) return;
                          const wsUrl = realtimeUrl.value.replace(/^http/, 'ws') + `/dashboard/ws?ticket=${encodeURIComponent(ticket)}`;
                          const socket = new WebSocket(wsUrl);
                          realtimeSocket = socket;
                          clearTimeout(realtimeConnectTimer);
                          realtimeConnectTimer = setTimeout(() => { if (realtimeSocket === socket && socket.readyState === WebSocket.CONNECTING) socket.close(); }, 30000);
                          socket.onopen = () => { if (realtimeSocket !== socket || generation !== realtimeGeneration) return socket.close(); clearTimeout(realtimeConnectTimer); realtimeDisconnectedAt = 0; realtimeRetryDelay = 5000; lastRealtimePing = Date.now(); realtimeConnected.value = true; window.kuiRealtimeConnected = true; clearTimeout(realtimeFallbackTimer); publicRealtimeSocket?.close(); refreshData(); stopPolling(); stopProbePolling(); pcStopProxy(); clearInterval(realtimePingTimer); realtimePingTimer = setInterval(() => { const now = Date.now(); if (realtimeSocket?.readyState === WebSocket.OPEN && now - lastRealtimePing >= 30000) { realtimeSocket.send('ping'); lastRealtimePing = now; } servers.value.forEach(server => { if (server.realtime_state === 'online' && now - server.last_report > 20000) server.realtime_state = 'stale'; }); publicProbeServers.value.forEach(server => { if (server.realtime_state === 'online' && server.last_updated && now - server.last_updated > 20000) server.realtime_state = 'stale'; }); if (activeTab.value === 'nodes') loadTrafficStats(); if (activeTab.value === 'proxy') pcFetchNodes(); }, 5000); };
                          socket.onmessage = event => { if (realtimeSocket !== socket) return; try { const message = JSON.parse(event.data); if (message.type === 'snapshot') (message.data || []).forEach(applyRealtimeSnapshot); else if (message.type === 'patch') applyRealtimeSnapshot(message.data); } catch(e) {} };
                          socket.onclose = () => { if (realtimeSocket !== socket) return; clearTimeout(realtimeConnectTimer); clearInterval(realtimePingTimer); realtimeConnected.value = false; window.kuiRealtimeConnected = false; realtimeSocket = null; if (isLoggedIn.value && !document.hidden) { scheduleRealtimeFallback(); clearTimeout(realtimeReconnectTimer); const delay = realtimeRetryDelay; realtimeRetryDelay = nextRealtimeRetryDelay(realtimeRetryDelay); realtimeReconnectTimer = setTimeout(connectRealtime, delay); } };
                          socket.onerror = () => socket.close();
                      } catch(e) { if (generation !== realtimeGeneration) return; scheduleRealtimeFallback(); clearTimeout(realtimeReconnectTimer); const delay = realtimeRetryDelay; realtimeRetryDelay = nextRealtimeRetryDelay(realtimeRetryDelay); realtimeReconnectTimer = setTimeout(connectRealtime, delay); }
                  };
                  const connectPublicRealtime = () => {
                      if (isLoggedIn.value || !realtimeUrl.value || probeSys.is_public !== 'true' || document.hidden) return;
                      if (publicRealtimeSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(publicRealtimeSocket.readyState)) return;
                      const socket = new WebSocket(realtimeUrl.value.replace(/^http/, 'ws') + '/public/ws');
                      publicRealtimeSocket = socket;
                      clearTimeout(publicRealtimeConnectTimer);
                      publicRealtimeConnectTimer = setTimeout(() => { if (publicRealtimeSocket === socket && socket.readyState === WebSocket.CONNECTING) socket.close(); }, 30000);
                      socket.onopen = () => { if (publicRealtimeSocket !== socket) return socket.close(); clearTimeout(publicRealtimeConnectTimer); publicRealtimeDisconnectedAt = 0; publicRealtimeRetryDelay = 10000; clearTimeout(publicRealtimeFallbackTimer); stopProbePolling(); clearInterval(publicRealtimeActivityTimer); socket.send(JSON.stringify({ type: 'activity' })); publicRealtimeActivityTimer = setInterval(() => { if (publicRealtimeSocket === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'activity' })); }, 30000); };
                      socket.onmessage = event => { if (publicRealtimeSocket !== socket) return; try { const message = JSON.parse(event.data); if (message.type === 'snapshot') (message.data || []).forEach(applyRealtimeSnapshot); else if (message.type === 'patch') applyRealtimeSnapshot(message.data); } catch(e) {} };
                      socket.onclose = event => { if (publicRealtimeSocket !== socket) return; clearTimeout(publicRealtimeConnectTimer); publicRealtimeSocket = null; clearInterval(publicRealtimeActivityTimer); if (event.code === 1008) { clearTimeout(publicRealtimeReconnectTimer); stopProbePolling(); publicProbeServers.value = []; probeSys.is_public = 'false'; return; } if (!publicRealtimeDisconnectedAt) publicRealtimeDisconnectedAt = Date.now(); clearTimeout(publicRealtimeFallbackTimer); publicRealtimeFallbackTimer = setTimeout(() => { if (!document.hidden && !isLoggedIn.value) startProbePolling(); }, Math.max(0, 30000 - (Date.now() - publicRealtimeDisconnectedAt))); clearTimeout(publicRealtimeReconnectTimer); const delay = publicRealtimeRetryDelay; publicRealtimeRetryDelay = nextRealtimeRetryDelay(publicRealtimeRetryDelay); publicRealtimeReconnectTimer = setTimeout(connectPublicRealtime, delay); };
                      socket.onerror = () => socket.close();
                  };
                  const notifyRealtime = async (ip = '') => { if (!realtimeUrl.value || role.value !== 'admin') return; try { const headers = await window.kuiAdminAuthHeader(); await fetch(`${realtimeUrl.value}/notify`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(ip ? { ip } : {}) }); } catch(e) {} };
                  window.kuiNotifyRealtime = notifyRealtime;
                  const startPolling = () => { 
                      if (realtimeConnected.value) return;
                      if (!dataTimer) { refreshData(); dataTimer = setInterval(() => { if (isLoggedIn.value && !document.hidden && activeTab.value !== 'probe') refreshData(); }, FALLBACK_DATA_INTERVAL); }
                      if (!pingTimer) { sendUiPing(); pingTimer = setInterval(() => { if (isLoggedIn.value && !document.hidden) sendUiPing(); }, FALLBACK_UI_PING_INTERVAL); }
                  };
                  const startProbePolling = () => { 
                      if ((realtimeConnected.value && isLoggedIn.value && role.value === 'admin') || publicRealtimeSocket?.readyState === WebSocket.OPEN) return;
                      if (!probeTimer) { fetchProbeData(); probeTimer = setInterval(() => { if (!document.hidden && (!isLoggedIn.value || activeTab.value === 'probe')) fetchProbeData(); }, FALLBACK_PROBE_INTERVAL); }
                  }
                  const stopProbePolling = () => { if (probeTimer) { clearInterval(probeTimer); probeTimer = null; } };
                  const stopPolling = () => { if (dataTimer) { clearInterval(dataTimer); dataTimer = null; } if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

                  onMounted(async () => {
                      if (authKey.value && currentUser.value) {
                          isLoggedIn.value = true;
                          if (role.value !== 'admin' && ['proxy', 'warp'].includes(activeTab.value)) activeTab.value = 'dashboard';
                          if (role.value === 'admin') {
                              await refreshData();
                              queueMicrotask(connectRealtime);
                          } else startPolling();
                          if (activeTab.value === 'proxy') setTimeout(pcInitProxy, 0);
                      }
                      await fetchProbeData();
                      if (!isLoggedIn.value || role.value !== 'admin') startProbePolling();
                      document.addEventListener('visibilitychange', () => { if (document.hidden) { realtimeGeneration++; realtimeDisconnectedAt = 0; publicRealtimeDisconnectedAt = 0; stopPolling(); stopProbePolling(); clearInterval(realtimePingTimer); clearInterval(publicRealtimeActivityTimer); clearTimeout(realtimeFallbackTimer); clearTimeout(realtimeReconnectTimer); clearTimeout(publicRealtimeReconnectTimer); const socket = realtimeSocket; realtimeSocket = null; socket?.close(); const publicSocket = publicRealtimeSocket; publicRealtimeSocket = null; publicSocket?.close(); realtimeConnected.value = false; window.kuiRealtimeConnected = false; } else if (isLoggedIn.value && role.value === 'admin' && realtimeUrl.value) { connectRealtime(); scheduleRealtimeFallback(); } else if (!isLoggedIn.value && realtimeUrl.value && probeSys.is_public === 'true') { connectPublicRealtime(); } else { if (isLoggedIn.value) startPolling(); startProbePolling(); } });
                  });

                  return { 
                      isLoggedIn, showLoginModal, loginUser, password, loginPending, currentUser, role, activeTab, colorMode, effectiveColorMode, refreshing, refreshPanel,
                      servers, nodes, users, groups, securityWarnings, proxyCredentialsReady, proxyPublicListenerManageable, publicListenerSaving, setProxyPublicListener, addingVps, addingNode, newVps, newNodeParams, nodeEditDrafts, newUser, newGroupName,
                      login, logout, refreshData, openProxyList, addUser, toggleUser, deleteUser, resetUserTraffic, addGroup, saveGroup, deleteGroup, groupDraft, addVps, copyPurgeCommand, addNode, startEditNode, cancelEditNode, saveNodeEdit, deleteNode, toggleNode, resetTraffic,
                      getNodesByIp, getVpsName, formatBytes, formatDate, getExpireText, getTrafficPercent, getPingColor, isOnline, generateCmd, generateUninstallCmd, copyDeployCommand, copyUninstallCommand, copyPurgeCommand, requestAgentBootstrapToken, generateSs2022Password, generateSubLink, generateMtproxyLink, copyCommand, copySurgeConfig,
                      globalOnline, globalTraffic, globalSpeedIn, globalSpeedOut, deployOsMap, saveOsMap, siteTitle, siteTitleInput, siteTitleDirty, markSiteTitleDirty, saveSiteTitle, siteTitleSaving, userNewPassword, updateUserPassword, passwordSaving, resetMySubLink, subTokenResetting, generateUUIDForNewUser, batchStartPort, batchUser, deployAllProtocols,
                      probeSys, publicProbeServers, filteredProbeServers, probeView, probeDetailId, probeDetail, setProbeView, openProbeDetail, probeGlobalOnline, probeGlobalOffline, probeGlobalSpeedIn, probeGlobalSpeedOut, probeGlobalNetRx, probeGlobalNetTx, filteredProbeGroups, probeCountryStats, currentFilter,
                      probeSettingsDirty, markProbeSettingsDirty, probeSettingsSaving, saveProbeSettings, subscriptionProtectionSaving, saveSubscriptionProtection, adminProbeServers, probeEditModalOpen, editingProbeNode, openProbeEditModal, saveProbeEdit, deleteProbeNode, currentDomain,
                      thirdPartySubscriptions, newThirdParty, loadingThirdParty, loadThirdPartySubscriptions, addThirdPartySubscription, toggleThirdPartySubscription, deleteThirdPartySubscription,
                      qrModalOpen, qrCodeImage, showQrCode, 
                      showWelcomePopup, closePopup,
                      availableThemes, pingNodes, pullGithubNodes, githubNodesPulling, hasCustomCssFlag,
                      proxyConfig, toggleNodeProxy, saveProxyConfig, switchProxyIP, proxyPool, loadProxyPool, egressModeLabel, updateVpsEgress, forceReapplyEgress, refreshVpsEgressIp, egressIpRefreshing, egressModeOf, proxyModeOf, proxyCategoriesOf, proxyCategoryOptions, proxyCategoryActive, toggleProxyCategory, markEgressDirty, markProxyCustomDomainsDirty, clearProxyCustomDomains, proxyCustomDomainCount, setProxyMode, egressHasDraft, applyEgressDraft, cancelEgressDraft, onEgressModeChange,
                      warpTargetIp, warpSelectedCandidate, warpActionPending, startWarpOptimization, applyWarpCandidate, cancelWarpOptimization, restoreWarpEndpoint, updateWarpPolicy,
                  };
}
