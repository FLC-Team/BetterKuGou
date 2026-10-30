# 主进程服务速查

## 职责与文件

当前目录没有子目录，承载由 Electron 主入口调用的独立生命周期服务。

- `desktopLyricPolicy.js`：桌面歌词隐藏条件、原生透明度及固定解锁热点的纯计算，不保存临时状态。
- `windowsForeground.js` / `windowsForeground.ps1`：每实例按需管理自己创建的隐藏 Windows 前台全屏检测 helper，只读取前台窗口和屏幕几何，不枚举用户进程、读取标题或采集画面。

- `backendService.js`：创建并管理本地酷狗 API Utility Process，处理启动、健康检查、状态通知及退出清理。
- `islandLyricService.js`：按需创建所选屏幕的大陆贴顶或浮动窗口，管理就绪、预览、播放/全屏隐藏、原生拖动与顶部吸附；并发打开共用就绪任务，回调校验窗口身份，加载失败/崩溃/10 秒超时解除等待。显隐及设置更新同步真实光标并重置交互缓存，避免隐藏后恢复仍然穿透；Linux 只在显示时轮询光标。显示器变化恢复可见位置，关闭释放监听、预览计时器和轮询；歌词快照及持久化仍由主入口提供。
- `fullscreenMonitor.js`：灵动岛对共享 `windowsForeground.js` 检测器的启停适配，复用同一 Windows 全屏检测协议，不增加第二套原生探针；其他平台明确不支持。
- `updateService.js`：调度应用更新 Worker、已提交更新策略、状态与进度广播、任务去重、取消及退出清理；保留安装包私有路径供主进程复核。
- `updateWorker.cjs`：独立 Node Worker，负责固定仓库发布分页、SemVer/平台架构筛选、双源网络请求、流式下载和文件校验；仅使用 Node 内置模块，随 extraResources 发布。
- `installQuitService.js`：Windows 安装退出协作，使用 Node 内置 net 和每 PID 命名管道承载固定能力探测、保存退出协议，不启动旧版 exe 或强制结束进程。
- `playlistCacheService.js`：主窗口固定缓存能力与 Worker RPC、会话代次、状态广播、媒体租约、目录迁移提交及退出清理；不在主线程下载或计算摘要。
- `playlistCacheWorker.cjs`：独立离线缓存 Worker，维护账号索引、完整歌单快照、实际播放歌曲的下载队列、歌词翻译和已加载封面，执行全部账号文件的目录迁移与校验；只用 Node 内置模块，通过 extraResources 发布。
- `playlistCacheMedia.js`：将已授予的私有媒体租约转换为 GET/HEAD/单段 Range 响应，不接受调用方路径。

- `lyricLibraryService.js`：在固定私有目录独立保存曲目歌词版本，提供列表、读取、在线保存、编辑副本与版本选择；异步串行读写，临时文件原子发布，不与离线缓存配额或账号清理混用。

## 核心函数与数据流

- `createBackendService(options)`：接收开发/生产路径、进度及状态回调、退出状态查询，返回独立服务实例。
- `start()`：开发时加载项目内 `KuGouMusicApi/app.js`，生产时加载 `resources/backend/app.js`，通过 `utilityProcess.fork()` 启动并固定 `HOST=localhost`、端口 `6500`，随后立即探测 HTTP 就绪状态。
- `waitUntilReady()`：同次启动共享就绪 Promise，首次 2xx 响应完成 `true`；未启动、启动失败、10 秒期限到达、进程退出或停止时完成 `false`，不会无限阻塞渲染入口。
- `checkHealth()`：取消旧检查，立即对当前实例的根路由发起限时 HTTP 请求；启动期连接失败或非 2xx 响应每 100 毫秒重试，统一受启动期限限制，只有 2xx 响应报告 `connected`。日志中的端口或进程创建本身不代表 HTTP 已就绪。
- `stop()`：复用正在执行的停止 Promise，取消健康请求及启动/检查定时器，等待进程退出；超时后 Windows 使用 `taskkill /T /F`，其他平台发送 `SIGKILL`。
- `isRunning()`：报告当前是否仍持有后端进程实例。

主入口启动服务并创建窗口 → Utility Process 启动 API → 首次成功 HTTP 探测解除渲染初始化等待并广播状态 → 主入口退出时等待 `stop()`。

### 灵动岛全屏检测适配

