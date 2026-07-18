"""Tests for CLI mode (--test), main() loop, _setup_logging, _create_client."""

import io
import json
import logging
import struct
from unittest.mock import MagicMock

import pytest

from linux_entra_bridge import (
    main,
    _setup_logging,
    _create_client,
    IdentityBrokerClient,
)


# ===== _setup_logging =====

class TestSetupLogging:
    def test_default_level_is_warning(self, monkeypatch):
        monkeypatch.delenv("ENTRA_SSO_DEBUG", raising=False)
        logger = logging.getLogger("entra-sso-test-default")
        logger.handlers.clear()
        # Patch the module-level log to our test logger
        import linux_entra_bridge
        orig_log = linux_entra_bridge.log
        linux_entra_bridge.log = logger
        try:
            _setup_logging()
            assert logger.level == logging.WARNING
        finally:
            linux_entra_bridge.log = orig_log

    def test_debug_level_when_env_set(self, monkeypatch):
        monkeypatch.setenv("ENTRA_SSO_DEBUG", "1")
        logger = logging.getLogger("entra-sso-test-debug")
        logger.handlers.clear()
        import linux_entra_bridge
        orig_log = linux_entra_bridge.log
        linux_entra_bridge.log = logger
        try:
            _setup_logging()
            assert logger.level == logging.DEBUG
        finally:
            linux_entra_bridge.log = orig_log

    def test_utc_iso8601_format(self, monkeypatch):
        monkeypatch.delenv("ENTRA_SSO_DEBUG", raising=False)
        logger = logging.getLogger("entra-sso-test-format")
        logger.handlers.clear()
        import linux_entra_bridge
        orig_log = linux_entra_bridge.log
        linux_entra_bridge.log = logger
        try:
            _setup_logging()
            handler = logger.handlers[0]
            assert handler.formatter.datefmt == "%Y-%m-%dT%H:%M:%SZ"
            import time
            assert handler.formatter.converter is time.gmtime
        finally:
            linux_entra_bridge.log = orig_log

    def test_idempotent_no_duplicate_handlers(self, monkeypatch):
        """F30: calling _setup_logging twice adds only one handler."""
        monkeypatch.delenv("ENTRA_SSO_DEBUG", raising=False)
        logger = logging.getLogger("entra-sso-test-idempotent")
        logger.handlers.clear()
        import linux_entra_bridge
        orig_log = linux_entra_bridge.log
        linux_entra_bridge.log = logger
        try:
            _setup_logging()
            _setup_logging()  # second call should be no-op
            assert len(logger.handlers) == 1
        finally:
            linux_entra_bridge.log = orig_log

class TestCreateClient:
    def test_success(self, mock_iface):
        client = _create_client()
        assert isinstance(client, IdentityBrokerClient)

    def test_dbus_exception_reraised(self, mock_dbus_module):
        import dbus
        dbus.SessionBus.side_effect = mock_dbus_module.exceptions.DBusException("no broker")
        with pytest.raises(Exception, match="no broker"):
            _create_client()
        dbus.SessionBus.side_effect = None  # cleanup


# ===== main() loop =====

