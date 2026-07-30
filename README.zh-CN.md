<p align="center">
  <img src="docs/assets/mascot.svg" alt="Muse 的蓝鸟吉祥物" width="120" />
</p>

# Muse

<p align="center">
  <b>一个会逐渐理解你的生活与工作方式，并学会何时、如何提供帮助的个人 AI。</b><br/>
  <i>本地优先，不绑定模型提供方，也不会把尚未实现的能力说成已经可用。</i>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.ja.md">日本語</a> ·
  <strong>简体中文</strong>
</p>

Muse 不只是办公助手，而是面向一个人的生活与工作的持续型智能体。它的长期方向叫 <strong>Attunement（默契适配）</strong>：不只记住信息，还要学会什么时候适合帮忙、什么时候最好保持安静，以及上一次建议是否真的有用。

第一个可以亲手使用的路径是 <strong>Personal Continuity</strong>。你主动创建一个 <code>life</code> 或 <code>work</code> 主题，并准确关联本地任务和笔记；Muse 只使用这些由你关联的来源，整理“上次做到哪里”和一个安全的下一步。自动识别主题、持续观察以及按时机主动介入仍属于路线图，并非当前能力。

> **现在已经可用：** 个人记忆、有来源依据的召回、本地个人数据存储、受保护的工具与浏览器操作、追踪、检查点，以及第一条由用户明确触发的 Personal Continuity 路径。产品边界见 [Attunement 产品契约](docs/strategy/attunement.md)，交付顺序见 [实施计划](docs/goals/attunement-implementation-plan.md)。

## 我们正在打造的 Muse“惊喜时刻”

假设你在比较三个住宿选项时停了下来。之后航班时间发生变化，其中一家住宿的
取消期限临近明天，而你的日程中刚好出现了18分钟空档。Muse 只准备变化部分，
解释为什么是现在，列出每一项准确来源，并说明点击后会执行到哪一步，再询问是否
暂时保留一个候选。

如果你选择“现在不要，晚上再说”，Muse 不会把它悄悄写成全局偏好，而会提出一条
只适用于这次旅行 thread、可试用、编辑、拒绝和回滚的协作规则。

- **Shadow Muse** — 在打扰或行动之前，先学习何时开口、何时保持安静。
- **Continuity Capsule** — 恢复中断点、后续变化、证据、下一步、已准备工作和预计时间。
- **Policy Card** — 展示 Muse 想如何更好地与你协作，以及证据、范围和可逆控制。

> **Muse 记住的不是应用，而是你原本想继续推进的状态。**

这是标志性的路线图，并不表示已经交付。它的基础不是简单接入第三方 graph DB，
而是轻量、面向智能体的时间与来源图谱兼 personal context compiler：
[Muse Attunement Graph (MAG)](docs/design/attunement-graph.md)。
[Agent-Native Graph Core blueprint](docs/design/agent-native-graph-core.md)
定义 scope-safe snapshot、proof-closed Working Graph、完整性与本地存储边界。
MAG 按未来可直接拆分为独立仓库的产品 Module 开发。Engine 与公开 Interface
保持 TypeScript，SQLite 在 worker 中隔离；只有在真实测量证明大规模遍历、哈希、
rebuild 或 forget 成为瓶颈时，才会在同一 conformance 合同后选择性使用 Rust
加速。详细决策见
[语言与运行时 ADR](docs/adr/0002-mag-language-runtime-boundary.md)。
当前 package 已实现并独立验证首个中立 lifecycle：
`openMag({ scope, store }) → project(canonical-projection@1) →
execute(working-graph@1) → close()`。随附的内存 Store 只是语义验证 oracle，
并非持久化存储。SQLite、clean-room 打包、Source Adapter 和独立发布仍在路线图中，
AWG-065 整体状态仍为 `partial`。
目前，显式 `muse.continuity.pack.preview` 已开始实际 dogfood 经过验证的
process-local Graph 基线：首次调用建立基线，后续调用返回受限的语义 resume
比较。在同一个 Preview 中显式请求时，只有精确绑定的 Pack/Graph 结果才会返回
经过验证的英韩双语 Continuity Capsule 渲染数据。这并不代表持久化 Graph、
自动时机判断、Capsule 产品 UI 或行动权限已经交付。
执行顺序见 [wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md)。

<p align="center"><img src="docs/images/web-home.png" alt="Muse 控制台首页" width="860" /></p>

