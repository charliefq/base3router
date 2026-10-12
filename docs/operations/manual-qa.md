# B3R 手工验收准备包（不是验收通过）

版本：PR #45，ac0c3ace530744960abb9deeb7ca350a7e7c71cb，包含 PR #31–45。代码/自动测试已接受。

本包只含脚本和步骤，不含数据库、sessions、配对 URL、令牌、用户数据或启动日志。不要上传 private-startup.log 或 userdata。环境默认 provider 全禁用，仅 metadata-only QA fixture 可用；它拒绝 session/turn RPC，没有 paid network 或真实 provider。

## 在候选不切换 HEAD 的前提下加载工具

工具分支的 commit 只提供辅助脚本；不要把候选切换到该分支。已存在精确候选的机器可直接执行：

```bash
qa_candidate=/absolute/path/to/accepted/base3router
qa_tool_dir=$(mktemp -d)
git -C "$qa_candidate" fetch origin codex/manual-qa-preparation
git -C "$qa_candidate" archive origin/codex/manual-qa-preparation scripts/manual-qa docs/operations/manual-qa.md | tar -x -C "$qa_tool_dir"
node "$qa_tool_dir/scripts/manual-qa/prepare.mjs" "$qa_candidate"
node "$qa_tool_dir/scripts/manual-qa/start.mjs" "$qa_candidate"
```

在第二个终端使用同一 `qa_tool_dir` 和 `qa_candidate` 跑 `health.mjs`。fetch/archive 不改变候选 HEAD 或工作树；候选仍必须精确 ac0c3ace。最终交接给出的精确工具 commit 可代替 `origin/codex/manual-qa-preparation`，防止工具分支后续移动。

## 本机启动

需要已按该 checkout 的 docs/operations/development.md 安装的 Node 24+ 和 repository dependencies（冻结 lockfile）。若已有工作目录有改动，保留原目录，创建新 worktree；不要 reset/clean：

    git fetch origin codex/collaboration-navigation-keybindings
    git worktree add --detach ../base3router-manual-qa ac0c3ace530744960abb9deeb7ca350a7e7c71cb

在新 worktree 按仓库开发文档准备依赖。解压此包到仓库以外，例如 ~/Downloads/b3r-qa-kit。

    node /path/to/b3r-qa-kit/prepare.mjs /path/to/base3router-manual-qa
    node /path/to/b3r-qa-kit/start.mjs /path/to/base3router-manual-qa

保留 start 的终端运行；在另一个终端执行：

    node /path/to/b3r-qa-kit/health.mjs /path/to/base3router-manual-qa

默认数据位于新 worktree 的 .t3/qa-ac0-local。prepare 拒绝覆盖已存在目录或非 .t3/qa-* 路径。重启只用 start，不重复 prepare。

健康输出会报告实际 localhost origin；它只对同一机器可用，不是可公开分享链接。首次配对请只在自己机器打开 .t3/qa-ac0-local/private-startup.log，读取新鲜完整 startup pairing URL，直接在本机浏览器使用。不要把 URL/日志发送到聊天或 GitHub。若过期，Ctrl+C 停止自己的 start，再重新 start，读取新的启动输出。不要修改真实 ~/.t3/userdata。

## 手工步骤与预期

1. 配对后确认 QA alpha / QA beta 两个 disposable 项目，以及 Alpha 的“QA read-only inspection — no provider turn”线程。若看不到，停止并记录版本、实际 origin 和错误，不发送 token。
2. 从命令面板分别搜索 agents/providers 和 tasks/delegation；导航到对应页面，面板关闭。设置的自定义导航标签应为 Agents: Open、Tasks: Open。
3. QA 状态预置 Mod+Alt+Shift+A / T 两个自定义快捷键（Mac 的 Mod 是 Cmd，其它平台为 Ctrl）；在普通页面触发，应导航并关闭面板。默认快捷键表没有新增项。可在此 disposable 环境修改/清除绑定，旧 palette 快捷键应仍工作；不要改真实用户配置。
4. Agents 选择 Alpha，打开 QA fixture，应恢复已有线程。切回 Agents 选择 Beta，快速重复点击 QA fixture，应收敛到一个 Beta 线程和绑定，不启动 provider。随后刷新、再开一个同 origin 的标签页并选择 Beta，应恢复同一线程 ID。记录地址栏 thread ID，不能用不同身份/环境的结果代替。
5. 失败重试：在 disposable 页用浏览器网络离线模式造成一次请求失败，恢复网络并在同项目重试；应恢复或创建同一个有效线程/绑定。若请求尚未提交，不能声称验证了“提交后响应丢失”。不要制造真实 provider 故障，不点击 Send/Dispatch。
6. 项目切换：Alpha/Beta 各自恢复各自绑定，不能打开另一项目的线程。Grokbot 应保持 NOT_CONNECTED。Tasks 显示阻塞/执行不授权；失效或未知绑定不能导航。
7. Alpha inspection 线程打开 Governance / Workflow 预览区，选择 QA preview run 的当前 stage，Request/Preview 应展示只读内容；Reset 只清除预览，再请求应重新读取。切换项目/线程后旧预览不应当作新上下文结果。不要触发 Workflow Dispatch、accept/run 或 provider message。

