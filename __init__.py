"""ABC 악보 스튜디오 — ComfyUI 커스텀 노드 진입점.

이 폴더를 ComfyUI의 `custom_nodes` 아래에 두면(예: `custom_nodes/toobusy-abc-studio`)
ComfyUI가 파이썬 패키지로 읽어들이므로, 이 `__init__.py`가 노드 매핑을 내놓아야 한다.

노드 자체는 텍스트만 주고받아서 import 시점 의존성이 없다. 편집기는 `js/` 아래의
단독 HTML 한 장이라 별도 설치가 필요 없다.
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

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
