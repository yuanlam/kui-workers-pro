<template>
  <div v-if="isLoggedIn && activeTab !== 'probe'" class="kui-admin-shell">
    <DesktopNavigation />
    <div class="kui-admin-workspace">
      <TopBar />
      <main class="kui-admin-content">
        <div v-if="role === 'admin' && securityWarnings.length" class="kui-alert kui-alert-danger">
          <div v-for="warning in securityWarnings" :key="warning">⚠ {{ warning }}</div>
        </div>
        <ServersPage />
        <UsersPage />
        <ResidentialProxyPage />
        <WarpTunnelPage />
        <PublicListenerPage />
        <UserDashboardPage />
        <ThirdPartyPage />
        <SettingsPage />
      </main>
    </div>
    <MobileNavigation />
  </div>
</template>

<script>
import { inject } from 'vue';
import DesktopNavigation from './DesktopNavigation.vue';
import MobileNavigation from './MobileNavigation.vue';
import TopBar from './TopBar.vue';
import { KUI_KEY } from './context.js';
import ResidentialProxyPage from '../pages/ResidentialProxyPage.vue';
import WarpTunnelPage from '../pages/WarpTunnelPage.vue';
import PublicListenerPage from '../pages/PublicListenerPage.vue';
import ServersPage from '../pages/ServersPage.vue';
import SettingsPage from '../pages/SettingsPage.vue';
import ThirdPartyPage from '../pages/ThirdPartyPage.vue';
import UserDashboardPage from '../pages/UserDashboardPage.vue';
import UsersPage from '../pages/UsersPage.vue';

export default {
  components: {
    DesktopNavigation,
    MobileNavigation,
    TopBar,
    ResidentialProxyPage,
    WarpTunnelPage,
    PublicListenerPage,
    ServersPage,
    SettingsPage,
    ThirdPartyPage,
    UserDashboardPage,
    UsersPage,
  },
  setup() {
    return inject(KUI_KEY);
  },
};
</script>
