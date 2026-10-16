# Electron 速查

## 职责与目录

负责应用窗口、托盘、系统快捷键、设置持久化、本地 API 及应用更新服务生命周期。Vue 渲染进程通过 preload 白名单调用系统能力。

- `services/`：具有独立生命周期的主进程服务。

## 重要文件

- `main.js`：应用入口，编排启动、窗口、托盘、IPC 和退出清理。
- `preload.js`：通过 `contextBridge` 暴露 `electronAPI`、`settingsAPI`、`loadingAPI`、`desktopLyricAPI`；事件订阅隐藏 Electron event 并返回解绑函数，`electronAPI.updates` 提供固定的更新操作及状态订阅；`waitForBackend()` 与 `notifyReady()` 仅桥接固定的启动就绪频道。
- `settingsStore.js`：设置默认值、Schema 补全、导入导出、自启协调与串行原子持久化。
- `autoLaunch.js`：封装 Windows/macOS 登录启动设置；不支持的平台返回明确的状态或错误。
- `logger.js`：主进程日志级别与输出入口，默认 `info`，通过 `BK_LOG_LEVEL` 或 `DEBUG` 开启诊断。
- `loading.html`：启动进度窗口，通过 `loadingAPI` 接收进度和状态。
- `desktopLyric.html`：独立歌词窗口，通过 `desktopLyricAPI` 接收歌曲、歌词、播放时间及显示设置。

## 核心流程

1. `app.whenReady()` 创建加载窗口和托盘，初始化设置后并行启动本地 API 与主窗口，不等待固定定时器。渲染入口并行初始化设置与等待实际 HTTP 就绪，后端失败或 10 秒截止仍允许界面挂载；主窗口顶层页面挂载后的首帧通过 `renderer:ready` 显示窗口并关闭加载窗，仅处理一次，退出中忽略就绪。启动期间的播放指令暂存到渲染就绪后发送。
2. 渲染进程经 preload 请求设置或系统能力，主进程执行后通过 IPC 返回结果或广播更新。
3. 播放器上报歌曲、播放状态、歌词及毫秒时间，主进程更新托盘并转发给桌面歌词。
   主进程缓存最近歌词和毫秒时间；窗口 ready 时按设置、歌曲、歌词、时间顺序重放，换曲清空旧内容，相同歌曲元数据更新保留歌词。
4. 初始化设置后创建更新服务，传入 `app.getVersion()`、平台架构和 `userData/updates/`；更新服务自行延迟调度，主窗口和本地 API 启动不等待网络任务。开发 Worker 位于 `electron/services/updateWorker.cjs`，打包通过 extraResources 加载 `resources/updater/updateWorker.cjs`。
5. `performApplicationCleanup()` 复用一个清理 Promise；释放窗口定时器、设置订阅、更新 Worker、快捷键、附属窗口、后端和托盘后，才允许正式退出。
6. Windows 打包版非阻塞启动每 PID 安装退出管道。安装器明确请求后，向就绪主窗口发送带随机 requestId 的保存准备通知；仅原顶层 frame 的当前回执可被接收。保存成功并发送管道确认后正常退出，重载、崩溃、断开或超时取消请求，清理时关闭管道，不改变正常多实例启动行为。

## 设置保障

- `setSettings()` 将整个事务串行执行；合并基于最后成功的缓存，原子落盘成功后才更新缓存和通知订阅者。
- 写入失败保留旧缓存，清理临时文件，后续事务仍可继续；已调整的系统自启状态尝试恢复。
- `ensureSchema()` 补全默认字段，拒绝任意层级的 `__proto__`、`constructor`、`prototype`。
- 损坏 JSON 在回退默认值前备份；设置位于 Electron `userData` 下，不写入项目目录。
- `custom.themePackages` 与其他设置共用持久化；theme IPC 从 `src/themes/themeCatalog.mjs` 共用校验，过滤损坏包，选择主题仅写主题字段。旧 auto 名称兼容为 system，打包包含共享目录与 JSON 清单。
- `desktopLyrics` 沿同一原子事务保存大小、主题和锁定。启动默认/导入值由 Schema 规范化；订阅只广播已提交偏好，窗口内大小/主题 IPC 检查发送窗口与枚举，失败重新同步已提交快照；初始化前打开窗口先显示默认值，随后补同步。
- 主题包可选 `desktopCss` 由主进程经共享目录校验和编译，再沿原显示偏好通道发送 `appearance`（视觉令牌与窗口限定 CSS）。独立 HTML 整份替换令牌/style；普通偏好消息缺少该字段时保持外观，切回无桌面 CSS 的主题发送 null 清除。异步解析按窗口身份与设置代次拒绝旧结果，保留经典/渐变/简约模式和现有隔离设置。
- `playback.quality` 沿既有设置事务持久化，默认字符串 128，Schema 与渲染侧一致只接收 128/320/flac/high，旧配置补全、非法值回退；不持久化或伪造当前歌曲的有效音质。
- `software.updates` 仅保存 `autoCheck`、`autoDownload` 和 `channel`，默认 true、false、stable，渠道限定 stable/beta；旧配置与非法导入值按同一规则补全。成功提交的设置广播才调用更新服务 `configure()`，不保存下载进度、文件路径或安装开关。
- 桌面歌词替换数组时重置行索引与逐字缓存，首个时间更新不被节流丢弃，保证暂停中重开及新曲第一行正确显示；锁定可从设置页恢复。

## 窗口与兼容保障

- 所有窗口禁用 Node 集成并启用上下文隔离；HTML 不直接使用 `require('electron')`。
- `updates:*` IPC 仅接受主窗口 webContents 及其顶层 frame；检查、下载、取消和定位均由主进程服务负责，下载参数只接受服务提供的资产 ID，渲染侧不能注入下载 URL 或本机路径。状态只向主窗口广播展示字段。
- `electronAPI.updates.onPrepareForInstall()` 订阅准备/取消通知并返回解绑函数；`completePrepareForInstall(requestId, result)` 只反馈当前准备结果，不直接授权安装或退出。保存中屏蔽托盘播放操作，过期回执无效。
- 安装只能由 `updates:install` 的用户动作触发：Worker 先校验文件，原生对话框默认取消，明确确认后再次校验并核对文件、版本和资产身份，随后才调用 `shell.openPath()`。只允许 exe/dmg/deb/rpm，AppImage 定位后由用户处理；启动、下载完成、退出均不安装，也不自动退出应用。
- 订阅和定时任务成对释放；桌面歌词卸载时取消订阅及待执行的动画帧。
- 普通关闭遵循 `minimizeToTray`，主动退出和清理中的关闭不再隐藏到托盘。
- 开发及构建后的主入口共用同一职责；Vite 处理主进程本地模块，并将两份窗口 HTML 复制到构建入口旁。
- 凭证和个人数据不进入日志，高频诊断使用 Trace；保持现有 IPC 频道和设置字段兼容。

## 验证

在项目根目录执行已验证的 `npm run check`、`npm test`、`npm run build`。涉及窗口、设置或生命周期时，还需实际运行 Electron，验证桌面歌词、保存设置、主动退出及本地端口释放；自动化 Mock 不能代替这些运行检查。
