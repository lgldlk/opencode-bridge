# Third-party notices

This project references the architecture and protocol handling used by
[`KochC/opencode-llm-proxy`](https://github.com/KochC/opencode-llm-proxy),
licensed under the MIT License.

The local checkout used during development is kept outside this repository at
`../.reference/opencode-llm-proxy`. The machine adapter implements an independent
CommonJS/TypeScript integration, while adopting the upstream project's
canonical message rendering, asynchronous OpenCode prompt lifecycle, and
bounded MCP tool-bridge pool ideas.
