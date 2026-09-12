"""Bounded, cancellable local transcription jobs for the score editor."""
from __future__ import annotations

import asyncio
import atexit
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import wave

MAX_UPLOAD = 18 * 1024 * 1024
MAX_SECONDS = 90
JOB_TTL = 30 * 60
JOBS = {}
LOCK = asyncio.Lock()


def terminate_worker(process):
    if process.poll() is not None:
        return
    if sys.platform == "win32":
        # Windows venv Python may be a redirector with a real worker child.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=10, check=False)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=5)


def stop_workers():
    for job in JOBS.values():
        terminate_worker(job["process"])


atexit.register(stop_workers)


def missing_dependencies():
    return [name for name in ("torch", "torchaudio", "librosa", "soundfile")
            if importlib.util.find_spec(name) is None]


def read_status(job):
    path = job["path"] / "status.json"
    try:
        status = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        status = {"state": "running", "percent": 0, "message": "분석 준비 중"}
    process = job["process"]
    if time.monotonic() - job["created"] > JOB_TTL and process.poll() is None:
        terminate_worker(process)
        status = {"state": "error", "message": "분석 제한 시간을 넘었습니다. 더 짧은 구간을 선택하세요."}
    elif process.poll() is not None and status["state"] == "running":
        status = {"state": "error", "message": "분석 작업이 종료되었습니다. ComfyUI 로그와 작업 로그를 확인하세요."}
    return status


def prune_jobs():
    for key, job in list(JOBS.items()):
        if time.monotonic() - job["created"] > JOB_TTL:
            if job["process"].poll() is None:
                terminate_worker(job["process"])
            shutil.rmtree(job["path"], ignore_errors=True)
            del JOBS[key]


def register_routes():
    from aiohttp import web
    import folder_paths
    from server import PromptServer

    server = PromptServer.instance
    if getattr(server, "_abc_audio_registered", False):
        return
    server._abc_audio_registered = True
    routes = server.routes
    models = Path(folder_paths.models_dir) / "abc_studio"

    async def expire_jobs(app):
        async def sweep():
            while True:
                await asyncio.sleep(60)
                prune_jobs()
        task = asyncio.create_task(sweep())
        yield
        task.cancel()
        stop_workers()

    server.app.cleanup_ctx.append(expire_jobs)

    @routes.get("/abc-studio/audio/status")
    async def capabilities(request):
        prune_jobs()
        missing = missing_dependencies()
        return web.json_response({"available": not missing, "missing": missing,
                                  "maxSeconds": MAX_SECONDS, "device": "cpu",
                                  "modelReady": (models / "hdemucs_high_trained.pt").is_file()})

    @routes.post("/abc-studio/audio/jobs")
    async def start(request):
        if missing_dependencies():
            return web.json_response({"error": "음원 분석 패키지가 없습니다. ABC Studio의 requirements.txt를 설치한 후 다시 시도하세요."}, status=503)
        async with LOCK:
            prune_jobs()
            if any(j["process"].poll() is None for j in JOBS.values()):
                return web.json_response({"error": "다른 음원을 분석 중입니다. 완료 후 다시 시도하세요."}, status=409)
            if request.content_length and request.content_length > MAX_UPLOAD:
                return web.json_response({"error": "음원 구간이 너무 큽니다. 최대 90초를 선택하세요."}, status=413)
            directory = Path(tempfile.mkdtemp(prefix="abc-studio-"))
            try:
                reader = await request.multipart()
                mode, size, found = "song", 0, False
                async for field in reader:
                    if field.name == "audio" and not found:
                        with (directory / "input.wav").open("wb") as output:
                            while chunk := await field.read_chunk():
                                size += len(chunk)
                                if size > MAX_UPLOAD:
                                    raise ValueError("음원 구간이 너무 큽니다. 최대 90초를 선택하세요.")
                                output.write(chunk)
                        found = True
                    elif field.name == "mode":
                        value = await field.read_chunk(size=8192)
                        if not field.at_eof():
                            raise ValueError("분석 방식 값이 너무 깁니다.")
                        mode = value.decode("utf-8")
                    else:
                        raise ValueError("지원하지 않는 요청 항목입니다.")
                if not found or mode not in ("song", "vocal"):
                    raise ValueError("분석할 음원과 올바른 분석 방식을 선택하세요.")
                with wave.open(str(directory / "input.wav"), "rb") as wav:
                    seconds = wav.getnframes() / wav.getframerate()
                    if (wav.getnchannels() not in (1, 2) or wav.getsampwidth() != 2
                            or wav.getframerate() != 44100 or not 0.2 <= seconds <= MAX_SECONDS + .05):
                        raise ValueError("0.2~90초의 음원 구간을 선택하세요.")
                (directory / "request.json").write_text(json.dumps({"mode": mode, "model_directory": str(models)}), encoding="utf-8")
                worker = Path(__file__).with_name("transcription_worker.py")
                kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {"start_new_session": True}
                with (directory / "worker.log").open("wb") as log:
                    process = subprocess.Popen([sys.executable, "-u", str(worker), str(directory)],
                                               stdout=log, stderr=log, **kwargs)
                job_id = uuid.uuid4().hex
                JOBS[job_id] = {"path": directory, "process": process, "created": time.monotonic()}
                return web.json_response({"id": job_id}, status=202)
            except (ValueError, wave.Error, EOFError, OSError, AssertionError) as exc:
                shutil.rmtree(directory, ignore_errors=True)
                return web.json_response({"error": str(exc)}, status=400)

    @routes.get("/abc-studio/audio/jobs/{job_id}")
    async def status(request):
        job = JOBS.get(request.match_info["job_id"])
        if not job:
            return web.json_response({"error": "분석 결과가 만료되었습니다. 다시 분석하세요."}, status=404)
        state = read_status(job)
        if state["state"] == "done":
            state["result"] = json.loads((job["path"] / "result.json").read_text(encoding="utf-8"))
        return web.json_response(state)

    @routes.get("/abc-studio/audio/jobs/{job_id}/vocals")
    async def vocals(request):
        job = JOBS.get(request.match_info["job_id"])
        if not job or read_status(job)["state"] != "done":
            raise web.HTTPNotFound()
        return web.FileResponse(job["path"] / "vocals.wav", headers={"Cache-Control": "no-store"})

    @routes.delete("/abc-studio/audio/jobs/{job_id}")
    async def cancel(request):
        async with LOCK:
            job = JOBS.pop(request.match_info["job_id"], None)
            if job:
                if job["process"].poll() is None:
                    await asyncio.to_thread(terminate_worker, job["process"])
                shutil.rmtree(job["path"], ignore_errors=True)
        return web.json_response({"state": "cancelled"})
