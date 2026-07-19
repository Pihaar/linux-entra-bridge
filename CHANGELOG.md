# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-07-19

### Fixed
- Native messaging manifest for Firefox and Thunderbird now installs to the lib64 mozilla path (`/usr/lib64/mozilla`) on RHEL, Fedora, and openSUSE; the RPM is now arch-specific. Previously it was placed in `/usr/lib/mozilla`, where those browsers do not search on lib64 distros, so SSO failed silently.
- Lowered Firefox `strict_min_version` to `140.0` so the extension installs on Firefox ESR 140 (RHEL/SLE/openSUSE). `142` excluded the main Enterprise Linux target group; the add-on is desktop-only (no Android), so the Android-only data-collection requirement does not apply.
- Disabled the RPM debug package (pure Python/JS/JSON payload, no binaries), fixing the Fedora/RHEL package build.

### Changed
- Adopted the Chrome Web Store extension ID as the canonical Chromium/Chrome ID.

## [0.1.0] - 2026-07-18

Initial release.

### Features
- Cross-browser Microsoft Entra ID (Azure AD) SSO on Linux via the `microsoft-identity-broker` D-Bus service
- Sets the PRT SSO cookie via the `cookies.set()` API for Firefox, LibreWolf, Chromium, Brave, Vivaldi, and Thunderbird
- SSO nonce support for Conditional Access (Intune Company Portal)
- SPA Background SSO: opt-in per-origin nonce injection for single-page apps
- Device compliance check via MS Graph (opt-in, informational only; Intune remains authoritative)
- Account selection UI with cookie cleanup on switch
- Auto dark/light mode following OS/browser preference (WCAG AA contrast)
- Structured logging with popup log viewer
- Broker v2/v3 API compatibility (cookieItems normalization) and broker version change warning
- Chromium service worker health state persistence, exponential backoff health circuit breaker
- Force refresh button and badge indicator

### Security
- httpOnly PRT SSO cookie, 24h max TTL cap, prototype pollution prevention
- Exact-host URL matching for cookie injection and nonce handling
- Error sanitization: generic messages to clients, details in stderr only
- PII redaction in logs and options page; nonce format validation

### Tests
- 423 tests (280 JS vitest + 143 Python pytest)
