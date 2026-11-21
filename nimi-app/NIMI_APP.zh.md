# Nimi DSH

Nimi DSH 基于开源项目 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 适配至 Nimi 平台，将本地代码与文件协作 Agent 工作区、桌面工具审批流与远程 Web 伴侣接入 Nimi Home 统一管理的 AI 模型、集成授权与账号体系。

## 快速开始

1. 在受支持的桌面设备（**Windows x64** 或 **macOS arm64**）上，从 Nimi Home 应用目录安装 **Nimi DSH**。
2. 登录 **Nimi Home**，在 **Nimi Home → AI 模型** 中确认至少有一个云端模型连接器或本地文本模型已就绪。
3. 从 Nimi Home 启动 **Nimi DSH**。若 Home 未登录或 Runtime 不可用，应用会停留在访问门禁界面，并提供打开 Nimi Home 与重新检查访问的快捷入口。
4. 在桌面端添加并选择本地工作区目录，在输入框下拉菜单选择模型，即可开始对话与任务执行。

## 模型选择与推理控制

- **云端、本地与已保存模型直选**：在输入框模型选择器中切换 **全部 / 云端 / 本地 / 已保存** 视图，按模型或提供方搜索。选择任一就绪的云端或本地模型后，应用会自动复用匹配配置或为本应用创建命名配置，并仅绑定到当前会话。
- **命名配置管理**：前往 **设置 → Nimi 模型与访问**（macOS 也可从应用菜单进入 **Nimi Models & Access…**）查看本机模型就绪状态、管理命名文本配置、配置可选的 **语音转写（`audio.transcribe`）** 模型，或跳转 Nimi Home 新增连接器与本地模型。
- **配置变更保护**：若会话绑定的模型配置在对话期间被修改，Nimi DSH 会在发送下一轮前暂停（`AI_CONFIG_REVISION_CONFLICT`），点击对话或设置中的 **采用更新后的配置** 确认后即可继续。
- **推理强度**：当所选模型提供推理挡位时，可直接在输入框中切换，更换模型后会自动刷新可用挡位。

## 远程 Web 伴侣

当主 PC 上的 Nimi DSH 桌面端处于运行状态，且已在 Nimi Home 中授权集成提供方（`ai.nimi.dsh.sessions`）后，可使用同一 Nimi 账号打开 Nimi DSH Web 伴侣：

- 浏览桌面端已有会话，或在桌面端已添加的工作区中新建会话。
- 发送幂等任务指令并实时查看流式进度与当前执行的工具。
- 审阅具体工具操作提案（包括文件写入、编辑与命令执行），按次允许或拒绝并附带审阅说明。
- 浏览、上传与下载当前会话工作区内的文件（单文件上限 32 MiB）。

**桌面工作区前置条件**：从 Web 伴侣新建会话前，需先在 Nimi DSH 桌面端添加至少一个本地工作区，并保持主 PC 的 Nimi Home 与 Nimi DSH 桌面端在线。首次从浏览器连接需在主 PC 的 Nimi Home 完成来源确认，并按需授予 `ai.nimi.dsh.sessions` 集成操作许可。

## 集成、Home 对话导入与活动通知

- **已授权集成**：在 **设置 → 集成** 中查看 Nimi Home 授予本应用的服务与操作。Agent 仅调用经授权的集成能力，应用本身不读取或存储外部服务凭证。
- **延续 Nimi Home 对话**：在 Nimi Home 导出对话（`nimi.home-chat.v1`）后，可在 **设置 → Nimi 账号** 中导入消息与草稿；重复导入同一文件会直接打开已有会话。
- **Home 活动动态**：当会话等待审批、完成一轮回复或出现异常时，Nimi DSH 会向 **Nimi Home 活动** 发送状态更新，点击即可直达对应会话。
- **音频转写**：配置 `audio.transcribe` 模型后，Agent 可通过 Nimi Runtime 转写工作区内的音频文件。

## 数据与隐私

- 会话记录、工作区绑定与本地偏好保存在本机按账号隔离的 `~/.nimi-dsh` 目录中。
- 项目与任务文件始终保存在你明确指定的本地工作区目录中。
- 提示词、相关工具输出与可选音频文件会经由 Nimi Runtime 发送至该会话所选的本地模型，或通过你在 Nimi Home 配置的连接器发送至云端模型。
- Nimi 托管桌面版已关闭上游遥测统计、反馈上报及独立自动更新插件，应用生命周期由 Nimi Home 管理。

## 限制与开源署名

- **可用宿主平台**：原生 Nimi DSH 桌面端支持 **Windows x64** 与 **macOS arm64**。终端、文件与浏览器工具均在你本机当前桌面用户权限下执行。
- **Web 伴侣依赖主 PC**：Web 伴侣不在云端托管执行环境，需要主 PC 的 Nimi Home 与 Nimi DSH 桌面端保持运行。
- **子 Agent 预设限制**：子 Agent 模型白名单仅接受已持久保存的 Nimi 命名配置（**设置 → Agent 预设**）。
- **上游项目与许可**：基于 MIT 协议适配自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。Nimi 适配相关问题请提交至 [github.com/nimiplatform/deepseek-harness/issues](https://github.com/nimiplatform/deepseek-harness/issues)。
