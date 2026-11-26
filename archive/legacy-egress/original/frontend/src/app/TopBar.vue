<template>
  <header class="kui-topbar">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <h1 class="kui-page-title">{{ pageTitle }}</h1>
        <span class="kui-live-badge"><i></i><span class="hidden sm:inline">实时连接</span></span>
      </div>
    </div>
    <div class="kui-topbar-actions">
      <button @click="openProbe" class="kui-button kui-button-ghost kui-probe-button" title="探针监控" aria-label="探针监控">
        <span>◉</span><span class="kui-probe-button-label">探针监控</span>
      </button>
      <a href="https://github.com/yuanlam/kui-workers-pro" target="_blank" rel="noreferrer" class="kui-button kui-button-ghost kui-desktop-only">GitHub</a>
      <details v-if="role === 'admin'" class="kui-action-menu">
        <summary class="kui-button kui-button-ghost">订阅与导出 <span>⌄</span></summary>
        <div class="kui-action-menu-panel">
          <button @click="copyCommand(generateSubLink('', ''), '全量普通订阅已复制！', $event)">复制普通订阅</button>
          <button @click="copyCommand(generateSubLink('', 'clash'), '全量Clash订阅已复制！', $event)">复制 Clash 订阅</button>
          <button @click="copySurgeConfig('', '', $event)">复制 Surge 配置段</button>
          <button @click="showQrCode(generateSubLink('', ''))">显示订阅二维码</button>
        </div>
      </details>
      <button @click="refreshPanel" :disabled="refreshing" class="kui-button kui-button-primary">
        <span :class="{ 'kui-spin': refreshing }">↻</span><span class="hidden sm:inline">{{ refreshing ? '刷新中' : '刷新' }}</span>
      </button>
    </div>
  </header>
</template>

<script>
import { computed, inject } from 'vue';
import { KUI_KEY } from './context.js';

const titles = {
  nodes: '服务器与节点', users: '用户与授权', proxy: '住宅 IP 代理',
  warp: 'WARP 隧道',
  thirdparty: '第三方订阅', 'public-listener': '公网监听', settings: '系统设置', dashboard: '我的主页',
};

export default {
  setup() {
    const state = inject(KUI_KEY);
    const openProbe = () => { state.probeDetailId.value = null; state.activeTab.value = 'probe'; };
    return { ...state, openProbe, pageTitle: computed(() => titles[state.activeTab.value] || '控制面板') };
  },
};
</script>
