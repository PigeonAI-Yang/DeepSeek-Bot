# DS Bot Autonomy

`ds-bot-autonomy` 是独立的 DS Bot 自主工作插件，通过公开 DSH Agent、Goal 和 storage-domain API 管理持久工作项。DS Bot 只提供 `dsBotAutonomyHost` v1 小适配层，不导入自主插件，也不向它暴露运行时、可变 roster 或 maps。

## 对 Bot 说

在 Bot 聊天中用自然语言交办，并说明目标、验收条件和允许范围。

- **交办持续任务：**“使用自主任务整理这份资料。完成条件：回答我的三个问题并标出来源；只使用我提供的文件，最多运行 20 轮。”
- **查看进度：**“列出我的自主任务，告诉我哪些正在执行、等待什么、还剩多少轮。”
- **停止或恢复：**“停止刚才的自主任务。”；“恢复这个任务，继续完成原来的目标。”
- **设置长期职责：**“每天上午 9 点整理指定资料目录的新内容，汇总后保存到工作区；只处理这个目录。先为我建立职责，再绑定定时触发。”
- **协作：**“把资料收集交给指定 Bot，等它返回结果后再整合并核验。”

默认每项任务最多运行 20 轮，可在交办时指定。需要你的答案时任务会等待；停止后需明确恢复。重启后未完成任务会保留并等待你恢复。定时工作需要 DS Bot 运行且主机保持唤醒。

## 使用

- `autonomy_submit_work`：提交目标、验收条件、目标 Bot、允许范围及正整数总轮数，默认 20 轮。
- `autonomy_list_work` / `autonomy_get_work`：读取已保存工作，不要求当前存在运行中的人类回合。
- `autonomy_stop_work` / `autonomy_resume_work`：停止并隔离迟到结果；由明确的人类回合恢复。
- `autonomy_manage_responsibilities`：保存、读取、修改或停止已授权职责。
- `autonomy_manage_schedules`：管理绑定职责的原生 Schedule；该服务可以不启用。
- `autonomy_delegate_work`：向另一 Bot 提交子任务，等待匹配结果，并由父任务整合证据、兑现原始验收。

`POST /api/bot` 提供 `autonomy-list`、`autonomy-get`、`autonomy-submit`、`autonomy-stop`、`autonomy-resume`、`autonomy-responsibilities`。修改操作携带当前 `sessionId`，授权必须来自该原生 Session 当前运行回合的真实人类输入。模型参数不能指定授权来源或返回地址。

公开 `ctx.dsBotAutonomy` 服务提供 submit/get/list/stop/resume、responsibilities、schedules 和 receiveDependency。修改方法的 actor 是准确的运行中 Agent 对象；工具包装器传 `exec.agent`，而非整个 exec。例如：

```js
const item = await ctx.dsBotAutonomy.submit({
  botId: 'writer',
  objective: '完成用户要求的报告',
  acceptance: '回答原始问题，并提供来源证据',
  allowedScope: '已批准的资料目录',
  maxGoalRounds: 20,
  resources: ['path:J:/approved-source', 'computer:shared'],
}, exactAgent)
const saved = await ctx.dsBotAutonomy.get(item.id)
```

resources 显式声明共享资源，`path:` 路径会规范化；Bot 和当前 Session 总会加入资源占用。职责也可以保存 resources。资源声明协调插件内部工作项，不改变文件系统权限。

## 运行行为

原生 Jobs 可用时，DS Bot 的命令使用 `run_in_background: true`，结果读取使用 `wait: false`。后台进程继续运行，同一个 Bot 可以回应新消息；任务结束后由原生完成通知接回结果。插件在执行前拒绝前台命令和阻塞读取，仍由原生权限与取消机制控制执行。自主 Goal 等待后台任务时不消耗继续运行轮数，只有同一项任务正常结束等待后才继续；用户停止、终止任务、卸载或 Goal 改变不会自动继续。此规则用于新调用，已经执行中的前台调用不能在不取消的情况下切换。

每项工作绑定准确 Agent/Session 的一个原生 Goal，复用已有原生 Goal 轮驱动，不新增驱动，也不修改原生 Goal 工具。原生 create/edit/resume 的人类授权规则保持原样。忙碌 Agent、未完成外来 Goal 或资源冲突使工作排队；换分段保留已经消耗的轮数和共享资源，不增加预算，不转发旧 Goal 回合消息。

每次原生 Goal 回合的计数写入持久表；写入失败时拒绝该工作执行，普通未托管回合保留原有路径。ask_user 等待准确的问题答案，子任务等待准确的父子 exchange。原生用户取消、Bot 停止、插件卸载均隔离迟到执行。重载后的未完成工作等待明确恢复，不自动追加普通 resume 回合。

最终文本在原生 Goal 完成后的工具结果步骤结束后保存。给用户的结果直接追加至原始返回聊天，不引发额外模型回合；子任务结果通过保存的父任务 exchange 返回，父任务整合后再完成。交付按稳定 ID 和原生 Session/inbox 事件核对；无法确认的交付保留 ambiguous 状态。

定时触发只接受原生 Schedule 来源、固定提醒格式及已保存职责绑定。职责目标、验收和范围不会被提醒内容替换。同一发生时刻去重；混合批次保留未绑定提醒。插件不会自动安装职责、任务、日程、外部事件订阅或轮询。

## 加载源码

先加载带 `dsBotAutonomyHost` v1 适配层的 DS Bot，再将本目录作为独立 Cordis 包 `ds-bot-autonomy` 加载。`cordis.patch.yml` 是 loader patch，本次检查没有安装它。插件等待 host、agents、goals、sessions、tools、storageDomain、systemPrompt 服务。配置中保留唯一已有 `@deepseek-ai/dsh-goal-round-driver`。

配置原生存储后端，并为 storage-domain 选择该后端。插件使用 `ds_bot_autonomy` v1 的 responsibilities 与 work_items 表。Schedule 为可选 peer。

## 源码验证范围

`test/native.test.js` 使用 DS Bot 测试台已有的公开 DSH 0.2.0-rc.2 包，真实加载 Cordis、Agent loop、Goal 工具、唯一 Goal round driver、JSON storage-domain 和 DS Bot 适配器，并使用离线模型。覆盖两轮真实执行和完成后最终文本、匹配答案、父子任务整合、原生用户取消、活动插件卸载/重载、剩余预算迁移到新原生 Session，以及真实 Schedule 存储、绑定迁移和混合提醒去重。用户交付没有额外模型回合。Schedule 检查另使用隔离 JSONL Session 持久层。

`test/service.test.js` 定向覆盖分段预算与回滚、忙碌/外来 Goal 排队、局部 Stop、显式资源、持久计数写入失败、混合提醒及未托管旧路径。

在本源码目录运行以下指定检查；DS Bot 源码测试台与 plugins 目录同级，或以 DSH_HARNESS 指定依赖运行时：

```powershell
node --import ./test/resolve-harness.mjs --test ./test/service.test.js ./test/native.test.js
```

此次源码验证未操作已安装 profile、用户数据、线上模型、真实 UI，也未打包、发布、部署或运行完整仓库测试套件。
