import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { pcFetchNodes, pcInitProxy, pcInvalidateLoadedConfig, pcLoadConfig, pcPopulateTargets, pcStopProxy } from '../proxy/legacyProxy.js';
import { createApiClient } from './useApi.js';
import { generateRealityKeys, generateSs2022Password } from './useAuth.js';
import { countryCoords, iso2To3 } from './useProbe.js';
import { nextRealtimeRetryDelay, normalizeRealtimeKey, realtimeStaleAfterMs } from './useRealtime.js';
import { applyEgressProbeResult, applyEgressRealtimeResult, extractTunnelPurity, mergeServerRealtimeTelemetry, resolveCurrentServer, shouldAutoProbeEgress, shouldSuggestWarpOptimization } from '../utils/egressState.js';
import { ensureChartJs, ensureEcharts, ensureLeaflet, ensureQrious, ensureTweetNacl } from '../utils/externalDeps.js';
import { buildProbeThemeCss, createDefaultProbeThemes } from '../styles/probeThemes.js';


export function useKuiState() {
                  let isUnmounted = false;
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
                  let realtimeTicketController = null; let realtimeTicketGeneration = 0; let realtimeTicketAuthGeneration = -1; let realtimeConnectPromise = null;
                  const abortRealtimeTicket = () => {
                      realtimeGeneration++;
                      if (realtimeTicketController) realtimeTicketController.abort();
                      realtimeTicketController = null;
                      realtimeConnectPromise = null;
                      realtimeTicketGeneration = 0;
                      realtimeTicketAuthGeneration = -1;
                  };
                  let publicRealtimeSocket = null; let publicRealtimeReconnectTimer = null; let publicRealtimeFallbackTimer = null; let publicRealtimeConnectTimer = null; let publicRealtimeActivityTimer = null; let publicRealtimeDisconnectedAt = 0; let publicRealtimeRetryDelay = 10000;
                  let proxyInitTimer = null;
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
                  const egressAppliedProbeMarkers = new Map();
                  const egressProbeInfo = reactive({});
                  const residentialProbeSchedule = new Map();
                  let residentialProbeTimer = null;
                  const warpTargetIp = ref('');
                  const warpSelectedCandidate = ref('');
                  const warpActionPending = ref(false);

                  // --- 动态拉取核心 ---
                  const availableThemes = ref(createDefaultProbeThemes());
                  const pingNodes = reactive({ ct: [], cu: [], cm: [] });

                  const probeSys = reactive({ theme: 'theme1', is_public: 'false', subscription_protection: 'true', site_title: 'Server Monitor Pro', custom_bg: '', custom_css: '', report_interval: '5', realtime_admin_interval: '5', realtime_public_interval: '10', realtime_idle_interval: '30', visits_total: '0', visits_today: '0', ping_node_ct: 'default', ping_node_cu: 'default', ping_node_cm: 'default', enable_popup: 'false', popup_content: '', tg_notify: 'false', tg_bot_token: '', tg_chat_id: '' });
                  const FALLBACK_DATA_INTERVAL = 60000;
                  const FALLBACK_PROBE_INTERVAL = 30000;
                  const FALLBACK_UI_PING_INTERVAL = 60000;
                  const publicProbeServers = ref([]);
                  const probeView = ref(localStorage.getItem('monitor_preferred_view') || 'card');
                  const probeDetailId = ref(null); const probeDetail = ref({});
                  let probeCharts = {};
                  const currentFilter = ref('all');
                  const kuiChartInstances = new Map();
                  let kuiChartRenderSeq = 0;

                  const adminProbeServers = ref([]);
                  const probeEditModalOpen = ref(false); const editingProbeNode = ref({});
                  
                  const qrModalOpen = ref(false);
                  const qrCodeImage = ref('');
                  let qrRequestId = 0;
                  watch(qrModalOpen, open => { if (!open) qrRequestId++; });
                  
                  const toast = reactive({ visible: false, text: '', tone: 'info' });
                  let toastTimer = null;
                  const dismissToast = () => {
                      clearTimeout(toastTimer);
                      toastTimer = null;
                      toast.visible = false;
                  };
                  const showToast = (text, tone = 'info', duration = 2800) => {
                      const message = String(text || '').trim();
                      if (!message) return;
                      clearTimeout(toastTimer);
                      toast.text = message;
                      toast.tone = tone || 'info';
                      toast.visible = true;
                      if (duration > 0) {
                          toastTimer = setTimeout(() => { toast.visible = false; toastTimer = null; }, duration);
                      }
                  };

                  const showWelcomePopup = ref(false);

                  watch(activeTab, (val) => { qrRequestId++; qrModalOpen.value = false; qrCodeImage.value = ''; localStorage.setItem('monitor_preferred_tab', val); if (val === 'proxy' && isLoggedIn.value) { loadProxyPool(); clearTimeout(proxyInitTimer); proxyInitTimer = setTimeout(pcInitProxy, 0); } else { clearTimeout(proxyInitTimer); proxyInitTimer = null; pcStopProxy(); } if (val === 'nodes' && isLoggedIn.value && role.value === 'admin') loadTrafficStats(true); else disposeKuiCharts(); if (isLoggedIn.value && val !== 'probe') destroyMap(); if (val === 'probe' && probeView.value === 'map') nextTick(() => { if (isProbeViewVisible() && probeView.value === 'map') initMap(); }); if (val === 'warp' && !warpTargetIp.value && servers.value.length) warpTargetIp.value = servers.value[0].ip; if (val === 'warp' && realtimeSocket?.readyState === WebSocket.OPEN) realtimeSocket.send(JSON.stringify({ type: 'resync' })); if (val === 'thirdparty') loadThirdPartySubscriptions(); if (val === 'settings' && isLoggedIn.value && role.value === 'admin') loadAdminProbeServers(); if (val === 'probe') updateCustomStyles(); else { document.body.className = ''; document.getElementById('kui-custom-styles')?.remove(); } });
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

                  const updateCustomStyles = () => {
                      if (isLoggedIn.value && activeTab.value !== 'probe') return;
                      document.body.className = probeSys.theme || 'theme1';

                      let styleTag = document.getElementById('kui-custom-styles');
                      if (!styleTag) { styleTag = document.createElement('style'); styleTag.id = 'kui-custom-styles'; document.head.appendChild(styleTag); }

                      const css = buildProbeThemeCss({
                          themeId: probeSys.theme,
                          availableThemes: availableThemes.value,
                          customCss: probeSys.custom_css,
                          customBg: probeSys.custom_bg,
                      });
                      styleTag.textContent = css;

                  };

                  watch(() => probeSys.theme, updateCustomStyles);
                  watch(() => probeSys.custom_css, updateCustomStyles);
                  watch(() => probeSys.custom_bg, updateCustomStyles);

                  const isOnline = (lastReport, realtimeState = '') => {
                      if (lastReport && typeof lastReport === 'object') {
                          realtimeState = lastReport.realtime_state || '';
                          lastReport = lastReport.last_report ?? lastReport.last_updated;
                      }
                      return realtimeState ? realtimeState === 'online' : !!lastReport && (Date.now() - lastReport) < 1200000;
                  };
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
                  window.kuiManagedServers = () => servers.value.map(server => ({
                      name: String(server.name || '').trim(),
                      ip: server.ip,
                      egress_mode: server.egress_mode || 'native',
                      egress_applied_mode: server.egress_applied_mode || server.egress_mode || 'native',
                      proxy_mode: server.proxy_mode || 'global',
                  })).filter(server => server.ip);
                  window.kuiManagedServerIps = () => servers.value.map(server => server.ip).filter(Boolean);
                  window.kuiShowToast = showToast;

                  const openResidentialProxy = (ip = '') => {
                      if (ip) window.pcPreferredTargetIp = String(ip);
                      if (activeTab.value === 'proxy') {
                          pcPopulateTargets();
                          pcInvalidateLoadedConfig();
                          pcLoadConfig();
                          pcFetchNodes();
                      } else {
                          activeTab.value = 'proxy';
                      }
                  };

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
                  
                  const clearPrivateState = () => {
                      residentialProbeSchedule.clear();
                      egressAppliedProbeMarkers.clear();
                      egressRefreshTimers.forEach(timer => clearTimeout(timer));
                      egressRefreshTimers.clear();
                      egressRefreshSilent.clear();
                      for (const key of Object.keys(egressProbeInfo)) delete egressProbeInfo[key];
                      for (const key of Object.keys(egressIpRefreshing)) delete egressIpRefreshing[key];
                      for (const key of Object.keys(egressRefreshRequests)) delete egressRefreshRequests[key];
                      servers.value = []; nodes.value = []; users.value = []; groups.value = []; trafficTotals.value = {}; trafficSeries.value = {}; trafficStatsLastFetchedAt = 0; addingVps.value = false; adminProbeServers.value = []; mySubToken.value = ''; publicProbeServers.value = []; probeDetailId.value = null; probeDetail.value = {}; pcStopProxy({ resetSession: true }); window.kuiRealtimeProxySnapshots = {};
                      subTokenResetting.value = false;
                      probeEditModalOpen.value = false;
                      editingProbeNode.value = {};
                      availableThemes.value = createDefaultProbeThemes();
                      for (const key of Object.keys(newNodeParams)) delete newNodeParams[key];
                      for (const key of Object.keys(nodeEditDrafts)) delete nodeEditDrafts[key];
                      for (const key of Object.keys(addingNode)) delete addingNode[key];
                      for (const key of Object.keys(batchStartPort)) delete batchStartPort[key];
                      for (const key of Object.keys(batchUser)) delete batchUser[key];
                      for (const key of Object.keys(groupDrafts)) delete groupDrafts[key];
                      Object.assign(probeSys, { theme: 'theme1', is_public: 'false', subscription_protection: 'true', site_title: 'Server Monitor Pro', custom_bg: '', custom_css: '', report_interval: '5', realtime_admin_interval: '5', realtime_public_interval: '10', realtime_idle_interval: '30', visits_total: '0', visits_today: '0', ping_node_ct: 'default', ping_node_cu: 'default', ping_node_cm: 'default', enable_popup: 'false', popup_content: '', tg_notify: 'false', tg_bot_token: '', tg_chat_id: '' });
                      delete probeSys.cached_nodes_data;
                      pingNodes.ct = []; pingNodes.cu = []; pingNodes.cm = [];
                      disposeKuiCharts();
                      qrRequestId++;
                      qrCodeImage.value = '';
                      qrModalOpen.value = false;
                  };
                  const logout = () => { const token = authKey.value; if (token) fetch('/api/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, keepalive: true }).catch(() => {}); authGeneration++; sessionStorage.removeItem('kui_auth_key'); sessionStorage.removeItem('kui_user'); sessionStorage.removeItem('kui_role'); isLoggedIn.value = false; currentUser.value = ''; authKey.value = ''; clearPrivateState(); activeTab.value = 'probe'; abortRealtimeTicket(); realtimeDisconnectedAt = 0; clearTimeout(realtimeFallbackTimer); clearTimeout(realtimeReconnectTimer); clearTimeout(realtimeConnectTimer); clearInterval(realtimePingTimer); const socket = realtimeSocket; realtimeSocket = null; socket?.close(); realtimeConnected.value = false; window.kuiRealtimeConnected = false; stopPolling(); startProbePolling();};
                  const sendUiPing = async () => { try { await fetchApi('/api/ui_ping', { method: 'POST' }); } catch(e) {} };

                  let mapInitPromise = null; let geoJsonPromise = null; let leafletLib = null; let myMap = null; let myMapContainer = null; let markersLayer = null; let geoJsonLayer = null; let worldGeoJson = null; let currentMapDataStr = "";
                  const isProbeViewVisible = () => !isLoggedIn.value || activeTab.value === 'probe';
                  const isMapAttached = () => Boolean(myMap && myMapContainer && myMapContainer.isConnected && myMapContainer === document.getElementById('map-container'));
                  const destroyMap = () => {
                      if (myMap) {
                          try { myMap.remove(); } catch (error) { console.error('[probe] map cleanup failed', error); }
                      }
                      myMap = null; myMapContainer = null; markersLayer = null; geoJsonLayer = null; currentMapDataStr = '';
                  };
                  const loadWorldGeoJson = async () => {
                      if (worldGeoJson) return worldGeoJson;
                      if (geoJsonPromise) return geoJsonPromise;
                      geoJsonPromise = (async () => {
                          try {
                              const res = await fetch('https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json', { signal: AbortSignal.timeout(15000) });
                              if (res.ok === false) throw new Error(`countries.geo.json ${res.status}`);
                              worldGeoJson = await res.json();
                              if (isMapAttached() && isProbeViewVisible()) drawMarkers();
                              return worldGeoJson;
                          } catch (error) {
                              console.error('[probe] GeoJSON load failed', error);
                              return null;
                          } finally {
                              geoJsonPromise = null;
                          }
                      })();
                      return geoJsonPromise;
                  };
                  const initMap = async () => {
                      if (isUnmounted || !isProbeViewVisible() || probeView.value !== 'map') return;
                      const container = document.getElementById('map-container');
                      if (!container) return;
                      if (myMap) {
                          if (myMapContainer === container && myMapContainer.isConnected) return myMap;
                          destroyMap();
                      }
                      if (mapInitPromise) return mapInitPromise;
                      mapInitPromise = (async () => {
                          const geoJsonRequest = loadWorldGeoJson();
                          try {
                              leafletLib = await ensureLeaflet();
                              const L = leafletLib;
                              if (isUnmounted || !isProbeViewVisible() || probeView.value !== 'map') return;
                              const currentContainer = document.getElementById('map-container');
                              if (!currentContainer) return;
                              if (myMap) {
                                  if (myMapContainer === currentContainer && myMapContainer.isConnected) return myMap;
                                  destroyMap();
                              }
                              myMap = L.map('map-container', { zoomControl: true, attributionControl: false, minZoom: 1 }).setView([30, 10], 2);
                              myMapContainer = currentContainer;
                              currentMapDataStr = '';
                              drawMarkers();
                              void geoJsonRequest;
                          } catch (error) {
                              console.error('[probe] map initialization failed', error);
                              destroyMap();
                          } finally {
                              mapInitPromise = null;
                          }
                      })();
                      return mapInitPromise;
                  };
                  const drawMarkers = () => {
                      const L = leafletLib || window.L;
                      if (!myMap || !worldGeoJson || !L) return;
                      const newDataStr = JSON.stringify(probeCountryStats.value);
                      if (currentMapDataStr === newDataStr) return; currentMapDataStr = newDataStr;
                      if (geoJsonLayer) myMap.removeLayer(geoJsonLayer);
                      if (markersLayer) markersLayer.clearLayers(); else markersLayer = L.layerGroup().addTo(myMap);
                      const activeTheme = availableThemes.value.find(theme => theme.id === probeSys.theme);
                      const isDark = Boolean(activeTheme?.is_dark);
                      const activeIso3 = {}; for (const code in probeCountryStats.value) { if (iso2To3[code]) activeIso3[iso2To3[code]] = true; }
                      
                      if (activeIso3['CHN'] || activeIso3['TWN'] || activeIso3['HKG'] || activeIso3['MAC']) {
                          activeIso3['CHN'] = true; activeIso3['TWN'] = true; activeIso3['HKG'] = true; activeIso3['MAC'] = true;
                      }
                      geoJsonLayer = L.geoJSON(worldGeoJson, { style: function(feature) { const isActive = activeIso3[feature.id]; return { fillColor: isActive ? '#10b981' : (isDark ? '#2a303c' : '#d5dce2'), weight: 1, opacity: 1, color: isDark ? '#1a202c' : '#ffffff', fillOpacity: 1 }; } }).addTo(myMap);
                      for (const [code, count] of Object.entries(probeCountryStats.value)) { if(countryCoords[code]) { const icon = L.divIcon({ className: 'probe-custom-map-badge', html: `<div>${count}</div>`, iconSize: [22,22] }); L.marker(countryCoords[code], {icon: icon}).addTo(markersLayer); } }
                  };

                  const setProbeView = (view) => {
                      probeView.value = view;
                      if (view !== 'map') return;
                      nextTick(() => {
                          if (isUnmounted || !isProbeViewVisible()) return;
                          const container = document.getElementById('map-container');
                          if (myMap && myMapContainer === container && myMapContainer.isConnected) {
                              myMap.invalidateSize();
                              drawMarkers();
                              if (!worldGeoJson && !geoJsonPromise) {
                                  loadWorldGeoJson().then(geoJson => {
                                      if (!geoJson || isUnmounted || !isProbeViewVisible() || probeView.value !== 'map') return;
                                      drawMarkers();
                                  });
                              }
                              return;
                          }
                          if (myMap) destroyMap();
                          initMap();
                      });
                  };

                  const destroyProbeDetailCharts = () => {
                      const charts = probeCharts || {};
                      probeCharts = {};
                      Object.values(charts).forEach(chart => {
                          try { chart?.destroy?.(); } catch (error) { console.error('[probe] chart cleanup failed', error); }
                      });
                  };
                  watch(probeDetailId, value => { if (value === null) destroyProbeDetailCharts(); });

                  const initProbeDetailCharts = async (expectedId = probeDetailId.value) => {
                      let Chart;
                      try {
                          Chart = await ensureChartJs();
                      } catch (error) {
                          console.error('[probe] Chart.js load failed', error);
                          return;
                      }
                      await nextTick();
                      if (isUnmounted || !expectedId || probeDetailId.value !== expectedId) return;

                      const chartIds = ['probeChartCPU', 'probeChartRAM', 'probeChartProc', 'probeChartNet', 'probeChartConn', 'probeChartPing'];
                      const canvases = Object.fromEntries(chartIds.map(id => [id, document.getElementById(id)]));
                      if (Object.values(canvases).some(canvas => !canvas)) return;

                      const commonOptions = { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { beginAtZero: true, border: { display: false } } }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, elements: { point: { radius: 0 }, line: { tension: 0.4, borderWidth: 2 } } };
                      const pingOptions = { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: true, ticks: { maxTicksLimit: 15, color: '#9ca3af', font: { size: 10 } } }, y: { beginAtZero: true, border: { display: false } } }, plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { enabled: true, mode: 'index', intersect: false } }, elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 }, line: { tension: 0.3, borderWidth: 2 } } };
                      const createChart = (canvas, color, bgColor) => new Chart(canvas.getContext('2d'), { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: bgColor, fill: true }] }, options: commonOptions });
                      try {
                          destroyProbeDetailCharts();
                          probeCharts.cpu = createChart(canvases.probeChartCPU, '#3b82f6', 'rgba(59, 130, 246, 0.1)');
                          probeCharts.ram = createChart(canvases.probeChartRAM, '#8b5cf6', 'rgba(139, 92, 246, 0.1)');
                          probeCharts.proc = createChart(canvases.probeChartProc, '#ec4899', 'rgba(236, 72, 153, 0.1)');
                          probeCharts.net = new Chart(canvases.probeChartNet.getContext('2d'), { type: 'line', data: { labels: [], datasets: [ { label: 'In', data: [], borderColor: '#10b981', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'Out', data: [], borderColor: '#3b82f6', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
                          probeCharts.conn = new Chart(canvases.probeChartConn.getContext('2d'), { type: 'line', data: { labels: [], datasets: [ { label: 'TCP', data: [], borderColor: '#6366f1', borderWidth: 2, tension: 0.4, pointRadius: 0 }, { label: 'UDP', data: [], borderColor: '#d946ef', borderWidth: 2, tension: 0.4, pointRadius: 0 } ]}, options: commonOptions });
                          probeCharts.ping = new Chart(canvases.probeChartPing.getContext('2d'), { type: 'line', data: { labels: [], datasets: [ { label: '电信', data: [], borderColor: '#10b981', backgroundColor: 'transparent' }, { label: '联通', data: [], borderColor: '#f59e0b', backgroundColor: 'transparent' }, { label: '移动', data: [], borderColor: '#3b82f6', backgroundColor: 'transparent' }, { label: '字节', data: [], borderColor: '#8b5cf6', backgroundColor: 'transparent' } ] }, options: pingOptions });
                      } catch (error) {
                          console.error('[probe] chart initialization failed', error);
                          destroyProbeDetailCharts();
                      }
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
                      const detailPromise = fetchProbeData(true);
                      await initProbeDetailCharts(id);
                      if (probeDetail.value?.id === id && probeDetail.value?.history) {
                          updateProbeDetailCharts(probeDetail.value);
                      }
                      await detailPromise;
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
                      const requestAuthGen = authGeneration;
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
                              if (isUnmounted || requestAuthGen !== authGeneration) return;
                              if(!res.ok) { if (probeDetailId.value === requestedId && generation === probeDetailRequestGeneration) probeDetailId.value = null; throw new Error("Detail fetch failed"); }
                              const detail = await res.json();
                              if (isUnmounted || requestAuthGen !== authGeneration || probeDetailId.value !== requestedId || generation !== probeDetailRequestGeneration) return;
                              const live = normalizeRealtimeKey(probeDetail.value?.id) === normalizeRealtimeKey(requestedId) ? probeDetail.value : null;
                              probeDetail.value = live && Number(live._realtime_ts || 0) >= Number(detail.last_updated || 0) ? { ...detail, ...live, stale_after_ms: live.stale_after_ms ?? detail.stale_after_ms, interval_ms: live.interval_ms ?? detail.interval_ms } : detail;
                              updateProbeDetailCharts(probeDetail.value);
                          } else {
                              const ajaxParam = isFirstLoad ? '' : '?ajax=1';
                              isFirstLoad = false;
                              const res = await fetch(`/api/probe/public${ajaxParam}`, {headers: authHeader});
                              if (isUnmounted || requestAuthGen !== authGeneration || document.hidden) return;
                              if (!res.ok) { if(res.status===401) { publicProbeServers.value = []; showLoginModal.value = true; } throw new Error("Private Dashboard"); }
                              const data = await res.json(); 
                              if (isUnmounted || requestAuthGen !== authGeneration || document.hidden) return;
                              Object.assign(probeSys, data.settings || {});
                              if (data.settings?.cached_nodes_data) parseCachedNodes(data.settings.cached_nodes_data);
                              const liveByIp = new Map(publicProbeServers.value.filter(item => item._realtime_ts).map(item => [normalizeRealtimeKey(item.id), item]));
                              publicProbeServers.value = (data.servers || []).map(item => {
                                  const live = liveByIp.get(normalizeRealtimeKey(item.id));
                                  return live && live._realtime_ts >= Number(item.last_updated || 0) ? { ...item, ...live, stale_after_ms: live.stale_after_ms ?? item.stale_after_ms, interval_ms: live.interval_ms ?? item.interval_ms } : item;
                              });
                              if (data.realtime_url !== realtimeUrl.value) realtimeUrl.value = data.realtime_url || '';
                              // A logged-in admin must use the Dashboard channel even
                              // while viewing the probe page. Re-check after every
                              // probe load to avoid the login/realtime URL race.
                              if (requestAuthGen !== authGeneration || isUnmounted) return;
                              if (isLoggedIn.value && role.value === 'admin' && realtimeUrl.value) queueMicrotask(connectRealtime);
                              else if (!isLoggedIn.value && data.settings?.is_public === 'true') queueMicrotask(connectPublicRealtime);
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
                      const opAuthGen = authGeneration;
                      isLoadingAdminProbeServers = true;
                      try {
                          const probeRes = await fetchApi('/api/probe/admin/data');
                          if (isUnmounted || opAuthGen !== authGeneration || !isLoggedIn.value) return;
                          if (!probeRes.ok) throw new Error(`Probe data request failed: ${probeRes.status}`);
                          const probeData = await probeRes.json();
                          if (isUnmounted || opAuthGen !== authGeneration || !isLoggedIn.value) return;
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
                      const requestAuthGen = authGeneration;
                      if (isUnmounted || requestAuthGen !== authGeneration || !isLoggedIn.value) return;
                      if (!kuiFetchPromise) kuiFetchPromise = (async () => {
                      try {
                          const res = await fetchApi('/api/data'); const data = await res.json();
                          if (isUnmounted || requestAuthGen !== authGeneration || !isLoggedIn.value) return;
                          if (document.hidden) return;
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
                          });
                          if (activeTab.value === 'proxy') pcPopulateTargets();
                          nodes.value = data.nodes || []; users.value = data.users || []; groups.value = (data.groups || []).map(group => { let members = []; let resources = []; try { members = JSON.parse(group.members || '[]'); } catch (e) {} try { resources = JSON.parse(group.resources || '[]'); } catch (e) {} if (!groupDrafts[group.id]) groupDrafts[group.id] = { members: Array.isArray(members) ? members : [], resources: Array.isArray(resources) ? resources.map(resource => `${resource.type}:${resource.id}`) : [] }; return group; });
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
                          const result = await kuiFetchPromise;
                          if (isUnmounted || requestAuthGen !== authGeneration || !isLoggedIn.value) return;
                          return result;
                      } catch (error) {
                          console.error('[panel] data refresh failed', error);
                          if (isUnmounted || requestAuthGen !== authGeneration) return;
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

                  const disposeKuiCharts = () => {
                      kuiChartRenderSeq++;
                      kuiChartInstances.forEach(entry => {
                          try { entry.chart?.dispose?.(); } catch (error) { console.error('[traffic] chart cleanup failed', error); }
                      });
                      kuiChartInstances.clear();
                  };

                  const renderKUICharts = async () => {
                      const renderSeq = ++kuiChartRenderSeq;
                      await nextTick();
                      if (isUnmounted || !isLoggedIn.value || role.value !== 'admin' || activeTab.value !== 'nodes' || !servers.value.length) return;
                      const hasChartContainer = servers.value.some(vps => {
                          const chartDom = document.getElementById('chart-' + vps.ip);
                          return Boolean(chartDom && chartDom.isConnected !== false);
                      });
                      if (!hasChartContainer) return;

                      let echarts;
                      try {
                          echarts = await ensureEcharts();
                      } catch (error) {
                          console.error('[traffic] ECharts load failed', error);
                          return;
                      }
                      await nextTick();
                      if (isUnmounted || renderSeq !== kuiChartRenderSeq || activeTab.value !== 'nodes') return;

                      const currentIps = new Set(servers.value.map(vps => vps.ip));
                      for (const [ip, entry] of kuiChartInstances) {
                          if (currentIps.has(ip)) continue;
                          try { entry.chart?.dispose?.(); } catch (error) { console.error('[traffic] chart cleanup failed', error); }
                          kuiChartInstances.delete(ip);
                      }

                      for (const vps of servers.value) {
                          if (isUnmounted || renderSeq !== kuiChartRenderSeq || activeTab.value !== 'nodes') return;
                          const chartDom = document.getElementById('chart-' + vps.ip);
                          if (!chartDom || chartDom.isConnected === false) continue;
                          const previous = kuiChartInstances.get(vps.ip);
                          if (previous && (previous.dom !== chartDom || !previous.dom?.isConnected)) {
                              try { previous.chart?.dispose?.(); } catch (error) { console.error('[traffic] chart cleanup failed', error); }
                              kuiChartInstances.delete(vps.ip);
                          }
                          try {
                              let entry = kuiChartInstances.get(vps.ip);
                              if (!entry || entry.dom !== chartDom) {
                                  const chart = echarts.init(chartDom);
                                  entry = { chart, dom: chartDom };
                                  kuiChartInstances.set(vps.ip, entry);
                              }
                              const stats = trafficSeries.value[vps.ip] || [];
                              entry.chart.setOption({ grid: { left: '8%', right: '5%', top: '5%', bottom: '15%' }, tooltip: { trigger: 'axis', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderColor: '#e2e8f0', textStyle: { color: '#334155' } }, xAxis: { type: 'category', data: stats.map(s=>s.day), axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: '#cbd5e1' } } }, yAxis: { type: 'value', show: false }, series: [{ data: stats.map(s=>(s.total_bytes/1024/1024).toFixed(2)), type: 'line', smooth: true, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(99, 102, 241, 0.2)' }, { offset: 1, color: 'rgba(99, 102, 241, 0)' }]) }, itemStyle: { color: '#6366f1' }, lineStyle: { width: 3 }, symbol: 'none' }] });
                              if (chartDom.clientWidth > 0) entry.chart.resize?.();
                          } catch (error) {
                              console.error('[traffic] chart render failed', error);
                          }
                      }
                  };

                  const loadTrafficStats = async (force = false, throwOnError = false) => {
                      if (!isLoggedIn.value || role.value !== 'admin') return;
                      const requestAuthGen = authGeneration;
                      if (!force && Date.now() - trafficStatsLastFetchedAt < 120000) {
                          if (activeTab.value === 'nodes') await renderKUICharts();
                          return;
                      }
                      if (!trafficFetchPromise) trafficFetchPromise = (async () => {
                          const response = await fetchApi('/api/stats');
                          const data = await response.json();
                          if (isUnmounted || requestAuthGen !== authGeneration || !isLoggedIn.value) return;
                          trafficTotals.value = data.totals || {};
                          trafficSeries.value = data.series || {};
                          trafficStatsLastFetchedAt = Date.now();
                      })().finally(() => { trafficFetchPromise = null; });
                      try {
                          await trafficFetchPromise;
                          if (isUnmounted || requestAuthGen !== authGeneration || !isLoggedIn.value) return;
                          if (activeTab.value === 'nodes') await renderKUICharts();
                      } catch (error) {
                          console.error('[traffic] statistics refresh failed', error);
                          if (isUnmounted || requestAuthGen !== authGeneration) return;
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
                      const schedule = residentialProbeSchedule.get(vps.ip) || {};
                      schedule.lastAttempt = Date.now();
                      schedule.changedAt = 0;
                      residentialProbeSchedule.set(vps.ip, schedule);
                      egressIpRefreshing[vps.ip] = true;
                      egressRefreshSilent.set(vps.ip, silent);
                      clearTimeout(egressRefreshTimers.get(vps.ip));
                      const requestId = crypto.randomUUID();
                      egressRefreshRequests[vps.ip] = requestId;
                      egressRefreshTimers.set(vps.ip, setTimeout(() => {
                          if (egressIpRefreshing[vps.ip] && !egressRefreshSilent.get(vps.ip)) alert(`刷新 ${vps.name || vps.ip} 实际出口 IP 超时，请确认 Agent 在线且出口可访问。`);
                          egressProbeInfo[vps.ip] = { ...egressProbeInfo[vps.ip], failed: true };
                          egressIpRefreshing[vps.ip] = false;
                          egressRefreshRequests[vps.ip] = '';
                          egressRefreshTimers.delete(vps.ip);
                          egressRefreshSilent.delete(vps.ip);
                      }, 90000));
                      try {
                          const response = await fetchApi('/api/vps/egress-refresh', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ip: vps.ip, request_id: requestId }) });
                          if (!response.ok) throw new Error(`HTTP ${response.status}`);
                      } catch (error) {
                          clearTimeout(egressRefreshTimers.get(vps.ip)); egressRefreshTimers.delete(vps.ip);
                          egressIpRefreshing[vps.ip] = false;
                          egressRefreshRequests[vps.ip] = '';
                          egressRefreshSilent.delete(vps.ip);
                          egressProbeInfo[vps.ip] = { ...egressProbeInfo[vps.ip], failed: true };
                          if (!silent) alert(`刷新实际出口 IP 失败：${error.message}`);
                      }
                  };

                  const updateResidentialProbes = () => {
                      const visible = !isUnmounted && !document.hidden && isLoggedIn.value && role.value === 'admin' && activeTab.value === 'nodes';
                      if (!visible) return;
                      const now = Date.now();
                      for (const vps of servers.value) {
                          const schedule = residentialProbeSchedule.get(vps.ip) || {};
                          const currentExit = vps.residential_active_exit_ip || '';
                          if (schedule.lastExit && currentExit && schedule.lastExit !== currentExit) schedule.changedAt = now;
                          if (currentExit) schedule.lastExit = currentExit;
                          residentialProbeSchedule.set(vps.ip, schedule);
                          if (shouldAutoProbeEgress(vps, schedule, { visible, online: isOnline(vps.last_report, vps.realtime_state), refreshing: !!egressIpRefreshing[vps.ip] }, now)) {
                              refreshVpsEgressIp(vps, true);
                          }
                      }
                  };

                  const isRealityProtocol = protocol => ['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'].includes(protocol);
                  const hasPartialRealityKeys = p => {
                      if (!isRealityProtocol(p?.protocol)) return false;
                      const privateKey = String(p?.reality_private_key || '').trim();
                      const publicKey = String(p?.reality_public_key || '').trim();
                      return Boolean(privateKey) !== Boolean(publicKey);
                  };
                  const needsRealityKeyGen = p => {
                      if (!isRealityProtocol(p?.protocol)) return false;
                      return !String(p?.reality_private_key || '').trim() && !String(p?.reality_public_key || '').trim();
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
                      const opAuthGen = authGeneration;
                      const draft = newNodeParams[ip];
                      if (!draft) return;
                      addingNode[ip] = true;
                      try {
                          if (!hasPartialRealityKeys(newNodeParams[ip]) && needsRealityKeyGen(newNodeParams[ip])) {
                              const expectedDraft = draft;
                              try {
                                  await ensureTweetNacl();
                              } catch (error) {
                                  console.error('[nodes] TweetNaCl load failed', error);
                                  alert('Reality 密钥组件加载失败，请检查网络后重试');
                                  return;
                              }
                              if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration || newNodeParams[ip] !== expectedDraft) return;
                          }
                          if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) return;
                          const payload = buildNodePayload(ip, newNodeParams[ip], crypto.randomUUID());
                          if (!payload) return;
                          await fetchApi('/api/nodes', { method: 'POST', body: JSON.stringify(payload) });
                          if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) return;
                          await refreshData();
                      } finally {
                          if (!isUnmounted && opAuthGen === authGeneration && newNodeParams[ip] === draft && Object.prototype.hasOwnProperty.call(addingNode, ip)) addingNode[ip] = false;
                      }
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
                      if (!node?.id) return;
                      const opAuthGen = authGeneration;
                      const draft = nodeEditDrafts[node.id];
                      if (!draft) return;
                      if (!hasPartialRealityKeys(draft) && needsRealityKeyGen(nodeEditDrafts[node.id])) {
                          try {
                              await ensureTweetNacl();
                          } catch (error) {
                              console.error('[nodes] TweetNaCl load failed', error);
                              alert('Reality 密钥组件加载失败，请检查网络后重试');
                              return;
                          }
                          if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration || nodeEditDrafts[node.id] !== draft) return;
                      }
                      if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) return;
                      const payload = buildNodePayload(node.vps_ip, nodeEditDrafts[node.id], node.id);
                      if (!payload) return;
                      await fetchApi('/api/nodes', { method: 'PUT', body: JSON.stringify(payload) });
                      if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) return;
                      delete nodeEditDrafts[node.id]; await refreshData();
                  };
                  
                  const deployAllProtocols = async (ip) => {
                      const opAuthGen = authGeneration;
                      let startPort = parseInt(batchStartPort[ip]); if (!startPort || startPort < 10 || startPort + 8 > 65535) return alert('⚠️ 请输入有效的起始端口 (推荐: 8881)');
                      const defaultSni = 'addons.mozilla.org'; const commonUser = batchUser[ip] || 'admin'; const commonUUID = crypto.randomUUID(); 
                      const protocolSequence = [ { protocol: 'XTLS-Reality', offset: 0, sni: defaultSni, type: 'reality' }, { protocol: 'Hysteria2', offset: 1, sni: defaultSni }, { protocol: 'TUIC', offset: 2 }, { protocol: 'Shadowsocks2022', offset: 3, method: '2022-blake3-aes-256-gcm' }, { protocol: 'Trojan', offset: 4, sni: defaultSni }, { protocol: 'H2-Reality', offset: 5, sni: defaultSni, type: 'reality' }, { protocol: 'gRPC-Reality', offset: 6, sni: defaultSni, type: 'reality' }, { protocol: 'AnyTLS', offset: 7, sni: defaultSni }, { protocol: 'Naive', offset: 8, sni: defaultSni } ];
                      if (!confirm(`🚀 极速部署确认：\n\n系统将按照 FSCARMEN 模式，向该服务器并发下发完整 ${protocolSequence.length} 个协议矩阵：\n` + protocolSequence.map(p => `- ${p.protocol} (端口: ${startPort + p.offset})`).join('\n') + `\n\n所有节点归属: ${commonUser}\n\n确认立刻组建节点矩阵吗？`)) return;
                      try {
                          await ensureTweetNacl();
                      } catch (error) {
                          console.error('[nodes] TweetNaCl load failed', error);
                          alert('Reality 密钥组件加载失败，请检查网络后重试');
                          return;
                      }
                      if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) return;
                      const failures = [];
                      for (let item of protocolSequence) {
                          if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) break;
                          const payload = { id: Date.now().toString() + Math.floor(Math.random() * 10000), uuid: commonUUID, vps_ip: ip, protocol: item.protocol, port: startPort + item.offset, username: commonUser, traffic_limit: 0, expire_time: 0, sni: item.sni || '', network: item.protocol === 'H2-Reality' ? 'http' : (item.protocol === 'gRPC-Reality' ? 'grpc' : 'tcp') };
                          if (item.type === 'reality') { const keys = generateRealityKeys(); payload.private_key = keys.privateKey; payload.public_key = keys.publicKey; payload.short_id = keys.shortId; } else if (item.protocol === 'Shadowsocks2022') { const key = new Uint8Array(32); crypto.getRandomValues(key); payload.uuid = item.method; payload.private_key = btoa(String.fromCharCode(...key)); payload.network = 'tcp,udp'; } else if (item.protocol === 'Naive') { payload.uuid = commonUUID.replace(/-/g, '').substring(0, 16); payload.private_key = payload.uuid; } else { const array = new Uint8Array(16); crypto.getRandomValues(array); payload.private_key = btoa(String.fromCharCode.apply(null, array)); }
                          try { await fetchApi('/api/nodes', { method: 'POST', body: JSON.stringify(payload) }); } catch(e) { failures.push(`${item.protocol}: ${e.message || '失败'}`); }
                      }
                      if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) return;
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
                      const opAuthGen = authGeneration;
                      subTokenResetting.value = true;
                      try {
                          const response = await fetchApi('/api/user/sub_token', { method: 'PUT' });
                          const data = await response.json();
                          if (isUnmounted || !isLoggedIn.value || opAuthGen !== authGeneration) return;
                          if (data.token) mySubToken.value = data.token;
                          alert('✅ 订阅令牌已刷新！');
                      } catch (error) {
                          console.error('[settings] failed to reset subscription token', error);
                      } finally {
                          if (opAuthGen === authGeneration) subTokenResetting.value = false;
                      }
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

                  const showQrCode = async (text) => {
                      const reqId = ++qrRequestId;
                      const expectedAuthGen = authGeneration;
                      const expectedTab = activeTab.value;
                      try {
                          const QRious = await ensureQrious();
                          if (isUnmounted || reqId !== qrRequestId || authGeneration !== expectedAuthGen || activeTab.value !== expectedTab) return;
                          const qr = new QRious({ value: text, size: 300, level: 'L', background: '#ffffff', foreground: '#1e293b' });
                          qrCodeImage.value = qr.toDataURL(); qrModalOpen.value = true;
                      } catch (err) {
                          if (!isUnmounted && reqId === qrRequestId && authGeneration === expectedAuthGen && activeTab.value === expectedTab) alert('生成二维码失败！请检查链接长度或浏览器控制台。');
                      }
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
                          notifyRealtime(ip);
                          alert(`✅ 节点 ${ip} 代理已${currentState ? '关闭' : '开启'}！`);
                          loadProxyPool();
                      } catch (e) {
                          alert('❌ 代理开关切换失败: ' + e.message);
                      }
                  };

                  const saveProxyConfig = async () => {
                      const targets = proxyConfig.ip ? [proxyConfig.ip] : (servers.value || []).map(s => s.ip);
                      if (targets.length === 0) { alert('⚠️ 暂无可下发的 VPS，请先在「服务器与节点」接入机器。'); return; }
                      const results = await Promise.allSettled(targets.map(ip =>
                          fetchApi('/api/proxy/config', {
                              method: 'POST',
                              body: JSON.stringify({ ip, enabled: true, port: parseInt(proxyConfig.port) || 7920, country: proxyConfig.country.toUpperCase(), mesh: proxyConfig.mesh })
                          })));
                      const succeeded = [];
                      const failed = [];
                      results.forEach((result, index) => {
                          if (result.status === 'fulfilled') succeeded.push(targets[index]);
                          else failed.push({ ip: targets[index], error: result.reason });
                      });
                      if (succeeded.length === 0) {
                          alert('❌ 配置下发失败: ' + failed.map(item => `${item.ip}: ${item.error?.message || item.error}`).join('\n'));
                          return;
                      }
                      await Promise.allSettled(succeeded.map(ip => notifyRealtime(ip)));
                      if (failed.length) {
                          alert(`⚠️ 配置下发完成：成功 ${succeeded.length} 台，失败 ${failed.length} 台\n${failed.map(item => `${item.ip}: ${item.error?.message || item.error}`).join('\n')}`);
                          return;
                      }
                      alert(`✅ 代理配置已下发到 ${succeeded.length} 台 VPS！Agent 下次心跳即生效。`);
                      loadProxyPool();
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
                          notifyRealtime(vps.ip);
                          vps.proxy_public_listener = result.proxy?.public_listener === true;
                          await refreshData();
                          alert(enabled ? '公网监听已开启，proxy-lite 将自动重启监听器。' : '公网监听已关闭，proxy-lite 将恢复为本机或 Docker 网桥监听。');
                      } catch (error) {
                          vps.proxy_public_listener = previous;
                      } finally {
                          publicListenerSaving[vps.ip] = false;
                      }
                  };

                  const switchProxyIP = async (switchMode = 'hot') => {
                      if (!proxyConfig.ip) { alert('⚠️ 请先在上方选择一台目标 VPS。'); return; }
                      const mode = String(switchMode || 'hot').trim().toLowerCase() === 'full' ? 'full' : 'hot';
                      const country = String(proxyConfig.country || 'JP').trim().replace(/\s+/g, '').toUpperCase();
                      const port = parseInt(proxyConfig.port) || 7920;
                      if (!/^(?:[A-Z]{2}|ANY)$/.test(country)) { alert('❌ 目标地区必须是 2 位国家码或 ANY'); return; }
                      try {
                          await fetchApi('/api/proxy/switch', {
                              method: 'POST',
                              body: JSON.stringify({ ip: proxyConfig.ip, '0': country, port, switch_mode: mode })
                          });
                          notifyRealtime(proxyConfig.ip);
                          alert(mode === 'full' ? '✅ 全量重拨指令已发送！' : '✅ 热切换指令已发送！');
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
                  const positiveMs = value => {
                      const milliseconds = Number(value);
                      return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
                  };
                  const realtimeInterval = (val, fallback) => positiveMs(Number(val) * 1000) || fallback;
                  const activeRealtimeInterval = () => {
                      if (isLoggedIn.value && role.value === 'admin') return realtimeInterval(probeSys.realtime_admin_interval, 5000);
                      if (!isLoggedIn.value && probeSys.is_public === 'true') return realtimeInterval(probeSys.realtime_public_interval, 10000);
                      return realtimeInterval(probeSys.realtime_idle_interval, 30000);
                  };
                  const staleAfterFor = snapshot => {
                      const serverStaleAfter = positiveMs(snapshot?.stale_after_ms);
                      if (serverStaleAfter) return serverStaleAfter;
                      const serverInterval = positiveMs(snapshot?.interval_ms);
                      return realtimeStaleAfterMs(serverInterval || activeRealtimeInterval());
                  };
                  const realtimeStateAt = (timestamp, staleAfter, serverState = '') => {
                      if (serverState === 'offline') return 'offline';
                      if (serverState === 'stale') return 'stale';
                      if (!timestamp) return serverState;
                      return Date.now() - Number(timestamp) > staleAfter ? 'stale' : 'online';
                  };
                  const refreshRealtimeStaleStates = () => {
                      const now = Date.now();
                      servers.value.forEach(server => {
                          const staleAfter = positiveMs(server.stale_after_ms) || realtimeStaleAfterMs(activeRealtimeInterval());
                          const heartbeatAt = Number(server._realtime_heartbeat_ts || server.last_report || 0);
                          if (server.realtime_state === 'online' && heartbeatAt && now - heartbeatAt > staleAfter) server.realtime_state = 'stale';
                      });
                      publicProbeServers.value.forEach(server => {
                          const staleAfter = positiveMs(server.stale_after_ms) || realtimeStaleAfterMs(activeRealtimeInterval());
                          const heartbeatAt = Number(server._realtime_heartbeat_ts || server.last_updated || 0);
                          if (server.realtime_state === 'online' && heartbeatAt && now - heartbeatAt > staleAfter) server.realtime_state = 'stale';
                      });
                      if (probeDetail.value?.realtime_state === 'online') {
                          const staleAfter = positiveMs(probeDetail.value.stale_after_ms) || realtimeStaleAfterMs(activeRealtimeInterval());
                          const heartbeatAt = Number(probeDetail.value._realtime_heartbeat_ts || probeDetail.value.last_updated || 0);
                          if (heartbeatAt && now - heartbeatAt > staleAfter) probeDetail.value.realtime_state = 'stale';
                      }
                  };
                  const applyRealtimeSnapshot = (snapshot) => {
                      if (!snapshot?.ip) return;
                      const key = normalizeRealtimeKey(snapshot.ip);
                      const staleAfter = staleAfterFor(snapshot);
                      const interval = positiveMs(snapshot.interval_ms) || activeRealtimeInterval();
                      const resultServer = servers.value.find(item => normalizeRealtimeKey(item.ip) === key);
                      const egressResult = snapshot.core_egress_result || snapshot.core_config_result;
                      const previousVerifiedIp = resultServer?.egress_ip;
                      if (applyEgressRealtimeResult(resultServer, egressResult)) {
                          const applyMarker = `${egressResult.deployment_id || ''}:${egressResult.revision}:${egressResult.applied_at || ''}`;
                          if (egressResult.success && egressAppliedProbeMarkers.get(resultServer.ip) === applyMarker && egressProbeInfo[resultServer.ip]?.at && previousVerifiedIp) {
                              resultServer.egress_ip = previousVerifiedIp;
                          }
                          if (egressResult.success && egressResult.egress_ip && egressAppliedProbeMarkers.get(resultServer.ip) !== applyMarker) {
                              egressAppliedProbeMarkers.set(resultServer.ip, applyMarker);
                              egressProbeInfo[resultServer.ip] = { at: Number(egressResult.applied_at) || Date.now(), failed: false };
                              const schedule = residentialProbeSchedule.get(resultServer.ip) || {};
                              schedule.lastAttempt = Date.now();
                              residentialProbeSchedule.set(resultServer.ip, schedule);
                          }
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
                          egressProbeInfo[resultServer.ip] = probeApplied
                              ? { at: Number(egressProbe.measured_at) || Date.now(), failed: false }
                              : { ...egressProbeInfo[resultServer.ip], failed: true };
                          if (!probeApplied && !silent) alert(`刷新实际出口 IP 失败：${egressProbe.error || 'VPS 未返回与当前配置匹配的有效出口 IP'}`);
                      }
                      if (snapshot.core) {
                          const timestamp = snapshot.core_last_seen !== undefined
                              ? Math.max(0, Number(snapshot.core_last_seen) || 0)
                              : snapshot.updated_at !== undefined
                                  ? Math.max(0, Number(snapshot.updated_at) || 0)
                                  : Date.now();
                          const heartbeatAt = snapshot.core_heartbeat_at !== undefined
                              ? Math.max(0, Number(snapshot.core_heartbeat_at || 0))
                              : timestamp;
                          const realtimeState = realtimeStateAt(heartbeatAt, staleAfter, snapshot.core_state || '');
                          const applyCoreRealtime = (target, fallbackTs = 0, sampleFields = {}, onSampleUpdated = null) => {
                              if (!target) return;
                              const currentTimestamp = Number(target._realtime_ts || fallbackTs || 0);
                              const currentHeartbeat = Math.max(Number(target._realtime_heartbeat_ts || 0), currentTimestamp);
                              if (timestamp >= currentTimestamp) {
                                  Object.assign(target, sampleFields);
                                  if (onSampleUpdated) onSampleUpdated();
                              }
                              if (heartbeatAt >= currentHeartbeat) {
                                  Object.assign(target, { _realtime_heartbeat_ts: heartbeatAt, stale_after_ms: staleAfter, interval_ms: interval, realtime_state: realtimeState });
                              }
                          };
                          const core = snapshot.core;
                          const server = servers.value.find(item => normalizeRealtimeKey(item.ip) === key);
                          if (server) applyCoreRealtime(server, server.last_report, { cpu: core.cpu, mem: core.mem, disk: core.disk, load: core.load, uptime: core.uptime, net_in_speed: core.net_in_speed, net_out_speed: core.net_out_speed, tcp_conn: core.tcp_conn, udp_conn: core.udp_conn, warp: core.warp || server.warp, last_report: timestamp, boot_id: snapshot.boot_id?.core, sequence: snapshot.sequence?.core, config_result: snapshot.core_config_result, config_result_at: snapshot.core_config_result_at, _realtime_ts: timestamp });
                          const probe = publicProbeServers.value.find(item => normalizeRealtimeKey(item.id) === key);
                          if (probe) applyCoreRealtime(probe, probe.last_updated, { cpu: core.cpu, ram: core.mem, disk: core.disk, load_avg: core.load, uptime: core.uptime, net_in_speed: core.net_in_speed, net_out_speed: core.net_out_speed, tcp_conn: core.tcp_conn, udp_conn: core.udp_conn, last_updated: timestamp, _realtime_ts: timestamp });
                          if (normalizeRealtimeKey(probeDetail.value?.id) === key) applyCoreRealtime(probeDetail.value, probeDetail.value?.last_updated, { cpu: core.cpu, ram: core.mem, disk: core.disk, load_avg: core.load, uptime: core.uptime, net_in_speed: core.net_in_speed, net_out_speed: core.net_out_speed, tcp_conn: core.tcp_conn, udp_conn: core.udp_conn, last_updated: timestamp, _realtime_ts: timestamp }, () => updateProbeDetailCharts(probeDetail.value));
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
                              residential_active_purity: extractTunnelPurity(active),
                              residential_standby_purity: extractTunnelPurity(standby),
                              residential_ready: !!active && !blockingReason,
                              residential_reason: active && !blockingReason ? '' : (resultServer.residential_reason || '住宅 OpenVPN 主通道尚未就绪'),
                              residential_last_seen: Number(snapshot.proxy_last_seen || snapshot.updated_at || Date.now()),
                          });
                      }
                      window.kuiRealtimeProxySnapshots = window.kuiRealtimeProxySnapshots || {};
                      if (snapshot.proxy || snapshot.proxy_state || snapshot.proxy_config_result) { const previous = window.kuiRealtimeProxySnapshots[snapshot.ip] || {}; window.kuiRealtimeProxySnapshots[snapshot.ip] = { ...previous, ...snapshot, proxy: snapshot.proxy || previous.proxy }; if (activeTab.value === 'proxy') setTimeout(pcFetchNodes, 0); }
                  };
                  const scheduleRealtimeFallback = () => {
                      if (isUnmounted) return;
                      clearTimeout(realtimeFallbackTimer);
                      if (!realtimeDisconnectedAt) realtimeDisconnectedAt = Date.now();
                      const remaining = Math.max(0, 30000 - (Date.now() - realtimeDisconnectedAt));
                      realtimeFallbackTimer = setTimeout(() => { if (!document.hidden && !realtimeConnected.value && isLoggedIn.value) { stopPolling(); startPolling(); startProbePolling(); if (activeTab.value === 'proxy') pcInitProxy(); } }, remaining);
                  };
                  const requestRealtimeTicket = async (authHeaders, controller) => {
                      const timeout = setTimeout(() => controller.abort(), 30000);
                      try {
                          const ticketRes = await fetch(`${realtimeUrl.value}/dashboard/ticket`, { method: 'POST', headers: authHeaders, signal: controller.signal });
                          if (realtimeTicketController !== controller || controller.signal.aborted) return null;
                          if (!ticketRes.ok) throw new Error(`ticket ${ticketRes.status}`);
                          const { ticket } = await ticketRes.json();
                          return ticket;
                      } finally {
                          clearTimeout(timeout);
                      }
                  };
                  const connectRealtime = () => {
                      if (isUnmounted || !isLoggedIn.value || role.value !== 'admin' || !realtimeUrl.value || document.hidden) return undefined;
                      if (realtimeSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(realtimeSocket.readyState)) return undefined;
                      const opAuthGen = authGeneration;
                      if (realtimeConnectPromise && realtimeTicketAuthGeneration === opAuthGen && realtimeTicketController && !realtimeTicketController.signal.aborted) {
                          return realtimeConnectPromise;
                      }
                      const generation = ++realtimeGeneration;
                      const ticketController = new AbortController();
                      realtimeTicketController = ticketController;
                      realtimeTicketGeneration = generation;
                      realtimeTicketAuthGeneration = opAuthGen;
                      scheduleRealtimeFallback();
                      realtimeConnectPromise = (async () => {
                          try {
                              const authHeaders = await window.kuiAdminAuthHeader();
                              if (ticketController.signal.aborted || generation !== realtimeGeneration || opAuthGen !== authGeneration || isUnmounted || !isLoggedIn.value || role.value !== 'admin' || document.hidden) return;
                              const ticket = await requestRealtimeTicket(authHeaders, ticketController);
                              if (!ticket) return;
                              if (ticketController.signal.aborted || generation !== realtimeGeneration || opAuthGen !== authGeneration || isUnmounted || !isLoggedIn.value || role.value !== 'admin' || document.hidden) return;
                              const wsUrl = realtimeUrl.value.replace(/^http/, 'ws') + `/dashboard/ws?ticket=${encodeURIComponent(ticket)}`;
                              if (isUnmounted) return;
                              const socket = new WebSocket(wsUrl);
                              realtimeSocket = socket;
                              clearTimeout(realtimeConnectTimer);
                              realtimeConnectTimer = setTimeout(() => { if (realtimeSocket === socket && socket.readyState === WebSocket.CONNECTING) socket.close(); }, 30000);
                              socket.onopen = () => { if (realtimeSocket !== socket || generation !== realtimeGeneration) return socket.close(); clearTimeout(realtimeConnectTimer); realtimeDisconnectedAt = 0; realtimeRetryDelay = 5000; lastRealtimePing = Date.now(); realtimeConnected.value = true; window.kuiRealtimeConnected = true; clearTimeout(realtimeFallbackTimer); publicRealtimeSocket?.close(); refreshData(); stopPolling(); stopProbePolling(); pcStopProxy(); clearInterval(realtimePingTimer); realtimePingTimer = setInterval(() => { const now = Date.now(); if (realtimeSocket?.readyState === WebSocket.OPEN && now - lastRealtimePing >= 30000) { realtimeSocket.send('ping'); lastRealtimePing = now; } refreshRealtimeStaleStates(); if (activeTab.value === 'nodes') loadTrafficStats(); if (activeTab.value === 'proxy') pcFetchNodes(); }, 5000); };
                              socket.onmessage = event => { if (realtimeSocket !== socket) return; try { const message = JSON.parse(event.data); if (message.type === 'snapshot') (message.data || []).forEach(applyRealtimeSnapshot); else if (message.type === 'patch') applyRealtimeSnapshot(message.data); } catch(e) {} };
                              socket.onclose = () => { if (realtimeSocket !== socket) return; clearTimeout(realtimeConnectTimer); clearInterval(realtimePingTimer); realtimeConnected.value = false; window.kuiRealtimeConnected = false; realtimeSocket = null; if (isLoggedIn.value && !document.hidden) { scheduleRealtimeFallback(); clearTimeout(realtimeReconnectTimer); const delay = realtimeRetryDelay; realtimeRetryDelay = nextRealtimeRetryDelay(realtimeRetryDelay); realtimeReconnectTimer = setTimeout(connectRealtime, delay); } };
                              socket.onerror = () => socket.close();
                          } catch(e) { if (generation !== realtimeGeneration || opAuthGen !== authGeneration || isUnmounted) return; scheduleRealtimeFallback(); clearTimeout(realtimeReconnectTimer); const delay = realtimeRetryDelay; realtimeRetryDelay = nextRealtimeRetryDelay(realtimeRetryDelay); realtimeReconnectTimer = setTimeout(connectRealtime, delay); } finally {
                              if (realtimeTicketController === ticketController) {
                                  realtimeTicketController = null;
                                  realtimeConnectPromise = null;
                                  realtimeTicketGeneration = 0;
                                  realtimeTicketAuthGeneration = -1;
                              }
                          }
                      })();
                      return realtimeConnectPromise;
                  };
                  const connectPublicRealtime = () => {
                      if (isUnmounted || isLoggedIn.value || !realtimeUrl.value || probeSys.is_public !== 'true' || document.hidden) return;
                      if (publicRealtimeSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(publicRealtimeSocket.readyState)) return;
                      const socket = new WebSocket(realtimeUrl.value.replace(/^http/, 'ws') + '/public/ws');
                      publicRealtimeSocket = socket;
                      clearTimeout(publicRealtimeConnectTimer);
                      publicRealtimeConnectTimer = setTimeout(() => { if (publicRealtimeSocket === socket && socket.readyState === WebSocket.CONNECTING) socket.close(); }, 30000);
                      socket.onopen = () => { if (publicRealtimeSocket !== socket) return socket.close(); clearTimeout(publicRealtimeConnectTimer); publicRealtimeDisconnectedAt = 0; publicRealtimeRetryDelay = 10000; clearTimeout(publicRealtimeFallbackTimer); stopProbePolling(); clearInterval(publicRealtimeActivityTimer); socket.send(JSON.stringify({ type: 'activity' })); refreshRealtimeStaleStates(); publicRealtimeActivityTimer = setInterval(() => { if (publicRealtimeSocket === socket && publicRealtimeSocket.readyState === WebSocket.OPEN) publicRealtimeSocket.send(JSON.stringify({ type: 'activity' })); refreshRealtimeStaleStates(); }, 30000); };
                      socket.onmessage = event => { if (publicRealtimeSocket !== socket) return; try { const message = JSON.parse(event.data); if (message.type === 'snapshot') (message.data || []).forEach(applyRealtimeSnapshot); else if (message.type === 'patch') applyRealtimeSnapshot(message.data); } catch(e) {} };
                      socket.onclose = event => { if (publicRealtimeSocket !== socket) return; clearTimeout(publicRealtimeConnectTimer); publicRealtimeSocket = null; clearInterval(publicRealtimeActivityTimer); if (event.code === 1008) { clearTimeout(publicRealtimeReconnectTimer); stopProbePolling(); publicProbeServers.value = []; probeSys.is_public = 'false'; return; } if (!publicRealtimeDisconnectedAt) publicRealtimeDisconnectedAt = Date.now(); clearTimeout(publicRealtimeFallbackTimer); publicRealtimeFallbackTimer = setTimeout(() => { if (!document.hidden && !isLoggedIn.value) startProbePolling(); }, Math.max(0, 30000 - (Date.now() - publicRealtimeDisconnectedAt))); clearTimeout(publicRealtimeReconnectTimer); const delay = publicRealtimeRetryDelay; publicRealtimeRetryDelay = nextRealtimeRetryDelay(publicRealtimeRetryDelay); publicRealtimeReconnectTimer = setTimeout(connectPublicRealtime, delay); };
                      socket.onerror = () => socket.close();
                  };
                  const realtimeNotifyScheduled = new Set();
                  const notifyRealtime = (ip = '') => {
                      if (!realtimeUrl.value || role.value !== 'admin') return Promise.resolve(false);
                      const key = ip || '*';
                      if (realtimeNotifyScheduled.has(key)) return Promise.resolve(false);
                      realtimeNotifyScheduled.add(key);
                      return Promise.resolve().then(async () => {
                          try {
                              const headers = await window.kuiAdminAuthHeader();
                              const response = await fetch(`${realtimeUrl.value}/notify`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(ip ? { ip } : {}) });
                              return response.ok;
                          } catch(e) {
                              return false;
                          } finally {
                              realtimeNotifyScheduled.delete(key);
                          }
                      });
                  };
                  window.kuiNotifyRealtime = notifyRealtime;
                  const startPolling = () => { 
                      if (isUnmounted) return;
                      if (realtimeConnected.value) return;
                      if (!dataTimer) { refreshData(); dataTimer = setInterval(() => { if (isLoggedIn.value && !document.hidden && activeTab.value !== 'probe') refreshData(); }, FALLBACK_DATA_INTERVAL); }
                      if (!pingTimer) { sendUiPing(); pingTimer = setInterval(() => { if (isLoggedIn.value && !document.hidden) sendUiPing(); }, FALLBACK_UI_PING_INTERVAL); }
                  };
                  const startProbePolling = () => { 
                      if (isUnmounted) return;
                      if (document.hidden) return;
                      if ((realtimeConnected.value && isLoggedIn.value && role.value === 'admin') || publicRealtimeSocket?.readyState === WebSocket.OPEN) return;
                      if (!probeTimer) { fetchProbeData(); probeTimer = setInterval(() => { if (!document.hidden && (!isLoggedIn.value || activeTab.value === 'probe')) fetchProbeData(); }, FALLBACK_PROBE_INTERVAL); }
                  }
                  const stopProbePolling = () => { if (probeTimer) { clearInterval(probeTimer); probeTimer = null; } };
                  const stopPolling = () => { if (dataTimer) { clearInterval(dataTimer); dataTimer = null; } if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

                  const handleVisibilityChange = () => {
                      if (document.hidden) {
                          abortRealtimeTicket();
                          realtimeDisconnectedAt = 0;
                          publicRealtimeDisconnectedAt = 0;
                          stopPolling();
                          stopProbePolling();
                          clearInterval(realtimePingTimer);
                          clearInterval(publicRealtimeActivityTimer);
                          clearTimeout(realtimeFallbackTimer);
                          clearTimeout(realtimeReconnectTimer);
                          clearTimeout(publicRealtimeReconnectTimer);
                          const socket = realtimeSocket;
                          realtimeSocket = null;
                          socket?.close();
                          const publicSocket = publicRealtimeSocket;
                          publicRealtimeSocket = null;
                          publicSocket?.close();
                          realtimeConnected.value = false;
                          window.kuiRealtimeConnected = false;
                      } else if (isLoggedIn.value && role.value === 'admin' && realtimeUrl.value) {
                          connectRealtime();
                          scheduleRealtimeFallback();
                          updateResidentialProbes();
                      } else if (!isLoggedIn.value && realtimeUrl.value && probeSys.is_public === 'true') {
                          connectPublicRealtime();
                      } else {
                          if (isLoggedIn.value) startPolling();
                          startProbePolling();
                      }
                  };

                  onMounted(async () => {
                      document.addEventListener('visibilitychange', handleVisibilityChange);
                      residentialProbeTimer = setInterval(updateResidentialProbes, 5000);
                      if (authKey.value && currentUser.value) {
                          isLoggedIn.value = true;
                          if (role.value !== 'admin' && ['proxy', 'warp'].includes(activeTab.value)) activeTab.value = 'dashboard';
                          if (role.value === 'admin') {
                              await refreshData();
                              if (isUnmounted) return;
                              queueMicrotask(connectRealtime);
                          } else startPolling();
                          if (activeTab.value === 'proxy') proxyInitTimer = setTimeout(pcInitProxy, 0);
                      }
                      await fetchProbeData();
                      if (isUnmounted) return;
                      if (!isLoggedIn.value || role.value !== 'admin') startProbePolling();
                      if (isUnmounted) return;
                      if (isProbeViewVisible() && probeView.value === 'map') {
                          await nextTick();
                          if (!isUnmounted) initMap();
                      }
                  });

                  onBeforeUnmount(() => {
                      isUnmounted = true;
                      clearInterval(residentialProbeTimer);
                      clearTimeout(toastTimer);
                      toastTimer = null;
                      abortRealtimeTicket();
                      document.removeEventListener('visibilitychange', handleVisibilityChange);
                      systemColorQuery.removeEventListener('change', syncSystemColor);
                      clearTimeout(proxyInitTimer);
                      proxyInitTimer = null;
                      pcStopProxy();
                      stopPolling();
                      stopProbePolling();
                      disposeKuiCharts();
                      destroyProbeDetailCharts();
                      destroyMap();
                      clearInterval(realtimePingTimer);
                      clearTimeout(realtimeConnectTimer);
                      clearTimeout(realtimeFallbackTimer);
                      clearTimeout(realtimeReconnectTimer);
                      clearInterval(publicRealtimeActivityTimer);
                      clearTimeout(publicRealtimeConnectTimer);
                      clearTimeout(publicRealtimeFallbackTimer);
                      clearTimeout(publicRealtimeReconnectTimer);
                      egressRefreshTimers.forEach(timer => clearTimeout(timer));
                      egressRefreshTimers.clear();
                      const socket = realtimeSocket;
                      realtimeSocket = null;
                      socket?.close();
                      const publicSocket = publicRealtimeSocket;
                      publicRealtimeSocket = null;
                      publicSocket?.close();
                      realtimeConnected.value = false;
                      window.kuiRealtimeConnected = false;
                      qrRequestId++;
                      mapInitPromise = null; geoJsonPromise = null; worldGeoJson = null; leafletLib = null;
                  });

                  return { 
                      isLoggedIn, showLoginModal, loginUser, password, loginPending, currentUser, role, activeTab, colorMode, effectiveColorMode, refreshing, refreshPanel,
                      servers, nodes, users, groups, securityWarnings, proxyCredentialsReady, proxyPublicListenerManageable, publicListenerSaving, setProxyPublicListener, addingVps, addingNode, newVps, newNodeParams, nodeEditDrafts, newUser, newGroupName,
                      login, logout, refreshData, openProxyList, addUser, toggleUser, deleteUser, resetUserTraffic, addGroup, saveGroup, deleteGroup, groupDraft, addVps, addNode, startEditNode, cancelEditNode, saveNodeEdit, deleteNode, toggleNode, resetTraffic,
                      getNodesByIp, getVpsName, formatBytes, formatDate, getExpireText, getTrafficPercent, getPingColor, isOnline, generateCmd, generateUninstallCmd, copyDeployCommand, copyUninstallCommand, copyPurgeCommand, requestAgentBootstrapToken, generateSs2022Password, generateSubLink, generateMtproxyLink, copyCommand, copySurgeConfig,
                      globalOnline, globalTraffic, globalSpeedIn, globalSpeedOut, deployOsMap, saveOsMap, siteTitle, siteTitleInput, siteTitleDirty, markSiteTitleDirty, saveSiteTitle, siteTitleSaving, userNewPassword, updateUserPassword, passwordSaving, resetMySubLink, subTokenResetting, generateUUIDForNewUser, batchStartPort, batchUser, deployAllProtocols,
                      probeSys, publicProbeServers, filteredProbeServers, probeView, probeDetailId, probeDetail, setProbeView, openProbeDetail, probeGlobalOnline, probeGlobalOffline, probeGlobalSpeedIn, probeGlobalSpeedOut, probeGlobalNetRx, probeGlobalNetTx, filteredProbeGroups, probeCountryStats, currentFilter,
                      probeSettingsDirty, markProbeSettingsDirty, probeSettingsSaving, saveProbeSettings, subscriptionProtectionSaving, saveSubscriptionProtection, adminProbeServers, probeEditModalOpen, editingProbeNode, openProbeEditModal, saveProbeEdit, deleteProbeNode, currentDomain,
                      thirdPartySubscriptions, newThirdParty, loadingThirdParty, loadThirdPartySubscriptions, addThirdPartySubscription, toggleThirdPartySubscription, deleteThirdPartySubscription,
                      qrModalOpen, qrCodeImage, showQrCode,
                      toast, showToast, dismissToast, openResidentialProxy, renderKUICharts,
                      showWelcomePopup, closePopup,
                      availableThemes, pingNodes, pullGithubNodes, githubNodesPulling, hasCustomCssFlag,
                      proxyConfig, toggleNodeProxy, saveProxyConfig, switchProxyIP, proxyPool, loadProxyPool, egressModeLabel, updateVpsEgress, forceReapplyEgress, refreshVpsEgressIp, egressIpRefreshing, egressProbeInfo, egressModeOf, proxyModeOf, proxyCategoriesOf, proxyCategoryOptions, proxyCategoryActive, toggleProxyCategory, markEgressDirty, markProxyCustomDomainsDirty, clearProxyCustomDomains, proxyCustomDomainCount, setProxyMode, egressHasDraft, applyEgressDraft, cancelEgressDraft, onEgressModeChange,
                      warpTargetIp, warpSelectedCandidate, warpActionPending, startWarpOptimization, applyWarpCandidate, cancelWarpOptimization, restoreWarpEndpoint, updateWarpPolicy,
                      applyRealtimeSnapshot, refreshRealtimeStaleStates,
                  };
}
