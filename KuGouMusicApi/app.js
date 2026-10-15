#!/usr/bin/env node
// 服务构建失败时保留错误上下文，通知父进程而不是产生未处理的 Promise 拒绝。
require('./server').startService().catch((error) => {
  console.error('[API startup]', error);
  process.exitCode = 1;
});
