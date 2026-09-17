#!/usr/bin/env bash
# Enable already-configured example servers; never install or authenticate them.
set -euo pipefail

all=(computer-use workiq slack datadog kusto-mcp trino-mcp)
if [[ $# -eq 0 || "${1:-}" == "--help" ]]; then
  echo "Usage: bash scripts/enable-example-mcps.sh SERVER [SERVER ...] | --all"
  echo "Servers: ${all[*]}"
  echo "Configure only the connectors you trust first; see docs/FIRST-AGENT.md."
  exit 0
fi
if [[ "${1:-}" == "--all" && $# -eq 1 ]]; then
  set -- "${all[@]}"
fi
# Validate every argument before changing any configuration.
for server in "$@"; do
  case "$server" in
    computer-use|workiq|slack|datadog|kusto-mcp|trino-mcp) ;;
    *) echo "Unknown example server: $server" >&2; exit 2 ;;
  esac
done
command -v copilot >/dev/null || {
  echo "Install Copilot CLI and put copilot on PATH first." >&2
  exit 1
}

failed=0
for server in "$@"; do
  echo "Checking $server..."
  if ! copilot mcp get "$server"; then
    echo "NOT ENABLED: $server is unavailable; configure it using docs/FIRST-AGENT.md." >&2
    failed=1
    continue
  fi
  if ! copilot mcp enable "$server"; then
    echo "FAILED: could not enable $server. Review the CLI diagnostic above." >&2
    failed=1
    continue
  fi
  if ! copilot mcp get "$server"; then
    echo "FAILED: could not read back $server after enabling it." >&2
    failed=1
  fi
done
echo "Start a fresh agent session; authenticate and run a read-only probe for each server."
echo "Configuration checks are not proof that a server connected or its tools work."
if [[ "$failed" -ne 0 ]]; then
  echo "Some servers failed; successful changes remain enabled. Fix the failures and rerun." >&2
fi
exit "$failed"
