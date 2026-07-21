# cloudcli-subagent-folding — 修复子 agent 折叠容器

> AgentMate 为 CloudCLI 修复「子 agent 折叠容器」特性的 overlay。目标是**当上游 `siteboon/claudecodeui` 升级时,指导本 overlay 同步升级**。所有改动以 Layer A 源码补丁(前端)+ Layer B 运行时补丁(后端)形式存在,不直接修改任何 vendored 上游代码。

---

## 1. 处理的上游代码版本

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/siteboon/claudecodeui |
| npm 包名 | `@cloudcli-ai/cloudcli`(CloudCLI) |
| **固定 commit** | **`615e2ca2926a68e6e3336d49b592616654a69424`** |
| **包版本** | **`1.36.2`** |
| 上游 License | AGPL-3.0-or-later |
| 基础镜像 | `coderluii/holyclaude:1.5.0` |
| 与 office-preview 的关系 | 本 overlay 的构建**链式**应用 HolyClaude account-management → office-preview → subagent-folding,产出**累积 tgz**(其 `dist/` 同时含 office-preview 与本修复)。Dockerfile 用该累积 tgz 取代旧的 office-preview-only tgz。 |

---

## 2. 原始代码中存在的问题

CloudCLI 在 commit `0207a1f` 引入「子 agent 折叠容器」:派生子 agent 的工具调用被收进紫色边框的 `SubagentContainer` 折叠块(显示 prompt、当前工具、`View tool history (N)`、完成状态、最终结果),与主 agent 普通工具行区分。上游 Claude Code 后来做了两处不兼容变更,使该特性**完全失效**:

1. **工具改名 `Task` → `Agent`**:派生子 agent 的工具在 transcript 中现记录为 `"name":"Agent"`(实测 `"Task"` 0 次)。前端写死 `toolName === 'Task'` 判定 → `isSubagentContainer` 恒为 false → `SubagentContainer` 分支进不去,`Agent` 回退到 `Default` 配置渲染成普通折叠块。
2. **transcript 迁移到子目录**:子 agent transcript 从「主 session 同目录的 `agent-*.jsonl`」搬到 `<session-id>/subagents/agent-*.jsonl`。后端 `getSessionMessages()` 仍在旧目录查找 → `subagentTools` 恒为空 → 即便容器渲染也无子工具。

---

## 3. 解决思路与技术方案

### 3.1 为什么分两层

| 部分 | 层 | 原因 |
|---|---|---|
| 前端(工具名识别,4 个 src 文件) | **Layer A** 源码补丁 | 改动进 minified `dist/assets/*.js`,Layer B 无法可靠 patch;且需 TS 类型检查通过 |
| 后端(`subagents/` 目录路径,1 个文件) | **Layer B** 运行时补丁 | 只改服务端已编译 `dist-server/*.js`;无 HolyClaude 补丁触碰该文件;agentmate 是 dist-only 安装,后端源码不重编 |

### 3.2 前端改动(Layer A,`0001-subagent-tool-name.patch`)

5 处改动,精确锚点见 [`docs/patches/002_fix_subagent_folding.md`](../../../docs/patches/002_fix_subagent_folding.md) §4:

1. **检测器** `src/components/chat/hooks/useChatMessages.ts` —— `msg.toolName === 'Task'` → 加 `|| msg.toolName === 'Agent'`(驱动整条路径)。
2. **配置别名** `src/components/chat/tools/configs/toolConfigs.ts` 的 `getToolConfig` —— `Agent` 别名到 `Task` 配置(让 result 渲染用「Subagent result」折叠块)。
3. **嵌套子 agent 紧凑展示** `src/components/chat/tools/components/SubagentContainer.tsx` 的 `getCompactToolDisplay` —— `case 'Agent':`。
4. **抗压缩标记** 同文件根 div 加 `data-agentmate-subagent-folding=""`(esbuild 压缩后字符串字面量保留,作 verifier/grep 标记)。
5. **抑制重复 result** `src/components/chat/view/subcomponents/MessageComponent.tsx` —— result 区守卫加 `!message.isSubagentContainer`(容器内部已展示 result,避免再渲染一遍)。

### 3.2.1 异步结果归位(`0002-subagent-result-folding.patch`,仅 `useChatMessages.ts`)

异步 `Agent` 立即返回 ack,真实结果稍后由 harness 注入 user 角色的 `<task-notification>`(含 `<tool-use-id>` + `<result>`)。原前端把它渲染成主对话里的独立消息 → 子 agent 输出泄漏。本补丁:
- `parseTaskNotification` 解析 `<tool-use-id>`;
- 预扫描把 `toolUseId` 匹配父容器的通知收集起来;
- `tool_use` 分支用通知的 `<result>` 覆盖容器 result(取代 ack),置 `isComplete`;
- `text` 分支不再为已折叠的通知产生独立通知/result 消息(父容器跨分页未加载时回退原渲染,不丢结果)。

### 3.3 后端改动(Layer B,`patches/patch-cloudcli-subagent-path.mjs`)

patch 已安装的 `dist-server/server/modules/providers/list/claude/claude-sessions.provider.js` 的 `getSessionMessages()`:
- 把「在 `path.dirname(jsonLPath)` 找 `agent-*.jsonl`」改为「同时扫描新目录 `<projectDir>/<session-id>/subagents/` 与旧同目录,`agentFiles` 由数组改 Set」;
- 内层解析:`.includes`→`.has`,路径优先新目录、回退旧目录(向后兼容历史 session)。
- 遵循 Layer B 契约 C1–C10:可参数化根目录、统一 `fail()`、幂等、锚点 `count === 1`、后置断言、唯一 marker `// AgentMate subagent-path patch`、CRLF 归一。
- `parseAgentTools`、`claude-sdk.js` 实时路径(`parentToolUseId`)、Codex provider 均无需改动(已确认)。

