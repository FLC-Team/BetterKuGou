# 项目脚本速查

## 职责与文件

当前目录没有子目录，保存需要长期维护的项目检查工具。一次性探针和调试脚本放 `.agent/tools/`。

- `check.cjs`：从项目根目录扫描 `src/`、`electron/`、`scripts/`、`tests/`，并检查 Vite 配置和本地 API 的应用/服务入口。
- `build-fue-vendor.mjs`：读取指定 Fue 0.1.0 源码，用现有 Vite 构建本地分发；仅扩展 Message 的函数式内容及声明以支持动作，完整保留原气泡与进度/动画。外部源码只读，暂存产物放 `.agent/tools/fue-package`，打包步骤见 `vendor/vendor.md`。
- `build-audio-effects.cjs`：获取并核对固定提交的 VST3 SDK、KISS FFT 与 JSON 依赖，使用 CMake 编译目标平台/架构宿主并生成第三方许可；本机架构构建后运行原生自检。依赖及编译缓存位于 `.cache/audio-effects/`，支持 `CMAKE` 与 `BK_NATIVE_GENERATOR` 指定现有工具链。
- `prepare-audio-effects.cjs`：electron-builder beforePack 钩子，构建目标架构并只将对应宿主/许可放入分发暂存目录；二进制及 Worker 通过 extraResources 放在 ASAR 外。
- `prepare-windows-nsis.cjs` 为 Windows 安装打包下载并校验官方 NSIS 3.12 工具包，缓存到 `.cache/nsis/3.12/`，同时兼容锁定版 electron-builder 的目录约定。
- `generate-installer-assets.ps1`：在 Windows PowerShell 7 使用现有公共 Logo 生成两份适配暖白/暖炭品牌栏的 NSIS BMP 和 DMG 1×/2× PNG，支持 `-WindowsOnly` 仅更新 NSIS 资源；打包直接读取已提交资源，其他平台无需执行此工具。
- `generate-installer-motion.cjs`：使用纯 Node 绘制音乐波形与完成勾形，编码为 Windows 原生动画控件支持的单视频流、无声、固定调色板 RLE8 AVI；输出深浅色及 96/120/144/192 DPI 资源，不依赖外部编码器。
- `publish-release.cjs` 核对发布标签与 `package.json` 版本及三平台的完整安装包。发布任务使用 GitHub CLI 建立草稿，验证远端文件的大小和 SHA-256 后才公开；重试只给一致的草稿补齐文件，保留已公开发布。

## 检查流程与保障

`npm run check` → 遍历 JavaScript、Vue 和 HTML → 使用现有 Vue 编译器解析语法 → 检查重复对象成员及相对文件引用 → 输出诊断或设置失败退出码。

- Vue 文件检查内联脚本、外置脚本与样式引用；HTML 检查内联脚本。
- 本地引用按当前模块路径解析，支持现有 JavaScript/Vue 文件及目录入口形式。
- 检查只读取源码，不修改格式、生成代码或覆盖用户文件。
- 渲染业务日志必须经过统一 logger，检查会拒绝绕过过滤和脱敏的 console 调用。
- 渲染消息必须使用 `AppNotice` 接入原版 Fue 通知；检查拒绝原生 `alert()` 和 Vue 模板中自行绘制的 `role="alert"` 消息块。业务确认、静态说明、加载状态和实际进度沿原组件保留。
- 该工具检查语法、重复成员、本地引用与渲染日志入口；不宣称替代完整 ESLint、类型分析、构建或运行验证。

## 验证命令

项目根目录的 `npm run check` 已验证。自动化行为回归使用 `npm test`，构建验证使用 `npm run build`，三者职责互补。

`npm run build:audio-effects` 构建并自检当前架构的原生宿主（需要前述 C++ 工具链）；开发启动使用 `npm run electron:dev`。客户端打包会自动调用同一原生构建入口，Windows x64 已执行目录打包并核对 ASAR 外资源和宿主自检，其他平台由对应 runner 构建。

`node scripts/generate-installer-motion.cjs` 已验证，可重新生成 `installer/assets/` 的 16 份 AVI；构建直接使用提交资源，无需运行生成器。
