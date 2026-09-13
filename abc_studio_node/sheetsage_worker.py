"""Official SheetSage2 inference in its own pinned Python environment."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import wave

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def explain(exc):
    """Say what an unsupported-card CUDA failure means and how to fix it.

    A Torch built without kernels for this GPU still reports CUDA as
    available, so the first model call is where it shows up, wearing an
    English message that says nothing about what to do. The console keeps
    the full traceback.
    """
    text = str(exc)
    if "no kernel image is available" in text:
        return ("이 그래픽카드를 지원하지 않는 Torch 가 채보 환경에 깔려 있습니다. "
                "최신 설치기를 다시 실행하면 맞는 버전으로 바뀝니다.")
    return text


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    for attempt in range(40):
        try:
            temporary.replace(path)
            return
        except PermissionError as exc:
            # Windows readers can briefly deny replacement while polling status.
            if sys.platform != "win32" or exc.winerror not in (5, 32, 33) or attempt == 39:
                raise
            time.sleep(.05)


def render_preview(path, tracks, duration):
    """Small piano-like preview of the returned MIDI, not separated source audio."""
    import numpy as np
    rate = 16000
    notes = [note for track in tracks for note in track["notes"]]
    # Write in blocks so long songs do not require another whole-song buffer.
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        for offset in range(0, int((duration + .1) * rate), rate * 5):
            count = min(rate * 5, int((duration + .1) * rate) - offset)
            block = np.zeros(count, dtype=np.float32)
            for note in notes:
                start, end = max(offset, round(note["start"] * rate)), min(offset + count, round(note["end"] * rate))
                if end <= start:
                    continue
                t = np.arange(start, end) / rate - note["start"]
                length = note["end"] - note["start"]
                envelope = np.minimum(t / .008, 1) * np.minimum((length - t) / .025, 1) * np.exp(-t * .7)
                f = 440 * 2 ** ((note["pitch"] - 69) / 12)
                block[start-offset:end-offset] += (.15 * envelope * (np.sin(2*np.pi*f*t) + .2*np.sin(4*np.pi*f*t))).astype(np.float32)
            output.writeframes((np.clip(block, -1, 1) * 32767).astype("<i2").tobytes())


def run(job, request, report):
    import numpy as np
    import torch
    from transformers import AutoModel

    torch.set_num_threads(4)
    if not torch.cuda.is_available():
        raise RuntimeError("SheetSage2 채보에 사용할 NVIDIA GPU를 찾지 못했습니다. 설치 검사를 실행하세요.")
    config = request["setup"]
    report("음원 읽는 중", 2)
    command = [config["ffmpeg"], "-v", "error", "-nostdin", "-y", "-i", str(job / "input.audio")]
    if request.get("from", 0):
        command += ["-ss", str(request["from"])]
    if request.get("to") is not None:
        command += ["-t", str(request["to"] - request.get("from", 0))]
    command += ["-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(job / "original.wav")]
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    decoded = subprocess.run(command, capture_output=True, timeout=600, **options)
    if decoded.returncode:
        raise ValueError("음원을 읽지 못했습니다: " + decoded.stderr.decode(errors="replace")[-600:])
    with wave.open(str(job / "original.wav"), "rb") as source:
        audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
    if audio.size < 4800:
        raise ValueError("분석할 소리가 0.2초 이상 필요합니다. 구간을 확인하세요.")
    report("SheetSage2와 MERT2 모델 불러오는 중", 5)
    model = AutoModel.from_pretrained(config["model"], base_model_path=config["encoder"],
                                     trust_remote_code=True, local_files_only=True).eval().to("cuda")
    started = time.monotonic()

    def progress(event):
        current, total = event.get("window", 1), event.get("windows", 1)
        label = {"audio": "음원 준비", "encoding": "음악 구조 분석", "decoding": "인스·보컬·박자 채보",
                 "window_complete": "구간 채보 완료", "notation": "두 멜로디를 ABC 악보로 변환", "complete": "악보 확인"}.get(event["stage"], "분석")
        suffix = f" · 구간 {current}/{total}"
        if event.get("tokens"):
            suffix += f" · {event['tokens']} 토큰"
        report(label + suffix + f" · {int(time.monotonic()-started)}초", 10 + 80 * (current-1) / total)

    result = model.transcribe(audio, sampling_rate=24000, output_dir=job / "score",
                              melody_only=request.get("mode", "melody") == "melody", progress=progress)
    if result.get("abc_error") or not result.get("abc"):
        raise ValueError("ABC 변환 실패: " + str(result.get("abc_error", "결과 없음")))
    duration = float(result["duration_seconds"])
    tracks = result["playback"]["tracks"]
    melodies = [track for track in tracks if track["name"] in ("Vocal", "Ins")]
    if not any(track["notes"] for track in melodies):
        raise ValueError("채보된 멜로디가 없습니다. 다른 구간이나 더 선명한 음원을 사용하세요.")
    report("인스·보컬 악보 미리듣기 만드는 중", 95)
    for part, name in (("vocal", "Vocal"), ("instrumental", "Ins")):
        render_preview(job / f"{part}.wav", [t for t in melodies if t["name"] == name], duration)
    render_preview(job / "melody.wav", melodies, duration)
    return {"engine": "SheetSage2", "abc": result["abc"], "duration": duration, "tracks": melodies,
            "vocalNotes": result["vocal_notes"], "instrumentalNotes": result["instrumental_notes"],
            "warnings": result["warnings"], "diagnostics": result["diagnostics"],
            "windows": result["windows"], "peakGpuMiB": result["peak_gpu_mib"],
            "elapsedSeconds": time.monotonic()-started, "mode": request.get("mode", "melody")}


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    def report(message, percent):
        print(message, flush=True)
        write_json(directory / "status.json", {"state": "running", "message": message, "percent": percent})
    try:
        write_json(directory / "result.json", run(directory, request, report))
        write_json(directory / "status.json", {"state": "done", "percent": 100, "message": "인스·보컬 채보 완료"})
    except Exception as exc:
        import traceback
        traceback.print_exc()
        write_json(directory / "status.json", {"state": "error", "message": explain(exc)})
        sys.exit(1)
