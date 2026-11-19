import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenSandboxProvider } from "./opensandbox-provider";
import { createSandboxProviderFromEnv } from "../provider-factory";
import type { CreateSandboxConfig } from "../provider";
import type { Env } from "../../types";

const provider = new OpenSandboxProvider({
  apiUrl: "http://localhost:8090",
  apiKey: "private-key",
  image: "local/runtime:test",
  scmProvider: "gitlab",
});
const config: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  startupAttemptId: "attempt-1",
  repoOwner: "group/subgroup",
  repoName: "repo",
  branch: "main",
  controlPlaneUrl: "http://172.17.0.1:8787",
  sandboxAuthToken: "session-key",
  provider: "anthropic",
  model: "model",
  timeoutSeconds: 300,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenSandbox provider", () => {
  it("uses the deployment runtime interpreter without changing task environment paths", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ id: "osb-runtime", status: { state: "Running" } }));
    vi.stubGlobal("fetch", fetcher);
    const isolated = createSandboxProviderFromEnv({
      SANDBOX_PROVIDER: "opensandbox",
      OPENSANDBOX_API_URL: "http://localhost:8090",
      OPENSANDBOX_API_KEY: "test-key",
      OPENSANDBOX_IMAGE: "task:fixed",
      OPENSANDBOX_PYTHON_PATH: "/opt/oi-runtime/bin/python3.12",
    } as Env);
    await isolated.createSandbox(config);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.entrypoint).toEqual([
      "/opt/oi-runtime/bin/python3.12",
      "-m",
      "sandbox_runtime.entrypoint",
    ]);
    expect(body.env.PYTHONHOME).toBeUndefined();
    expect(body.env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it("rejects a non-absolute deployment interpreter", () => {
    expect(
      () =>
        new OpenSandboxProvider({
          apiUrl: "http://localhost:8090",
          apiKey: "test-key",
          image: "task:fixed",
          scmProvider: "github",
          pythonPath: "python -c injected",
        })
    ).toThrow("absolute executable");
  });
  it("finds and deletes a late creation after its response is lost, without touching another attempt", async () => {
    vi.useFakeTimers();
    const metadata = {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_startup_attempt_id: config.startupAttemptId,
    };
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              id: "other",
              metadata: { ...metadata, openinspect_startup_attempt_id: "other-attempt" },
            },
            { id: "late", metadata },
          ],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const assertion = expect(provider.createSandbox(config)).rejects.toMatchObject({
      errorType: "transient",
    });
    await vi.runAllTimersAsync();
    await assertion;
    const filter = new URLSearchParams(
      new URL(fetcher.mock.calls[1][0]).searchParams.get("metadata")!
    );
    expect(filter.get("openinspect_startup_attempt_id")).toBe(config.startupAttemptId);
    expect(
      fetcher.mock.calls.filter(([, init]) => init.method === "DELETE").map(([url]) => url)
    ).toEqual(["http://localhost:8090/v1/sandboxes/late"]);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("redacts malformed response fragments and still attempts cleanup", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"private":"secret-value"'))
      .mockRejectedValue(new TypeError("network unavailable"));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider.createSandbox(config)).rejects.toMatchObject({
      message: "OpenSandbox returned an invalid create response",
      errorType: "transient",
    });
    expect(fetcher.mock.calls[1][1].method).toBe("GET");
  });
  it("sends the native lifecycle contract and protected shared runtime environment", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        id: "osb-1",
        status: { state: "Running" },
        createdAt: "2026-09-07T00:00:00Z",
      })
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await provider.createSandbox({
      ...config,
      sandboxSettings: { cpuCores: 0.5, memoryMib: 1024 },
      userEnvVars: {
        SANDBOX_ID: "spoof",
        CONTROL_PLANE_URL: "http://wrong",
        SESSION_CONFIG: "{}",
        ANTHROPIC_API_KEY: "llm-key",
      },
    });
    expect(result).toMatchObject({
      sandboxId: "sandbox-1",
      providerObjectId: "osb-1",
      createdAt: Date.parse("2026-09-07T00:00:00Z"),
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://localhost:8090/v1/sandboxes");
    expect(init.headers["OPEN-SANDBOX-API-KEY"]).toBe("private-key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      image: { uri: "local/runtime:test" },
      timeout: 300,
      entrypoint: ["python", "-m", "sandbox_runtime.entrypoint"],
      resourceLimits: { cpu: "0.5", memory: "1024Mi" },
      metadata: {
        openinspect_session_id: config.sessionId,
        openinspect_startup_attempt_id: "attempt-1",
      },
      env: {
        SANDBOX_ID: config.sandboxId,
        CONTROL_PLANE_URL: config.controlPlaneUrl,
        ANTHROPIC_API_KEY: "llm-key",
        VCS_HOST: "gitlab.com",
      },
    });
    expect(JSON.parse(body.env.SESSION_CONFIG)).toMatchObject({
      repo_owner: "group/subgroup",
      sandbox_backend: "opensandbox",
      startup_attempt_id: "attempt-1",
    });
  });

  it("keeps long control-plane sandbox IDs out of length-limited labels", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ id: "osb", status: { state: "Running" } }));
    vi.stubGlobal("fetch", fetcher);
    const sandboxId = `sandbox-${"a".repeat(64)}-1788761309814`;
    await provider.createSandbox({ ...config, sandboxId });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(Object.values(body.metadata).every((value) => String(value).length <= 63)).toBe(true);
    expect(body.env.SANDBOX_ID).toBe(sandboxId);
    expect(body.metadata.openinspect_session_id).toBe(config.sessionId);
    expect(body.metadata.openinspect_startup_attempt_id).toBe(config.startupAttemptId);
  });

  it.each([401, 422, 429, 503])(
    "classifies HTTP %s without exposing response secrets",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("secret-env-value", { status }))
      );
      await expect(provider.createSandbox(config)).rejects.toMatchObject({
        errorType: status === 429 || status >= 500 ? "transient" : "permanent",
        message: `OpenSandbox POST failed (HTTP ${status})`,
      });
    }
  );

  it("classifies connection loss as transient and does not retry a creation", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider.createSandbox(config)).rejects.toMatchObject({ errorType: "transient" });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("cleans up a known failed creation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "failed/id", status: { state: "Failed" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider.createSandbox(config)).rejects.toThrow("failed to start");
    expect(fetcher.mock.calls[1][0]).toBe("http://localhost:8090/v1/sandboxes/failed%2Fid");
    expect(fetcher.mock.calls[1][1].method).toBe("DELETE");
  });

  it("treats an already removed sandbox as stopped and respects cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await provider.stopSandbox({
        providerObjectId: "gone",
        sessionId: "session",
        reason: "test",
        signal: abort.signal,
      })
    ).toEqual({ success: true });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each([
    { timeoutSeconds: 59 },
    { codeServerEnabled: true },
    { vncEnabled: true },
    { prebuiltImageId: "other:image" },
    { sandboxSettings: { tunnelPorts: [3000] } },
    { sandboxSettings: { terminalEnabled: true } },
    { sandboxSettings: { memoryMib: -1 } },
  ])(
    "rejects unsupported or invalid configuration before creating resources: %j",
    async (override) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(provider.createSandbox({ ...config, ...override })).rejects.toMatchObject({
        errorType: "permanent",
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it("selects OpenSandbox without any Modal configuration", () => {
    const env = {
      SANDBOX_PROVIDER: "opensandbox",
      OPENSANDBOX_API_URL: "http://localhost:8090",
      OPENSANDBOX_API_KEY: "key",
      OPENSANDBOX_IMAGE: "image",
    } as Env;
    expect(createSandboxProviderFromEnv(env).name).toBe("opensandbox");
    expect(() => createSandboxProviderFromEnv({ ...env, OPENSANDBOX_API_KEY: undefined })).toThrow(
      "OPENSANDBOX_API_KEY"
    );
  });
});