- `createFullscreenMonitor({ onChange, logger, platform, scriptPath })` 返回 `supported`、`isActive()`、`start()` 与异步 `stop()`。只支持 Windows，创建实例不启动进程；主入口仅在相关已保存偏好生效时启动，关闭偏好与应用退出时停止。启停交错时先排空旧进程，仅最新启用请求可继续配置共享检测器。
- 适配器以 `efficientMode=true` 复用共享检测器的 300ms 探测、输出校验及隐藏进程生命周期。主入口显式传入 `app.getAppPath()/electron/services/windowsForeground.ps1`，测试或独立使用默认同目录脚本；固定脚本经 Node 读取后编码传入 PowerShell，兼容 ASAR，不需要 Vite 复制、asarUnpack、临时脚本或另一份原生实现。
- 状态沿用 `{ fullscreen: false }` 或 `{ fullscreen: true, bounds: { x, y, width, height } }`，矩形为物理显示器坐标，由调用方转为 Electron DIP。只在状态或显示器变化时通知，故障恢复非全屏并提供日志，后续显式开启可重试。
- 桌面歌词与灵动岛复用同一检测实现，可分别创建实例并管理自己的 helper；不作为应用级进程单例。

### 应用更新

- `createUpdateService(options)` 接收 Worker 路径、专用下载目录、实际版本、平台架构和状态回调；`configure()` 只消费已提交的 `software.updates`，默认自动检查开启、自动下载关闭、正式版 stable，测试版使用 beta。首次启动延迟 10 秒检查，此后每 24 小时检查；普通设置广播不重置计划。
- `check()` / `download(assetId)` 立即返回状态，任务在 Worker 中进行；`getState()` 返回带递增 revision 的展示快照，发布下载 URL 和本机路径保持私有，进度节流后广播。检查与下载共享单任务；`cancel()` 立即失效旧任务，取消的版本在本次会话不再自动重下，但允许用户手动重试。
- Worker 分页请求固定 `FLC-Team/BetterKuGou/releases`，元数据先使用 `https://git.tangbai.cc/https://api.github.com/repos/FLC-Team/BetterKuGou/releases`，失败再从 GitHub 原站重新分页。按 SemVer 选择高于安装版本的最新版本；stable 同时排除 GitHub prerelease 标记与版本预发布后缀，beta 包含正式与预发布。
- Windows 匹配通用或当前架构 setup.exe，macOS 匹配当前架构 DMG，Linux 优先同架构 AppImage，也允许同架构 DEB/RPM。无匹配包仍返回版本说明，禁止把未知架构误当作当前架构。
- 下载单独优先代理资产 URL，网络、超时或完整性失败后从头尝试 GitHub 一次；用户取消与磁盘错误不换源。只允许固定仓库的 HTTPS 地址和受限重定向主机，文件名和路径必须落在专用目录。
- 在 `userData/updates/` 使用唯一 `.part` 临时文件流式写入，核对发布大小并计算 SHA256，有发布 digest 时必须匹配。发布 digest 可校验的完整缓存可复用；无发布 digest 时仍计算本次摘要供后续复核，不复用无法验证来源的同大小缓存。失败或取消先销毁写流并等待真实关闭（包含尚未完成的文件打开），再清理临时文件，完成清理后才结束下载任务。
- `getDownloadedFile()` 在 Worker 中重验大小和 SHA256，主进程据此执行定位或明确确认后的打开；Worker 没有安装命令。切换渠道取消旧任务并丢弃候选状态，进程内状态及取消记录不持久化。

已提交设置 → updateService 调度 → updateWorker 检查/下载/校验 → 带 revision 的主窗口展示状态；用户确认安装 → Worker 再次复核 → 主进程打开同一安装包。

### 离线歌单与已播放歌曲

