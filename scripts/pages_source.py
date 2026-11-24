"""Select Actions publishing for this repository and handle a legacy build already in flight."""
import json
import os
import subprocess
import time


def gh(path, *args):
    result = subprocess.run(['gh', 'api', path, *args], text=True, capture_output=True, timeout=24)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-300:])
    return json.loads(result.stdout) if result.stdout.strip() else {}


def prepare():
    repo = 'repos/' + os.environ['GITHUB_REPOSITORY']
    mode = gh(repo + '/pages').get('build_type')
    print(f'GitHub Pages publishing mode is {mode}', flush=True)
    if mode == 'workflow':
        return
    if mode != 'legacy':
        raise ValueError('Unexpected Pages publishing mode')
    try:
        gh(repo + '/pages', '--method', 'PUT', '-f', 'build_type=workflow')
        print('GitHub Pages now reports publishing mode ' + gh(repo + '/pages')['build_type'], flush=True)
    except RuntimeError:
        print('Repository settings retain branch publishing; checking its deployment before the IDSS release.', flush=True)
    if os.environ.get('GITHUB_EVENT_NAME') != 'push':
        return
    # A branch build can already be queued when the setting switches. Publish the IDSS artifact last.
    head = os.environ['GITHUB_SHA']
    for i in range(30):
        runs = gh(repo + '/actions/runs?head_sha=' + head + '&per_page=100')['workflow_runs']
        legacy = [r for r in runs if 'dynamic/pages' in (r.get('path') or '') or r['name'].lower()=='pages build and deployment']
        if legacy and all(r['status']=='completed' for r in legacy):
            print('The branch build has finished.', flush=True)
            return
        if not legacy and i>=5:
            return
        time.sleep(5)
    raise RuntimeError('The existing Pages branch build has not finished yet')


if __name__ == '__main__':
    prepare()