### 3.4 安装策略:dist-only 覆盖 + Layer B(零回归)

- Layer A 累积 tgz 只覆盖 `dist/`(前端);`dist-server/` 原样保留 → HolyClaude 的 7 个运行时补丁不受影响。
- Layer B `.mjs` 只改 `dist-server/.../claude-sessions.provider.js`(无 HolyClaude 补丁触碰)→ 也不影响其他运行时补丁。
- office-preview、account-management、base-path 等既有功能不回归。

---

## 4. 构建 / 安装 / 检测机制

| 环节 | 文件 | 说明 |
|---|---|---|
| overlay 目录 | `patches/source/cloudcli-subagent-folding/` | `0001-subagent-tool-name.patch`、`0002-subagent-result-folding.patch`、`README.md`(本文件) |
| 构建脚本 | `scripts/build-cloudcli-subagent-folding-artifact.mjs` + `-container.mjs` | 镜像 office-preview 构建;固定 `node:26.5.0-bookworm-slim@sha256:2d49d876…`、Node v26.5.0、npm 11.17.0;**链式 patch(HolyClaude → office-preview → subagent-folding)**;`npm ci → typecheck → build → lint → shrinkwrap`;双 pack sha256 + 双 install 依赖树 sha256 必须一致 |
| 产物 | `patches/source/artifacts/cloudcli-ai-cloudcli-1.36.2-agentmate-subagent-folding.tgz` + `cloudcli-subagent-folding.manifest.json` | 累积 tgz(dist/ 含 office + subagent 前端改动)+ manifest 成对入库 |
| 前端检测器 | `scripts/verify-cloudcli-subagent-folding-support.mjs` | 标记 = `data-agentmate-subagent-folding`;`state=agentmate-bridge-complete` 时 ok |
| 后端检测 | Dockerfile `grep -Fq '// AgentMate subagent-path patch'`(可选第二道闸) | Layer B 脚本自身后置断言 + runner `set -e` 已是 fail-closed |
| Dockerfile | Layer A 阶段切换到累积 tgz;同时跑 office + subagent 两个 verifier | 见 [`Dockerfile`](../../../Dockerfile) |

**fail-closed 漂移探测点**(任一失败即 build 失败):
1. `git apply -C0` 每个 patch(context 漂移 → apply 失败);
2. `npm ci`/`typecheck`/`build`/`lint`;
3. 双 pack / 双 install sha256 不一致 → `throw`;
4. Layer B `.mjs` 锚点 `count !== 1` → `exit(1)`(经 runner `set -e` 上抛);
5. Dockerfile grep(office 标记 / subagent 标记缺失);
6. 前端检测器状态 ≠ `agentmate-bridge-complete`。

---

## 5. 升级指南

当 `coderluii/holyclaude` 升级,或 CloudCLI 发新版本时:

### 5.1 若上游 CloudCLI 前端已识别 `Agent` 工具名
- 在新源码里 grep `'Task'`/`'Agent'` 与 `SubagentContainer`,确认 §3.2 的 5 个锚点是否仍存在。
- 若上游已原生识别 `Agent` → 删除 `0001-subagent-tool-name.patch`,保留 verifier(状态会变 `upstream-complete` 时移除)。

### 5.2 若上游 `claude-sessions.provider` 已读 `<session-id>/subagents/`
- Layer B `.mjs` 的 OLD 锚点会因重构而 `count !== 1` → fail-closed → 删除 `patches/patch-cloudcli-subagent-path.mjs`。

### 5.3 关键锚点速查

| 锚点 | 文件 | 含义 |
|---|---|---|
| `const isSubagentContainer = msg.toolName === 'Task';` | `useChatMessages.ts` | 检测器 |
| `return TOOL_CONFIGS[toolName] \|\| TOOL_CONFIGS.Default;` | `toolConfigs.ts` 的 `getToolConfig` | 配置别名 chokepoint |
| `case 'Task':\n      return input.description ...` | `SubagentContainer.tsx` 的 `getCompactToolDisplay` | 嵌套 case |
| `border-l-purple-400">` | `SubagentContainer.tsx` 根 div | marker 注入点 |
| `message.toolName !== 'Bash' && !shouldHideToolResult` | `MessageComponent.tsx` result 守卫 | 抑制重复 result |
| `const agentFiles = files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));` | 编译产物 `dist-server/.../claude-sessions.provider.js` | Layer B OLD_A |
| `if (!agentFiles.includes(agentFileName)) {` 同上文件 | Layer B OLD_B |

---

## 6. 移除条件

当以下**两者同时**满足,删除本 overlay 与 Layer B 脚本:
1. 上游 CloudCLI 前端识别 `Agent` 工具名(检测器状态变 `upstream-complete`);
2. 上游 `claude-sessions.provider` 原生从 `<session-id>/subagents/` 读取子 agent transcript。

届时删除:`patches/source/cloudcli-subagent-folding/`、`scripts/build-cloudcli-subagent-folding-*`、`patches/source/artifacts/cloudcli-*subagent-folding*` + manifest、`patches/patch-cloudcli-subagent-path.mjs`,并把 Dockerfile Layer A 阶段切回 office-preview tgz。

> **整包重装(`npm i -g`)注意**:agentmate 当前用 dist-only 覆盖,后端源码不重编。若将来改为整包重装,需把 §3.3 的等价 `.ts` 改动补成 `0002-subagent-path.patch` 加入本 overlay(否则重建出的 `dist-server/` 不含路径修复)。
