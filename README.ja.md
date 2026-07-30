<p align="center">
  <img src="docs/assets/mascot.svg" alt="Muse の青い鳥のマスコット" width="120" />
</p>

# Muse

<p align="center">
  <b>暮らし方と働き方を学び、いつ、どのように手伝うべきかを少しずつ合わせていくパーソナル AI。</b><br/>
  <i>プロバイダー非依存、柔軟な配置。そして、まだできないことを曖昧にしません。</i>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ko.md">한국어</a> ·
  <strong>日本語</strong> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

Muse は仕事専用のアシスタントではなく、一人の生活と仕事を継続して支えるエージェントです。目標は <strong>Attunement（歩調合わせ）</strong>。何を知っているかだけでなく、助けが合う場面、静かにしているほうがよい場面、前回の提案が本当に役立ったかを学ぶことを目指します。

最初の具体的な体験が <strong>Personal Continuity</strong> です。ユーザー自身が <code>life</code> または <code>work</code> の未完了テーマを作り、ローカルのタスクやノートを正確に結び付けます。Muse はそのリンクだけを使って、再開に必要な文脈と安全な次の一歩を提示します。テーマの自動検出、常時観察、最適なタイミングの推定はまだロードマップです。

> **現在利用できるもの:** パーソナルメモリ、根拠付きリコール、ローカルの個人用ストア、ガード付きツール／ブラウザー操作、トレース、チェックポイント、そして明示的に開始する Personal Continuity の最初の経路。詳しくは [Attunement のプロダクト契約](docs/strategy/attunement.md) と [実装計画](docs/goals/attunement-implementation-plan.md) を参照してください。

## Muse が目指す「驚きの瞬間」

宿泊先を三つ比較している途中で止まり、その後フライト時刻が変わり、一つの
キャンセル期限が明日に迫り、予定の間に18分できたとします。Muse は変更点だけを
準備し、「なぜ今か」、正確な根拠、操作がどこまで進むかを示してから、候補を一つ
保留するか尋ねます。

「今ではなく今晩」と答えた場合、隠れた全体設定にはしません。その旅行 thread
だけに適用する協働ルールを、試用・編集・拒否・ロールバック可能なカードとして提案します。

- **Shadow Muse** — 邪魔や実行をする前に、話す時と黙る時を学びます。
- **Continuity Capsule** — 中断地点、変化、根拠、次の一歩、準備済み作業、所要時間を復元します。
- **Policy Card** — Muse がこの人との協働方法について学ぶ提案と根拠、適用範囲、操作を示します。

> **Muse はアプリではなく、あなたが続けようとしていた状態を記憶します。**

これは代表的なロードマップであり、実装済みという主張ではありません。基盤は単なる
外部 graph DB ではなく、軽量な時間・来歴グラフ兼 personal context compiler である
[Muse Attunement Graph (MAG)](docs/design/attunement-graph.md) です。
[Agent-Native Graph Core blueprint](docs/design/agent-native-graph-core.md) が
scope-safe snapshot、proof-closed Working Graph、完全性、ローカル保存境界を定義し、
MAG は将来そのまま別リポジトリへ抽出できる独立 Product Module として開発します。
Engine と公開 Interface は TypeScript を維持し、SQLite は worker に隔離します。
大規模 traversal、hash、rebuild、forget は、実測でボトルネックと証明された場合に
限り、同じ conformance の背後で Rust により選択的に高速化します。詳細は
[language/runtime ADR](docs/adr/0002-mag-language-runtime-boundary.md) にあります。
現在の package には、独立検証済みの最初の中立 lifecycle
`openMag({ scope, store }) → project(canonical-projection@1) →
execute(working-graph@1) → close()` が実装されています。同梱の in-memory Store
は意味論検証用 oracle であり、永続 Store ではありません。SQLite、clean-room
package、Source Adapter、独立リリースは roadmap のままで、AWG-065 全体も
`partial` です。
現在は明示的な `muse.continuity.pack.preview` が、検証済みの process-local
Graph 基準線を実際に dogfood します。最初の呼び出しで基準線を作り、以降は
制限された semantic resume 比較を返します。同じ Preview で明示的に要求すると、
正確に結合された Pack/Graph 結果だけが検証済みの英韓二言語 Continuity Capsule
render data を返します。永続 Graph、自動タイミング、Capsule 製品 UI、
実行権限を意味しません。
実行順序は [wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md) に記録されています。

<p align="center"><img src="docs/images/web-home.png" alt="Muse コンソールのホーム画面" width="860" /></p>

---

## 📊 数字で見る Muse

