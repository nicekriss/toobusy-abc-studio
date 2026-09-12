"""ABC 악보 스튜디오.

ABC 텍스트 위젯(`abc`)을 가진 노드라면 어떤 노드든 위젯 위에
"악보 스튜디오 열기" 버튼이 붙는다. YuE2 · Generate Song 노드가 그 대상이다.
아래 두 노드는 악보를 따로 보관하거나 확인할 때 쓰는 보조 노드다.

또한 YuE2가 설치되어 있으면 동일한 출력 타입(`STRING`)으로 `abc`를 받아
동작하는 `2BZ YuE2 Generate + ABC` 노드를 제공한다. YuE2가 없으면 같은 노드는
정적 오류를 보여주며 기존 기능은 그대로 유지한다.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

DEFAULT_ABC = "\n".join([
    "X:1",
    "T:",
    "M:4/4",
    "L:1/16",
    "Q:1/4=91",
    "K:Am",
    "V:1",
    "z16|z16|z16|z16|",
    "",
])


class ABCScoreInput:
    """피아노롤로 그린 멜로디를 ABC 악보 텍스트로 내보낸다."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"abc": ("STRING", {
            "multiline": True,
            "default": DEFAULT_ABC,
            "tooltip": "위의 '악보 스튜디오 열기' 버튼을 누르면 피아노롤로 그릴 수 있다.",
        })}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("abc",)
    FUNCTION = "run"
    CATEGORY = "toobusy/ABC"

    def run(self, abc):
        return (abc,)


class ABCScoreInfo:
    """ABC 악보에서 조, 박자, 템포, 마디 수를 읽어 본다."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"abc": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ("STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("key", "meter", "bpm", "bars")
    FUNCTION = "run"
    CATEGORY = "toobusy/ABC"

    def run(self, abc):
        import re

        key, meter, bpm, bars = "C", "4/4", 120, 0
        seen_key = False
        for line in (abc or "").splitlines():
            line = line.strip()
            if line.startswith("K:") and not seen_key:
                key, seen_key = (line[2:].strip() or "C"), True
            elif line.startswith("M:"):
                m = re.search(r"(\d+)\s*/\s*(\d+)", line)
                if m:
                    meter = "%s/%s" % (m.group(1), m.group(2))
            elif line.startswith("Q:"):
                m = re.search(r"=\s*(\d+)", line)
                if m:
                    bpm = int(m.group(1))
            elif line and line[1:2] != ":" and not line.startswith("%"):
                bars += line.count("|")
        return (key, meter, bpm, bars)


def _iter_yue2_node_candidates():
    """Yield potential `ComfyUI-YuE2/nodes.py` paths, including common layouts."""

    repo_root = Path(__file__).resolve().parents[2]
    candidates = {
        repo_root / "ComfyUI-YuE2" / "nodes.py",
        repo_root.parent / "ComfyUI-YuE2" / "nodes.py",
        repo_root / "custom_nodes" / "ComfyUI-YuE2" / "nodes.py",
        Path.cwd() / "ComfyUI-YuE2" / "nodes.py",
        Path.cwd() / "custom_nodes" / "ComfyUI-YuE2" / "nodes.py",
    }

    for entry in sys.path:
        try:
            base = Path(entry).resolve()
        except Exception:
            continue
        candidates.add(base / "ComfyUI-YuE2" / "nodes.py")
        candidates.add(base / "custom_nodes" / "ComfyUI-YuE2" / "nodes.py")

    for candidate in sorted(candidates):
        yield candidate

    # If upstream structure changes and `ComfyUI-YuE2` is nested under one of the
    # candidate roots, scan limited depth for a `nodes.py` containing the class.
    roots = {
        repo_root / "custom_nodes",
        repo_root.parent / "custom_nodes",
        Path.cwd() / "custom_nodes",
    }
    for root in roots:
        if not root.is_dir():
            continue
        for nodes_path in root.glob("**/ComfyUI-YuE2/nodes.py"):
            if nodes_path.is_file():
                yield nodes_path


def _load_upstream_yue2_generate():
    """Load upstream `YuE2LocalGenerate` lazily if available."""

    tried = []
    for candidate in _iter_yue2_node_candidates():
        if not candidate.is_file():
            continue
        key = str(candidate)
        if key in tried:
            continue
        tried.append(key)
        try:
            snippet = candidate.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if "YuE2LocalGenerate" not in snippet:
            continue
        spec = importlib.util.spec_from_file_location("_toobusy_yue2_nodes", candidate)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            return None, None, (
                "YuE2 노드 임포트 실패. ComfyUI-YuE2 패키지가 설치되어 있더라도 Python 경로 이슈가 있을 수 있습니다. "
                f"실패 위치: {candidate}, 원인: {exc}"
            )
        base = getattr(module, "YuE2LocalGenerate", None)
        if base is None:
            continue
        return base, module, None

    error = (
        "YuE2LocalGenerate를 찾을 수 없습니다.\n"
        "ComfyUI-YuE2가 설치돼 있다면 최신 버전으로 업데이트 후 ComfyUI를 재시작하세요.\n"
        "현재 toobusy-abc-studio는 ABC 기능만 제공합니다."
    )
    if tried:
        error = (
            "업스트림 ComfyUI-YuE2를 찾았으나 YuE2LocalGenerate 클래스를 로드하지 못했습니다. "
            "확인 파일: " + ", ".join(tried)
        )
    return None, None, error


class YuE2LocalGenerateWithABCUnavailable:
    """Fallback node that clearly explains missing YuE2 dependency."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("YUE2_MODEL",),
            "style": ("STRING", {"forceInput": True}),
            "lyrics": ("STRING", {"forceInput": True}),
            "seed": ("INT", {"default": 831001, "min": 0, "max": 2**63 - 1}),
            "planning": (["full", "melody", "off"], {"default": "full"}),
            "abc": ("STRING", {"multiline": True, "default": ""}),
        }}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "generate"
    CATEGORY = "toobusy/ABC"
    _MISSING_YUE2_MESSAGE = (
        "YuE2 연동 노드를 사용하려면 ComfyUI-YuE2 패키지를 먼저 설치하세요. "
        "현재 toobusy-abc-studio는 기존 ABC 기능은 그대로 유지합니다."
    )

    def generate(self, model, style, lyrics, seed, planning, abc):  # noqa: ARG002
        raise RuntimeError(self._MISSING_YUE2_MESSAGE)


