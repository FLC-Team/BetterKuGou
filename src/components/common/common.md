# common 速查

## 职责

维护跨页面复用的交互组件；本目录没有子目录。

## 直接文件

- `AnimatedSelect.vue`：通用带动画选择器，保留受控值类型、同值重选、禁用及键盘入口；用于设置、底栏音质、更新、缓存和外观编辑器。
- `DropdownMenu.vue`：选择器的 body 弹出层，提供视口定位、滚动选项、滑动高亮、选中反馈、进退场及菜单互斥。
- `ContextMenu.vue`：通过 Teleport 渲染到 body 的菜单、定位和外部关闭事件。
- `WindowedList.vue`：超过 200 项时只挂载可见曲目与上下缓冲行，按真实行高维护占位；具名 header 插槽与直接行插槽保留既有列表布局和动效。
- `AnimatedDetails.vue`：保留原生 details/summary 的折叠组件，提供 `summary` 具名插槽、默认内容插槽及 `open` 初始/外部开合参数；普通点击与键盘激活使用同一开合流程。
- `detailsMotion.js`：原生折叠的可取消高度动画控制器；返回 `setOpen` / `dispose`，用于 AnimatedDetails、应用更新及恢复入口 Shadow DOM。
- `motionLayout.js`：网格离场坐标冻结及恢复的共享函数；移出正常布局后保留真实离场动画，允许其他项使用 FLIP 平滑移动，离场期间禁用交互和无障碍访问。
- `ThemePackages.vue`：主题缩略预览、切换、文件导入更新、移除回退和当前主题导出。
- `ThemeAdjustments.vue`：全部主题令牌按区域分组编辑、搜索和分组恢复，通过 custom v-model 交由设置页保存。
- `ThemeStudio.vue`：App 常驻的区域/元素拾取编辑器与主窗口/桌面歌词高级 CSS 草稿；预览、取消、保存与失败反馈。
- `ThemeRecovery.vue`：默认隐藏的独立 Shadow DOM 恢复面板；快捷键恢复时显示结果或重试，不受主题 CSS 影响。
- `ArtworkCover.vue`：列表及底部播放栏共用封面，支持 `{size}`、缺图/坏图回退；先查本账号本地封面，真实图片 load 后后台缓存网络图片，保持懒加载，不修改歌曲数据。
- `SongBadges.vue`：歌曲列表与播放队列复用的权限标签，通过 `songMetadata` 读取歌曲 VIP 元数据；标题、无障碍描述与徽标一致，不查询或推断当前账号的实际播放权限。
- `ArtistLinks.vue`：通过 `getSongArtists(song)` 为每位歌手提供独立按钮，`select` 只返回所选 `{ id, name }`；普通区域换行，`compact` 区域支持鼠标滚轮横向滚动与键盘聚焦显露目标，滚动边界保留页面原生滚轮行为。
- `AppUpdates.vue`：设置页应用更新区域，版本对照卡片集中展示实际版本、更新状态、真实下载进度和手动操作，分区展示更新说明与渠道/自动策略。
- `AppUpdates.css`：AppUpdates 专属 scoped 样式，沿用主题令牌与杂志式排版，提供窄容器、减少动态效果、高对比度和键盘焦点适配。
- `PlaylistCacheSettings.vue`：设置页离线缓存开关、容量、并发、全局占用、本账号清理及全部账号缓存位置迁移；普通偏好通过 download v-model 编辑父级草稿，管理前等待 beforeAction 保存，实际目录与迁移进度按 revision 接收。

- `LyricSettings.vue`：播放设置中的歌词库开关、自动保存/更新及匹配门槛，和翻译、罗马音、简繁、分词、脏词显示选项；使用 playback v-model 与既有设置保存流程。
- `DesktopLyricSettings.vue`：设置页桌面歌词的播放动画、自动显隐、字体配色、阴影及窗口锁定分组；通过 desktopLyrics v-model 编辑同一父级草稿，保留窗口位置和未知兼容字段。
- `IslandLyricSettings.vue`：设置页灵动岛的模式/屏幕/浮动位置、内容、字体颜色、透明度缩放、隐藏规则及左右内容；通过 islandLyrics v-model 编辑父级草稿，窗口预览前等待 beforeAction 保存。
- `LyricLibrary.vue`：按歌名/歌手搜索已保存曲目，预览与选用歌词版本、保存本地编辑副本；原版本保留，保存失败保留草稿。

