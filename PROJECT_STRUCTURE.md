# BetterKuGou 项目结构

## 架构边界

BetterKuGou 由以下运行单元组成：

- `src/`：Vue 3 渲染进程，只负责界面、播放状态和用户交互。
- `electron/`：Electron 主进程，负责窗口、系统能力、设置持久化和本地 API 生命周期。
- `KuGouMusicApi/`：独立的本地 Express API，监听 `localhost:6500`。
- `electron/services/updateWorker.cjs`：独立更新线程，负责发布请求、下载与文件校验；主进程只调度并处理用户主动打开安装包。

渲染进程通过 Axios 调用本地 API，通过 preload 白名单调用 Electron 能力，不直接启用 Node 集成。

所有窗口使用 `nodeIntegration: false` 和 `contextIsolation: true`；加载页及桌面歌词分别使用专用白名单。工作规范见 `AGENTS.md`，长期要求见 `agent.md`，目录索引和运行检查见 `BK.md` 与各目录同名 `.md`。

## 当前目录

```text
BK/
├── electron/
│   ├── services/
│   │   ├── backendService.js     # API 启停、健康检查和退出清理
│   │   ├── updateService.js      # 更新策略、任务调度和状态广播
│   │   └── updateWorker.cjs      # 双源请求、下载和文件校验
│   ├── main.js                   # 应用编排、窗口、托盘和 IPC
│   ├── preload.js                # 渲染进程白名单桥接
│   ├── settingsStore.js          # 设置持久化
│   └── desktopLyric.html         # 桌面歌词窗口
├── KuGouMusicApi/                # 第三方本地音乐 API
├── src/
│   ├── api/                      # auth.js、music.js
│   ├── assets/icons/             # 实际使用的 SVG 图标
│   ├── components/
│   │   ├── common/               # 右键菜单、主题与应用更新等通用组件
│   │   ├── layout/               # 标题栏、侧边栏、用户菜单
│   │   ├── player/               # 播放器、歌词、播放列表
│   │   │   └── styles/           # 播放器 scoped 样式
│   │   └── index.js              # 组件公共出口
│   ├── views/
│   │   ├── logic/                # 复杂页面业务逻辑
│   │   ├── styles/               # 复杂页面 scoped 样式
│   │   └── index.js              # 页面公共出口
│   ├── stores/                   # 响应式设置与会话快照
│   ├── styles/                   # 全局变量、重置、通用组件样式
│   ├── themes/                   # 内置主题 JSON、共享校验和可导入示例
│   ├── utils/                    # 日志、主题和对象工具
│   ├── App.vue                   # 页面与播放器编排
│   ├── App.css                   # 根布局私有 scoped 样式
│   └── main.js                   # Vue 入口
├── public/                       # 唯一公共 Logo 与应用图标
├── scripts/                      # 静态检查工具
├── tests/                        # Node/Vue/HTTP 回归验证
├── .github/workflows/release.yml # 多平台发布
├── package.json                  # 命令、依赖和打包配置
└── vite.config.js                # Vue/Electron 联合构建
```

## 文件职责约束

- 页面级内容放入 `src/views/`，不要再混入 `components/`。
- 通用组件按 `common/layout/player` 分类，并通过 `components/index.js` 暴露给根入口。
- 超过约 30 KB 且同时包含复杂逻辑和样式的 SFC，应参照播放器拆成 `.vue + .js + styles/*.css`。
- 全局样式只放主题变量、reset 和跨页面复用规则；页面私有样式使用 scoped 外置 CSS。
- Electron `main.js` 只做编排；可独立测试或拥有生命周期的逻辑放入 `electron/services/`。
- Logo 统一使用 `public/logo.png`；加载状态使用 `.loading-spinner`，不要提交重复 Logo 或大 GIF。Electron 加载页和托盘通过统一路径解析复用该 Logo。
- 不存在可运行的插件系统，不新增 `plugins/` 或第二套全局状态草案。

## 关键数据流

1. `npm run electron:dev` 启动 Vite 与 Electron。
2. `electron/main.js` 初始化设置和窗口，并调用 `backendService.start()`。
3. `backendService` 根据开发/生产环境解析 API 路径，通过 Utility Process 启动服务并健康检查。
4. Vue 从 `settingsAPI` 读取设置，`App.vue` 恢复页面与播放会话。
5. 页面经 `src/api/*.js` 请求本地 API；`music.js` 将认证失效响应转换为全局事件，`App.vue` 清理假登录状态并打开登录页。
6. 播放器以事件请求 App 替换队列，选歌和歌词加载只应用最新请求。收藏页兼容不同字段名和 ID 类型。
7. 设置页只提交编辑字段；渲染提交串行并保留待写修改，主进程落盘成功后才发布设置。当前 schema 的缺失字段也按默认值补全。
8. API 保留查询参数优先级，将请求体映射到模块顶层；仅缓存无凭证且无请求体的公开 GET，并按 Origin 隔离缓存。
9. 退出等待统一清理任务完成，释放更新 Worker、API、快捷键、托盘、窗口、监听器及定时器；托盘驻留不阻挡主动退出。
10. 主题包通过设置页导入 custom.themePackages，themeManager 解析并整包更新 CSS 变量；JSON 导出只包含视觉快照，Vue 与 Electron 共用主题目录校验。
11. 设置“启动与应用”编辑 software.updates，保存成功后配置 updateService；Worker 独立获取固定仓库发布与安装包，各自优先代理、失败尝试 GitHub。Worker 通过 extraResources 发布至 resources/updater/updateWorker.cjs，文件只写 userData/updates；运行状态留在内存，preload 只向主窗口暴露展示状态和固定操作。安装须用户主动点击、原生确认及确认前后校验，不自动退出应用，AppImage 只定位文件。
12. `installer/` 维护 Windows 无边框 NSIS 安装和升级流程及 macOS DMG 品牌资源。用户在安装器确认后，经 `installQuitService` 的每 PID 命名管道请求客户端保存设置、复核会话并正常退出；仅当前主窗口顶层 frame 的当前请求可确认，失败或超时提示手动退出。Linux 保留系统包管理与 AppImage 替换，发布工作流匹配实际产物名称。

## 常用命令

```bash
npm install
npm run electron:dev
npm run check
npm test
npm run build
npm run electron:build -- --dir
npm run dist:win
```

中间产物位于 `dist/`、`dist-electron/`，发布产物位于 `release/`。
