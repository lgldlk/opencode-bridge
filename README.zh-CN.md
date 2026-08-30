# OpenCode Bridge

[English](README.md)

OpenCode Bridge 是一个 OpenAI 兼容网关。每台 OpenCode 工作节点运行一个
`machine` 适配器，可选的 `manager` 负责统一入口、多机路由、健康检查和限流冷却。

## 功能

- 从 OpenCode 动态发现模型，不在客户端写死模型。
- 支持 JSON 和 SSE Chat Completions。
- 支持轮询或随机选择工作节点。
- 节点返回限流时进入可配置冷却期。
- 将调用方工具转换为标准 `tool_calls`。
- 文件、Shell、`edit` 等工具始终由调用方本地执行；MCP 桥注册失败直接返回
  `503`，不会退回远程原生工具。

## 目录

```text
src/machine/   machine 适配器和 OpenCode 客户端
src/manager/   路由、注册表和管理 API
src/shared/    公共 HTTP 与鉴权代码
web/            无构建依赖的管理界面
config/         已脱敏的配置模板
deploy/         部署脚本
test/           Node 测试
```

需要 Node.js 22.6+（或 Node.js 24+），生产运行不依赖 npm 包。

## 最小部署

在每台 OpenCode 工作节点执行：

```sh
BRIDGE_KEY='replace-me' OPENCODE_PASSWORD='replace-me' ./deploy/deploy-machine.sh
```

在一台管理节点执行：

```sh
MANAGER_ADMIN_KEY='replace-me' MANAGER_API_KEY='replace-me' ./deploy/deploy-manager.sh
```

需要从本地自动打包并通过 SSH 部署时，使用 `deploy/deploy-remote.sh`，目标参数填写
你私有 SSH 配置中的别名。

通过受保护的管理 API 注册工作节点。下面的地址、名称和密钥都是占位符，不能替换
为真实值后提交到 Git：

```sh
curl -X PUT https://manager.example.invalid/admin/machines/machine-id-placeholder \
  -H 'Authorization: Bearer <admin-key>' \
  -H 'content-type: application/json' \
  -d '{"name":"display-name-placeholder","baseUrl":"https://machine.example.invalid","apiKey":"replace-with-machine-bridge-key"}'
```

管理界面位于 `/admin`。管理密钥只保存在当前浏览器，并用于访问受保护的管理 API。

## 调用约定

Pi 或其他 OpenAI 兼容客户端只需要连接 manager 的 HTTPS 地址，并从 `GET /v1/models`
获取模型 ID。manager 原样转发 `messages`、`tools`、`tool_choice`、assistant 的
`tool_calls` 以及工具结果，不保存对话内容。

模型提出 `read`、`write`、`edit` 等调用方工具时，网桥返回标准 `tool_calls`；调用方
在自己的本地工作目录执行，然后在下一轮请求发送结果。网桥不会从用户文字提取路径，
也不会让远程 OpenCode 执行原生工具。

## 开发

```sh
npm test
npm run typecheck
```

真实密钥、主机名、机器 ID、URL、本地路径和部署参数必须放在 Git 之外。仓库中的
`config/` 文件仅作为模板。

## 许可证

[MIT](LICENSE)