## 接口与流程

- AnimatedSelect 通过 `modelValue/options` 接收选项和值，`update:modelValue` 与 `change` 返回选项原始值，不产生原生 change Event；保存仍由调用方负责。DropdownMenu 与既有右键/歌词菜单共用 contextMenuManager，选择后立即执行动作，退场层禁用输入；支持方向键、Home/End、文字查找、Escape/Tab 与焦点恢复。
- 选择器弹层按实际未变换尺寸测量并限制在视口内，选项过多可滚动；祖先 fieldset 禁用、inert/hidden、页面失活与卸载均关闭并释放监听。ThemeStudio 的弹层带主题安全标记与固定配色，避免自定义 CSS 隐藏编辑入口；减少动态效果保留可见选中反馈。
- props 为 visible、position 和 items，关闭通过 close 事件反馈。
- item 支持 label、icon、divider、disabled、action 和 shortcut。
- 点击可用菜单项先锁定离场菜单，再执行 action 并通知父级关闭；选择期间不能重复执行，Arrow/Home/End 导航和 Enter/Space 激活可用项，Escape 关闭。菜单保留真实退场，快速重开重新测量并解除旧锁定。
- 打开或坐标变化后，在 nextTick 测量菜单并限制在视口内。
- SVG 文件、data SVG 和路径字符串使用对应图标渲染方式。
- ThemePackages 的 modelValue 是 custom 设置分组，通过 update:modelValue 交给父页面保存；包格式由 themes 模块校验，不持有独立设置来源。
- ThemeAdjustments 使用 themes/themeAdjustments.js 克隆完整主题，创建或复用唯一的个性包，保留原主题及 CSS；分组恢复只影响该组令牌，颜色支持 rgba 透明度。
- 外观分组和高级 CSS 使用 AnimatedDetails；搜索结果和主题包卡片使用有稳定 key 的进入、离开及移动过渡，动作结果按序号重新反馈。折叠高度从当前可见值衔接，动态内容缩小时重新测量，减少动态效果立即完成；卸载释放动画、观察器及偏好监听。
- 打开 ThemeStudio 前先排空设置页保存；面板与拾取监听由 App 承载，导航不会丢草稿，可拾取 body 中的歌词/队列/菜单，按页面和语义 class/id 生成选择器。区域输入更新同一高级 CSS 文本，清空属性恢复继承。
- ThemeStudio 预览只调用 themeManager，不持久化且 30 秒自动恢复；应用经 settings store 保存完整主题包，失败保留草稿。保存期间禁用表单与关闭，普通 div 承担有限高度滚动；退出取消预览并释放监听/计时器。
- ThemeStudio 关闭立即取消拾取和预览并锁定输入，面板退场完成后才发出 close 供 App 卸载；收起保留表单与草稿，以高度过渡隐藏并禁用其中交互。拾取提示、匹配框、桌面预览和保存结果均有状态过渡。
- ThemeRecovery 宿主排除主题 CSS，默认隐藏且 inert；Ctrl+Alt+Shift+R 切回当前明暗内置主题并显示恢复状态，保留安装包。编辑入口只留在设置。恢复前经 App 与设置页握手，排空已有事务并丢弃主题草稿，避免防抖重选坏主题；保存失败保留安全预览和重试入口，其他偏好草稿保留。
- ThemeRecovery 的显隐、按钮悬停/按下及恢复结果动效定义在 Shadow DOM 内，工作期间去重并禁用恢复与关闭；完成后可关闭或 Escape 收起并恢复焦点，退场立即 inert，快速重开拒绝旧动画完成回调。系统减少动态效果时立即收敛，卸载忽略迟到保存结果并释放监听及动画。
- 导入限制文件大小与数量；导出用 Blob 下载主题快照，卸载忽略未完成文件读取并释放下载 URL/定时器。
- AppUpdates 的 modelValue 为 `software.updates`，通过 `update:modelValue` 返回父级草稿，`beforeAction` 排空既有保存，`current-version` 同步实际版本。只通过 `electronAPI.updates` 调用固定操作，不持有独立设置 store；下载仅提交已提供的资产 ID。
- AppUpdates 先订阅再读取状态快照，按 revision 拒绝旧响应，卸载仅解绑、不取消后台任务；重开可恢复下载进度和资产选择。更新说明按纯文本显示，发布页只允许固定项目路径；Linux 可在 AppImage 下载后改选 DEB/RPM 再下载。
- AppUpdates 的状态卡片按已提交渠道显示标记，偏好控件仍编辑父级草稿；真实百分比与字节数来自服务快照，尚未获得进度时使用原生不定进度条。更新说明默认展开，长说明可键盘聚焦滚动；版本、文件名和错误可换行，窄容器改为单列。
- AppUpdates 的版本、进度、完成文件、动作按钮、错误和发布信息均有过渡，更新说明与来源保留原生 details 开合；操作按钮离场立即 inert，快速回到原状态恢复交互，动画不触发安装或取消后台任务。
- DesktopLyricSettings 用 AnimatedDetails 收纳选项，AnimatedSelect 保留字号、样式、对齐及阴影来源的受控值；原生 checkbox/range/color/text 提供键盘与标签入口。仅显示歌曲信息时暂停歌词内容选项，节能模式暂停装饰动画选项，悬停淡化与阴影子设置跟随对应开关禁用，保留原偏好以便恢复。字体恢复只清空字体，文字颜色恢复只清空三类颜色，阴影恢复只更新参数，不覆盖窗口位置或其他设置。
- 桌面设置的打开和找回动作先等待 beforeAction 排空设置保存，再调用固定的 show/resetPosition；等待期间去重，失败显示可重试提示，卸载后不再执行迟到的窗口动作。浏览器禁用窗口按钮；偏好本身继续使用页面原有保存与错误重试流程。
- IslandLyricSettings 不建立独立 store，五处选择入口复用 AnimatedSelect/DropdownMenu 的鼠标、键盘和动效。左右内容预设由 leftContent/rightContent 推导，不保存重复字段；Logo 显隐独立，字体和单项颜色恢复不改写其他偏好，选择屏幕同时清空旧浮动位置。
- 灵动岛先订阅 onDisplaysChanged 再读取 getDisplays/getCapabilities，热插拔代次优先于迟到快照，断开屏幕不覆盖已保存选择；读取失败可重试，卸载解绑并拒绝迟到响应。外部全屏检测依能力启用，浏览器禁用系统窗口控件。手动启用先更新草稿，再与重新显示共用排空父级保存后的 3 秒预览；关闭只保存偏好。等待期间关闭选择器并防止重复窗口操作，结果及错误沿 ui-fade 展示。
- PlaylistCacheSettings 的“更改位置”先排空设置草稿，再调用无参数 `electronAPI.playlistCache.chooseDirectory()`；主进程选择父目录并迁移至其 `offline-playlists` 子目录，组件不直接编辑路径配置。该操作覆盖全部账号且不要求登录，取消不报告成功；状态恢复实际路径、复制/校验进度、迁移失败和旧文件清理警告，离页不取消迁移。

