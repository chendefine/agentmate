# 基于 HolyClaude 镜像二次定制 CloudCLI(claudecodeui)的补丁规范

> 本文档分析 `vendor/HolyClaude/`(HolyClaude 官方镜像源码)是如何对 `vendor/claudecodeui/`(即 npm 包 `@cloudcli-ai/cloudcli`,GitHub 仓库 `siteboon/claudecodeui`)进行打补丁修改的,并提炼成 **本项目(agentmate)后续在 HolyClaude 官方镜像基础上进一步做自定义修改时必须遵循的参考与标准规范**。

---

## 0. 名词对齐:CloudCLI = claudecodeui

首先澄清一个容易混淆的点,它决定了所有补丁的落点:

| 名称 | 本质 | 证据 |
|---|---|---|
| **claudecodeui** | GitHub 仓库名 `siteboon/claudecodeui` | `vendor/claudecodeui/.git` → `origin = https://github.com/siteboon/claudecodeui.git` |
| **CloudCLI** | 该仓库发布的 **npm 包名** `@cloudcli-ai/cloudcli` | `vendor/claudecodeui/package.json` → `"name": "@cloudcli-ai/cloudcli"`,启动二进制也叫 `cloudcli` |

**两者是同一个项目。** HolyClaude 文档里一律称 "CloudCLI",对应我们 vendor 目录里的 `claudecodeui`。下文统一用 **CloudCLI** 指代被补丁的目标,路径前缀为安装目录:

```
/usr/local/lib/node_modules/@cloudcli-ai/cloudcli/
├── server/                         # 源码(部分 .ts/.js 会随包发布)
├── dist-server/server/...          # 编译产物 —— 运行时实际加载的代码
├── dist/                           # 前端构建产物(index.html / sw.js / assets/*)
└── package.json
```

> 关键事实:CloudCLI 既发布 `server/` 源码,也发布编译后的 `dist-server/`,两者都在安装目录里。HolyClaude 的运行时补丁往往 **同时改源码和编译产物两份**,保证即便重新构建也保留补丁。

---

## 1. 核心结论:两层补丁架构

HolyClaude 对 CloudCLI 的修改分为 **两个完全独立的层次**,任何自定义补丁都必须先判断属于哪一层:

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer A —— 构建时源码补丁 (build-time source patch)              │
│  产物:vendor/artifacts/cloudcli-ai-cloudcli-1.36.2-*.tgz         │
│  手段:git apply *.patch → npm ci/build/lint/pack                  │
│  适用:需要进入编译产物 / 需要 TS 类型检查 / 需要改依赖锁           │
│  示例:本地账号管理(logout/改密)、Node26 的 better-sqlite3 锁     │
└─────────────────────────────────────────────────────────────────┘
                          ↓ tgz 被 npm i -g 安装进镜像
