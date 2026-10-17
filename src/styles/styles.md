# styles 速查

## 职责

维护跨页面全局样式；本目录没有子目录。

## 直接文件

- `index.css`：按变量、reset、工具类、组件样式的顺序统一导入。
- `variables.css`：固定窗口布局尺寸与层级；视觉参数统一来自 `themes/` 主题包。
- `reset.css`：全局基础元素重置。
- `mixins.css`：布局、文本与间距等复用工具类。
- `components.css`：按钮等共享组件样式与 loading-spinner。
- `motion.css`：原生交互控件的悬停、焦点、按压及滑块反馈，统一 ui-fade/ui-pop/ui-list 过渡与全局减少动态效果保护。
- `README.md`：既有样式说明，作为补充参考保留。

## 流程与保障

- `src/main.js` 只导入全局入口，避免散落的重复样式引入。
- 主题管理器在 documentElement 设置 CSS 变量，组件沿同一变量体系取值。
- 高级主题 CSS 经共享 AST 校验与作用域编译后由 themeManager 管理唯一 style；区域编辑沿同一 CSS 文本，覆盖页面 scoped 样式，恢复/编辑入口被排除。既有窗口结构令牌仍在 variables.css，用户可通过区域或高级 CSS 调整已存在元素的布局。
- 视觉变量白名单与默认值以 `themes/default-dark.json` 为准，格式、分享和制作说明见 [themes.md](../themes/themes.md)。
- 页面专用样式保留 scoped，不在全局入口堆积单页选择器。
- 公共加载状态使用 CSS spinner，应用 Logo 由 public 维护。
- 共享过渡使用独立 translate/scale 保留组件 transform；ui-list 的 move 使用 Vue FLIP。只有显式 ui-list-container 容器启用绝对离场，网格离场由页面冻结原坐标与尺寸。scoped 控件显式 transition 清单必须包含 scale，系统减少动态效果时清除位移并缩短全部 CSS 过渡。

## 运行

项目启动、构建和视觉验证说明见 [BK.md](../../BK.md)。
