# Electron 速查

## 职责与目录

负责应用窗口、托盘、系统快捷键、设置持久化及本地 API 生命周期。Vue 渲染进程通过 preload 白名单调用系统能力。

- `services/`：具有独立生命周期的主进程服务。

## 重要文件

- `main.js`：应用入口，编排启动、窗口、托盘、IPC 和退出清理。
- `preload.js`：通过 `contextBridge` 暴露 `electronAPI`、`settingsAPI`、`loadingAPI`、`desktopLyricAPI`；事件订阅隐藏 Electron event 并返回解绑函数。
- `settingsStore.js`：设置默认值、Schema 补全、导入导出、自启协调与串行原子持久化。
- `autoLaunch.js`：封装 Windows/macOS 登录启动设置；不支持的平台返回明确的状态或错误。
- `logger.js`：主进程日志级别与输出入口，默认 `info`，通过 `BK_LOG_LEVEL` 或 `DEBUG` 开启诊断。
- `loading.html`：启动进度窗口，通过 `loadingAPI` 接收进度和状态。
- `desktopLyric.html`：独立歌词窗口，通过 `desktopLyricAPI` 接收歌曲、歌词、播放时间及显示设置。

## 核心流程

1. `app.whenReady()` 创建加载窗口和托盘，初始化设置，再启动本地 API 与主窗口。
2. 渲染进程经 preload 请求设置或系统能力，主进程执行后通过 IPC 返回结果或广播更新。
3. 播放器上报歌曲、播放状态、歌词及毫秒时间，主进程更新托盘并转发给桌面歌词。
4. `performApplicationCleanup()` 复用一个清理 Promise；释放窗口定时器、设置订阅、快捷键、附属窗口、后端和托盘后，才允许正式退出。

## 设置保障

- `setSettings()` 将整个事务串行执行；合并基于最后成功的缓存，原子落盘成功后才更新缓存和通知订阅者。
- 写入失败保留旧缓存，清理临时文件，后续事务仍可继续；已调整的系统自启状态尝试恢复。
- `ensureSchema()` 补全默认字段，拒绝任意层级的 `__proto__`、`constructor`、`prototype`。
- 损坏 JSON 在回退默认值前备份；设置位于 Electron `userData` 下，不写入项目目录。
- `custom.themePackages` 与其他设置共用持久化；theme IPC 从 `src/themes/themeCatalog.mjs` 共用校验，过滤损坏包，选择主题仅写主题字段。旧 auto 名称兼容为 system，打包包含共享目录与 JSON 清单。

## 窗口与兼容保障

- 所有窗口禁用 Node 集成并启用上下文隔离；HTML 不直接使用 `require('electron')`。
- 订阅和定时任务成对释放；桌面歌词卸载时取消订阅及待执行的动画帧。
- 普通关闭遵循 `minimizeToTray`，主动退出和清理中的关闭不再隐藏到托盘。
- 开发及构建后的主入口共用同一职责；Vite 处理主进程本地模块，并将两份窗口 HTML 复制到构建入口旁。
- 凭证和个人数据不进入日志，高频诊断使用 Trace；保持现有 IPC 频道和设置字段兼容。

## 验证

在项目根目录执行已验证的 `npm run check`、`npm test`、`npm run build`。涉及窗口、设置或生命周期时，还需实际运行 Electron，验证桌面歌词、保存设置、主动退出及本地端口释放；自动化 Mock 不能代替这些运行检查。
