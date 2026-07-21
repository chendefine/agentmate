<div align="center">

# AgentMate

**一个开箱即用的 CloudCLI(Claude Code Web UI)增强镜像 —— 在 HolyClaude 之上叠加 AgentMate 专属修复**

*An opinionated, batteries-included Docker image that layers AgentMate-specific fixes onto CloudCLI (the web UI for Claude Code), on top of the HolyClaude base image.*

![License: AGPL-3.0](https://img.shields.io/github/license/chendefine/agentmate)
![GitHub stars](https://img.shields.io/github/stars/chendefine/agentmate?style=social)
![GitHub last commit](https://img.shields.io/github/last-commit/chendefine/agentmate)
![GitHub issues](https://img.shields.io/github/issues/chendefine/agentmate)
![GitHub pull requests](https://img.shields.io/github/issues-pr/chendefine/agentmate)
![Base image](https://img.shields.io/badge/base%20image-coderluii%2Fholyclaude%3A1.5.0-orange)
![CloudCLI](https://img.shields.io/badge/CloudCLI-1.36.2-6c42d6)
![Reproducible build](https://img.shields.io/badge/build-node%2026.5.0%20%C2%B7%20npm%2011.17.0-339933)
![Platform](https://img.shields.io/badge/platform-linux%2Famd64-lightgrey)
![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)

</div>

---

## 简介

[CloudCLI](https://github.com/siteboon/claudecodeui)(npm 包 `@cloudcli-ai/cloudcli`,即 claudecodeui)是当下流行的 Claude Code 网页端。[HolyClaude](https://github.com/coderluii/holyclaude) 把它打包成了一个生产可用的 Docker 镜像(浏览器运行时、反向代理子路径、通知、本地账号管理……)。

**AgentMate 再往上一层**:在 `coderluii/holyclaude:1.5.0` 之上,用一套**可复现、fail-closed** 的补丁框架,注入 HolyClaude 没有覆盖的 AgentMate 专属增强,然后打成一张新镜像。你只需要 `docker compose up`。

> 仓库里**没有应用源码** —— 只有补丁脚本、构建链和 Dockerfile。所有对上游的修改都以补丁形式存在,**不直接改动任何 vendored 上游代码**,便于跟踪与升级。

## ✨ 特性

**面向用户的增强**

- 📄 **Office 文档内联预览** —— 在文件管理器里直接预览 `doc / docx / xls / xlsx / ppt / pptx / odt / ods / odp`(基于 `@open-file-viewer`)。上游原本只显示「二进制文件无法显示」。
- 🗂️ **子 agent 折叠容器修复** —— 上游 Claude Code 把工具 `Task` 改名为 `Agent`、并把子 agent transcript 迁到 `subagents/` 子目录,导致 CloudCLI 的折叠容器完全失效;AgentMate 让它重新工作。
- 🤫 **隐藏合成消息** —— 命中 Skill 时不再把 `SKILL.md` 内容在实时流里渲染成一条用户消息。

**面向工程的保证**

- 🔒 **fail-closed**:任何一个补丁的锚点在上游版本里漂移,都会让 `docker build` **立即失败**,绝不静默打错位置。
- ♻️ **可复现构建**:Layer A 产物在固定 `node:26.5.0` / npm `11.17.0` 镜像里构建,双重 `npm pack` + 双重 `npm install` 校验 sha256 一致,并随产物入库 `manifest.json`。
- 🧩 **幂等补丁**:每个运行时补丁可安全重复执行,`already patched` 不会报错。

## 🚀 快速开始

**前置**:Docker 与 Docker Compose(Compose v2)。

```bash
git clone https://github.com/chendefine/agentmate.git
cd agentmate

# (可选)若本机 3001 被占用,改一下端口
echo "HOLYCLAUDE_HOST_PORT=3001" > .env

# 构建并启动
docker compose up -d --build
```

浏览器打开 `http://<主机IP>:${HOLYCLAUDE_HOST_PORT:-3001}`,看到 CloudCLI 界面即成功。

> 不想自己构建?`compose.yaml` 默认拉取 `chendefine/agentmate:latest`;若你只想跑、不想构建,把 `build:` 段删掉、保留 `image:` 即可。

<details>
<summary>用 systemd 托管(生产环境推荐)</summary>

本仓库带了两个 unit(依赖关系已配好,`tproxy` 网络会在 agentmate 之前起来):

```bash
sudo cp systemd/docker-network-tproxy.service /etc/systemd/system/
sudo cp systemd/docker-agentmate.service       /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now docker-agentmate.service
```

> `docker-agentmate.service` 是 oneshot 单元,容器崩溃后的自愈交给 compose 里的 `restart: unless-stopped`。
</details>

## 🧩 工作原理:两层补丁

每条对 CloudCLI 的定制都归入两层之一。判错层是最常见的错误,完整决策树见
[docs/how_to_patch_claudecodeui.md §7.1](docs/how_to_patch_claudecodeui.md)。

```
                  coderluii/holyclaude:1.5.0  (CloudCLI 1.36.2 + HolyClaude 7 个运行时补丁)
                                   │
   ┌───────────────────────────────┼───────────────────────────────┐
   │ Layer A —— 构建时源码补丁      │   Layer B —— 运行时安装补丁     │
   │ patches/source/<feature>/     │   patches/patch-cloudcli-*.mjs │
   │   00NN-*.patch                │   (按字母序,apply-*.sh 执行)   │
   │   ↓ 固定镜像内重建 → npm pack  │   ↓ 构建期直接改 dist-server/   │
   │ patches/source/artifacts/*.tgz│                                │
   └───────────────┬───────────────┴────────────────┬──────────────┘
                   │  Dockerfile 覆盖唯一一个 dist/   │  Dockerfile 内 node 执行
                   └───────────────┬─────────────────┘
                                   ▼
                        chendefine/agentmate:latest
```

- **Layer A**:改动必须进入**被压缩的前端 bundle**(`dist/assets/*.js`)、要过 TS 类型检查、或要改依赖锁时使用。标记必须用**字符串字面量**(esbuild 会剥注释)。
- **Layer B**:只改服务端、已编译的 `dist-server/*.js`。未压缩,注释标记可保留。
- **单 tgz 约束**:Dockerfile 只能覆盖**一个** `dist/`,因此所有 Layer A 前端 overlay 必须**链式合并进同一个累积 tgz**(当前是 `…agentmate-subagent-folding.tgz`,已含 office-preview + subagent-folding 两套前端修复)。

## ⚙️ 配置

`compose.yaml` 里每一项都有内联注释。常用项:

| 变量 / 卷                                           | 默认                        | 说明                                                              |
| --------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `HOLYCLAUDE_HOST_PORT`                              | `3001`                      | 宿主机映射到容器 `3001`(CloudCLI Web UI 唯一端口)。在 `.env` 里改 |
| `./data/claude` → `/home/claude/.claude`            | —                           | 设置、凭据、API key、记忆文件。**重建不丢,勿删**                  |
| `./data/cloudcli` → `/home/claude/.cloudcli`        | —                           | CloudCLI 自身数据                                                 |
| `./data/agents` → `/home/claude/.agents`            | —                           | AgentMate 的 agent 定义、prompts、skills                          |
| `./workspace` → `/workspace`                        | —                           | 你的代码与项目                                                    |
| `./data/bin/officecli` → `/usr/local/bin/officecli` | —                           | 只读挂载的 office CLI 工具                                        |
| `TZ`                                                | `Asia/Shanghai`             | 时区                                                              |
| `NODE_OPTIONS`                                      | `--max-old-space-size=4096` | Node 堆上限                                                       |

完整选项(通知、SSH/Mosh、反向代理子路径、Codex 权限模式等)见
[docs/configuration.md](docs/configuration.md)。

## 🛠️ 开发指南

### 新增一个补丁:先选层

| 改动                                  | 选层        | 落点                                                          |
| ------------------------------------- | ----------- | ------------------------------------------------------------- |
| 进前端 bundle / 要 TS 类型 / 改依赖锁 | **Layer A** | `patches/source/<feature>/00NN-*.patch`,扩展现有累积构建脚本  |
| 只改服务端                            | **Layer B** | `patches/patch-cloudcli-<feature>.mjs`(从 `_templates/` 复制) |

### 本地验证一个 Layer B 补丁(幂等性 + 还原)

```bash
# 连跑两次,第二次必须打印 already patched
node patches/patch-cloudcli-<feature>.mjs /opt/agentmate/vendor/claudecodeui
node patches/patch-cloudcli-<feature>.mjs /opt/agentmate/vendor/claudecodeui

git -C /opt/agentmate/vendor/claudecodeui diff          # 检查改动
git -C /opt/agentmate/vendor/claudecodeui checkout -- . # 还原
```

### 重建 Layer A 产物 / 构建镜像

```bash
# 始终用 -container.mjs 入口(它用 @sha256 固定了镜像/node/npm);勿跑裸 .mjs
node scripts/build-cloudcli-subagent-folding-artifact-container.mjs

docker compose build      # 构建镜像;Layer B 在此运行,锚点漂移即失败
```

每个 Layer B 补丁必须遵守 **C1–C10 契约**(可参数化根、统一 `fail()`、幂等、锚点恰好出现一次、写入后断言、唯一 marker、源码+产物双打、CRLF 归一……),完整规范见
[docs/how_to_patch_claudecodeui.md §4](docs/how_to_patch_claudecodeui.md)。

## 📁 目录结构

```
agentmate/
├── compose.yaml                # 用户最常编辑的文件:端口、卷、环境变量
├── Dockerfile                  # Layer A 覆盖 + Layer B 补丁,全部 fail-closed
├── .env                        # HOLYCLAUDE_HOST_PORT 等本地覆盖(gitignored)
├── patches/
│   ├── patch-cloudcli-*.mjs            # Layer B 运行时补丁(按字母序执行)
│   ├── _templates/patch-cloudcli-feature.mjs   # 新补丁模板
│   └── source/
│       ├── <feature>/00NN-*.patch      # Layer A 源码补丁
│       └── artifacts/                  # 入库的构建产物(*.tgz + *.manifest.json)
├── scripts/
│   ├── apply-cloudcli-patches.sh               # Layer B 执行器
│   ├── build-cloudcli-*-artifact-container.mjs # Layer A 可复现构建入口
│   └── verify-cloudcli-*-support.mjs           # 状态机式漂移检测器
├── systemd/                    # docker-network-tproxy + docker-agentmate 单元
├── docs/                       # 完整规范 + 每个补丁的升级指南
├── data/                       # 运行时卷(gitignored):claude / cloudcli / agents
├── workspace/                  # 你的项目(gitignored 挂载)
└── vendor/                     # 本地参考 checkout(claudecodeui / HolyClaude,不入库)
```

## ⬆️ 升级上游

1. 在 `build-cloudcli-*-artifact.mjs` 更新 `upstreamCommit` / `packageVersion`,重跑构建。
2. 让补丁的**锚点断言**自动暴露漂移(`patch-*.mjs` 找不到旧文本即 `fail()`,Dockerfile 的 `grep` 复核也会失败)。
3. 对每个失败点:要么改写补丁适配新锚点,要么(上游已采纳)删补丁、保留 `grep -q <upstream-marker>` 断言。
4. 更新 `verify-*.mjs` 状态机;若上游完整支持,按 manifest 的 `removal` 条款删除 overlay。

**永远不要**:弱化断言、静默跳过失败补丁、用 `|| true` 兜底。每条补丁的升级细则见
[docs/patches/](docs/patches/)。

## 📄 文档

- [docs/how_to_patch_claudecodeui.md](docs/how_to_patch_claudecodeui.md) —— **补丁规范权威文档**(两层架构、C1–C10 契约、决策树、升级流程)
- [docs/configuration.md](docs/configuration.md) —— 全部配置项参考
- [docs/patches/](docs/patches/) —— 每个补丁的上游版本、根因分析与升级指南
- [CLAUDE.md](CLAUDE.md) —— 给 Claude Code / AI 协作者的项目导览

## 🙏 致谢

AgentMate 站在巨人的肩膀上,向以下项目致敬:

- **[HolyClaude](https://github.com/coderluii/holyclaude)** —— 生产级 CloudCLI Docker 镜像,本仓库的基础镜像与补丁框架范本。
- **[claudecodeui / CloudCLI](https://github.com/siteboon/claudecodeui)** —— 被 patched 的 Claude Code 网页端本体。
- **[@open-file-viewer](https://github.com/nicepkg/open-file-viewer)** —— Office 文档预览能力的底层库。

## 📄 许可证

上游 [claudecodeui / CloudCLI](https://github.com/siteboon/claudecodeui) 采用 **AGPL-3.0**。AgentMate 作为其衍生作品(对其前端重新构建、镜像内含修改后的 AGPL 代码),**整镜像与本仓库内的全部补丁源码**均按 **AGPL-3.0** 分发,完整的许可证文本见 [LICENSE](LICENSE)。

按 AGPL-3.0 第 13 条:任何通过计算机网络与修改版交互的用户,都有权获取该修改版的对应源码(Corresponding Source)。对本项目而言,对应源码即为本仓库。