_YUE2_BASE_CLASS, _YUE2_BASE_MODULE, _YUE2_LOAD_ERROR = _load_upstream_yue2_generate()
YuE2LocalGenerateWithABCUnavailable._MISSING_YUE2_MESSAGE = _YUE2_LOAD_ERROR
if _YUE2_BASE_CLASS is None:
    YuE2LocalGenerateWithABC = YuE2LocalGenerateWithABCUnavailable
    _YUE2_GENERATE_CLASS_NAME = "2BZ YuE2 Generate + ABC (YuE2 미설치)"
else:
    class YuE2LocalGenerateWithABC(_YUE2_BASE_CLASS):
        """YuE2 local generate node with optional `abc` score override."""

        @classmethod
        def INPUT_TYPES(cls):
            required = dict(super().INPUT_TYPES()["required"])
            required["abc"] = (
                "STRING",
                {"multiline": True, "default": "", "tooltip": "비우면 자동 작곡 경로를 사용하고, 채우면 해당 ABC 기반으로 생성합니다."},
            )
            return {"required": required}

        def generate(self, model, style, lyrics, seed, planning, abc=""):
            # 상위 YuE2 노드가 이미 abc 를 처리한다. 빈 값이면 자동 작곡,
            # 값이 있으면 악보 기반 생성이고, planning=off 와 함께 오면
            # 한국어 안내를 띄운다. 워커 호출을 여기서 다시 구현하면 상위가
            # 바뀔 때 조용히 어긋나고 그 안내도 사라진다. 그대로 넘긴다.
            return super().generate(model, style, lyrics, seed, planning, abc)


_YUE2_GENERATE_CLASS_NAME = "2BZ YuE2 Generate + ABC"

NODE_CLASS_MAPPINGS = {
    "ABCScoreInput": ABCScoreInput,
    "ABCScoreInfo": ABCScoreInfo,
    "YuE2LocalGenerateWithABC": YuE2LocalGenerateWithABC,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ABCScoreInput": "ABC 악보 입력",
    "ABCScoreInfo": "ABC 악보 정보",
    "YuE2LocalGenerateWithABC": _YUE2_GENERATE_CLASS_NAME,
}
