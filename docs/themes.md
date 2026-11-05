# 视觉主题

Freebo 自有界面的视觉主题由 `settings.visualTheme` 保存，独立于 `settings.theme` 的系统／浅色／深色选择。默认 `original` 保留 [界面设计](design.md) 的 Original 规范；`slate` 是展示主题机制的简易示例；`elysium` 使用五张本地画作。未知主题 ID 在读取设置时只回退为 `original`，其余设置继续保留。

## 实现边界

- `src/shared/visual-themes.ts` 是主题 ID、显示名和原生窗口配色的静态注册表。增加主题时同步新增 `src/themes/<id>/style.css` 的浅色与深色语义变量，并由 `src/style.css` 导入。设置 IPC 从注册表读取允许值。主题不拥有业务状态或调用 IPC。
- `src/App.tsx` 在主窗口、选服务窗口和播放浮窗的 React 根节点设置 `data-visual-theme`。既有 `.dark` 类仍根据应用外观与系统偏好独立决定。Tailwind/shadcn 的颜色与圆角工具通过语义 CSS 变量取值；少量展示性插槽可用主题变量，例如首页标题背景。Original 的插槽值为空。
- Electron 主进程取注册表中的背景、卡片和标题栏颜色。原生浏览器外壳的固定 88px 高度、网页视图边界和 IPC 保持原有职责。主题样式不进入媒体服务器 `WebContentsView`。
- 本地统计页面 `web/统计页面.html` 经 Vite 输出为 `watch-statistics.html`，由 `StatisticsFrame` 的同源 iframe 加载。父组件仅向该 iframe 发送白名单 `visual-theme` 展示消息；既有统计 RPC 与数据通道不变。Original 沿用统计页原样式，Elysium 使用透明 iframe 表面透出父窗口的共享画作。打印样式保持白底。

## 扩展接口

注册表的 `VisualThemeDefinition` 要求显示名和浅／深两套 `NativeThemePalette`，后者分别提供 `background`、`card`、`tab`、`symbol`。可选 `backgrounds` 为静态预设表，包含文件相对路径、焦点、遮罩及三类材质色；`defaultBackground` 指明缺省画作。`settings.visualBackground` 保存背景 ID；未知 ID 在读取时独立回退，当前缺省为 `skyline`，主题切换不会清除选择。渲染端 `ThemeSlots` 的 `HomeTitle` 与 `HomeLayout` 可选；后者只接收标题、说明、操作、内容和页脚节点，不接收服务器、播放器或导航对象。

| 令牌                                                                                                            | 用途                                                              |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `--background`、`--foreground`、`--card`、`--primary` 等                                                        | 现有 shadcn/Tailwind 语义颜色                                     |
| `--theme-font-body`、`--theme-body-size`、`--theme-title-size`、`--theme-subtitle-size`、`--theme-control-size` | 字体与文字层级；局部实用类仍可覆盖                                |
| `--theme-body-leading`、`--theme-title-leading`、`--theme-heading-tracking`                                     | 行高与标题字距                                                    |
| `--theme-section-space`、`--theme-density`、`--radius`                                                          | 区块间距、展示密度与圆角；固定结构尺寸仍由组件决定                |
| `--theme-card-shadow`、`--theme-home-decoration`、`--theme-material-image`                                      | 阴影、材质图像与展示装饰；Original 值为空；图像令牌预留给展示插槽 |
| `--theme-motion-fast`                                                                                           | 快速状态过渡                                                      |

新增主题时，先在 `src/shared/visual-themes.ts` 注册 ID、名称和两套原生颜色；在 `src/themes/<id>/style.css` 定义浅／深 CSS 变量，并从 `src/style.css` 静态导入。若需要不同的展示结构，在 `src/themes/registry.tsx` 加入只接收展示数据的可选插槽；未加时沿用 Original 展示。设置页从注册表生成选项，IPC 的 ID 校验也从注册表生成。检查两种外观、主窗口与两个浮窗、重启后的设置读取及未知 ID 的回退，并确认网页视图边界和业务行为无变化。

背景预设文件放在 `public/themes/<id>/backgrounds/`，路径在注册表中相对 `index.html` 声明。渲染端只将当前选中的图像 URL 写入 CSS 变量；切换主题时清除该组变量。预设可以设置 `position`、`mask`、`artTint`、`contentTint`、`controlTint`、`foreground`、`mutedForeground`；三类表面的填充、边线、局部模糊和静态纹理由 `.theme-surface-art`、`.theme-surface-content`、`.theme-surface-control` 消费。当前 Elysium 五张画作仅由用户本机提供，保留原始 3840×2160 PNG 细节，Git 忽略原图；Vite 构建仍会复制它们到 `dist/`，未取得分发许可前不得公开分发包含画作的构建产物。资源缺失时主题仍可显示纯色底面，但绘画效果缺失。

Elysium 主窗口在 BrowserShell 的持久背景层绘制当前画作，首页、快速配置、设置与统计共享该层；页面级表面只提供局部染色和可读性。设置侧栏宽度由 `--settings-sidebar-width` 同时控制网格和常驻统计 iframe，默认展开，子路由切换时保持状态。首页欣赏模式是仅覆盖渲染窗口的临时图层，单击或 Esc 退出，不改变路由和原生网页视图几何。独立浮窗只使用主题深色表面，不复制画作。

## 验证边界

主题扩展需在 Electron 中检查 Original 回退、五张画作、快速配置、设置、统计 iframe 与两个浮窗，并确认浏览器外壳 88px 及原生网页视图边界。隔离样例数据只能验证显示和交互；真实媒体服务器、播放器、统计同步与打印结果须在实际使用中验收。画作分发许可和 GPU 内存使用另行确认。
