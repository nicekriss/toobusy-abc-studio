"""Install the official transcriber without changing ComfyUI's Python packages."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()


def download(url, path, expected):
    if path.is_symlink():
        raise RuntimeError(f'Refusing linked destination: {path}')
    if path.is_file():
        if sha256(path) == expected:
            return
        raise RuntimeError(f'Existing file differs; preserved for review: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix+'.part')
    print('Download:', path.name, flush=True)
    with urllib.request.urlopen(url, timeout=120) as source, partial.open('wb') as output:
        shutil.copyfileobj(source, output, 1024*1024)
    if sha256(partial) != expected:
        raise RuntimeError(f'Download checksum mismatch: {path.name}')
    partial.replace(path)


def run(command, capture=False):
    options = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
    return subprocess.run([str(x) for x in command], check=True, text=True, encoding='utf-8',
                          capture_output=capture, env=dict(os.environ, PYTHONUTF8='1'), **options)


def python311(state, manifest):
    if sys.version_info[:2] == (3,11):
        return Path(sys.executable)
    if shutil.which('py'):
        try:
            result = run(['py','-3.11','-c','import sys; print(sys.executable)'], capture=True)
            path = Path(result.stdout.strip())
            if path.is_file(): return path
        except subprocess.CalledProcessError:
            pass
    base = state / 'python311'
    python = base / 'python' / 'python.exe'
    if python.is_file(): return python
    archive = state / 'python311.tar.gz'
    download(manifest['python']['url'], archive, manifest['python']['sha256'])
    with tempfile.TemporaryDirectory(dir=state, prefix='python-stage-') as temporary:
        stage = Path(temporary)
        with tarfile.open(archive, 'r:gz') as source:
            for entry in source.getmembers():
                target = (stage / entry.name).resolve()
                if not target.is_relative_to(stage.resolve()) or not (entry.isfile() or entry.isdir()):
                    raise RuntimeError('Unsafe Python archive member')
                if entry.isdir(): target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.extractfile(entry) as data, target.open('wb') as output:
                        shutil.copyfileobj(data, output)
        if not (stage/'python'/'python.exe').is_file():
            raise RuntimeError('Python archive is incomplete')
        if base.exists(): raise RuntimeError(f'Incomplete Python directory: {base}')
        stage.rename(base)
    return python


def verify_models(root, manifest):
    for model in manifest['models']:
        for file in model['files']:
            path = root / model['name'] / file['name']
            if not path.is_file() or path.is_symlink() or sha256(path) != file['sha256']:
                raise RuntimeError(f'SheetSage2 model check failed: {path}')


def check_runtime(python):
    source = '''import json,sys,torch,torchaudio,transformers,numpy,scipy,mir_eval,pretty_midi
assert sys.version_info[:2] == (3,11)
assert sys.prefix != sys.base_prefix
assert torch.__version__.split('+')[0] == '2.8.0'
assert torchaudio.__version__.split('+')[0] == '2.8.0'
assert transformers.__version__ == '4.45.2'
assert torch.cuda.is_available(), 'NVIDIA CUDA unavailable'
print(json.dumps({'torch':torch.__version__,'gpu':torch.cuda.get_device_name(0)}))'''
    print(run([python,'-c',source], capture=True).stdout.strip(), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--comfyui', type=Path, required=True)
    parser.add_argument('--models', type=Path)
    parser.add_argument('--user-directory', type=Path)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'win32' or platform.machine().lower() not in ('amd64','x86_64'):
        raise RuntimeError('This installer supports 64-bit Windows with NVIDIA GPU.')
    comfy = args.comfyui.resolve()
    if not (comfy/'main.py').is_file(): raise RuntimeError('Select the ComfyUI folder containing main.py')
    state = (args.user_directory or comfy/'user').resolve() / 'abc-studio'
    state.mkdir(parents=True, exist_ok=True)
    config_path = state / 'setup.json'
    manifest = json.loads((HERE/'sheetsage-models.json').read_text(encoding='utf-8'))
    if args.check_only:
        config = json.loads(config_path.read_text(encoding='utf-8'))
        check_runtime(config['python'])
        verify_models(Path(config['model']).parent, manifest)
        run([config['ffmpeg'],'-version'], capture=True)
        print('SHEETSAGE2 VERIFIED', flush=True)
        return
    runtime = state/'runtime'
    python = runtime/'Scripts'/'python.exe'
    marker = runtime/'.abc-studio-runtime'
    if runtime.exists() and not marker.is_file():
        raise RuntimeError(f'Unrecognized runtime preserved: {runtime}')
    if not python.is_file():
        if runtime.exists(): raise RuntimeError(f'Incomplete runtime preserved: {runtime}')
        run([python311(state, manifest),'-m','venv',runtime])
        marker.write_text('SheetSage2 isolated runtime\n',encoding='utf-8')
    if 'include-system-site-packages = false' not in (runtime/'pyvenv.cfg').read_text().lower():
        raise RuntimeError('SheetSage2 runtime must not share ComfyUI packages')
    run([python,'-m','pip','install','torch==2.8.0','torchaudio==2.8.0','--index-url','https://download.pytorch.org/whl/cu126','--disable-pip-version-check'])
    run([python,'-m','pip','install','-r',HERE/'requirements-sheetsage.txt','--disable-pip-version-check'])
    check_runtime(python)
    models = (args.models or comfy/'models').resolve()/'abc_studio'
    for model in manifest['models']:
        for file in model['files']:
            url = f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/{file['name']}"
            download(url, models/model['name']/file['name'], file['sha256'])
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        ffmpeg = run([python,'-c','import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],capture=True).stdout.strip()
    run([ffmpeg,'-version'], capture=True)
    config = {'engine':'SheetSage2','python':str(python),'model':str(models/'SheetSage2'),
              'encoder':str(models/'MERT-v2-FullSong'),'ffmpeg':ffmpeg,
              'revision':manifest['models'][0]['revision']}
    temporary = config_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(config,indent=2),encoding='utf-8')
    temporary.replace(config_path)
    print('SHEETSAGE2 INSTALLED — restart ComfyUI', flush=True)


if __name__ == '__main__':
    main()
