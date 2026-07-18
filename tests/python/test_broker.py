"""Tests for broker client, URL validation, message handling, and v3 normalization."""

import json

import pytest

from linux_entra_bridge import (
    _validate_sso_url,
    _validate_account,
    _sanitize_account,
    _extract_account,
    _truncate,
    IdentityBrokerClient,
    handle_message,
)


# ===== _truncate =====

class TestTruncate:
    def test_short_string_unchanged(self):
        assert _truncate("hello") == "hello"

    def test_long_string_truncated(self):
        s = "x" * 201
        result = _truncate(s)
        assert len(result) == 201  # 200 + ellipsis
        assert result.endswith("\u2026")

    def test_non_string_converted(self):
        assert _truncate(42) == "42"
        assert _truncate(None) == "None"

    def test_empty_string(self):
        assert _truncate("") == ""

    def test_exactly_200_chars_unchanged(self):
        s = "a" * 200
        assert _truncate(s) == s


# ===== _validate_sso_url =====

class TestValidateSsoUrl:
    @pytest.mark.parametrize("url,expected", [
        ("https://login.microsoftonline.com/", True),
        ("https://login.microsoft.com/", True),
        ("https://login.live.com/", True),
        ("https://sub.login.microsoftonline.com/path", False),
        ("https://login.microsoftonline.com:443/", True),
        ("https://login.microsoftonline.com:8443/", False),
        ("https://user:pass@login.microsoftonline.com/", False),
        ("https://login.microsoftonline.com/?q=x", True),
        ("http://login.microsoftonline.com/", False),
        ("https://evil.com/", False),
        ("https://login.microsoftonline.com.evil.com/", False),
        ("", False),
        ("not-a-url", False),
        (None, False),
        ("ftp://login.microsoftonline.com/", False),
        ("javascript:alert(1)", False),
    ])
    def test_validate_sso_url(self, url, expected):
        assert _validate_sso_url(url) is expected


# ===== IdentityBrokerClient =====

