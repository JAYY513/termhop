# 贡献指南

## 开发环境

需要 Node.js 20+ 和 npm。Windows 上如果 `npm install` 之后 Electron 或 esbuild
的二进制缺失，看下面「安装脚本被拦」。

```bash
npm install
npm run dev        # 开发模式（渲染层热更新）
```

首次运行前建议生成图标（仓库里已经有一份， 只有改了 `scripts/gen-icon.mjs` 才需要重跑）：

```bash
npm run icons
```

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式 |
| `npm run typecheck` | 主进程和渲染层两套 tsconfig 分别检查 |
| `npm run build` | 产出到 `out/` |
| `npm run dist` | 打包出 `release/` 下的 exe 和 zip |
| `npm run verify` | 跑六套验证（见下） |
| `npm run icons` | 重新生成应用与托盘图标 |
| `npm run docs:shot` | 重新生成 README 里的面板截图 |

`verify:cli` 需要先 `npm run dist`，因为它要驱动真实打包出来的 exe。

### 安装脚本被拦

npm 11.19 起有 install-scripts 白名单，`esbuild` 和 `electron` 的 postinstall
默认不执行，装完看起来成功但运行时才炸。看到
`install scripts not yet covered by allowScripts` 就先处理：

```bash
npm install-scripts approve esbuild
npm install-scripts approve electron
npm rebuild esbuild electron
```

还不行就直接跑脚本：`node node_modules/electron/install.js`。

## 项目结构

```
src/
  shared/types.ts     主进程、preload、渲染层共用的类型契约
  main/
    index.ts          入口：单实例、托盘、IPC、CLI 分流
    config.ts         配置的读取/归一化/写入 + 所有增删改的纯函数
    shells.ts         ShellSpec 注册表 + Windows 启动逻辑
    cli.ts            argv 解析、CLI 命令、termhop.cmd shim 生成
    window.ts         启动器窗口、设置窗口、多屏定位
    hotkey.ts         全局快捷键注册
    assets/icons.ts   由 scripts/gen-icon.mjs 生成，勿手改
  preload/index.ts    contextBridge 暴露的 API
  renderer/src/
    App.tsx           根据 hash 决定渲染启动器还是设置页
    fuzzy.ts          模糊匹配与高亮
    components/       Launcher / Settings / EntryRow
scripts/
  gen-icon.mjs        纯 zlib 手写 PNG，不依赖任何图形库
  verify-all.mjs      聚合执行器，负责套件之间的前提清理
  verify-spawn.mjs    验证 shell 启动
  verify-window.mjs   验证窗口行为
  verify-shortcuts.cjs 验证启动面板的快捷键（跑在 Electron 里）
  verify-cli.mjs      验证命令行
  verify-quickadd.mjs 验证保存目录这条路的边界
  verify-autostart.mjs 验证开机自启
  harnesses/          verify-shortcuts 用的挂载台和假 IPC
  screenshot-docs.cjs 生成 README 用的面板截图，用隔离 profile 和假数据
  testkit.mjs         套件共用的进程与注册表前提
  stubs/              给单元测试用的假 electron 模块
```

## 六套验证为什么存在

这些脚本各自负责**代码里最容易出错、又最难靠肉眼检查**的部分。改了相关代码请一并跑。

```bash
npm run verify
```

### verify-spawn.mjs

shell 启动的引号问题在开发时几乎看不出来——路径错了窗口照样会弹，用户才会发现。
所以它不只断言 argv 构造，还会**真的把 PowerShell 拉起来**，在
**带空格和方括号**的目录里执行命令，再从 shell 内部读回 `Get-Location` 和落盘的
标记文件。只断言"进程起来了"是不够的。

### verify-window.mjs

窗口的层级和生命周期问题靠肉眼点不出来，所以用假的 electron 模块直接断言逻辑：

- **打开设置会先隐藏启动器**——启动器是 `alwaysOnTop: 'floating'`，层级比普通窗口高，
  不藏起来就会盖在设置窗口上，而且关掉设置后它还杵在那
- **关闭设置是 hide 不是 destroy**——destroy 会把你正在填的东西和滚动位置一起扔掉，
  而且每次开设置都要重建一个 980×700 的窗口
- **拖动会切换到固定位置**，而**代码自己移动窗口不会被误判成拖动**（靠比对坐标，
  不是靠时间窗口）
- **固定位置会被夹回工作区**，拔掉显示器也不会飞出屏幕
- **设置有焦点时启动器不因失焦消失**
- **窗口必须是 `resizable: true`**——Electron 在 Windows 上遇到 `resizable: false`
  会**静默忽略** `setSize()`，高度自适应会整个失效，而失败没有任何报错
- **宽度用 `setMinimumSize` / `setMaximumSize` 钉死**，不让 `resizable: true`
  顺带引入意外拉伸
