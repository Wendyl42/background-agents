#!/usr/bin/env python3
"""Pull a pinned OCI/Docker image through the caller's HTTP proxy.

Docker's daemon need not share the shell's proxy. Public registry credentials
remain in memory; verified blobs and decompressed layers are reusable on retry.
No Docker configuration is changed. Only linux/amd64 images are accepted.
"""

from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import http.client
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_REQUEST_TIMEOUT_SECONDS = 120
DEFAULT_LOAD_TIMEOUT_SECONDS = 3600
DEFAULT_DOWNLOAD_ATTEMPTS = 3
CHUNK_BYTES = 8 * 1024 * 1024
MEDIA_TYPES = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def check_digest(value: str) -> str:
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError(f"Unsupported or invalid content digest: {value!r}")
    return value.split(":", 1)[1]


def external_root(lab_root: Path) -> Path:
    root = lab_root.expanduser().resolve()
    repository = Path(__file__).resolve().parents[2]
    if root == repository or repository in root.parents:
        raise ValueError("Benchmark downloads must be outside the source repository")
    return root


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirect = super().redirect_request(req, fp, code, msg, headers, newurl)
        if (
            redirect is not None
            and urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc
        ):
            redirect.remove_header("Authorization")
        return redirect


class Registry:
    def __init__(self, image: str):
        if image.startswith(("http://", "https://")):
            raise ValueError("Pass an OCI image reference, not a URL")
        name, separator, reference = image.partition("@")
        if not separator:
            slash = name.rfind("/")
            colon = name.rfind(":")
            if colon > slash:
                name, reference = name[:colon], name[colon + 1 :]
            else:
                reference = "latest"
        first, separator, rest = name.partition("/")
        if separator and ("." in first or ":" in first or first == "localhost"):
            self.host, self.repository = first, rest
        else:
            self.host = "registry-1.docker.io"
            self.repository = name if separator else "library/" + name
        if self.host in {"docker.io", "index.docker.io"}:
            self.host = "registry-1.docker.io"
        if not re.fullmatch(r"[a-z0-9._/-]+", self.repository) or ".." in self.repository.split(
            "/"
        ):
            raise ValueError("Invalid registry repository name")
        self.reference = reference
        self.image_name = (
            self.repository
            if self.host == "registry-1.docker.io"
            else self.host + "/" + self.repository
        )
        self.tag = (
            self.image_name
            + ":"
            + (
                reference
                if not reference.startswith("sha256:")
                else "benchmark-" + check_digest(reference)[:16]
            )
        )
        self.token: str | None = None
        self.opener = urllib.request.build_opener(SafeRedirect())

    def open(self, kind: str, reference: str, *, offset: int = 0):
        for attempt in range(DEFAULT_DOWNLOAD_ATTEMPTS):
            try:
                return self._open_once(kind, reference, offset=offset)
            except urllib.error.HTTPError as error:
                if (
                    error.code not in {408, 429, 500, 502, 503, 504}
                    or attempt + 1 == DEFAULT_DOWNLOAD_ATTEMPTS
                ):
                    raise
            except (
                urllib.error.URLError,
                http.client.RemoteDisconnected,
                TimeoutError,
                ConnectionError,
            ):
                if attempt + 1 == DEFAULT_DOWNLOAD_ATTEMPTS:
                    raise
            time.sleep(2**attempt)
        raise RuntimeError("Registry request retry budget exhausted")

    def _open_once(self, kind: str, reference: str, *, offset: int = 0):
        url = f"https://{self.host}/v2/{self.repository}/{kind}/{reference}"
        headers = {"Accept": MEDIA_TYPES}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)
        try:
            return self.opener.open(request, timeout=DEFAULT_REQUEST_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise
            challenge = error.headers.get("WWW-Authenticate", "")
            if not challenge.lower().startswith("bearer "):
                raise RuntimeError("Registry requires unsupported authentication") from error
            fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
            realm = fields.get("realm", "")
            if not realm.startswith("https://"):
                raise RuntimeError("Registry authentication realm must use HTTPS") from error
            query = {
                "service": fields.get("service", ""),
                "scope": fields.get("scope", f"repository:{self.repository}:pull"),
            }
            with self.opener.open(
                realm + "?" + urllib.parse.urlencode(query), timeout=DEFAULT_REQUEST_TIMEOUT_SECONDS
            ) as response:
                auth = json.load(response)
            self.token = auth.get("token") or auth.get("access_token")
            if not self.token:
                raise RuntimeError("Registry did not provide a public pull token") from error
            request.add_header("Authorization", "Bearer " + self.token)
            return self.opener.open(request, timeout=DEFAULT_REQUEST_TIMEOUT_SECONDS)

    def manifest(self, reference: str) -> tuple[dict, bytes, str]:
        with self.open("manifests", reference) as response:
            raw = response.read()
            actual = "sha256:" + hashlib.sha256(raw).hexdigest()
            advertised = response.headers.get("Docker-Content-Digest")
        if reference.startswith("sha256:") and reference != actual:
            raise RuntimeError("Downloaded manifest does not match pinned digest")
        if advertised and advertised != actual:
            raise RuntimeError("Registry manifest header disagrees with content hash")
        return json.loads(raw), raw, actual

    def blob(self, descriptor: dict, cache: Path) -> Path:
        digest = descriptor["digest"]
        target = cache / "blobs" / check_digest(digest)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if target.exists():
                if target.stat().st_size == descriptor["size"] and sha256_file(target) == digest:
                    return target
                raise RuntimeError(f"Corrupt cached registry blob: {target}")
            partial = target.with_suffix(".partial")
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > descriptor["size"]:
                raise RuntimeError(f"Oversized partial registry blob: {partial}")
            if offset == descriptor["size"]:
                if sha256_file(partial) != digest:
                    raise RuntimeError(f"Corrupt completed partial registry blob: {partial}")
                partial.replace(target)
                return target
            for attempt in range(DEFAULT_DOWNLOAD_ATTEMPTS):
                offset = partial.stat().st_size if partial.exists() else 0
                try:
                    with self.open("blobs", digest, offset=offset) as response:
                        resume = offset > 0 and response.status == 206
                        if resume and not response.headers.get("Content-Range", "").startswith(
                            f"bytes {offset}-"
                        ):
                            raise RuntimeError(
                                "Registry returned an inconsistent resumed byte range"
                            )
                        with partial.open("ab" if resume else "wb") as destination:
                            while chunk := response.read(CHUNK_BYTES):
                                destination.write(chunk)
                    break
                except (
                    urllib.error.URLError,
                    http.client.HTTPException,
                    TimeoutError,
                    ConnectionError,
                ):
                    if attempt + 1 == DEFAULT_DOWNLOAD_ATTEMPTS:
                        raise
                    time.sleep(2**attempt)
            if partial.stat().st_size != descriptor["size"] or sha256_file(partial) != digest:
                raise RuntimeError(f"Downloaded blob failed size/hash verification: {digest}")
            partial.replace(target)
            return target


def unpack_layer(blob: Path, descriptor: dict, diff_id: str, cache: Path) -> Path:
    target = cache / "layers" / (check_digest(diff_id) + ".tar")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if target.exists():
            if sha256_file(target) == diff_id:
                return target
            raise RuntimeError(f"Corrupt cached uncompressed layer: {target}")
        partial = target.with_suffix(".partial")
        media_type = descriptor.get("mediaType", "")
        opener = gzip.open if media_type.endswith(("+gzip", ".gzip")) else open
        if "zstd" in media_type:
            raise ValueError("zstd OCI layers require an explicit supported decoder")
        with opener(blob, "rb") as source, partial.open("wb") as destination:
            digest = hashlib.sha256()
            while chunk := source.read(CHUNK_BYTES):
                digest.update(chunk)
                destination.write(chunk)
        if "sha256:" + digest.hexdigest() != diff_id:
            raise RuntimeError("Uncompressed image layer does not match config diff_id")
        partial.replace(target)
        return target


def inspect_loaded_image(reference: str, config: dict) -> dict | None:
    inspection = subprocess.run(
        ["docker", "image", "inspect", reference], capture_output=True, text=True, check=False
    )
    if inspection.returncode:
        return None
    loaded = json.loads(inspection.stdout)[0]
    # The containerd image store reports a manifest ID after legacy docker load;
    # classic Docker reports the config ID. Verify the content in either case.
    if loaded.get("RootFS", {}).get("Layers") != config.get("rootfs", {}).get("diff_ids"):
        raise RuntimeError("Loaded image layers differ from verified registry config")
    expected_config = {
        k: v for k, v in config.get("config", {}).items() if v not in (None, [], {}, "")
    }
    actual_config = {
        k: v for k, v in loaded.get("Config", {}).items() if v not in (None, [], {}, "")
    }
    if expected_config != actual_config:
        raise RuntimeError(
            "Loaded image runtime configuration differs from verified registry config"
        )
    if loaded.get("Architecture") != config.get("architecture") or loaded.get("Os") != config.get(
        "os"
    ):
        raise RuntimeError("Loaded image platform differs from verified registry config")
    return loaded


def _ensure_image(
    image: str, lab_root: Path, expected_digest: str | None = None, inspect_only: bool = False
) -> dict:
    root = external_root(Path(lab_root))
    cache = root / "cache" / "oci"
    cache.mkdir(parents=True, exist_ok=True)
    registry = Registry(image)
    reference = expected_digest or registry.reference

    def read_manifest(ref: str) -> tuple[dict, bytes, str]:
        if ref.startswith("sha256:"):
            cached = cache / "manifests" / (check_digest(ref) + ".json")
            if cached.exists():
                data = cached.read_bytes()
                if "sha256:" + hashlib.sha256(data).hexdigest() != ref:
                    raise RuntimeError("Cached manifest does not match pinned digest")
                return json.loads(data), data, ref
        parsed, data, digest = registry.manifest(ref)
        cached = cache / "manifests" / (check_digest(digest) + ".json")
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(data)
        return parsed, data, digest

    manifest, raw, requested_digest = read_manifest(reference)
    manifest_digest = requested_digest
    if "manifests" in manifest:
        candidates = [
            item
            for item in manifest["manifests"]
            if item.get("platform", {}).get("os") == "linux"
            and item.get("platform", {}).get("architecture") == "amd64"
        ]
        if len(candidates) != 1:
            raise RuntimeError("Image index must have exactly one linux/amd64 manifest")
        manifest, raw, manifest_digest = read_manifest(candidates[0]["digest"])
    if "layers" not in manifest or "config" not in manifest:
        raise ValueError("Expected a schema 2 Docker/OCI image manifest")
    manifest_path = cache / "manifests" / (check_digest(manifest_digest) + ".json")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_bytes(raw)
    config_path = registry.blob(manifest["config"], cache)
    config = json.loads(config_path.read_bytes())
    if config.get("os") != "linux" or config.get("architecture") != "amd64":
        raise RuntimeError("Image config is not linux/amd64")
    result = {
        "image": image,
        "requestedDigest": requested_digest,
        "manifestDigest": manifest_digest,
        "configDigest": manifest["config"]["digest"],
        "imageId": None,
        "platform": "linux/amd64",
        "compressedBytes": sum(layer["size"] for layer in manifest["layers"]),
        "layers": [
            {"digest": layer["digest"], "compressedBytes": layer["size"]}
            for layer in manifest["layers"]
        ],
        "status": "resolved",
    }
    if inspect_only:
        return result
    metadata_path = cache / "images" / (check_digest(manifest_digest) + ".json")
    previous_id = (
        json.loads(metadata_path.read_text()).get("imageId") if metadata_path.exists() else None
    )
    loaded = inspect_loaded_image(previous_id or registry.tag, config)
    if loaded:
        result.update(status="available", imageId=loaded["Id"])
        write_json(cache / "images" / (check_digest(manifest_digest) + ".json"), result)
        return result
    # Reserve enough room for blobs, unpacked layers and Docker's own storage.
    if shutil.disk_usage(cache).free < result["compressedBytes"] * 4:
        raise RuntimeError(
            "Insufficient free disk for cached compressed/uncompressed layers and Docker storage"
        )
    diff_ids = config.get("rootfs", {}).get("diff_ids", [])
    if len(diff_ids) != len(manifest["layers"]):
        raise RuntimeError("Config diff_ids does not match the image layer count")
    unpacked = []
    for number, (layer, diff_id) in enumerate(zip(manifest["layers"], diff_ids, strict=True), 1):
        print(
            f"[{number}/{len(diff_ids)}] {layer['digest']} ({layer['size']} compressed bytes)",
            file=os.sys.stderr,
            flush=True,
        )
        blob = registry.blob(layer, cache)
        unpacked.append(unpack_layer(blob, layer, diff_id, cache))
    load_log = cache / "images" / (check_digest(manifest_digest) + ".docker-load.log")
    load_log.parent.mkdir(parents=True, exist_ok=True)
    archive_manifest = [
        {
            "Config": "config.json",
            "RepoTags": [registry.tag],
            "Layers": [f"{i}/layer.tar" for i in range(len(unpacked))],
        }
    ]
    with load_log.open("wb") as log:
        process = subprocess.Popen(
            ["docker", "load"], stdin=subprocess.PIPE, stdout=log, stderr=log
        )
        try:
            with tarfile.open(fileobj=process.stdin, mode="w|") as archive:
                archive.add(config_path, arcname="config.json", recursive=False)
                data = json.dumps(archive_manifest).encode("utf-8")
                info = tarfile.TarInfo("manifest.json")
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
                for i, layer_path in enumerate(unpacked):
                    archive.add(layer_path, arcname=f"{i}/layer.tar", recursive=False)
            process.stdin.close()
            if process.wait(timeout=DEFAULT_LOAD_TIMEOUT_SECONDS):
                raise RuntimeError(f"docker load failed; inspect {load_log}")
        except BaseException:
            process.kill()
            process.wait()
            raise
    loaded = inspect_loaded_image(registry.tag, config)
    if not loaded:
        raise RuntimeError("docker load did not create the expected image")
    result.update(
        status="available",
        imageId=loaded["Id"],
        loadedTag=registry.tag,
        loadedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    write_json(cache / "images" / (check_digest(manifest_digest) + ".json"), result)
    return result


def ensure_image(
    image: str,
    lab_root: Path,
    expected_digest: str | None = None,
    inspect_only: bool = False,
) -> dict:
    root = external_root(Path(lab_root))
    key = hashlib.sha256((expected_digest or image).encode("utf-8")).hexdigest()
    lock_path = root / "cache" / "oci" / "image-locks" / (key + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with (root / "cache/oci/activity.lock").open("a") as activity, lock_path.open("a") as lock:
        fcntl.flock(activity, fcntl.LOCK_SH)
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _ensure_image(image, root, expected_digest, inspect_only)


def prune_expanded_cache(lab_root: Path, *, dry_run: bool = True) -> dict:
    """Remove reproducible layers used only by already-loaded images.

    Every not-yet-loaded cached manifest protects its full layer set, including
    the image currently downloading/loading. Compressed blobs are never deleted.
    """
    root = external_root(Path(lab_root))
    with (root / "cache/oci/activity.lock").open("a") as activity:
        try:
            fcntl.flock(activity, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(
                "An image operation is active; retry pruning after it completes"
            ) from error
        return _prune_expanded_cache(root, dry_run=dry_run)


def _prune_expanded_cache(root: Path, *, dry_run: bool) -> dict:
    cache = root / "cache/oci"
    loaded_layers: dict[str, dict] = {}
    protected_layers: set[str] = set()
    protected_blobs: set[str] = set()
    inspected_images = []
    for path in sorted((cache / "manifests").glob("*.json")):
        if sha256_file(path) != "sha256:" + path.stem:
            raise ValueError("Manifest cache changed during pruning inspection: " + str(path))
        manifest = json.loads(path.read_text())
        if "layers" not in manifest or "config" not in manifest:
            continue
        config_path = cache / "blobs" / check_digest(manifest["config"]["digest"])
        if not config_path.exists():
            protected_blobs.update(item["digest"] for item in manifest["layers"])
            continue
        if sha256_file(config_path) != manifest["config"]["digest"]:
            raise ValueError("Config cache differs from its digest: " + str(config_path))
        config = json.loads(config_path.read_text())
        diff_ids = config.get("rootfs", {}).get("diff_ids", [])
        if len(diff_ids) != len(manifest["layers"]):
            raise ValueError("Manifest/config layer counts differ")
        metadata_path = cache / "images" / path.name
        metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
        image_id = metadata.get("imageId")
        loaded = inspect_loaded_image(image_id, config) if image_id else None
        inspected_images.append({"manifestDigest": "sha256:" + path.stem, "loaded": bool(loaded)})
        if not loaded:
            protected_layers.update(diff_ids)
            protected_blobs.update(item["digest"] for item in manifest["layers"])
            continue
        for descriptor, diff_id in zip(manifest["layers"], diff_ids, strict=True):
            loaded_layers[diff_id] = descriptor
    result = {
        "dryRun": dry_run,
        "inspectedImages": inspected_images,
        "protectedLayerCount": len(protected_layers),
        "eligibleBytes": 0,
        "freedBytes": 0,
        "layers": [],
        "skipped": [],
    }
    for diff_id, descriptor in loaded_layers.items():
        if diff_id in protected_layers or descriptor["digest"] in protected_blobs:
            continue
        target = cache / "layers" / (check_digest(diff_id) + ".tar")
        if not target.exists() or target.is_symlink():
            continue
        with target.with_suffix(".lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                result["skipped"].append({"diffId": diff_id, "reason": "layer currently locked"})
                continue
            blob = cache / "blobs" / check_digest(descriptor["digest"])
            if not blob.exists() or sha256_file(blob) != descriptor["digest"]:
                result["skipped"].append(
                    {"diffId": diff_id, "reason": "no verified compressed source"}
                )
                continue
            size = target.stat().st_size
            result["eligibleBytes"] += size
            result["layers"].append(
                {"diffId": diff_id, "compressedDigest": descriptor["digest"], "bytes": size}
            )
            if not dry_run:
                target.unlink()
                result["freedBytes"] += size
    report = cache / "pruning" / (str(time.time_ns()) + ".json")
    result["reportPath"] = str(report)
    write_json(report, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--image")
    action.add_argument("--prune-expanded-cache", action="store_true")
    parser.add_argument("--execute-prune", action="store_true", help="Default pruning is a dry run")
    parser.add_argument("--lab-root", type=Path, default=os.environ.get("BENCHMARK_LAB_ROOT"))
    parser.add_argument("--expected-digest")
    parser.add_argument("--inspect-only", action="store_true")
    args = parser.parse_args()
    if not args.lab_root:
        parser.error("--lab-root or BENCHMARK_LAB_ROOT is required")
    if args.execute_prune and not args.prune_expanded_cache:
        parser.error("--execute-prune requires --prune-expanded-cache")
    result = (
        prune_expanded_cache(args.lab_root, dry_run=not args.execute_prune)
        if args.prune_expanded_cache
        else ensure_image(args.image, args.lab_root, args.expected_digest, args.inspect_only)
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
