# stores 速查

## 职责

维护唯一的渲染侧响应式设置与播放会话；本目录没有子目录。

## 直接文件

- `settingsStore.js`：默认设置、迁移、初始化、更新、导入导出及会话快照。

## 状态与接口

- `useSettingsStore()` 暴露稳定的 `settings` 引用和 ready/loading/error/revision 状态。
- `initSettings()` 复用初始化 Promise，优先读取 `window.settingsAPI`，浏览器回退 LocalStorage。
- 默认分组为 playback/desktopLyrics/download/custom/shortcuts/software/session，Schema 版本为 1。
- 当前版本的设置也按默认值补全缺失分组，保留已保存的用户选择。
- 主题包列表保存在 `custom.themePackages`，选择的包 ID 使用原 `custom.theme`；旧配置自动补全空列表，不迁移或删除已有配色。
- `custom.themeAdjustmentId` 仅标识设置页创建的个性主题包；精调保留原包并复用该 ID 更新，不创建另一套主题来源。
- `desktopLyrics` 默认 fontSize=medium、theme=classic、locked=false；双端补全旧配置，只接收 small/medium/large、classic/gradient/minimal 与布尔锁定。歌词翻译 showTranslation 默认 true，非布尔导入值回退默认，合法 false 保留。
- `playback.quality` 默认字符串 128；双端仅接收 128/320/flac/high，补全旧配置，非法导入值回退 128。它表示所选音质偏好，当前音源的真实格式和码率由播放器独立维护。
- `updateSettings()` 默认合并，`overwriteSettings()` 替换，均保留响应式对象引用。
- `saveSessionSnapshot()` 合并队列、当前歌曲、索引及播放时间、音量和模式。

## 持久化流程

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
| playback.fullscreenLyrics / enqueueFullPlaylist / showTranslation | App 自动歌词、列表入队和 LyricView 翻译；设置“播放与歌词”，翻译也可在全屏歌词内切换。 |
| playback.quality | 播放器请求的普通音质偏好；底栏与全屏歌词快速切换当前歌，设置“播放与歌词”选择后续歌曲偏好。 |
| desktopLyrics.fontSize / theme / locked | 独立歌词窗口字号、配色和锁定；设置与窗口现有工具栏双向同步，锁定在设置中恢复。 |
| custom.playerStyle / theme / customTheme / themePackages | 播放栏布局、完整主题及旧三色配色；设置“外观与主题”，精调只编辑已有消费的视觉令牌。 |
| shortcuts.enableGlobal / keys | App 与主进程快捷键；设置“快捷键”，注册探测只检查可用性。 |
| software.autoLaunch / minimizeToTray / restorePlaylist / restorePlaybackState / defaultPage | 系统启动、关闭、会话恢复和启动页；设置“启动与应用”。 |
| download.* | 保留旧配置及目录初始化；音乐下载、缓存限额与并发控制未接入，界面只读/禁用。 |
| session.* | 播放器实时队列、进度、音量和模式；由播放会话维护，不在偏好设置重复编辑。 |

## 运行

项目命令和设置测试见 [BK.md](../../BK.md)。
