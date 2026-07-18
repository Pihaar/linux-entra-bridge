/**
 * Tests for popup.js — uses real exported functions via ES module imports.
 */

let formatTime, el, row, sendMsg, init, selectAccount, clearAccount;

beforeAll(async () => {
  // Set up DOM before import (popup.js references these elements via init)
  document.body.innerHTML = `
    <div class="header">
      <img src="icons/icon-32.png" alt="" class="header-icon">
      <span class="header-title">Linux Entra Bridge</span>
    </div>
    <div id="status" class="status loading">
      <span class="status-dot"></span>
      <span>Connecting\u2026</span>
    </div>
    <button id="refresh-btn">Refresh Cookie</button>
    <div id="log-section"></div>
    <div id="details"></div>
    <div id="device-status" style="display:none"></div>
  `;
  const mod = await import("../../extension/popup.js");
  ({ formatTime, el, row, sendMsg, init, selectAccount, clearAccount } = mod);
});

// ===== formatTime (real function from popup.js) =====

describe("formatTime", () => {
  test("formats hours and minutes", () => { expect(formatTime(3700)).toBe("1h 01m"); });
  test("formats minutes and seconds", () => { expect(formatTime(90)).toBe("1m 30s"); });
  test("formats seconds only", () => { expect(formatTime(45)).toBe("45s"); });
  test("formats zero", () => { expect(formatTime(0)).toBe("0s"); });
  test("formats 24 hours", () => { expect(formatTime(86400)).toBe("24h 00m"); });
  test("formats exact hour boundary", () => { expect(formatTime(3600)).toBe("1h 00m"); });
  test("formats exact minute boundary", () => { expect(formatTime(60)).toBe("1m 00s"); });
  test("clamps negative input to 0s", () => { expect(formatTime(-1)).toBe("0s"); });
  test("clamps large negative input to 0s", () => { expect(formatTime(-9999)).toBe("0s"); });
});

// ===== el() (real function from popup.js) =====

describe("el() function", () => {
  test("creates element with tag", () => { expect(el("div").tagName).toBe("DIV"); });
  test("sets className", () => { expect(el("div", { className: "test" }).className).toBe("test"); });
  test("sets textContent", () => { expect(el("span", { textContent: "hi" }).textContent).toBe("hi"); });
  test("sets data attributes", () => { expect(el("div", { "data-id": "42" }).getAttribute("data-id")).toBe("42"); });
  test("appends string children", () => { expect(el("div", null, ["a", "b"]).textContent).toBe("ab"); });
  test("appends element children", () => {
    const child = document.createElement("span");
    expect(el("div", null, [child]).children[0]).toBe(child);
  });
  test("handles null attrs/children", () => { expect(el("div", null, null).children).toHaveLength(0); });
});

// ===== row() (real function from popup.js) =====

describe("row() function", () => {
  test("creates a row with label and value", () => {
    const r = row("Key:", "Value");
    expect(r.className).toBe("row");
    expect(r.querySelector(".label").textContent).toBe("Key:");
    expect(r.querySelector(".value").textContent).toBe("Value");
  });
});

// ===== init() integration tests =====

