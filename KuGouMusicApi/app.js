#!/usr/bin/env node
const parentPort = process.parentPort;
const ownerPid = Number(process.env.BK_BACKEND_PARENT_PID);
const managed = Boolean(parentPort && Number.isSafeInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid);

/** 主进程崩溃时释放 API 端口。父进程探测只检查存活，退出信号只发送给自身。 */
function exitIfOwnerIsGone() {
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') process.kill(process.pid, 'SIGTERM');
    else if (error.code !== 'EPERM') console.error('[API owner check]', error);
  }
}

if (managed) {
  exitIfOwnerIsGone();
  setInterval(exitIfOwnerIsGone, 250).unref();
}

// 仅在本进程完成绑定后通知父进程，避免旧监听者的 HTTP 响应冒充新服务。
require('./server').startService({
  retryBind: managed,
  onBindConflict: managed ? () => parentPort.postMessage('backend:waiting-for-port') : undefined,
})
  .then(() => { if (managed) parentPort.postMessage('backend:listening'); })
  .catch((error) => {
    console.error('[API startup]', error);
    if (managed && error.code === 'EADDRINUSE') parentPort.postMessage('backend:port-in-use');
    process.exitCode = 1;
  });
