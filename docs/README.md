# Documentation Map

Start with the guide for the task at hand. Current behavior, measurement definitions, and historical
design records have separate owners; reading every plan is not required to work on the project.

## Setup and architecture

| Question                                                | Primary document                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| How do I run the web app locally or set up development? | [SETUP_GUIDE.md](SETUP_GUIDE.md)                                                                                             |
| How do I deploy a complete instance?                    | [GETTING_STARTED.md](GETTING_STARTED.md), [Terraform](../terraform/README.md)                                                |
| How do sessions, sandboxes, and prompts work?           | [HOW_IT_WORKS.md](HOW_IT_WORKS.md)                                                                                           |
| What are the development commands and conventions?      | [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md)                                                             |
| Where are the APIs and package entrypoints?             | [Package map](../README.md#packages), [control plane](../packages/control-plane/README.md), [web](../packages/web/README.md) |

The data plane has two distinct owners: provider adapters manage sandbox lifecycle, while
`packages/sandbox-runtime` runs the shared supervisor, bridge, and agent tools inside the sandbox.
`modal-infra` is one backend, not the owner of the shared runtime.

## Logs, traces, and offline analysis

| Question                                                                        | Primary document                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Where do events originate, what is persisted, and what can the timestamps mean? | [TRACE_PIPELINE.md](TRACE_PIPELINE.md)                                 |
| How do I correlate service logs and debug a running deployment?                 | [DEBUGGING_PLAYBOOK.md](DEBUGGING_PLAYBOOK.md)                         |
| How are backend identity, clocks, runtime logs, and host attachments recorded?  | [SANDBOX_BACKEND_PREPARATION.md](SANDBOX_BACKEND_PREPARATION.md)       |
| How do I run the existing offline analyzers?                                    | [Trace analysis README](../tools/openinspect-trace-analysis/README.md) |
| What is implemented and where are the results?                                  | [Trace analysis status](../tools/openinspect-trace-analysis/STATUS.md) |

The trace analysis README routes to the measurement contracts, data schemas, experiment protocol,
and dated results. Experiment results describe their own datasets; they are not general statements
about every deployment or bundle.

## Deployment and feature references

| Area                              | Documents                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox backends                  | [Modal](../packages/modal-infra/README.md), [Daytona](../packages/daytona-infra/README.md), [E2B](E2B_SANDBOX_PROVIDER.md), [Vercel](VERCEL_SANDBOX_PROVIDER.md), [OpenComputer](OPENCOMPUTER_PROVIDER.md) |
| Images and secrets                | [IMAGE_PREBUILD.md](IMAGE_PREBUILD.md), [SECRETS.md](SECRETS.md)                                                                                                                                           |
| Scheduling and repository targets | [AUTOMATIONS.md](AUTOMATIONS.md), [MULTI_REPO_AUTOMATIONS.md](MULTI_REPO_AUTOMATIONS.md)                                                                                                                   |
| Managed skills                    | [MANAGED_SKILLS.md](MANAGED_SKILLS.md)                                                                                                                                                                     |
| Model configuration               | [AVAILABLE_MODELS.md](AVAILABLE_MODELS.md), [OPENAI_MODELS.md](OPENAI_MODELS.md), [GROK_MODELS.md](GROK_MODELS.md)                                                                                         |
| Integrations                      | [Slack](integrations/SLACK.md), [GitHub](integrations/GITHUB.md), [Linear](integrations/LINEAR.md)                                                                                                         |

## Decisions and historical material

Accepted architecture decisions:

- [SCM boundaries](adr/0001-single-provider-scm-boundaries.md) and the
  [provider contribution checklist](provider-contribution-checklist.md).
- [Shared session contracts and correlation naming](adr/0002-shared-session-contracts-and-correlation-boundary.md).
- [Session snapshot handoff](adr/0003-session-snapshot-handoff.md).

Design records retain rationale and design-time inventories. They do not prescribe the next task:

- [Managed skills design](plans/managed-skills.md); current use is documented in the feature guide.
- [Task activity nesting](plans/task-activity-nesting.md); current collection boundaries are in the
  trace pipeline.
- [shadcn/ui proposal](shadcn-ui-integration-plan.md).
- [Ramp Inspect reference](ramp-inspect-agent.md), describing the external system that inspired this
  project.
- [Trace analysis checkpoints](../tools/openinspect-trace-analysis/history/CHECKPOINTS.md),
  preserving earlier validation and pilot results.

## Keeping documentation consistent

Put commands in the relevant README or setup guide, definitions in the relevant contract, and
dataset-specific numbers in dated results. Link to these owners from summaries instead of copying
their full contents. Keep current status short; historical validation records belong with history or
results. Verify code paths and CLI flags against the implementation when updating a guide.
