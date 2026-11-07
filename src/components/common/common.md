# common 速查

## 职责

维护跨页面复用的交互组件；本目录没有子目录。

## 直接文件

- `NotificationRoot.vue`：挂载 FueConfigProvider/FueMessageProvider 与完整原库样式；保留倒计时进度条、悬停暂停及 Message/Alert 动画，提供主题安全 Shadow DOM、播放器上方右下角定位、无可见滚动条的堆叠滚动、F8 焦点入口、首帧就绪及致命启动失败退出。
- `AppNotice.vue`：全局注册的无渲染消息适配组件，把响应式消息、类型、动作和重复序号交给 Fue；管理所属通知的替换、关闭、失活与卸载，不创建第二份通知列表。
- `NotificationEvents.vue`：订阅固定 `onAppNotice` IPC，将主进程及歌词窗口的纯文本消息交给同一 Fue Provider；按消息标识替换，卸载解绑和关闭所属通知。
- `AnimatedSelect.vue`：通用带动画选择器，保留受控值类型、同值重选、禁用及键盘入口；用于设置、底栏音质、更新、缓存和外观编辑器。
- `DropdownMenu.vue`：选择器的 body 弹出层，提供视口定位、滚动选项、滑动高亮、选中反馈、进退场及菜单互斥。
- `ContextMenu.vue`：通过 Teleport 渲染到 body 的菜单、定位和外部关闭事件。
- `SongDetailsPanel.vue`：歌曲、专辑及歌单的只读评论侧栏，包含分类、热词、回复、分页及其他歌曲版本。
- `SongDetailsPanel.css`：侧栏私有 scoped 样式，维护封面信息头、评论与回复层级、真实状态动画和窄窗口/减少动态效果适配。
- `WindowedList.vue`：超过 200 项时只挂载可见曲目与上下缓冲行，按真实行高维护占位；具名 header 插槽与直接行插槽保留既有列表布局和动效。
- `AnimatedDetails.vue`：保留原生 details/summary 的折叠组件，提供 `summary` 具名插槽、默认内容插槽及 `open` 初始/外部开合参数；普通点击与键盘激活使用同一开合流程。
- `detailsMotion.js`：原生折叠的可取消高度动画控制器；返回 `setOpen` / `dispose`，用于 AnimatedDetails 及应用更新。
- `motionLayout.js`：网格离场坐标冻结及恢复的共享函数；移出正常布局后保留真实离场动画，允许其他项使用 FLIP 平滑移动，离场期间禁用交互和无障碍访问。
- `ThemePackages.vue`：主界面背景设置、主题缩略预览、切换、文件导入更新、移除回退和当前主题导出。
- `BackgroundImageSetting.vue`：主界面和全屏歌词共用的图片选择、预览和清除。使用 Chromium 解码本地图片，处理完成后将管理 ID 写入设置草稿，失败保留原图片并通过 AppNotice 提示。
- `ThemeAdjustments.vue`：全部主题令牌按区域分组编辑、搜索和分组恢复，通过 custom v-model 交由设置页保存；设置入口收纳在“外观与主题 → 界面精调与高级编辑”。
- `ThemeStudio.vue`：App 常驻的区域/元素拾取编辑器与主窗口/桌面歌词高级 CSS 草稿；预览、取消、保存与失败反馈。
- `ThemeRecovery.vue`：恢复快捷键及安全主题预览、设置保存握手；恢复进度、结果和重试统一通过 AppNotice，不维护独立面板或样式宿主。
- `ArtworkCover.vue`：列表及底部播放栏共用封面，统一首尾空白、全部 `{size}` 和协议相对图片地址，关注头像按同一 URL 查找和保存；支持缺图/坏图回退，先查本账号本地封面，真实图片 load 后后台缓存网络图片，保持懒加载，不修改歌曲数据。
- `SongBadges.vue`：歌曲列表与播放队列复用的权限标签，通过 `songMetadata` 读取歌曲 VIP 元数据；标题、无障碍描述与徽标一致，不查询或推断当前账号的实际播放权限。
- `ArtistLinks.vue`：通过 `getSongArtists(song)` 为每位歌手提供独立按钮，`select` 只返回所选 `{ id, name }`；普通区域换行，`compact` 区域支持鼠标滚轮横向滚动与键盘聚焦显露目标，滚动边界保留页面原生滚轮行为。
- `AppUpdates.vue`：设置“更新与备份”面板的应用更新区域，版本对照卡片集中展示实际版本、更新状态、真实下载进度和手动操作，分区展示更新说明与渠道/自动策略。
- `AppUpdates.css`：AppUpdates 专属 scoped 样式，沿用主题令牌与杂志式排版，提供窄容器、减少动态效果、高对比度和键盘焦点适配。
- `PlaylistCacheSettings.vue`：设置页离线缓存开关、容量、并发、全局占用、本账号清理及全部账号缓存位置迁移；普通偏好通过 download v-model 编辑父级草稿，管理前等待 beforeAction 保存，实际目录与迁移进度按 revision 接收。

