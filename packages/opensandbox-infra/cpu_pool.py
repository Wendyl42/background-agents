"""Host-wide, fail-closed CPU leases for the local OpenSandbox Docker backend.

All participating servers must share the same persistent state directory and pool.
Container deletion (not stop) releases a confirmed lease on the next allocation.
"""
import fcntl
import functools
import inspect
import json
import os
from pathlib import Path
import re
from contextlib import contextmanager


class CpuPoolError(RuntimeError):
    pass


def parse_cpus(value):
    if not isinstance(value, str) or not value:
        raise CpuPoolError("CPU pool must be an explicit nonempty CPU list")
    cpus = set()
    for part in value.split(','):
        if not re.fullmatch(r'\d+(?:-\d+)?', part):
            raise CpuPoolError("Invalid CPU list")
        bounds = [int(x) for x in part.split('-')]
        start, end = bounds[0], bounds[-1]
        if end < start or end > 65535:
            raise CpuPoolError("Invalid CPU range")
        cpus.update(range(start, end + 1))
    return cpus


def _save(path, state):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(state, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class CpuPool:
    def __init__(self, directory, cpus, width=2):
        self.directory = Path(directory)
        self.cpus = parse_cpus(cpus)
        self.width = width
        if type(width) is not int or width <= 0 or width > len(self.cpus):
            raise CpuPoolError("Invalid CPUs per sandbox")
        if not self.cpus <= os.sched_getaffinity(0):
            raise CpuPoolError("CPU pool contains unavailable CPUs")

    @contextmanager
    def reserve(self, client, sandbox_id):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.directory / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = self.directory / 'leases.json'
            state = json.loads(path.read_text()) if path.exists() else {
                'version': 1, 'pool': sorted(self.cpus), 'width': self.width, 'leases': {}}
            if (state.get('version'), state.get('pool'), state.get('width')) != (
                1, sorted(self.cpus), self.width
            ):
                raise CpuPoolError("CPU pool configuration differs from persistent state")
            leases = state['leases']
            # Inspect individual known IDs: only an explicit Docker 404 frees CPUs.
            for key, lease in list(leases.items()):
                if lease.get('containerId'):
                    try:
                        client.containers.get(lease['containerId'])
                    except Exception as exc:
                        if getattr(exc, 'status_code', None) != 404:
                            raise
                        del leases[key]
            used = set()
            for lease in leases.values():
                assigned = set(lease['cpus'])
                if len(assigned) != self.width or not assigned <= self.cpus or used & assigned:
                    raise CpuPoolError("Invalid or overlapping CPU lease state")
                used.update(assigned)
            # Include stopped containers: they can resume. Reject legacy unpinned
            # sandboxes rather than pretending that a new allocation is exclusive.
            actual_used = set()
            for container in client.containers.list(all=True):
                attrs = container.attrs
                labels = attrs.get('Config', {}).get('Labels') or {}
                name = attrs.get('Name', '').lstrip('/')
                if not (name.startswith('sandbox-') or 'opensandbox.io/id' in labels):
                    continue
                cpuset = attrs.get('HostConfig', {}).get('CpusetCpus', '')
                if not cpuset:
                    raise CpuPoolError("Existing sandbox has no CPU binding; drain it before enabling CPU leases")
                assigned = parse_cpus(cpuset)
                if actual_used & assigned:
                    raise CpuPoolError("Existing sandbox CPU sets overlap")
                actual_used.update(assigned)
                owner = next((v for k, v in leases.items()
                              if v.get('containerId') == container.id or name == 'sandbox-' + k), None)
                if owner is not None and assigned != set(owner['cpus']):
                    raise CpuPoolError("Container CPU binding differs from its lease")
                if owner is None and assigned & used:
                    raise CpuPoolError("Untracked sandbox conflicts with a CPU lease")
            used.update(actual_used)
            if sandbox_id in leases:
                raise CpuPoolError("Sandbox already has a CPU lease; reconcile its original creation")
            available = sorted(self.cpus - used)
            if len(available) < self.width:
                raise CpuPoolError("Insufficient free vCPUs for another sandbox")
            lease = {'cpus': available[:self.width], 'containerId': None}
            leases[sandbox_id] = lease
            # Persist BEFORE any Docker create. An ambiguous create/start failure
            # retains the pending lease even when Docker currently lists nothing.
            _save(path, state)
            yield lease
            _save(path, state)


def bind_sandbox_cpus(method):
    """Wrap the upstream create/start boundary; pin before any user code starts."""
    signature = inspect.signature(method)

    @functools.wraps(method)
    def wrapped(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        service = bound.arguments['self']
        sandbox_id = bound.arguments['sandbox_id']
        config = dict(bound.arguments['host_config_kwargs'])
        try:
            pool = CpuPool(os.environ.get('OI_CPU_LEASE_DIR', '/var/lib/opensandbox/cpu-leases'),
                           os.environ.get('OI_SANDBOX_CPU_POOL', ''),
                           int(os.environ.get('OI_SANDBOX_CPU_WIDTH', '2')))
            if config.get('cpuset_cpus'):
                raise CpuPoolError("Caller-supplied CPU binding is not permitted")
            quota = config.get('nano_cpus')
            if quota is None or quota <= 0 or quota > pool.width * 1_000_000_000:
                raise CpuPoolError("CPU quota must be positive and no larger than the assigned CPU set")
            with pool.reserve(service.docker_client, sandbox_id) as lease:
                config['cpuset_cpus'] = ','.join(map(str, lease['cpus']))
                bound.arguments['host_config_kwargs'] = config
                container = method(*bound.args, **bound.kwargs)
                container.reload()
                actual = parse_cpus(container.attrs['HostConfig']['CpusetCpus'])
                if actual != set(lease['cpus']):
                    raise CpuPoolError("Docker did not apply the assigned CPU binding")
                lease['containerId'] = container.id
                return container
        except CpuPoolError as exc:
            from fastapi import HTTPException
            raise HTTPException(status_code=503, detail={
                'code': 'OPENINSPECT_CPU_CAPACITY', 'message': str(exc)}) from exc
    return wrapped
