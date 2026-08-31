# OpenCode Bridge

[中文文档](README.zh-CN.md)

OpenCode Bridge is a small OpenAI-compatible gateway for self-hosted OpenCode
workers. A manager can route requests across multiple machine adapters and
handle health checks and rate-limit cooldowns.

## What It Does

- Discovers models from each OpenCode worker instead of hard-coding a model.
- Supports JSON and SSE Chat Completions requests.
- Routes requests by quota failover by default, with round-robin and random alternatives.
- Places rate-limited workers in a configurable cooldown period.
- Converts caller-provided tools into client-side `tool_calls`.
- Keeps file, shell, and edit execution on the calling client. Workers only
  perform model inference; a failed MCP bridge fails closed with `503`.

## Layout

```text
src/machine/   machine adapter and OpenCode client
src/manager/   routing, registry, and admin API
src/shared/    shared HTTP and auth helpers
web/            dependency-free admin console
config/         redacted configuration examples
deploy/         deployment scripts
test/           Node test suite
```

Requires Node.js 22.5+ (or Node.js 24+) and does not need production npm
dependencies. The manager stores token usage in SQLite.

## Quick Start

Install a machine adapter beside an OpenCode worker:

```sh
BRIDGE_KEY='replace-me' OPENCODE_PASSWORD='replace-me' ./deploy/deploy-machine.sh
```

Install the manager separately:

```sh
MANAGER_ADMIN_KEY='replace-me' MANAGER_API_KEY='replace-me' ./deploy/deploy-manager.sh
```

For SSH-based packaging and deployment, use `deploy/deploy-remote.sh` with a
host alias from your private SSH configuration.

Register workers through the protected admin API. Use your own private HTTPS
URL and identifiers; do not commit them:

```sh
curl -X PUT https://manager.example.invalid/admin/machines/machine-id-placeholder \
  -H 'Authorization: Bearer <admin-key>' \
  -H 'content-type: application/json' \
  -d '{"name":"display-name-placeholder","baseUrl":"https://machine.example.invalid","apiKey":"replace-with-machine-bridge-key"}'
```

The browser console is served at `/admin`. It stores the admin key only in the
current browser and sends it to the protected API.

## Client Contract

Point Pi or another OpenAI-compatible client at the manager HTTPS URL and use
model IDs returned by `GET /v1/models`. The manager forwards `messages`,
`tools`, `tool_choice`, assistant `tool_calls`, and tool results without saving
conversation content.

When a model proposes `read`, `write`, `edit`, or another caller tool, the
response is a standard OpenAI `tool_calls` response. The caller executes that
tool in its own local workspace and sends the result in the next request. The
bridge never extracts paths from user text and never falls back to remote
native tools.

## Development

```sh
npm test
npm run typecheck
```

Keep real keys, hostnames, machine IDs, URLs, local paths, and deployment
settings outside Git. Use the files under `config/` only as templates.

## License

[MIT](LICENSE)
