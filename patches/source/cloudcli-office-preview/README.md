# CloudCLI office-preview bridge (docx / xlsx / pptx + family)

AgentMate carries this source overlay until CloudCLI ships native inline preview for
Office documents. It adds a new `'office'` preview kind that renders
`doc / docx / xls / xlsx / ppt / pptx / odt / ods / odp` inline in the file manager
using the [`@open-file-viewer`](https://github.com/xushanpei/open-file-viewer) library
(`officePlugin` only). Existing text / image / pdf / audio / video handling is
untouched. Preview is **view-only** (no editing); the editor's existing save guard
already refuses to write any file that has a `previewKind`.

Upstream source: https://github.com/siteboon/claudecodeui
Pinned source commit: `615e2ca2926a68e6e3336d49b592616654a69424` (matches the
`coderluii/holyclaude:1.5.0` base image, which ships `@cloudcli-ai/cloudcli@1.36.2`)
Package version: `@cloudcli-ai/cloudcli@1.36.2`
Renderer: `@open-file-viewer/core@0.1.26` + `@open-file-viewer/react@0.1.26` (MIT)

## What the overlay changes (all under `src/`, frontend only)

- **NEW** `src/components/code-editor/view/subcomponents/OfficePreview.tsx` — a
  `React.lazy`-loaded component wrapping `<FileViewer plugins={[officePlugin()]}>`.
  All `@open-file-viewer/*` imports live inside this module, so Vite code-splits the
  heavy office deps (docx-preview, mammoth, xlsx, @aiden0z/pptx-renderer, jszip,
  dompurify, …) into an async chunk fetched only on first office open.
- `src/components/code-editor/utils/previewableFile.ts` — adds `'office'` to the
  `PreviewKind` union, the 9 office extensions to `EXTENSION_MIME`, and an office
  branch to `kindForMime`. This is the single source of truth; routing flows
  automatically from here (no changes to `useCodeEditorDocument`, `CodeEditor`, the
  file tree, the backend, or i18n).
- `src/components/code-editor/utils/binaryFile.ts` — drops the 9 office extensions
  from the binary fallback list (they are now previewed).
- `src/components/code-editor/view/subcomponents/CodeEditorMediaPreview.tsx` — adds a
  `case 'office'` to the render switch, delegating to the lazy `OfficePreview` inside
  `<Suspense>`, reusing the existing header / fullscreen / close chrome and the
  authenticated blob-fetch pipeline.
- `package.json` / `package-lock.json` — adds the two `@open-file-viewer/*` deps
  (exact pins). See `0002-office-preview-deps.patch`.

`csv / tsv / rtf` are intentionally **not** added — they are text-editable today and
adding them would steal them from the code editor.

## Install strategy: dist-only overlay (regression-free)

The Dockerfile builds this tgz but overlays **only `dist/`** onto the installed
CloudCLI, leaving `dist-server/` untouched. I verified (by reading all seven
`patch-cloudcli-*.mjs` runtime patches) that **none of them writes to `dist/`** —
they all target `dist-server/` (or, for web-terminal, an external plugin dir). So
all HolyClaude runtime patches (base-path, Chromium, Apprise, Codex, self-update,
web-terminal) keep working with zero re-application, and the base-path runtime's
request-time `dist/` transforms keep working because the rebuilt `dist/` retains
every upstream marker it depends on (`href="/manifest.json"`,
`navigator.serviceWorker.register('/sw.js')`, `CACHE_NAME = 'claude-ui-v2'`,
`__ROUTER_BASENAME__`, `"start_url": "/"`).

## Rules

1. Build from the pinned source with HolyClaude's account-management overlay chained
   in first, then these patches:
   `node scripts/build-cloudcli-office-preview-artifact-container.mjs`
2. Do not hand-edit hashed `dist/assets/*.js` files.
3. Keep the two `@open-file-viewer/*@0.1.26` pins exact (pre-1.0 library, fast-moving).
4. Keep the manifest next to the generated tarball.
5. Detector marker that survives minification: the `data-agentmate-office-preview`
   attribute string on the `OfficePreview` wrapper div (a JS comment would be stripped
   by esbuild). `scripts/verify-cloudcli-office-preview-support.mjs` greps for it.

## Removal

Remove when CloudCLI ships native docx/xlsx/pptx inline preview
(`scripts/verify-cloudcli-office-preview-support.mjs` reports `upstream-complete`), or
when `@open-file-viewer/*` is swapped for another renderer. Then delete this directory,
`scripts/build-cloudcli-office-preview-*`, `patches/source/artifacts/cloudcli-*office-preview*`
+ `cloudcli-office-preview.manifest.json`, and the Dockerfile Layer A stage.
