#!/usr/bin/env python3
"""Native Messaging Host for Entra ID SSO on Linux.

Communicates with the microsoft-identity-broker D-Bus service to obtain
PRT SSO cookies and tokens for Entra ID authentication.

Logging goes to stderr (native messaging uses stdin/stdout exclusively).
Set ENTRA_SSO_DEBUG=1 for verbose output.
"""

import json
import logging
import os
import struct
import sys
import time
import uuid
from urllib.parse import urlparse

import dbus

log = logging.getLogger("entra-sso")

BROKER_BUS_NAME = "com.microsoft.identity.broker1"
BROKER_OBJECT_PATH = "/com/microsoft/identity/broker1"
BROKER_INTERFACE = "com.microsoft.identity.Broker1"

PROTOCOL_VERSION = "0.0"  # Broker protocol version (observed via dbus-monitor on Edge)
DBUS_TIMEOUT = 10  # seconds
MAX_MESSAGE_SIZE = 1_048_576  # 1 MB (Chrome/Firefox native messaging limit)

# Edge's client ID and redirect URI (reverse-engineered via dbus-monitor)
EDGE_CLIENT_ID = "ecd6b820-32c2-49b6-98a6-444530e5a77a"
EDGE_REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient"

# MSAL C++ version reported to the broker (must match what Edge sends)
MSAL_CPP_VERSION = "1.31.0"

# Observed from Edge D-Bus calls — undocumented protocol constants
EDGE_REQUEST_OPTIONS = [205, 202]
EDGE_AUTH_TYPE = 8

ALLOWED_SSO_HOSTS = frozenset({
    "login.microsoftonline.com",
    "login.microsoft.com",
    "login.live.com",
})


def _truncate(s, max_len=200):
    """Truncate string for safe error reporting."""
    s = str(s)
    return s[:max_len] + "\u2026" if len(s) > max_len else s


def _validate_sso_url(url: str) -> bool:
    """Only allow HTTPS URLs to known Microsoft SSO hosts (default port only)."""
    try:
        parsed = urlparse(url)
        return (parsed.scheme == "https" and
                not parsed.username and
                parsed.port in (None, 443) and
                parsed.hostname in ALLOWED_SSO_HOSTS)
    except Exception:
        return False


