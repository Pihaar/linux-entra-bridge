/**
 * Background script for the Linux Entra Bridge extension.
 *
 * Sets the PRT SSO cookie in the browser cookie store for Microsoft SSO domains.
 * Works on both Firefox/LibreWolf (Gecko) and Chromium-based browsers (Chrome, Brave, Vivaldi).
 *
 * No webRequest interception needed — the browser includes the cookie automatically.
 */

import { api, truncateMsg } from "./lib.js";

// --- Type Definitions ---

/** @typedef {{ homeAccountId: string, username: string, name?: string, realm?: string, environment?: string, localAccountId?: string }} Account */
/** @typedef {{ cookieName: string, cookieContent: string, cookieItems?: Array<{cookieName: string, cookieContent: string}> }} CookieData */
/** @typedef {{ success: boolean, data?: Object, error?: string }} BrokerResponse */
/** @typedef {{ ts: string, level: string, source: string, msg: string }} LogEntry */

// --- Structured Logging ---
// NOTE: In MV3 the background is non-persistent (service worker on Chromium, event
// page on Firefox/Thunderbird): it is terminated when idle and restarted on a
// registered event. The logBuffer is ephemeral and empty after each restart. This is
// acceptable; the extension is event-driven and re-derives its state on wake.

const LOG_MAX = 200;
export const logBuffer = [];

/**
 * Structured log entry. Never includes secrets.
 * Debug entries are only stored when debugEnabled.
 * @param {string} level - Log level (info, warn, error, debug)
 * @param {string} source - Source component identifier
 * @param {string} msg - Log message (will be truncated)
 */
export function ssoLog(level, source, msg) {
  const safemsg = truncateMsg(msg);
  const entry = { ts: new Date().toISOString(), level, source, msg: safemsg };
  if (level === "debug" && !_internal.debugEnabled) return;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  const prefix = `[Entra SSO] [${source}]`;
  if (level === "error") console.error(prefix, safemsg);
  else if (level === "warn") console.warn(prefix, safemsg);
  else if (level === "debug") console.debug(prefix, safemsg);
  else console.log(prefix, safemsg);
}

/**
 * Load debug setting from storage and listen for changes.
 */
export async function loadDebugSetting() {
  try {
    const s = await api.storage.local.get("debugMode");
    _internal.debugEnabled = !!s.debugMode;
  } catch { ssoLog("debug", "storage", "storage.local.get debugMode failed"); }
}
loadDebugSetting();
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.debugMode) {
    _internal.debugEnabled = !!changes.debugMode.newValue;
  }
});

// --- Constants ---

const NATIVE_HOST = "linux_entra_bridge";
const COOKIE_URLS = [
  "https://login.microsoftonline.com",
  "https://login.microsoft.com",
  "https://login.live.com",
];
export const SSO_NONCE_HOSTS = COOKIE_URLS.map(u => new URL(u).hostname);
export const SSO_NONCE_FILTER = SSO_NONCE_HOSTS.map(h => ({ hostEquals: h }));
const COOKIE_FALLBACK_TTL_MS = 5 * 60 * 1000;
const MAX_COOKIE_TTL_MS = 24 * 60 * 60 * 1000; // 24h max — defense-in-depth against forged JWTs
const HEALTH_RETRY_MS = 30 * 1000;
const MAX_HEALTH_BACKOFF_MS = 5 * 60 * 1000; // 5 min max backoff
const REFRESH_ALARM = "entra-sso-refresh";
const COMPLIANCE_ALARM = "entra-sso-compliance";
const COMPLIANCE_INTERVAL_MIN = 30; // check every 30 minutes
const COMPLIANCE_FETCH_TIMEOUT_MS = 15000; // 15s AbortController timeout
const KNOWN_BROKER_MAJOR = 3; // Tested against broker 3.0.1 (2026-04)
const NONCE_DEBOUNCE_MS = 2000; // min 2s between identical nonce broker calls
const NONCE_GLOBAL_MAX = 5; // max broker calls per NONCE_GLOBAL_WINDOW_MS
const NONCE_GLOBAL_WINDOW_MS = 10000; // 10s window for global rate limit
const PRT_COOKIE_NAME = "x-ms-RefreshTokenCredential"; // The only cookie name the broker returns

// Container cookie sync (Thunderbird OWA): OWA hosts that trigger mirroring the PRT
// into a contextual-identity store. Matched at a label boundary (leading dot or exact),
// so "evil-office.com" does NOT match "office.com".
const OWA_HOST_SUFFIXES = ["office.com", "office365.com", "outlook.com", "cloud.microsoft"];
// webNavigation URL filter for the container handler. login.* is intentionally NOT here:
// the login auth request is a sub-frame (frameId != 0) and is filtered out anyway; adding
// it would only make both onBeforeNavigate handlers fire on the same login navigation.
const OWA_URL_FILTER = [
  ...OWA_HOST_SUFFIXES.map((h) => ({ hostSuffix: "." + h })),
  ...OWA_HOST_SUFFIXES.map((h) => ({ hostEquals: h })),
];
// Container-store allowlist: only Thunderbird's OWA contextual-identity stores. Fail-closed
// — default/private/incognito and any unknown/future store id get nothing.
export const CONTAINER_STORE_RE = /^firefox-container-\d+$/;

