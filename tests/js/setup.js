/**
 * Vitest setup: Mock WebExtension APIs before any extension module loads.
 */

// Mock the browser/chrome WebExtension API
globalThis.browser = {
  runtime: {
    id: "entra-bridge@linux-entra-bridge", // matches manifests/firefox.json gecko.id; Chromium uses a different ID but tests only need internal consistency
    sendNativeMessage: vi.fn((_host, _msg, cb) => cb && cb({})),
    sendMessage: vi.fn((_msg, cb) => cb && cb({})),
    onMessage: { addListener: vi.fn() },
    lastError: null,
    getManifest: vi.fn(() => ({ version: "0.1.0", manifest_version: 3, name: "Linux Entra Bridge" })),
  },
  tabs: {
    query: vi.fn().mockResolvedValue([{ url: "https://example.com" }]),
  },
  permissions: {
    request: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    contains: vi.fn().mockResolvedValue(false),
    getAll: vi.fn().mockResolvedValue({ origins: [], permissions: [] }),
    onAdded: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  cookies: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    managed: {
      get: vi.fn().mockResolvedValue({}),
    },
    onChanged: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  webNavigation: {
    onBeforeNavigate: { addListener: vi.fn() },
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
};

// Chrome is alias of browser in test env
globalThis.chrome = globalThis.browser;
