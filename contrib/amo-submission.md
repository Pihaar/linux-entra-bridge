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

AMO renders the same limited HTML allowlist as ATN: `<a href title> <abbr title> <acronym title> <b> <blockquote> <code> <em> <i> <li> <ol> <strong> <ul>`; NO `<p>` — use blank lines for paragraphs; Markdown is NOT interpreted. Paste:

```html
On Linux, Microsoft Entra ID Conditional Access normally works only in Microsoft Edge, because only Edge talks to the Microsoft Identity Broker. <b>Linux Entra Bridge</b> gives Firefox the same capability.

A small native messaging host (open-source Python) requests the PRT single sign-on cookie from the local <code>microsoft-identity-broker</code> over D-Bus, and the extension places it in the browser cookie store for the Microsoft sign-in domains. Firefox then presents as a compliant device to Entra ID, so Microsoft 365, the Azure Portal, and SAML or OAuth applications behind login.microsoftonline.com work without repeated sign-ins.

<b>Requirements:</b>
<ul>
<li>A Linux device enrolled in Microsoft Intune, with microsoft-identity-broker running (Edge SSO must already work).</li>
<li>The companion native messaging host, installed system-wide via the package or the project's install script.</li>
</ul>

<b>Privacy:</b> Everything runs locally. The extension and host make no network requests of their own and send no data to the developer or any third party. The SSO token is kept in memory and never written to disk.

Open source (MIT), including the native host and the reverse-engineered broker protocol notes: <a href="https://github.com/Pihaar/linux-entra-bridge">github.com/Pihaar/linux-entra-bridge</a>
```

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

### Source code / build instructions (Firefox reviewer)

No minified, bundled, obfuscated, or transpiled code — vanilla JS, ES modules, no build framework. At AMO's "Do you use tools to minify/concatenate/generate code?" question you can answer NO; then no source upload is required. If build instructions are requested, paste:
> This add-on contains no minified, bundled, obfuscated, or transpiled code. All JavaScript, HTML, and CSS are the original human-readable sources (vanilla JS, ES modules). `web-ext build` only zips the files; no compilation or code generation.
>
> Environment: any OS with Node.js and npm (developed on Linux).
>
> Build (reproduces the exact package):
>     git clone https://github.com/Pihaar/linux-entra-bridge
>     cd linux-entra-bridge && git checkout v0.1.1
>     npm ci                # installs web-ext 10.4.0, pinned via package-lock.json
>     make build-firefox    # copies manifests/firefox.json to extension/manifest.json, then runs 'web-ext build'
>
> Result: web-ext-artifacts/firefox/linux_entra_bridge-0.1.1.zip — contents are exactly the files under extension/ plus manifests/firefox.json renamed to manifest.json, byte-for-byte the same as the repo. No minification.
>
> Source for this exact version: https://github.com/Pihaar/linux-entra-bridge/tree/v0.1.1

## Thunderbird (addons.thunderbird.net / ATN)

ATN is a separate store from AMO: own account, own review, web-UI only (no `web-ext sign` CLI).
Upload the file `web-ext-artifacts/entra-id-sso-thunderbird-0.1.1.xpi`. Every field below is
self-contained; nothing needs to be copied from the Firefox section.

**Compatible applications:** Thunderbird only (not SeaMonkey).

**Compatibility (versions):** Thunderbird 128.0 and later (`strict_min_version` 128.0). No max.

**Add-on ID (from manifest, do not change):** `entra-bridge@linux-entra-bridge.tb`

**Name:** Linux Entra Bridge

**Summary** (max 250 chars):
Entra ID SSO for Thunderbird on Linux. A native messaging host bridges to the local microsoft-identity-broker, reusing the device SSO session for Microsoft 365 / Exchange (Conditional Access outside Edge). Companion host required.

**Description** (ATN has a full HTML description field. Allowed tags: `<a href title> <abbr title> <acronym title> <b> <blockquote> <code> <em> <i> <li> <ol> <strong> <ul>`; NO `<p>` — use blank lines for paragraphs; Markdown is NOT interpreted). Paste:

