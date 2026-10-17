"""No model/network calls; test only explicitly labelled disposable containers."""
import json
import os
import tempfile
import uuid
import types
import docker
from fastapi import HTTPException
from oi_cpu_pool import bind_sandbox_cpus, parse_cpus

real = docker.from_env()
token = uuid.uuid4().hex
label = 'openinspect.cpu-pool-smoke'
image = os.environ['SMOKE_IMAGE_ID']
cpus = sorted(os.sched_getaffinity(0))[:4]
assert len(cpus) == 4
created = []

class ScopedContainers:
    def list(self, all=True):
        return real.containers.list(all=all, filters={'label': label + '=' + token})
    def get(self, cid):
        return real.containers.get(cid)

class Service:
    docker_client = types.SimpleNamespace(containers=ScopedContainers())
    @bind_sandbox_cpus
    def create(self, sandbox_id, host_config_kwargs):
        container = real.containers.create(image, name='sandbox-' + sandbox_id,
            entrypoint=['python', '-c'], command=['import time; time.sleep(120)'],
            network_mode='none', labels={label: token}, **host_config_kwargs)
        created.append(container)
        container.start()
        return container

try:
    with tempfile.TemporaryDirectory() as directory:
        os.environ['OI_SANDBOX_CPU_POOL'] = ','.join(map(str, cpus))
        os.environ['OI_CPU_LEASE_DIR'] = directory
        service = Service()
        a = service.create(token + '-a', {'nano_cpus': 2_000_000_000})
        b = service.create(token + '-b', {'nano_cpus': 2_000_000_000})
        ca = parse_cpus(a.attrs['HostConfig']['CpusetCpus'])
        cb = parse_cpus(b.attrs['HostConfig']['CpusetCpus'])
        assert not ca & cb and len(ca) == len(cb) == 2
        for container, expected in [(a, ca), (b, cb)]:
            code, output = container.exec_run(['python', '-c', 'import os,json;print(json.dumps(sorted(os.sched_getaffinity(0))))'])
            assert code == 0 and set(json.loads(output)) == expected
        try:
            service.create(token + '-exhausted', {'nano_cpus': 2_000_000_000})
            raise AssertionError('must refuse third sandbox')
        except HTTPException as exc:
            assert exc.status_code == 503
        a.remove(force=True)
        c = service.create(token + '-c', {'nano_cpus': 2_000_000_000})
        assert parse_cpus(c.attrs['HostConfig']['CpusetCpus']) == ca
        print(json.dumps({'first': sorted(ca), 'second': sorted(cb),
                          'exhaustionRejected': True, 'reusedAfterDeletion': True,
                          'effectiveAffinityVerified': True}))
finally:
    for container in real.containers.list(all=True, filters={'label': label + '=' + token}):
        container.remove(force=True)
    assert not real.containers.list(all=True, filters={'label': label + '=' + token})
