# common 速查

## 职责

维护跨页面复用的交互组件；本目录没有子目录。

## 直接文件

- `ContextMenu.vue`：通过 Teleport 渲染到 body 的菜单、定位和外部关闭事件。
- `ThemePackages.vue`：主题缩略预览、切换、文件导入更新、移除回退和当前主题导出。
- `ThemeAdjustments.vue`：全部主题令牌按区域分组编辑、搜索和分组恢复，通过 custom v-model 交由设置页保存。
- `ThemeStudio.vue`：App 常驻的区域/元素拾取编辑器与主窗口/桌面歌词高级 CSS 草稿；预览、取消、保存与失败反馈。
- `ThemeRecovery.vue`：body 中独立 Shadow DOM 外观入口与恢复快捷键；不受主题 CSS 影响。
- `ArtworkCover.vue`：列表页及底部播放栏复用的纯展示封面，支持 `{size}` 替换、缺图/加载失败的唱片纹理回退，以及源地址变化后重试；不发送业务请求或修改歌曲数据。
- `SongBadges.vue`：歌曲列表与播放队列复用的权限标签，通过 `songMetadata` 读取歌曲 VIP 元数据；标题、无障碍描述与徽标一致，不查询或推断当前账号的实际播放权限。
- `ArtistLinks.vue`：通过 `getSongArtists(song)` 为每位歌手提供独立按钮，`select` 只返回所选 `{ id, name }`；普通区域换行，`compact` 区域支持鼠标滚轮横向滚动与键盘聚焦显露目标，滚动边界保留页面原生滚轮行为。
- `AppUpdates.vue`：设置页应用更新区域，版本对照卡片集中展示实际版本、更新状态、真实下载进度和手动操作，分区展示更新说明与渠道/自动策略。
- `AppUpdates.css`：AppUpdates 专属 scoped 样式，沿用主题令牌与杂志式排版，提供窄容器、减少动态效果、高对比度和键盘焦点适配。

## 接口与流程

- props 为 visible、position 和 items，关闭通过 close 事件反馈。
- item 支持 label、icon、divider、disabled、action 和 shortcut。
- 点击可用菜单项先执行 action，再通知父级关闭。
- 打开或坐标变化后，在 nextTick 测量菜单并限制在视口内。
- SVG 文件、data SVG 和路径字符串使用对应图标渲染方式。
- ThemePackages 的 modelValue 是 custom 设置分组，通过 update:modelValue 交给父页面保存；包格式由 themes 模块校验，不持有独立设置来源。
- ThemeAdjustments 使用 themes/themeAdjustments.js 克隆完整主题，创建或复用唯一的个性包，保留原主题及 CSS；分组恢复只影响该组令牌，颜色支持 rgba 透明度。
- 打开 ThemeStudio 前先排空设置页保存；面板与拾取监听由 App 承载，导航不会丢草稿，可拾取 body 中的歌词/队列/菜单，按页面和语义 class/id 生成选择器。区域输入更新同一高级 CSS 文本，清空属性恢复继承。
- ThemeStudio 预览只调用 themeManager，不持久化且 30 秒自动恢复；应用经 settings store 保存完整主题包，失败保留草稿。保存期间禁用表单与关闭，普通 div 承担有限高度滚动；退出取消预览并释放监听/计时器。
- ThemeRecovery 宿主排除主题 CSS，独立固定样式与 Shadow DOM 始终保留恢复按钮；Ctrl+Alt+Shift+R 切回当前明暗内置主题，保留安装包。恢复前经 App 与设置页握手，排空已有事务并丢弃主题草稿，避免防抖重选坏主题；保存失败保留安全预览和重试入口，其他偏好草稿保留。
- 导入限制文件大小与数量；导出用 Blob 下载主题快照，卸载忽略未完成文件读取并释放下载 URL/定时器。
- AppUpdates 的 modelValue 为 `software.updates`，通过 `update:modelValue` 返回父级草稿，`beforeAction` 排空既有保存，`current-version` 同步实际版本。只通过 `electronAPI.updates` 调用固定操作，不持有独立设置 store；下载仅提交已提供的资产 ID。
- AppUpdates 先订阅再读取状态快照，按 revision 拒绝旧响应，卸载仅解绑、不取消后台任务；重开可恢复下载进度和资产选择。更新说明按纯文本显示，发布页只允许固定项目路径；Linux 可在 AppImage 下载后改选 DEB/RPM 再下载。
- AppUpdates 的状态卡片按已提交渠道显示标记，偏好控件仍编辑父级草稿；真实百分比与字节数来自服务快照，尚未获得进度时使用原生不定进度条。更新说明默认展开，长说明可键盘聚焦滚动；版本、文件名和错误可换行，窄容器改为单列。

## 关键保障

- document 点击、窗口 resize 和捕获阶段 scroll 监听在卸载时成对移除。
- 不直接持有页面业务状态，不在通用菜单中复制播放或收藏逻辑。
- 活动菜单的全局注册由调用方配合菜单管理器处理。
- ArtworkCover 的 src/label/mark 只控制图片、无障碍描述及占位符；尺寸由调用页提供，缺少 label 时封面为装饰内容，失败图片不会留下破图或改变封面占位尺寸。
- ArtworkCover 的 loading 默认为 lazy，持续可见的播放栏传入 eager，确保新封面立即开始加载；列表保留原有懒加载行为。
- SongBadges 与截断的歌名并列，窄窗口和长歌名仍保留标识；未知权限不标记、不隐藏或禁用歌曲，VIP 与既有 SQ 音质标记独立。
- ArtistLinks 不修改歌曲或播放状态，按钮隔离点击与双击，保留原生键盘操作与明确歌手名称；缺少元数据时只显示不可交互的“未知歌手”。
- AppUpdates 下载完成不调用安装接口，exe/dmg/deb/rpm 只有手动点击才请求主进程原生确认，等待期间去重；AppImage 仅提供文件定位。取消下载可在原下载请求未结束时执行，迟到状态不能恢复已取消的任务；浏览器预览禁用桌面更新控件。

## 运行

项目启动与验证说明见 [BK.md](../../../BK.md)。
