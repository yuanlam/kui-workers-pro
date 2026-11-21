export const DEFAULT_PROBE_THEMES = [
    { id: 'theme1', name: '1. 默认清爽白 (Classic)', is_dark: false, css: '' },
    { id: 'theme2', name: '2. 暗黑极客 (Dark)', is_dark: true, css: '' },
    { id: 'theme3', name: '3. 新粗野主义 (Brutalism)', is_dark: false, css: '' },
    { id: 'theme4', name: '4. 动态渐变毛玻璃 (Glass)', is_dark: true, css: '' },
    { id: 'theme5', name: '5. 赛博朋克 (Cyberpunk)', is_dark: true, css: '' },
    { id: 'theme6', name: '6. 完全自定义 CSS', is_dark: true, has_custom_css: true, css: '' },
];

export const createDefaultProbeThemes = () => DEFAULT_PROBE_THEMES.map(theme => ({ ...theme }));

export const THEME_COMPATIBILITY_CSS = `
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

const CUSTOM_BACKGROUND_GLASS_CSS = `.probe-vps-card, .probe-global-stats, .probe-header-card, .probe-chart-card, .probe-custom-table, .probe-filter-tag, .probe-view-controls { background: rgba(255, 255, 255, 0.4) !important; backdrop-filter: blur(12px) !important; -webkit-backdrop-filter: blur(12px) !important; border: 1px solid rgba(255, 255, 255, 0.6) !important; box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.1) !important; color: #111 !important; } .probe-vps-card:hover { background: rgba(255, 255, 255, 0.6) !important; transform: translateY(-3px); } .probe-group-header { color: #fff !important; text-shadow: 0 2px 5px rgba(0,0,0,0.6) !important; border-left-color: #fff !important; } .probe-g-val, .probe-card-title { color: #000 !important; font-weight: 800 !important; } .probe-g-label, .probe-g-sub, .probe-card-meta { color: #333 !important; font-weight: 600 !important; } .probe-stat-bar-full { background: rgba(0,0,0,0.1) !important; }`;

export const sanitizeCssUrl = rawUrl => {
    const raw = String(rawUrl ?? '');
    if (/[\u0000-\u001F\u007F]/.test(raw)) return '';
    const value = raw.trim();
    if (!value) return '';

    const lower = value.toLowerCase();
    const isAllowedProtocol = lower.startsWith('https:')
        || lower.startsWith('http:')
        || lower.startsWith('data:image/')
        || (value.startsWith('/') && !value.startsWith('//'));
    if (!isAllowedProtocol) return '';

    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
};

export const buildCustomBackgroundCss = customBg => {
    const safeUrl = sanitizeCssUrl(customBg);
    if (!safeUrl) return '';
    return `body { background: url('${safeUrl}') no-repeat center center fixed !important; background-size: cover !important; } ${CUSTOM_BACKGROUND_GLASS_CSS}`;
};

export const buildProbeThemeCss = ({ themeId, availableThemes = [], customCss = '', customBg = '' } = {}) => {
    const themes = Array.isArray(availableThemes) ? availableThemes : [];
    const currentTheme = themes.find(theme => theme?.id === themeId) || themes[0];
    let css = '';
    if (currentTheme?.css) css += currentTheme.css + '\n';
    css += THEME_COMPATIBILITY_CSS;

    if (customCss && (themeId === 'theme6' || currentTheme?.has_custom_css)) {
        css += customCss + '\n';
    }

    css += buildCustomBackgroundCss(customBg);
    return css;
};
