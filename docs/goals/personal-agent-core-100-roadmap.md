---
title: Muse personal-agent Core 100 roadmap
audience: [owner, product, engineering, evaluation]
purpose: Finish the smallest essential remaining program for a trusted daily provider-neutral personal AI agent
status: active-authoritative
updated: 2026-07-28
reconciledSourceHead: d693cea6fb1b6bf4889fa99dd38d9e5e0ae04642
supersedesForActivation:
  - personal-agent-productization-roadmap.md
related:
  - ../strategy/attunement.md
  - ../development/personal-agent-qualification.md
  - ../development/ai-agent-testing-strategy.md
  - ../../harness/AGENTS.md
---

# Muse personal-agent Core 100 roadmap

## 목적

이 문서는 기존 300-task 프로그램에서 **현재 source에 이미 구현·검증된 작업을 제외**하고,
Muse가 한 사용자의 실제 일상에서 신뢰받는 provider-neutral personal AI agent가 되기 위해
남은 핵심 작업만 100개의 실행 slice로 다시 고른 권위 실행 문서다.

제품의 성공 문장은 그대로다.

> Muse는 한 사용자의 삶과 일을 정확한 출처로 이어주고, 도움이 되었는지를 명시적으로 배우며,
> 권한을 몰래 확대하지 않은 채 안정적으로 매일 실행된다.

기존
[`personal-agent-productization-roadmap.md`](personal-agent-productization-roadmap.md)는
요구사항의 역사와 legacy ID를 찾는 참조 문서로 남긴다. 새 작업 활성화와 다음 작업 선택에는
이 문서가 우선한다.

## 현재 source reconciliation

이 목록은 `d693cea6fb1b6bf4889fa99dd38d9e5e0ae04642`의 source와 fresh evaluator 결과를
기준으로 만들었다. 다음은 새 100개에서 다시 구현하지 않는다.

- legacy Task 001–058에서 닫힌 기준선, resident runtime, delivery brake, terminal reliability,
  corrected-fact recall, owner memory inspect/correct/forget/undo 계약
- CLI actuator authority 분류와 `muse doctor`의 explicit permission repair surface
- `planSensitivePermissionRepair`와 `applySensitivePermissionRepair`가 이미 제공하는 exact-file,
  `O_NOFOLLOW`, mode-drift, symlink/scope 밖 거부 계약
- generic draft-first, untrusted tool-output, provider adapter, local personal store 같은 현재 substrate
- 990분 worst-case의 legacy Task 059–060 monolithic capability run

legacy 059–060은 품질 기준을 버린 것이 아니라 이 문서의 004–010에 있는 bounded,
cacheable shard 계약으로 대체한다. CLI permission 구현을 반복하지 않고 011–020은 아직 남은
독립 closure, cross-surface 분류, receipt, directory, encryption/restore delta만 다룬다.

작성 시점의 fresh qualification은 다음과 같다.

| 축 | current 판정 | 이 문서의 처리 |
| --- | --- | --- |
| resident runtime | passed, healthy | 재구현하지 않고 098–099 health/monitor에서 회귀만 감시 |
| capability | unverified | 004–010의 bounded shard/provenance로 대체 검증 |
| delivery | unverified, brake engaged | brake를 약화하지 않고 exact held reason을 유지 |
| organic effectiveness | not-proven | 040과 099의 EVIDENCE/MONITOR에서만 승격 판정 |
| permission/doctor source | built-unverified | 011에서 current 구현을 독립 closure한 뒤 남은 delta만 BUILD |

어떤 항목이 activation 시점의 current source에서 이미 충족됐음이 발견되면 재구현하지 않는다.
증거로 `verified-current` 또는 `superseded` 처리하고 같은 영역의 실제 missing delta를 다시
계획한다.

2026-07-30 reconciliation: Core100-075는 현재 timing store와 API no-send 경로로
`verified-current`다. legacy-115는 별도 reducer activation으로는 `superseded`이며, fresh
결정의 decision-time policy snapshot과 exact Source/Graph binding만 AWG-050b1의 distinct
delta로 분리했다. rule-v1/v2 기록은 계속 읽지만 Graph provenance로 승격하지 않는다.

## 20분 실행 계약

각 번호는 outcome이나 epic이 아니라 **한 번의 실제 activation으로 끝낼 수 있는 작업 단위**다.

