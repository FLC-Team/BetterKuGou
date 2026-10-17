# taskbar 资源速查

## 职责与文件

Windows 原生任务栏预览按钮图标，本目录没有子目录。

- `previous.png`、`play.png`、`pause.png`、`next.png`：32×32 透明 PNG，分别派生自 `src/assets/icons/previous.svg`、`play.svg`、`stop.svg`、`next.svg`；白色图形带深色描边，以兼容深浅任务栏背景。

## 调用与保障

Electron `updateTaskbarButtons()` 通过 `nativeImage` 读取并缓存；Vite 将本目录原样复制到 `dist/taskbar/`，安装包沿现有 `dist/**/*` 规则包含。保持四个文件名，播放/暂停共用中间按钮位置，不依赖远程图标或运行时图像转换。

运行与验证见 [BK.md](../../BK.md)。
