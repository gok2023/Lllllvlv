# 观影统计：数据契约与维护

本页是统计功能的权威专题。当前实现接入 Jellyfin；操作入口见[开发流程](development.md#jellyfin-观影统计)。以下区分**当前代码事实**、**已验证环境**和**待验证或未来方案**。主进程同步和持久化见 [WatchStatisticsStore](../electron/core/watch-statistics.ts)，插件契约见[查询与解析](../electron/core/watch-statistics-playback-reporting.ts)，展示计算见[统计页面](../web/watch-statistics.js)，类型见[共享模型](../src/shared/watch-statistics.ts)。

## 数据链路与来源

```mermaid
flowchart LR
    J["A：Jellyfin Views / Items"] --> M["媒体库、作品与用户观看状态"]
    P["B：Playback Reporting HTTP"] --> R["逐次播放记录"]
    DB["C：本机插件 SQLite，Windows 回退"] --> R
    M --> S["主进程合并、确认与估算"]
    R --> S
    S --> F["D：项目快照、确认、估算"]
    C["D：旧档案独立修正文件"] --> V["展示层"]
    F --> V
    V --> E["版本化 JSON 导入导出"]
```

「设置 → 统计」的 React 路由承载统计 iframe，页面通过受限 `postMessage` 桥与预加载 IPC 请求主进程；[统计页面](../web/watch-statistics.js)负责筛选与展示聚合，主进程负责读取和持久化。应用打开或 Jellyfin 网页登录后触发增量同步；播放停止并等待插件写入后再次同步，统计页打开时约每 60 秒检查一次，后台另有周期增量检查。手动完整同步在主进程后台运行，页面通过状态与完成事件刷新。

| 类别                    | 当前接口与必要字段                                                                                                                                                     | 类型、含义与边界                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 核心媒体库目录        | `Users/{userId}/Views` 的 `Items[].Id/Name`                                                                                                                            | ID 字符串、名称字符串；包括空库。用于归属目录，不是逐次观看证据。Jellyfin 10.11.11 中该路由仍可用但已标记废弃，委托 `UserViews?userId=`。                                                                                                                                                                                                                     |
| A 核心媒体及用户状态    | `Users/{userId}/Items` 分页或指定 `Ids`；`Id/Type/Name/ParentId/SeriesId/ParentIndexNumber/IndexNumber/RunTimeTicks/ProductionYear/Genres/People/ProviderIds/UserData` | ID、名称、类型是字符串，季集号、年份、ticks 是数字，genres 是字符串数组，People 是对象数组，ProviderIds 是字符串映射；ticks 为 100 ns，换算秒。`UserData.Played` 是布尔，`PlayCount` 是数字，`LastPlayedDate` 是时间文本，`PlaybackPositionTicks` 是数字。`PlayCount` 不推算重温次数。该旧路由在 Jellyfin 10.11.11 仍可用但已标记废弃，委托 `Items?userId=`。 |
| B 插件 HTTP             | Playback Reporting `POST user_usage_stats/submit_custom_query`，`CustomQueryString` 查询 `PlaybackActivity`，`ReplaceUserId: false`                                    | 响应有拼作 `colums` 的字符串列名数组、`results` 的二维数组和 `message` 字符串。数据库单元格经插件序列化为字符串，Freebo 显式将 `PlayDuration` 转成数字。插件接口需要管理员权限。                                                                                                                                                                              |
| C 本机 SQLite           | `System/Info.ProgramDataPath` 辅助定位；Windows 本机 `playback_reporting.db` 的 `PlaybackActivity`                                                                     | B 失败后本机只读查询九列：`DateCreated` 为 DATETIME，经 SQL 转 TEXT；`UserId/ItemId/ItemType/ItemName/ClientName/DeviceName/PlaybackMethod` 为 TEXT，`PlayDuration` 为 INT。手动路径及 System/Info 候选会先于进程核实，因此仅自动进程候选可称为端口归属核实。                                                                                                 |
| D Freebo 派生与用户资产 | `WatchStatisticsSnapshot`、`WatchConfirmation`、`WatchBackfill`、`corrections`                                                                                         | `records[].durationSec`、估算时长与运行时长为秒数；`startAt`、`baselineAt`、`confirmedAt` 为时间字符串；确认 ID、作品 ID、记录 ID 为字符串；修正是记录或作品 ID 到媒体库 ID 的字符串映射。它们不是上游原始字段。                                                                                                                                              |

### 哪些事实必须随档案保存

| 数据 | 时间与可恢复性 | 同步和统计的责任 |
| --- | --- | --- |
| 媒体名称、季集、外部标识、片长、当前库 | 反映最近一次取得的目录，离库后上游可能无法重取 | 更新元数据，保留离库作品及其历史。系列、季和具体单集分别建档，剧场版采用 Jellyfin 给出的媒体类型。 |
| Played、PlayCount、进度与最近播放时间 | 当前用户状态，可由 Jellyfin 再取。手动勾选也会产生 Played | 只有合资格的电影或具体单集应用首次确认规则。系列内其他集的状态、进度和播放次数不生成该集的观看次数。 |
| 插件逐次播放与时长 | 有事件起点和累计播放秒数，保留期过后可能只剩本地副本 | 保存原始时间文本、事件 ID、已解释的起点和秒数。时长可随同一条上游记录更新。多次短播各自贡献有效时长。 |
| 首次确认、重温确认、待处理决定、撤销与操作 ID | 属于本地资产。确认时间是操作时间，通常无法还原历史观看日期 | 由确认条数计算全部时间的部次、集次与刷次。保留证据 ID、忽略及撤销结果，让再次同步或导入可以追溯。 |
| 历史补录和手动估算 | 本地资产，基线时间用于防止与迟到的旧实播重复计时 | 全部范围按固定基线、已知证据和有效估算计算。近期范围、日历、设备和活跃时段使用有事件时间的实播。 |
| 人工作品关联、记录与作品的库修正 | 本地资产，Jellyfin 无法重建 | 保留原证据 ID 并按逻辑作品引用，展示时优先使用记录修正。跨服恢复后应复核目标库是否存在。 |

上述 A 类旧路由的废弃标记与委托关系见 Jellyfin [ItemsController](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/ItemsController.cs) 和 [UserViewsController](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/UserViewsController.cs)；后续应评估改用新路由，不能把当前接口写成已失效。B/C 的权限、响应及表结构见插件 v17 [控制器](https://github.com/jellyfin/jellyfin-plugin-playbackreporting/blob/v17/Jellyfin.Plugin.PlaybackReporting/Api/PlaybackReportingActivityController.cs)和[仓库](https://github.com/jellyfin/jellyfin-plugin-playbackreporting/blob/v17/Jellyfin.Plugin.PlaybackReporting/Data/ActivityRepository.cs)。插件的时长来自未暂停的墙钟时间累计，详见 [PlaybackTracker](https://github.com/jellyfin/jellyfin-plugin-playbackreporting/blob/v17/Jellyfin.Plugin.PlaybackReporting/Data/PlaybackTracker.cs)；因此跳转、异常结束等情况下不应宣称它精确等于实际观看的不同画面长度。插件的按日 `GetItems` 会把时间格式化为不含秒和完整日期的显示文本，不能无损替换当前原始记录与 ID；聚合报表也不等于逐次历史。

当前 `Items` 全量扫描按媒体库递归分页（每页最多 500），启用 `EnableUserData`，限制 Movie/Series/Season/Episode，并请求 Genres/People/ParentId/ProviderIds；这些参数符合已核接口，缺省可选字段由代码兜底，属于合理的当前实现，应保留。

## 本地资产与身份

媒体目录通常可从服务器重取；插件历史过期或清理后，原始逐次记录可能无法重取；本地确认、估算、修正和操作历史无法从服务器重建。备份必须包含快照、独立修正与用户导出。

快照位于用户数据目录 `watch-statistics/<serverId>-<normalizedUserId>.json`，包含媒体、原始记录、估算 `backfill`、确认 `confirmations`、候选 `candidates`、已应用操作 ID、撤销确认 ID、人工作品关联 `identityLinks`、设置、媒体库目录及增量游标。当前写入将单次记录和作品的媒体库修正保存在快照的 `corrections`。旧快照缺该字段时读取 `<快照路径>.corrections.json`；`playback-reporting-paths.json` 保存按服务指定的数据库路径。它们及用户导出的版本 3 JSON 都是用户资产，不能因全量扫描、设置写入、升级或清理缓存而丢弃。导入支持版本 1、2、3 及本程序原始 `.backup`；预览显示档案规模与同 ID 冲突。无冲突合并保留双方不同资产，同 ID 的事实矛盾时拒绝合并。同一候选状态的证据按 ID 取并集；替换以导入文件为准。写入前备份含有效修正的原档案视图，替换失败时尝试恢复原快照；原子重命名不提供停电持久性保证。暂存档案绑定用户时合并档案及修正。

人工关联只用于用户确认的同一作品换源：选择旧作品和当前作品，必须为同类型的现有项目，目标属于当前服务；已指向不同目标的关联被拒绝。观影资产立即归入目标作品，关联规则保存于快照并用于后续同步；原始播放记录 ID 不重写。不可仅凭相同标题自动建立关联。跨设备导入、媒体库 ID 不同以及真实用户数据的恢复仍须先用隔离档案验收，逐项结果见 [观影档案维护验收](watch-archive-maintenance.md)。

跨服务恢复先把旧媒体 ID 放入 `legacy:<原服务ID>:<原ID>` 命名空间，再用唯一且无矛盾的 provider 身份匹配电影、系列；单集还须系列唯一匹配且季集号一致。无法可靠匹配时保留旧档案，供用户人工关联。同 ItemId 的强标识互斥时，保留事件和确认 ID，记录旧、新标识供核对重新刮削或 ID 复用；这两种情况仅凭目录无法区分。跨服务同名或裸 ItemId 相同都不构成身份。合并对同稳定 ID 的事实冲突发出提示。兼容的同状态候选可以汇总证据，旧档重复忽略的证据按 ID 保留一次；导入预览与实际导入使用同一规范化和冲突检查。原始记录 ID、确认 ID、估算基线及用户处理状态均保留。同步和导入按同一目标档案序列化；在途旧同步不能覆盖较晚的导入。导入的备份位置、恢复步骤、测试证据及未验证边界集中见 [观影档案维护验收](watch-archive-maintenance.md)。

Jellyfin ID 去掉连字符并转小写；文件按服务器 ID 与用户 ID 隔离。逐次记录 ID 由规范化用户 ID、作品 ID、原始 `DateCreated`、客户端名和设备名组成；`sourceKey` 保留后四者。改变字段、拼接、日期标准化或身份范围会影响去重、修正键、候选证据及导入后的继续同步，须先设计旧档案兼容。相隔一秒且源时间不同的事件分别保留。同一批插件响应若返回完整事件键相同的两行，同步报错并保存旧档，需核对插件原始记录。上游单次只提供一行时无法推断是否存在已合并的同键事件。SQLite 有 `rowid`，但当前查询未使用它，也不能假定它跨数据库重建稳定。

插件 `DateCreated` 可能不带时区偏移；当前代码把它按**运行 Freebo 的本机时区**解析为 ISO 时间，原始文本另存于 `rawDate`。重读已经匹配的事件保留档案中既有的 `startAt`。首次采集时服务与客户端时区不同时可能偏移；勿未经数据迁移改变解释方式。增量同步按快照 `cursor` 回看七天的插件记录，合并时按稳定 ID 去重；完整同步保留既有档案、确认和修正。超过回看窗口才写入或更正的旧记录需要手动完整同步核查。当前解析要求完整九列和合法行，仅识别插件 v17 的精确空结果消息配空列、空行；畸形响应走本机数据库回退，不能当空历史。

[路径定位器](../electron/core/watch-statistics-path.ts)先限定本机地址和 Windows，然后依次尝试保存的手动路径、`System/Info.ProgramDataPath`、监听端口所属 Jellyfin 进程的 `--datadir`/`-d`、Freebo 进程可见的 `JELLYFIN_DATA_DIR`、注册表 `DataFolder`、`ProgramData`、`LOCALAPPDATA`、已保存的自动路径。各候选均验证文件名与九列。手动路径和 System/Info 候选在进程核实之前；其余环境及系统目录候选也不能证明文件一定属于该进程。代理、容器、多实例和路径重用时必须人工核对。

完整扫描中，删除的作品保留旧元数据及原媒体库。重新入库仅在明确且唯一的 TMDb/IMDb/TVDb 类型标识匹配时重映射非单集作品；单集依已匹配的系列及季集号重映射。标题不能作为跨作品身份。修正展示优先级是单次记录、同 ItemId 作品规则、同步归属、未匹配；历史补录只用作品规则，单次修正不改原始作品元数据。

### 新作品进入档案的时机

| 触发 | 媒体目录 | 播放数据 |
| --- | --- | --- |
| 首次同步、恢复后游标为空、手动「重新同步」 | 按可访问媒体库递归分页，读取各作品的最新身份、层级与 Played | 核对插件全部可取得的逐次记录，保留上游已经过期的本地历史 |
| 平时后台检查、播放后同步 | 按有新增或时长变化的记录查询作品，必要时取系列及剧集 | 按游标回看七天，重读同一事件时更新时长 |
| 距上次目录核对满 24 小时，或检测到媒体库 ID 集合变化 | 下一次成功的自动同步核对目录。新片、季零、新季、尚无播放的作品、仅手动 Played 的状态以及新的刮削信息都可由此进入档案 | 已有游标时继续按播放增量查询，目录核对周期与播放窗口独立 |

应用和上游服务需可用才能推进核对时间。未到一小时游标检查点、目录也未到期且业务内容一致时，日常增量可以沿用已提交快照。重启时仍从磁盘游标向前重叠查询。相同库内刚入库且无人播放的作品可能要等到下一次目录核对。播放中的零时长记录可随插件后续更新获得有效证据。只有元数据变化时，后台也可收敛到新状态。新作品在本服务按 ItemId 建档，无需预设名称或外部标识。跨 ItemId 自动继承须经过身份核对。无法自动区分的记录与实机验收边界见[档案验收](watch-archive-maintenance.md)。

## 统计不变量

近期范围（本年度、近 30 天、近 7 天、自定义近 N 天）的观看时长与“播放过的电影/单集”来自有效逐次实播；同一作品多条播放记录只在作品数中计一次，不能据此推断完整观看或刷次。范围从本地今天 00:00 回溯 N-1 个自然日，至当前时刻，沿用记录跨边界裁剪。自定义 N 是页面临时状态，不写入快照。“全部”继续用确认记录计算累计部次、集次与刷次分布，并纳入历史估算。系列进度卡按档案中最近取得的单集 Played 计算已看集数；离库条目可保留上次状态。作品详情的刷次使用本地确认。确认时间仅表示用户操作时间，不作为历史观看发生日期；`Played` 与 `LastPlayedDate` 也不构成逐次历史。日历、活动与观影习惯仍只使用有实际时间的记录。详情中的观看次数编辑始终对全局确认档案操作，不将近期播放作品数写成确认次数。

完整扫描换源时，旧 ItemId 消失且唯一 TMDb/IMDb/TVDb 身份匹配则重映射；单集还要求系列匹配及相同季集号。旧条目与新条目同时存在时，仅对唯一的新重复条目沿用旧逻辑身份。已保存的播放记录 ID、确认及候选证据 ID 保持稳定，避免旧证据被当作新观看。缺少可靠身份或多个候选时保留旧资产，不按标题猜测。增量媒体请求仅容许单个已删除条目的 404；连接、权限和异常响应会中止同步，避免误报完整成功。

- 累计时长 = 去重后的有效逐次时长 + 未被旧实播覆盖的历史估算。电影或具体单集首次出现 `Played=true` 且没有首次确认、待人工处理候选时，各自动建立一次历史确认。同步时已有的实播累计达到片长 90% 视为完整观看证据，不再估算；否则按完整片长建立一次估算并固定基线，当时已知的短实播仍单独计时。此后补到的基线前旧记录不与估算重复计时；基线后的新实播可继续累加。估算一旦建立不因后续实播消失。
- `Played` 只提供一刷线索，不提供观看次数，也不区分手动勾选与自动完成；取消或恢复它不撤销已确认次数。已有无证据且未处理的首次待确认候选可在同步时改为自动首次确认；带实播证据、稍后、忽略及来源不明的候选保留人工处理。新重温候选来自上次确认之后的有效新实播，默认累计达到 10 分钟待确认。用户确认、稍后、忽略、撤销及手动补记必须跨同步保留。
- 手动补记可设置电影或电视剧系列、季、单集总确认次数，可仅增加次数或附加片长估算。确认计数决定电影部次与剧集集次，刷次分类互斥；导演作品数量按媒体项目去重。
- 时间不可靠的历史确认与估算只进入全部时间汇总；日历、时段和观影活动只使用有时间的逐次实播。合并间隔、短片过滤与补全设置影响展示或候选计算，不得静默改写源记录。

## 已验证范围与潜在边界

用户提供的实机组合是 **Windows、Jellyfin 10.11.11、Playback Reporting 17.0.0.0**。这说明该环境曾可用，不能外推至其他插件版本、远端服务、其他操作系统或所有数据库安装路径。插件查询无分页；大量历史记录的响应体、超时及内存占用需要实测。查询权限、插件关闭或升级后的列名、列顺序、类型与 `message` 行为需按原始响应核对。本机数据库回退依赖 Windows 进程和路径定位，且不能替代远端历史读取。统计专属 Vitest 已覆盖合成档案导入、身份同步及页面范围函数；普通媒体服务器集成检查仍不覆盖真实插件历史与用户档案。

检查入口是 `pnpm typecheck`、`pnpm test`（或运行[档案验收中的专项命令](watch-archive-maintenance.md#复验入口)）及相关构建。`tests/helpers/` 的 IPC 桩本身不构成统计功能覆盖。诊断日志由应用内「设置 → 诊断」读取内存日志；当前源码未找到持久 `main.log` 写入，排查时不应假定用户数据目录有此文件。

## 升级与排查

1. 记录 Freebo、Jellyfin、Playback Reporting 版本、操作系统、服务是否本机及当前用户 ID；保留快照、独立修正文件和版本化导出，勿提交令牌、数据库、完整日志或用户观看数据。
2. 先确认同一用户的 `Views` 与分页 `Items` 返回目录和作品，再以管理员权限核查插件接口的 HTTP 状态、`colums/results/message`、九列名称及单元格类型。区分真实空结果、权限失败和响应结构变化；核对插件表与 `PlayDuration` 的语义。
3. 对比一条已知播放在插件原始 `DateCreated`、Freebo `rawDate/startAt`、作品 ID、用户 ID、秒数及客户端/设备中的值。跨时区先核对客户端与服务端本地时间；重复或缺失先核对稳定 ID、七天回看及是否做过完整同步。
4. API 不可用且是 Windows 本机服务时，检查进程、端口、配置来源和只读数据库路径；远端或非 Windows 不使用此回退。用完整同步核对媒体库与缺失作品，检查旧作品重映射是否具有唯一提供商标识。
5. 对比快照、修正文件、确认与估算基线和导出内容；先在隔离用户数据目录复现升级或导入，再记录哪一层发生变化。涉及统计契约的变更做必要的现有检查和手动验收，不以一般播放集成检查代替。
6. 成功后更新版本矩阵：Freebo 提交或版本、Jellyfin 与插件版本、操作系统、HTTP/本机数据库来源、是否完整同步、已验证场景与未验证范围。

## 未来统计源：能力研究，未实现

现有 `WatchMedia` 的名称、层级、片长等大部分形状可复用，但 GUID 去连字符、`Movie/Series/Episode` 枚举、提供商标识及 Played 语义均带 Jellyfin 假设。快照内容只存 `serverId`，用户隔离依靠外部文件名，内部没有 provider/user 命名空间。未来应在新来源适配层携带 `source + server + user` 上下文，声明逐次历史、有效实播秒数、时间可靠度和保留范围的能力；不要为此直接改写现有持久 ID。现有 `MediaServerProvider`/`PlaybackClient` 负责播放，不提供通用统计认证。[watchIdentity](../electron/main.ts)目前从 Jellyfin 网页 `ApiClient` 读取用户 ID 与令牌、校验服务 origin，统计请求沿用该会话的 fetch；新来源至少需要独立的身份获取和认证读取适配，再接入同一档案语义。

最小演进路线是先把 Jellyfin 数据读取从统计计算中独立出来，保留共享的确认、估算及去重规则；在首个真实新来源验证后，再按实际差异引入轻量接口，此时无需预设新的 Provider 框架。可按用户目标选择先验证 Emby 第三方插件契约，或先接入 Plex 原生观看状态与历史；Plex 原生历史缺少有效实播秒数，若需时长再评估 Tautulli。

可扩展的最小路线是保持 `WatchMedia`、逐次记录、确认及估算的内部含义，先为每个来源证明用户身份、作品身份、实际逐次时长、时间与增量游标的契约，再映射而非共用 Jellyfin 字段名。缺少可信逐次时长时只能提供明确标注的估算或观看状态，不能把片长冒充实播。

| 来源            | 已知能力                                                                                                                                                                                                                                                                              | 接入前必验                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plex 原生       | 官方 [PMS API](https://developer.plex.tv/pms/) 的 `/status/sessions/history/all` 支持分页及 `accountID/viewedAt` 过滤；含 `historyKey/ratingKey/librarySectionID/viewedAt/accountID/deviceID`。原生状态另有 `viewCount/lastViewedAt/viewOffset`，元数据分 Movie/show/season/episode。 | 历史接口未提供单次有效实播时长契约；不能用媒体 duration 代替。核对账户、媒体重建后 ratingKey、库归属与分页时间边界。                                                                                                                                                  |
| Plex + Tautulli | [Tautulli API](https://github.com/Tautulli/Tautulli/wiki/Tautulli-API-Reference#get_history) 的 `get_history` 支持 `start/length/grouping`，含 `row_id/reference_id/user_id/rating_key/started/stopped/paused_counter/play_duration`。                                                | 关闭分组后验证每行代表一次播放、时长及暂停秒数、用户与 Plex 项目关联、历史保留期。它是额外服务，不能视为 Plex 原生能力。                                                                                                                                              |
| Emby            | 官方 [UserItemDataDto](https://dev.emby.media/reference/RestAPI/PlaystateService/postUsersByUseridPlayeditemsById.html) 有 `Played/PlayCount/LastPlayedDate/PlaybackPositionTicks`；[Playback check-ins](https://dev.emby.media/doc/restapi/Playback-Check-ins.html) 是事件上报流程。 | 前者是聚合状态，后者不是完整历史读取。第三方 [Playback Reporting 插件](https://github.com/faush01/playback_reporting/blob/develop/playback_reporting/Api/UserActivityAPI.cs) 有管理员 API，但发行版本、字段、权限与实播时长必须实机核实；不能套用 Jellyfin v17 契约。 |

## 本次验证范围

既有插件 v17 解析和本机 SQLite 合成检查结果属于此前审计记录。本轮档案维护的定向 Vitest、类型检查、构建及未验证范围以 [观影档案维护验收](watch-archive-maintenance.md) 为准；它们不等于真实 Jellyfin、插件、安装版或用户数据库实机验收。

## Jellyfin 12.4 认证兼容验证

2026-11-21，统计媒体、用户状态、Playback Reporting 查询和后台 Sessions 检查统一使用标准 Authorization 头，格式为 MediaBrowser Token="…"。12.4 默认禁用旧认证时，同一有效令牌的 X-Emby-Token 与 X-MediaBrowser-Token 请求返回 401，Authorization 返回 200。该格式也由现有 Jellyfin 播放客户端使用，10.11.x 继续支持。未启用服务端旧认证。

既有开发验证使用隔离统计目录执行完整与连续增量同步，历史实播、确认、估算和处理状态保留；已有稳定身份映射继续处理条目 ID 变化。用户真实播放的新记录归入既有系列，重复增量同步没有生成重复记录。详细基线和私人档案仅保留在本机，不进入源码或公开发布包。该次认证调整保留了原持久化格式、记录 ID 和时间口径。
