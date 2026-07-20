# 001 — CloudCLI 多格式文件预览(docx / xlsx / pptx + 家族)

> 本文档记录 AgentMate 为 CloudCLI 增加 Office 文档内联预览的补丁,目标是**当上游 `siteboon/claudecodeui` 升级时,指导本补丁同步升级**。所有改动都以 Layer A 源码补丁形式存在,不直接修改任何 vendored 上游代码。

---

## 1. 处理的上游代码版本

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/siteboon/claudecodeui |
| npm 包名 | `@cloudcli-ai/cloudcli`(产品名 CloudCLI,旧名 claudecodeui) |
| **固定 commit** | **`615e2ca2926a68e6e3336d49b592616654a69424`** |
| **包版本** | **`1.36.2`** |
| 上游 License | AGPL-3.0-or-later |
| 基础镜像 | `coderluii/holyclaude:1.5.0`(内含 CloudCLI 1.36.2 + HolyClaude account-management overlay + 7 个运行时补丁) |
| 引入的第三方库 | `@open-file-viewer/core@0.1.26` + `@open-file-viewer/react@0.1.26`(MIT,精确 pin,pre-1.0) |

> 为什么固定到 `615e2ca2` / 1.36.2:与基础镜像里已安装的 CloudCLI 版本严格对齐,保证重建出的前端 bundle 与基础镜像里未替换的 `dist-server/`(后端 + HolyClaude 运行时补丁)版本一致,避免前后端版本错配。

---

## 2. 原始代码中存在的问题

CloudCLI 的文件预览分发链只有一个入口(`CodeEditor.tsx` → `useCodeEditorDocument` → `getPreviewKind`),原始只支持:

- **文本/代码** → CodeMirror(`@uiw/react-codemirror`)
- **图片** → 原生 `<img>`(`CodeEditorMediaPreview` 的 `case 'image'`)
- **PDF** → 原生 `<iframe>`(blob URL + 魔数校验,`case 'pdf'`)
- **音频/视频** → 原生 `<audio>`/`<video>`
- **markdown** → `react-markdown`(作为文本编辑的子模式)

而 `doc / docx / xls / xlsx / ppt / pptx / odt / ods / odp` 这 9 个扩展名被硬编码在 [`vendor/claudecodeui/src/components/code-editor/utils/binaryFile.ts`](../../vendor/claudecodeui/src/components/code-editor/utils/binaryFile.ts) 的 `BINARY_EXTENSIONS` 列表里,分发时命中"二进制文件无法显示"占位符:

```
'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
```

**根因**:项目里没有任何 Office 文档解析库,且 `PreviewKind` 类型只有 `'image' | 'pdf' | 'video' | 'audio'`,没有为 Office 文档预留渲染通道。用户在文件管理器点击 docx/xlsx/pptx 只能看到"无法显示"。

---

## 3. 解决思路与技术方案

### 3.1 为什么走 Layer A(不是 Layer B)

本改动同时命中 Layer A 的三条触发条件(决策树见 [`docs/how_to_patch_claudecodeui.md`](../how_to_patch_claudecodeui.md) §7.1):

1. 要进入**前端 bundle**(`dist/assets/*.js`,新增 React 组件);
2. 需要让 **TypeScript 类型检查**通过(扩展 `PreviewKind` 联合类型);
3. 要改**依赖锁**(新增 `@open-file-viewer/*` 依赖)。

Layer B(改已编译的 `dist-server/*.js`)无法 patch minified 的前端 bundle,所以必须 Layer A:从上游源码 `git apply` 补丁 → 重新 `npm build` 成 tgz。

### 3.2 渲染库选型:只引 `officePlugin`

`@open-file-viewer` 是一个 pnpm monorepo,核心包 `@open-file-viewer/core` 内含 docx-preview / mammoth / xlsx(SheetJS)/ @aiden0z/pptx-renderer / jszip / dompurify 等纯前端依赖,**无 native 依赖**。只 `import { officePlugin }`,**不引** `imagePlugin/pdfPlugin/textPlugin`——这样既保证现有图片/PDF/文本的处理路径字节级不变,又让 Rollup 能 tree-shake 掉 `three / leaflet / hls.js` 等其他插件的重依赖。

### 3.3 懒加载切分(首屏零负担)

