# Electron 速查

## 职责与目录

负责应用窗口、托盘、系统快捷键、设置持久化、本地 API、离线缓存、歌词版本及应用更新服务生命周期。Vue 渲染进程通过 preload 白名单调用系统能力。

- `services/`：具有独立生命周期的主进程服务。

## 重要文件

- `main.js`：应用入口，编排启动、窗口、托盘、IPC 和退出清理。
- `preload.js`：通过 `contextBridge` 暴露 `electronAPI`、`settingsAPI`、`loadingAPI`、`desktopLyricAPI` 与 `islandLyricAPI`；事件订阅隐藏 Electron event 并返回解绑函数，`electronAPI.updates` 提供固定的更新操作及状态订阅；`waitForBackend()` 与 `notifyReady()` 仅桥接固定的启动就绪频道。
- `settingsStore.js`：设置默认值、Schema 补全、导入导出、自启协调与串行原子持久化。
- `autoLaunch.js`：封装 Windows/macOS 登录启动设置；不支持的平台返回明确的状态或错误。
- `logger.js`：主进程日志级别与输出入口，默认 `info`，通过 `BK_LOG_LEVEL` 或 `DEBUG` 开启诊断。
- `loading.html`：启动进度窗口，通过 `loadingAPI` 接收真实进度和状态；阶段文字以可取消的 WAAPI 动效切换，进度和 spinner 独立更新。
- `desktopLyric.html`：独立透明歌词窗口，通过 `desktopLyricAPI` 接收歌曲、歌词、毫秒时间、真实播放状态、显示设置及错误；显示当前原文与翻译或下一句，提供播放、字号、样式、翻译、锁定、关闭及缩放控件，保留动画反馈与减少动态支持。
- `islandLyric.html`：贴顶黑色凹口与浮动歌词两种模式；默认左 Logo、中间单行歌词、右封面，支持双行、歌曲信息及左右内容自定义。大陆模式鼠标避让且穿透，浮动模式通过点击、右键或键盘展开播放控制并支持拖动；固定 `islandLyricAPI` 接收已确认播放快照，纯文本渲染及逐字/横移均按绝对播放时间更新。

## 核心流程

1. `app.whenReady()` 创建加载窗口和托盘，初始化设置后并行启动本地 API 与主窗口，不等待固定定时器。渲染入口并行初始化设置与等待实际 HTTP 就绪，后端失败或 10 秒截止仍允许界面挂载；主窗口顶层页面挂载后的首帧通过 `renderer:ready` 显示窗口并关闭加载窗，仅处理一次，退出中忽略就绪。启动期间的播放指令暂存到渲染就绪后发送。
2. 渲染进程经 preload 请求设置或系统能力，主进程执行后通过 IPC 返回结果或广播更新。
3. 播放器上报歌曲、播放状态、歌词及毫秒时间，主进程更新托盘、Windows 任务栏预览按钮并转发给桌面歌词。
   主进程缓存歌曲 `trackId`、歌词、毫秒时间、总时长与播放倍率；窗口 ready/重开时按设置、歌曲、歌词、时间、播放状态顺序重放。时间桥接只转发规范化的 `advancing/playbackRate/discontinuity`，旧快照重放明确禁止推进，收到新音频采样才恢复插值。确认换曲清空旧内容，空歌曲清空快照，同一身份元数据更新保留歌词；带过期身份的歌词与时间上报被拒绝。
   `updateTaskbarButtons()` 用 `setThumbarButtons()` 设置上一首、播放/暂停、下一首，复用 `broadcastPlayerControl()`，不还原或聚焦窗口。图标从开发 `public/taskbar/` 或生产 `dist/taskbar/` 读取并缓存；原生更新失败仅记录警告，下次显示或状态变化重试。
