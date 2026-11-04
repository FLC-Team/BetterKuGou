# helpers 速查

## 职责与文件

- `noticeHarness.cjs`：向内存 Vue 测试宿主注册真实编译的 `AppNotice`；替代 Fue 外部呈现 API，收集实际通知并渲染其内容和动作。业务模板、消息监听、清理与动作保护继续执行真实代码。

## 运行与保障

在测试的 `createApp` 后、`mount` 前调用 `registerAppNotice(app)`。通知 API 和序号按应用隔离，不访问系统窗口；计时和 Fue 原生呈现由通知集成测试验证。随项目 `npm test` 运行调用它的测试。
