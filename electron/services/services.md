# 主进程服务速查

## 职责与文件

当前目录没有子目录，承载由 Electron 主入口调用的独立生命周期服务。

- `backendService.js`：创建并管理本地酷狗 API Utility Process，处理启动、健康检查、状态通知及退出清理。
- `updateService.js`：调度应用更新 Worker、已提交更新策略、状态与进度广播、任务去重、取消及退出清理；保留安装包私有路径供主进程复核。
- `updateWorker.cjs`：独立 Node Worker，负责固定仓库发布分页、SemVer/平台架构筛选、双源网络请求、流式下载和文件校验；仅使用 Node 内置模块，随 extraResources 发布。
- `installQuitService.js`：Windows 安装退出协作，使用 Node 内置 net 和每 PID 命名管道承载固定能力探测、保存退出协议，不启动旧版 exe 或强制结束进程。

## 核心函数与数据流

- `createBackendService(options)`：接收开发/生产路径、进度及状态回调、退出状态查询，返回独立服务实例。
- `start()`：开发时加载项目内 `KuGouMusicApi/app.js`，生产时加载 `resources/backend/app.js`，通过 `utilityProcess.fork()` 启动并固定 `HOST=localhost`、端口 `6500`，随后立即探测 HTTP 就绪状态。
- `waitUntilReady()`：同次启动共享就绪 Promise，首次 2xx 响应完成 `true`；未启动、启动失败、10 秒期限到达、进程退出或停止时完成 `false`，不会无限阻塞渲染入口。
- `checkHealth()`：取消旧检查，立即对当前实例的根路由发起限时 HTTP 请求；启动期连接失败或非 2xx 响应每 100 毫秒重试，统一受启动期限限制，只有 2xx 响应报告 `connected`。日志中的端口或进程创建本身不代表 HTTP 已就绪。
- `stop()`：复用正在执行的停止 Promise，取消健康请求及启动/检查定时器，等待进程退出；超时后 Windows 使用 `taskkill /T /F`，其他平台发送 `SIGKILL`。
- `isRunning()`：报告当前是否仍持有后端进程实例。

主入口启动服务并创建窗口 → Utility Process 启动 API → 首次成功 HTTP 探测解除渲染初始化等待并广播状态 → 主入口退出时等待 `stop()`。

### 应用更新

- `createUpdateService(options)` 接收 Worker 路径、专用下载目录、实际版本、平台架构和状态回调；`configure()` 只消费已提交的 `software.updates`，默认自动检查开启、自动下载关闭、正式版 stable，测试版使用 beta。首次启动延迟 10 秒检查，此后每 24 小时检查；普通设置广播不重置计划。
- `check()` / `download(assetId)` 立即返回状态，任务在 Worker 中进行；`getState()` 返回带递增 revision 的展示快照，发布下载 URL 和本机路径保持私有，进度节流后广播。检查与下载共享单任务；`cancel()` 立即失效旧任务，取消的版本在本次会话不再自动重下，但允许用户手动重试。
- Worker 分页请求固定 `FLC-Team/BetterKuGou/releases`，元数据先使用 `https://git.tangbai.cc/https://api.github.com/repos/FLC-Team/BetterKuGou/releases`，失败再从 GitHub 原站重新分页。按 SemVer 选择高于安装版本的最新版本；stable 同时排除 GitHub prerelease 标记与版本预发布后缀，beta 包含正式与预发布。
- Windows 匹配通用或当前架构 setup.exe，macOS 匹配当前架构 DMG，Linux 优先同架构 AppImage，也允许同架构 DEB/RPM。无匹配包仍返回版本说明，禁止把未知架构误当作当前架构。
- 下载单独优先代理资产 URL，网络、超时或完整性失败后从头尝试 GitHub 一次；用户取消与磁盘错误不换源。只允许固定仓库的 HTTPS 地址和受限重定向主机，文件名和路径必须落在专用目录。
- 在 `userData/updates/` 使用唯一 `.part` 临时文件流式写入，核对发布大小并计算 SHA256，有发布 digest 时必须匹配。发布 digest 可校验的完整缓存可复用；无发布 digest 时仍计算本次摘要供后续复核，不复用无法验证来源的同大小缓存。失败或取消清理临时文件。
- `getDownloadedFile()` 在 Worker 中重验大小和 SHA256，主进程据此执行定位或明确确认后的打开；Worker 没有安装命令。切换渠道取消旧任务并丢弃候选状态，进程内状态及取消记录不持久化。

已提交设置 → updateService 调度 → updateWorker 检查/下载/校验 → 带 revision 的主窗口展示状态；用户确认安装 → Worker 再次复核 → 主进程打开同一安装包。

## 生命周期保障

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
