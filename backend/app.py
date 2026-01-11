import os
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import database

# Determine paths
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BACKEND_DIR, '..', 'frontend')

app = Flask(__name__, static_folder=FRONTEND_DIR)
CORS(app)

# Initialize database on startup
database.init_db()

@app.route('/api/threads', methods=['GET'])
def get_threads():
    """List all threads."""
    threads = database.get_all_threads()
    return jsonify(threads)

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

if __name__ == '__main__':
    # Development mode
    app.run(debug=True, port=5000)
