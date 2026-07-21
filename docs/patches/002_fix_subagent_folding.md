# 002 — 修复子 agent 折叠容器(Task→Agent 改名 + subagents/ 目录迁移)

> 本文档记录 AgentMate 为 CloudCLI 修复「子 agent 折叠容器」特性的补丁,目标是**当上游 `siteboon/claudecodeui` 升级时,指导本补丁同步升级**。改动以 Layer A 源码补丁(前端)+ Layer B 运行时补丁(后端)形式存在,不直接修改任何 vendored 上游代码。镜像 [`001_support_multi_file_view.md`](001_support_multi_file_view.md) 的结构。

---

## 1. 处理的上游代码版本

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/siteboon/claudecodeui |
| npm 包名 | `@cloudcli-ai/cloudcli`(CloudCLI) |
| **固定 commit** | **`615e2ca2926a68e6e3336d49b592616654a69424`** |
| **包版本** | **`1.36.2`** |
| 上游 License | AGPL-3.0-or-later |
| 基础镜像 | `coderluii/holyclaude:1.5.0`(内含 CloudCLI 1.36.2 + HolyClaude overlay + 7 个运行时补丁) |

> 该 commit 与 doc 001(office-preview)一致,且实测 5 个目标前端文件在 v1.36.2 ↔ v1.36.3 间**完全相同**,故补丁锚点在两个版本通用。

---

## 2. 原始代码中存在的问题

CloudCLI 在 commit `0207a1f` 引入「子 agent 折叠容器」:派生子 agent 的工具调用收进紫色边框的 `SubagentContainer` 折叠块。上游 Claude Code 后来做了两处不兼容变更,使该特性**完全失效**:

1. **工具改名 `Task` → `Agent`**:transcript 现记录 `"name":"Agent"`(实测主 session 7 次,`"Task"` 0 次)。前端写死 `toolName === 'Task'` → `isSubagentContainer` 恒 false → `SubagentContainer` 分支进不去,`Agent` 回退到 `Default` 配置。
2. **transcript 迁移到子目录**:子 agent transcript 从「主 session 同目录 `agent-*.jsonl`」搬到 `~/.claude/projects/<cwd>/<session-id>/subagents/agent-<id>.jsonl`。后端 `getSessionMessages()` 仍在旧目录查找 → `subagentTools` 恒空。

**根因**:前端 4 处 `Task` 判定未跟随上游改名;后端目录扫描未跟随上游目录迁移。两者叠加导致折叠容器既不触发、也无子工具。

---

## 3. 解决思路与技术方案

### 3.1 为什么分两层(决策树见 [`how_to_patch_claudecodeui.md`](../how_to_patch_claudecodeui.md) §7.1)

| 部分 | 层 | 触发条件 |
|---|---|---|
| 前端(工具名识别) | **Layer A** 源码补丁 | 改动进 minified `dist/assets/*.js`;需 TS 类型检查通过 |
| 后端(目录路径) | **Layer B** 运行时补丁 | 只改服务端已编译 `dist-server/*.js`;agentmate 是 dist-only 安装,后端源码不重编 |

### 3.2 与 office-preview 的链式关系

Dockerfile 只能 overlay 一个 `dist/`,故所有 AgentMate 前端 overlay 必须同进一个 tgz。本 overlay 的构建**链式**应用 HolyClaude account-management → office-preview → subagent-folding,产出**累积 tgz**,其 `dist/` 同时含 office-preview 与本修复。Dockerfile Layer A 阶段切换到该累积 tgz(取代旧的 office-preview-only tgz;office-preview 的 patch 目录仍被本构建引用)。

### 3.3 安装策略:dist-only 覆盖 + Layer B(零回归)

- 累积 tgz 只覆盖 `dist/`;`dist-server/` 原样保留 → HolyClaude 7 个运行时补丁不受影响。
- Layer B `.mjs` 只改 `dist-server/.../claude-sessions.provider.js`(无 HolyClaude 补丁触碰)。
- office-preview、account-management、base-path 等既有功能不回归。

---

## 4. 补丁调整了原始代码中的哪些地方,怎么修改的

### 4.1 前端(Layer A,`patches/source/cloudcli-subagent-folding/0001-subagent-tool-name.patch`)

**(a) 检测器**(驱动整条路径)——`src/components/chat/hooks/useChatMessages.ts`:
```diff
-const isSubagentContainer = msg.toolName === 'Task';
+const isSubagentContainer = msg.toolName === 'Task' || msg.toolName === 'Agent';
```

