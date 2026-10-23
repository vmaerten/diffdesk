"""Task publication flow with fake external builders/validators and a fake gh.

Real archive/native verification is covered by task release:snapshot. These
fixtures exercise tag propagation, ordering and failure paths without GitHub writes.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ReleaseTask(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ghl-release-task-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['scripts', 'test', 'desktop', 'tools']:
            (self.root / name).mkdir()
        shutil.copyfile(ROOT / 'Taskfile.yml', self.root / 'Taskfile.yml')
        shutil.copyfile(ROOT / 'scripts/release-tag.ts', self.root / 'scripts/release-tag.ts')
        shutil.copyfile(ROOT / 'scripts/release-cask.ts', self.root / 'scripts/release-cask.ts')
        shutil.copyfile(ROOT / 'desktop/cask.rb', self.root / 'desktop/cask.rb')
        (self.root / 'package.json').write_text(json.dumps({'version': '1.2.3', 'type': 'module'}))
        (self.root / 'CHANGELOG.md').write_text('Fixture release notes\n')
        self.events = self.root / 'events.jsonl'
        self.env = {**os.environ, 'PATH': str(self.root / 'tools') + os.pathsep + os.environ['PATH'],
                    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
                    'GHL_TEST_EVENTS': str(self.events)}
        self.env.pop('RELEASE_TAG', None)
        self.env.pop('TAG', None)
        self.env.pop('RELEASE_REF', None)
        self.env.pop('HOMEBREW_TAP_TOKEN', None)
        self.tool('goreleaser', '''import hashlib
log('build', tag=os.environ['RELEASE_TAG'], args=sys.argv[1:])
if os.environ.get('GHL_TEST_BUILD_FAIL'): sys.exit(25)
version = os.environ['RELEASE_TAG'][1:]
folder = Path('go/dist/release')
folder.mkdir(parents=True)
metadata = {'version': version, 'tag': os.environ['RELEASE_TAG'], 'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()}
(folder / 'metadata.json').write_text(json.dumps(metadata))
name = f'ghl_{version}_darwin_arm64.zip'
(folder / name).write_bytes(b'fixture asset')
(folder / 'checksums.txt').write_text(hashlib.sha256(b'fixture asset').hexdigest() + '  ' + name + '\\n')
''')
        self.tool('gh', '''import hashlib
args = sys.argv[1:]
if args[0] == 'api':
    method = args[2] if args[1] == '--method' else 'GET'
    path = args[3] if args[1] == '--method' else args[1]
    log('api', method=method, path=path, args=args, token=os.environ.get('GH_TOKEN'))
    if path == 'repos/vmaerten/homebrew-tap':
        sys.exit(1 if os.environ.get('GHL_TEST_TAP_DENIED') else 0)
    if method == 'GET':
        if not os.environ.get('GHL_TEST_CASK_SHA'): sys.exit(1)
        print(os.environ['GHL_TEST_CASK_SHA'])
    elif os.environ.get('GHL_TEST_TAP_FAIL'): sys.exit(28)
    sys.exit(0)
log(args[1], args=args)
if args[:2] == ['release', 'create'] and os.environ.get('GHL_TEST_CREATE_FAIL'): sys.exit(26)
if args[:2] == ['release', 'download']:
    version = args[2][1:]
    folder = Path(args[args.index('--dir') + 1])
    (folder / 'checksums.txt').write_text(hashlib.sha256(b'fixture asset').hexdigest() + f'  ghl_{version}_darwin_arm64.zip\\n')
''')
        (self.root / 'desktop/release.py').write_text('''import json,os,sys
with open(os.environ['GHL_TEST_EVENTS'],'a') as f: f.write(json.dumps({'event':'verify','tag':os.environ['RELEASE_TAG']})+'\\n')
if os.environ.get('GHL_TEST_VERIFY_FAIL'): sys.exit(27)
if os.environ.get('GHL_TEST_TAMPER'):
    with open(f"go/dist/release/ghl_{os.environ['RELEASE_TAG'][1:]}_darwin_arm64.zip",'w') as f: f.write('tampered')
''')
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Release fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'release fixture')
        self.git('tag', 'v1.2.3')

    def tool(self, name, body):
        path = self.root / 'tools' / name
        path.write_text('''#!/usr/bin/env python3
import json,os,subprocess,sys
from pathlib import Path
def log(event, **fields):
    with open(os.environ['GHL_TEST_EVENTS'],'a') as f: f.write(json.dumps({'event':event,**fields})+'\\n')
''' + body)
        path.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, env=self.env, text=True)

    def run_release(self, *args, **env):
        result = subprocess.run(['task', 'release', *args], cwd=self.root, env={**self.env, **env}, capture_output=True, text=True, timeout=30)
        events = [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []
        return result, events

    def test_stable_release_builds_verifies_uploads_publishes_then_updates_the_cask(self):
        result, events = self.run_release(HOMEBREW_TAP_TOKEN='tap-token', GH_TOKEN='repo-token')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([e['event'] for e in events], ['build', 'verify', 'api', 'create', 'edit', 'download', 'api', 'api'])
        push = events[-1]
        self.assertEqual((push['method'], push['path'], push['token']), ('PUT', 'repos/vmaerten/homebrew-tap/contents/Casks/ghl.rb', 'tap-token'))
        self.assertEqual(events[3]['args'][:2], ['release', 'create'])
        cask = base64.b64decode(next(a for a in push['args'] if a.startswith('content=')).split('=', 1)[1]).decode()
        self.assertIn('version "1.2.3"', cask)
        self.assertIn(f'sha256 "{hashlib.sha256(b"fixture asset").hexdigest()}"', cask)
        self.assertFalse(any(a.startswith('sha=') for a in push['args']), 'a new cask has no previous blob')
        self.assertEqual(events[0]['tag'], 'v1.2.3')
        self.assertEqual(events[1]['tag'], 'v1.2.3')
        self.assertEqual(events[0]['args'], ['release', '--skip=publish', '--clean'])
        for flag in ['--draft', '--verify-tag', 'go/dist/release/ghl_1.2.3_darwin_arm64.zip', 'go/dist/release/checksums.txt']:
            self.assertIn(flag, events[3]['args'])
        self.assertIn('--draft=false', events[4]['args'])

    def test_workflow_tag_takes_precedence_over_the_head_tag(self):
        result, events = self.run_release(RELEASE_TAG='v1.2.4')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, [])

    def test_mismatched_tag_cannot_build_or_publish(self):
        result, events = self.run_release('TAG=v1.2.4')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, [])

    def test_failed_build_does_not_publish(self):
        result, events = self.run_release(GHL_TEST_BUILD_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([e['event'] for e in events], ['build'])

    def test_unreachable_tap_stops_before_publishing(self):
        result, events = self.run_release(GHL_TEST_TAP_DENIED='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('HOMEBREW_TAP_TOKEN', result.stderr)
        self.assertNotIn('create', [e['event'] for e in events])

    def test_failed_cask_push_leaves_the_release_published(self):
        result, events = self.run_release(GHL_TEST_TAP_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('edit', [e['event'] for e in events])
        self.assertEqual(events[-1]['method'], 'PUT')

    def test_existing_cask_is_replaced_in_place(self):
        result, events = self.run_release(GHL_TEST_CASK_SHA='previous-blob')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('sha=previous-blob', events[-1]['args'])

    def test_failed_validation_does_not_publish(self):
        result, events = self.run_release(GHL_TEST_VERIFY_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([e['event'] for e in events], ['build', 'verify'])

    def test_changed_asset_does_not_publish(self):
        result, events = self.run_release(GHL_TEST_TAMPER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('create', [e['event'] for e in events])

    def test_failed_upload_does_not_publish_draft(self):
        result, events = self.run_release(GHL_TEST_CREATE_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]['event'], 'create')
        self.assertNotIn('edit', [e['event'] for e in events])

    def test_manual_prerelease_is_marked(self):
        (self.root / 'package.json').write_text(json.dumps({'version':'1.2.3-rc.1', 'type':'module'}))
        self.git('add', 'package.json')
        self.git('commit', '-qm', 'prerelease fixture')
        self.git('tag', 'v1.2.3-rc.1')
        result, events = self.run_release('TAG=v1.2.3-rc.1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--prerelease', events[-2]['args'])
        self.assertNotIn('api', [e['event'] for e in events], 'a prerelease leaves the cask alone')


if __name__ == '__main__':
    unittest.main()
