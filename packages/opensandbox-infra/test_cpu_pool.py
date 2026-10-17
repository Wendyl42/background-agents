import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from cpu_pool import CpuPool, CpuPoolError, bind_sandbox_cpus, parse_cpus
from patch_cpu_pool import patch as patch_source


class Missing(Exception):
    status_code = 404


class Container:
    def __init__(self, name, cpus, cid=None):
        self.id = cid or name
        self.attrs = {'Name': '/sandbox-' + name, 'HostConfig': {'CpusetCpus': cpus}}
    def reload(self):
        pass


class Containers:
    def __init__(self, items=()):
        self.items = {x.id: x for x in items}
    def list(self, all=False):
        assert all
        return list(self.items.values())
    def get(self, cid):
        if cid not in self.items:
            raise Missing()
        return self.items[cid]


def client(items=()):
    return types.SimpleNamespace(containers=Containers(items))


def contender(directory, cpus, number, output):
    try:
        with CpuPool(directory, cpus).reserve(client(), str(number)) as lease:
            output.put(lease['cpus'])
    except CpuPoolError:
        output.put(None)


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cpus = sorted(os.sched_getaffinity(0))[:4]
        if len(self.cpus) != 4:
            self.skipTest('requires four allowed vCPUs')
        self.cpu_text = ','.join(map(str, self.cpus))
        self.pool = CpuPool(self.tmp.name, self.cpu_text)

    def test_parse_and_invalid_config(self):
        self.assertEqual(parse_cpus('0-2,5'), {0, 1, 2, 5})
        for value in ['', '-1', '2-1', '0,', 'a', '0-999999999']:
            with self.assertRaises(CpuPoolError):
                parse_cpus(value)
        with self.assertRaises(CpuPoolError):
            CpuPool(self.tmp.name, '65535')

    def test_disjoint_exhaustion_and_confirmed_deletion(self):
        docker = client()
        for name in ['a', 'b']:
            with self.pool.reserve(docker, name) as lease:
                obj = Container(name, ','.join(map(str, lease['cpus'])))
                docker.containers.items[obj.id] = obj
                lease['containerId'] = obj.id
        with self.assertRaises(CpuPoolError):
            with self.pool.reserve(docker, 'c'):
                self.fail('overallocated')
        del docker.containers.items['a']
        with self.pool.reserve(docker, 'c') as lease:
            self.assertEqual(lease['cpus'], self.cpus[:2])

    def test_pending_failure_survives_restart(self):
        with self.assertRaises(TimeoutError):
            with self.pool.reserve(client(), 'a'):
                raise TimeoutError('ambiguous Docker create')
        restarted = CpuPool(self.tmp.name, self.cpu_text)
        with restarted.reserve(client(), 'b') as lease:
            self.assertEqual(lease['cpus'], self.cpus[2:])
        with self.assertRaises(CpuPoolError):
            with restarted.reserve(client(), 'a'):
                pass

    def test_legacy_and_stopped_containers_block_reuse(self):
        with self.assertRaises(CpuPoolError):
            with self.pool.reserve(client([Container('legacy', '')]), 'a'):
                pass
        existing = Container('stopped', ','.join(map(str, self.cpus[:2])))
        with self.pool.reserve(client([existing]), 'a') as lease:
            self.assertEqual(lease['cpus'], self.cpus[2:])

    def test_daemon_error_does_not_release(self):
        with self.pool.reserve(client(), 'a') as lease:
            lease['containerId'] = 'known'
        docker = client()
        docker.containers.get = lambda _: (_ for _ in ()).throw(ConnectionError())
        with self.assertRaises(ConnectionError):
            with self.pool.reserve(docker, 'b'):
                pass
        saved = json.loads((Path(self.tmp.name) / 'leases.json').read_text())
        self.assertIn('a', saved['leases'])

    def test_config_change_and_corrupt_state_fail_closed(self):
        with self.pool.reserve(client(), 'a'):
            pass
        with self.assertRaises(CpuPoolError):
            with CpuPool(self.tmp.name, self.cpu_text, 1).reserve(client(), 'b'):
                pass
        (Path(self.tmp.name) / 'leases.json').write_text('{')
        with self.assertRaises(ValueError):
            with self.pool.reserve(client(), 'b'):
                pass

    def test_cross_process_allocation(self):
        ctx = multiprocessing.get_context('fork')
        output = ctx.Queue()
        processes = [ctx.Process(target=contender, args=(self.tmp.name, self.cpu_text, i, output)) for i in range(6)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(10)
            self.assertEqual(process.exitcode, 0)
        assigned = [output.get(timeout=2) for _ in processes]
        successes = [x for x in assigned if x is not None]
        self.assertEqual(len(successes), 2)
        self.assertFalse(set(successes[0]) & set(successes[1]))

    def test_wrapper_binds_before_start_and_verifies(self):
        class Service:
            docker_client = client()
            @bind_sandbox_cpus
            def create(self, sandbox_id, host_config_kwargs):
                self.seen = host_config_kwargs
                obj = Container(sandbox_id, host_config_kwargs['cpuset_cpus'])
                self.docker_client.containers.items[obj.id] = obj
                return obj
        service = Service()
        with patch.dict(os.environ, {'OI_SANDBOX_CPU_POOL': self.cpu_text,
                                     'OI_CPU_LEASE_DIR': self.tmp.name}):
            service.create('a', {'nano_cpus': 2_000_000_000})
        self.assertEqual(parse_cpus(service.seen['cpuset_cpus']), set(self.cpus[:2]))
        saved = json.loads((Path(self.tmp.name) / 'leases.json').read_text())
        self.assertEqual(saved['leases']['a']['containerId'], 'a')

    def test_overlapping_existing_bindings_rejected(self):
        cpus = ','.join(map(str, self.cpus[:2]))
        with self.assertRaises(CpuPoolError):
            with self.pool.reserve(client([Container('a', cpus), Container('b', cpus)]), 'c'):
                pass

    def test_tracked_container_drift_rejected(self):
        with self.pool.reserve(client(), 'a') as lease:
            lease['containerId'] = 'a'
        moved = Container('a', ','.join(map(str, self.cpus[2:])))
        with self.assertRaises(CpuPoolError):
            with self.pool.reserve(client([moved]), 'b'):
                pass

    def test_delayed_create_cannot_reclaim_pending_cpus(self):
        with self.assertRaises(TimeoutError):
            with self.pool.reserve(client(), 'a'):
                raise TimeoutError()
        late = Container('a', ','.join(map(str, self.cpus[:2])))
        with self.pool.reserve(client([late]), 'b') as lease:
            self.assertEqual(lease['cpus'], self.cpus[2:])

    def test_patcher_provenance_and_rejects_reapplication(self):
        root = Path(self.tmp.name)
        directory = root / 'opensandbox_server/services/docker'
        directory.mkdir(parents=True)
        (root / 'oi_cpu_pool.py').write_text('# allocator')
        source = directory / 'container_ops.py'
        source.write_text('class Mixin:\n    def _create_and_start_container(\n'
                          '        self, sandbox_id, image_uri, bootstrap_command, labels, environment, host_config_kwargs, exposed_ports, platform\n'
                          '    ):\n        return self.docker_client.api.create_host_config(**host_config_kwargs)\n')
        patch_source(root)
        record = json.loads((root / 'openinspect-cpu-pool-provenance.json').read_text())
        self.assertNotEqual(record['originalSha256'], record['adaptedSha256'])
        with self.assertRaises(RuntimeError):
            patch_source(root)


if __name__ == '__main__':
    unittest.main()