```html
On Linux, signing in to Microsoft 365 or Exchange accounts in Thunderbird goes through Microsoft Entra ID, where Conditional Access (Intune device compliance) normally works only in Microsoft Edge, because only Edge talks to the Microsoft Identity Broker. <b>Linux Entra Bridge</b> closes that gap for Thunderbird.

A companion native messaging host (open-source Python) requests the PRT single sign-on cookie from the local <code>microsoft-identity-broker</code> service over D-Bus, and the extension sets it for the Microsoft sign-in domains. Thunderbird's built-in OAuth sign-in window for Microsoft 365 and Exchange accounts then reuses your device's existing SSO session, without repeated logins, and presents the device as compliant to Entra ID.

<b>Requirements:</b>
<ul>
<li>A Linux device enrolled in Microsoft Intune, with microsoft-identity-broker running (Edge SSO must already work).</li>
<li>The companion native messaging host, installed system-wide via the package or the project's install script.</li>
</ul>

<b>Privacy:</b> Everything runs locally. The extension and host make no network requests of their own and send no data to the developer or any third party. The SSO token is kept in memory and never written to disk.

Open source (MIT), including the native host and the reverse-engineered broker protocol notes: <a href="https://github.com/Pihaar/linux-entra-bridge">github.com/Pihaar/linux-entra-bridge</a>
```

**Categories:** Privacy & Security

**Support site / Homepage / Source code:** https://github.com/Pihaar/linux-entra-bridge

