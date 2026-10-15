# BetterKuGou 项目速查

## 职责与入口

Vue 3 渲染界面与播放器，Electron 主进程提供窗口、托盘、桌面歌词、快捷键及设置持久化，独立本地 API 转发酷狗请求。

`index.html → src/main.js → src/App.vue` 是渲染入口；`package.json.main → electron/main.js` 是客户端入口。渲染侧通过 Axios 调用 `localhost:6500`，系统能力只通过隔离的 preload 白名单使用。

## 直接子目录

- [src/](./src/src.md)：界面、页面、播放状态、HTTP 封装、主题与渲染日志。
- [electron/](./electron/electron.md)：客户端主进程、窗口 HTML、桥接和持久化。
- [KuGouMusicApi/](./KuGouMusicApi/KuGouMusicApi.md)：随应用启动的第三方本地 API。
- [public/](./public/public.md)：公共 Logo 和安装图标。
- [scripts/](./scripts/scripts.md)：正式静态检查工具。
- [tests/](./tests/tests.md)：Node 回归测试及 Vue/HTTP 集成边界验证。
- `.github/`：开发提示和多平台自动构建工作流；推送 `master`、针对 `master` 的 PR 和手动触发执行检查、测试及构建，推送 `v*` 标签时另行创建 Release。
- `.vscode/`：编辑器建议配置。
- `.agent/`：删除文件恢复区、临时诊断工具和截图；不提交。
- `.agents/`：已有 Agent 配置目录；不作为应用入口。
- `node_modules/`、`dist/`、`dist-electron/`、`release/`：依赖和可再生构建输出。

## 直接重要文件

- [AGENTS.md](./AGENTS.md)：统一工作规则。
- [agent.md](./agent.md)：已明确的长期要求。
- `package.json` / `package-lock.json`：npm 依赖、命令、客户端入口和打包配置。
- `vite.config.js`：Vue/Electron 构建；内联主进程的 CommonJS 模块并复制两份窗口 HTML。
- `index.html`：挂载节点和唯一公共 Logo 引用。
- `.editorconfig` / `.gitignore`：编辑风格及构建、环境、敏感和临时内容排除。
- `README.md` / `PROJECT_STRUCTURE.md`：使用说明及架构总览。
- `BK.txt`：保留的历史速查资料，当前逻辑以同名 `.md` 文档为准。
- `LICENSE`：许可证；`todo` / `updata_log.md`：项目规划和版本记录。
- `push.bat`：人工发布辅助脚本，不作为 Agent 自动提交入口。

## 核心流程与保障

1. 主进程初始化设置，启动 Utility Process 中的本地 API，并创建隔离窗口。
2. 渲染 store 加载并补全设置；播放队列由 App 持有，播放器通过事件请求队列替换。
3. 设置页只提交编辑字段；渲染提交串行，重放尚未落盘的修改，防止早期广播回退会话。主进程整笔事务串行且原子落盘，成功后发布缓存和通知。
4. 选歌、歌词、搜索和二维码登录按请求代次拒绝过期响应；组件退出释放定时器、IPC、MediaSession 和 DOM 监听。
5. API 将 POST body 映射到模块顶层，保留查询优先级及 `body` 兼容；只缓存无请求体、无凭证的公开 GET，按 Origin 隔离 CORS 缓存。
6. 认证失效由 API 事件通知 App 清理登录信息；日志脱敏后才写入控制台、内存和 IPC，Trace 需显式开启，渲染日志最多保留 500 条。
7. 退出复用同一清理任务，等待后端停止后才放行；清理中不因托盘设置阻止关闭，不重建窗口或留下端口。
8. 浮动侧栏沿用 BetterKuGou 的圆角、悬停展开和滑动指示条；整栏可向左收起，右侧播放列表向右收起，均保留贴边展开图标。登录页保留侧栏，选中歌单由 App 状态驱动，主题与账号菜单复用 BK 现有实现。
9. 内置样式和可分享 JSON 主题包维护在 `src/themes/`；设置页管理导入、切换及导出，复用 `custom.theme/themePackages` 和原持久化流程。Vue 与 Electron IPC 共用校验目录，整包应用视觉变量，播放会话广播不会覆盖尚未保存的主题预览。
10. 网易云播放器选项采用 BetterKuGou 悬浮胶囊布局；App 按实际播放器挂载条件预留空间，空队列不占位。歌词和播放列表独立挂载到 body，全屏歌词从底部覆盖至标题栏并反向收起，退场完成后复原标题栏。
11. 页面短过渡配合按资源区分、最多 12 个实例的 KeepAlive；主页、收藏与详情保留数据和独立滚动位置，登录/设置沿用卸载清理。账号变化释放私有缓存；歌单目录复用请求，手动刷新只更新目标曲目，每日资源跨日更新。
12. 歌词桥段保留前句和独立进度指示；拖动进度期间歌词实时跟随预览，高亮与桥段同步，松开后确认音频跳转，取消回到实际时间；纵向短过渡跟随最新位置，屏外行保留可插值起点。

禁止改变既有技术栈和协议，禁止新建重复 store/日志/插件架构。目录职责与局部设计细节见各目录速查。

## 运行与验证

依赖使用 npm 和现有 lockfile；根安装流程通过 `postinstall` 安装本地 API 的生产依赖。安装解析可用 `npm install --dry-run --offline --ignore-scripts` 检查，本命令不执行安装脚本。

```bash
npm run electron:dev
npm run check
npm test
npm run build
```

开发命令由 Vite 启动客户端；静态检查覆盖语法、重复对象成员和本地引用；测试覆盖业务状态及本地 HTTP，构建生成 `dist/` 和 `dist-electron/`。生产安装包入口及平台打包命令见 `package.json` 和 README，发布产物进入 `release/`。

运行时诊断可设置 `BK_LOG_LEVEL=trace`，常规使用默认 `info`。真实酷狗登录、歌曲授权和跨平台安装包须在对应账号与系统环境验证。
