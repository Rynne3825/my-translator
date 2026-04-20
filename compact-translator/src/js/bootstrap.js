import { App } from './app.js';

const app = new App();

const startApp = async () => {
  try {
    await app.init();
    window.__TB_APP_READY = true;
    window.__TB_INIT_STAGE = 'app_ready';
  } catch (err) {
    window.__TB_INIT_STAGE = 'app_init_failed';
    const message = err?.message || String(err);
    if (typeof window.__TB_SHOW_RUNTIME_ERROR === 'function') {
      window.__TB_SHOW_RUNTIME_ERROR(message);
    }
    console.error('[compact bootstrap] init failed', err);
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApp, { once: true });
} else {
  startApp();
}