describe("popup init()", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="header">
        <img src="icons/icon-32.png" alt="" class="header-icon">
        <span class="header-title">Linux Entra Bridge</span>
      </div>
      <div id="status" class="status loading">
        <span class="status-dot"></span>
        <span>Connecting\u2026</span>
      </div>
      <button id="refresh-btn">Refresh Cookie</button>
      <div id="log-section"></div>
      <div id="details"></div>
      <div id="device-status" style="display:none"></div>
    `;
  });

  test("shows 'Connected' when broker is healthy", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
        accounts: [], selectedAccount: null,
        cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.getElementById("status").textContent).toBe("Connected to Identity Broker");
  });

  test("shows 'Extension not responding' when status is undefined", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => cb(undefined));
    await init();
    expect(document.getElementById("status").textContent).toBe("Extension not responding");
  });

  test("shows 'Native host not installed' when native host missing", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({ connected: false, nativeHostMissing: true, error: "Native messaging host not installed" });
    });
    await init();
    expect(document.getElementById("status").textContent).toBe("Native host not installed");
  });

  test("shows log banner when recentErrors > 0", async () => {
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 3,
        });
      } else {
        cb({});
      }
    });
    await init();
    const banner = document.querySelector(".log-banner");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("3 recent warning");
  });

  test("shows 'not cached' when no cookie", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.getElementById("details").textContent).toContain("not cached");
  });

  test("shows 'discovery pending' when 0 accounts", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.getElementById("details").textContent).toContain("discovery pending");
  });

  test("truncates error message to 200 chars", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => { throw new Error("x".repeat(300)); });
    await init();
    const details = document.getElementById("details").textContent;
    expect(details.length).toBeLessThanOrEqual(200);
  });

  test("shows 'Broker unhealthy (retrying...)' when unhealthy", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: false, brokerVersion: "3.0.1",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.getElementById("status").textContent).toBe("Broker unhealthy (retrying\u2026)");
  });

  test("shows cookie countdown when cached", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
        accounts: [], selectedAccount: null,
        cachedCookie: true, cookieExpiresIn: 3600, recentErrors: 0,
      });
    });
    await init();
    const details = document.getElementById("details").textContent;
    expect(details).toContain("cached");
    expect(details).toContain("remaining");
  });

  test("renders account list with selected account", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
        accounts: [
          { homeAccountId: "abc", name: "Test User", username: "test@example.com" },
          { homeAccountId: "def", name: "Other User", username: "other@example.com" },
        ],
        selectedAccount: { homeAccountId: "abc" },
        cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    const details = document.getElementById("details").textContent;
    expect(details).toContain("Test User");
    expect(details).toContain("Other User");
    expect(document.querySelector(".account.selected")).not.toBeNull();
    expect(document.querySelector(".clear-btn")).not.toBeNull();
  });

  test("shows 'Not connected' for non-missing-host error", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({ connected: false, nativeHostMissing: false, error: "Broker timeout" });
    });
    await init();
    expect(document.getElementById("status").textContent).toBe("Not connected");
    expect(document.getElementById("details").textContent).toContain("Broker timeout");
  });

  test("selectAccount sends select_account message", async () => {
    const calls = [];
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      calls.push(msg);
      cb({ connected: false });
    });
    await selectAccount({ homeAccountId: "abc", username: "u@t.com" });
    expect(calls[0].action).toBe("select_account");
    expect(calls[0].account.homeAccountId).toBe("abc");
  });

  test("clearAccount sends clear_account message", async () => {
    const calls = [];
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      calls.push(msg);
      cb({ connected: false });
    });
    await clearAccount();
    expect(calls[0].action).toBe("clear_account");
  });

  test("log banner click opens log panel with entries", async () => {
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 2,
        });
      } else if (msg.action === "get_logs") {
        cb({
          logs: [
            { ts: "2026-04-04T12:00:00.000Z", level: "warn", source: "broker", msg: "test warning" },
            { ts: "2026-04-04T12:01:00.000Z", level: "error", source: "native", msg: "test error" },
          ],
        });
      } else { cb({}); }
    });
    await init();
    const banner = document.querySelector(".log-banner");
    expect(banner).not.toBeNull();
    // Click to open
    banner.click();
    await new Promise((r) => setTimeout(r, 20));
    const panel = document.querySelector(".log-panel");
    expect(panel.classList.contains("visible")).toBe(true);
    expect(panel.textContent).toContain("test warning");
    expect(panel.textContent).toContain("test error");
    // Click again to close
    banner.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(panel.classList.contains("visible")).toBe(false);
  });

  test("refresh button is visible and functional when connected", async () => {
    const calls = [];
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      calls.push(msg);
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        });
      } else if (msg.action === "force_refresh") {
        cb({ success: true });
      } else {
        cb({});
      }
    });
    await init();
    const btn = document.getElementById("refresh-btn");
    expect(btn).not.toBeNull();
    expect(btn.style.display).toBe("block");
    expect(btn.textContent).toBe("Refresh Cookie");
    // Click the button
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    // Should have sent force_refresh
    expect(calls.some(c => c.action === "force_refresh")).toBe(true);
    expect(btn.textContent).toBe("Cookie refreshed!");
  });

  test("refresh button shows failure message on error", async () => {
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        });
      } else if (msg.action === "force_refresh") {
        cb({ success: false, error: "Refresh failed" });
      } else {
        cb({});
      }
    });
    await init();
    const btn = document.getElementById("refresh-btn");
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(btn.textContent).toBe("Refresh failed");
  });

  test("refresh button updates countdown after successful refresh", async () => {
    let callCount = 0;
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        callCount++;
        if (callCount === 1) {
          // Initial init() — cached cookie with 60s TTL
          cb({
            connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
            accounts: [], cachedCookie: true, cookieExpiresIn: 60, recentErrors: 0,
          });
        } else {
          // After refresh — fresh cookie with 3600s TTL
          cb({
            connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
            accounts: [], cachedCookie: true, cookieExpiresIn: 3600, recentErrors: 0,
          });
        }
      } else if (msg.action === "force_refresh") {
        cb({ success: true });
      } else {
        cb({});
      }
    });
    await init();
    const countdown = document.querySelector(".countdown");
    expect(countdown).not.toBeNull();
    expect(countdown.textContent).toContain("1m 00s");
    // Click refresh
    const btn = document.getElementById("refresh-btn");
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    // Countdown should now show the fresh TTL (~1h)
    expect(countdown.textContent).toContain("remaining");
    expect(countdown.textContent).toContain("1h 00m"); // 3600s = 1h 00m
  });

  test("refresh button hidden when not connected", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({ connected: false, nativeHostMissing: true, error: "Not installed" });
    });
    await init();
    const btn = document.getElementById("refresh-btn");
    expect(btn.style.display).not.toBe("block"); // not connected → button not shown
  });
});

// ===== Countdown timer lifecycle (fake timers) =====

describe("popup countdown timer", () => {
  function mockConnectedWithCookie(expiresIn) {
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: true, cookieExpiresIn: expiresIn, recentErrors: 0,
        });
      } else cb({});
    });
  }

  // shouldAdvanceTime: true allows Promises to resolve while still controlling setInterval
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  test("countdown decrements displayed seconds each tick", async () => {
    mockConnectedWithCookie(5);
    await init();
    const countdown = document.querySelector(".countdown");
    expect(countdown.textContent).toContain("5s");
    vi.advanceTimersByTime(1000);
    expect(countdown.textContent).toContain("4s");
    vi.advanceTimersByTime(1000);
    expect(countdown.textContent).toContain("3s");
  });

  test("countdown shows 'expired' then schedules re-poll after 2s", async () => {
    mockConnectedWithCookie(2);
    await init();
    const countdown = document.querySelector(".countdown");
    vi.advanceTimersByTime(2000);
    expect(countdown.textContent).toContain("expired");
    expect(countdown.textContent).toContain("refreshing");
    // Verify setTimeout was scheduled for re-poll (2000ms)
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  test("clearInterval stops countdown ticks after expiry (before re-poll)", async () => {
    mockConnectedWithCookie(1);
    await init();
    const countdown = document.querySelector(".countdown");
    vi.advanceTimersByTime(1000);
    const expiredText = countdown.textContent;
    // Within the 2s before re-poll, no further ticks should change the text
    vi.advanceTimersByTime(1500);
    expect(countdown.textContent).toBe(expiredText);
  });

  test("cookieExpiresIn=0 shows 'not cached' (no countdown)", async () => {
    mockConnectedWithCookie(0);
    await init();
    const details = document.getElementById("details");
    expect(details.textContent).toContain("not cached");
    expect(document.querySelector(".countdown")).toBeNull();
  });

  test("cookieExpiresIn=1 boundary — single tick to expired", async () => {
    mockConnectedWithCookie(1);
    await init();
    const countdown = document.querySelector(".countdown");
    expect(countdown.textContent).toContain("1s");
    vi.advanceTimersByTime(1000);
    expect(countdown.textContent).toContain("expired");
  });
});

// ===== New tests from 7-agent scan =====

// F13: sendMsg throw path
describe("sendMsg synchronous throw", () => {
  test("resolves with undefined when sendMessage throws synchronously", async () => {
    browser.runtime.sendMessage.mockImplementation(() => { throw new Error("sync throw"); });
    const { sendMsg: sendMsgFn } = await import("../../extension/lib.js");
    const result = await sendMsgFn({ action: "test" });
    expect(result).toBeUndefined();
  });
});

// F35: double init() timer cleanup
describe("double init() timer cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.body.innerHTML = `
      <div class="header"><img src="icons/icon-32.png" alt="" class="header-icon"><span class="header-title">Linux Entra Bridge</span></div>
      <div id="status" class="status loading"><span class="status-dot"></span><span>Connecting\u2026</span></div>
      <button id="refresh-btn">Refresh Cookie</button>
      <div id="log-section"></div>
      <div id="details"></div>
    `;
  });
  afterEach(() => { vi.useRealTimers(); });

  test("calling init() twice results in only one active countdown", async () => {
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: true, cookieExpiresIn: 60, recentErrors: 0,
        });
      } else cb({});
    });
    await init();
    // Call init again with different TTL
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: true, cookieExpiresIn: 120, recentErrors: 0,
        });
      } else cb({});
    });
    await init();
    const countdown = document.querySelector(".countdown");
    expect(countdown.textContent).toContain("2m 00s");
    vi.advanceTimersByTime(1000);
    expect(countdown.textContent).toContain("1m 59s");
  });
});

// F38: refresh button 1500ms finally
describe("refresh button text restoration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    document.body.innerHTML = `
      <div class="header"><img src="icons/icon-32.png" alt="" class="header-icon"><span class="header-title">Linux Entra Bridge</span></div>
      <div id="status" class="status loading"><span class="status-dot"></span><span>Connecting\u2026</span></div>
      <button id="refresh-btn">Refresh Cookie</button>
      <div id="log-section"></div>
      <div id="details"></div>
    `;
  });
  afterEach(() => { vi.useRealTimers(); });

  test("button text reverts to 'Refresh Cookie' after 1500ms", async () => {
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        });
      } else if (msg.action === "force_refresh") {
        cb({ success: true });
      } else cb({});
    });
    await init();
    const btn = document.getElementById("refresh-btn");
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(btn.textContent).toBe("Cookie refreshed!");
    vi.advanceTimersByTime(1500);
    expect(btn.textContent).toBe("Refresh Cookie");
    expect(btn.disabled).toBe(false);
  });
});

// F39: account keydown handler
describe("account keydown handler", () => {
  test("Enter key triggers selectAccount", async () => {
    const calls = [];
    browser.runtime.sendMessage.mockImplementation((msg, cb) => {
      calls.push(msg);
      if (msg.action === "get_status") {
        cb({
          connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
          accounts: [{ homeAccountId: "abc", name: "Test", username: "t@e.com" }],
          selectedAccount: null,
          cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        });
      } else cb({});
    });
    await init();
    const accountEl = document.querySelector(".account");
    expect(accountEl).not.toBeNull();
    accountEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some(c => c.action === "select_account")).toBe(true);
  });
});

// F10t: version display in popup header
describe("popup version display", () => {
  test("extension version is rendered in header", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.1",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    const versionEl = document.querySelector(".header-version");
    expect(versionEl).not.toBeNull();
    expect(versionEl.textContent).toBe("v0.1.0");
  });
});

// ===== Device Compliance display =====

describe("device compliance display", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="header"><img src="icons/icon-32.png" alt="" class="header-icon"><span class="header-title">Linux Entra Bridge</span></div>
      <div id="status" class="status loading"><span class="status-dot"></span><span>Connecting…</span></div>
      <button id="refresh-btn">Refresh Cookie</button>
      <div id="log-section"></div>
      <div id="details"></div>
      <div id="device-status" style="display:none"></div>
    `;
  });

  test("shows compliance status when enabled and state present", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        complianceEnabled: true,
        complianceState: { compliant: true, deviceName: "WORKSTATION01", lastChecked: Date.now() - 120000 },
      });
    });
    await init();
    const deviceEl = document.getElementById("device-status");
    expect(deviceEl.style.display).toBe("block");
    expect(deviceEl.textContent).toContain("WORKSTATION01");
    expect(deviceEl.textContent).toContain("compliant");
    expect(deviceEl.textContent).toContain("checked");
    expect(deviceEl.textContent).toContain("Informational only");
  });

  test("shows non-compliant state with red indicator class", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        complianceEnabled: true,
        complianceState: { compliant: false, deviceName: "LAPTOP02", lastChecked: Date.now() },
      });
    });
    await init();
    const deviceEl = document.getElementById("device-status");
    expect(deviceEl.querySelector(".compliance-fail")).not.toBeNull();
    expect(deviceEl.textContent).toContain("non-compliant");
  });

  test("hides compliance section when disabled", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        complianceEnabled: false,
      });
    });
    await init();
    const deviceEl = document.getElementById("device-status");
    expect(deviceEl.style.display).toBe("none");
  });
});

