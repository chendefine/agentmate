# 003 — 隐藏流式消息中的 SKILL.md text(不渲染成 user message)

> 本文档记录 AgentMate 为 CloudCLI 修复「命中 Skill 时,SKILL.md 内容在实时流里被渲染成 user 消息」的补丁,目标是**当上游 `siteboon/claudecodeui` 升级时,指导本补丁同步升级**。改动以 **Layer B 运行时补丁**形式存在,不直接修改任何 vendored 上游代码。镜像 [`001_support_multi_file_view.md`](001_support_multi_file_view.md) / [`002_fix_subagent_folding.md`](002_fix_subagent_folding.md) 的结构。

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

---

## 2. 原始代码中存在的问题

Claude Code 命中 Skill 时,CLI 读取 `SKILL.md` 并把内容作为一条**合成 user 消息**注入对话。两个协议对这条注入消息的标记不一致(均经实测确认):

| 协议 | 标记 | `normalizeMessage` 行为 |
|---|---|---|
| 实时流 `stream-json` | `isSynthetic: true` | `raw.isMeta !== true` 守卫通过(isMeta 缺失)→ 产出 `{kind:'text', role:'user', content: <SKILL.md>}` |
| 历史(transcript 落盘) | `isMeta: true` | 守卫 `raw.isMeta !== true` 失败 → 整个 user 分支跳过 → 不产出 |

后果:
- **实时流**:前端 [`useChatMessages.ts`](../../vendor/claudecodeui/src/components/chat/hooks/useChatMessages.ts) 的 `case 'text' / role==='user'`(`:99`)把整段 SKILL.md 渲染成一个**用户气泡**(泄漏成 user message)。
- **历史**:同一条内容被 `isMeta` 过滤 → 历史接口不返回 → **看不到**。
- 两者叠加:既是「SKILL.md 泄漏成 user 输入」,也是「实时流与历史对不上」。

