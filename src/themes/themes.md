# themes 速查与主题包制作

## 职责与文件

主题包是独立的 JSON 数据，定义配色、字体、间距、圆角、阴影、动效、图标滤镜及全屏歌词颜色。本目录没有子目录。

- `default-dark.json`：当前项目经典深色的完整视觉参数，也是变量白名单的来源。
- `default-light.json`：完整浅色参数；两份内置包拥有相同的变量集合。
- `themeCatalog.mjs`：无文件读取副作用的共享目录工厂，校验、补全、序列化和筛选主题；Vue 与 Electron 共用。
- `themePackages.js`：渲染入口，注入内置 JSON 并暴露目录 API。
- `themeAdjustments.js`：设置精调的字段/范围与主题修改，克隆当前完整视觉快照，沿目录校验和 50 个安装包上限保存。
- `example.bk-theme.json`：可直接导入的“松林夜色”示例及制作模板。

## 使用与分享

在“设置 → 外观与主题 → 主题与配色”选择主题、导入主题包或导出当前主题。导入后自动应用，同 ID 再导入更新已有包；移除当前包后切回对应的内置深色或浅色。导出前可填写名称与作者，将下载的 `.bk-theme.json` 文件发送给其他用户即可分享。

现有深色、浅色、跟随系统及三色自定义设置继续可用。主题选择和安装列表保存在已有 `custom.theme` / `custom.themePackages` 设置中；桌面端由 Electron 原子持久化，浏览器预览使用现有 LocalStorage。播放器布局选择仍由 `custom.playerStyle` 管理。

## 设置精细调整

设置页提供 1 个字体、13 个字号/间距/圆角和 7 个全屏歌词颜色入口，颜色支持 rgba 透明度；只显示已有实际消费的变量，不暴露废弃令牌或假缩放。字号分别控制辅助文字、曲目/表单、正文及不同层级标题，范围直接显示在界面；歌词字号仍沿原有响应式布局策略，不在本轮精调中变更。

第一次调整创建唯一 `personal-*` 包，后续通过 `custom.themeAdjustmentId` 复用。每次从当前已解析的完整主题克隆，保留其余配色、字体、阴影与原主题；50 个安装包上限只计算用户包。恢复默认细节只重置这些可见精调项为对应明暗主题默认值，其他视觉参数保留。该标识不进入分享包，分享仍只包含标准主题清单。

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
  }
}
```

`id` 为小写字母开头的字母、数字、连字符，最长 64 字符；`name` 必填，最长 80 字符。`version` 使用 `1.0.0` 格式；`base` 为 `dark` 或 `light`。作者和说明选填，最长分别为 80、240 字符。内置保留 ID `dark/light/system/auto/custom` 不能用于导入；应用导出内置主题时自动生成可分享 ID。

制作时可只覆盖所需变量，缺项由 base 补全；应用导出的是完整参数快照，不需要发送基础包。全部支持的变量以 `default-dark.json.tokens` 为准，可参考 `--color-*`、`--gradient-*`、`--bg-*`、`--font-*`、`--spacing-*`、`--radius-*`、`--shadow-*`、`--icon-*-filter` 和 `--lyric-*`。

仅改变主色时，需同时调整相关 hover、active、rgb、light、渐变及阴影变量；它们都是独立参数。主题包不修改布局结构、窗口尺寸、业务组件或应用 Logo。

## 数据流与保障

```text
文件/内置清单 → 共享校验目录 → 设置页编辑 → settingsStore → themeManager → 根 CSS 变量
                                  ↓
                           Electron 设置 / LocalStorage
```

- 文件最大 128 KB，最多安装 50 个包；按 ID 去重，损坏包被过滤，选中丢失包时回退经典深色。
- 只接受白名单视觉变量；不加载脚本、任意 CSS、URL、图片或外部字体资源，递归拒绝原型字段和变量循环。
- 字体大小限定为 8–64px（rem/em 按 16px 换算），普通尺寸上限 120px，完整圆角例外上限 9999px。
- 切换完整重写变量并设置 `data-theme`、`data-theme-base` 和 `color-scheme`，避免继承上一个包的样式。
- 导出只包含主题清单，不包含播放会话、账户、快捷键、本机路径或其他设置。
- 跟随系统导出当前实际配色快照；单个主题包不包含自动明暗切换规则。
- 独立桌面歌词 HTML 保留其经典/渐变/简约显示模式，启动加载窗口也独立于 Vue 主题；包控制主窗口与全屏歌词。

## 验证

根目录执行 `npm run check`、`npm test`、`npm run build`；UI 检查主题切换、示例文件导入、导出再导入、移除和刷新恢复。包格式与监听回归位于 `tests/theme-packages.test.cjs`。