class TestIdentityBrokerClient:
    def test_get_version(self, mock_iface):
        mock_iface.getLinuxBrokerVersion.return_value = json.dumps({
            "linuxBrokerVersion": "3.0.1"
        })
        client = IdentityBrokerClient()
        result = client.get_version()
        assert result["linuxBrokerVersion"] == "3.0.1"

    def test_get_accounts(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "user@example.com", "homeAccountId": "abc"}]
        })
        client = IdentityBrokerClient()
        result = client.get_accounts()
        assert len(result["accounts"]) == 1

    def test_acquire_prt_sso_cookie_v2(self, mock_iface):
        """v2 format: cookieName at top level."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential",
            "cookieContent": "jwt-content",
        })
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        assert result["cookieName"] == "x-ms-RefreshTokenCredential"
        assert result["cookieContent"] == "jwt-content"

    def test_acquire_prt_sso_cookie_v3(self, mock_iface):
        """v3 format: cookieItems array normalized to top level."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieItems": [{
                "cookieName": "x-ms-RefreshTokenCredential",
                "cookieContent": "jwt-v3",
            }]
        })
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        assert result["cookieName"] == "x-ms-RefreshTokenCredential"
        assert result["cookieContent"] == "jwt-v3"

    def test_acquire_prt_sso_cookie_v3_empty(self, mock_iface):
        """v3 with empty cookieItems — no normalization."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieItems": []
        })
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        assert "cookieName" not in result

    def test_acquire_prt_sso_cookie_v3_not_list(self, mock_iface):
        """v3 cookieItems is not a list — no normalization."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieItems": "not-a-list"
        })
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        assert "cookieName" not in result

    def test_acquire_prt_sso_cookie_v3_missing_keys(self, mock_iface):
        """v3 cookieItems[0] has no keys — normalize with empty strings."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieItems": [{}]
        })
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        assert result.get("cookieName") == ""
        assert result.get("cookieContent") == ""

    def test_get_default_account_no_accounts(self, mock_iface):
        """Raises RuntimeError when no accounts."""
        mock_iface.getAccounts.return_value = json.dumps({"accounts": []})
        client = IdentityBrokerClient()
        with pytest.raises(RuntimeError, match="No accounts found"):
            client._get_default_account()

    def test_get_default_account_dbus_failure(self, mock_iface, mock_dbus_module):
        """getAccounts D-Bus failure falls through to RuntimeError."""
        mock_iface.getAccounts.side_effect = mock_dbus_module.exceptions.DBusException("timeout")
        client = IdentityBrokerClient()
        with pytest.raises(RuntimeError, match="No accounts found"):
            client._get_default_account()
        mock_iface.getAccounts.side_effect = None

    def test_acquire_prt_sso_cookie_explicit_account(self, mock_iface):
        """Explicit account parameter skips _get_default_account."""
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential",
            "cookieContent": "jwt",
        })
        explicit_account = {"username": "explicit@test.com", "homeAccountId": "xyz"}
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/", account=explicit_account)
        assert result["cookieName"] == "x-ms-RefreshTokenCredential"
        # getAccounts should NOT have been called (explicit account used)
        mock_iface.getAccounts.assert_not_called()

    def test_acquire_token_silently_explicit_account(self, mock_iface):
        """Explicit account parameter for token acquisition."""
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        explicit_account = {"username": "user@test.com", "homeAccountId": "abc"}
        client = IdentityBrokerClient()
        result = client.acquire_token_silently(["openid"], account=explicit_account)
        assert result["accessToken"] == "tok"
        mock_iface.getAccounts.assert_not_called()


# ===== handle_message =====

class TestHandleMessage:
    def _make_client(self, mock_iface):
        return IdentityBrokerClient()

    def test_get_version(self, mock_iface):
        mock_iface.getLinuxBrokerVersion.return_value = json.dumps({"version": "3.0"})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_version"}, client)
        assert result["success"] is True
        assert is_dbus is False

    def test_get_accounts(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({"accounts": []})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_accounts"}, client)
        assert result["success"] is True
        assert is_dbus is False

    def test_get_prt_sso_cookie_default_url(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential",
            "cookieContent": "jwt",
        })
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_prt_sso_cookie"}, client)
        assert result["success"] is True

    def test_get_prt_sso_cookie_invalid_url(self, mock_iface):
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_prt_sso_cookie", "ssoUrl": "https://evil.com"}, client)
        assert result["success"] is False
        assert "Invalid" in result["error"]

    def test_get_prt_sso_cookie_http_url(self, mock_iface):
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_prt_sso_cookie", "ssoUrl": "http://login.microsoftonline.com/"}, client)
        assert result["success"] is False

    def test_acquire_token(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "acquire_token", "scopes": ["openid"]}, client)
        assert result["success"] is True

    def test_acquire_token_invalid_scopes_string(self, mock_iface):
        """scopes must be a list, not a string."""
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "acquire_token", "scopes": "openid"}, client)
        assert result["success"] is False
        assert "Invalid scopes" in result["error"]

    def test_acquire_token_invalid_scopes_non_string_items(self, mock_iface):
        """scopes items must be strings."""
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "acquire_token", "scopes": [123, True]}, client)
        assert result["success"] is False
        assert "Invalid scopes" in result["error"]

    def test_acquire_token_default_scopes(self, mock_iface):
        """acquire_token without scopes uses default ["openid", "profile"]."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "acquire_token"}, client)
        assert result["success"] is True
        # Verify default scopes were used (check the call to acquireTokenSilently)
        call_args = mock_iface.acquireTokenSilently.call_args
        request_json = json.loads(call_args[0][2])  # 3rd positional arg is JSON body
        assert request_json["authParameters"]["requestedScopes"] == ["openid", "profile"]

    def test_get_prt_sso_cookie_with_explicit_account(self, mock_iface):
        """get_prt_sso_cookie passes account from message to broker."""
        explicit = {"username": "u@e.com", "homeAccountId": "id"}
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential", "cookieContent": "jwt",
        })
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "get_prt_sso_cookie",
            "ssoUrl": "https://login.microsoftonline.com/",
            "account": explicit,
        }, client)
        assert result["success"] is True
        # getAccounts should NOT be called (explicit account used)
        mock_iface.getAccounts.assert_not_called()

    def test_acquire_token_with_explicit_account(self, mock_iface):
        """acquire_token passes account from message to broker."""
        explicit = {"username": "u@e.com", "homeAccountId": "id"}
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "acquire_token",
            "scopes": ["openid"],
            "account": explicit,
        }, client)
        assert result["success"] is True
        mock_iface.getAccounts.assert_not_called()

    def test_unknown_action(self, mock_iface):
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "unknown"}, client)
        assert result["success"] is False
        assert "Unknown" in result["error"]

    def test_no_action_key(self, mock_iface):
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({}, client)
        assert result["success"] is False
        assert result["error"] == "Unknown action"

    def test_dbus_exception_sanitized(self, mock_iface, mock_dbus_module):
        mock_iface.getLinuxBrokerVersion.side_effect = mock_dbus_module.exceptions.DBusException("D-Bus timeout on /com/microsoft/identity/broker1")
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_version"}, client)
        assert result["success"] is False
        assert result["error"] == "Broker communication error"
        assert is_dbus is True  # D-Bus error triggers reconnect flag

    def test_runtime_error_sanitized(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({"accounts": []})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_prt_sso_cookie"}, client)
        assert result["success"] is False
        assert result["error"] == "Broker operation failed"
        assert is_dbus is False  # RuntimeError does NOT trigger reconnect

    def test_sso_url_not_echoed_in_error(self, mock_iface):
        """ssoUrl should not appear in error message."""
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_prt_sso_cookie", "ssoUrl": "https://secret.internal.corp/"}, client)
        assert result["success"] is False
        assert "secret.internal.corp" not in result["error"]

    def test_generic_exception_sanitized(self, mock_iface):
        """Generic Exception (not DBus, not RuntimeError) returns generic message."""
        mock_iface.getLinuxBrokerVersion.side_effect = TypeError("unexpected type error " + "x" * 300)
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_version"}, client)
        assert result["success"] is False
        assert result["error"] == "Internal error"
        mock_iface.getLinuxBrokerVersion.side_effect = None

    def test_long_action_name_not_echoed(self, mock_iface):
        """Long action name not included in error response (generic message)."""
        client = self._make_client(mock_iface)
        long_action = "x" * 300
        result, is_dbus = handle_message({"action": long_action}, client)
        assert result["success"] is False
        assert result["error"] == "Unknown action"
        assert long_action[:50] not in result["error"]
        assert is_dbus is False

    def test_validate_sso_url_integer_input(self):
        """Non-string input handled gracefully."""
        assert _validate_sso_url(123) is False

    def test_broker_error_as_plain_string(self, mock_iface):
        """Broker error as string (not dict) does not crash."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "error": "Something went wrong"
        })
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        # Should not crash — error is a string, not a dict
        assert "cookieName" not in result or not result.get("cookieName")

    def test_acquire_token_silently_default_account(self, mock_iface):
        """acquire_token_silently with no explicit account uses _get_default_account."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = IdentityBrokerClient()
        result = client.acquire_token_silently(["openid"])
        assert result["accessToken"] == "tok"
        # getAccounts should have been called (default account)
        mock_iface.getAccounts.assert_called()

    def test_acquire_token_silently_uses_build_auth_params(self, mock_iface):
        """acquire_token_silently uses _build_auth_params helper (DRY refactor)."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = IdentityBrokerClient()
        client.acquire_token_silently(["custom.scope"])
        call_args = mock_iface.acquireTokenSilently.call_args
        request_json = json.loads(call_args[0][2])
        params = request_json["authParameters"]
        assert params["requestedScopes"] == ["custom.scope"]
        assert params["authorizationType"] == 1  # 1 = Cached Refresh Token (silent), not 8 (PRT cookie)
        assert params["requestOptions"] == [205, 202]
        assert params["clientId"] == "ecd6b820-32c2-49b6-98a6-444530e5a77a"


# ===== _validate_account =====

class TestValidateAccount:
    def test_valid_account(self):
        assert _validate_account({"homeAccountId": "abc", "username": "u@e.com"}) is True

    def test_valid_account_with_extra_fields(self):
        assert _validate_account({"homeAccountId": "abc", "username": "u@e.com", "name": "User"}) is True

    def test_rejects_string(self):
        assert _validate_account("not-a-dict") is False

    def test_rejects_list(self):
        assert _validate_account([{"homeAccountId": "a", "username": "b"}]) is False

    def test_rejects_none(self):
        assert _validate_account(None) is False

    def test_rejects_empty_homeAccountId(self):
        assert _validate_account({"homeAccountId": "", "username": "u@e.com"}) is False

    def test_rejects_empty_username(self):
        assert _validate_account({"homeAccountId": "abc", "username": ""}) is False

    def test_rejects_missing_homeAccountId(self):
        assert _validate_account({"username": "u@e.com"}) is False

    def test_rejects_missing_username(self):
        assert _validate_account({"homeAccountId": "abc"}) is False

    def test_rejects_non_string_homeAccountId(self):
        assert _validate_account({"homeAccountId": 123, "username": "u"}) is False

    def test_rejects_non_string_username(self):
        assert _validate_account({"homeAccountId": "abc", "username": 123}) is False

    def test_rejects_empty_dict(self):
        assert _validate_account({}) is False

    def test_rejects_integer(self):
        assert _validate_account(42) is False


# ===== _sanitize_account =====

class TestSanitizeAccount:
    def test_keeps_known_fields(self):
        acct = {"homeAccountId": "abc", "username": "u@e.com", "name": "User", "realm": "tenant"}
        result = _sanitize_account(acct)
        assert result == acct

    def test_strips_unknown_fields(self):
        acct = {"homeAccountId": "abc", "username": "u@e.com", "evil_field": "bad", "injected": True}
        result = _sanitize_account(acct)
        assert "evil_field" not in result
        assert "injected" not in result
        assert result["homeAccountId"] == "abc"
        assert result["username"] == "u@e.com"

    def test_strips_proto(self):
        acct = {"homeAccountId": "abc", "username": "u@e.com", "__proto__": {"admin": True}}
        result = _sanitize_account(acct)
        assert "__proto__" not in result

    def test_preserves_all_schema_fields(self):
        acct = {
            "homeAccountId": "abc", "username": "u@e.com", "name": "User",
            "localAccountId": "local", "realm": "tenant", "environment": "login.microsoftonline.com",
            "additionalFields": {"extra": True},
        }
        result = _sanitize_account(acct)
        assert result == acct

    def test_empty_dict(self):
        assert _sanitize_account({}) == {}


# ===== Account validation in handle_message =====

class TestHandleMessageAccountValidation:
    def _make_client(self, mock_iface):
        return IdentityBrokerClient()

    def test_get_prt_sso_cookie_invalid_account_string(self, mock_iface):
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "get_prt_sso_cookie",
            "ssoUrl": "https://login.microsoftonline.com/",
            "account": "not-a-dict",
        }, client)
        assert result["success"] is False
        assert "Invalid account" in result["error"]

    def test_get_prt_sso_cookie_invalid_account_missing_fields(self, mock_iface):
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "get_prt_sso_cookie",
            "ssoUrl": "https://login.microsoftonline.com/",
            "account": {"invalid": True},
        }, client)
        assert result["success"] is False
        assert "Invalid account" in result["error"]

    def test_get_prt_sso_cookie_account_none_ok(self, mock_iface):
        """account=None (omitted) uses default account — no validation error."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential", "cookieContent": "jwt",
        })
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "get_prt_sso_cookie",
        }, client)
        assert result["success"] is True

    def test_acquire_token_invalid_account(self, mock_iface):
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "acquire_token",
            "scopes": ["openid"],
            "account": {"noId": True},
        }, client)
        assert result["success"] is False
        assert "Invalid account" in result["error"]

    def test_acquire_token_account_none_ok(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "acquire_token",
            "scopes": ["openid"],
        }, client)
        assert result["success"] is True

    def test_get_prt_sso_cookie_account_sanitized(self, mock_iface):
        """Unknown account fields are stripped before forwarding to broker."""
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential", "cookieContent": "jwt",
        })
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({
            "action": "get_prt_sso_cookie",
            "ssoUrl": "https://login.microsoftonline.com/",
            "account": {"homeAccountId": "abc", "username": "u@e.com", "evil_injected": "bad"},
        }, client)
        assert result["success"] is True
        # Verify the account passed to broker has no unknown fields
        call_args = mock_iface.acquirePrtSsoCookie.call_args
        request_json = json.loads(call_args[0][2])
        account_in_request = request_json.get("account", {})
        assert "evil_injected" not in account_in_request
        assert account_in_request.get("homeAccountId") == "abc"


