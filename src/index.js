/**
 * agent-top — core
 * ════════════════
 * Spawns a child process, scans its stdout for a tiny JSON-line protocol,
 * and maintains rolling stats for a live terminal dashboard.
 *
 * Protocol (one JSON object per line on stdout, anywhere in the stream):
 *   {"agent_top":{"tokens":1500}}
 *   {"agent_top":{"api_call":"openai.chat.completions"}}
 *   {"agent_top":{"action":"tool:bash:ls"}}
 *   {"agent_top":{"cost_usd":0.0032}}
 *
 * Lines matching this shape are stripped from the passthrough stream (so
 * your dashboard isn't cluttered with telemetry); everything else is
 * forwarded to stdout unchanged.
 *
 * Zero required dependencies. Optional: aegis-node, if present, is used
 * to actually enforce limits (kill on breach) — agent-top works as a
 * pure dashboard even without it.
 */
"use strict";

const { spawn } = require("child_process");
const os = require("os");

const WINDOW_MS = 60_000;

class AgentTop {
  /**
   * @param {object} opts
   * @param {string} opts.command
   * @param {string[]} [opts.args]
   * @param {number} [opts.pricePer1kTokens] - $ per 1000 tokens, used to
   *   estimate cost when the agent reports tokens but not cost directly.
   *   Default 0.002 (~gpt-4o-mini blended estimate).
   */
  constructor(opts) {
    if (!opts || !opts.command) throw new Error("AgentTop requires { command }");
    this.command = opts.command;
    this.args = opts.args || [];
    this.pricePer1kTokens = opts.pricePer1kTokens || 0.002;

    this.child = null;
    this.startedAt = null;
    this.exited = false;
    this.exitCode = null;

    this.tokenEvents = [];   // { t, amount }
    this.apiCallEvents = []; // { t, name }
    this.actionEvents = [];  // { t, signature }
    this.totalTokens = 0;
    this.totalCostUsd = 0;
    this.totalApiCalls = 0;
  }

  start() {
    this.startedAt = Date.now();
    this.child = spawn(this.command, this.args, {
      stdio: ["inherit", "pipe", "inherit"],
      detached: os.platform() !== "win32",
    });

    let buf = "";
    this.child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!this._maybeConsumeTelemetry(line)) {
          process.stdout.write(line + "\n");
        }
      }
    });

    this.child.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
    });

    return this;
  }

  _maybeConsumeTelemetry(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes("agent_top")) return false;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      return false;
    }
    if (!obj || typeof obj !== "object" || !obj.agent_top) return false;

    const t = Date.now();
    const at = obj.agent_top;
    if (typeof at.tokens === "number") {
      this.tokenEvents.push({ t, amount: at.tokens });
      this.totalTokens += at.tokens;
      if (typeof at.cost_usd !== "number") {
        this.totalCostUsd += (at.tokens / 1000) * this.pricePer1kTokens;
      }
    }
    if (typeof at.cost_usd === "number") {
      this.totalCostUsd += at.cost_usd;
    }
    if (typeof at.api_call === "string") {
      this.apiCallEvents.push({ t, name: at.api_call });
      this.totalApiCalls++;
    }
    if (typeof at.action === "string") {
      this.actionEvents.push({ t, signature: at.action });
    }
    return true;
  }

  _prune(arr, now) {
    while (arr.length && now - arr[0].t > WINDOW_MS) arr.shift();
  }

  /** Returns current stats snapshot for rendering. */
  stats() {
    const now = Date.now();
    this._prune(this.tokenEvents, now);
    this._prune(this.apiCallEvents, now);
    this._prune(this.actionEvents, now);

    const tokensPerMin = this.tokenEvents.reduce((s, e) => s + e.amount, 0);
    const apiCallsPerMin = this.apiCallEvents.length;

    const actionCounts = new Map();
    for (const e of this.actionEvents) {
      actionCounts.set(e.signature, (actionCounts.get(e.signature) || 0) + 1);
    }
    let topAction = null;
    let topActionCount = 0;
    for (const [sig, count] of actionCounts) {
      if (count > topActionCount) {
        topAction = sig;
        topActionCount = count;
      }
    }

    return {
      uptimeMs: now - this.startedAt,
      tokensPerMin,
      apiCallsPerMin,
      totalTokens: this.totalTokens,
      totalApiCalls: this.totalApiCalls,
      totalCostUsd: this.totalCostUsd,
      topAction,
      topActionCount,
      exited: this.exited,
      exitCode: this.exitCode,
      pid: this.child ? this.child.pid : null,
    };
  }

  kill() {
    if (!this.child) return;
    try {
      if (os.platform() === "win32") {
        spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"]);
      } else {
        process.kill(-this.child.pid, "SIGKILL");
      }
    } catch (_) {
      try {
        this.child.kill("SIGKILL");
      } catch (_) {}
    }
  }
}

module.exports = { AgentTop };