- active wall-clock hard cap: **20분**
- 기본 배분: 조사·수정 12분 + 검증 6분 + receipt/handoff 2분
- 단일 명령의 허용 timeout과 예상 정상 실행시간: 최대 12분
- 시작 전 20분 안에 끝난다는 근거가 없으면 BUILD를 열지 않고 `blocked`로 돌려 scope를 재설계한다.
- 12분 안에 green/red가 나오지 않는 full suite, soak, cohort, organic collection은 직접 기다리지 않는다.
- 긴 evaluation은 axis/seed별 cacheable shard로 실행하고 aggregation은 기존 shard만 읽는다.
- organic/24h/30d 증거는 `enroll`, `observe`, `close` activation을 각각 20분 이내로 수행한다.
  경과 시간은 task 작업시간이 아니며 EVIDENCE/MONITOR lane에서 다른 BUILD를 막지 않는다.
- 시간 제한 때문에 quality floor, pass^k, adversarial case, provenance, independent evaluation을
  낮추지 않는다.
- BUILD WIP는 1, non-mutating EVIDENCE/MONITOR WIP는 1이다.

20분 내에 acceptance를 모두 충족하지 못하면 부분 완료로 닫지 않는다. 현재 diff를 안전하게
보존 또는 되돌릴 수 있는 지점까지 정리하고 `partial | blocked`와 정확한 재개 조건을 기록한다.

## 상태와 activation

상태는 다음만 사용한다.

`missing | partial | built-unverified | verified-current | monitoring | blocked | deferred | rejected | superseded`

각 작업 전에는 다음 header를 먼저 채운다.

```text
Task ID:
상태:
현재 Stage / Gate:
lane:
유형(FIX|BUILD|TEST|OPS|EVAL|DOC):
크기(S|M|L):
현재 구현 symbol/file:
current evidence:
missing delta:
acceptance criteria:
검증 명령과 관찰:
commit 경계:
maker model / effort:
모델 선택 사유:
evaluator model / effort:
escalation trigger:
범위 밖:
blocker와 재개 조건:
```

권한, credential, persistence, process/concurrency, browser/computer effect, self-learning,
multi-agent authority, release/provenance는 크기와 무관하게 Sol/high에서 시작한다. 안전한 S/M
구현만 activation 후 Terra/high로 넘길 수 있다. 완료 판정은 fresh Sol evaluator context가
acceptance와 current diff/artifact만 읽어 수행한다.

## Authoritative execution order

숫자는 안정된 참조지만 무조건적인 숫자 순서는 아니다. 다음 wave와 current dependency-ready
상태가 우선한다.

아래 10개 영역에 각 10개 행을 둔 것은 1–100 탐색성을 위한 편집 구조일 뿐, 영역별 투자 quota나
동일 우선순위를 뜻하지 않는다. 현재 피해, release blocker, dependency와 evidence가 실제 선택량을
결정하며 optional 영역은 필요한 선행 gate가 없으면 `deferred`로 남는다.

| Wave | 기본 범위 | 통과 조건 |
| --- | --- | --- |
| A. Bounded truth | 001–010 | 긴 qualification을 shard·cache·aggregate하며 누락을 green으로 만들 수 없음 |
| B. Safe agency | 011–030 | 권한·privacy와 계획/재개 loop가 fail-close |
| C. Daily personal value | 031–060 | Continuity, memory, 생활 domain, communication의 exact-source loop |
| D. Controlled action and adaptation | 061–090 | browser/computer, event trigger, learning, provider/multi-agent 경계 |
| E. Release and value cycle | 091–100 | 기존 owner profile에서 첫 가치, 복구, provenance, 운영·successor 판정 |

INCIDENT가 없으면 001부터 시작한다. Wave 안에서는 `P0 safety blocker → dependency-ready
truth/reliability → daily value → optional expansion` 순으로 고른다. organic evidence가 부족하면
해당 promotion만 held하고 다음 dependency-ready safety/reliability slice를 진행한다.

## Core 100

