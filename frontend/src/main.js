import { createApp } from 'vue';
import App from './App.vue';
import './styles/legacy.css';
import './styles/tokens.css';
import './styles/app.css';
import { ensureGoogleFonts } from './utils/externalDeps.js';

createApp(App).mount('#app');

const loadFonts = () => {
  ensureGoogleFonts().catch(() => {});
};

if (typeof globalThis.requestIdleCallback === 'function') {
  globalThis.requestIdleCallback(loadFonts);
} else {
  setTimeout(loadFonts, 0);
}
