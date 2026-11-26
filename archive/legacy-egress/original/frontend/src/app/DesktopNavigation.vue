<template>
  <aside class="kui-sidebar">
    <div class="kui-sidebar-brand">
      <span class="kui-brand-mark">K</span>
      <div class="min-w-0">
        <strong class="block truncate">{{ siteTitle || 'Cluster Gateway' }}</strong>
        <span class="text-[11px] text-slate-400">Control Center</span>
      </div>
    </div>

    <nav class="kui-sidebar-nav" aria-label="主导航">
      <template v-if="role === 'admin'">
        <button v-for="item in adminItems" :key="item.id" @click="go(item.id)" :class="{ active: activeTab === item.id }">
          <span class="kui-nav-icon">{{ item.icon }}</span><span>{{ item.label }}</span>
        </button>
      </template>
      <template v-else>
        <button v-for="item in userItems" :key="item.id" @click="go(item.id)" :class="{ active: activeTab === item.id }">
          <span class="kui-nav-icon">{{ item.icon }}</span><span>{{ item.label }}</span>
        </button>
      </template>
    </nav>

    <div v-if="role === 'admin'" class="kui-sidebar-secondary">
      <label class="kui-sidebar-theme-picker" title="界面配色">
        <span class="kui-nav-icon" aria-hidden="true">{{ effectiveColorMode === 'dark' ? '☾' : '☀' }}</span>
        <select v-model="colorMode" aria-label="界面配色">
          <option value="system">跟随系统</option>
          <option value="light">浅色模式</option>
          <option value="dark">深色模式</option>
        </select>
      </label>
      <button @click="go('settings')" :class="{ active: activeTab === 'settings' }">
        <span class="kui-nav-icon">⚙</span><span>系统设置</span>
      </button>
    </div>

    <div class="kui-sidebar-footer">
      <div class="kui-user-avatar">{{ (currentUser || 'U').slice(0, 1).toUpperCase() }}</div>
      <div class="min-w-0 flex-1"><strong class="block truncate text-sm">{{ currentUser }}</strong><span class="text-[11px] text-slate-400">{{ role === 'admin' ? '管理员' : '用户' }}</span></div>
      <button class="kui-icon-button" title="退出登录" @click="logout">↪</button>
    </div>
  </aside>
</template>

<script>
import { inject } from 'vue';
import { KUI_KEY } from './context.js';

const adminItems = [
  { id: 'nodes', icon: '▣', label: '服务器与节点' },
  { id: 'proxy', icon: '⌁', label: '住宅 IP 代理' },
  { id: 'warp', icon: '◈', label: 'WARP 隧道' },
  { id: 'public-listener', icon: '◉', label: '公网监听' },
  { id: 'thirdparty', icon: '↗', label: '第三方订阅' },
  { id: 'users', icon: '◎', label: '用户与授权' },
];
const userItems = [
  { id: 'dashboard', icon: '⌂', label: '我的主页' },
  { id: 'settings', icon: '⚙', label: '账号设置' },
];

export default {
  setup() {
    const state = inject(KUI_KEY);
    const go = id => { state.activeTab.value = id; if (id === 'probe') state.probeDetailId.value = null; };
    return { ...state, adminItems, userItems, go };
  },
};
</script>
