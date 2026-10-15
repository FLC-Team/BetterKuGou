# common 速查

## 职责

维护跨页面复用的交互组件；本目录没有子目录。

## 直接文件

- `ContextMenu.vue`：通过 Teleport 渲染到 body 的菜单、定位和外部关闭事件。
- `ThemePackages.vue`：主题缩略预览、切换、文件导入更新、移除回退和当前主题导出。
- `ArtworkCover.vue`：列表页复用的纯展示封面，支持 `{size}` 替换、缺图/加载失败的唱片纹理回退，以及源地址变化后重试；不发送业务请求或修改歌曲数据。

## 接口与流程

- props 为 visible、position 和 items，关闭通过 close 事件反馈。
- item 支持 label、icon、divider、disabled、action 和 shortcut。
- 点击可用菜单项先执行 action，再通知父级关闭。
- 打开或坐标变化后，在 nextTick 测量菜单并限制在视口内。
- SVG 文件、data SVG 和路径字符串使用对应图标渲染方式。
- ThemePackages 的 modelValue 是 custom 设置分组，通过 update:modelValue 交给父页面保存；包格式由 themes 模块校验，不持有独立设置来源。
- 导入限制文件大小与数量；导出用 Blob 下载主题快照，卸载忽略未完成文件读取并释放下载 URL/定时器。

## 关键保障

- document 点击、窗口 resize 和捕获阶段 scroll 监听在卸载时成对移除。
- 不直接持有页面业务状态，不在通用菜单中复制播放或收藏逻辑。
- 活动菜单的全局注册由调用方配合菜单管理器处理。
- ArtworkCover 的 src/label/mark 只控制图片、无障碍描述及占位符；尺寸由调用页提供，缺少 label 时封面为装饰内容，失败图片不会留下破图或改变封面占位尺寸。

## 运行

项目启动与验证说明见 [BK.md](../../../BK.md)。