**(b) 配置别名**(result 渲染的唯一 chokepoint)——`src/components/chat/tools/configs/toolConfigs.ts` 的 `getToolConfig`:
```diff
 export function getToolConfig(toolName: string): ToolDisplayConfig {
-  return TOOL_CONFIGS[toolName] || TOOL_CONFIGS.Default;
+  // AgentMate subagent-folding: upstream renamed the subagent tool Task->Agent;
+  // alias it to the existing Task config so input+result render identically.
+  const key = toolName === 'Agent' ? 'Task' : toolName;
+  return TOOL_CONFIGS[key] || TOOL_CONFIGS.Default;
 }
```

**(c) 嵌套子 agent 紧凑展示**——`src/components/chat/tools/components/SubagentContainer.tsx` 的 `getCompactToolDisplay`:
```diff
     case 'Task':
+    case 'Agent':
       return input.description || input.subagent_type || '';
```

**(d) 抗压缩标记**(供 verifier / Dockerfile grep;esbuild 压缩后字符串字面量保留)——同文件根 div:
```diff
-    <div className="my-1 border-l-2 border-l-purple-500 py-0.5 pl-3 dark:border-l-purple-400">
+    <div className="my-1 border-l-2 border-l-purple-500 py-0.5 pl-3 dark:border-l-purple-400" data-agentmate-subagent-folding="">
```

**(e) 抑制重复 result 渲染**——`src/components/chat/view/subcomponents/MessageComponent.tsx`(容器内部已展示 result,避免再渲染一遍):
```diff
-{message.toolResult && message.toolName !== 'Bash' && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
+{message.toolResult && message.toolName !== 'Bash' && !message.isSubagentContainer && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
```

> 已确认无需改动:`ToolRenderer.tsx:43` 的 `getToolCategory`(检测器修好后对容器永不调用)、`PermissionsContent.tsx` 工具白名单(设置 UX,与渲染 bug 正交)。

### 4.2 前端(Layer A,`patches/source/cloudcli-subagent-folding/0002-subagent-result-folding.patch`)

异步 `Agent` 工具立即返回 ack(`tool_result` = "Async agent launched"),真实结果稍后由 harness 注入一条 user 角色的 `<task-notification>` 文本消息(含 `<tool-use-id>` 与 `<result>`)。原前端把它渲染成主对话里的独立通知 + result 消息,导致子 agent 输出泄漏到主对话。本补丁仅改 `src/components/chat/hooks/useChatMessages.ts`:

- **`parseTaskNotification`**:新增解析 `<tool-use-id>`,返回结构加 `toolUseId`。
- **预扫描**:收集本页内所有 `Agent`/`Task` 容器的 `toolId`(`subagentToolIds`),再收集 `toolUseId` 能匹配上的 `<task-notification>`(`taskNotificationsByToolId`)。匹配不上的(父容器跨分页未加载)保持原渲染,避免结果丢失。
- **`tool_use` 分支**:对匹配到通知的容器,用通知的 `<result>` 覆盖容器的 `toolResult`(取代 ack),并置 `isComplete`。
- **`text`(user)分支**:被折叠的通知不再产生独立的通知卡片 + result 消息(结果已在容器内)。

> 关联键:`<tool-use-id>` === 父 `Agent` 工具调用的 `toolId`,数据天然存在。改动集中在一个文件,纯前端 Layer A。

### 4.3 前端(Layer A,`patches/source/cloudcli-subagent-folding/0003-subagent-live-folding.patch`)

运行时(流式)子 agent 的中间事件(thinking / text / tool_use / tool_result)经 websocket **实时**推到主对话,每条带 `parentToolUseId`;这些事件**不落盘**到主 transcript(所以历史回看不到、0002 碰不到),而前端原无分组逻辑 → 全部独立渲染(泄漏)。实测 ws 流(`subagent_messages_ws_stream.jsonl`)确认。本补丁仅改 `useChatMessages.ts`,在 0002 预扫描基础上扩展:

- **预扫描**:把带 `parentToolUseId` 且父 `Agent` 容器已加载的事件按父 toolId 分桶 → 派生 `liveChildToolsByParent`(桶内 `tool_use` 造 childTool,`tool_result` 按 toolId 回填)+ `liveResultByParent`(桶内最后一条 assistant `text` = 子 agent 最终输出)。
- **`tool_use`(Agent 容器)分支**:`childTools` = 后端 `subagentTools`(0001)∪ `liveChildToolsByParent`(0003),按 toolId 去重;`result` 优先级 = 异步 `<task-notification>`(0002)→ 实时最终文本(0003)→ ack 兜底。
- **主循环顶部守卫**:`if (msg.parentToolUseId && subagentToolIds.has(...)) continue;` —— 抑制所有子 agent 事件的独立渲染(父容器跨分页未加载的孤儿事件回退独立渲染,不丢数据)。

