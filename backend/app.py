import os
import json
import logging
import sqlite3
import urllib.request
import urllib.error
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory, session, redirect
from flask_cors import CORS
import database

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Determine paths
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BACKEND_DIR, '..', 'frontend')

app = Flask(__name__, static_folder=FRONTEND_DIR)
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
CORS(app)

# Log database configuration
logger.info(f"TURSO_DATABASE_URL set: {bool(os.environ.get('TURSO_DATABASE_URL'))}")
logger.info(f"TURSO_AUTH_TOKEN set: {bool(os.environ.get('TURSO_AUTH_TOKEN'))}")
if os.environ.get('TURSO_DATABASE_URL'):
    logger.info(f"Using Turso: {os.environ.get('TURSO_DATABASE_URL')[:50]}...")

# Track if database is initialized (lazy init to avoid fork issues with libsql/tokio)
_db_initialized = False

def ensure_db_initialized():
    """Initialize database on first use (after gunicorn fork)."""
    global _db_initialized
    if not _db_initialized:
        logger.info("Initializing database...")
        database.init_db()
        logger.info("Database initialized")
        _db_initialized = True

# =========================================================================
# Auth helpers
# =========================================================================

def get_current_user():
    """Return the current user_id from session, or None."""
    return session.get('user_id')

def login_required(f):
    """Decorator: return 401 if not logged in."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not get_current_user():
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated

def check_thread_access(thread_id, require_write=False):
    """Check if the current user has access to a thread (owner or collaborator).

    Returns (allowed, is_owner) tuple.
    """
    user_id = get_current_user()
    if not user_id:
        return False, False

    owner_id = database.get_thread_owner(thread_id)

    # Owner always has full access
    if owner_id == user_id:
        return True, True

    # Collaborators have read + write access
    if database.is_collaborator(thread_id, user_id):
        return True, False

    return False, False

# =========================================================================
# Request lifecycle
# =========================================================================

PUBLIC_PREFIXES = ('/login', '/api/auth/', '/shared/', '/css/', '/js/', '/favicon')

@app.before_request
def before_request():
    """Ensure DB init + redirect unauthenticated users to login."""
    ensure_db_initialized()

    path = request.path

    # Static assets and public API paths are always accessible
    if any(path.startswith(p) for p in PUBLIC_PREFIXES):
        return

    # API endpoints return 401 (handled per-route by @login_required)
    if path.startswith('/api/'):
        return

    # Main page: redirect to login if not authenticated
    if path == '/' and not get_current_user():
        return redirect('/login')

# =========================================================================
# Page serving
# =========================================================================

@app.route('/login')
def serve_login():
    """Serve the login page."""
    if get_current_user():
        return redirect('/')
    return send_from_directory(FRONTEND_DIR, 'login.html')

@app.route('/shared/<token>')
def accept_share(token):
    """Accept a share invite: add thread to user's list, redirect to main app."""
    share_info = database.get_thread_by_share_token(token)
    if not share_info:
        return send_from_directory(FRONTEND_DIR, 'login.html')  # invalid token

    user_id = get_current_user()
    if not user_id:
        # Remember where to go after login
        session['pending_share_token'] = token
        return redirect('/login')

    # Don't add owner as collaborator on their own thread
    owner_id = database.get_thread_owner(share_info['id'])
    if owner_id != user_id:
        database.add_collaborator(share_info['id'], user_id)

    return redirect(f'/?thread={share_info["id"]}')

