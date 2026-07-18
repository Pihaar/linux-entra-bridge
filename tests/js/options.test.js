/**
 * Tests for options.js — real behavioral tests using ES module exports.
 */

let initOptions, sendMsg;

beforeAll(async () => {
  document.body.innerHTML = `
    <input type="checkbox" id="debugMode">
    <button id="checkBroker">Check</button>
    <div id="status"></div>
    <pre id="brokerInfo" style="display:none"></pre>
  `;
  const mod = await import("../../extension/options.js");
  ({ initOptions, sendMsg } = mod);
});

beforeEach(() => {
  document.body.innerHTML = `
    <input type="checkbox" id="debugMode">
    <button id="checkBroker">Check</button>
    <div id="status"></div>
    <pre id="brokerInfo" style="display:none"></pre>
  `;
  vi.clearAllMocks();
  browser.storage.local.get.mockResolvedValue({});
  browser.storage.local.set.mockResolvedValue(undefined);
  browser.runtime.sendMessage.mockImplementation((_msg, cb) => cb && cb({}));
});

describe("initOptions", () => {
  test("loads debugMode from storage on init", async () => {
    browser.storage.local.get.mockResolvedValue({ debugMode: true });
    initOptions();
    await new Promise((r) => setTimeout(r, 10));
    expect(document.getElementById("debugMode").checked).toBe(true);
  });

  test("saves debugMode on checkbox change", () => {
    initOptions();
    const checkbox = document.getElementById("debugMode");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(browser.storage.local.set).toHaveBeenCalledWith({ debugMode: true });
  });

  test("broker check shows connected status", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({ connected: true, brokerVersion: "3.0.1" });
    });
    initOptions();
    document.getElementById("checkBroker").click();
    await new Promise((r) => setTimeout(r, 10));
    const statusEl = document.getElementById("status");
    expect(statusEl.textContent).toContain("Connected");
    expect(statusEl.textContent).toContain("3.0.1");
  });

  test("broker check shows error on failure", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({ connected: false, error: "Not connected" });
    });
    initOptions();
    document.getElementById("checkBroker").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(document.getElementById("status").textContent).toBe("Not connected");
  });

  test("broker check handles null status (SW terminated)", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => cb(undefined));
    initOptions();
    document.getElementById("checkBroker").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(document.getElementById("status").textContent).toBe("Extension not responding");
  });

  test("initOptions returns early when DOM elements missing", () => {
    document.body.innerHTML = ""; // no elements
    expect(() => initOptions()).not.toThrow();
    // No event listeners should have been attached (nothing to attach to)
    expect(browser.storage.local.get).not.toHaveBeenCalled();
  });

  test("storage.local.get rejection handled gracefully", async () => {
    browser.storage.local.get.mockRejectedValue(new Error("storage error"));
    // Should not throw — .catch() handles it
    expect(() => initOptions()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    // Checkbox stays unchecked (default)
    expect(document.getElementById("debugMode").checked).toBe(false);
  });

  test("broker check redacts PII in status dump", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true,
        brokerVersion: "3.0.1",
        accounts: [
          { homeAccountId: "35b640fa-05c8-4cca-ac36-40d14ee3d476", username: "testuser@example.com", name: "Test User" },
          { homeAccountId: "abcdef1234567890", username: "ab@example.com", name: "AB" },
        ],
        selectedAccount: { homeAccountId: "35b640fa-05c8-4cca-ac36-40d14ee3d476" },
      });
    });
    initOptions();
    document.getElementById("checkBroker").click();
    await new Promise((r) => setTimeout(r, 10));
    const infoText = document.getElementById("brokerInfo").textContent;
    // homeAccountId should be truncated to 8 chars + ellipsis
    expect(infoText).toContain("35b640fa");
    expect(infoText).not.toContain("35b640fa-05c8-4cca-ac36-40d14ee3d476");
    // username should be masked: first 1 char + *** + @domain
    expect(infoText).toContain("t***@example.com");
    expect(infoText).not.toContain("testuser@example.com");
    // second account: "ab@example.com" — now masked to "a***@example.com"
    expect(infoText).toContain("a***@example.com");
    expect(infoText).not.toContain("ab@example.com");
    // name should be redacted (F14: first char + ***)
    expect(infoText).toContain("T***");
    expect(infoText).not.toContain("Test User");
    // selectedAccount homeAccountId also truncated
    const parsed = JSON.parse(infoText);
    expect(parsed.selectedAccount.homeAccountId).toMatch(/^35b640fa/);
    expect(parsed.selectedAccount.homeAccountId.length).toBeLessThan(20);
  });

  test("broker check redacts accounts with empty/missing fields", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true,
        brokerVersion: "3.0.1",
        accounts: [
          { homeAccountId: "", username: "", name: "" },
          { homeAccountId: "short" },
        ],
        selectedAccount: null,
      });
    });
    initOptions();
    document.getElementById("checkBroker").click();
    await new Promise((r) => setTimeout(r, 10));
    const parsed = JSON.parse(document.getElementById("brokerInfo").textContent);
    // Empty homeAccountId → just ellipsis
    expect(parsed.accounts[0].homeAccountId).toMatch(/\u2026$/);
    expect(parsed.accounts[0].username).toBe("");
    // Short homeAccountId → truncated + ellipsis
    expect(parsed.accounts[1].homeAccountId).toBe("short\u2026");
    // selectedAccount null → no redaction needed
    expect(parsed.selectedAccount).toBeNull();
  });

  // F14test: PII regex edge cases
  test("broker check redacts username without @ as '***'", async () => {
    browser.runtime.sendMessage.mockImplementation((_msg, cb) => {
      cb({
        connected: true,
        brokerVersion: "3.0.1",
        accounts: [
          { homeAccountId: "abc12345", username: "localuser", name: "Local User" },
          { homeAccountId: "def12345", username: "@domain.com", name: "At User" },
        ],
        selectedAccount: null,
      });
    });
    initOptions();
    document.getElementById("checkBroker").click();
    await new Promise((r) => setTimeout(r, 10));
    const parsed = JSON.parse(document.getElementById("brokerInfo").textContent);
    // localuser (no @) → "***"
    expect(parsed.accounts[0].username).toBe("***");
    // @domain.com (@ at index 0) → "***" (indexOf > 0 fails)
    expect(parsed.accounts[1].username).toBe("***");
    // name field redacted (first char + ***)
    expect(parsed.accounts[0].name).toBe("L***");
    expect(parsed.accounts[1].name).toBe("A***");
  });
});