- `createPlaylistCacheService({ workerPath, cacheRoot, onState, onAuthExpired })` 初始化单个 Worker；`configure()` 只消费已提交的设置。`setSession()` 绑定瞬态凭证并推进代次；账号索引使用 userId 摘要命名，凭证不落盘、不进入日志或展示状态。
- `putPlaylist()` 只保存完整列表及真实歌单 ID，收藏使用 isFavorite 别名并与普通入口去重，保留收藏与最近 10 个普通歌单；`readPlaylist()` 更新最近访问而不解除暂停。只有实际播放后的 `cacheSong()` 才排音频任务，不遍历列表预取；`putLyrics()` 保存播放器已取得的完整歌词翻译响应，`cacheArtwork()` 由图片真实 load 触发。
- 下载复用旧 `/audio` 和 `/song/url`，不请求试听；按响应内容识别认证错误，包括 HTTP 502 的业务错误。音频与封面流式写 `.part`，核对长度、实际格式、SHA256 后原子发布，损坏完整文件不可复用。媒体与图片下载不携带账号凭证，图片域名及公网地址受限。
- 全局配额包括所有账号、临时文件、索引及待释放媒体；并发预留空间，按最近使用回收非租约文件，evicted 不自动循环重下。网络失败有限退避，`retryNetwork()` 仅恢复网络失败，不解除暂停、清理抑制或重试权限错误；用户 retry 可重试失败任务。
- `getSource()` / `getArtwork()` 校验完整文件后授予不透明租约，渲染侧只获得 `bk-cache://media/<lease>`。租约持续保护当前、候选与回滚音源，logout 不撤销已授源，后续读取需要当前账号；release 后清理等待删除文件，Worker 重建也恢复租约与孤儿释放保障。
- `clear()` 清理当前账号音频、歌词与封面，保留完整列表入口，正在使用文件延迟至租约释放后删除；清理后仅新播放或用户继续/重试可重新积累，不由页面激活或联网事件解除。关闭自动缓存暂停任务，读取已有音源仍可用；重启只恢复先前已播放的未完成任务。
- `changeDirectory(targetRoot, persistDirectory)` 串行协调迁移，普通缓存 RPC 与账号变更等待迁移提交，已授媒体读流继续可用。Worker 的 `prepareMigration()` 暂停下载并排空写入，将全部账号索引、完整音频、歌词和封面复制到目标旁的专用临时目录，逐文件核对大小与 SHA256 后发布；拒绝相互包含、非绝对、链接及非空目标，不将部分下载当成完整媒体迁移。
- 目标发布后先调用专用设置事务保存路径，再由 `commitMigration()` 切换 Worker 根目录及租约；主进程同步调整已有租约，新读流直接读目标，迁移前打开的源读流结束后才执行 `finalizeMigration()` 清理。状态提供 `copying/verifying/committing/cleanup`、复制/校验字节数、实际目录和错误/警告；清理只删除本次已核对且未被外部改变的文件。
- 路径保存前失败调用 `rollbackMigration()`，原位置保持可用，临时副本清理失败明确提示。保存成功后 Worker 异常以已发布目标重建，绝不删除新缓存，源副本保留并提示；无法立即重建时可重试或重启。清理失败保留未确认安全的文件，不覆盖无关内容。
- Windows 整目录重命名遇到持续占用时，短暂重试后使用独占目标目录并逐文件发布，失败按本次文件清单清理两侧副本；校验及复制句柄均等待关闭。删除旧媒体前核对仍被引用的目标副本，正常索引更新和已回收媒体沿当前状态处理。强制结束进程可能留下暂存或目标副本，原缓存保留；未提交的非空目标需选择其他位置，不能自动覆盖。
- Worker 故障使进行中 RPC 失败，后续操作可重建 Worker；部分损坏索引经过规范化后可恢复，临时残留不作为完整资源。应用退出先等待迁移及已开始的清理，再取消网络与写入、等待索引落盘，超时结束线程，重复 stop 共享同一任务。

### 曲目与歌词管理

- `createLyricLibraryService({ root, onChanged })` 使用主进程提供的 `userData/lyric-library/`，歌曲 hash 规范化后以 SHA256 文件名保存；渲染侧只使用歌曲与版本标识，不接受目录参数。文件读取和原子替换使用异步文件操作，失败保留旧版本与损坏原件，后继操作可重试。
- `configure()` 只消费已提交的 `playback.lyricLibrary`，默认 enabled/autoSave/autoUpdate 开启、minMatch 为 high。关闭后 `list()`/`read()` 返回空结果，不自动保存且保留已有文件；偏好变化推进代次，尚未发布的旧写入取消并清理临时文件。
- `saveOnline({ hash, title, artist, sourceId, matchLevel, data, mode })` 保留原始歌词响应并递归剔除凭证/危险键。autoSave 按 any/medium/high/exact 阈值判断；autoUpdate 不依赖自动保存开关，但必须已有对应在线源。内容摘要去重，后台更新新增在线版本，不覆盖原版本、编辑副本或用户明确选中的版本。
- `read(hash)` 返回带 `selectedVersionId` 和完整 versions 的曲目；`list()` 只返回曲目信息和版本数量。读写统一补全可编辑 `data.decodeContent`，兼容普通/嵌套正文和合法 UTF-8 Base64 时间轴歌词，拒绝尚未解压的 krc1 内容。
- `saveEdit({ hash, versionId, content })` 新建并选中编辑副本；有序行时间标签不变时保留语言数据，增删行或更改时间标签时移除继承的外部翻译/罗马音和旧内嵌 language 标签，并保存 `languageReset` 供界面提示。明确编辑内嵌 language 时以新正文标签为唯一语言来源，在线原件始终保留。`select({ hash, versionId })` 持久化手动选择；自动选中的在线版本随新内容前进，手动选择保持稳定。
- 写入成功后广播 `{ hash, revision, reason }`，reason 为 online/edit/select；保存失败不广播。歌词响应限 2 MiB、编辑正文限 1 MiB，单曲限 100 个版本和 16 MiB，达到边界拒绝新增并保留已有内容。退出 `stop()` 失效待执行操作并等待当前队列结束，无后台定时任务。

