"""Guarded image-only integration; never rewrite the upstream checkout."""
import ast
import hashlib
import json
from pathlib import Path
import sys


def patch(root):
    root = Path(root)
    candidates = list((root / 'opensandbox_server/services/docker').glob('*.py'))
    matches = []
    for path in candidates:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == '_create_and_start_container':
                matches.append((path, node))
    if len(matches) != 1:
        raise RuntimeError('Unsupported OpenSandbox create/start boundary')
    path, node = matches[0]
    expected = ['self', 'sandbox_id', 'image_uri', 'bootstrap_command', 'labels',
                'environment', 'host_config_kwargs', 'exposed_ports', 'platform']
    if [arg.arg for arg in node.args.args] != expected or node.decorator_list:
        raise RuntimeError('Unsupported OpenSandbox create/start signature')
    original = path.read_bytes()
    source = original.decode()
    marker = '    def _create_and_start_container(\n'
    if source.count(marker) != 1 or 'create_host_config(**host_config_kwargs)' not in ast.get_source_segment(source, node):
        raise RuntimeError('Recheck upstream Docker host configuration')
    source = source.replace(marker, '    @__import__("oi_cpu_pool").bind_sandbox_cpus\n' + marker)
    ast.parse(source)
    path.write_text(source)
    manifest = {'sourcePath': str(path.relative_to(root)),
                'originalSha256': hashlib.sha256(original).hexdigest(),
                'adaptedSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'allocatorSha256': hashlib.sha256((root / 'oi_cpu_pool.py').read_bytes()).hexdigest()}
    (root / 'openinspect-cpu-pool-provenance.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    patch(sys.argv[1])