class IdentityBrokerClient:
    """Client for the Microsoft Identity Broker D-Bus API.

    D-Bus method signature: all methods take (string, string, string)
    and return string.

    Parameter format (reverse-engineered via dbus-monitor on Edge):
      param1: protocol version string ("0.0")
      param2: correlation UUID (random per request)
      param3: JSON request body
    """

    def __init__(self):
        self.bus = dbus.SessionBus()
        self.broker = self.bus.get_object(BROKER_BUS_NAME, BROKER_OBJECT_PATH)
        self.iface = dbus.Interface(self.broker, BROKER_INTERFACE)
        log.debug("D-Bus connection established")

    @staticmethod
    def _correlation_id() -> str:
        return str(uuid.uuid4())

    def get_version(self) -> dict:
        """Get the broker version."""
        log.debug("Calling getLinuxBrokerVersion")
        result = self.iface.getLinuxBrokerVersion(
            PROTOCOL_VERSION,
            self._correlation_id(),
            json.dumps({"msalCppVersion": MSAL_CPP_VERSION}),
            timeout=DBUS_TIMEOUT
        )
        return json.loads(result)

    def get_accounts(self) -> dict:
        """Get all accounts registered with the broker."""
        log.debug("Calling getAccounts")
        request = json.dumps({
            "clientId": EDGE_CLIENT_ID,
            "redirectUri": EDGE_REDIRECT_URI,
            "environment": "login.microsoftonline.com"
        })
        result = self.iface.getAccounts(
            PROTOCOL_VERSION,
            self._correlation_id(),
            request,
            timeout=DBUS_TIMEOUT
        )
        return json.loads(result)

    def _build_auth_params(self, account, scopes=None, sso_url=None):
        """Build the authParameters dict for D-Bus broker calls.

        authorizationType: 8 = PRT SSO Cookie, 1 = Cached Refresh Token (silent token)
        """
        auth_type = EDGE_AUTH_TYPE if sso_url else 1  # 8 for PRT cookie, 1 for token
        params = {
            "account": account,
            "additionalQueryParametersForAuthorization": {},
            "authority": "https://login.microsoftonline.com/common",
            "authorizationType": auth_type,
            "clientId": EDGE_CLIENT_ID,
            "enrollmentId": "",
            "isTestMode": False,
            "popParams": None,
            "redirectUri": EDGE_REDIRECT_URI,
            "requestOptions": EDGE_REQUEST_OPTIONS,
            "requestedScopes": scopes if scopes is not None else ["https://graph.microsoft.com/.default"],
            "username": account.get("username", ""),
            "uxContextHandle": -1
        }
        if sso_url:
            params["ssoUrl"] = sso_url
        return params

    def acquire_prt_sso_cookie(self, sso_url: str, account: dict = None) -> dict:
        """Acquire a PRT SSO cookie for the given URL.

        Returns dict with cookieName, cookieContent, account, error, telemetry.
        """
        if account is None:
            account = self._get_default_account()

        request = {
            "account": account,
            "authParameters": self._build_auth_params(account, sso_url=sso_url),
            "mamEnrollment": False,
            "ssoUrl": sso_url
        }

        log.debug("Calling acquirePrtSsoCookie for %s", urlparse(sso_url).hostname)
        result = self.iface.acquirePrtSsoCookie(
            PROTOCOL_VERSION,
            self._correlation_id(),
            json.dumps(request),
            timeout=DBUS_TIMEOUT
        )
        data = json.loads(result)

        # Broker v3 wraps cookies in a cookieItems array; normalize to
        # the v2 top-level cookieName/cookieContent format so the
        # extension doesn't need to know about the difference.
        if "cookieItems" in data and not data.get("cookieName"):
            items = data["cookieItems"]
            if items and isinstance(items, list) and len(items) > 0:
                data["cookieName"] = items[0].get("cookieName", "")
                data["cookieContent"] = items[0].get("cookieContent", "")
                log.debug("Normalized cookieItems[0] to top-level fields (broker v3)")

        if data.get("cookieName"):
            log.debug("Got PRT cookie: %s (%d chars)", data["cookieName"], len(data.get("cookieContent", "")))
        elif data.get("error"):
            context = data["error"].get("context", "unknown") if isinstance(data.get("error"), dict) else "unknown"
            log.warning("Broker error: %s", _truncate(context))

        return data

    def acquire_token_silently(self, scopes: list, account: dict = None) -> dict:
        """Acquire a token silently (no user interaction)."""
        if account is None:
            account = self._get_default_account()

        request = {
            "authParameters": self._build_auth_params(account, scopes=scopes),
        }

        log.debug("Calling acquireTokenSilently")
        result = self.iface.acquireTokenSilently(
            PROTOCOL_VERSION,
            self._correlation_id(),
            json.dumps(request),
            timeout=DBUS_TIMEOUT
        )
        return json.loads(result)

    def _get_default_account(self) -> dict:
        """Get the first account from the broker."""
        try:
            result = self.get_accounts()
            accounts = result.get("accounts", [])
            if accounts:
                log.info("Using default account (1 of %d)", len(accounts))
                return accounts[0]
            log.warning("getAccounts returned no accounts")
        except Exception as e:
            log.warning("getAccounts failed: %s", _truncate(e))

        raise RuntimeError(
            "No accounts found in identity broker. "
            "Is the device enrolled in Intune? "
            "Try signing in with Edge first."
        )


# --- Native Messaging Protocol ---

