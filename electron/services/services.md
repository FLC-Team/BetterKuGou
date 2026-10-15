# 主进程服务速查

## 职责与文件

当前目录没有子目录，承载由 Electron 主入口调用的独立生命周期服务。

- `backendService.js`：创建并管理本地酷狗 API Utility Process，处理启动、健康检查、状态通知及退出清理。

## 核心函数与数据流

- `createBackendService(options)`：接收开发/生产路径、进度及状态回调、退出状态查询，返回独立服务实例。
- `start()`：开发时加载项目内 `KuGouMusicApi/app.js`，生产时加载 `resources/backend/app.js`，通过 `utilityProcess.fork()` 启动并固定 `HOST=localhost`、端口 `6500`。
- `checkHealth()`：取消旧检查，再对当前实例的根路由发起限时 HTTP 请求；只有 2xx 响应报告 `connected`。
- `stop()`：复用正在执行的停止 Promise，取消健康请求及启动/检查定时器，等待进程退出；超时后 Windows 使用 `taskkill /T /F`，其他平台发送 `SIGKILL`。
- `isRunning()`：报告当前是否仍持有后端进程实例。

主入口启动服务 → Utility Process 启动 API → 健康检查广播状态 → 主入口退出时等待 `stop()`。

## 生命周期保障

- 停止尚未完成时不创建第二个后端实例；重复停止共享同一任务。
- 正常退出清理停止超时及临时退出监听，关闭中的网络回调不能再报告连接成功。
- 进程回调核对实例身份，旧进程的延迟退出不清除新实例和新定时器。
- 强制清理失败会拒绝停止任务并保留进程状态，允许重试；非 Windows 的 `ESRCH` 表示目标已退出。
- 后端随 Electron 生命周期运行，不依赖系统 Node.js，不留下应用退出后的端口监听。

## 验证

项目根目录的 `npm test` 包含本服务的定时器、并发停止、健康请求及跨平台强制退出回归；`npm run check` 检查源码。修改真实进程行为后需实际验证 Electron 启停与端口释放。
