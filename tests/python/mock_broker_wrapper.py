#!/usr/bin/env python3
"""Test wrapper: runs linux_entra_bridge with mocked D-Bus (no real broker needed).

This script is used by integration tests (test_integration.py) to run the native
messaging host as a subprocess without requiring a D-Bus session bus or the
Microsoft Identity Broker service.

The mock setup mirrors conftest.py but runs in a separate process.
"""
import json
import os
import sys
from unittest.mock import MagicMock

# Add native-host to Python path (so linux_entra_bridge can be imported)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "native-host"))

# Mock dbus module with proper DBusException (same pattern as conftest.py)
_mock_dbus = MagicMock()
_mock_dbus.exceptions.DBusException = type("DBusException", (Exception,), {})

# Stub D-Bus interface methods with canned responses
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
_mock_iface.acquireTokenSilently.return_value = json.dumps({
    "accessToken": "mock-access-token",
})

_mock_dbus.SessionBus.return_value.get_object.return_value = MagicMock()
_mock_dbus.Interface.return_value = _mock_iface

sys.modules["dbus"] = _mock_dbus

from linux_entra_bridge import main  # noqa: E402
main()