4. 初始化设置后创建更新服务，传入 `app.getVersion()`、平台架构和 `userData/updates/`；更新服务自行延迟调度，主窗口和本地 API 启动不等待网络任务。开发 Worker 位于 `electron/services/updateWorker.cjs`，打包通过 extraResources 加载 `resources/updater/updateWorker.cjs`。
5. `performApplicationCleanup()` 复用一个清理 Promise；释放窗口定时器、设置订阅、更新 Worker、快捷键、附属窗口、后端和托盘后，才允许正式退出。
6. Windows 打包版非阻塞启动每 PID 安装退出管道。安装器明确请求后，向就绪主窗口发送带随机 requestId 的保存准备通知；仅原顶层 frame 的当前回执可被接收。保存成功并发送管道确认后正常退出，重载、崩溃、断开或超时取消请求，清理时关闭管道，不改变正常多实例启动行为。
7. 初始化独立离线缓存服务，读取已提交的 `download.offlineCachePath`，空值使用 `userData/offline-playlists/`；开发 Worker 位于 services，打包 Worker 从 `resources/playlist-cache/playlistCacheWorker.cjs` 加载。设置成功广播后 configure；退出先等待进行中的目录迁移，再停止 Worker，后台缓存故障不阻断窗口与在线播放。

8. 歌词库服务固定使用 `userData/lyric-library/`，独立管理曲目的在线原文、编辑副本及选中版本；已提交设置控制读取、自动保存阈值及后台更新。关闭管理保留文件，修改通知带歌曲 hash、revision 和 online/edit/select 原因；退出失效未发布写入并等待队列清理。

## 设置保障

- `setSettings()` 将整个事务串行执行；合并基于最后成功的缓存，原子落盘成功后才更新缓存和通知订阅者。
- 写入失败保留旧缓存，清理临时文件，后续事务仍可继续；已调整的系统自启状态尝试恢复。
- `ensureSchema()` 补全默认字段，拒绝任意层级的 `__proto__`、`constructor`、`prototype`。
- `playback.restartOnPreviousNearEnd` 默认 false，与渲染侧一致只接受布尔 true 开启末尾上一首重播；旧配置及非法导入值回退 false，沿已有串行设置事务持久化。
- 损坏 JSON 在回退默认值前备份；设置位于 Electron `userData` 下，不写入项目目录。
- `custom.themePackages` 与其他设置共用持久化；theme IPC 从 `src/themes/themeCatalog.mjs` 共用校验，过滤损坏包，选择主题仅写主题字段。旧 auto 名称兼容为 system，打包包含共享目录与 JSON 清单。
- `desktopLyrics` 沿同一原子事务保存字号、主题、锁定、`bounds` 及桌面显示/行为/样式偏好；双端 Schema 规范化全部字段，主进程复用 `normalizeDesktopLyrics()` 白名单剥离 bounds 后发送显示快照。全局 `playback.showTranslation` 保留，桌面 `hideTranslation` 仅额外抑制桌面翻译与音译。窗口设置 IPC 校验顶层发送方和枚举/布尔值，返回保存结果，仅成功偏好生效，失败重放已提交快照并显示可重试反馈。
- `islandLyrics` 双端规范化启用、模式、显示器与位置、Logo/双行/岛内隐藏翻译与音译/歌曲信息、字体/粗体/逐字高亮、三种颜色、透明度、缩放及隐藏策略；默认禁用、mainland、跟随主屏、单行、左 Logo/右封面。字号限定 14–40，缩放 .5–2，整体不透明度 .2–1，背景不透明度 0–1，位置仅保留有限整数，字体及颜色严格过滤。
- 设置页、托盘与窗口关闭沿同一设置事务，保存失败保留原窗口及可见重试反馈。普通会话广播不重开失败窗口；显式找回先排空设置草稿，复用或重新创建窗口并预览 3 秒，单次启用共用设置广播的打开 Promise。翻译继续共用 `playback.showTranslation`，岛内 `hideTranslation` 不改变其他视图，不另存播放状态或歌词。左右内容预设只修改 leftContent/rightContent，不重复保存预设名。
- 窗口位置/尺寸在移动和缩放后以 300ms 防抖串行保存，关闭和退出排空同一队列；失败保留最近位置供重试并通过 `desktop-lyric:error` 提示。外部导入/恢复立即应用新位置，取消尚未执行的旧写；已进入事务的旧写完成后补回最新接受的位置，自写广播不拉回正在拖动的窗口。`bounds` 默认 null，合法值只保留有限的 x/y/width/height；创建与显示器变化时夹紧到可用工作区，默认主屏下方 800×200，最小 420×180。
- 主题包可选 `desktopCss` 由主进程经共享目录校验和编译，再沿原显示偏好通道发送 `appearance`（视觉令牌与窗口限定 CSS）。独立 HTML 整份替换令牌/style；普通偏好消息缺少该字段时保持外观，切回无桌面 CSS 的主题发送 null 清除。异步解析按窗口身份与设置代次拒绝旧结果，保留经典/渐变/简约模式和现有隔离设置。
- `playback.quality` 沿既有设置事务持久化，默认字符串 128，Schema 与渲染侧一致只接收 128/320/flac/high，旧配置补全、非法值回退；不持久化或伪造当前歌曲的有效音质。
- `software.updates` 仅保存 `autoCheck`、`autoDownload` 和 `channel`，默认 true、false、stable，渠道限定 stable/beta；旧配置与非法导入值按同一规则补全。成功提交的设置广播才调用更新服务 `configure()`，不保存下载进度、文件路径或安装开关。
- `download.offlinePlaylistCacheEnabled` 默认 true，`cacheSizeIndex` 限定 0–5（2048/4096/6144/8192/10240MB/无限制），`concurrentDownloads` 为 1–10，默认 3；原预留下载目录与缓存路径保持兼容，不作为离线服务目录来源。
- `download.offlineCachePath` 默认空，仅迁移专用的 `setOfflineCacheDirectory()` 可在文件复制校验完成后串行原子保存；普通设置草稿、导入和重置保留最近已提交的路径，避免改变配置却未迁移文件。该事务不触发自启等无关系统操作，Windows 文件短暂占用时有限重试原子替换，持续失败保留原设置。
- 桌面歌词替换数组或歌曲身份时重置行索引，时间消息保存实际音频位置与可推进状态；只在明确可播放时以倍率逐帧插值，单个采样最多延伸 300ms，重复采样不延长截止时间。暂停、缓冲、seek、换源和重开立即冻结或重置，细小消息抖动不撤回已开始的自然换行；所有插值仅控制歌词显示，不写回播放进度。首帧、暂停重开、前后跳转和同文重复句均从绝对时间重算所有字素，歌词以纯文本创建 DOM，保留 Unicode 字素与原空格。
- 前奏预览首句；当前句有译文且开关启用时次行显示译文，否则显示下一句。长句原文及当前译文根据播放时间与溢出宽度平移，下一句保持句首。自然连续换行时预览从次行位置上移、放大为当前行，下一句淡入；跳转、快速换曲、暂停及减少动态效果取消旧过渡。内容、字号和视口变化后重测，暂停保持横向位置。

