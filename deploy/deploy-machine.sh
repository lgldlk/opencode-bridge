#!/usr/bin/env bash
set -Eeuo pipefail

# Idempotent machine-side installer. Run as root on the OpenCode host.
# Set OPENCODE_RUN_USER=ubuntu when OpenCode should run as a regular user.
ROOT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
: "${BRIDGE_KEY:?set BRIDGE_KEY before deploying}"
: "${OPENCODE_PASSWORD:?set OPENCODE_PASSWORD before deploying}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "deploy-machine.sh must run as root" >&2
  exit 1
fi

RUN_USER="${OPENCODE_RUN_USER:-root}"
if ! getent passwd "$RUN_USER" >/dev/null; then
  echo "unknown OPENCODE_RUN_USER: $RUN_USER" >&2
  exit 1
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [[ -z "$RUN_HOME" || ! -d "$RUN_HOME" ]]; then
  echo "home directory not found for $RUN_USER: $RUN_HOME" >&2
  exit 1
fi

INSTANCE_NAME="${OPENCODE_INSTANCE:-$RUN_USER}"
INSTANCE_SAFE="${INSTANCE_NAME//[^A-Za-z0-9_.@-]/-}"
[[ -n "$INSTANCE_SAFE" ]] || { echo "OPENCODE_INSTANCE must not be empty" >&2; exit 1; }

if [[ "$RUN_USER" == "root" && "$INSTANCE_NAME" == "root" ]]; then
  UNIT_SUFFIX=""
  ENV_FILE="/etc/opencode-bridge.env"
  OC_UNIT="opencode.service"
  BRIDGE_UNIT="opencode-bridge.service"
else
  # Keep the instance name safe when it becomes a systemd unit/file name.
  UNIT_SUFFIX="-$INSTANCE_SAFE"
  ENV_FILE="/etc/opencode-bridge${UNIT_SUFFIX}.env"
  OC_UNIT="opencode${UNIT_SUFFIX}.service"
  BRIDGE_UNIT="opencode-bridge${UNIT_SUFFIX}.service"
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -x "$NODE_BIN" ]] || { echo "node executable not found" >&2; exit 1; }
OPENCODE_BIN="${OPENCODE_BIN:-$RUN_HOME/.opencode/bin/opencode}"
if [[ ! -x "$OPENCODE_BIN" ]]; then
  OPENCODE_BIN="$(command -v opencode || true)"
fi
[[ -x "$OPENCODE_BIN" ]] || {
  echo "opencode executable not found; set OPENCODE_BIN" >&2
  exit 1
}

PORT_VALUE="${PORT:-8080}"
HOST_VALUE="${HOST:-0.0.0.0}"
OPENCODE_URL_VALUE="${OPENCODE_URL:-http://127.0.0.1:4096}"
OPENCODE_USERNAME_VALUE="${OPENCODE_USERNAME:-opencode}"
DIRECTORY_VALUE="${OPENCODE_DIRECTORY:-$RUN_HOME}"

install -d -m 0755 /opt/opencode-bridge
install -d -m 0755 /opt/opencode-bridge/src
install -m 0644 "$ROOT_DIR/../src/machine.ts" /opt/opencode-bridge/src/machine.ts

# The env file is deliberately write-once: rotating secrets is an explicit
# operator action and must not happen accidentally during a redeploy.
if [[ ! -e "$ENV_FILE" ]]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
BRIDGE_KEY=$BRIDGE_KEY
OPENCODE_PASSWORD=$OPENCODE_PASSWORD
OPENCODE_USERNAME=$OPENCODE_USERNAME_VALUE
OPENCODE_URL=$OPENCODE_URL_VALUE
OPENCODE_DIRECTORY=$DIRECTORY_VALUE
DEFAULT_MODEL=${DEFAULT_MODEL:-}
PORT=$PORT_VALUE
HOST=$HOST_VALUE
OPENCODE_SERVER_PASSWORD=$OPENCODE_PASSWORD
OPENCODE_SERVER_USERNAME=$OPENCODE_USERNAME_VALUE
OPENCODE_REQUEST_TIMEOUT_MS=${OPENCODE_REQUEST_TIMEOUT_MS:-3600000}
EOF
fi
chmod 600 "$ENV_FILE"

cat > "/etc/systemd/system/$OC_UNIT" <<EOF
[Unit]
Description=OpenCode headless server ($RUN_USER)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Environment=HOME=$RUN_HOME
WorkingDirectory=$DIRECTORY_VALUE
EnvironmentFile=$ENV_FILE
ExecStart=$OPENCODE_BIN serve --hostname 127.0.0.1 --port 4096
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/$BRIDGE_UNIT" <<EOF
[Unit]
Description=OpenAI compatible proxy for OpenCode ($RUN_USER)
After=$OC_UNIT
Requires=$OC_UNIT

[Service]
Type=simple
User=$RUN_USER
Environment=HOME=$RUN_HOME
WorkingDirectory=/opt/opencode-bridge
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN --experimental-strip-types /opt/opencode-bridge/src/machine.ts
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

chown -R root:root /opt/opencode-bridge
systemctl daemon-reload
systemctl enable --now "$OC_UNIT" "$BRIDGE_UNIT"
systemctl --no-pager --full status "$OC_UNIT" "$BRIDGE_UNIT"