- LyricSettings 只编辑父级 playback 草稿，中文翻译复用 showTranslation；管理入口和 LyricLibrary 的每次读写均先排空 beforeAction。关闭管理后不读取库，原文件保留；浏览器预览禁用歌词库能力，内容处理选项仍可编辑。
- LyricLibrary 的版本选择器先预览，点击“使用此版本”才切换播放来源；保存创建并选中编辑副本，时间/行结构改变后提示服务已重置原翻译和读音。脏草稿禁用曲目/版本切换和刷新，关闭需显式放弃，写入失败保留草稿；外部变更只提示刷新，不覆写编辑。LyricSettings 转发 prepareLeave，正文未保存或仍在读写时阻止离页并展示提示；内部 beforeAction 仍只排空偏好，避免递归。读写去重，卸载解绑通知并拒绝迟到响应，管理操作与结果均有状态动画。

## 关键保障

- document 点击、窗口 resize 和捕获阶段 scroll 监听在卸载时成对移除。
- 不直接持有页面业务状态，不在通用菜单中复制播放或收藏逻辑。
- WindowedList 接收完整 items 和稳定 itemKey，行插槽用 data-window-index 标记当前展示索引；筛选、排序和播放仍由调用页管理。动态行高测量排除动画变换，宽度、字体与主题变化重新测量并维持滚动锚点；焦点行独立保留，Tab 可跨未挂载行，KeepAlive 失活释放观察器，激活后跟随页面恢复的滚动位置。
- 活动菜单的全局注册由调用方配合菜单管理器处理。
- ArtworkCover 的 src/label/mark 只控制图片、无障碍描述及占位符；尺寸由调用页提供，缺少 label 时封面为装饰内容，失败图片不会留下破图或改变封面占位尺寸。
- ArtworkCover 的 loading 默认为 lazy，持续可见的播放栏传入 eager，确保新封面立即开始加载；列表保留原有懒加载行为。
- ArtworkCover 的 imageOnly 模式保留原生 img 根节点，供首页与全屏歌词延续原有占位、CSS 和切歌过渡；与普通封面共用缓存和租约处理。最终图片错误向调用者透传，损坏本地封面先回退网络，原始地址属性支持旧层错误隔离。
- ArtworkCover 只在当前代次实际加载成功后淡入；相对、data 及缓存 URL 规范比较后接受，换源复位加载状态，迟到 load/error 不能改变新图。imageOnly 保留原 img 实例和调用方 class，仅增加加载状态属性，不覆盖调用方最终透明度和布局。
- ArtworkCover 不因挂载下载未显示封面；本地图片租约在源改变、卸载和迟到结果时释放，损坏本地图片回退网络，缓存故障只影响本地资源复用。PlaylistCacheSettings 在账号变化时取消清理确认，卸载仅解绑，不取消后台任务。
- SongBadges 与截断的歌名并列，窄窗口和长歌名仍保留标识；未知权限不标记、不隐藏或禁用歌曲，VIP 与既有 SQ 音质标记独立。
- SongBadges 只在内容出现时作短淡入；ArtistLinks 提供 hover/focus/press 反馈，compact 聚焦时平滑显露目标，滚轮仍按实际边界保留页面滚动。
- ArtistLinks 不修改歌曲或播放状态，按钮隔离点击与双击，保留原生键盘操作与明确歌手名称；缺少元数据时只显示不可交互的“未知歌手”。
- AppUpdates 下载完成不调用安装接口，exe/dmg/deb/rpm 只有手动点击才请求主进程原生确认，等待期间去重；AppImage 仅提供文件定位。取消下载可在原下载请求未结束时执行，迟到状态不能恢复已取消的任务；浏览器预览禁用桌面更新控件。
- PlaylistCacheSettings 的清理确认支持真实进退场与快速取消重开；离场内容立即 inert，取消后旧确认处理器也不能执行清理。忙碌和结果反馈不改变先保存设置、再校验账号代次、最后执行缓存动作的顺序。
- 目录迁移时合并本地操作锁与服务迁移状态，禁用更改位置、清理和重试；保存失败保留可重试入口，保存期间开始的另一迁移阻止重复提交。卸载忽略迟到选择/迁移结果并解除订阅，重新打开设置从状态快照继续显示；浏览器预览禁用目录选择，进度和结果沿用减少动态效果支持。

## 运行

项目启动与验证说明见 [BK.md](../../../BK.md)。
