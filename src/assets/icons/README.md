# 图标资源

本目录只存放渲染进程实际引用的 SVG 图标：

- 窗口：`close.svg`、`minimize.svg`、`full_screen_*.svg`
- 播放：`play.svg`、`stop.svg`、`previous.svg`、`next.svg`、`nextplay.svg`
- 列表与模式：`playlist.svg`、`repeat_all.svg`、`repeat_one.svg`、`shuffle.svg`
- 音量：`sound_0.svg` 至 `sound_3.svg`
- 侧边栏：`sidebar-hide.svg`、`sidebar-home.svg`、`sidebar-list.svg`、`sidebar-settings.svg`、`sidebar-favorite.svg`、`sidebar-add.svg`

侧边栏图标沿用 BetterKuGou 使用的 Ionicons（Xicons 导出资源），版权归 Ionic 所有，按 MIT 许可证分发，详见 `sidebar-icons.LICENSE`。图标以 CSS mask 继承 BK 的主题颜色。

应用 Logo 统一使用 `public/logo.png`；加载状态统一使用 `src/styles/components.css` 中的 `.loading-spinner`，不要再次放入重复 Logo 或大体积加载 GIF。