## 生命周期保障

- 桌面策略将暂停、同屏且可见的应用歌词界面及同屏外部全屏组合；主窗口隐藏/最小化只重算可见性，重载/崩溃/销毁清除歌词界面状态。临时隐藏、鼠标悬停及找回状态不写设置。
- 外部全屏仅 Windows 支持：隐藏 PowerShell 接收固定 `SAMPLE`/`EXIT` 行，Win32 使用 `GetForegroundWindow`、`GetClientRect`/`ClientToScreen` 和 `MonitorFromWindow`/`GetMonitorInfo` 比较客户区与整屏范围，排除自身进程与系统桌面/任务栏。线程临时启用每显示器 DPI 感知，返回物理像素屏幕矩形，主进程用 Electron `screenToDipRect` 转换后匹配桌面窗口屏幕。
- Node 从 `app.getAppPath()/electron/services/windowsForeground.ps1` 读取随 `electron/**/*` 打包的固定脚本，再传给 PowerShell 编码命令，因此支持 `app.asar` 且不依赖本机 Node/额外原生模块。桌面歌词 helper 只在设置启用且其他隐藏条件未满足时运行，灵动岛实例仅在启用岛且外部全屏隐藏偏好开启时运行；普通/高效模式为 100/300ms，每次只允许一个待回应采样，初始化/响应期限分别 10/2 秒。
- 关闭选项、窗口或退出会停止采样、写入 EXIT 并关闭 stdin；超出 1.5 秒只终止本服务创建的 helper，3 秒仍未退出则明确返回清理失败并保留自有句柄供重试，不伪报退出；旧 helper 未结束前不创建第二个。检测错误立即失效旧全屏快照、保持歌词可见并提示，重开选项可重试；旧实例迟到输出不能修改新实例状态。未启用此选项及非 Windows 平台不创建进程。隐藏使用 Node `windowsHide:true`，不叠加会阻塞 GUI 父进程启动的 PowerShell `-WindowStyle Hidden`。
- 原生 API 行为参考：[GetClientRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclientrect)、[ClientToScreen](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clienttoscreen)、[GetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow)、[Electron screen](https://www.electronjs.org/docs/latest/api/screen)。

- 安装协作端点为 `\\.\pipe\BetterKuGou.InstallQuit.v1.<PID>`，默认用户权限，不开启全用户读写。短 ASCII 行协议仅支持 `HELLO/1`、`QUIT/1`，回复 `READY/1`、`SAVED/1` 或固定失败码；能力握手限 1 秒，保存准备限 10 秒，安装器等待实际进程退出限 30 秒。只允许一个保存请求；当前随机 requestId 的一次回执有效，断开/超时/停止先失效再通知取消，停止不等待回执。SAVED 不代表文件可覆盖，安装器另查真实进程退出。

- 停止尚未完成时不创建第二个后端实例；重复停止共享同一任务。
- 正常退出清理停止超时及临时退出监听，关闭中的网络回调不能再报告连接成功。
- 就绪成功、启动期限到达、进程错误、退出及停止均解除等待并清理启动/重试定时器和探测请求；启动期限之后不再自动重试。
- 进程回调核对实例身份，旧进程的延迟退出不清除新实例和新定时器。
- 强制清理失败会拒绝停止任务并保留进程状态，允许重试；非 Windows 的 `ESRCH` 表示目标已退出。
- 后端随 Electron 生命周期运行，不依赖系统 Node.js，不留下应用退出后的端口监听。
- 更新 Worker 按请求身份隔离迟到响应；异常使当前任务可见失败，后续请求可重建 Worker，不能阻止窗口、播放或本地 API 启动。退出共享同一停止 Promise，取消网络和文件流，等待 Worker 清理，超过宽限后结束线程。

## 验证

项目根目录的 `npm test` 包含后端立即探测、连接失败/503 重试、共享就绪等待、启动期限、启动中退出、真实临时本地 HTTP、定时器/请求释放、并发停止及跨平台强制退出，以及更新双源、版本/资产筛选、完整性、调度、取消和 Worker 清理回归；`npm run check` 检查源码。修改真实进程行为后需实际验证 Electron 启停、更新期间的界面响应及端口释放。