- **cursor 和 center 两种模式都不带点**，只有 fixed 保留拖动出来的坐标

### verify-shortcuts.cjs

快捷键这一层住在渲染层，之前**一个自动化测试都没有**——`verify-window` 只测主进程。
但这一层的 bug 全是"footer 宣传的和实际做的对不上"这类：`Ctrl+N` 的「添加」分支
从第一个 commit 起就被前面的导航分支盖住了，成了死代码，footer 写着「Ctrl+N 添加」
而实际按下去是选中行往上挪一格。

所以这个套件是**唯一跑在 Electron 里的**（其余是 `node scripts/*.mjs`）：它用真实的
键盘事件驱动**真实的 Launcher 组件**——`scripts/harnesses/` 里的挂载台把组件原样挂上，
只把 IPC 换成记录器，所以跑它不会真的拉起终端。

它断言的是：

- footer 宣传的四个键各自真的做了那件事：`Enter` 打开、`Shift+Enter` 进选择器、
  `Alt+Enter` 在资源管理器里打开、`Ctrl+N` 添加
- `Ctrl+N` 在输入框为空时打开设置表单、输入了路径时直接存下来，且**不移动选中行**
- footer 的文案和 README 的快捷键表不打架（同一个键不能在表里出现两次）

改了 `src/renderer/src/components/Launcher.tsx` 里的按键分发，这个套件不能跳过。

### verify-cli.mjs

CLI 走了单实例中继、headless 执行、`.cmd` 生成三条路：

- **argv 解析**：命令必须是第一个参数，否则一个叫 `add` 的文件夹会伪装成命令；
  无法识别的参数必须启动 GUI 而不是报错退出
- **条目匹配**：前缀有歧义时拒绝匹配，不猜
- **生成的 shim 必须是纯 ASCII**：cmd.exe 用 OEM 代码页解析它，一个非 ASCII 字节
  就可能变成一个不存在的命令名
- **真跑打包好的 exe**：成功 / 重复添加 / 目录不存在 / 未知动词的返回码
- **中继**：App 正在运行时，CLI 不启动第二个进程，配置由运行中的实例写入

> 注意：这个脚本会操作 `%APPDATA%\TermHop\config.json`。它跑之前会快照、跑完还原，
> 如果你改了这个脚本，记得保留这个行为。

### verify-quickadd.mjs

面板里那条「存为常用目录」背后有两件肉眼完全看不出来的事：

- **不存在的目录不能被存进去**。存进去就是一条永远打不开的死条目，之后每次按回车
  都报"目录不存在"，用户只能去设置里翻回收站才知道当初打错了什么
- **新条目的默认 shell 必须和面板打开同一路径时用的是同一个**。这两处以前各写一份
  （一处按 `pwsh → powershell → wt → cmd` 找，一处写死 `powershell`），症状是用户用
  `pwsh` 打开了一个目录、存下来、再打开变成了 Windows PowerShell，且没有任何提示

这两个断言都需要真的文件系统，所以脚本在临时目录里造出真目录、文件和不存在路径各一个。

### verify-autostart.mjs

开机自启是一条**对系统的真实声明**：注册表
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 里要真的出现一个指向 exe 的值，
关掉时又要真的消失。这个读代码是读不出来的，所以脚本去查注册表：

- 全新状态下不注册任何东西
- 打开开关后 Run 里出现指向当前 exe、带 `--autostart` 参数的条目
- 关掉开关后条目消失
- 以自启方式启动时不弹任何窗口

> ⚠️ 这个脚本会读写注册表的 Run 键。它只碰 `TermHop` 这一个值，绝不碰用户其他
> 开机启动项，而且跑之前快照、跑完原样还原。如果你改这个脚本，保留这个行为。
> 改这块代码时更要小心：写错一个值就可能把用户的开机启动弄坏。

## 加一个新 shell

在 `src/main/shells.ts` 里加一个 `ShellSpec` 就行：

```ts
{
  id: 'myShell',
  label: 'My Shell',
  badge: 'myshell',
  resolve: () => findMyShell(),        // 返回绝对路径，找不到就返回 null
  build: (exe, cwd, initCmd) => [...],  // 构造 argv
  isGui: false,                        // 是否是 GUI 程序
  supportsInitCmd: true                // 启动命令能否可靠传进去
}
```

然后在 `src/shared/types.ts` 的 `ShellId` 和 `src/renderer/src/api.ts` 的
`SHELL_META` 里加上对应项。

`build` 收到的路径可能是带空格、带 `[` `]`、带单引号的目录，这是刻意的——
那正是真实用户会遇到的情况。

## 提交前

```bash
npm run typecheck && npm run verify
```

改动如果涉及启动方式或 CLI，把 `verify` 的输出贴进 PR，说明它覆盖了什么。
