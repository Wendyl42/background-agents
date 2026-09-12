#!/usr/bin/env python3
"""Build a credential-free collaboration derivative without modifying experiment evidence."""
import argparse
import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import socket
import subprocess
import tarfile
import time
import zlib
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRIMARY = 'acceptance-30-001-behavior-v3'
SUPPLEMENT = 'fault-supplement-20260911-001'
COHORT_RUNS = ['acceptance-30-001', 'acceptance-30-001-behavior-v2', PRIMARY, SUPPLEMENT]
SECRET_KEY = re.compile(r'(?:api[_-]?key|exportServiceSecret|accessToken(?:Encrypted)?|refreshToken(?:Encrypted)?|private[_-]?key|password|signing[_-]?secret|SERVICE_AUTH_SECRET.*|TOKEN_ENCRYPTION_KEY|REPO_SECRETS_ENCRYPTION_KEY|IMAGE_CALLBACK_TOKEN_PEPPER|OPENSANDBOX_API_KEY|DEEPSEEK_API_KEY|.*(?:secret|password|token|apikey|api_key|privatekey|private_key|encryption_key|pepper)(?:Encrypted)?)', re.I)
TOKEN_PATTERNS = [
    ('github_token', re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b')),
    ('provider_key', re.compile(rb'\bsk-(?:(?:proj|ant)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})\b')),
    ('private_key', re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[ \t]*(?:\r?\n|\\n)(?:[A-Za-z0-9+/= \t\r\n]|\\n|\\r)+-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----', re.S)),
]
PRIVATE_NAMES = {'connection.json', 'trace-connection.json', 'sandbox-env.json', '.dev.vars', '.env', 'terraform.tfstate', 'terraform.tfstate.backup', 'hosts.yml', 'control-plane-env.json', 'seed-secrets.sql'}
CACHE_PARTS = {'.git', '__pycache__', '.pytest_cache', '.ruff_cache', 'node_modules', '.wrangler', 'control-plane-state', 'sqlite-inspection'}
CREDENTIAL_ASSIGNMENT = re.compile(
    rb'''(?<![A-Za-z0-9_])(?:[A-Za-z][A-Za-z0-9_]{0,100}(?:API_KEY|SECRET|TOKEN)|apiKey|accessToken|refreshToken|exportServiceSecret|API_KEY|AUTH_TOKEN)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?([A-Za-z0-9_+/=.\-]{24,})''', re.I
)
BEARER_ASSIGNMENT = re.compile(
    rb'''Authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?(?:Bearer|Basic)\s+([A-Za-z0-9_+/=.\-]{16,})''', re.I
)

def sha(data): return hashlib.sha256(data).hexdigest()
def read(path): return json.loads(Path(path).read_text())
def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

class Builder:
    def __init__(self, lab, output):
        self.lab, self.output = lab, output
        self.bundle = output / 'benchmark-collaboration-20260911'
        self.bundle.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.secrets, self.excluded, self.changes, self.originals = set(), [], {}, {}
        self.origins = [(str(ROOT.parent).encode(), b'/ORIGINAL_PROJECT_PARENT'),
                        (str(Path.home()).encode(), b'/ORIGINAL_HOME')]
        self.files_copied = 0
        self.processed = {}
        self.nested_members = {}
        self.origins.append((socket.gethostname().encode(), b'EXPERIMENT_HOST'))

    def collect_secrets(self):
        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if SECRET_KEY.fullmatch(key) and isinstance(item, str) and len(item) >= 16:
                        self.secrets.add(item.encode())
                    walk(item)
            elif isinstance(value, list):
                for item in value: walk(item)
        candidates = list((ROOT / '.cache/opensandbox').glob('*.json'))
        candidates += [p for p in (self.lab / 'runs').rglob('*') if p.is_file() and (p.name in PRIVATE_NAMES or p.name.endswith('.dev.vars') or p.name.startswith('.env.'))]
        for path in candidates:
            try:
                data = path.read_text()
                try: walk(json.loads(data))
                except ValueError:
                    for line in data.splitlines():
                        key, sep, value = line.partition('=')
                        value = value.strip().strip('"\'')
                        if sep and SECRET_KEY.fullmatch(key.strip()) and len(value) >= 16:
                            self.secrets.add(value.encode())
            except (UnicodeError, OSError): pass
        # Per-sandbox tokens may exist only in captured tool output, never in a global config.
        for path in (self.lab / 'runs').rglob('*'):
            if path.is_file() and path.suffix in {'.json', '.jsonl', '.log', '.txt'}:
                data = path.read_bytes()
                for match in CREDENTIAL_ASSIGNMENT.finditer(data):
                    value = match.group(1)
                    # Runtime auth tokens here are hex; reject code expressions/long identifiers.
                    if re.fullmatch(rb'[0-9a-fA-F]{32,}', value) or value.startswith((b'eyJ', b'gh', b'sk-')):
                        self.secrets.add(value)
                self.secrets.update(match.group(1) for match in BEARER_ASSIGNMENT.finditer(data))
        # Short/reused placeholder strings are not credentials. Never print the values.
        self.secrets = {x for x in self.secrets if not x.startswith((b'${', b'<', b'process.env', b'os.environ'))}
        for value in list(self.secrets):
            try: self.secrets.add(json.dumps(value.decode())[1:-1].encode())
            except UnicodeError: pass

    def sanitize(self, data):
        rules = Counter()
        for secret in sorted(self.secrets, key=len, reverse=True):
            if secret in data:
                rules['known_credential'] += data.count(secret)
                data = data.replace(secret, b'[REDACTED_CREDENTIAL]')
        for name, pattern in TOKEN_PATTERNS:
            data, count = pattern.subn(b'[REDACTED_CREDENTIAL]', data)
            rules[name] += count
        for origin, replacement in self.origins:
            if origin in data:
                rules['origin_path_pseudonymized'] += data.count(origin)
                data = data.replace(origin, replacement)
        return data, +rules

    def reason(self, relative):
        if any(part in CACHE_PARTS for part in relative.parts): return 'VCS/compiled cache or private control-plane database directory; source snapshots/API exports supplied separately'
        if relative.name in PRIVATE_NAMES or (relative.name.startswith('.env.') and relative.name not in {'.env.example', '.env.sample', '.env.template'}) or relative.name.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.pem', '.key', '.pyc')):
            return 'Runtime credential, private database, key, or compiled cache; not an analysis input'
        if relative.name.endswith('.lock') and relative.name not in {'uv.lock', 'poetry.lock', 'package-lock.json'}:
            return 'Process coordination lock; historical ownership records remain in audits where available'
        return None

    def copy_file(self, source, relative):
        reason = self.reason(relative)
        if reason:
            self.excluded.append({'path': relative.as_posix(), 'reason': reason, 'sourceSha256': sha(source.read_bytes())})
            return
        if source.is_symlink():
            # Materialize internal file symlinks; never dereference an external host file.
            resolved = source.resolve()
            if not (resolved.is_relative_to(ROOT) or resolved.is_relative_to(self.lab)) or resolved.is_relative_to(ROOT / '.cache') or resolved.is_relative_to(self.lab / 'cache'):
                self.excluded.append({'path': relative.as_posix(), 'reason': 'External host symlink'})
                return
        data = source.read_bytes()
        original_sha = sha(data)
        if original_sha in self.processed:
            previous, rules = self.processed[original_sha]
            data = previous.read_bytes()
        elif source.suffix == '.tar':
            data, rules = self.sanitize_tar(data, relative)
        else:
            data, rules = self.sanitize(data)
        target = self.bundle / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)
        self.originals[relative.as_posix()] = {'sha256': original_sha, 'bytes': source.stat().st_size}
        if rules:
            self.changes[relative.as_posix()] = {'rules': dict(rules), 'originalSha256': original_sha, 'releaseSha256': sha(data)}
        self.processed[original_sha] = target, rules
        self.files_copied += 1

    def safe_link(self, member, names):
        link = member.linkname
        parent = posixpath.dirname(member.name)
        if link.startswith('/'):
            for prefix in ['/testbed/', '/workspace/repo/', '/workspace/']:
                if link.startswith(prefix) and link[len(prefix):] in names:
                    return posixpath.relpath(link[len(prefix):], parent or '.')
            return None
        resolved = posixpath.normpath(posixpath.join(parent, link) if member.issym() else link)
        if resolved == '..' or resolved.startswith('../') or '.git' in Path(resolved).parts:
            return None
        return link

    def sanitize_tar(self, data, relative):
        rules = Counter(); inventory = []; output = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            members = archive.getmembers()
            names = {posixpath.normpath(m.name) for m in members}
            with tarfile.open(fileobj=output, mode='w') as result:
                for member in members:
                    name = Path(member.name)
                    if name.is_absolute() or '..' in name.parts:
                        raise ValueError(f'Unsafe nested archive member in {relative}')
                    if '.git' in name.parts:
                        rules['nested_git_metadata_omitted'] += 1
                        continue
                    entry = {'name': member.name, 'type': member.type.decode('ascii')}
                    if member.isfile():
                        contents = archive.extractfile(member).read()
                        cleaned, findings = self.sanitize(contents)
                        entry.update(originalSha256=sha(contents), releaseSha256=sha(cleaned), bytes=len(cleaned))
                        rules.update(findings)
                        member.size = len(cleaned)
                        result.addfile(member, io.BytesIO(cleaned))
                    elif member.issym() or member.islnk():
                        target = self.safe_link(member, names)
                        if target is None:
                            self.excluded.append({'path': relative.as_posix() + '!' + member.name,
                                                  'reason': 'Nested external/escaping runtime link omitted'})
                            rules['nested_external_link_omitted'] += 1
                            continue
                        if target != member.linkname:
                            rules['nested_absolute_link_made_relative'] += 1
                        member.linkname = target
                        entry['linkname'] = target
                        result.addfile(member)
                    elif member.isdir():
                        result.addfile(member)
                    else:
                        self.excluded.append({'path': relative.as_posix() + '!' + member.name,
                                              'reason': 'Nested device/special file omitted'})
                        rules['nested_special_file_omitted'] += 1
                        continue
                    inventory.append(entry)
        self.nested_members[sha(data)] = inventory
        rules['nested_archive_repacked'] += 1
        return output.getvalue(), rules

    def scan_tar(self, data):
        rules = Counter()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            members = archive.getmembers(); names = {posixpath.normpath(m.name) for m in members}
            for member in members:
                if '.git' in Path(member.name).parts: rules['unexpected_git_metadata'] += 1
                if member.issym() or member.islnk():
                    if member.linkname.startswith('/') or self.safe_link(member, names) is None:
                        rules['unsafe_archive_link'] += 1
                if member.isfile():
                    _, findings = self.sanitize(archive.extractfile(member).read())
                    rules.update(findings)
        return rules

    def add_tree(self, source, destination):
        for path in sorted(source.rglob('*')):
            if path.is_file(): self.copy_file(path, destination / path.relative_to(source))

    def repair_trace_hashes(self):
        for path in self.bundle.rglob('hashes.json'):
            if not (path.parent / 'manifest.json').exists(): continue
            value = read(path)
            if value.get('algorithm') != 'sha256' or not isinstance(value.get('files'), list): continue
            changed = False
            for item in value['files']:
                file = path.parent / item['path']
                if not file.is_file(): raise ValueError(f'Missing trace member: {file}')
                payload = file.read_bytes()
                if item['sha256'] != sha(payload) or item['bytes'] != len(payload):
                    item['sha256'], item['bytes'] = sha(payload), len(payload); changed = True
            if changed:
                write(path, value)
                rel = path.relative_to(self.bundle).as_posix()
                self.changes[rel] = {'rules': {'trace_integrity_recomputed_for_public_derivative': 1},
                                     'originalSha256': self.originals[rel]['sha256'], 'releaseSha256': sha(path.read_bytes())}

    def index(self):
        cohorts = []
        for name, label in [(PRIMARY, 'primary-30'), (SUPPLEMENT, 'supplement-4')]:
            original = self.lab / 'runs' / name
            report = read(original / 'report.json'); rows = []
            for state in report['attempts']:
                attempt = Path(state.get('evidencePath', self.lab / 'runs' / state['runId'] / 'attempts' / state['attemptId']))
                relative = lambda p: (Path('benchmark-lab') / Path(p).relative_to(self.lab)).as_posix()
                prepared = self.lab / 'task-workspaces' / state['taskId']
                rows.append({'attemptId': state['attemptId'], 'taskId': state['taskId'],
                    'expectedRootSessionId': state['rootSessionId'],
                    'expectedSessionIds': sorted(state['sessionTree']),
                    'expectedMessageIds': sorted(m['messageId'] for s in read(Path(state['analysis']['path']) / 'summary.json')['lifecycle']['sessions'] for m in s['messages']),
                    'modelExecution': state['modelExecution'], 'machineProtocol': state['childProtocol'],
                    'scoring': state['benchmarkCorrectness']['status'],
                    'attempt': relative(attempt), 'trace': relative(Path(state['trace']['path'])),
                    'analysis': relative(Path(state['analysis']['path'])), 'taskContext': relative(prepared),
                    'config': f'benchmark-lab/runs/{state["runId"]}/config.json',
                    'retryOf': state.get('retryOf', {}).get('attemptId')})
            cohorts.append({'id': label, 'runId': name, 'count': len(rows), 'attempts': rows,
                            'batchAnalysis': f'benchmark-lab/runs/{name}/trace-batch-001/analysis'})
        write(self.bundle / 'COHORTS.json', {'cohorts': cohorts,
              'policy': 'Primary 30 and four preselected supplements are separate. Do not replace original failures or pool as 34 independent tasks.'})

    def build(self):
        self.collect_secrets()
        print('Collected private credential patterns in memory; assembling public derivative', flush=True)
        # All run history is retained, with private runtime stores and generated caches excluded.
        self.add_tree(self.lab / 'runs', Path('benchmark-lab/runs'))
        print('Run evidence copied', self.files_copied, flush=True)
        for name in ['task-workspaces', 'sources', 'datasets']:
            self.add_tree(self.lab / name, Path('benchmark-lab') / name)
            print('Context copied:', name, flush=True)
        names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
        for name in sorted(set(names) - {''}):
            path = ROOT / name
            if path.is_file(): self.copy_file(path, Path('background-agents') / name)
        self.repair_trace_hashes()
        self.index()
        write(self.bundle / 'ORIGINAL_FILE_HASHES.json', self.originals)
        write(self.bundle / 'TRANSFORMATIONS.json', self.changes)
        write(self.bundle / 'EXCLUSIONS.json', self.excluded)
        write(self.bundle / 'NESTED_ARCHIVE_MEMBERS.json', self.nested_members)
        write(self.bundle / 'SOURCE_STATE.json', {
            'baseCommit': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'snapshot': 'background-agents contains the actual working tree, including uncommitted benchmark implementation and reports. GitHub tag source alone does not include these changes.',
            'imagesIncluded': False, 'cacheIncluded': False,
            'originMappings': {'/ORIGINAL_PROJECT_PARENT/background-agents': 'background-agents',
                               '/ORIGINAL_PROJECT_PARENT/benchmark-lab': 'benchmark-lab'},
            'privacy': 'Live credentials/private runtime databases excluded. Credential values and author home prefixes sanitized where detected. Original local evidence untouched.',
            'redactedFileCount': len(self.changes), 'excludedFileCount': len(self.excluded)})
        # A final scan never logs matched credential values.
        failures = []
        for path in self.bundle.rglob('*'):
            if not path.is_file(): continue
            data = path.read_bytes()
            if path.suffix == '.tar':
                rules = self.scan_tar(data)
            else: _, rules = self.sanitize(data)
            if rules: failures.append({'path': path.relative_to(self.bundle).as_posix(), 'rules': dict(rules)})
        write(self.output / 'private-final-scan.json', {'findings': failures})
        if failures: raise ValueError(f'Final credential/origin scan has {len(failures)} findings; see private-final-scan.json')
        print(json.dumps({'bundle': str(self.bundle), 'files': self.files_copied,
                          'transformedFiles': len(self.changes), 'excludedFiles': len(self.excluded), 'finalScanFindings': 0}), flush=True)

if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lab-root', type=Path, default=ROOT.parent / 'benchmark-lab')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    Builder(args.lab_root.resolve(), args.out.resolve()).build()
