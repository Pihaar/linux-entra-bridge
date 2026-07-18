import { api, sendMsg, truncateMsg } from "./lib.js";
export { sendMsg };

export function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") e.className = v;
      else if (k === "textContent") e.textContent = v;
      else e.setAttribute(k, v);
    }
  }
  if (children) {
    for (const c of children) {
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return e;
}

export function row(label, value) {
  return el("div", { className: "row" }, [
    el("span", { className: "label", textContent: label }),
    document.createTextNode(" "),
    el("span", { className: "value", textContent: value }),
  ]);
}

export async function selectAccount(account) {
  await sendMsg({ action: "select_account", account });
  await init();
}

export async function clearAccount() {
  await sendMsg({ action: "clear_account" });
  await init();
}

let countdownTimer = null;

export function formatTime(seconds) {
  seconds = Math.max(0, seconds);
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h + "h " + String(m).padStart(2, "0") + "m";
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + "m " + String(s).padStart(2, "0") + "s";
  }
  return seconds + "s";
}

/**
 * Start (or restart) the cookie countdown timer on a DOM element.
 * Clears any previous timer. Updates the element's textContent every second.
 * @param {HTMLElement} element - The DOM element to update
 * @param {number} seconds - Initial seconds remaining
 */
function startCountdown(element, seconds) {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  let remaining = seconds;
  element.textContent = "cached (" + formatTime(remaining) + " remaining)";
  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      element.textContent = "expired \u2014 refreshing\u2026";
      clearInterval(countdownTimer);
      countdownTimer = null;
      // Background alarm fires 60s before expiry, so the fresh cookie
      // is almost certainly ready by now. Re-poll after a short delay.
      // Only re-poll if log panel is NOT open (avoid disrupting user interaction).
      setTimeout(() => {
        const openPanel = document.querySelector(".log-panel.visible");
        if (openPanel) {
          element.textContent = "expired \u2014 click Refresh Cookie";
          return;
        }
        init().catch(() => {}).then(() => {
          // If still no cookie after re-poll, retry once more after 5s
          if (!document.querySelector(".countdown")) {
            setTimeout(() => init().catch(() => {}), 5000);
          }
        });
      }, 2000);
      return;
    }
    element.textContent = "cached (" + formatTime(remaining) + " remaining)";
  }, 1000);
}

