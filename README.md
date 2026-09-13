# Nomai Thread Viewer

Threaded conversations rendered as branching Nomai-inspired writing. Hold a glyph to translate it, and draw from an existing spiral to write a reply. The optional conversation view shows the selected message's current branch with full translated text inline; untranslated text remains hidden.

Selecting a message highlights its ancestor path. Shared threads refresh every 15 seconds while the page is visible, preserving the camera, selection, and reading progress. Refreshes wait while drawing, translating, or composing. The selector and outline show unread counts for the signed-in user.

## Run locally

```bash
python3 -m venv venv
venv/bin/pip install -r backend/requirements.txt
./run_local.sh
```

Open http://localhost:5000. Direct execution with `python backend/app.py` generates a temporary session key when no private key is configured; restarting signs you out. The local launcher uses SQLite.

## Production and existing installations

Gunicorn and Flask CLI require a private `SECRET_KEY`. Missing keys and the old development/example values fail at startup. Render's blueprint already generates a key. Configure one explicitly for Docker or Fly before restarting:

```bash
export SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
```

Keep the same private key across workers and restarts. Configure `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for Turso, or `DATABASE_PATH` for a persistent local SQLite database. Personal Discord webhooks are configured in the app's Settings; only Discord webhook destinations are accepted.

Registration no longer assigns unowned legacy threads. If an old database contains threads without an owner, an administrator can explicitly assign them to an existing username:

```bash
venv/bin/python -m flask --app backend/app.py claim-legacy-threads USERNAME
```

Use the intended database configuration and a private `SECRET_KEY` for that command. It assigns all currently unowned threads and leaves existing ownership intact.

Existing layouts retain their appearance and acquire a persistent geometry seed when loaded. Imports also support older exports and resolve parent links independently of message order. Legacy browser reading progress is retained until its server upload succeeds.

## Checks

```bash
venv/bin/python -m unittest discover -s test -p test_backend.py
node test/intersection-unit-test.js
node test/regression-test.js
node test/spiral-intersection-test.js
```

Tests use temporary local databases and the actual frontend source. The stress check writes its diagnostic JSON under the system temporary directory.

For desktop/mobile browser checks, use Node 22+ and a local Chromium executable:

```bash
CHROME_BIN=/path/to/chrome node test/browser-test.js
```

The browser suite starts a temporary local Flask server, uses an isolated browser profile, and checks keyboard navigation, spoiler boundaries, replies, shared-thread refreshes, camera/draft preservation, and mobile branch selection. Set `PYTHON` if the virtualenv is elsewhere. Screenshots are written to the system temporary directory as `nomai-desktop.png` and `nomai-mobile.png`.