`@open-file-viewer/core` 解压后约 4.5MB。通过 `React.lazy(() => import('./OfficePreview'))` 把整个 Office 渲染路径隔离成**独立异步 chunk**,只有用户首次点开 Office 文件时才下载。实测产物:

- `OfficePreview-<hash>.js`(244KB)——bridge + react 适配器 + officePlugin
- `aiden0z-pptx-renderer-<hash>.js`(995KB)——**仅打开 pptx 时**才按需加载
- `xlsx-<hash>.js`(429KB)——仅打开 xlsx 时
- 主入口 `index-<hash>.js` 不含任何 office 代码,且 `three/leaflet` 零泄漏

### 3.4 安装策略:dist-only 覆盖(零回归)

重建并重装 CloudCLI 会**抹掉**基础镜像里 HolyClaude 已烤进去的 7 个运行时补丁。通过**通读全部 7 个 `patch-cloudcli-*.mjs`** 确认:**没有一个写 `dist/`**——它们都写 `dist-server/`(或 web-terminal 的外部插件目录)。`patch-cloudcli-base-path.mjs` 对 `dist/` 只读(`verifyStaticFiles`),真正的改写在请求时由注入到 `dist-server/server/index.js` 的 helper 内存完成。

因此 Dockerfile 里**只覆盖 `dist/`**,保留 `dist-server/`:

- 7 个 HolyClaude 运行时补丁原样保留,**无需重新应用**;
- account-management 等已有功能不回归;
- base-path 运行时改写依赖的 upstream 标记(`href="/manifest.json"`、`navigator.serviceWorker.register('/sw.js')`、`CACHE_NAME='claude-ui-v2'`、`__ROUTER_BASENAME__`、`"start_url": "/"`)在重建的 `dist/` 里全部存活(补丁不动这些文件),并由 Dockerfile grep fail-closed 断言。

### 3.5 链式 HolyClaude overlay

重建 tgz 时**先应用** HolyClaude 自己的 account-management overlay(`0001-local-account-management.patch` + `0002-node26-better-sqlite3-lock.patch`),**再应用**本 office-preview overlay。否则覆盖 `dist/` 会丢失 account-management 的前端 UI。

---

## 4. 补丁调整了原始代码中的哪些地方,怎么修改的

> 补丁源文件:[`patches/source/cloudcli-office-preview/0001-office-preview.patch`](../../patches/source/cloudcli-office-preview/0001-office-preview.patch)(4 个 src 文件)+ [`0002-office-preview-deps.patch`](../../patches/source/cloudcli-office-preview/0002-office-preview-deps.patch)(依赖锁)。本节给出每个改动的**精确锚点**,升级时按此在新上游里定位。

### 4.1 新增文件 `src/components/code-editor/view/subcomponents/OfficePreview.tsx`

完全新增。是 office 渲染的唯一入口,所有 `@open-file-viewer/*` import 都集中在此(保证整块进异步 chunk)。要点:

```tsx
// AGENTMATE_OFFICE_PREVIEW_BRIDGE   ← 源码可读性标记(注释会被 esbuild 压缩掉,
//                                      检测器改用下面的 data- 属性字符串)
import { useMemo, useState } from 'react';
import { FileViewer } from '@open-file-viewer/react';
import { officePlugin } from '@open-file-viewer/core';
import '@open-file-viewer/core/style.css';   // 必须引入一次,否则布局错乱

// plugins 必须 memo:officePlugin() 每次返回新实例,不 memo 会导致 FileViewer
// 的 mount effect 每次渲染都销毁重建 viewer。
const plugins = useMemo(() => [officePlugin()], []);
// ...
return (
  <div className="h-full w-full" data-agentmate-office-preview="">  {/* ← 抗压缩标记 */}
    <FileViewer file={url} fileName={fileName} plugins={plugins}
      locale={locale} theme="auto" toolbar width="100%" height="100%"
      onError={() => setFailed(true)} onUnsupported={() => setFailed(true)} />
  </div>
);
```