**Release notes (per-version, plain text — ATN's version-notes field takes no HTML/Markdown):**
Fixes adding Microsoft 365 and Exchange accounts through Thunderbird's built-in Outlook Web login. The Conditional Access error 530003 ("device is not registered") no longer occurs: Thunderbird opens that login in an isolated cookie container that the single sign-on cookie did not reach before, and the cookie is now provided there so Entra recognises the device.

Adds an options page in Thunderbird (previously available only on Firefox and Chromium), including a working opt-in device compliance toggle.

Fixes the companion native messaging host installation on RHEL, Fedora and openSUSE (lib64 path), where single sign-on could previously fail silently.

**Notes to reviewer:**
This extension enables Microsoft Entra ID SSO for Thunderbird on Linux. It cannot be fully exercised in a standard review environment because it requires (1) a Linux device enrolled in Microsoft Intune and (2) the microsoft-identity-broker system service running and reachable on the session D-Bus. Without that broker there is no token source.

How it works: a native messaging host (open-source Python, in the project repo) calls the broker over D-Bus to obtain a PRT SSO cookie; the extension sets it in the cookie store for the Microsoft sign-in domains, so Thunderbird's built-in login window for Microsoft 365 and Exchange accounts reuses the device's SSO session. Thunderbird opens that login inside an isolated contextual-identity cookie store; this version additionally mirrors the SSO cookie into that container store, which fixes Conditional Access error 530003 ("device Unregistered"). The extension and host make no outbound network requests and send no data to the developer or any third party; the cookie is only ever set on the three Microsoft sign-in domains, and storage.local holds only the selected account's username.

Permission justification: `cookies` (set the SSO cookie on the Microsoft sign-in domains, including Thunderbird's isolated OWA container store), `nativeMessaging` (talk to the local Python host), `storage` (remember the selected account username, stored locally), `alarms` (refresh the cookie before expiry), `webNavigation` (detect the sso_nonce parameter for Conditional Access nonce flows, and detect the OWA container navigation so the cookie is mirrored in time). host_permissions cover login.microsoftonline.com, login.microsoft.com and login.live.com. optional_host_permissions (graph.microsoft.com and other Microsoft origins) are not granted by default; they are requested at runtime only if the user enables the opt-in device-compliance display on the options page.

Source is public and unminified (vanilla JavaScript, no bundler): https://github.com/Pihaar/linux-entra-bridge

**Data collection:** none. The manifest declares `data_collection_permissions.required = ["none"]`, so no consent flow is needed. (`web-ext lint` shows a `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` warning for this field at TB 128; that is a Firefox-linter artifact and does not apply to ATN.)

## Chrome Web Store (CWS)

Third store, separate Google developer account (one-time $5 fee), own review.

**Upload package:** `web-ext-artifacts/chrome-store/linux-entra-bridge-0.1.0-cws.zip` (the chromium build with the `key` field REMOVED, because the Web Store assigns the ID).

**Extension ID (store ID is the single canonical ID):** `dffhogipdmkddjnppibgmgpcobdnaffk`
The Web Store assigned this ID on upload. Its public key is stored as the `key` field in `manifests/chromium.json`, so unpacked and OBS-packaged builds derive the same ID as the store build. Every native-messaging `allowed_origins` entry (spec, debian.rules, PKGBUILD, install.sh), `chromium-policy.json`, and the READMEs reference this ID. The uploaded `.zip` itself has NO `key` field, because the store assigns the ID for the store build.

**Name:** Linux Entra Bridge

**Short description** (max 132 chars):
Microsoft Entra ID SSO for Chrome on Linux. Bridges to microsoft-identity-broker; needs a companion native messaging host.

**Detailed description:**
On Linux, Microsoft Entra ID Conditional Access normally works only in Microsoft Edge, because only Edge talks to the Microsoft Identity Broker. Linux Entra Bridge gives Chrome (and Chromium, Brave, Vivaldi) the same capability.

A native messaging host (open-source Python) requests the PRT single sign-on cookie from the local microsoft-identity-broker over D-Bus, and the extension sets it for the Microsoft sign-in domains. Chrome then presents as a compliant device to Entra ID, so Microsoft 365, the Azure Portal, and any SAML or OAuth application behind login.microsoftonline.com work without repeated sign-ins.

It requires a Linux device enrolled in Microsoft Intune with microsoft-identity-broker running, plus the companion native messaging host from the project page. Everything runs locally; the extension makes no network requests of its own and sends no data to the developer or any third party.

**Category:** Privacy & Security if offered; otherwise Communication or Workflow & Planning (CWS presents the list in the form).

**Screenshots:** at least one required (1280x800 or 640x400). Use the popup.

**Privacy practices tab (CWS asks for each of these in its own field):**

Single purpose:
> This extension has a single purpose: to provide Microsoft Entra ID single sign-on for Chrome on Linux. It obtains the PRT SSO cookie from the local microsoft-identity-broker (through a companion native messaging host that talks to the broker over D-Bus) and sets it for the Microsoft sign-in domains, so the browser can pass Conditional Access checks that otherwise require Microsoft Edge.

`alarms`:
> Schedules a background refresh of the PRT SSO cookie shortly before it expires, so the sign-in session stays valid without user interaction.

`cookies`:
> Sets the PRT single sign-on cookie on the Microsoft sign-in domains (login.microsoftonline.com, login.microsoft.com, login.live.com) and removes it when the user switches accounts. This cookie is what lets the browser authenticate as a compliant device.

`nativeMessaging`:
> Communicates with the companion native messaging host (open-source Python), the only component that talks to the local microsoft-identity-broker over D-Bus to obtain the SSO cookie. The browser cannot reach the broker directly.

`storage`:
> Remembers the user's selected account (username only) and local settings such as the debug toggle, using chrome.storage. Nothing is transmitted anywhere.

`webNavigation`:
> Detects the sso_nonce parameter on navigations to login.microsoftonline.com, so the extension can request a nonce-bound SSO cookie for Conditional Access flows that require it.

Host permissions:
> Host access to the Microsoft sign-in domains (login.microsoftonline.com, login.microsoft.com, login.live.com) is required to set the SSO cookie on exactly those domains. Optional host permissions (for example graph.microsoft.com for the opt-in device-compliance display) are requested only on demand when the user enables that feature.

Remote code: select "No, I am not using remote code." If a justification field is still shown:
> All code is contained in the extension package. Vanilla JavaScript, no bundler, no external scripts, no eval of remote content, no CDN references. Nothing is loaded or executed from a remote source at runtime.

Data usage: declare NO data categories as collected, then tick the three certification checkboxes (data is not sold, not used for unrelated purposes, not used for creditworthiness). Privacy policy: https://github.com/Pihaar/linux-entra-bridge/blob/main/PRIVACY.md

Publisher contact email (account-level, one-time): set and verify a contact email in the developer settings before publishing. Use a private or GitHub noreply address, not a corporate one. This applies to all your extensions, not just this one.

**Test instructions (CWS "Testing instructions": credentials + additional instructions):**
Leave the credentials field empty. There is no test account and none is needed. The additional-instructions field has a 500-character limit; paste this (499 chars):
> No test account exists or is needed; the extension has no login of its own. Its function requires a Linux device enrolled in Microsoft Intune with the microsoft-identity-broker service on D-Bus, so it cannot run in a standard review VM. A companion native host (open-source Python) fetches a PRT SSO cookie from that local broker; the extension sets it on the Microsoft sign-in domains. No outbound requests, no data sent to anyone, token in memory only. Source: github.com/Pihaar/linux-entra-bridge
