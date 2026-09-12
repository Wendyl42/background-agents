import importlib.util
import io
import json
import tarfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('release_builder', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def test_browser_secret_discovered_and_private_config_excluded(tmp_path, monkeypatch):
    checkout = tmp_path / 'checkout'
    (checkout / '.cache/opensandbox').mkdir(parents=True)
    lab = tmp_path / 'lab'
    config = lab / 'runs/test/control-plane/control-plane-env.json'
    config.parent.mkdir(parents=True)
    secret = '0123456789abcdef-browser-auth-secret-9876543210'
    config.write_text(json.dumps({'BROWSER_AUTH_SECRET': secret}))
    monkeypatch.setattr(build, 'ROOT', checkout)
    builder = build.Builder(lab, tmp_path / 'output')
    builder.collect_secrets()
    cleaned, rules = builder.sanitize(('logged ' + secret).encode())
    assert secret.encode() not in cleaned and rules['known_credential'] == 1
    assert builder.reason(Path('benchmark-lab/runs/test/control-plane/control-plane-env.json'))
    assert builder.reason(Path('benchmark-lab/runs/test/control-plane/seed-secrets.sql'))


def test_tar_drops_git_packs_and_relocates_internal_absolute_link(tmp_path):
    builder = build.Builder(tmp_path / 'lab', tmp_path / 'output')
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for name, data in [('./pandas/__init__.py', b'code'), ('./.git/objects/pack/a.pack', b'opaque-secret-data')]:
            item = tarfile.TarInfo(name); item.size = len(data); archive.addfile(item, io.BytesIO(data))
        item = tarfile.TarInfo('./build/cp311/pandas/__init__.py')
        item.type = tarfile.SYMTYPE; item.linkname = '/testbed/pandas/__init__.py'; archive.addfile(item)
        item = tarfile.TarInfo('./escape'); item.type = tarfile.SYMTYPE; item.linkname = '/etc/passwd'; archive.addfile(item)
    output, rules = builder.sanitize_tar(stream.getvalue(), Path('context.tar'))
    with tarfile.open(fileobj=io.BytesIO(output)) as archive:
        assert not any('.git' in Path(m.name).parts for m in archive.getmembers())
        assert './escape' not in archive.getnames()
        assert not archive.getmember('./build/cp311/pandas/__init__.py').linkname.startswith('/')
        assert archive.extractfile('./pandas/__init__.py').read() == b'code'
    assert not builder.scan_tar(output)
    assert rules['nested_git_metadata_omitted'] and rules['nested_absolute_link_made_relative']


def test_token_and_origin_redaction_keep_content_and_hash_ids(tmp_path):
    builder = build.Builder(tmp_path / 'lab', tmp_path / 'output')
    data = b'tokenSha256="' + b'a' * 64 + b'" api=ghp_' + b'Z' * 30 + b' keep this task evidence'
    cleaned, rules = builder.sanitize(data)
    assert b'a' * 64 in cleaned
    assert b'ghp_' not in cleaned
    assert b'keep this task evidence' in cleaned
    assert rules['github_token'] == 1


def test_pem_delimiter_code_and_sklearn_css_are_not_credentials(tmp_path):
    builder = build.Builder(tmp_path / 'lab', tmp_path / 'output')
    data = b'key.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", ""); .sk-estimator-param-doc-link'
    assert builder.sanitize(data)[0] == data
    actual = b'-----BEGIN PRIVATE KEY-----\n' + b'A' * 64 + b'\n-----END PRIVATE KEY-----'
    assert b'BEGIN PRIVATE KEY' not in builder.sanitize(actual)[0]


def test_runtime_only_token_in_escaped_tool_output_is_collected(tmp_path, monkeypatch):
    checkout = tmp_path / 'checkout'; (checkout / '.cache/opensandbox').mkdir(parents=True)
    lab = tmp_path / 'lab'; trace = lab / 'runs/r/trace/normalized/events.jsonl'; trace.parent.mkdir(parents=True)
    token = 'abcdef1234567890abcdef123456789012'
    trace.write_text(json.dumps({'data': {'output': 'SANDBOX_AUTH_TOKEN=' + token + '\n'}}) + '\n')
    monkeypatch.setattr(build, 'ROOT', checkout)
    builder = build.Builder(lab, tmp_path / 'output'); builder.collect_secrets()
    assert token.encode() in builder.secrets
    cleaned, _ = builder.sanitize(trace.read_bytes())
    assert token.encode() not in cleaned
    assert json.loads(cleaned)['data']['output'].startswith('SANDBOX_AUTH_TOKEN=[REDACTED_CREDENTIAL]')


def test_event_token_ids_are_not_auth_credentials(tmp_path, monkeypatch):
    checkout = tmp_path / 'checkout'; (checkout / '.cache/opensandbox').mkdir(parents=True)
    lab = tmp_path / 'lab'; trace = lab / 'runs/r/events.jsonl'; trace.parent.mkdir(parents=True)
    message_id = '1234567890abcdef1234567890abcdef'
    trace.write_text(json.dumps({'id': 'token:' + message_id, 'messageId': message_id, 'type': 'token'}) + '\n')
    monkeypatch.setattr(build, 'ROOT', checkout)
    builder = build.Builder(lab, tmp_path / 'output'); builder.collect_secrets()
    assert message_id.encode() not in builder.secrets
    assert builder.sanitize(trace.read_bytes())[0] == trace.read_bytes()
