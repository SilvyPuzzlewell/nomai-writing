from flask import Flask, jsonify, request
from flask_cors import CORS
import database

app = Flask(__name__)
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
        content=data['content']
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

if __name__ == '__main__':
    app.run(debug=True, port=5000)