关键契约:
- 接收 `url`(blob URL,由 `CodeEditorMediaPreview` 用 `authenticatedFetch('/api/projects/:id/files/content?path=…')` 取字节后 build)、`fileName`、`errorLabel`。
- `FileViewer` 内部会自己去 fetch 这个 same-origin blob URL,无需额外传 auth header。
- **`data-agentmate-office-preview`** 是字符串属性,esbuild 压缩后仍保留——这是检测器与 Dockerfile grep 的**抗压缩标记**(JS 注释会被剥离,不能用)。
- `theme="auto"`:库支持 `'light'|'dark'|'auto'`(已在 `@open-file-viewer/core` 的 `PreviewTheme` 类型确认)。

### 4.2 `src/components/code-editor/utils/previewableFile.ts`(分发的唯一真相源)

三处改动:

**(a) 扩展 `PreviewKind` 联合类型**(原第 6 行):
```diff
-export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio';
+export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'office';
```

**(b) `EXTENSION_MIME` 映射加 9 个 office 扩展**(接在 `weba: 'audio/webm',` 之后):
```ts
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
```

**(c) `kindForMime` 加 office 分支**(在 `return null;` 之前):
```ts
  if (
    mime.startsWith('application/vnd.openxmlformats-officedocument') ||
    mime.startsWith('application/vnd.ms-') ||
    mime.startsWith('application/vnd.oasis.opendocument')
  ) {
    return 'office';
  }
```

> **刻意不加** `csv / tsv / rtf`:它们当前是文本可编辑的(不在 `BINARY_EXTENSIONS`),加了会从代码编辑器抢走。如未来要支持,只需在 `EXTENSION_MIME` 加映射——`kindForMime` 已自动兜底。

> 这一处是**整个特性的总开关**:`useCodeEditorDocument` 完全自动(无需改动),`previewKind` 一旦返回 `'office'`,加载 effect 自动短路、`handleSave` 自动拒绝写盘(只读)。

### 4.3 `src/components/code-editor/utils/binaryFile.ts`(移除死分支)

原第 10 行的 `// Documents` 行:
```diff
-  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
+  'pdf',
```
> 严格说不是必须(`previewKind` 判定在 `isBinary` 之前,不移除也是死代码),但保留会让两份名单漂移,故清理。`pdf` 保留(同 office 一样靠 previewKind 优先命中)。

### 4.4 `src/components/code-editor/view/subcomponents/CodeEditorMediaPreview.tsx`(挂载点)

**(a) 合并 react import**(原第 1 行):
```diff
-import { useEffect, useState } from 'react';
+import { Suspense, lazy, useEffect, useState } from 'react';
```

**(b) 在 import 块后加懒加载常量**:
```ts
const OfficePreview = lazy(() => import('./OfficePreview'));
```

**(c) `renderMedia()` 的 `switch (kind)` 加 case**(在 `case 'audio'` 之后、`default` 之前):
```tsx
      case 'office':
        return (
          <Suspense fallback={<div className="…">{labels.loading}</div>}>
            <OfficePreview url={currentUrl} fileName={file.name} errorLabel={labels.error} />
          </Suspense>
        );
```
> 复用 `CodeEditorMediaPreview` 已有的 header / 全屏 / 关闭 chrome 和 `authenticatedFetch` → blob URL 流水线。`currentUrl` 在此处保证非空(外层 `{!loading && currentUrl && renderMedia()}` 门控)。

### 4.5 `package.json` + `package-lock.json`(依赖)

`dependencies` 加两条**精确 pin**(无 `^`,因 pre-1.0 库变动快):
```json
"@open-file-viewer/core": "0.1.26",
"@open-file-viewer/react": "0.1.26"
```
`package-lock.json` 由 `npm install --package-lock-only` 重新生成后捕获为 diff(约 +543 行,主要是 `@open-file-viewer/*` 及其传递依赖)。生成时**必须先应用 HolyClaude 的 `0002` 锁补丁**,以保证本补丁的 context 匹配"应用 HolyClaude 0002 之后"的锁文件状态。

---

## 5. 构建 / 安装 / 检测机制

