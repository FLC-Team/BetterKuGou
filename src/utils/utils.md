# utils 速查

## 职责

提供渲染进程共享工具；本目录没有子目录。

## 直接文件

- `logger.js`：日志级别过滤、统一脱敏、最多保留 500 条记录及主进程日志桥接。
- `themeManager.js`：主题包解析、旧 dark/light/system/custom 模式兼容、系统配色监听、完整 CSS 变量/限定作用域 CSS 应用、草稿预览取消及视觉快照导出。
- `objectUtils.js`：深拷贝、原地合并、响应式内容替换和可写副本。
- `contextMenuManager.js`：管理一个活动菜单关闭回调。
- `playbackQuality.js`：普通音质选项及菜单的名称/格式/短标签、偏好规范化及依据响应格式/码率（含驼峰历史字段）确认当前音源信息，缺少格式时读取实际首条播放地址路径扩展名；不读取查询参数/备用地址，不凭格式推断码率或以偏好推断实际无损。
- `playlistCache.js`：可选桌面缓存桥接、串行账号初始化与等待、会话代次及跨账号迟到结果隔离；不持有第二份响应式缓存状态。
- `desktopLyrics.js`：桌面歌词纯解析器，输出统一毫秒时间轴，支持 KRC 词级时序、LRC 重复时间标签、正负 offset 和 UTF-8 翻译，保留原始空格、Unicode 与文本尖括号。
- `lyricProcessing.js`：为显示生成歌词副本，使用 OpenCC 双向简繁转换、Intl 中文分词及基础中英文脏词遮罩；整句处理后分配回原 KRC 词区间，保留所有时间标签。读取来源提供的日文罗马音，按毫秒时间轴、重复标签和 offset 对齐。
- `songMetadata.js`：读取歌曲 VIP 徽标，兼容既有 `privilege` 的 8/10 数值与字符串、大小写字段和明确 VIP 标志；按歌曲、歌手、专辑的历史字段过滤歌曲，保留原数组与行对象。
- `songMetadata.js` 的 getSongSearchKeyword 优先读取明确曲名，再兼容 name/filename/FileName；识别已知单人或多人歌手前缀，保留标题中的连字符和版本后缀，文件名去除音频扩展名，空或非文本名称不生成关键词。
- `songMetadata.js` 的 getSongArtists 将可用歌手数组规范为独立 `{ id, name }`，兼容历史歌手/作者字段并去重；空数组不遮蔽其他数组，结构化姓名保持原样，缺失数组时仅按顿号和带空格斜线拆分合唱文本，单个歌曲级歌手 ID 不分配给多个人。

## 核心流程

- 设置应用调用 `applyTheme()`；system 模式监听系统变化，离开该模式时移除监听。
- 主题数据与校验统一在 `themes/`；切换整包重置视觉变量，并同步根元素 theme/themeBase 和 colorScheme。主窗口高级 CSS 经目录编译后只替换唯一 style，切回无 CSS 主题则删除；预览独立于持久化，在会话广播期间保持，取消后解析最新保存设置。导出包括主/桌面 CSS，不读取非视觉设置。
- `mergeDeep()` 原地合并对象、替换数组，undefined 字段表示删除。
- `replaceReactive()` 保持目标引用并移除来源中不存在的旧字段。
- 菜单打开时注册稳定关闭回调，关闭或卸载时取消注册。
- logger 对控制台、内存和 IPC 使用同一可序列化脱敏快照。
- App 通过 initializePlaylistCacheSession 设置账号；播放器和封面使用 waitForPlaylistCacheSession / callPlaylistCache 等待最新初始化。无桌面桥接或会话初始化失败时回到在线路径；迟到媒体能力不交给新账号，已取得的租约会释放。
- MusicPlayer 通过 `parseDesktopLyrics(content, rawData)` 生成桌面歌词；翻译先按原始有效歌词行关联，再展开重复时间标签与排序。正 offset 提前歌词，截到零点时同步校正词开始/结束与持续时间；KRC 无词标签时使用整行时长。可选翻译损坏仅忽略译文，不丢弃原文，不在解析层拆分 Unicode 字符或解析 HTML。
- `processLyricContent(content, rawData, playback)` 只返回显示副本，原始在线/保存版本不被改写。`preferSimplifiedChinese` 决定简体或繁体，`segmentLyrics` 只增加相邻中文词间空格，`showProfanity` 关闭时按内置基础词表替换星号；不保证识别所有变体或绕写。日/韩文原文保留字形，中文译文独立处理。`readLyricRomanization()` 仅返回日文歌词中可用的拉丁发音，不推测缺失读音或把中文拼音当罗马音。

## 关键保障

- 对象写入前递归拒绝 `__proto__`、`constructor`、`prototype` 字段。
- 日志不保存请求配置和凭证；错误保留必要的类型、消息、堆栈、原因和状态。
- 日志限制嵌套深度、字符串长度与数组大小，处理循环引用。
- 日志桥接失败不影响业务，且避免重复输出桥接失败提示。
- 不额外创建平行的日志、主题或菜单管理实现。
- 歌曲徽标不把未知权限码、音质/文件大小或账号会员状态推断为 VIP；只提供展示元数据，不声称实际可播放或修改权限。

## 运行

项目命令和工具测试见 [BK.md](../../BK.md)。
