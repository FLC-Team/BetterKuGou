# Audio effects native host

独立 C++17 辅助进程，通过 VST3 SDK 加载本机已安装、架构匹配的效果器。Electron 主进程只负责启动/监督，插件崩溃或卡住不会把插件代码带入 Electron 进程。一个宿主管理整条立体声效果链，每个实例可以打开独立原生窗口。

## 目录与文件

- `src/`：协议、插件生命周期、平台窗口和流式 BPM 算法；见 [src.md](src/src.md)。
- `tests/`：Node 原生协议/真实插件集成验证及实时速率长时间运行工具。
- `bin/`：忽略的 `${platform}-${arch}/bk-audio-host[.exe]` 与第三方许可证，供开发及打包读取。
- `CMakeLists.txt`：SDK hosting 库、KISS FFT、平台实现与静态 Windows CRT 构建。
- `.gitignore`：原生产物排除规则。

## 依赖和构建

构建脚本固定并核验 Git commit：VST3 SDK `v3.8.1_build_84`（MIT）、KISS FFT `131.2.0`（BSD-3-Clause）、nlohmann/json `v3.11.3`（MIT）。不安装系统组件；依赖源代码在根 `.cache/audio-effects/deps/`。发行目录的 `THIRD_PARTY_NOTICES.txt` 包含实际版权声明与许可证。

macOS 在根 CMake 的 `project()` 后、载入 SDK 子目录前启用 Objective-C++，使 SDK 自身的 `.mm` 目标与宿主共同继承编译规则；原生窗口及 SDK 模块仍使用 ARC 和 Cocoa。Windows/Linux 仅启用各自所需语言。

运行需要与宿主同架构的 VST3。构建需要 Git、Node、CMake 3.25+ 和 C++17 工具链。Windows 使用 Visual Studio C++ 与 Windows SDK；macOS 使用 Xcode/Clang/Cocoa；Linux 使用 C++ 编译器和 X11 开发库，窗口要求 X11 或 XWayland。原生 Wayland 不在首版支持范围。

项目根目录已验证的构建/检查入口：

```text
node scripts/build-audio-effects.cjs
node --test native/audio-effects/tests/host.test.cjs
```

可用 `--arch=x64|ia32|arm64` 指定受支持平台目标。Windows 默认 Visual Studio generator 自动选择目标架构；设置 `BK_NATIVE_GENERATOR=Ninja` 时必须使用匹配的编译器开发环境，所有目标均必须通过 `VSCMD_ARG_TGT_ARCH` 校验（x86 对应 ia32）。`CMAKE` 可指定 CMake 可执行文件。macOS 支持 x64/arm64；Linux 要在同架构 runner 构建。非当前架构不在构建机上执行自测。

Windows 的 MSVC 与全部 SDK 静态库统一使用静态 CRT，宿主本身不依赖外置 VCRUNTIME/MSVCP。插件自身依赖仍由插件安装负责。本机已验证 Windows x64 构建和运行；macOS、Linux、Windows ia32/arm64 需要对应平台运行验证。

## 协议

`--scan PATH` 在独立扫描进程输出 JSON 数组；同模块不同 AudioEffect ClassID 分别返回，Instrument 子类别标为 `isEffect:false`。仅完成模块/控制器初始化并检测是否存在编辑器；这不代表授权有效或声音一定可用。

`--host` / `--echo` 的 stdin/stdout 是二进制帧：小端 uint32 JSON 字节数、小端 uint32 PCM 字节数、UTF-8 JSON、planar float32 PCM。JSON 上限 32 MiB，PCM 上限 1 MiB。插件 stdout 被重定向 stderr，协议独占原始 stdout。

控制请求 `{id,command,...}` 返回 `{id,ok,result,error}`。命令包括 `configure`、`openEditor`、`closeEditor`、`setBypass`、`getState`、`setState`、`getParameters`、`setParameter`、`flush`、`transport`、`shutdown`。处理音频块为 `{type:'audio',generation,sequence,frames,sampleRate,channels:2,tempo,tempoValid,position,playing}` 和 PCM；响应保留标识并附 `latencySamples`。`position` 单位为秒。

