# AMO Submission Notes: Linux Entra Bridge

Helper document for submitting the Firefox extension to addons.mozilla.org (listed).
Not shipped in the extension; kept in the repo for reference.

## Listing metadata

- **Name:** Linux Entra Bridge
- **Add-on ID (gecko):** `entra-bridge@linux-entra-bridge`
- **Category:** Privacy & Security (only this one; the other categories do not apply)
- **License:** MIT
- **Homepage / Support:** https://github.com/Pihaar/linux-entra-bridge
- **Privacy Policy URL:** https://github.com/Pihaar/linux-entra-bridge/blob/main/PRIVACY.md
- **Data collection:** `data_collection_permissions.required = ["none"]`. Declare "Does not collect data" in the AMO form; it matches the manifest and PRIVACY.md.

### Summary (max 250 chars)

Microsoft Entra ID single sign-on for Firefox on Linux. It bridges to the local
microsoft-identity-broker so Firefox can pass Conditional Access checks that
otherwise require Microsoft Edge.

### Full description

On Linux, Microsoft Entra ID Conditional Access normally works only in Microsoft
Edge, because only Edge talks to the Microsoft Identity Broker. Linux Entra Bridge
gives Firefox the same capability.

A small native messaging host (open-source Python) requests the PRT single sign-on
cookie from the local microsoft-identity-broker over D-Bus, and the extension places
it in the browser cookie store for the Microsoft sign-in domains. Firefox then
presents as a compliant device to Entra ID, so Microsoft 365, the Azure Portal, and
SAML or OAuth applications behind login.microsoftonline.com work without repeated
sign-ins.

Requirements:
- A Linux device enrolled in Microsoft Intune, with microsoft-identity-broker running
- The native messaging host from the project page

Everything runs locally. The extension makes no network requests of its own and
sends no data to the developer or any third party. Source and documentation:
https://github.com/Pihaar/linux-entra-bridge

## Reviewer notes (paste into the submission)

This extension enables Microsoft Entra ID SSO for Firefox on Linux. It cannot be
fully exercised in a standard review environment because it requires:
(1) a Linux device enrolled in Microsoft Intune, and
(2) the microsoft-identity-broker system service running and reachable on the
session D-Bus. Without that broker there is no token source, so the SSO flow cannot
be triggered on a clean machine.

How it works: a native messaging host (open-source Python, in the project repo)
calls the broker over D-Bus to obtain a PRT SSO cookie; the extension writes that
cookie to the browser cookie store for the Microsoft sign-in domains. The browser,
not the extension, then sends the cookie to Microsoft during its normal sign-in
flow. The extension and host make no outbound network requests and send no data to
the developer or any third party. The token is kept in memory, never written to disk.

Permission justification:
- `cookies`: set the PRT SSO cookie on the Microsoft sign-in domains.
- `nativeMessaging`: communicate with the local Python host that talks to the broker.
- `storage`: remember the selected account (username only), stored locally.
- `alarms`: schedule cookie refresh shortly before expiry.
- `webNavigation`: detect the `sso_nonce` parameter on navigations to
  `login.microsoftonline.com` for Conditional Access nonce flows.
- host_permissions (`login.microsoftonline.com`, `login.microsoft.com`,
  `login.live.com`): required to set the cookie on the sign-in domains.
- optional_host_permissions (`graph.microsoft.com`, `*.office.com`, `*.sharepoint.com`,
  etc.): requested only on demand. `graph.microsoft.com` for the opt-in device
  compliance display; the others for opt-in per-origin background SSO in SPAs.

Source code is public and unminified (vanilla JavaScript, no bundler):
https://github.com/Pihaar/linux-entra-bridge. See SECURITY.md for the security
model and the reverse-engineered broker protocol notes.