> 管线已就位:`parentToolUseId` 端到端可用(SDK 提取并透传,`useSessionStore.ts:81` 类型),`SubagentContainer` 已有 `childTools`/`currentToolIndex`/`isComplete` 实时态字段。内联流式无显式完成信号,`isComplete` 沿用 `Boolean(result)`(运行中可能略早显示「Completed」,属可接受小瑕疵)。

### 4.4 前端(Layer A,`patches/source/cloudcli-subagent-folding/0004-subagent-result-rendering.patch`)

0001–0003 把子 agent 最终输出正确折叠进容器后,折叠进来的文本本身仍有两处渲染缺陷:**长文本后半段被截断**、**正常文本里出现字面 `&lt;` 等实体**。根因分两层:

- **数据层**(`useChatMessages.ts`):0002/0003 把 `subagentResult.content`(`asyncNotif.result` / `liveResult`)**原样塞入**,跳过了主对话所有文本路径都走的 `decodeHtmlEntities`/`unescapeWithMathProtection`/`formatUsageLimitText` 解码管线(对照 standalone task-notification `:116`、assistant `:131`、user `:124`、thinking `:196`)。
- **渲染层**(`SubagentContainer.tsx`):`ToolRenderer.tsx:113-122` 把 `isSubagentContainer` 短路进 `SubagentContainer` 且 result 模式 `return null` → Task 的 `contentType:'markdown'` 配置(`toolConfigs.ts`)永远到不了 `MarkdownContent`/`<Markdown>`;容器内改用纯 JSX 文本 `{content}`(React **不**解码文本表达式里的实体,还会把残留 `&` 再转义 → 字面 `&lt;`)+ 硬 `line-clamp-6`(无展开机制)。

本补丁应用在 0001→0002→0003 之后的最终态(构建脚本 [build-cloudcli-subagent-folding-artifact.mjs](../../scripts/build-cloudcli-subagent-folding-artifact.mjs) `:121` 按 sorted glob 收集 `*.patch`,新增 `0004-*.patch` 自动最后应用,**无需改构建脚本**),改两处:

**(a) 数据层解码** —— `useChatMessages.ts` 两条 `content:` 套上与 `:116` 一致的管线:
```diff
         const subagentResult = asyncNotif
           ? {
-              content: asyncNotif.result || '',
+              content: formatUsageLimitText(unescapeWithMathProtection(decodeHtmlEntities(asyncNotif.result || ''))),
               isError: asyncNotif.status === 'failed' || asyncNotif.status === 'error',
               toolUseResult: toolResult?.toolUseResult,
             }
           : (liveResult
-              ? { content: liveResult, isError: false, toolUseResult: toolResult?.toolUseResult }
+              ? { content: formatUsageLimitText(unescapeWithMathProtection(decodeHtmlEntities(liveResult))), isError: false, toolUseResult: toolResult?.toolUseResult }
               : toolResult);
```
> 三个函数文件已 import(`:8`),无需新增 import。

**(b) 渲染层走 Markdown + 去截断** —— `SubagentContainer.tsx`:
```diff
+import { Markdown } from '../../view/subcomponents/Markdown';
 ...
               return typeof content === 'string' ? (
-                <div className="line-clamp-6 whitespace-pre-wrap break-words">
+                <Markdown className="break-words">
                   {content}
-                </div>
+                </Markdown>
               ) : content ? (
-                <pre className="line-clamp-6 whitespace-pre-wrap break-words font-mono text-[11px]">
+                <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
                   {JSON.stringify(content, null, 2)}
                 </pre>
               ) : null;
```
> `<Markdown>`(react-markdown + remark-gfm/math + rehype-katex)同时修好「实体解码」(commonmark 解析 `&lt;` 等)与「markdown 格式渲染」(列表/粗体/代码块,与主对话 assistant 文本一致);去 `line-clamp-6` 后长文本完整可见。JSON 数组提取逻辑(`:143-166`)不动 —— 提取后仍是 string,交给 `<Markdown>`。不改动:`ToolRenderer` 短路、prompt 块 `line-clamp-4`(是请求非输出)、`MessageComponent` 的 `!isSubagentContainer` 守卫。

