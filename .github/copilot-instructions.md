# BetterKuGou 开发约定

## 修改原则

- 先定位真实入口和调用关系，不创建与现有实现平行的第二套架构。
- 使用 camelCase JavaScript 命名和 kebab-case CSS 变量。
- 保持功能行为稳定；修改播放、设置或进程生命周期后必须进行真实运行验证。
- 渲染进程不得启用 Node 集成，只能使用 `electron/preload.js` 暴露的白名单 API。
- 敏感数据不得写入日志；API 查询日志必须经过脱敏。

## 目录边界

- `src/views/`：页面级组件。
- `src/components/common/`：跨页面通用组件。
- `src/components/layout/`：标题栏、侧边栏等布局组件。
- `src/components/player/`：播放器、歌词和队列。
- `src/stores/`：唯一的渲染侧设置/会话状态来源。
- `src/styles/`：主题变量、reset 和跨页面公共样式。
- `electron/services/`：从主进程抽离的独立生命周期服务。
- `KuGouMusicApi/`：第三方本地 API，避免无关改写。

页面和根组件分别通过 `src/views/index.js`、`src/components/index.js` 暴露公共入口。不要恢复已删除的 `config/`、`plugins/`、`src/stores/globalState.js` 或 `src/main/loggerManager.js` 草案。

## 大文件约定

复杂 SFC 参照以下形式拆分：

```text
Feature.vue                 # 模板与组件声明
Feature.js                  # Options API 业务逻辑
styles/Feature.css          # scoped 样式
```

`<script setup>` 页面可保留脚本在 SFC 中，但较大的 scoped 样式应外置。

## 资源约定

- 应用 Logo 只维护 `public/logo.png` 和安装包所需 `public/logo.ico`。
- 渲染图标放入 `src/assets/icons/`。
- 加载状态使用全局 `.loading-spinner`，不添加重复 Logo 或大体积 GIF。

## 验证命令

```bash
npm run build
npm run electron:dev
npm run electron:build -- --dir
```

工作前先读根目录 `AGENTS.md`、`agent.md` 和目标目录同名 `.md` 速查。
涉及目录、关键函数或数据流变化后，同步 `BK.md`、受影响目录速查及 `PROJECT_STRUCTURE.md`。`BK.txt` 仅保留历史资料。
静态检查使用 `npm run check`，回归测试使用 `npm test`；构建成功不能代替运行时验证。
