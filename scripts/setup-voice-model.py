"""Install the pinned public Parakeet ONNX export; never download during a live turn."""
import hashlib
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request

assets = Path(sys.argv[1])
model = assets / "parakeet-unified-en-0.6b"
files = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
if all((model / name).is_file() for name in files):
    sys.exit(0)

package = "sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming"
url = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{package}.tar.bz2"
print("Downloading Parakeet Unified English 0.6B int8 (478 MiB), once…", flush=True)
with tempfile.TemporaryDirectory(prefix="parakeet-install-", dir=assets) as temporary:
    archive = Path(temporary) / "model.tar.bz2"
    urllib.request.urlretrieve(url, archive)
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != "99f63605b3a85a54c250c0869670a687b7d6598a47bf2421515e1f839a76e150":
        raise ValueError("Parakeet download checksum mismatch. Rerun setup to retry.")
    names = {f"{package}/{name}" for name in files}
    with tarfile.open(archive, "r|bz2") as source:
        source.extractall(temporary, members=(entry for entry in source if entry.name in names), filter="data")
    model.mkdir(exist_ok=True)
    for name in files:
        shutil.move(Path(temporary) / package / name, model / name)
print(f"Parakeet installed in {model}")