### 4.5 后端(Layer B,`patches/patch-cloudcli-subagent-path.mjs`)

patch 已安装的 `dist-server/server/modules/providers/list/claude/claude-sessions.provider.js` 的 `getSessionMessages()`。两处块替换(`agentFiles` 数组→Set,扫描新+旧两个目录,路径优先新目录回退旧目录):

**替换 A**(目录列举):
```js
// OLD
        const projectDir = path.dirname(jsonLPath);
        const files = await fsp.readdir(projectDir);
        const agentFiles = files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));
// NEW
        const projectDir = path.dirname(jsonLPath);
        // AgentMate subagent-path patch: transcripts moved to <projectDir>/<session-id>/subagents/.
        const sessionFile = path.basename(jsonLPath, '.jsonl');
        const subagentsDir = path.join(projectDir, sessionFile, 'subagents');
        const agentFiles = new Set();
        for (const _scanDir of [subagentsDir, projectDir]) {
          let _names = [];
          try { _names = await fsp.readdir(_scanDir); } catch {}
          for (const _name of _names) {
            if (_name.endsWith('.jsonl') && _name.startsWith('agent-')) agentFiles.add(_name);
          }
        }
```

**替换 B**(路径解析):
```js
// OLD
            const agentFileName = `agent-${agentId}.jsonl`;
            if (!agentFiles.includes(agentFileName)) { ... continue; }
            const agentFilePath = path.join(projectDir, agentFileName);
            const tools = await parseAgentTools(agentFilePath);
// NEW
            const agentFileName = `agent-${agentId}.jsonl`;
            if (!agentFiles.has(agentFileName)) { ... continue; }
            const _subagentPath = path.join(subagentsDir, agentFileName);
            const _legacyPath = path.join(projectDir, agentFileName);
            let agentFilePath;
            try { await fsp.access(_subagentPath); agentFilePath = _subagentPath; }
            catch { agentFilePath = _legacyPath; }
            const tools = await parseAgentTools(agentFilePath);
```

遵循 Layer B 契约 C1–C10:marker `// AgentMate subagent-path patch`、幂等、锚点 `count === 1`、后置断言、CRLF 归一。`agentId` 关联链(`toolUseResult.agentId` → 文件名后缀)在新布局下不变。

---

## 5. 构建 / 安装 / 检测机制

| 环节 | 文件 | 说明 |
|---|---|---|
| overlay 目录 | [`patches/source/cloudcli-subagent-folding/`](../../patches/source/cloudcli-subagent-folding/) | `0001-subagent-tool-name.patch`、`0002-subagent-result-folding.patch`、`0003-subagent-live-folding.patch`、`README.md` |
| 构建脚本 | [`scripts/build-cloudcli-subagent-folding-artifact.mjs`](../../scripts/build-cloudcli-subagent-folding-artifact.mjs) + `-container.mjs` | 镜像 office-preview 构建;固定 `node:26.5.0-bookworm-slim@sha256:2d49d876…`;链式 patch(HolyClaude → office-preview → subagent-folding);`npm ci → typecheck → build → lint → shrinkwrap`;双 pack sha256 + 双 install 依赖树 sha256 一致 |
| 产物 | `patches/source/artifacts/cloudcli-ai-cloudcli-1.36.2-agentmate-subagent-folding.tgz` + `cloudcli-subagent-folding.manifest.json` | 累积 tgz + manifest 成对入库 |
| 前端检测器 | [`scripts/verify-cloudcli-subagent-folding-support.mjs`](../../scripts/verify-cloudcli-subagent-folding-support.mjs) | 标记 = `data-agentmate-subagent-folding`;`agentmate-bridge-complete` 时 ok |
| 后端检测 | Layer B 脚本自身后置断言 + runner `set -e`(Dockerfile 可选加 `grep -Fq '// AgentMate subagent-path patch'`) | fail-closed |
| Dockerfile | Layer A 阶段切换到累积 tgz;同时跑 office + subagent 两个 verifier | 见 [`Dockerfile`](../../Dockerfile) |

---

## 6. 验证与已知风险

### 6.1 验证项