### 1. Bounded qualification과 실행 제어

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 001 | current HEAD용 Core100 input manifest를 생성한다. | HEAD, tree, dirty, gate artifact digest, generated-at가 한 read-only JSON에 있고 source 변경 전후 store digest가 같다. | 001–003 |
| 002 | activation artifact에 active·command·validation 분 예산 필드를 고정한다. | 세 필드가 없거나 20/12/6 상한을 넘는 fixture가 PLAN gate에서 거부된다. | 007, 009, 011 |
| 003 | 20분을 넘는 activation을 거부하는 deterministic admission check를 추가한다. | exact boundary 20은 허용되고 21, unknown, unbounded는 BUILD WIP를 열지 못한다. | 007, 010 |
| 004 | capability evaluator에 required axis 하나만 고르는 selector 계약을 추가한다. | 선택한 axis만 실행되고 다른 axis count는 성공으로 집계되지 않는다. | 059 |
| 005 | 한 axis/seed shard를 12분 안에 취소·종료시키는 timeout 계약을 핀한다. | timeout fixture가 child 작업을 남기지 않고 explicit terminal state와 비영점 exit를 남긴다. | 059, 087 |
| 006 | 각 shard에 exact source와 input provenance receipt를 기록한다. | HEAD, tree, axis, seed, input hash, model/runtime identity 중 하나가 없으면 aggregate 대상이 아니다. | 003, 005, 059 |
| 007 | completed shard만 재사용하는 resumable manifest를 만든다. | 동일 provenance는 skip되고 HEAD/input 하나가 바뀌면 해당 shard만 stale 처리된다. | 059 |
| 008 | 실행 없이 cached shard를 읽는 aggregate 경로를 만든다. | aggregate 전후 shard bytes가 같고 중복 axis/seed는 한 번만 계산된다. | 059–060 |
| 009 | missing·stale·skipped shard가 strict aggregate를 green으로 만들지 못하게 한다. | required matrix 한 칸이라도 비면 `unverified`; pass^k와 quality floor는 그대로다. | 060 |
| 010 | 004–009의 bounded qualification protocol을 독립 평가한다. | evaluator가 한 axis replay와 corrupted/missing shard를 20분 내 재현해 `PASS` 또는 `FAIL`을 남긴다. | 012, 060 |

### 2. Permission, privacy, persistence

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 011 | current CLI actuator authority와 sensitive permission repair를 독립 closure한다. | fresh evaluator가 public CLI classification, dry-run/apply, mode drift, symlink/scope rejection을 재현해 `PASS` 또는 `FAIL`을 남기며 source 수정은 0이다. | 073–074 |
| 012 | public tool·CLI command·API route·MCP surface의 permission gap report를 생성한다. | 각 surface가 정확히 한 authority class 또는 explicit unmapped로 나오며 report 생성은 무변경이다. | 073 |
| 013 | 012의 highest-risk unmapped surface 정확히 하나를 fail-close로 분류한다. | 그 surface의 read/write/process/network/send class와 negative fixture가 고정되고 다른 surface는 건드리지 않는다. | 073 |
| 014 | 같은 effect의 CLI/API/Web/MCP authority parity fixture 하나를 추가한다. | adapter 이름과 무관하게 target·effect가 같으면 동일 permission/approval 결과를 낸다. | 073 |
| 015 | 승인 receipt에 exact target·payload digest·expiry를 묶는 한 contract를 닫는다. | target/payload/time 하나가 바뀐 replay는 기존 승인을 재사용하지 못한다. | 073, 200, 214 |
| 016 | owner-only repair가 아직 다루지 않는 sensitive directory 한 묶음을 inventory한다. | exact owned paths와 expected 0700이 나오고 symlink·scope 밖·unknown path는 repair 후보가 아니다. | 074 |
| 017 | 기존 permission repair receipt에 plan hash와 before/after mode를 추가한다. | dry-run은 mutation 0, apply는 각 성공 파일의 0600 전환과 plan hash를 기록한다. | 074 |
| 018 | directory permission repair 한 건을 descriptor-relative·non-recursive로 닫는다. | exact directory만 0700이 되고 child traversal, symlink follow, scope swap이 0이다. | 074 |
| 019 | encryption·backup·restore의 current missing-path report를 생성한다. | store별 encrypted/plaintext/unsupported, key state, backup version, restore support가 read-only로 분리된다. | 075–076 |
| 020 | 011–019 변경만 대상으로 독립 permission/privacy adversarial review를 수행한다. | unmapped authority, symlink escape, stale approval, plaintext restore 중 하나라도 재현되면 gate는 red다. | 084 |

