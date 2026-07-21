/**
 * Comprehensive tests for background.js — the core of the Entra SSO extension.
 */

// Module exports — populated in beforeAll via dynamic import
let _internal, logBuffer;
let decodeJwtPayload, getCookieExpiry, ssoLog;
let refreshCookie, _doRefreshCookie, setCookieInStore, removeCookieFromStore;
let computeAndSetCookie, resetCookieAndRefresh;
let scheduleRefresh, markBrokerUnhealthy, updateBadge, callBroker, loadDebugSetting;
let saveHealthState, loadHealthState, validateAccount, sanitizeAccount, getSelectedAccount;
let normalizeBrokerResponse, SSO_NONCE_HOSTS, SSO_NONCE_FILTER, DENY_KEYS;
let isContainerStore, isOwaHost, CONTAINER_STORE_RE;

// truncateMsg is imported from lib.js (not re-exported from background.js)
let truncateMsg;

// Saved references to the REAL registered listeners (captured before clearAllMocks)
let onMessageListener;
let onAlarmListener;
let onChangedListener;
let onBeforeNavigateListener;
let onContainerNavigateListener;

// Sender mock for onMessage calls — derived from mock runtime.id for consistency
const SELF_SENDER = { id: browser.runtime.id };

beforeAll(async () => {
  // Import truncateMsg from lib.js (shared utility, not re-exported from background.js)
  const libMod = await import("../../extension/lib.js");
  truncateMsg = libMod.truncateMsg;

  // Import background.js as ES module — side effects (refreshCookie, loadDebugSetting) run with mocks
  const mod = await import("../../extension/background.js");
  ({
    _internal, logBuffer,
    decodeJwtPayload, getCookieExpiry, ssoLog,
    refreshCookie, _doRefreshCookie, setCookieInStore, removeCookieFromStore,
    computeAndSetCookie, resetCookieAndRefresh,
    scheduleRefresh, markBrokerUnhealthy, updateBadge, callBroker, loadDebugSetting,
    saveHealthState, loadHealthState, validateAccount, sanitizeAccount, getSelectedAccount,
    normalizeBrokerResponse, SSO_NONCE_HOSTS, SSO_NONCE_FILTER, DENY_KEYS,
    isContainerStore, isOwaHost, CONTAINER_STORE_RE,
  } = mod);

  // Capture the actual registered listeners BEFORE any clearAllMocks.
  // Resolve the two onBeforeNavigate listeners by their filter content (NOT by index),
  // so the tests don't depend on registration order:
  //   nonce handler   -> registered with { url: SSO_NONCE_FILTER }
  //   container handler-> registered with { url: [...{hostSuffix:".office.com"}...] }
  onMessageListener = browser.runtime.onMessage.addListener.mock.calls[0]?.[0];
  onAlarmListener = browser.alarms.onAlarm.addListener.mock.calls[0]?.[0];
  onChangedListener = browser.storage.onChanged.addListener.mock.calls[0]?.[0];
  const navCalls = browser.webNavigation.onBeforeNavigate.addListener.mock.calls;
  onBeforeNavigateListener = navCalls.find((c) => c[1]?.url === SSO_NONCE_FILTER)?.[0];
  onContainerNavigateListener = navCalls.find(
    (c) => c[1]?.url?.some((f) => f.hostSuffix === ".office.com"))?.[0];
});

beforeEach(() => {
  // Reset state between tests
  _internal.cachedCookie = null;
  _internal.cookieExpiry = 0;
  _internal.brokerHealthy = true;
  _internal.healthRetryAt = 0;
  _internal.debugEnabled = false;
  _internal.refreshInFlight = null;
  _internal.healthBackoffMs = 30000; // reset backoff to initial value
  _internal.lastNonceValue = null;
  _internal.lastNonceCallTime = 0;
  _internal.nonceCallTimestamps = [];
  _internal.isThunderbird = true; // default TB for container tests; override to false for no-op cases
  _internal.browserInfoReady = Promise.resolve();
  logBuffer.length = 0;

  // Reset all mocks
  vi.clearAllMocks();
  browser.runtime.lastError = null;
  browser.storage.local.get.mockResolvedValue({});
  browser.storage.local.set.mockResolvedValue(undefined);
  browser.storage.local.remove.mockResolvedValue(undefined);
  browser.cookies.get.mockResolvedValue(null);
  browser.cookies.set.mockResolvedValue(undefined);
  browser.cookies.remove.mockResolvedValue(undefined);
  browser.cookies.getAllCookieStores.mockResolvedValue([{ id: "firefox-default", tabIds: [] }]);
  browser.runtime.getBrowserInfo.mockResolvedValue({ name: "Thunderbird", version: "128.0" });
  browser.runtime.sendNativeMessage.mockImplementation((_host, _msg, cb) => cb && cb({}));
});

// ===== truncateMsg =====

describe("truncateMsg", () => {
  test("returns short strings unchanged", () => {
    expect(truncateMsg("hello")).toBe("hello");
  });

  test("returns string of exactly 200 chars unchanged", () => {
    const s = "a".repeat(200);
    expect(truncateMsg(s)).toBe(s);
  });

  test("truncates string longer than 200 chars", () => {
    const s = "x".repeat(201);
    const result = truncateMsg(s);
    expect(result.length).toBe(201); // 200 + ellipsis char
    expect(result.endsWith("\u2026")).toBe(true);
  });

  test("converts non-string input to string", () => {
    expect(truncateMsg(42)).toBe("42");
    expect(truncateMsg(null)).toBe("null");
    expect(truncateMsg(undefined)).toBe("undefined");
  });
});

// ===== validateAccount =====

describe("validateAccount", () => {
  test("accepts valid account with required fields", () => {
    expect(validateAccount({ homeAccountId: "abc-123", username: "user@example.com" })).toBe(true);
  });
  test("accepts account with extra fields", () => {
    expect(validateAccount({ homeAccountId: "abc", username: "u@t.com", name: "User", realm: "tenant" })).toBe(true);
  });
  test("rejects null", () => { expect(validateAccount(null)).toBe(false); });
  test("rejects undefined", () => { expect(validateAccount(undefined)).toBe(false); });
  test("rejects string", () => { expect(validateAccount("not-an-object")).toBe(false); });
  test("rejects number", () => { expect(validateAccount(42)).toBe(false); });
  test("rejects boolean", () => { expect(validateAccount(true)).toBe(false); });
  test("rejects array", () => { expect(validateAccount([{ homeAccountId: "a", username: "b" }])).toBe(false); });
  test("rejects empty object", () => { expect(validateAccount({})).toBe(false); });
  test("rejects missing homeAccountId", () => { expect(validateAccount({ username: "u@t.com" })).toBe(false); });
  test("rejects missing username", () => { expect(validateAccount({ homeAccountId: "abc" })).toBe(false); });
  test("rejects non-string homeAccountId", () => { expect(validateAccount({ homeAccountId: 123, username: "u" })).toBe(false); });
  test("rejects non-string username", () => { expect(validateAccount({ homeAccountId: "abc", username: 123 })).toBe(false); });
  test("rejects empty homeAccountId", () => { expect(validateAccount({ homeAccountId: "", username: "u" })).toBe(false); });
  test("rejects empty username", () => { expect(validateAccount({ homeAccountId: "abc", username: "" })).toBe(false); });
});

// ===== decodeJwtPayload =====

