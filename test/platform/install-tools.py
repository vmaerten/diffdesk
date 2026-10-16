"""Install verified validation tools in the disposable Linux test image."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tomllib
import urllib.request

architecture = sys.argv[1]
labels = {"arm64": "arm64", "amd64": "x64"}
label = labels[architecture]
go = tomllib.loads(Path("/tmp/mise.lock").read_text())["tools"]["go"][0]
platform = go[f"platforms.linux-{label}"]


def download(url, expected, destination):
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError(f"Checksum mismatch: {url}")


tar = Path("/tmp/go.tar.gz")
download(platform["url"], platform["checksum"].removeprefix("sha256:"), tar)
subprocess.run(["tar", "-xzf", str(tar), "-C", "/usr/local"], check=True)
tar.unlink()
# Official mise 2026.10.2 SHASUMS256.txt, matching the distribution acceptance gate.
checksums = {
    "arm64": "5d3368679ce0cc37fb222511a04c61426cded69f0cda0f8248d03970dc34f303",
    "amd64": "79a2bf0ffc9b8a9a6391344e875b3c3679c15053fda3e8728ddf1790d63db788",
}
tar = Path("/tmp/mise.tar.gz")
download(f"https://github.com/jdx/mise/releases/download/v2026.10.2/mise-v2026.10.2-linux-{label}.tar.gz", checksums[architecture], tar)
subprocess.run(["tar", "-xzf", str(tar), "--strip-components=2", "-C", "/usr/local/bin", "mise/bin/mise"], check=True)
tar.unlink()
