# themes 速查与主题包制作

## 职责与文件

主题包是独立的 JSON 数据，定义配色、字体、间距、圆角、阴影、动效、图标滤镜及全屏歌词颜色。本目录没有子目录。

- `default-dark.json`：当前项目经典深色的完整视觉参数，也是变量白名单的来源。
- `default-light.json`：完整浅色参数；两份内置包拥有相同的变量集合。
- `themeCatalog.mjs`：无文件读取副作用的共享目录工厂，校验、补全、序列化和筛选主题；Vue 与 Electron 共用。
- `themePackages.js`：渲染入口，注入内置 JSON 并暴露目录 API。
- `themeAdjustments.js`：全量令牌字段、区域/属性目录、稳定元素选择器与个性主题修改；克隆完整视觉快照，沿目录校验和 50 个安装包上限保存。
- `example.bk-theme.json`：可直接导入的“松林夜色”示例及制作模板。

## 使用与分享

在“设置 → 外观与主题 → 主题与配色”选择主题、导入主题包或导出当前主题。导入后自动应用，同 ID 再导入更新已有包；移除当前包后切回对应的内置深色或浅色。导出前可填写名称与作者，将下载的 `.bk-theme.json` 文件发送给其他用户即可分享。

现有深色、浅色、跟随系统及三色自定义设置继续可用。主题选择和安装列表保存在已有 `custom.theme` / `custom.themePackages` 设置中；桌面端由 Electron 原子持久化，浏览器预览使用现有 LocalStorage。播放器布局选择仍由 `custom.playerStyle` 管理。

## 设置精细调整

设置页按全局配色、字体、间距、圆角、侧栏、标题栏、播放栏、歌词、队列、阴影、渐变、动效和图标分组提供全部 `THEME_TOKEN_NAMES` 的编辑与搜索。颜色支持 rgba 透明度，尺寸以像素输入；每组可恢复当前明暗基色的默认令牌。

“可视化编辑器 / 高级 CSS”在 App 常驻浮动层打开，可跨页面导航后拾取任意元素，也覆盖 Teleport 到 body 的歌词、队列和菜单。选择器以页面或功能根与语义 class/id 组合，按元素类型共享样式，不依赖曲目位置或 Vue 的构建属性。预设区域提供字号、字体、颜色、背景、透明度、边距、尺寸、圆角、阴影、滤镜等可视化输入；写入同一 CSS 文本，留空删除该选择器的对应顶层覆盖。

主窗口和独立桌面歌词分别编辑 `css` / `desktopCss`。高级编辑器支持常用元素、class/id、data/aria 属性、组合、状态伪类、伪元素、`:is/:where/:not`、nth 选择器，以及白名单屏幕尺寸/明暗/动态效果/输入设备 `@media` 和单一视觉属性 `@supports`。不支持 CSS 嵌套、资源导入、外部字体或脚本。区域与高级编辑共享草稿，主窗口预览在 30 秒后自动恢复；取消不写设置，应用后沿原设置存储保存，失败保留草稿。保存期间冻结编辑控件，避免覆盖后续输入。

编辑器外另有位于 body 的 Shadow DOM“外观恢复 / 编辑”入口，排除主题样式；`Ctrl + Alt + Shift + R` 可恢复内置外观。即使 CSS 隐藏应用根或设置页，恢复入口仍可操作；恢复仅切回内置包，保留已安装主题。恢复会先排空设置页已有保存并丢弃主题草稿，防旧坏主题被自动重存；其余偏好草稿保留，保存失败仍保持安全预览并可重试。

第一次调整创建唯一 `personal-*` 包，后续通过 `custom.themeAdjustmentId` 复用。每次从当前已解析的完整主题克隆，保留其他参数和 CSS、桌面 CSS 与原主题；50 个安装包上限只计算用户包。该标识不进入分享包，分享只包含视觉主题清单。

## 文件格式

