/**
 * Quiet demo agent — emits only agent_top telemetry (stripped from output),
 * so the dashboard redraws cleanly with no passthrough noise. For GIF recording.
 */
"use strict";

let i = 0;
const interval = setInterval(() => {
  i++;
  const tokens = 200 + i * 150;
  console.log(JSON.stringify({ agent_top: { tokens } }));
  console.log(JSON.stringify({ agent_top: { api_call: "openai.chat.completions" } }));
  console.log(JSON.stringify({ agent_top: { action: "tool:web_search:query=" + (i % 3) } }));

  if (i >= 32) {
    clearInterval(interval);
    process.exit(0);
  }
}, 250);
