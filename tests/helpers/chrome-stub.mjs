export function installChromeStub(overrides = {}) {
  const store = {};
  const listeners = () => ({ addListener() {}, removeListener() {} });
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async () => {},
      getPlatformInfo: (cb) => cb && cb({}),
      onMessage: listeners(), onInstalled: listeners(), onStartup: listeners(), lastError: null
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store };
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (k) => { for (const x of [].concat(k)) delete store[x]; }
      },
      onChanged: listeners()
    },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: listeners(), onEvent: listeners() },
    tabs: { query: async () => [], create: async (o) => ({ id: 1, ...o }), update: async () => ({}), get: async (id) => ({ id }), onRemoved: listeners(), onUpdated: listeners() },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    action: { onClicked: listeners() },
    scripting: { executeScript: async () => [] },
    ...overrides
  };
  globalThis.self = globalThis;
  globalThis.addEventListener ||= () => {};
  globalThis.skipWaiting ||= async () => {};
  globalThis.clients ||= { claim: async () => {} };
  return store;
}
