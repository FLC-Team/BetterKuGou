# BetterKuGou

> 本项目前端与客户端由本仓库维护，后端接口基于 [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) 项目，致谢原作者的开源贡献。

[![GitHub release](https://img.shields.io/github/v/release/YuanXiaCN/BetterKuGou?include_prereleases)](https://github.com/YuanXiaCN/BetterKuGou/releases)
[![GitHub stars](https://img.shields.io/github/stars/YuanXiaCN/BetterKuGou)](https://github.com/YuanXiaCN/BetterKuGou/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 第三方跨平台酷狗音乐客户端，界面简洁，支持主题与播放行为自定义。

## 软件特点
- **界面简洁**：极致简约风格，专注音乐体验
- **高度自定义**：支持多种主题、配色、布局，用户可深度定制
- **动画全覆盖**：全局动画效果，交互流畅自然
- **无广告**：纯净体验
- **多平台支持**：Windows、macOS、Linux

## 更新日志
详见 [updata_log.md](./updata_log.md)。

## 快速开始

### 下载安装

前往 [Releases](https://github.com/YuanXiaCN/BetterKuGou/releases) 页面，下载适合你系统的安装包：
- Windows: `BetterKuGou-*.exe`
- macOS: `BetterKuGou-*.dmg` 或 `BetterKuGou-*.zip`
- Linux: `BetterKuGou-*.AppImage`、`*.deb`、`*.rpm`

### 源码运行

1. 克隆仓库
   ```bash
   git clone https://github.com/YuanXiaCN/BetterKuGou.git
   cd BetterKuGou
   ```
2. 安装依赖
   ```bash
   npm install
   ```
   该命令会自动安装根项目以及 `KuGouMusicApi/` 的生产依赖。
3. 启动开发环境
   ```bash
   npm run electron:dev
   ```
   Vite、Electron 和本地 API（`localhost:6500`）会一起启动。
4. 打包构建
   ```bash
   npm run dist:win   # Windows
   npm run dist:mac   # macOS
   npm run dist:linux # Linux
   ```

仅验证编译时可运行 `npm run build`。最终安装包输出到 `release/`。

## 项目架构

- `src/`：Vue 3 界面、播放与歌词逻辑
- `electron/`：窗口、托盘、设置、快捷键和桌面歌词
- `KuGouMusicApi/`：随应用启动的本地 API 服务

项目入口、命令和保障见 [BK.md](./BK.md)，架构总览见 [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md)。Agent 工作规范见 [AGENTS.md](./AGENTS.md)，长期要求见 [agent.md](./agent.md)。

开发检查命令：

```bash
npm run check  # JS/Vue/HTML 语法、重复对象成员和本地引用
npm test      # 业务状态、Vue 事件流和本地 HTTP 回归
npm run build # Vue 与 Electron 构建
```

日志默认 `info`；需要诊断时设置 `BK_LOG_LEVEL=trace`。登录凭证和敏感参数不输出到日志。

## 自定义
- 支持主题切换、配色自定义、布局调整
- 丰富的动画 API，轻松实现全局动效
在“设置 → 自定义功能 → 主题与配色”选择主题、导入 `.bk-theme.json` 文件，或导出当前主题分享给其他用户。原深色/浅色及跟随系统、自定义配色继续可用。

主题制作请查看 [主题包文档](src/themes/themes.md)，可先导入 [松林夜色示例](src/themes/example.bk-theme.json)。


## 贡献指南
欢迎任何形式的贡献！
1. Fork 本仓库
2. 新建分支 (`git checkout -b feature/xxx`)
3. 提交更改 (`git commit -am 'feat: xxx'`)
4. 推送分支 (`git push origin feature/xxx`)
5. 提交 Pull Request

## 常见问题
- Q: 使用什么账号登录？
- A: 使用酷狗账号登录，所有的数据都会从酷狗服务器获取

- Q: 账号有没有泄露风险？
- A: 登录请求由本机 API 向酷狗服务发起，账号密码在登录模块中加密处理。客户端在本机保存登录状态，日志会对凭证和敏感参数脱敏。

- Q: 数据是同步的吗？
- A: 是的，数据会自动同步到酷狗账号，登录酷狗客户端也会出现同步数据

- Q：会出手机端吗？
- A: 暂不支持手机端，但是后续考虑在移动设备上适配单独的移动端版本。

## 后续规划
[TodoList](https://github.com/YuanXiaCN/BetterKuGou/blob/master/todo)

## 许可证

本项目基于 MIT License 开源，详见 [LICENSE](LICENSE)。

## 致谢
- **所有使用的用户**：感谢你们的支持与反馈！
- **白砂**：参与多种主题配色编写。
- **[MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)**：项目后端接口来源，感谢原作者开源。

---

> 作者：鸢夏 <1925019494@qq.com> 
> 反馈Q群：[点击加入](https://qm.qq.com/q/H9g8tVztKg)
> 项目主页：[https://github.com/YuanXiaCN/BetterKuGou](https://github.com/YuanXiaCN/BetterKuGou)
