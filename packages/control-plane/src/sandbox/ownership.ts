/** Provider handles are opaque and must never be interpreted by another backend. */
export interface SandboxOwnership {
  modal_sandbox_id: string | null;
  modal_object_id: string | null;
  sandbox_backend: string | null;
  snapshot_image_id: string | null;
  snapshot_backend: string | null;
}

export function sandboxOwnershipError(
  sandbox: SandboxOwnership | null,
  backend: string,
  includeSnapshot: boolean
): string | null {
  if (!sandbox) return null;
  const resources = [
    {
      kind: "sandbox",
      exists: !!(sandbox.modal_sandbox_id || sandbox.modal_object_id),
      owner: sandbox.sandbox_backend,
    },
    {
      kind: "snapshot",
      exists: includeSnapshot && !!sandbox.snapshot_image_id,
      owner: sandbox.snapshot_backend,
    },
  ];
  for (const resource of resources) {
    if (!resource.exists || resource.owner === backend) continue;
    if (!resource.owner) {
      return `Cannot use ${resource.kind}: backend ownership is unknown. Set SANDBOX_LEGACY_PROVIDER to the verified historical backend, or use a new session.`;
    }
    return `Cannot use ${resource.kind} owned by ${resource.owner} with backend ${backend}. Use the original backend or a new session.`;
  }
  return null;
}
