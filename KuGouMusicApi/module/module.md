# module 速查

## 职责

每个直接 JavaScript 文件实现一个酷狗接口适配。服务按文件名将下划线转换为路由分段，模块接收已合并参数与上游请求函数，返回 HTTP 状态、响应体、Cookie 和可选响应头。当前目录没有子目录。

## 重要文件与约定

- `login*.js`、`captcha_sent.js`：登录、验证码与登录状态协议，沿用现有加解密工具。
- `user_detail.js`：当前账号资料读取；`user_update.js`：昵称、签名、性别、生日的显式修改，按上游独立用户服务进行 RSA 认证，不接受任意资料字段。保留 MIT 来源与根许可。
- `user_playlist.js`、`playlist_track_all*.js`：账号目录和公开/自有曲目读取，保留不同资源 ID 的语义。
- `playlist_add.js`、`playlist_del.js`、`playlist_tracks_add.js`、`playlist_tracks_del.js`：歌单和所选条目的写操作，结构化参数校验先于上游调用。
- 其他音乐、歌词、歌手、专辑、排行、评论和云盘模块按现有接口文件各自提供请求适配，不在此层建立新的账号或缓存状态。

## 关键保障与验证

模块复用 `../util` 的请求、签名及加解密能力；无效输入应在网络请求前拒绝。资料模块仅接收明确变化的字段，空签名/生日保留清空含义，不记录资料正文或凭证。接口说明见上级 `docs/README.md`，类型见上级 `interface.d.ts`。

项目根目录 `node --test tests/profile.test.cjs tests/library-api.test.cjs` 验证模块请求边界与校验，不调用真实账号服务。完整运行方式见上级速查。
