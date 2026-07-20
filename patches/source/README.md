# Layer A —— 源码补丁(opt-in,默认不启用)

本目录用于 **构建时源码补丁**(对应 HolyClaude 的 `vendor/patches/cloudcli-account-management/`):通过 `git apply *.patch` 改上游 claudecodeui 源码,再 `npm build` 成新的 CloudCLI tgz 覆盖安装。

## 什么时候需要 Layer A?

当且仅当改动属于以下任一情况:

- 要进入 **前端 bundle**(`dist/assets/*.js`,即改 React/TSX 组件);
- 需要让 **TypeScript 类型检查** 通过(改 `.ts` 服务端源码并希望类型安全);
- 要改 **依赖锁**(`package-lock.json` / `npm-shrinkwrap.json`)。

否则一律走 Layer B(`patches/patch-cloudcli-*.mjs`,打已安装的 `dist-server/*.js`)。决策树见 [`../docs/how_to_patch_claudecodeui.md`](../../docs/how_to_patch_claudecodeui.md) §7.1。

## 为什么默认不启用?

AgentMate 的 `Dockerfile` 基于 **已发布的** `coderluii/holyclaude:1.5.0`,该镜像里 CloudCLI 已经构建好并安装。要做 Layer A,等于在镜像里:

1. `git clone` 上游 `siteboon/claudecodeui` 到 HolyClaude 固定的 commit;
2. 先应用 **HolyClaude 自己的 overlay 补丁**(否则会丢失 HolyClaude 已有的功能,如本地账号管理);
3. 再应用 **本目录里的 AgentMate 补丁**;
4. `npm ci → typecheck → build → lint → npm pack`;
5. `npm uninstall -g @cloudcli-ai/cloudcli && npm i -g ./agentmate.tgz`;
6. 重新应用 **HolyClaude 的 7 个运行时 `.mjs` 补丁**(因为 dist 刚被重装,它们没了)+ **AgentMate 的运行时补丁**。

这条链路长、慢、且每次升级 HolyClaude 都要同步 HolyClaude 自身的补丁集。**只有在确有必要时才启用。**

## 如果确实需要

参考 HolyClaude 的实现:

- 构建脚本范式:`vendor/HolyClaude/scripts/build-cloudcli-account-management-artifact.mjs`
- patch 文件范式:`vendor/HolyClaude/vendor/patches/cloudcli-account-management/0001-*.patch`(`git apply -C0` 兼容空白)
- 可复现双校验:两次 `npm pack` + 两次 `npm i -g` 的 sha256 必须一致
- 产物清单:tgz + `<feature>.manifest.json`(含 upstream commit / 各 patch sha256 / removal 条款)成对入库

约定:本目录下的 patch 文件命名 `00NN-<slug>.patch`(字典序即应用顺序),并配一个 `README.md` 说明 upstream commit、关联 issue、**移除条件**。

启用时,需要在 `Dockerfile` 里新增一个独立的「重建 CloudCLI」构建阶段(此处默认不提供,按需编写),并确保它跑在 `scripts/apply-cloudcli-patches.sh` **之前**。