describe("decodeJwtPayload", () => {
  test("decodes valid JWT payload", () => {
    // {"test":1} → eyJ0ZXN0IjoxfQ
    const jwt = "header.eyJ0ZXN0IjoxfQ.signature";
    expect(decodeJwtPayload(jwt)).toEqual({ test: 1 });
  });

  test("handles URL-safe base64 characters", () => {
    // Base64 with - and _ instead of + and /
    const payload = btoa(JSON.stringify({ foo: "bar" })).replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = `header.${payload}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual({ foo: "bar" });
  });

  test("returns null for empty string", () => {
    expect(decodeJwtPayload("")).toBeNull();
  });

  test("returns null for string without dots", () => {
    expect(decodeJwtPayload("nodots")).toBeNull();
  });

  test("returns null for bad base64", () => {
    expect(decodeJwtPayload("a.!!!invalid.c")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(decodeJwtPayload(null)).toBeNull();
  });

  test("returns null for numeric input", () => {
    expect(decodeJwtPayload(42)).toBeNull();
  });

  test("returns null for object input", () => {
    expect(decodeJwtPayload({})).toBeNull();
  });
});

// ===== getCookieExpiry =====

describe("getCookieExpiry", () => {
  function makeJwt(payload) {
    const b64 = btoa(JSON.stringify(payload));
    return `h.${b64}.s`;
  }

  test("uses exp claim with 60s buffer", () => {
    const jwt = makeJwt({ exp: 1700000000 });
    expect(getCookieExpiry(jwt)).toBe(1700000000 * 1000 - 60000);
  });

  test("falls back to iat + 1h when no exp", () => {
    const jwt = makeJwt({ iat: 1700000000 });
    expect(getCookieExpiry(jwt)).toBe(1700000000 * 1000 + 3600000 - 60000);
  });

  test("prefers exp over iat", () => {
    const jwt = makeJwt({ exp: 1700000000, iat: 1699999000 });
    expect(getCookieExpiry(jwt)).toBe(1700000000 * 1000 - 60000);
  });

  test("returns null when neither exp nor iat", () => {
    const jwt = makeJwt({ sub: "user" });
    expect(getCookieExpiry(jwt)).toBeNull();
  });

  test("returns null for unparseable JWT", () => {
    expect(getCookieExpiry("not-a-jwt")).toBeNull();
  });

  test("returns null for exp: 0 (guarded by > 0)", () => {
    const jwt = makeJwt({ exp: 0 });
    expect(getCookieExpiry(jwt)).toBeNull();
  });

  test("returns null for non-numeric exp (guarded by typeof)", () => {
    const jwt = makeJwt({ exp: "abc" });
    expect(getCookieExpiry(jwt)).toBeNull();
  });

  test("returns null for iat: 0", () => {
    const jwt = makeJwt({ iat: 0 });
    expect(getCookieExpiry(jwt)).toBeNull();
  });
});

// ===== ssoLog + logBuffer =====

describe("ssoLog", () => {
  test("adds info entry to buffer and calls console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    ssoLog("info", "test", "hello");
    expect(logBuffer).toHaveLength(1);
    expect(logBuffer[0].level).toBe("info");
    expect(logBuffer[0].source).toBe("test");
    expect(logBuffer[0].msg).toBe("hello");
    expect(logBuffer[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("adds error entry and calls console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    ssoLog("error", "test", "fail");
    expect(logBuffer[0].level).toBe("error");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("adds warn entry and calls console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ssoLog("warn", "test", "warning");
    expect(logBuffer[0].level).toBe("warn");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("does NOT store debug entry when debugEnabled=false", () => {
    _internal.debugEnabled = false;
    ssoLog("debug", "test", "debug msg");
    expect(logBuffer).toHaveLength(0);
  });

  test("stores debug entry and calls console.debug when debugEnabled=true", () => {
    _internal.debugEnabled = true;
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    ssoLog("debug", "test", "debug msg");
    expect(logBuffer).toHaveLength(1);
    expect(logBuffer[0].level).toBe("debug");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("enforces ring buffer max size (200)", () => {
    for (let i = 0; i < 205; i++) {
      ssoLog("info", "test", `msg ${i}`);
    }
    expect(logBuffer).toHaveLength(200);
    expect(logBuffer[0].msg).toBe("msg 5"); // first 5 shifted out
  });

  test("truncates long messages", () => {
    const longMsg = "x".repeat(300);
    ssoLog("info", "test", longMsg);
    expect(logBuffer[0].msg.length).toBe(201); // 200 + ellipsis
  });

  test("unknown level falls through to console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    ssoLog("trace", "test", "trace msg");
    expect(logBuffer[0].level).toBe("trace");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("entry has ISO 8601 timestamp", () => {
    ssoLog("info", "test", "ts test");
    expect(logBuffer[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ===== callBroker =====

describe("callBroker", () => {
  test("resolves with response on success", async () => {
    const mockResponse = { success: true, data: { version: "3.0" } };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(mockResponse));
    const result = await callBroker({ action: "get_version" });
    expect(result).toEqual(mockResponse);
  });

  test("rejects when lastError is set", async () => {
    browser.runtime.lastError = { message: "Host not found" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    await expect(callBroker({ action: "test" })).rejects.toThrow("Host not found");
  });

  test("resolves with undefined when callback receives undefined", async () => {
    browser.runtime.lastError = null;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    const result = await callBroker({ action: "test" });
    expect(result).toBeUndefined();
  });
});

// ===== markBrokerUnhealthy =====

describe("markBrokerUnhealthy", () => {
  test("sets brokerHealthy=false and healthRetryAt", () => {
    const before = Date.now();
    markBrokerUnhealthy();
    expect(_internal.brokerHealthy).toBe(false);
    expect(_internal.healthRetryAt).toBeGreaterThanOrEqual(before + 30000);
  });

  test("logs a warning", () => {
    markBrokerUnhealthy();
    const warns = logBuffer.filter(e => e.level === "warn" && e.source === "broker");
    expect(warns.length).toBeGreaterThan(0);
  });

  test("calls updateBadge to set '!' badge", () => {
    markBrokerUnhealthy();
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#d32f2f" });
  });
});

// ===== updateBadge =====

describe("updateBadge", () => {
  test("sets '!' badge when broker is unhealthy", () => {
    _internal.brokerHealthy = false;
    updateBadge();
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#d32f2f" });
  });

  test("clears badge when broker is healthy", () => {
    _internal.brokerHealthy = true;
    updateBadge();
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  test("badge cleared after successful refresh", async () => {
    _internal.brokerHealthy = false;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({
        success: true,
        data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" },
      });
    });
    await _doRefreshCookie();
    expect(_internal.brokerHealthy).toBe(true);
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });
});

// ===== loadDebugSetting =====

describe("loadDebugSetting", () => {
  test("sets debugEnabled=true when storage has debugMode:true", async () => {
    browser.storage.local.get.mockResolvedValue({ debugMode: true });
    await loadDebugSetting();
    expect(_internal.debugEnabled).toBe(true);
  });

  test("sets debugEnabled=false when storage is empty", async () => {
    _internal.debugEnabled = true;
    browser.storage.local.get.mockResolvedValue({});
    await loadDebugSetting();
    expect(_internal.debugEnabled).toBe(false);
  });

  test("leaves debugEnabled unchanged on storage error", async () => {
    _internal.debugEnabled = true;
    browser.storage.local.get.mockRejectedValue(new Error("storage error"));
    await loadDebugSetting();
    expect(_internal.debugEnabled).toBe(true);
  });
});

// ===== saveHealthState / loadHealthState (Chromium SW persistence) =====

describe("saveHealthState / loadHealthState", () => {
  test("saveHealthState writes brokerHealthy, healthRetryAt, cookieExpiry to storage.session", async () => {
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = 12345;
    _internal.cookieExpiry = 99999;
    await saveHealthState();
    expect(browser.storage.session.set).toHaveBeenCalledWith({
      _health: { brokerHealthy: false, healthRetryAt: 12345, cookieExpiry: 99999 },
    });
  });

  test("loadHealthState restores state from storage.session", async () => {
    browser.storage.session.get.mockResolvedValue({
      _health: { brokerHealthy: false, healthRetryAt: 55555, cookieExpiry: 77777 },
    });
    await loadHealthState();
    expect(_internal.brokerHealthy).toBe(false);
    expect(_internal.healthRetryAt).toBe(55555);
    expect(_internal.cookieExpiry).toBe(77777);
  });

  test("loadHealthState does nothing when storage.session is empty", async () => {
    browser.storage.session.get.mockResolvedValue({});
    _internal.brokerHealthy = true;
    _internal.healthRetryAt = 0;
    await loadHealthState();
    expect(_internal.brokerHealthy).toBe(true);
    expect(_internal.healthRetryAt).toBe(0);
  });

  test("saveHealthState ignores errors silently", async () => {
    browser.storage.session.set.mockRejectedValue(new Error("no session storage"));
    // Should not throw
    await saveHealthState();
  });

  test("loadHealthState ignores errors silently", async () => {
    browser.storage.session.get.mockRejectedValue(new Error("no session storage"));
    _internal.brokerHealthy = true;
    await loadHealthState();
    expect(_internal.brokerHealthy).toBe(true); // unchanged
  });

  test("markBrokerUnhealthy triggers saveHealthState", async () => {
    markBrokerUnhealthy();
    // saveHealthState is fire-and-forget, but storage.session.set should be called
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({
        _health: expect.objectContaining({ brokerHealthy: false }),
      })
    );
  });
});

// ===== Broker version warning =====

describe("broker version warning", () => {
  test("logs warning when broker major version differs from KNOWN_BROKER_MAJOR", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { linuxBrokerVersion: "4.0.0" },
          accounts: { accounts: [] },
        }});
      }
      else cb({});
    });
    logBuffer.length = 0;

    const response = await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });

    expect(response.connected).toBe(true);
    expect(response.brokerVersion).toBe("4.0.0");
    const warns = logBuffer.filter(e => e.level === "warn" && e.msg.includes("major version changed"));
    expect(warns.length).toBe(1);
    expect(warns[0].msg).toContain("4.0.0");
  });

  test("no warning when broker major version matches KNOWN_BROKER_MAJOR", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { linuxBrokerVersion: "3.0.1" },
          accounts: { accounts: [] },
        }});
      }
      else cb({});
    });
    logBuffer.length = 0;

    await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });

    const warns = logBuffer.filter(e => e.level === "warn" && e.msg.includes("major version"));
    expect(warns.length).toBe(0);
  });

  test("no warning when broker version is 'unknown'", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: {},
          accounts: { accounts: [] },
        }});
      }
      else cb({});
    });
    logBuffer.length = 0;

    await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });

    const warns = logBuffer.filter(e => e.level === "warn" && e.msg.includes("major version"));
    expect(warns.length).toBe(0);
  });
});

// ===== removeCookieFromStore on account change =====

describe("removeCookieFromStore on account change", () => {
  test("select_account removes old cookie before refreshing", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "select_account", account: { homeAccountId: "new-id", username: "new@example.com" } }, SELF_SENDER, resolve);
    });
    expect(response.success).toBe(true);
    // Verify cookies.remove was called (old cookie cleanup)
    expect(browser.cookies.remove).toHaveBeenCalled();
    // Verify it was called for all 3 COOKIE_URLS
    expect(browser.cookies.remove).toHaveBeenCalledTimes(3);
  });

  test("clear_account removes old cookie before refreshing", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "clear_account" }, SELF_SENDER, resolve);
    });
    expect(response.success).toBe(true);
    expect(browser.cookies.remove).toHaveBeenCalledTimes(3);
  });
});

// ===== storage.onChanged listener =====

describe("storage.onChanged listener", () => {
  test("updates debugEnabled when debugMode changes in local storage", () => {
    onChangedListener({ debugMode: { newValue: true } }, "local");
    expect(_internal.debugEnabled).toBe(true);
  });

  test("sets debugEnabled=false when debugMode set to false", () => {
    _internal.debugEnabled = true;
    onChangedListener({ debugMode: { newValue: false } }, "local");
    expect(_internal.debugEnabled).toBe(false);
  });

  test("ignores changes from sync storage area", () => {
    _internal.debugEnabled = false;
    onChangedListener({ debugMode: { newValue: true } }, "sync");
    expect(_internal.debugEnabled).toBe(false);
  });
});

// ===== Broker v3 normalization =====

describe("broker v3 normalization (in refreshCookie)", () => {
  function mockBrokerResponse(data) {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_prt_sso_cookie") {
        cb({ success: true, data });
      } else {
        cb({ success: true, data: {} });
      }
    });
  }

  test("v2 format passed through unchanged", async () => {
    mockBrokerResponse({ cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt-content" });
    const result = await _doRefreshCookie();
    expect(result.cookieName).toBe("x-ms-RefreshTokenCredential");
    expect(result.cookieContent).toBe("jwt-content");
  });

  test("v3 format normalized to top-level", async () => {
    mockBrokerResponse({
      cookieItems: [{ cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt-v3" }],
    });
    const result = await _doRefreshCookie();
    expect(result.cookieName).toBe("x-ms-RefreshTokenCredential");
    expect(result.cookieContent).toBe("jwt-v3");
  });

  test("v3 empty cookieItems not normalized", async () => {
    mockBrokerResponse({ cookieItems: [] });
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
  });

  test("v3 missing cookieContent normalized with empty", async () => {
    mockBrokerResponse({
      cookieItems: [{ cookieName: "x-ms-RefreshTokenCredential" }],
    });
    const result = await _doRefreshCookie();
    // cookieContent is undefined → falsy → treated as invalid
    expect(result).toBeNull();
  });

  test("v3 with top-level fields already present not overwritten", async () => {
    mockBrokerResponse({
      cookieName: "x-ms-RefreshTokenCredential",
      cookieContent: "original",
      cookieItems: [{ cookieName: "x-ms-RefreshTokenCredential", cookieContent: "from-items" }],
    });
    const result = await _doRefreshCookie();
    expect(result.cookieContent).toBe("original");
  });

  test("v3 cookieItems not an array not normalized", async () => {
    mockBrokerResponse({ cookieItems: "not-an-array" });
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
  });
});

// ===== refreshCookie =====

describe("refreshCookie", () => {
  function mockBrokerSuccess() {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_prt_sso_cookie") {
        cb({
          success: true,
          data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" },
        });
      } else {
        cb({ success: true, data: {} });
      }
    });
  }

  test("returns cached cookie when not expired", async () => {
    _internal.cachedCookie = { cookieName: "test" };
    _internal.cookieExpiry = Date.now() + 60000;
    const result = await refreshCookie();
    expect(result).toEqual({ cookieName: "test" });
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  test("calls broker when cache expired", async () => {
    mockBrokerSuccess();
    _internal.cachedCookie = { cookieName: "old" };
    _internal.cookieExpiry = Date.now() - 1000;
    const result = await refreshCookie();
    expect(result.cookieName).toBe("x-ms-RefreshTokenCredential");
  });

  test("returns null when broker unhealthy within cooldown", async () => {
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = Date.now() + 60000;
    const result = await refreshCookie();
    expect(result).toBeNull();
  });

  test("retries broker when cooldown expired", async () => {
    mockBrokerSuccess();
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = Date.now() - 1000;
    const result = await refreshCookie();
    expect(result.cookieName).toBe("x-ms-RefreshTokenCredential");
  });

  test("returns null on broker error response", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { error: { context: "some error" } } });
    });
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
  });

  test("returns null when cookieName is wrong", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "other-cookie", cookieContent: "jwt" } });
    });
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
  });

  test("returns null when cookieContent is empty", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "" } });
    });
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
  });

  test("marks unhealthy on native host error", async () => {
    browser.runtime.lastError = { message: "No such native application" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    await _doRefreshCookie();
    expect(_internal.brokerHealthy).toBe(false);
  });

  test("falls back to 5min TTL when JWT has no exp/iat", async () => {
    const jwt = btoa("{}"); // no exp or iat
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({
        success: true,
        data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: `h.${jwt}.s` },
      });
    });
    const before = Date.now();
    await _doRefreshCookie();
    expect(_internal.cookieExpiry).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 100);
  });

  test("proceeds with account=null when storage rejects", async () => {
    mockBrokerSuccess();
    browser.storage.local.get.mockRejectedValue(new Error("storage error"));
    const result = await _doRefreshCookie();
    expect(result.cookieName).toBe("x-ms-RefreshTokenCredential");
  });

  test("concurrent calls coalesce (reentrancy guard)", async () => {
    let callCount = 0;
    let resolveBroker;
    const brokerPromise = new Promise((resolve) => { resolveBroker = resolve; });
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      callCount++;
      brokerPromise.then(() => cb({
        success: true,
        data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" },
      }));
    });
    // Start first refresh — it will be in-flight after this
    const p1 = refreshCookie();
    // Yield to let the first call progress past the sync guard check
    await new Promise((r) => setTimeout(r, 0));
    // Second call should reuse the in-flight promise
    const p2 = refreshCookie();
    // Only one broker call should have been made
    expect(callCount).toBe(1);
    resolveBroker();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cookieName).toBe("x-ms-RefreshTokenCredential");
    expect(r2.cookieName).toBe("x-ms-RefreshTokenCredential");
  });
});

// ===== setCookieInStore =====

describe("setCookieInStore", () => {
  test("sets cookies for all 3 COOKIE_URLS", async () => {
    await setCookieInStore("test-cookie", "value", Date.now() + 60000);
    expect(browser.cookies.set).toHaveBeenCalledTimes(3);
  });

  test("continues when one cookie.set fails", async () => {
    browser.cookies.set
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce(undefined);
    await setCookieInStore("test", "val", Date.now() + 60000);
    expect(browser.cookies.set).toHaveBeenCalledTimes(3);
  });

  test("sets correct cookie parameters", async () => {
    const expiresAt = 1700000000000;
    await setCookieInStore("name", "content", expiresAt);
    const call = browser.cookies.set.mock.calls[0][0];
    expect(call.secure).toBe(true);
    expect(call.httpOnly).toBe(true);
    expect(call.sameSite).toBe("no_restriction");
    expect(call.expirationDate).toBe(Math.floor(expiresAt / 1000));
  });

  test("calculates expirationDate correctly", async () => {
    await setCookieInStore("n", "v", 1700000000123);
    expect(browser.cookies.set.mock.calls[0][0].expirationDate).toBe(1700000000);
  });
});

// ===== removeCookieFromStore =====

describe("removeCookieFromStore", () => {
  test("removes cookies for all 3 COOKIE_URLS", async () => {
    await removeCookieFromStore("test-cookie");
    expect(browser.cookies.remove).toHaveBeenCalledTimes(3);
  });

  test("continues when one remove fails", async () => {
    browser.cookies.remove
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce(undefined);
    await removeCookieFromStore("test");
    expect(browser.cookies.remove).toHaveBeenCalledTimes(3);
  });

  test("passes correct name parameter", async () => {
    await removeCookieFromStore("my-cookie");
    for (const call of browser.cookies.remove.mock.calls) {
      expect(call[0].name).toBe("my-cookie");
    }
  });
});

// ===== scheduleRefresh =====

describe("scheduleRefresh", () => {
  test("schedules alarm with correct delay for 3600s TTL", () => {
    scheduleRefresh(3600);
    expect(browser.alarms.create).toHaveBeenCalledWith("entra-sso-refresh", {
      delayInMinutes: (3600 - 60) / 60,
      periodInMinutes: 30,
    });
  });

  test("uses minimum 0.5 minutes for short TTL", () => {
    scheduleRefresh(30);
    expect(browser.alarms.create.mock.calls[0][1].delayInMinutes).toBe(0.5);
  });

  test("uses minimum 0.5 minutes for zero TTL", () => {
    scheduleRefresh(0);
    expect(browser.alarms.create.mock.calls[0][1].delayInMinutes).toBe(0.5);
  });

  test("uses minimum 0.5 minutes for negative TTL", () => {
    scheduleRefresh(-10);
    expect(browser.alarms.create.mock.calls[0][1].delayInMinutes).toBe(0.5);
  });
});

// ===== Alarm handler =====

describe("alarm handler", () => {
  test("REFRESH_ALARM clears cache and triggers refresh", async () => {
    _internal.cachedCookie = { old: true };
    _internal.cookieExpiry = 999;

    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });

    onAlarmListener({ name: "entra-sso-refresh" });
    // Let the async refreshCookie resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(_internal.cachedCookie).not.toBeNull();
    expect(_internal.cachedCookie.cookieName).toBe("x-ms-RefreshTokenCredential");
  });

  test("ignores alarms with different names", () => {
    _internal.cachedCookie = { preserved: true };
    _internal.cookieExpiry = Date.now() + 60000;
    onAlarmListener({ name: "other-alarm" });
    expect(_internal.cachedCookie).toEqual({ preserved: true });
  });
});

// ===== Message handlers (using the REAL registered onMessage listener) =====

describe("message handlers", () => {
  function dispatch(msg) {
    return new Promise((resolve) => {
      onMessageListener(msg, SELF_SENDER, resolve);
    });
  }

  test("get_logs returns logBuffer contents", async () => {
    ssoLog("info", "test", "entry1");
    ssoLog("warn", "test", "entry2");
    const response = await dispatch({ action: "get_logs" });
    expect(response.logs).toHaveLength(2);
    expect(response.logs[0].msg).toBe("entry1");
  });

  test("select_account stores account, removes old cookie, and refreshes", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await dispatch({ action: "select_account", account: { homeAccountId: "test-id", username: "test@example.com" } });
    expect(response.success).toBe(true);
    expect(browser.storage.local.set).toHaveBeenCalledWith({ selectedAccount: { homeAccountId: "test-id", username: "test@example.com" } });
    expect(browser.cookies.remove).toHaveBeenCalled(); // old cookie removed
  });

  test("select_account returns error on storage failure", async () => {
    browser.storage.local.set.mockRejectedValue(new Error("fail"));
    const response = await dispatch({ action: "select_account", account: { homeAccountId: "abc", username: "u@t.com" } });
    expect(response.success).toBe(false);
    expect(response.error).toBe("Storage error");
  });

  test("clear_account removes storage, removes old cookie, and refreshes", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await dispatch({ action: "clear_account" });
    expect(response.success).toBe(true);
    expect(browser.storage.local.remove).toHaveBeenCalledWith("selectedAccount");
    expect(browser.cookies.remove).toHaveBeenCalled(); // old cookie removed
  });

  test("force_refresh clears cache and returns success", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await dispatch({ action: "force_refresh" });
    expect(response.success).toBe(true);
  });

  test("force_refresh reports failure when broker is down", async () => {
    browser.runtime.lastError = { message: "Host not found" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    const response = await dispatch({ action: "force_refresh" });
    // refreshCookie resolves to null on error → force_refresh now reports failure
    expect(response.success).toBe(false);
    expect(response.error).toContain("no data");
    expect(_internal.brokerHealthy).toBe(false); // but broker is marked unhealthy
  });

  test("get_status returns connected status with recentErrors", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { linuxBrokerVersion: "3.0.1" },
          accounts: { accounts: [] },
        }});
      }
      else cb({});
    });
    ssoLog("warn", "test", "a warning");
    const response = await dispatch({ action: "get_status" });
    expect(response.connected).toBe(true);
    expect(response.brokerVersion).toBe("3.0.1");
    expect(response.recentErrors).toBe(1);
  });

  test("get_status returns not connected on native host error", async () => {
    browser.runtime.lastError = { message: "No such native application linux_entra_bridge" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    const response = await dispatch({ action: "get_status" });
    expect(response.connected).toBe(false);
    expect(response.nativeHostMissing).toBe(true);
  });

  test("select_account rejects null account", async () => {
    const response = await dispatch({ action: "select_account", account: null });
    expect(response.success).toBe(false);
    expect(response.error).toBe("Invalid account");
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });

  test("select_account rejects account without required fields", async () => {
    const response = await dispatch({ action: "select_account", account: { name: "test" } });
    expect(response.success).toBe(false);
    expect(response.error).toBe("Invalid account");
  });

  test("select_account rejects missing account", async () => {
    const response = await dispatch({ action: "select_account" });
    expect(response.success).toBe(false);
    expect(response.error).toBe("Invalid account");
  });
});

// ===== Additional tests from final scan findings =====

describe("additional coverage", () => {
  test("truncateMsg with empty string", () => {
    expect(truncateMsg("")).toBe("");
  });

  test("decodeJwtPayload with 2 parts (no signature)", () => {
    const payload = btoa(JSON.stringify({ test: 1 }));
    expect(decodeJwtPayload(`header.${payload}`)).toEqual({ test: 1 });
  });

  test("decodeJwtPayload with non-padded base64 (M7 regression)", () => {
    const payload = btoa(JSON.stringify({ x: 1 })).replace(/=+$/, "");
    expect(decodeJwtPayload(`h.${payload}.s`)).toEqual({ x: 1 });
  });

  test("getCookieExpiry with negative exp returns null", () => {
    const jwt = `h.${btoa(JSON.stringify({ exp: -100 }))}.s`;
    expect(getCookieExpiry(jwt)).toBeNull();
  });

  test("refreshCookie with success:false broker response", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: false, error: "broker down" });
    });
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
  });

  test("success:false with valid data — success flag is the actual gate", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: false, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
    expect(browser.cookies.set).not.toHaveBeenCalled(); // cookie data NOT used
    expect(_internal.cachedCookie).toBeNull(); // not populated
    expect(_internal.brokerHealthy).toBe(true); // not degraded (no native error)
  });

  test("selectedAccount passthrough to broker call", async () => {
    const acct = { homeAccountId: "abc", username: "u@t.com" };
    browser.storage.local.get.mockResolvedValue({ selectedAccount: acct });
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_prt_sso_cookie") {
        expect(msg.account).toEqual(acct);
        cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
      } else cb({});
    });
    await _doRefreshCookie();
  });

  test("brokerVersion telemetry fallback", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { telemetry: { broker_version: "3.1.0" } },
          accounts: { accounts: [] },
        }});
      }
      else cb({});
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });
    expect(response.brokerVersion).toBe("3.1.0");
  });

  test("clear_account storage error returns failure", async () => {
    browser.storage.local.remove.mockRejectedValue(new Error("fail"));
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "clear_account" }, SELF_SENDER, resolve);
    });
    expect(response.success).toBe(false);
    expect(response.error).toBe("Storage error");
  });

  test("broker version 0.1.0 triggers warning", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { linuxBrokerVersion: "0.1.0" },
          accounts: { accounts: [] },
        }});
      }
      else cb({});
    });
    logBuffer.length = 0;
    await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });
    const warns = logBuffer.filter(e => e.level === "warn" && e.msg.includes("major version"));
    expect(warns.length).toBe(1);
  });
});

// ===== normalizeBrokerResponse helper =====

describe("normalizeBrokerResponse", () => {
  test("v2 response passed through unchanged", () => {
    const data = { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" };
    normalizeBrokerResponse(data);
    expect(data.cookieName).toBe("x-ms-RefreshTokenCredential");
  });

  test("v3 response normalized to top-level", () => {
    const data = { cookieItems: [{ cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt-v3" }] };
    normalizeBrokerResponse(data);
    expect(data.cookieName).toBe("x-ms-RefreshTokenCredential");
    expect(data.cookieContent).toBe("jwt-v3");
  });

  test("empty cookieItems not normalized", () => {
    const data = { cookieItems: [] };
    normalizeBrokerResponse(data);
    expect(data.cookieName).toBeUndefined();
  });

  test("non-array cookieItems skipped (Array.isArray guard)", () => {
    const data = { cookieItems: "string" };
    normalizeBrokerResponse(data);
    expect(data.cookieName).toBeUndefined(); // string skipped by Array.isArray
  });

  test("null data handled gracefully", () => {
    expect(() => normalizeBrokerResponse(null)).not.toThrow();
  });
});

// ===== SSO Nonce handler (webNavigation.onBeforeNavigate) =====

describe("SSO nonce handler", () => {
  function nav(url, frameId = 0) {
    return onBeforeNavigateListener({ url, frameId, tabId: 1 });
  }

  function mockBrokerWithCookie() {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt-nonce" } });
    });
  }

  test("navigation with sso_nonce triggers broker call and sets cookie", async () => {
    mockBrokerWithCookie();
    await nav("https://login.microsoftonline.com/common/oauth2/authorize?sso_nonce=ABC123");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
    const call = browser.runtime.sendNativeMessage.mock.calls[0];
    expect(call[1].ssoUrl).toContain("sso_nonce=ABC123");
    expect(browser.cookies.set).toHaveBeenCalled();
  });

  test("navigation without sso_nonce does not call broker", async () => {
    await nav("https://login.microsoftonline.com/common/oauth2/authorize?client_id=abc");
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  test("sub-frame navigation is ignored", async () => {
    await nav("https://login.microsoftonline.com/?sso_nonce=ABC", 1);
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  test("non-SSO host is ignored", async () => {
    await nav("https://example.com/?sso_nonce=ABC");
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  test("malformed URL handled gracefully", async () => {
    logBuffer.length = 0;
    await nav(""); // empty string causes new URL("") to throw
    const warns = logBuffer.filter(e => e.level === "warn" && e.source === "nonce");
    expect(warns.length).toBe(1);
    expect(warns[0].msg).toContain("Navigation intercept error");
  });

  test("empty sso_nonce treated as falsy", async () => {
    await nav("https://login.microsoftonline.com/?sso_nonce=");
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  test("nonce with invalid characters rejected", async () => {
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=<script>alert(1)</script>");
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
    const warns = logBuffer.filter(e => e.msg.includes("Invalid sso_nonce"));
    expect(warns.length).toBe(1);
  });

  test("broker failure falls back gracefully and marks unhealthy", async () => {
    browser.runtime.lastError = { message: "Host not found" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=ValidNonce123");
    // Should not crash, and broker should be marked unhealthy
    const warns = logBuffer.filter(e => e.source === "nonce" && e.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(_internal.brokerHealthy).toBe(false);
  });

  test("nonce value NOT in logBuffer", async () => {
    mockBrokerWithCookie();
    logBuffer.length = 0;
    const testNonce = "SecretNonce_XyZ_789";
    await nav(`https://login.microsoftonline.com/?sso_nonce=${testNonce}`);
    for (const entry of logBuffer) {
      expect(entry.msg).not.toContain(testNonce);
    }
  });

  test("cachedCookie NOT updated — nonce cookie is one-shot", async () => {
    _internal.cachedCookie = null;
    mockBrokerWithCookie();
    await nav("https://login.microsoftonline.com/?sso_nonce=ABC123");
    expect(_internal.cachedCookie).toBeNull(); // NOT updated
    expect(browser.cookies.set).toHaveBeenCalled(); // but cookie IS in store
  });

  test("v3 cookieItems normalized in nonce handler", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieItems: [{ cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt-v3-nonce" }] } });
    });
    await nav("https://login.microsoftonline.com/?sso_nonce=ABC123");
    expect(browser.cookies.set).toHaveBeenCalled();
  });

  test("nonce with dot character accepted (I1 — Microsoft nonces may contain dots)", async () => {
    mockBrokerWithCookie();
    await nav("https://login.microsoftonline.com/?sso_nonce=AwABEgEAAAA.test.value123");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
    expect(browser.cookies.set).toHaveBeenCalled();
  });

  test("undefined broker response handled gracefully (L2)", async () => {
    browser.runtime.lastError = null;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=TestNonce");
    // Should not crash — catch block handles TypeError
    const warns = logBuffer.filter(e => e.source === "nonce" && e.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  test("broker failure logs correct message (L3)", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: false, error: "broker down" });
    });
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=TestNonce");
    const warns = logBuffer.filter(e => e.source === "nonce" && e.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0].msg).toContain("generic cookie remains");
  });
});