@app.route('/')
def serve_index():
    """Serve the main index.html."""
    if not get_current_user():
        return redirect('/login')
    return send_from_directory(FRONTEND_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    """Serve static files (JS, CSS, etc.)."""
    return send_from_directory(FRONTEND_DIR, path)

# =========================================================================
# Auth endpoints
# =========================================================================

@app.route('/api/auth/register', methods=['POST'])
def register():
    """Register a new user."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body is required'}), 400

    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if len(username) < 2:
        return jsonify({'error': 'Username must be at least 2 characters'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400

    try:
        user = database.create_user(username, password)
    except (sqlite3.IntegrityError, Exception) as e:
        if 'UNIQUE' in str(e).upper() or 'unique' in str(e).lower():
            return jsonify({'error': 'Username already taken'}), 409
        raise

    # Auto-login
    session['user_id'] = user['id']
    session['username'] = user['username']

    # Claim orphan threads (one-time migration for existing data)
    database.claim_orphan_threads(user['id'])

    # Check for pending share invite
    redirect_url = None
    pending_token = session.pop('pending_share_token', None)
    if pending_token:
        redirect_url = f'/shared/{pending_token}'

    return jsonify({'id': user['id'], 'username': user['username'], 'redirect': redirect_url}), 201

@app.route('/api/auth/login', methods=['POST'])
def login():
    """Log in with username and password."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body is required'}), 400

    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    user = database.authenticate_user(username, password)
    if not user:
        return jsonify({'error': 'Invalid username or password'}), 401

    session['user_id'] = user['id']
    session['username'] = user['username']

    # Check for pending share invite
    redirect_url = None
    pending_token = session.pop('pending_share_token', None)
    if pending_token:
        redirect_url = f'/shared/{pending_token}'

    return jsonify({'id': user['id'], 'username': user['username'], 'redirect': redirect_url})

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    """Clear session."""
    session.clear()
    return jsonify({'success': True})

@app.route('/api/auth/me', methods=['GET'])
@login_required
def get_me():
    """Return current user info."""
    user = database.get_user_by_id(get_current_user())
    if not user:
        session.clear()
        return jsonify({'error': 'User not found'}), 401
    return jsonify(user)

# =========================================================================
# Thread endpoints
# =========================================================================

@app.route('/api/threads', methods=['GET'])
@login_required
def get_threads():
    """List all threads for the current user."""
    try:
        threads = database.get_all_threads(get_current_user())
        return jsonify(threads)
    except Exception as e:
        logger.error(f"Error getting threads: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/threads/<int:thread_id>', methods=['GET'])
@login_required
def get_thread(thread_id):
    """Get a thread with all messages."""
    allowed, _ = check_thread_access(thread_id)
    if not allowed:
        return jsonify({'error': 'Access denied'}), 403

    thread = database.get_thread_with_messages(thread_id)
    if thread is None:
        return jsonify({'error': 'Thread not found'}), 404
    return jsonify(thread)

@app.route('/api/threads', methods=['POST'])
@login_required
def create_thread():
    """Create a new thread."""
    data = request.get_json()
    if not data or 'title' not in data:
        return jsonify({'error': 'Title is required'}), 400

    thread = database.create_thread(data['title'], get_current_user())
    return jsonify(thread), 201

@app.route('/api/threads/<int:thread_id>', methods=['DELETE'])
@login_required
def delete_thread(thread_id):
    """Delete a thread and all its messages. Owner only."""
    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    database.delete_thread(thread_id)
    return jsonify({'success': True})

# =========================================================================
# Message endpoints
# =========================================================================

@app.route('/api/messages', methods=['POST'])
@login_required
def create_message():
    """Add a message to a thread."""
    data = request.get_json()

    if not data:
        return jsonify({'error': 'Request body is required'}), 400

    required = ['thread_id', 'writer_name', 'content']
    for field in required:
        if field not in data:
            return jsonify({'error': f'{field} is required'}), 400

    # Check access (owner or collaborator)
    allowed, _ = check_thread_access(data['thread_id'])
    if not allowed:
        return jsonify({'error': 'Access denied'}), 403

    message = database.create_message(
        thread_id=data['thread_id'],
        parent_id=data.get('parent_id'),
        writer_name=data['writer_name'],
        content=data['content'],
        spiral_prefs=data.get('spiral_prefs')
    )
    return jsonify(message), 201

@app.route('/api/messages/<int:message_id>', methods=['DELETE'])
@login_required
def delete_message(message_id):
    """Delete a message. Owner only."""
    thread_id = database.get_message_thread_id(message_id)
    if thread_id is None:
        return jsonify({'error': 'Message not found'}), 404

    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    database.delete_message(message_id)
    return jsonify({'success': True})

# =========================================================================
# Layout endpoints
# =========================================================================

@app.route('/api/threads/<int:thread_id>/layouts', methods=['PUT'])
@login_required
def update_layouts(thread_id):
    """Update layout data for multiple messages in a thread."""
    allowed, _ = check_thread_access(thread_id)
    if not allowed:
        return jsonify({'error': 'Access denied'}), 403

    data = request.get_json()
    if not data or 'layouts' not in data:
        return jsonify({'error': 'layouts object is required'}), 400

    database.update_thread_layouts(thread_id, data['layouts'])
    return jsonify({'success': True})

@app.route('/api/threads/<int:thread_id>/layouts', methods=['DELETE'])
@login_required
def clear_layouts(thread_id):
    """Clear all layout data for a thread (triggers regeneration). Owner only."""
    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    database.clear_thread_layouts(thread_id)
    return jsonify({'success': True})

# =========================================================================
# Export / Import
# =========================================================================

@app.route('/api/threads/<int:thread_id>/export', methods=['GET'])
@login_required
def export_thread(thread_id):
    """Export a thread with all messages and layout data as JSON."""
    allowed, _ = check_thread_access(thread_id)
    if not allowed:
        return jsonify({'error': 'Access denied'}), 403

    thread = database.get_thread_with_messages(thread_id)
    if thread is None:
        return jsonify({'error': 'Thread not found'}), 404
    return jsonify(thread)

@app.route('/api/threads/import', methods=['POST'])
@login_required
def import_thread():
    """Import a thread from JSON data."""
    data = request.get_json()

    if not data:
        return jsonify({'error': 'Request body is required'}), 400

    if 'title' not in data:
        return jsonify({'error': 'Thread title is required'}), 400

    try:
        thread = database.import_thread(data, get_current_user())
        return jsonify(thread), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 400

# =========================================================================
# Discord notification
# =========================================================================

@app.route('/api/threads/<int:thread_id>/notify-discord', methods=['POST'])
@login_required
def notify_discord(thread_id):
    """Send a Discord notification that a thread was updated. Owner only."""
    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    webhook_url = os.environ.get('DISCORD_WEBHOOK_URL')
    if not webhook_url:
        return jsonify({'error': 'Discord webhook URL not configured'}), 400

    thread = database.get_thread_with_messages(thread_id)
    if thread is None:
        return jsonify({'error': 'Thread not found'}), 404

    message_count = len(thread.get('messages', []))
    embed = {
        "embeds": [{
            "title": thread['title'],
            "description": f"Thread has been updated ({message_count} messages)",
            "color": 0x00CCCC
        }]
    }

    try:
        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(embed).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'User-Agent': 'NomaiThreadViewer/1.0',
            },
            method='POST'
        )
        response = urllib.request.urlopen(req)
        return jsonify({'success': True})
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        logger.error(f"Discord webhook HTTP error {e.code}: {body}")
        return jsonify({'error': f'Discord returned HTTP {e.code}'}), 502
    except Exception as e:
        logger.error(f"Failed to send Discord notification: {e}")
        return jsonify({'error': 'Failed to send Discord notification'}), 500

