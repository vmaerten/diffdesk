"""Small local comparison. Builds and Git fixtures stay in a temporary directory.

Run: python3 scripts/bench-runtime/run.py [--go-poc | --go]
The default minimal-prototype mode needs Rust as well as Node and Go.
Production modes need the corresponding built executable and frontend.
Uses Python standard library, Git and ps; no network downloads.
"""
import concurrent.futures
import base64
import datetime
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import select
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode, parse_qsl

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
REPEATS = 3
IDLE_SECONDS = 3


def command(args, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=True, **kwargs).strip()


def stats(pid):
    values = command(['/bin/ps', '-p', pid, '-o', 'rss=', '-o', 'time=']).split()
    minutes, seconds = values[1].split(':')
    return {'rss_mib': int(values[0]) / 1024, 'cpu_seconds': int(minutes) * 60 + float(seconds)}


def request(port, path):
    start = time.perf_counter()
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    try:
        conn.request('GET', path, headers={'Connection': 'close'})
        response = conn.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f'{path}: HTTP {response.status}: {body[:200]!r}')
        return (time.perf_counter() - start) * 1000, hashlib.sha256(body).hexdigest(), len(body)
    finally:
        conn.close()


def workload(port, path, count, concurrency, expected):
    start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        responses = list(pool.map(lambda _: request(port, path), range(count)))
    elapsed = time.perf_counter() - start
    if any((digest, size) != expected for _, digest, size in responses):
        raise RuntimeError(f'Response mismatch for {path}')
    latencies = sorted(item[0] for item in responses)
    return {'requests': count, 'concurrency': concurrency, 'p50_ms': statistics.median(latencies),
            'p95_ms': latencies[int((len(latencies) - 1) * .95)], 'requests_per_second': count / elapsed,
            'bytes': expected[1], 'response_sha256': expected[0]}