README に掲載するのは、管理された条件で確認できた二つの結果だけです。失敗、変化なし、診断用の証拠は図に昇格させず、[エビデンス索引](docs/benchmarks/EVIDENCE.md)で公開し続けます。

### 根拠づけ（grounding）の限定結果

**例:** 同じ架空の予約質問に対し、grounding は根拠のない推測ではなくリンク済みノートを引用すべきです。独立した二つの管理下チェックで、faithfulness は自作ケースの **ON 16/17 対 OFF 0/17**で **+0.94**、squad ケースの **ON 5/8 対 OFF 0/8**で **+0.63**でした。False-refusal コストは **0/12 対 0/12** と **0/8 対 0/8**で、どちらも **+0.00**です。分母が異なるため合算スコアではありません。

![独立した二つの grounding チェックにおける faithfulness の実数と false-refusal コスト](docs/benchmarks/readme-qualified-grounding-v1.svg)

出典: [公開範囲を固定した README エビデンス一覧（manifest）](docs/benchmarks/readme-qualified-evidence-v1.json) · [全エビデンス索引](docs/benchmarks/EVIDENCE.md)

### 管理下の合成データ規模と完全性

**例:** 架空の予約訂正レコードで、個人データに触れず現在時刻と以前の時刻を区別できるかを検査します。独立した **1K / 10K / 100K / 1M** コーパスの全体では、生成・直列化・解析 + スキーマ検証がそれぞれ **1,111,000/1,111,000件**でした。全コーパスとは別の runtime 標本は **96** セルで、名前を明記した Muse の公開境界 **768/768件**を通過しました。LLM・ツール・ネットワーク呼び出しは **0 / 0 / 0**で、所有者状態はバイト単位で不変でした（**byte-stable**）。

![管理下の全合成コーパスと別枠の768件runtime標本を区別した規模結果](docs/benchmarks/readme-controlled-scale-v1.svg)

出典: [正本 scale JSON](docs/benchmarks/eval-datasets-scale-v1.json) · [公開範囲を固定した README エビデンス一覧（manifest）](docs/benchmarks/readme-qualified-evidence-v1.json) · [全エビデンス索引](docs/benchmarks/EVIDENCE.md)

境界: エージェント総合は **10/11 FAILED**、実利用での有効性（organic effectiveness）は **NOT_PROVEN**、訂正情報のリコール（recall correction）は **UNQUALIFIED**です。管理下の合成完全性は個人学習ではありません。管理下の証拠は organic effectiveness ではありません。**1,111,000 レコードは 1,111,000 回のエージェント実行ではありません。**

---

## ⚡ インストールとクイックスタート

~~~bash
# 必要環境: Git + Node.js >= 22.12（Node 24 LTS 推奨）+ pnpm 10
git clone https://github.com/wlsdks/muse-agent.git
cd muse-agent
corepack enable
pnpm install:muse
muse onboard
~~~

対応しているソースインストールは clean な <code>main</code> を使い、依存関係を frozen install し、workspace を build して CLI を link・検証します。事前確認は <code>pnpm install:muse -- --dry-run</code>、更新は <code>muse update</code>、ローカルデモは <code>pnpm demo</code> です。

明示的な Continuity thread を始める例:

~~~bash
muse thread start "誕生日の計画" --kind life
muse thread link <thread-id> note birthday.md --role context
muse thread link <thread-id> task <task-id> --role next-step
muse continue <thread-id>
muse thread outcome <delivery-id> used
~~~

そのほかのローカル実行:

~~~bash
muse chat --local --user me
muse status --user me
muse proactive watch --user me --interval 60
~~~

<code>muse ask</code> は参照元を明記し、開ける receipt とともに grounded answer を返します。

<p align="center"><img src="docs/images/cli-ask.png" alt="参照元と receipt を表示する muse ask" width="860" /></p>

---

## 🔧 主な機能

- **プロバイダー非依存の推論:** OpenAI、Anthropic、Gemini、OpenRouter、Ollama、LM Studio、OpenAI-compatible endpoint を一つの <code>ModelProvider</code> 境界で扱います。
- **Personal Continuity とメモリ:** 明示的な life/work thread、正確なローカル source link、outcome、fact、preference、veto、goal。
- **根拠付きリコール:** ローカルノートの ranking、confidence gate、freshness、citation。証拠が弱いときに自信のある回答を作りません。
- **個人用ツール:** ローカルの note、task、reminder、contact と、五種類の calendar backend。
- **ガードされた操作:** fail-close guard、fail-open hook、明示的 approval、untrusted tool output、loop/timeout 上限、trace。
- **一つの runtime:** CLI、API/web chat、messaging、scheduled job、delegated worker は同じ composition root を共有します。
- **双方向 MCP:** built-in <code>muse.*</code> tool と、他の agent に read-only recall/search/user-model access を提供する <code>muse mcp serve</code>。
- **配置に依存しないプライバシー:** file-backed personal store は cloud account なしで動作し、local/cloud model provider は同じ抽象境界を使い、<code>MUSE_LOCAL_ONLY=true</code> はユーザーが選べる fail-close mode です。