/** True only for a Thunderbird OWA contextual-identity cookie store. */
export function isContainerStore(store) {
  return !!store && !store.incognito && CONTAINER_STORE_RE.test(store.id);
}

/** Label-boundary host match against the OWA allowlist (defense-in-depth vs. hostSuffix). */
export function isOwaHost(hostname) {
  return OWA_HOST_SUFFIXES.some((d) => hostname === d || hostname.endsWith("." + d));
}

// Internal mutable state — exported for test access via _internal.propertyName
// Properties are mutable (const ref, mutable props). _internal prefix = test-only by convention.
// WARNING: Never add background.js or lib.js to web_accessible_resources — _internal would leak to web pages.
export const _internal = {
  debugEnabled: false,
  cachedCookie: null,
  cookieExpiry: 0,
  brokerHealthy: true,
  healthRetryAt: 0,
  refreshInFlight: null,
  healthBackoffMs: HEALTH_RETRY_MS,
  lastNonceValue: null,
  lastNonceCallTime: 0,
  nonceCallTimestamps: [],
  // Device compliance (Feature 2)
  complianceEnabled: false,
  complianceState: null,
  // SPA Background SSO (Feature 3) — set of granted hostnames
  grantedSpaOrigins: new Set(),
  pendingPolicyDomains: null, // domains from managed storage awaiting user gesture
  // Container cookie sync (Thunderbird OWA): set async from runtime.getBrowserInfo()
  isThunderbird: false,
  browserInfoReady: Promise.resolve(), // replaced synchronously at module load below
};

// Thunderbird detection for the container-sync handler (TB-only). getBrowserInfo is
// Gecko-only; on Chromium it is absent -> isThunderbird stays false. The cached promise
// IS the assignment chain (awaited by the handler) and never rejects, so the TB gate is
// fail-closed and cold-wake-safe. Assignment is top-level synchronous so it completes
// before any queued webNavigation event is dispatched.
_internal.browserInfoReady = (api.runtime.getBrowserInfo
  ? api.runtime.getBrowserInfo()
  : Promise.resolve(null)
).then((info) => { _internal.isThunderbird = info?.name === "Thunderbird"; })
  .catch(() => { _internal.isThunderbird = false; });

// Chromium MV3: persist health state across service worker restarts.
// storage.session survives SW termination but not browser restart.
// Falls back gracefully on Firefox where storage.session may not exist.
const sessionStore = api.storage.session || null;
if (!sessionStore) ssoLog("debug", "init", "storage.session not available");

export async function saveHealthState() {
  if (!sessionStore) return;
  try {
    await sessionStore.set({ _health: { brokerHealthy: _internal.brokerHealthy, healthRetryAt: _internal.healthRetryAt, cookieExpiry: _internal.cookieExpiry } });
  } catch { ssoLog("debug", "storage", "storage.session.set failed"); }
}

export async function loadHealthState() {
  if (!sessionStore) return;
  try {
    const s = await sessionStore.get("_health");
    // Only restore persisted health while ALL three fields are still at their cold-wake
    // defaults (cookieExpiry 0, brokerHealthy true, healthRetryAt 0). The container-sync
    // navigation can wake the event page and run refreshCookie() concurrently with this
    // restore; guarding on the full default set avoids clobbering both a fresh SUCCESS
    // (cookieExpiry > 0) and a fresh FAILURE (markBrokerUnhealthy set brokerHealthy=false /
    // healthRetryAt>0 while cookieExpiry stayed 0).
    if (s._health && _internal.cookieExpiry === 0 && _internal.brokerHealthy && _internal.healthRetryAt === 0) {
      _internal.brokerHealthy = s._health.brokerHealthy;
      _internal.healthRetryAt = s._health.healthRetryAt;
      _internal.cookieExpiry = s._health.cookieExpiry;
    }
  } catch { ssoLog("debug", "storage", "storage.session.get failed"); }
}
// Initial: restore health state, then refresh cookie — .finally() deduplicates the two paths
function initialRefresh() {
  // Re-arm alarm immediately if cookieExpiry is in the future (belt-and-suspenders:
  // alarms usually persist across SW termination, but not across browser restart)
  const now = Date.now();
  if (_internal.cookieExpiry > now) {
    const remainingSec = Math.round((_internal.cookieExpiry - now) / 1000);
    scheduleRefresh(remainingSec);
  }
  refreshCookie().then((result) => {
    if (!result) scheduleRefresh(60); // retry in 1 minute if initial refresh fails
  }).catch(() => { scheduleRefresh(60); });
}
loadHealthState().finally(() => initialRefresh()).catch(() => {});

// Network recovery: proactively refresh cookie so it's ready before next navigation.
// Fixes race condition after Wi-Fi AP roaming (Issue #3): SW wakes on network restore
// but onBeforeNavigate fires before the broker call completes.
self.addEventListener("online", () => {
  ssoLog("info", "network", "Network restored — proactive cookie refresh");
  _internal.cachedCookie = null;
  _internal.cookieExpiry = 0;
  refreshCookie().catch(() => {});
});

