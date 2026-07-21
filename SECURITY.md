# Security Notes: linux-entra-bridge

## Classification

**Type:** Local browser extension + native messaging host

This extension runs entirely on the user's machine. It makes no outbound HTTP requests. All communication is via local IPC (WebExtension APIs, stdin/stdout, D-Bus Unix socket).

## Communication Architecture

```
Browser (handles its own HTTP to login.microsoftonline.com)
  ↕ WebExtension API (cookies.set, storage.local)
Extension (JavaScript, sandboxed by browser)
  ↕ Native Messaging (stdin/stdout, per-message process)
Native Host (Python)
  ↕ D-Bus (local Unix socket)
microsoft-identity-broker (system service)
```

**No network communication originates from the extension or native host.** The browser handles all HTTP traffic independently.

## Security Measures

### Injection protection

| Threat | Status | Implementation |
|--------|--------|----------------|
| XSS (innerHTML) | N/A | All DOM manipulation via `createElement()`/`textContent`; no innerHTML |
| eval/exec | N/A | No `eval()`, `Function()`, `exec()`, or dynamic code execution |
| OS command injection | N/A | No subprocess calls, no `shell=True`, no `os.system()` |
| Prototype pollution | Mitigated | `sanitizeAccount()` strips `__proto__`/`constructor`/`prototype` keys via `DENY_KEYS` filter |
| Input validation | Enforced | Account objects validated (homeAccountId + username as strings); scopes validated (max 50, max 256 chars); nonce format regex |

### No information disclosure

- PRT cookie content is never logged (neither `console.log` nor Python stderr).
- Error messages are sanitized: only broker error context is logged, never token content.
- Account data is minimal: only username/displayName in the popup (by-design for the account selector); the options page redacts PII (first char + domain).

### Secure URL handling

- `sso_nonce` is extracted via `URL.searchParams`; the hostname is validated against the `SSO_NONCE_HOSTS` allowlist (exact-host match, no substring matching).
- `ssoUrl` is reconstructed from validated parts only (hostname + nonce); other params are stripped.
- Nonce format is validated by regex; `encodeURIComponent` is applied before embedding.

### Secret management

- The PRT cookie lives in memory only (a JavaScript variable), never persisted to disk.
- `storage.local` stores only the account preference (username), never tokens.
- No secrets in logs (only cookie name and cache TTL) and none in source (all tokens obtained at runtime via D-Bus).
- JWT-based expiry with a 60s pre-refresh buffer; fallback 5min TTL.

### Cookie protection

- `secure: true` on all `cookies.set()` calls.
- `sameSite: "no_restriction"` (required for cross-domain SSO).
- `httpOnly: true`: the cookie is sent as an HTTP header automatically; JS on login pages does not need to read it, which prevents XSS-based cookie theft.
- On Thunderbird the cookie is also mirrored into the OWA account-setup container store, so it rests in one additional persistent cookie partition on disk. At-rest protection of the browser profile relies on endpoint full-disk encryption (LUKS/BitLocker) and OS profile permissions, outside this extension's control.

### Fail securely

| Case | Behaviour |
|------|-----------|
| D-Bus timeout | 10s (`timeout=DBUS_TIMEOUT`) on every D-Bus method call |
| Broker health | `brokerHealthy` flag with 30s→5min exponential backoff prevents hammering a dead broker |
| Missing native host | Popup shows install instructions when the host is not found |
| JWT parse failure | Falls back to a 5min cache TTL |
| Cookie TTL cap | JWT-claimed expiry capped at 24h as defense-in-depth |
| Unknown actions | Rejected with an error response |
| Error sanitization | Exception details logged to stderr only; clients receive generic messages |

## Protocol Fragility Notice

This extension communicates with the Microsoft Identity Broker using **reverse-engineered constants** observed via `dbus-monitor` on Microsoft Edge's D-Bus calls. These are not part of any public API:

| Constant | Value | Source |
|----------|-------|--------|
| `EDGE_CLIENT_ID` | `ecd6b820-32c2-49b6-98a6-444530e5a77a` | Edge's OAuth client ID |
| `EDGE_REDIRECT_URI` | `https://login.microsoftonline.com/common/oauth2/nativeclient` | Edge's redirect URI |
| `MSAL_CPP_VERSION` | `1.31.0` | MSAL C++ version string |
| `EDGE_REQUEST_OPTIONS` | `[205, 202]` | Undocumented request flags |
| `EDGE_AUTH_TYPE` | `8` | Undocumented auth type enum |

**Risks:** Microsoft may change these values in any broker or Edge update without notice. The broker is not covered by any public API stability guarantee.

**Runtime defense:** `KNOWN_BROKER_MAJOR` is checked against the broker's reported version on each `get_status` call in `background.js`. A mismatch logs a warning visible in the popup. This does not block operation; it alerts the user.

**Maintenance:** On each broker update, verify SSO works end-to-end. If the broker changes its protocol, update the constants in `linux_entra_bridge.py` and `KNOWN_BROKER_MAJOR` in `background.js`.

## Dependencies

Zero npm runtime dependencies; the extension is vanilla JavaScript. The native host uses only `dbus-python` (system package, LGPL-compatible).

## Distribution

| Channel | Format | Signed? |
|---------|--------|---------|
| Firefox / LibreWolf | `.xpi` | AMO signed (unlisted) |
| Chromium / Brave / Vivaldi | Load unpacked | Stable ID via `key` field |
| RPM | `linux-entra-bridge` package | System-wide native host install |

## Contact

- **Maintainer:** Patrick Haar
- **Source:** https://github.com/Pihaar/linux-entra-bridge
