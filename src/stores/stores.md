# stores 速查

## 职责

维护唯一的渲染侧响应式设置与播放会话；本目录没有子目录。

## 直接文件

- `settingsStore.js`：默认设置、迁移、初始化、更新、导入导出及会话快照。

## 状态与接口

- `useSettingsStore()` 暴露稳定的 `settings` 引用和 ready/loading/error/revision 状态。
- `initSettings()` 复用初始化 Promise，并发读取 `window.settingsAPI` 的默认设置、默认目录与已保存设置，再统一补全、应用主题并就绪；任一读取失败沿用对应回退，浏览器回退 LocalStorage。
- 默认分组为 playback/desktopLyrics/islandLyrics/download/custom/shortcuts/software/session，Schema 版本为 1。
- 当前版本的设置也按默认值补全缺失分组，保留已保存的用户选择。
- 主题包列表保存在 `custom.themePackages`，选择的包 ID 使用原 `custom.theme`；旧配置自动补全空列表，不迁移或删除已有配色。
- `custom.themeAdjustmentId` 仅标识设置页创建的个性主题包；精调保留原包并复用该 ID 更新，不创建另一套主题来源。
- `desktopLyrics` 由双端 `normalizeDesktopLyrics()` 补全与白名单校验；主进程导出此函数供窗口同步复用。保留 fontSize=medium、theme=classic、locked=false、bounds=null，默认开启双行、逐字高亮、换句动画及模糊、置顶和同屏全屏歌词隐藏。其余隐藏/节能/信息模式等布尔项默认关闭，严格保留布尔类型。
- 桌面透明度/悬停透明度/阴影透明度限制 0–100%，描边 0–200%，阴影深度 0–30px、方向 0–360°、半径 0–40px；字体最多 128 字符且拒绝控制符，颜色仅六位十六进制，空文字色继承主题。对齐限制 left/center/right，阴影来源 cover/custom；未知字段丢弃。bounds 仅保留有限的 x/y/width/height 并取整，位置限定 ±100000、宽 420–8192、高 180–4096，实际显示时由主进程夹紧至屏幕工作区。
- `islandLyrics` 双端按相同规则补全：enabled=false、showLogo=true、mode=mainland（另可选 floating）、displayId=primary、position=null；浮动位置只保留有限 x/y，夹紧至 ±100000 DIP 并取整。所有布尔项严格校验，未知字段过滤；只有成功保存的启用状态控制窗口，启动恢复已保存状态。
- 灵动岛 alwaysTwoLines/hideTranslation/songInfoOnly/boldText 默认 false，karaokeEnabled 默认 true；fontFamily 默认空字符串，最多 100 字符且不含控制符，fontSize 默认 22，有限数值夹紧 14–40 并取整。leftContent/rightContent 默认 logo/cover，分别限定 none/logo/cover；预设只从两侧内容推导，showLogo 独立控制标识显隐。
- 灵动岛 autoHide=true、hideOnFullscreen=false、hideOnLyricView=true；外部全屏检测按主进程能力提示平台限制。opacity 默认 1、范围 0.2–1，backgroundOpacity 默认 1、范围 0–1，scale 默认 1、范围 0.5–2；数字只接受有限数值，colors 只接受六位十六进制，默认 text=#ffffff、inactive=#656565、background=#000000。
- `playback.showTranslation` 默认 true，非法类型回退默认；全屏、桌面和灵动岛沿用此总偏好。桌面与灵动岛的 `hideTranslation` 分别隐藏各自窗口的翻译与已有音译，不修改总偏好。
- `playback.restartOnPreviousNearEnd` 默认 false，双端只接受布尔 true 开启，旧配置缺失及非法类型回退 false；沿原事务保存、导入导出和恢复。播放器统一上一首入口实时消费此偏好。
- `playback.quality` 默认字符串 128；双端仅接收 128/320/flac/high，补全旧配置，非法导入值回退 128。它表示所选音质偏好，当前音源的真实格式和码率由播放器独立维护。
- `software.updates` 默认 `{ autoCheck: true, autoDownload: false, channel: 'stable' }`；双端补全旧配置，布尔开关严格校验、渠道限定 stable/beta，移除未知字段及任何自动安装开关。更新服务只消费保存成功的设置，检查结果、进度和本机安装包路径不进入本 store。
- 离线缓存复用 download 分组：offlinePlaylistCacheEnabled 默认 true；cacheSizeIndex 默认 0，限定 0–5；concurrentDownloads 默认 3，限定 1–10。双端按同一规则补全与校验，不将缓存资源、凭证或进度存入设置。
- `download.offlineCachePath` 默认空，表示沿用主进程默认缓存目录；非空值由主进程完成目录迁移后专用提交并广播。渲染草稿不直接编辑此字段，普通保存、导入和重置不能改变已提交目录；旧 `downloadPath/cachePath` 继续保留兼容。
- `updateSettings()` 默认合并，`overwriteSettings()` 替换，均保留响应式对象引用。
- `saveSessionSnapshot()` 合并队列、当前歌曲、索引及播放时间、音量和模式。
- `flushPendingSettings()` 等待已有串行写入及其间新增的事务，传播持久化失败；供安装前保存确认使用，不能把队列用于恢复的 catch 当作保存成功。