def read_message() -> dict:
    """Read a message from the WebExtension via stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        sys.exit(0)
    length = struct.unpack("=I", raw_length)[0]
    if length > MAX_MESSAGE_SIZE:
        raise ValueError(f"Message too large: {length}")
    message_bytes = sys.stdin.buffer.read(length)
    if len(message_bytes) < length:
        sys.exit(0)  # stdin closed mid-message — clean exit (same as EOF)
    return json.loads(message_bytes.decode("utf-8"))


def send_message(message: dict):
    """Send a message to the WebExtension via stdout."""
    encoded = json.dumps(message).encode("utf-8")
    if len(encoded) > MAX_MESSAGE_SIZE:
        log.warning("Response too large (%d bytes), truncating error", len(encoded))
        encoded = json.dumps({"success": False, "error": "Response too large"}).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _validate_account(account):
    """Validate account has required fields (homeAccountId, username as non-empty strings)."""
    return (isinstance(account, dict) and
            isinstance(account.get("homeAccountId"), str) and
            len(account["homeAccountId"]) > 0 and
            isinstance(account.get("username"), str) and
            len(account["username"]) > 0)


# Allowlist of account fields from the broker's Account.json schema.
# Only these fields are forwarded to D-Bus; any unknown/injected fields are stripped.
_ALLOWED_ACCOUNT_KEYS = frozenset([
    "homeAccountId", "username", "name", "localAccountId",
    "realm", "environment", "additionalFields",
])


def _sanitize_account(account):
    """Strip account fields not in the broker schema."""
    return {k: v for k, v in account.items() if k in _ALLOWED_ACCOUNT_KEYS}


def _extract_account(message):
    """Extract, validate, and sanitize account from a message.

    Returns (safe_account_or_None, error_tuple_or_None).
    error_tuple is (response_dict, is_dbus_bool) for handle_message early return.
    """
    account = message.get("account")
    if account is not None and not _validate_account(account):
        return None, ({"success": False, "error": "Invalid account format"}, False)
    safe_account = _sanitize_account(account) if account is not None else None
    return safe_account, None


def handle_message(message: dict, client: IdentityBrokerClient) -> tuple:
    """Handle a message from the WebExtension.

    Returns (response_dict, is_dbus_error) tuple. The is_dbus_error flag
    signals to main() that the D-Bus client should be dropped for reconnect.
    """
    action = message.get("action")
    log.debug("Action: %s", action)

    try:
        if action == "get_version":
            return {"success": True, "data": client.get_version()}, False

        elif action == "get_accounts":
            return {"success": True, "data": client.get_accounts()}, False

        elif action == "get_status":
            version_data = client.get_version()
            accounts_data = client.get_accounts()
            return {"success": True, "data": {"version": version_data, "accounts": accounts_data}}, False

        elif action == "get_prt_sso_cookie":
            sso_url = message.get("ssoUrl", "https://login.microsoftonline.com/")
            if not _validate_sso_url(sso_url):
                log.warning("Rejected invalid ssoUrl domain")
                return {"success": False, "error": "Invalid ssoUrl domain"}, False
            safe_account, err = _extract_account(message)
            if err is not None:
                return err
            return {"success": True, "data": client.acquire_prt_sso_cookie(sso_url, safe_account)}, False

        elif action == "acquire_token":
            scopes = message.get("scopes", ["openid", "profile"])
            if not isinstance(scopes, list) or not all(isinstance(s, str) for s in scopes):
                return {"success": False, "error": "Invalid scopes: must be a list of strings"}, False
            if len(scopes) > 50 or any(len(s) > 256 for s in scopes):
                return {"success": False, "error": "Scopes exceed size limits"}, False
            safe_account, err = _extract_account(message)
            if err is not None:
                return err
            return {"success": True, "data": client.acquire_token_silently(scopes, safe_account)}, False

        else:
            log.warning("Rejected unknown action: %s", _truncate(action))
            return {"success": False, "error": "Unknown action"}, False

    except dbus.exceptions.DBusException as e:
        log.error("D-Bus error: %s", _truncate(e))
        return {"success": False, "error": "Broker communication error"}, True
    except RuntimeError as e:
        log.error("%s", _truncate(e))
        return {"success": False, "error": "Broker operation failed"}, False
    except Exception as e:
        log.error("Unexpected error: %s", _truncate(e))
        return {"success": False, "error": "Internal error"}, False


def _create_client() -> IdentityBrokerClient:
    """Create a new broker client; caller handles logging."""
    return IdentityBrokerClient()


def main():
    """Main loop: read messages from WebExtension, dispatch to broker, respond."""
    client = None

    while True:
        try:
            message = read_message()
        except (SystemExit, KeyboardInterrupt):
            break  # stdin closed (EOF) or signal — normal exit
        except (json.JSONDecodeError, ValueError, UnicodeDecodeError) as e:
            # Malformed or oversized message — send error and continue
            log.warning("Bad message: %s", _truncate(e))
            send_message({"success": False, "error": "Malformed message"})
            continue
        except Exception:
            log.warning("Unexpected read error, exiting")
            break  # unexpected error — exit

        # Lazy-init or reconnect
        if client is None:
            try:
                client = _create_client()
            except Exception as e:
                log.error("Cannot connect to identity broker: %s", _truncate(e))
                send_message({"success": False, "error": "Cannot connect to identity broker D-Bus service"})
                continue

        response, is_dbus_error = handle_message(message, client)

        # On D-Bus error, drop client so next message reconnects
        if is_dbus_error:
            log.info("Dropping D-Bus connection for reconnect")
            client = None

        send_message(response)


def _setup_logging():
    """Configure logging to stderr with UTC ISO 8601 timestamps."""
    if log.handlers:
        return  # Idempotency guard — prevent duplicate handlers on re-import
    level = logging.DEBUG if os.environ.get("ENTRA_SSO_DEBUG") == "1" else logging.WARNING
    handler = logging.StreamHandler(sys.stderr)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s",
                                  datefmt="%Y-%m-%dT%H:%M:%SZ")
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    log.addHandler(handler)
    log.setLevel(level)


if __name__ == "__main__":
    _setup_logging()

    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        log.setLevel(logging.DEBUG)
        client = _create_client()
        print("=== Broker Version ===")
        print(json.dumps(client.get_version(), indent=2))
        print("\n=== Accounts ===")
        print(json.dumps(client.get_accounts(), indent=2))
        print("\n=== PRT SSO Cookie ===")
        result = client.acquire_prt_sso_cookie("https://login.microsoftonline.com/")
        # Redact cookie content for security (handles both v2 and v3 formats)
        display = dict(result)
        if display.get("cookieContent"):
            display["cookieContent"] = f"[{len(display['cookieContent'])} chars]"
        if display.get("cookieItems"):
            display["cookieItems"] = [
                {**item, "cookieContent": f"[{len(item.get('cookieContent', ''))} chars]"}
                for item in display["cookieItems"]
            ]
        print(json.dumps(display, indent=2))
    else:
        main()
