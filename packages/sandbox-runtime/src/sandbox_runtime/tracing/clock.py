"""Private local clock calibration peer; stdin requests, monotonic-ns replies."""

import json
import sys
import time
from pathlib import Path


def main() -> None:
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    namespace = str(Path("/proc/self/ns/time").readlink())
    print(
        json.dumps(
            {
                "clock_id": f"{boot}:{namespace}:monotonic",
                "host_boot_id": boot,
                "time_namespace": namespace,
            }
        ),
        flush=True,
    )
    for _line in sys.stdin:
        print(time.monotonic_ns(), flush=True)


if __name__ == "__main__":
    main()
