# 安装品牌资源

本目录保存直接提交并供打包使用的品牌图像和原生动画资源，没有子目录。

- `logo-light.bmp` / `logo-dark.bmp`：128 × 128 的 Windows 安装器 Logo，分别适配暖白柔紫与暖炭品牌背景，页面按 DPI 缩放为 40px 品牌标识，来源为公共 `public/logo.png`。
- `dmg-background.png`：640 × 420 的 macOS DMG 背景，为真实应用及 Applications 图标预留位置，说明首次安装与退出后替换。
- `dmg-background@2x.png`：对应 1280 × 840 Retina 版本，electron-builder 在 macOS 打包时自动合并。
- `install-{light,dark}-{96,120,144,192}.avi`：音乐波形，基准 448 × 76、25fps、50 帧、2 秒循环；颜色匹配安装页面背景，动画与实际进度完全独立。
- `success-{light,dark}-{96,120,144,192}.avi`：基准 80 × 80、25fps、15 帧的勾形揭示；成功只播放一次，减少动态时直接显示最后一帧。两组 AVI 均为单视频流、无音频、固定调色板的 RLE8 关键帧，不需要额外编解码器。

Windows PowerShell 7 下执行 `pwsh -NoProfile -File scripts/generate-installer-assets.ps1` 可重新生成全部图像，附加 `-WindowsOnly` 可仅更新两份 Windows BMP。macOS/Linux 构建直接使用这些已提交文件，不运行生成工具；公共 Logo 的修改须同步重新生成。

在任意有 Node 的平台执行 `node scripts/generate-installer-motion.cjs` 可重生成全部 AVI。Windows 原生控件居中显示但不缩放剪辑，安装器选择不大于当前 DPI 的资源；打包只读取已提交文件。
