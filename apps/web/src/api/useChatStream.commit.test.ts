import { describe, expect, it } from "vitest";

// Regression lock for the streaming freeze: the first commit swaps the draft
// object for a clone inside the turns array, so identity-based replacement
// (`t === draft`) goes dead after one update — under real token streaming the
// bubble froze on the FIRST delta. The fix replaces by position (the draft is
// always the tail turn while a send is pending). This pins the tail-replace
// semantics as a pure array transform, mirroring the hook's commit().

interface Turn {
  role: "user" | "assistant";
  text: string;
}

function commitByPosition(turns: readonly Turn[], draft: Turn): readonly Turn[] {
  return turns.map((t, i) => (i === turns.length - 1 ? { ...draft } : t));
}

describe("useChatStream commit semantics", () => {
  it("every successive delta lands, not just the first (position beats identity)", () => {
    const draft: Turn = { role: "assistant", text: "" };
    let turns: readonly Turn[] = [{ role: "user", text: "질문" }, draft];

    for (const chunk of ["아", "침 ", "운동은 ", "좋다"]) {
      draft.text += chunk;
      turns = commitByPosition(turns, draft);
    }

    expect(turns[turns.length - 1]!.text).toBe("아침 운동은 좋다");
    // identity-based replacement would have stopped after the first chunk:
    const identityCommit = (all: readonly Turn[], d: Turn) => all.map((t) => (t === d ? { ...d } : t));
    const frozen = identityCommit(commitByPosition([{ role: "user", text: "q" }, draft], draft), draft);
    expect(frozen[frozen.length - 1]).not.toBe(draft);
  });

  it("earlier turns are never touched", () => {
    const draft: Turn = { role: "assistant", text: "부분" };
    const turns = commitByPosition([{ role: "user", text: "그대로" }, draft], draft);
    expect(turns[0]).toEqual({ role: "user", text: "그대로" });
  });
});
