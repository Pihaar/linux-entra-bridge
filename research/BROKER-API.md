# Microsoft Identity Broker D-Bus API

Reverse-engineered documentation of the `com.microsoft.identity.broker1` D-Bus service on Linux.

> **Last verified:** April 2026, broker v3.0.1 (`microsoft-identity-broker-3.0.1-1.el9.x86_64`)

## Supported Linux Distributions (Intune Enrollment)

Per [Microsoft docs](https://learn.microsoft.com/en-us/intune/intune-service/fundamentals/deployment-guide-platform-linux):

- Ubuntu LTS 26.04, 24.04, 22.04 (22.04 deprecated August 2026)
- Red Hat Enterprise Linux 9, 10

## Service Details

| Property | Value |
|----------|-------|
| Bus | Session bus |
| Destination | `com.microsoft.identity.broker1` |
| Object path | `/com/microsoft/identity/broker1` |
| Interface | `com.microsoft.identity.Broker1` |
| Managed by | `microsoft-identity-broker.service` (systemd user service) |
| Binary | `/opt/microsoft/identity-broker/bin/microsoft-identity-broker` (native, since v3.0) |

### Broker Version History

Source: [What's new in Microsoft single sign-on for Linux](https://learn.microsoft.com/entra/identity/devices/whats-new-linux)

| Version | Date | Runtime | Key Changes |
|---------|------|---------|-------------|
| < 2.0.2 | pre Sep 2025 | Java JAR | v2 response format, schemas extracted from `LinuxBroker-2.0.1.jar` |
| 2.0.2 | Sep 19, 2025 | **C++ (Preview)** | Major rewrite. Entra Join (not Registration). Certs moved to `/etc/ssl/private`. User broker becomes D-Bus-invoked executable (no longer a persistent service). |
| 2.0.3 | Oct 21, 2025 | C++ | Service renamed `linux_broker` → `microsoft-identity-broker`. Added `dsreg` CLI tool. |
| 2.5.0 | Jan 13, 2026 | C++ | RHEL 10 support. `dsreg` tool. Broker version in telemetry. |
| 2.5.1 | Jan 29, 2026 | C++ | GTK4 smartcard fix. TLS 1.3 GetDeviceState. |
| 2.5.2 | Feb 11, 2026 | C++ | GTK4 fix. Callback reuse fix. |
| **3.0.1** | **Mar 31, 2026** | **C++ (GA)** | GA release of C++ broker. FIDO2/PIV/CBA (Phish Resistant MFA). v3 response format (`cookieItems[]`). Device broker renamed to `microsoft-identity-devicebroker`. |
| **3.0.2** | **Apr 27, 2026** | C++ | Ubuntu 26.04 LTS support. **PKCE support**. Thread-safety fix ("ensure all browser calls done in same thread"). Improved logging. |

> **Architecture change (v3.0.1):** "There's no longer a user broker service named `microsoft-identity-broker`. The user broker is now an executable invoked over D-Bus." — the broker starts on-demand via D-Bus activation, not as a persistent systemd service.

> **Device re-registration:** When devices update from broker < 2.0.2 to >= 2.0.2, Intune automatically re-registers them with new device IDs ([source](https://learn.microsoft.com/en-us/intune/intune-service/fundamentals/deployment-guide-platform-linux)).

> **Deprecation:** Ubuntu 22.04 LTS support ends August 2026.

### Diagnostics: `dsreg` CLI Tool

Since v2.0.3, the broker includes `/usr/bin/dsreg` (similar to Windows `dsregcmd`):

```bash
dsreg --status        # Device registration status, PRT info, broker version
dsreg --help          # All options
```

## Methods

All methods take 3 string parameters `(string, string, string)` and return 1 string (JSON):

| Method | Purpose | Request Schema |
|--------|---------|----------------|
| `getLinuxBrokerVersion` | Get broker version | `LinuxBrokerVersionRequest.json` |
| `getAccounts` | List enrolled accounts | `GetAllAccountsRequest.json` |
| `acquireTokenSilently` | Get token without UI | `SilentTokenRequest.json` |
| `acquireTokenInteractively` | Get token with SSO dialog | `InteractiveTokenRequest.json` |
| `acquirePrtSsoCookie` | **Get PRT SSO cookie** | `AcquirePrtSsoCookieRequest.json` |
| `generateSignedHttpRequest` | Proof-of-Possession | `GenerateSignedHttpRequest.json` |
| `removeAccount` | Remove account | `RemoveAccountRequest.json` |
| `cancelInteractiveFlow` | Cancel auth dialog | `CancelInteractiveFlowRequest.json` |

JSON schemas in `broker-schemas/` were extracted from the broker v2.0.1 JAR. The v3 native broker is protocol-compatible but the schemas may drift over time.

## Parameter Format

```
param1: "0.0"                    (protocol version -- plain string, not JSON)
param2: "<uuid>"                 (correlation ID -- random UUID per request)
param3: '{"account":{...}, ...}' (request body -- JSON string)
```

This was discovered by monitoring Edge's D-Bus calls via `dbus-monitor`.

### Reverse-Engineered Constants

These values were captured from Edge (April 2026) and have **no API stability guarantee**:

| Constant | Value | Notes |
|----------|-------|-------|
| Client ID | `ecd6b820-32c2-49b6-98a6-444530e5a77a` | Edge's OAuth public client ID |
| Redirect URI | `https://login.microsoftonline.com/common/oauth2/nativeclient` | Edge's redirect URI |
| MSAL C++ Version | `1.31.0` | Reported to broker by Edge (MSAL C++ SDK) |
| Request Options | `[205, 202]` | Undocumented flags (observed in Edge D-Bus calls) |
| Auth Type | `8` | Undocumented enum (observed in Edge D-Bus calls) |

> **Note:** The broker itself internally uses MSAL Java SDK v4.67.2 (seen in v2.0.1 JAR manifest). The `msalCppVersion: "1.31.0"` is what Edge *reports* to the broker, not the broker's own version. Since v3.0 the broker is no longer Java-based.

### Broker Response Formats

**v2 format** (broker 2.x -- Java JAR):
```json
{
  "cookieName": "x-ms-RefreshTokenCredential",
  "cookieContent": "<jwt>"
}
```

**v3 format** (broker 3.x -- native binary):
```json
{
  "cookieItems": [
    {
      "cookieName": "x-ms-RefreshTokenCredential",
      "cookieContent": "<jwt>"
    }
  ]
}
```

The extension normalizes v3 to v2 format by extracting `cookieItems[0]` to top-level fields. Both the Python native host and the JS extension perform this normalization independently.

### SSO Nonce Flow

When `login.microsoftonline.com` URLs contain an `sso_nonce` parameter (Conditional Access), the nonce is passed in the `ssoUrl` field of the `acquirePrtSsoCookie` request. The broker returns a nonce-specific PRT cookie with a `request_nonce` claim in the JWT. This cookie is one-shot and does not replace the cached proactive cookie.

## How to Capture Edge's Calls

```bash
# Terminal 1: Monitor D-Bus traffic to the broker
dbus-monitor --session "destination='com.microsoft.identity.broker1'"

# Terminal 2: Open a new Edge tab to an Entra ID protected site
microsoft-edge https://portal.azure.com
```

See `capture-broker-calls.sh` for a ready-to-use capture script.

## Implementation Notes

- Broker v2.0.x used **Moshi** for JSON deserialization (Java); v3.0.x is native
- Parameter validation in v2 happened in `LinuxBrokerRequestValidator` (Java class)
- Edge uses MSAL C++ to call the broker; the `msalCppVersion` field is required
- D-Bus activation via `.service` files in `/usr/share/dbus-1/services/` gives the legitimate broker priority over rogue services
- The broker runs as a systemd user service: `systemctl --user status microsoft-identity-broker.service`