## 持久化流程

- `playback.lyricLibrary` 默认 `{ enabled: true, autoSave: true, minMatch: 'high', autoUpdate: true }`；双端仅保留这四个字段，匹配限定 exact/high/medium/any。正文版本存独立歌词库，不进入设置或播放会话。
- `playback.romanization` 限定 off/on，默认 off；preferSimplifiedChinese 默认 true，segmentLyrics/showProfanity 默认 false，均严格保留布尔值。内容偏好实时处理显示副本，中文翻译继续使用原 showTranslation。

- 编辑先更新界面并记录 mutation 版本，持久化任务进入串行 Promise 队列。
- 每次执行保存时采集最新快照；成功后只移除已提交版本的编辑。
- 保存期间的主进程广播暂存，提交后叠加尚未提交的修改。
- 失败恢复最近已提交或重新读取的快照，只撤销失败调用及此前的修改。
- 后续编辑仍重放并排队保存，前一次失败不阻断后续任务。

## 关键保障

- 深拷贝与合并经对象工具验证，拒绝原型污染字段。
- 主题在设置应用与编辑时同步更新；本机目录由主进程提供，不写死用户路径。
- 浏览器持久化键为 `betterkugou_settings`，会话恢复开关由 App 执行。

## 配置与入口

| 配置 | 实际消费与设置入口 |
| --- | --- |
| playback.fullscreenLyrics / enqueueFullPlaylist / showTranslation | App 自动歌词、列表入队以及全屏/桌面歌词翻译；设置“播放与歌词”，翻译也可在两种歌词工具栏内切换。 |
| playback.quality | 播放器请求的普通音质偏好；底栏与全屏歌词快速切换当前歌，设置“播放与歌词”选择后续歌曲偏好。 |
| playback.restartOnPreviousNearEnd | 设置“播放与歌词”的末尾重播开关；开启后歌曲实际剩余 0–10 秒时上一首从头播放当前歌，关闭时保持正常上一首导航。 |
| desktopLyrics.fontSize / theme / locked / bounds | 独立歌词窗口字号、配色、原生锁定穿透及位置尺寸；设置与窗口工具栏同步，位置由主进程保存；托盘/设置支持解锁和找回。 |
| desktopLyrics 显示、动效、外观及隐藏规则 | DesktopLyricSettings 编辑父级草稿；HTML 消费行数/逐字/字体配色/阴影等，主进程消费显隐、透明度、置顶与穿透；只应用保存成功的偏好。 |
| islandLyrics.* | IslandLyricSettings 编辑原草稿的启用、贴顶/浮动、屏幕/坐标、内容、字体颜色、透明度缩放及隐藏规则；先保存再重新显示，自动隐藏时提供 3 秒预览，停用时仍可编辑偏好。 |
| custom.playerStyle / theme / customTheme / themePackages | 播放栏布局、完整主题及旧三色配色；设置“外观与主题”，精调只编辑已有消费的视觉令牌。 |
| shortcuts.enableGlobal / keys | App 与主进程快捷键；设置“快捷键”，注册探测只检查可用性。 |
| software.autoLaunch / minimizeToTray / restorePlaylist / restorePlaybackState / defaultPage | 系统启动、关闭、会话恢复和启动页；设置“启动与应用”。 |
| software.updates.autoCheck / autoDownload / channel | 主进程更新服务的自动检查、自动下载及正式/测试渠道；设置“启动与应用 → 应用更新”，保存成功后生效。 |
| download.offlinePlaylistCacheEnabled / cacheSizeIndex / concurrentDownloads | 独立离线缓存服务消费已提交偏好；设置“下载与缓存”，默认启用、2GB 和 3 并发。 |
| download.offlineCachePath | 离线缓存实际根目录，空值使用 userData/offline-playlists；设置“下载与缓存 → 更改位置”迁移全部账号后由主进程提交。 |
| download.downloadPath / cachePath | 保留旧配置兼容，普通文件下载尚未开放；这两个字段不控制离线缓存目录。 |
| session.* | 播放器实时队列、进度、音量和模式；由播放会话维护，不在偏好设置重复编辑。 |

## 运行

项目命令和设置测试见 [BK.md](../../BK.md)。
