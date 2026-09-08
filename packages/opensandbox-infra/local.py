#!/usr/bin/env python3
"""Build and run a single-host OpenSandbox research deployment (Docker required)."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = Path(__file__).resolve().parent
STATE = ROOT / ".cache" / "opensandbox"
SERVER_NAME = "oi-opensandbox-server"
SERVER_IMAGE = "openinspect-opensandbox-server:local"
RUNTIME_IMAGE = "openinspect-runtime:opensandbox"
SERVER_PORT = 8090
START_TIMEOUT_SECONDS = 60
EXECD_IMAGE = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd:v1.1.0"


def run(*args: str) -> None:
    subprocess.run(args, check=True)


def settings() -> dict[str, str]:
    return json.loads((STATE / "connection.json").read_text())


def initialize() -> None:
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    connection = STATE / "connection.json"
    if not connection.exists():
        with open(connection, "x", opener=lambda p, f: os.open(p, f, 0o600)) as f:
            json.dump(
                {
                    "api_url": f"http://127.0.0.1:{SERVER_PORT}",
                    "api_key": secrets.token_hex(32),
                    "image": RUNTIME_IMAGE,
                },
                f,
            )
    config = STATE / "server.toml"
    config_text = f'''[server]
host = "127.0.0.1"
port = {SERVER_PORT}
api_key = "{settings()["api_key"]}"

[runtime]
type = "docker"
execd_image = "{EXECD_IMAGE}"

[docker]
network_mode = "bridge"
host_ip = "127.0.0.1"
pids_limit = 4096
no_new_privileges = true
drop_capabilities = ["AUDIT_WRITE", "MKNOD", "NET_ADMIN", "NET_RAW", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_TIME", "SYS_TTY_CONFIG"]

[store]
type = "sqlite"
path = "/var/lib/opensandbox/opensandbox.db"

[ingress]
mode = "direct"
'''
    with open(config, "w", opener=lambda p, f: os.open(p, f, 0o600)) as f:
        f.write(config_text)
    config.chmod(0o600)


def down() -> None:
    """Delete managed sandboxes before stopping their expiration timers."""
    connection = settings()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    query = urllib.parse.urlencode(
        {"metadata": "openinspect_framework=open-inspect", "pageSize": 200}
    )
    headers = {"OPEN-SANDBOX-API-KEY": connection["api_key"]}
    while True:
        request = urllib.request.Request(
            connection["api_url"] + "/v1/sandboxes?" + query, headers=headers
        )
        try:
            with opener.open(request, timeout=10) as response:
                items = json.load(response)["items"]
        except urllib.error.HTTPError:
            raise
        except (OSError, ValueError):
            # The server may already be down. Limit fallback to our labelled containers.
            ids = subprocess.check_output(
                ["docker", "ps", "-aq", "--filter", "label=openinspect_framework=open-inspect"],
                text=True,
            ).split()
            if ids:
                run("docker", "rm", "-f", *ids)
            break
        if not items:
            break
        for item in items:
            if item.get("metadata", {}).get("openinspect_framework") != "open-inspect":
                raise RuntimeError("Server returned a sandbox outside this deployment's ownership")
            request = urllib.request.Request(
                connection["api_url"] + "/v1/sandboxes/" + urllib.parse.quote(item["id"], safe=""),
                headers=headers,
                method="DELETE",
            )
            try:
                with opener.open(request, timeout=30):
                    pass
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
    servers = subprocess.check_output(
        ["docker", "ps", "-aq", "--filter", f"name=^{SERVER_NAME}$"], text=True
    ).split()
    if servers:
        run("docker", "rm", "-f", *servers)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["init", "build", "up", "down", "status"])
    parser.add_argument("--source", type=Path, default=ROOT.parent / "OpenSandbox")
    parser.add_argument("--python-image", default="python:3.12-slim-bookworm")
    parser.add_argument("--node-image", default="node:22-bookworm-slim")
    parser.add_argument("--debian-mirror", default="https://deb.debian.org")
    parser.add_argument("--build-network", default="default")
    args = parser.parse_args()
    if args.command == "init":
        initialize()
        print(f"Private connection settings: {STATE / 'connection.json'}")
    elif args.command == "build":
        cmd = [
            "docker",
            "build",
            "--network",
            args.build_network,
            "-t",
            RUNTIME_IMAGE,
            "-f",
            str(PACKAGE / "Dockerfile"),
            "--build-arg",
            f"PYTHON_IMAGE={args.python_image}",
            "--build-arg",
            f"NODE_IMAGE={args.node_image}",
            "--build-arg",
            f"DEBIAN_MIRROR={args.debian_mirror}",
        ]
        # Docker's predefined proxy arguments are not persisted in the resulting image.
        for key in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
            "PIP_INDEX_URL",
        ):
            if os.environ.get(key):
                cmd.extend(["--build-arg", key])
        run(*cmd, str(ROOT))
    elif args.command == "up":
        initialize()
        run(
            "docker",
            "build",
            "-t",
            SERVER_IMAGE,
            "-f",
            str(PACKAGE / "Dockerfile.server"),
            str(args.source.resolve() / "server"),
        )
        run("docker", "pull", EXECD_IMAGE)
        run(
            "docker",
            "run",
            "-d",
            "--name",
            SERVER_NAME,
            "--network",
            "host",
            "--mount",
            f"type=bind,src={STATE / 'server.toml'},dst=/etc/opensandbox/config.toml,readonly",
            "--mount",
            "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
            "--mount",
            "type=volume,src=oi-opensandbox-store,dst=/var/lib/opensandbox",
            SERVER_IMAGE,
        )
        connection = settings()
        request = urllib.request.Request(
            connection["api_url"] + "/v1/sandboxes",
            headers={"OPEN-SANDBOX-API-KEY": connection["api_key"]},
        )
        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        # Local API traffic must not use an HTTP proxy inherited by the shell.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < deadline:
            try:
                with opener.open(request, timeout=2) as response:
                    if response.status == 200:
                        print(f"OpenSandbox ready at {connection['api_url']}")
                        return
            except OSError:
                time.sleep(1)
        raise SystemExit(f"Server readiness timed out; inspect: docker logs {SERVER_NAME}")
    elif args.command == "down":
        down()
    else:
        run(
            "docker",
            "ps",
            "-a",
            "--filter",
            f"name=^{SERVER_NAME}$",
            "--format",
            "{{.Names}}\t{{.Status}}",
        )


if __name__ == "__main__":
    main()
