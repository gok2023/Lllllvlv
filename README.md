<p align="center"><img src="assets/personal/app-icon.png" width="180" alt="Lllllvlv 图标" /></p>

<h1 align="center">Lllllvlv</h1>

<p align="center">基于开源 Freebo 的个人定制桌面影音客户端</p>

[![English](https://img.shields.io/badge/English-193C35?style=flat&logo=googletranslate&logoColor=white)](README.en.md)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-193C35?style=flat)](LICENSE)
[![macOS, Windows, Linux](https://img.shields.io/badge/Platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-193C35?style=flat)](#功能)
[![更新说明](https://img.shields.io/badge/%E6%9B%B4%E6%96%B0%E8%AF%B4%E6%98%8E-193C35?style=flat)](CHANGELOG.md)

**在熟悉的媒体库里浏览，用喜欢的本地播放器观看。Lllllvlv 在开源 Freebo 的基础上，加入个人观影管理与桌面外观定制。**

上游 [Freebo](https://github.com/elonzh/freebo) 是免费开源软件，负责将 Emby、Jellyfin、Plex 的网页浏览与本地播放器连接起来。Lllllvlv 是基于它的独立分支，使用自己的名称与图标；播放器需另行安装，媒体与服务器由用户自行提供。

## 为什么做 Lllllvlv

保留 Freebo 熟悉的媒体库网页与本地播放流程，补上个人使用中需要的观看记录、历史确认、外观和数据管理。Lllllvlv 仍以本机使用为中心；媒体服务及其内容不由本项目提供。

## 功能

- 支持 Emby、Jellyfin 和 Plex，多服务器标签页分别保留登录会话。
- 电影、剧集和视频播放列表，支持续播、连续播放与观看进度同步。
- 沿用媒体库的音轨、字幕和视频版本选择。
- 播放浮窗提供暂停、进度跳转和列表切换。
- 自动查找已安装的播放器，也可手动选择路径或[添加自定义播放器](docs/development.md#自定义播放器)。
- 中英双语、浅色与深色外观，记住窗口大小和位置。
- 关闭主窗口后继续后台播放，通过托盘恢复窗口或退出。
- Jellyfin 观影统计：在「设置 → 统计」按本年度、近 30 天、近 7 天、自定义天数或全部查看实播与观看确认，支持本地备份导入导出；详细范围见[观影统计说明](docs/watch-statistics.md)。

### 本分支的扩展

- Jellyfin 观影统计增加观看确认、刷次修正与历史估算；估算和实际播放时长分开展示，仅 Jellyfin 接入这一统计功能。
- 可把普通 HTTP(S) 网站作为 Web Service 加入标签页；它只提供网页浏览，不接管播放或同步进度。
- 增加 Lllllvlv 品牌外观、可选启动视频和 Elysium 视觉主题。源码仓库不含原图；Windows 发行包包含用户选用的官方公开壁纸，壁纸版权归原作者，不适用本项目 Apache-2.0 代码许可证。
- Windows 可在诊断页选择用户数据目录；本分支关闭上游自动更新入口。

| 系统    | 播放器                                       |
| ------- | -------------------------------------------- |
| macOS   | IINA、mpv、VLC                               |
| Windows | mpv.net、PotPlayer、MPC-HC、MPC-BE、mpv、VLC |
| Linux   | mpv、VLC、Cine                               |

音乐和直播继续使用服务器网页播放。

Cine 仅打开当前视频，播放控制与进度同步的支持范围见 [播放器接入说明](docs/architecture.md#服务器与播放器扩展)。

## 快速开始

1. 安装或从源码运行 Lllllvlv，在首次配置中选择已安装的播放器。
2. 选择 Emby、Jellyfin 或 Plex，添加媒体服务器地址，在服务器网页中登录。
3. 在媒体库中点击播放，用地址栏旁的播放按钮打开控制浮窗。

服务器和播放器可随时在设置中修改。服务器名称可留空；Emby、Jellyfin 按需保存的账号密码会自动填入登录页，Plex 使用网页登录会话。Plex 地址应填写媒体服务器地址（例如 `http://192.168.1.10:32400`）。便携版播放器可手动指定路径，服务器地址支持端口和反向代理子路径。

此个人定制版已关闭上游自动更新入口。构建方式见 [开发流程](docs/development.md#环境与源码运行)。

## 开发指引

源码运行、检查与提交、Emby／Jellyfin／Plex 集成测试、打包流程见 [开发流程](docs/development.md)。

## 致谢

感谢 [embyToLocalPlayer](https://github.com/kjtsune/embyToLocalPlayer) 提供协议与行为参考。

Lllllvlv 基于 [Freebo 原项目](https://github.com/elonzh/freebo)，感谢原作者 elonzh 及贡献者。Freebo 的原有署名与 Apache-2.0 条款保留在 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)；本分支的源码修改也按该许可发布。Elysium 壁纸版权归原作者，不受本项目的 Apache-2.0 代码许可覆盖。
