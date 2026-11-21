# Jellyfin 插件归档：Media Bar JF12 轮播修复

本目录在 2026-11-21 基础归档 `1e0421e656eead0f437efbe994ddd83b0bebf95b/20261121` 上保存新的 Windows 插件包；基础归档及其 SOURCE-MANIFEST.md 保持不变。

新包保留 14 个插件构建、48 个文件。与基础归档 catalog 的逐文件清单相比，仅 `Media Bar JF12_3.0.2.0/Jellyfin.Plugin.MediaBar.dll` 改变：旧 SHA-256 `a5f0c5e82af5e73d057fd747b6f2b19c2145cd051ce7537b696c8927f666d315`，新 SHA-256 `942df90f3c472d91bbfec39d4e51d9f059d099caedbdf2077b33d25ff287357f`。其余 47 个文件的路径和 SHA-256 均与基础 catalog 相同，10.11 构建未改。

Media Bar 3.0.2.0 基于上游标签 `c626924` 以 12.x 目标构建，应用中文资源定制及仓库中的 `resources/jellyfin-plugins/customizations/mediabar-3.0.2.0-jf12-timer.patch`。补丁只移除 `slideshowpure.js` 中停止新计时器后的置空语句。编译产物保留原程序集版本和引用；嵌入配置、首页、CSS 与原汉化构建一致，嵌入 JS 仅该行不同。Chrome 与 Lllllvlv 安装版轮播周期已获用户实际验收。

完整构建版本、来源和逐文件摘要以对应 main 提交的 `resources/jellyfin-plugins/catalog.json` 及 `docs/jellyfin-maintenance.md` 为准。
