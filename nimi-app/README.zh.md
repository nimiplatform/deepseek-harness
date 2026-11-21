---
description: "开发 Nimi DSH 桌面应用并查看当前验证范围。"
kind: package-reference
---

# Nimi DSH

[English](README.md) | 中文

Nimi App 项目基于上游 `0.2.2-rc.3` 版本适配 DeepSeek Harness 桌面产品。DSH 管理 Electron 构建、桌面界面、插件和 RunAsNode Worker。App Tools 管理 Nimi 声明和安装归档。两个项目各自保留 pnpm 版本，并使用相同的 SDK 和 Kit 候选包。

`pnpm install --frozen-lockfile` 安装已锁定的本地平台包。编辑 App 声明后运行 `pnpm exec nimi-app sync` 和 `pnpm exec nimi-app check`。运行 `pnpm exec nimi-app test` 检查 Adapter。

从 DSH 工作区选择“设置 → Nimi 模型与访问 → 打开 Nimi 设置”。这个窗口在同一受保护 Host 上复用 Kit 的 App 会话、访问状态、NimiAppChrome 和 App AIConfig 编辑器。会话的模型选择器读取当前开发注册的有效配置。工作文件保存在用户选定的工作区，已有的 Documents 工作区可以继续使用。可选的网页搜索工具使用它独立配置的搜索服务。通用设置及 macOS 应用菜单也可打开 Nimi 设置。

推理等级菜单通过现有 Host IPC 读取当前配置的能力。每个模型步骤都会重新核对已选等级，切换路线后也一样；选择默认时沿用 Nimi 配置。

日常开发时，打开启用开发者模式的 Nimi Home，在本目录运行 `pnpm dev`。App Tools 监督 Electron Host。开发构建复用 DSH 的界面构建与运行时准备。在 **Apps → Nimi DSH → AI models** 为开发注册选择文本模型。已有注册使用 `pnpm dev -- --list-registrations` 和 `pnpm dev -- --resume <selector>`。

Shell 使用 Home 选择的 Electron。开发 Worker 使用 DSH 锁定的 Electron 可执行文件，因为原生插件加载器与特定 Electron 版本匹配。Worker 作为 App 子进程运行，通过现有私有 IPC 通道请求模型步骤。

在 macOS arm64 上，首个开发会话通过 Home 配置的路线返回了指定回复并生成标题。Runtime 为 `ai.nimi.dsh` 记录了两次调用。监督的 Host 重启后，同一个开发注册重新打开了该会话。

DSH 开发 App 写入并读回了实际工作区文件。停止前台 Shell 命令后，延迟标记文件没有出现。两种进程内委托工具都完成了由模型执行的子任务。第二个开发注册在自己的 Nimi 存储命名空间下建立默认工作区，并显示空会话列表。

macOS 本地开发使用 Kit `0.24.0-rc.15.scope.1`、匹配的原生载体与源码 Runtime。Host 监听当前账户的会话寿命。登出时先关闭旧工作区和文件预览，再退出 Worker。登录后从原开发注册启动即可读取当前账户的会话和草稿。

每次打开桌面工作区时，应用都会向已认证的 Worker 读取当前插件脚本。导入的思考记录可以在历史视图阅读。提交给 Nimi 的上下文保留其他来源的公开回答和配对的工具结果，推理回放只使用相同路线产生的内容。

Nimi 模型适配器声明文本请求上限为 128 条消息和 1 MiB。每种 DSH 会话预设都会在选择完整的摘要区段时使用这些限制。桌面开发 App 通过本地文件导入 65 轮短对话，经 Nimi 完成摘要并继续，正确回答了只在第一轮出现的交接代号和时间。验证后已关闭本地会话导入插件。

视觉测试使用 Home 配置的 GPT-6 Luna 路线。DSH 将实际合成 PNG 作为工具结果读取，通过 Nimi 发送图片，并返回正确的色带顺序。手动 `/compact` 生成检查点，下一轮回忆出了这些颜色。

当已安装的 Chrome 可执行文件可用时，macOS 开发配置还会在隔离的无头 Chrome 会话中运行 Playwright MCP。App 打开了本机 Nimi 页面、保存实际 PNG 截图，模型报告了可见主标题。Playwright 使用独立的短路径套接字目录。原生 Computer Use 作为可选插件启用，其 helper 持有 macOS 权限。

用户为开发 helper 授予辅助功能和屏幕录制权限后，原生 Computer Use 在获准的 TextEdit 测试窗口上通过。DSH 查询两项权限、选中准确窗口、读取辅助功能树，并通过 Nimi 回传截图。随后它经原生界面输入追加验证行，保存测试文档并再次截图。文件字节包含该行。

macOS arm64 候选构建运行 `pnpm exec nimi-app build --target macos-aarch64`，然后运行 `pnpm exec nimi-app pack --target macos-aarch64 --production`。这会调用现有 DSH Electron 打包，将生成的 Bundle 封装为本地 Nimi 包。通过 **Apps → Add App → Import local package** 安装。在 Home 选择文本模型。模型桥使用当前 App 会话，并通过 App 的受管存储命名空间划分 DSH home。

本地候选与上游发布分别使用自己的工作流。候选构建目标为 macOS arm64。

在 macOS arm64 上，Home 本地导入并启动 `0.2.2-rc.3.20261118.1`。安装包的 RunAsNode Worker 新建会话，首轮回复与自动标题由 Nimi Runtime 调用 DeepSeek Flash 完成。重开同一安装来源后，两者仍在。Luna 路线起初返回上游不可用。在 Home 恢复该路线后，另建安装态会话，首轮灯塔欢迎词和自动标题也分别经 Nimi Runtime 成功完成。本次使用源 Runtime。

下一本地候选 `0.2.2-rc.3.20261118.2` 使用 SDK rc.7 和 Kit rc.11。该受管配置由 Nimi Home 分发更新，并关闭上游反馈与产品统计插件。用户仍可在本地导出会话。开发态设置页和重开续聊已通过，Home 已将本地导入副本从 .1 更新至 .2，启动后保留原有会话，安装版 Worker 完成自动标题和模型驱动的 Computer Use 权限查询。.2 默认的 Helper 清单指向开发代，此次通过公开 helperPath 指定同一个包内的正式 Helper。用户为正式 Helper 开启辅助功能和屏幕录制后，安装版从指定 TextEdit 窗口回传了 1346 × 878 WebP，模型正确抄录全部三行。TextEdit 仅对这次会话放行。.3 本地包已独立准备并验证正式 Helper，尚未安装。
