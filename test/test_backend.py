"""API regressions, using only a temporary local SQLite database."""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ.pop('TURSO_DATABASE_URL', None)
os.environ.pop('TURSO_AUTH_TOKEN', None)
os.environ['SECRET_KEY'] = 'test-only-private-key'
sys.path.insert(0, str(ROOT / 'backend'))
server = importlib.import_module('app')
database = importlib.import_module('database')


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='nomai-api-test-')
        self.addCleanup(self.tmp.cleanup)
        database.DATABASE_PATH = self.tmp.name + '/test.db'
        server._db_initialized = False
        server.app.config['TESTING'] = True
        self.owner = server.app.test_client()
        self.reader = server.app.test_client()
        self.owner_id = self.register(self.owner, 'owner')['id']
        self.reader_id = self.register(self.reader, 'reader')['id']
        self.thread = self.owner.post('/api/threads', json={'title': 'Private wall'}).json['id']
        self.root = self.message(self.owner, self.thread, None).json['id']

    def register(self, client, username):
        result = client.post('/api/auth/register', json={'username': username, 'password': 'test-password'})
        self.assertEqual(result.status_code, 201)
        return result.json

    def message(self, client, thread, parent, **extra):
        return client.post('/api/messages', json={
            'thread_id': thread, 'parent_id': parent, 'writer_name': 'writer', 'content': 'Message', **extra
        })

    def test_cross_thread_parent_rejected_even_when_both_threads_accessible(self):
        other = self.owner.post('/api/threads', json={'title': 'Other'}).json['id']
        result = self.message(self.owner, other, self.root)
        self.assertEqual(result.status_code, 400)
        self.assertEqual(self.owner.get(f'/api/threads/{other}').json['messages'], [])

    def test_private_parent_and_missing_parent_rejected(self):
        other = self.reader.post('/api/threads', json={'title': 'Readers wall'}).json['id']
        for parent in (self.root, 99999, '1', True):
            with self.subTest(parent=parent):
                self.assertEqual(self.message(self.reader, other, parent).status_code, 400)

    def test_valid_reply_cascades_within_thread(self):
        child = self.message(self.owner, self.thread, self.root).json['id']
        self.owner.post(f'/api/threads/{self.thread}/translations', json={'message_ids': [child]})
        self.assertEqual(self.owner.delete(f'/api/messages/{self.root}').status_code, 200)
        self.assertEqual(self.owner.get(f'/api/threads/{self.thread}').json['messages'], [])
        self.assertEqual(self.owner.get(f'/api/threads/{self.thread}/translations').json['translated'], [])

    def test_registration_does_not_claim_legacy_threads(self):
        orphan = database.create_thread('Legacy', None)['id']
        self.register(server.app.test_client(), 'newcomer')
        self.assertIsNone(database.get_thread_owner(orphan))
        result = server.app.test_cli_runner().invoke(args=['claim-legacy-threads', 'owner'])
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(database.get_thread_owner(orphan), self.owner_id)

    def test_import_resolves_arbitrary_message_order_and_keeps_seeds(self):
        result = self.owner.post('/api/threads/import', json={'title': 'Import', 'messages': [
            {'id': 30, 'parent_id': 20, 'content': 'grandchild'},
            {'id': 20, 'parent_id': 10, 'content': 'child', 'layout_data': json.dumps({'seed': 77})},
            {'id': 10, 'parent_id': None, 'content': 'root'}
        ]})
        self.assertEqual(result.status_code, 201)
        messages = {m['content']: m for m in result.json['messages']}
        self.assertEqual(messages['grandchild']['parent_id'], messages['child']['id'])
        self.assertEqual(messages['child']['parent_id'], messages['root']['id'])
        self.assertEqual(json.loads(messages['child']['layout_data'])['seed'], 77)
        self.assertEqual(json.loads(messages['root']['layout_data'])['seed'], 10)

    def test_invalid_import_is_atomic(self):
        cases = [
            [{'id': 1, 'parent_id': 2}],
            [{'id': 1, 'parent_id': 1}],
            [{'id': 1, 'parent_id': 2}, {'id': 2, 'parent_id': 1}],
            [{'id': 1}, {'id': 1}],
            [{'id': 1, 'layout_data': 'broken json'}],
            [{'id': 1, 'layout_data': {'userPrefs': {'branchT': 1.5}}}],
        ]
        for messages in cases:
            with self.subTest(messages=messages):
                before = len(self.owner.get('/api/threads').json)
                result = self.owner.post('/api/threads/import', json={'title': 'Invalid', 'messages': messages})
                self.assertEqual(result.status_code, 400)
                self.assertEqual(len(self.owner.get('/api/threads').json), before)

    def test_bad_layout_and_preferences_are_rejected(self):
        for layout in ('broken', {'overrides': {'lengthScale': -1}}, {'seed': True}):
            self.assertEqual(self.owner.put(f'/api/threads/{self.thread}/layouts', json={'layouts': {str(self.root): layout}}).status_code, 400)
        self.assertEqual(self.message(self.owner, self.thread, self.root, spiral_prefs={'branchT': 2}).status_code, 400)
        self.assertIsNone(self.owner.get(f'/api/threads/{self.thread}').json['messages'][0]['layout_data'])

    def test_unread_counts_are_per_user_and_collaborator_permissions_hold(self):
        database.add_collaborator(self.thread, self.reader_id)
        self.owner.post(f'/api/threads/{self.thread}/translations', json={'message_ids': [self.root]})
        self.assertEqual(self.owner.get('/api/threads').json[0]['unread_count'], 0)
        self.assertEqual(self.reader.get('/api/threads').json[0]['unread_count'], 1)
        self.assertEqual(self.reader.delete(f'/api/messages/{self.root}').status_code, 403)
        self.assertEqual(self.reader.delete(f'/api/threads/{self.thread}/layouts').status_code, 403)
        self.assertEqual(self.message(self.reader, self.thread, self.root).status_code, 201)
        self.assertEqual(self.owner.get('/api/threads').json[0]['unread_count'], 1)
        database.remove_collaborator(self.thread, self.reader_id)
        self.assertEqual(self.reader.get(f'/api/threads/{self.thread}').status_code, 403)

    def test_webhook_validation_and_clear(self):
        for webhook in ('https://example.invalid/?discord', 'https://discord.com.evil/api/webhooks/1/token',
                        'https://discord.com@localhost/api/webhooks/1/token', 'https://discord.com:443/api/webhooks/1/token',
                        'http://discord.com/api/webhooks/1/token', 'https://discord.com/api/webhooks/1/token?redirect=x'):
            self.assertEqual(self.reader.put('/api/auth/me/discord-webhook', json={'webhook': webhook}).status_code, 400)
        for webhook in ('https://discord.com/api/webhooks/123/test_token', ''):
            self.assertEqual(self.reader.put('/api/auth/me/discord-webhook', json={'webhook': webhook}).status_code, 200)

    def test_notification_revalidates_old_urls_and_sets_timeout_without_redirects(self):
        database.add_collaborator(self.thread, self.reader_id)
        database.set_user_discord_webhook(self.reader_id, 'https://example.invalid/?discord')
        with patch.object(server.urllib.request, 'build_opener') as build:
            self.owner.post(f'/api/threads/{self.thread}/notify-discord')
            build.return_value.open.assert_not_called()
        database.set_user_discord_webhook(self.reader_id, 'https://discord.com/api/webhooks/123/test_token')
        with patch.object(server.urllib.request, 'build_opener') as build:
            self.assertEqual(self.owner.post(f'/api/threads/{self.thread}/notify-discord').status_code, 200)
            self.assertEqual(build.return_value.open.call_args.kwargs['timeout'], 5)
            handler = build.call_args.args[0]
            self.assertIsNone(handler.redirect_request(None, None, 302, '', {}, 'https://example.invalid'))

    def test_missing_or_known_secret_fails_at_import(self):
        for key in ('', 'dev-secret-key-change-in-production', 'your-secret-key-here'):
            env = dict(os.environ, SECRET_KEY=key, DATABASE_PATH=self.tmp.name + '/unused.db')
            result = subprocess.run([sys.executable, '-c', 'import app'], cwd=ROOT / 'backend', env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Set a private SECRET_KEY', result.stderr)


if __name__ == '__main__':
    unittest.main()