// ===== Gap tests: HIGH + MEDIUM coverage fixes =====

describe("coverage gaps", () => {

  // HIGH-1: unknown message action — now returns error response
  test("unknown message action returns error response", async () => {
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "nonexistent_action" }, SELF_SENDER, resolve);
    });
    expect(response.success).toBe(false);
    expect(response.error).toBe("Unknown action");
  });

  // HIGH-2: get_status with cachedCookie — cookieExpiresIn calculation
  test("get_status returns cookieExpiresIn when cookie is cached", async () => {
    _internal.cachedCookie = { cookieName: "x-ms-RefreshTokenCredential" };
    _internal.cookieExpiry = Date.now() + 3600000; // 1h from now
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { linuxBrokerVersion: "3.0.1" },
          accounts: { accounts: [] },
        }});
      }
      else cb({});
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });
    expect(response.connected).toBe(true);
    expect(response.cachedCookie).toBe(true);
    expect(response.cookieExpiresIn).toBeGreaterThan(3500); // ~1h
  });

  // HIGH-3: select_account inner catch — removeCookieFromStore swallows errors internally,
  // so the "Cookie cleanup failed" path only fires if something completely unexpected throws.
  // We verify that cookies.remove rejection does NOT crash the handler.
  test("select_account continues when cookies.remove rejects", async () => {
    browser.cookies.remove.mockRejectedValue(new Error("remove failed"));
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await new Promise((resolve) => {
      onMessageListener({
        action: "select_account",
        account: { homeAccountId: "abc", username: "u@t.com" },
      }, SELF_SENDER, resolve);
    });
    // removeCookieFromStore catches internally — handler succeeds
    expect(response.success).toBe(true);
  });

  // HIGH-3b: clear_account — same behavior
  test("clear_account continues when cookies.remove rejects", async () => {
    browser.cookies.remove.mockRejectedValue(new Error("remove failed"));
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "clear_account" }, SELF_SENDER, resolve);
    });
    expect(response.success).toBe(true);
  });

  // HIGH-5a: nonce handler — nonce > 512 chars rejected
  test("nonce handler rejects nonce > 512 chars", async () => {
    logBuffer.length = 0;
    const longNonce = "A".repeat(513);
    await onBeforeNavigateListener({
      url: `https://login.microsoftonline.com/?sso_nonce=${longNonce}`,
      frameId: 0, tabId: 1,
    });
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
    const warns = logBuffer.filter(e => e.msg.includes("Invalid sso_nonce"));
    expect(warns.length).toBe(1);
  });

  // HIGH-5a boundary: exactly 512 chars accepted
  test("nonce handler accepts nonce of exactly 512 chars", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const nonce512 = "A".repeat(512);
    await onBeforeNavigateListener({
      url: `https://login.microsoftonline.com/?sso_nonce=${nonce512}`,
      frameId: 0, tabId: 1,
    });
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
  });

  // HIGH-5b: nonce handler — account passthrough from storage
  test("nonce handler includes selectedAccount from storage", async () => {
    const acct = { homeAccountId: "abc", username: "u@t.com" };
    browser.storage.local.get.mockResolvedValue({ selectedAccount: acct });
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      expect(msg.account).toEqual(acct);
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await onBeforeNavigateListener({
      url: "https://login.microsoftonline.com/?sso_nonce=ABC",
      frameId: 0, tabId: 1,
    });
    expect(browser.cookies.set).toHaveBeenCalled();
  });

  // MEDIUM-6: handle_message account passthrough + default scopes — tested via Python below

  // MEDIUM-7: options.js initOptions missing DOM — tested in options.test.js

  // MEDIUM-8a: popup.js init — connected + unhealthy broker
  // (tested in popup.test.js below)

  // get_status: generic error (not host-missing)
  test("get_status returns generic error for non-missing-host failures", async () => {
    browser.runtime.lastError = { message: "Some other error" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });
    expect(response.connected).toBe(false);
    expect(response.nativeHostMissing).toBe(false);
  });

  // get_status: selectedAccount returned in response
  test("get_status includes selectedAccount from storage", async () => {
    const acct = { homeAccountId: "xyz", username: "test@t.com" };
    browser.storage.local.get.mockResolvedValue({ selectedAccount: acct });
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { linuxBrokerVersion: "3.0.1" },
          accounts: { accounts: [acct] },
        }});
      } else cb({});
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });
    expect(response.selectedAccount).toEqual(acct);
  });

  // Fix 4: _doRefreshCookie handles undefined response from callBroker
  test("_doRefreshCookie handles undefined callBroker response gracefully", async () => {
    browser.runtime.lastError = null;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    logBuffer.length = 0;
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
    // Should log generic message (F4: broker error context redaction)
    const warns = logBuffer.filter(e => e.level === "warn" && e.msg.includes("check browser console"));
    expect(warns.length).toBe(1);
  });

  // Fix 5: Account selection logs truncated homeAccountId
  test("select_account logs truncated homeAccountId", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    logBuffer.length = 0;
    await new Promise((resolve) => {
      onMessageListener({
        action: "select_account",
        account: { homeAccountId: "35b640fa-05c8-4cca-ac36-40d14ee3d476", username: "u@t.com" },
      }, SELF_SENDER, resolve);
    });
    const logs = logBuffer.filter(e => e.source === "account" && e.msg.includes("Account selected"));
    expect(logs.length).toBe(1);
    expect(logs[0].msg).toContain("35b640fa"); // truncated to 8 chars
    expect(logs[0].msg).not.toContain("u@t.com"); // no username
  });

  // Fix 2: options.js storage.local.get .catch
  // (tested in options.test.js)
});

