# api 速查

## 职责

封装 `http://localhost:6500` 的 Axios 请求，向页面和播放器提供业务接口。
本目录没有子目录。

## 直接文件

- `auth.js`：验证码、账号/手机/二维码登录及本地登录信息保存、读取和清理。
- `music.js`：歌曲、歌词、推荐、排行、歌单、搜索、歌手、专辑和封面请求。
- `library.js`：复用音乐 Axios 客户端的发现、搜索辅助、账号歌单读写、历史、关注新作、评论、往期推荐/榜单、其他版本及云盘接口；普通调用保留原响应，完整分页方法返回规范化资源数组。

## 调用与状态

- Axios 响应拦截器返回 `response.data`，调用方检查业务状态字段。
- `auth.js` 请求超时为 10 秒，认证信息从 LocalStorage 读取。
- `music.js` 为需要登录的请求附加已保存的酷狗认证信息。
- `libraryRequest` 在发出前捕获账号并附加 Cookie，发送拦截器和响应均核对账号；认证必需时拒绝访客，业务失败与未确认写入不会被当作成功。所有新接口支持 AbortSignal，错误消息不拼入上游正文或凭证。
- `completeLibrarySongs` 为历史等列表补齐播放标识和展示资料：缺 hash、曲名或封面且存在曲库 ID 时，每批至多 50 条调用 `/krm/audio`，剩余有 hash 的缺图条目通过 `/privilege/lite` 补图；全程核对同一账号及 AbortSignal。仅填空字段，保留原权限、fileid、云盘账号和原文件名，不启动播放器取流或音频下载，也不保留权限响应中的音源地址。必要播放身份补全失败交给页面重试，纯展示资料失败记入脱敏日志并保留可播放列表。
- `getAllUserPlaylists` 使用用户目录接口默认的 30 条页长，调用方可指定更小的正整数；无明确 `total/count` 时短页结束、满页继续，不把首批短页当成新的页长，也不将 `list_count/collect_count` 相加推断总数。有明确总数且尚未取完时仍适配服务端限页长；缺数组继续报错，不能作为空目录发布。
- `getAllPlaylistTracks` 保留按首批真实页长适配服务端限页长的行为。两类分页均拒绝重复页、格式异常和不完整结果；格式错误 `INVALID_LIBRARY_PAGE` 的 `cause` 仅提供端点、页码、页长、已读数量及固定字段类型，不包含账号和歌单正文。
- 账号目录资源标为 `source: owned`，与可编辑的 `isOwned` 分开；仅账号目录、本人或已确认收藏资源通过 `/playlist/track/all/new` 使用 `listId`。公共曲目通过 `/playlist/track/all` 使用 `globalCollectionId`，不能把创建者 listid 当本账号歌单；删除不能以 hash 替代 `fileid`。
- 歌单写入使用 JSON POST；新建的 type/source 是数值，添加曲目通过结构化 songs 保留名称中的分隔符；收藏保留来源创建者和来源歌单 ID。`uploadPlayHistory` 将有效曲库 ID 作为 mxid、秒级时间作为 time，不将 hash 或播放进度写入历史。
- `getCloudSongUrl` 仅接受当前账号所属云盘歌曲，传入原始文件名和 audio_id，规范返回为播放器使用的 status/url；不假设云盘支持普通音质切换。
- `getLyric(hash, album_audio_id, keywords, options)` 先搜索候选再取详情；按明确 hash/音频 ID、规范歌名与歌手证据分为 exact/high/medium/any，优先选择匹配更高的有效候选。返回仅含候选 ID 和匹配等级的 lyricSource，不携带搜索访问密钥；options.song 使用既有元数据解析，options.signal 贯穿搜索与详情。
- `getRankInfo()` 读取榜单介绍；`getRankSongs(rankid, page, pagesize)` 从 `/rank/audio` 读取曲目，返回 `data.songlist` 和总数，页面按总数分页，不能把介绍中的摘要当作可播放歌曲。
- `getRankSongs` 的第四参数支持 `rankCid` 与 `signal`；`searchMusic` 的第五参数支持 `signal`，原调用参数保持兼容。
- `getSongUrl(hash, album_id, album_audio_id, quality, options)` 提供播放器使用的旧版播放地址封装，普通音质限于字符串 128/320/flac/high，缺省或非法值回退 128；不请求试听，不将魔法音乐或蝰蛇音效作为普通音质。
- `getSongDetail(hash, options)` 和 `getSongUrl` 的可选 `options.signal` 直接传给 Axios；切歌取消时终止旧 HTTP 请求，省略该选项保持原调用行为。
- `findArtistByName(name)` 只查询被选中的单个姓名，按 Unicode、空白和大小写规范化后精确匹配搜索结果，并要求有效歌手 ID；无匹配返回 null，请求或响应格式失败继续拒绝 Promise，由歌手页面显示重试入口。

## 关键保障

- `KUGOU_AUTH_EXPIRED_EVENT` 通知 App 处理业务错误 `20017`，避免维持失效登录状态。
- 音乐请求以 WeakMap 保存发出时的账号身份；旧账号迟到的认证失效响应仍拒绝该请求，但不登出当前新账号。
- 歌曲 `hash` 是播放、队列定位与封面查询的重要标识。
- 保留现有端点、请求字段和业务状态判定，不将 HTTP 成功等同于业务成功。
- 异常通过 logger 记录并继续拒绝 Promise，不在封装层吞掉失败；预期的 Axios 请求取消只继续拒绝，不记录错误或触发认证失效。
- Token、密码、Cookie、二维码密钥和个人信息不得进入日志。

## 运行

项目启动与验证说明见 [BK.md](../../BK.md)。
