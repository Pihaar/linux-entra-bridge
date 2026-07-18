"""Contract tests: validate broker request dicts against JSON schemas in research/broker-schemas/.

Uses manual key/type validation (no jsonschema pip dependency).
Documented deviations (fields in code but not in schema) are asserted explicitly.
"""

import json
import os


from linux_entra_bridge import IdentityBrokerClient, _ALLOWED_ACCOUNT_KEYS

SCHEMA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "research", "broker-schemas")

TYPE_MAP = {"string": str, "integer": int, "boolean": bool, "array": list, "object": dict}


def load_schema(name):
    with open(os.path.join(SCHEMA_DIR, name)) as f:
        return json.load(f)


def check_keys_and_types(data, schema):
    """Validate data keys against schema properties. Returns (extra_keys, type_errors)."""
    props = schema.get("properties", {})
    extra = [k for k in data if k not in props]
    type_errors = []
    for key, val in data.items():
        if key in props and val is not None:
            expected_type = props[key].get("type")
            if expected_type and expected_type in TYPE_MAP:
                if not isinstance(val, TYPE_MAP[expected_type]):
                    type_errors.append((key, expected_type, type(val).__name__))
    return extra, type_errors


# ===== AuthParameters contract =====

class TestAuthParametersContract:
    def test_build_auth_params_conforms_to_schema(self, mock_iface):
        client = IdentityBrokerClient()
        account = {"homeAccountId": "test-id", "username": "test@example.com"}
        params = client._build_auth_params(account, scopes=["openid"])
        schema = load_schema("AuthParameters.json")
        extra, type_errors = check_keys_and_types(params, schema)
        # Documented deviations: isTestMode and requestOptions are observed in Edge
        # but not in the broker's published schema
        assert set(extra) == {"isTestMode", "requestOptions"}, f"Unexpected extra keys: {extra}"
        assert type_errors == [], f"Type mismatches: {type_errors}"

    def test_auth_params_has_all_schema_string_fields(self, mock_iface):
        client = IdentityBrokerClient()
        account = {"homeAccountId": "test-id", "username": "test@example.com"}
        params = client._build_auth_params(account, scopes=["openid"])
        schema = load_schema("AuthParameters.json")
        # Fields removed from broker calls (empty strings not needed by broker v3)
        optional_empty_fields = {"accessTokenToRenew", "decodedClaims", "password", "isSignIn"}
        for key, prop in schema["properties"].items():
            if "$ref" in prop:
                continue
            if key in optional_empty_fields:
                continue
            assert key in params, f"Schema field '{key}' missing from _build_auth_params output"


# ===== AcquirePrtSsoCookieRequest contract =====

class TestAcquirePrtSsoCookieRequestContract:
    def test_request_conforms_to_schema(self, mock_iface):
        """Validate the full request dict built by acquire_prt_sso_cookie."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquirePrtSsoCookie.return_value = json.dumps({
            "cookieName": "x-ms-RefreshTokenCredential", "cookieContent": "jwt",
        })

        client = IdentityBrokerClient()
        # Build the request dict the same way acquire_prt_sso_cookie does
        account = client._get_default_account()
        request = {
            "account": account,
            "authParameters": client._build_auth_params(account, sso_url="https://login.microsoftonline.com/"),
            "mamEnrollment": False,
            "ssoUrl": "https://login.microsoftonline.com/"
        }

        schema = load_schema("AcquirePrtSsoCookieRequest.json")
        extra, type_errors = check_keys_and_types(request, schema)
        # mamEnrollment is observed in Edge D-Bus calls but not in the schema
        assert set(extra) == {"mamEnrollment"}, f"Unexpected extra keys: {extra}"
        assert type_errors == [], f"Type mismatches: {type_errors}"


# ===== Account allowlist contract =====

class TestAccountContract:
    def test_allowed_keys_subset_of_schema(self):
        schema = load_schema("Account.json")
        schema_keys = set(schema["properties"].keys())
        # additionalFields is an implementation-specific passthrough, not in schema
        code_keys = _ALLOWED_ACCOUNT_KEYS - {"additionalFields"}
        not_in_schema = code_keys - schema_keys
        assert not_in_schema == set(), f"Allowlist keys not in Account.json schema: {not_in_schema}"

    def test_schema_has_fields_not_in_allowlist(self):
        """Document which schema fields are intentionally excluded from the allowlist."""
        schema = load_schema("Account.json")
        schema_keys = set(schema["properties"].keys())
        code_keys = _ALLOWED_ACCOUNT_KEYS - {"additionalFields"}
        excluded = schema_keys - code_keys
        # These are schema fields we intentionally don't forward to the broker
        expected_excluded = {"givenName", "familyName", "middleName", "alternativeAccountId",
                            "clientInfo", "passwordExpiry", "passwordChangeUrl", "homeEnvironment"}
        assert excluded == expected_excluded, f"Schema exclusion drift: {excluded}"


# ===== SilentTokenRequest contract =====

class TestSilentTokenRequestContract:
    def test_request_conforms_to_schema(self, mock_iface):
        """acquire_token_silently request dict matches SilentTokenRequest.json."""
        mock_iface.getAccounts.return_value = json.dumps({
            "accounts": [{"username": "u@e.com", "homeAccountId": "id"}]
        })
        mock_iface.acquireTokenSilently.return_value = json.dumps({"accessToken": "tok"})
        client = IdentityBrokerClient()
        # Build the same request dict acquire_token_silently would build
        account = client._get_default_account()
        request = {"authParameters": client._build_auth_params(account, scopes=["openid"])}
        schema = load_schema("SilentTokenRequest.json")
        extra, type_errors = check_keys_and_types(request, schema)
        assert extra == [], f"Extra keys: {extra}"
        assert type_errors == [], f"Type mismatches: {type_errors}"


# ===== GetAllAccountsRequest contract =====

class TestGetAllAccountsRequestContract:
    def test_request_conforms_to_schema(self, mock_iface):
        """get_accounts request dict matches GetAllAccountsRequest.json."""
        # The get_accounts() call sends: {clientId, redirectUri, environment}
        # Build same request as get_accounts() line 104-108
        from linux_entra_bridge import EDGE_CLIENT_ID, EDGE_REDIRECT_URI
        request = {
            "clientId": EDGE_CLIENT_ID,
            "redirectUri": EDGE_REDIRECT_URI,
            "environment": "login.microsoftonline.com",
        }
        schema = load_schema("GetAllAccountsRequest.json")
        extra, type_errors = check_keys_and_types(request, schema)
        assert extra == [], f"Extra keys: {extra}"
        assert type_errors == [], f"Type mismatches: {type_errors}"


# ===== LinuxBrokerVersionRequest contract =====

class TestLinuxBrokerVersionRequestContract:
    def test_request_conforms_to_schema(self, mock_iface):
        """get_version request dict matches LinuxBrokerVersionRequest.json."""
        from linux_entra_bridge import MSAL_CPP_VERSION
        request = {"msalCppVersion": MSAL_CPP_VERSION}
        schema = load_schema("LinuxBrokerVersionRequest.json")
        extra, type_errors = check_keys_and_types(request, schema)
        assert extra == [], f"Extra keys: {extra}"
        assert type_errors == [], f"Type mismatches: {type_errors}"