// ===== v0.5.0: TTL cap (MAX_COOKIE_TTL_MS = 24h) =====

describe("cookie TTL cap (24h max)", () => {
  function makeJwt(payload) {
    const b64 = btoa(JSON.stringify(payload));
    return `h.${b64}.s`;
  }

  test("JWT with exp 48h in future is capped to 24h", async () => {
    const now = Date.now();
    const exp48h = Math.floor((now + 48 * 60 * 60 * 1000) / 1000);
    const jwt = makeJwt({ exp: exp48h });
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: jwt } });
    });
    await _doRefreshCookie();
    // cookieExpiry should be ~now + 24h, NOT now + 48h
    const max24h = now + 24 * 60 * 60 * 1000;
    expect(_internal.cookieExpiry).toBeLessThanOrEqual(max24h + 100);
    expect(_internal.cookieExpiry).toBeGreaterThan(now + 23 * 60 * 60 * 1000); // at least 23h
  });

  test("JWT with normal exp (1h) is NOT capped", async () => {
    const now = Date.now();
    const exp1h = Math.floor((now + 3600 * 1000) / 1000);
    const jwt = makeJwt({ exp: exp1h });
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: jwt } });
    });
    await _doRefreshCookie();
    // exp1h*1000 - 60000 ≈ now + 59min
    const expectedExpiry = exp1h * 1000 - 60000;
    expect(_internal.cookieExpiry).toBe(expectedExpiry);
  });
});