// Load compliance setting from storage
api.storage.local.get("complianceEnabled").then((data) => {
  if (data.complianceEnabled) {
    _internal.complianceEnabled = true;
    api.alarms.create(COMPLIANCE_ALARM, { periodInMinutes: COMPLIANCE_INTERVAL_MIN });
    checkDeviceCompliance().catch(() => {});
  }
}).catch(() => {});

// Load granted SPA origins from permissions (Feature 3)
function rebuildSpaOrigins() {
  if (!api.permissions?.getAll) return;
  api.permissions.getAll().then((perms) => {
    _internal.grantedSpaOrigins = new Set();
    for (const origin of (perms.origins || [])) {
      try {
        const h = new URL(origin.replace("/*", "/")).hostname;
        if (!SSO_NONCE_HOSTS.includes(h)) {
          _internal.grantedSpaOrigins.add(h);
        }
      } catch { /* skip invalid */ }
    }
    if (_internal.grantedSpaOrigins.size > 0) {
      ssoLog("info", "spa", `Background SSO enabled for ${_internal.grantedSpaOrigins.size} domain(s)`);
    }
  }).catch(() => {});
}
rebuildSpaOrigins();

// Enterprise Policy: auto-grant SPA domains from managed storage (chrome.storage.managed)
// Admins deploy via Chromium policy JSON or Firefox policies.json
function validateSpaDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  if (domain.length > 253) return false;
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\.[a-z]{2,})$/i.test(domain)) return true;
  if (/^\*\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\.[a-z]{2,})$/i.test(domain)) return true;
  return false;
}

async function applyManagedSpaPolicy() {
  if (!api.storage?.managed?.get) return;
  try {
    const policy = await api.storage.managed.get("spaAllowedDomains");
    const domains = policy?.spaAllowedDomains;
    if (!Array.isArray(domains) || domains.length === 0) return;

    const validDomains = domains.filter(validateSpaDomain);
    if (validDomains.length === 0) return;

    // Store pending policy domains — permissions.request() requires user gesture,
    // so we cannot auto-grant here. The popup shows a "policy pending" banner
    // and the user clicks to apply. Alternatively, Chromium admins can use
    // ExtensionSettings policy to force-grant permissions without gesture.
    _internal.pendingPolicyDomains = validDomains;
    ssoLog("info", "policy", `Managed policy: ${validDomains.length} SPA domain(s) pending user approval`);
  } catch { /* managed storage not available (Firefox without policies.json) */ }
}
applyManagedSpaPolicy();

// Listen for permission changes (user grants/revokes via popup)
if (api.permissions?.onAdded) {
  api.permissions.onAdded.addListener(() => rebuildSpaOrigins());
}
if (api.permissions?.onRemoved) {
  api.permissions.onRemoved.addListener(() => rebuildSpaOrigins());
}

/**
 * Decode a JWT payload without verification (we only need the claims).
 * @param {string} jwt - JWT string to decode
 * @returns {Object|null} Decoded payload or null if unparseable
 */
export function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

/**
 * Determine cookie expiry from JWT claims.
 * @param {string} cookieContent - JWT cookie content string
 * @returns {number|null} Expiry timestamp in ms, or null if unparseable
 */
export function getCookieExpiry(cookieContent) {
  const payload = decodeJwtPayload(cookieContent);
  if (!payload) return null;

  if (typeof payload.exp === "number" && payload.exp > 0) {
    return payload.exp * 1000 - 60000;
  }
  if (typeof payload.iat === "number" && payload.iat > 0) {
    return payload.iat * 1000 + 3600000 - 60000;
  }
  return null;
}

/**
 * Send a message to the native messaging host.
 * @param {Object} message - Message to send to the native host
 * @returns {Promise<BrokerResponse>}
 */
export function callBroker(message) {
  return new Promise((resolve, reject) => {
    const callback = (response) => {
      const err = api.runtime.lastError;
      if (err) {
        reject(new Error(err.message || String(err)));
      } else {
        resolve(response);
      }
    };
    api.runtime.sendNativeMessage(NATIVE_HOST, message, callback);
  });
}

export function markBrokerUnhealthy() {
  _internal.brokerHealthy = false;
  _internal.healthRetryAt = Date.now() + _internal.healthBackoffMs;
  ssoLog("warn", "broker", `Marked unhealthy, retry in ${Math.round(_internal.healthBackoffMs / 1000)}s`);
  _internal.healthBackoffMs = Math.min(_internal.healthBackoffMs * 2, MAX_HEALTH_BACKOFF_MS); // double AFTER logging
  saveHealthState();
  updateBadge();
}

/**
 * Update the extension icon badge to reflect broker health.
 * Shows "!" when broker is unhealthy, clears on healthy.
 */
export function updateBadge() {
  if (!_internal.brokerHealthy) {
    api.action.setBadgeText({ text: "!" });
    api.action.setBadgeBackgroundColor({ color: "#d32f2f" });
  } else {
    api.action.setBadgeText({ text: "" });
  }
}