```json
{
  "format": "betterkugou-theme",
  "schemaVersion": 1,
  "id": "my-theme",
  "name": "我的主题",
  "version": "1.0.0",
  "author": "作者昵称",
  "description": "主题说明",
  "base": "dark",
  "tokens": {
    "--color-primary": "#52b788",
    "--sidebar-radius": "24px"
  },
  "css": ".music-player .song-name { font-size: 18px; }",
  "desktopCss": ".current-lyric { color: var(--lyric-accent); font-size: 30px; }"
}
```

`id` 为小写字母开头的字母、数字、连字符，最长 64 字符；`name` 必填，最长 80 字符。`version` 使用 `1.0.0` 格式；`base` 为 `dark` 或 `light`。作者和说明选填，最长分别为 80、240 字符。内置保留 ID `dark/light/system/auto/custom` 不能用于导入；应用导出内置主题时自动生成可分享 ID。

制作时可只覆盖所需变量，缺项由 base 补全；应用导出的是完整参数快照，不需要发送基础包。全部支持的变量以 `default-dark.json.tokens` 为准，可参考 `--color-*`、`--gradient-*`、`--bg-*`、`--font-*`、`--spacing-*`、`--radius-*`、`--shadow-*`、`--icon-*-filter` 和 `--lyric-*`。

仅改变主色时，需同时调整相关 hover、active、rgb、light、渐变及阴影变量；它们都是独立参数。CSS 可调整已有界面的视觉和布局，分享包不包含业务状态、脚本、系统窗口设置或资源文件。`css` / `desktopCss` 为可选字段，旧 schemaVersion 1 主题仍兼容。

## 数据流与保障

```text
文件/内置清单 → 共享校验目录 → 设置页编辑 → settingsStore → themeManager → 根 CSS 变量
                                  ↓
                           Electron 设置 / LocalStorage
```

- 文件及完整导出 JSON（包括补全令牌与转义）最大 128 KB；每窗规范化 CSS 最大 48 KB，最多 800 个节点、4 层嵌套。最多安装 50 个包；按 ID 去重，损坏包被过滤，选中丢失包时回退经典深色。
- 令牌接受视觉变量白名单；高级 CSS 使用直接运行依赖 PostCSS 8.5.6 解析 AST，再校验节点、选择器、视觉/布局属性、函数、变量引用和条件。拒绝 URL、资源函数、脚本、转义绕过、不支持的 @ 规则和自定义属性写入，递归拒绝原型字段和令牌循环；浏览器再检查 CSS 属性值支持情况。
- 字体大小限定为 8–64px（rem/em 按 16px 换算），普通尺寸上限 120px，完整圆角例外上限 9999px。
- 切换完整重写变量并设置 `data-theme`、`data-theme-base` 和 `color-scheme`；高级规则编译时强制限定 `body[data-bk-theme-root]` 下的元素并排除恢复/编辑层，整份替换或删除唯一 style，避免继承上一个包的样式。
- 导出只包含主题清单，不包含播放会话、账户、快捷键、本机路径或其他设置。
- 跟随系统导出当前实际配色快照；单个主题包不包含自动明暗切换规则。
- 独立桌面歌词保留经典/渐变/简约模式；主进程经同一目录校验所选包的 `desktopCss`，通过既有偏好通道发送已编译的 CSS 与完整令牌。HTML 整份替换，切回内置包时移除；普通偏好广播不闪断已应用样式，异步结果按窗口与代次隔离。启动加载窗口保持独立。

## 验证

根目录执行 `npm run check`、`npm test`、`npm run build`；UI 检查令牌/区域编辑、跨页面与 Teleport 拾取、预览/取消/应用、主题导入导出/切换/重载及恢复入口。基础包回归位于 `tests/theme-packages.test.cjs`；CSS 解析/拒绝/体积、作用域、双窗口分享、区域持久化和应用清理位于 `tests/theme-customization.test.cjs`。
