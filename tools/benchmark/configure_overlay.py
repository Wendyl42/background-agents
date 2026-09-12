"""Build-time setup for the benchmark-only, unprivileged model process."""

import pwd
from pathlib import Path

launcher = Path("/opt/oi-tools/opencode")
launcher.rename(launcher.with_name("opencode-native"))
launcher.write_text(
    '#!/bin/sh\nexec /opt/oi-runtime/bin/python3.12 -I -S /opt/oi-benchmark/launch_opencode.py "$@"\n'
)
launcher.chmod(0o755)
artifact = Path("/opt/oi-tools/oi-bench")
artifact.write_text(artifact.read_text().replace("python3.12 ", "python3.12 -I -S "))
Path("/opt/oi-runtime/lib/python3.12/site-packages").chmod(0o700)
Path("/opt/oi-runtime/lib/node_modules").chmod(0o700)
Path("/opt/oi-benchmark/task.json").chmod(0o444)
Path("/root").chmod(0o755)  # Some official task interpreters live under /root.
assert 10001 not in {entry.pw_uid for entry in pwd.getpwall()}, "Benchmark UID already allocated"
accounts = Path("/etc/passwd")
accounts.write_text(
    accounts.read_text() + "oiagent:x:10001:10001:Benchmark agent:/home/oi-agent:/bin/sh\n"
)
groups = Path("/etc/group")
groups.write_text(groups.read_text() + "oiagent:x:10001:\n")

interpreter = Path("/opt/oi-tools/python-runtime")
interpreter.write_text('#!/bin/sh\nexec /opt/oi-runtime/bin/python3.12 -I "$@"\n')
interpreter.chmod(0o755)
