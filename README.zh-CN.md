# Luckee OpenClaw 插件

[English](./README.md) | [中文](./README.zh-CN.md)

一个 [OpenClaw](https://openclaw.ai) 插件，将 **luckee CLI** 封装为 AI 可调用的工具和聊天命令。AI 助手可以通过 OpenClaw 连接的任意渠道（Telegram、WhatsApp、Discord、飞书、Slack 等）查询领星数据。

## 仓库结构

```
plugin/       OpenClaw 插件源码（index.ts、配置、依赖）
skill/        ClawHub 技能（SKILL.md + reference.md，供 AI 代理使用）
```

## 功能特性

- **`luckee_query` 工具** — AI 代理可以通过编程方式调用领星查询。
- **`/luckee` 命令** — 用户可在任意聊天渠道中直接执行查询。
- **流式输出** — 在支持推送的渠道上实时更新进度，支持消息编辑。
- **按发送者管理 Token** — Token 按用户安全存储，跨重启持久化。
- **自动安装** — 未找到 `luckee-cli` 时自动通过 pip 安装。
- **多渠道支持** — Telegram、WhatsApp、Discord、飞书、Slack、Signal 等。

## 前置条件

- [OpenClaw](https://openclaw.ai) 网关正在运行
- Python 3.8+（用于 `luckee-cli` 后端）
- Node.js 18+

## 安装

### 1. 安装 luckee CLI

```bash
pip install --upgrade luckee-cli
```

### 2. 将插件注册到 OpenClaw

```bash
git clone https://github.com/motse-ai/luckee-openclaw-plugin.git
cd luckee-openclaw-plugin/plugin && npm install
openclaw plugins install ./luckee-openclaw-plugin/plugin
```

### 3. 配置必填项

```bash
openclaw config set plugins.entries.luckee-tool.config.defaultUrl "<你的API地址>"
openclaw config set plugins.entries.luckee-tool.config.defaultUserId "<你的用户ID>"
openclaw config set plugins.entries.luckee-tool.config.defaultLingxingAccount "<领星账号>"
```

然后重启网关：

```bash
openclaw gateway restart
```

### 通过 ClawHub 技能安装（替代方式）

如果你已安装 ClawHub，可以安装技能并让 AI 代理自动完成设置：

```bash
clawhub install luckee-skill
```

## 配置项

所有配置位于 OpenClaw 配置文件的 `plugins.entries["luckee-tool"].config` 下。

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `binaryPath` | string | `luckee-cli` | luckee CLI 二进制文件路径 |
| `defaultUrl` | string | — | **必填。** API 端点地址 |
| `defaultUserId` | string | — | **必填。** 默认用户 ID |
| `defaultLingxingAccount` | string | — | **必填。** 领星账号标识 |
| `defaultLanguage` | string | `CN` | 查询语言 |
| `defaultToken` | string | — | 默认 API Token |
| `tokenStorePath` | string | 自动 | Token 持久化存储路径 |
| `defaultTimeout` | number | `90` | 查询超时时间（秒） |
| `streamFlushMs` | number | `500` | 流式输出刷新间隔（毫秒） |
| `autoInstallCli` | boolean | `true` | 未找到 CLI 时自动通过 pip 安装 |
| `pythonPath` | string | 自动 | 用于自动安装的 Python 可执行文件路径 |

## 使用方法

### 聊天命令

```
/luckee 查一下 asin B0FFGNZ36F 的信息 用skills
```

### 设置当前会话的 Token

```
/luckee token sk_your_token_here
```

### 设置 Token 并同时执行查询

```
/luckee token sk_your_token_here 查一下 asin B0FFGNZ36F 的信息
```

### AI 工具调用

连接到 OpenClaw 的 AI 代理可以调用 `luckee_query` 工具：

```json
{
  "query": "查一下 asin B0FFGNZ36F 的信息 用skills",
  "token": "sk_optional_override",
  "language": "CN",
  "timeout": 90
}
```

## 安全性

- Token 存储在 `~/.openclaw/secrets/luckee-tool/tokens.json`，文件权限为 `0600`。
- 按发送者存储的 Token 使用 SHA-256 哈希作为键。
- 所有日志输出中的 Token 值均已脱敏。
- 插件强制使用配置中的 `defaultUrl` — 调用方无法覆盖 API 端点。

## 许可证

MIT

---

由 [Motse AI](https://motse.ai) 开发
