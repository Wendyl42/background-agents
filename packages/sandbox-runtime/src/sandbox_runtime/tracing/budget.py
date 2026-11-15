"""Bound pending files with exclusive slots; delivered files release their slots."""

import json
import os
from pathlib import Path


def reserve(directory, name, limit):
    if os.environ.get("OI_EXECUTION_TRACE_MANAGED") != "1":
        return
    leases = directory / "leases"
    leases.mkdir(exist_ok=True, mode=0o700)
    for slot in range(limit):
        try:
            fd = os.open(
                leases / str(slot), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
        except FileExistsError:
            continue
        with os.fdopen(fd, "w") as stream:
            stream.write(name)
        return
    try:
        with (Path(directory) / "overflow.json").open("x") as stream:
            json.dump({"reason": "pending_stream_limit"}, stream)
    except FileExistsError:
        pass
    raise RuntimeError("Execution trace pending-stream budget exhausted")
