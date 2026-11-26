<template>
  <nav class="kui-mobile-nav" aria-label="移动端导航">
    <template v-if="role === 'admin'">
      <button v-for="item in primaryAdminItems" :key="item.id" @click="go(item.id)" :class="{ active: activeTab === item.id }"><span>{{ item.icon }}</span>{{ item.label }}</button>
      <button @click="moreOpen = true" :class="{ active: moreIds.includes(activeTab) }"><span>•••</span>更多</button>
    </template>
    <template v-else>
      <button v-for="item in userItems" :key="item.id" @click="go(item.id)" :class="{ active: activeTab === item.id }"><span>{{ item.icon }}</span>{{ item.label }}</button>
      <button @click="logout"><span>↪</span>退出</button>
    </template>
  </nav>

  <div v-if="moreOpen" class="kui-mobile-sheet-backdrop" @click.self="moreOpen = false">
    <section class="kui-mobile-sheet">
      <div class="kui-sheet-handle"></div>
      <div class="flex items-center justify-between mb-3"><strong>更多功能</strong><button class="kui-icon-button" @click="moreOpen = false">×</button></div>
      <div class="kui-mobile-more-grid">
        <button v-for="item in moreItemsBeforeTheme" :key="item.id" @click="go(item.id)" :class="{ active: activeTab === item.id }"><span>{{ item.icon }}</span>{{ item.label }}</button>
        <label class="kui-mobile-theme-picker" title="界面配色">
          <span aria-hidden="true">{{ effectiveColorMode === 'dark' ? '☾' : '☀' }}</span>
          <select v-model="colorMode" aria-label="界面配色">
            <option value="system">跟随系统</option>
            <option value="light">浅色模式</option>
            <option value="dark">深色模式</option>
          </select>
        </label>
        <button v-for="item in moreItemsAfterTheme" :key="item.id" @click="go(item.id)" :class="{ active: activeTab === item.id }"><span>{{ item.icon }}</span>{{ item.label }}</button>
      </div>
      <button class="kui-mobile-logout" @click="logout">退出登录</button>
    </section>
  </div>
</template>

<script>
import { inject, ref } from 'vue';
import { KUI_KEY } from './context.js';

const primaryAdminItems = [
  { id: 'nodes', icon: '▣', label: '服务器' },
  { id: 'proxy', icon: '⌁', label: '住宅' },
  { id: 'public-listener', icon: '◉', label: '公网监听' },
];
const moreItems = [
  { id: 'warp', icon: '◈', label: 'WARP' }, { id: 'thirdparty', icon: '↗', label: '订阅' }, { id: 'users', icon: '◎', label: '用户' }, { id: 'settings', icon: '⚙', label: '设置' },
];
const moreItemsBeforeTheme = moreItems.filter(item => item.id !== 'settings');
const moreItemsAfterTheme = moreItems.filter(item => item.id === 'settings');
const userItems = [
  { id: 'dashboard', icon: '⌂', label: '主页' }, { id: 'settings', icon: '⚙', label: '设置' }, { id: 'probe', icon: '◉', label: '探针监控' },
];
const moreIds = moreItems.map(item => item.id);

export default {
  setup() {
    const state = inject(KUI_KEY);
    const moreOpen = ref(false);
    const go = id => {
      moreOpen.value = false;
      state.activeTab.value = id;
      if (id === 'probe') state.probeDetailId.value = null;
    };
    return { ...state, go, moreIds, moreItemsAfterTheme, moreItemsBeforeTheme, moreOpen, primaryAdminItems, userItems };
  },
};
</script>