def measure(name, args, env, expected, asset_route, current=False, context_route=False, query=None, extra=False):
    start = time.perf_counter()
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=ROOT)
    try:
        if not select.select([proc.stdout], [], [], 20)[0]:
            raise RuntimeError(f'{name}: timed out waiting for startup')
        line = proc.stdout.readline().strip()
        if not line:
            raise RuntimeError(f'{name}: exited without a startup announcement')
        if current:
            info = json.loads(line)
            port = info['port']
            routes = {'health': '/api/health', 'asset': asset_route, 'diff': f"/r/{info['repoId']}/api/diff?{query or 'base=HEAD'}"}
        else:
            port = int(line)
            routes = {'health': '/health', 'asset': '/asset', 'diff': '/diff'}
        request(port, routes['health'])
        startup_ms = (time.perf_counter() - start) * 1000
        # Warm the process before idle and response-time measurements.
        for _ in range(10):
            request(port, routes['health'])
        for _ in range(3):
            request(port, routes['asset'])
            response = request(port, routes['diff'])
            if current:
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
                conn.request('GET', routes['diff'])
                payload = json.loads(conn.getresponse().read())
                conn.close()
                digest = hashlib.sha256(payload['patch'].encode()).hexdigest()
                if expected.get('diff') and digest != expected['diff'][0]:
                    raise RuntimeError('Real ghl patch differs from fixture git diff')
        if context_route:
            expandable = [f for f in payload['files'] if not f.get('binary') and not f.get('image')
                          and f.get('hash') and f['status'] != 'deleted']
            file = next((f for f in expandable if f['path'] == 'file-000.ts'), expandable[0])
            routes['context'] = f"/r/{info['repoId']}/api/diff-files?" + urlencode({
                **dict(parse_qsl(query or 'base=HEAD')),
                'path': file['path'], 'hash': file['hash'],
                'comparison': json.dumps(payload['comparison'], separators=(',', ':'))})
            for _ in range(3):
                request(port, routes['context'])
        if extra:
            routes['refs'] = f"/r/{info['repoId']}/api/refs"
            routes['commits'] = f"/r/{info['repoId']}/api/commits?{query}"
            image = next((f.get('image', {}).get('after', {}).get('url') for f in payload['files']
                          if f.get('image', {}).get('after', {}).get('url')), None)
            if image:
                routes['image'] = image
                expected['image'] = request(port, image)[1:]
            for key in ['refs', 'commits']:
                for _ in range(3):
                    request(port, routes[key])
        before_idle = stats(proc.pid)
        time.sleep(IDLE_SECONDS)
        idle = stats(proc.pid)
        results = {}
        tasks = [('health', 100), ('asset', 20), ('diff', 20)]
        if context_route:
            tasks.append(('context', 10))
        if extra:
            tasks.extend([('refs', 10), ('commits', 10)])
            if 'image' in routes:
                tasks.append(('image', 20))
        for key, count in tasks:
            route = routes[key]
            # Real app JSON includes more work and a different payload: measure separately.
            reference = (request(port, route)[1:]) if current else expected[key]
            if key == 'asset':
                reference = expected[key]
            results[key] = workload(port, route, count, 1, reference)
            results[key + '_c4'] = workload(port, route, count, 4, reference)
        loaded = stats(proc.pid)
        # Real health body contains stable process-specific metadata; patch body can vary
        # only if fixture/state changes, neither of which is allowed during the run.
        contract = {key: payload.get(key) for key in ['patch', 'files', 'totals', 'comparison', 'untracked', 'untrackedIncluded']} if query else None
        return {'runtime': name, 'startup_ms': startup_ms, 'idle_rss_mib': idle['rss_mib'],
                'after_load_rss_mib': loaded['rss_mib'],
                'idle_cpu_percent': (idle['cpu_seconds'] - before_idle['cpu_seconds']) / IDLE_SECONDS * 100,
                'server_load_cpu_seconds': loaded['cpu_seconds'] - idle['cpu_seconds'], 'workloads': results,
                **({'contract_sha256': hashlib.sha256(json.dumps(contract, sort_keys=True, ensure_ascii=False).encode()).hexdigest(), 'contract': contract} if contract else {})}
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        proc.stdout.close()
        proc.stderr.close()


