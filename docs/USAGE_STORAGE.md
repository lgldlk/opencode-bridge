# Token 用量存储

管理端将上游返回的 token 用量写入 SQLite，不再把运行时统计写进机器注册表 JSON。

管理端需要 Node.js 22.5 或更高版本（使用内置 `node:sqlite`，无需额外原生依赖）。

## 数据库位置

生产环境默认由部署脚本设置：

```text
/var/lib/opencode-bridge/usage.sqlite
```

也可以通过 `MANAGER_USAGE_DB` 指定绝对路径。目录权限应限制为管理端服务用户（默认 root）可读写。

## 表结构

- `usage_totals`：每台机器的累计请求数、输入/输出/推理/cache/token 总量和最后请求时间。
- `usage_by_model`：按机器和模型拆分的同样指标。
- `usage_daily`：按机器、UTC 日期和模型拆分；模型为空字符串的记录是机器当天总量。
- `usage_requests`：每次上游机器尝试一条调用记录，保存机器、模型、流式标记、状态、时间和本次 token 数；不保存 prompt 或响应正文。

数据库启用 WAL、`synchronous=NORMAL` 和 5 秒 busy timeout。每次请求结束时使用事务更新
调用记录及累计、按模型、按日索引；没有 usage 时仅增加请求计数。

## 统计口径

- 所有数值单位都是 **token 个数**（整数），不是字节，也不是金额。不同供应商的计费
  单位可能按 1K 或 1M token 计价；网桥只记录数量，不把价格硬编码进统计。
- OpenAI 兼容响应通常使用 `prompt_tokens`、`completion_tokens`、`total_tokens`，
  并在 `prompt_tokens_details.cached_tokens` 和
  `completion_tokens_details.reasoning_tokens` 提供细分；缓存写入使用
  `cache_creation_input_tokens`（部分 provider 不返回该字段）。
- 非流式响应读取 OpenAI `usage` 字段。
- 流式响应由 machine bridge 发送内部 `bridge.usage` 帧，manager 解析后记录；该帧不会转发给客户端。
- OpenCode 的缓存字段对应 `tokens.cache.read` / `tokens.cache.write`，管理端分别展示为缓存读取和缓存写入。
- `cache.read` 只有在本次请求命中 provider 的 prompt cache 时才会大于 0；
  `cache.write` 只有 provider 实际写入缓存并回报时才会大于 0，返回 0 不代表统计丢失。
- 如果上游没有返回 usage，则不会估算 token，避免制造虚假额度数据。
- 每次已完成的上游尝试都会计为一条请求；错误、超时或未返回 usage 时 token 字段为 0。
- 这是网桥观测到的消耗量，不是 OpenCode 官方剩余额度。

## 管理接口

管理员认证后访问：

```text
GET /admin/usage
```

返回总量、每台机器累计明细以及最近 30 天的每日明细。可以使用 `?days=90` 查询最近 90 天（最多 366 天），管理控制台会自动展示。

调用明细接口：

```text
GET /admin/requests?days=30&limit=100&offset=0
```

每条记录会标记 `success`、`rate_limited`、`timeout`、`error` 等状态。发生故障转移时，每台实际尝试的机器各有一条记录，便于定位是哪台机器失败或消耗了 token。

## 备份与清理

备份时同时复制主库和 WAL 文件，或先停止 manager 再复制：

```bash
sudo systemctl stop opencode-manager.service
sudo install -m 600 /var/lib/opencode-bridge/usage.sqlite /var/backups/opencode-bridge/usage.sqlite
sudo systemctl start opencode-manager.service
```

清零统计前先备份数据库，然后删除数据库文件并重启服务；服务会自动重建表结构：

```bash
sudo systemctl stop opencode-manager.service
sudo rm -f /var/lib/opencode-bridge/usage.sqlite /var/lib/opencode-bridge/usage.sqlite-wal /var/lib/opencode-bridge/usage.sqlite-shm
sudo systemctl start opencode-manager.service
```

不要将实际数据库、API Key、机器地址或公网 IP 提交到 Git。