### 3. 핵심 agent loop, planning, checkpoint

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 021 | project 실행 상태와 conversation/Continuity thread ID를 분리하는 read model을 고정한다. | project mutation이 linked thread/evidence/outcome을 암묵적으로 바꾸지 않는다. | 205 |
| 022 | goal decomposition 결과를 effect 없는 editable draft로만 생성한다. | confirm 전 task creation, store mutation, tool execution이 모두 0이다. | 206 |
| 023 | active plan에 acceptance·non-goal·kill condition을 필수화한다. | 비어 있거나 모순된 plan fixture는 실행 상태로 전환되지 않는다. | 207 |
| 024 | exact dependency에서 ready action 하나만 고르는 순수 selector를 추가한다. | unmet dependency, owner decision, missing authority가 있는 항목은 runnable이 아니다. | 208 |
| 025 | blocker와 no-progress를 terminal state로 만드는 한 전이 계약을 닫는다. | 같은 blocker가 새 evidence 없이 반복되면 retry 대신 blocker와 재개 조건을 남긴다. | 209 |
| 026 | checkpoint에 plan digest와 pending-effect set을 묶는다. | plan/pending-effect mismatch가 자동 resume를 거부한다. | 129, 210 |
| 027 | corrupt·stale checkpoint resume의 negative fixture 하나씩을 추가한다. | 두 fixture 모두 effect 0, explicit recovery path, original checkpoint 보존을 만족한다. | 129, 210 |
| 028 | 한 plan step에 attempt·time·tool·model·effect budget을 적용한다. | 하나의 budget exhaustion이 성공으로 넘어가지 않고 explicit terminal state가 된다. | 087–095, 212 |
| 029 | progress를 verified effect receipt에서만 계산한다. | assistant claim, tool error, unverifiable output은 completed 비율을 올리지 않는다. | 213 |
| 030 | plan→blocker→checkpoint→resume의 deterministic two-session fixture를 독립 평가한다. | duplicate effect 0, unsupported completion 0, stale resume 0이며 021–029만 재현한다. | 211, 216 |

### 4. Personal Continuity와 daily conversation

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 031 | normal chat의 현재 Continuity seam을 read-only gap map으로 만든다. | select/link/preview/open/outcome별 existing symbol과 missing surface가 구분된다. | 061 |
| 032 | 031에서 missing인 main-chat Continuity tool schema 하나만 노출한다. | schema만으로 허용 effect와 금지 auto-link/outcome을 구분하고 기존 store를 재사용한다. | 061 |
| 033 | life/work thread binding을 suggestion과 explicit confirm으로 분리한다. | confirm 전 thread, kind, link persistent mutation이 0이다. | 062 |
| 034 | exact local task 또는 note 한 domain의 link preview를 닫는다. | canonical ID만 허용하고 ambiguous/renamed/deleted/duplicate title은 mutation 전에 거부한다. | 063 |
| 035 | Pack preview와 explicit open authority를 한 store contract에서 분리한다. | 반복 preview는 byte-identical이고 open만 exactly-one delivery receipt를 만든다. | 064 |
| 036 | chat outcome 입력을 네 explicit 값과 optional owner note로 제한한다. | timeout, sentiment, task receipt, assistant guess는 outcome을 생성하지 않는다. | 065 |
| 037 | surface 하나를 공통 Attunement reducer에 연결하는 parity fixture를 추가한다. | 같은 operation sequence가 기존 surface와 같은 digest/projection을 낸다. | 066 |
| 038 | life/work eligible coverage를 계산하는 read-only projection을 갱신한다. | exact receipt, explicit outcome, distinct dates, exclusion reason이 분리되고 store bytes가 같다. | 067–069 |
| 039 | ignored/rejected/adjusted의 owner-authored reason projection을 추가한다. | exact delivery와 연결되며 model-inferred reason은 organic negative로 집계되지 않는다. | 070 |
| 040 | 031–039의 engineering contract를 독립 평가하고 organic 부족은 monitoring으로 분리한다. | deterministic 계약과 organic evidence를 별도 판정하며 부족한 날짜가 다른 BUILD를 막지 않는다. | 071–072 |

