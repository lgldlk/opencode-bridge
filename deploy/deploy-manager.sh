#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
: "${MANAGER_ADMIN_KEY:?set MANAGER_ADMIN_KEY before deploying}"
: "${MANAGER_API_KEY:?set MANAGER_API_KEY before deploying}"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error("opencode manager requires Node.js >= 22.5 for node:sqlite"); process.exit(1); }'

install -d -m 0755 /opt/opencode-bridge
install -d -m 0755 /opt/opencode-bridge/src
install -d -m 0755 /opt/opencode-bridge/src/manager
install -d -m 0755 /opt/opencode-bridge/src/shared
install -d -m 0755 /opt/opencode-bridge/web
install -d -m 0700 /var/lib/opencode-bridge
install -m 0644 "$ROOT_DIR/../src/manager.ts" /opt/opencode-bridge/src/manager.ts
install -m 0644 "$ROOT_DIR/../src/manager/"*.ts /opt/opencode-bridge/src/manager/
install -m 0644 "$ROOT_DIR/../src/shared/"*.ts /opt/opencode-bridge/src/shared/
install -m 0644 "$ROOT_DIR/../web/admin.html" "$ROOT_DIR/../web/admin.css" "$ROOT_DIR/../web/admin.js" /opt/opencode-bridge/web/
install -m 0644 "$ROOT_DIR/../systemd/opencode-manager.service" /etc/systemd/system/opencode-manager.service

if [[ ! -e /etc/opencode-manager.env ]]; then
  umask 077
  cat > /etc/opencode-manager.env <<EOF
MANAGER_CONFIG=/etc/opencode-manager.json
MANAGER_USAGE_DB=${MANAGER_USAGE_DB:-/var/lib/opencode-bridge/usage.sqlite}
MANAGER_ADMIN_KEY=$MANAGER_ADMIN_KEY
MANAGER_API_KEY=$MANAGER_API_KEY
MANAGER_HOST=${MANAGER_HOST:-0.0.0.0}
MANAGER_PORT=${MANAGER_PORT:-8090}
MANAGER_REQUEST_TIMEOUT_MS=${MANAGER_REQUEST_TIMEOUT_MS:-3600000}
MANAGER_FIRST_DATA_TIMEOUT_MS=${MANAGER_FIRST_DATA_TIMEOUT_MS:-900000}
MANAGER_IDLE_DATA_TIMEOUT_MS=${MANAGER_IDLE_DATA_TIMEOUT_MS:-900000}
MANAGER_HEALTH_INTERVAL_MS=${MANAGER_HEALTH_INTERVAL_MS:-30000}
MANAGER_SESSION_AFFINITY_TTL_MS=${MANAGER_SESSION_AFFINITY_TTL_MS:-3600000}
MANAGER_SESSION_AFFINITY_MAX_ENTRIES=${MANAGER_SESSION_AFFINITY_MAX_ENTRIES:-10000}
EOF
fi
if ! grep -q '^MANAGER_USAGE_DB=' /etc/opencode-manager.env; then
  printf '%s\n' 'MANAGER_USAGE_DB=/var/lib/opencode-bridge/usage.sqlite' >> /etc/opencode-manager.env
fi
if [[ ! -e /etc/opencode-manager.json ]]; then
  umask 077
  printf '%s\n' '{"machines":[]}' > /etc/opencode-manager.json
fi

systemctl daemon-reload
systemctl enable --now opencode-manager.service
systemctl --no-pager --full status opencode-manager.service