/**
 * Set the PRT SSO cookie in the browser's cookie store for all SSO domains.
 * @param {string} [storeId] - optional cookie-store id (Thunderbird OWA container mirror);
 *   when omitted the cookie is written to the default store.
 */
export async function setCookieInStore(cookieName, cookieContent, expiresAt, storeId) {
  const expSec = Math.floor(expiresAt / 1000);
  await Promise.all(COOKIE_URLS.map(async (url) => {
    try {
      const details = {
        url,
        name: cookieName,
        value: cookieContent,
        path: "/",
        secure: true,
        httpOnly: true, // cookie sent as HTTP header, JS on login pages doesn't need to read it
        sameSite: "no_restriction",
        expirationDate: expSec,
      };
      if (storeId) details.storeId = storeId; // omit key entirely for the default store
      await api.cookies.set(details);
    } catch (_err) {
      ssoLog("warn", "cookie", `Failed to set cookie for ${url}`);
    }
  }));
}

/**
 * Remove the PRT SSO cookie from the default cookie store, and (Thunderbird only) from any
 * OWA container store. The default-store removal always runs first and unconditionally, so
 * an account switch never leaves a stale PRT there even if container enumeration fails.
 */
export async function removeCookieFromStore(cookieName) {
  // Default store first, unconditionally — must succeed even if the enumeration below
  // throws, so an account switch never leaves a stale PRT in the default store.
  await Promise.all(COOKIE_URLS.map(async (url) => {
    try {
      await api.cookies.remove({ url, name: cookieName });
    } catch {
      // ignore — cookie may not exist
    }
  }));
  // Then the TB OWA container store(s), same gate as the mirror path (symmetry).
  await _internal.browserInfoReady;
  if (!_internal.isThunderbird || !api.cookies.getAllCookieStores) return;
  try {
    const stores = await api.cookies.getAllCookieStores();
    await Promise.all(stores.filter(isContainerStore).flatMap((store) =>
      COOKIE_URLS.map(async (url) => {
        try {
          await api.cookies.remove({ url, name: cookieName, storeId: store.id });
        } catch {
          // ignore — cookie may not exist in this store
        }
      })));
  } catch {
    ssoLog("warn", "container", "Container cookie cleanup failed");
  }
}

/**
 * Compute cookie expiry from JWT claims (with fallback + 24h cap) and set in browser cookie store.
 * @param {CookieData} cookieData - Cookie data with cookieName and cookieContent
 * @param {string} [storeId] - optional cookie-store id, passed through to setCookieInStore
 * @returns {Promise<number>} expiresAt timestamp in ms
 */
export async function computeAndSetCookie(cookieData, storeId) {
  const now = Date.now();
  const jwtExpiry = getCookieExpiry(cookieData.cookieContent);
  const expiresAt = Math.min(jwtExpiry || now + COOKIE_FALLBACK_TTL_MS, now + MAX_COOKIE_TTL_MS);
  await setCookieInStore(cookieData.cookieName, cookieData.cookieContent, expiresAt, storeId);
  return expiresAt;
}

/**
 * Refresh the PRT SSO cookie from the broker and set it in the cookie store.
 * Uses a reentrancy guard to prevent concurrent broker calls.
 * @returns {Promise<CookieData|null>}
 */
export async function refreshCookie() {
  if (_internal.refreshInFlight) return _internal.refreshInFlight;
  _internal.refreshInFlight = _doRefreshCookie();
  try { return await _internal.refreshInFlight; } finally { _internal.refreshInFlight = null; }
}

/**
 * Normalize broker v3 cookieItems[] response to top-level cookieName/cookieContent.
 * Mutates data in-place. Used by both _doRefreshCookie and the nonce handler.
 */
export function normalizeBrokerResponse(data) {
  if (data && !data.cookieName && Array.isArray(data.cookieItems) && data.cookieItems.length > 0) {
    data.cookieName = data.cookieItems[0].cookieName;
    data.cookieContent = data.cookieItems[0].cookieContent;
    ssoLog("debug", "broker", "Normalized cookieItems[] (broker v3)");
  }
}

/**
 * Load selected account from storage. Used by refresh and nonce handlers.
 */
export async function getSelectedAccount() {
  try {
    const stored = await api.storage.local.get("selectedAccount");
    return stored.selectedAccount || null;
  } catch { return null; }
}

