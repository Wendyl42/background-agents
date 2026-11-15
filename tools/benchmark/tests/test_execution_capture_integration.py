from unittest.mock import Mock
import pytest
import runner


def test_capture_readiness_failure_never_submits_model_prompt():
    client=Mock()
    client.request.return_value={"sessionId":"root"}
    capture=Mock()
    capture.await_root_ready.side_effect=RuntimeError("not measured")
    state={"phase":"allocated","title":"test","executionTrace":{"mode":"process"}}
    config={"model":"deepseek/deepseek-v4-flash","setupTimeoutSeconds":1,"deadlineSeconds":60}
    with pytest.raises(RuntimeError,match="not measured"):
        runner.ensure_submission(client,state,lambda:None,"prompt",config,capture)
    assert client.request.call_count==1
    assert client.request.call_args.args[0]=="/sessions"
    assert client.request.call_args.args[2]["executionTrace"]==state["executionTrace"]
    assert state["phase"]=="created"


def test_capture_ready_gate_precedes_prompt_submission():
    steps=[]
    client=Mock()
    client.request.side_effect=lambda path,*args: steps.append(path) or {"messageId":"m"}
    capture=Mock()
    capture.await_root_ready.side_effect=lambda *args:steps.append("ready")
    state={"phase":"created","rootSessionId":"root","executionTrace":{"mode":"process"}}
    runner.ensure_submission(client,state,lambda:None,"unaltered prompt",{"setupTimeoutSeconds":1,"deadlineSeconds":60},capture)
    assert steps==["ready","/sessions/root/prompt"]
    assert client.request.call_args.args[2]=={"content":"unaltered prompt"}
