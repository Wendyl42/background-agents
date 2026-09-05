import { posix } from "node:path";
import { sha256Bytes } from "../../hash.mjs";
import { canonicalJson, normalizedInputFingerprint } from "../inputs.mjs";
import { parsePackageManagerCommand } from "../package-command-parser.mjs";
import { parseSafeCommandStage, splitPipelineStages } from "../shell-command-parser.mjs";
import { extractShellSegments } from "../shell-extractor.mjs";

function normalizedWorkdir(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) return null;
  return posix.normalize(value.trim());
}

function resolveCdTarget(path, baseWorkdir) {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return null;
  if (path.startsWith("/")) return posix.normalize(path);
  return baseWorkdir ? posix.resolve(baseWorkdir, path) : posix.normalize(path);
}

function safeCdTarget(segment, baseWorkdir) {
  const pipeline = splitPipelineStages(segment);
  if (!pipeline.ok || pipeline.stages.length !== 1) return null;
  const parsed = parseSafeCommandStage(pipeline.stages[0]);
  if (!parsed.ok || parsed.program !== "cd" || parsed.args.length !== 1 || parsed.wrapper)
    return null;
  return resolveCdTarget(parsed.args[0], baseWorkdir);
}

function createSegment({ invocation, item, index, effectiveWorkdir, workdirSource, pipeline }) {
  const identity = {
    schemaVersion: "openinspect-shell-segment-block-c-v2",
    sourceInvocationId: invocation.invocationId,
    segmentIndex: index,
    text: item.segment,
    separatorBefore: item.separatorBefore,
    effectiveWorkdir,
    workdirSource,
  };
  return {
    schemaVersion: "openinspect-shell-segment-block-c-v2",
    shellSegmentId: `seg_${sha256Bytes(Buffer.from(canonicalJson(identity))).slice(0, 32)}`,
    sourceInvocationId: invocation.invocationId,
    sourceEventId: invocation.sourceEventId,
    sessionId: invocation.sessionId,
    segmentIndex: index,
    text: item.segment,
    separatorBefore: item.separatorBefore,
    workdir: effectiveWorkdir
      ? { present: true, value: effectiveWorkdir, source: workdirSource }
      : { present: false },
    pipeline: pipeline.ok
      ? {
          stageCount: pipeline.stages.length,
          firstStage: pipeline.stages[0],
          tailStageCount: Math.max(0, pipeline.stages.length - 1),
        }
      : { stageCount: null, firstStage: null, tailStageCount: null },
    normalizationStatus: "syntactic",
    matchedSemanticParser: null,
    emittedOperationIds: [],
    diagnostics: pipeline.ok ? [] : pipeline.diagnostics,
  };
}

function syntacticDraft(invocation, segment, pipeline) {
  const parameters = {
    pipeline: pipeline.ok
      ? { stageCount: pipeline.stages.length, firstStageOnlyPolicy: true }
      : { stageCount: null, firstStageOnlyPolicy: true },
  };
  return {
    parser: { id: "shell.segment", version: "2.0.0" },
    kind: "shell_segment",
    targetType: "shell_command",
    target: segment.text,
    scope: segment.workdir.present ? segment.workdir.source : "invocation_default",
    effect: "unknown",
    parameters,
    inputFingerprint: normalizedInputFingerprint({ target: segment.text, parameters }),
    normalizationLevel: "syntactic",
    confidence: "high",
    sourceShellSegmentIds: [segment.shellSegmentId],
    evidence: {
      sourceEventId: invocation.sourceEventId,
      sourceSessionId: invocation.sessionId,
      shellSegmentId: segment.shellSegmentId,
      shellSegmentIndex: segment.segmentIndex,
      commandArgument: "command",
    },
    diagnostics: {
      pipelinePreserved: pipeline.ok ? pipeline.stages.length > 1 : true,
    },
  };
}