export async function init() {
  if (countdownTimer) clearInterval(countdownTimer);

  const statusEl = document.getElementById("status");
  const detailsEl = document.getElementById("details");
  const logSection = document.getElementById("log-section");
  detailsEl.replaceChildren();
  logSection.replaceChildren();

  try {
    const status = await sendMsg({ action: "get_status" });

    // Guard against undefined status (e.g., Chromium service worker terminated)
    if (!status) {
      statusEl.className = "status error";
      statusEl.replaceChildren(el("span", { className: "status-dot" }), el("span", { textContent: "Extension not responding" }));
      return;
    }

    // Show log banner if errors/warnings exist
    if (status.recentErrors > 0) {
      const banner = el("button", { className: "log-banner has-errors" }, [
        `${status.recentErrors} recent warning(s) \u2014 click to view`
      ]);
      const panel = el("div", { className: "log-panel" });

      banner.addEventListener("click", async () => {
        if (panel.classList.contains("visible")) {
          panel.classList.remove("visible");
          return;
        }
        const resp = await sendMsg({ action: "get_logs" });
        panel.replaceChildren();
        if (resp && resp.logs) {
          for (const entry of resp.logs) {
            const time = (entry.ts || "").substring(11, 19);
            panel.appendChild(el("div", {
              className: "log-entry " + (entry.level || "info"),
              textContent: `${time} [${entry.level}] ${entry.source}: ${entry.msg}`,
            }));
          }
        }
        panel.classList.add("visible");
        panel.scrollTop = panel.scrollHeight;
      });

      logSection.appendChild(banner);
      logSection.appendChild(panel);
    }

    if (status.connected) {
      statusEl.className = "status ok";
      statusEl.replaceChildren(
        el("span", { className: "status-dot" }),
        el("span", { textContent: status.brokerHealthy ? "Connected to Identity Broker" : "Broker unhealthy (retrying\u2026)" })
      );

      // Show extension version in header (from manifest)
      const header = document.querySelector(".header");
      if (header && !header.querySelector(".header-version")) {
        const extVer = api.runtime.getManifest().version || "";
        if (extVer) {
          header.appendChild(el("span", { className: "header-version", textContent: "v" + extVer }));
        }
      }

      // Show broker version as detail row
      detailsEl.appendChild(row("Broker:", "v" + status.brokerVersion));

      const refreshBtn = document.getElementById("refresh-btn");
      if (refreshBtn) {
        refreshBtn.style.display = "block";
        refreshBtn.onclick = async () => {
          refreshBtn.textContent = "Refreshing\u2026";
          refreshBtn.disabled = true;
          try {
            const result = await sendMsg({ action: "force_refresh" });
            if (result?.success) {
              refreshBtn.textContent = "Cookie refreshed!";
              // Update countdown with fresh TTL from background
              const freshStatus = await sendMsg({ action: "get_status" });
              if (freshStatus?.cachedCookie && freshStatus.cookieExpiresIn > 0) {
                const countdownEl = document.querySelector(".countdown");
                if (countdownEl) {
                  startCountdown(countdownEl, freshStatus.cookieExpiresIn);
                }
              }
            } else {
              refreshBtn.textContent = "Refresh failed";
            }
          } finally {
            setTimeout(() => {
              refreshBtn.textContent = "Refresh Cookie";
              refreshBtn.disabled = false;
            }, 1500);
          }
        };
      }

      if (status.cachedCookie && status.cookieExpiresIn > 0) {
        const cookieValue = el("span", { className: "value countdown", textContent: "cached (" + formatTime(status.cookieExpiresIn) + " remaining)" });
        const cookieRow = el("div", { className: "row" }, [
          el("span", { className: "label", textContent: "Cookie:" }),
          document.createTextNode(" "),
          cookieValue,
        ]);
        detailsEl.appendChild(cookieRow);
        startCountdown(cookieValue, status.cookieExpiresIn);
      } else {
        detailsEl.appendChild(row("Cookie:", "not cached"));
      }

      if (status.accounts && status.accounts.length > 0) {
        const selectedId = status.selectedAccount?.homeAccountId;
        const accDiv = el("div", { className: "accounts" }, [
          el("div", { className: "accounts-title", textContent: "Accounts (click to select):" }),
        ]);

        for (const acc of status.accounts) {
          const isSelected = acc.homeAccountId === selectedId;
          const name = acc.name || acc.username || "Unknown";
          const email = acc.username || "";
          const accEl = el("div", { className: "account" + (isSelected ? " selected" : ""), role: "button", tabindex: "0" }, [
            el("div", { className: "name", textContent: name + (isSelected ? " \u2713" : "") }),
          ]);
          if (email) {
            accEl.appendChild(el("div", { className: "email", textContent: email }));
          }
          accEl.addEventListener("click", () => selectAccount(acc));
          accEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectAccount(acc); } });
          accDiv.appendChild(accEl);
        }
        detailsEl.appendChild(accDiv);

        if (selectedId) {
          const btn = el("button", { className: "clear-btn", textContent: "Use auto-select" });
          btn.addEventListener("click", clearAccount);
          detailsEl.appendChild(btn);
        }
      } else {
        detailsEl.appendChild(row("Accounts:", "discovery pending"));
      }
    } else {
      statusEl.className = "status error";
      statusEl.replaceChildren(
        el("span", { className: "status-dot" }),
        el("span", { textContent: status.nativeHostMissing ? "Native host not installed" : "Not connected" })
      );

      if (status.nativeHostMissing) {
        detailsEl.appendChild(
          el("div", { className: "label", textContent: "Install the native messaging host:" })
        );
        const cmd = el("pre", { className: "install-cmd" });
        const code = el("code", { textContent: "sudo dnf install linux-entra-bridge" });
        cmd.appendChild(code);
        detailsEl.appendChild(cmd);
        detailsEl.appendChild(
          el("div", { className: "label", textContent: "Or manually:" })
        );
        const cmd2 = el("pre", { className: "install-cmd" });
        const code2 = el("code", { textContent: "git clone https://github.com/Pihaar/linux-entra-bridge.git\ncd linux-entra-bridge && bash native-host/install.sh" });
        cmd2.appendChild(code2);
        detailsEl.appendChild(cmd2);
      } else {
        detailsEl.appendChild(
          el("div", { className: "label", textContent: status.error || "Native host not reachable" })
        );
      }
    }

    // Device compliance display (Feature 2)
    const deviceEl = document.getElementById("device-status");
    // Remove previous SPA toggle and policy banner if exists (prevent duplicate accumulation on re-init)
    const oldSpa = document.querySelector(".spa-toggle");
    if (oldSpa) oldSpa.remove();
    const oldPolicy = document.querySelector(".policy-banner");
    if (oldPolicy) oldPolicy.remove();

    if (status.complianceEnabled && status.complianceState && !status.complianceState.error) {
      const cs = status.complianceState;
      const dotClass = cs.compliant ? "compliance-ok" : "compliance-fail";
      const agoEl = el("span", { className: "compliance-ago" });
      function updateAgo() {
        const mins = cs.lastChecked ? Math.round((Date.now() - cs.lastChecked) / 60000) : "?";
        agoEl.textContent = ` — checked ${mins} min ago`;
      }
      updateAgo();
      setInterval(updateAgo, 60000);
      deviceEl.style.display = "block";
      deviceEl.replaceChildren(
        el("span", { className: dotClass, textContent: "●" }),
        el("span", { textContent: ` ${cs.deviceName} (${cs.compliant ? "compliant" : "non-compliant"})` }),
        agoEl,
        el("div", { className: "compliance-disclaimer", textContent: "Informational only — authoritative state is determined by Intune" })
      );
    } else if (status.complianceEnabled && status.complianceState?.error) {
      const isRateLimit = status.complianceState.error === "rate_limited";
      const dotClass = isRateLimit ? "compliance-warn" : "compliance-fail";
      const errMsg = isRateLimit
        ? "Compliance check rate-limited by Microsoft (429) — will retry automatically"
        : status.complianceState.error === "token_failed"
          ? "Could not acquire Graph API token — check broker connection"
          : `Compliance check failed (HTTP ${status.complianceState.status || "error"})`;
      deviceEl.style.display = "block";
      deviceEl.replaceChildren(
        el("span", { className: dotClass, textContent: "●" }),
        el("span", { className: "compliance-ago", textContent: ` ${errMsg}` })
      );
    } else if (status.complianceEnabled && !status.complianceState) {
      deviceEl.style.display = "block";
      deviceEl.replaceChildren(
        el("span", { className: "compliance-ago", textContent: "Checking device compliance…" })
      );
      // Poll only the compliance state (not full init) every 5s until resolved
      const compliancePoll = setInterval(async () => {
        const freshStatus = await sendMsg({ action: "get_status" });
        if (freshStatus?.complianceState && !freshStatus.complianceState.error) {
          clearInterval(compliancePoll);
          const cs = freshStatus.complianceState;
          const dotClass = cs.compliant ? "compliance-ok" : "compliance-fail";
          const mins = cs.lastChecked ? Math.round((Date.now() - cs.lastChecked) / 60000) : "?";
          deviceEl.replaceChildren(
            el("span", { className: dotClass, textContent: "●" }),
            el("span", { textContent: ` ${cs.deviceName} (${cs.compliant ? "compliant" : "non-compliant"})` }),
            el("span", { className: "compliance-ago", textContent: ` — checked ${mins} min ago` }),
            el("div", { className: "compliance-disclaimer", textContent: "Informational only — authoritative state is determined by Intune" })
          );
        } else if (freshStatus?.complianceState?.error) {
          clearInterval(compliancePoll);
          const isRL = freshStatus.complianceState.error === "rate_limited";
          const errMsg = isRL
            ? "Rate-limited by Microsoft (429) — will retry automatically"
            : freshStatus.complianceState.error === "token_failed"
              ? "Could not acquire Graph API token"
              : `Check failed (HTTP ${freshStatus.complianceState.status || "error"})`;
          deviceEl.replaceChildren(
            el("span", { className: isRL ? "compliance-warn" : "compliance-fail", textContent: "●" }),
            el("span", { className: "compliance-ago", textContent: ` ${errMsg}` })
          );
        }
      }, 5000);
    } else {
      deviceEl.style.display = "none";
    }

    // Enterprise policy pending banner (managed storage SPA domains)
    if (status.pendingPolicyDomains && status.pendingPolicyDomains.length > 0 && api.permissions?.request) {
      const policyBanner = el("div", { className: "policy-banner" });
      const applyBtn = el("button", {
        className: "policy-apply-btn",
        textContent: `Apply managed policy (${status.pendingPolicyDomains.length} SPA domain${status.pendingPolicyDomains.length > 1 ? "s" : ""})`,
      });
      applyBtn.addEventListener("click", async () => {
        const origins = status.pendingPolicyDomains.map(d => `https://${d}/*`);
        const granted = await api.permissions.request({ origins }).catch(() => false);
        if (granted) {
          applyBtn.textContent = "Policy applied!";
          applyBtn.disabled = true;
        }
      });
      policyBanner.appendChild(applyBtn);
      deviceEl.parentNode.insertBefore(policyBanner, deviceEl);
    }

    // SPA Background SSO toggle (Feature 3)
    if (api.permissions?.request && api.tabs?.query) {
      try {
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
          const tabHost = new URL(tab.url).hostname;
          // Only show toggle for Microsoft-ecosystem domains
          const msPatterns = [".microsoft.com", ".microsoftonline.com", ".office.com", ".office365.com", ".sharepoint.com", ".azure.com"];
          const isMsDomain = msPatterns.some(p => tabHost.endsWith(p));
          const ssoHosts = ["login.microsoftonline.com", "login.microsoft.com", "login.live.com"];
          if (isMsDomain && !ssoHosts.includes(tabHost)) {
            const spaSection = el("div", { className: "spa-toggle" });
            const origin = `https://${tabHost}/*`;
            const hasPermission = await api.permissions.contains({ origins: [origin] });
            const toggleBtn = el("button", {
              className: "spa-btn" + (hasPermission ? " active" : ""),
              textContent: hasPermission ? `Background SSO: enabled (${tabHost})` : `Enable Background SSO for ${tabHost}`,
            });
            toggleBtn.addEventListener("click", async () => {
              if (hasPermission) {
                await api.permissions.remove({ origins: [origin] });
              } else {
                await api.permissions.request({ origins: [origin] });
              }
              await init();
            });
            spaSection.appendChild(toggleBtn);
            deviceEl.parentNode.insertBefore(spaSection, deviceEl);
          }
        }
      } catch { /* tabs.query not available (Thunderbird) */ }
    }
  } catch (err) {
    statusEl.className = "status error";
    statusEl.replaceChildren(el("span", { className: "status-dot" }), el("span", { textContent: "Error" }));
    const msg = truncateMsg(err.message || "Unknown error");
    detailsEl.appendChild(
      el("div", { className: "label", textContent: msg })
    );
  }
}
