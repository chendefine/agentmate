# AgentMate CloudCLI 补丁目录

本目录存放 AgentMate 在 **HolyClaude 官方镜像**(`coderluii/holyclaude:1.5.0`)之上,对 **CloudCLI**(`@cloudcli-ai/cloudcli`,即 `siteboon/claudecodeui`)做的二次定制补丁。

> 完整的补丁机制、契约与决策树见 [`docs/how_to_patch_claudecodeui.md`](../docs/how_to_patch_claudecodeui.md)。本文件只讲「在哪里放、怎么加」。

## 目录结构

```
patches/
├── README.md                          ← 本文件
├── patch-cloudcli-<feature>.mjs       ← 你新增的 Layer B 运行时补丁(按字母序执行)
├── _templates/
│   └── patch-cloudcli-feature.mjs     ← 复制此模板来新建补丁
└── source/                            ← Layer A 源码补丁(opt-in,默认不启用)
    └── README.md
```

构建镜像时,`scripts/apply-cloudcli-patches.sh` 会以 **字母序** 依次执行所有 `patch-cloudcli-*.mjs`,并把 CloudCLI 安装根目录作为 `argv[2]` 传进去。`_templates/` 与 `source/` 不会被自动执行。

## 关键前提:基础镜像里已经是什么状态

`coderluii/holyclaude:1.5.0` 里 CloudCLI 已被 `npm i -g` 安装在:

```
/usr/local/lib/node_modules/@cloudcli-ai/cloudcli/
├── dist-server/server/...    ← 运行时实际加载的代码(必须打这里)
└── server/...                ← 源码(可选,仅当你重新构建时才需要)
```

**而且 HolyClaude 自己的 7 个运行时补丁 + Layer A overlay 已经全部应用完毕。** 因此:

> ⚠️ 你的补丁里的 `OLD_ANCHOR` 必须匹配 **基础镜像里(HolyClaude 已打过补丁后)的文本**,不是上游 claudecodeui 的原始文本。定位锚点用:
> ```bash
> docker run --rm -it coderluii/holyclaude:1.5.0 \
>   grep -Rn "<你的代码片段>" /usr/local/lib/node_modules/@cloudcli-ai/cloudcli/dist-server
> ```

## 新增一个 Layer B 补丁的 SOP

1. **复制模板**:
   ```bash
   cp patches/_templates/patch-cloudcli-feature.mjs patches/patch-cloudcli-<feature>.mjs
   ```
2. **填空**:替换所有 `<feature>` / `<path>` / `<file>` / TODO,设置唯一的 `PATCH_MARKER`,把 `OLD_ANCHOR`/`NEW_ANCHOR` 改成真实文本。遵守模板里列出的 **C1–C10 契约**(详见 docs §4)。
3. **本地验证**(对 vendor 里的 claudecodeui checkout 跑两次,第二次必须报 "already patched"):
   ```bash
   node patches/patch-cloudcli-<feature>.mjs /opt/agentmate/vendor/claudecodeui
   git -C /opt/agentmate/vendor/claudecodeui diff
   git -C /opt/agentmate/vendor/claudecodeui checkout -- .   # 还原
   ```
4. **构建镜像**:
   ```bash
   docker compose build
   ```
   若补丁的锚点在上游版本里漂移了,`node` 会 `exit(1)` → `set -e` → **build 失败**(这就是 fail-closed)。日志里应看到 `[agentmate-patch] <feature> patched (runtime)`。

## 执行顺序

按文件名字典序。需要保证补丁 A 先于补丁 B 时,用数字前缀命名,例如:

```
patches/patch-cloudcli-10-branding.mjs
patches/patch-cloudcli-20-disable-telemetry.mjs
```

## Layer A(源码补丁)什么时候用?

仅当改动 **必须进入前端 bundle**(`dist/assets/*.js`)、**需要过 TypeScript 类型检查**、或 **要改依赖锁** 时,才走 Layer A。在「基于已发布镜像」的场景下,Layer A 意味着要从上游 claudecodeui 重新构建 CloudCLI tgz 并覆盖安装 —— 成本高,默认 **不启用**。详见 [`source/README.md`](source/README.md) 与 docs §7.1 决策树。

## 与 HolyClaude 自带补丁的边界

- **不要** 在这里重做 HolyClaude 已经做的事(Chromium 路径、base-path、禁用自更新、Apprise、Codex 权限/完成码、Web Terminal 渲染)——基础镜像里已经有了。
- 这里只放 **AgentMate 独有** 的定制。
- 升级基础镜像(改 `Dockerfile` 里的 `FROM coderluii/holyclaude:x.y.z`)后,每个补丁的锚点断言会自动暴露漂移;逐个适配即可。
