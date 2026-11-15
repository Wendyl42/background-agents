#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeProcessAnalysis } from "./lib/process/output.mjs";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "Usage: node tools/openinspect-trace-analysis/process-cli.mjs BUNDLE [BUNDLE ...] --out NEW_DIRECTORY"
  );
} else {
  if (!values.out || !positionals.length) throw new Error("Provide at least one bundle and --out");
  console.log(writeProcessAnalysis(positionals, values.out));
}
