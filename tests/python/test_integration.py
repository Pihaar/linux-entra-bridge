"""Integration tests: run linux_entra_bridge as a subprocess with piped stdin/stdout.

Uses mock_broker_wrapper.py to bypass D-Bus — no real broker or D-Bus session needed.
Tests the full native messaging protocol: 4-byte length prefix + JSON framing.
"""

import json
import os
import struct
import subprocess


WRAPPER = os.path.join(os.path.dirname(__file__), "mock_broker_wrapper.py")


def _frame(message):
    """Encode a message as a native messaging frame (4-byte LE length + UTF-8 JSON)."""
    encoded = json.dumps(message).encode("utf-8")
    return struct.pack("=I", len(encoded)) + encoded


def _send_recv(messages, timeout=5):
    """Start the wrapper, send framed messages, receive framed responses."""
    stdin_data = b"".join(_frame(m) for m in messages)
    proc = subprocess.Popen(
        ["python3", WRAPPER],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    stdout, stderr = proc.communicate(input=stdin_data, timeout=timeout)
    # Parse responses from stdout
    responses = []
    pos = 0
    while pos + 4 <= len(stdout):
        length = struct.unpack("=I", stdout[pos:pos + 4])[0]
        pos += 4
        if pos + length > len(stdout):
            break
        resp = json.loads(stdout[pos:pos + length].decode("utf-8"))
        responses.append(resp)
        pos += length
    return responses, proc.returncode


class TestIntegration:
    def test_get_version(self):
        responses, rc = _send_recv([{"action": "get_version"}])
        assert len(responses) == 1
        assert responses[0]["success"] is True
        assert "mock" in responses[0]["data"]["linuxBrokerVersion"]

    def test_get_accounts(self):
        responses, rc = _send_recv([{"action": "get_accounts"}])
        assert len(responses) == 1
        assert responses[0]["success"] is True
        assert len(responses[0]["data"]["accounts"]) == 1
        assert responses[0]["data"]["accounts"][0]["username"] == "mock@test.example"

    def test_get_prt_sso_cookie(self):
        responses, rc = _send_recv([{
            "action": "get_prt_sso_cookie",
            "ssoUrl": "https://login.microsoftonline.com/",
        }])
        assert len(responses) == 1
        assert responses[0]["success"] is True
        assert responses[0]["data"]["cookieName"] == "x-ms-RefreshTokenCredential"

    def test_get_status(self):
        responses, rc = _send_recv([{"action": "get_status"}])
        assert len(responses) == 1
        assert responses[0]["success"] is True
        assert "version" in responses[0]["data"]
        assert "accounts" in responses[0]["data"]

    def test_unknown_action(self):
        responses, rc = _send_recv([{"action": "nonexistent"}])
        assert len(responses) == 1
        assert responses[0]["success"] is False
        assert "Unknown action" in responses[0]["error"]

    def test_malformed_then_valid(self):
        """Malformed message gets error response; broker continues processing."""
        bad = b"not{valid json"
        good = json.dumps({"action": "get_version"}).encode("utf-8")
        stdin_data = (
            struct.pack("=I", len(bad)) + bad +
            struct.pack("=I", len(good)) + good
        )
        proc = subprocess.Popen(
            ["python3", WRAPPER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        stdout, stderr = proc.communicate(input=stdin_data, timeout=5)
        responses = []
        pos = 0
        while pos + 4 <= len(stdout):
            length = struct.unpack("=I", stdout[pos:pos + 4])[0]
            pos += 4
            if pos + length > len(stdout):
                break
            responses.append(json.loads(stdout[pos:pos + length].decode("utf-8")))
            pos += length
        assert len(responses) == 2
        assert responses[0]["success"] is False  # malformed
        assert responses[1]["success"] is True   # valid

    def test_eof_clean_exit(self):
        """Empty stdin causes clean exit (return code 0)."""
        proc = subprocess.Popen(
            ["python3", WRAPPER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        stdout, stderr = proc.communicate(input=b"", timeout=5)
        assert proc.returncode == 0
        assert stdout == b""

    def test_acquire_token(self):
        """acquire_token action returns mock access token."""
        responses, rc = _send_recv([{
            "action": "acquire_token",
            "scopes": ["openid"],
        }])
        assert len(responses) == 1
        assert responses[0]["success"] is True
        assert "accessToken" in responses[0]["data"]


class TestCliTestMode:
    """F34: Integration test for --test CLI mode."""

    def test_test_mode_outputs_version_and_cookie(self):
        """--test mode via mock wrapper prints broker version and redacted cookie."""
        proc = subprocess.Popen(
            ["python3", WRAPPER.replace("mock_broker_wrapper.py", "mock_broker_test_wrapper.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        stdout, stderr = proc.communicate(timeout=5)
        output = stdout.decode("utf-8")
        # Should contain version info and redacted cookie
        assert "Broker Version" in output or "linuxBrokerVersion" in output or "mock" in output.lower()
        assert proc.returncode == 0
