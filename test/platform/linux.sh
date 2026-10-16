#!/usr/bin/env bash
set -euo pipefail

# The input and shared Git metadata are read-only mounts. Tests mutate only a clone.
git config --global --add safe.directory '*'
checkout=$(mktemp -d /tmp/ghl-platform.XXXXXX)
git clone --quiet --no-local --single-branch /input "$checkout"
# Include current tracked edits and new source files when testing a local snapshot.
git -C /input ls-files -z --cached --others --exclude-standard |
  tar -C /input --null -T - -cf - | tar -C "$checkout" -xf -
cp -R /input/go/cmd/ghl/assets "$checkout/go/cmd/ghl/"
mkdir -p "$checkout/go/dist"
cp -R /input/go/dist/release "$checkout/go/dist/"
cd "$checkout"
python3 - <<'REPORT'
import json, platform
from pathlib import Path
Path('/results/validation.json').write_text(json.dumps({'complete': False, 'kernel': platform.platform(), 'machine': platform.machine()}, indent=2) + '\n')
REPORT
pnpm install --frozen-lockfile > /results/install.log 2>&1
go -C go vet ./... > /results/vet.log 2>&1
go -C go test -race ./... > /results/go-race.log 2>&1
node test/releaseGuards.ts > /results/guards.log 2>&1
node test/goAcceptance.ts > /results/acceptance.log 2>&1
node test/goMise.ts > /results/mise.log 2>&1
platform_target=$(node --input-type=module -e "import {releaseTarget} from './test/releaseTarget.ts'; console.log(releaseTarget())")
cp ".task/go-mise-acceptance-${platform_target}.json" /results/go-mise-acceptance.json
node --input-type=module - <<'REPORT'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { releaseTarget } from './test/releaseTarget.ts'
const report = JSON.parse(readFileSync('/results/validation.json', 'utf8'))
const metadata = JSON.parse(readFileSync('go/dist/release/metadata.json', 'utf8'))
Object.assign(report, { complete: true, target: releaseTarget(), commit: metadata.commit,
  node: process.version, go: execFileSync('go', ['version'], { encoding: 'utf8' }).trim(),
  browser: execFileSync(process.env.CHROME_PATH, ['--version'], { encoding: 'utf8' }).trim(),
  engine_arch: process.env.GHL_TEST_ENGINE_ARCH,
  execution: ({ aarch64: 'arm64', x86_64: 'amd64' }[process.env.GHL_TEST_ENGINE_ARCH] ?? process.env.GHL_TEST_ENGINE_ARCH) === releaseTarget().split('_')[1] ? 'native-virtualized' : 'translated-virtualized',
  checks: ['Go vet', 'Go race tests', 'release rejection guards', 'archive CLI/API/daemon/browser acceptance', 'mise install/upgrade/rollback and asset selection'] })
writeFileSync('/results/validation.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
REPORT