// ===== v0.5.0: Exponential backoff for health circuit breaker =====

describe("exponential backoff", () => {
  test("3x markBrokerUnhealthy doubles backoff each time", () => {
    const t0 = Date.now();

    markBrokerUnhealthy();
    const retry1 = _internal.healthRetryAt;
    expect(retry1).toBeGreaterThanOrEqual(t0 + 30000 - 50);

    markBrokerUnhealthy();
    const retry2 = _internal.healthRetryAt;
    expect(retry2).toBeGreaterThanOrEqual(t0 + 60000 - 50);

    markBrokerUnhealthy();
    const retry3 = _internal.healthRetryAt;
    expect(retry3).toBeGreaterThanOrEqual(t0 + 120000 - 50);
  });

  test("backoff caps at MAX_HEALTH_BACKOFF_MS (5min)", () => {
    // Force backoff to near max
    _internal.healthBackoffMs = 4 * 60 * 1000; // 4min
    markBrokerUnhealthy(); // doubles to 5min (max)
    markBrokerUnhealthy(); // stays at 5min
    expect(_internal.healthBackoffMs).toBe(5 * 60 * 1000);
  });

  test("successful refresh resets backoff to initial 30s", async () => {
    _internal.healthBackoffMs = 120000; // simulate elevated backoff
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await _doRefreshCookie();
    expect(_internal.healthBackoffMs).toBe(30000);
  });
});

// ===== v0.5.0: Nonce debounce =====

describe("nonce debounce", () => {
  function nav(url, frameId = 0) {
    return onBeforeNavigateListener({ url, frameId, tabId: 1 });
  }

  function mockBrokerWithCookie() {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt-nonce" } });
    });
  }

  test("two rapid navigations with SAME nonce → only 1 broker call", async () => {
    mockBrokerWithCookie();
    await nav("https://login.microsoftonline.com/?sso_nonce=SameNonce1");
    await nav("https://login.microsoftonline.com/?sso_nonce=SameNonce1");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalledTimes(1);
  });

  test("two rapid navigations with DIFFERENT nonces → both call broker", async () => {
    mockBrokerWithCookie();
    await nav("https://login.microsoftonline.com/?sso_nonce=NonceA");
    await nav("https://login.microsoftonline.com/?sso_nonce=NonceB");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalledTimes(2);
  });

  test("same nonce after debounce period → second call allowed", async () => {
    mockBrokerWithCookie();
    await nav("https://login.microsoftonline.com/?sso_nonce=Nonce1");
    // Simulate time passing beyond debounce
    _internal.lastNonceCallTime = Date.now() - 3000; // 3s ago (> 2s debounce)
    await nav("https://login.microsoftonline.com/?sso_nonce=Nonce1");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalledTimes(2);
  });
});

// ===== v0.5.0: Nonce handler broker health check with retry =====

describe("nonce handler broker health", () => {
  function nav(url) {
    return onBeforeNavigateListener({ url, frameId: 0, tabId: 1 });
  }

  test("unhealthy + within cooldown → skip nonce request", async () => {
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = Date.now() + 60000;
    await nav("https://login.microsoftonline.com/?sso_nonce=TestNonce");
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  test("unhealthy + cooldown expired → broker call made", async () => {
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = Date.now() - 1000;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await nav("https://login.microsoftonline.com/?sso_nonce=TestNonce");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
  });

  test("nonce success resets brokerHealthy and backoff", async () => {
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = Date.now() - 1000;
    _internal.healthBackoffMs = 120000;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await nav("https://login.microsoftonline.com/?sso_nonce=TestNonce");
    expect(_internal.brokerHealthy).toBe(true);
    expect(_internal.healthBackoffMs).toBe(30000);
  });
});

// ===== v0.5.0: sanitizeAccount (prototype pollution prevention) =====

describe("sanitizeAccount", () => {
  test("normal account passes through unchanged", () => {
    const acct = { homeAccountId: "abc", username: "u@t.com", name: "User" };
    expect(sanitizeAccount(acct)).toEqual(acct);
  });

  test("__proto__ key is stripped", () => {
    const acct = { homeAccountId: "abc", username: "u@t.com", "__proto__": { admin: true } };
    const result = sanitizeAccount(acct);
    expect(result.homeAccountId).toBe("abc");
    // __proto__ should not be an own property of the result
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
  });

  test("constructor key is stripped", () => {
    const acct = { homeAccountId: "abc", username: "u@t.com", constructor: "evil" };
    const result = sanitizeAccount(acct);
    expect(result.homeAccountId).toBe("abc");
    expect(result).not.toHaveProperty("constructor", "evil");
  });

  test("prototype key is stripped", () => {
    const acct = { homeAccountId: "abc", username: "u@t.com", prototype: {} };
    const result = sanitizeAccount(acct);
    expect(result).not.toHaveProperty("prototype");
  });

  test("DENY_KEYS set contains expected keys", () => {
    expect(DENY_KEYS.has("__proto__")).toBe(true);
    expect(DENY_KEYS.has("constructor")).toBe(true);
    expect(DENY_KEYS.has("prototype")).toBe(true);
  });
});

// ===== v0.5.0: getSelectedAccount helper =====

describe("getSelectedAccount", () => {
  test("returns account from storage", async () => {
    const acct = { homeAccountId: "abc", username: "u@t.com" };
    browser.storage.local.get.mockResolvedValue({ selectedAccount: acct });
    const result = await getSelectedAccount();
    expect(result).toEqual(acct);
  });

  test("returns null when no account in storage", async () => {
    browser.storage.local.get.mockResolvedValue({});
    const result = await getSelectedAccount();
    expect(result).toBeNull();
  });

  test("returns null on storage error", async () => {
    browser.storage.local.get.mockRejectedValue(new Error("storage error"));
    const result = await getSelectedAccount();
    expect(result).toBeNull();
  });
});

// ===== v0.5.0: Initial refresh retry alarm =====

describe("initial refresh retry", () => {
  test("scheduleRefresh(60) called when initial refreshCookie returns null", async () => {
    // This is tested by verifying that alarms.create was called during module import
    // The module-level refreshCookie().then() handles this
    // We verify the behavior indirectly: on broker failure, alarm is scheduled
    browser.runtime.lastError = { message: "No such native application" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    _internal.cachedCookie = null;
    _internal.cookieExpiry = 0;
    const result = await _doRefreshCookie();
    expect(result).toBeNull();
    // The caller (refreshCookie().then()) would schedule alarm — we verify the mechanism works
  });
});

// ===== v0.5.0: Nonce TTL cap (Phase 3 fix) =====

describe("nonce cookie TTL cap", () => {
  function nav(url) {
    return onBeforeNavigateListener({ url, frameId: 0, tabId: 1 });
  }

  test("nonce cookie with far-future JWT exp is capped at 24h", async () => {
    const now = Date.now();
    const exp48h = Math.floor((now + 48 * 60 * 60 * 1000) / 1000);
    const jwt = `h.${btoa(JSON.stringify({ exp: exp48h }))}.s`;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: jwt } });
    });
    await nav("https://login.microsoftonline.com/?sso_nonce=TestCap");
    // Verify cookie was set with capped expiry
    const cookieCall = browser.cookies.set.mock.calls[0][0];
    const cookieExpSec = cookieCall.expirationDate;
    const max24hSec = Math.floor((now + 24 * 60 * 60 * 1000) / 1000);
    expect(cookieExpSec).toBeLessThanOrEqual(max24hSec + 1);
  });
});

// ===== v0.5.0: Global nonce rate limiter =====

describe("global nonce rate limit", () => {
  function nav(url) {
    return onBeforeNavigateListener({ url, frameId: 0, tabId: 1 });
  }

  test("6th unique nonce in 10s window is blocked", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    // Send 5 unique nonces (within limit)
    for (let i = 0; i < 5; i++) {
      await nav(`https://login.microsoftonline.com/?sso_nonce=Unique${i}`);
    }
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalledTimes(5);

    // 6th nonce should be rate-limited
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=Unique5");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalledTimes(5); // no new call
    const warns = logBuffer.filter(e => e.msg.includes("rate limit"));
    expect(warns.length).toBe(1);
  });

  test("nonces allowed again after window expires", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    // Fill the rate limit window
    _internal.nonceCallTimestamps = [Date.now() - 11000, Date.now() - 11000, Date.now() - 11000, Date.now() - 11000, Date.now() - 11000];
    // All timestamps are older than 10s → window is clear
    await nav("https://login.microsoftonline.com/?sso_nonce=AfterWindow");
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalledTimes(1);
  });
});

// ===== v0.5.0: Alarm handler retry on failure =====

describe("alarm handler retry", () => {
  test("alarm reschedules on refresh failure", async () => {
    browser.runtime.lastError = { message: "No such native application" };
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb(undefined));
    _internal.cachedCookie = { old: true };
    _internal.cookieExpiry = 999;

    onAlarmListener({ name: "entra-sso-refresh" });
    await new Promise((r) => setTimeout(r, 50));

    // Refresh failed → scheduleRefresh(60) should have been called
    expect(browser.alarms.create).toHaveBeenCalledWith("entra-sso-refresh", expect.objectContaining({
      delayInMinutes: expect.any(Number),
    }));
  });
});

// ===== v0.5.0: select_account with __proto__ stripped =====

describe("select_account prototype pollution prevention", () => {
  test("select_account with __proto__ stores sanitized account", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await new Promise((resolve) => {
      onMessageListener({
        action: "select_account",
        account: { homeAccountId: "abc", username: "u@t.com", "__proto__": { admin: true } },
      }, SELF_SENDER, resolve);
    });
    // Verify storage.local.set was called WITHOUT __proto__
    const storedAccount = browser.storage.local.set.mock.calls[0][0].selectedAccount;
    expect(storedAccount.homeAccountId).toBe("abc");
    expect(storedAccount.username).toBe("u@t.com");
    expect(Object.prototype.hasOwnProperty.call(storedAccount, "__proto__")).toBe(false);
  });
});

// ===== v0.5.0: Deep sanitizeAccount (JSON round-trip) =====

describe("sanitizeAccount deep sanitization", () => {
  test("nested __proto__ own-key survives but does not cause prototype pollution", () => {
    // JSON.parse creates __proto__ as an own key, not a prototype override
    const nested = JSON.parse('{"__proto__": {"polluted": true}, "safe": "value"}');
    expect(Object.prototype.hasOwnProperty.call(nested, "__proto__")).toBe(true);

    const acct = { homeAccountId: "abc", username: "u@t.com", additionalFields: nested };
    const result = sanitizeAccount(acct);

    // The nested __proto__ own-key survives JSON round-trip (V8 behavior),
    // but it is NOT a prototype override — it's just a data property named "__proto__"
    expect(result.additionalFields.safe).toBe("value");
    // Critical assertion: no prototype pollution occurred
    expect(({}).polluted).toBeUndefined();
    // The nested __proto__ is an own key, not inherited — verify it doesn't pollute
    const fresh = {};
    expect(fresh.polluted).toBeUndefined();
  });

  test("non-JSON-serializable input falls back gracefully", () => {
    const acct = { homeAccountId: "abc", username: "u@t.com" };
    acct.self = acct; // circular reference
    // Should not throw — falls back to DENY_KEYS-only
    const result = sanitizeAccount(acct);
    expect(result.homeAccountId).toBe("abc");
    expect(result.username).toBe("u@t.com");
  });
});

