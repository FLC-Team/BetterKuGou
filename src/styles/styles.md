# styles 速查

## 职责

维护跨页面全局样式；本目录没有子目录。

## 直接文件

- `index.css`：按变量、reset、工具类、组件样式的顺序统一导入。
- `variables.css`：固定窗口布局尺寸与层级；视觉参数统一来自 `themes/` 主题包。
- `reset.css`：全局基础元素重置。
- `mixins.css`：布局、文本与间距等复用工具类。
- `components.css`：按钮等共享组件样式与 loading-spinner。
- `README.md`：既有样式说明，作为补充参考保留。

## 流程与保障

- `src/main.js` 只导入全局入口，避免散落的重复样式引入。
- 主题管理器在 documentElement 设置 CSS 变量，组件沿同一变量体系取值。
- 视觉变量白名单与默认值以 `themes/default-dark.json` 为准，格式、分享和制作说明见 [themes.md](../themes/themes.md)。
- 页面专用样式保留 scoped，不在全局入口堆积单页选择器。
- 公共加载状态使用 CSS spinner，应用 Logo 由 public 维护。

## 运行

项目启动、构建和视觉验证说明见 [BK.md](../../BK.md)。
