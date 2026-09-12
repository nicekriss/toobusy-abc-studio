"""One bounded CPU job; termination releases all models and temporary memory."""
import json
import os
from pathlib import Path
import sys

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")

from transcription import transcribe


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


if __name__ == "__main__":
    job = Path(sys.argv[1])
    request = json.loads((job / "request.json").read_text(encoding="utf-8"))

    def progress(message, percent):
        write_json(job / "status.json", {"state": "running", "message": message, "percent": percent})

    try:
        result = transcribe(job / "input.wav", request["mode"], request["model_directory"], progress)
        write_json(job / "result.json", result)
        write_json(job / "status.json", {"state": "done", "percent": 100, "message": "분석 완료"})
    except Exception as exc:
        import traceback
        traceback.print_exc()
        write_json(job / "status.json", {"state": "error", "message": str(exc)})
        sys.exit(1)