## 窗口与兼容保障

- 所有窗口禁用 Node 集成并启用上下文隔离；HTML 不直接使用 `require('electron')`。
- 桌面窗口的就绪、加载失败、10 秒超时、崩溃与关闭回调均绑定创建时实例；快速开关不能复活旧窗口或清除新窗口引用，显示失败返回 false，成功通过 `showInactive()` 显示而不抢焦点。窗口关闭清理显示器监听和计时器。
- 锁定同步应用原生鼠标穿透、禁止移动与禁止聚焦，HTML 将工具栏 inert，独立解锁按钮固定右/上边距 8 DIP、44×36 DIP。主进程只在光标进入此矩形且按钮未隐藏时暂时开放点击，其余区域维持穿透；悬停渐隐只对锁定窗口生效，解锁热点至少保留 20% 透明度便于找回。`hideUnlockButton` 关闭该热点，托盘和设置仍能解锁。“找回并解锁”恢复主屏默认位置/尺寸并临时可见 5 秒。
- `desktopLyricPolicy` 消费已提交偏好，统一应用 `autoHidePaused`、`hideOnLyricView`、`hideOnFullscreen`、`opacity`、`hoverFade`/`hoverOpacity` 与 `alwaysOnTop`。主页面通过固定布尔 `setLyricViewVisible()` 上报应用歌词界面，只有主窗口可见且与桌面窗口同屏才隐藏桌面；主窗隐藏/最小化恢复桌面，再显示时继续检测；重载/崩溃/销毁清除过期上报。外部前台全屏检测仅 Windows，通过独立只读服务返回屏幕范围，同屏才隐藏。
- 透明度、穿透及运行时隐藏不写回设置。原生显隐发送 `desktopLyricAPI.onRuntimeState({hidden})`，HTML 隐藏时停止绘制调度，恢复后按最新音频锚点显示。指针检测只在锁定且有渐隐/解锁热点时运行，外部检测只在需要时运行；普通/高效模式分别 100/300ms，关闭窗口和退出清理监测器。
- `doubleLine` 控制副行，`songInfoOnly` 显示标题/歌手并停止持续插值，关闭 `karaokeEnabled` 时整句高亮。高效模式按 34ms 调度且禁用装饰动画；换行动画与模糊分别由 `transitionEnabled`/`transitionBlur` 控制，系统减少动态优先。颜色空值继承主题，字体使用转义后的单个 family，描边 100% 对应 1px；阴影按颜色/深度/方向/透明度/半径绘制，封面模式按需从 24×24 图片取色，迟到结果按版本拒绝、失败回退自定义颜色。
- 透明窗口禁用原生 resize，右下手柄通过固定 `beginResize/resize/endResize` 桥接由主进程读取屏幕 DIP 坐标调整，方向键通过 `resizeBy` 微调；取消、失焦、锁定和卸载终止手势，不信任渲染进程提供的屏幕坐标。播放控制仅允许当前桌面顶层窗口发送 prev/toggle/next，复用主播放器控制链；按钮读取真实播放/可操作状态，主窗口就绪、重载、崩溃、关闭及安装准备/取消均同步。锁定时工具栏隐藏，托盘解锁或找回失败通过原生对话框反馈。
- `playlist-cache:*` IPC 仅允许主窗口顶层，通过固定桥接操作绑定账号、读写快照、缓存已播放歌曲、保存歌词、加载封面及管理任务。主进程不接收任意文件路径，媒体地址仅包含不可猜租约；协议在 ready 前注册 standard/secure/stream，支持 GET/HEAD/单段 Range，不绕过 CSP。退出账号保留已授播放租约，后续源必须按当前账号重新申请。
- `electronAPI.lyricLibrary` 仅暴露 list/read/saveOnline/saveEdit/select 和可解绑 onChanged；`lyric-library:*` 仅接受主窗口顶层。服务校验歌曲 hash、版本存在性、原始响应和大小，剔除凭证，不暴露路径、删除或通用文件能力；用户编辑与手动选中的历史版本不会被自动更新替换。
- `playlist-cache:choose-directory` 无路径参数，只采用原生选择框返回的父目录并追加 `offline-playlists`；选择前后核对主窗口身份和退出状态，重复选择或迁移返回忙碌。服务依次复制校验全部账号、保存新路径、切换租约并等待旧读流释放后清理；状态广播携带实际目录、迁移阶段和错误/警告。
- electronAPI.writeClipboardText(text) 仅桥接 clipboard:write-text；主进程复用主窗口顶层发送方检查，只接受最多 1 MiB UTF-8 字符串并写纯文本，不提供读取、任意格式或通用 IPC 能力，不记录复制内容。
- `updates:*` IPC 仅接受主窗口 webContents 及其顶层 frame；检查、下载、取消和定位均由主进程服务负责，下载参数只接受服务提供的资产 ID，渲染侧不能注入下载 URL 或本机路径。状态只向主窗口广播展示字段。
- `electronAPI.updates.onPrepareForInstall()` 订阅准备/取消通知并返回解绑函数；`completePrepareForInstall(requestId, result)` 只反馈当前准备结果，不直接授权安装或退出。保存中屏蔽托盘播放操作，过期回执无效。
- 安装只能由 `updates:install` 的用户动作触发：Worker 先校验文件，原生对话框默认取消，明确确认后再次校验并核对文件、版本和资产身份，随后才调用 `shell.openPath()`。只允许 exe/dmg/deb/rpm，AppImage 定位后由用户处理；启动、下载完成、退出均不安装，也不自动退出应用。
- 订阅和定时任务成对释放；桌面歌词卸载时取消订阅、待执行的动画帧、结果提示定时器、WAAPI 动画和尺寸观察器，终止缩放。两份独立 HTML 使用自己的 prefers-reduced-motion 查询与变更监听，系统偏好变化立即取消旧动画，提示已进入淡出时立即清空其终态，卸载时解除媒体查询监听；连续歌曲/阶段/结果更新先取消旧动效，迟到的完成回调不清除新内容。桌面控件支持键盘聚焦显现、原生按压反馈，锁定后不可交互。
- 普通关闭遵循 `minimizeToTray`，主动退出和清理中的关闭不再隐藏到托盘。
- 任务栏按钮仅在 Windows 注册，等待主窗口顶层就绪期间、主页面重载/崩溃、安装保存及退出时禁用。回调检查窗口身份与实时状态，关闭后旧回调不作用于新窗口；播放/暂停图标只随音频回报更新，不做乐观切换。
- 开发及构建后的主入口共用同一职责；Vite 处理主进程本地模块，并将加载、桌面歌词和灵动岛三份 HTML 复制到构建入口旁。
- 灵动岛服务独立管理窗口就绪、关闭/超时/崩溃和显示器监听；所有回调绑定创建实例，显示使用 showInactive。主入口向两种歌词窗口转发同一歌曲、歌词、时间及真实可操作状态，主窗口重载/崩溃、安装准备及退出均禁用灵动岛控制。灵动岛控制、拖动及穿透 IPC 仅接受当前岛顶层来源，主窗口的显示、显示器枚举、能力查询及全屏歌词可见性通知也校验顶层来源；控制复用 prev/toggle/next，不改变原播放导航。
- 大陆模式依据所选显示器 bounds 贴住真实上沿，不被顶部任务栏的 workArea 下移；浮动模式在工作区内夹紧位置。拖动只由主进程读取光标 DIP 坐标，结束后保存显示器/模式/位置，靠近顶部吸附为大陆模式，失败恢复已提交位置，退出等待在途位置保存。屏幕列表热插拔通知与迟到枚举结果有代次保护，所选屏幕断开后回主屏。
- Windows/Linux 禁用最小化到托盘时，主窗口关闭即走现有退出清理，不依赖灵动岛启用状态或最后窗口退出事件；仅剩桌面歌词时也关闭辅助窗口并等待后台服务停止。启用托盘和 macOS 关闭驻留仍沿用原行为，macOS Dock 激活按主窗口是否存在恢复或重建，不受剩余歌词窗口影响。正式退出保留已保存的灵动岛开关。
- 大陆模式保持穿透、不接收键盘操作，鼠标进入固定凹口形状区域时淡出避让，离开后恢复；浮动模式只在实际圆角区域接收鼠标，点击/右键或 Enter/空格展开，Escape 收起，悬停和聚焦不自动展开。Windows/macOS 使用原生 forward，Linux 每 80ms 读取 DIP 光标并转换为窗口内坐标；Linux 创建时保留 focusable 以支持浮动键盘操作，切回大陆时清除焦点并恢复穿透。退出释放轮询、订阅、计时器、动画和尺寸观察器。
- 整体不透明度只应用一次：Windows/macOS 通过原生 setOpacity，Linux 通过主进程指定的 opacityInRenderer 在 body 生效；背景不透明度单独作用于凹口和面板。缩放与字体尺寸共同参与布局及命中区域，减少动态偏好变更取消旧装饰动画。
- 自动隐藏只改变窗口可见性：暂停/无音乐或播放不可用时可隐藏，手动预览暂时绕过此条件；同屏应用全屏歌词或外部应用全屏仍按偏好避让。Windows 外部检测复用 fullscreenMonitor 对共享 windowsForeground 的适配，主入口从 app.getAppPath()/electron/services/windowsForeground.ps1 提供固定路径，Node 读取 ASAR 内脚本并编码交给隐藏 PowerShell，物理矩形转 DIP 后匹配显示器；其他系统能力返回 false。禁用或退出停止检测，不改播放或启用偏好。
- 凭证和个人数据不进入日志，高频诊断使用 Trace；保持现有 IPC 频道和设置字段兼容。

## 验证

在项目根目录执行已验证的 `npm run check`、`npm test`、`npm run build`。涉及窗口、设置或生命周期时，还需实际运行 Electron，验证桌面歌词、保存设置、主动退出及本地端口释放；自动化 Mock 不能代替这些运行检查。
