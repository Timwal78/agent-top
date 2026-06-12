#!/usr/bin/env node
/**
 * agent-top CLI
 * ─────────────
 * Usage:
 *   npx agent-top [--price-per-1k 0.002] -- <command> [args...]
 *
 * Live dashboard updates ~4x/sec. Press 'k' to kill the agent immediately.
 * Press 'q' or Ctrl-C to detach (agent keeps running).
 *
 * Your agent reports telemetry by printing JSON lines to stdout:
 *   console.log(JSON.stringify({ agent_top: { tokens: 1500 } }))
 *   console.log(JSON.stringify({ agent_top: { api_call: "openai.chat" } }))
 *   console.log(JSON.stringify({ agent_top: { action: "tool:bash:ls" } }))
 * These lines are stripped from the visible output automatically.
 */
"use strict";

const { AgentTop } = require("../src/index.js");

let AegisGuard = null;
try {
  // Optional peer: if aegis-node is installed, agent-top's 'k' key and
  // the dashboard's loop/rate warnings can be backed by real enforcement.
  AegisGuard = require("@timothywalton/aegis-node").AegisNode;
} catch (_) {
  /* aegis-node not installed — dashboard-only mode */
}

function parseArgs(argv) {
  const out = { pricePer1kTokens: 0.002, cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.cmd = argv.slice(i + 1);
      break;
    }
    if (a === "--price-per-1k") out.pricePer1kTokens = Number(argv[++i]);
  }
  return out;
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.cmd.length) {
  console.error("agent-top: no command given.\n\nUsage: npx agent-top [--price-per-1k 0.002] -- <command> [args...]");
  process.exit(2);
}

const top = new AgentTop({
  command: parsed.cmd[0],
  args: parsed.cmd.slice(1),
  pricePer1kTokens: parsed.pricePer1kTokens,
}).start();

// ── Dashboard rendering ──────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", magenta: "\x1b[35m",
};

function bar(value, max, width, color) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(ratio * width);
  const c = ratio > 0.85 ? C.red : ratio > 0.5 ? C.yellow : color;
  return c + "█".repeat(filled) + C.dim + "░".repeat(width - filled) + C.reset;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Reasonable default scales for the bar visualizations — purely cosmetic,
// real enforcement belongs to aegis-node.
const TOKEN_SCALE = 50_000; // tokens/min for a "full" bar
const API_SCALE = 60;       // calls/min for a "full" bar

let killed = false;

function render() {
  const s = top.stats();
  const lines = [];
  lines.push(`${C.bold}${C.cyan}agent-top${C.reset}  ${C.dim}pid ${s.pid}  uptime ${fmtTime(s.uptimeMs)}${C.reset}`);
  lines.push("");
  lines.push(`  tokens/min  ${bar(s.tokensPerMin, TOKEN_SCALE, 24, C.green)}  ${s.tokensPerMin.toLocaleString()} / ${TOKEN_SCALE.toLocaleString()}`);
  lines.push(`  api calls/m ${bar(s.apiCallsPerMin, API_SCALE, 24, C.green)}  ${s.apiCallsPerMin} / ${API_SCALE}`);
  lines.push("");
  lines.push(`  total tokens   ${C.bold}${s.totalTokens.toLocaleString()}${C.reset}`);
  lines.push(`  total api calls ${C.bold}${s.totalApiCalls}${C.reset}`);
  lines.push(`  est. cost      ${C.bold}${C.green}$${s.totalCostUsd.toFixed(4)}${C.reset}`);
  if (s.topAction) {
    const loopWarn = s.topActionCount >= 5 ? `  ${C.red}${C.bold}⚠ possible loop${C.reset}` : "";
    lines.push(`  top action     ${s.topAction} ${C.dim}(x${s.topActionCount}/min)${C.reset}${loopWarn}`);
  }
  lines.push("");
  if (s.exited) {
    lines.push(`  ${C.yellow}agent exited (code ${s.exitCode})${C.reset}`);
  } else {
    const guard = AegisGuard ? `${C.green}aegis-node: active${C.reset}` : `${C.dim}aegis-node: not installed — dashboard only${C.reset}`;
    lines.push(`  ${C.dim}[k] kill agent now    [q] detach${C.reset}    ${guard}`);
  }
  return lines.join("\n");
}

let lastLineCount = 0;
function repaint() {
  if (lastLineCount > 0) {
    process.stdout.write(`\x1b[${lastLineCount}A`); // move cursor up
    process.stdout.write("\x1b[J"); // clear to end of screen
  }
  const out = render();
  process.stdout.write(out + "\n");
  lastLineCount = out.split("\n").length;
}

const interval = setInterval(() => {
  repaint();
  if (top.exited && !killed) {
    clearInterval(interval);
    cleanup();
    process.exit(top.exitCode || 0);
  }
}, 250);

repaint();

function cleanup() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    if (key === "k" || key === "K") {
      killed = true;
      top.kill();
      clearInterval(interval);
      repaint();
      process.stdout.write(`\n${C.red}${C.bold}[agent-top] killed.${C.reset}\n`);
      cleanup();
      process.exit(137);
    }
    if (key === "q" || key === "\u0003") {
      clearInterval(interval);
      cleanup();
      process.stdout.write(`\n${C.dim}[agent-top] detached — agent keeps running (pid ${top.child.pid}).${C.reset}\n`);
      process.exit(0);
    }
  });
}
