# BetterKuGou

# 本项目已停止开发

> 本项目前端与客户端由本仓库维护，后端接口基于 [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) 项目，致谢原作者的开源贡献。

[![GitHub release](https://img.shields.io/github/v/release/YuanXiaCN/BetterKuGou?include_prereleases)](https://github.com/YuanXiaCN/BetterKuGou/releases)
[![GitHub stars](https://img.shields.io/github/stars/YuanXiaCN/BetterKuGou)](https://github.com/YuanXiaCN/BetterKuGou/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 第三方跨平台酷狗音乐客户端，界面简洁，高度自定义，高度拓展性，动画全覆盖。

## 软件特点
- **界面简洁**：极致简约风格，专注音乐体验
- **高度自定义**：支持多种主题、配色、布局，用户可深度定制
- **高度拓展性**：插件化架构，便于功能扩展与二次开发
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
   # 或 pnpm install
   ```
3. 启动开发环境
   ```bash
   npm run dev
   # 或 pnpm dev
   ```
4. 打包构建
   ```bash
   npm run dist:win   # Windows
   npm run dist:mac   # macOS
   npm run dist:linux # Linux
   ```

## 高度自定义与拓展
- 支持主题切换、配色自定义、布局调整
- 插件系统，欢迎开发和分享你的插件
- 丰富的动画 API，轻松实现全局动效
PS：主题开发请查看 [主题文档](https://github.com/YuanXiaCN/BetterKuGou/blob/master/src/styles/README.md)


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
- A: 完全没有，通过后端加密传输，未经过中转服务器，数据完全在本地处理，不会上传至非酷狗的任何服务器，请放心使用。

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
> 作者：鸢夏 <1925019494@qq.com>
> 
> 项目主页：[https://github.com/YuanXiaCN/BetterKuGou](https://github.com/YuanXiaCN/BetterKuGou)