- `LyricSettings.vue`：独立“歌词内容”面板中的歌词库开关、自动保存/更新及匹配门槛，和翻译、罗马音、简繁、分词、脏词显示选项；使用 playback v-model 与既有设置保存流程。
- `DesktopLyricSettings.vue`：设置页桌面歌词的播放动画、自动显隐、字体配色、阴影及窗口锁定分组；通过 desktopLyrics v-model 编辑同一父级草稿，保留窗口位置和未知兼容字段。
- `IslandLyricSettings.vue`：设置页灵动岛的模式/屏幕/浮动位置、内容、字体颜色、透明度缩放、隐藏规则及左右内容；通过 islandLyrics v-model 编辑父级草稿，窗口预览前等待 beforeAction 保存。
- `TaskbarLyricSettings.vue`：Windows 任务栏歌词的嵌入/轮询/显示器、布局对齐、内容、字体动效及边距尺寸；通过 taskbarLyrics v-model 编辑同一父级草稿，启用/预览/恢复前排空保存。复用 AnimatedSelect，能力不足禁用系统操作，保存失败保留草稿及重试，实际回退原因可见；先订阅状态/屏幕再读快照，拒绝迟到覆盖，卸载解绑。
- `LyricLibrary.vue`：按歌名/歌手搜索已保存曲目，预览与选用歌词版本、保存本地编辑副本；原版本保留，保存失败保留草稿。

## 接口与流程

