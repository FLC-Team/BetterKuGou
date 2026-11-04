# vendor 速查

- `fue-ui-0.1.0-bk.1.tgz`：基于 Fue UI 0.1.0 源码构建的本地分发包，通知使用 `FueMessageProvider` 及其原版 `FueAlert`。保留原库完整 CSS、倒计时进度、悬停暂停、关闭守卫、入退场和堆叠动画，不另写气泡。
- 唯一集成扩展是 Message 的 content 接受 `string | (() => VNodeChild)`，供 AppNotice 放入原库 FueButton 动作；字符串继续按纯文本渲染。补丁由 `scripts/build-fue-vendor.mjs` 显式执行并同步声明，不手改压缩产物、不修改外部 Fue 目录。
- 通过 `package.json` 的相对 `file:vendor/fue-ui-0.1.0-bk.1.tgz` 依赖和 lockfile 完整性校验安装；普通安装无需外部源码目录，不额外引入 Vue 副本。
- 更新包：`node scripts/build-fue-vendor.mjs <Fue源码目录>`（要求 0.1.0 源码及其已生成声明）→ `npm pack ./.agent/tools/fue-package --pack-destination vendor --ignore-scripts` → 使用 npm 更新本地固定依赖并验证通知行为。构建暂存位于 `.agent/tools/fue-package`。