function invocationStatus(segments) {
  const semantic = segments.some((segment) =>
    new Set(["specific", "mixed"]).has(segment.normalizationStatus)
  );
  const incomplete = segments.some((segment) =>
    new Set(["syntactic", "mixed"]).has(segment.normalizationStatus)
  );
  if (semantic && incomplete) return "mixed";
  if (semantic) return "specific";
  return "syntactic";
}

export function bashCompositeRuleV2(semanticRegistry) {
  return {
    id: "shell.composite",
    version: "2.0.0",
    priority: 20,
    supportedTools: ["bash"],
    match: () => true,
    normalize(invocation) {
      const extracted = extractShellSegments(invocation.args?.command);
      if (!extracted.ok) {
        return {
          status: "fallback",
          operations: [],
          segments: [],
          diagnostics: extracted.diagnostics,
        };
      }

      const explicitWorkdir = normalizedWorkdir(invocation.args?.workdir);
      const segments = [];
      const operations = [];
      let previousCdTarget = null;

      for (const [index, item] of extracted.segments.entries()) {
        const derivedWorkdir = item.separatorBefore === "&&" ? previousCdTarget : null;
        const effectiveWorkdir = derivedWorkdir ?? explicitWorkdir;
        const workdirSource = derivedWorkdir
          ? "preceding_cd_and"
          : explicitWorkdir
            ? "explicit_workdir"
            : "invocation_default";
        const pipeline = splitPipelineStages(item.segment);
        const segment = createSegment({
          invocation,
          item,
          index,
          effectiveWorkdir,
          workdirSource,
          pipeline,
        });

        let semantic = null;
        let semanticDiagnostic = null;
        if (pipeline.ok) {
          const parsedStage = parseSafeCommandStage(pipeline.stages[0]);
          if (parsedStage.ok) {
            const parsedPackageCommand = parsePackageManagerCommand(parsedStage);
            if (parsedPackageCommand.ok) {
              const selector = {
                tool: parsedPackageCommand.descriptor.manager,
                invocationId: segment.shellSegmentId,
                descriptor: parsedPackageCommand.descriptor,
              };
              const rule = semanticRegistry.select(selector);
              if (!rule) {
                throw new Error(
                  `No semantic rule for ${parsedPackageCommand.descriptor.manager}:${parsedPackageCommand.descriptor.form}`
                );
              }
              const context = {
                ...selector,
                invocation,
                segment,
                descriptor: parsedPackageCommand.descriptor,
                effectiveWorkdir,
                workdirSource,
              };
              semantic = { rule, draft: rule.normalize(context) };
            } else {
              semanticDiagnostic = parsedPackageCommand.diagnostics[0];
            }
          } else {
            semanticDiagnostic = parsedStage.diagnostics[0];
          }
        } else {
          semanticDiagnostic = pipeline.diagnostics[0];
        }

        if (semantic) {
          segment.normalizationStatus =
            pipeline.ok && pipeline.stages.length > 1 ? "mixed" : "specific";
          segment.matchedSemanticParser = {
            id: semantic.rule.id,
            version: semantic.rule.version,
          };
          if (segment.normalizationStatus === "mixed") {
            segment.diagnostics.push({
              code: "pipeline_tail_preserved_syntactic",
              tailStageCount: pipeline.stages.length - 1,
            });
          }
          operations.push({
            ...semantic.draft,
            parser: { id: semantic.rule.id, version: semantic.rule.version },
          });
        } else {
          segment.normalizationStatus = "syntactic";
          if (semanticDiagnostic) segment.diagnostics.push(semanticDiagnostic);
          operations.push(syntacticDraft(invocation, segment, pipeline));
        }

        segments.push(segment);
        previousCdTarget = safeCdTarget(item.segment, effectiveWorkdir);
      }

      return {
        status: invocationStatus(segments),
        operations,
        segments,
        diagnostics: extracted.diagnostics,
      };
    },
  };
}