## Muse がしないこと（境界）

- **資金を動かしません。** 金融口座への接続、支払い、送金は行いません。
- **第三者へ自律送信しません。** メール、チャット、フォーム、予約は draft-first。送信先と本文をユーザーが確認します。
- **Continuity を勝手に推測しません。** thread と source link はユーザーが作成します。自動検出は将来の opt-in 機能です。
- **一人、一環境向けです。** multi-tenant workspace、共有アカウント、RBAC の製品ではありません。
- **証拠クラスを混ぜません。** software test、synthetic replay、component diagnostic、agent trial、organic outcome は別々に扱います。

強制される境界は [outbound safety](.claude/rules/outbound-safety.md) と [Attunement 設計](docs/design/attunement.md) を参照してください。

## 🧩 プロバイダーと配置モード

<code>MUSE_MODEL=&lt;provider&gt;/&lt;model&gt;</code> と通常の API key 環境変数で provider を選びます。<code>MUSE_MODEL_PROVIDER_ID</code>、<code>MUSE_MODEL_API_KEY</code>、<code>MUSE_MODEL_BASE_URL</code> で明示的に上書きできます。cloud provider と <code>MUSE_LOCAL_ONLY=true</code> は併用できません。

local-only 実行は Muse の製品アイデンティティではなく、ユーザーが選択できる privacy posture です。

Ollama を使う無料・オフライン経路:

~~~bash
brew install ollama
ollama serve &
ollama pull gemma4:12b
muse setup local
~~~

個人データは標準で file-backed です。notes は <code>~/.muse/notes/</code>、tasks は <code>~/.muse/tasks.json</code>、reminders は <code>~/.muse/reminders.json</code>、memory は <code>~/.muse/user-memory.json</code> に保存されます。<code>muse setup calendar</code> は Local、Local-ICS、Google、CalDAV、macOS Calendar に対応します。Windows では CLI、API、recall、Ollama、opt-in PowerShell actuator が利用でき、macOS 専用 mirror は自動で無効になります。

モデルの tier、license、latency、troubleshooting は [ローカルモデル設定](docs/setup-local-llm.md) にあります。

## ✅ 検証

編集時は狭い gate、merge 前は full gate を使います。

~~~bash
pnpm typecheck:fast
pnpm test:changed
pnpm check
pnpm smoke:broad
pnpm smoke:live
~~~

<code>smoke:live</code> はローカルの Ollama を明示的に使用し、接続できなければスキップします。時間のかかる <code>pnpm eval:agent</code> は夜間または手動実行向けです。最新の有効なエージェント評価は 10 件合格、1 件不合格、未確認 0 件、つまり **10/11**。総合判定は **FAILED** のままです。

## 📖 ドキュメント

- [Attunement のプロダクト契約](docs/strategy/attunement.md)
- [Attunement のアーキテクチャと現在の gap](docs/design/attunement.md)
- [Muse Attunement Graph (MAG)](docs/design/attunement-graph.md)
- [Agent-Native Graph Core blueprint](docs/design/agent-native-graph-core.md)
- [Attunement 実装計画](docs/goals/attunement-implementation-plan.md)
- [Attunement wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md)
- [システムマップ](docs/SYSTEM-MAP.md)
- [検証済み feature catalog](docs/feature-catalog/INDEX.md)
- [エビデンス索引](docs/benchmarks/EVIDENCE.md)
- [セキュリティ方針](SECURITY.md)

## 💬 コミュニティとサポート

質問、bug、feature idea は [GitHub Issues](https://github.com/wlsdks/Muse/issues) へ。脆弱性は公開 issue ではなく [SECURITY.md](SECURITY.md) の方法で報告してください。

## コントリビューション

変更前に [CONTRIBUTING.md](CONTRIBUTING.md)、[CLAUDE.md](CLAUDE.md)、[domain rules](.claude/rules/) を読んでください。Conventional Commits を使い、commit と PR の説明は英語で記述します。

## ライセンス

[MIT](LICENSE)。runtime、adapter、tooling は open source で、contribution も同じ条件で受け入れます。