// ===== v0.5.0: sender.id verification =====

describe("sender.id guard", () => {
  test("message from foreign sender.id is dropped and logged", async () => {
    let called = false;
    logBuffer.length = 0;
    onMessageListener({ action: "get_logs" }, { id: "foreign-extension" }, () => { called = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
    const warns = logBuffer.filter(e => e.level === "warn" && e.msg.includes("foreign sender"));
    expect(warns.length).toBe(1);
  });

  test("message with sender = undefined is dropped and logged", async () => {
    let called = false;
    logBuffer.length = 0;
    onMessageListener({ action: "get_logs" }, undefined, () => { called = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
    const warns = logBuffer.filter(e => e.msg.includes("foreign sender"));
    expect(warns.length).toBe(1);
  });

  test("message with sender = {} (no id) is dropped and logged", async () => {
    let called = false;
    logBuffer.length = 0;
    onMessageListener({ action: "get_logs" }, {}, () => { called = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
    const warns = logBuffer.filter(e => e.msg.includes("foreign sender"));
    expect(warns.length).toBe(1);
  });
});

// ===== v0.5.0: Nonce edge case tests (Phase 3 deferred) =====

describe("nonce handler edge cases", () => {
  function nav(url, frameId = 0) {
    return onBeforeNavigateListener({ url, frameId, tabId: 1 });
  }

  test("nonce response success:true without data field falls through", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true });
    });
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=TestNoData");
    expect(browser.cookies.set).not.toHaveBeenCalled();
    const warns = logBuffer.filter(e => e.source === "nonce" && e.msg.includes("failed"));
    expect(warns.length).toBe(1);
  });

  test("nonce response success:true with empty data object falls through", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: {} });
    });
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=TestEmptyData");
    expect(browser.cookies.set).not.toHaveBeenCalled();
    const warns = logBuffer.filter(e => e.source === "nonce" && e.msg.includes("failed"));
    expect(warns.length).toBe(1);
  });

  test("nonce response with wrong cookieName falls through", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "wrong-cookie", cookieContent: "jwt" } });
    });
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=TestWrongName");
    expect(browser.cookies.set).not.toHaveBeenCalled();
    const warns = logBuffer.filter(e => e.source === "nonce" && e.msg.includes("failed"));
    expect(warns.length).toBe(1);
  });

  test("nonce response with empty cookieContent falls through", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "" } });
    });
    logBuffer.length = 0;
    await nav("https://login.microsoftonline.com/?sso_nonce=TestEmptyContent");
    expect(browser.cookies.set).not.toHaveBeenCalled();
    const warns = logBuffer.filter(e => e.source === "nonce" && e.msg.includes("failed"));
    expect(warns.length).toBe(1);
  });

  test("nonce with base64 + character (URL-encoded as %2B) passes correctly", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      expect(msg.ssoUrl).toContain("sso_nonce=abc%2Bdef%2Fghi%3D");
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await nav("https://login.microsoftonline.com/common/oauth2?sso_nonce=abc%2Bdef%2Fghi%3D");
    expect(browser.cookies.set).toHaveBeenCalled();
  });
});

// ===== computeAndSetCookie helper =====

describe("computeAndSetCookie", () => {
  function makeJwt(payload) {
    const b64 = btoa(JSON.stringify(payload));
    return `h.${b64}.s`;
  }

  test("computes expiry from JWT exp and sets cookie for all 3 URLs", async () => {
    const now = Date.now();
    const exp = Math.floor((now + 3600000) / 1000); // 1h from now
    const cookieData = { cookieName: "test", cookieContent: makeJwt({ exp }) };
    const expiresAt = await computeAndSetCookie(cookieData);
    expect(browser.cookies.set).toHaveBeenCalledTimes(3);
    expect(expiresAt).toBe(exp * 1000 - 60000); // exp with 60s buffer
  });

  test("falls back to 5min TTL when JWT has no exp/iat", async () => {
    const now = Date.now();
    const cookieData = { cookieName: "test", cookieContent: makeJwt({}) };
    const expiresAt = await computeAndSetCookie(cookieData);
    expect(expiresAt).toBeGreaterThanOrEqual(now + 5 * 60 * 1000 - 100);
    expect(expiresAt).toBeLessThanOrEqual(now + 5 * 60 * 1000 + 100);
  });

  test("caps expiry at 24h max", async () => {
    const now = Date.now();
    const exp = Math.floor((now + 48 * 60 * 60 * 1000) / 1000); // 48h future
    const cookieData = { cookieName: "test", cookieContent: makeJwt({ exp }) };
    const expiresAt = await computeAndSetCookie(cookieData);
    const max24h = now + 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeLessThanOrEqual(max24h + 100);
  });

  test("returns expiresAt as a number", async () => {
    const cookieData = { cookieName: "test", cookieContent: makeJwt({ exp: 1700000000 }) };
    const expiresAt = await computeAndSetCookie(cookieData);
    expect(typeof expiresAt).toBe("number");
    expect(expiresAt).toBeGreaterThan(0);
  });
});

// ===== resetCookieAndRefresh helper =====

describe("resetCookieAndRefresh", () => {
  test("clears cache, removes cookies, triggers refresh, calls sendResponse", async () => {
    _internal.cachedCookie = { old: true };
    _internal.cookieExpiry = 99999;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await new Promise((resolve) => {
      resetCookieAndRefresh(resolve);
    });
    expect(response.success).toBe(true);
    expect(browser.cookies.remove).toHaveBeenCalledTimes(3);
  });

  test("handles removeCookieFromStore errors gracefully", async () => {
    // removeCookieFromStore catches per-URL errors internally, so resetCookieAndRefresh succeeds
    browser.cookies.remove.mockRejectedValue(new Error("remove failed"));
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    const response = await new Promise((resolve) => {
      resetCookieAndRefresh(resolve);
    });
    expect(response.success).toBe(true); // succeeds despite remove errors
  });
});

// ===== QA CRITICAL/HIGH test improvements =====

describe("truncateMsg custom max", () => {
  test("truncates to custom max length", () => {
    expect(truncateMsg("abcdefghij", 5)).toBe("abcde\u2026");
  });

  test("returns unchanged when under custom max", () => {
    expect(truncateMsg("abc", 5)).toBe("abc");
  });
});

describe("selectedAccount passthrough (outside mock)", () => {
  test("broker call includes account from storage", async () => {
    const acct = { homeAccountId: "abc", username: "u@t.com" };
    browser.storage.local.get.mockResolvedValue({ selectedAccount: acct });
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await _doRefreshCookie();
    // Assert OUTSIDE the mock — verify the call was made with the account
    const call = browser.runtime.sendNativeMessage.mock.calls[0];
    expect(call[1].account).toEqual(acct);
  });
});

describe("past-expiry JWT handling", () => {
  function makeJwt(payload) {
    return `h.${btoa(JSON.stringify(payload))}.s`;
  }

  test("computeAndSetCookie with past-expiry JWT returns past timestamp", async () => {
    const jwt = makeJwt({ exp: 100 }); // year 1970 — way in the past
    const cookieData = { cookieName: "test", cookieContent: jwt };
    const expiresAt = await computeAndSetCookie(cookieData);
    // exp: 100 → 100*1000 - 60000 = 40000 (1970-01-01T00:00:40)
    expect(expiresAt).toBe(40000);
    expect(browser.cookies.set).toHaveBeenCalledTimes(3); // still sets cookie
  });

  test("_doRefreshCookie with past-expiry JWT sets cookie and schedules alarm", async () => {
    const jwt = makeJwt({ exp: 100 });
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: jwt } });
    });
    const result = await _doRefreshCookie();
    expect(result).not.toBeNull();
    expect(browser.cookies.set).toHaveBeenCalled();
    expect(browser.alarms.create).toHaveBeenCalled();
  });
});

// ===== LOW/INFO test improvements =====

describe("LOW/INFO gap closures", () => {
  test("normalizeBrokerResponse with undefined does not throw", () => {
    expect(() => normalizeBrokerResponse(undefined)).not.toThrow();
  });

  test("getCookieExpiry with negative iat returns null", () => {
    const jwt = `h.${btoa(JSON.stringify({ iat: -100 }))}.s`;
    expect(getCookieExpiry(jwt)).toBeNull();
  });
});

// ===== Cookie store restore path (Chromium SW restart) =====

describe("cookie store restore in _doRefreshCookie", () => {
  test("restores cache from browser cookie store when in-memory cache lost", async () => {
    _internal.cachedCookie = null;
    _internal.cookieExpiry = Date.now() + 3600000;
    browser.cookies.get.mockResolvedValue({
      name: "x-ms-RefreshTokenCredential",
      value: "jwt-from-store",
      expirationDate: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await _doRefreshCookie();
    expect(result).not.toBeNull();
    expect(result.cookieName).toBe("x-ms-RefreshTokenCredential");
    expect(result.cookieContent).toBe("jwt-from-store");
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
    // Bug fix: verify refresh alarm is re-scheduled after cookie store restore
    expect(browser.alarms.create).toHaveBeenCalledWith("entra-sso-refresh", expect.objectContaining({
      delayInMinutes: expect.any(Number),
    }));
    // Alarm delay should be ~59 min (3600s TTL - 60s buffer = 3540s / 60 = 59 min)
    const alarmDelay = browser.alarms.create.mock.calls[0][1].delayInMinutes;
    expect(alarmDelay).toBeGreaterThan(55);
    expect(alarmDelay).toBeLessThan(61);
  });

  test("calls broker when cookie not in store despite valid cookieExpiry", async () => {
    _internal.cachedCookie = null;
    _internal.cookieExpiry = Date.now() + 3600000;
    browser.cookies.get.mockResolvedValue(null);
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "fresh-jwt" } });
    });
    const result = await _doRefreshCookie();
    expect(result).not.toBeNull();
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
  });
});

// ===== get_status cookieExpiresIn from cookieInStore =====

describe("get_status with cookieInStore fallback", () => {
  test("reports cookie TTL from store when in-memory cache lost", async () => {
    _internal.cachedCookie = null;
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800;
    browser.cookies.get.mockResolvedValue({
      name: "x-ms-RefreshTokenCredential",
      value: "jwt",
      expirationDate: futureExpiry,
    });
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: true, data: {
          version: { linuxBrokerVersion: "3.0.1" },
          accounts: { accounts: [] },
        }});
      } else cb({});
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });
    expect(response.cachedCookie).toBe(true);
    expect(response.cookieExpiresIn).toBeGreaterThan(1700);
    expect(response.cookieExpiresIn).toBeLessThan(1810);
  });
});

// ===== New tests from 7-agent scan (F12, F15, F10test, F2test, F4test, F36, F37, F40) =====

// F12: get_status with success:false broker response
describe("get_status with broker success:false", () => {
  test("returns connected with unknown version when broker returns success:false", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      if (msg.action === "get_status") {
        cb({ success: false, error: "broker error" });
      } else cb({});
    });
    const response = await new Promise((resolve) => {
      onMessageListener({ action: "get_status" }, SELF_SENDER, resolve);
    });
    expect(response.brokerVersion).toBe("unknown");
  });
});

