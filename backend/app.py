import os
import json
import logging
import urllib.request
import urllib.error
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import database

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Determine paths
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BACKEND_DIR, '..', 'frontend')

app = Flask(__name__, static_folder=FRONTEND_DIR)
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

@app.before_request
def before_request():
    """Ensure database is initialized before handling requests."""
    ensure_db_initialized()

@app.route('/api/threads', methods=['GET'])
def get_threads():
    """List all threads."""
    try:
        threads = database.get_all_threads()
        logger.info(f"GET /api/threads returning {len(threads)} threads")
        return jsonify(threads)
    except Exception as e:
        logger.error(f"Error getting threads: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/threads/<int:thread_id>', methods=['GET'])
def get_thread(thread_id):
    """Get a thread with all messages."""
    thread = database.get_thread_with_messages(thread_id)
    if thread is None:
        return jsonify({'error': 'Thread not found'}), 404
    return jsonify(thread)

@app.route('/api/threads', methods=['POST'])
def create_thread():
    """Create a new thread."""
    data = request.get_json()
    if not data or 'title' not in data:
        return jsonify({'error': 'Title is required'}), 400

    thread = database.create_thread(data['title'])
    return jsonify(thread), 201

@app.route('/api/threads/<int:thread_id>', methods=['DELETE'])
def delete_thread(thread_id):
    """Delete a thread and all its messages."""
    database.delete_thread(thread_id)
    return jsonify({'success': True})

@app.route('/api/messages', methods=['POST'])
def create_message():
    """Add a message to a thread."""
    data = request.get_json()

    if not data:
        return jsonify({'error': 'Request body is required'}), 400

    required = ['thread_id', 'writer_name', 'content']
    for field in required:
        if field not in data:
            return jsonify({'error': f'{field} is required'}), 400

    message = database.create_message(
        thread_id=data['thread_id'],
        parent_id=data.get('parent_id'),
        writer_name=data['writer_name'],
        content=data['content'],
        spiral_prefs=data.get('spiral_prefs')
    )
    return jsonify(message), 201

@app.route('/api/messages/<int:message_id>', methods=['DELETE'])
def delete_message(message_id):
    """Delete a message."""
    database.delete_message(message_id)
    return jsonify({'success': True})

@app.route('/api/threads/<int:thread_id>/layouts', methods=['PUT'])
def update_layouts(thread_id):
    """Update layout data for multiple messages in a thread."""
    data = request.get_json()

    if not data or 'layouts' not in data:
        return jsonify({'error': 'layouts object is required'}), 400

    database.update_thread_layouts(thread_id, data['layouts'])
    return jsonify({'success': True})

@app.route('/api/threads/<int:thread_id>/layouts', methods=['DELETE'])
def clear_layouts(thread_id):
    """Clear all layout data for a thread (triggers regeneration)."""
    database.clear_thread_layouts(thread_id)
    return jsonify({'success': True})

@app.route('/api/threads/<int:thread_id>/export', methods=['GET'])
def export_thread(thread_id):
    """Export a thread with all messages and layout data as JSON."""
    thread = database.get_thread_with_messages(thread_id)
    if thread is None:
        return jsonify({'error': 'Thread not found'}), 404
    return jsonify(thread)

@app.route('/api/threads/<int:thread_id>/notify-discord', methods=['POST'])
def notify_discord(thread_id):
    """Send a Discord notification that a thread was updated."""
    logger.debug(f"Discord notify requested for thread {thread_id}")

    webhook_url = os.environ.get('DISCORD_WEBHOOK_URL')
    if not webhook_url:
        logger.warning("DISCORD_WEBHOOK_URL not set in environment")
        return jsonify({'error': 'Discord webhook URL not configured'}), 400

    thread = database.get_thread_with_messages(thread_id)
    if thread is None:
        logger.warning(f"Thread {thread_id} not found for Discord notification")
        return jsonify({'error': 'Thread not found'}), 404

    message_count = len(thread.get('messages', []))
    embed = {
        "embeds": [{
            "title": thread['title'],
            "description": f"Thread has been updated ({message_count} messages)",
            "color": 0x00CCCC
        }]
    }
    logger.debug(f"Sending Discord webhook for thread '{thread['title']}' ({message_count} messages)")

    try:
        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(embed).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        response = urllib.request.urlopen(req)
        logger.info(f"Discord webhook sent successfully (HTTP {response.status}) for thread {thread_id}")
        return jsonify({'success': True})
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        logger.error(f"Discord webhook HTTP error {e.code}: {body}")
        return jsonify({'error': f'Discord returned HTTP {e.code}'}), 502
    except Exception as e:
        logger.error(f"Failed to send Discord notification: {e}")
        return jsonify({'error': 'Failed to send Discord notification'}), 500

@app.route('/api/threads/import', methods=['POST'])
def import_thread():
    """Import a thread from JSON data."""
    data = request.get_json()

    if not data:
        return jsonify({'error': 'Request body is required'}), 400

    if 'title' not in data:
        return jsonify({'error': 'Thread title is required'}), 400

    try:
        thread = database.import_thread(data)
        return jsonify(thread), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 400

# Serve frontend static files
@app.route('/')
def serve_index():
    """Serve the main index.html."""
    return send_from_directory(FRONTEND_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    """Serve static files (JS, CSS, etc.)."""
    return send_from_directory(FRONTEND_DIR, path)

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
