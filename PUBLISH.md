# 发布/上传指南（GitHub）

本目录 `toolsmith-mcp-server/` 设计为一个**独立项目**，用于单独部署 Toolsmith MCP Server。

> 说明：当前运行环境可能无法访问 GitHub，因此你可以在有网络的电脑上执行下面步骤。

---

## 1) 本地自检（推荐）

```bash
npm install
npm test
npm run build
docker compose build
```

---

## 2) 创建新仓库并推送（GitHub CLI）

```bash
gh auth login
gh repo create toolsmith-mcp-server --public --source . --remote origin --push
```

如需私有仓库，把 `--public` 改为 `--private`。

---

## 3) 手动方式（不用 gh）

1. 在 GitHub 网页端创建空仓库（例如：`toolsmith-mcp-server`）
2. 在本目录执行：

```bash
git init
git branch -m main
git add .
git commit -m "init: toolsmith mcp server"
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/toolsmith-mcp-server.git
git push -u origin main
```