// ===== SPA Background SSO toggle =====

describe("SPA background SSO toggle", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="header"><img src="icons/icon-32.png" alt="" class="header-icon"><span class="header-title">Linux Entra Bridge</span></div>
      <div id="status" class="status loading"><span class="status-dot"></span><span>Connecting…</span></div>
      <button id="refresh-btn">Refresh Cookie</button>
      <div id="log-section"></div>
      <div id="details"></div>
      <div id="device-status" style="display:none"></div>
    `;
  });

  test("shows toggle for Microsoft domain tab", async () => {
    browser.tabs.query.mockResolvedValue([{ url: "https://teams.microsoft.com/app" }]);
    browser.permissions.contains.mockResolvedValue(false);
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    const spaToggle = document.querySelector(".spa-toggle");
    expect(spaToggle).not.toBeNull();
    const btn = spaToggle.querySelector(".spa-btn");
    expect(btn.textContent).toContain("Enable Background SSO");
    expect(btn.textContent).toContain("teams.microsoft.com");
  });

  test("does NOT show toggle for non-Microsoft domain", async () => {
    browser.tabs.query.mockResolvedValue([{ url: "https://example.com/page" }]);
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    const spaToggle = document.querySelector(".spa-toggle");
    expect(spaToggle).toBeNull();
  });

  test("shows 'enabled' state when permission already granted", async () => {
    browser.tabs.query.mockResolvedValue([{ url: "https://outlook.office.com/mail" }]);
    browser.permissions.contains.mockResolvedValue(true);
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    const btn = document.querySelector(".spa-btn");
    expect(btn.classList.contains("active")).toBe(true);
    expect(btn.textContent).toContain("enabled");
  });

  test("does NOT show toggle for login.microsoftonline.com (SSO host)", async () => {
    browser.tabs.query.mockResolvedValue([{ url: "https://login.microsoftonline.com/common" }]);
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.querySelector(".spa-toggle")).toBeNull();
  });
});

// ===== Edge-case tests (PIV2 qa-tester findings) =====

describe("compliance edge cases", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="header"><img src="icons/icon-32.png" alt="" class="header-icon"><span class="header-title">Linux Entra Bridge</span></div>
      <div id="status" class="status loading"><span class="status-dot"></span><span>Connecting…</span></div>
      <button id="refresh-btn">Refresh Cookie</button>
      <div id="log-section"></div>
      <div id="details"></div>
      <div id="device-status" style="display:none"></div>
    `;
  });

  test("complianceEnabled=true with complianceState=null shows Checking placeholder", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
        complianceEnabled: true, complianceState: null,
      });
    });
    await init();
    const deviceEl = document.getElementById("device-status");
    expect(deviceEl.style.display).toBe("block");
    expect(deviceEl.textContent).toContain("Checking device compliance");
  });
});

