# docs/goals — 작업 선정의 복리 장부 (the work ledgers)

> 이름은 역사적 잔재("goal 번호" 시대). 실체는 **"다음에 뭘 만들지 / 뭘 만들었지 /
> 뭘 왜 버렸지"가 세션을 넘어 살아남는 곳**이다. 어떤 파일도 통째로 읽지 말 것 —
> 전부 retrieval 인덱스다(grep으로 필요한 섹션만).

## 활성 장부 — 스킬이 쓰고 소비한다

| 파일 | 쓰는 쪽 | 읽는(소비하는) 쪽 | 내용 |
|---|---|---|---|
| `backlog.md` | improve-muse(◦ 추가/제거), scout(`→improve-muse` 태그), grow(부채 태그) | **improve-muse** rung 4 | **열린 것만**: ★ open · ◦ ready · ⏳ · Rejected/Blocked (2026-07-17 수명 분리) |
| `backlog-archive.md` | improve-muse/grow의 완료 ✓ 라인 (완료 시 backlog에서 이쪽으로 이동) | freshness guard·dedup의 grep 대상 | 완료·superseded·exhausted 역사 (append-only) |
| `growth-backlog.md` | scout(`[scout 날짜]` 행) | **grow-muse** rung 4 (build 행만; ✓ 플립도 grow) | 역량 기회 저수지 (231 base + scout 델타) |
| `judgment-lens.md` | (2026-06-23 생성 후 동결) | scout의 판정 기준서 (fit/verdict/edge 판례, ⛔51 skip 포함) | Muse-정체성 렌즈 |
| `rival-watch.md` | **scout 전용** | 다음 scout (워터마크가 델타의 펜스) | 로스터·선반(~/ai 클론, 라이선스, 🚨khoj AGPL)·fire 로그 |

흐름 한 줄: **scout이 두 백로그를 채우고 → grow/improve가 소비하고 ✓ 플립하고 →
rival-watch가 다음 정찰의 시작점을 기억한다.**

> 2026-07-17 개명: `capability-parity-backlog.md` → `growth-backlog.md`,
> `capability-parity-judgment.md` → `judgment-lens.md` (아카이브·과거 커밋의
> 옛 이름은 이 파일들을 가리킨다).

## 스킬 산출물 전체 인벤토리 (이게 전부다)

- **레포 안 (md 3+1):** `backlog.md`·`growth-backlog.md`·`rival-watch.md`에 쓰고,
  `judgment-lens.md`는 읽기 전용 렌즈(2026-06-23 동결). 스킬이 다른 md를 만들지 않는다.
- **레포 안 (md 아님):** 코드/테스트 커밋 자체(improve·grow의 슬라이스 — 검증 증거는 커밋
  본문에), 그리고 스킬 문서 자신들(`.claude/skills/*`).
- **레포 밖:** `~/ai/<name>` 라이벌 클론(scout; fetch로 유지), `docs/self-eval-scoreboard.json`
  (gitignored 로컬 — ORIENT의 `pnpm self-eval`이 간접 기록), 세션 메모리 노트(스킬 계약이
  아니라 에이전트의 자체 기록).

## 아카이브 / 설계 문서 — 스킬이 쓰지 않는다

- `competitor-teardown.md` — 2026-06-23 경쟁사 전수분해 (재스카웃 금지, 읽기 전용 근거 문서)
- `loops/` + `loop-digest.md` — 과거 자율 루프들의 fire 저널 (역사)
- `attunement-implementation-plan.md`, `attunement-slice-b-safety-contract.md`,
  `LEARNING-LOOP-PLAN.md`, `general-tools-design.md` — 사람-지시 설계/계획 문서

## 동시성 (2026-07-17, 공개연구 기반)

세 장부(backlog·growth-backlog·rival-watch)는 `.gitattributes`의 **`merge=union`**으로
병렬 append 충돌을 자동 해소한다 (여러 루프/워크트리가 동시에 쓰는 게 일상이라 —
git 공식 드라이버, rebase에도 적용, RED→GREEN 재현 검증됨). 알려진 트레이드오프:
같은 줄을 동시에 고치면 충돌 대신 **중복 줄**이 생길 수 있다 → 큐레이션 규칙이 잡는다.
동시 작성자가 훨씬 늘면 다음 단계는 GitLab-식 **엔트리-파일 분리**(항목=파일,
상태=디렉토리 이동; git-bug/ripissue 계열 prior art) — 지금은 과잉이라 미채택.

## 기록 템플릿 (2026-07-17 진안 지시 — 분석 가능한 데이터로)

backlog.md·backlog-archive.md의 모든 최상위 `- ` 줄은 이 문법을 따른다
(`scripts/check-ledger-format.mjs`가 self-eval 게이트로 강제):

```
- [status] YYYY-MM-DD key=value ... :: 자유 서술 (제목/내용)
  이어지는 상세는 2칸 들여쓰기 (여러 줄 허용, 자유 산문)
```

- **status** (단어만): `open` 해야할 것 · `done` 완료 · `blocked` 막힘 ·
  `decision` 사람 결정 대기 · `rejected` 기각(재유도 금지) · `superseded` 대체됨
- **필드** (있는 것만, 공백 구분): `commit=<sha>` `kind=<fix|feat|test|docs|guard|scout>`
  `src=<probe|scout|owner|loop|audit>` `prio=<1-5>` `gate="before->after"`
  `for=<improve-muse|grow-muse>`
- **이모지·장식기호 금지** (수학 기호는 허용). 화살표는 `->`.
- 분석 예: `grep '^- \[done\]' | ...` 로 날짜·커밋·게이트델타가 바로 뽑힌다.

## 큐레이션 규칙 (모든 장부 공통)

완료는 델타 붙은 한 줄로 압축하고, 항목을 더할 때마다 낡은 줄 하나 이상 지운다
(순증가 ≈ 0). 장부가 무한히 자라면 다음 pick의 판단을 흐리는 노이즈가 된다.
