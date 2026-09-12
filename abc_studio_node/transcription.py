"""Local song-sample transcription. Heavy imports happen only in the worker."""
from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path
import urllib.request

MAX_SECONDS = 90
MODEL_NAME = "hdemucs_high_trained.pt"
MODEL_URL = "https://download.pytorch.org/torchaudio/models/" + MODEL_NAME
# SHA-256 of the official PyTorch asset, verified when integrating this model.
MODEL_SHA256 = "a004b2790d73ffeaa535db458a1a79b539dfdbafbccc31f275d07e632ebd7816"


def model_path(directory, progress=lambda *_: None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / MODEL_NAME
    if not target.exists():
        progress("보컬 분리 모델 받는 중 (최초 1회, 약 335 MB)", 3)
        partial = target.with_suffix(".part")
        with urllib.request.urlopen(MODEL_URL, timeout=60) as src, partial.open("wb") as dst:
            while chunk := src.read(1024 * 1024):
                dst.write(chunk)
        if file_hash(partial) != MODEL_SHA256:
            partial.unlink(missing_ok=True)
            raise ValueError("보컬 분리 모델 검증 실패. 다시 분석하면 다운로드를 재시도합니다.")
        partial.replace(target)
    if file_hash(target) != MODEL_SHA256:
        raise ValueError("보컬 분리 모델이 손상되었습니다. models/abc_studio의 모델 파일을 다시 설치하세요.")
    return target


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        while block := f.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def segment_notes(pitches, probabilities, hop_seconds, onsets=(), duration=None):
    """Preserve gaps and re-attacks; suppress isolated pitch jitter, not rests."""
    import numpy as np

    raw = np.asarray(pitches, dtype=float)
    clean = raw.copy()
    for i, value in enumerate(raw):
        if np.isfinite(value):
            w = raw[max(0, i - 2):i + 3]
            clean[i] = np.median(w[np.isfinite(w)])
    attack = {int(round(t / hop_seconds)) for t in onsets}
    notes, start, current = [], 0, None

    def finish(end):
        if current is None or (end - start) * hop_seconds < 0.05:
            return
        t0 = start * hop_seconds
        t1 = min(end * hop_seconds, duration) if duration is not None else end * hop_seconds
        if t1 <= t0:
            return
        notes.append({"pitch": current, "start": round(t0, 5), "duration": round(t1 - t0, 5),
                      "confidence": round(float(np.mean(probabilities[start:end])), 3)})

    for i, value in enumerate(clean):
        pitch = int(np.floor(value + 0.5)) if np.isfinite(value) else None
        reattack = i in attack and (i - start) * hop_seconds >= 0.09
        if pitch != current or (pitch is not None and reattack):
            finish(i)
            start, current = i, pitch
    finish(len(clean))
    return notes


def rising_onsets(onsets, energy, hop_seconds):
    """Reject spectral changes caused by releases rather than new attacks."""
    import numpy as np
    accepted = []
    for time in onsets:
        i = int(round(time / hop_seconds))
        before = energy[max(0, i - 4):i]
        after = energy[i:min(len(energy), i + 5)]
        if not len(after):
            continue
        low = float(np.median(before)) if len(before) else 0
        high = float(np.max(after))
        if high > max(low * 1.3, low + 0.01):
            accepted.append(float(time))
    return accepted


def separate_vocals(audio, sr, directory, progress):
    import numpy as np
    import torch
    import torchaudio

    progress("보컬 분리 준비 중", 5)
    path = model_path(directory, progress)
    # CPU isolation leaves ComfyUI's active GPU generation and model cache alone.
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    sources = ["drums", "bass", "other", "vocals"]
    model = torchaudio.models.hdemucs_high(sources=sources)
    model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
    model.eval()
    wave = torch.from_numpy(np.asarray(audio.T, dtype=np.float32).copy())
    if wave.shape[0] == 1:
        wave = wave.repeat(2, 1)
    if sr != 44100:
        wave = torchaudio.functional.resample(wave, sr, 44100)
    ref = wave.mean(0)
    mean, std = ref.mean(), ref.std().clamp_min(1e-6)
    wave = (wave - mean) / std
    # Overlap-add bounds memory and avoids hard seams between model windows.
    length, chunk, overlap = wave.shape[-1], 44100 * 10, 44100
    stride = chunk - overlap
    vocal = torch.zeros((2, length))
    weight = torch.zeros(length)
    starts = list(range(0, length, stride))
    with torch.inference_mode():
        for index, start in enumerate(starts):
            end = min(length, start + chunk)
            piece = wave[:, start:end]
            actual = piece.shape[-1]
            if actual < 44100:
                piece = torch.nn.functional.pad(piece, (0, 44100 - actual))
            pred = model(piece[None])[0, sources.index("vocals"), :, :actual]
            ramp = torch.ones(actual)
            fade = min(overlap, actual)
            if start:
                ramp[:fade] *= torch.linspace(0.001, 1, fade)
            if end < length:
                ramp[-fade:] *= torch.linspace(1, 0.001, fade)
            vocal[:, start:end] += pred * ramp
            weight[start:end] += ramp
            progress("보컬 분리 중", 10 + int(40 * (index + 1) / len(starts)))
    vocal = vocal / weight.clamp_min(1e-6) * std + mean
    return vocal.mean(0).numpy(), 44100


def transcribe(path, mode, model_directory, progress=lambda *_: None):
    import librosa
    import numpy as np
    import soundfile as sf

    progress("음원 확인 중", 1)
    info = sf.info(path)
    if not 0.2 <= info.duration <= MAX_SECONDS + 0.05 or info.channels not in (1, 2):
        raise ValueError("0.2~90초, 모노 또는 스테레오 음원 구간을 선택하세요.")
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    if not np.all(np.isfinite(audio)) or float(np.max(np.abs(audio))) < 1e-6:
        raise ValueError("선택한 구간에 분석할 소리가 없습니다.")
    mono = audio.mean(axis=1)
    if mode == "song":
        vocal, vocal_sr = separate_vocals(audio, sr, model_directory, progress)
    elif mode == "vocal":
        vocal, vocal_sr = mono, sr
    else:
        raise ValueError("지원하지 않는 분석 방식입니다.")
    sf.write(Path(path).with_name("vocals.wav"), vocal, vocal_sr, subtype="PCM_16")
    progress("원곡 템포 추정 중", 55)
    rhythm = librosa.resample(mono, orig_sr=sr, target_sr=22050)
    tempo, beats = librosa.beat.beat_track(y=rhythm, sr=22050, hop_length=256, units="time")
    bpm = float(np.asarray(tempo).reshape(-1)[0])
    tempo_valid = len(beats) >= 3 and math.isfinite(bpm) and 30 <= bpm <= 300
    progress("보컬 음높이와 반복음 분석 중", 65)
    y = librosa.resample(vocal, orig_sr=vocal_sr, target_sr=16000)
    peak = float(np.max(np.abs(y)))
    if peak < 1e-6:
        raise ValueError("보컬을 찾지 못했습니다. 노래하는 구간을 선택하거나 목소리만 있는 파일을 사용하세요.")
    y = y / peak * 0.8
    hop, frame = 160, 1024
    f0, voiced, probability = librosa.pyin(y, sr=16000, fmin=65, fmax=1100,
                                         frame_length=frame, hop_length=hop, resolution=0.2)
    # A short energy window preserves rests that the longer pitch frame straddles.
    rms = librosa.feature.rms(y=y, frame_length=320, hop_length=hop)[0]
    gate = max(0.003, float(np.max(rms)) * 0.025)
    good = voiced & (probability >= 0.12) & (rms[:len(f0)] >= gate)
    pitches = np.full(len(f0), np.nan)
    pitches[good] = librosa.hz_to_midi(f0[good])
    onsets = librosa.onset.onset_detect(y=y, sr=16000, hop_length=hop,
                                      backtrack=True, units="time", wait=8, delta=0.15)
    onsets = rising_onsets(onsets, rms, hop / 16000)
    notes = segment_notes(pitches, probability, hop / 16000, onsets, info.duration)
    if not notes:
        raise ValueError("안정적인 멜로디를 찾지 못했습니다. 보컬이 또렷한 다른 구간을 선택하세요.")
    warnings = ["자동 채보 초안입니다. 합창·강한 잔향·보컬 분리 흔적은 틀린 음을 만들 수 있습니다."]
    if not tempo_valid:
        warnings.append("템포를 확실히 찾지 못했습니다. BPM을 직접 입력하세요.")
    else:
        warnings.append("추정 BPM은 두 배·절반으로 잡힐 수 있습니다. 미리듣기로 확인하세요.")
    progress("미리듣기 준비 완료", 100)
    return {"notes": notes, "duration": info.duration, "bpm": round(bpm, 2) if tempo_valid else None,
            "beatOffset": round(float(beats[0]), 5) if tempo_valid else 0,
            "mode": mode, "warnings": warnings,
            "lowConfidenceNotes": sum(n["confidence"] < 0.5 for n in notes)}
