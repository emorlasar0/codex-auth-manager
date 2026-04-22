## 项目上下文摘要（切换重启反馈与 Codex App 唤醒修复）
生成时间：2026-04-22 14:25:00

### 1. 相似实现分析
- **实现1**: C:\Users\JCS\Desktop\codex-auth-manager\src\components\Header.tsx:86-220
  - 模式：顶部操作区使用悬浮下拉菜单，依靠 `onMouseEnter/onMouseLeave + 本地 useState` 控制浮层显示。
  - 可复用：现有“小工具”入口与“快速登录”下拉菜单样式、按钮层级、阴影和圆角。
  - 需注意：当前“小工具”是纯图标按钮，不符合“直接显示小工具文字”的最新需求。

- **实现2**: C:\Users\JCS\Desktop\codex-auth-manager\src\components\QuickLoginModal.tsx:1-134
  - 模式：阻塞式进度弹窗，依赖 phase 切换文案、徽标色和 loading spinner。
  - 可复用：切换账号重启期间的“请等待”反馈样式、不可关闭状态、成功/失败提示风格。
  - 需注意：当前该组件绑定了快速登录语义，不宜直接硬复用，应抽取同类交互或扩展现有重启确认弹窗。

- **实现3**: C:\Users\JCS\Desktop\codex-auth-manager\src\components\SettingsModal.tsx:130-177
  - 模式：开关型设置项使用 `relative h-8 w-14 rounded-full` 的滑块 UI。
  - 可复用：自动重启 Codex 开关可直接沿用此滑块 UI，但需要从设置弹窗迁移到“小工具”浮层。
  - 需注意：设置弹窗保存型配置与顶部即时开关交互不同，迁移后应改为即时写入 store。

- **实现4**: C:\Users\JCS\Desktop\codex-auth-manager\src-tauri\src\lib.rs:759-929
  - 模式：Rust Tauri command 通过 PowerShell 脚本查询/结束/重启 Windows 进程，并以 JSON 回传结果。
  - 可复用：现有 `restart_codex_processes_windows` 的进程枚举、结果结构体和命令注册。
  - 需注意：桌面版 Codex 目前使用 `Start-Process -FilePath $appExecutablePath`，用户实测会把桌面窗口挂到 PowerShell 控制台生命周期上。

### 2. 项目约定
- **命名约定**: React 组件 props 与状态使用 camelCase；Rust 结构体字段使用 snake_case，并通过 `serde(rename_all = "camelCase")` 对齐前端。
- **文件组织**: 顶部导航在 `src/components/Header.tsx`；流程型弹窗在 `src/components/*.tsx`；系统级命令集中在 `src-tauri/src/lib.rs`。
- **导入顺序**: 先第三方，再本地组件/工具；同层模块使用相对路径。
- **代码风格**: 函数式组件 + hooks；长流程在 `App.tsx` 协调，具体系统操作在 Rust 命令层执行。

### 3. 可复用组件清单
- `C:\Users\JCS\Desktop\codex-auth-manager\src\components\Header.tsx`: 顶部悬浮菜单与按钮布局。
- `C:\Users\JCS\Desktop\codex-auth-manager\src\components\QuickLoginModal.tsx`: 进度型阻塞弹窗视觉模式。
- `C:\Users\JCS\Desktop\codex-auth-manager\src\components\SwitchRestartDialog.tsx`: 首次确认 + 记住选择逻辑。
- `C:\Users\JCS\Desktop\codex-auth-manager\src\stores\useAccountStore.ts`: `updateConfig` 即时写入配置。
- `C:\Users\JCS\Desktop\codex-auth-manager\src-tauri\src\lib.rs`: Windows 进程控制命令骨架。

### 4. 测试策略
- **测试框架**: 前端以 `eslint + tsc/vite build` 为现有可执行验证；Rust 有 `cargo fmt` 与 lib 单测，但当前机器缺少 `link.exe` 无法完成链接。
- **测试模式**: 本次以本地静态校验 + PowerShell 实机命令验证为主。
- **参考文件**: Rust 测试集中在 `src-tauri/src/lib.rs` 尾部；前端暂无同类自动化测试文件。
- **覆盖要求**: 需要覆盖 UI 展示、配置持久化、重启命令结果解析，以及 Codex App 启动方式不再依赖 PowerShell 控制台生命周期。

### 5. 依赖和集成点
- **外部依赖**: `@tauri-apps/api`（前端调用 Rust command）、Windows PowerShell / explorer shell:AppsFolder（桌面应用唤醒）。
- **内部依赖**: `App.tsx` → `Header/SwitchRestartDialog/SettingsModal`；`useAccountStore.updateConfig` 持久化设置；`lib.rs` 执行实际重启。
- **集成方式**: 前端 invoke `restart_codex_processes`，Rust 命令返回 `{ appRestarted, cliRestarted }`。
- **配置来源**: `accounts.json` 中的 `config.autoRestartCodexOnSwitch / skipSwitchRestartConfirm / codexPath`。

### 6. 技术选型理由
- **为什么用这个方案**: UI 上继续沿用现有悬浮菜单与阻塞弹窗模式，可以最小化视觉割裂；后端继续使用 PowerShell 查询进程，但桌面 App 唤醒改为 `explorer.exe shell:AppsFolder\<PackageFamily>!<AppId>`，避免控制台依附问题。
- **优势**: 与现有组件风格一致；不需要引入新的依赖；能直接修复用户实测的“关掉 PowerShell 导致 Codex App 一起退出”问题。
- **劣势和风险**: `shell:AppsFolder` 唤醒比直接 exe 启动慢，需要前端进度弹窗兜底；不同安装形态可能需要回退到 direct exe。

### 7. 关键风险点
- **并发问题**: 切换账号时如果进度弹窗未覆盖整个流程，用户仍可能二次点击导致误判。
- **边界条件**: 当用户启用了“下次不再提示”时，也必须显示进度弹窗；不能只在首次确认时显示。
- **性能瓶颈**: `Get-AppxPackage / Get-AppxPackageManifest` 查询会增加几百毫秒到数秒延迟。
- **验证缺口**: 当前机器无法完成 Rust 链接验证，需要用 `cargo fmt`、前端 build/lint 和 PowerShell 实机命令补偿。

### 8. 外部检索工具说明
- context7 / github.search_code / desktop-commander：当前会话不可用，已改为本地代码检索与系统命令分析，并在操作日志留痕。
