# views/styles 速查

## 职责

复杂页面的私有 CSS，通过各自 Vue SFC 的 scoped style src 导入。
本目录没有子目录。

## 直接文件

- `ArtistView.css`：歌手资料、分页曲目、专辑及页面布局。
- `FavoriteView.css`：收藏/歌单列表、歌曲状态、局部刷新错误提示和交互布局。
- `SettingsView.css`：设置分组、表单、快捷键及预览布局。

## 设计与保障

- 文件名与对应页面一致，样式作用域由导入的 SFC 提供。
- 颜色、阴影、间距、字体和动效引用主题包的全局 CSS 变量；页面不固定配色。
- 主要按钮文字使用 `--color-on-primary`，设置错误状态使用 `--color-error`，白色控件使用 `--text-white`。
- 卡片、滑块、开关及设置聚焦阴影分别使用 `--shadow-card` / `--shadow-card-soft`、`--shadow-control` / `--shadow-control-hover`、`--shadow-toggle`、`--shadow-settings-focus` / `--shadow-shortcut-focus`。
- 页面专属选择器保持在此目录，不改写全局 reset 或主题定义。
- 调整样式时核对对应页面模板和不同窗口尺寸的表现。

## 运行

启动、构建和视觉验证入口见 [BK.md](../../../BK.md)。