- NotificationRoot 先创建带 `data-bk-theme-safety` 的 Shadow DOM，把原版 Provider 与样式挂在其中，再通过同一 Vue 组件树内的嵌套 Teleport 将 App 放回 `#app`；App 的所有页面和 body 弹层仍能注入同一 Provider。只补充定位、动作排列及主题变量映射，气泡、图标、按钮和动画均来自 Fue。宿主和子组件挂载完成后才在首帧发送就绪，卸载清理宿主、监听与待执行帧。
- AppNotice 接收 `message/title/type/revision/actions/duration/closable/busy`，动作项使用 `label/run/disabled`；默认 success/info 为 4500ms，error/warning 或带动作的消息持续显示，显式 duration 可覆盖。消息或重复序号变化替换通知，动作内容和禁用状态实时更新；关闭只影响自身，替换及卸载的旧关闭回调不能清除新消息。异步动作防重入，异常留在同一通知供重试，过期按钮不能继续执行。KeepAlive 失活关闭自己的消息，激活按当前状态恢复。
- F8 从页面或模态焦点范围滚到并进入最新通知，重复 F8 保留原焦点；通知内部键盘事件不触发播放器快捷键。Escape 通过原库关闭按钮执行守卫并返回原控件，不可关闭的通知保留。自动淘汰及其他离场期间捕获并阻止鼠标/键盘动作，旧通知不能继续操作；启动失败只展示不可关闭的通知与“退出程序”，退出仍调用主进程受限接口。
- `LibraryActions.vue` 注入 App 的 musicLibrary 和 songActions，在全部旧歌曲入口提供共享心形与更多菜单；只在云端确认后改状态，等待时禁用重复点击，菜单沿原管理器互斥。
- `LibrarySongs.vue` 是发现、我的音乐和版本列表的通用歌曲列表，默认显示序号，主动进入批量操作后显示复选框与所选下载/添加；完成、失活或资源变化清除选择。支持播放、收藏及分享，来源与所属账号参与当前歌曲识别。
- `SongDetailsPanel.vue` 承载歌曲、专辑、歌单评论及其他版本；`SongDetailsPanel.css` 为其 scoped 杂志式封面头、分类/热词、评论署名、回复层级、加载骨架与空态样式。歌曲分类、热词、回复分别分页，切换资源或隐藏取消旧请求；实例首次打开后保留，内部 visible 驱动真实进退场与快速反向，离场完成后还焦点且不抢新弹层焦点，强制卸载同样保护焦点。
- `PlaylistDialog.vue` 负责新建/私密、添加歌曲、收藏公开歌单、删除或取消收藏；确认真实 listId 和完整目录，失败保留表单，系统收藏目标不可删除。
- 歌单复合操作全过程核对同一账号；未知创建/收藏结果先读回核实，防止重复建立；收藏缺失曲目分批补齐并核对最终列表，确认绑定与候选系统收藏均拒绝删除。PlaylistOverview 只用公开全局 ID，不以自有 listId 查询公共详情。
- `PlaylistOverview.vue` 独立读取公开歌单简介、评论入口及相似歌单，不影响主曲目加载，卸载取消请求。
- `DownloadsView.vue` 展示主进程确认的账号任务状态，提供暂停、继续、取消、重试、补全附加信息副本及文件定位；状态订阅在卸载解绑。
- `MusicDownloadSettings.vue` 编辑既有 download 草稿，目录通过原生选择器获得，保存后才影响新任务；浏览器预览禁用系统功能。
- `AudioEffectsSettings.vue` 展示主进程确认的 VST3 插件库、串联效果链、原生插件窗口与当前歌曲 BPM；缓冲通过 AnimatedSelect 选择 64/128/256/512ms（默认 128ms），展示实际已保存缓冲与插件自身延迟。缓冲、添加、移除、排序、旁路、窗口置顶及手动速度使用固定 `electronAPI.audioEffects` 接口，不将链复制到父级设置草稿。管理动作先等待 `beforeAction`，扫描取消可在扫描请求未结束时执行；先订阅再读快照，以单调 revision 拒绝迟到结果，卸载只解绑、不停止后台效果。
- 音效 BPM 仅对当前曲目设置，手动输入限定 20–400，支持倍速数值校正和恢复自动分析；不会改变歌曲播放倍率。尚未识别时显示空值，并说明同步效果暂用 120 BPM。保存期间切歌拒绝旧曲目的迟到操作，输入失败保留草稿；未保存状态提供独立重试入口，待应用修改明确提示仍使用上次成功的链。插件延迟和按采样率对齐的约 64ms 音频缓冲分别显示。浏览器或不支持的平台禁用原生能力，插件链排序保留拖动与键盘按钮，显示变化遵循减少动态效果。
- WindowedList 默认使用 `.list-page` 为滚动容器，LibrarySongs 通过 scrollContainerSelector 指向实际的 `.library-page` 或 `.song-panel-body`，保证主页面与侧栏超过窗口化阈值后仍能访问全部歌曲。

