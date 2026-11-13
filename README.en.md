<p align="center"><img src="assets/personal/app-icon.png" width="180" alt="Lllllvlv icon" /></p>

<h1 align="center">Lllllvlv</h1>

<p align="center">A personal desktop media client based on open-source Freebo</p>

[![中文](https://img.shields.io/badge/%E4%B8%AD%E6%96%87-193C35?style=flat&logo=googletranslate&logoColor=white)](README.md)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-193C35?style=flat)](LICENSE)
[![macOS, Windows, Linux](https://img.shields.io/badge/Platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-193C35?style=flat)](#features)
[![Changelog](https://img.shields.io/badge/Changelog-193C35?style=flat)](CHANGELOG.md)

**Browse your familiar library and watch with your favorite local player. Lllllvlv builds on open-source Freebo with personal viewing management and desktop customization.**

[Freebo](https://github.com/elonzh/freebo) is free and open-source software that connects Emby, Jellyfin and Plex websites to local players. Lllllvlv is an independent fork with its own name and icon. Players must be installed separately; users provide their own media and servers.

## Why Lllllvlv exists

Lllllvlv keeps Freebo's familiar library websites and local playback flow while adding the viewing history, confirmations, appearance and data controls needed for personal use. It does not provide a media service or content.

## Features

- Emby, Jellyfin and Plex servers, with separate persistent sign-in sessions in each tab.
- Movies, episodes and video playlists with resume, continuous playback and watch progress sync.
- Your library's audio, subtitle and video-version selections.
- A floating panel for pause, seeking and queue navigation.
- Installed player discovery, manual path selection and [custom players](docs/development.md#自定义播放器).
- English and Chinese, light and dark appearance, and remembered window size and position.
- Keep playing in the background when the main window closes; reopen or quit from the tray.

### Extensions in this fork

- Jellyfin viewing statistics offer year, recent 30 days, recent 7 days, custom day ranges and all-time views. Recent views use actual playback; all-time viewing counts retain confirmations and historical estimates. This feature currently supports Jellyfin only.
- Add an ordinary HTTP(S) website as a Web Service tab. It supports browsing, without playback interception or progress sync.
- Lllllvlv branding, an optional startup video and the Elysium visual theme. The source repository does not include the original artwork; Windows releases bundle official public wallpapers selected by the user. Copyright remains with the original creators, and the artwork is not covered by this project's Apache-2.0 code license.
- Choose a user-data directory from Diagnostics on Windows. Upstream automatic updates are disabled in this fork.

| System  | Players                                      |
| ------- | -------------------------------------------- |
| macOS   | IINA, mpv, VLC                               |
| Windows | mpv.net, PotPlayer, MPC-HC, MPC-BE, mpv, VLC |
| Linux   | mpv, VLC, Cine                               |

Music and live TV continue to play on the server website.

Cine opens the current video only. See [player integration](docs/architecture.md#服务器与播放器扩展) for playback control and progress sync capabilities.

## Quick start

1. Install or run Lllllvlv from source, then select an installed player during initial setup.
2. Choose Emby, Jellyfin or Plex, add your media server address and sign in on its website.
3. Press play in your library. Use the playback button beside the address bar to open the floating controls.

Servers and players can be changed in Settings. Server names are optional; saved Emby and Jellyfin credentials fill the sign-in form. Plex keeps its Web sign-in session; enter the media server address (for example `http://192.168.1.10:32400`). Choose a path manually for portable players. Server addresses support ports and reverse proxy subpaths.

This personal build disables upstream automatic updates. See the [development workflow](docs/development.md#环境与源码运行) for build instructions.

## Development guide

See the [development workflow](docs/development.md) for running from source, checks, commits, Emby/Jellyfin/Plex integration tests, and packaging.

## Acknowledgments

Thanks to [embyToLocalPlayer](https://github.com/kjtsune/embyToLocalPlayer) for protocol and behavior references.

Lllllvlv is based on [the original Freebo project](https://github.com/elonzh/freebo). Thanks to its author, elonzh, and contributors. Freebo's attribution and Apache-2.0 terms are retained in [NOTICE](NOTICE) and [LICENSE](LICENSE); this fork's source changes are also released under that license. Elysium wallpapers remain copyrighted by their original creators and are not covered by the Apache-2.0 code license.
