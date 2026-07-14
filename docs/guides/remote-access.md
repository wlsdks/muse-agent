---
title: 휴대폰에서 Muse 쓰기 (Remote access via Tailscale)
audience: [사용자]
purpose: muse remote enable 한 번으로 내 Tailscale 기기(휴대폰 등)에서 Muse 웹 UI 열기 — 공개 인터넷 노출 없이
updated: 2026-07-15
related: [README.md, setup-local-llm.md]
---

# 휴대폰에서 Muse 쓰기 (Remote access)

Muse의 API 서버는 웹 UI도 함께 제공합니다 — 로컬 포트 하나(기본 3030)만 프록시하면
집/사무실 컴퓨터에서 돌아가는 Muse를 휴대폰에서 그대로 열 수 있습니다. Muse는 이 프록시를
[Tailscale](https://tailscale.com)의 **Serve** 기능으로만 제공합니다: **내 Tailscale
계정(tailnet)에 속한 내 기기끼리만** 연결되고, 공개 인터넷에는 절대 노출되지 않습니다.
(공개 노출 기능인 Tailscale **Funnel**은 의도적으로 지원하지 않습니다 — `--funnel`을
붙이면 `muse remote`가 거부합니다.)

## 5분 설정

**1. 컴퓨터와 휴대폰 양쪽에 Tailscale을 설치하고 같은 계정으로 로그인**

- macOS: <https://tailscale.com/download/mac> (또는 `brew install tailscale`)
- Linux: <https://tailscale.com/download/linux>
- Windows: <https://tailscale.com/download/windows>
- 휴대폰(iOS/Android): 각 앱스토어에서 "Tailscale" 검색 → 같은 계정으로 로그인

컴퓨터에서 로그인이 안 되어 있다면:

```bash
tailscale up
```

**2. Muse의 API 서버가 켜져 있는지 확인**

평소 Muse를 쓰던 방식대로 API 서버를 실행해 두세요 (데스크톱 앱, 또는
`pnpm --filter @muse/api dev`).

**3. 원격 접속 켜기**

```bash
muse remote enable
```

tailscale 미설치 / 로그인 안 됨 / API 서버 미기동 중 하나라도 있으면 `muse remote enable`이
그 지점에서 안내 메시지를 출력하고 **아무것도 실행하지 않고** 멈춥니다 (fail-close). 세 가지가
전부 준비되면 이렇게 출력됩니다:

```
✓ Muse is now available on your tailnet: https://<내-기기-이름>.<tailnet>.ts.net
이 주소를 휴대폰(같은 Tailscale 계정)에서 열면 Muse에 접속됩니다 / open this on your phone (any device on your tailnet).
```

**4. 휴대폰에서 그 주소를 열기**

Tailscale 앱이 켜져 있는 휴대폰의 브라우저에 그대로 붙여넣으면 Muse 웹 UI가 뜹니다.
언제든 상태를 다시 확인하려면:

```bash
muse remote status
```

## "tailnet-only"가 의미하는 것

- 이 URL은 **내 Tailscale 계정에 연결된 기기에서만** 열립니다 — 인터넷 전체에 공개되는
  것이 아닙니다. Tailscale 자체가 WireGuard 기반 사설망이기 때문입니다.
- 다만 Muse의 자체 로그인(인증)은 **기본 OFF**입니다 — 즉 지금 tailnet에 있는 모든
  기기(보통은 내 기기뿐)가 로그인 없이 Muse를 쓸 수 있다는 뜻입니다. `muse remote enable`이
  이 상태일 때 경고를 함께 출력합니다. 여러 사람과 tailnet을 공유한다면
  `MUSE_AUTH_JWT_SECRET`(또는 `MUSE_AUTH_SECRETS_FILE`)을 설정해 토큰 로그인을 켜세요.
- **Tailscale Funnel**(공개 인터넷 노출)은 지원하지 않습니다 — Muse가 개인용 도구이기
  때문에 범위 밖으로 정했습니다.

## 끄기

```bash
muse remote disable
```

이미 꺼져 있으면 아무 것도 하지 않고 조용히 끝납니다(idempotent).
