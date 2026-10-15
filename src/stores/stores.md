# stores 速查

## 职责

维护唯一的渲染侧响应式设置与播放会话；本目录没有子目录。

## 直接文件

- `settingsStore.js`：默认设置、迁移、初始化、更新、导入导出及会话快照。

## 状态与接口

- `useSettingsStore()` 暴露稳定的 `settings` 引用和 ready/loading/error/revision 状态。
- `initSettings()` 复用初始化 Promise，优先读取 `window.settingsAPI`，浏览器回退 LocalStorage。
- 默认分组为 playback/download/custom/shortcuts/software/session，Schema 版本为 1。
- 当前版本的设置也按默认值补全缺失分组，保留已保存的用户选择。
- 主题包列表保存在 `custom.themePackages`，选择的包 ID 使用原 `custom.theme`；旧配置自动补全空列表，不迁移或删除已有配色。
- `updateSettings()` 默认合并，`overwriteSettings()` 替换，均保留响应式对象引用。
- `saveSessionSnapshot()` 合并队列、当前歌曲、索引及播放时间、音量和模式。

## 持久化流程

- 编辑先更新界面并记录 mutation 版本，持久化任务进入串行 Promise 队列。
- 每次执行保存时采集最新快照；成功后只移除已提交版本的编辑。
- 保存期间的主进程广播暂存，提交后叠加尚未提交的修改。
- 失败恢复最近已提交或重新读取的快照，只撤销失败调用及此前的修改。
- 后续编辑仍重放并排队保存，前一次失败不阻断后续任务。

## 关键保障

- 深拷贝与合并经对象工具验证，拒绝原型污染字段。
- 主题在设置应用与编辑时同步更新；本机目录由主进程提供，不写死用户路径。
- 浏览器持久化键为 `betterkugou_settings`，会话恢复开关由 App 执行。

## 运行

项目命令和设置测试见 [BK.md](../../BK.md)。
