# 安装品牌资源

本目录保存直接提交并供打包使用的静态品牌图像，没有子目录。

- `logo-light.bmp` / `logo-dark.bmp`：128 × 128 的 Windows 安装器 Logo，分别适配浅深品牌背景，来源为公共 `public/logo.png`。
- `dmg-background.png`：640 × 420 的 macOS DMG 背景，为真实应用及 Applications 图标预留位置，说明首次安装与退出后替换。
- `dmg-background@2x.png`：对应 1280 × 840 Retina 版本，electron-builder 在 macOS 打包时自动合并。

Windows PowerShell 7 下执行 `pwsh -NoProfile -File scripts/generate-installer-assets.ps1` 可重新生成全部图像。macOS/Linux 构建直接使用这些已提交文件，不运行生成工具；公共 Logo 的修改须同步重新生成。