| 环节 | 文件 | 说明 |
|---|---|---|
| overlay 目录 | [`patches/source/cloudcli-office-preview/`](../../patches/source/cloudcli-office-preview/) | `0001-*.patch`、`0002-*.patch`、`README.md` |
| 构建脚本 | [`scripts/build-cloudcli-office-preview-artifact.mjs`](../../scripts/build-cloudcli-office-preview-artifact.mjs) + `-container.mjs` | 镜像 HolyClaude account-management 构建:固定 `node:26.5.0-bookworm-slim@sha256:2d49d876…`、Node v26.5.0、npm 11.17.0;链式 patch(HolyClaude 先 → office 后);`npm ci → typecheck → build → lint → shrinkwrap`;**双 pack sha256 + 双 install 依赖树 sha256** 必须一致 |
| 产物 | [`patches/source/artifacts/cloudcli-ai-cloudcli-1.36.2-agentmate-office-preview.tgz`](../../patches/source/artifacts/cloudcli-ai-cloudcli-1.36.2-agentmate-office-preview.tgz) + `.manifest.json` | tgz + manifest 成对入库;manifest 记录全部 sha256 与移除条款 |
| 检测器 | [`scripts/verify-cloudcli-office-preview-support.mjs`](../../scripts/verify-cloudcli-office-preview-support.mjs) | 4 态状态机;标记 = `data-agentmate-office-preview` + OOXML MIME 串 + `@open-file-viewer/core` in lockfile |
| Dockerfile | [`Dockerfile`](../../Dockerfile) | Layer A 阶段:COPY tgz + manifest + 检测器 → 只解出 `package/dist` 覆盖 → grep 断言 base-path 标记 + office 标记 → 跑检测器断言 `agentmate-bridge-complete` → 清理。**跑在 Layer B 之前** |

**fail-closed 漂移探测点**(任一失败即 build 失败,绝不静默):
1. `git apply -C0` 每个 patch(context 漂移 → apply 失败);
2. `npm ci`(锁文件与 package.json 不同步 → 失败);
3. `npm run typecheck / build / lint`;
4. 双 pack / 双 install sha256 不一致 → `throw`;
5. Dockerfile 的 grep(base-path 标记 / office 标记缺失);
6. 检测器状态 ≠ `agentmate-bridge-complete`。

---

## 6. 升级指南(上游 bump 时怎么做)

当 `coderluii/holyclaude` 升级,或 CloudCLI 发新版本时:

### 6.1 若只升 HolyClaude 基础镜像(`Dockerfile` 的 `FROM`)

通常**无需改本补丁**。`docker compose build` 会自动暴露问题:
- 基础镜像里 CloudCLI 版本若变 → manifest 里的 `version: 1.36.2` 仍对(本 tgz 自带版本),但需确认新基础镜像的 `dist-server` 与本 tgz 的 `dist/`(1.36.2)前后端兼容。若 HolyClaude 升了 CloudCLI 版本,**建议同步 6.2**。
- Layer B 的 `apply-cloudcli-patches.sh` 在新 `dist/` 上重跑(幂等)。

### 6.2 若要跟随上游 CloudCLI 新版本

1. **改构建脚本的 pin**:[`scripts/build-cloudcli-office-preview-artifact.mjs`](../../scripts/build-cloudcli-office-preview-artifact.mjs) 里的 `upstreamCommit`、`packageVersion`、`artifactFile` 改成新值;同步 manifest 模板里的 `upstream.commit/version`。
2. **在新 commit 上重新生成补丁**:
   - `git worktree add` 新 commit 的 checkout;
   - 按本文件 §4 的**锚点**在新源码里重新定位(若行号/上下文变了);
   - 重新做 4 个 src 改动 + 依赖改动,`git diff` 覆盖 `0001` / `0002`;
   - 锁文件 patch 务必在"应用 HolyClaude 当前 overlay 之后"重新 `npm install --package-lock-only` 生成。
3. **跑构建脚本**:`node scripts/build-cloudcli-office-preview-artifact-container.mjs`。任一 fail-closed 点(apply / ci / typecheck / 双 pack)失败都会告诉你哪里漂了,逐个修。
4. **更新检测器**(若上游新增了原生 office 预览):状态会变 `upstream-complete` → 按移除条款删 overlay。
5. **重新 e2e 验证**(见 §7)。

### 6.3 关键锚点速查(升级时在新上游里 grep 这些确认结构没变)

