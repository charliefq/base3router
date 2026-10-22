"""Offline fixtures only; never start B3R or a provider."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('control', Path(__file__).with_name('control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
SHA = 'a' * 40
OTHER = 'b' * 40


class OperationsTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve() / 'runtime'
        control.init(self.root)
        for sha in (SHA, OTHER):
            release = self.root / 'releases' / sha
            (release / 'apps/server/dist/client').mkdir(parents=True)
            (release / 'apps/server/dist/bin.mjs').write_text('fixture')
            (release / 'apps/server/dist/client/index.html').write_text('fixture')
            (release / '.personal-cloud-build.json').write_text(json.dumps({'commit': sha}))
        control.activate(self.root, SHA)

    def test_offline_sqlite_attachments_workspace_and_provider_home_restore(self):
        state = self.root / 't3-home/userdata'
        state.mkdir()
        # An exited SQLite fixture leaves committed WAL, as after an unclean stop.
        subprocess.run([sys.executable, '-c', '''import os, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute('pragma journal_mode=wal')
db.execute('create table tasks (result text)')
db.execute("insert into tasks values ('fixture result')")
db.commit()
os._exit(0)
''', str(state / 'state.sqlite')], check=True)
        self.assertTrue((state / 'state.sqlite-wal').exists())
        (state / 'attachments').mkdir()
        (state / 'attachments/file.txt').write_text('fixture attachment')
        workspace = self.root / 'workspaces/project'
        workspace.mkdir()
        (workspace / 'work.txt').write_text('fixture workspace')
        (workspace / 'linked.txt').symlink_to('work.txt')
        (self.root / 'provider-home/fixture.txt').write_text('fixture CLI state')
        archive = self.root / 'backups/snapshot.tar.gz'
        control.backup(self.root, archive)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        (workspace / 'work.txt').write_text('changed')
        control.activate(self.root, OTHER)
        result = control.restore(self.root, archive)
        self.assertEqual(result['required_release'], SHA)
        self.assertEqual((Path(result['retained']) / 'workspaces/project/work.txt').read_text(), 'changed')
        with self.assertRaisesRegex(ValueError, 'Activate'):
            control.release(self.root)
        control.activate(self.root, SHA)
        with sqlite3.connect(state / 'state.sqlite') as db:
            self.assertEqual(db.execute('pragma integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('select result from tasks').fetchone()[0], 'fixture result')
        self.assertEqual((workspace / 'linked.txt').read_text(), 'fixture workspace')
        self.assertEqual((state / 'attachments/file.txt').read_text(), 'fixture attachment')
        self.assertEqual((self.root / 'provider-home/fixture.txt').read_text(), 'fixture CLI state')

    def test_lock_blocks_backup_restore_and_activation(self):
        archive = self.root / 'backups/fixture.tar.gz'
        control.backup(self.root, archive)
        # Separate process proves the service lock survives exec into Node's slot.
        with control.lock(self.root) as stream:
            os.set_inheritable(stream.fileno(), True)
            child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'],
                                     pass_fds=(stream.fileno(),), stdin=subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        try:
            for operation in (lambda: control.backup(self.root, self.root / 'backups/blocked.tar.gz'),
                              lambda: control.restore(self.root, archive),
                              lambda: control.activate(self.root, OTHER)):
                with self.assertRaisesRegex(ValueError, 'lock held'):
                    operation()
        finally:
            child.communicate(b'')
        control.activate(self.root, OTHER)

    def test_unsafe_restore_and_checksum_fail_before_data_swap(self):
        archive = self.root / 'backups/bad.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            member = tarfile.TarInfo('../escape')
            member.size = 4
            tar.addfile(member, io.BytesIO(b'nope'))
        Path(str(archive) + '.sha256').write_text(control.checksum(archive))
        with self.assertRaisesRegex(ValueError, 'archive path'):
            control.restore(self.root, archive)
        self.assertFalse((self.root.parent / 'escape').exists())
        Path(str(archive) + '.sha256').write_text('wrong')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            control.restore(self.root, archive)
        self.assertEqual(control.release(self.root).name, SHA)

    def test_external_links_and_existing_destination_refused(self):
        (self.root / 'workspaces/external').symlink_to('/tmp')
        archive = self.root / 'backups/fixture.tar.gz'
        with self.assertRaisesRegex(ValueError, 'symlink'):
            control.backup(self.root, archive)
        self.assertFalse(archive.exists())
        (self.root / 'workspaces/external').unlink()
        archive.touch()
        with self.assertRaisesRegex(ValueError, 'must be new'):
            control.backup(self.root, archive)

    def test_render_and_release_validation(self):
        unit = control.unit(self.root)
        self.assertIn('--root ' + str(self.root) + ' run', unit)
        self.assertIn('KillMode=mixed', unit)
        self.assertNotIn('tailscale', unit)
        with self.assertRaisesRegex(ValueError, 'empty'):
            control.init(self.root)
        (self.root / 'releases' / OTHER / '.personal-cloud-build.json').unlink()
        with self.assertRaises(FileNotFoundError):
            control.activate(self.root, OTHER)
        self.assertEqual(control.release(self.root).name, SHA)


if __name__ == '__main__':
    unittest.main()