┌─────────────────────────────────────────────────────────────────┐
│  Layer B —— 运行时安装补丁 (runtime install patch)                │
│  产物:直接修改已安装的 dist-server/*.js                          │
│  手段:Dockerfile 里 node /tmp/patch-cloudcli-*.mjs               │
│  适用:与 HolyClaude 容器环境强耦合(宿主二进制/环境变量)          │
│  示例:Chromium 路径、反向代理子路径、禁用 npm 自更新、通知桥接    │
└─────────────────────────────────────────────────────────────────┘
```

**判断准则(本项目必须遵守,详见 §7 决策树):**

- 改动需要 **被编译进前端 bundle** 或 **需要 TypeScript 类型通过** → **Layer A**(`.patch`)。
- 改动只涉及 **服务端已编译的 `.js`** 且依赖 **HolyClaude 容器特有输入**(如 `process.env.CHROME_PATH`、`/usr/local/bin/notify.py`、`HOLYCLAUDE_BASE_PATH`)→ **Layer B**(`.mjs`)。
- 两者皆可时,**优先 Layer B**:因为它不触碰可复现构建链,升级 CloudCLI 时漂移面更小。

---

## 2. Layer A:构建时源码补丁(`.patch` + `git apply`)

### 2.1 落点与文件

```
vendor/HolyClaude/
├── vendor/patches/cloudcli-account-management/
│   ├── 0001-local-account-management.patch     # 580 行,本地账号 logout/改密
│   ├── 0002-node26-better-sqlite3-lock.patch   #  38 行,Node26 依赖锁
│   └── README.md                               # 该 overlay 的规则与移除条件
├── vendor/artifacts/
│   ├── cloudcli-ai-cloudcli-1.36.2-holyclaude-account-management.tgz   # 构建产物
│   └── cloudcli-account-management.manifest.json                        # 可复现清单
├── scripts/build-cloudcli-account-management-artifact.mjs              # 构建逻辑(243 行)
└── scripts/build-cloudcli-account-management-artifact-container.mjs    # 在固定容器里跑上面那个
```

### 2.2 构建流程(`build-cloudcli-account-management-artifact.mjs`)

脚本在 **固定镜像 `node:26.5.0-bookworm-slim@sha256:...`** 内运行(由 `-container.mjs` 通过 `docker run --platform linux/amd64` 保证),严格按以下顺序:

1. **环境断言** — 校验 `HOLYCLAUDE_CLOUDCLI_BUILD_IMAGE`、`node --version`、`npm --version` 三者完全等于预期,否则 `throw`。这是可复现的第一道闸。
2. **取源** — `git clone --no-checkout https://github.com/siteboon/claudecodeui.git` → `git checkout <pinned-commit>`(当前固定 `615e2ca2...`,对应 v1.36.2)。也支持 `--source <dir>` 用本地副本。
3. **commit 断言** — 取到的 `HEAD` 必须等于 `upstreamCommit`,否则 `throw`。
4. **打补丁** — 遍历 `vendor/patches/cloudcli-account-management/*.patch`(按文件名字典序),逐个 `git apply -C0 <patch>`。
   - `-C0` = **零容差** 忽略空白:HolyClaude 仓库里这些 `.patch` 是空白归一化的(为了通过仓库自身的 release lint),上游 commit 已由第 3 步固定,所以用零上下文避免把上游的尾随空格带进本仓库。
5. **构建** — 依次 `npm ci` → `npm run typecheck` → `npm run build` → `npm run lint` → `npm shrinkwrap --omit=dev`。任一失败即终止。
6. **双重 pack 一致性** — 在两个空目录各跑一次 `npm pack`,两次产物的 `sha256` 必须相同,否则 `throw`(证明构建可复现)。
7. **双重 install 一致性** — 把 tgz 在两个独立 prefix 各 `npm install -g` 一次,对 `npm ls --all --json` 的依赖树做归一化后比对 `sha256`,必须相同。
8. **落盘产物 + 写 manifest** — 拷贝 tgz 到 `vendor/artifacts/`,并写出 `cloudcli-account-management.manifest.json`,记录:
   - `upstream`:仓库 / commit / 包名 / 版本 / license
   - `build`:镜像 / node / npm / 命令序列 / `sourceTreeSha256`
   - `artifact`:tgz 的 `sha256` / 大小 / 文件列表 hash / shrinkwrap hash / 依赖树 hash / 第二次 pack 的 hash
   - `patches[]`:每个 `.patch` 的 `sha256`
   - `verification`:对应的检测脚本与期望状态
   - `removal`:何时可以移除该 overlay(上游发布完整支持后)

### 2.3 `.patch` 内容示例

`0001-local-account-management.patch` 改动 13 个文件,横跨服务端源码与前端 React 组件(因此 **必须** 走 Layer A,前端要进 bundle):

```
server/middleware/auth.js                      # JWT token generation 校验
server/modules/database/repositories/app-config.ts   # getStrict()
server/modules/database/repositories/users.ts        # getUserAuthById / updatePasswordHash
server/routes/auth.js                          # /change-password 路由
src/components/auth/context/AuthContext.tsx    # 前端登出/改密 UI
src/components/settings/...                    # 设置面板新 tab
src/utils/api.js                               # 客户端 API 封装
```

`0002-node26-better-sqlite3-lock.patch` 把 `package-lock.json` 里的 `better-sqlite3` 从 `12.6.2` 提到 `12.11.1`(支持 Node 26),并把 `npm-shrinkwrap.json` 加进 `package.json` 的 `files` 白名单。这是依赖锁变更,**只能** 走 Layer A。

### 2.4 Dockerfile 里如何消费

```dockerfile
ARG CLOUDCLI_ACCOUNT_MANAGEMENT_ARTIFACT=cloudcli-ai-cloudcli-1.36.2-holyclaude-account-management.tgz
COPY vendor/artifacts/${CLOUDCLI_ACCOUNT_MANAGEMENT_ARTIFACT} /tmp/vendor/cloudcli-ai-cloudcli.tgz
COPY vendor/artifacts/cloudcli-account-management.manifest.json /tmp/vendor/cloudcli-account-management.manifest.json
...
RUN npm i -g /tmp/vendor/cloudcli-ai-cloudcli.tgz && rm -f /tmp/vendor/cloudcli-ai-cloudcli.tgz
```

注意:Dockerfile **不重新构建** CloudCLI,只 `npm i -g` 预编译好的 tgz。构建链完全在 `build-*-artifact.mjs` 里离线完成并入库。

---

## 3. Layer B:运行时安装补丁(`.mjs` 脚本)

### 3.1 落点与文件

```
vendor/HolyClaude/scripts/
├── patch-cloudcli-apprise-notifications.mjs        # 195 行  通知桥接
├── patch-cloudcli-base-path.mjs                    # 392 行  反向代理子路径
├── patch-cloudcli-browser-runtime.mjs              # 104 行  Chromium 路径
├── patch-cloudcli-codex-complete-exit-code.mjs     #  88 行  Codex 完成字段
├── patch-cloudcli-codex-permissions.mjs            # 175 行  Codex 权限模式
├── patch-cloudcli-disable-self-update.mjs          # 301 行  禁用 npm 自更新
├── patch-cloudcli-web-terminal-rendering.mjs       # 164 行  Web Terminal 插件渲染
├── verify-cloudcli-account-management-support.mjs  # 129 行  Layer A 的检测器(见 §5)
└── build-cloudcli-account-management-artifact.mjs  # 243 行  Layer A 的构建器(见 §2)
```

### 3.2 Dockerfile 里的编排(Dockerfile 第 307–396 行)

每个补丁都是 **三步**:① `COPY` 脚本到 `/tmp/` → ② `RUN node /tmp/patch-*.mjs` → ③ `RUN grep -Fq <marker>` 复核。脚本用完即 `rm -f` 删除,不进镜像层。

```dockerfile
COPY scripts/patch-cloudcli-browser-runtime.mjs /tmp/patch-cloudcli-browser-runtime.mjs
# 应用补丁
RUN node /tmp/patch-cloudcli-browser-runtime.mjs && rm -f /tmp/patch-cloudcli-browser-runtime.mjs
# fail-closed 复核:补丁没生效就让 docker build 失败
RUN CLOUDCLI_BROWSER_USE="/usr/local/lib/node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/browser-use/browser-use.service.js" && \
    grep -Fq "// HolyClaude canonical browser runtime" "$CLOUDCLI_BROWSER_USE" && \
    grep -Fq "executablePath: process.env.CHROME_PATH," "$CLOUDCLI_BROWSER_USE" && \
    echo "[patch] CloudCLI Browser Use canonical Chromium applied to runtime"
```

对 "上游已包含该修复" 的情形,Dockerfile 直接用 `grep -q` 断言上游标记存在,而不是再打补丁:

```dockerfile
RUN CLOUDCLI_WS_PROXY=".../plugin-websocket-proxy.service.js" && \
    grep -q "binary: isBinary" "$CLOUDCLI_WS_PROXY" && \
    echo "[patch] WebSocket frame type fix already present upstream"
```

### 3.3 七个运行时补丁的职责与落点

| 补丁脚本 | 解决问题(issue) | 修改的安装目录文件 | 关键 marker |
|---|---|---|---|
| `browser-runtime` | 让 Browser Use 启动 HolyClaude 的系统 Chromium 而非未安装的 headless-shell | `dist-server/.../browser-use/browser-use.service.js`(+ 源码 `.ts`) | `// HolyClaude canonical browser runtime` |
| `base-path` | 支持反向代理子路径 `HOLYCLAUDE_BASE_PATH`(改写 HTML/manifest/sw.js/CSS/WS,前端 monkey-patch `fetch`/`XHR`/`WebSocket`/`EventSource`/`Request`) | `dist-server/server/index.js`、`.../websocket-server.service.js` | `HolyClaude base path support` |
| `apprise-notifications` | 把 Codex 生命周期的 stop/error 事件桥接到 HolyClaude 的 Apprise 通知(调用 `/usr/local/bin/notify.py`) | `dist-server/.../notification-orchestrator.service.js`(+ 源码) | `APPRISE_PROVIDER_ALLOWLIST`、`sendAppriseLifecycleNotification` |
| `codex-permissions` | 通过 `HOLYCLAUDE_CODEX_CHAT_PERMISSION_MODE` 配置 Codex 聊天权限模式 | `dist-server/server/openai-codex.js`(+ 源码) | `HOLYCLAUDE_CODEX_CHAT_PERMISSION_PATCH = true` |
| `codex-complete-exit-code` | Codex 完成事件补 `exitCode:0 / success:true / aborted:false` | `dist-server/.../codex/codex-sessions.provider.js`(+ 源码) | (正则匹配 `kind:'complete'` 块) |
| `disable-self-update` | 禁用 CloudCLI 的 `cloudcli update` 与 `/api/system/update`,防止 npm 自更新覆盖补丁 | `dist-server/server/cli.js`、`dist-server/server/index.js`(+ 源码) | `HOLYCLAUDE_CLOUDCLI_SELF_UPDATE_DISABLED = true` |
| `web-terminal-rendering` | Web Terminal 插件 PTY 输出 UTF-8 解码、字体回退栈、可禁用 WebGL | **插件源码** `~/.claude-code-ui/plugins/web-terminal/src/{server,index}.ts`(构建前) | `encoding: null,`、`DEFAULT_FONT_FAMILY` |

> `web-terminal-rendering` 是特例:它不打 CloudCLI 本体,而是在 Dockerfile 里 `git clone` 插件后、`npm ci && npm run build` 之前,对插件源码打补丁(见 Dockerfile 第 388–396 行)。机制与 Layer B 一致,只是目标换成了插件源码树。

---

## 4. `.mjs` 补丁脚本的统一契约(最重要)

所有 `patch-cloudcli-*.mjs` 共享一套 **几乎模板化** 的结构。**本项目新增任何运行时补丁,必须严格遵循该契约。** 以最简单的 `patch-cloudcli-browser-runtime.mjs` 为骨架:

### 4.1 模板骨架

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// 1) 目标根目录:可被 argv[2] 覆盖,方便对本地 checkout 跑测试
const DEFAULT_CLOUDCLI_ROOT = '/usr/local/lib/node_modules/@cloudcli-ai/cloudcli';
const CLOUDCLI_ROOT = process.argv[2] || DEFAULT_CLOUDCLI_ROOT;

// 2) 统一的失败信息 + 退出码
const ERROR_MESSAGE = '[patch] ERROR: ... anchors not found';
function fail() { console.error(ERROR_MESSAGE); process.exit(1); }

// 3) 唯一 marker(用于幂等判定 + Dockerfile grep 复核)
const PATCH_MARKER = '// HolyClaude canonical browser runtime';
const EXECUTABLE_PATH_FIELD = 'executablePath: process.env.CHROME_PATH,';

// 4) 同时列出"源码"与"编译产物"两份目标(保证重构建仍保留补丁)
const targets = [
  { label: 'source',  path: `${CLOUDCLI_ROOT}/server/.../browser-use.service.ts`,  indent: '      ' },
  { label: 'runtime', path: `${CLOUDCLI_ROOT}/dist-server/server/.../browser-use.service.js`, indent: '            ' },
];

function countOccurrences(source, searchText) {
  return source.split(searchText).length - 1;
}

function patchTarget(target) {
  if (!existsSync(target.path)) fail();
  let source;
  try { source = readFileSync(target.path, 'utf8'); } catch { fail(); }

  // 5) 幂等:已经打过就 log 并返回(绝不重复打)
  const markerCount       = countOccurrences(source, PATCH_MARKER);
  const fieldCount        = countOccurrences(source, EXECUTABLE_PATH_FIELD);
  if (markerCount === 1 && fieldCount === 1 && source.includes(patchedAnchor)) {
    console.log(`[patch] ... already patched (${target.label})`);
    return;
  }

  // 6) 锚点存在性断言:旧文本必须"恰好出现一次",漂移就 fail
  if (markerCount !== 0 || fieldCount !== 0
      || countOccurrences(source, launchAnchor) !== 1
      || countOccurrences(source, READINESS_ANCHOR) !== 1) {
    fail();
  }

  // 7) 应用替换
  source = source.replace(launchAnchor, patchedAnchor)
                 .replace(READINESS_ANCHOR, READINESS_FIELD);

  // 8) 后置断言:新 marker 在、旧 marker 走、锚点完整,否则 fail
  if (countOccurrences(source, PATCH_MARKER) !== 1
      || countOccurrences(source, EXECUTABLE_PATH_FIELD) !== 1
      || countOccurrences(source, READINESS_ANCHOR) !== 0
      || !source.includes(patchedAnchor)) {
    fail();
  }

  try { writeFileSync(target.path, source); } catch { fail(); }
  console.log(`[patch] ... patched (${target.label})`);
}

for (const target of targets) patchTarget(target);
```

### 4.2 契约要点(逐条强制)

| # | 规则 | 为什么 |
|---|---|---|
| **C1** | **可参数化根目录**:`process.argv[2] || DEFAULT_CLOUDCLI_ROOT` | 能对本地 checkout 跑补丁做单测,不必依赖镜像 |
| **C2** | **统一 `fail()`**:`console.error(ERROR_MESSAGE); process.exit(1)` | 让 Docker build 在补丁失败时 **立刻中断**(fail-closed) |
| **C3** | **幂等性**:先 `countOccurrences` 判定 "已打过",命中则 `return` | 镜像层缓存、重复执行、上游部分采纳修复时都不会重复打/出错 |
| **C4** | **锚点唯一性**:旧文本必须 `=== 1` 次出现,否则 `fail()` | 防止上游改了代码后,补丁静默打错位置或打空 |
| **C5** | **后置断言**:打完后必须新 marker 在、旧 marker 走、结构完整 | 防止 `replace` 只命中部分、或被上游重构破坏 |
| **C6** | **marker 注释/常量**:每个补丁注入一句独一无二的 `// HolyClaude ...` 或 `const HOLYCLAUDE_..._PATCH = true;` | 给 Dockerfile 的 `grep -Fq` 复核提供稳定锚点;给 `verify-*.mjs` 检测器识别"是谁打的" |
| **C7** | **源码 + 产物双打**:`targets` 同时含 `.ts/.js` 源码与 `dist-server/*.js` 产物 | 上游若以源码形式重新构建,补丁仍在;只改产物会在重构建时丢失 |
| **C8** | **CRLF 归一**:`readFileSync(...).replace(/\r\n/g, '\n')`(base-path / web-terminal 采用) | 避免 Windows 换行让锚点匹配失败 |
| **C9** | **辅助函数复用**:`readSource` / `writeSource` / `replaceRequired(source, old, new)`(`new` 已存在则原样返回,`old` 不存在则 `fail()`) | 把幂等 + 锚点断言封装进一个 helper,降低出错率 |
| **C10** | **日志前缀 `[patch]`** | 与 Dockerfile 的 `echo "[patch] ..."` 风格一致,build 日志可读 |

### 4.3 复杂补丁的进阶手法

当改动较大(如 `base-path` 注入上百行运行时 helper、`disable-self-update` 整段替换函数体)时,脚本会用:

- **`findFunctionEnd` / `findBlockEnd`** — 用括号深度扫描(并正确跳过字符串/模板串/行注释/块注释)定位函数边界,从而整段替换 `async function updatePackage() {...}`。**本项目若要整段替换函数,务必复刻这套带词法感知的 `findBlockEnd`,不能简单按行或按括号数。**
- **多锚点串联**:`assertServerPatched(source)` 同时检查 6–8 个 marker 全部命中才认为成功。
- **正则回填**:`codex-complete-exit-code` 用 `String.replace(regex, (_, prefix, suffix) => ...)` 在捕获组之间插入字段。
- **静态资源校验**:`base-path` 在打补丁前先 `verifyStaticFiles(packageRoot)`,断言 `dist/index.html`、`dist/manifest.json`、`dist/sw.js`、`dist/assets/*.css` 都含预期原始内容(漂移即 `fail()`)。

---

## 5. fail-closed 验证体系

HolyClaude 的核心设计信条是 **"漂移就让构建失败,绝不静默"**。验证分布在三处:

### 5.1 Dockerfile 内联 grep 复核(每个补丁之后)

```dockerfile
RUN node /tmp/patch-cloudcli-base-path.mjs && rm -f /tmp/patch-cloudcli-base-path.mjs
RUN CLOUDCLI_SERVER=".../server/index.js" && \
    CLOUDCLI_WS_SERVER=".../websocket-server.service.js" && \
    grep -q "HOLYCLAUDE_BASE_PATH"          "$CLOUDCLI_SERVER"   && \
    grep -q "sendHolyClaudeIndexHtml"       "$CLOUDCLI_SERVER"   && \
    grep -q "stripHolyClaudeBasePathFromPathname" "$CLOUDCLI_WS_SERVER" && \
    echo "[patch] CloudCLI base path support applied to runtime"
```

- 用 `grep -Fq`(固定串)/`grep -q`(正则)断言 marker 存在。
- 任何一行 `grep` 失败 → 该 `RUN` 退出非零 → **docker build 失败**。
- 这是对 `.mjs` 脚本自身后置断言的 **第二道独立闸**(防止脚本被改坏或被上游完全重构)。

### 5.2 状态检测器 `verify-cloudcli-account-management-support.mjs`

专门检测 Layer A 的账号管理 overlay 是否就位。它:

- 解包 tgz(若传文件)或读安装目录;
- 逐文件 `includesAll(source, markers)` 检查一组 marker;
- 输出 JSON 状态机:

```jsonc
{
  "state": "holyclaude-bridge-complete"  // 本 overlay 完整
           // 或 "upstream-complete"     // 上游已原生支持 → 可以移除 overlay
           // 或 "unsupported-known"     // 该版本已知不支持
           // 或 "partial-or-drifted"    // 部分命中 → 危险
  , "ok": true, "checks": { ... }
}
```

- `partial-or-drifted` / `unsupported-known` 时 `process.exit(1)`。

> 这个检测器实现了 manifest 里写的 **"removal" 条款**:一旦上游 CloudCLI 原生支持本地账号管理,状态会变成 `upstream-complete`,HolyClaude 就可以删掉这套 overlay。**本项目自定义补丁也应配套写一个检测器,标注移除条件。**

### 5.3 构建期可复现双校验(见 §2.2 第 6–7 步)

两次 `npm pack` 的 tgz `sha256` 必须一致;两次 `npm install -g` 的依赖树归一化 `sha256` 必须一致。任何不一致都 `throw`。

---

## 6. 补丁全量清单(Inventory)

### Layer A(源码 overlay,通过 tgz 入库)

| overlay | patches | 触发 issue / 目的 | 入口脚本 |
|---|---|---|---|
| `cloudcli-account-management` | `0001-local-account-management.patch`<br>`0002-node26-better-sqlite3-lock.patch` | #797 / #928 / #526:本地 logout + 改密;Node26 下 `better-sqlite3@12.11.1` | `build-cloudcli-account-management-artifact-container.mjs` |

### Layer B(运行时改已安装产物)

| 补丁 | 目标文件(安装目录下) | issue | 关键环境/二进制依赖 |
|---|---|---|---|
| `browser-runtime` | `server/modules/browser-use/browser-use.service.{ts,js}` | (Bookworm Chromium) | `process.env.CHROME_PATH` → `/usr/bin/chromium` |
| `base-path` | `server/index.js`、`server/modules/websocket/services/websocket-server.service.js`、静态资源 `dist/*` | #64 | `HOLYCLAUDE_BASE_PATH` |
| `apprise-notifications` | `server/modules/notifications/services/notification-orchestrator.service.js` | #17 | `/usr/local/bin/notify.py` |
| `codex-permissions` | `server/openai-codex.js` | #18 | `HOLYCLAUDE_CODEX_CHAT_PERMISSION_MODE` |
| `codex-complete-exit-code` | `server/modules/providers/list/codex/codex-sessions.provider.{ts,js}` | #19 | — |
| `disable-self-update` | `server/cli.js`、`server/index.js` | #50 | `docker compose pull` 提示语 |
| `web-terminal-rendering` | 插件源码 `plugins/web-terminal/src/{server,index}.ts` | (CJK/emoji 渲染) | `localStorage['web-terminal-disable-webgl']` |

---

## 7. 本项目(agentmate)自定义补丁标准规范

> 以下是我们以 HolyClaude 官方镜像为基础做二次定制时 **必须遵守** 的规范。

### 7.1 决策树:新补丁走哪一层?

```
新需求:要改 CloudCLI 的某段行为
   │
   ├─ 改动会进入前端 bundle(dist/assets/*.js)?
   │     或需要 TypeScript 类型检查通过?
   │     或要改 package-lock / 加依赖?
   │   → YES ─→ Layer A: 新增 vendor/patches/<feature>/00NN-*.patch
   │            (并重跑 build-*-artifact.mjs,刷新 tgz + manifest)
   │
   ├─ 只改服务端,且依赖 HolyClaude 容器特有的环境变量/宿主二进制
   │   (CHROME_PATH / HOLYCLAUDE_* / /usr/local/bin/notify.py …)?
   │   → YES ─→ Layer B: 新增 scripts/patch-cloudcli-<feature>.mjs
   │
   └─ 两层都满足 ─→ 默认 Layer B(漂移面小,不碰可复现链)
                    除非补丁需要被前端感知
```

### 7.2 命名与目录约定

| 类型 | 路径 | 命名 |
|---|---|---|
| Layer A patch | `vendor/HolyClaude/vendor/patches/<feature>/00NN-<slug>.patch` | 4 位序号 + kebab-case;按字典序即应用顺序 |
| Layer A overlay README | `vendor/HolyClaude/vendor/patches/<feature>/README.md` | 说明 upstream commit、issue 链接、**移除条件** |
| Layer B 脚本 | `vendor/HolyClaude/scripts/patch-cloudcli-<feature>.mjs` | 一律 `patch-cloudcli-` 前缀,ESM(`import`),`.mjs` |
| 检测器(可选) | `vendor/HolyClaude/scripts/verify-cloudcli-<feature>-support.mjs` | 配套状态机 + 移除条件 |
| 产物 | `vendor/HolyClaude/vendor/artifacts/` | tgz + `<feature>.manifest.json` 成对入库 |

> 本项目若把 HolyClaude 作为 git 子目录/子模块引入,新增补丁应放在 **与 HolyClaude 同级或之上的自有目录**(例如 `patches/`、`scripts/`),通过扩展的 Dockerfile `COPY` 进来,**避免直接修改 vendor/HolyClaude 源码**(便于跟踪上游)。

### 7.3 Layer B 新增补丁的强制清单(对照 §4.2)

- [ ] **C1** 顶部 `const ROOT = process.argv[2] || DEFAULT_...`,可对本地 checkout 单测。
- [ ] **C2** 统一 `fail()` → `process.exit(1)`,错误信息以 `[patch] ERROR:` 开头。
- [ ] **C3** 幂等:先判定"已打过"(`marker` 恰好出现且新文本在)→ `return`。
- [ ] **C4** 锚点断言:旧文本 `countOccurrences(...) === 1`,否则 `fail()`。
- [ ] **C5** 后置断言:打完后新 marker 在、旧 marker 走。
- [ ] **C6** 注入唯一 marker(注释或 `const HOLYCLAUDE_..._PATCH = true;`)。
- [ ] **C7** 同时改 `.ts/.js` 源码与 `dist-server/*.js` 产物(`targets[]` 双条目)。
- [ ] **C8** 读入后 `.replace(/\r\n/g, '\n')`。
- [ ] **C9** 用 `replaceRequired(source, old, new)` 之类 helper 封装幂等替换。
- [ ] **C10** 成功日志 `console.log('[patch] ... applied')`。

### 7.4 Dockerfile 集成强制清单

每个 Layer B 补丁在 Dockerfile 中必须出现 **三段**:

```dockerfile
# ① COPY 脚本(需要写非 root 文件时加 --chown=claude:claude)
COPY scripts/patch-cloudcli-<feature>.mjs /tmp/patch-cloudcli-<feature>.mjs

# ② 应用并清理
RUN node /tmp/patch-cloudcli-<feature>.mjs && rm -f /tmp/patch-cloudcli-<feature>.mjs

# ③ fail-closed 复核(独立 RUN,与脚本的后置断言互为冗余)
RUN TARGET="/usr/local/lib/node_modules/@cloudcli-ai/cloudcli/dist-server/server/<file>.js" && \
    grep -Fq "<unique marker>" "$TARGET" && \
    echo "[patch] <feature> applied to runtime"
```

### 7.5 Layer A 新增补丁的强制清单

- [ ] 锚定 **upstream commit**(在 overlay README + manifest 里固化),构建脚本里 `git checkout` 后断言 `HEAD == upstreamCommit`。
- [ ] 在 `build-cloudcli-account-management-artifact.mjs` 的 `patchDir` 同级 **新增 overlay 目录**,patch 文件名 `00NN-` 前缀,字典序即应用顺序。
- [ ] `git apply -C0` 应用(零空白容差,patch 本体在仓库里空白归一化)。
- [ ] 走完整 `npm ci → typecheck → build → lint → shrinkwrap` 链。
- [ ] **双重 pack + 双重 install** 一致性校验,差异即 `throw`。
- [ ] 刷新 `manifest.json`:记录 upstream/build/artifact/patches 的全部 `sha256`,以及 **`removal` 条款**。
- [ ] tgz 与 manifest 成对 commit 进 `vendor/artifacts/`。
- [ ] 写配套 `verify-cloudcli-<feature>-support.mjs`,Dockerfile 末尾跑它,`ok !== true` 即构建失败。

### 7.6 升级 CloudCLI 时的流程

1. 在 `build-*-artifact.mjs` 更新 `upstreamCommit` / `packageVersion`,重跑构建。
2. 每个 Layer B 补丁的 **锚点断言** 会自动暴露漂移:`patch-*.mjs` 在旧文本找不到时 `fail()`,Dockerfile 的 `grep` 复核也会失败。
3. 对每个失败点:要么改写补丁适配新锚点,要么(若上游已采纳)删除补丁、保留 `grep -q <upstream-marker>` 断言。
4. 更新 `verify-*.mjs` 的状态机;若上游完整支持,按 manifest 的 `removal` 条款删除 overlay。
5. **不允许**:静默跳过失败补丁、用 `|| true` 兜底、降低断言强度。

---

## 8. 落地步骤(给本项目新补丁的 SOP)

以 "新增一个 Layer B 补丁:让 CloudCLI 读取 `MY_AGENT_FEATURE` 环境变量" 为例:

1. **定位** :在 `vendor/claudecodeui/` 里 grep 出要改的源文件与对应 `dist-server/` 产物,确认两份都存在(对照 §0 的目录结构)。
2. **抄模板** :复制 `patch-cloudcli-browser-runtime.mjs`(最简单)为 `patch-cloudcli-my-feature.mjs`,改 `DEFAULT_CLOUDCLI_ROOT`、marker、`targets[]`、`launchAnchor`/`patchedAnchor`。
3. **本地验证** :对 vendor checkout 跑两次 ——
   ```bash
   node scripts/patch-cloudcli-my-feature.mjs /opt/agentmate/vendor/claudecodeui   # 第一次:应打印 applied
   node scripts/patch-cloudcli-my-feature.mjs /opt/agentmate/vendor/claudecodeui   # 第二次:应打印 already patched(幂等)
   ```
   用 `git -C vendor/claudecodeui diff` 复核改动符合预期。完事后 `git checkout -- .` 还原。
4. **接入 Dockerfile** :按 §7.4 三段式 `COPY` / `RUN node` / `RUN grep -Fq`。
5. **build 验证** :`docker build`,确认 `[patch] ... applied` 与 `[patch] ... applied to runtime` 都打印;故意把锚点改坏一次,确认 build **会失败**。
6. **(可选)写检测器** :若该补丁有 "上游可能采纳" 的可能,加 `verify-cloudcli-my-feature-support.mjs`,在 Dockerfile 末尾运行。
7. **文档** :在 overlay/补丁同目录写一行 issue 来源与移除条件,便于后续升级时溯源。

---

## 附录:关键源码索引

| 主题 | 文件 |
|---|---|
| 整体编排(补丁顺序/复核) | [Dockerfile](../vendor/HolyClaude/Dockerfile) 第 296–396 行 |
| Layer A 构建逻辑 | [build-cloudcli-account-management-artifact.mjs](../vendor/HolyClaude/scripts/build-cloudcli-account-management-artifact.mjs) |
| Layer A 容器入口 | [build-cloudcli-account-management-artifact-container.mjs](../vendor/HolyClaude/scripts/build-cloudcli-account-management-artifact-container.mjs) |
| Layer A overlay 补丁 | [vendor/patches/cloudcli-account-management/](../vendor/HolyClaude/vendor/patches/cloudcli-account-management/) |
| Layer A 产物清单 | [cloudcli-account-management.manifest.json](../vendor/HolyClaude/vendor/artifacts/cloudcli-account-management.manifest.json) |
| Layer B 最简模板 | [patch-cloudcli-browser-runtime.mjs](../vendor/HolyClaude/scripts/patch-cloudcli-browser-runtime.mjs) |
| Layer B 复杂模板(注入大段 helper) | [patch-cloudcli-base-path.mjs](../vendor/HolyClaude/scripts/patch-cloudcli-base-path.mjs) |
| Layer B 整段替换函数体 | [patch-cloudcli-disable-self-update.mjs](../vendor/HolyClaude/scripts/patch-cloudcli-disable-self-update.mjs) |
| 状态检测器范式 | [verify-cloudcli-account-management-support.mjs](../vendor/HolyClaude/scripts/verify-cloudcli-account-management-support.mjs) |
| 插件源码补丁范式 | [patch-cloudcli-web-terminal-rendering.mjs](../vendor/HolyClaude/scripts/patch-cloudcli-web-terminal-rendering.mjs) |
| 架构与设计决策 | [docs/architecture.md](../vendor/HolyClaude/docs/architecture.md) |
| 补丁演进历史与动机 | [docs/CHANGELOG.md](../vendor/HolyClaude/docs/CHANGELOG.md) |
