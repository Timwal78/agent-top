/**
 * Fake "agent" for demos — emits agent_top telemetry lines plus normal
 * output, simulating a tool-call loop that escalates token usage.
 *
 * Run directly:    node examples/fake-agent.js
 * With dashboard:  node bin/cli.js -- node examples/fake-agent.js
 */
"use strict";

let i = 0;
const interval = setInterval(() => {
  i++;
  const tokens = 200 + i * 150; // escalating burn rate
  console.log(`[agent] step ${i}: thinking...`);
  console.log(JSON.stringify({ agent_top: { tokens } }));
  console.log(JSON.stringify({ agent_top: { api_call: "openai.chat.completions" } }));
  console.log(JSON.stringify({ agent_top: { action: "tool:web_search:query=" + (i % 3) } }));

  if (i >= 40) {
    console.log("[agent] done.");
    clearInterval(interval);
    process.exit(0);
  }
}, 250);
