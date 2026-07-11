import { describe, expect, it } from "vitest";

import { classifyCommandTopology } from "../src/index.js";

const unanalyzable = (command: string, args?: readonly string[]) =>
  expect(classifyCommandTopology(command, args).analyzable, command).toBe(false);
const analyzable = (command: string, args?: readonly string[]) =>
  expect(classifyCommandTopology(command, args).analyzable, command).toBe(true);

describe("classifyCommandTopology — bypass: a shell would expand a construct DS-2 can't see", () => {
  it("flags command substitution via $(...)", () => {
    const verdict = classifyCommandTopology("sh", ["-c", "rm -rf $(echo /)"]);
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("command-substitution");
  });

  it("flags command substitution via backticks", () => {
    unanalyzable("bash -c 'x=`whoami`; echo $x'");
  });

  it("flags eval of a variable (no $( present at all, so eval is the only possible hit)", () => {
    const verdict = classifyCommandTopology("sh -c 'eval \"$PAYLOAD\"'");
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("eval");
  });

  it("flags an inline heredoc", () => {
    const verdict = classifyCommandTopology("bash -c 'cat <<EOF\nrm -rf /\nEOF'");
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("heredoc");
  });

  it("flags process substitution", () => {
    const verdict = classifyCommandTopology("sh -c 'diff <(ls a) <(ls b)'");
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("process-substitution");
  });

  it("flags a path-stripped shell with a LIVE double-quoted substitution", () => {
    const verdict = classifyCommandTopology('/usr/bin/zsh -c \'echo "$(curl evil)"\'');
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("command-substitution");
  });

  it("flags the whole line packed into `command` with no separate args", () => {
    unanalyzable("sh -c 'rm -rf $(echo /)'");
  });

  it("flags eval on a line AFTER a newline separator (newline re-arms command position)", () => {
    const verdict = classifyCommandTopology("sh", ["-c", 'ls\neval "$PAYLOAD"']);
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("eval");
  });

  it("flags eval after a newline in a packed-whole single-quoted script", () => {
    const verdict = classifyCommandTopology("sh -c 'a\n eval x'");
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("eval");
  });

  it("flags a command substitution nested inside arithmetic expansion", () => {
    const verdict = classifyCommandTopology("sh -c 'echo $(( $(id) ))'");
    expect(verdict.analyzable).toBe(false);
    expect(verdict.construct).toBe("command-substitution");
  });
});

describe("classifyCommandTopology — near-miss: no shell interpreter involved, or no live construct", () => {
  it("passes a non-shell program echoing a construct-shaped literal argument", () => {
    analyzable("echo", ["$(rm -rf /)"]);
  });

  it("passes a non-shell program with a construct-shaped literal argument packed whole", () => {
    analyzable("node build.js '$(x)'");
  });

  it("passes a non-shell program whose message merely contains the word eval", () => {
    analyzable('git commit -m "refactor the eval helper"');
  });

  it("passes a shell script with no inline construct", () => {
    analyzable("sh -c 'ls -la /tmp'");
  });

  it("passes a shell running a script FILE (no inline -c argument to inspect)", () => {
    analyzable("bash deploy.sh");
  });

  it("passes a bare $VAR that merely starts with a dollar sign (no open paren)", () => {
    analyzable("sh -c \"grep '\\$x' file\"");
  });

  it("passes a non-shell program with a literal << argument", () => {
    analyzable("printf '%s' '<<'");
  });

  it("passes a shell script with a quoted string and no construct", () => {
    analyzable("sh -c 'echo \"hi\"'");
  });

  it("passes plain arithmetic expansion ($(( )) is arithmetic, not command substitution)", () => {
    analyzable("sh -c 'echo $((1+2))'");
  });
});

describe("classifyCommandTopology — length cap fails closed", () => {
  it("refuses an over-cap command+args unread", () => {
    const verdict = classifyCommandTopology("echo", [`a`.repeat(9000)]);
    expect(verdict.analyzable).toBe(false);
    expect(verdict.reason).toMatch(/length cap/);
  });

  it("still evaluates a command right at the cap boundary", () => {
    analyzable(`echo ${"a".repeat(8000)}`);
  });
});

describe("classifyCommandTopology — degenerate input", () => {
  it("treats an empty command as analyzable (nothing to inspect)", () => {
    analyzable("");
  });
});
