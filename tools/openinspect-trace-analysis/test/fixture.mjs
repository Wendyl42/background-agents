import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashFile } from "../lib/hash.mjs";
import { stableJson } from "../lib/json.mjs";

const BASE = 1_700_000_000_000;

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, stableJson(value));
}

function writeJsonl(path, values) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function event(sessionId, id, type, createdAt, data, messageId = null) {
  return {
    rootSessionId: "root",
    sessionId,
    parentSessionId: sessionId === "root" ? null : "root",
    spawnDepth: sessionId === "root" ? 0 : 1,
    id,
    type,
    data,
    messageId,
    createdAt,
  };
}

export function createSyntheticBundle(root) {
  const sessions = [
    {
      id: "root",
      title: "Synthetic root",
      parentSessionId: null,
      spawnDepth: 0,
      status: "completed",
      createdAt: BASE,
      updatedAt: BASE + 5_000,
      activeDurationMs: 4_800,
      totalCost: 0.01,
      model: "test/model",
      repoOwner: "test",
      repoName: "repo",
    },
    {
      id: "child",
      title: "Synthetic child",
      parentSessionId: "root",
      spawnDepth: 1,
      status: "completed",
      createdAt: BASE + 1_000,
      updatedAt: BASE + 4_000,
      activeDurationMs: 1_800,
      totalCost: 0.02,
      model: "test/model",
      repoOwner: "test",
      repoName: "repo",
    },
  ];
  const messages = [
    {
      rootSessionId: "root",
      sessionId: "root",
      parentSessionId: null,
      spawnDepth: 0,
      id: "root-message",
      authorId: "user",
      content: "coordinate",
      source: "web",
      status: "completed",
      createdAt: BASE + 100,
      startedAt: BASE + 200,
      completedAt: BASE + 5_000,
    },
    {
      rootSessionId: "root",
      sessionId: "child",
      parentSessionId: "root",
      spawnDepth: 1,
      id: "child-message",
      authorId: "user",
      content: "work",
      source: "agent",
      status: "completed",
      createdAt: BASE + 1_100,
      startedAt: BASE + 2_200,
      completedAt: BASE + 4_000,
    },
  ];
  const events = [
    event("root", "root-ready", "ready", BASE + 100, {
      type: "ready",
      sandboxId: "sandbox-root",
      timestamp: (BASE + 90) / 1000,
    }),
    event(
      "root",
      "root-user",
      "user_message",
      BASE + 200,
      {
        type: "user_message",
        messageId: "root-message",
        content: "coordinate",
        timestamp: BASE / 1000,
      },
      "root-message"
    ),
    event(
      "root",
      "root-tool",
      "tool_call",
      BASE + 500,
      {
        type: "tool_call",
        tool: "bash",
        args: { command: "echo root" },
        callId: "root-call",
        status: "completed",
        output: "root",
        messageId: "root-message",
        sandboxId: "sandbox-root",
        timestamp: (BASE + 800) / 1000,
      },
      "root-message"
    ),
    event(
      "root",
      "root-complete",
      "execution_complete",
      BASE + 5_000,
      {
        type: "execution_complete",
        messageId: "root-message",
        success: true,
        timestamp: (BASE + 5_000) / 1000,
      },
      "root-message"
    ),
    event("child", "child-ready", "ready", BASE + 2_000, {
      type: "ready",
      sandboxId: "sandbox-child",
      timestamp: (BASE + 1_990) / 1000,
    }),
    event(
      "child",
      "child-user",
      "user_message",
      BASE + 2_200,
      {
        type: "user_message",
        messageId: "child-message",
        content: "work",
        timestamp: (BASE + 2_200) / 1000,
      },
      "child-message"
    ),
    event(
      "child",
      "child-tool-a",
      "tool_call",
      BASE + 2_300,
      {
        type: "tool_call",
        tool: "read",
        args: { filePath: "/workspace/a" },
        callId: "child-call-a",
        status: "completed",
        output: "a",
        messageId: "child-message",
        sandboxId: "sandbox-child",
        timestamp: (BASE + 3_000) / 1000,
      },
      "child-message"
    ),
    event(
      "child",
      "child-tool-b",
      "tool_call",
      BASE + 2_500,
      {
        type: "tool_call",
        tool: "read",
        args: { filePath: "/workspace/b" },
        callId: "child-call-b",
        status: "completed",
        output: "b",
        messageId: "child-message",
        sandboxId: "sandbox-child",
        timestamp: (BASE + 3_500) / 1000,
      },
      "child-message"
    ),
    event(
      "child",
      "child-write",
      "tool_call",
      BASE + 3_600,
      {
        type: "tool_call",
        tool: "write",
        args: { filePath: "/workspace/result.md", content: "DO_NOT_COPY" },
        callId: "child-write",
        status: "completed",
        output: "Wrote file successfully.",
        messageId: "child-message",
        sandboxId: "sandbox-child",
        timestamp: (BASE + 3_700) / 1000,
      },
      "child-message"
    ),
    event(
      "child",
      "child-complete",
      "execution_complete",
      BASE + 4_000,
      {
        type: "execution_complete",
        messageId: "child-message",
        success: true,
        timestamp: (BASE + 4_000) / 1000,
      },
      "child-message"
    ),
  ];

  const eventTypes = {
    execution_complete: 2,
    ready: 2,
    tool_call: 4,
    user_message: 2,
  };
  const completeness = {
    rootSessionId: "root",
    sessionCount: 2,
    sessionIds: ["root", "child"],
    parentMismatches: [],
    sessions: [
      { sessionId: "root", eventCount: 4, messageCount: 1 },
      { sessionId: "child", eventCount: 6, messageCount: 1 },
    ],
    eventCount: 10,
    messageCount: 2,
    eventTypes,
    compositeEventIdDuplicates: [],
    compositeMessageIdDuplicates: [],
  };
  const missingness = {
    stepStartAndStepFinish: "not persisted",
    normalizedOperations: "not implemented",
  };

  writeJson(join(root, "completeness.json"), completeness);
  writeJson(join(root, "missingness.json"), missingness);
  writeJson(join(root, "raw/session-index.json"), { sessions });
  writeJsonl(join(root, "normalized/events.jsonl"), events);
  writeJsonl(join(root, "normalized/messages.jsonl"), messages);

  const hashedPaths = [
    "completeness.json",
    "missingness.json",
    "raw/session-index.json",
    "normalized/events.jsonl",
    "normalized/messages.jsonl",
  ];
  const files = hashedPaths.map((path) => ({ path, ...hashFile(join(root, path)) }));
  writeJson(join(root, "hashes.json"), { algorithm: "sha256", files });
  writeJson(join(root, "manifest.json"), {
    schemaVersion: "openinspect-trace-v0",
    exportedAt: "2026-08-21T00:00:00.000Z",
    source: { rootSessionId: "root", webUrl: null, controlPlaneUrl: null, repository: "test/repo" },
    interval: { earliestSessionCreatedAt: BASE, latestSessionUpdatedAt: BASE + 5_000 },
    counts: { sessions: 2, events: 10, messages: 2 },
    deployment: {},
    infrastructureLogs: {},
    limitationsFile: "missingness.json",
    completenessFile: "completeness.json",
    hashesFile: "hashes.json",
    securityScanFile: null,
  });
  return root;
}
