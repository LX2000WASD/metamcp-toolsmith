# Toolsmith MCP Server（独立部署版）

Toolsmith 是一个**本地 MCP Server**：你可以让 AI 通过工具调用来**创建/更新/删除**你机器上的 MCP 工具文件（`tools/*.mjs`），并且工具会**热加载**。

本项目是“独立部署版”——你不需要重新部署 MetaMCP。  
已经部署了 MetaMCP 的用户，只要把 Toolsmith 作为一个 **SSE / Streamable HTTP** 的远程 MCP Server 添加进去即可无缝使用。

---

## 特色能力

- **对话式造工具**：内置 `toolsmith_*` 管理工具，AI 可直接写入工具文件
- **热加载**：`tools/*.mjs` 变更后自动重载（基于 mtime + ESM cache bust）
- **同一 Server 内同时承载**：
  - 管理工具：`toolsmith_*`
  - 用户工具：你生成的 `tools/<name>.mjs`
- **双传输协议**：同时提供
  - SSE：`GET /sse` + `POST /message`
  - Streamable HTTP：`/mcp`
- **安全开关（可选）**：
  - `TOOLSMITH_BEARER_TOKEN`：HTTP 接入鉴权（给 MetaMCP 配置 bearerToken 即可）
  - `TOOLSMITH_WRITE_TOKEN`：写操作二次令牌（create/update/delete 必须带 writeToken）

---

## 快速开始（Docker Compose）

前置要求：Docker（含 `docker compose`）。

```bash
git clone https://github.com/LX2000WASD/metamcp-toolsmith.git
cd metamcp-toolsmith
cp example.env .env
docker compose up -d --build
```

默认：

- Toolsmith 监听：`http://localhost:7071`
- 工具目录挂载到宿主机：`./toolsmith-tools`

---

## 本地运行（不用 Docker）

前置要求：Node.js 18+。

```bash
npm install
npm run build
npm start
```

默认监听 `0.0.0.0:7071`，工具目录为 `./tools`（可用 `.env` 覆盖）。

---

## 接入 MetaMCP（JSON 一键导入）

在 MetaMCP UI -> **MCP Servers** -> **导入 JSON**，直接粘贴下面任意一种（SSE 或 Streamable HTTP 二选一）。

### 方案 A：SSE（推荐）

> 地址提示：
> - 如果 MetaMCP 跑在 Docker 里：通常用 `host.docker.internal` 访问宿主机上的 Toolsmith
> - 如果 MetaMCP 直接跑在宿主机：把 URL 改成 `http://127.0.0.1:7071/...`

```json
{
  "mcpServers": {
    "toolsmith": {
      "type": "sse",
      "url": "http://host.docker.internal:7071/sse",
      "bearerToken": "替换为你的 TOOLSMITH_BEARER_TOKEN（如果你启用了）",
      "description": "Toolsmith MCP Server (SSE)"
    }
  }
}
```

### 方案 B：Streamable HTTP

```json
{
  "mcpServers": {
    "toolsmith": {
      "type": "streamable_http",
      "url": "http://host.docker.internal:7071/mcp",
      "bearerToken": "替换为你的 TOOLSMITH_BEARER_TOKEN（如果你启用了）",
      "description": "Toolsmith MCP Server (Streamable HTTP)"
    }
  }
}
```

导入完成后：

1) 把 `toolsmith` 这个 MCP Server 绑定到你的某个 namespace  
2) 让 endpoint 指向该 namespace  
3) 然后你会在 endpoint 的工具列表看到：
   - `toolsmith__toolsmith_create_tool` / `toolsmith__toolsmith_update_tool` / ...
   - 以及你动态生成的 `toolsmith__<your_tool_name>`

> 说明：`toolsmith__` 前缀来自 MetaMCP 的聚合规则：`<serverName>__<toolName>`。

---

## 创建你的第一个工具（示例）

在 MetaMCP 聚合后的工具里调用：

- `toolsmith__toolsmith_create_tool`

参数（template 模式）：

```json
{
  "name": "hello_toolsmith",
  "description": "Say hello from a dynamically generated tool",
  "mode": "template",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Your name" }
    },
    "required": ["name"]
  },
  "writeToken": "填你的 TOOLSMITH_WRITE_TOKEN（如果启用了）"
}
```

成功后：

- 宿主机会生成 `./toolsmith-tools/hello_toolsmith.mjs`
- 新工具会以 `toolsmith__hello_toolsmith` 出现在工具列表中

---

## 用户工具文件格式（`tools/<name>.mjs`）

必须导出：

- `export const tool = { name, description, inputSchema }`
- `export async function handler(args, ctx)`

并且 `tool.name` 有约束：

- 必须匹配 `^[a-z0-9_]+$`
- 禁止包含 `__`
- 禁止以 `toolsmith_` 开头（保留前缀）

---

## 原项目（MetaMCP）参考

Toolsmith 的接入目标是 MetaMCP（MCP 聚合器）。完整概念与更多能力请直接参考原项目：

- Repo：`https://github.com/metatool-ai/metamcp`
- Docs：`https://docs.metamcp.com`
