# OpenSandbox exclusive vCPU allocation

This local Docker server extension assigns each sandbox a disjoint, fixed set of
WSL/Linux logical CPUs before the container starts. Default width is two. The
existing CPU-time and memory limits remain in force. It does not isolate unrelated
Linux processes, host Windows workloads, interrupts, caches or memory bandwidth.

The implementation belongs to `background-agents`; benchmark controllers remain
in `benchmark-lab`. This directory intentionally does not restore the historical
P5 deployment tooling or modify any frozen target/campaign.

## Build and enable

Build a separate image from the **already prepared local** OpenSandbox server image:

```sh
docker build --pull=false --network=none \
  -f packages/opensandbox-infra/Dockerfile.cpu-pool \
  -t openinspect-opensandbox-server:cpu-pool \
  packages/opensandbox-infra
```

The build refuses an incompatible upstream create/start boundary and writes
`/app/openinspect-cpu-pool-provenance.json` with original/adapted source hashes and
allocator hash. Pin the resulting server image ID and export this manifest into
the infrastructure evidence for new campaigns. Target source provenance alone
cannot identify an externally deployed server image.

Enable only between experiments: stop new submissions, wait for existing sandboxes
to be deleted and confirm cleanup, then replace the server with this image using
its existing configuration/socket mounts and persistent `oi-opensandbox-store`
volume. Add `OI_SANDBOX_CPU_POOL=0-15` (or an explicit deployment-specific CPU list).
The wrapper refuses to create sandboxes if the pool is unset, contains unavailable
CPUs, or existing sandbox containers have no binding. Do not merely update live
containers or replace a frozen controller. All server replicas for one Docker
host must share this CPU pool, width and lease directory; unrelated sandbox
creators must not bypass this allocator. API CPU requests must be positive and
no larger than the configured width. Default width is two; changing it is a new
resource profile, not an in-place experiment change.

No host process isolation is enabled. The complete `0-15` pool can provide at most
eight two-vCPU sandboxes, but memory may impose a much smaller practical limit.
This allocator checks CPU capacity only; it is not a memory admission controller.

## Lifecycle and recovery

The host-wide file lock serializes reservation and Docker creation/start. Leases
are fsync'ed before creation. Successful allocations record immutable Docker IDs;
on subsequent allocations, only Docker's explicit 404 for an ID frees its CPUs.
Stopped containers retain their allocation, since they may resume. Existing pinned
sandbox containers are included even if their lease file is absent. Overlapping
bindings, configuration drift, daemon errors and corrupt state fail closed.

An exhausted pool returns HTTP 503 with code `OPENINSPECT_CPU_CAPACITY` at the
server's creation boundary. OpenSandbox's asynchronous create API may surface this
as a failed creation/status rather than a synchronous HTTP response. There is no
CPU wait queue, oversubscription or automatic increase in child count.

Ambiguous create/start failures (including process death) retain a pending lease.
This intentionally favors safety over automatic reclamation. Do not delete a
pending reservation just because one Docker listing is empty: a timed-out create
may still complete. Recovery requires stopping/draining the server and outstanding
operations, deleting/reconciling its sandbox containers and confirming no sandbox
containers remain, then archiving the lease directory before initializing a fresh
pool. Preserve the archive as failure evidence. Never reset leases while requests
or containers may still be active. A failure before confirmation can retain CPU
capacity even when upstream cleanup succeeded.

Verification:

```sh
python -m unittest discover -s packages/opensandbox-infra -p 'test_cpu_pool.py' -v
docker inspect --format '{{.HostConfig.CpusetCpus}}' SANDBOX_CONTAINER_ID
```

The stored lease IDs/CPU lists and Docker `HostConfig.CpusetCpus` provide allocation
evidence. This is vCPU exclusivity among managed sandboxes, not equal physical-core
performance. Kernel/daemon administrators can override cpusets; subsequent creates
validate observed sets and reject drift, but this is not protection against an
administrator modifying running containers.