export async function _doRefreshCookie() {
  const now = Date.now();

  if (_internal.cachedCookie && now < _internal.cookieExpiry) {
    return _internal.cachedCookie;
  }

  // Chromium SW restart: in-memory cache lost but cookie may still be in browser store
  // Check cookieExpiry (persisted in storage.session) before making an unnecessary broker call
  if (!_internal.cachedCookie && _internal.cookieExpiry > now) {
    try {
      const existing = await api.cookies.get({
        url: "https://login.microsoftonline.com",
        name: PRT_COOKIE_NAME,
      });
      if (existing) {
        _internal.cachedCookie = { cookieName: existing.name, cookieContent: existing.value };
        ssoLog("debug", "cookie", "Restored cache from browser cookie store");
        // Re-schedule refresh alarm — alarm is lost on SW restart
        const remainingSec = Math.round((_internal.cookieExpiry - now) / 1000);
        scheduleRefresh(remainingSec);
        return _internal.cachedCookie;
      }
    } catch { /* cookies.get failed — proceed with broker refresh */ }
  }

  if (!_internal.brokerHealthy && now < _internal.healthRetryAt) {
    return null;
  }

  if (!_internal.brokerHealthy) {
    ssoLog("info", "broker", "Retrying after cooldown");
  }

  try {
    const account = await getSelectedAccount();

    const msg = { action: "get_prt_sso_cookie", ssoUrl: "https://login.microsoftonline.com/" };
    if (account) msg.account = account;

    const response = await callBroker(msg);

    // Normalize broker v3 cookieItems[] format
    if (response && response.success && response.data) {
      normalizeBrokerResponse(response.data);
    }

    if (
      response &&
      response.success &&
      response.data &&
      response.data.cookieName === PRT_COOKIE_NAME &&
      response.data.cookieContent
    ) {
      // brokerHealthy reflects broker responsiveness, not cookie-store writability.
      // Set BEFORE computeAndSetCookie — if cookie store fails, the catch block
      // calls markBrokerUnhealthy. cachedCookie is set AFTER to avoid stale refs.
      _internal.brokerHealthy = true;
      _internal.healthBackoffMs = HEALTH_RETRY_MS; // reset backoff on success
      updateBadge();

      _internal.cookieExpiry = await computeAndSetCookie(response.data);
      _internal.cachedCookie = response.data; // set AFTER cookie is in browser store

      const ttlSec = Math.round((_internal.cookieExpiry - now) / 1000);
      ssoLog("info", "cookie", `Cookie set (valid for ${ttlSec}s)`);
      saveHealthState();

      // Schedule alarm for refresh before expiry
      scheduleRefresh(ttlSec);

      return _internal.cachedCookie;
    }

    const context = response?.data?.error?.context || response?.error || "no cookie";
    // broker error context may contain internal MS details — keep out of logBuffer
    ssoLog("warn", "broker", "Broker returned error (check browser console for details)");
    console.debug("[Entra SSO] [broker] Raw context:", truncateMsg(context));
    return null;
  } catch (err) {
    ssoLog("error", "native", "Host error: " + truncateMsg(err.message || String(err)));
    markBrokerUnhealthy();
    return null;
  }
}

/**
 * Schedule a cookie refresh alarm.
 * Uses BOTH a one-shot delay (precise timing) AND a periodic heartbeat
 * (survives SW termination more reliably on Chromium).
 */
export function scheduleRefresh(ttlSeconds) {
  const refreshInMinutes = Math.max(0.5, (ttlSeconds - 60) / 60);
  api.alarms.create(REFRESH_ALARM, { delayInMinutes: refreshInMinutes, periodInMinutes: 30 });
}

/**
 * Check device compliance via MS Graph API (opt-in feature).
 * Token is NEVER logged or stored — only the compliance result is cached.
 */
export async function checkDeviceCompliance() {
  if (!_internal.complianceEnabled) return;

  // Rate limit: don't check more than once per 5 minutes
  if (_internal.complianceState?.lastChecked &&
      Date.now() - _internal.complianceState.lastChecked < 5 * 60 * 1000) {
    return;
  }

  try {
    const response = await callBroker({
      action: "acquire_token",
      scopes: ["https://graph.microsoft.com/.default"],
    });
    const tokenData = response?.data?.brokerTokenResponse || response?.data;
    if (!response?.success || !tokenData?.accessToken) {
      ssoLog("warn", "compliance", "Could not acquire Graph token");
      _internal.complianceState = { error: "token_failed", lastChecked: Date.now() };
      return;
    }
    const token = tokenData.accessToken;

    const payload = decodeJwtPayload(token);
    const deviceId = payload?.deviceid;
    if (!deviceId) {
      ssoLog("info", "compliance", "Token has no deviceid claim");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMPLIANCE_FETCH_TIMEOUT_MS);

    try {
      const graphResp = await fetch(
        `https://graph.microsoft.com/v1.0/devices(deviceId='${encodeURIComponent(deviceId)}')?$select=isCompliant,displayName`,
        { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
      );
      clearTimeout(timeout);

      if (!graphResp.ok) {
        if (graphResp.status === 429) {
          ssoLog("info", "compliance", "Graph API rate limited (429), will retry later");
          _internal.complianceState = { error: "rate_limited", lastChecked: Date.now() };
        } else {
          ssoLog("warn", "compliance", `Graph API returned ${graphResp.status}`);
          _internal.complianceState = { error: "api_error", status: graphResp.status, lastChecked: Date.now() };
        }
        return;
      }

      const data = await graphResp.json();
      _internal.complianceState = {
        compliant: data.isCompliant === true,
        deviceName: truncateMsg(data.displayName || "unknown", 50),
        lastChecked: Date.now(),
      };
      ssoLog("info", "compliance", `Device: ${_internal.complianceState.deviceName} (${_internal.complianceState.compliant ? "compliant" : "non-compliant"})`);
    } catch (fetchErr) {
      clearTimeout(timeout);
      if (fetchErr.name === "AbortError") {
        ssoLog("warn", "compliance", "Graph API fetch timed out (15s)");
      } else {
        ssoLog("warn", "compliance", "Graph API fetch failed");
      }
    }
  } catch (_err) {
    ssoLog("warn", "compliance", "Compliance check failed");
  }
}

// Alarm handler — refresh cookie before expiry + compliance check
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    ssoLog("debug", "alarm", "Refresh alarm triggered");
    _internal.cachedCookie = null;
    _internal.cookieExpiry = 0;
    refreshCookie().then((result) => {
      if (!result) scheduleRefresh(60); // retry in 1 minute on failure
    }).catch(() => { scheduleRefresh(60); });
  } else if (alarm.name === COMPLIANCE_ALARM) {
    checkDeviceCompliance().catch(() => {});
  }
});