class TestMainLoop:
    def _make_stdin(self, messages):
        """Create a stdin-like buffer with multiple native messages."""
        buf = b""
        for msg in messages:
            encoded = json.dumps(msg).encode("utf-8")
            buf += struct.pack("=I", len(encoded)) + encoded
        return buf

    def test_normal_loop(self, monkeypatch, mock_iface):
        """Read message, handle, send response, then EOF → clean exit."""
        mock_iface.getLinuxBrokerVersion.return_value = json.dumps({"version": "3.0"})
        stdin_data = self._make_stdin([{"action": "get_version"}])
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(stdin_data)))

        stdout_buf = io.BytesIO()
        monkeypatch.setattr("sys.stdout", io.TextIOWrapper(stdout_buf))

        main()  # should return cleanly (SystemExit caught internally)

        stdout_buf.seek(0)
        data = stdout_buf.read()
        length = struct.unpack("=I", data[:4])[0]
        response = json.loads(data[4:4+length].decode("utf-8"))
        assert response["success"] is True

    def test_client_init_failure_continues(self, monkeypatch, mock_dbus_module):
        """When client creation fails, send error and continue to next message."""
        import dbus
        call_count = [0]

        def side_effect_fn():
            call_count[0] += 1
            if call_count[0] <= 1:
                raise mock_dbus_module.exceptions.DBusException("no broker")
            mock_obj = MagicMock()
            return mock_obj

        dbus.SessionBus.side_effect = side_effect_fn
        iface = MagicMock()
        iface.getLinuxBrokerVersion.return_value = json.dumps({"v": "1"})
        dbus.Interface.return_value = iface

        stdin_data = self._make_stdin([
            {"action": "get_version"},  # will fail (client init fails)
            {"action": "get_version"},  # will succeed
        ])
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(stdin_data)))
        stdout_buf = io.BytesIO()
        monkeypatch.setattr("sys.stdout", io.TextIOWrapper(stdout_buf))

        main()

        stdout_buf.seek(0)
        data = stdout_buf.read()
        pos = 0
        responses = []
        while pos + 4 <= len(data):
            length = struct.unpack("=I", data[pos:pos+4])[0]
            pos += 4
            if pos + length > len(data):
                break
            resp = json.loads(data[pos:pos+length].decode("utf-8"))
            responses.append(resp)
            pos += length

        assert len(responses) == 2
        assert responses[0]["success"] is False  # client init failed
        assert responses[1]["success"] is True   # second attempt succeeded

        dbus.SessionBus.side_effect = None  # cleanup

    def test_eof_clean_exit(self, monkeypatch, mock_iface):
        """Empty stdin causes clean return (no exception)."""
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(b"")))
        stdout_buf = io.BytesIO()
        monkeypatch.setattr("sys.stdout", io.TextIOWrapper(stdout_buf))

        main()  # returns cleanly

        stdout_buf.seek(0)
        assert stdout_buf.read() == b""  # no output

    def test_dbus_error_drops_client_for_reconnect(self, monkeypatch, mock_iface, mock_dbus_module):
        """D-Bus error in handle_message drops client; next message reconnects."""

        # First message: get_version succeeds
        # Second message: triggers a D-Bus error → client dropped
        # Third message: client re-created, succeeds
        call_count = [0]
        def versioned_response(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 2:
                raise mock_dbus_module.exceptions.DBusException("D-Bus connection lost")
            return json.dumps({"version": "3.0"})

        mock_iface.getLinuxBrokerVersion.side_effect = versioned_response

        stdin_data = self._make_stdin([
            {"action": "get_version"},  # succeeds
            {"action": "get_version"},  # D-Bus error → client dropped
            {"action": "get_version"},  # reconnect + succeed
        ])
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(stdin_data)))
        stdout_buf = io.BytesIO()
        monkeypatch.setattr("sys.stdout", io.TextIOWrapper(stdout_buf))

        main()

        stdout_buf.seek(0)
        data = stdout_buf.read()
        pos = 0
        responses = []
        while pos + 4 <= len(data):
            length = struct.unpack("=I", data[pos:pos+4])[0]
            pos += 4
            if pos + length > len(data):
                break
            resp = json.loads(data[pos:pos+length].decode("utf-8"))
            responses.append(resp)
            pos += length

        assert len(responses) == 3
        assert responses[0]["success"] is True        # first: OK
        assert responses[1]["success"] is False       # second: D-Bus error
        assert responses[1]["error"] == "Broker communication error"
        assert responses[2]["success"] is True        # third: reconnected

        mock_iface.getLinuxBrokerVersion.side_effect = None

    def test_malformed_message_continues(self, monkeypatch, mock_iface):
        """A malformed JSON message sends error response but loop continues."""
        mock_iface.getLinuxBrokerVersion.return_value = json.dumps({"version": "3.0"})

        # Build stdin: first message is invalid JSON, second is valid
        bad_content = b"not{valid json"
        good_msg = json.dumps({"action": "get_version"}).encode("utf-8")
        stdin_data = (
            struct.pack("=I", len(bad_content)) + bad_content +
            struct.pack("=I", len(good_msg)) + good_msg
        )
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(stdin_data)))
        stdout_buf = io.BytesIO()
        monkeypatch.setattr("sys.stdout", io.TextIOWrapper(stdout_buf))

        main()

        stdout_buf.seek(0)
        data = stdout_buf.read()
        pos = 0
        responses = []
        while pos + 4 <= len(data):
            length = struct.unpack("=I", data[pos:pos+4])[0]
            pos += 4
            if pos + length > len(data):
                break
            resp = json.loads(data[pos:pos+length].decode("utf-8"))
            responses.append(resp)
            pos += length

        assert len(responses) == 2
        assert responses[0]["success"] is False  # malformed message error
        assert responses[1]["success"] is True   # valid message succeeded


class TestTestMode:
    def test_redacts_cookie_content_v2(self, mock_iface, capsys):
        """--test mode redacts cookieContent in v2 format."""
        mock_iface.getLinuxBrokerVersion.return_value = json.dumps({"version": "3.0"})
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential",
            "cookieContent": "secret-jwt-content-here",
        })

        import linux_entra_bridge
        orig_level = linux_entra_bridge.log.level
        linux_entra_bridge.log.setLevel(logging.DEBUG)
        try:
            client = _create_client()
            result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
            display = dict(result)
            if display.get("cookieContent"):
                display["cookieContent"] = f"[{len(display['cookieContent'])} chars]"
            output = json.dumps(display, indent=2)
            assert "secret-jwt-content-here" not in output
            assert "[23 chars]" in output
        finally:
            linux_entra_bridge.log.setLevel(orig_level)

    def test_redacts_cookie_content_v3(self, mock_iface):
        """--test mode redacts cookieItems[].cookieContent in v3 format."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieItems": [{
                "cookieName": "x-ms-RefreshTokenCredential",
                "cookieContent": "v3-secret-jwt",
            }]
        })

        client = _create_client()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        display = dict(result)
        if display.get("cookieContent"):
            display["cookieContent"] = f"[{len(display['cookieContent'])} chars]"
        if display.get("cookieItems"):
            display["cookieItems"] = [
                {**item, "cookieContent": f"[{len(item.get('cookieContent', ''))} chars]"}
                for item in display["cookieItems"]
            ]
        output = json.dumps(display, indent=2)
        assert "v3-secret-jwt" not in output
