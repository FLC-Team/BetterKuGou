# public 资源速查

## 职责

保存 Vite 原样复制到渲染构建目录的公共品牌资源，供窗口、加载页、托盘及打包器共用。

## 直接文件

- `logo.png`：网页 favicon、应用界面、加载页及托盘的公共 Logo。
- `logo.ico`：Windows 安装包及卸载器图标。

## 直接子目录

- `taskbar/`：Windows 任务栏预览的原生 PNG 播放按钮，从已有播放 SVG 派生。渲染界面 SVG 操作图标仍由 `src/assets/icons/` 维护。

## 保障

保持上述文件名和打包配置引用一致；不添加重复 Logo、大体积加载 GIF 或失效的 Vite 默认图标。
Electron 在开发时从 `public/` 取图标，生产时从 `dist/` 取图标；加载页的图片地址由主进程传入。

运行与验证见 [BK.md](../BK.md)。
