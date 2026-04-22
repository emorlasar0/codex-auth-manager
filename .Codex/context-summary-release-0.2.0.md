## 项目上下文摘要（0.2.0 发版）
生成时间：2026-04-22 15:02:31

### 1. 相似实现分析
- **实现1**: GitHub Release `v0.1.9`
  - 模式：标题使用 `Codex Manager v<版本>`，正文采用“更新内容：”+ 短横线列表
  - 可复用：保持 Release 正文结构一致，继续强调“安装包由 GitHub Actions 自动构建并附加到当前 Release”
  - 需注意：本次功能跨度更大，正文宜用“更新内容”而非“修复内容”

- **实现2**: GitHub Release `v0.1.8`
  - 模式：正文保持精炼，聚焦 2-4 条用户可感知变化
  - 可复用：延续简洁风格，避免写内部实现细节
  - 需注意：本次要覆盖“小工具入口”“进度反馈”“Codex App 唤醒修复”三类变化

- **实现3**: `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`
  - 模式：前端版本、Rust 包版本、Tauri bundle 版本保持一致
  - 可复用：统一升级为 `0.2.0`，避免打包产物与 Release 标签不一致
  - 需注意：`src/App.tsx` 与 `src/components/SettingsModal.tsx` 仍有硬编码版本展示，需要同步更新

### 2. 项目约定
- **命名约定**: npm/Tauri 版本号统一使用语义化版本 `x.y.z`，Release tag 使用 `v` 前缀
- **文件组织**: 版本配置分散在前端根目录与 `src-tauri/`；界面文案版本在 React 组件内
- **代码风格**: 配置文件保持现有 JSON/TOML 排版；Release 文案延续之前的简短条目式风格

### 3. 可复用组件清单
- `package.json`: 前端包版本来源
- `package-lock.json`: npm 锁文件根版本来源
- `src-tauri/Cargo.toml`: Rust 包版本来源
- `src-tauri/Cargo.lock`: Rust 根包锁版本来源
- `src-tauri/tauri.conf.json`: 安装包版本来源
- `src/App.tsx`: 底部状态栏版本展示
- `src/components/SettingsModal.tsx`: 设置弹窗版本展示
- `.github/workflows/windows-build.yml`: Windows 安装包构建入口

### 4. 测试策略
- **测试框架**: 前端采用 `npm run lint` 与 `npm run build`；Rust 采用 `cargo fmt --all` 与 `cargo check --lib`
- **验证模式**: 本地静态检查 + GitHub Actions 远端 Windows 打包验证
- **参考流程**: 先推送 `main` 触发 `Build Windows Installer`，再下载 artifact 附加到 Release
- **已知限制**: 当前机器缺少 MSVC `link.exe`，`cargo check --lib` 预计继续失败

### 5. 依赖和集成点
- **外部依赖**: GitHub CLI `gh`、git 凭据管理、GitHub Actions
- **内部依赖**: 版本号需同时影响前端显示、Tauri bundle 元数据与 Release tag
- **集成方式**: `git push` 触发 workflow，`gh run download` 下载 artifact，`gh release create` 创建正式版

### 6. 技术选型理由
- **为什么沿用现有 Release 风格**: 与历史版本保持一致，用户更容易理解变化内容
- **优势**: 可复用既有构建链路，不新增发布脚本
- **风险**: 若版本号分布不一致，会出现 UI、安装包与 Git tag 不匹配

### 7. 关键风险点
- **边界条件**: `package-lock.json` 与 `Cargo.lock` 若漏改，可能导致产物版本不一致
- **流程风险**: Release 若先于 Windows 构建完成，会缺少安装包附件
- **验证风险**: 本地 Rust 校验受缺少 `link.exe` 影响，需要明确记录