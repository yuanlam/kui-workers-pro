import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const appShell = read('../frontend/src/app/AppShell.vue');
const desktopNavigation = read('../frontend/src/app/DesktopNavigation.vue');
const mobileNavigation = read('../frontend/src/app/MobileNavigation.vue');
const serversPage = read('../frontend/src/pages/ServersPage.vue');
const appStyles = read('../frontend/src/styles/app.css');
const tokens = read('../frontend/src/styles/tokens.css');
const topBar = read('../frontend/src/app/TopBar.vue');
const residentialProxyPage = read('../frontend/src/pages/ResidentialProxyPage.vue');
const legacyProxy = read('../frontend/src/proxy/legacyProxy.js');
const state = read('../frontend/src/composables/useKuiState.js');
const publicListenerPage = read('../frontend/src/pages/PublicListenerPage.vue');
const settingsPage = read('../frontend/src/pages/SettingsPage.vue');
const usersPage = read('../frontend/src/pages/UsersPage.vue');
const qrModal = read('../frontend/src/components/modals/QrModal.vue');
const probeEditModal = read('../frontend/src/components/modals/ProbeEditModal.vue');
const app = read('../frontend/src/App.vue');
const api = read('../functions/api/[[path]].js');

test('removed and hidden pages are absent from the active UI', () => {
    assert.doesNotMatch(appShell, /ServicesPage|RealmPage/);
    assert.doesNotMatch(desktopNavigation, /第三方服务|Realm 中转|id:\s*['"](?:services|realm)['"]/);
    assert.doesNotMatch(mobileNavigation, /第三方服务|Realm|id:\s*['"](?:services|realm)['"]/);
    assert.doesNotMatch(topBar, /第三方服务|Realm 中转/);
});

test('desktop navigation keeps all operational entries in the requested upper order', () => {
    const itemOrder = ['nodes', 'proxy', 'route-logs', 'public-listener', 'thirdparty', 'users'];
    const positions = itemOrder.map(id => desktopNavigation.indexOf(`id: '${id}'`));
    assert.ok(positions.every(position => position >= 0));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.ok(desktopNavigation.indexOf('kui-sidebar-secondary') < desktopNavigation.indexOf('kui-sidebar-footer'));
    assert.match(desktopNavigation, /kui-sidebar-secondary[\s\S]*kui-sidebar-theme-picker[\s\S]*go\('settings'\)/);
});

test('public listener control is placed before settings on desktop and mobile', () => {
    const desktopPublic = desktopNavigation.indexOf("id: 'public-listener'");
    assert.ok(desktopPublic >= 0);
    assert.match(desktopNavigation, /kui-sidebar-secondary[\s\S]*go\('settings'\)/);
    const mobilePublic = mobileNavigation.indexOf("id: 'public-listener'");
    const mobileSettings = mobileNavigation.indexOf("id: 'settings'", mobilePublic);
    assert.ok(mobilePublic >= 0 && mobilePublic < mobileSettings);
    assert.match(publicListenerPage, /role="switch"/);
    assert.match(publicListenerPage, /setProxyPublicListener/);
    assert.match(publicListenerPage, /防火墙或云安全组/);
});

test('VPS onboarding is inline directly below the four status cards', () => {
    assert.doesNotMatch(desktopNavigation, /id: 'add-vps'|接入 VPS/);
    assert.doesNotMatch(mobileNavigation, /id: 'add-vps'|接入 VPS/);
    assert.doesNotMatch(app, /AddVpsModal/);
    const stats = serversPage.indexOf('class="kui-server-stats');
    const onboarding = serversPage.indexOf('class="kui-vps-onboarding"');
    const serverGrid = serversPage.indexOf('class="kui-server-grid');
    assert.ok(stats >= 0 && stats < onboarding && onboarding < serverGrid);
    assert.equal((serversPage.slice(stats, onboarding).match(/class="kui-stat-card/g) || []).length, 4);
    assert.match(serversPage, /kui-vps-onboarding[\s\S]*>主机名 [\s\S]*>公网 IP [\s\S]*>系统架构 [\s\S]*确认接入/);
    assert.match(serversPage, /@submit\.prevent="addVps"/);
    assert.match(serversPage, /v-model\.trim="newVps\.name"/);
    assert.match(appStyles, /\.kui-vps-onboarding \{/);
    assert.match(appStyles, /data-kui-theme="dark"\] \.kui-vps-onboarding/);
});

test('probe monitor is displayed before subscription exports and remains visible on mobile', () => {
    const probe = topBar.indexOf('探针监控');
    const exports = topBar.indexOf('订阅与导出');
    assert.ok(probe >= 0 && probe < exports);
    assert.doesNotMatch(topBar.match(/<button @click="openProbe"[^>]+>/)?.[0] || '', /kui-desktop-only/);
    assert.match(topBar, /openProbe[\s\S]*activeTab\.value = 'probe'/);
});

test('mobile admin navigation places residential proxy before users and removes duplicate probe entry', () => {
    const nodes = mobileNavigation.indexOf("id: 'nodes'");
    const proxy = mobileNavigation.indexOf("id: 'proxy'");
    const users = mobileNavigation.indexOf("id: 'users'");
    const moreItems = mobileNavigation.slice(mobileNavigation.indexOf('const moreItems'), mobileNavigation.indexOf('const userItems'));
    assert.ok(nodes >= 0 && nodes < proxy && proxy < users);
    assert.doesNotMatch(moreItems, /id:\s*['"]probe['"]/);
});

test('servers page uses compact Chinese overview', () => {
    assert.doesNotMatch(topBar, /kui-page-subtitle|siteTitle \|\| 'Cluster Gateway'/);
    for (const label of ['在线服务器', '累计流量', '实时下载', '实时上传']) assert.match(serversPage, new RegExp(label));
    assert.doesNotMatch(serversPage, /ONLINE SERVERS|AGGREGATE TRAFFIC|>DOWNLOAD<|>UPLOAD</);
    assert.match(appStyles, /\.kui-servers-page[\s\S]*margin-top: 10px/);
});

test('desktop server cards use a two-column grid', () => {
    assert.match(serversPage, /class="kui-server-grid grid grid-cols-1 xl:grid-cols-2/);
});

test('global color modes reuse the servers light palette and residential dark palette', () => {
    assert.match(tokens, /:root,\s*:root\[data-kui-theme="light"\]/);
    assert.match(tokens, /:root\[data-kui-theme="dark"\]/);
    assert.match(tokens, /--kui-color-bg:\s*#f4f6fb/);
    assert.match(tokens, /--kui-color-bg:\s*#090e17/i);
    assert.match(state, /localStorage\.getItem\('kui_color_mode'\)/);
    assert.match(state, /window\.matchMedia\('\(prefers-color-scheme: dark\)'\)/);
    assert.match(state, /colorMode\.value === 'system'/);
    assert.match(state, /document\.documentElement\.dataset\.kuiTheme = effectiveColorMode\.value/);
    assert.match(state, /systemColorQuery\.addEventListener\('change'/);
    assert.match(state, /systemColorQuery\.removeEventListener\('change'/);
    assert.doesNotMatch(topBar, /v-model="colorMode"|kui-theme-picker/);
    for (const navigation of [desktopNavigation, mobileNavigation]) {
        assert.match(navigation, /v-model="colorMode"/);
        assert.match(navigation, /value="system">跟随系统/);
        assert.match(navigation, /value="light">浅色模式/);
        assert.match(navigation, /value="dark">深色模式/);
    }
    assert.doesNotMatch(residentialProxyPage.match(/<div[^>]+class="pc-body[^>]+>/)?.[0] || '', /bg-\[#090E17\]|text-slate-300/);
    assert.match(appStyles, /data-kui-theme="dark"[\s\S]*\.kui-server-card/);
    assert.match(appStyles, /data-kui-theme="light"[\s\S]*\.pc-body/);
    assert.match(qrModal, /kui-modal-surface/);
    assert.match(probeEditModal, /kui-modal-surface/);
    assert.match(appStyles, /data-kui-theme="dark"[\s\S]*\.kui-modal-surface/);
});

test('theme controls live above desktop settings and left of mobile settings', () => {
    const desktopTheme = desktopNavigation.indexOf('kui-sidebar-theme-picker');
    const desktopSettings = desktopNavigation.indexOf("go('settings')");
    assert.ok(desktopTheme >= 0 && desktopTheme < desktopSettings);

    const mobileTheme = mobileNavigation.indexOf('kui-mobile-theme-picker');
    const mobileSettings = mobileNavigation.indexOf("id: 'settings'", mobileTheme);
    assert.ok(mobileTheme >= 0 && mobileTheme < mobileSettings);
    assert.match(appStyles, /\.kui-sidebar-theme-picker/);
    assert.match(appStyles, /\.kui-sidebar-theme-picker select \{[^}]*text-align: left;[^}]*text-align-last: left/);
    assert.match(appStyles, /\.kui-mobile-theme-picker/);
});

test('server cards expose clear visual boundaries between operational modules', () => {
    for (const className of ['kui-server-card', 'kui-server-metric', 'kui-server-chart', 'kui-quick-deploy-panel', 'kui-node-deploy-panel', 'kui-egress-panel', 'kui-node-list-section', 'kui-node-card', 'kui-node-export-actions', 'kui-server-command-panel']) {
        assert.match(serversPage, new RegExp(className));
        assert.match(appStyles, new RegExp(`\\.${className}`));
    }
    assert.match(appStyles, /\.kui-server-card > \* \+ \* \{ border-top-color: #d7dfeb/);
});

test('server card header and deployment actions use the compact explicit layout', () => {
    const status = serversPage.indexOf('kui-server-status-dot');
    const ip = serversPage.indexOf('kui-server-ip');
    assert.ok(status >= 0 && status < ip);
    assert.doesNotMatch(serversPage, /UP:|LOAD:|vps\.uptime|vps\.load/);
    assert.match(serversPage, /<button @click="copyDeployCommand\(vps, \$event\)"[\s\S]{0,80}kui-copy-deploy-button[\s\S]{0,80}复制完整部署命令<\/button>/);
    assert.match(appStyles, /\.kui-copy-deploy-button \{ display: flex; width: 100%;/);
    assert.match(serversPage, /class="kui-server-name truncate">\{\{ vps\.name \}\}/);
    assert.match(appStyles, /\.kui-server-name \{ font-size: 28px;/);
});

test('server overflow menu exports all protocols and opens deployment commands', () => {
    const menu = serversPage.slice(serversPage.indexOf('kui-server-menu'), serversPage.indexOf('kui-server-metric'));
    assert.match(menu, /generateSubLink\(vps\.ip, ''\)/);
    assert.match(menu, /generateSubLink\(vps\.ip, 'clash'\)/);
    assert.match(menu, /copySurgeConfig\(vps\.ip, '', \$event\)/);
    assert.match(menu, /复制所有协议普通订阅/);
    assert.match(menu, /复制所有协议 Clash 订阅/);
    assert.match(menu, /复制所有协议 Surge 配置段/);
    assert.match(menu, /kui-server-command-menu/);
    assert.match(appStyles, /\.kui-server-menu-panel/);
    assert.match(appStyles, /\.kui-server-command-panel/);
});

test('deployment commands live in the server overflow flyout with all three copy actions', () => {
    const start = serversPage.indexOf('<details class="kui-server-command-menu');
    const deployPanel = serversPage.slice(start, serversPage.indexOf('</div>\n                                          </details>', start));
    assert.ok(start >= 0);
    assert.doesNotMatch(deployPanel.match(/<details[^>]*>/)?.[0] || '', /\sopen(?:\s|>)/);
    assert.equal((deployPanel.match(/<button\b/g) || []).length, 3);
    assert.match(deployPanel, /copyDeployCommand\(vps, \$event\)/);
    assert.match(deployPanel, /copyUninstallCommand\(vps, \$event\)/);
    assert.match(deployPanel, /copyPurgeCommand\(vps, \$event\)/);
    assert.doesNotMatch(serversPage, /kui-server-delivery-section|kui-deploy-panel/);
});

test('successful command and protocol copies close their floating menus', () => {
    assert.match(state, /closeCopyOverlays = trigger =>/);
    assert.match(state, /details\.kui-server-command-menu\[open\][\s\S]*details\.kui-server-menu\[open\][\s\S]*details\.kui-action-menu\[open\]/);
    assert.match(state, /copyCommand = async \(txt, msg, eventOrTrigger\) => \{ const trigger = eventOrTrigger\?\.currentTarget \|\| eventOrTrigger;[\s\S]{0,160}await writeClipboard\(txt\); closeCopyOverlays\(trigger\); alert\(msg\)/);
    const surgeCopy = state.slice(state.indexOf('const copySurgeConfig = async'), state.indexOf('\n                  const showQrCode'));
    assert.match(surgeCopy, /const trigger = event\?\.currentTarget;/);
    assert.match(surgeCopy, /await writeClipboard\(config\);\s*closeCopyOverlays\(trigger\)/);
    for (const functionName of ['copyDeployCommand', 'copyUninstallCommand', 'copyPurgeCommand']) {
        assert.match(state, new RegExp(`${functionName} = async \\(vps, event\\) => \\{ const trigger = event\\?\\.currentTarget;[\\s\\S]{0,700}copyCommand\\([^;]+, trigger\\)`));
    }
    assert.match(serversPage, /copyCommand\(generateSubLink\(vps\.ip, '',?\)[\s\S]{0,100}\$event/);
    assert.match(topBar, /copySurgeConfig\('', '', \$event\)/);
});

test('expanded node details expose protocol-appropriate node exports', () => {
    const start = serversPage.indexOf('kui-node-export-actions');
    const actions = serversPage.slice(start, serversPage.indexOf('</div>', start));
    assert.ok(start >= 0);
    assert.equal((actions.match(/<button\b/g) || []).length, 4);
    assert.match(actions, /generateMtproxyLink\(node\)/);
    assert.match(actions, /generateSubLink\(vps\.ip, '', node\.id\)/);
    assert.match(actions, /generateSubLink\(vps\.ip, 'clash', node\.id\)/);
    assert.match(actions, /copySurgeConfig\(vps\.ip, node\.id\)/);
    assert.match(appStyles, /\.kui-node-export-actions/);
});

test('egress panel sits directly below traffic trend and outside node management', () => {
    const chart = serversPage.indexOf('kui-server-chart');
    const egress = serversPage.indexOf('kui-egress-panel');
    const tools = serversPage.indexOf('<details class="kui-server-tools">');
    assert.ok(chart >= 0 && chart < egress && egress < tools);
    const betweenChartAndEgress = serversPage.slice(chart, egress);
    assert.doesNotMatch(betweenChartAndEgress, /kui-server-tools|kui-node-deploy-panel/);
    const toolsSection = serversPage.slice(tools, serversPage.indexOf('kui-node-list-section'));
    assert.doesNotMatch(toolsSection, /kui-egress-panel|节点出口/);
});

test('egress panel uses the same neutral palette and controls as adjacent server modules', () => {
    const start = serversPage.indexOf('kui-egress-panel');
    const panel = serversPage.slice(start, serversPage.indexOf('<details class="kui-server-tools">', start));
    assert.ok(start >= 0);
    for (const className of ['kui-egress-heading', 'kui-egress-description', 'kui-egress-control', 'kui-egress-mode-button', 'kui-egress-category-button', 'kui-egress-retry']) {
        assert.match(panel, new RegExp(className));
        assert.match(appStyles, new RegExp(`\\.${className}`));
    }
    assert.doesNotMatch(panel, /bg-sky-50|border-sky-|text-sky-|bg-sky-600/);
    assert.match(appStyles, /\.kui-egress-panel \{ border: 1px solid #d7dfeb;[\s\S]*background: rgba\(248,250,252,\.92\)/);
    assert.match(appStyles, /\.kui-egress-mode-button\.is-active[\s\S]*background: #4f46e5/);
    assert.match(appStyles, /data-kui-theme="dark"[\s\S]*\.kui-egress-panel/);
    assert.match(appStyles, /data-kui-theme="dark"[\s\S]*\.kui-egress-control/);
});

test('residential proxy uses four equal overview cards without matrix or scheduler panels', () => {
    const overviewStart = residentialProxyPage.indexOf('id="pc-nodes-table"');
    const scoreStart = residentialProxyPage.indexOf('id="pc-ip-score-section"');
    assert.ok(overviewStart >= 0 && scoreStart > overviewStart);
    const overview = residentialProxyPage.slice(overviewStart, scoreStart);

    assert.equal((overview.match(/class="pc-overview-card\b/g) || []).length, 4);
    for (const className of ['pc-target-card', 'pc-current-target-card', 'pc-exit-card-active', 'pc-exit-card-standby']) {
        assert.match(overview, new RegExp(className));
    }
    assert.match(residentialProxyPage, /id="pc-nodes-table" class="pc-overview-grid"/);
    assert.match(residentialProxyPage, /<label for="slot-target-ip" class="pc-card-title">目标 VPS<\/label>/);
    assert.doesNotMatch(residentialProxyPage.match(/<div id="pc-nodes-table"[^>]*>/)?.[0] || '', /aria-live/);
    assert.match(residentialProxyPage, /id="pc-active-copy"[^>]*hidden[^>]*>复制<\/button>/);
    assert.match(residentialProxyPage, /class="pc-exit-address"[\s\S]{0,220}id="pc-active-copy"/);
    assert.match(residentialProxyPage, /id="pc-config-dirty-badge"/);
    assert.doesNotMatch(residentialProxyPage, /pc-panel pc-scheduler-panel|pc-panel pc-node-matrix|活跃节点矩阵|<table\b|<tbody\b/);
    assert.doesNotMatch(residentialProxyPage, /id="pc-purity-attribution"/);
    assert.match(residentialProxyPage, /id="pc-ip-score-link"[\s\S]{0,180}https:\/\/ipok\.io/);
    assert.match(residentialProxyPage, /class="pc-panel pc-country-panel/);
    assert.match(residentialProxyPage, /class="pc-panel pc-score-panel/);
    assert.match(legacyProxy, /class="pc-country-chip/);
    assert.match(appStyles, /data-kui-theme="light"[\s\S]*\.pc-country-chip/);
    assert.match(residentialProxyPage, /id="pc-native-score-container"/);
    assert.doesNotMatch(residentialProxyPage, /diagView|原生深度质检报告|testisp\.info/);
    assert.match(appStyles, /\.pc-section-stack \{ display: grid; gap: 12px/);
});

test('residential target card keeps every scheduling control', () => {
    const targetStart = residentialProxyPage.indexOf('pc-target-card');
    const currentStart = residentialProxyPage.indexOf('pc-current-target-card', targetStart + 1);
    assert.ok(targetStart >= 0 && currentStart > targetStart);
    const targetCard = residentialProxyPage.slice(targetStart, currentStart);

    for (const id of ['slot-target-ip', 'slot-cfg-0', 'slot-port', 'slot-listen-host', 'pc-config-dirty-badge', 'pc-full-redial-hint']) {
        assert.match(targetCard, new RegExp(`id="${id}"`));
    }
    assert.match(targetCard, /@click="pcSaveConfig"/);
    assert.match(targetCard, /@click="pcSwitchIP\('full'\)"/);
    assert.match(targetCard, /下发策略/);
    assert.match(targetCard, /全量重拨/);
    assert.match(targetCard, /连接会中断/);
    assert.doesNotMatch(targetCard, /目标策略/);
});

test('residential current target card owns policy and channel summaries', () => {
    const currentStart = residentialProxyPage.indexOf('pc-current-target-card');
    const activeStart = residentialProxyPage.indexOf('pc-exit-card-active', currentStart + 1);
    assert.ok(currentStart >= 0 && activeStart > currentStart);
    const currentCard = residentialProxyPage.slice(currentStart, activeStart);

    for (const id of [
        'pc-overview-target',
        'pc-overview-target-sub',
        'pc-overview-policy',
        'pc-overview-policy-sub',
        'pc-overview-channels',
        'pc-overview-channels-sub',
    ]) {
        assert.match(currentCard, new RegExp(`id="${id}"`));
    }
    assert.match(currentCard, /调度策略/);
    assert.match(currentCard, /主备通道/);
    assert.doesNotMatch(residentialProxyPage, /pc-overview-policy-card/);
});

test('residential country candidates expand without an internal scrollbar', () => {
    assert.match(residentialProxyPage, /id="countries-list" class="pc-country-list/);
    assert.doesNotMatch(residentialProxyPage, /id="countries-list"[^>]*(?:max-h-|overflow-y-auto)/);
    assert.match(appStyles, /\.pc-country-list \{[^}]*min-height: 150px;[^}]*overflow: visible/);
});

test('residential country candidates sort by availability then country code', () => {
    assert.match(legacyProxy, /\.sort\(\(a, b\) => \{/);
    assert.match(legacyProxy, /const nodeDelta = \(b\.nodes \?\? -1\) - \(a\.nodes \?\? -1\)/);
    assert.match(legacyProxy, /return nodeDelta \|\| a\.code\.localeCompare\(b\.code, 'en'/);
});

test('residential overview cards use four, two, and one column breakpoints', () => {
    assert.match(appStyles, /\.pc-node-overview-grid \{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(appStyles, /@media \(max-width: 1023px\)[\s\S]*?\.pc-node-overview-grid \{[^}]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(appStyles, /@media \(max-width: 640px\)[\s\S]*?\.pc-node-overview-grid \{[^}]*?grid-template-columns:\s*1fr/);
    assert.match(appStyles, /\.pc-overview-grid \{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(appStyles, /@media \(max-width: 1023px\)[\s\S]*?\.pc-overview-grid \{[^}]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(appStyles, /@media \(max-width: 640px\)[\s\S]*?\.pc-overview-grid \{[^}]*?grid-template-columns:\s*1fr/);
    assert.doesNotMatch(appStyles, /grid-template-areas:\s*"target/);
    assert.doesNotMatch(appStyles, /\.pc-node-matrix/);
    assert.doesNotMatch(appStyles, /\.pc-scheduler-form/);
});

test('regular form controls and action buttons share the egress mode height', () => {
    assert.match(appStyles, /--kui-control-height:\s*36px/);
    assert.match(appStyles, /\.kui-admin-content input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),[\s\S]*\.kui-admin-content select[\s\S]*height: var\(--kui-control-height\)/);
    assert.match(appStyles, /\.kui-egress-mode-button \{[^}]*height: var\(--kui-control-height\)/);
    assert.match(appStyles, /\.kui-admin-content button:not\(\.kui-control-size-exempt\)[^\{]*\{[^}]*height: var\(--kui-control-height\)/);
    assert.doesNotMatch(appStyles, /\.kui-admin-content button, \.kui-admin-content input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), \.kui-admin-content select \{ min-height: 44px/);
});

test('global controls center their labels in both axes', () => {
    assert.match(appStyles, /button:not\(\.kui-control-size-exempt\) \{[^}]*align-items: center;[^}]*justify-content: center/);
    assert.match(appStyles, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), select \{[^}]*text-align: center/);
    assert.match(appStyles, /select \{ text-align-last: center/);
});

test('public listener and settings pages use explicit shared dark surfaces', () => {
    assert.match(publicListenerPage, /kui-public-listener-page/);
    assert.match(settingsPage, /kui-settings-page/);
    for (const className of ['kui-public-listener-hero', 'kui-public-listener-list', 'kui-public-listener-warning', 'kui-public-listener-error', 'kui-public-listener-status']) {
        assert.match(publicListenerPage, new RegExp(className));
        assert.match(appStyles, new RegExp(`data-kui-theme="dark"[^}]*\\.${className}|data-kui-theme="dark"[\\s\\S]*\\.${className}`));
    }
    assert.match(appStyles, /data-kui-theme="dark"\] \.kui-settings-card/);
    assert.match(appStyles, /\.kui-settings-table th/);
});

test('users and authorization page uses compact responsive controls and safe actions', () => {
    for (const className of ['kui-users-page', 'kui-users-panel', 'kui-user-create', 'kui-user-card', 'kui-group-card', 'kui-group-grid']) {
        assert.match(usersPage, new RegExp(className));
        assert.match(appStyles, new RegExp(`\\.${className}`));
    }
    assert.match(usersPage, /minlength="12"/);
    assert.match(usersPage, /@submit\.prevent="submitUser"/);
    assert.match(usersPage, /@submit\.prevent="submitGroup"/);
    assert.match(usersPage, /userActionPending/);
    assert.match(usersPage, /groupActionPending/);
    assert.match(appStyles, /\.kui-group-grid select\[multiple\] \{[^}]*height: 144px;[^}]*min-height: 144px/);
    assert.match(appStyles, /data-kui-theme="dark"\] \.kui-users-panel/);
});

test('settings places probe server management before dashboard appearance settings', () => {
    const realtime = settingsPage.indexOf('Realtime 状态频率策略');
    const servers = settingsPage.indexOf('kui-probe-server-settings');
    const dashboard = settingsPage.indexOf('探针大盘外观与设置');
    assert.ok(realtime >= 0 && realtime < servers && servers < dashboard);
});

test('settings page uses compact semantic sections and guarded actions', () => {
    for (const className of ['kui-settings-card', 'kui-settings-heading', 'kui-settings-grid', 'kui-settings-field', 'kui-settings-switch', 'kui-settings-table']) {
        assert.match(settingsPage, new RegExp(className));
        assert.match(appStyles, new RegExp(`\\.${className}`));
    }
    assert.match(settingsPage, /@input="markProbeSettingsDirty"/);
    assert.match(settingsPage, /probeSettingsSaving/);
    assert.match(settingsPage, /siteTitleSaving/);
    assert.match(settingsPage, /minlength="12"/);
    assert.match(appStyles, /data-kui-theme="dark"\] \.kui-settings-card/);
    assert.match(settingsPage, /kui-settings-grid-three kui-settings-telegram-grid/);
});

test('deleting a managed probe also removes its server card and dependent VPS records', () => {
    assert.match(api, /if \(method === 'DELETE' && subPath === 'admin\/server'\) \{[\s\S]{0,500}await deleteVpsRecords\(db, id\)/);
    assert.match(api, /async function deleteVpsRecords[\s\S]{0,1000}DELETE FROM servers WHERE ip = \?/);
    assert.match(state, /删除后，“服务器与节点”中的服务器卡片及其关联节点也会一并移除/);
});

test('servers page supports toolbar filtering, collapsible egress config, tabbed deployment, and residential shortcut', () => {
    assert.match(serversPage, /class="kui-server-toolbar"/);
    assert.match(serversPage, /v-model\.trim="serverSearch"/);
    assert.match(serversPage, /serverStatusFilter/);
    assert.match(serversPage, /serverEgressFilter/);
    assert.match(serversPage, /v-show="matchesServerFilter\(vps\)"/);
    assert.match(serversPage, /openResidentialProxy\(vps\.ip\)/);
    assert.match(serversPage, /class="kui-deploy-tabs"/);
    assert.match(serversPage, /class="kui-node-advanced"/);
    assert.match(serversPage, /class="kui-node-filter-bar"/);
    assert.match(serversPage, /quickCopyNode\(vps, node\)/);
    assert.match(state, /const openResidentialProxy = \(ip = ''\) =>/);
    assert.match(app, /class="kui-toast"/);
});

test('residential proxy page uses semantic token layout, status overview, country filter, and diagnostic controls', () => {
    assert.doesNotMatch(residentialProxyPage, /animate-pulse|blur-\[120px\]|bg-\[#090e17\]/);
    assert.match(residentialProxyPage, /class="pc-overview-grid"/);
    for (const id of ['pc-overview-target', 'pc-overview-channels', 'pc-overview-exit', 'pc-overview-policy', 'pc-config-dirty-badge', 'pc-hot-switch-btn', 'pc-country-toggle']) {
        assert.match(residentialProxyPage, new RegExp(`id="${id}"`));
    }
    for (const id of ['pc-node-overview-section', 'pc-node-overview-grid', 'pc-node-overview-count', 'pc-batch-mode-btn', 'pc-detail-target-badge', 'pc-overview-connections', 'pc-overview-traffic', 'pc-profile-role-active', 'pc-profile-role-standby']) {
        assert.match(residentialProxyPage, new RegExp(`id="${id}"`));
    }
    assert.match(residentialProxyPage, /pcToggleBatchMode/);
    assert.match(residentialProxyPage, /pcSetProfileRole/);
    assert.match(appStyles, /\.pc-profile-role-switch/);
    assert.match(appStyles, /\.pc-profile-content/);
    assert.match(appStyles, /\.pc-purity-progress/);
    assert.match(appStyles, /data-kui-theme="dark"[\s\S]*\.pc-profile-verdict/);
    assert.match(residentialProxyPage, /pcSetCountryFilter/);
    assert.match(residentialProxyPage, /pcToggleCountriesExpanded/);
    assert.match(residentialProxyPage, /pcSetLogFilter/);
    assert.match(residentialProxyPage, /pcToggleLogPause/);
    assert.match(residentialProxyPage, /pcCopyLogs/);
    assert.match(appStyles, /\.pc-overview-grid/);
    assert.match(appStyles, /\.kui-toast/);
});

test('residential overview exposes status rows, native channel details, and hidden copy actions', () => {
    const overviewStart = residentialProxyPage.indexOf('class="pc-overview-grid"');
    const scoreStart = residentialProxyPage.indexOf('id="pc-ip-score-section"');
    assert.ok(overviewStart >= 0 && scoreStart > overviewStart);
    const overview = residentialProxyPage.slice(overviewStart, scoreStart);

    for (const id of [
        'pc-overview-target',
        'pc-overview-target-sub',
        'pc-overview-channels',
        'pc-overview-channels-sub',
        'pc-overview-policy',
        'pc-overview-policy-sub',
        'pc-overview-exit',
        'pc-overview-exit-sub',
        'pc-overview-standby',
        'pc-overview-standby-sub',
        'pc-overview-active-status',
        'pc-overview-standby-status',
    ]) {
        assert.match(overview, new RegExp(`id="${id}"`));
    }
    for (const id of ['pc-overview-target-sub', 'pc-overview-exit-sub', 'pc-overview-standby-sub']) {
        assert.match(overview, new RegExp(`id="${id}" class="pc-status-list"`));
    }
    assert.equal((overview.match(/class="pc-status-row"/g) || []).length, 2);
    assert.match(overview, /class="pc-status-placeholder"/);

    const activeCard = overview.indexOf('pc-exit-card-active');
    const standbyCard = overview.indexOf('pc-exit-card-standby');
    assert.ok(activeCard >= 0 && activeCard < standbyCard);
    assert.match(overview, /id="pc-overview-active-status"[^>]*data-tone="neutral"/);
    assert.match(overview, /id="pc-overview-standby-status"[^>]*data-tone="neutral"/);
    assert.match(overview, /质量/);

    for (const role of ['active', 'standby']) {
        const label = role === 'active' ? '主' : '备用';
        assert.match(overview, new RegExp(`id="pc-${role}-details" class="[^"]*pc-channel-details" hidden`));
        assert.match(overview, new RegExp(`id="pc-${role}-details"[\\s\\S]*?<summary>通道详情<\\/summary>`));
        assert.match(overview, new RegExp(`id="pc-${role}-detail-rows"[^>]*class="[^"]*pc-status-list`));
        assert.match(overview, new RegExp(`id="pc-${role}-copy"[^>]*hidden[^>]*@click="pcCopyOverviewExit\\('${role}'\\)"`));
        assert.match(overview, new RegExp(`id="pc-${role}-copy"[^>]*aria-label="复制${label}出口 IP"`));
    }

    const standbyMarkup = overview.slice(standbyCard, overview.indexOf('</article>', standbyCard));
    assert.match(standbyMarkup, /class="[^"]*pc-hot-switch-group/);
    assert.match(standbyMarkup, /id="pc-hot-switch-btn"[^>]*disabled/);
    assert.match(standbyMarkup, /@click="pcSwitchIP\('hot'\)"/);
    assert.match(standbyMarkup, /重新拨号/);
    assert.match(standbyMarkup, /现有连接可能中断/);
    assert.doesNotMatch(residentialProxyPage, /双活/);

    assert.match(appStyles, /\.pc-status-row \{[^}]*display: grid/);
    assert.match(appStyles, /\.pc-status-row \{[^}]*min-height: 25px[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
    assert.match(appStyles, /\.pc-status-value \{[^}]*text-align: right/);
    assert.match(appStyles, /\.pc-channel-details > summary::before \{[^}]*content: '▶'/);
    assert.doesNotMatch(appStyles, /grid-area: (?:active|standby)/);
    assert.match(appStyles, /\.pc-status-label \{/);
    assert.match(appStyles, /\.pc-status-value \{/);
    assert.match(appStyles, /\.pc-status-label a \{/);
    assert.match(appStyles, /\.pc-channel-details\[hidden\][^{]*\{[^}]*display:\s*none/);
    assert.match(appStyles, /\.pc-exit-copy\[hidden\][^{]*\{[^}]*display:\s*none/);
    assert.match(appStyles, /\.pc-exit-status\[data-tone="ready"\]/);
    assert.match(appStyles, /\.pc-exit-status\[data-tone="wait"\]/);
    assert.match(appStyles, /\.pc-exit-status\[data-tone="neutral"\]/);
});
