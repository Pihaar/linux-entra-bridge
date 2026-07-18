# Privacy Policy — Linux Entra Bridge

_Last updated: 2026-07-18_

## Summary

Linux Entra Bridge does **not** collect, store, or transmit any personal data to
the developer or to any third party. It has no telemetry, no analytics, and makes
no network requests of its own.

## What the extension does with data

- **PRT SSO cookie:** The extension obtains a Primary Refresh Token SSO cookie from
  the locally running `microsoft-identity-broker` service (via a native messaging
  host that talks to the broker over D-Bus) and places it in the browser's cookie
  store for the Microsoft sign-in domains. From there the **browser** sends the
  cookie to `login.microsoftonline.com` as part of Microsoft's own sign-in flow.
  The extension itself sends nothing anywhere.
- **Account preference:** The extension stores a single value locally
  (`storage.local`) — the username of the account you selected in the popup — so it
  can remember your choice. This never leaves your device.
- **No token persistence:** The SSO cookie/token is held in memory only and is never
  written to disk by the extension.

## Network

The extension and its native host make **no outbound network requests**. All
communication is local IPC (WebExtension APIs, native messaging over stdin/stdout,
and D-Bus to the identity broker). Any HTTPS traffic to Microsoft is performed by
the browser itself, not by the extension.

## Optional device-compliance check

If you explicitly opt in, the extension can query Microsoft Graph
(`graph.microsoft.com`) to display your device's compliance status. This request is
made only after you enable the feature, uses a token obtained locally from the
broker, and its result is shown to you only — it is not stored or shared. Intune
remains the authoritative source; this display is informational.

## Contact

Source code and issues: https://github.com/Pihaar/linux-entra-bridge
