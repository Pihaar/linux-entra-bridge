#!/bin/bash
# Install the native messaging host manifest for supported browsers.
#
# Usage: ./install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/linux_entra_bridge.py"

# Check dependencies
echo "Checking dependencies..."
python3 -c "import dbus" 2>/dev/null || { echo "ERROR: dbus-python not installed. Run: pip install dbus-python"; exit 1; }
echo "  dbus-python: OK"

# Make host script executable
# Set permissions — 750 if owned by current user, 755 for shared installs
if [ "$(stat -c '%u' "$HOST_SCRIPT")" = "$(id -u)" ]; then
    chmod 750 "$HOST_SCRIPT"
else
    chmod 755 "$HOST_SCRIPT"  # shared/root clone — other users need execute
fi

# Verify native host works
echo "Verifying native host..."
if ENTRA_SSO_DEBUG=1 python3 "$HOST_SCRIPT" --test >/dev/null; then
    echo "  Native host: OK"
else
    echo "  WARNING: Native host test failed (broker may not be running)"
    echo "  The extension will still install, but SSO won't work until the broker is available"
fi

# Create manifest with absolute path
# Note: heredoc uses unquoted delimiter for $HOST_SCRIPT expansion.
# $HOST_SCRIPT is derived from dirname, safe for JSON embedding.
create_manifest() {
    local target_dir="$1"
    local browser_name="$2"
    mkdir -p "$target_dir"
    cat > "$target_dir/linux_entra_bridge.json" << EOF
{
  "name": "linux_entra_bridge",
  "description": "Microsoft Entra ID SSO via Identity Broker D-Bus",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_extensions": ["entra-bridge@linux-entra-bridge", "entra-bridge@linux-entra-bridge.tb"]
}
EOF
    echo "  Installed: $target_dir/linux_entra_bridge.json ($browser_name)"
    chmod 0644 "$target_dir/linux_entra_bridge.json"
}

echo "Installing native messaging host manifests..."

# Firefox
create_manifest "$HOME/.mozilla/native-messaging-hosts" "Firefox"

# LibreWolf
if [[ "${1:-}" == "--librewolf" ]] || command -v librewolf &>/dev/null; then
    create_manifest "$HOME/.librewolf/native-messaging-hosts" "LibreWolf"
fi

# Thunderbird uses the SAME native-messaging dir and host name as Firefox
# (~/.mozilla/native-messaging-hosts). No separate manifest is needed; the
# Firefox manifest above already lists the Thunderbird gecko id in
# allowed_extensions. (Firefox/TB do not search ~/.thunderbird for NM hosts.)

# Chromium-based browsers
for chromium_dir in \
    "$HOME/.config/chromium/NativeMessagingHosts" \
    "$HOME/.config/google-chrome/NativeMessagingHosts" \
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
    "$HOME/.config/vivaldi/NativeMessagingHosts"; do

    config_parent=$(dirname "$chromium_dir")
    browser_name=$(basename "$config_parent")

    # Only install if the browser's config dir exists (browser is installed)
    if [ -d "$config_parent" ]; then
        # Chromium native messaging uses different allowed_origins format
        mkdir -p "$chromium_dir"
        cat > "$chromium_dir/linux_entra_bridge.json" << CHROMEOF
{
  "name": "linux_entra_bridge",
  "description": "Microsoft Entra ID SSO via Identity Broker D-Bus",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://dffhogipdmkddjnppibgmgpcobdnaffk/"]
}
CHROMEOF
        echo "  Installed: $chromium_dir/linux_entra_bridge.json ($browser_name)"
        chmod 0644 "$chromium_dir/linux_entra_bridge.json"
    fi
done

echo ""
echo "Done. Restart your browser to pick up the native messaging host."
