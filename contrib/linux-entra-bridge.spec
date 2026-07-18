Name:           linux-entra-bridge
Version:        0.1.0
Release:        1%{?dist}
Summary:        Microsoft Entra ID SSO for Linux browsers via Identity Broker D-Bus
License:        MIT
URL:            https://github.com/Pihaar/linux-entra-bridge

Source0:        %{name}-%{version}.tar.gz

# NOT noarch: the Firefox/Thunderbird native-messaging manifest must live in the
# arch library dir mozilla path (/usr/lib64/mozilla on 64-bit distros). Firefox and
# Thunderbird derive their system manifest dir from HAVE_USR_LIB64_DIR and do NOT
# search /usr/lib/mozilla on lib64 distros (RHEL, Fedora, openSUSE). A noarch package
# cannot ship into the arch libdir, so this builds per-arch though the payload is
# arch-independent.
BuildRequires:  python3 >= 3.6
Requires:       python3 >= 3.6
Requires:       python3-dbus >= 1.2

# No compiled binaries (Python + JS + JSON only): nothing belongs in a
# debuginfo/debugsource subpackage. Disable it, otherwise Fedora/RHEL fail the
# arch-specific build with an empty debugsource file list.
%global debug_package %{nil}

%description
Cross-browser extension that enables Microsoft Entra ID SSO on Linux
by communicating with the microsoft-identity-broker D-Bus service.
Installs the native messaging host for Firefox, LibreWolf, and
Chromium-based browsers. The browser extension (.xpi) is included
and can be installed from the package documentation directory.

%prep
%setup -q

%install
# Native messaging host binary
install -Dm755 native-host/linux_entra_bridge.py %{buildroot}%{_libexecdir}/%{name}/linux_entra_bridge.py
# Use an absolute interpreter path (SUSE rpmlint rejects /usr/bin/env for dependency detection)
sed -i '1s|#!/usr/bin/env python3|#!/usr/bin/python3|' %{buildroot}%{_libexecdir}/%{name}/linux_entra_bridge.py

# Firefox/LibreWolf native messaging host manifest
install -d %{buildroot}%{_libdir}/mozilla/native-messaging-hosts
cat > %{buildroot}%{_libdir}/mozilla/native-messaging-hosts/linux_entra_bridge.json << EOF
{
  "name": "linux_entra_bridge",
  "description": "Microsoft Entra ID SSO via Identity Broker D-Bus",
  "path": "%{_libexecdir}/%{name}/linux_entra_bridge.py",
  "type": "stdio",
  "allowed_extensions": ["entra-bridge@linux-entra-bridge", "entra-bridge@linux-entra-bridge.tb"]
}
EOF

# Chromium native messaging host manifest
install -d %{buildroot}%{_sysconfdir}/chromium/native-messaging-hosts
cat > %{buildroot}%{_sysconfdir}/chromium/native-messaging-hosts/linux_entra_bridge.json << EOF
{
  "name": "linux_entra_bridge",
  "description": "Microsoft Entra ID SSO via Identity Broker D-Bus",
  "path": "%{_libexecdir}/%{name}/linux_entra_bridge.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://dffhogipdmkddjnppibgmgpcobdnaffk/"]
}
EOF
# Symlink for Google Chrome and Brave
install -d %{buildroot}%{_sysconfdir}/opt/chrome/native-messaging-hosts
ln -sf %{_sysconfdir}/chromium/native-messaging-hosts/linux_entra_bridge.json \
       %{buildroot}%{_sysconfdir}/opt/chrome/native-messaging-hosts/linux_entra_bridge.json
install -d %{buildroot}%{_sysconfdir}/brave-browser/native-messaging-hosts
ln -sf %{_sysconfdir}/chromium/native-messaging-hosts/linux_entra_bridge.json \
       %{buildroot}%{_sysconfdir}/brave-browser/native-messaging-hosts/linux_entra_bridge.json
install -d %{buildroot}%{_sysconfdir}/vivaldi/native-messaging-hosts
ln -sf %{_sysconfdir}/chromium/native-messaging-hosts/linux_entra_bridge.json \
       %{buildroot}%{_sysconfdir}/vivaldi/native-messaging-hosts/linux_entra_bridge.json

# LibreWolf system-wide native messaging host (symlink to Firefox manifest)
install -d %{buildroot}%{_libdir}/librewolf/native-messaging-hosts
ln -sf %{_libdir}/mozilla/native-messaging-hosts/linux_entra_bridge.json \
       %{buildroot}%{_libdir}/librewolf/native-messaging-hosts/linux_entra_bridge.json

# Extension source (Chromium unpacked load — Firefox users should use the signed .xpi from Releases)
# The Chromium manifest is the canonical manifest for the unpacked/system extension install
install -d %{buildroot}%{_datadir}/%{name}/extension
cp extension/*.js extension/*.html extension/*.css %{buildroot}%{_datadir}/%{name}/extension/
cp manifests/chromium.json %{buildroot}%{_datadir}/%{name}/extension/manifest.json
cp -r extension/icons %{buildroot}%{_datadir}/%{name}/extension/

%check
python3 -c "import py_compile; py_compile.compile('native-host/linux_entra_bridge.py', doraise=True)"

%files
%license LICENSE
%doc README.md
%{_libexecdir}/%{name}/
%dir %{_libdir}/mozilla
%dir %{_libdir}/mozilla/native-messaging-hosts
%{_libdir}/mozilla/native-messaging-hosts/linux_entra_bridge.json
%dir %{_libdir}/librewolf
%dir %{_libdir}/librewolf/native-messaging-hosts
%{_libdir}/librewolf/native-messaging-hosts/linux_entra_bridge.json
%dir %{_sysconfdir}/chromium
%dir %{_sysconfdir}/chromium/native-messaging-hosts
%{_sysconfdir}/chromium/native-messaging-hosts/linux_entra_bridge.json
%dir %{_sysconfdir}/opt/chrome
%dir %{_sysconfdir}/opt/chrome/native-messaging-hosts
%{_sysconfdir}/opt/chrome/native-messaging-hosts/linux_entra_bridge.json
%dir %{_sysconfdir}/brave-browser
%dir %{_sysconfdir}/brave-browser/native-messaging-hosts
%{_sysconfdir}/brave-browser/native-messaging-hosts/linux_entra_bridge.json
%dir %{_sysconfdir}/vivaldi
%dir %{_sysconfdir}/vivaldi/native-messaging-hosts
%{_sysconfdir}/vivaldi/native-messaging-hosts/linux_entra_bridge.json
%{_datadir}/%{name}/

%changelog
* Sat Jul 18 2026 Patrick Haar <Pihaar@users.noreply.github.com> - 0.1.0-1
- Initial release
