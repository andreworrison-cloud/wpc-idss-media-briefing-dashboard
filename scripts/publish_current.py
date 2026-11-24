"""Replace the IDSS-only current-data pointer after a complete public release is built."""
import base64
import os
from pathlib import Path
import subprocess

REPO = 'andreworrison-cloud/wpc-idss-media-briefing-dashboard'
REF = 'refs/heads/idss-public-current'
MARKER = 'Generated IDSS public data only, version 1\n'
FILES = {'board.json', 'handoff.json', 'idss-publication.txt'}


def publish():
    if os.environ['GITHUB_REPOSITORY'] != REPO:
        raise ValueError('Unrecognized publication repository')
    env = os.environ.copy()
    token = env.pop('IDSS_PUBLICATION_TOKEN')
    header = base64.b64encode(('x-access-token:'+token).encode()).decode()
    env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',
               GIT_CONFIG_VALUE_0='AUTHORIZATION: basic '+header,
               GIT_AUTHOR_NAME='github-actions[bot]', GIT_COMMITTER_NAME='github-actions[bot]',
               GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com',
               GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com')
    def git(*args, data=None):
        return subprocess.run(['git', *args], env=env, input=data, capture_output=True, check=True, timeout=45).stdout.decode().strip()
    remote = f'https://github.com/{REPO}.git'
    listing = git('ls-remote','--heads',remote,REF).split()
    previous = listing[0] if listing else ''
    if previous:
        git('fetch','--no-tags','--depth=1',remote,REF)
        if git('rev-parse','FETCH_HEAD') != previous:
            raise RuntimeError('The data pointer advanced during publication')
        if (set(git('ls-tree','--name-only',previous).splitlines()) != FILES or
                git('show',previous+':idss-publication.txt') != MARKER.strip() or
                git('show','-s','--format=%ae',previous) != env['GIT_AUTHOR_EMAIL']):
            raise ValueError('The destination contains user-managed content')
    contents = {name:(Path('_site/data')/name).read_bytes() for name in ('board.json','handoff.json')}
    contents['idss-publication.txt'] = MARKER.encode()
    entries = [f'100644 blob {git("hash-object","-w","--stdin",data=contents[name])}\t{name}\n' for name in sorted(contents)]
    tree = git('mktree',data=''.join(entries).encode())
    if previous and git('rev-parse',previous+'^{tree}')==tree:
        return
    # A single generated tree bounds storage. The lease protects concurrent publication.
    commit = git('commit-tree',tree,'-m','Publish current reviewed IDSS data')
    git('push','--force-with-lease='+REF+':'+previous,remote,commit+':'+REF)
    print('Current public IDSS data pointer verified at '+commit)


if __name__=='__main__':publish()
