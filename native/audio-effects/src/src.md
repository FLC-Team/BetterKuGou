# Native audio source

此目录实现原生辅助进程，通过父目录 CMake 构建；无子目录。对外协议与构建入口见 [audio-effects.md](../audio-effects.md)。

- `main.cpp`：命令行扫描/宿主/echo/self-test 模式；独占输出协议；有界线程队列；效果链复用、聚合延迟/尾音、ProcessContext、保存前参数屏障和管道断开的强制退出兜底。
- `plugin.h` / `plugin.cpp`：VST3 component/controller 初始化和消息连接、立体声总线、精度协商、参数队列/零样本提交、状态 base64、原生 view/frame 与多实例窗口生命周期。
- `platform.h`：平台窗口和事件泵抽象。
- `platform_win.cpp`：COM、HWND、Windows 消息泵；显式 SWP_SHOWWINDOW 不受子进程 windowsHide 的首次 ShowWindow 行为影响。
- `platform_mac.mm`：Cocoa NSWindow/NSView 与应用事件泵。
- `platform_linux.cpp`：X11 窗口和 VST3 Linux IRunLoop 的文件描述符/定时器回调；支持 XWayland。
- `tempo.h` / `tempo.cpp`：有界 PCM overlap、KISS FFT 谱通量、滚动自相关、稳定性/置信度事件及多采样率固定速度/静音自测。

状态/GUI/插件创建必须由主线程完成；处理只能在稳定链上执行。插件处理输出必须是有限 float，处理失败让上层监督器退回干声。插件 stdout 不能写入协议通道。任何 SDK 对象/窗口必须在其所属线程和模块卸载前释放。状态重新配置不得覆盖已存在实例的实时编辑。
