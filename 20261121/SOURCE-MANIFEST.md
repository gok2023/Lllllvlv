# Jellyfin plugin bundle: sources and notices

This archive contains separate plugin builds, not user configuration or databases. Plugin GUID/version/ABI and individual file hashes are locked in the Lllllvlv resources/jellyfin-plugins/catalog.json for v1.2.4. Each upstream project retains its own license and copyright; the app Apache-2.0 license does not relicense plugins.

| Plugin | Source / customization |
| --- | --- |
| Fanart 14 / 15 | https://github.com/jellyfin/jellyfin-plugin-fanart ; retained 14.x 4K source attached as Fanart-14-4K-custom-source.zip |
| Playback Reporting 17 / 19 | https://github.com/jellyfin/jellyfin-plugin-playbackreporting ; localization resources and scripts in Lllllvlv v1.2.4 |
| File Transformation 3.0.3.0 | https://github.com/IAmParadox27/jellyfin-plugin-file-transformation/tree/3.0.3.0 ; GPL-3.0 text included in Lllllvlv docs/licenses/jellyfin-plugins |
| Plugin Pages 3.0.3.0 | https://github.com/IAmParadox27/jellyfin-plugin-pages/tree/3.0.3.0 ; GPL-3.0 text included |
| Media Bar 3.0.2.0 | https://github.com/IAmParadox27/jellyfin-plugin-media-bar/tree/3.0.2.0 ; upstream DBAD license included; retained 10.11 timer customization patch in Lllllvlv resources/jellyfin-plugins/customizations |
| Home Screen Sections 3.0.4.0 | https://github.com/IAmParadox27/jellyfin-plugin-home-sections/tree/3.0.4.0 ; corresponding accepted old/new customized source archives attached; GPL-3.0 preserved |
| Scoped Import 0.2.0.3 | https://github.com/gok2023/jellyfin-scoped-import/releases/tag/v0.2.0.3 ; old/new corresponding source archives attached; GPL-3.0-only preserved |

Binary packages use the accepted local DLLs unchanged. Source archives exclude SDKs, hosts, credentials, databases and private settings. The HSS customization repository retains its original private visibility; its corresponding distributable source is attached here so public binaries do not depend on access to that private repository.
