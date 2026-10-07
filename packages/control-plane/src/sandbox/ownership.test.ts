import { describe, expect, it } from "vitest";
import { sandboxOwnershipError, type SandboxOwnership } from "./ownership";

const owned: SandboxOwnership = {
  modal_sandbox_id: "logical-1",
  modal_object_id: "opaque-1",
  sandbox_backend: "modal",
  snapshot_image_id: "image-1",
  snapshot_backend: "modal",
};

describe("sandbox ownership", () => {
  it("accepts fresh state and verified same-backend handles", () => {
    expect(sandboxOwnershipError(null, "local", true)).toBeNull();
    expect(sandboxOwnershipError(owned, "modal", true)).toBeNull();
    expect(
      sandboxOwnershipError(
        { ...owned, modal_sandbox_id: null, modal_object_id: null, snapshot_image_id: null },
        "local",
        true
      )
    ).toBeNull();
  });

  it("rejects unknown legacy ownership without guessing from the active backend", () => {
    expect(sandboxOwnershipError({ ...owned, sandbox_backend: null }, "modal", false)).toContain(
      "SANDBOX_LEGACY_PROVIDER"
    );
  });

  it("checks instance and snapshot ownership separately", () => {
    expect(sandboxOwnershipError(owned, "local", false)).toContain("owned by modal");
    const oldSnapshot = { ...owned, sandbox_backend: "local" };
    expect(sandboxOwnershipError(oldSnapshot, "local", false)).toBeNull();
    expect(sandboxOwnershipError(oldSnapshot, "local", true)).toContain("snapshot owned by modal");
    expect(sandboxOwnershipError({ ...owned, snapshot_backend: null }, "modal", true)).toContain(
      "ownership is unknown"
    );
  });
});
