#!/usr/bin/env python3
"""Verify the collaboration release offline. Never launches agents or executes task code."""
import argparse
import hashlib
import json
import sys
from pathlib import Path


def read(path): return json.loads(path.read_text())
def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): hasher.update(block)
    return hasher.hexdigest()
def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root): raise ValueError(f'Path escapes bundle: {relative}')
    return path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--list', action='store_true', help='List the 30 primary + 4 supplemental attempts')
    parser.add_argument('--resolve', help='Translate a pseudonymized historical absolute path')
    args = parser.parse_args(); root = args.root.resolve()
    if args.resolve:
        mappings = read(root / 'SOURCE_STATE.json')['originMappings']
        for origin, destination in sorted(mappings.items(), key=lambda x: -len(x[0])):
            if args.resolve == origin or args.resolve.startswith(origin + '/'):
                print(inside(root, destination + args.resolve[len(origin):])); return 0
        raise ValueError('Not a relocatable historical project path; use COHORTS.json for bundle paths')
    index = read(root / 'COHORTS.json')
    if args.list:
        for cohort in index['cohorts']:
            for item in cohort['attempts']:
                print(cohort['id'], item['attemptId'], item['taskId'], item['modelExecution'], item['trace'])
        return 0
    manifest = read(root / 'MANIFEST.json'); errors = []
    for item in manifest['files']:
        path = inside(root, item['path'])
        if not path.is_file() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            errors.append({'path': item['path'], 'error': 'missing or release hash/size mismatch'})
    listed = {item['path'] for item in manifest['files']}
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual != listed | {'MANIFEST.json'}:
        errors.append({'error': 'file set differs from manifest', 'extra': sorted(actual - listed - {'MANIFEST.json'}), 'missing': sorted(listed - actual)})
    expected_counts = {'primary-30': 30, 'supplement-4': 4}
    attempts = 0; original_files = read(root / 'ORIGINAL_FILE_HASHES.json'); changes = read(root / 'TRANSFORMATIONS.json')
    for item in manifest['files']:
        prior = original_files.get(item['path'])
        if prior and prior['sha256'] != item['sha256'] and item['path'] not in changes:
            errors.append({'path': item['path'], 'error': 'undeclared transformation'})
    for cohort in index['cohorts']:
        if len(cohort['attempts']) != expected_counts[cohort['id']]: errors.append({'cohort': cohort['id'], 'error': 'wrong count'})
        unique = set()
        for item in cohort['attempts']:
            if item['attemptId'] in unique: errors.append({'error': 'duplicate attempt', 'attempt': item['attemptId']})
            unique.add(item['attemptId']); attempts += 1
            directory = inside(root, item['attempt']); state = read(directory / 'attempt.json')
            if state['phase'] != 'done' or state['taskId'] != item['taskId']:
                errors.append({'attempt': item['attemptId'], 'error': 'identity/terminal state mismatch'})
            if state['rootSessionId'] != item['expectedRootSessionId'] or sorted(state['sessionTree']) != item['expectedSessionIds']:
                errors.append({'attempt': item['attemptId'], 'error': 'session identities changed'})
            for required in ['prompt.submitted.txt', 'prompt.appendix.txt', 'prompt-manifest.json', 'containers.json', 'protocol.json', 'artifact-coverage.json', 'cleanup.json']:
                if not (directory / required).is_file(): errors.append({'attempt': item['attemptId'], 'error': f'missing {required}'})
            if not list(directory.glob('prompt.original.*.txt')): errors.append({'attempt': item['attemptId'], 'error': 'original prompt missing'})
            trace = inside(root, item['trace'])
            for line in (trace / 'normalized/events.jsonl').open():
                event = json.loads(line)
                if event['sessionId'] not in item['expectedSessionIds'] or (event.get('messageId') and event['messageId'] not in item['expectedMessageIds']):
                    errors.append({'attempt': item['attemptId'], 'error': 'event identity outside original cohort'})
                    break
                if 'REDACTED_CREDENTIAL' in str(event.get('id', '')):
                    errors.append({'attempt': item['attemptId'], 'error': 'event ID damaged by sanitization'})
                    break
            for file in read(trace / 'hashes.json')['files']:
                path = inside(trace.resolve(), file['path'])
                if not path.is_file() or digest(path) != file['sha256'] or path.stat().st_size != file['bytes']:
                    errors.append({'attempt': item['attemptId'], 'error': 'public trace integrity failure', 'file': file['path']})
            # Artifact hashes remain historical IDs when a credential was redacted from the bytes.
            for metadata in (directory / 'artifacts').glob('*/*.json'):
                if metadata.name not in ['checkpoint.json', 'published.json']: continue
                value = read(metadata)
                patch = inside(metadata.parent.resolve(), value['file'])
                relative = patch.relative_to(root).as_posix()
                if not patch.exists() or original_files.get(relative, {}).get('sha256') != value['sha256']:
                    errors.append({'attempt': item['attemptId'], 'error': 'missing artifact or original hash link', 'file': relative})
            if not (inside(root, item['analysis']) / 'summary.json').is_file(): errors.append({'attempt': item['attemptId'], 'error': 'missing analysis'})
            context = inside(root, item['taskContext'])
            if not any((context / n).exists() for n in ['workspace.tar', 'agent-source.tar']):
                errors.append({'attempt': item['attemptId'], 'error': 'missing source context archive'})
        batch = read(inside(root, cohort['batchAnalysis']) / 'batch-manifest.json')
        if batch['successfulRunCount'] != cohort['count'] or batch['failureCount'] != 0:
            errors.append({'cohort': cohort['id'], 'error': 'batch analysis incomplete'})
    print(json.dumps({'verifiedFiles': len(manifest['files']), 'cohortAttempts': attempts, 'errors': errors,
                      'scope': 'Published bytes and declared provenance; private excluded originals cannot be verified from this public derivative.'}, indent=2))
    return 1 if errors else 0

if __name__ == '__main__':
    try: sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr); sys.exit(1)
