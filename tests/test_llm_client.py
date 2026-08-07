from unittest.mock import MagicMock

from teachkg.utils.llm_client import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    LLMClient,
    llm_settings_from_config,
    resolve_llm_model,
)


def test_default_model_and_base_url():
    assert resolve_llm_model(None) == DEFAULT_MODEL
    assert DEFAULT_MODEL == "deepseek-v4-flash-0731"
    assert DEFAULT_BASE_URL == "https://dashscope.aliyuncs.com/compatible-mode/v1"


def test_llm_settings_from_config_merges():
    settings = llm_settings_from_config(
        {"model": "deepseek-v4-flash-0731", "max_retry": 5},
        model="qwen-plus",
    )
    assert settings["model"] == "qwen-plus"
    assert settings["max_retry"] == 5


def test_llm_client_chat_retries(monkeypatch):
    client = LLMClient(api_key="test-key", base_url=DEFAULT_BASE_URL, model="deepseek-v4-flash-0731", max_retry=2)
    mock_create = MagicMock(side_effect=[
        RuntimeError("fail"),
        MagicMock(choices=[MagicMock(message=MagicMock(content='{"ok": true}'))]),
    ])
    mock_openai = MagicMock()
    mock_openai.return_value.chat.completions.create = mock_create
    monkeypatch.setattr("openai.OpenAI", mock_openai)
    monkeypatch.setattr("time.sleep", lambda _: None)

    out = client.chat("hello")
    assert out == '{"ok": true}'
    assert mock_create.call_count == 2
    kwargs = mock_create.call_args.kwargs
    assert kwargs["model"] == "deepseek-v4-flash-0731"
    assert kwargs["messages"] == [{"role": "user", "content": "hello"}]
