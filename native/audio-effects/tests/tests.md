# Native host tests

- `host.test.cjs`：二进制协议回环、格式拒绝、BPM 自测和显式 opt-in 的真实 EQ/Serum 双实例、参数影响声音、状态恢复、配置复用和窗口开关。
- `soak.cjs`：显式运行的 48 kHz 实时速率持续处理/分析探针，默认 30 分钟，仅生成测试 PCM，不播放声卡。

从项目根执行 `node --test native/audio-effects/tests/host.test.cjs`。真实插件环境变量与长时间验证使用方法见 [audio-effects.md](../audio-effects.md)。集成测试会短暂打开其创建的原生编辑器，结束后关闭并停止测试子进程。没有插件授权不得绕过授权，也不得将静音结果修改成通过。
