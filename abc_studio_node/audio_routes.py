"""Bounded, cancellable local transcription jobs for the score editor."""
from __future__ import annotations

import asyncio
import atexit
import json
import math
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

MAX_UPLOAD = 512 * 1024 * 1024
JOB_TTL = 6 * 60 * 60
JOBS = {}
CANCELLED = {}
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


def load_setup(path):
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        for field in ("python", "ffmpeg"):
            if not Path(config[field]).is_file():
                return None
        for field in ("model", "encoder"):
            if not (Path(config[field]) / "model.safetensors").is_file():
                return None
        return config
    except (OSError, ValueError, KeyError, TypeError):
        return None


def parse_options(fields):
    mode = fields.get("mode", "melody")
    start = float(fields.get("from", "0"))
    end = float(fields["to"]) if fields.get("to", "").strip() else None
    if mode not in ("melody", "full"):
        raise ValueError("SheetSage2 분석 방식을 선택하세요.")
    if not math.isfinite(start) or start < 0 or (end is not None and (not math.isfinite(end) or end-start < .2)):
        raise ValueError("분석 시작·종료 시간을 확인하세요.")
    return {"mode": mode, "from": start, "to": end}


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
    for key, created in list(CANCELLED.items()):
        if time.monotonic() - created > JOB_TTL:
            del CANCELLED[key]
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
    setup_path = Path(folder_paths.get_user_directory()) / "abc-studio" / "setup.json"

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
        ready = load_setup(setup_path) is not None
        return web.json_response({"available": ready, "engine": "SheetSage2",
                                  "maxSeconds": None, "maxUploadBytes": MAX_UPLOAD, "device": "cuda",
                                  "modelReady": ready})

    @routes.post("/abc-studio/audio/jobs")
    async def start(request):
        setup = load_setup(setup_path)
        if not setup:
            return web.json_response({"error": "SheetSage2 설치가 필요합니다. 최신 설치기를 실행한 후 다시 시도하세요."}, status=503)
        async with LOCK:
            prune_jobs()
            if any(j["process"].poll() is None for j in JOBS.values()):
                return web.json_response({"error": "다른 음원을 분석 중입니다. 완료 후 다시 시도하세요."}, status=409)
            if request.content_length and request.content_length > MAX_UPLOAD:
                return web.json_response({"error": "512 MB 이하의 음원 파일을 선택하세요."}, status=413)
            directory = Path(tempfile.mkdtemp(prefix="abc-studio-"))
            try:
                reader = await request.multipart()
                fields, size, found = {}, 0, False
                async for field in reader:
                    if field.name == "audio" and not found:
                        with (directory / "input.audio").open("wb") as output:
                            while chunk := await field.read_chunk():
                                size += len(chunk)
                                if size > MAX_UPLOAD:
                                    raise ValueError("512 MB 이하의 음원 파일을 선택하세요.")
                                output.write(chunk)
                        found = True
                    elif field.name in ("mode", "from", "to", "id") and field.name not in fields:
                        value = await field.read_chunk(size=8192)
                        if not field.at_eof():
                            raise ValueError("분석 방식 값이 너무 깁니다.")
                        fields[field.name] = value.decode("utf-8")
                    else:
                        raise ValueError("지원하지 않는 요청 항목입니다.")
                if not found or not size:
                    raise ValueError("분석할 음원과 올바른 분석 방식을 선택하세요.")
                options = parse_options(fields)
                job_id = uuid.UUID(fields["id"]).hex if fields.get("id") else uuid.uuid4().hex
                if job_id in CANCELLED or request.transport is None or request.transport.is_closing():
                    raise ValueError("분석을 취소했습니다.")
                if job_id in JOBS:
                    raise ValueError("이미 처리한 분석 요청입니다.")
                (directory / "request.json").write_text(json.dumps(dict(options, setup=setup)), encoding="utf-8")
                worker = Path(__file__).with_name("sheetsage_worker.py")
                kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {"start_new_session": True}
                with (directory / "worker.log").open("wb") as log:
                    process = subprocess.Popen([setup["python"], "-u", str(worker), str(directory)],
                                               stdout=log, stderr=log, **kwargs)
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

    @routes.get("/abc-studio/audio/jobs/{job_id}/files/{name}")
    async def artifact(request):
        job = JOBS.get(request.match_info["job_id"])
        if not job or read_status(job)["state"] != "done":
            raise web.HTTPNotFound()
        name = request.match_info["name"]
        allowed = {"original.wav": "original.wav", "vocal.wav": "vocal.wav", "instrumental.wav": "instrumental.wav",
                   "melody.wav": "melody.wav", "score.abc": "score/score.abc", "transcription.mid": "score/transcription.mid"}
        if name not in allowed:
            raise web.HTTPNotFound()
        return web.FileResponse(job["path"] / allowed[name], headers={"Cache-Control": "no-store"})

    @routes.delete("/abc-studio/audio/jobs/{job_id}")
    async def cancel(request):
        async with LOCK:
            try:
                job_id = uuid.UUID(request.match_info["job_id"]).hex
            except ValueError:
                raise web.HTTPNotFound()
            CANCELLED[job_id] = time.monotonic()
            job = JOBS.pop(job_id, None)
            if job:
                if job["process"].poll() is None:
                    await asyncio.to_thread(terminate_worker, job["process"])
                shutil.rmtree(job["path"], ignore_errors=True)
        return web.json_response({"state": "cancelled"})
