#!/usr/bin/env python3
"""Test wrapper for --test CLI mode: runs linux_entra_bridge --test with mocked D-Bus.

Used by test_integration.py::TestCliTestMode.
"""
import json
import os
import sys
from unittest.mock import MagicMock

# Add native-host to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "native-host"))

# Mock dbus module (same pattern as conftest.py and mock_broker_wrapper.py)
_mock_dbus = MagicMock()
_mock_dbus.exceptions.DBusException = type("DBusException", (Exception,), {})

_mock_iface = MagicMock()
_mock_iface.getLinuxBrokerVersion.return_value = json.dumps({
    "linuxBrokerVersion": "3.0.1-mock",
})
_mock_iface.getAccounts.return_value = json.dumps({
    "accounts": [{"homeAccountId": "mock-001", "username": "mock@test.example", "name": "Mock User"}],
})
_mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
    "cookieName": "x-ms-RefreshTokenCredential",
    "cookieContent": "mock-jwt-content",
})

_mock_dbus.SessionBus.return_value.get_object.return_value = MagicMock()
_mock_dbus.Interface.return_value = _mock_iface

sys.modules["dbus"] = _mock_dbus

# Simulate --test mode
sys.argv = ["linux_entra_bridge.py", "--test"]

import linux_entra_bridge  # noqa: E402
linux_entra_bridge._setup_logging()

if __name__ == "__main__":
    client = linux_entra_bridge._create_client()
    print("=== Broker Version ===")
    print(json.dumps(client.get_version(), indent=2))
    print("\n=== Accounts ===")
    print(json.dumps(client.get_accounts(), indent=2))
    print("\n=== PRT SSO Cookie ===")
    result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
    display = dict(result)
    if display.get("cookieContent"):
        display["cookieContent"] = f"[{len(display['cookieContent'])} chars]"
    print(json.dumps(display, indent=2))
