# 项目脚本速查

## 职责与文件

当前目录没有子目录，保存需要长期维护的项目检查工具。一次性探针和调试脚本放 `.agent/tools/`。

- `check.cjs`：从项目根目录扫描 `src/`、`electron/`、`scripts/`、`tests/`，并检查 Vite 配置和本地 API 的应用/服务入口。
- `generate-installer-assets.ps1`：在 Windows PowerShell 7 使用现有公共 Logo 生成两份适配暖白/暖炭品牌栏的 NSIS BMP 和 DMG 1×/2× PNG，支持 `-WindowsOnly` 仅更新 NSIS 资源；打包直接读取已提交资源，其他平台无需执行此工具。
- `generate-installer-motion.cjs`：使用纯 Node 绘制音乐波形与完成勾形，编码为 Windows 原生动画控件支持的单视频流、无声、固定调色板 RLE8 AVI；输出深浅色及 96/120/144/192 DPI 资源，不依赖外部编码器。

## 检查流程与保障

`npm run check` → 遍历 JavaScript、Vue 和 HTML → 使用现有 Vue 编译器解析语法 → 检查重复对象成员及相对文件引用 → 输出诊断或设置失败退出码。

- Vue 文件检查内联脚本、外置脚本与样式引用；HTML 检查内联脚本。
- 本地引用按当前模块路径解析，支持现有 JavaScript/Vue 文件及目录入口形式。
- 检查只读取源码，不修改格式、生成代码或覆盖用户文件。
- 渲染业务日志必须经过统一 logger，检查会拒绝绕过过滤和脱敏的 console 调用。
- 该工具检查语法、重复成员、本地引用与渲染日志入口；不宣称替代完整 ESLint、类型分析、构建或运行验证。

## 验证命令

项目根目录的 `npm run check` 已验证。自动化行为回归使用 `npm test`，构建验证使用 `npm run build`，三者职责互补。

`node scripts/generate-installer-motion.cjs` 已验证，可重新生成 `installer/assets/` 的 16 份 AVI；构建直接使用提交资源，无需运行生成器。
