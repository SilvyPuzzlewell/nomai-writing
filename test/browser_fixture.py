"""Ephemeral local server used only by browser-test.js."""
import os
import secrets
import sys
import tempfile
from pathlib import Path
from werkzeug.serving import make_server

os.environ.pop('TURSO_DATABASE_URL', None)
os.environ.pop('TURSO_AUTH_TOKEN', None)
os.environ['SECRET_KEY'] = secrets.token_hex(32)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

with tempfile.TemporaryDirectory(prefix='nomai-browser-db-') as directory:
    os.environ['DATABASE_PATH'] = directory + '/test.db'
    import app
    import database
    database.init_db()
    app._db_initialized = True
    owner = database.create_user('owner', 'nomai-test-password')
    reader = database.create_user('reader', 'nomai-test-password')
    database.send_friend_request(owner['id'], reader['id'])
    database.send_friend_request(reader['id'], owner['id'])
    thread = database.create_thread('Observatory notes', owner['id'])
    database.add_collaborator(thread['id'], reader['id'])
    root = database.create_message(thread['id'], None, 'owner', 'A note from the observatory.')
    child = database.create_message(thread['id'], root['id'], 'reader', 'A reply about the stars.')
    database.create_message(thread['id'], child['id'], 'owner', 'The hidden conclusion.')
    database.create_message(thread['id'], None, 'owner', 'Another line of inquiry.')
    database.create_thread('Empty wall', owner['id'])
    server = make_server('127.0.0.1', 0, app.app, threaded=True)
    print('FIXTURE_URL=http://127.0.0.1:' + str(server.server_port), flush=True)
    server.serve_forever()
