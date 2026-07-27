#!/usr/bin/env node

const timer = setInterval(() => {}, 60_000);

process.on("message", (message) => {
  if (message !== "close") return;
  clearInterval(timer);
  process.disconnect?.();
});

if (typeof process.send === "function") {
  process.send("ready");
}
