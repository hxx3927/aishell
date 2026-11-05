# 文档

AIShell 的设计与验证记录。用户文档以根目录的 [README](../README.md) 为准。

| 文档 | 内容 |
|---|---|
| [architecture.md](./architecture.md) | 架构总览：进程模型、MCP 调用链、Agent 启动流程、安全边界 |
| [audit-and-persistent-shell.md](./audit-and-persistent-shell.md) | 审计落盘与单机持久 shell 的设计、实现细节、风险与取舍 |
| [verification.md](./verification.md) | 功能验证清单：12 个模块的逐项检查结果与已修复缺陷 |
| [design/](./design/) | 应用图标与字标的 HTML 设计稿及预览图 |
| [images/](./images/) | README 与文档使用的界面截图 |

## 阅读顺序

1. 想了解 AIShell 怎么工作：先看 [architecture.md](./architecture.md)。
2. 想知道 Agent 的每一步如何被记录下来：看 [audit-and-persistent-shell.md](./audit-and-persistent-shell.md)。
3. 想核对某个功能是否验证过：看 [verification.md](./verification.md)。

## 维护约定

- 代码行为变化时，同步更新对应设计文档和验证清单。
- 涉及审计、安全边界的描述以代码为准；文档中的「已知限制」不是承诺。
- 截图使用 `scripts/mock-ssh-server.mjs` 的演示数据生成，不包含真实服务器信息。