### 5. 장기 memory와 knowledge

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 041 | memory read projection에 observed-at·valid-from·invalidated-at 상태를 추가한다. | 과거 사실과 현재 active 사실이 같은 confidence 숫자로 합쳐지지 않는다. | 157 |
| 042 | exact source가 있는 contradiction cluster 하나를 read-only로 만든다. | conflicting fact IDs와 sources가 보이고 자동 winner mutation은 0이다. | 158 |
| 043 | stale fact 재확인을 mutation-free draft로 생성한다. | 답변 없음/취소는 current memory와 policy를 바꾸지 않는다. | 159 |
| 044 | explicit owner confirmation으로 fact version 하나를 갱신한다. | old version은 history로 남고 new version provenance와 receipt가 연결된다. | 160 |
| 045 | invalidation을 correction·forget과 구분하는 전이 하나를 닫는다. | invalidated fact는 active recall에서 빠지지만 history/export에서 조용히 삭제되지 않는다. | 161 |
| 046 | retention과 forget 범위를 owner-readable projection으로 노출한다. | exact IDs, affected stores, irreversible boundary, undo 가능 범위가 mutation 전에 보인다. | 162–163 |
| 047 | memory export의 fact→source→version provenance completeness check를 추가한다. | active/history/invalidation 중 누락된 link 하나라도 있으면 export는 incomplete로 표시된다. | 164 |
| 048 | memory와 notes/tasks 중 한 cross-store conflict를 mutation 없이 보여준다. | domain receipt는 memory correction이나 preference promotion으로 자동 승격되지 않는다. | 165 |
| 049 | correction→invalidation→forget→recovery의 한 deterministic shard를 실행한다. | stale resurrection 0, unrelated fact loss 0, exact source preservation을 증명한다. | 166–167 |
| 050 | 041–049만 대상으로 long-term memory evaluator 판정을 받는다. | temporal truth, deletion truth, export provenance 중 하나라도 불명확하면 PASS하지 않는다. | 168 |

### 6. Tasks, calendar, reminders, contacts, notes, communication

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 051 | vague user intent에서 task draft만 만드는 한 contract를 닫는다. | owner confirm 전 task write 0이고 missing next action/due 정보가 질문으로 남는다. | 169–171 |
| 052 | task status exact transition 하나를 idempotent receipt로 만든다. | duplicate replay는 상태를 한 번만 바꾸며 completion은 outcome/permission이 아니다. | 172 |
| 053 | calendar free/busy와 event detail permission을 분리하는 projection을 추가한다. | detail 권한이 없을 때 title/attendee/location이 모델 context로 새지 않는다. | 173–174 |
| 054 | exact calendar occurrence에서 Continuity Pack draft를 만든다. | recurring series 전체가 아니라 선택 occurrence ID만 연결되고 delivery는 0이다. | 175 |
| 055 | reminder cancel·retry·stale 전이 중 하나의 failure matrix를 핀한다. | cancellation 뒤 발화 0, retry duplicate 0, stale state 성공 오인 0이다. | 176–177 |
| 056 | contact context와 communication recipient를 서로 다른 authority로 고정한다. | contact recall만으로 send target이나 future permission이 생성되지 않는다. | 178, 193–196 |
| 057 | note capture→grounded recall 한 round trip을 exact source로 검증한다. | unsupported synthesis는 abstain하고 note citation이 원문 위치로 돌아간다. | 179–180 |
| 058 | exact recipient·account·channel preview를 한 send adapter에 고정한다. | alias collision, account drift, ambiguous recipient은 provider 호출 전에 거부된다. | 193–198 |
| 059 | communication content·attachment digest를 final approval에 묶는다. | text/attachment/order 하나가 바뀌면 기존 승인이 만료되고 send count는 0이다. | 199–201 |
| 060 | ambiguous provider acknowledgement를 effect ID로 reconcile한다. | success-before-ack와 restart replay에서 duplicate send 0, unknown은 manual path로 남는다. | 202–204 |

### 7. Browser와 computer action safety

