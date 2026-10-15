# 样式系统文档

## 目录结构

- variables.css: 定义所有CSS变量
- components.css: 通用组件样式
- reset.css: 基础元素重置
- mixins.css: 布局、文本、圆角、阴影及过渡工具类
- index.css: 样式入口文件

## 使用方法
在需要使用CSS变量的组件中，可以直接引用定义的变量:
```css
.my-component {
  background-color: var(--color-primary);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
}
```

## CSS变量列表

### 颜色系统

#### 主色调

| 变量名 | 值 | 描述 | 应用组件 |
| --------|-----|------|---------|
| --color-primary | #377db6 | 全局主色调 | 按钮、链接、进度条等 |
| --color-primary-hover | #3b55e4 | 主色调悬停状态 | 按钮悬停、链接悬停等 |
| --color-primary-active | #f75050 | 主色调激活状态 | 按钮按下、激活状态元素 |

#### 功能性颜色

| 变量名 | 值 | 描述 | 应用组件 |
|--------|-----|------|---------|
| --color-success | #52c41a | 成功状态颜色 | 成功提示、成功按钮等 |
| --color-warning | #faad14 | 警告状态颜色 | 警告提示、警告按钮等 |
| --color-error | #ff4d4f | 错误状态颜色 | 错误提示、错误按钮等 |
| --color-info | #1890ff | 信息状态颜色 | 信息提示、信息按钮等 |

#### 中性色
| 变量名 | 值 | 描述 | 应用组件 |
|--------|-----|------|---------|
| --color-text | #ffffff | 主要文本颜色 | 大部分文本内容 |
| --color-text-secondary | #a0a0a0 | 次要文本颜色 | 次要信息、描述文字 |
| --color-text-tertiary | #707070 | 第三级文本颜色 | 占位符、辅助说明 |
| --color-border | #404040 | 边框基础颜色 | 输入框、表格、分割线等 |
| --color-border-light | #505050 | 分割线颜色 | 分割线、边框等 |
| --color-background | #1a1a1a | 背景基础颜色 | 页面背景、容器背景 |
| --color-background-light | #2c2c2c | 浅背景颜色 | 卡片、面板背景 |

### 间距系统
| 变量名 | 值 | 描述 | 应用组件 |
|--------|-----|------|---------|
| --spacing-xs | 4px | 超小间距 | 小元素间距离 |
| --spacing-sm | 8px | 小间距 | 按钮内边距、小元素间距 |
| --spacing-md | 16px | 中等间距 | 模块内边距、常规间距 |
| --spacing-lg | 24px | 大间距 | 模块间距离 |
| --spacing-xl | 32px | 超大间距 | 大模块间距 |

### 字体系统
| 变量名 | 值 | 描述 | 应用组件 |
|--------|-----|------|---------|
| --font-size-xs | 12px | 超小字体 | 特殊小字标注 |
| --font-size-sm | 14px | 小字体 | 辅助说明文字 |
| --font-size-base | 16px | 基础字体 | 默认正文大小 |
| --font-size-lg | 18px | 中等字体 | 标题、重要信息 |
| --font-size-xl | 20px | 大字体 | 主标题 |

### 圆角系统
| 变量名 | 值 | 描述 | 应用组件 |
|--------|-----|------|---------|
| --radius-sm | 4px | 小圆角 | 按钮、输入框等 |
| --radius-md | 8px | 中等圆角 | 卡片、面板等 |
| --radius-lg | 12px | 大圆角 | 模块容器等 |

### 阴影系统
| 变量名 | 值 | 描述 | 应用组件 |
|--------|-----|------|---------|
| --shadow-menu | 0 4px 20px var(--shadow-dark) | 基础阴影 | 弹窗、下拉菜单等 |
| --shadow-md | 0 4px 6px rgba(0, 0, 0, 0.2) | 卡片阴影 | 卡片组件 |

### 过渡动画
| 变量名 | 值 | 描述 | 应用组件 |
|--------|-----|------|---------|
| --transition-base | 250ms cubic-bezier(0.4, 0, 0.2, 1) | 过渡动画时长 | 所有交互动画 |
| --transition-fast | 150ms cubic-bezier(0.4, 0, 0.2, 1) | 过渡动画曲线 | 所有交互动画 |

## 工具类

视觉变量名称与默认值见 [default-dark.json](../themes/default-dark.json)，主题管理器按设置应用完整主题包；[variables.css](./variables.css) 只保留结构尺寸与层级，导入关系见 [styles.md](./styles.md)。

### 文本对齐
- .text-left: 左对齐
- .text-center: 居中对齐
- .text-right: 右对齐

### 布局与外观工具类
- .flex、.flex-center、.flex-between、.flex-column：常用布局
- .rounded-sm、.rounded-md、.rounded-lg、.rounded-full：圆角
- .shadow-sm、.shadow-md、.shadow-lg：阴影
- .transition、.transition-fast、.transition-slow：过渡
- .hidden、.invisible、.text-ellipsis：可见性与文本省略

示例:
```html
<div class="flex-center text-center">居中内容</div>
```

## 通用组件样式

### 按钮 (Button)
默认样式包含:
- 基础背景色: var(--color-primary)
- 悬停背景色: var(--color-primary-hover)
- 激活背景色: var(--color-primary-active)
- 圆角: var(--radius-sm)
- 内边距: var(--spacing-sm) var(--spacing-md)

### 输入框 (Input)
默认样式包含:
- 边框颜色: var(--color-border)
- 悬停边框颜色: var(--color-primary)
- 焦点边框颜色: var(--color-primary)
- 圆角: var(--radius-sm)
- 内边距: var(--spacing-sm)

### 卡片 (Card)
默认样式包含:
- 背景色: var(--color-background-light)
- 圆角: var(--radius-lg)
- 阴影: var(--shadow-md)
- 内边距: var(--spacing-lg)

## 自定义主题
在“设置 → 自定义功能 → 主题与配色”切换、导入或导出独立 JSON 主题包。主题包可以定义配色、字体、圆角、间距、阴影、图标滤镜和全屏歌词颜色，导出文件可直接分享给其他用户。

格式与变量说明见 [主题包文档](../themes/themes.md)，可直接导入 [松林夜色示例](../themes/example.bk-theme.json)。页面 CSS 继续通过 `var(--color-primary)` 等变量引用主题参数。
