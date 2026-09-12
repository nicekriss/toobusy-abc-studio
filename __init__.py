"""ABC 악보 스튜디오 — ComfyUI 커스텀 노드 진입점.

이 폴더를 ComfyUI의 `custom_nodes` 아래에 두면(예: `custom_nodes/toobusy-abc-studio`)
ComfyUI가 파이썬 패키지로 읽어들이므로, 이 `__init__.py`가 노드 매핑을 내놓아야 한다.

오디오 분석의 무거운 패키지는 별도 작업 프로세스에서만 불러온다.
기본 악보 편집기는 `js/` 아래에 있고 ComfyUI에서 제공한다.
"""

import logging

logger = logging.getLogger(__name__)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .abc_studio_node import (
        NODE_CLASS_MAPPINGS as _CLASSES,
        NODE_DISPLAY_NAME_MAPPINGS as _NAMES,
    )
except Exception as exc:  # noqa: BLE001 - 로드 실패 이유가 시작 로그에 남아야 한다
    logger.warning(
        "[toobusy-abc-studio] 노드를 불러오지 못했습니다 (%s: %s).",
        type(exc).__name__,
        exc,
    )
else:
    NODE_CLASS_MAPPINGS.update(_CLASSES)
    NODE_DISPLAY_NAME_MAPPINGS.update(_NAMES)

WEB_DIRECTORY = "./js"

try:
    from .abc_studio_node.audio_routes import register_routes
    register_routes()
except ImportError:
    # Score parsing and tests can run without a ComfyUI server.
    pass
except Exception:
    logger.exception("[toobusy-abc-studio] 음원 분석 경로 등록 실패")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