이 영역의 `computer`는 현재 허용된 browser와 Muse-owned artifact/action surface를 뜻한다.
임의의 desktop-wide autonomy를 추가하지 않는다.

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 061 | browser/computer public action의 current authority gap report를 만든다. | inspect/fill/submit/upload/download/clipboard/screen/process별 class와 unmapped가 보인다. | 181–183 |
| 062 | inspect 결과에서 mutation-free action plan 하나를 만든다. | plan 생성 중 click/type/upload/download/system effect가 0이다. | 184 |
| 063 | stale DOM/accessibility target 재검증 계약을 추가한다. | node identity 또는 page generation이 바뀌면 action 직전 fail-close한다. | 185 |
| 064 | fill과 submit을 다른 authority와 receipt로 분리한다. | fill approval로 submit이 실행되지 않고 submit target/payload가 다시 보인다. | 186 |
| 065 | browser download 한 경로를 quarantine+content-bound receipt로 닫는다. | final destination 밖 write 0, executable auto-open 0, hash/type/size receipt가 남는다. | 187 |
| 066 | upload 한 경로에 exact local path·destination·field preview를 고정한다. | symlink/scope swap, changed file hash, hidden field change가 upload 전에 거부된다. | 188 |
| 067 | active account identity를 action receipt에 묶는다. | account/session drift가 감지되면 old approval로 action하지 않는다. | 189 |
| 068 | accessibility target과 screenshot inference 충돌 시 abstain하는 fixture를 추가한다. | 두 evidence가 불일치하면 click/type 0이고 inspect 요청으로 돌아간다. | 190 |
| 069 | browser/computer checkpoint resume에서 pending effect를 재검증한다. | crash 후 uncertain effect는 자동 replay하지 않고 reconcile 상태를 남긴다. | 191 |
| 070 | stale target·injection·upload swap·ambiguous effect 중 한 adversarial journey shard를 평가한다. | 선택 case의 unapproved effect 0과 exact terminal reason을 독립 evaluator가 재현한다. | 192 |

### 8. Event-driven proactivity, Observe, governed adaptation

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 071 | Observe/event source 하나의 explicit consent grant를 고정한다. | source, fields, cadence, retention, pause가 없으면 enrollment가 거부된다. | 109–111 |
| 072 | pause·resume·forget 중 한 Observe lifecycle transition을 닫는다. | pause 후 collection 0, resume는 새 consent generation, forget은 exact scope receipt를 남긴다. | 112 |
| 073 | task/calendar/reminder event 하나를 idempotent trigger envelope로 만든다. | source ID, generation, occurred-at, dedup key가 있고 replay는 trigger를 한 번만 만든다. | 113, 265–266 |
| 074 | trigger eligibility를 permission·quiet hours·relevance에서 read-only로 계산한다. | ineligible event는 delivery 없이 explicit suppression reason을 남긴다. | 114–115 |
| 075 | proactive timing decision 한 건을 shadow log로만 기록한다. | candidate, chosen/suppressed reason, counterfactual이 남지만 notification/send는 0이다. | 116 |
| 076 | cooldown과 repeated-trigger suppression 계약을 추가한다. | burst/restart/clock-skew fixture에서 duplicate interruption이 0이다. | 117, 267 |
| 077 | negative outcome 하나가 bounded display/timing rollback proposal만 만들게 한다. | source, permission, recipient, action scope는 확대되지 않고 자동 promotion은 0이다. | 118–120 |
| 078 | experience에서 learning candidate를 proposal로만 생성한다. | explicit outcome과 source run이 없으면 candidate가 없고 active behavior digest는 같다. | 217–218 |
| 079 | candidate 한 건을 quarantine held-out test까지 진행한다. | active registry/prompt는 변하지 않고 safety regression 하나면 activation 불가다. | 219–223 |
| 080 | event→shadow→outcome→proposal chain을 독립 governance audit한다. | silent collection/delivery/activation 0이며 receipt가 permission으로 승격되지 않는다. | 224–228 |