| 锚点 | 文件 | 含义 |
|---|---|---|
| `export type PreviewKind = 'image' \| 'pdf' \| 'video' \| 'audio';` | `previewableFile.ts` | 类型扩展点 |
| `const EXTENSION_MIME: Record<string, string>` | `previewableFile.ts` | MIME 注册表 |
| `const kindForMime = (mime: string): PreviewKind \| null` | `previewableFile.ts` | kind 推导 |
| `'pdf', 'doc', 'docx', …, 'odp',` | `binaryFile.ts` | 要移除的 office 条目 |
| `import { useEffect, useState } from 'react';` | `CodeEditorMediaPreview.tsx` | react import 合并点 |
| `switch (kind) { … case 'audio': … default: return null; }` | `CodeEditorMediaPreview.tsx` 的 `renderMedia()` | case 插入点 |
| `const contentUrl = /api/projects/${projectId}/files/content?path=…` | `CodeEditorMediaPreview.tsx` | blob 取数口(office 复用) |
| `if (previewKind) return <CodeEditorMediaPreview …/>` | `CodeEditor.tsx` | 分发入口(通常无需改) |
| `getPreviewKind(file.name)` / `if (previewKind || isBinaryFile(fileName)) return;` | `useCodeEditorDocument.ts` | 自动短路 + 只读保护(通常无需改) |

> 若上游重构了文件预览架构(例如把 `CodeEditorMediaPreview` 拆分、或 `PreviewKind` 改成枚举),需对应改写本补丁的 §4.2 / §4.4 部分,但 §4.1 的 `OfficePreview.tsx` 与 §3.2 的"只引 officePlugin + 懒加载"思路不变。

### 6.4 `@open-file-viewer/*` 版本升级

库处于 `0.1.x`(pre-1.0,变动快)。升级时:
- 改 `package.json` 两条 pin + 重新生成 `0002` 锁补丁;
- 重新确认 `FileViewer` / `officePlugin` 的 API(尤其是 `theme`、`file`、`plugins` 的签名),必要时改 `OfficePreview.tsx`;
- 检测器标记 `data-agentmate-office-preview` 是我们自己注入的,与库版本无关,保持稳定。

---

## 7. 验证与已知风险

### 7.1 已通过的验证(2026-07-21)

- 构建:4-patch 链按序 apply 通过;双 pack sha256 一致(可复现);检测器对 tgz 报 `agentmate-bridge-complete`;镜像 build 打印 `office-preview dist overlay applied`;容器健康启动。
- e2e(浏览器实测):docx(`.docx-wrapper` 渲染)、xlsx(`table` + Sheet 标签)、pptx(slide + pptx-renderer 动态加载)全部渲染;文本文件仍走 CodeMirror(`officePreview:false`),回归无碍。
- 后端零改动:`/files/content` 已正确以 OOXML MIME 流式返回。

### 7.2 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| `xlsx@0.18.5`(SheetJS)有历史 CVE | 仅在懒加载 chunk 内解析用户自己的 same-origin blob;渲染 HTML 经 dompurify 清洗;跟踪 `@open-file-viewer/core` 升级 |
| `@open-file-viewer/*@0.1.x` 变动快 | 精确 pin(无 `^`);manifest 记录 resolved 版本;构建断言 |
| base-path 标记被上游重构掉 | Dockerfile grep fail-closed;固定 upstream commit |
| 重建 tgz 抹掉 HolyClaude 运行时补丁 | dist-only 覆盖策略(只动 `dist/`),`dist-server/` 原样保留 |

---

## 8. 相关文件清单

```
patches/source/cloudcli-office-preview/
├── 0001-office-preview.patch          # 源码补丁(4 个 src 文件)
├── 0002-office-preview-deps.patch     # package.json + lockfile
└── README.md                          # overlay 说明 + 移除条件
patches/source/artifacts/
├── cloudcli-ai-cloudcli-1.36.2-agentmate-office-preview.tgz
└── cloudcli-office-preview.manifest.json
scripts/
├── build-cloudcli-office-preview-artifact.mjs
├── build-cloudcli-office-preview-artifact-container.mjs
└── verify-cloudcli-office-preview-support.mjs
Dockerfile                              # 新增 Layer A 阶段(dist-only 覆盖)
```

**移除条件**:当 CloudCLI 原生支持 docx/xlsx/pptx 内联预览(检测器报 `upstream-complete`),或替换渲染库时,删除上述 overlay 目录、`scripts/build-cloudcli-office-preview-*`、`patches/source/artifacts/cloudcli-*office-preview*` + manifest,以及 Dockerfile 的 Layer A 阶段。