def main():
    binaries = {name: os.environ.get('BENCH_' + name.upper()) or shutil.which(name) for name in ['node', 'go', 'rustc']}
    if not all(binaries.values()):
        raise RuntimeError('Requires node, go and rustc')
    assets = list((ROOT / 'web-dist' / 'assets').glob('*.js'))
    if not assets:
        raise RuntimeError('Build the Node reference frontend first: pnpm build:node')
    asset = max(assets, key=lambda path: path.stat().st_size)
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
               GIT_AUTHOR_NAME='Benchmark', GIT_AUTHOR_EMAIL='benchmark@example.invalid',
               GIT_COMMITTER_NAME='Benchmark', GIT_COMMITTER_EMAIL='benchmark@example.invalid')
    with tempfile.TemporaryDirectory(prefix='ghl-runtime-bench-') as temporary:
        temp = Path(temporary)
        env['GOCACHE'] = str(temp / 'go-cache')
        env['CGO_ENABLED'] = '0'
        env['GOTOOLCHAIN'] = 'local'
        subprocess.run([binaries['go'], 'build', '-trimpath', '-ldflags=-s -w', '-o', str(temp / 'go-server'), str(HERE / 'main.go')], env=env, check=True)
        subprocess.run([binaries['rustc'], '-C', 'opt-level=3', '-C', 'debuginfo=0', '-o', str(temp / 'rust-server'), str(HERE / 'main.rs')], env=env, check=True)
        if platform.system() == 'Darwin':
            # Use the system tool: rust-objcopy in this toolchain lacks libLLVM.
            subprocess.run(['/usr/bin/strip', str(temp / 'rust-server')], check=True)
        repo = temp / 'repo'
        repo.mkdir()
        command(['git', 'init', '-q', '-b', 'main', repo], env=env)
        original = ''.join(f'line {i}: const value = {i};\n' for i in range(200))
        for i in range(100):
            (repo / f'file-{i:03}.ts').write_text(original)
        command(['git', '-C', repo, 'add', '.'], env=env)
        command(['git', '-C', repo, 'commit', '-qm', 'fixture'], env=env)
        for i in range(100):
            (repo / f'file-{i:03}.ts').write_text(original.replace('const value =', 'const updated ='))
        env.update(BENCH_REPO=str(repo), BENCH_INDEX=str(ROOT / 'web-dist' / 'index.html'), BENCH_ASSET=str(asset))
        patch = subprocess.check_output(['git', '-C', str(repo), 'diff', '--no-ext-diff', '--no-color', 'HEAD'], env=env)
        expected = {key: (hashlib.sha256(body).hexdigest(), len(body)) for key, body in {
            'health': b'{"ok":true}\n', 'asset': asset.read_bytes(), 'diff': patch}.items()}
        commands = {'Node minimal': [binaries['node'], str(HERE / 'server.mjs')],
                    'Go minimal': [str(temp / 'go-server')], 'Rust minimal': [str(temp / 'rust-server')],
                    'ghl Node actuel': [binaries['node'], str(HERE / 'current.ts')]}
        report = {'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'platform': platform.platform(), 'architecture': platform.machine(),
                  'versions': {'node': command([binaries['node'], '--version']),
                               'go': command([binaries['go'], 'version']), 'rust': command([binaries['rustc'], '--version'])},
                  'fixture': {'files': 100, 'lines_per_file': 200, 'patch_bytes': len(patch),
                              'asset': str(asset.relative_to(ROOT)), 'asset_bytes': asset.stat().st_size},
                  'binary_bytes': {'go': (temp / 'go-server').stat().st_size, 'rust': (temp / 'rust-server').stat().st_size},
                  'idle_seconds': IDLE_SECONDS, 'repeats': REPEATS, 'runs': []}
        destination = ROOT / 'docs' / 'runtime-benchmark.json'
        destination.parent.mkdir(exist_ok=True)
        # Rotate order across rounds to reduce systematic first/last-run bias.
        names = list(commands)
        for repeat in range(REPEATS):
            for name in names[repeat:] + names[:repeat]:
                print(f'Round {repeat + 1}/{REPEATS}: {name}', flush=True)
                row = measure(name, commands[name], env, expected, '/' + str(asset.relative_to(ROOT / 'web-dist')), name == 'ghl Node actuel')
                row['round'] = repeat + 1
                report['runs'].append(row)
                destination.write_text(json.dumps(report, indent=2) + '\n')
                print(f"  RSS idle {row['idle_rss_mib']:.1f} MiB, after load {row['after_load_rss_mib']:.1f} MiB; git diff p50 {row['workloads']['diff']['p50_ms']:.2f} ms", flush=True)
        destination.write_text(json.dumps(report, indent=2) + '\n')
        print(f'Results: {destination}', flush=True)


