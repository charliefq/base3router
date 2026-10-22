#!/usr/bin/env python3
"""Single-owner Linux VM operator. No provisioning, login, or remote shell API."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import uuid

UNIT = 'b3r-personal-cloud.service'
PARTS = ('t3-home', 'provider-home', 'workspaces')
MARKER = '.b3r-personal-cloud-v1'


def safe_path(value):
    path = Path(value)
    if not path.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value):
        raise ValueError('Use an absolute path with letters, digits, dot, slash, hyphen, underscore only')
    if path != path.resolve() or str(path) in ('/', '/tmp', '/srv', str(Path.home())):
        raise ValueError('Use a dedicated canonical directory, without symlink ancestors')
    return path


def require_root(root):
    if not (root / MARKER).is_file():
        raise ValueError('Not an initialized personal-cloud root')
    for name in PARTS:
        if (root / name).is_symlink() or not (root / name).is_dir():
            raise ValueError(f'Missing or symlinked persistent directory: {name}')


def init(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError('Initialization requires an empty dedicated directory')
    root.chmod(0o700)
    (root / MARKER).write_text('1\n')
    for name in (*PARTS, 'releases', 'backups'):
        (root / name).mkdir(mode=0o700)
    (root / 'config.json').write_text(json.dumps({'node': '/usr/bin/node', 'port': 3773}, indent=2) + '\n')


@contextlib.contextmanager
def lock(root):
    require_root(root)
    with (root / 'runtime.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Runtime/maintenance lock held; stop this service before offline operations') from None
        yield stream


def config(root):
    data = json.loads((root / 'config.json').read_text())
    node = safe_path(data['node'])
    port = data['port']
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError('port must be an unprivileged TCP port')
    return node, port


def release(root):
    current = (root / 'current').resolve(strict=True)
    if current.parent != root / 'releases' or not re.fullmatch(r'[0-9a-f]{40}', current.name):
        raise ValueError('current must point to releases/<full commit SHA>')
    for file in ('apps/server/dist/bin.mjs', 'apps/server/dist/client/index.html', '.personal-cloud-build.json'):
        if not (current / file).is_file():
            raise ValueError(f'Incomplete release: {file}')
    receipt = json.loads((current / '.personal-cloud-build.json').read_text())
    if receipt['commit'] != current.name:
        raise ValueError('Build receipt does not match release directory')
    pending = root / '.restore-required-release'
    if pending.exists() and pending.read_text().strip() != current.name:
        raise ValueError('Activate the release recorded by restore before starting')
    return current


def run(root):
    # flock survives exec and covers Node plus its inherited provider children.
    with lock(root) as stream:
        node, port = config(root)
        current = release(root)
        env = {'PATH': f'{root}/provider-home/.local/bin:{node.parent}:/usr/local/bin:/usr/bin:/bin',
               'HOME': str(root / 'provider-home'), 'LANG': 'C.UTF-8',
               'T3CODE_HOME': str(root / 't3-home')}
        os.chdir(root / 'workspaces')
        os.set_inheritable(stream.fileno(), True)
        os.execve(node, [str(node), str(current / 'apps/server/dist/bin.mjs'),
                         '--base-dir', str(root / 't3-home'), '--host', '127.0.0.1',
                         '--port', str(port), '--no-browser'], env)


def unit(root):
    require_root(root)
    script = safe_path(str(Path(__file__).resolve()))
    return f'''[Unit]
Description=B3R personal single-owner environment
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 {script} --root {root} run
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=120
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
'''


def activate(root, sha):
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Use the full reviewed commit SHA')
    with lock(root):
        pending = root / '.restore-required-release'
        if pending.exists() and pending.read_text().strip() != sha:
            raise ValueError('Restore requires activation of its recorded release first')
        candidate = root / 'releases' / sha
        if not candidate.is_dir() or candidate.is_symlink():
            raise ValueError('Release checkout is missing')
        # Validate without changing the active pointer on failure.
        receipt = json.loads((candidate / '.personal-cloud-build.json').read_text())
        if receipt['commit'] != sha or not (candidate / 'apps/server/dist/client/index.html').is_file() or not (candidate / 'apps/server/dist/bin.mjs').is_file():
            raise ValueError('Incomplete release or mismatched build receipt')
        temporary = root / ('.current-' + uuid.uuid4().hex)
        temporary.symlink_to(candidate)
        temporary.replace(root / 'current')
        pending.unlink(missing_ok=True)


def assert_links(root):
    # Absolute links cannot be restored safely at a different root. External Git
    # worktrees / linked repositories must be consolidated by the owner first.
    for name in PARTS:
        for directory, dirs, files in os.walk(root / name, followlinks=False):
            for entry in (*dirs, *files):
                path = Path(directory) / entry
                if path.name == '.git' and path.is_file() and not path.is_symlink():
                    pointer = path.read_text().strip()
                    if pointer.startswith('gitdir:'):
                        gitdir = (path.parent / pointer[7:].strip()).resolve()
                        if not gitdir.is_relative_to(root / 'workspaces'):
                            raise ValueError(f'Backup refuses external Git directory: {path}')
                if path.is_symlink():
                    target = os.readlink(path)
                    if os.path.isabs(target) or not path.resolve().is_relative_to(root / name):
                        raise ValueError(f'Backup refuses absolute/external symlink: {path}')


def checksum(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def backup(root, destination):
    destination = Path(destination).resolve()
    if destination.exists() or Path(str(destination) + '.sha256').exists() or any(destination.is_relative_to(root / part) for part in PARTS):
        raise ValueError('Backup destination must be new and outside persistent directories')
    with lock(root):
        assert_links(root)
        with destination.open('xb') as output:
            os.chmod(destination, 0o600)
            with tarfile.open(fileobj=output, mode='w:gz', dereference=False) as archive:
                metadata = {'format': 1, 'root': str(root), 'release': release(root).name}
                with tempfile.TemporaryDirectory(dir=root) as scratch:
                    manifest = Path(scratch) / 'manifest.json'
                    manifest.write_text(json.dumps(metadata))
                    archive.add(manifest, arcname='manifest.json')
                for part in PARTS:
                    archive.add(root / part, arcname=part)
        digest = checksum(destination)
        with Path(str(destination) + '.sha256').open('x') as check:
            os.chmod(check.name, 0o600)
            check.write(digest + '\n')
    return digest


def restore(root, source):
    source = Path(source).resolve(strict=True)
    expected = Path(str(source) + '.sha256').read_text().strip()
    if checksum(source) != expected:
        raise ValueError('Backup checksum mismatch')
    with lock(root), tempfile.TemporaryDirectory(prefix='.restore-', dir=root) as scratch:
        staging = Path(scratch)
        with tarfile.open(source, 'r:gz') as archive:
            for member in archive.getmembers():
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in (*PARTS, 'manifest.json'):
                    raise ValueError('Unexpected archive path')
                # The data filter also checks resolved relative link targets.
                if member.issym() and os.path.isabs(member.linkname):
                    raise ValueError('Absolute archive symlink')
            archive.extractall(staging, filter='data')
        metadata = json.loads((staging / 'manifest.json').read_text())
        if metadata.get('format') != 1 or metadata.get('root') != str(root):
            raise ValueError('Restore requires the same absolute root (workspace paths are durable)')
        if not re.fullmatch(r'[0-9a-f]{40}', metadata.get('release', '')):
            raise ValueError('Invalid backup release')
        for part in PARTS:
            if not (staging / part).is_dir() or (staging / part).is_symlink():
                raise ValueError('Incomplete backup')
        # Retain the old data for an operator to recover; never overwrite it.
        (root / '.restore-required-release').write_text(metadata['release'] + '\n')
        retained = root / ('before-restore-' + uuid.uuid4().hex)
        retained.mkdir(mode=0o700)
        moved = []
        try:
            for part in PARTS:
                (root / part).rename(retained / part)
                moved.append(part)
                (staging / part).rename(root / part)
        except OSError:
            for part in reversed(moved):
                if (root / part).exists():
                    shutil.rmtree(root / part)
                (retained / part).rename(root / part)
            raise
    return {'retained': str(retained), 'required_release': metadata['release']}


def health(root):
    _, port = config(root)
    # Descriptor proves HTTP availability only; it does not exercise providers.
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/.well-known/t3/environment', timeout=5) as response:
        descriptor = json.load(response)
        if response.status != 200 or not isinstance(descriptor, dict) or 'environmentId' not in descriptor:
            raise ValueError('Invalid environment descriptor')
    return {'environmentId': descriptor['environmentId'],
            'status': 'HTTP reachable; provider execution and authenticated WSS not tested'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=safe_path)
    parser.add_argument('action', choices=('init', 'unit', 'run', 'start', 'stop', 'status', 'health', 'activate', 'backup', 'restore'))
    parser.add_argument('argument', nargs='?')
    args = parser.parse_args()
    root = args.root
    os.umask(0o077)
    if args.action == 'init':
        init(root)
        return
    require_root(root)
    if args.action in ('start', 'stop', 'status'):
        if args.action == 'start':
            release(root)
            config(root)
        installed = subprocess.check_output(
            ['systemctl', '--user', 'show', UNIT, '--property=ExecStart', '--value'], text=True)
        expected = f'{Path(__file__).resolve()} --root {root} run'
        if expected not in installed:
            raise ValueError('Installed unit belongs to a different operator script/root; refusing control')
        subprocess.run(['systemctl', '--user', args.action, UNIT], check=True)
    elif args.action == 'unit':
        print(unit(root))
    elif args.action == 'run':
        run(root)
    elif args.action == 'health':
        print(health(root))
    else:
        if not args.argument:
            parser.error('This action requires a SHA or archive path')
        result = globals()[args.action](root, args.argument)
        if result is not None:
            print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(str(error))
