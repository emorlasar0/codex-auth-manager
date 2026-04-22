## 项目上下文摘要（代码审查-状态抖动与账号切换）
生成时间：2026-04-22 09:17:55

### 1. 相似实现分析
- **实现1**: /src/stores/useAccountStore.ts:52-72
  - 模式：先从磁盘加载 store，再异步同步当前账号与工作区元数据，最后整批覆盖前端状态。
  - 可复用/约束：loadAccountsStore、syncCurrentAccount、efreshAccountsWorkspaceMetadata 共同决定账户列表最终状态。
  - 需注意：该实现没有请求版本号或取消机制，晚返回的旧请求可以覆盖较新的本地状态。

- **实现2**: /src/hooks/useAutoRefresh.ts:118-162、167-249
  - 模式：刷新前若目标账号是当前激活账号，会先执行 syncCurrentAccount；刷新结果统一写回 usageInfo。
  - 可复用/约束：efreshSingleAccount 和 efreshAllUsage 共用全局 isRefreshingRef 锁。
  - 需注意：utoRefreshAccountIdRef 在刷新前就写入，若刷新被跳过，后续不会自动补刷。

- **实现3**: /src-tauri/src/lib.rs:502-552、1906-2096
  - 模式：Rust 后端后台轮询 wham/usage，结果写入 ccounts.json 并通知前端重新加载。
  - 可复用/约束：后台刷新直接调用 save_accounts_store_data 持久化；get_codex_wham_usage 直接使用存档里的 ccess_token 请求接口。
  - 需注意：401 直接映射为 expired，没有任何 token 刷新或切回当前账号重试逻辑。

- **实现4**: /src/utils/storage.ts:605-711
  - 模式：读取当前 .codex/auth.json，通过 ccountId/userId/email 匹配本地账号，并在需要时把当前 auth 回写到匹配账号的私有 auth 文件。
  - 可复用/约束：匹配质量依赖 ccountInfo.accountId、userId、email 完整存在。
  - 需注意：一旦 store 被弱化成只剩 email，匹配会退化并可能写错账号 auth。

### 2. 项目约定
- **状态管理**: Zustand 单 store，前端以 ccounts 为唯一 UI 数据源。
- **后端交互**: 通过 Tauri invoke 调 Rust 命令；Rust 负责磁盘存储、托盘和后台刷新。
- **持久化模式**: 前端与 Rust 都会读写同一个 ccounts.json，存在双写场景。
- **命名风格**: TypeScript 使用 camelCase；Rust 使用 snake_case + serde rename 映射到 camelCase。

### 3. 可复用组件清单
- /src/utils/storage.ts
  - loadAccountsStore：前端读取/规范化 store
  - ddAccount：导入 auth 并落盘
  - syncCurrentAccount：根据当前 .codex/auth.json 回写激活状态
- /src/hooks/useAutoRefresh.ts
  - efreshSingleAccount：刷新单账号额度
  - efreshAllUsage：串行刷新全部账号额度
- /src-tauri/src/lib.rs
  - get_codex_wham_usage：通过 wham/usage 获取额度
  - efresh_accounts_usage_in_background：后台刷新并发事件通知

### 4. 测试策略
- **前端测试**: 仓库内未找到业务测试文件。
- **后端测试**: src-tauri/src/lib.rs 含若干 Rust 单元测试，主要覆盖路径解析、tray 文案和 rate limit 解析。
- **验证方式**:
  - 
pm run build：通过
  - 
pm run lint：失败，发现 React hook/setState 与声明顺序问题
  - cargo test --lib：当前环境缺少 link.exe，无法完成

### 5. 依赖和集成点
- **外部依赖**: React 19、Zustand 5、Tauri 2、Reqwest。
- **关键集成点**:
  - .codex/auth.json
  - %LOCALAPPDATA%/codex-manager/accounts.json
  - %USERPROFILE%/.codex_manager/auths/*.json
  - https://chatgpt.com/backend-api/wham/usage
- **后台机制**: Rust 每 30 秒检查一次是否需要后台自动刷新；前端窗口聚焦、托盘切换、后台刷新事件都会触发 loadAccounts()。

### 6. 技术选型理由
- **为什么这样设计**: 用 Tauri 处理本地文件、托盘与后台任务；前端只负责展示与交互。
- **优势**: 本地文件可控、跨平台、前端实现较轻。
- **劣势和风险**: 前后端共同写同一份 store，且 Rust 使用了“托盘简化版”结构体，容易产生字段丢失和竞态覆盖。

### 7. 关键风险点
- **状态竞态**: 多个 loadAccounts/updateUsage/后台刷新并发写同一 store。
- **身份退化**: store 字段被裁剪后，只能靠 email 匹配同邮箱多账号，存在错配风险。
- **Token 生命周期**: 非激活账号的 ccess_token 会自然过期，但当前实现没有刷新链路。
- **测试缺口**: 没有覆盖“同邮箱多账号”“后台刷新与手动添加并发”“切换账号后立即刷新”这些关键场景。