### 9. Provider-neutral runtime, resource, multi-agent, evaluation

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 081 | provider adapter 하나의 capability probe를 공통 contract로 투영한다. | tool/stream/structured-output/vision 지원이 adapter 이름이 아니라 probe result로 결정된다. | 085, 241–243 |
| 082 | auxiliary model callsite 하나에 personal/local-only egress gate를 배선한다. | local-only fixture에서 cloud auxiliary call 0, explicit unavailable/fallback reason이 남는다. | 073, 242 |
| 083 | fallback 전에 pending tool/effect가 없음을 강제하는 한 contract를 닫는다. | partial output나 uncertain effect 뒤 provider swap 0, safe pre-effect failure만 fallback 가능하다. | 244–245 |
| 084 | 동일 tool-loop fixture를 provider 두 개의 normalized trace로 비교한다. | provider wire 차이는 허용하되 user-visible outcome, tool args, permission result가 같다. | 246 |
| 085 | foreground와 background work의 resource admission 한 충돌 fixture를 추가한다. | foreground pressure에서 background claim 0, starvation은 explicit deferred로 남는다. | 085–096 |
| 086 | model/tool cancellation 뒤 budget과 pending effect를 settle한다. | token/time/tool counters가 terminal이고 child/process/pending approval leak이 0이다. | 087–095 |
| 087 | multi-agent 후보 한 task family의 single-agent baseline shard를 고정한다. | artifact, rubric, budget, seed가 같고 quality/cost/latency/effect count가 기록된다. | 229 |
| 088 | decomposition과 writable scope를 한 handoff schema에 고정한다. | shared-state/ordering 의존 task는 fan-out되지 않고 allowed paths/tools 밖 write가 거부된다. | 230–233 |
| 089 | subagent가 maker 권한을 확대하지 못하는 negative fixture를 추가한다. | delegated tool/effect permission은 parent intersection이며 handoff spoof/replay가 거부된다. | 234–238 |
| 090 | single vs multi 또는 provider A vs B의 paired shard를 독립 평가한다. | 같은 inputs/rubric/budget에서 quality gain 없이 더 복잡한 후보는 promotion되지 않는다. | 239–252 |

### 10. Onboarding, release, operations, value cycle

| ID | 20분 slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 091 | 기존 owner macOS profile에서 isolated `MUSE_HOME` onboarding preflight를 만든다. | 별도 OS 사용자나 재부팅 없이 stable entrypoint, writable local root, provider state를 진단한다. | 097–099 |
| 092 | onboarding에서 local/cloud data path와 egress를 실제 요청 전에 보여준다. | provider, base URL locality, sent field classes가 보이고 취소 시 network call 0이다. | 100–101 |
| 093 | provider credential diagnostic 한 경로를 secret-safe로 닫는다. | missing/invalid/unreachable을 구분하고 token 원문은 stdout, trace, artifact에 0이다. | 102 |
| 094 | doctor repair 한 경로를 preview→apply→verify receipt로 통일한다. | preview mutation 0, explicit apply만 effect, postcondition 실패는 green이 아니다. | 103–105 |
| 095 | first cited answer 또는 Continuity Pack 한 journey shard를 clean `MUSE_HOME`에서 실행한다. | setup→request→exact source→next safe action이 12분 안에 terminal state로 끝난다. | 106–108 |
| 096 | encrypted backup의 verify-only와 isolated restore 한 fixture를 실행한다. | source 불변, empty target digest 일치, wrong key/version은 fail-close한다. | 075–076, 145–156 |
| 097 | current tree와 package candidate 한 개의 secret·personal-remnant·provenance/signature-state scan을 실행한다. | HEAD/tree/build digest와 signing 상태가 맞고 finding 미분류 또는 scanner skip이면 release gate red다. | 077, 133–140 |
| 098 | install health와 rollback 한 경로를 fresh artifact에서 검증한다. | failed health probe가 previous known-good로 복귀하고 user data를 삭제하지 않는다. | 133–140, 145–156 |
| 099 | organic dogfood/value monitor를 enroll하거나 기존 snapshot을 20분 내 review한다. | synthetic/controlled/organic denominator가 분리되고 다음 observation 시각만 남긴 뒤 BUILD를 해제한다. | 068–072, 141–143, 289–299 |
| 100 | 모든 적용 gate의 fresh evidence로 release·successor·종료 결정을 기록한다. | `release-ready`, `continue-with-successor`, `terminate` 중 하나와 blockers, provenance, rollback이 있고 red/unknown을 green으로 추정하지 않는다. | 144, 300 |

## Task 100 이후

100은 무조건 출시하는 작업이 아니다. source/behavior, controlled-live, organic-production gate가 모두
해당 주장에 맞게 fresh할 때만 `release-ready`를 선택한다. 외부 publication, tag, release 생성은
별도 owner 권한과 release gate를 따른다.

필수 gate가 red이지만 Muse의 가치가 계속 확인되면 `continue-with-successor`로 다음 bounded
roadmap을 만든다. 가치 대비 위험·운영비·복잡도가 더 크고 회복 가능한 다음 실험도 없으면
근거와 함께 `terminate`를 선택한다.
