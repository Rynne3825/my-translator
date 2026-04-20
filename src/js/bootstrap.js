import { App } from './app.js';

const bootApp = () => {
    if (window.__TB_APP_BOOTED) return;
    window.__TB_APP_BOOTED = true;

    let app;
    try {
        app = new App();
    } catch (err) {
        window.__TB_INIT_STAGE = 'failed_construct';
        window.__TB_INIT_ERROR = err?.message || `${err}`;
        console.error('[App] constructor failed:', err);
        window.__TB_SHOW_RUNTIME_ERROR?.(window.__TB_INIT_ERROR);
        return;
    }

    window.__TB_APP_INSTANCE = app;
    app.init().catch((err) => {
        window.__TB_INIT_STAGE = 'failed';
        window.__TB_INIT_ERROR = err?.message || `${err}`;
        console.error('[App] init failed:', err);
        const message = err?.message || `${err}`;
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast error show';
        toast.textContent = `Init failed: ${message}`;
        document.body.appendChild(toast);
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp, { once: true });
} else {
    bootApp();
}