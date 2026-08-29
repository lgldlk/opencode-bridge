# OpenCode Bridge

[中文文档](README.zh-CN.md)

An OpenAI-compatible gateway for self-hosted OpenCode instances. Deploy a
machine adapter next to each OpenCode server, then optionally run one manager
that exposes a single endpoint, discovers available models, monitors machine
health, and routes requests across registered machines.

The streaming path preserves the machine adapter's OpenAI-style SSE bytes. It
does not generate, modify, or buffer model output.

This project has two deployment roles:

```text
src/machine.ts   machine entry point
src/manager.ts   manager entry point
src/machine/     OpenCode client, model mapping, and completion handling
src/manager/     registry, admin API, and completion routing
src/shared/      shared HTTP and authentication utilities
web/             dependency-free browser admin console
deploy/          idempotent root deployment scripts
systemd/         service units
config/          non-secret examples
test/            Node built-in black-box tests
```

Runtime requires Node 22.6+ (`--experimental-strip-types`) or Node 24+.
There are no production npm dependencies.

`src/machine.ts` exposes the OpenAI-compatible subset used by most clients:

- `GET /v1/models`
- `POST /v1/chat/completions` (JSON and SSE-shaped streaming)
- `GET /health`

The bridge authenticates with `Authorization: Bearer <BRIDGE_KEY>` and talks
to OpenCode over its local Basic-auth HTTP API. Model ids are discovered from
OpenCode's `/provider` catalog. If `DEFAULT_MODEL` is empty and a request omits
`model`, the bridge uses OpenCode's catalog default (with a first-catalog-model
fallback); it never treats `opencode` as a model name. The systemd units are
intended to be installed on the OpenCode host; keep the generated env file mode
600.

## Manager and machine deployment

`src/manager.ts` is an optional control plane. It keeps an explicit machine registry,
polls `/health` and `/v1/models`, aggregates models, and fails over a completion
only when a machine is unreachable or returns `502`, `503`, or `504`. It does not
silently bypass `429` quota responses. The manager client API uses
`MANAGER_API_KEY`; registry changes use `MANAGER_ADMIN_KEY`.

Install the machine side as root on each OpenCode host:

```sh
BRIDGE_KEY='sk-...' OPENCODE_PASSWORD='...' ./deploy/deploy-machine.sh
```

For a regular user and a non-default bridge port, set deployment variables:

```sh
OPENCODE_RUN_USER=ubuntu PORT=18080 BRIDGE_KEY='sk-...' \
  OPENCODE_PASSWORD='...' ./deploy/deploy-machine.sh
```

This generates `opencode-<instance>.service`,
`opencode-bridge-<instance>.service`, and a matching
`/etc/opencode-bridge-<instance>.env`; an existing env file is never
overwritten. `OPENCODE_INSTANCE` defaults to the run user, and can preserve a
machine name used by an existing deployment:

```sh
OPENCODE_INSTANCE=machine-01 OPENCODE_RUN_USER=ubuntu PORT=18080 \
  BRIDGE_KEY='sk-...' OPENCODE_PASSWORD='...' ./deploy/deploy-machine.sh
```

Install the manager on one host:

```sh
MANAGER_ADMIN_KEY='...' MANAGER_API_KEY='...' ./deploy/deploy-manager.sh
```

Register a machine (`baseUrl` is the machine bridge root, without `/v1`):

```sh
curl -X PUT http://MANAGER:8090/admin/machines/sg-01 \
  -H 'Authorization: Bearer ADMIN_KEY' -H 'content-type: application/json' \
  -d '{"name":"machine-01","baseUrl":"https://machine-01.example.internal","apiKey":"sk-..."}'
```

The manager exposes the same `GET /v1/models` and `POST /v1/chat/completions`
paths as a machine, plus `GET /admin/machines` and per-machine `check`,
`enable`, and `disable` actions.

The browser console is available at `http://MANAGER:8090/admin`. It does not
embed credentials: enter `MANAGER_ADMIN_KEY` in the login prompt. The key is
kept only in that browser's local storage and is sent to the existing protected
admin API for list, check, enable/disable, and create/edit operations.

Operational commands:

```sh
npm test
npm run start:machine
npm run start:manager
```

The manager stores its registry in `/etc/opencode-manager.json` with mode 600.
Keep the manager API behind TLS or a private network; both manager keys and
machine bridge keys are bearer secrets and should be rotated independently.

Example request:

```sh
curl http://HOST:8080/v1/chat/completions \
  -H 'Authorization: Bearer sk-...' \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

To select a specific model, use an id returned by `/v1/models`, such as
`provider/model`.

Long-running requests are configured for up to 60 minutes by default. The
machine adapter uses `OPENCODE_REQUEST_TIMEOUT_MS`; the manager uses
`MANAGER_REQUEST_TIMEOUT_MS`. Keep these aligned with the client timeout.