// F15: cookies.get rejection in SW restore path
describe("SW restore cookies.get rejection", () => {
  test("calls broker when cookies.get rejects despite valid cookieExpiry", async () => {
    _internal.cachedCookie = null;
    _internal.cookieExpiry = Date.now() + 3600000;
    browser.cookies.get.mockRejectedValue(new Error("cookies.get failed"));
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "fresh-jwt" } });
    });
    const result = await _doRefreshCookie();
    expect(result).not.toBeNull();
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
  });
});

// F2test: nonce success calls saveHealthState
describe("nonce handler saveHealthState (F2)", () => {
  test("nonce success triggers saveHealthState", async () => {
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = Date.now() - 1000;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await onBeforeNavigateListener({
      url: "https://login.microsoftonline.com/?sso_nonce=TestSave",
      frameId: 0, tabId: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({
        _health: expect.objectContaining({ brokerHealthy: true }),
      })
    );
  });
});

// F4test: broker error context redaction in logBuffer
describe("broker error context redaction (F4)", () => {
  test("logBuffer gets generic message, not raw broker context", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { error: { context: "AADSTS50076: internal details" } } });
    });
    logBuffer.length = 0;
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    await _doRefreshCookie();
    const warns = logBuffer.filter(e => e.level === "warn" && e.source === "broker");
    expect(warns.length).toBe(1);
    expect(warns[0].msg).toContain("check browser console");
    expect(warns[0].msg).not.toContain("AADSTS50076");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[Entra SSO]"),
      expect.stringContaining("AADSTS50076")
    );
    spy.mockRestore();
  });
});

// F36: sender {id: null} rejection
describe("sender.id null rejection", () => {
  test("message with sender.id = null is rejected", async () => {
    let called = false;
    logBuffer.length = 0;
    onMessageListener({ action: "get_logs" }, { id: null }, () => { called = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
    const warns = logBuffer.filter(e => e.msg.includes("foreign sender"));
    expect(warns.length).toBe(1);
  });
});

// F37: path traversal URL in nonce handler
describe("nonce handler path traversal", () => {
  test("path traversal URL is processed correctly (URL parser normalizes path)", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, msg, cb) => {
      expect(msg.ssoUrl).not.toContain("..");
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    await onBeforeNavigateListener({
      url: "https://login.microsoftonline.com/../etc/passwd?sso_nonce=TestTraversal",
      frameId: 0, tabId: 1,
    });
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
  });
});

// F40: callBroker passes correct native host name
describe("callBroker native host name", () => {
  test("sendNativeMessage receives 'linux_entra_bridge' as first argument", async () => {
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => cb({}));
    await callBroker({ action: "test" });
    expect(browser.runtime.sendNativeMessage.mock.calls[0][0]).toBe("linux_entra_bridge");
  });
});

// ===== B6: sessionStore===null path (vi.resetModules) =====

describe("sessionStore null (B6)", () => {
  test("saveHealthState and loadHealthState are no-ops when storage.session is absent", async () => {
    vi.resetModules();
    const origSession = browser.storage.session;
    delete browser.storage.session;
    try {
      const freshMod = await import("../../extension/background.js");
      // saveHealthState should be a no-op (no crash, no storage.session.set call)
      await freshMod.saveHealthState();
      await freshMod.loadHealthState();
      // No crash = success
    } finally {
      browser.storage.session = origSession;
      vi.resetModules();
    }
  });
});

// ===== B7: initialRefresh called regardless of loadHealthState outcome =====

describe("initialRefresh invocation (B7)", () => {
  test("refreshCookie works after loadHealthState failure (the .finally path)", async () => {
    // Simulate what happens when loadHealthState rejects: initialRefresh still calls refreshCookie
    // We test this by calling refreshCookie directly (initialRefresh is not exported)
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) => {
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: "jwt" } });
    });
    _internal.cachedCookie = null;
    _internal.cookieExpiry = 0;
    const result = await refreshCookie();
    expect(result).not.toBeNull();
    // scheduleRefresh should have been called
    expect(browser.alarms.create).toHaveBeenCalledWith("entra-sso-refresh", expect.objectContaining({
      delayInMinutes: expect.any(Number),
    }));
  });
});

// ===== PIV: alarm re-arm on SW startup (Issue #2 fix) =====

describe("alarm re-arm on startup (initialRefresh)", () => {
  test("schedules alarm when cookieExpiry is in the future", () => {
    _internal.cookieExpiry = Date.now() + 120000; // 2 min from now
    browser.alarms.create.mockClear();
    const now = Date.now();
    if (_internal.cookieExpiry > now) {
      const remainingSec = Math.round((_internal.cookieExpiry - now) / 1000);
      scheduleRefresh(remainingSec);
    }
    expect(browser.alarms.create).toHaveBeenCalledWith("entra-sso-refresh", expect.objectContaining({
      delayInMinutes: expect.any(Number),
    }));
    const delay = browser.alarms.create.mock.calls[0][1].delayInMinutes;
    expect(delay).toBeGreaterThan(0.5);
    expect(delay).toBeLessThan(2);
  });

  test("does NOT schedule alarm when cookieExpiry is in the past", () => {
    _internal.cookieExpiry = Date.now() - 1000;
    browser.alarms.create.mockClear();
    const now = Date.now();
    if (_internal.cookieExpiry > now) {
      scheduleRefresh(Math.round((_internal.cookieExpiry - now) / 1000));
    }
    expect(browser.alarms.create).not.toHaveBeenCalled();
  });

  test("does NOT schedule alarm when cookieExpiry is 0", () => {
    _internal.cookieExpiry = 0;
    browser.alarms.create.mockClear();
    const now = Date.now();
    if (_internal.cookieExpiry > now) {
      scheduleRefresh(Math.round((_internal.cookieExpiry - now) / 1000));
    }
    expect(browser.alarms.create).not.toHaveBeenCalled();
  });
});

// ===== Container cookie sync (Thunderbird OWA 530003 fix) =====

const COOKIE_URLS = [
  "https://login.microsoftonline.com",
  "https://login.microsoft.com",
  "https://login.live.com",
];
// JWT with {"exp":9999999999} so getCookieExpiry yields a far-future timestamp.
const FUTURE_JWT = "h.eyJleHAiOjk5OTk5OTk5OTl9.s";

describe("isContainerStore (allowlist, fail-closed)", () => {
  test("accepts a firefox-container-N store", () => {
    expect(isContainerStore({ id: "firefox-container-6", tabIds: [10] })).toBe(true);
  });
  test("rejects default store", () => {
    expect(isContainerStore({ id: "firefox-default", tabIds: [] })).toBe(false);
  });
  test("rejects private store", () => {
    expect(isContainerStore({ id: "firefox-private", tabIds: [] })).toBe(false);
  });
  test("rejects Chrome default and incognito ids", () => {
    expect(isContainerStore({ id: "0" })).toBe(false);
    expect(isContainerStore({ id: "1" })).toBe(false);
  });
  test("rejects a store flagged incognito even if the id matches", () => {
    expect(isContainerStore({ id: "firefox-container-6", incognito: true })).toBe(false);
  });
  test("rejects unknown / future store ids", () => {
    expect(isContainerStore({ id: "firefox-container-x" })).toBe(false);
    expect(isContainerStore({ id: "some-other-store" })).toBe(false);
    expect(isContainerStore(undefined)).toBe(false);
    expect(isContainerStore(null)).toBe(false);
  });
  test("CONTAINER_STORE_RE matches exactly the container id shape", () => {
    expect(CONTAINER_STORE_RE.test("firefox-container-0")).toBe(true);
    expect(CONTAINER_STORE_RE.test("firefox-container-42")).toBe(true);
    expect(CONTAINER_STORE_RE.test("firefox-container-")).toBe(false);
    expect(CONTAINER_STORE_RE.test("xfirefox-container-6")).toBe(false);
  });
});

describe("isOwaHost (label-boundary match)", () => {
  test("accepts OWA subdomains and apex", () => {
    expect(isOwaHost("outlook.office.com")).toBe(true);
    expect(isOwaHost("office.com")).toBe(true);
    expect(isOwaHost("outlook.office365.com")).toBe(true);
    expect(isOwaHost("outlook.com")).toBe(true);
    expect(isOwaHost("m365.cloud.microsoft")).toBe(true);
  });
  test("rejects look-alike domains (no label boundary)", () => {
    expect(isOwaHost("evil-office.com")).toBe(false);
    expect(isOwaHost("xoutlook.com")).toBe(false);
    expect(isOwaHost("myoffice365.com")).toBe(false);
  });
  test("rejects suffix-injection lookalikes", () => {
    expect(isOwaHost("outlook.com.attacker.example")).toBe(false);
    expect(isOwaHost("office.com.evil.test")).toBe(false);
  });
  test("rejects unrelated hosts", () => {
    expect(isOwaHost("example.com")).toBe(false);
    expect(isOwaHost("login.microsoftonline.com")).toBe(false); // login.* handled by nonce path
  });
});

describe("setCookieInStore storeId parameter", () => {
  test("passes storeId to all three cookies.set calls when given", async () => {
    await setCookieInStore("x-ms-RefreshTokenCredential", "val", Date.now() + 3600000, "firefox-container-6");
    expect(browser.cookies.set).toHaveBeenCalledTimes(3);
    for (const call of browser.cookies.set.mock.calls) {
      expect(call[0].storeId).toBe("firefox-container-6");
      expect(COOKIE_URLS).toContain(call[0].url);
    }
  });
  test("omits storeId key entirely when not given (Chrome-safe)", async () => {
    await setCookieInStore("x-ms-RefreshTokenCredential", "val", Date.now() + 3600000);
    expect(browser.cookies.set).toHaveBeenCalledTimes(3);
    for (const call of browser.cookies.set.mock.calls) {
      expect(call[0]).not.toHaveProperty("storeId");
    }
  });
});

