"""Add the pinned official SILK decoder to a STAGED runtime, then verify it offline.

Usage: python scripts/prepare-voice-runtime.py <staged-app-root> <official-wheel>
Does not download models, read chats, or call an ASR service.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import zipfile

WHEEL_NAME = 'silk_python-0.2.9-cp312-cp312-win_amd64.whl'
WHEEL_SHA256 = 'fcb8f1ae5bea0000e2d755fe29079a357e882d15952196d3b90d3a9f44c15646'
SELFTEST = '''import io, math, struct, pysilk
pcm = b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000))
encoded, decoded = io.BytesIO(), io.BytesIO()
pysilk.encode(io.BytesIO(pcm), encoded, 16000, 24000, tencent=True)
pysilk.decode(io.BytesIO(encoded.getvalue()), decoded, 16000)
assert len(encoded.getvalue()) > 20
assert 28000 <= len(decoded.getvalue()) <= 36000
assert any(decoded.getvalue())
print('SILK roundtrip OK; PCM bytes:', len(decoded.getvalue()))
'''


def safe_members(archive):
    files = []
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if path.is_absolute() or '..' in path.parts or '\\' in info.filename or ':' in info.filename:
            raise ValueError('unsafe wheel path')
        if not info.is_dir():
            files.append((path, archive.read(info)))
    return files


def prepare(root, wheel):
    root, wheel = Path(root).resolve(), Path(wheel).resolve()
    if wheel.name != WHEEL_NAME or hashlib.sha256(wheel.read_bytes()).hexdigest() != WHEEL_SHA256:
        raise ValueError('expected the pinned official CPython 3.12 Windows x64 wheel')
    runtime = root / 'runtime'
    python = runtime / 'python' / 'python.exe'
    if not python.is_file():
        raise ValueError('staged Windows runtime is missing')
    site = runtime / 'python' / 'Lib' / 'site-packages'
    with zipfile.ZipFile(wheel) as archive:
        files = safe_members(archive)
    # 仅新增缺失包；已有不同内容时交给完整构建，不静默覆盖第三方文件。
    for rel, data in files:
        target = site.joinpath(*rel.parts)
        if target.exists() and target.read_bytes() != data:
            raise ValueError('different installed decoder exists; rebuild runtime')
    for rel, data in files:
        target = site.joinpath(*rel.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    subprocess.run([str(python), '-B', '-c', SELFTEST], check=True, timeout=30)
    manifest_path = runtime / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    manifest.setdefault('packages', {})['silk-python'] = '0.2.9'
    manifest['voiceDecoder'] = {'wheel': WHEEL_NAME, 'sha256': WHEEL_SHA256, 'offlineRoundtrip': True}
    manifest.setdefault('sizes', {})['pythonMB'] = round(sum(p.stat().st_size for p in python.parent.rglob('*') if p.is_file()) / 1048576, 1)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return [str(Path('runtime/python/Lib/site-packages').joinpath(*p.parts)) for p, _ in files] + ['runtime/manifest.json']


if __name__ == '__main__':
    print(json.dumps({'files': prepare(*sys.argv[1:])}, ensure_ascii=False))
