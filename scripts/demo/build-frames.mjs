import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

const dir = new URL("./", import.meta.url).pathname;
const rows = readFileSync(`${dir}/transcript.txt`, "utf8").trim().split("\n").map((l) => {
  const i = l.indexOf("|");
  return { kind: l.slice(0, i), text: l.slice(i + 1) };
});

const FPS = 8;
const CPF = 4;      // characters typed per frame
const HOLD_AFTER_CMD = 3;
const HOLD_PER_OUT = 1;
const GAP_HOLD = 10;
const END_HOLD = 26;

// build the list of screen states, one per frame
const frames = [];
const screen = [];
const push = (n = 1) => { for (let i = 0; i < n; i++) frames.push([...screen]); };

push(4);
for (const r of rows) {
  if (r.kind === "CMD") {
    screen.push({ kind: "cmd", text: "" });
    for (let n = CPF; n < r.text.length + CPF; n += CPF) {
      screen[screen.length - 1] = { kind: "cmd", text: r.text.slice(0, Math.min(n, r.text.length)) };
      push();
    }
    push(HOLD_AFTER_CMD);
  } else if (r.kind === "GAP") {
    push(GAP_HOLD / 2);
    screen.push({ kind: "gap", text: r.text });
    push(GAP_HOLD);
  } else {
    screen.push({ kind: "out", text: r.text });
    push(HOLD_PER_OUT);
  }
}
push(END_HOLD);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cols = Math.max(...rows.map((r) => r.text.length)) + 4;
const lineCount = rows.length + 1;

const page = (state, cursorOn) => `<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0f18;font:13px/20px ui-monospace,SFMono-Regular,Menlo,monospace}
.win{width:${cols * 8.05 + 36}px;background:#12141f;border-radius:10px;overflow:hidden}
.bar{height:30px;background:#1b1e2e;display:flex;align-items:center;padding:0 12px;gap:8px}
.d{width:10px;height:10px;border-radius:50%}
.t{flex:1;text-align:center;color:#6f7690;font-size:11px;margin-left:-46px}
.body{padding:12px 18px 16px;height:${lineCount * 20 + 22}px}
.cmd{color:#e6e9f2;white-space:pre}.out{color:#b8bfd4;white-space:pre}
.gap{color:#6f7690;font-style:italic;white-space:pre}
.p{color:#8b93b8}
.cur{display:inline-block;width:7px;height:14px;background:#e6e9f2;vertical-align:-2px;opacity:${cursorOn ? 1 : 0}}
</style></head><body><div class="win"><div class="bar">
<span class="d" style="background:#ff5f57"></span><span class="d" style="background:#febc2e"></span><span class="d" style="background:#28c840"></span>
<span class="t">muse — continuity</span></div><div class="body">
${state.map((l, i) => {
  const last = i === state.length - 1;
  if (l.kind === "cmd") return `<div class="cmd"><span class="p">$</span> ${esc(l.text)}${last ? '<span class="cur"></span>' : ""}</div>`;
  if (l.kind === "gap") return `<div class="gap">${esc(l.text)}</div>`;
  return `<div class="out">${esc(l.text)}${last ? '<span class="cur"></span>' : ""}</div>`;
}).join("\n")}
</div></div></body></html>`;

rmSync(`${dir}/frames`, { recursive: true, force: true });
mkdirSync(`${dir}/frames`, { recursive: true });
frames.forEach((state, i) => {
  writeFileSync(`${dir}/frames/f${String(i).padStart(4, "0")}.html`, page(state, Math.floor(i / (FPS / 2)) % 2 === 0));
});
console.log(`${frames.length} frames at ${FPS}fps = ${(frames.length / FPS).toFixed(1)}s`);
