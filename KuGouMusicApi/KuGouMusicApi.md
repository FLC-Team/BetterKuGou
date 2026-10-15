# 本地酷狗 API 速查

## 职责与直接子目录

基于上游 Express API 提供本地音乐、登录和用户接口，由 Electron 管理启动与退出。模块协议和外部酷狗服务调用保持兼容，避免无关改写。

- `module/`：各音乐及用户接口的上游请求实现，文件名映射为 HTTP 路由。
- `util/`：请求、签名、加解密、Cookie 与缓存等公共能力。
- `public/`：根路由等静态页面资源。
- `docs/`：上游接口使用文档。
- `.github/`：上游仓库自动化配置。

`node_modules/` 为安装生成的依赖目录，不维护模块速查。

## 重要文件

- `app.js`：服务启动入口；启动失败输出异常上下文并设置失败退出码。
- `index.js`：引用应用入口，供上游开发配置使用。
- `main.js`：程序调用入口，按模块文件导出接口函数，并暴露服务及请求能力。
- `server.js`：Express 构建、动态路由、参数适配、公开请求缓存、脱敏日志和 HTTP 监听。
- `package.json`、`package-lock.json`：本地 API 的独立依赖声明与 npm 锁定文件；根项目 `postinstall` 安装其生产依赖。
- `.env.example`：环境变量示例；真实 `.env` 不进入版本控制。
- `interface.d.ts`：上游程序调用接口类型声明。
- `README.md`：上游项目与接口说明。
- `nodemon.json`、`tsconfig.json`、`Dockerfile`、`vercel.json`：上游开发、类型及部署配置；桌面应用采用 Electron Utility Process 启动。

## 核心函数与流程

- `getModulesDefinitions()`：枚举模块 `.js` 文件，默认将下划线替换为路由斜杠，支持显式路由映射。
- `constructServer(moduleDefs)`：构建 Express 中间件和路由；可注入模块定义以验证参数、缓存和响应行为。
- `getSafeRequestUrl()`：直接解析原始 URL，对敏感查询字段脱敏，避免提前解码改变参数边界。
- `startService()`：读取 `PORT`、`HOST` 并等待监听成功，返回带 `service` HTTP Server 句柄的应用；监听失败拒绝 Promise。

HTTP 请求 → CORS、Cookie 和请求体解析 → 公开请求缓存 → 模块路由参数适配 → 上游请求工具 → 返回模块状态码、响应体、头及 Cookie。

## 兼容与安全保障

- 模块参数按 Cookie 默认值、请求体、查询参数依次合并；查询参数保留优先级，原始请求体同时保留在 `body`。
- 仅公开且无凭证、无请求体的 GET 可缓存；POST、认证请求和大小写不敏感的私有路由绕过缓存，并按 Origin 隔离 CORS 响应。
- 成功请求的诊断日志只在 `DEBUG` 开启时输出；错误日志保留路由、状态、错误码及脱敏后的标准异常类型、信息、堆栈和原因，不展开请求配置或认证响应。
- Token、密码、验证码、二维码 key、Cookie 及用户标识等查询字段脱敏，响应仍保持上游协议。
- 桌面应用固定监听 `localhost:6500`；独立服务的环境变量默认值不替代 Electron 的明确启动参数。

## 验证与运行

服务随 Electron 启动，桌面使用无需单独运行 API。项目根目录的 `npm test` 使用注入模块和临时本地 HTTP 端口验证参数转发、缓存隔离与脱敏，不调用真实酷狗账号服务；`npm run check` 检查本地服务入口源码，`npm run build` 验证桌面构建。
