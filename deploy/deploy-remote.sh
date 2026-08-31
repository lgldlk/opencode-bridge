#!/usr/bin/env bash
set -Eeuo pipefail

# Package the current checkout, copy it to a remote host, and run the existing
# root installer there. The remote installer remains the single source of
# truth for systemd units and persistent environment files.

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy-remote.sh manager --target SSH_ALIAS [options]
  deploy-remote.sh machine --target SSH_ALIAS [options]

Required environment variables (or they will be read securely from the tty):
  manager: MANAGER_ADMIN_KEY, MANAGER_API_KEY
  machine: BRIDGE_KEY, OPENCODE_PASSWORD

Options:
  --target ALIAS             SSH host alias from ~/.ssh/config
  --ssh-option VALUE         Extra option passed to ssh/scp (repeatable)
  --instance NAME            Machine instance name (default: root)
  --run-user USER            OpenCode service user (default: root)
  --port PORT                Machine bridge port
  --host HOST                Machine bind host
  --opencode-url URL         Local OpenCode URL used by the machine adapter
  --opencode-directory DIR   OpenCode working directory
  --default-model MODEL      Optional provider/model default
  --manager-host HOST        Manager bind host (manager role)
  --manager-port PORT        Manager bind port (manager role)
  --usage-db PATH            SQLite usage database path (manager role)
  --request-timeout MS       Manager request timeout (manager role)
  --no-restart               Install files without restarting the service
  -h, --help                 Show this help

Examples:
  MANAGER_ADMIN_KEY=... MANAGER_API_KEY=... \
    deploy-remote.sh manager --target manager-host
  BRIDGE_KEY=... OPENCODE_PASSWORD=... \
    deploy-remote.sh machine --target worker-host --instance worker-a
USAGE
  exit 2
}

die() {
  printf 'deploy-remote: %s\n' "$*" >&2
  exit 1
}

role="${1:-}"
[[ "$role" == "manager" || "$role" == "machine" ]] || usage
shift