# ===== Scopes size limits =====

class TestScopesLimits:
    def _make_client(self, mock_iface):
        return IdentityBrokerClient()

    def test_51_scopes_rejected(self, mock_iface):
        client = self._make_client(mock_iface)
        result, _ = handle_message({
            "action": "acquire_token",
            "scopes": [f"scope{i}" for i in range(51)],
        }, client)
        assert result["success"] is False
        assert "size limits" in result["error"]

    def test_50_scopes_accepted(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = self._make_client(mock_iface)
        result, _ = handle_message({
            "action": "acquire_token",
            "scopes": [f"scope{i}" for i in range(50)],
        }, client)
        assert result["success"] is True

    def test_scope_257_chars_rejected(self, mock_iface):
        client = self._make_client(mock_iface)
        result, _ = handle_message({
            "action": "acquire_token",
            "scopes": ["x" * 257],
        }, client)
        assert result["success"] is False
        assert "size limits" in result["error"]

    def test_scope_256_chars_accepted(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = self._make_client(mock_iface)
        result, _ = handle_message({
            "action": "acquire_token",
            "scopes": ["x" * 256],
        }, client)
        assert result["success"] is True


# ===== Error sanitization =====

class TestErrorSanitization:
    def _make_client(self, mock_iface):
        return IdentityBrokerClient()

    def test_dbus_error_returns_generic_message(self, mock_iface, mock_dbus_module):
        mock_iface.getLinuxBrokerVersion.side_effect = mock_dbus_module.exceptions.DBusException(
            "org.freedesktop.DBus.Error.ServiceUnknown: details"
        )
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_version"}, client)
        assert result["success"] is False
        assert result["error"] == "Broker communication error"
        assert is_dbus is True
        mock_iface.getLinuxBrokerVersion.side_effect = None

    def test_dbus_error_no_internal_details(self, mock_iface, mock_dbus_module):
        """D-Bus error response must NOT contain org.freedesktop, paths, etc."""
        mock_iface.getLinuxBrokerVersion.side_effect = mock_dbus_module.exceptions.DBusException(
            "org.freedesktop.DBus.Error.Timeout on /com/microsoft/identity/broker1"
        )
        client = self._make_client(mock_iface)
        result, _ = handle_message({"action": "get_version"}, client)
        assert "freedesktop" not in result["error"]
        assert "/com/" not in result["error"]
        mock_iface.getLinuxBrokerVersion.side_effect = None

    def test_runtime_error_returns_generic_message(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({"accounts": []})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_prt_sso_cookie"}, client)
        assert result["success"] is False
        assert result["error"] == "Broker operation failed"
        assert is_dbus is False

    def test_generic_exception_returns_generic_message(self, mock_iface):
        mock_iface.getLinuxBrokerVersion.side_effect = TypeError("unexpected type error with internal details")
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_version"}, client)
        assert result["success"] is False
        assert result["error"] == "Internal error"
        assert "unexpected" not in result["error"]
        assert is_dbus is False
        mock_iface.getLinuxBrokerVersion.side_effect = None


# ===== _extract_account =====

class TestExtractAccount:
    def test_valid_account_returns_sanitized(self):
        msg = {"account": {"homeAccountId": "abc", "username": "u@e.com", "evil": "bad"}}
        safe, err = _extract_account(msg)
        assert err is None
        assert safe["homeAccountId"] == "abc"
        assert safe["username"] == "u@e.com"
        assert "evil" not in safe

    def test_no_account_key_returns_none(self):
        safe, err = _extract_account({})
        assert err is None
        assert safe is None

    def test_explicit_none_returns_none(self):
        safe, err = _extract_account({"account": None})
        assert err is None
        assert safe is None

    def test_invalid_account_returns_error_tuple(self):
        safe, err = _extract_account({"account": "not-a-dict"})
        assert safe is None
        assert err is not None
        response, is_dbus = err
        assert response["success"] is False
        assert "Invalid account" in response["error"]
        assert is_dbus is False

    def test_account_missing_required_fields(self):
        safe, err = _extract_account({"account": {"invalid": True}})
        assert safe is None
        assert err is not None


# ===== get_status action =====

class TestHandleMessageGetStatus:
    def _make_client(self, mock_iface):
        return IdentityBrokerClient()

    def test_get_status_success(self, mock_iface):
        mock_iface.getLinuxBrokerVersion.return_value = json.dumps({"linuxBrokerVersion": "3.0.1"})
        mock_iface.getAccounts.return_value = json.dumps({"accounts": [{"username": "u@e.com", "homeAccountId": "id"}]})
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_status"}, client)
        assert result["success"] is True
        assert result["data"]["version"]["linuxBrokerVersion"] == "3.0.1"
        assert len(result["data"]["accounts"]["accounts"]) == 1
        assert is_dbus is False

    def test_get_status_dbus_error_on_get_version(self, mock_iface, mock_dbus_module):
        mock_iface.getLinuxBrokerVersion.side_effect = mock_dbus_module.exceptions.DBusException("timeout")
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_status"}, client)
        assert result["success"] is False
        assert result["error"] == "Broker communication error"
        assert is_dbus is True
        mock_iface.getLinuxBrokerVersion.side_effect = None

    def test_get_status_dbus_error_on_get_accounts(self, mock_iface, mock_dbus_module):
        mock_iface.getLinuxBrokerVersion.return_value = json.dumps({"linuxBrokerVersion": "3.0.1"})
        mock_iface.getAccounts.side_effect = mock_dbus_module.exceptions.DBusException("timeout")
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": "get_status"}, client)
        assert result["success"] is False
        assert result["error"] == "Broker communication error"
        assert is_dbus is True
        mock_iface.getAccounts.side_effect = None


# ===== QA CRITICAL/HIGH: _build_auth_params sso_url parameter =====

class TestBuildAuthParamsSsoUrl:
    def test_sso_url_present_when_provided(self, mock_iface):
        client = IdentityBrokerClient()
        account = {"homeAccountId": "id", "username": "u@e.com"}
        params = client._build_auth_params(account, sso_url="https://login.microsoftonline.com/")
        assert "ssoUrl" in params
        assert params["ssoUrl"] == "https://login.microsoftonline.com/"

    def test_sso_url_absent_when_not_provided(self, mock_iface):
        client = IdentityBrokerClient()
        account = {"homeAccountId": "id", "username": "u@e.com"}
        params = client._build_auth_params(account, scopes=["openid"])
        assert "ssoUrl" not in params


# ===== QA CRITICAL/HIGH: empty scopes =====

class TestEmptyScopes:
    def test_empty_scopes_accepted(self, mock_iface):
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = IdentityBrokerClient()
        result, is_dbus = handle_message({"action": "acquire_token", "scopes": []}, client)
        assert result["success"] is True


# ===== QA DEFERRED: broker dict error context =====

class TestBrokerErrorContext:
    def test_dict_error_context_in_response(self, mock_iface):
        """Broker error with dict context: response has error, no cookie."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "error": {"context": "conditional access required"}
        })
        client = IdentityBrokerClient()
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        assert "cookieName" not in result or not result.get("cookieName")


# ===== LOW/INFO: explicit action:None + default scopes =====

class TestLowInfoGaps:
    def _make_client(self, mock_iface):
        return IdentityBrokerClient()

    def test_action_none_returns_unknown(self, mock_iface):
        """Explicit action: None behaves same as missing action."""
        client = self._make_client(mock_iface)
        result, is_dbus = handle_message({"action": None}, client)
        assert result["success"] is False
        assert result["error"] == "Unknown action"

    def test_build_auth_params_default_scopes(self, mock_iface):
        """When scopes=None, default is graph.microsoft.com/.default."""
        client = IdentityBrokerClient()
        account = {"homeAccountId": "id", "username": "u@e.com"}
        params = client._build_auth_params(account)
        assert params["requestedScopes"] == ["https://graph.microsoft.com/.default"]
