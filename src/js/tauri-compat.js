const tauriGlobal = window.__TAURI__ || {};
const tauriCore = tauriGlobal.core || {};
const tauriWindowApi = tauriGlobal.window || {};

export const invoke = typeof tauriCore.invoke === 'function'
    ? tauriCore.invoke.bind(tauriCore)
    : async () => {
        throw new Error('Tauri core.invoke is unavailable');
    };

export const getCurrentWindow = typeof tauriWindowApi.getCurrentWindow === 'function'
    ? tauriWindowApi.getCurrentWindow.bind(tauriWindowApi)
    : (typeof tauriWindowApi.getCurrent === 'function'
        ? tauriWindowApi.getCurrent.bind(tauriWindowApi)
        : null);

export const createFallbackWindowHandle = () => ({
    close: async () => {},
    minimize: async () => {},
    setAlwaysOnTop: async () => {},
    scaleFactor: async () => 1,
    outerPosition: async () => ({ x: 0, y: 0 }),
    innerSize: async () => ({ width: 1200, height: 760 }),
    setSize: async () => {},
    setPosition: async () => {},
});