def full_poc():
    """Full API comparison; minimal prototype results remain in their own report."""
    node = os.environ.get('BENCH_NODE') or shutil.which('node')
    go = os.environ.get('BENCH_GO') or shutil.which('go')
    binary = ROOT / 'poc/go/dist/ghl-go-poc'
    if not node or not go or not binary.is_file():
        raise RuntimeError('Requires Node, Go and pnpm poc:go:build')
    # Same bytes and URL in both builds. The entry bundle differs by capability.
    candidates = [p for p in (ROOT / 'web-dist/assets').glob('*.js')
                  if (ROOT / 'go/cmd/ghl-go-poc/assets/assets' / p.name).is_file()
                  and p.read_bytes() == (ROOT / 'go/cmd/ghl-go-poc/assets/assets' / p.name).read_bytes()]
    if not candidates:
        raise RuntimeError('Build both frontends before benchmarking')
    asset = max(candidates, key=lambda p: p.stat().st_size)
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
               GIT_AUTHOR_NAME='Benchmark', GIT_AUTHOR_EMAIL='benchmark@example.invalid',
               GIT_COMMITTER_NAME='Benchmark', GIT_COMMITTER_EMAIL='benchmark@example.invalid')
    with tempfile.TemporaryDirectory(prefix='ghl-go-poc-bench-') as temporary:
        repo = Path(temporary) / 'repo'
        repo.mkdir()
        command(['git', 'init', '-q', '-b', 'main', repo], env=env)
        original = ''.join(f'line {i}: const value = {i};\n' for i in range(200))
        for i in range(100):
            (repo / f'file-{i:03}.ts').write_text(original)
        command(['git', '-C', repo, '-c', 'core.hooksPath=/dev/null', 'add', '.'], env=env)
        command(['git', '-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], env=env)
        for i in range(100):
            (repo / f'file-{i:03}.ts').write_text(original.replace('const value =', 'const updated ='))
        env['BENCH_REPO'] = str(repo)
        patch = subprocess.check_output(['git', '-C', str(repo), 'diff', '--no-ext-diff', '--no-color', 'HEAD'], env=env)
        expected = {key: (hashlib.sha256(body).hexdigest(), len(body)) for key, body in {
            'asset': asset.read_bytes(), 'diff': patch}.items()}
        commands = {'ghl Node actuel': [node, str(HERE / 'current.ts')],
                    'ghl Go PoC': [str(binary), '--repo', str(repo), '--base', 'HEAD', '--no-open', '--json']}
        asset_bytes = lambda path: sum(p.stat().st_size for p in path.rglob('*') if p.is_file())
        report = {'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'platform': platform.platform(), 'architecture': platform.machine(),
                  'versions': {'node': command([node, '--version']), 'go': command([go, 'version'])},
                  'fixture': {'files': 100, 'lines_per_file': 200, 'patch_bytes': len(patch),
                              'asset': str(asset.relative_to(ROOT)), 'asset_bytes': asset.stat().st_size},
                  'binary_bytes': {'go_poc_with_assets': binary.stat().st_size},
                  'frontend_bytes': {'node': asset_bytes(ROOT / 'web-dist'), 'go_poc': asset_bytes(ROOT / 'go/cmd/ghl-go-poc/assets')},
                  'idle_seconds': IDLE_SECONDS, 'repeats': REPEATS, 'runs': []}
        destination = ROOT / 'docs/go-poc-benchmark.json'
        names = list(commands)
        for repeat in range(REPEATS):
            for name in names[repeat:] + names[:repeat]:
                print(f'Round {repeat + 1}/{REPEATS}: {name}', flush=True)
                row = measure(name, commands[name], env, expected,
                              '/' + str(asset.relative_to(ROOT / 'web-dist')), True, True)
                row['round'] = repeat + 1
                report['runs'].append(row)
                destination.parent.mkdir(exist_ok=True)
                destination.write_text(json.dumps(report, indent=2) + '\n')
                print(f"  RSS idle {row['idle_rss_mib']:.1f} MiB, after load {row['after_load_rss_mib']:.1f} MiB; API diff p50 {row['workloads']['diff']['p50_ms']:.2f} ms", flush=True)
        print(f'Results: {destination}', flush=True)


def production():
    """Full maintained runtime; retain both earlier prototype reports unchanged."""
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('Initial supported benchmark target: macOS ARM64')
    node = os.environ.get('BENCH_NODE') or shutil.which('node')
    go = os.environ.get('BENCH_GO') or shutil.which('go')
    binary = Path(os.environ.get('BENCH_GHL_GO', ROOT / 'go/dist/ghl')).resolve()
    if not node or not go or not binary.is_file():
        raise RuntimeError('Requires Node, Go, pnpm build:node and task build')
    embedded = ROOT / 'go/cmd/ghl/assets/assets'
    candidates = [p for p in (ROOT / 'web-dist/assets').glob('*.js')
                  if (embedded / p.name).is_file() and p.read_bytes() == (embedded / p.name).read_bytes()]
    if not candidates:
        raise RuntimeError('Build both production frontends before benchmarking')
    asset = max(candidates, key=lambda p: p.stat().st_size)
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GHL_PORT='',
               GIT_AUTHOR_NAME='Benchmark', GIT_AUTHOR_EMAIL='benchmark@example.invalid',
               GIT_COMMITTER_NAME='Benchmark', GIT_COMMITTER_EMAIL='benchmark@example.invalid',
               GIT_AUTHOR_DATE='2020-01-01T00:00:00Z', GIT_COMMITTER_DATE='2020-01-01T00:00:00Z')
    report = {'complete': False, 'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'platform': platform.platform(), 'architecture': platform.machine(),
              'source_commit': command(['git', 'rev-parse', 'HEAD']),
              'source_dirty': bool(command(['git', 'status', '--porcelain', '--untracked-files=no'])),
              'versions': {'node': command([node, '--version']), 'go': command([go, 'version']),
                           'git': command(['git', '--version']),
                           'python': platform.python_version(),
                           'ghl': json.loads(command([binary, '--version', '--json']))},
              'hardware': {'model': command(['/usr/sbin/sysctl', '-n', 'hw.model']),
                           'logical_cpus': int(command(['/usr/sbin/sysctl', '-n', 'hw.logicalcpu'])),
                           'memory_bytes': int(command(['/usr/sbin/sysctl', '-n', 'hw.memsize']))},
              'binary_bytes': {'go_with_assets': binary.stat().st_size,
                               'node_runtime_only': Path(command([node, '-p', 'process.execPath'])).stat().st_size},
              'frontend_bytes': {'node': sum(p.stat().st_size for p in (ROOT / 'web-dist').rglob('*') if p.is_file())},
              'asset': str(asset.relative_to(ROOT)), 'asset_bytes': asset.stat().st_size,
              'measurement_scope': 'Server PID only: child Git processes, browser, clients and build tools excluded. Foreground production Go; in-process production Node server.',
              'idle_seconds': IDLE_SECONDS, 'repeats': REPEATS, 'fixtures': [], 'runs': []}
    destination = Path(os.environ.get('BENCH_OUTPUT', ROOT / 'docs/go-runtime-benchmark.json'))
    destination.parent.mkdir(parents=True, exist_ok=True)
    (ROOT / '.task/benchmark-mismatch.json').unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='ghl-production-bench-') as temporary:
        fixtures = []
        for label, count in [('large-tracked', 100), ('mixed', 12)]:
            # The Node server API expects the resolved root; Go's CLI resolves it.
            # macOS /var and /private/var aliases must identify the same fixture.
            repo = Path(temporary).resolve() / label
            repo.mkdir()
            def git(*args):
                return command(['git', '-C', repo, '-c', 'core.hooksPath=/dev/null',
                                '-c', 'commit.gpgsign=false', *args], env=env)
            git('init', '-q', '-b', 'main')
            git('config', 'core.quotepath', 'false')
            original = ''.join(f'line {i}: const value = {i};\n' for i in range(200))
            for i in range(count):
                (repo / f'file-{i:03}.ts').write_text(original)
            if label == 'mixed':
                (repo / 'old name.ts').write_text(original)
                (repo / 'deleted.ts').write_text(original)
                (repo / 'changed.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="red"/></svg>')
                png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=')
                (repo / 'pixel.png').write_bytes(png + bytes(300))
            git('add', '.')
            git('commit', '-qm', 'base')
            git('checkout', '-qb', 'feature')
            for i in range(count):
                changed = original.replace('const value =', 'const updated =') if label == 'large-tracked' else original.replace('line 10:', 'committed 10:')
                (repo / f'file-{i:03}.ts').write_text(changed)
            if label == 'mixed':
                git('mv', 'old name.ts', 'renamed café.ts')
                git('rm', '-q', 'deleted.ts')
                (repo / 'added.ts').write_text('new file\n')
                (repo / 'pixel.png').write_bytes(png + bytes(400))
                (repo / 'changed.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="blue"/></svg>')
            git('add', '.')
            git('commit', '-qm', 'review')
            if label == 'mixed':
                file = repo / 'file-000.ts'
                file.write_text(file.read_text().replace('line 80:', 'staged 80:'))
                git('add', 'file-000.ts')
                file.write_text(file.read_text().replace('line 150:', 'unstaged 150:'))
                (repo / 'untracked café.ts').write_text('untracked code\n')
                (repo / 'untracked.png').write_bytes(png)
                (repo / 'opaque.bin').write_bytes(b'\0binary')
                scopes = [('mixed-checkout', 'base=main&untracked=1'),
                          ('mixed-ref', 'base=main&target=feature'),
                          ('mixed-commit', 'base=main&commit=' + git('rev-parse', 'HEAD'))]
            else:
                scopes = [(label, 'base=main')]
            for scenario, query in scopes:
                fixtures.append((scenario, repo, query))
                report['fixtures'].append({'name': scenario, 'query': query, 'tracked_text_files': count,
                                           'lines_per_file': 200, 'includes_images': label == 'mixed',
                                           'includes_checkout_edits_and_untracked': scenario == 'mixed-checkout'})
        contracts = {}
        for repeat in range(REPEATS):
            for scenario, repo, query in fixtures:
                commands = {'ghl Node': [node, str(HERE / 'current.ts')],
                            'ghl Go': [str(binary), '--repo', str(repo), '--base', 'main', '--no-daemon', '--port', '0', '--no-open', '--json']}
                names = list(commands)
                if repeat % 2:
                    names.reverse()
                expected = {'asset': (hashlib.sha256(asset.read_bytes()).hexdigest(), asset.stat().st_size)}
                if scenario == 'large-tracked':
                    patch = subprocess.check_output(['git', '-C', str(repo), 'diff', '--no-ext-diff', '--no-color', 'main'], env=env)
                    expected['diff'] = (hashlib.sha256(patch).hexdigest(), len(patch))
                for name in names:
                    print(f'Round {repeat + 1}/{REPEATS}: {scenario}, {name}', flush=True)
                    row = measure(name, commands[name], dict(env, BENCH_REPO=str(repo)), expected.copy(),
                                  '/' + str(asset.relative_to(ROOT / 'web-dist')), True, True, query, True)
                    signature = (row['contract_sha256'], row['workloads'].get('image', {}).get('response_sha256'))
                    contract = row.pop('contract')
                    if scenario in contracts and contracts[scenario][0] != signature:
                        diagnostic = ROOT / '.task/benchmark-mismatch.json'
                        diagnostic.parent.mkdir(exist_ok=True)
                        diagnostic.write_text(json.dumps({'fixture': scenario, 'expected': contracts[scenario][1],
                                                         'actual': contract}, indent=2) + '\n')
                        raise RuntimeError(f'Node/Go contract or image bytes differ: {scenario}; see {diagnostic}')
                    contracts[scenario] = (signature, contract)
                    row.update(round=repeat + 1, fixture=scenario)
                    report['runs'].append(row)
                    destination.write_text(json.dumps(report, indent=2) + '\n')
                    print(f"  RSS warm {row['idle_rss_mib']:.1f} MiB, loaded {row['after_load_rss_mib']:.1f} MiB; diff p50 {row['workloads']['diff']['p50_ms']:.2f} ms", flush=True)
        report['complete'] = True
        destination.write_text(json.dumps(report, indent=2) + '\n')
        print(f'Results: {destination}', flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--go-poc']:
        full_poc()
    elif sys.argv[1:] == ['--go']:
        production()
    elif not sys.argv[1:]:
        main()
    else:
        raise SystemExit('Usage: run.py [--go-poc | --go]')