/**
 * Intercept navigations to Microsoft login pages with sso_nonce.
 * Sets a nonce-specific PRT cookie for Conditional Access flows.
 *
 * TIMING: This handler is async/non-blocking. The browser does NOT wait for it.
 * This works because Microsoft login uses a multi-redirect flow (302 chain).
 * By the time the final page checks the cookie, the broker call has completed.
 * Edge uses the same pattern (proactive + on-navigation, not blocking).
 *
 * The nonce cookie is ONE-SHOT — it is set in the cookie store but does NOT
 * update cachedCookie/cookieExpiry, so the alarm-based refresh is unaffected.
 */
api.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Sub-frame handling for SPA Background SSO
  if (details.frameId !== 0) {
    // Only proceed if sub-frame originates from a granted SPA domain
    if (!_internal.grantedSpaOrigins || _internal.grantedSpaOrigins.size === 0) return;
    const initiator = details.documentUrl || details.originUrl || "";
    if (!initiator) return;
    try {
      const initiatorHost = new URL(initiator).hostname;
      if (!_internal.grantedSpaOrigins.has(initiatorHost)) return;
    } catch { return; }
    // Fall through to nonce check below (sub-frame from granted SPA domain)
  }

  try {
    const url = new URL(details.url);
    if (!SSO_NONCE_HOSTS.includes(url.hostname)) return;

    const ssoNonce = url.searchParams.get("sso_nonce");
    if (!ssoNonce) return;

    // Validate nonce format (opaque base64/alphanumeric token, +/=. for std base64)
    if (!/^[A-Za-z0-9_\-+/=.]{1,512}$/.test(ssoNonce)) {
      ssoLog("warn", "nonce", "Invalid sso_nonce format, ignoring");
      return;
    }

    // Per-nonce debounce: skip if same nonce was just requested (last-nonce dedup)
    const now = Date.now();
    if (ssoNonce === _internal.lastNonceValue && now - _internal.lastNonceCallTime < NONCE_DEBOUNCE_MS) {
      ssoLog("debug", "nonce", "Debounced duplicate nonce request");
      return;
    }
    _internal.lastNonceValue = ssoNonce;
    _internal.lastNonceCallTime = now;

    // Global rate limit: max NONCE_GLOBAL_MAX broker calls per NONCE_GLOBAL_WINDOW_MS
    _internal.nonceCallTimestamps = _internal.nonceCallTimestamps.filter(t => now - t < NONCE_GLOBAL_WINDOW_MS);
    if (_internal.nonceCallTimestamps.length >= NONCE_GLOBAL_MAX) {
      ssoLog("warn", "nonce", "Global nonce rate limit exceeded");
      return;
    }
    _internal.nonceCallTimestamps.push(now);

    // Check broker health with retry on cooldown expiry
    if (!_internal.brokerHealthy) {
      if (now < _internal.healthRetryAt) {
        ssoLog("debug", "nonce", "Broker unhealthy, skipping nonce request");
        return;
      }
      ssoLog("info", "nonce", "Broker cooldown expired, retrying for nonce");
    }

    ssoLog("info", "nonce", "SSO nonce detected in navigation");

    // Build minimal ssoUrl: hostname + nonce only (strip path and other params)
    const ssoUrl = `https://${url.hostname}/?sso_nonce=${encodeURIComponent(ssoNonce)}`;

    const account = await getSelectedAccount();

    const msg = { action: "get_prt_sso_cookie", ssoUrl };
    if (account) msg.account = account;

    const response = await callBroker(msg);

    if (response && response.success && response.data) {
      normalizeBrokerResponse(response.data);

      if (response.data.cookieName === PRT_COOKIE_NAME &&
          response.data.cookieContent) {
        await computeAndSetCookie(response.data);
        ssoLog("info", "nonce", "Nonce-specific cookie set");
        // Nonce success proves broker is alive — reset health
        _internal.brokerHealthy = true;
        _internal.healthBackoffMs = HEALTH_RETRY_MS;
        updateBadge();
        saveHealthState();
        // NOTE: Do NOT update cachedCookie/cookieExpiry — nonce cookie is one-shot
        return;
      }
    }

    ssoLog("warn", "nonce", "Nonce cookie request failed, generic cookie remains");
  } catch (err) {
    ssoLog("warn", "nonce", "Navigation intercept error: " + truncateMsg(err.message || String(err)));
    markBrokerUnhealthy();
  }
}, { url: SSO_NONCE_FILTER });


