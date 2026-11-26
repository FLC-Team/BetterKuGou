# BetterKuGou 活跃安装统计服务

独立的 Node.js 服务接收活跃安装报告，使用 SQLite 统计今日和近 30 天的活跃安装数、软件版本及系统和架构分布。配置域名反向代理后，客户端向 `https://betterkugou.flcserver.cn/telemetering` 上报。

- `server.cjs` 负责 HTTP 接入、管理员鉴权和服务生命周期。
- `activity.cjs` 根据协议校验报告字段，并按上海时区确定统计日期。
- `store.cjs` 维护每天每个安装的最新报告，以随机安装 ID 的 SHA-256 摘要去重。
- `contract.spec.cjs` 使用本机 HTTP 和临时数据库验证接口协议。
- `data/` 存放服务生成的数据库，已从版本控制排除。

## 运行和测试

需要 Node.js 24 或更高版本，使用内建 SQLite，无第三方依赖。在项目根目录执行以下命令。

```sh
npm --prefix telemetering start
```

默认监听 `127.0.0.1:8787`，可用 `TELEMETRY_PORT` 修改端口。数据库默认保存在 `telemetering/data/activity.sqlite`，可用 `TELEMETRY_DB_PATH` 指定持久化路径。服务进程需要数据库目录的读写权限。需要查询统计时，通过运行环境设置 `TELEMETRY_STATS_TOKEN` 并把凭证只交给管理员。

```sh
node --test telemetering/contract.spec.cjs
```

## 上报约定

桌面客户端在「设置 → 应用 → 隐私与使用统计」提供「分享使用统计」开关，默认关闭。同一页面可预览及清空本机待发送的 JSON。关停后会取消在途请求，服务端已收到的报告仍按其保留期处理。

客户端在用户主动同意后为本机生成随机安装 ID，升级沿用，同步或导出设置时排除此标识。关闭统计后停止上报并清空待发数据。安装 ID 独立于酷狗账号，不使用硬件编号。每个上海自然日，用户主动打开主界面或实际播放时才记为活跃。持续播放跨过午夜后计入新一天，开机自启后一直挂在托盘不计入。

向 `/telemetering` 发送 `POST`，设置 `Content-Type: application/json`，请求体上限 4 KiB。字段如下。

| 字段 | 约定 |
| --- | --- |
| `schema_version` | 数字 `1`。 |
| `install_id` | UUID v4。 |
| `activity_date` | `YYYY-MM-DD`，按 Asia/Shanghai 取实际活跃日期，支持补发今日及此前 29 个自然日的报告。 |
| `revision` | 正整数。每份安装每天从 `1` 起，同日实际使用的版本或环境变更时递增。重试沿用原值及原内容。 |
| `app_version` | 当前实际运行的应用版本，使用 SemVer，最多 64 个字符，例如 `1.0.1`。 |
| `os_family` | `windows`、`macos`、`linux`。 |
| `os_version_group` | 可省略，默认 `unknown`。Windows 使用 `10`、`11` 或 `older` 字符串。macOS 使用发行主版本号，Linux 使用内核主版本号，格式均为字符串 `1` 到 `99`。 |
| `os_arch` | 系统原生架构，`x64`、`arm64`、`ia32` 或 `unknown`。 |
| `app_arch` | 当前应用进程架构，使用相同枚举。ARM64 Windows 上运行 x64 安装包时分别填 `arm64` 和 `x64`。 |

只发送约定字段。以下 PowerShell 示例为当天生成一个测试安装 ID，写入本地运行的服务。

```powershell
$activity = @{
  schema_version = 1
  install_id = [guid]::NewGuid().ToString()
  activity_date = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd')
  revision = 1
  app_version = '1.0.1'
  os_family = 'windows'
  os_version_group = '11'
  os_arch = 'arm64'
  app_arch = 'x64'
}
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/telemetering' -ContentType 'application/json' -Body ($activity | ConvertTo-Json)
```

成功返回 `204`，无响应体。重复提交同一份报告只计一次，较旧的修订号不会覆盖较新的环境。格式、字段或日期无效返回 `400`，请求体过大返回 `413`，媒体类型不支持返回 `415`。

## 查询统计

在服务器本机访问 `GET /telemetering/stats`，通过请求头 `Authorization: Bearer <管理员令牌>` 鉴权。未配置令牌时该接口返回 `404`。

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/telemetering/stats' -Headers @{ Authorization = "Bearer $env:TELEMETRY_STATS_TOKEN" } | ConvertTo-Json -Depth 8
```

`as_of` 给出统计日期，`time_zone` 为 `Asia/Shanghai`。`today` 覆盖当日，`last_30_days` 覆盖当日及之前 29 个自然日。每段统计均返回去重后的 `active_installs` 和三组分布。每个桶的 `count` 除以同一窗口的 `active_installs` 即为占比。

| 分布数组 | 每项字段 |
| --- | --- |
| `versions` | `app_version`、`count` |
| `systems` | `os_family`、`os_version_group`、`count` |
| `architectures` | `os_family`、`os_arch`、`app_arch`、`count` |

顶层 `daily_active` 按日期顺序给出近 30 天每天的 `activity_date` 和 `active_installs`，没有活跃记录的日期返回 `0`。每份安装按窗口内最后一次活跃时的环境归类，因此同日升级只占一个版本，连续使用 30 天也只计一份。活动数据只保留在统计窗口内。统计范围为参与上报的安装，同一个人在两台电脑使用会计为两份安装。

## 接入域名

在 `betterkugou.flcserver.cn` 已配置 HTTPS 的 Nginx `server` 块中，仅把上报路径转发到本机端口。管理端点只从服务器本机查询。公开上报可按来源限速，以下示例的限速区域放在 `http` 块，阈值可按实际流量调整。

```nginx
limit_req_zone $binary_remote_addr zone=bk_telemetering:1m rate=10r/s;
```

```nginx
location = /telemetering {
    if ($request_method != POST) { return 405; }
    limit_req zone=bk_telemetering burst=50 nodelay;
    limit_req_status 429;
    client_max_body_size 4k;
    access_log off;
    proxy_pass http://127.0.0.1:8787;
}

location ^~ /telemetering/ {
    return 404;
}
```

数据库存放在站点公开目录之外，持久化服务可以独立重启。客户端上报和域名反向代理分别由桌面端和服务器接入。
