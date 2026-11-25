<template>
  <ProbePage />
  <AppShell />
  <ProbeEditModal />
  <QrModal />
  <div v-if="toast.visible" class="kui-toast" :class="'is-' + toast.tone" role="status" aria-live="polite">
    <span>{{ toast.text }}</span>
    <button type="button" class="kui-toast-close kui-control-size-exempt" @click="dismissToast" aria-label="关闭提示">×</button>
  </div>
</template>

<script>
import { provide } from 'vue';
import AppShell from './app/AppShell.vue';
import { KUI_KEY } from './app/context.js';
import ProbeEditModal from './components/modals/ProbeEditModal.vue';
import QrModal from './components/modals/QrModal.vue';
import { useKuiState } from './composables/useKuiState.js';
import ProbePage from './pages/ProbePage.vue';

export default {
  components: { AppShell, ProbeEditModal, ProbePage, QrModal },
  setup() {
    const state = useKuiState();
    provide(KUI_KEY, state);
    return state;
  },
};
</script>
