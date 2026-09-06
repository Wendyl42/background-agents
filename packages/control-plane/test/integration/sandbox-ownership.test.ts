import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionDO } from "../../src/session/durable-object";
import { initSchema, MIGRATIONS } from "../../src/session/schema";
import { SandboxRepository } from "../../src/session/sandbox-repository";
import { sandboxOwnershipError } from "../../src/sandbox/ownership";

describe("sandbox provenance in real Durable Object SQLite", () => {
  it("migrates old handles without guessing ownership", async () => {
    const stub = env.SESSION.get(env.SESSION.newUniqueId());
    await runInDurableObject(stub, (instance: SessionDO) => {
      const sql = instance.ctx.storage.sql;
      // No session initialization: this test never warms a sandbox or calls a provider.
      sql.exec(
        `CREATE TABLE sandbox (id TEXT PRIMARY KEY, modal_sandbox_id TEXT, modal_object_id TEXT, snapshot_image_id TEXT)`
      );
      sql.exec(`INSERT INTO sandbox VALUES ('s', 'logical', 'opaque', 'image')`);
      const migration = MIGRATIONS.find(({ id }) => id === 43)!;
      if (typeof migration.run !== "function") throw new Error("Expected migration function");
      migration.run(sql);
      const repository = new SandboxRepository(sql);
      expect(sandboxOwnershipError(repository.getSandbox(), "modal", true)).toContain("unknown");
      repository.adoptLegacySandboxBackend("modal");
      repository.adoptLegacySandboxBackend("local");
      expect(sandboxOwnershipError(repository.getSandbox(), "modal", true)).toBeNull();
      expect(sandboxOwnershipError(repository.getSandbox(), "local", true)).toContain(
        "owned by modal"
      );
    });
  });

  it("persists independent snapshot ownership and rotates only attempt identity on resume", async () => {
    const stub = env.SESSION.get(env.SESSION.newUniqueId());
    await runInDurableObject(stub, (instance: SessionDO) => {
      const repository = new SandboxRepository(instance.ctx.storage.sql);
      initSchema(instance.ctx.storage.sql);
      repository.createSandbox({
        id: "s",
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 1,
      });
      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 2,
        authTokenHash: "test-hash",
        modalSandboxId: "logical",
        sandboxBackend: "local",
        startupAttemptId: "create-1",
      });
      repository.updateSandboxModalObjectId("opaque");
      repository.updateSandboxSnapshotImageId("s", "image", "local");
      repository.updateSandboxForResume({
        status: "connecting",
        createdAt: 3,
        startupAttemptId: "resume-2",
      });
      expect(repository.getSandbox()).toMatchObject({
        sandbox_backend: "local",
        snapshot_backend: "local",
        startup_attempt_id: "resume-2",
        modal_sandbox_id: "logical",
        modal_object_id: "opaque",
        auth_token_hash: "test-hash",
      });
    });
  });
});
