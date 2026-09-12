import json

import pytest
from artifacts import atomic_json, store_patch
from reporting import protocol_evidence


def protocol_fixture(directory):
    root, children = "parent0001", ["child00001", "child00002"]
    events, publications, transfers = [], {}, []

    def event(session_id, kind, data):
        events.append(
            {"sessionId": session_id, "type": kind, "createdAt": len(events), "data": data}
        )

    def call(session_id, tool, args, output):
        event(
            session_id,
            "tool_call",
            {"tool": tool, "args": args, "output": output, "status": "completed"},
        )

    for session_id in [root, *children]:
        event(session_id, "ready", {"sandboxBackend": "opensandbox"})
    for index, child in enumerate(children):
        original = f"# Feature {index + 1}\n\nPreserve this independent requirement.\n"
        (directory / f"prompt.original.{index + 1}.txt").write_text(original)
        call(root, "spawn-child", {"prompt": original}, f"Child ID: {child}")
    for index, child in enumerate(children):
        publication = store_patch(
            directory / "artifacts", child, f"child change {index}".encode(), source="published"
        )
        publications[child] = publication
        call(child, "bash", {"command": "oi-bench publish"}, json.dumps(publication))
        call(
            root,
            "get-child-status",
            {"childId": child, "includeResponse": True},
            f"Child: {child}\nFinal response:\nSuccess: yes\nText:\nImplemented the feature.",
        )
        call(
            root,
            "bash",
            {"command": f"oi-bench fetch {child} {publication['sha256']} --output /tmp/{child}"},
            f"/tmp/{child}",
        )
        transfers.append(
            {
                "recipientSessionId": root,
                "sourceSessionId": child,
                "sha256": publication["sha256"],
                "bytes": publication["bytes"],
            }
        )
    parent = store_patch(directory / "artifacts", root, b"integrated code", source="published")
    publications[root] = parent
    store_patch(directory / "artifacts", root, b"integrated code", source="checkpoint")
    call(root, "bash", {"command": "oi-bench publish"}, json.dumps(parent))
    event(
        root,
        "token",
        {
            "messageId": "message1",
            "content": "\n".join(f"{child}: {publications[child]['sha256']}" for child in children),
        },
    )
    event(root, "execution_complete", {"messageId": "message1", "success": True})
    atomic_json(
        directory / "containers.json",
        {f"container-{sid}": {"sessionId": sid} for sid in [root, *children]},
    )
    atomic_json(
        directory / "artifact-coverage.json",
        {"sessions": {root: {"finalCapture": True}}},
    )
    state = {
        "rootSessionId": root,
        "sessionTree": {root: None, **dict.fromkeys(children, root)},
        "trace": {"path": str(directory / "trace")},
        "benchmarkCorrectness": {
            "status": "complete",
            "child_patch_sha256": [publications[child]["sha256"] for child in children],
        },
    }
    return state, events, publications, transfers


def evaluate(directory, state, events, transfers):
    path = directory / "trace/normalized/events.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(event) + "\n" for event in events))
    (directory / "artifact-transfers.jsonl").write_text(
        "".join(json.dumps(transfer) + "\n" for transfer in transfers)
    )
    return protocol_evidence(directory, state, {"benchmark": "cooperbench"})


def test_skipped_scoring_keeps_real_child_artifact_protocol(tmp_path):
    state, events, _publications, transfers = protocol_fixture(tmp_path)
    state["benchmarkCorrectness"] = {"status": "not_scored", "reason": "disabled_by_config"}
    result = evaluate(tmp_path, state, events, transfers)
    assert result["status"] == "passed"
    assert result["officialChildScoring"] == {
        "status": "not_scored",
        "reason": "disabled_by_config",
    }
    # Disabling the grader must not waive actual parent/child patch transfer checks.
    result = evaluate(tmp_path, state, events, [])
    assert result["status"] == "failed"


