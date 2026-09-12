"""Regression tests for the ABC 악보 스튜디오 nodes.

The nodes must stay dependency free at import time: they only move text around,
so a user without any audio library still gets them. The score reader is checked
against a real two-voice ABC tune because its numbers drive what the YuE2
Generate Song node is told about the melody.
"""

import importlib.util
import os
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load():
    path = os.path.join(ROOT, "abc_studio_node", "abc_studio.py")
    spec = importlib.util.spec_from_file_location("toobusy.abc_studio_node.abc_studio", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_BEFORE_LOAD = set(sys.modules)
_mod = _load()
_PULLED_IN = set(sys.modules) - _BEFORE_LOAD

SCORE = "\n".join([
    "X:1",
    "T:demo",
    "M:3/4",
    "L:1/8",
    "Q:1/4=132",
    "% a comment line with | pipes | that must not count as bars",
    "V: Vocal clef=treble",
    "K:Gm",
    "V: Vocal",
    "GABc|d2z4|",
    "V: Ins",
    "G4z2|G6|",
])


def test_input_node_is_passthrough():
    node = _mod.ABCScoreInput()
    assert node.run(SCORE) == (SCORE,)
    # An empty score is still valid: YuE2 falls back to generating its own melody.
    assert node.run("") == ("",)


def test_input_node_default_parses_as_a_score():
    key, meter, bpm, bars = _mod.ABCScoreInfo().run(_mod.DEFAULT_ABC)
    assert key == "Am"
    assert meter == "4/4"
    assert bpm == 91
    assert bars == 4


def test_info_node_reads_header_and_counts_bars():
    key, meter, bpm, bars = _mod.ABCScoreInfo().run(SCORE)
    assert key == "Gm", "the first K: line wins, later voice switches must not overwrite it"
    assert meter == "3/4"
    assert bpm == 132
    assert bars == 4, "two music lines of two bars each; comments and headers excluded"


def test_info_node_survives_an_empty_or_headerless_score():
    assert _mod.ABCScoreInfo().run("") == ("C", "4/4", 120, 0)
    assert _mod.ABCScoreInfo().run(None) == ("C", "4/4", 120, 0)


def test_nodes_are_registered_with_display_names():
    for name in ("ABCScoreInput", "ABCScoreInfo", "YuE2LocalGenerateWithABC"):
        assert name in _mod.NODE_CLASS_MAPPINGS
        assert _mod.NODE_DISPLAY_NAME_MAPPINGS.get(name)


def test_yue2_abc_node_exposes_clear_error_when_dependency_missing():
    cls = _mod.NODE_CLASS_MAPPINGS["YuE2LocalGenerateWithABC"]
    if cls.__name__ != "YuE2LocalGenerateWithABCUnavailable":
        return
    node = cls()
    try:
        node.generate("model", "style", "lyrics", 1, "full", "")
    except RuntimeError as exc:
        assert "YuE2" in str(exc)
    else:
        raise AssertionError("YuE2 미설치 환경에서 오류를 반환해야 합니다.")


def test_import_pulls_no_heavy_dependency():
    heavy = {name for name in _PULLED_IN if name.split(".")[0] in {"torch", "numpy", "PIL", "scipy"}}
    assert not heavy, f"importing the ABC nodes must stay cheap, but it loaded {sorted(heavy)}"


# 아래는 YuE2 연동 노드가 상위 generate 에 인자를 그대로 넘기는지 본다.
# 예전에는 워커 호출부를 통째로 복사해 뒀는데, 그 복사본에서 planning=off 안내가
# 빠져 있었다. 그 탓에 악보와 off 를 함께 넣으면 YuE2 내부 영어 예외가 그대로
# 튀어나왔다. 위임으로 바꾼 뒤 이 테스트가 그 회귀를 막는다.
_STUB_UPSTREAM = """
CALLS = []


class YuE2LocalGenerate:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("YUE2_MODEL",),
                "style": ("STRING", {"forceInput": True}),
                "lyrics": ("STRING", {"forceInput": True}),
                "seed": ("INT", {"default": 831001}),
                "planning": (["full", "melody", "off"], {"default": "full"}),
            },
            "optional": {"abc": ("STRING", {"multiline": True, "default": ""})},
        }

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "generate"

    def generate(self, model, style, lyrics, seed, planning, abc=""):
        CALLS.append((model, style, lyrics, seed, planning, abc))
        if abc and abc.strip() and planning == "off":
            raise ValueError("planning 을 full 또는 melody 로 바꾸세요")
        return ("AUDIO_OK",)
"""

_SAMPLE_SCORE = chr(10).join(["X:1", "M:4/4", "L:1/8", "K:Am", 'V:1', '"Am"A2c2e2c2|'])


def _load_with_stub_upstream(tmpdir):
    """Load the module against a fake ComfyUI-YuE2 placed on sys.path."""
    node_dir = os.path.join(tmpdir, "ComfyUI-YuE2")
    os.makedirs(node_dir, exist_ok=True)
    with open(os.path.join(node_dir, "nodes.py"), "w", encoding="utf-8") as handle:
        handle.write(_STUB_UPSTREAM)
    path = os.path.join(ROOT, "abc_studio_node", "abc_studio.py")
    sys.path.insert(0, tmpdir)
    try:
        spec = importlib.util.spec_from_file_location("toobusy.abc_studio_stubbed", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(tmpdir)


def test_bridge_node_forwards_every_argument_to_upstream():
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        mod = _load_with_stub_upstream(tmpdir)
        assert mod._YUE2_BASE_CLASS is not None, "스텁 업스트림을 찾지 못했습니다"
        calls = mod._YUE2_BASE_MODULE.CALLS
        node = mod.YuE2LocalGenerateWithABC()

        assert node.generate("MODEL", "STYLE", "LYRICS", 7, "full", _SAMPLE_SCORE) == ("AUDIO_OK",)
        assert calls[-1] == ("MODEL", "STYLE", "LYRICS", 7, "full", _SAMPLE_SCORE), (
            "악보가 상위 노드까지 그대로 가야 합니다"
        )

        node.generate("MODEL", "STYLE", "LYRICS", 7, "full", "")
        assert calls[-1][5] == "", "빈 악보도 상위가 자동 작곡으로 처리하도록 넘겨야 합니다"


def test_bridge_node_keeps_the_planning_off_guard():
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        mod = _load_with_stub_upstream(tmpdir)
        node = mod.YuE2LocalGenerateWithABC()
        try:
            node.generate("MODEL", "STYLE", "LYRICS", 7, "off", _SAMPLE_SCORE)
        except ValueError as exc:
            assert "planning" in str(exc)
        else:
            raise AssertionError("악보와 planning=off 조합은 상위 안내로 막혀야 합니다")


def test_bridge_node_exposes_abc_as_a_required_widget():
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        mod = _load_with_stub_upstream(tmpdir)
        required = mod.YuE2LocalGenerateWithABC.INPUT_TYPES()["required"]
        assert "abc" in required, "abc 는 위젯으로 보여야 악보 스튜디오 버튼이 붙습니다"
        assert required["abc"][1].get("multiline") is True


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("ABC studio tests passed")