每项记录：浏览器及版本、平台、精确 head、实际 origin、操作、预期/实际、截图（先隐藏配对凭证）。Browser、模拟器、物理真机分别记结果。本包没有自动 Browser/Device 通过证据。

## 已验证与限制

准备环境实际运行了同一 prepare/start/health 路径：两项目、一条生产 thread/bind、一条 Workflow run；orchestration providerRuns=0、messages=0。四个同源 HTTP 路径返回 200，页面模块可编译，fake peer 只有 metadata 请求。HTTP 200 不证明页面操作成功。

云容器只核实 localhost。没有已核实用户可达的现成云映射；无 Tailscale 可执行文件、VPN 配置或运行态映射工具。不要新建网络/认证权限来绕过。若需云入口，由主线程/平台提供已有授权映射；配对仍须本地私密处理。

T3 preview/device 工具缺失，所以 AUTOMATED_QA_BLOCKED；技能禁止替换页面自动化。用户本机人工验收可进行。模拟器/真机还需具备 T3 host 的 device_list/device_open/device_screenshot、可用 host/device、native dev client 与可达 backend/Metro；物理设备结果不能由模拟器代替。

优先在第二终端运行 `node "$qa_tool_dir/scripts/manual-qa/start.mjs" "$qa_candidate" --stop`：校验记录的 dev-runner PID 和该 QA 路径后，只向其独立 process group 发 SIGTERM。Ctrl+C 也使用同一停止逻辑；停止后确认 health 无法连接，再用 start 重启。只删除确认属于此 QA 的 .t3/qa-* 目录。不要释放 generation 41，不 merge/release，不调用 Cursor，不更改付费、凭证或 live 配置。

安全边界：base 必须是规范仓库路径下 `.t3` 的单层 `qa-*` 子目录；拒绝符号链接。启动会验证完整禁用的真实 provider map、唯一 fixture 的精确 driver/config 路径及可信脚本内容。已记录进程或进程组仍存活时拒绝重复启动，保留日志和所有权记录。QA 子进程过滤应用、OTEL、Clerk、Vite 等环境配置，保留平台代理与认证保护变量；固定 loopback、禁用 share/Tailscale/analytics。存在根 `.env`/`.env.local` 时拒绝启动，不读取值；请使用没有这些文件的隔离候选，不删除真实配置。`start.mjs [repo] [base] --stop` 支持省略 base（默认 `.t3/qa-ac0-local`），自定义 base 时必须在停止命令中提供同一 base。

候选服务会在写 settings 时省略默认禁用的 pi/antigravity 和旧式 fixture config.enabled；严格 start 会拒绝这份非完整配置。停止并核实端口关闭后，可显式运行 `node "$qa_tool_dir/scripts/manual-qa/prepare.mjs" "$qa_candidate" /同一/qa-base --restore-settings`，仅恢复已核实省略的 QA 默认，再启动。该操作拒绝活跃进程组、其它缺失 provider、未知字段、真实 provider 启用、fixture driver/path/content 漂移；保留项目、线程和 keybindings。自定义 base 和默认 base 均支持。

回归命令（工具目录执行）：`node --test scripts/manual-qa/safety.test.mjs`。实际启动回归仅对精确 ac0、已装依赖且默认 `.t3/qa-ac0-local` 尚不存在的独立候选运行：`B3R_QA_REPO=/absolute/candidate node --test scripts/manual-qa/live.test.mjs`；会创建并保留 disposable QA 状态，测试后停止自己的进程组。不要为重跑而覆盖已有状态。

本次云端实测：5 组安全回归通过；1 组实际生命周期回归通过，分别注入 host 0.0.0.0 / ::、Tailscale true、relay 与三类 OTLP 地址和非秘密 headers/token。后端只监听 127.0.0.1，环境校验通过，本地外部请求 sentinel 命中 0；重复启动保留日志/进程记录，省略 base 的 --stop 成功，恢复配置后重启成功，最终进程组和 QA 端口关闭。不是 Browser/Device 验收。

Mac 已确认的旧版本结果：以明确隔离 base 停止旧 QA 进程组 31236 后无残留，6433 ECONNREFUSED，候选 ac0 干净。Mac 尚未完成新工具启动、health 或 UI；不要把云端结果当作 Mac 通过。