---

## 📊 用数字看 Muse

README 只发布两项通过受控检查的结果。失败、无变化和诊断性证据不会升级为图表，仍完整保留在[证据索引](docs/benchmarks/EVIDENCE.md)中。

### 通过受控检查的 grounding 结果

**例子：** 对同一个虚构预约问题，grounding 应引用已链接的笔记，而不是无依据地猜测。两项相互独立的受控检查中，faithfulness 在自编案例为 **ON 16/17 对 OFF 0/17**，增量 **+0.94**；在 squad 案例为 **ON 5/8 对 OFF 0/8**，增量 **+0.63**。False-refusal 成本分别为 **0/12 对 0/12**、**0/8 对 0/8**，增量均为 **+0.00**。两项检查的分母不同，不能合并成一个总分。

![两项独立grounding检查的faithfulness原始数量与false-refusal成本](docs/benchmarks/readme-qualified-grounding-v1.svg)

来源：[范围固定的 README 证据清单（manifest）](docs/benchmarks/readme-qualified-evidence-v1.json) · [完整证据索引](docs/benchmarks/EVIDENCE.md)

### 受控合成数据的规模完整性

**例子：** 虚构的预约修正记录用于检查能否在不接触个人数据的情况下区分当前时间与旧时间。四个相互独立的 **1K / 10K / 100K / 1M** 语料在全量范围内分别完成 **1,111,000/1,111,000 条**生成、序列化、解析 + schema 校验。与全量语料分开的 runtime 抽样在 **96** 个单元中通过了 **768/768 条**具名 Muse 公共边界；LLM、工具和网络调用为 **0 / 0 / 0**，所有者状态在字节层面保持不变（**byte-stable**）。

![区分受控合成全量语料与独立768条runtime抽样的规模结果](docs/benchmarks/readme-controlled-scale-v1.svg)

来源：[基准 scale JSON](docs/benchmarks/eval-datasets-scale-v1.json) · [范围固定的 README 证据清单（manifest）](docs/benchmarks/readme-qualified-evidence-v1.json) · [完整证据索引](docs/benchmarks/EVIDENCE.md)

边界：智能体总评为 **10/11 FAILED**，真实使用效果为 **NOT_PROVEN**，信息修正召回（recall correction）仍为 **UNQUALIFIED**。受控合成完整性不代表个人学习。受控证据不代表真实使用效果。**1,111,000 条记录不等于 1,111,000 次智能体运行。**

---

## ⚡ 安装与快速开始

~~~bash
# 环境要求：Git + Node.js >= 22.12（推荐 Node 24 LTS）+ pnpm 10
git clone https://github.com/wlsdks/muse-agent.git
cd muse-agent
corepack enable
pnpm install:muse
muse onboard
~~~

受支持的源码安装要求干净的 <code>main</code>，会冻结依赖安装、构建 workspace、链接 CLI 并执行验证。用 <code>pnpm install:muse -- --dry-run</code> 预览，用 <code>muse update</code> 更新，或运行 <code>pnpm demo</code> 查看带讲解的本地演示。

主动创建一个 Continuity thread：

~~~bash
muse thread start "准备生日聚会" --kind life
muse thread link <thread-id> note birthday.md --role context
muse thread link <thread-id> task <task-id> --role next-step
muse continue <thread-id>
muse thread outcome <delivery-id> used
~~~

其他常用的本地流程：

~~~bash
muse chat --local --user me
muse status --user me
muse proactive watch --user me --interval 60
~~~

<code>muse ask</code> 会返回带引用依据、且来源可以打开核对的 grounded answer。

<p align="center"><img src="docs/images/cli-ask.png" alt="带引用与可打开来源的 muse ask" width="860" /></p>

---

## 🔧 核心能力

- **不绑定模型提供方的推理层：** 用同一个 <code>ModelProvider</code> 边界连接 OpenAI、Anthropic、Gemini、OpenRouter、Ollama、LM Studio 与 OpenAI-compatible endpoint。
- **Personal Continuity 与记忆：** 明确区分 life/work thread，只使用用户准确关联的本地来源，并保存 outcome、fact、preference、veto 与 goal。
- **有依据的召回：** 本地笔记排序、confidence gate、新鲜度处理和 citation；证据不足时不会给出自信断言。
- **个人工具：** 本地 note、task、reminder、contact，以及五种 calendar backend。
- **受保护的动作：** fail-close guard、fail-open hook、明确 approval、不信任 tool output、有限 loop/timeout 和 trace。
- **一个 runtime：** CLI、API/web chat、messaging、scheduled job 与 delegated worker 共用同一个 composition root。
- **双向 MCP：** 内置 <code>muse.*</code> 工具，同时可通过 <code>muse mcp serve</code> 向其他 agent 提供只读召回、搜索和 user-model access。
- **本地优先：** 文件型个人存储不需要云账号；<code>MUSE_LOCAL_ONLY=true</code> 会拒绝云模型提供方。