def test_complete_protocol_links_publication_delivery_response_and_scoring(tmp_path):
    state, events, _, transfers = protocol_fixture(tmp_path)
    result = evaluate(tmp_path, state, events, transfers)
    assert result["status"] == "passed" and result["issues"] == []
    assert result["officialChildScoring"]["status"] == "matched"
    assert result["parentPublicationSha256"]


@pytest.mark.parametrize(
    "failure",
    [
        "missing",
        "help",
        "changed",
        "corrupt",
        "response",
        "cancelled",
        "missing_checkpoint",
        "nonfinal_checkpoint",
        "corrupt_checkpoint",
    ],
)
def test_parent_publication_and_successful_final_identities_are_required(tmp_path, failure):
    state, events, publications, transfers = protocol_fixture(tmp_path)
    root = state["rootSessionId"]
    if failure == "missing":
        (tmp_path / "artifacts" / root / "published.json").unlink()
    elif failure == "help":
        for event in events:
            if (
                event["sessionId"] == root
                and event["data"].get("args", {}).get("command") == "oi-bench publish"
            ):
                event["data"]["args"]["command"] += " --help"
    elif failure == "changed":
        store_patch(tmp_path / "artifacts", root, b"unpublished changes", source="checkpoint")
    elif failure == "corrupt":
        (tmp_path / "artifacts" / root / publications[root]["file"]).write_bytes(b"corrupted")
    elif failure == "response":
        next(event for event in events if event["type"] == "token")["data"]["content"] = "Done"
    elif failure == "missing_checkpoint":
        (tmp_path / "artifacts" / root / "checkpoint.json").unlink()
    elif failure == "nonfinal_checkpoint":
        atomic_json(
            tmp_path / "artifact-coverage.json", {"sessions": {root: {"finalCapture": False}}}
        )
    elif failure == "corrupt_checkpoint":
        path = tmp_path / "artifacts" / root / "checkpoint.json"
        checkpoint = json.loads(path.read_text())
        checkpoint["sha256"] = "0" * 64
        atomic_json(path, checkpoint)
    else:
        next(event for event in events if event["type"] == "execution_complete")["data"][
            "success"
        ] = False
    result = evaluate(tmp_path, state, events, transfers)
    assert result["status"] == "failed"
    assert any("parent" in issue.lower() for issue in result["issues"])


@pytest.mark.parametrize(
    "failure",
    ["publish_output", "fetch_revision", "delivery_revision", "delivery_bytes", "score_revision"],
)
def test_child_revision_must_match_across_the_complete_evidence_chain(tmp_path, failure):
    state, events, _, transfers = protocol_fixture(tmp_path)
    if failure == "publish_output":
        child_call = next(
            event
            for event in events
            if event["sessionId"] == "child00001" and event["type"] == "tool_call"
        )
        child_call["data"]["output"] = "Published another revision"
    elif failure == "fetch_revision":
        fetch = next(
            event
            for event in events
            if "oi-bench fetch child00001" in event["data"].get("args", {}).get("command", "")
        )
        fetch["data"]["args"]["command"] = "oi-bench fetch child00001 " + "0" * 64
    elif failure == "delivery_revision":
        transfers[0]["sha256"] = "0" * 64
    elif failure == "delivery_bytes":
        transfers[0]["bytes"] += 1
    else:
        state["benchmarkCorrectness"]["child_patch_sha256"].reverse()
    result = evaluate(tmp_path, state, events, transfers)
    assert result["status"] == "failed"


def test_rewritten_prompt_requires_review_without_asserting_missing_requirements(tmp_path):
    state, events, _, transfers = protocol_fixture(tmp_path)
    spawn = next(event for event in events if event["data"].get("tool") == "spawn-child")
    spawn["data"]["args"]["prompt"] = "Feature 1: Preserve this independent requirement."
    result = evaluate(tmp_path, state, events, transfers)
    assert result["status"] == "review_required" and result["issues"] == []
    assert result["originalPromptCopies"][0]["semanticCompleteness"] == "not_automatically_assessed"
    assert result["reviewRequired"]