# =========================================================================
# Share endpoints
# =========================================================================

@app.route('/api/threads/<int:thread_id>/share', methods=['POST'])
@login_required
def share_thread(thread_id):
    """Generate or update a share link for a thread. Owner only."""
    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    data = request.get_json() or {}
    mode = data.get('mode', 'view')
    if mode not in ('view', 'collaborate'):
        return jsonify({'error': 'Invalid share mode'}), 400

    # Check if thread already has a token
    thread = database.get_thread_with_messages(thread_id)
    if thread and thread.get('share_token'):
        token = thread['share_token']
    else:
        token = database.generate_share_token(thread_id)

    database.update_share_mode(thread_id, mode)

    return jsonify({
        'share_token': token,
        'share_mode': mode,
        'url': f'/shared/{token}'
    })

@app.route('/api/threads/<int:thread_id>/share', methods=['DELETE'])
@login_required
def unshare_thread(thread_id):
    """Revoke a share link. Owner only."""
    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    database.revoke_share_token(thread_id)
    return jsonify({'success': True})

@app.route('/api/shared/<token>', methods=['GET'])
def check_share_token(token):
    """Validate a share token. Returns thread info if valid."""
    share_info = database.get_thread_by_share_token(token)
    if not share_info:
        return jsonify({'error': 'Invalid or expired share link'}), 404
    return jsonify({'thread_id': share_info['id'], 'share_mode': share_info['share_mode']})

# =========================================================================
# Debug endpoint
# =========================================================================

@app.route('/api/debug', methods=['GET'])
def debug_info():
    """Debug endpoint to check configuration."""
    return jsonify({
        'turso_url_set': bool(os.environ.get('TURSO_DATABASE_URL')),
        'turso_token_set': bool(os.environ.get('TURSO_AUTH_TOKEN')),
        'turso_url_prefix': os.environ.get('TURSO_DATABASE_URL', '')[:30] + '...' if os.environ.get('TURSO_DATABASE_URL') else None,
        'database_path': os.environ.get('DATABASE_PATH'),
        'using_turso': bool(database.TURSO_DATABASE_URL)
    })

if __name__ == '__main__':
    # Development mode
    app.run(debug=True, port=5000)