- **Layer B 本地**(V2):对从 tgz 解出的 dist-server 文件跑两次(applied / already patched,幂等);破坏锚点 → `exit(1)`(fail-closed);`node --check` 通过。
- **构建可复现**(V1):`git apply -C0` 三套 patch 通过;typecheck/build/lint 通过;双 pack sha256 一致;双 install 依赖树 sha256 一致。
- **镜像集成**(V3):`docker build` 打印 overlay applied、两 verifier 均 `agentmate-bridge-complete`、`subagent-path patched (runtime)`。
- **功能 e2e**(V4):真实 fixture `~/.claude/projects/-opt-agentmate/deb60cbb-….jsonl`(7 个 `Agent` 子 agent)→ 历史接口返回 7 个 `Agent` tool_use 的 `subagentTools` 非空;浏览器(playwright-cli)渲染为紫色折叠 `SubagentContainer` + `View tool history (N)` + `Completed (N tools)`。
- **回归**(V5):office-preview 仍渲染;无子 agent 的 session 正常;旧目录布局 fixture 回退加载;Codex session 正常;HolyClaude 7 个运行时补丁标记 intact。

### 6.2 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| 上游 `getSessionMessages` 重构 → Layer B 锚点漂移 | `.mjs` 锚点 `count !== 1` 时 `exit(1)`,经 runner `set -e` 让 docker build 失败;固定 upstream commit |
| 上游再把工具改名 → 前端 `Agent` 判定失效 | 检测器 verifier + e2e 暴露;固定 upstream commit |
| 异步 `Agent` 的真实结果经 task-notification 投递 | **已由 `0002` 修复**:`<tool-use-id>` 关联回父容器,结果折叠进容器内,主对话不再出现独立 result 消息;父容器跨分页未加载时回退原渲染(不丢结果) |
| 运行时流式子 agent 中间事件(thinking/text/tool_use/tool_result)泄漏到主对话 | **已由 `0003` 修复**:按 `parentToolUseId` 归组进父容器(childTools + 最终文本),主循环顶部守卫抑制其独立渲染;孤儿事件回退独立渲染。注:这些事件是临时的(不落盘),故历史回看本就看不到、0002 也碰不到 |
| 累积 tgz 取代 office-preview tgz | office-preview patch 目录仍被链式构建引用;Dockerfile 注释 + 本文档 + doc 001 注明取代关系 |

---

## 7. 升级指南(上游 bump 时怎么做)

1. 改构建脚本的 `upstreamCommit`/`packageVersion`/`artifactFile`(与 office-preview 保持一致)。
2. 在新 commit 上重新定位 §4 的锚点(尤其编译产物的 OLD_A/OLD_B 引号与缩进),重新生成 `0001` 与 `.mjs` 锚点。
3. 跑 `node scripts/build-cloudcli-subagent-folding-artifact-container.mjs`;任一 fail-closed 点失败都会指出漂移位置。
4. 重新 e2e 验证(§6.1)。
5. 若上游原生支持 → 按移除条件删除 overlay 与 Layer B 脚本。

---

## 8. 相关文件清单

```
patches/source/cloudcli-subagent-folding/
├── 0001-subagent-tool-name.patch      # 前端:Task→Agent 识别(5 处,4 文件)
├── 0002-subagent-result-folding.patch # 前端:异步 task-notification 结果折叠进容器(useChatMessages.ts)
├── 0003-subagent-live-folding.patch   # 前端:运行时 parentToolUseId 流式事件折叠进容器(useChatMessages.ts)
├── 0004-subagent-result-rendering.patch # 前端:最终输出走 <Markdown> 解实体 + 去截断(useChatMessages.ts + SubagentContainer.tsx)
└── README.md                          # overlay 说明 + 移除条件
patches/patch-cloudcli-subagent-path.mjs              # Layer B 后端运行时补丁
patches/source/artifacts/
├── cloudcli-ai-cloudcli-1.36.2-agentmate-subagent-folding.tgz   # 累积 tgz(含 office + subagent)
└── cloudcli-subagent-folding.manifest.json
scripts/
├── build-cloudcli-subagent-folding-artifact.mjs
├── build-cloudcli-subagent-folding-artifact-container.mjs
└── verify-cloudcli-subagent-folding-support.mjs
Dockerfile                            # Layer A 切换到累积 tgz + 双 verifier
```

**移除条件**:当上游 CloudCLI 前端识别 `Agent` 工具名 **且** `claude-sessions.provider` 原生读 `<session-id>/subagents/`,删除上述 overlay 目录、`scripts/build-cloudcli-subagent-folding-*`、`patches/source/artifacts/cloudcli-*subagent-folding*` + manifest、`patches/patch-cloudcli-subagent-path.mjs`,并把 Dockerfile Layer A 切回 office-preview tgz。