**根因**:`normalizeMessage`([`claude-sessions.provider.ts:314`](../../vendor/claudecodeui/server/modules/providers/list/claude/claude-sessions.provider.ts#L314))的 user 分支守卫只认 `isMeta`(历史协议标记),不认 `isSynthetic`(流协议标记)。而 `isMeta`/`isSynthetic` 是 CLI 对同一概念——「harness 注入的非真实 user 轮次」——在两个协议里的平行标记(对 SKILL.md 实测:`isSynthetic`(流)= `isMeta`(历史)= `true`)。

---

## 3. 解决思路与技术方案

### 3.1 为什么走 Layer B(决策树见 [`how_to_patch_claudecodeui.md`](../how_to_patch_claudecodeui.md) §7.1)

| 判据 | 本补丁 |
|---|---|
| 进前端 bundle(`dist/assets/*.js`)? | 否(`normalizeMessage` 是后端) |
| 需 TS 类型检查 / 改依赖锁? | 否 |
| 只改服务端已编译 `dist-server/*.js`? | 是 |
| agentmate 是 dist-only 安装,后端源码不重编? | 是 |

agentmate 用 **dist-only overlay**(只覆盖 `dist/`,从不重编 `server/*.ts`),故后端改动只能打已安装的 `dist-server/*.js`。与 [`002`](002_fix_subagent_folding.md) §4.5 的 `patch-cloudcli-subagent-path.mjs` 同理——**且打的就是同一个文件**,只是改的函数不同(`normalizeMessage` vs `getSessionMessages`)。

### 3.2 修复:让 `isSynthetic` 与 `isMeta` 同等跳过

在 `normalizeMessage` 的 user 分支守卫,把

```js
if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
```

扩展为

```js
if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true && raw.isSynthetic !== true) {
```

效果:
- **流式 SKILL.md text**(`isSynthetic:true`)→ 守卫失败 → 不产出 → **前端不渲染**(达成目标)。
- **真实用户输入 / assistant 文本 / `"Launching skill"` tool_result**:`isSynthetic` 缺失 → 不受影响,Skill 调用本身(tool_use + ack)仍可见。
- **历史**:那条记录是 `isMeta`,本就被过滤 → **行为不变**(同时修好流/历史一致性)。

### 3.3 为什么是「广过滤 isSynthetic」而不是「只匹配 SKILL.md 前缀」

- `isSynthetic` 是 CLI 的结构化标记,稳定;内容前缀(`Base directory for this skill:`)是 native CLI 硬编码字符串、上游改文案即失效。
- `isSynthetic` 与历史的 `isMeta` 对应,过滤它让流/历史**对称**,顺带修好一致性 bug,与上游「注入文本不属真实 user 轮次」的语义一致。

### 3.4 不回归边界(关键)

- **`<task-notification>` 不受影响**:它是异步 Agent 完成时 harness 注入的**用户可见**轮次,实测在历史中 `isMeta` **缺失**(故 0002 能在历史里折叠它);按 `isSynthetic↔isMeta` 对应,流里也不会带 `isSynthetic` → 本补丁不隐藏它。**测试 F5 把这条作为首要回归闸**。
- **同文件邻居补丁**:`patch-cloudcli-subagent-path.mjs` 改 `getSessionMessages()`;本补丁改 `normalizeMessage()`。函数不同,锚点互不重叠。
- **HolyClaude 7 个运行时补丁 + office-preview + account-management**:都不触碰 `normalizeMessage`(该文件 `AgentMate|HolyClaude` 标记计数 = 0,基础镜像实测)。

---

## 4. 补丁调整了原始代码中的哪些地方,怎么修改的

> 补丁源文件:[`patches/patch-cloudcli-synthetic-skill-text.mjs`](../../patches/patch-cloudcli-synthetic-skill-text.mjs)。唯一目标:已安装的 `dist-server/server/modules/providers/list/claude/claude-sessions.provider.js`(运行时)。不附 `server/*.ts` 源码目标(agentmate 从不重编后端源码)。

**单点改动** —— `normalizeMessage` 的 user 分支守卫(基础镜像编译产物第 237 行,esbuild 原样保留 `?.`/单引号/8 空格缩进,已 `grep` 确认):

```diff
+        // AgentMate synthetic-skill-text patch: live stream marks harness-injected user text
+        // (isSynthetic, e.g. SKILL.md content) which the transcript persists as isMeta.
+        // Mirror the isMeta skip so injected skill text no longer renders as a user
+        // message in the stream, keeping live and history consistent.
-        if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
+        if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true && raw.isSynthetic !== true) {
```

遵循 Layer B 契约 C1–C10:marker `// AgentMate synthetic-skill-text patch`、幂等(已打过则 return)、锚点 `count === 1`、后置断言(marker 恰好 1 处 + OLD 消失 + NEW 在)、CRLF 归一、`[agentmate-patch]` 日志前缀。

---

## 5. 构建 / 安装 / 检测机制

| 环节 | 文件 | 说明 |
|---|---|---|
| Layer B 脚本 | [`patches/patch-cloudcli-synthetic-skill-text.mjs`](../../patches/patch-cloudcli-synthetic-skill-text.mjs) | runner `scripts/apply-cloudcli-patches.sh` 按字典序自动 glob 执行(`subagent-path` < `synthetic-skill-text`,两者独立) |
| 第二闸 grep | [`Dockerfile`](../../Dockerfile) | runner 之后追加 `grep -Fq '// AgentMate synthetic-skill-text patch' …/claude-sessions.provider.js`,与既有 subagent-path 第二闸并列 |
| 检测 | Layer B 脚本自身后置断言 + runner `set -e` + Dockerfile 第二闸 grep | 三重 fail-closed |

**fail-closed 漂移探测点**(任一失败即 build 失败):
1. `.mjs` 锚点 `count !== 1` → `exit(1)`(context 漂移);
2. runner `set -e` 传播 → docker build 失败;
3. Dockerfile 第二闸 grep 缺 marker → build 失败。

---

## 6. 验证

### 6.1 验证项

- **T1 补丁脚本单测**(本地,基础镜像文件做 fake root):applied / already patched(幂等)/ 破坏锚点 → `exit(1)`(fail-closed)/ `node --check` 通过。
- **T2 行为功能测试**(基础镜像容器内,真实 `ClaudeSessionsProvider`):
  - F1 SKILL.md 合成文本(`isSynthetic:true`)→ `normalizeMessage` 返回 `[]`(生效);
  - F2 普通用户文本 → 仍返回 text/user;F3 `"Launching skill"` tool_result → 仍返回 tool_result;F4 assistant 文本 → 仍返回 text/assistant;F6 thinking → 仍返回 thinking(不回归);
  - **F5 `<task-notification>` user 文本 → 仍返回 text/user(subagent-folding 不回归,首要回归闸)**。
- **T3 构建集成**(`docker compose build`):日志同时出现 `synthetic-skill-text patched (runtime)` 与 `subagent-path patched (runtime)`;两道第二闸 grep 均通过;负向(破坏锚点)build 失败。
- **T4 真实端到端**(可选/重):跑镜像触发真实 Skill → SKILL.md 不再成 user 气泡,Skill tool_use + ack 仍在;异步 Agent 的 task-notification 仍折叠进容器。

### 6.2 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| 上游 `normalizeMessage` 重构 → 锚点漂移 | `.mjs` 锚点 `count !== 1` → `exit(1)`,runner `set -e` 让 docker build 失败;固定 upstream commit |
| 误伤 `<task-notification>`(若上游未来给它加 `isSynthetic`) | `isSynthetic↔isMeta` 对应关系 + F5 回归断言;真出现则改为 `isSynthetic && !isTaskNotification` |
| 与 subagent-path 同文件冲突 | 函数隔离 + 两道第二闸 grep 并存验证 |

### 6.3 实测结果(2026-07-21,T1–T3 全通过)

- **T1 补丁脚本单测**:对从基础镜像提取的 `claude-sessions.provider.js` 做 fake root,首轮 `patched (runtime)`、次轮 `already patched`(幂等)、`node --check` 通过、marker 恰好 1 处、OLD 锚点消失;破坏锚点 → `exit 1`(fail-closed)。diff 仅 1 处 5 行替换(4 行注释 + 守卫加 `&& raw.isSynthetic !== true`)。
- **T2 行为功能测试**(容器内真实 `ClaudeSessionsProvider.normalizeMessage`):**F1 SKILL.md 合成文本 → `[]`(生效)**;F2 普通用户文本 / F3 `Launching skill` tool_result / F4 assistant 文本 / F6 thinking 全部不变;**F5 `<task-notification>` user 文本 → `text/user`(subagent-folding 不回归,首要回归闸通过)**。6/6 PASS。
- **T3 构建集成**:`docker compose build` 成功,Layer B RUN 日志同时出现 `subagent-path patched (runtime)` 与 `synthetic-skill-text patched (runtime)`,两道第二闸 grep 均通过(同文件双补丁共存);负向(破坏 `OLD_ANCHOR`)→ build 在 `[9/9]` 步 `exit code: 1` 失败,日志 `ERROR: synthetic-skill-text anchors not found`;还原后 rebuild 成功。
- **T4 真实端到端**(可选/重):服务器侧发射路径已由 T2 用「实测捕获的流事件真实形状」证明(F1);浏览器端到端作为最终人工验收,受模型/proxy 触发 Skill 的稳定性约束。

---

## 7. 升级指南(上游 bump 时怎么做)

1. 改 `FROM coderluii/holyclaude:x.y.z` 后,对每个 Layer B 补丁跑 `docker run --rm … grep` 重新定位锚点。
2. 在新基础镜像里重新取 `normalizeMessage` 的 user 守卫行,覆盖 [`patch-cloudcli-synthetic-skill-text.mjs`](../../patches/patch-cloudcli-synthetic-skill-text.mjs) 的 `OLD_ANCHOR`。
3. `docker compose build` 暴露漂移;逐个适配。
4. 重新跑 T1–T4。
5. 若上游原生按 `isSynthetic`/统一处理 → 按移除条件删除本补丁。

---

## 8. 相关文件清单

```
patches/patch-cloudcli-synthetic-skill-text.mjs   # Layer B 后端运行时补丁
Dockerfile                                         # 第二闸 grep(与 subagent-path 并列)
docs/patches/003_hide_synthetic_skill_text.md      # 本文件
```

**移除条件**:当上游 CloudCLI 的 `normalizeMessage` 原生按 `isSynthetic` 跳过(或流/历史对注入文本的处理已一致),删除 `patches/patch-cloudcli-synthetic-skill-text.mjs`、Dockerfile 的对应第二闸 grep 行、以及本文件。
