# OpenCode Bridge

[English](README.md) | 中文

OpenCode Bridge 是给自托管 OpenCode 实例使用的 OpenAI 兼容网关。每台运行
OpenCode 的机器部署一个 `machine` 适配器；可选部署一个 `manager` 管理端，向
客户端提供单一 API 地址，并统一管理多台机器。

它适合将 Pi、OpenAI SDK 或其他兼容 Chat Completions API 的客户端接入 OpenCode，
同时保留多个后端机器的健康检查和故障切换能力。

## 架构

```text
兼容 OpenAI API 的客户端
          |
          v
  manager（可选，统一入口）
          |
          +--> machine-01 bridge --> 本机 OpenCode
          |
          +--> machine-02 bridge --> 本机 OpenCode
```

目录说明：

- `src/machine.ts`：单机 OpenCode 到 OpenAI API 的适配器。
- `src/manager.ts`：多机器注册、健康检查、模型聚合与路由。
- `web/`：无依赖的浏览器管理界面。
- `deploy/`：机器端和管理端部署脚本。
- `systemd/`：服务单元文件。
- `config/`：不含真实凭据的配置示例。
- `test/`：Node 内置测试。

运行需要 Node.js 22.6+（使用 `--experimental-strip-types`）或 Node.js 24+；生产
运行不依赖 npm 包。

## 提供的接口

机器端和管理端均提供：

- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /health`

机器端使用 `Authorization: Bearer <BRIDGE_KEY>` 鉴权，并通过本机的 Basic Auth
OpenCode API 获取模型目录。请求未指定 `model` 时，适配器会使用 OpenCode 目录中
的默认模型，绝不会把 `opencode` 误当作模型名称。

流式请求使用 SSE。管理端会立即发送 HTTP 响应头并保持连接存活，但不会生成、填充、
解析或改写模型输出；机器端发出的 OpenAI 风格 SSE 字节会原样转发给客户端。

## 快速部署

### 1. 在每台 OpenCode 机器部署 machine

以 root 执行：

```sh
BRIDGE_KEY='sk-...' OPENCODE_PASSWORD='...' ./deploy/deploy-machine.sh
```

指定运行用户和端口：

```sh
OPENCODE_RUN_USER=ubuntu PORT=18080 BRIDGE_KEY='sk-...' \
  OPENCODE_PASSWORD='...' ./deploy/deploy-machine.sh
```

脚本会创建相匹配的 OpenCode 服务、bridge 服务以及权限为 `0600` 的环境变量文件。
已有环境变量文件不会被脚本覆盖。

如果同一主机上有多个实例，设置明确的实例名：

```sh
OPENCODE_INSTANCE=machine-01 OPENCODE_RUN_USER=ubuntu PORT=18080 \
  BRIDGE_KEY='sk-...' OPENCODE_PASSWORD='...' ./deploy/deploy-machine.sh
```

### 2. 部署 manager

在一台管理机器上执行：

```sh
MANAGER_ADMIN_KEY='...' MANAGER_API_KEY='...' ./deploy/deploy-manager.sh
```

manager 的机器注册表保存在 `/etc/opencode-manager.json`，权限为 `0600`。

### 3. 注册机器

`baseUrl` 是机器端 bridge 的根地址，不要包含 `/v1`：

```sh
curl -X PUT http://MANAGER:8090/admin/machines/machine-01 \
  -H 'Authorization: Bearer ADMIN_KEY' \
  -H 'content-type: application/json' \
  -d '{
    "name":"machine-01",
    "baseUrl":"https://machine-01.example.internal",
    "apiKey":"sk-...",
    "enabled":true,
    "weight":1
  }'
```

浏览器管理界面地址为 `http://MANAGER:8090/admin`。输入 `MANAGER_ADMIN_KEY` 后可查看
机器状态、执行健康检查、启停机器和编辑注册信息。密钥只会保存在当前浏览器的 local
storage 中，并用于调用已有的受保护管理 API。

## 路由和故障处理

manager 会轮询每台已启用机器的 `/health` 和 `/v1/models`，并聚合可用模型。

- 上游不可连接或返回 `502`、`503`、`504` 时，会尝试下一台健康机器。
- `429` 限流响应不会被静默绕过，保留原始配额和 `Retry-After` 语义。
- 请求指定模型时优先挑选声明该模型的机器；未指定时在可用机器间轮询。
- 单次请求与长时间流式响应默认允许 60 分钟，可通过
  `OPENCODE_REQUEST_TIMEOUT_MS` 和 `MANAGER_REQUEST_TIMEOUT_MS` 调整。

## 调用示例

```sh
curl http://MANAGER:8090/v1/chat/completions \
  -H 'Authorization: Bearer MANAGER_API_KEY' \
  -H 'content-type: application/json' \
  -d '{
    "model":"provider/model",
    "messages":[{"role":"user","content":"你好"}],
    "stream":true
  }'
```

先调用 `GET /v1/models` 获取当前可用的真实模型 ID。模型由 OpenCode provider catalog
动态发现，不应在客户端或管理端写死。

## 开发与测试

```sh
npm test
npm run typecheck
npm run start:machine
npm run start:manager
```

## 安全建议

- 真实密钥只放在环境变量文件或秘密管理系统中，绝不提交到 Git。
- manager API、管理界面和机器端 bridge 都应部署在 TLS 或私有网络之后。
- `MANAGER_ADMIN_KEY`、`MANAGER_API_KEY`、每台机器的 `BRIDGE_KEY` 应分开设置并
  定期轮换。
- 公开仓库只保留 `config/*.example.*` 示例；真实地址、主机名、密钥与本地会话目录均
  不应纳入版本控制。

## 许可证

[MIT](LICENSE)