target=""
instance="root"
run_user="root"
machine_port=""
machine_host=""
opencode_url=""
opencode_directory=""
default_model=""
manager_host=""
manager_port=""
usage_db=""
request_timeout=""
restart=1
ssh_options=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || die "--target requires a value"
      target="$2"
      shift 2
      ;;
    --ssh-option)
      [[ $# -ge 2 ]] || die "--ssh-option requires a value"
      ssh_options+=("$2")
      shift 2
      ;;
    --instance)
      [[ $# -ge 2 ]] || die "--instance requires a value"
      instance="$2"
      shift 2
      ;;
    --run-user)
      [[ $# -ge 2 ]] || die "--run-user requires a value"
      run_user="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port requires a value"
      machine_port="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || die "--host requires a value"
      machine_host="$2"
      shift 2
      ;;
    --opencode-url)
      [[ $# -ge 2 ]] || die "--opencode-url requires a value"
      opencode_url="$2"
      shift 2
      ;;
    --opencode-directory)
      [[ $# -ge 2 ]] || die "--opencode-directory requires a value"
      opencode_directory="$2"
      shift 2
      ;;
    --default-model)
      [[ $# -ge 2 ]] || die "--default-model requires a value"
      default_model="$2"
      shift 2
      ;;
    --manager-host)
      [[ $# -ge 2 ]] || die "--manager-host requires a value"
      manager_host="$2"
      shift 2
      ;;
    --manager-port)
      [[ $# -ge 2 ]] || die "--manager-port requires a value"
      manager_port="$2"
      shift 2
      ;;
    --usage-db)
      [[ $# -ge 2 ]] || die "--usage-db requires a value"
      usage_db="$2"
      shift 2
      ;;
    --request-timeout)
      [[ $# -ge 2 ]] || die "--request-timeout requires a value"
      request_timeout="$2"
      shift 2
      ;;
    --no-restart)
      restart=0
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "$target" ]] || die "--target is required"
command -v ssh >/dev/null 2>&1 || die "ssh is required"
command -v scp >/dev/null 2>&1 || die "scp is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

read_secret() {
  local variable="$1"
  local prompt="$2"
  local value=""
  if [[ -n "${!variable:-}" ]]; then return; fi
  if [[ ! -t 0 || ! -t 1 ]]; then
    die "$variable is required in a non-interactive shell"
  fi
  printf '%s' "$prompt" >&2
  IFS= read -r -s value
  printf '\n' >&2
  printf -v "$variable" '%s' "$value"
}

if [[ "$role" == "manager" ]]; then
  read_secret MANAGER_ADMIN_KEY 'MANAGER_ADMIN_KEY: '
  read_secret MANAGER_API_KEY 'MANAGER_API_KEY: '
else
  read_secret BRIDGE_KEY 'BRIDGE_KEY: '
  read_secret OPENCODE_PASSWORD 'OPENCODE_PASSWORD: '
fi

repo_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
archive="$(mktemp "${TMPDIR:-/tmp}/opencode-bridge.XXXXXX.tgz")"
remote_archive="/tmp/opencode-bridge-deploy.tgz"
cleanup() {
  rm -f "$archive"
}
trap cleanup EXIT

tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.pi-glla' \
  --exclude='./OPERATIONS.local.md' \
  --exclude='*.env' \
  -czf "$archive" -C "$repo_dir" .

printf 'Uploading release to %s...\n' "$target" >&2
scp "${ssh_options[@]}" "$archive" "$target:$remote_archive"

shell_quote() {
  printf '%q' "$1"
}

remote_env=()
if [[ "$role" == "manager" ]]; then
  remote_env+=("MANAGER_ADMIN_KEY=$(shell_quote "$MANAGER_ADMIN_KEY")")
  remote_env+=("MANAGER_API_KEY=$(shell_quote "$MANAGER_API_KEY")")
  [[ -n "$manager_host" ]] && remote_env+=("MANAGER_HOST=$(shell_quote "$manager_host")")
  [[ -n "$manager_port" ]] && remote_env+=("MANAGER_PORT=$(shell_quote "$manager_port")")
  [[ -n "$usage_db" ]] && remote_env+=("MANAGER_USAGE_DB=$(shell_quote "$usage_db")")
  [[ -n "$request_timeout" ]] && remote_env+=("MANAGER_REQUEST_TIMEOUT_MS=$(shell_quote "$request_timeout")")
else
  remote_env+=("BRIDGE_KEY=$(shell_quote "$BRIDGE_KEY")")
  remote_env+=("OPENCODE_PASSWORD=$(shell_quote "$OPENCODE_PASSWORD")")
  [[ -n "$instance" ]] && remote_env+=("OPENCODE_INSTANCE=$(shell_quote "$instance")")
  [[ -n "$run_user" ]] && remote_env+=("OPENCODE_RUN_USER=$(shell_quote "$run_user")")
  [[ -n "$machine_port" ]] && remote_env+=("PORT=$(shell_quote "$machine_port")")
  [[ -n "$machine_host" ]] && remote_env+=("HOST=$(shell_quote "$machine_host")")
  [[ -n "$opencode_url" ]] && remote_env+=("OPENCODE_URL=$(shell_quote "$opencode_url")")
  [[ -n "$opencode_directory" ]] && remote_env+=("OPENCODE_DIRECTORY=$(shell_quote "$opencode_directory")")
  [[ -n "$default_model" ]] && remote_env+=("DEFAULT_MODEL=$(shell_quote "$default_model")")
fi

env_assignments="${remote_env[*]}"
if [[ "$role" == "manager" ]]; then
  service="opencode-manager.service"
  installer='deploy-manager.sh'
else
  safe_instance="${instance//[^A-Za-z0-9_.@-]/-}"
  [[ -n "$safe_instance" ]] || die "--instance must not be empty"
  if [[ "$run_user" == "root" && "$instance" == "root" ]]; then
    service="opencode-bridge.service"
  else
    service="opencode-bridge-${safe_instance}.service"
  fi
  installer='deploy-machine.sh'
fi

remote_script=$(cat <<EOF
set -Eeuo pipefail
release_dir=\$(mktemp -d /tmp/opencode-bridge-release.XXXXXX)
cleanup_remote() {
  rm -rf "\$release_dir" "$remote_archive"
}
trap cleanup_remote EXIT
tar -xzf "$remote_archive" -C "\$release_dir"
cd "\$release_dir"
sudo env $env_assignments ./deploy/$installer
EOF
)
if [[ "$restart" -eq 1 ]]; then
  remote_script+=$'\n'
  remote_script+="sudo systemctl restart $(shell_quote "$service")"
  remote_script+=$'\n'
  remote_script+="sudo systemctl is-active $(shell_quote "$service")"
  remote_script+=$'\n'
else
  remote_script+=$'\n'
  remote_script+="printf '%s\\n' 'Installed without restarting $service'"
  remote_script+=$'\n'
fi

printf 'Installing %s on %s...\n' "$role" "$target" >&2
ssh "${ssh_options[@]}" "$target" "bash -s" <<< "$remote_script"
printf 'Deployment complete: %s on %s\n' "$role" "$target" >&2