- AnimatedSelect 通过 `modelValue/options` 接收选项和值，`update:modelValue` 与 `change` 返回选项原始值，不产生原生 change Event；保存仍由调用方负责。DropdownMenu 与既有右键/歌词菜单共用 contextMenuManager，选择后立即执行动作，退场层禁用输入；支持方向键、Home/End、文字查找、Escape/Tab 与焦点恢复。
- 选择器弹层按实际未变换尺寸测量并限制在视口内，选项过多可滚动；祖先 fieldset 禁用、inert/hidden、页面失活与卸载均关闭并释放监听。ThemeStudio 的弹层带主题安全标记与固定配色，避免自定义 CSS 隐藏编辑入口；减少动态效果保留可见选中反馈。
- props 为 visible、position 和 items，关闭通过 close 事件反馈。
- item 支持 label、icon、divider、disabled、action 和 shortcut。
- 点击可用菜单项先还原触发控件焦点并锁定离场菜单，再执行 action 并通知父级关闭；选择期间不能重复执行，Arrow/Home/End 导航和 Enter/Space 激活可用项，Escape/Tab 关闭并归还焦点，外部点击关闭不抢焦点。菜单按键停止冒泡，避免动作同时触发播放器快捷键；菜单保留真实退场，快速重开重新测量并解除旧锁定。
- 打开或坐标变化后，在 nextTick 测量菜单并限制在视口内。
- SVG 文件、data SVG 和路径字符串使用对应图标渲染方式。
- ThemePackages 的 modelValue 是 custom 设置分组，通过 update:modelValue 交给父页面保存；包格式由 themes 模块校验，不持有独立设置来源。
- ThemeAdjustments 使用 themes/themeAdjustments.js 克隆完整主题，创建或复用唯一的个性包，保留原主题及 CSS；分组恢复只影响该组令牌，颜色支持 rgba 透明度。
- 外观分组和高级 CSS 使用 AnimatedDetails；搜索结果和主题包卡片使用有稳定 key 的进入、离开及移动过渡，动作结果按序号重新反馈。折叠高度从当前可见值衔接，动态内容缩小时重新测量，减少动态效果立即完成；卸载释放动画、观察器及偏好监听。
- 打开 ThemeStudio 前先排空设置页保存；面板与拾取监听由 App 承载，导航不会丢草稿，可拾取 body 中的歌词/队列/菜单，按页面和语义 class/id 生成选择器。区域输入更新同一高级 CSS 文本，清空属性恢复继承。
- ThemeStudio 预览只调用 themeManager，不持久化且 30 秒自动恢复；应用经 settings store 保存完整主题包，失败保留草稿。保存期间禁用表单与关闭，普通 div 承担有限高度滚动；退出取消预览并释放监听/计时器。
- ThemeStudio 关闭立即取消拾取和预览并锁定输入，面板退场完成后才发出 close 供 App 卸载；收起保留表单与草稿，以高度过渡隐藏并禁用其中交互。匹配框和桌面预览保留原状态过渡，拾取指导及保存结果交给 AppNotice。
- ThemeRecovery 通过 Ctrl+Alt+Shift+R 切回当前明暗内置主题，保留安装包；正常播放无常驻恢复入口，编辑入口只留在设置。恢复前经 App 与设置页握手，排空已有事务并丢弃主题草稿，避免防抖重选坏主题；保存失败保留安全预览和统一通知中的重试入口，其他偏好草稿保留。
- ThemeRecovery 复用 NotificationRoot 受保护的通知层，工作期间去重并禁用通知动作与关闭；成功持久化后才取消安全预览，失败仍可重试。重复恢复使用序号替换旧消息，卸载释放快捷键监听及保存事务，迟到结果不发布通知或取消新预览。
- 导入限制文件大小与数量；导出用 Blob 下载主题快照，卸载忽略未完成文件读取并释放下载 URL/定时器。
- AppUpdates 的 modelValue 为 `software.updates`，通过 `update:modelValue` 返回父级草稿，`beforeAction` 排空既有保存，`current-version` 同步实际版本。只通过 `electronAPI.updates` 调用固定操作，不持有独立设置 store；下载仅提交已提供的资产 ID。
- AppUpdates 先订阅再读取状态快照，按 revision 拒绝旧响应，卸载仅解绑、不取消后台任务；重开可恢复下载进度和资产选择。更新说明按纯文本显示，发布页只允许固定项目路径；Linux 可在 AppImage 下载后改选 DEB/RPM 再下载。
- AppUpdates 的状态卡片显示已提交渠道、客户端架构和可识别的 Linux 安装格式。偏好控件仍编辑父级草稿。当前 Linux 安装格式缺少匹配包时提示手动选择。真实百分比与字节数来自服务快照，尚未获得进度时使用原生不定进度条。更新说明默认展开，长说明可键盘聚焦滚动。版本、文件名和错误可换行，窄容器改为单列。
- AppUpdates 的版本、进度、完成文件、动作按钮和发布信息保留状态过渡，操作失败与结果经 AppNotice 通知；更新说明与来源保留原生 details 开合。操作按钮离场立即 inert，快速回到原状态恢复交互，动画不触发安装或取消后台任务。
- DesktopLyricSettings 用 AnimatedDetails 收纳选项，AnimatedSelect 保留字号、样式、对齐及阴影来源的受控值；原生 checkbox/range/color/text 提供键盘与标签入口。仅显示歌曲信息时暂停歌词内容选项，节能模式暂停装饰动画选项，悬停淡化与阴影子设置跟随对应开关禁用，保留原偏好以便恢复。字体恢复只清空字体，文字颜色恢复只清空三类颜色，阴影恢复只更新参数，不覆盖窗口位置或其他设置。
- 桌面设置的打开和找回动作先等待 beforeAction 排空设置保存，再调用固定的 show/resetPosition；等待期间去重，失败显示可重试提示，卸载后不再执行迟到的窗口动作。浏览器禁用窗口按钮；偏好本身继续使用页面原有保存与错误重试流程。
- IslandLyricSettings 不建立独立 store，五处选择入口复用 AnimatedSelect/DropdownMenu 的鼠标、键盘和动效。左右内容预设由 leftContent/rightContent 推导，不保存重复字段；Logo 显隐独立，字体和单项颜色恢复不改写其他偏好，选择屏幕同时清空旧浮动位置。
- IslandLyricSettings 与 TaskbarLyricSettings 各自位于独立设置面板，启用、模式或嵌入、屏幕等常用项直接展示；内容、布局、字体、隐藏或尺寸等细项使用 AnimatedDetails 默认折叠。切换分类只隐藏面板，组件草稿、展开状态、服务订阅和进行中动作保持。
- 灵动岛先订阅 onDisplaysChanged 再读取 getDisplays/getCapabilities，热插拔代次优先于迟到快照，断开屏幕不覆盖已保存选择；读取失败可重试，卸载解绑并拒绝迟到响应。外部全屏检测依能力启用，浏览器禁用系统窗口控件。手动启用先更新草稿，再与重新显示共用排空父级保存后的 3 秒预览；关闭只保存偏好。等待期间关闭选择器并防止重复窗口操作，结果及错误交给 AppNotice，读取失败的重试按钮保留在通知中。
- PlaylistCacheSettings 的“更改位置”先排空设置草稿，再调用无参数 `electronAPI.playlistCache.chooseDirectory()`；主进程选择父目录并迁移至其 `offline-playlists` 子目录，组件不直接编辑路径配置。该操作覆盖全部账号且不要求登录，取消不报告成功；状态恢复实际路径、复制/校验进度、迁移失败和旧文件清理警告，离页不取消迁移。

- LyricSettings 只编辑父级 playback 草稿，中文翻译复用 showTranslation；管理入口和 LyricLibrary 的每次读写均先排空 beforeAction。关闭管理后不读取库，原文件保留；浏览器预览禁用歌词库能力，内容处理选项仍可编辑。
- LyricLibrary 的版本选择器先预览，点击“使用此版本”才切换播放来源；保存创建并选中编辑副本，时间/行结构改变后提示服务已重置原翻译和读音。脏草稿禁用曲目/版本切换和刷新，关闭需显式放弃，写入失败保留草稿；外部变更只提示刷新，不覆写编辑。LyricSettings 转发 prepareLeave，正文未保存或仍在读写时阻止离页并展示提示；内部 beforeAction 仍只排空偏好，避免递归。读写去重，卸载解绑通知并拒绝迟到响应，管理操作与结果均有状态动画。

## 关键保障

- 通用组件的成功、失败、警告及操作结果统一交给全局 `AppNotice`，由 Fue 通知组件在右下角展示；不再渲染局部反馈条、错误气泡或结果段落。通知保留原消息来源、重复反馈序号及重试/补全等动作和禁用条件。实际下载/扫描进度、控件状态、空内容和静态说明仍在所属界面展示。
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