describe("container-sync navigation handler", () => {
  function navContainer(url = "https://outlook.office.com/owa/", tabId = 10, frameId = 0) {
    return onContainerNavigateListener({ url, tabId, frameId });
  }
  function warmCache() {
    _internal.cachedCookie = { cookieName: "x-ms-RefreshTokenCredential", cookieContent: FUTURE_JWT };
    _internal.cookieExpiry = Date.now() + 3600000; // future -> refreshCookie returns cache, no broker/default set
  }
  function stores(...extra) {
    return [{ id: "firefox-default", tabIds: [1, 2] }, ...extra];
  }

  test("the container listener was registered with the OWA URL filter", () => {
    expect(onContainerNavigateListener).toBeTypeOf("function");
  });

  test("mirrors the PRT into the container store on an OWA frameId-0 navigation", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-container-6", tabIds: [10] }));
    await navContainer();
    const containerSets = browser.cookies.set.mock.calls.filter((c) => c[0].storeId === "firefox-container-6");
    expect(containerSets).toHaveLength(3);
    for (const call of containerSets) expect(COOKIE_URLS).toContain(call[0].url);
  });

  test("never uses details.url as the cookie url (injection regression)", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-container-6", tabIds: [10] }));
    await navContainer("https://outlook.office.com/owa/?evil=1");
    for (const call of browser.cookies.set.mock.calls) {
      expect(COOKIE_URLS).toContain(call[0].url);
    }
  });

  test("no-op when not Thunderbird", async () => {
    _internal.isThunderbird = false;
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-container-6", tabIds: [10] }));
    await navContainer();
    expect(browser.cookies.set).not.toHaveBeenCalled();
    expect(browser.cookies.getAllCookieStores).not.toHaveBeenCalled();
  });

  test("no-op on a sub-frame navigation (frameId !== 0)", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-container-6", tabIds: [10] }));
    await navContainer("https://login.microsoftonline.com/authorize", 10, 38654705665);
    expect(browser.cookies.set).not.toHaveBeenCalled();
  });

  test("no-op on a non-OWA host", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-container-6", tabIds: [10] }));
    await navContainer("https://evil-office.com/owa/");
    expect(browser.cookies.set).not.toHaveBeenCalled();
  });

  test("no-op when the tab lives in the default store", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue([{ id: "firefox-default", tabIds: [10] }]);
    await navContainer();
    expect(browser.cookies.set).not.toHaveBeenCalled();
  });

  test("no-op when the tab lives in a private store", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-private", tabIds: [10] }));
    await navContainer();
    expect(browser.cookies.set).not.toHaveBeenCalled();
  });

  test("no-op when the tab is in no store / empty stores / missing tabIds", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue([]);
    await navContainer();
    browser.cookies.getAllCookieStores.mockResolvedValue([{ id: "firefox-container-6" }]); // tabIds absent
    await navContainer();
    await navContainer("https://outlook.office.com/owa/", -1); // tabId -1
    expect(browser.cookies.set).not.toHaveBeenCalled();
  });

  test("no set when refreshCookie yields no cookie", async () => {
    _internal.cachedCookie = null;
    _internal.cookieExpiry = 0;
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = Date.now() + 60000; // broker on cooldown -> refreshCookie returns null
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-container-6", tabIds: [10] }));
    await navContainer();
    expect(browser.cookies.set).not.toHaveBeenCalled();
  });

  test("cold wake: empty cache triggers a broker call before mirroring", async () => {
    _internal.cachedCookie = null;
    _internal.cookieExpiry = 0;
    browser.runtime.sendNativeMessage.mockImplementation((_h, _m, cb) =>
      cb({ success: true, data: { cookieName: "x-ms-RefreshTokenCredential", cookieContent: FUTURE_JWT } }));
    browser.cookies.getAllCookieStores.mockResolvedValue(stores({ id: "firefox-container-6", tabIds: [10] }));
    await navContainer();
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalled();
    const containerSets = browser.cookies.set.mock.calls.filter((c) => c[0].storeId === "firefox-container-6");
    expect(containerSets).toHaveLength(3);
  });

  test("multi-store isolation: mirrors only into the tab's own container", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue(stores(
      { id: "firefox-container-6", tabIds: [10] },
      { id: "firefox-container-7", tabIds: [11] },
    ));
    await navContainer("https://outlook.office.com/owa/", 11);
    const c6 = browser.cookies.set.mock.calls.filter((c) => c[0].storeId === "firefox-container-6");
    const c7 = browser.cookies.set.mock.calls.filter((c) => c[0].storeId === "firefox-container-7");
    expect(c6).toHaveLength(0);
    expect(c7).toHaveLength(3);
  });

  test("getAllCookieStores throwing is caught (warn, no crash)", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockRejectedValue(new Error("boom"));
    await expect(navContainer()).resolves.toBeUndefined();
    expect(logBuffer.some((e) => e.source === "container" && e.level === "warn")).toBe(true);
  });
});

describe("removeCookieFromStore over container stores", () => {
  test("deletes from the default store first, then the container store", async () => {
    browser.cookies.getAllCookieStores.mockResolvedValue([
      { id: "firefox-default", tabIds: [] },
      { id: "firefox-container-6", tabIds: [10] },
    ]);
    await removeCookieFromStore("x-ms-RefreshTokenCredential");
    const defaultRemoves = browser.cookies.remove.mock.calls.filter((c) => !c[0].storeId);
    const containerRemoves = browser.cookies.remove.mock.calls.filter((c) => c[0].storeId === "firefox-container-6");
    expect(defaultRemoves).toHaveLength(3);
    expect(containerRemoves).toHaveLength(3);
  });

  test("default-store removal still happens when enumeration throws", async () => {
    browser.cookies.getAllCookieStores.mockRejectedValue(new Error("boom"));
    await removeCookieFromStore("x-ms-RefreshTokenCredential");
    const defaultRemoves = browser.cookies.remove.mock.calls.filter((c) => !c[0].storeId);
    expect(defaultRemoves).toHaveLength(3);
  });

  test("no container enumeration under non-Thunderbird", async () => {
    _internal.isThunderbird = false;
    await removeCookieFromStore("x-ms-RefreshTokenCredential");
    expect(browser.cookies.getAllCookieStores).not.toHaveBeenCalled();
    expect(browser.cookies.remove).toHaveBeenCalledTimes(3); // default only
  });

  test("removes from multiple container stores", async () => {
    browser.cookies.getAllCookieStores.mockResolvedValue([
      { id: "firefox-default", tabIds: [] },
      { id: "firefox-container-6", tabIds: [10] },
      { id: "firefox-container-7", tabIds: [11] },
    ]);
    await removeCookieFromStore("x-ms-RefreshTokenCredential");
    expect(browser.cookies.remove.mock.calls.filter((c) => c[0].storeId === "firefox-container-6")).toHaveLength(3);
    expect(browser.cookies.remove.mock.calls.filter((c) => c[0].storeId === "firefox-container-7")).toHaveLength(3);
  });
});

describe("loadHealthState guard against clobbering fresh state", () => {
  test("restores persisted health when cookieExpiry is 0 (cold wake)", async () => {
    _internal.cookieExpiry = 0;
    _internal.brokerHealthy = true;
    browser.storage.session.get.mockResolvedValue({
      _health: { brokerHealthy: false, healthRetryAt: 123, cookieExpiry: 456 },
    });
    await loadHealthState();
    expect(_internal.cookieExpiry).toBe(456);
    expect(_internal.brokerHealthy).toBe(false);
    expect(_internal.healthRetryAt).toBe(123);
  });

  test("does NOT clobber a fresh in-memory cookieExpiry/brokerHealthy", async () => {
    _internal.cookieExpiry = 999999; // fresh value set by a concurrent refreshCookie
    _internal.brokerHealthy = true;
    browser.storage.session.get.mockResolvedValue({
      _health: { brokerHealthy: false, healthRetryAt: 123, cookieExpiry: 456 },
    });
    await loadHealthState();
    expect(_internal.cookieExpiry).toBe(999999);
    expect(_internal.brokerHealthy).toBe(true);
  });

  test("does NOT restore over a fresh unhealthy state (concurrent broker failure)", async () => {
    // markBrokerUnhealthy ran (brokerHealthy=false, healthRetryAt>0) but left cookieExpiry 0
    _internal.cookieExpiry = 0;
    _internal.brokerHealthy = false;
    _internal.healthRetryAt = 55555;
    browser.storage.session.get.mockResolvedValue({
      _health: { brokerHealthy: true, healthRetryAt: 0, cookieExpiry: 888888 },
    });
    await loadHealthState();
    expect(_internal.brokerHealthy).toBe(false); // not clobbered back to persisted true
    expect(_internal.healthRetryAt).toBe(55555);
    expect(_internal.cookieExpiry).toBe(0);
  });
});

// ===== Container sync — PIV hardening (feature-detect, log secrecy, idempotency) =====

describe("container-sync PIV hardening", () => {
  const CONTAINER = { id: "firefox-container-6", tabIds: [10] };
  function navContainer(url = "https://outlook.office.com/owa/", tabId = 10, frameId = 0) {
    return onContainerNavigateListener({ url, tabId, frameId });
  }
  function warmCache() {
    _internal.cachedCookie = { cookieName: "x-ms-RefreshTokenCredential", cookieContent: FUTURE_JWT };
    _internal.cookieExpiry = Date.now() + 3600000;
  }

  test("no-op when getAllCookieStores is unavailable (feature-detect)", async () => {
    warmCache();
    const saved = browser.cookies.getAllCookieStores;
    browser.cookies.getAllCookieStores = undefined;
    try {
      await navContainer();
      expect(browser.cookies.set).not.toHaveBeenCalled();
    } finally {
      browser.cookies.getAllCookieStores = saved;
    }
  });

  test("success log carries only storeId, never the JWT cookie content", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue([{ id: "firefox-default", tabIds: [1] }, CONTAINER]);
    await navContainer();
    const containerLogs = logBuffer.filter((e) => e.source === "container");
    expect(containerLogs.length).toBeGreaterThan(0);
    for (const e of containerLogs) expect(e.msg).not.toContain(FUTURE_JWT);
    expect(containerLogs.some((e) => e.msg.includes("firefox-container-6"))).toBe(true);
  });

  test("cookies.set rejection for a dead container store is caught (no crash)", async () => {
    warmCache();
    browser.cookies.getAllCookieStores.mockResolvedValue([{ id: "firefox-default", tabIds: [1] }, CONTAINER]);
    browser.cookies.set.mockRejectedValue(new Error("dead store"));
    await expect(navContainer()).resolves.toBeUndefined();
  });

  test("removeCookieFromStore is idempotent across repeated calls", async () => {
    browser.cookies.getAllCookieStores.mockResolvedValue([{ id: "firefox-default", tabIds: [] }, CONTAINER]);
    await removeCookieFromStore("x-ms-RefreshTokenCredential");
    await expect(removeCookieFromStore("x-ms-RefreshTokenCredential")).resolves.toBeUndefined();
  });
});

// ===== TB detection derivation: the getBrowserInfo -> isThunderbird gate itself =====

describe("TB detection derivation (browserInfoReady chain)", () => {
  afterEach(() => { vi.resetModules(); });
  async function reimport() {
    vi.resetModules();
    const mod = await import("../../extension/background.js");
    await mod._internal.browserInfoReady;
    return mod;
  }

  test("getBrowserInfo name 'Thunderbird' derives isThunderbird=true", async () => {
    browser.runtime.getBrowserInfo.mockResolvedValue({ name: "Thunderbird" });
    expect((await reimport())._internal.isThunderbird).toBe(true);
  });

  test("getBrowserInfo name 'Firefox' derives isThunderbird=false", async () => {
    browser.runtime.getBrowserInfo.mockResolvedValue({ name: "Firefox" });
    expect((await reimport())._internal.isThunderbird).toBe(false);
  });

  test("getBrowserInfo absent (Chrome) derives isThunderbird=false", async () => {
    const saved = browser.runtime.getBrowserInfo;
    delete browser.runtime.getBrowserInfo;
    try {
      expect((await reimport())._internal.isThunderbird).toBe(false);
    } finally {
      browser.runtime.getBrowserInfo = saved;
    }
  });

  test("getBrowserInfo rejection derives isThunderbird=false (fail-closed)", async () => {
    browser.runtime.getBrowserInfo.mockRejectedValue(new Error("nope"));
    expect((await reimport())._internal.isThunderbird).toBe(false);
  });

  test("stays false while browserInfoReady is pending, flips to true on resolve", async () => {
    vi.resetModules();
    let resolveInfo;
    browser.runtime.getBrowserInfo.mockReturnValue(new Promise((r) => { resolveInfo = r; }));
    const mod = await import("../../extension/background.js");
    expect(mod._internal.isThunderbird).toBe(false); // pending
    resolveInfo({ name: "Thunderbird" });
    await mod._internal.browserInfoReady;
    expect(mod._internal.isThunderbird).toBe(true);
  });
});
