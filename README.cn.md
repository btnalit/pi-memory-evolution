# pi-memory-evolution

[English](README.md) · 简体中文

[![CI](https://github.com/btnalit/pi-memory-evolution/actions/workflows/ci.yml/badge.svg)](https://github.com/btnalit/pi-memory-evolution/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-memory-evolution)](https://www.npmjs.com/package/pi-memory-evolution)

为 [Pi](https://pi.dev) 提供持久记忆，让项目背景、个人偏好和工作进展能够跨会话延续。

扩展自动学习值得保留的信息，在后续对话中按主题注入相关内容，也支持跨目录召回。不需要反复说“记住”，不需要维护审批队列。

## 功能

- **自动学习与更新**：从对话摘要、需求和纠正中提取记忆，根据实际工具结果更新已有项目状态；保留来源和变更历史，支持衰退、排序与撤销。
- **相关内容注入**：结合当前问题和近期用户上下文选择记忆，过滤弱匹配和失效状态；没有匹配就不填充无关内容。
- **跨会话召回**：在共享记忆库的不同会话、目录中查找背景；提供只读 `memory_recall` 工具，供助手在任务中途补查。

学习默认使用 Pi agent 当前模型和已有认证；额度耗尽、限流或重复故障时，可切换到 Pi 已配置的其他供应商模型，不改变主对话模型。无需另配 API Key、向量数据库或嵌入服务。详见[重试、切换与预算](docs/recovery.md)。

## 安装

需要 **Pi 0.85+**，并已配置可用模型。使用 npm 版 Pi 时需要 **Node.js 22.19+**。

### npm

```bash
pi install npm:pi-memory-evolution
```

### Git

也可以直接安装 Git 默认分支，需要本机有 Git 和 npm：

```bash
pi install https://github.com/btnalit/pi-memory-evolution
```

**两种方式选一种**，不要重复安装。然后在 Pi 中执行：

```text
/reload
/memory status
```

出现 `SQLite ok (schema 7)` 表示存储初始化成功。后续正常使用 Pi 即可，学习和召回会自动运行。

## 使用

在对话中说明需求，例如：

```text
atlas-service 的核心需求是自动备份和故障恢复。
```

之后可以在新会话中继续询问：

```text
你还记得 atlas-service 的核心需求吗？
```

学习在后台完成，并非每句话都会保存。可用以下命令查看和维护记忆：

| 命令 | 用途 |
| --- | --- |
| `/memory list` | 浏览记忆 |
| `/memory search <主题>` | 搜索相关内容 |
| `/memory show <id>` | 查看内容和来源 |
| `/memory learning` | 查看采集、更新及实际变更结果 |
| `/memory explain` | 查看上一次自动注入的选择原因 |
| `/memory correct <id> <内容>` | 纠正记忆 |
| `/memory forget <id>` | 停止召回该记忆 |

完整命令、安装迁移和排错方法见[使用指南](docs/usage.md)。

## 更新与卸载

npm 安装：

```bash
pi update npm:pi-memory-evolution
pi remove npm:pi-memory-evolution
```

Git 安装请把上面的包来源替换为安装时使用的仓库 URL。操作后执行 `/reload` 或重启 Pi。卸载扩展不会删除记忆库；升级数据库结构前请先退出共用该库的 Pi 进程并备份。

## 数据与边界

数据默认保存在 `~/.pi/agent/agent-suite/memory-evolution/`，使用本地 SQLite。`PI_CODING_AGENT_DIR` 可改变存储前缀；不同工作目录默认共享记忆库。

学习会将经过过滤的来源内容发送给当前模型或允许使用的备用供应商，并消耗相应额度。默认启用跨供应商切换；可通过[恢复配置](docs/recovery.md)限制供应商模型名单或关闭切换。所有备用模型共享调用上限。记忆不是经过独立验证的事实，匹配和敏感信息过滤也并非万无一失；重要内容仍需核实。详见[存储与隐私](docs/usage.md#local-storage-and-provenance)。

## 开发

在源码仓库中运行：

```bash
npm ci --ignore-scripts
npm run check
npm run test:install
npm run test:pi
npm run build
```

CI 自动检查类型、回归、包内容、安装和模拟模型集成；构建产出可安装的 npm 压缩包及校验值。版本和更新记录由发布 PR 自动维护，合并且验证通过后自动发包；依赖更新也走 PR 门禁。

安装测试使用隔离环境，集成测试使用真实 Pi 和模拟模型，不产生付费模型调用。详见[测试说明](docs/testing.md)和[发布流程](docs/releasing.md)。

## 文档

[使用指南](docs/usage.md) · [架构设计](docs/design.md) · [记忆质量](docs/core-quality.md) · [更新记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
