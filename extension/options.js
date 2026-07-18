import { api, sendMsg } from "./lib.js";
export { sendMsg };

export function initOptions() {
  const debugEl = document.getElementById("debugMode");
  const complianceEl = document.getElementById("complianceMode");
  const checkBtn = document.getElementById("checkBroker");
  const statusEl = document.getElementById("status");
  const infoEl = document.getElementById("brokerInfo");
  if (!debugEl || !checkBtn || !statusEl || !infoEl) return;

  api.storage.local.get(["debugMode", "complianceEnabled"]).then((s) => {
    if (s.debugMode) debugEl.checked = true;
    if (s.complianceEnabled && complianceEl) complianceEl.checked = true;
  }).catch(() => {});

  debugEl.addEventListener("change", () => {
    api.storage.local.set({ debugMode: debugEl.checked });
  });

  if (complianceEl) {
    complianceEl.addEventListener("change", async () => {
      if (complianceEl.checked) {
        // Request optional Graph API permission
        const granted = await api.permissions?.request?.({
          origins: ["https://graph.microsoft.com/*"],
        }).catch(() => false);
        if (granted) {
          await sendMsg({ action: "enable_compliance" });
        } else {
          complianceEl.checked = false;
        }
      } else {
        await sendMsg({ action: "disable_compliance" });
      }
    });
  }

  checkBtn.addEventListener("click", async () => {
    statusEl.classList.remove("ok", "error");
    statusEl.style.display = "none";
    infoEl.style.display = "none";

    try {
      const status = await sendMsg({ action: "get_status" });
      if (!status) {
        statusEl.classList.remove("ok", "error");
        statusEl.classList.add("error");
        statusEl.textContent = "Extension not responding";
        statusEl.style.display = "block";
        return;
      }
      if (status.connected) {
        statusEl.classList.remove("ok", "error");
        statusEl.classList.add("ok");
        statusEl.textContent = `Connected — broker v${status.brokerVersion}`;
        statusEl.style.display = "block";
        // Redact PII before displaying status dump
        const safeStatus = { ...status };
        if (safeStatus.accounts) {
          safeStatus.accounts = safeStatus.accounts.map(a => ({
            homeAccountId: (a.homeAccountId || "").slice(0, 8) + "\u2026",
            username: a.username
              ? (a.username.indexOf("@") > 0 ? a.username.replace(/(.{1}).*(@.*)/, "$1***$2") : "***")
              : "",
            name: a.name ? a.name[0] + "***" : "",
          }));
        }
        if (safeStatus.selectedAccount) {
          safeStatus.selectedAccount = {
            homeAccountId: (safeStatus.selectedAccount.homeAccountId || "").slice(0, 8) + "\u2026",
          };
        }
        infoEl.textContent = JSON.stringify(safeStatus, null, 2);
        infoEl.style.display = "block";
      } else {
        statusEl.classList.remove("ok", "error");
        statusEl.classList.add("error");
        statusEl.textContent = status.error || "Not connected";
        statusEl.style.display = "block";
      }
    } catch (err) {
      statusEl.classList.remove("ok", "error");
      statusEl.classList.add("error");
      statusEl.textContent = (err.message || "Unknown error").slice(0, 200);
      statusEl.style.display = "block";
    }
  });
}
