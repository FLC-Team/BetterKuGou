# helpers 速查

## 职责与文件

- `noticeHarness.cjs`：向内存 Vue 测试宿主注册真实编译的 `AppNotice`；替代 Fue 外部呈现 API，收集实际通知并渲染其内容和动作。业务模板、消息监听、清理与动作保护继续执行真实代码。
- `animatedSliderHarness.cjs`：将真实的 `AnimatedSlider` 模板与输入事件绑定加载到内存 Vue 测试宿主，供设置与播放器控件测试复用。
- `songTitleHarness.cjs`：编译真实 `SongTitle` 原生按钮、事件仲裁和生命周期，可注入受控计时器；供列表事件及收藏标题回归复用，不复制交互实现。

## 运行与保障

在测试的 `createApp` 后、`mount` 前调用 `registerAppNotice(app)`。通知 API 和序号按应用隔离，不访问系统窗口；计时和 Fue 原生呈现由通知集成测试验证。随项目 `npm test` 运行调用它的测试。