/**
 * Container cookie sync (Thunderbird only).
 *
 * Thunderbird opens the embedded Exchange/OWA login window in its own contextual
 * identity (a cookie store like "firefox-container-6"). cookies.set() without a storeId
 * only reaches firefox-default, so the isolated OWA window never sees the PRT SSO cookie
 * and Entra reports Conditional Access 530003 (device Unregistered). This handler mirrors
 * the PRT into that container store on the OWA navigation.
 *
 * The PRT is a device-wide SSO credential, so mirroring is tightly gated:
 *  - Thunderbird only (getBrowserInfo): in Firefox, containers can be attacker-influenced
 *    (Temporary/Multi-Account Containers), so mirroring there would be a confused-deputy /
 *    isolation break. Thunderbird has no add-on API to spawn containers.
 *  - Domain gate (listener filter) + in-handler host recheck: only OWA navigations.
 *  - frameId 0: earliest container navigation, before the login sub-frame request.
 *  - Container-store allowlist (fail-closed): never default/private/incognito/unknown.
 *
 * Non-contractual assumptions (a break surfaces via the info log below, not silently):
 * TB opens OWA in a contextual identity; tabId -> store resolves via getAllCookieStores();
 * container ids match /^firefox-container-\d+$/. TB forks reporting a different runtime
 * name (e.g. Betterbird) are a no-op (fail-closed).
 *
 * No per-store debounce: the store id is only known after awaits, so a debounce could not
 * be atomic against the owa/->mail/ double navigation. The refreshCookie() reentrancy guard
 * is the real dedup (both invocations share one broker call); worst case is an idempotent
 * duplicate cookies.set.
 */
api.webNavigation.onBeforeNavigate.addListener(async (details) => {
  try {
    if (details.frameId !== 0) return;
    await _internal.browserInfoReady;
    if (!_internal.isThunderbird) return;

    // Defense-in-depth host recheck: the registration filter is not enforced when tests
    // call the listener directly, and hostSuffix lacks a label boundary. Cheap sync check
    // first, before touching the cookie-store API.
    let hostname;
    try { hostname = new URL(details.url).hostname; } catch { return; }
    if (!isOwaHost(hostname)) return;

    if (!api.cookies.getAllCookieStores) return;
    const stores = await api.cookies.getAllCookieStores();
    const store = stores.find((s) => s.tabIds?.includes(details.tabId));
    if (!isContainerStore(store)) {
      // A found-but-non-container store may mean TB changed its OWA store scheme; surface
      // it at debug level so the (non-contractual) assumption break is diagnosable, not silent.
      if (store) ssoLog("debug", "container", "Tab store is not an OWA container: " + store.id);
      return;
    }

    // refreshCookie() uses the cache + reentrancy guard and wakes the broker if needed
    // (covers the cold event-page wake). On a cache miss it also refreshes the default
    // store and reschedules the alarm — idempotent and desirable.
    const cookie = await refreshCookie();
    if (!cookie) return;

    await computeAndSetCookie(cookie, store.id);
    ssoLog("info", "container", "Mirrored PRT into store " + store.id);
  } catch (err) {
    ssoLog("warn", "container", "Container cookie sync failed: " + truncateMsg(err.message || String(err)));
  }
}, { url: OWA_URL_FILTER });


/**
 * Validate that an account object has the required fields for the broker.
 * Only checks homeAccountId and username — other fields are optional and
 * may change across broker versions.
 */
export function validateAccount(account) {
  return (
    account != null &&
    typeof account === "object" &&
    !Array.isArray(account) &&
    typeof account.homeAccountId === "string" &&
    account.homeAccountId.length > 0 &&
    typeof account.username === "string" &&
    account.username.length > 0
  );
}

/**
 * Sanitize account object to prevent prototype pollution.
 * JSON round-trip strips non-serializable values and nested __proto__ keys.
 * DENY_KEYS filter is the primary defense against top-level pollution keys
 * (constructor, prototype, __proto__). The round-trip is belt-and-suspenders
 * for nested keys that Object.entries cannot reach.
 */
export const DENY_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function sanitizeAccount(account) {
  let obj;
  try { obj = JSON.parse(JSON.stringify(account)); } catch { obj = account; }
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => !DENY_KEYS.has(k))
  );
}

/**
 * Clear cached cookie, remove from store, and trigger a refresh.
 * Shared by select_account and clear_account handlers.
 */
export async function resetCookieAndRefresh(sendResponse) {
  try {
    _internal.cachedCookie = null;
    _internal.cookieExpiry = 0;
    await removeCookieFromStore(PRT_COOKIE_NAME);
    await refreshCookie(); // await so popup sees fresh cookie on subsequent get_status
    sendResponse({ success: true });
  } catch { sendResponse({ success: false, error: "Cookie cleanup failed" }); }
}

