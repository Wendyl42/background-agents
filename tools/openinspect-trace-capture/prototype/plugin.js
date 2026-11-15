import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import process from "node:process";

export const TraceProbe = async () => ({
  "shell.env": async (input, output) => {
    const context = { session_id: input.sessionID, call_id: input.callID, token: randomUUID() };
    appendFileSync(
      `${process.env.OI_TRACE_PROBE_DIR}/hooks.jsonl`,
      JSON.stringify({ kind: "shell_hook", ...context }) + "\n"
    );
    output.env.OI_TRACE_PROBE_CONTEXT = JSON.stringify(context);
  },
});
