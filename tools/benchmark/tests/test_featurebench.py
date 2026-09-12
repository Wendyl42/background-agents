"""Regression checks for benchmark source-copy isolation boundaries."""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from featurebench import (
    BUILD_MANIFEST_SANITIZATION_SOURCE,
    MESON_COPY_MATERIALIZATION_SOURCE,
    PACKAGE_ISOLATION_SOURCE,
    TARGET_MODULE_LOCATION_SOURCE,
    active_legacy_preparation,
    archive_preparation,
)


class MesonCopyOutputTests(unittest.TestCase):
    def test_import_mapping_rejects_unaudited_or_changed_build_copies(self):
        namespace = {}
        exec(TARGET_MODULE_LOCATION_SOURCE, namespace)
        verify = namespace["verify_target_module_location"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "sklearn"
            canonical.mkdir()
            source = canonical / "__init__.py"
            source.write_text("# masked\n")
            destination = root / "build/cp310/sklearn/__init__.py"
            destination.parent.mkdir(parents=True)
            shutil.copy2(source, destination)
            mapping = {
                "source": str(source.relative_to(root)),
                "destination": str(destination.relative_to(root)),
                "maskedContentSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            }
            self.assertEqual(
                verify(str(source), str(canonical), [], str(root))["locationPolicy"], "canonical"
            )
            with self.assertRaises(AssertionError):
                verify(str(destination), str(canonical), [], str(root))
            accepted = verify(str(destination), str(canonical), [mapping], str(root))
            self.assertEqual(accepted["verifiedMaterializedCopyCount"], 1)
            self.assertEqual(
                accepted["locationPolicy"], "audited_meson_copy_with_identical_masked_bytes"
            )
            destination.write_text("# stale unmasked copy\n")
            with self.assertRaises(AssertionError):
                verify(str(destination), str(canonical), [mapping], str(root))
            source.write_text("# both changed\n")
            shutil.copy2(source, destination)
            with self.assertRaises(AssertionError):
                verify(str(destination), str(canonical), [mapping], str(root))

    def test_copy_rule_outputs_use_masked_regular_files_and_keep_other_links(self):
        namespace = {}
        exec(MESON_COPY_MATERIALIZATION_SOURCE, namespace)
        materialize = namespace["materialize_meson_copy_outputs"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "sklearn"
            canonical.mkdir()
            source = canonical / "__init__.py"
            source.write_text("# masked canonical content\n")
            build = root / "build/cp310"
            output = build / "sklearn/__init__.py"
            output.parent.mkdir(parents=True)
            output.symlink_to(source)
            other = output.parent / "other.py"
            other.symlink_to(source)
            binary = output.parent / "native.so"
            binary.write_bytes(b"preserved binary")
            manifest = build / "build.ninja"
            manifest.write_text(
                "build sklearn/__init__.py: CUSTOM_COMMAND ../../sklearn/__init__.py\n"
                " COMMAND = /opt/conda/bin/meson --internal copy "
                "../../sklearn/__init__.py sklearn/__init__.py\n"
            )
            with self.assertRaises(shutil.SameFileError):
                shutil.copy2(source, output)
            result = materialize(str(root), str(canonical))
            self.assertEqual(len(result["materializedMaskedPythonCopies"]), 1)
            self.assertFalse(output.is_symlink())
            self.assertEqual(output.read_bytes(), source.read_bytes())
            self.assertTrue(other.is_symlink())
            self.assertEqual(binary.read_bytes(), b"preserved binary")
            source.write_text("# agent edit\n")
            shutil.copy2(source, output)
            self.assertEqual(output.read_bytes(), source.read_bytes())
            self.assertEqual(
                materialize(str(root), str(canonical))["materializedMaskedPythonCopies"], []
            )


class MissingTestBuildManifestTests(unittest.TestCase):
    def test_hidden_test_removed_from_meson_list_without_restoring_its_contents(self):
        namespace = {}
        exec(BUILD_MANIFEST_SANITIZATION_SOURCE, namespace)
        sanitize = namespace["sanitize_missing_test_build_entries"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tests = root / "lib/matplotlib/tests"
            tests.mkdir(parents=True)
            manifest = tests / "meson.build"
            manifest.write_bytes(
                b"test_files = [\n  'test_backend_qt.py',\n"
                b"  'test_backend_registry.py',\n  'test_backend_svg.py',\n]\n"
                b"# test_backend_registry.py is intentionally absent\n"
            )
            visible = tests / "test_backend_qt.py"
            visible.write_text("visible test remains")
            hidden = tests / "test_backend_registry.py"
            result = sanitize(str(root), [str(hidden)])
            self.assertFalse(hidden.exists())
            self.assertEqual(visible.read_text(), "visible test remains")
            self.assertEqual(result["removedMissingTestEntries"][0]["removedEntries"], 1)
            self.assertIn(b"# test_backend_registry.py", manifest.read_bytes())
            self.assertNotIn(b"  'test_backend_registry.py',", manifest.read_bytes())
            after = manifest.read_bytes()
            self.assertEqual(sanitize(str(root), [str(hidden)])["removedMissingTestEntries"], [])
            self.assertEqual(manifest.read_bytes(), after)
            with self.assertRaisesRegex(ValueError, "must already be removed"):
                sanitize(str(root), [str(visible)])


class PreparationRecoveryTests(unittest.TestCase):
    def test_recovery_refuses_live_legacy_task_across_resource_locks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "task-workspaces/task-one"
            output.mkdir(parents=True)
            evidence = output / "prepared.json"
            evidence.write_text('{"ready": false}')
            command = [
                sys.executable,
                "-c",
                "import signal; signal.pause()",
                "--lab-root",
                str(root),
                "--task-id",
                "task-one",
            ]
            process = subprocess.Popen(command)
            try:
                plan_path = root / "cache/featurebench-resource-plan.json"
                plan_path.parent.mkdir()
                record = {"pid": process.pid, "arguments": command}
                plan_path.write_text(json.dumps({"legacyPreparationProcesses": [record]}))
                self.assertEqual(active_legacy_preparation(root, "task-one"), process.pid)
                with self.assertRaisesRegex(RuntimeError, "active legacy preparation"):
                    archive_preparation(root, "task-one", output)
                self.assertEqual(evidence.read_text(), '{"ready": false}')
                self.assertIsNone(active_legacy_preparation(root, "different-task"))
                record["arguments"] = [*command, "different-command-after-pid-reuse"]
                plan_path.write_text(json.dumps({"legacyPreparationProcesses": [record]}))
                self.assertIsNone(active_legacy_preparation(root, "task-one"))
                record["arguments"] = command
                plan_path.write_text(json.dumps({"legacyPreparationProcesses": [record]}))
            finally:
                process.terminate()
                process.wait(timeout=5)
            self.assertIsNone(active_legacy_preparation(root, "task-one"))


class PackageIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.workspace = self.directory / "workspace"
        self.canonical = self.workspace / "sample_package"
        self.write(self.canonical / "__init__.py", "# canonical package\n")
        self.write(self.canonical / "feature.py", "def feature():\n    pass\n")
        self.scan = self.directory / "installed"
        self.scan.mkdir()
        namespace = {}
        # Execute the exact standalone function source shipped into containers.
        exec(PACKAGE_ISOLATION_SOURCE, namespace)
        self.isolate = namespace["isolate_target_package"]

    def write(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def run_isolation(self):
        return self.isolate(
            workspace=str(self.workspace),
            module="sample_package",
            mask_files=["sample_package/feature.py", "sample_package/removed_module.py"],
            hidden_files=["sample_package/tests/test_private.py"],
            scan_roots=[str(self.scan)],
        )

    def test_same_named_integration_is_unchanged(self):
        integration = self.scan / "hypothesis/extra/sample_package"
        self.write(integration / "__init__.py", "def strategies():\n    return 'integration'\n")
        self.write(integration / "impl.py", "# integration implementation\n")
        original = {p.name: p.read_bytes() for p in integration.iterdir()}
        result = self.run_isolation()
        self.assertFalse(integration.is_symlink())
        self.assertEqual(original, {p.name: p.read_bytes() for p in integration.iterdir()})
        self.assertIn(str(integration), result["skippedSameNameDirectories"])

    def test_true_python_copy_and_mask_only_copy_are_redirected(self):
        duplicate = self.scan / "vendor/sample_package"
        self.write(duplicate / "feature.py", "def feature():\n    return 'reference'\n")
        sparse = self.scan / "sparse_vendor/sample_package"
        self.write(sparse / "removed_module.py", "# removed reference implementation\n")
        result = self.run_isolation()
        for path in [duplicate, sparse]:
            self.assertTrue(path.is_symlink())
            self.assertEqual(path.resolve(), self.canonical)
            self.assertFalse((path / "removed_module.py").exists())
            self.assertIn(str(path), result["replacedPackageCopies"])
        self.assertEqual(
            (duplicate / "feature.py").read_text(), (self.canonical / "feature.py").read_text()
        )

    def test_compiled_copy_retains_binary_and_masks_python_and_private_tests(self):
        duplicate = self.scan / "build/cp311/sample_package"
        self.write(duplicate / "__init__.py", "# original package\n")
        self.write(duplicate / "feature.py", "def feature():\n    return 'reference'\n")
        self.write(duplicate / "removed_module.py", "# removed implementation\n")
        self.write(duplicate / "tests/test_private.py", "# hidden official test\n")
        self.write(duplicate / "__pycache__/feature.cpython-311.pyc", "cached reference")
        binary = duplicate / "_native.cpython-311-x86_64-linux-gnu.so"
        binary.write_bytes(b"opaque compiled extension bytes\x00\x01")
        expected_digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        result = self.run_isolation()
        self.assertFalse(duplicate.is_symlink())
        self.assertEqual(expected_digest, hashlib.sha256(binary.read_bytes()).hexdigest())
        self.assertTrue((duplicate / "feature.py").is_symlink())
        self.assertEqual((duplicate / "feature.py").resolve(), self.canonical / "feature.py")
        self.assertFalse((duplicate / "removed_module.py").exists())
        self.assertFalse((duplicate / "tests/test_private.py").exists())
        self.assertFalse((duplicate / "__pycache__").exists())
        self.assertEqual(result["preservedCompiledPackages"][0]["compiledFileCount"], 1)
        # Further agent edits to the canonical implementation must remain visible.
        self.write(self.canonical / "feature.py", "def feature():\n    return 'candidate'\n")
        self.assertIn("candidate", (duplicate / "feature.py").read_text())

    def test_masked_generic_init_copy_is_distinct_from_same_named_integration(self):
        original = "from sample_package.feature import reference_feature\n"
        self.write(self.canonical / "__init__.py", "# masked package initialization\n")
        duplicate = self.scan / "build/cp311/sample_package"
        self.write(duplicate / "__init__.py", original)
        binary = duplicate / "_native.cpython-311-x86_64-linux-gnu.so"
        binary.write_bytes(b"preserved extension")
        integration = self.scan / "hypothesis/extra/sample_package"
        integration_source = "def strategies():\n    return 'integration'\n"
        self.write(integration / "__init__.py", integration_source)
        result = self.isolate(
            workspace=str(self.workspace),
            module="sample_package",
            mask_files=["sample_package/__init__.py"],
            hidden_files=[],
            scan_roots=[str(self.scan)],
            original_generic_hashes={"__init__.py": hashlib.sha256(original.encode()).hexdigest()},
        )
        self.assertEqual(result["auditVersion"], 4)
        self.assertTrue((duplicate / "__init__.py").is_symlink())
        self.assertEqual((duplicate / "__init__.py").resolve(), self.canonical / "__init__.py")
        self.assertNotIn("reference_feature", (duplicate / "__init__.py").read_text())
        self.assertEqual(binary.read_bytes(), b"preserved extension")
        self.assertFalse(integration.is_symlink())
        self.assertEqual((integration / "__init__.py").read_text(), integration_source)
        self.assertEqual(
            result["matchedMaskedGenericCopies"],
            [{"path": str(duplicate), "matchingOriginalFiles": ["__init__.py"]}],
        )


if __name__ == "__main__":
    unittest.main()
