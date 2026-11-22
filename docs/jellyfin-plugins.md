# Jellyfin 插件目录

## 发行资源与源码索引

Windows 当前内置插件包固定为同仓库 `plugin-archives` 分支的[不可变提交](https://github.com/gok2023/Lllllvlv/tree/007b562c5976fffedb0f4d815b689ebb87f35960/20261122-hss-layouts) 中的[jellyfin-plugins-windows-20261122-hss-layouts.zip](https://github.com/gok2023/Lllllvlv/blob/007b562c5976fffedb0f4d815b689ebb87f35960/20261122-hss-layouts/jellyfin-plugins-windows-20261122-hss-layouts.zip)，SHA-256 由 [bundle.json](../resources/jellyfin-plugins/bundle.json) 锁定。[SOURCE-MANIFEST.md](https://github.com/gok2023/Lllllvlv/blob/007b562c5976fffedb0f4d815b689ebb87f35960/20261122-hss-layouts/SOURCE-MANIFEST.md) 与 [SHA256SUMS.txt](https://github.com/gok2023/Lllllvlv/blob/007b562c5976fffedb0f4d815b689ebb87f35960/20261122-hss-layouts/SHA256SUMS.txt) 记录本次 HSS 12.4 栏目布局定制及归档摘要。原 [Media Bar 归档](https://github.com/gok2023/Lllllvlv/tree/f2a699e4b94f07304b8a0af61d5869adb48ee436/20261121-mediabar-timer) 与 [2026-11-21 基础档案](https://github.com/gok2023/Lllllvlv/tree/1e0421e656eead0f437efbe994ddd83b0bebf95b/20261121) 保留；历史 `v1.2.4` 构建不移动标签或重写原文件。下载脚本仅接受固定 HTTPS 主机，限制大小并核对 ZIP 和每个文件摘要。分支名称可移动，当前构建来源以新提交 ID 为准；插件归档不是应用 Release。

目录现同时提供 Windows x64 的 Jellyfin 10.11.x 与 12.x 独立构建；当前清单和定制迁移入口见 [长期维护文档](jellyfin-maintenance.md)。以下原始盘点基于 Jellyfin 10.11.11。服务使用 `--datadir` 指向独立数据目录，盘点取其 `plugins` 下的 10 个 Active 插件。Freebo 内置目录收录 Fanart、File Transformation、Home Screen Sections、Media Bar、Playback Reporting、Plugin Pages 和 Scoped Import。锁定 GUID、插件版本、Jellyfin 目标 ABI、插件间依赖、发布文件清单和 SHA-256 见 [catalog.json](../resources/jellyfin-plugins/catalog.json)。

## 来源与二进制对照

将已安装的 DLL 和发布依赖文件与作者公开 ZIP 比对。公开 ZIP 经过 HTTPS 下载，先与作者清单的 MD5 核对，再计算 SHA-256。Freebo 目录中的独立文件哈希用于校验本地导入。来源见 [Jellyfin 插件清单](https://repo.jellyfin.org/files/plugin/manifest.json)和 [IAmParadox27 插件清单](https://www.iamparadox.dev/jellyfin/plugins/manifest.json)。

| 插件                                                                                                            | 本机版本／目标 ABI  | 对照结果                                                                                                                            | 插件依赖                          |
| --------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [AniDB](https://github.com/jellyfin/jellyfin-plugin-anidb)                                                      | 11.0.0.0／10.11.0.0 | DLL 与 Jellyfin 发布包一致                                                                                                          | 无                                |
| [Fanart](https://github.com/jellyfin/jellyfin-plugin-fanart)                                                    | 14.0.0.0／10.11.5.0 | DLL 与本机 `fanart-4k/artifacts` 的 MIT 许可构建一致，含新增 4K 电影和电视剧背景                                                    | 无                                |
| [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation/releases/tag/3.0.3.0) | 3.0.3.0／10.11.11.0 | DLL、依赖清单和图标与作者发布包一致                                                                                                 | 无                                |
| [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages/releases/tag/3.0.3.0)                      | 3.0.3.0／10.11.11.0 | DLL、依赖清单和图标与作者发布包一致                                                                                                 | File Transformation               |
| [Home Screen Sections](https://github.com/IAmParadox27/jellyfin-plugin-home-sections/releases/tag/3.0.4.0)      | 3.0.4.0／10.11.11.0 | DLL 与本机中文合并包一致，基础源码为上游 GPL-3.0 的 `288a1f6ae7a9af3e4ac0d145b6285d84888d0ab1`                                      | File Transformation、Plugin Pages |
| [Media Bar](https://github.com/IAmParadox27/jellyfin-plugin-media-bar/releases/tag/3.0.2.0)                     | 3.0.2.0／10.11.11.0 | 依赖清单和图标匹配，DLL 与作者发布包有差异，本机变动来源待核实                                                                      | File Transformation               |
| [Playback Reporting](https://github.com/jellyfin/jellyfin-plugin-playbackreporting)                             | 17.0.0.0／10.11.0.0 | 主 DLL 与本机 `playbackreporting-zh` 汉化包一致；`SQLitePCL.pretty.dll` 与 Jellyfin 发布包一致。上游为 GPL-3.0                      | 无                                |
| Scoped Import                                                                                                   | 0.2.0.3／10.11.11.0 | 本机当前 DLL 与本机插件备份匹配。另存的同版本构建包使用不同 DLL 摘要，当前字节与源码构建的对应关系待核实。本机源码声明 GPL-3.0-only | 无                                |
| [Subtitle Extract](https://github.com/jellyfin/jellyfin-plugin-subtitleextract)                                 | 7.0.0.0／10.11.2.0  | DLL 与 Jellyfin 发布包一致                                                                                                          | 无                                |
| [TheTVDB](https://github.com/jellyfin/jellyfin-plugin-tvdb)                                                     | 22.0.0.0／10.11.8.0 | 主 DLL 与 `Tvdb.Sdk.dll` 均与 Jellyfin 发布包一致                                                                                   | 无                                |

AniDB、Plugin Pages、Subtitle Extract 和 TheTVDB 仅保留来源记录。Home Screen Sections 另外要求 Jellyfin 中已有启用的 Plugin Pages 3.0.3.0 或兼容的新版本。

| 仅盘点的插件     | 本机 GUID                              |
| ---------------- | -------------------------------------- |
| AniDB            | `a2b2a7ed-aa28-4521-a64a-63d86901f246` |
| Plugin Pages     | `5b6550fa-a014-4f4c-8a2c-59a43680ac6d` |
| Subtitle Extract | `cd893c24-b59e-4060-87b2-184070e1bf68` |
| TheTVDB          | `a677c0da-fac5-4cde-941a-7134223f14c8` |

公开构建包含六个插件的目录。Jellyfin 启用作者的插件仓库后，可以从发布者获取已核验的 File Transformation 原版。其他五个插件通过本地导入使用。发布本机变体前需核对相应授权、版权和第三方许可通知，GPL 二进制还需有相应的可提供源码。当前 Media Bar 和 Scoped Import 的构建来源待核实，按本机变体处理。

## 插件卸载与重启

本机 Windows 支持在插件管理中批量选择内置插件的具体版本。点「预览卸载」核对原目录和备份位置。Freebo 通过管理员会话、Jellyfin 实例 ID、端口监听进程和目录内 `meta.json` 的 GUID 与版本核对目标。仍被其他已知插件使用的依赖需要先处理。例如，保留 Plugin Pages 时，Freebo 会阻止彻底卸载 File Transformation。

点「确认卸载」后，Freebo 通过 Jellyfin 的关机接口正常关闭服务。待服务器进程和监听端口均退出后，Freebo 将选中的插件目录移入与 `plugins` 同级的 `freebo-plugin-backup-<标识>`。插件配置、数据库、媒体和其他插件保留。关机未完成时，以原方式正常停止实例，Freebo 检测到退出后自动继续。Windows 托盘的 Stop Jellyfin 和 Exit 在关不掉主窗口时会强制结束服务，应使用 Jellyfin 管理后台的关机操作。 [Jellyfin 关机接口](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/SystemController.cs#L115-L129) · [托盘停止实现](https://github.com/jellyfin/jellyfin-server-windows/blob/v10.11.11-202606061137/Jellyfin.Windows.Tray/TrayApplicationContext.cs#L287-L321)

- 对能识别的 Windows 服务，Freebo 确认服务状态为 `Stopped`，移动完成后通过 Windows 服务控制管理器启动同一服务。自动启动失败时，可手动启动该服务。 [Windows 服务控制](https://learn.microsoft.com/en-us/windows/win32/services/controlling-a-service-using-sc)
- 对能识别的 Jellyfin 官方托盘，Freebo 保持托盘运行。原托盘仍在同一用户会话、权限一致，且注册表中的程序和数据目录与原进程一致时，Freebo 按托盘原有的可执行文件和 `--datadir` 参数启动服务。条件不满足时，在现有托盘图标中选择「Start Jellyfin」。 [托盘配置与启动实现](https://github.com/jellyfin/jellyfin-server-windows/blob/v10.11.11-202606061137/Jellyfin.Windows.Tray/TrayApplicationContext.cs#L142-L150) · [托盘启动实现](https://github.com/jellyfin/jellyfin-server-windows/blob/v10.11.11-202606061137/Jellyfin.Windows.Tray/TrayApplicationContext.cs#L232-L252)
- 其他启动方式在备份结束后按原方式启动同一实例。

Freebo 自动等待服务重新连接，并重新核对 Jellyfin 实例 ID、监听进程、插件目录、备份和插件列表。所选版本均已移除后，界面显示完成与备份位置。若文件移动未完成，排除占用或权限问题后可在原流程重试。操作记录在重启 Freebo 后仍可读取，等待停启的操作会继续检查实例状态。

### 验证范围

此前在 Windows 源码版进行了只读验收。实际 Jellyfin 10.11.11 返回了六个内置插件条目，Freebo 自动定位到服务报告的数据目录。三套主题的浅色和深色模式均在 820 × 600 窗口内可滚动浏览，未出现横向溢出。插件面板默认折叠，展开状态能保存。安装、彻底卸载及 Jellyfin 停启留待手动验收。

## 本机离线包

传入当前 Jellyfin 实例的 `plugins` 目录。导入脚本只读取目录里已经核验的 DLL、必要的运行时依赖清单和插件图标。脚本根据目录中经审阅的字段重新生成可移植的 `meta.json`，关闭插件自动更新以保持离线版本。插件配置、数据库、日志、符号、库目录和账号数据均在清单之外。

```powershell
pnpm jellyfin:import-plugins 'D:\TOOL\jellyfin\tmp\plugins'
```

导入结果写入 Git 忽略的 `resources/jellyfin-plugins/payload/`，源码模式直接使用。Windows 本机打包时显式启用以下环境变量，打包钩子会再次核对每个文件哈希，再将白名单产物写入应用资源目录。

```powershell
$env:FREEBO_PACKAGE_LOCAL_JELLYFIN_PLUGINS = '1'
try {
  pnpm package
} finally {
  Remove-Item Env:FREEBO_PACKAGE_LOCAL_JELLYFIN_PLUGINS
}
```

常规打包复制目录 JSON 和下方列出的推荐配置。维护目录时，核对实际插件 GUID、版本、ABI 和跨插件依赖，比对公开 ZIP 与本地变体，并更新新增或变化文件的 SHA-256。生成 `meta.json` 的摘要对应两空格缩进、UTF-8、LF 和文件末尾换行。

## 推荐配置

本机安装时可取消默认勾选的「使用 Lllllvlv 推荐配置」。安装完成后，Freebo 校验对应版本的配置文件 SHA-256，再将新文件写入该 Jellyfin 实例的 `plugins/configurations`。同名文件已存在时保留现有文件，卸载后重新安装也遵循此规则。本机在线安装还需通过 Jellyfin 或监听进程核实目录，并在磁盘上确认对应插件版本；远程安装沿用 Jellyfin 的设置流程。写入需要目标文件系统支持硬链接。配置写入失败时，Freebo 会显示提示，插件仍可在 Jellyfin 重启后加载。

| 插件                         | 推荐配置                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| File Transformation 3.0.3.0  | 关闭调试日志；转换规则由插件管理。                                                                                                         |
| Home Screen Sections 3.0.4.0 | 首页分页、缓存与图片显示参数，以及内置分区的开关、排序、显示和数量设置。与账号、媒体库、外部服务或自定义分区参数有关的值由 Jellyfin 管理。 |
| Media Bar 3.0.2.0            | 启用横幅及选定的界面参数。头像、SVG 与播放列表由 Jellyfin 管理。                                                                           |

Fanart 的本机配置为空，Scoped Import 没有同类插件配置文件。Playback Reporting 的设置位于 Jellyfin 数据目录的 `config` 下，包含保留期限和备份设置，沿用该实例的现有设置。Home Screen Sections 的 `ModularHomeSettings.json` 是按 Jellyfin 用户保存的个人首页状态。

## 当前 Jellyfin 12.4 维护结果

当前市场为七个官方英文名称、十四个独立构建。目标版本矩阵、HSS 混合时间流移植、Scoped Import 12.4 适配与配置保留规则统一维护在 [jellyfin-maintenance.md](jellyfin-maintenance.md)，不以插件版本号代替目标 ABI。

12.x 官方 ZIP 的原始摘要与本地汉化文件摘要见 catalog.json。汉化词表位于 resources/jellyfin-plugins/localization，处理脚本为 scripts/jellyfin-localize-pages.py 与 scripts/jellyfin-localize-plugins.ps1；显示文本汉化保留，名称恢复官方英文，GUID、页面路由、选项值和配置键不变。HSS 定制构建及对应源码补丁已纳入，旧 10.11 构建保留。Scoped Import 0.2.0.3 的新旧 ABI 包独立保存。

本轮源码管理器对正式 12.4 的只读查询返回 admin、七个兼容包、完整依赖、已安装版本及 ABI。八项多构建/依赖/配置回归、TypeScript 检查和源码前后端构建通过，十四个本地白名单包通过文件哈希校验。Scoped Import 已安装 Active、Ready=true；真实入库等待用户手动验收。没有更换 Lllllvlv 安装版或推送 GitHub，没有新增统计同步或媒体扫描。

本文前面的 10.11 审计及来源记录属于历史证据，不能替代当前构建矩阵或外推完整功能验收。开发数据目录 .local 含真实档案副本，不提交；payload 仍按原规则本地保存，公开分发须连同对应源码及许可材料维护。
