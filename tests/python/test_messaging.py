"""Tests for native messaging protocol: read_message, send_message."""

import io
import json
import struct
import sys

import pytest

from linux_entra_bridge import read_message, send_message


class TestReadMessage:
    def test_valid_message(self, monkeypatch):
        msg = {"action": "test", "data": "hello"}
        encoded = json.dumps(msg).encode("utf-8")
        buf = struct.pack("=I", len(encoded)) + encoded
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        result = read_message()
        assert result == msg

    def test_eof_exits(self, monkeypatch):
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(b"")))
        with pytest.raises(SystemExit) as exc_info:
            read_message()
        assert exc_info.value.code == 0

    def test_partial_read_exits(self, monkeypatch):
        """1-3 bytes followed by EOF treated as clean exit."""
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(b"\x01\x02")))
        with pytest.raises(SystemExit) as exc_info:
            read_message()
        assert exc_info.value.code == 0

    def test_message_too_large(self, monkeypatch):
        """Length > 1MB raises ValueError."""
        length = 2 * 1024 * 1024  # 2 MB
        buf = struct.pack("=I", length) + b"x" * 100  # don't actually allocate 2MB
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        with pytest.raises(ValueError, match="Message too large"):
            read_message()

    def test_exact_max_message_size_accepted(self, monkeypatch):
        """Message of exactly MAX_MESSAGE_SIZE (1MB) bytes is accepted."""
        msg = json.dumps({"data": "x" * (1048576 - 20)}).encode("utf-8")
        # Trim or pad to exactly 1048576 bytes
        msg = msg[:1048576] if len(msg) > 1048576 else msg + b" " * (1048576 - len(msg))
        buf = struct.pack("=I", len(msg)) + msg
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        # Should not raise ValueError (may raise JSONDecodeError from padded content, that's OK)
        try:
            read_message()
        except (json.JSONDecodeError, ValueError) as e:
            # ValueError for "too large" would be a bug — JSONDecodeError is expected from padding
            assert "too large" not in str(e).lower()

    def test_message_one_over_max_rejected(self, monkeypatch):
        """Message of MAX_MESSAGE_SIZE + 1 bytes is rejected."""
        length = 1048576 + 1
        buf = struct.pack("=I", length) + b"x" * 100
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        with pytest.raises(ValueError, match="Message too large"):
            read_message()

    def test_short_read_exits_cleanly(self, monkeypatch):
        """Header says 100 bytes but stdin only has 50 — clean exit (dead pipe)."""
        header = struct.pack("=I", 100)
        partial_body = b"x" * 50  # less than the 100 bytes promised
        buf = header + partial_body
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        with pytest.raises(SystemExit) as exc_info:
            read_message()
        assert exc_info.value.code == 0

    def test_unicode_message(self, monkeypatch):
        msg = {"text": "Ünïcödé 🎉"}
        encoded = json.dumps(msg).encode("utf-8")
        buf = struct.pack("=I", len(encoded)) + encoded
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        result = read_message()
        assert result["text"] == "Ünïcödé 🎉"

    def test_zero_length_message(self, monkeypatch):
        """Length = 0 means empty JSON string → JSONDecodeError."""
        buf = struct.pack("=I", 0)
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        with pytest.raises(json.JSONDecodeError):
            read_message()

    def test_invalid_json_message(self, monkeypatch):
        """Valid length but invalid JSON content → JSONDecodeError."""
        content = b"not{valid json"
        buf = struct.pack("=I", len(content)) + content
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        with pytest.raises(json.JSONDecodeError):
            read_message()
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(buf)))
        with pytest.raises(json.JSONDecodeError):
            read_message()


class TestSendMessage:
    def test_encodes_with_length_prefix(self):
        buf = io.BytesIO()
        stdout_wrapper = io.TextIOWrapper(buf)

        msg = {"result": "ok"}
        encoded = json.dumps(msg).encode("utf-8")
        expected = struct.pack("=I", len(encoded)) + encoded

        # Patch stdout
        orig_stdout = sys.stdout
        sys.stdout = stdout_wrapper
        try:
            send_message(msg)
        finally:
            sys.stdout = orig_stdout

        buf.seek(0)
        written = buf.read()
        assert written == expected

    def test_unicode_message(self):
        buf = io.BytesIO()
        stdout_wrapper = io.TextIOWrapper(buf)

        msg = {"emoji": "🔑"}
        orig_stdout = sys.stdout
        sys.stdout = stdout_wrapper
        try:
            send_message(msg)
        finally:
            sys.stdout = orig_stdout

        buf.seek(0)
        data = buf.read()
        length = struct.unpack("=I", data[:4])[0]
        payload = json.loads(data[4:4+length].decode("utf-8"))
        assert payload["emoji"] == "🔑"

    def test_oversized_response_truncated(self):
        """Response exceeding MAX_MESSAGE_SIZE is replaced with error."""
        buf = io.BytesIO()
        stdout_wrapper = io.TextIOWrapper(buf)

        # Create a message larger than 1MB
        msg = {"data": "x" * (1024 * 1024 + 100)}

        orig_stdout = sys.stdout
        sys.stdout = stdout_wrapper
        try:
            send_message(msg)
        finally:
            sys.stdout = orig_stdout

        buf.seek(0)
        data = buf.read()
        length = struct.unpack("=I", data[:4])[0]
        payload = json.loads(data[4:4+length].decode("utf-8"))
        assert payload["success"] is False
        assert "too large" in payload["error"].lower()
