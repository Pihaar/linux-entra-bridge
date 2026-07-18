#!/bin/bash
# Capture D-Bus calls from Edge to the Microsoft Identity Broker.
#
# Usage:
#   1. Run this script in a terminal
#   2. In Edge, navigate to an Entra ID protected site (or clear cookies and re-login)
#   3. The script captures the D-Bus method calls and saves them
#
# This reveals the exact parameter format Edge uses, which we need to replicate.

set -euo pipefail

OUTPUT_FILE="broker-dbus-capture-$(date +%Y%m%d-%H%M%S).log"

echo "=== Microsoft Identity Broker D-Bus Capture ==="
echo ""
echo "Monitoring D-Bus calls to com.microsoft.identity.broker1"
echo "Output: $OUTPUT_FILE"
echo ""
echo "Now open Edge and navigate to an Entra ID protected site."
echo "Press Ctrl+C to stop capturing."
echo ""

dbus-monitor --session "destination='com.microsoft.identity.broker1'" 2>&1 | tee "$OUTPUT_FILE"
