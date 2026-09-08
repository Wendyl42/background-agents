import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SandboxProvider,
  type StopConfig,
  type StopResult,
} from "../provider";
import { buildSandboxEnvVars, scmCloneIdentity } from "../sandbox-env";

const log = createLogger("opensandbox-provider");
export const OPENSANDBOX_CREATE_TIMEOUT_MS = 90_000;
const DELETE_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_DELAYS_MS = [0, 1_000, 2_000];
const DEFAULT_CPU_CORES = 1;
const DEFAULT_MEMORY_MIB = 2048;

export interface OpenSandboxProviderConfig {
  /** Server origin, without /v1. */
  apiUrl: string;
  apiKey: string;
  /** Locally built image containing sandbox_runtime and the agent toolchain. */
  image: string;
  scmProvider: SourceControlProviderName;
}

/** Direct lifecycle API adapter; the image entrypoint starts the shared runtime. */
export class OpenSandboxProvider implements SandboxProvider {
  readonly name = "opensandbox";
  readonly capabilities = {
    supportsSandboxTimeout: true,
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(private readonly config: OpenSandboxProviderConfig) {
    const url = new URL(config.apiUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error(
        "OPENSANDBOX_API_URL must be an HTTP(S) origin without a path or credentials"
      );
    }
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    if (
      config.prebuiltImageId ||
      config.codeServerEnabled ||
      config.vncEnabled ||
      config.sandboxSettings?.terminalEnabled ||
      config.sandboxSettings?.tunnelPorts?.length
    ) {
      throw new SandboxProviderError(
        "OpenSandbox does not support repo images, code-server, VNC, web terminal, or tunnel ports; disable these features for this backend",
        "permanent"
      );
    }
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60) {
      throw new SandboxProviderError(
        "OpenSandbox sandbox lifetime must be at least 60 seconds",
        "permanent"
      );
    }
    const cpuCores = config.sandboxSettings?.cpuCores ?? DEFAULT_CPU_CORES;
    const memoryMib = config.sandboxSettings?.memoryMib ?? DEFAULT_MEMORY_MIB;
    if (
      !Number.isFinite(cpuCores) ||
      cpuCores <= 0 ||
      !Number.isInteger(memoryMib) ||
      memoryMib <= 0
    ) {
      throw new SandboxProviderError(
        "OpenSandbox requires positive CPU cores and integer memory MiB",
        "permanent"
      );
    }
    const startedAt = Date.now();
    const startupAttemptId = config.startupAttemptId ?? crypto.randomUUID();
    const metadata = {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_startup_attempt_id: startupAttemptId,
    };
    // OpenSandbox applies the 63-character Kubernetes label limit even on Docker.
    // Full CP sandbox IDs live in runtime logs/env; join via session + startup attempt.
    const body = {
      image: { uri: this.config.image },
      entrypoint: ["python", "-m", "sandbox_runtime.entrypoint"],
      timeout: timeoutSeconds,
      resourceLimits: { cpu: String(cpuCores), memory: `${memoryMib}Mi` },
      env: buildSandboxEnvVars(
        { ...config, sandboxBackend: this.name, startupAttemptId },
        {
          scmIdentity: scmCloneIdentity(this.config.scmProvider),
        }
      ),
      metadata,
    };
    let providerObjectId: string | undefined;
    try {
      const response = await this.request(
        "POST",
        "/v1/sandboxes",
        OPENSANDBOX_CREATE_TIMEOUT_MS,
        body
      );
      const sandbox = (await response.json()) as {
        id?: unknown;
        status?: { state?: string };
        createdAt?: string;
      };
      if (typeof sandbox?.id !== "string" || !sandbox.id) {
        throw new Error("Invalid create response");
      }
      providerObjectId = sandbox.id;
      if (typeof sandbox.status?.state !== "string") throw new Error("Invalid create state");
      if (["Failed", "Terminated"].includes(sandbox.status.state)) {
        throw new SandboxProviderError("OpenSandbox failed to start the sandbox", "permanent");
      }
      log.info("opensandbox.create", {
        session_id: config.sessionId,
        sandbox_id: config.sandboxId,
        provider_object_id: providerObjectId,
        startup_attempt_id: startupAttemptId,
        duration_ms: Date.now() - startedAt,
        image: this.config.image,
      });
      return {
        sandboxId: config.sandboxId,
        providerObjectId,
        status: sandbox.status.state,
        createdAt:
          sandbox.createdAt && Number.isFinite(Date.parse(sandbox.createdAt))
            ? Date.parse(sandbox.createdAt)
            : Date.now(),
      };
    } catch (error) {
      if (providerObjectId) {
        await this.stopSandbox({
          providerObjectId,
          sessionId: config.sessionId,
          reason: "failed-create",
        });
      } else if (!(error instanceof SandboxProviderError) || error.errorType === "transient") {
        await this.cleanupUnacknowledgedCreate(metadata);
      }
      // JSON parse exceptions can include body fragments; never expose those.
      throw error instanceof SandboxProviderError
        ? error
        : new SandboxProviderError("OpenSandbox returned an invalid create response", "transient");
    }
  }

  private async cleanupUnacknowledgedCreate(metadata: Record<string, string>): Promise<void> {
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    const query = new URLSearchParams({
      metadata: new URLSearchParams(metadata).toString(),
      pageSize: "200",
    });
    try {
      for (const delayMs of CLEANUP_DELAYS_MS) {
        if (signal.aborted) break;
        if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
        const response = await this.request(
          "GET",
          `/v1/sandboxes?${query}`,
          CLEANUP_TIMEOUT_MS,
          undefined,
          signal
        );
        const result = (await response.json()) as {
          items: Array<{ id: string; metadata?: Record<string, string> }>;
        };
        const owned = result.items.filter(
          (item) =>
            typeof item.id === "string" &&
            Object.entries(metadata).every(([key, value]) => item.metadata?.[key] === value)
        );
        for (const item of owned) {
          await this.request(
            "DELETE",
            `/v1/sandboxes/${encodeURIComponent(item.id)}`,
            CLEANUP_TIMEOUT_MS,
            undefined,
            signal
          );
        }
        if (owned.length) return;
      }
    } catch {
      // No second POST: the server may still finish provisioning after this window.
    }
    log.warn("opensandbox.create_cleanup_unconfirmed", {
      session_id: metadata.openinspect_session_id,
      startup_attempt_id: metadata.openinspect_startup_attempt_id,
      fallback: "server_ttl",
    });
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      await this.request(
        "DELETE",
        `/v1/sandboxes/${encodeURIComponent(config.providerObjectId)}`,
        DELETE_TIMEOUT_MS,
        undefined,
        config.signal
      );
      return { success: true };
    } catch (error) {
      log.warn("opensandbox.stop_failed", {
        session_id: config.sessionId,
        provider_object_id: config.providerObjectId,
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async request(
    method: string,
    path: string,
    timeoutMs: number,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${this.config.apiUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "OPEN-SANDBOX-API-KEY": this.config.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (response.ok || (method === "DELETE" && response.status === 404)) return response;
      // Provider errors may contain environment values; never log the response body.
      throw new SandboxProviderError(
        `OpenSandbox ${method} failed (HTTP ${response.status})`,
        response.status === 408 || response.status === 429 || response.status >= 500
          ? "transient"
          : "permanent"
      );
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw new SandboxProviderError(
        `OpenSandbox ${method} request failed`,
        "transient",
        error instanceof Error ? error : undefined
      );
    }
  }
}
