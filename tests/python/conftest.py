"""Shared fixtures for Python tests — mock D-Bus module."""

import sys
from unittest.mock import MagicMock

import pytest

# Mock dbus module BEFORE importing linux_entra_bridge
# (dbus-python may not be installed in the test environment)
_mock_dbus = MagicMock()
_mock_dbus.exceptions = MagicMock()
_mock_dbus.exceptions.DBusException = type("DBusException", (Exception,), {})
sys.modules["dbus"] = _mock_dbus


@pytest.fixture
def mock_iface():
    """Reset and return the mock D-Bus interface for each test."""
    iface = MagicMock()
    _mock_dbus.SessionBus.return_value.get_object.return_value = MagicMock()
    _mock_dbus.Interface.return_value = iface
    return iface


@pytest.fixture
def mock_dbus_module():
    """Return the mock dbus module itself for exception testing."""
    return _mock_dbus