describe("SPA toggle edge cases", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="header"><img src="icons/icon-32.png" alt="" class="header-icon"><span class="header-title">Linux Entra Bridge</span></div>
      <div id="status" class="status loading"><span class="status-dot"></span><span>Connecting…</span></div>
      <button id="refresh-btn">Refresh Cookie</button>
      <div id="log-section"></div>
      <div id="details"></div>
      <div id="device-status" style="display:none"></div>
    `;
  });

  test("tab without url property does not crash", async () => {
    browser.tabs.query.mockResolvedValue([{ id: 1 }]); // no url property
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.querySelector(".spa-toggle")).toBeNull();
  });

  test("tabs.query rejection does not crash (Thunderbird)", async () => {
    browser.tabs.query.mockRejectedValue(new Error("tabs not available"));
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.querySelector(".spa-toggle")).toBeNull();
    // No crash — graceful degradation
    expect(document.getElementById("status").textContent).toBe("Connected to Identity Broker");
  });

  test("empty tabs array does not crash", async () => {
    browser.tabs.query.mockResolvedValue([]);
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true, brokerHealthy: true, brokerVersion: "3.0.2",
        accounts: [], cachedCookie: false, cookieExpiresIn: 0, recentErrors: 0,
      });
    });
    await init();
    expect(document.querySelector(".spa-toggle")).toBeNull();
  });
});