## Muse 不会做什么（边界）

- **不会移动资金。** 不连接金融账户，不发起付款或转账。
- **不会自主向第三方发送。** 邮件、聊天、表单和预订都先生成草稿；内容和收件人由你确认。
- **不会暗中猜测 Continuity 归属。** thread 与 source link 由用户创建；自动识别属于未来的 opt-in 工作。
- **只面向一个用户、一个环境。** Muse 不是多租户 workspace，也没有共享账号或 RBAC 产品模型。
- **不会混淆证据类别。** software test、synthetic replay、component diagnostic、agent trial 与 organic outcome 始终分开。

强制执行的边界见 [outbound safety](.claude/rules/outbound-safety.md) 和 [Attunement 设计](docs/design/attunement.md)。

## 🧩 模型提供方与本地运行

通过 <code>MUSE_MODEL=&lt;provider&gt;/&lt;model&gt;</code> 和相应的 API key 环境变量选择 provider。<code>MUSE_MODEL_PROVIDER_ID</code>、<code>MUSE_MODEL_API_KEY</code>、<code>MUSE_MODEL_BASE_URL</code> 可显式覆盖。云 provider 与 <code>MUSE_LOCAL_ONLY=true</code> 不兼容。

使用 Ollama 的免费离线路径：

~~~bash
brew install ollama
ollama serve &
ollama pull gemma4:12b
muse setup local
~~~

个人数据默认保存在本地文件：notes 位于 <code>~/.muse/notes/</code>，tasks 位于 <code>~/.muse/tasks.json</code>，reminders 位于 <code>~/.muse/reminders.json</code>，memory 位于 <code>~/.muse/user-memory.json</code>。<code>muse setup calendar</code> 支持 Local、Local-ICS、Google、CalDAV 与 macOS Calendar。Windows 支持 CLI、API、recall、Ollama 和 opt-in PowerShell actuator；仅限 macOS 的 mirror 会自动停用。

模型档位、许可证、延迟与排错方法见 [本地模型设置](docs/setup-local-llm.md)。

## ✅ 验证

编辑时使用窄范围 gate，合并前运行完整 gate：

~~~bash
pnpm typecheck:fast
pnpm test:changed
pnpm check
pnpm smoke:broad
pnpm smoke:live
~~~

<code>smoke:live</code> 会明确使用本地 Ollama，无法连接时会跳过。耗时更长的 <code>pnpm eval:agent</code> 用于 nightly/manual。最新合格结果是 10 passed、1 failed、0 unverified，也就是 **10/11**；aggregate 仍为 **FAILED**。

## 📖 文档

- [Attunement 产品契约](docs/strategy/attunement.md)
- [Attunement 架构与当前缺口](docs/design/attunement.md)
- [Muse Attunement Graph (MAG)](docs/design/attunement-graph.md)
- [Agent-Native Graph Core blueprint](docs/design/agent-native-graph-core.md)
- [Attunement 实施计划](docs/goals/attunement-implementation-plan.md)
- [Attunement wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md)
- [系统地图](docs/SYSTEM-MAP.md)
- [已验证功能目录](docs/feature-catalog/INDEX.md)
- [证据索引](docs/benchmarks/EVIDENCE.md)
- [安全说明](SECURITY.md)

## 💬 社区与支持

问题、bug 和功能建议请提交到 [GitHub Issues](https://github.com/wlsdks/Muse/issues)。安全漏洞请按 [SECURITY.md](SECURITY.md) 说明私下报告，不要创建公开 issue。

## 参与贡献

修改仓库前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[CLAUDE.md](CLAUDE.md) 和 [domain rules](.claude/rules/)。请使用 Conventional Commits，并用英文撰写 commit 与 PR 描述。

## 许可证

[MIT](LICENSE)。runtime、adapter 与 tooling 都是开源的，contribution 采用相同条款。
