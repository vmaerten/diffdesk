"""Concurrent cold launches (#136): every review requested while the app starts opens once."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

from smoke import BINARY, Collector, fixture

ROUNDS = 3


def running(binary):
    return subprocess.run(['pgrep', '-f', f'{binary} --desktop-window'], capture_output=True).returncode == 0


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Collector)
    server.events = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    binary = BINARY.resolve()
    with tempfile.TemporaryDirectory(prefix='ghl-cold-') as directory:
        folder = Path(directory).resolve()
        first, second = folder / 'first', folder / 'second'
        fixture(first, True)
        fixture(second, False)
        # The probe's path isolates this app from the user's; it only reports what opened.
        probe = folder / 'probe.js'
        probe.write_text(f'''setInterval(async () => {{
  const health = await (await fetch('/api/health')).json()
  fetch('http://127.0.0.1:{server.server_port}/', {{method: 'POST', body: JSON.stringify({{
    phase: 'opened', pid: health.pid, repos: health.repos.length,
    tabs: document.querySelectorAll('[role="tab"]').length,
  }})}})
}}, 250)
''')
        env = {**os.environ, 'GHL_DESKTOP_PROBE': str(probe), 'GHL_DESKTOP_SETTINGS': str(folder / 'settings.json'), 'GHL_DESKTOP_TABS': '1'}
        # The app started through LaunchServices never sees the launcher's TMPDIR.
        env.pop('TMPDIR', None)
        try:
            for round in range(1, ROUNDS + 1):
                assert not running(binary), 'A previous app is still running'
                server.events.clear()
                # Two distinct reviews and a duplicate, all before the first window is up.
                launchers = [subprocess.Popen([str(binary), '--repo', str(repo), '--base', 'HEAD'], env=env,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                             for repo in [first, second, first]]
                for launcher in launchers:
                    assert launcher.wait(timeout=30) == 0, launcher.stderr.read()
                deadline = time.monotonic() + 30
                state = None
                while time.monotonic() < deadline:
                    state = server.events[-1] if server.events else None
                    if state and state['repos'] == 2 and state['tabs'] == 2:
                        break
                    time.sleep(.2)
                assert state and state['repos'] == 2 and state['tabs'] == 2, f'round {round}: {state}'
                assert len({event['pid'] for event in server.events}) == 1, 'More than one app answered'
                subprocess.run(['pkill', '-TERM', '-f', f'{binary} --desktop-window'], check=True)
                for _ in range(75):
                    if not running(binary):
                        break
                    time.sleep(.2)
            print(json.dumps({'complete': True, 'rounds': ROUNDS, 'check': 'concurrent cold launches open every review once'}))
        finally:
            subprocess.run(['pkill', '-KILL', '-f', f'{binary} --desktop-window'])
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
