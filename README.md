# <img src="extension/icons/icon-96.png" width="32" height="32" alt=""> linux-entra-bridge

Cross-browser extension that enables Microsoft Entra ID (Azure AD) SSO on Linux by communicating with the `microsoft-identity-broker` D-Bus service.

## Problem

On Linux, Microsoft Entra ID conditional access (Intune device compliance) only works in Microsoft Edge. Firefox, LibreWolf, Chromium, Brave, and Vivaldi cannot authenticate to Entra ID-protected services because they lack integration with the Microsoft Identity Broker.

On Windows and macOS this isn't an issue -- the OS-level identity broker (WAM / Company Portal) works with all browsers. On Linux, the broker exists as a standalone D-Bus service but only Edge knows how to talk to it.

## Solution

1. **Native Messaging Host** -- Python daemon communicating with `com.microsoft.identity.broker1` via D-Bus
2. **Cross-browser WebExtension** -- Sets the PRT SSO cookie in the browser's cookie store via `cookies.set()` API

### Supported Browsers

| Browser | Support | Notes |
|---------|---------|-------|
| Firefox | Manifest V3 | Full support (signed .xpi) |
| LibreWolf | Manifest V3 | Full support (unsigned extensions allowed by default) |
| Chromium | Manifest V3 | Full support (load unpacked) |
| Brave | Manifest V3 | Full support (load unpacked) |
| Vivaldi | Manifest V3 | Full support (load unpacked) |
| Thunderbird | Manifest V3 | Firefox-based; native host via install.sh, signed .xpi |
| Edge | Not needed | Built-in broker integration |

Works with **all** Entra ID protected services requiring Conditional Access via `login.microsoftonline.com` -- Jira, GitHub Enterprise, Office 365, Azure Portal, and any SAML/OAuth-integrated application.

## How It Works

```
Browser (Firefox / LibreWolf / Chromium / Brave / Vivaldi)
    |
    +-- Extension sets PRT SSO cookie via cookies.set() API
    |
    +-- Native Messaging (stdin/stdout)
    |       |
    |       +-- Python host calls D-Bus: acquirePrtSsoCookie()
    |       |       |
    |       |       +-- microsoft-identity-broker returns SSO cookie
    |       |
    |       +-- Returns cookie to extension
    |
    +-- Browser automatically includes cookie in requests
            |
            +-- Entra ID sees compliant device
```

## Prerequisites

- **Linux** with D-Bus session bus (any desktop environment)
- A **Secret Service provider** (`org.freedesktop.secrets`):
  - GNOME / XFCE: gnome-keyring (usually pre-installed)
  - KDE Plasma: KWallet with Secret Service integration
  - Sway / i3 / etc: KeePassXC (enable Secret Service in settings)
- **microsoft-identity-broker** service running:
  ```bash
  systemctl --user status microsoft-identity-broker.service
  ```
- Device enrolled in Microsoft Intune (Edge SSO must already work)
- Python 3.9+ with `dbus-python`

## Installation

### 1. Install native messaging host

```bash
git clone https://github.com/Pihaar/linux-entra-bridge.git
cd linux-entra-bridge
bash native-host/install.sh
```

This auto-detects installed browsers and installs the native messaging manifest for each.

### 2. Install the extension

#### Firefox / LibreWolf

Build and sign the `.xpi` yourself (no CI/CD -- signing requires AMO API credentials):

```bash
export WEB_EXT_API_KEY="your-key"
export WEB_EXT_API_SECRET="your-secret"
make sign
```

The signed `.xpi` appears in `web-ext-artifacts/firefox/`. Install it via:
`about:addons` --> gear icon --> "Install Add-on From File" --> select the `.xpi`

> **LibreWolf:** Unsigned extensions are allowed by default, so you can also use `make build-firefox` (no AMO credentials needed) and install the unsigned `.xpi`.

#### Chromium / Brave / Vivaldi

```bash
make build-chromium
```

Then load the unpacked extension:
1. Open `chrome://extensions` (or `brave://extensions`, `vivaldi://extensions`)
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked** --> select `web-ext-artifacts/chromium/`

The extension gets a stable ID (`fldaignoojobnhfafojdhekiiboameoe`) via the `key` field in the manifest, so the native messaging host always connects.

> **Note:** Chromium shows a "Developer mode extensions" banner on startup. This is cosmetic.

### Updating

The extension and native host do not auto-update. After pulling new changes:

```bash
cd linux-entra-bridge
git pull
```

