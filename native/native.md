# Native

原生模块为 Electron 提供需要直接调用本地 ABI 的隔离辅助进程，不在 Electron 主进程加载第三方音频插件。

- `audio-effects/`：VST3 扫描、全局效果链、独立编辑器窗口和实际播放音频的固定速度 BPM 估计。见 [audio-effects.md](audio-effects/audio-effects.md)。

构建由项目根目录 `scripts/build-audio-effects.cjs` 驱动；下载依赖和编译缓存位于被忽略的 `.cache/audio-effects/`，平台产物位于模块自身被忽略的 `bin/`。