`configure` 接收 sampleRate、maxBlockSize 和最多 64 个 `{instanceId,path,classId,bypassed,state}`。相同 identity/path/ClassID 复用实例与窗口；只在新实例创建时恢复随配置传入的 state，防止重新连接覆盖实时旋钮。状态是 component/controller 两个 base64 字符串；合计原始状态不超过 23 MiB，确保封装后小于 JSON 帧上限。超限明确返回未保存错误。

`status` 事件包含整链 `latencySamples` 和 `tailSamples`，有效实例串联保守累加；无限尾音用 -1。`editor` 事件含 instanceId/open，`parameters` 事件含变化或 invalidated，`tempo` 事件含 trackId/generation/bpm/confidence/status/algorithmVersion。GUI 配置暂占用链时音频回复 `bypassed:true`，保持最后稳定延迟；调用方只确认该块并回退干声，不能把它当有效 wet 音频。

## 线程和保障

主线程承担插件/控制器创建、状态和窗口生命周期；音频处理、BPM 分析、协议读取与写出分别使用后台线程。队列有上限；音频线程不会等待 GUI 链互斥锁。参数通过有界原子队列传送，控制器/处理器后台消息转发到 GUI 线程。aux 音频总线和 MIDI 事件总线禁用，主输入/输出必须是立体声。优先 float32，不支持时协商 float64 并转换。

暂停时后台处理线程用零样本 VST3 参数 flush 提交待处理参数；`getState` 先等待该线程的屏障确认，不能把音频 process 移到 GUI 线程。读管道 EOF 或写管道断开后启动 2 秒退出看门狗，即使插件 process/terminate 永久挂住也不会留下失去监督的孤儿进程。正常停止仍优先释放插件和窗口；写线程完成关闭回执后只刷新独立协议流再退出，不能全局刷新仍由读线程阻塞持锁的 stdin。

播放位置/tempo 有效性传入 ProcessContext；音乐位置仅是从歌曲起点按固定速度计算的网格，不能解释为检测到强拍。`transport` 保留插件状态，只有显式 `flush` 重置处理缓冲。编辑器关闭不卸载实例。

BPM 使用实际 sample rate 的约 46 ms Hann/FFT、约 100 Hz 正谱通量、40–240 BPM 自相关和 32 秒滚动包络；先过滤持续音的微小窗口相位波动，至少约 24 秒且连续三次估计稳定才发布 detected。静音不确认 BPM，跳转/曲目/代次改变重置。首版仅固定速度估计，不能保证复杂节奏、弱鼓点、变速曲或半倍/双倍速度选择正确；手动覆盖由上层优先处理。

## 真实插件和长时间验证

`host.test.cjs` 默认验证已构建宿主的 BPM、协议、错误边界及孤儿退出；没有二进制时明确 skip。真实插件测试需显式设置 `BK_AUDIO_TEST_PLUGINS=1`、`BK_TEST_EQ_PLUGIN`（已授权 FabFilter Pro-Q 4）、`BK_TEST_SERUM_PLUGIN`（Serum 2 模块路径），然后运行同一 Node 测试入口。需要有效授权和可访问正常用户插件配置的运行环境，过期试用或受限环境下的静音不能作为宿主处理正确性的验证。真实测试覆盖 Output Level 的声音影响、播放与暂停下状态恢复、实例复用、整链输出、Linear Phase 动态延迟和独立编辑器。

`soak.cjs` 通过合成信号以 48 kHz/512 块实时速度驱动 Serum FX 和分析，不向声卡输出，不读取用户歌曲。设置 `BK_TEST_SERUM_PLUGIN` 后可运行 `node native/audio-effects/tests/soak.cjs`，默认 1800 秒；`BK_SOAK_SECONDS` 可调时间，`BK_TEST_HOST_BINARY` 可指定隔离缓存副本以免阻碍开发重链接。报告块数、旁通块、非有限值、最大往返耗时和 Windows RSS；此脚本的定时器/进程内存查询带来的调度延迟不等于设备音频 underrun。
