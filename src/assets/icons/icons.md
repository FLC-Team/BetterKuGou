# icons 速查

## 职责

渲染进程 SVG 图标目录；本目录没有子目录。

## 直接文件

- `README.md`：既有图标用途与资源约定，分类说明见 [README.md](README.md)。
- `close.svg`、`minimize.svg`、`full_screen_maximize.svg`、`full_screen_minimize.svg`：窗口控制。
- `play.svg`、`stop.svg`、`previous.svg`、`next.svg`、`nextplay.svg`：播放与下一首操作。
- `playlist.svg`、`repeat_all.svg`、`repeat_one.svg`、`shuffle.svg`：队列与播放模式。
- `sound_0.svg` 至 `sound_3.svg`：静音及不同音量状态。
- `kugologo.svg`：现有酷狗图形资源。
- `sidebar-hide.svg`、`sidebar-home.svg`、`sidebar-list.svg`、`sidebar-settings.svg`、`sidebar-favorite.svg`、`sidebar-add.svg`：参考 BetterKuGou 的 Ionicons 侧栏图标。
- `sidebar-icons.LICENSE`：上述 Ionicons 资源的 MIT 许可证。

## 调用与保障

- 使用 JS import 或现有菜单图标接口，不依赖输出目录的固定文件名。
- 图标颜色和尺寸由实际组件布局及主题控制。
- 侧栏 SVG 从参考项目实际使用的图标导出，通过 CSS mask 着色，无需引入图标库运行依赖；分发时保留许可证。
- 应用 Logo 与安装图标继续由 public 维护，不重复创建位图 Logo。
- 删除或替换前核对源码引用，避免产生失效的本地 import。

## 运行

项目构建与资源验证说明见 [BK.md](../../../BK.md)。