/**
 * Handle messages from the popup and options page.
 */
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Reject messages from foreign extensions (defense-in-depth; MV3 already blocks without externally_connectable)
  if (!sender || sender.id !== api.runtime.id) {
    ssoLog("warn", "msg", "Rejected message from foreign sender");
    return;
  }

  if (message.action === "get_status") {
    (async () => {
      try {
        const [statusResp, stored] = await Promise.all([
          callBroker({ action: "get_status" }),
          api.storage.local.get("selectedAccount").catch(() => ({})),
        ]);
        // Check actual browser cookie store (survives SW restart, unlike _internal.cachedCookie)
        const cookieInStore = await api.cookies.get({
          url: "https://login.microsoftonline.com",
          name: PRT_COOKIE_NAME,
        }).catch(() => null);
        const hasCookie = !!_internal.cachedCookie || !!cookieInStore;
        const versionData = statusResp.data?.version;
        const accountsData = statusResp.data?.accounts;
        const brokerVer = versionData?.linuxBrokerVersion ||
          versionData?.telemetry?.broker_version || "unknown";
        const majorVer = parseInt(brokerVer, 10);
        if (!isNaN(majorVer) && majorVer !== KNOWN_BROKER_MAJOR) {
          ssoLog("warn", "broker", `Broker major version changed: ${brokerVer} (expected ${KNOWN_BROKER_MAJOR}.x)`);
        }
        sendResponse({
          connected: true,
          brokerHealthy: _internal.brokerHealthy,
          brokerVersion: brokerVer,
          accounts: accountsData?.accounts || [],
          selectedAccount: stored.selectedAccount || null,
          cachedCookie: hasCookie,
          cookieExpiresIn: hasCookie
            ? (_internal.cachedCookie
              ? Math.max(0, Math.round((_internal.cookieExpiry - Date.now()) / 1000))
              : (cookieInStore?.expirationDate
                ? Math.max(0, Math.round(cookieInStore.expirationDate - (Date.now() / 1000)))
                : 0))
            : 0,
          recentErrors: logBuffer.filter(e => e.level === "error" || e.level === "warn").length,
          complianceEnabled: _internal.complianceEnabled,
          complianceState: _internal.complianceState,
          pendingPolicyDomains: _internal.pendingPolicyDomains,
        });
      } catch (err) {
        const msg = err.message || String(err);
        const isHostMissing = msg.includes("No such native application") ||
          msg.includes("not found") || msg.includes("disconnected");
        sendResponse({
          connected: false,
          nativeHostMissing: isHostMissing,
          error: isHostMissing
            ? "Native messaging host not installed"
            : truncateMsg(msg),
        });
      }
    })();
    return true; // keep message channel open for async response
  }

  if (message.action === "get_logs") {
    sendResponse({ logs: [...logBuffer] });
    return true;
  }

  if (message.action === "select_account") {
    if (!validateAccount(message.account)) {
      ssoLog("warn", "account", "Invalid account rejected");
      sendResponse({ success: false, error: "Invalid account" });
      return true;
    }
    ssoLog("info", "account", "Account selected: " + truncateMsg(message.account.homeAccountId, 8));
    const safe = sanitizeAccount(message.account);
    api.storage.local.set({ selectedAccount: safe })
      .then(() => resetCookieAndRefresh(sendResponse))
      .catch(() => sendResponse({ success: false, error: "Storage error" }));
    return true;
  }

  if (message.action === "clear_account") {
    ssoLog("info", "account", "Account cleared (auto-select)");
    api.storage.local.remove("selectedAccount")
      .then(() => resetCookieAndRefresh(sendResponse))
      .catch(() => sendResponse({ success: false, error: "Storage error" }));
    return true;
  }

  if (message.action === "force_refresh") {
    ssoLog("info", "cookie", "Manual refresh triggered");
    _internal.cachedCookie = null;
    _internal.cookieExpiry = 0;
    refreshCookie()
      .then((result) => sendResponse({ success: !!result, error: result ? undefined : "Cookie refresh returned no data" }))
      .catch(() => sendResponse({ success: false, error: "Refresh failed" }));
    return true;
  }

  if (message.action === "enable_compliance") {
    _internal.complianceEnabled = true;
    api.storage.local.set({ complianceEnabled: true });
    api.alarms.create(COMPLIANCE_ALARM, { periodInMinutes: COMPLIANCE_INTERVAL_MIN });
    checkDeviceCompliance().catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "disable_compliance") {
    _internal.complianceEnabled = false;
    _internal.complianceState = null;
    api.storage.local.set({ complianceEnabled: false });
    api.alarms.clear(COMPLIANCE_ALARM);
    sendResponse({ success: true });
    return true;
  }

  // Default: respond with error for unknown actions
  sendResponse({ success: false, error: "Unknown action" });
  return true;
});

ssoLog("info", "init", "Extension loaded (cross-browser, cookies.set mode)");
