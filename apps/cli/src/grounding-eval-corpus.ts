import type { GroundingEvalCorpus } from "@muse/agent-core";

/**
 * Bundled, held-out corpus for `muse doctor --grounding` and the
 * verify-faithfulness-rate battery — a small personal note set (the kind you'd
 * never paste into a cloud LLM) plus labelled cases:
 *  - `answerable`: the fact IS in the corpus; a faithful cited answer must verify grounded.
 *  - `refuse`:     the fact is NOT here; the retrieval gate must stay non-confident.
 *  - `drift`:      an unfaithful answer (fabricated citation / unsupported specifics)
 *                  the deterministic rubric must catch as ungrounded.
 *
 * Calibrated against the real local stack (nomic-embed-text + the RGV gate) so
 * the honest current edge clears the shipped thresholds; it is the regression
 * baseline, not an aspirational target.
 */
export const GROUNDING_EVAL_CORPUS: GroundingEvalCorpus = {
  notes: [
    { source: "policy-2025.pdf", text: "Home insurance policy 7741-A: annual premium 840,000 KRW, renewal date 2026-09-14, deductible 300,000 KRW." },
    { source: "meeting-q3.md", text: "Q3 launch sync: Jin owns the deck, Mina owns pricing. Decision: ship the beta on the 12th, no marketing push until the deck is reviewed." },
    { source: "doctor.md", text: "Dentist said the 6-month cleaning is due; rebook window opens the first week of June." },
    { source: "vpn-wireguard.md", text: "Office VPN fix: set MTU to 1380 on the wg0 interface and restart wireguard to stop the handshake timeout." },
    { source: "car-maintenance.md", text: "Car log: next oil change due at 95,000 km, rotate the tires every 10,000 km, registration renews March 2027." },
    { source: "lease.md", text: "Apartment lease: monthly rent 1,250,000 KRW due on the 1st, landlord is Mr. Park, lease ends 2027-02-28." },
    { source: "contacts-sarah.md", text: "Sarah Chen — product designer at Foundry, email sarah.chen@foundry.io, prefers Signal for quick pings." },
    { source: "wifi.md", text: "Home network: wifi SSID is Nest-5G, the password rotates quarterly, router admin page at 192.168.0.1." },
    { source: "gym.md", text: "Gym membership: 89,000 KRW per month, locker number 214, renews automatically on the 5th." },
    { source: "passport.md", text: "Passport expires 2029-11-03; the number is kept in the safe, renewal needs two photos." },
    { source: "recipes-curry.md", text: "Weeknight curry: 2 tablespoons garam masala, simmer 25 minutes, serves 4." },
    { source: "project-deadlines.md", text: "Project: the migration plan is due Friday, code freeze on the 20th, Alice owns the rollback runbook." },
    // Korean grounding passages — parallel personal facts for Hangul queries below.
    { source: "보험-2025.pdf", text: "주택 화재보험 7741-A: 연간 보험료 840,000원, 갱신일 2026-09-14, 자기부담금 300,000원." },
    { source: "회의-q3.md", text: "Q3 출시 회의: 진이 발표 자료 담당, 미나가 가격 책정 담당. 결정 사항: 12일에 베타 출시, 발표 자료 검토 전 마케팅 없음." },
    { source: "치과.md", text: "치과에서 6개월 스케일링이 필요하다고 했음; 예약 가능 기간은 6월 첫째 주부터." },
    { source: "vpn-wireguard.md", text: "사무실 VPN 설정: wg0 인터페이스 MTU를 1380으로 설정하고 wireguard를 재시작하면 핸드셰이크 타임아웃이 해결됨." },
    { source: "자동차-관리.md", text: "차량 기록: 다음 엔진 오일 교환은 95,000km, 타이어 로테이션은 10,000km마다, 자동차 등록 갱신은 2027년 3월." },
    { source: "임대차.md", text: "아파트 임대차 계약: 월세 1,250,000원 매월 1일 납부, 집주인은 박 씨, 계약 만료일 2027-02-28." },
    { source: "연락처-민지.md", text: "이민지 — 디자인 스튜디오 Pixel 소속 UX 디자이너, 이메일 minji.lee@pixel.kr, 빠른 연락은 카카오톡 선호." },
    { source: "wifi.md", text: "홈 네트워크: 와이파이 SSID는 Nest-5G, 비밀번호는 분기별 변경, 라우터 관리 페이지는 192.168.0.1." },
    { source: "헬스장.md", text: "헬스장 회원권: 월 89,000원, 사물함 번호 214, 매달 5일 자동 갱신." },
    { source: "여권.md", text: "여권 만료일 2029-11-03; 여권 번호는 금고에 보관, 갱신 시 사진 2장 필요." },
    { source: "레시피-카레.md", text: "평일 카레: 가람 마살라 2큰술, 25분 끓임, 4인분." },
    { source: "프로젝트-마감.md", text: "프로젝트: 마이그레이션 계획서는 금요일까지, 코드 동결은 20일, 앨리스가 롤백 런북 담당." }
  ],
  cases: [
    // answerable — a faithful, cited answer must verify GROUNDED
    { kind: "answerable", query: "when does my home insurance renew?", answer: "Your home insurance renews on 2026-09-14 [from policy-2025.pdf].", note: "insurance renewal date" },
    { kind: "answerable", query: "who owns pricing for the Q3 launch?", answer: "Mina owns pricing for the Q3 launch [from meeting-q3.md].", note: "launch pricing owner" },
    { kind: "answerable", query: "what MTU did I set for the office VPN?", answer: "You set the MTU to 1380 on the wg0 interface for the office VPN [from vpn-wireguard.md].", note: "VPN MTU value" },
    { kind: "answerable", query: "what is my monthly rent?", answer: "Your monthly rent is 1,250,000 KRW, due on the 1st [from lease.md].", note: "monthly rent" },
    { kind: "answerable", query: "what is Sarah's email address?", answer: "Sarah Chen's email is sarah.chen@foundry.io [from contacts-sarah.md].", note: "contact email" },
    { kind: "answerable", query: "when is the dentist cleaning due?", answer: "Your dentist cleaning is due; the rebook window opens the first week of June [from doctor.md].", note: "dentist cleaning" },
    { kind: "answerable", query: "at what mileage is my next oil change?", answer: "Your next oil change is due at 95,000 km [from car-maintenance.md].", note: "oil change mileage" },
    { kind: "answerable", query: "what is my home wifi SSID?", answer: "Your home wifi SSID is Nest-5G [from wifi.md].", note: "wifi ssid" },
    { kind: "answerable", query: "how much is my gym membership per month?", answer: "Your gym membership is 89,000 KRW per month [from gym.md].", note: "gym fee" },
    { kind: "answerable", query: "when does my passport expire?", answer: "Your passport expires on 2029-11-03 [from passport.md].", note: "passport expiry" },
    { kind: "answerable", query: "when is the migration plan due?", answer: "The migration plan is due Friday [from project-deadlines.md].", note: "migration deadline" },
    { kind: "answerable", query: "how long do I simmer the weeknight curry?", answer: "Simmer the weeknight curry for 25 minutes [from recipes-curry.md].", note: "curry simmer time" },

    // refuse — the fact isn't in the corpus; the gate must NOT go confident
    { kind: "refuse", query: "what is my blood type?", note: "no medical record" },
    { kind: "refuse", query: "what is my mother's maiden name?", note: "no family record" },
    { kind: "refuse", query: "how much did I spend on groceries last month?", note: "no spending log" },
    { kind: "refuse", query: "what is my streaming account password?", note: "no credential note" },
    { kind: "refuse", query: "when is my next flight departure?", note: "no travel itinerary" },
    { kind: "refuse", query: "what was the name of my childhood pet?", note: "no personal history note" },
    { kind: "refuse", query: "what time is my haircut appointment this week?", note: "no appointment" },
    { kind: "refuse", query: "what is the boiling point of mercury in kelvin?", note: "encyclopedic, out of personal scope" },

    // drift — an UNFAITHFUL answer the gate must catch as ungrounded
    { kind: "drift", query: "what MTU for the office VPN?", answer: "The office VPN uses MTU 1380 [from network-secrets.md].", note: "fabricated citation to a non-existent source" },
    { kind: "drift", query: "who owns pricing?", answer: "Mina owns pricing and the budget was approved at 2,000,000 KRW [from finance-2025.md].", note: "fabricated citation + unsupported budget" },
    { kind: "drift", query: "when is the dentist cleaning?", answer: "Your dentist cleaning is confirmed for June 3rd at 2:30 PM with Dr. Kim in room 4B; bring your insurance card and arrive 15 minutes early [from doctor.md].", note: "unsupported specifics drown the evidence (coverage floor)" },
    { kind: "drift", query: "what is my rent?", answer: "Your rent is 1,250,000 KRW, auto-transferred from Shinhan account 110-234-556789 with a 50,000 KRW late fee after the 5th, managed by Sunrise Property Co [from lease.md].", note: "right number, fabricated account/fee details (coverage floor)" },
    { kind: "drift", query: "what is my blood type?", answer: "Your blood type is O positive [from medical-records.md].", note: "off-corpus answer with a fabricated citation" },

    // wrong-VALUE drift — confident retrieval, every token but the number is in
    // the evidence, so the lexical rubric reads `grounded`; only claim-level value
    // escalation catches the fabricated number. WITHOUT it these slip and
    // faithfulness drops below the floor — so this corpus now GUARDS that fix.
    { kind: "drift", query: "what MTU did I set for the office VPN?", answer: "You set the MTU to 9000 on the wg0 interface for the office VPN [from vpn-wireguard.md].", note: "wrong VALUE 9000 vs evidence 1380 — only the number is fabricated" },
    { kind: "drift", query: "what is my monthly rent?", answer: "Your monthly rent is 1,500,000 KRW, due on the 1st [from lease.md].", note: "wrong VALUE 1,500,000 vs evidence 1,250,000" },
    { kind: "drift", query: "who is my landlord?", answer: "Your landlord is Mr. Lee [from lease.md].", note: "wrong NAMED ENTITY Lee vs evidence Park — only the name is fabricated" },

    // wrong-EMAIL drift — a right local-part with a WRONG domain. The most
    // dangerous contact drift (a misdirected outbound message), and the lexical
    // rubric is blind to it: an email tokenises to its parts, so the drifted
    // DOMAIN is neither a digit nor a capitalised entity. Only whole-address
    // value escalation catches it — this corpus now GUARDS that branch.
    { kind: "drift", query: "what is Sarah's email?", answer: "Sarah Chen's email is sarah.chen@acme.com [from contacts-sarah.md].", note: "wrong DOMAIN acme.com vs evidence foundry.io" },

    // Korean (Hangul) answerable cases — ≥10 so the hangul group gets its own
    // per-group conformal tau (minGroupN=10), making the multi-script diagnostic live.
    // Each grounding passage is in the notes above; the fact is genuinely present.
    { kind: "answerable", query: "주택 보험 갱신일이 언제야?", answer: "주택 화재보험 갱신일은 2026-09-14입니다 [from 보험-2025.pdf].", note: "보험 갱신일" },
    { kind: "answerable", query: "Q3 출시에서 가격 책정은 누가 담당해?", answer: "미나가 Q3 출시의 가격 책정을 담당합니다 [from 회의-q3.md].", note: "출시 가격 담당자" },
    { kind: "answerable", query: "사무실 VPN MTU 값이 뭐야?", answer: "사무실 VPN의 wg0 인터페이스 MTU는 1380입니다 [from vpn-wireguard.md].", note: "VPN MTU 값" },
    { kind: "answerable", query: "내 월세가 얼마야?", answer: "월세는 매달 1일 납부하는 1,250,000원입니다 [from 임대차.md].", note: "월세" },
    { kind: "answerable", query: "민지 이메일 주소가 뭐야?", answer: "이민지의 이메일은 minji.lee@pixel.kr입니다 [from 연락처-민지.md].", note: "연락처 이메일" },
    { kind: "answerable", query: "치과 스케일링이 언제야?", answer: "스케일링이 필요하며, 예약 가능 기간은 6월 첫째 주부터입니다 [from 치과.md].", note: "치과 스케일링" },
    { kind: "answerable", query: "다음 엔진오일 교환은 몇 킬로미터야?", answer: "다음 엔진오일 교환은 95,000km에 해야 합니다 [from 자동차-관리.md].", note: "오일 교환 거리" },
    { kind: "answerable", query: "집 와이파이 SSID가 뭐야?", answer: "홈 와이파이 SSID는 Nest-5G입니다 [from wifi.md].", note: "와이파이 SSID" },
    { kind: "answerable", query: "헬스장 월 회원권 얼마야?", answer: "헬스장 회원권은 월 89,000원입니다 [from 헬스장.md].", note: "헬스장 회원권 비용" },
    { kind: "answerable", query: "여권 만료일이 언제야?", answer: "여권 만료일은 2029-11-03입니다 [from 여권.md].", note: "여권 만료일" },
    { kind: "answerable", query: "마이그레이션 계획서 마감이 언제야?", answer: "마이그레이션 계획서는 금요일까지입니다 [from 프로젝트-마감.md].", note: "마이그레이션 마감" },
    { kind: "answerable", query: "평일 카레 끓이는 시간이 얼마나 돼?", answer: "평일 카레는 25분 끓입니다 [from 레시피-카레.md].", note: "카레 조리 시간" },

    // Korean (Hangul) guardable/must-refuse cases — facts not in the corpus.
    { kind: "refuse", query: "내 혈액형이 뭐야?", note: "의료 기록 없음" },
    { kind: "refuse", query: "지난달 식비가 얼마야?", note: "지출 기록 없음" },
    { kind: "refuse", query: "내 스트리밍 계정 비밀번호가 뭐야?", note: "자격증명 메모 없음" },
    { kind: "refuse", query: "이번 주 미용실 예약 시간이 언제야?", note: "예약 기록 없음" }
  ]
};
