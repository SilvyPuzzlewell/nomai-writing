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

PUBLIC_PREFIXES = ('/login', '/api/auth/', '/css/', '/js/', '/favicon')

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

    return jsonify({'id': user['id'], 'username': user['username']}), 201

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

    return jsonify({'id': user['id'], 'username': user['username']})

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
    """Create a new thread, optionally sharing with friends."""
    data = request.get_json()
    if not data or 'title' not in data:
        return jsonify({'error': 'Title is required'}), 400

    user_id = get_current_user()
    thread = database.create_thread(data['title'], user_id)

    # Add friends as collaborators if provided
    friend_ids = data.get('friend_ids', [])
    for fid in friend_ids:
        if database.are_friends(user_id, fid):
            database.add_collaborator(thread['id'], fid)

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
# Friend endpoints
# =========================================================================

@app.route('/api/users/search', methods=['GET'])
@login_required
def search_users():
    """Search users by username (min 2 chars)."""
    q = (request.args.get('q') or '').strip()
    if len(q) < 2:
        return jsonify([])
    results = database.search_users(q, get_current_user())
    return jsonify(results)

@app.route('/api/friends', methods=['GET'])
@login_required
def get_friends():
    """List accepted friends."""
    friends = database.get_friends(get_current_user())
    return jsonify(friends)

@app.route('/api/friends/requests', methods=['GET'])
@login_required
def get_friend_requests():
    """Get incoming + outgoing friend requests."""
    user_id = get_current_user()
    return jsonify({
        'incoming': database.get_pending_requests(user_id),
        'outgoing': database.get_outgoing_requests(user_id)
    })

@app.route('/api/friends/requests/count', methods=['GET'])
@login_required
def get_friend_request_count():
    """Get pending incoming request count for badge."""
    count = database.get_pending_request_count(get_current_user())
    return jsonify({'count': count})

@app.route('/api/friends/request', methods=['POST'])
@login_required
def send_friend_request():
    """Send a friend request."""
    data = request.get_json()
    if not data or 'user_id' not in data:
        return jsonify({'error': 'user_id is required'}), 400

    receiver_id = data['user_id']
    sender_id = get_current_user()

    if receiver_id == sender_id:
        return jsonify({'error': 'Cannot send friend request to yourself'}), 400

    # Verify receiver exists
    user = database.get_user_by_id(receiver_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    result = database.send_friend_request(sender_id, receiver_id)
    return jsonify(result)

@app.route('/api/friends/requests/<int:request_id>/accept', methods=['POST'])
@login_required
def accept_friend_request(request_id):
    """Accept a friend request."""
    result = database.respond_to_friend_request(request_id, get_current_user(), 'accept')
    if not result:
        return jsonify({'error': 'Request not found or not yours'}), 404
    return jsonify(result)

@app.route('/api/friends/requests/<int:request_id>/decline', methods=['POST'])
@login_required
def decline_friend_request(request_id):
    """Decline a friend request."""
    result = database.respond_to_friend_request(request_id, get_current_user(), 'decline')
    if not result:
        return jsonify({'error': 'Request not found or not yours'}), 404
    return jsonify(result)

@app.route('/api/friends/<int:friend_user_id>', methods=['DELETE'])
@login_required
def remove_friend(friend_user_id):
    """Remove a friend (cascades to collaborator access)."""
    user_id = get_current_user()
    if not database.are_friends(user_id, friend_user_id):
        return jsonify({'error': 'Not friends'}), 404
    database.remove_friend(user_id, friend_user_id)
    return jsonify({'success': True})

# =========================================================================
# Collaborator endpoints
# =========================================================================

@app.route('/api/threads/<int:thread_id>/collaborators', methods=['GET'])
@login_required
def get_collaborators(thread_id):
    """List collaborators on a thread."""
    allowed, _ = check_thread_access(thread_id)
    if not allowed:
        return jsonify({'error': 'Access denied'}), 403
    collaborators = database.get_thread_collaborators(thread_id)
    return jsonify(collaborators)

@app.route('/api/threads/<int:thread_id>/collaborators', methods=['POST'])
@login_required
def add_collaborator(thread_id):
    """Add a friend as collaborator. Owner only, must be friends."""
    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    data = request.get_json()
    if not data or 'user_id' not in data:
        return jsonify({'error': 'user_id is required'}), 400

    user_id = get_current_user()
    target_id = data['user_id']

    if not database.are_friends(user_id, target_id):
        return jsonify({'error': 'Must be friends to add as collaborator'}), 400

    database.add_collaborator(thread_id, target_id)
    return jsonify({'success': True})

@app.route('/api/threads/<int:thread_id>/collaborators/<int:user_id>', methods=['DELETE'])
@login_required
def remove_collaborator(thread_id, user_id):
    """Remove a collaborator from a thread. Owner only."""
    allowed, is_owner = check_thread_access(thread_id)
    if not allowed or not is_owner:
        return jsonify({'error': 'Access denied'}), 403

    database.remove_collaborator(thread_id, user_id)
    return jsonify({'success': True})

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
