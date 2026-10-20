# AGENTS.md

给在这个仓库里动手的 AI agent 看的。人类贡献者看 [CONTRIBUTING.md](CONTRIBUTING.md)，
设计取舍看 [docs/DECISIONS.md](docs/DECISIONS.md)。这里只记"容易踩、且从别处看不出来"的部分。

## 打包：只有一个输出目录

产物目录由 `electron-builder.yml` 的 `directories.output: release` 唯一决定。

**永远不要用 `--config.directories.output=<别的目录>` 绕开打包失败。**
一次失败换一个新目录，会在磁盘上留几百 MB 没人认领的陈旧产物。
`release/`、`out/` 都在 `.gitignore` 里，但它们不会自己消失。

**`npm run dist` 在同一个 MiniMax Code 会话里，同一个输出目录只能成功一次。**
第二次必定 `EBUSY`，因为这个运行环境会钉住构建出的 `.asar` 文件句柄且不释放
（已用 Restart Manager 查证：持有者是 MiniMax Code 进程本身，不是杀软、不是 electron-builder）。

所以遇到 EBUSY 时的正确动作是：

1. **停下来告诉用户**，说明需要退出 MiniMax Code 后重打；
2. 不要自己换目录重试。

各次构建的产物目录是 `out/`（`npm run build`）和 `release/`（`npm run dist`），
两者都不是稳定可增量更新的，想确认包里带了什么要重新构建。

## 验证

`npm run verify` 跑六套。改了哪块就跑对应的：

| 套件 | 覆盖 |
| --- | --- |
| `verify:spawn` | shell 启动、base64 传参、`cmd /c start` 的引号 |
| `verify:window` | 窗口层级、生命周期、高度自适应 |
| `verify:shortcuts` | 启动面板的快捷键：footer 宣传的四个键各自真的做了那件事 |
| `verify:cli` | argv 解析、条目匹配、shim 生成 |
| `verify:quickadd` | 目录存在性校验、新条目默认 shell |
| `verify:autostart` | 注册表里的开机自启项 |

`verify:cli` 有一段要驱动**真实打包出来的 exe**，`npm run dist` 之前会跳过。
`verify:autostart` 会读写 `HKCU\...\Run` 并注册登录项，跑前请让用户知情。
`verify:shortcuts` 是唯一跑在 **Electron** 里的套件（其余是 `node scripts/*.mjs`）：
快捷键这一层住在渲染层，得有真的 DOM 和真的键盘事件才测得出来。
它用 `scripts/harnesses/` 里的挂载台驱动**真实的 Launcher 组件**，只把 IPC 换成记录器，
所以跑它不会真的拉起终端。

改 `src/main/config.ts` 或 `src/main/shells.ts` 里的共享逻辑时，
`verify:quickadd` 是唯一覆盖"默认值必须和面板一致"那条的套件，别跳过。
改了 `Launcher.tsx` 里的按键分发时，`verify:shortcuts` 是唯一覆盖那条的套件，也别跳过。

## 代码里几条不能随手破坏的不变量

- **`@shared/types.ts` 里的 `PREFERRED_SHELL_ORDER` 是唯一一份 shell 顺序。**
  主进程和渲染层共用。曾经有过第二份写死的顺序（`ALL_SHELLS`），症状是
  "用 pwsh 打开的目录存下来之后再打开变成 powershell"。别再加第三份。
- **`addEntryToConfig` 自己校验目录是否存在。** 不要把这个检查挪回调用方——
  CLI 和设置表单各写一份的时候，设置表单那份是漏的，存进去的死条目永远打不开。
- **合成行用 `key` 区分**：`__path__`（开终端）、`__save__`（存下来）、`__shell__<id>`（选 shell）。
  它们没有 `entryId`，`launchRow` 靠这一点决定分发路径。
- **所有启动都走 `launchRow`**，它同时管 in-flight 锁和 `Phase` 状态上报。
  复制一段启动逻辑出去，就复制了一份"进行中/成功/失败长得一样"的问题。
- **一个键只能有一个意思，而且先命中先赢。** keydown 处理器是一串 `if`，
  前面某个分支 `return` 了，后面的同名判断就是死代码——`Ctrl+N` 的「添加」分支
  被导航分支盖了整整一个版本，footer 写的和实际做的对不上。
  加新快捷键时先确认没有更靠前的分支认领同一个组合键。

## 改完要同步的文档

- README 的**快捷键表**和 `Settings.tsx` 里的说明文字——它们是手写的，
  改了按键不会自动同步，README 里曾经长期写着"Ctrl+N 启动器里一步到位"这种做不到的话。
- `docs/DECISIONS.md` **尤其是被否决的方案**。记录"我们考虑过并否决了什么"
  比记录"我们做了什么"更值钱，否则半年后会有人再提一遍。
