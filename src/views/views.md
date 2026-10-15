# views 速查

## 职责与子目录

维护页面级组件；App 通过本目录公共出口选择页面。
- `logic/`：Artist、Favorite 页面 Options API 业务逻辑。
- `styles/`：复杂页面外置 scoped CSS。

## 直接文件

- `index.js`：页面公共导出。
- `HomeView.vue`：音乐杂志式首页，每日推荐封面主视觉、私人 FM、精选歌曲与独立榜单区；引用外置 scoped 样式。
- `LoginView.vue`：手机、账号和二维码登录。
- `SearchView.vue`：搜索、分页、歌曲操作与播放事件。
- `FavoriteView.vue`：收藏与普通歌单共用的列表模板，引用独立逻辑与样式，支持当前歌单刷新。
- `ArtistView.vue`：歌手页模板，引用独立逻辑与样式。
- `AlbumDetailView.vue`：专辑信息、曲目和播放入口。
- `RankDetailView.vue`：排行详情和曲目播放。
- `PersonalFMView.vue`：私人 FM 内容与播放。
- `DailyRecommendView.vue`：每日推荐与全部播放。
- `SettingsView.vue`：设置编辑、目录选择、主题包管理、设置导入导出及快捷键配置。

## 数据流与保障

- 页面调用 api 封装，规整歌曲字段后发出 play/play-all/play-next/navigate 等事件。
- App 持有导航、登录与播放队列，页面不自行创建音频播放器。
- Home、Favorite、Artist、Album、Rank、Search、Daily 由 App 按资源缓存；页面往返复用数据、排序及滚动位置，真实登录会话变化时释放。登录、设置和动态私人 FM 不缓存。
- Home 收藏变更只刷新 AI 推荐；每日推荐在跨本地日激活时刷新，首次 mounted/activated 不重复取数，模块请求合并并拒绝旧账号或卸载结果。
- 首页激活仅补拉失败或过期模块，成功空结果同样缓存；AI 按实际前十首收藏 hash 去重，尾部及元数据变化不重拉，显式刷新仍可更新相同种子。
- 首页封面复用每日推荐响应，不新增请求；图片缺失或加载失败显示本地唱片排版，按实际尺寸隔离失败状态，资源刷新成功后允许重试。精选默认展示六首、榜单默认展示四项，均可展开全部；刷新保留已有推荐，首次加载显示骨架。原生按钮支持键盘操作，歌曲与歌手入口独立；根节点继续承担 App 的滚动缓存和播放器留白。
- 缓存页失活时关闭右键菜单，Artist 另外断开分页 Observer，激活后幂等恢复；不会让隐藏页继续触发分页。
- SettingsView 使用 settings store，临时编辑和主题预览不建立独立持久化来源。
- ThemePackages 通过 v-model 编辑 custom 分组；主题立即预览后沿用设置页保存流程，保存失败显示提示，会话广播后重放待保存的预览。
- LoginView 的计时器、轮询和过期请求在卸载时清理。
- 页面私有样式保持 scoped，高频调试信息使用 logger Trace。

## 运行

项目启动和验证见 [BK.md](../../BK.md)。
