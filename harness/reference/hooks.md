---
title: 훅 (Hooks — PreToolUse / PostToolUse)
audience: [개발자, AI 에이전트]
purpose: 도구 호출 전/후에 끼어 우회 불가로 막거나 관측하는 정통 하네스 레이어
updated: 2026-06-13
---

# 훅 (Hooks)

정통 하네스의 다섯 레이어(메모리·도구·권한·**훅**·관측) 중 하나. 2026 합의(Boris Cherny/Claude Code)는
**"메모리 + 훅부터 시작하라"** — 가장 흔한 실패를 이 둘이 막기 때문입니다. 핵심: **PreToolUse 훅은
도구 호출을 *무조건* 막을 수 있는 유일한 메커니즘이고, 우회할 수 없습니다.**

## 무엇인가

- **PreToolUse** — 도구가 실행되기 *전에* 돈다. 하나라도 거부(또는 예외)하면 호출이 **차단**되고
  실제 실행은 일어나지 않는다(fail-closed).
- **PostToolUse** — 도구 실행 *후에* 돈다. 관측용(로그·트레이스)이며, 던져도 결과를 막거나 망치지 않는다.

## 왜 게이트와 별개인가

권한 게이트([permission-matrix](../core/permission-matrix.md))는 "이 등급을 허용하나"를 판정하는 규칙이고,
훅은 그 규칙들을 **모든 도구 호출 길목에 끼우는 실행 장치**다. 그래서 우리 코드에선 **권한 게이트가
곧 기본 PreToolUse 훅**(`permissionHook`)으로 들어가 있다 — 권한 enforcement = 훅의 한 사례.

## 어떻게 쓰나 (코드)

[runner/hooks.mjs](../runner/hooks.mjs) (의존성 0):

- `createHookPipeline()` → `onPreToolUse(fn)` · `onPostToolUse(fn)`
- `dispatchTool(pipeline, call, execute)` — **도구를 도는 유일한 정식 경로**. pre-훅이 막으면
  `execute()`에 도달하지 않으므로 enforcement를 건너뛸 수 없다.
- `permissionHook` — 권한 게이트를 PreToolUse 훅으로 쓰는 기본 제공품.

```
const p = createHookPipeline();
p.onPreToolUse(permissionHook);            // 은행=거부, 외부전송=확정+확인 필요
p.onPostToolUse((call, res) => trace(call, res));
const r = await dispatchTool(p, { kind: 'outbound', recipientResolved: true, confirmed: true }, send);
// pre-훅 통과 → send 실행 → post-훅 관측. 막히면 r.blocked=true, send 미실행.
```

## 검증

[runner/hooks.test.mjs](../runner/hooks.test.mjs) — `node --test "harness/runner/*.test.mjs"`:
PreToolUse 거부가 실행을 막음·통과 시 실행+PostToolUse 관측·훅 예외는 fail-closed 차단·다중 훅
첫 거부 우선·권한 훅(은행/외부전송 차단·read 허용)·PostToolUse 예외는 결과 불변. **6/6.**

## 한계 / 다음

이건 호스트가 자기 도구 디스패치를 `dispatchTool`로 감싸야 효력이 난다(우리가 강제하는 건 "감싸면
못 빠져나간다"는 것). 에이전트 CLI를 직접 쓰는 경우의 자동 후킹은 호스트 런타임 몫. (관측·세션 영속·메모리·도구도
이후 전부 코드로 채워짐 — [architecture §4](architecture.md).)
