# Jellyfin 升级与个性化维护

当前环境：Windows x64，Jellyfin 12.4.0，2026-11-21。本文维护升级入口、定制来源和验收边界；构建版本、GUID、ABI、依赖、文件摘要以 [catalog.json](../resources/jellyfin-plugins/catalog.json) 为准，统计契约以 [watch-statistics.md](watch-statistics.md) 为准。新增插件定制、统计规则或美化功能时同步更新对应专题及本文索引。

## 插件清单与构建选择

插件使用官方英文名称；中文仅用于功能描述、分类、设置页、按钮与提示，不改变 GUID、页面注册名、配置键或接口。

| 官方名称与上游                                                                             | 10.11.x 保留构建              | 12.4 可用构建               | 汉化、定制与依赖                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| [Fanart](https://github.com/jellyfin/jellyfin-plugin-fanart)                               | 14.0.0.0 / ABI 10.11.5.0      | 15.0.0.0 / ABI 12.0.0.0     | 设置页中文；旧版保留本机 4K 背景扩展，新版为官方功能，未移植 4K 扩展；无插件依赖         |
| [Playback Reporting](https://github.com/jellyfin/jellyfin-plugin-playbackreporting)        | 17.0.0.0 / ABI 10.11.0.0      | 19.0.0.0 / ABI 12.0.0.0     | 报表、设置及操作文字中文；无插件依赖；历史数据库不能用空库覆盖                           |
| [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) | 3.0.3.0 / ABI 10.11.11.0      | 3.0.3.0 / ABI 12.0.0.0      | 12.x 设置页中文；Web 响应转换基础依赖                                                    |
| [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages)                      | 3.0.3.0 / ABI 10.11.11.0      | 3.0.3.0 / ABI 12.0.0.0      | 12.x 可见说明汉化；旧版保留原安装构建；依赖 File Transformation                          |
| [Home Screen Sections](https://github.com/IAmParadox27/jellyfin-plugin-home-sections)      | 3.0.4.0 / ABI 10.11.11.0      | 定制 3.0.4.0 / ABI 12.4.0.0 | 中英文界面、混合最近添加、竖版卡片；依赖 File Transformation、Plugin Pages               |
| [Media Bar](https://github.com/IAmParadox27/jellyfin-plugin-media-bar)                     | 3.0.2.0 / ABI 10.11.11.0      | 3.0.2.0 / ABI 12.0.0.0      | 12.x 设置页中文；旧版保留本机变体；依赖 File Transformation                              |
| [Scoped Import](https://github.com/gok2023/jellyfin-scoped-import)                         | 定制 0.2.0.3 / ABI 10.11.11.0 | 定制 0.2.0.3 / ABI 12.4.0.0 | 原中文管理页、定向追加、新条目元数据刷新、仓储保护；无插件依赖；真实入库已获用户实际验收 |

以上七项共十四个独立构建。AniDB 13、TheTVDB 24、Subtitle Extract 8 在本机 12.4 为 Active，当前不在内置市场中；其上游分别为 Jellyfin 的 [anidb](https://github.com/jellyfin/jellyfin-plugin-anidb)、[tvdb](https://github.com/jellyfin/jellyfin-plugin-tvdb)、[subtitleextract](https://github.com/jellyfin/jellyfin-plugin-subtitleextract)。Jellyfin 自带的元数据插件随服务端维护，不与这些包混用。

市场实现见 [jellyfin-plugins.ts](../electron/core/jellyfin-plugins.ts)、[文件校验与配置写入](../electron/core/jellyfin-plugin-files.ts)。先读取连接服务器版本，再按 GUID 归组，筛选兼容 ABI，选择最高插件版本，再以目标 ABI 和目录名稳定排序。10.x 必须同主、次版本；12.x 必须同主版本且达到目标 ABI 最低版本。没有兼容构建时只展示，不允许安装。界面默认显示官方名称、中文描述、加载状态与已安装版本；未安装时显示当前服务器可用构建版本。ABI 和全部构建收于详情。相同插件版本号不等于相同构建；已安装插件显示 Active 时，不因内置市场没有对应构建而标为不兼容。

依赖按当前服务器所选构建核对；已知 ABI 不兼容的依赖，即使插件版本号相同也不能满足要求。安装顺序为 File Transformation → Plugin Pages → HSS，Media Bar 在 File Transformation 后。保留原有“已安装时不直接覆盖、卸载需检查依赖”的边界，不静默跨 ABI 替换。远端接口不返回已安装 ABI 时依靠服务器加载状态，不能把未知 ABI 写成已核验。

File Transformation、HSS、Media Bar 的原推荐模板与当前 12.4 配置顶层结构相符，分别保留在新 ABI 资源目录中；HSS 模板未开启混合开关，缺省仍为关闭。每个构建的推荐配置按 `plugin.folder` 独立保存并校验摘要。仅用户选择使用推荐配置、且目标文件不存在时写入；已有文件原样保留。不要把旧版 XML 无条件覆盖到新版，也不要用推荐配置重置用户栏目。Playback Reporting 使用 Jellyfin 数据目录中的 `data/playback_reporting.db` 和 `config/playback_reporting.xml`，不属于可随插件替换的静态默认配置。

### HSS 定制来源

- 旧源码：本机 `D:\TOOL\jellyfin\HomeScreenSections\home-screen-sections-3.0.4.0-src`。混合功能提交 `6975d3377e25f18a60b23962c7376a06649c0868`，汉化提交 `0a91943`；上游基线 `288a1f6ae7a9af3e4ac0d145b6285d84888d0ab1`。
- 12.4 使用同一上游 3.0.4.0 正式源码，选择性复用 `RecentlyAddedInLibrarySection`、`UserSectionsDataCache`、`HomeScreenSectionService`、`loadSections.js` 与语言/设置资源。可移植补丁保存在 [hss-3.0.4.0-jf12.patch](../resources/jellyfin-plugins/customizations/hss-3.0.4.0-jf12.patch)，应用到干净上游源码，不叠加到已改过的树上。
- 重新构建时使用 `dotnet build src/Jellyfin.Plugin.HomeScreenSections/Jellyfin.Plugin.HomeScreenSections.csproj -c Release -p:JellyfinVersion=12.4.0 -p:JellyfinReferenceDir=<12.4 官方服务端目录>`；依赖 ABI 及目标程序集以实际产物检查为准，不改目标声明冒充新构建。
- `mergeLibraries` 默认关闭；开启时只有一个最近添加栏目。权限与隐藏库过滤后，按 DateCreated 查询电影/单集，按现有设置归组，作品排序采用最新符合条件成员的入库时间，最后截取展示数。按需分页，完成边界同时间条目的稳定排序，避免固定截取单集导致归组后数量不足。
- 沿用竖版卡片、预览、详情跳转、ElegantFin 样式及原刷新机制。12.4 构建使用 .NET 10 和 12.4 引用；前端预览使用 ApiClient 的认证请求。当前生产 DLL 的原安装元数据仍声明 ABI 12.0.0.0；内置定制包按实际编译引用保守标记为 12.4.0.0，二进制相同。
- 用户已明确确认混合时间流实际验收通过。本轮仅把该产物纳入市场并保存补丁，没有重新开发或重复视觉验收。后续换上游时测试混合开关、归组、最新成员排序、满额与无重复、竖版样式、其他栏目及用户权限。

### Scoped Import 定制来源

源码：`D:\TOOL\jellyfin\scoped-import`，基线 `5b667b8`，当前仍为 0.2.0.3；本机未提交修改。项目 [docs/PROJECT.md](../../../jellyfin/scoped-import/docs/PROJECT.md) 是该插件安全契约及当前状态的权威来源。10.11 使用原 SDK/依赖锁；12.4 新增 `scripts/dependencies-jf12.lock.json`、`bootstrap-jf12.ps1`、`build-jf12.ps1`，分别使用官方 12.4 引用与 .NET 10.0.404。

12.4 将查询仓储与持久化服务分离，且查询仓储通过工厂共享同一具体实例。适配保留该实例，在 `IItemRepository` 查询和 `IItemPersistenceService` 写入之间复用原追加保护；新图片接口为 `SaveImagesAsync`。仍核对编译 ABI、原版仓储/持久化类型并拒绝未知装饰器。`IDirectoryService` 新接口只使用既有检查清单，`Move` 明确拒绝移动媒体；独立管理页改用标准 Authorization。

保留电影、剧、季、集新增对象的原单项元数据/图片刷新顺序；已有项跳过，不借兼容性维护开放任意已有记录写入，不以全库扫描兜底。目录门禁、任务锁、新 ID/父子身份核验、历史 UserData 不重挂接等限制继续适用。当前没有新增“批量修复已有媒体元数据”的能力。

本轮 12.4 编译零警告零错误，纯内存保护测试、登录/配置页测试及 DLL ABI/嵌入资源检查通过；10.11 构建亦通过编译与产物检查，未重复执行旧全套测试。生产安装后 Active、`Ready=true`，管理员 GET 成功，未认证 GET 为 401；未提交 Import、PickFolder 或元数据刷新请求，没有创建测试媒体。用户已确认真实入库、刮削及 HSS 混合时间流通过实际使用验收；自动化加载检查与用户验收分别记录。

## 观影统计维护

- 标准认证集中在 [jellyfin-authorization.ts](../electron/core/jellyfin-authorization.ts)，使用 `Authorization: MediaBrowser Token="…"`。媒体、用户状态、Playback Reporting、后台 Sessions 及市场请求均按相应会话认证；不重新开启 12.x 旧认证，不回退到 `X-Emby-Token`、`X-MediaBrowser-Token` 或 URL `api_key`。
- 读取接口、Playback Reporting 九列及秒数/时间解释见 [统计契约](watch-statistics.md#数据链路与来源)。401 不是空库；失败不能覆盖历史。PR 插件数据库和 Lllllvlv 档案是两套资产，都要保留。
- 实播记录按稳定 ID 去重，增量回看七天；确认、待确认、忽略及历史估算基线必须跨同步保留。`Played`/`PlayCount` 不等于逐次实播，不能用片长替代真实播放时长。时间筛选及估算口径不随服务端升级改变。
- 换源/ItemId 变化仅在唯一且不矛盾的 TMDb/IMDb/TVDb 身份匹配后衔接；单集还须系列和季集号一致。保留原确认、记录及候选证据 ID；同名作品不能自动合并，无法匹配的旧记录保留待处理。
- 导出、导入预览、合并/恢复及独立修正文件的边界见 [观影档案维护验收](watch-archive-maintenance.md)，持久化路径规则见 [本地资产与身份](watch-statistics.md#本地资产与身份)。升级前保留版本化 JSON 导出、快照与修正文件，验证时使用隔离开发用户目录；不重建统计库。
- 已有 12.4 真实接口及隔离统计副本验收记录见 [认证兼容验证](watch-statistics.md#jellyfin-124-认证兼容验证)：代表性电视剧的新实播正确延续原系列身份，两次增量记录 ID 集合相同；私人观看基线不进入公开仓库。本轮没有重复播放或同步测试，也没有修改统计口径。后续升级仍核对 Played、PlayCount、LastPlayedDate、PlaybackPositionTicks、IsFavorite、Rating，以及继续观看、接下来和作品身份连续性。

## 个性化与配置

当前 CSS 的权威位置为 Jellyfin 实际数据目录的 `config/branding.xml`；本机当前仅引用 ElegantFin 的 jsDelivr `@main` 样式。该地址可变，后续排查应记录实际内容/版本；当前文件未见 Abyss 引用，不假设历史组合仍在生效。不要直接修改 Jellyfin Web 原始文件。

HSS 管理员配置在 `plugins/configurations/Jellyfin.Plugin.HomeScreenSections.xml`，用户栏目在 `ModularHomeSettings.json`，用户启用标记和缓存由 HSS 管理。生产当前沿用混合开启、竖版模式及“我的媒体 → 继续观看 → 接下来 → 最近添加”顺序。Media Bar 配置和相关 JSON/图片保存在插件数据中，换 DLL 时一并保留。

首页失效先区分：插件是否 Active、全局/当前用户是否启用、Plugin Pages 和 File Transformation 是否兼容、HSS 用户栏目/顺序是否缓存。更改后导航离开再返回，必要时 Ctrl+F5；源码客户端须重启主进程并刷新嵌入页面。优先保留 Desktop (Legacy) 体验，不把缓存旧页面误判为后端逻辑错误，也不通过清空用户配置排错。

## 可重复升级清单

1. 阅读目标版本的[官方升级说明](https://jellyfin.org/posts/jellyfin-release-12.0/)、[备份恢复](https://jellyfin.org/docs/general/administration/backup-and-restore/)及 [Windows 安装说明](https://jellyfin.org/docs/general/installation/windows/)。记录实际程序/数据/配置路径、启动方式、挂载状态、基线及备份后增量。
2. 保留停服完整备份：同版程序/Web、全部数据与配置、元数据、合集、插件及持久化、PR 历史、Lllllvlv 快照/修正/导出。已核验备份可复用，仅补充发生变化的数据，不重复全量审计或哈希。
3. 核对每个插件的目标 ABI、依赖及对应源码；相同版本号也逐构建区分。隔离旧第三方 DLL，先完成官方迁移，再恢复兼容插件及配置；HSS/Scoped Import 定制按上述来源选择性移植。当前长期保留的 10.11.11 完整回退点为 `D:\Jellyfin-Backups\Jellyfin-10.11.11-20261121-095158`，未经用户确认不删除。
4. 验证标准 API 认证、媒体数量/层级、观看状态、PR 原始记录与统计确认/估算/身份映射。严重迁移异常或大量数据丢失时停在现场，准备回退，不用全库重标观看掩盖问题。
5. 按目标版本官方要求安排扫描，先确认 CD2 与媒体可读及写入策略；不额外全库替换元数据/图片。本轮兼容性维护没有主动扫描或探测媒体。
6. 验收 HSS 混合流、Media Bar、CSS、合集、继续观看、接下来；Scoped Import 用用户选定的真实媒体定向入库验收，不能退化为全库扫描。Chrome 与 Lllllvlv 源码客户端分别验收，后端 HTTP/编译结果不能替代视觉与真实播放验证。
7. 真实播放后停止，再同步两次，核对进度、PR 新记录、时长、作品身份与去重。开发测试和正式档案隔离，不伪造数据库记录替代播放链路。
8. Lllllvlv 只在源码区开发；完整兼容性测试通过且用户确认后，才统一构建发布包、替换安装版及维护远端。最终发布经用户授权后，更新安装版并同步远端；结果见 1.2.4 Release。
9. 回退必须同时恢复旧程序和对应旧数据库/配置/插件，不能让旧版启动迁移后的数据库。升级后已有新观看记录时，先保留新版完整数据和增量导出；合并先在副本验证。单独撤下 Scoped Import 时停服，将该插件目录移出 `plugins` 后重启，保留配置和数据；不要给 12.4 安装旧 ABI DLL。

## 本轮验收边界

七插件十四构建的八项 ABI/选择/依赖/配置回归、TypeScript 检查、源码主进程与前端构建通过；生产只读市场状态查询确认七项兼容且依赖完整，相关配置页返回 200。两次 Scoped Import 候选替换期间配置哈希均未变化，PR 历史记录逐行保持；实际数量与时长仅保存在本机验收记录。同功能源码的 1.2.3 候选安装版已实际打开插件卡片、HSS 构建详情及观影统计页面，显示七项已启用且无兼容性误报，统计无 401；最终 1.2.4 仅修复打包脚本并调整版本，另核对程序/ASAR 版本、十四个内置构建及启动响应；HSS 的用户实际验收沿用已确认结果。用户现已确认 Scoped Import 真实入库/刮削和 HSS 混合时间流均通过实际使用验收。

## 1.2.4 最终维护与发布

- 修复先按未知服务器版本筛选、丢弃 12.x 后再次筛选导致的兼容性误报，始终从完整目录选择当前 ABI 的构建。
- 已安装构建优先使用服务器报告 ABI，无法唯一匹配的磁盘目录不猜测。Active 插件不因缺少内置候选被误标为不兼容；仅兼容候选版本更高或本机核心 DLL/依赖摘要确实不同才提示更新，服务端自动改写的 meta.json 不参与构建摘要。
- 默认卡片只显示官方英文名、中文描述、状态与当前/可用版本；ABI 和完整构建表放入折叠详情，保留原主题和管理操作。
- Windows 正式包默认包含十四个锁定构建。源树缺少 payload 时按 bundle.json 从版本化资源 Release 下载，先校验 ZIP 摘要/条目，再核对每个文件；旧版本不删除。新 ABI 推荐配置独立打包，已有配置不覆盖。
- 已验收 HSS 和 Scoped Import 二进制作为发行基线，分别维护对应源码、版本标记和许可。资源包附源码/上游来源清单；HSS 私有仓库可见性不因发布安装器改变。
- 公开源码与 Release 不含本机数据库、令牌、私人配置、观看档案或完整日志。实际备份/空间清理清单保存在本机升级工具目录，不随应用发布。

最终发布验收：284 项测试通过、1 项跳过，类型检查、lint、应用及品牌构建通过；Windows 包已校验十四个构建，并更新本机正式安装。用户配置、登录和观影档案保留，HSS/Scoped Import 沿用用户已确认的实际验收。本机正式回退点及空间清理明细维护在升级工具的本地报告中，不发布私人档案。

远端最终 1.2.4 的 Windows、macOS、Linux 打包均通过；正式 Windows 附件与本机交付文件逐一核对 GitHub SHA-256 摘要一致。应用发布见 [v1.2.4](https://github.com/gok2023/Lllllvlv/releases/tag/v1.2.4)，两项定制插件的发布与对应源码见各仓库及插件资源 Release。