**Chromium / Brave / Vivaldi:**
```bash
make build-chromium
# Then go to chrome://extensions and click the reload button on the extension
```

**Firefox / LibreWolf:** Re-sign and re-install the `.xpi` (see above).

**Native host:** Updates to `linux_entra_bridge.py` take effect immediately on the next browser restart; the native messaging manifest points directly to the repo clone. Only re-run `bash native-host/install.sh` if you move the repo directory or the manifest format changes.

> **Important:** Do not move or delete the repo clone, because both the unpacked extension (Chromium) and the native messaging manifests reference files in it by absolute path.

### Enterprise Deployment

For managed Linux desktops, see [`contrib/README-enterprise.md`](contrib/README-enterprise.md) for IT admin instructions including Chromium policy templates and RPM packaging.

## Features

- Auto dark/light mode following OS/browser preference (WCAG AA contrast)
- Account selection UI with cookie cleanup on switch
- SSO nonce support for Conditional Access (Intune Company Portal)
- SPA Background SSO: opt-in per-origin nonce injection for single-page apps
- Device compliance check via MS Graph (opt-in, informational only; Intune remains authoritative)
- Structured logging with popup log viewer
- Broker v2/v3 API compatibility (cookieItems normalization)
- Broker version change warning
- Chromium service worker health state persistence
- Exponential backoff health circuit breaker
- Force refresh button and badge indicator
- httpOnly PRT cookie, 24h TTL cap, prototype pollution prevention
- 423 tests (280 JS vitest + 143 Python pytest)

## Project Structure

```
linux-entra-bridge/
+-- extension/                    # WebExtension (vanilla JS, no bundler)
|   +-- background.js             # Background script: cookie lifecycle, logging
|   +-- popup.html / popup.js     # Status popup with log viewer
|   +-- options.html / options.js # Settings (debug toggle, broker check)
|   +-- theme.css                 # Shared CSS variables (dark/light mode)
|   +-- popup.css / options.css   # Component-specific styles
|   +-- lib.js                    # Shared utilities (API shim, truncation)
|   +-- *-init.js                 # MV3 CSP-compliant entry points
|   +-- icons/                    # Extension icons (SVG + PNG)
+-- manifests/                    # Browser-specific manifests
|   +-- firefox.json              # Firefox/LibreWolf (Manifest V3)
|   +-- chromium.json             # Chromium/Brave/Vivaldi (Manifest V3)
|   +-- thunderbird.json          # Thunderbird (Manifest V3)
+-- native-host/                  # Native Messaging Host
|   +-- linux_entra_bridge.py       # D-Bus broker communication (Python)
|   +-- install.sh                # Auto-detect browsers, install NM manifests
+-- contrib/
|   +-- linux-entra-bridge.spec      # RPM spec for system-wide install
|   +-- chromium-policy.json      # Enterprise policy template
|   +-- README-enterprise.md      # IT admin deployment guide
+-- tests/                        # Test suites
|   +-- js/                       # vitest + jsdom (background, popup, options)
|   +-- python/                   # pytest (broker, messaging, CLI, integration)
+-- research/                     # Reverse-engineering documentation
|   +-- broker-schemas/           # JSON schemas from broker JAR
|   +-- BROKER-API.md             # D-Bus API reference
|   +-- capture-broker-calls.sh   # dbus-monitor capture script
+-- Makefile                      # check/install/build/sign/test/rpm
+-- SECURITY.md                   # Security notes + protocol fragility
+-- CHANGELOG.md
+-- LICENSE                       # MIT
```

## Protocol Fragility Notice

This extension communicates with the Microsoft Identity Broker using **reverse-engineered constants** observed via `dbus-monitor` on Edge's D-Bus calls. These are not part of any public API and may break on broker updates. The extension logs a warning when the broker major version changes. See [`SECURITY.md`](SECURITY.md) for details and [`research/BROKER-API.md`](research/BROKER-API.md) for the full D-Bus API reference.

## Development

```bash
make check          # Verify prerequisites + test native host
make test           # Run all 423 tests (JS + Python)
make lint           # ESLint + ruff
make coverage       # Coverage reports (JS + Python)
make build          # Build both Firefox + Chromium
make rpm            # Build RPM package
make check-version  # Verify version consistency across manifests
```

## Related Work

- [microsoft-identity-broker](https://packages.microsoft.com/) -- Microsoft's Linux identity broker
- [MSAL C++](https://github.com/AzureAD/microsoft-authentication-library-for-cpp) -- Microsoft Authentication Library (what Edge uses)
- [WebExtension Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) -- Browser native messaging API

## License

MIT
