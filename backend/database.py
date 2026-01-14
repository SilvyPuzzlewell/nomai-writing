import sqlite3
import os
from contextlib import contextmanager

# Turso configuration (remote database)
TURSO_DATABASE_URL = os.environ.get('TURSO_DATABASE_URL')
TURSO_AUTH_TOKEN = os.environ.get('TURSO_AUTH_TOKEN')

# Use environment variable for database path, with fallback to local data directory
DATABASE_PATH = os.environ.get(
    'DATABASE_PATH',
    os.path.join(os.path.dirname(__file__), '..', 'data', 'threads.db')
)

# Use libsql if Turso is configured
if TURSO_DATABASE_URL:
    import libsql_experimental as libsql

def init_db():
    """Initialize the database with schema."""
    # Ensure database directory exists (only for local SQLite)
    if not TURSO_DATABASE_URL:
        db_dir = os.path.dirname(DATABASE_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)

    with get_connection() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id INTEGER NOT NULL,
                parent_id INTEGER,
                writer_name TEXT NOT NULL,
                content TEXT NOT NULL,
                layout_data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
            CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
        ''')
        # Add layout_data column if it doesn't exist (migration for existing DBs)
        try:
            conn.execute('ALTER TABLE messages ADD COLUMN layout_data TEXT')
        except sqlite3.OperationalError:
            pass  # Column already exists

@contextmanager
def get_connection():
    """Context manager for database connections."""
    if TURSO_DATABASE_URL:
        conn = libsql.connect(database=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)
    else:
        conn = sqlite3.connect(DATABASE_PATH)
        conn.execute('PRAGMA foreign_keys = ON')
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

def get_all_threads():
    """Get all threads with message counts."""
    with get_connection() as conn:
        cursor = conn.execute('''
            SELECT t.id, t.title, t.created_at,
                   COUNT(m.id) as message_count
            FROM threads t
            LEFT JOIN messages m ON t.id = m.thread_id
            GROUP BY t.id
            ORDER BY t.created_at DESC
        ''')
        return [dict(row) for row in cursor.fetchall()]

def get_thread_with_messages(thread_id):
    """Get a thread with all its messages."""
    with get_connection() as conn:
        # Get thread
        cursor = conn.execute(
            'SELECT id, title, created_at FROM threads WHERE id = ?',
            (thread_id,)
        )
        thread = cursor.fetchone()
        if not thread:
            return None

        # Get messages
        cursor = conn.execute('''
            SELECT id, thread_id, parent_id, writer_name, content, layout_data, created_at
            FROM messages
            WHERE thread_id = ?
            ORDER BY created_at
        ''', (thread_id,))
        messages = [dict(row) for row in cursor.fetchall()]

        return {
            'id': thread['id'],
            'title': thread['title'],
            'created_at': thread['created_at'],
            'messages': messages
        }

def create_thread(title):
    """Create a new thread."""
    with get_connection() as conn:
        cursor = conn.execute(
            'INSERT INTO threads (title) VALUES (?)',
            (title,)
        )
        return {
            'id': cursor.lastrowid,
            'title': title
        }

def delete_thread(thread_id):
    """Delete a thread and all its messages."""
    with get_connection() as conn:
        conn.execute('DELETE FROM threads WHERE id = ?', (thread_id,))
        return True

def create_message(thread_id, parent_id, writer_name, content, spiral_prefs=None):
    """Create a new message in a thread.

    spiral_prefs: optional dict with user spiral preferences (branchT, curvatureDir, curvatureTightness)
    """
    import json

    # Store spiral preferences as initial layout_data if provided
    layout_data = None
    if spiral_prefs:
        layout_data = json.dumps({'userPrefs': spiral_prefs})

    with get_connection() as conn:
        cursor = conn.execute('''
            INSERT INTO messages (thread_id, parent_id, writer_name, content, layout_data)
            VALUES (?, ?, ?, ?, ?)
        ''', (thread_id, parent_id, writer_name, content, layout_data))
        return {
            'id': cursor.lastrowid,
            'thread_id': thread_id,
            'parent_id': parent_id,
            'writer_name': writer_name,
            'content': content,
            'layout_data': layout_data
        }

def delete_message(message_id):
    """Delete a message and all its children (cascade)."""
    with get_connection() as conn:
        conn.execute('DELETE FROM messages WHERE id = ?', (message_id,))
        return True

def update_message_layout(message_id, layout_data):
    """Update layout data for a single message."""
    with get_connection() as conn:
        conn.execute(
            'UPDATE messages SET layout_data = ? WHERE id = ?',
            (layout_data, message_id)
        )
        return True

def update_thread_layouts(thread_id, layouts):
    """Bulk update layout data for multiple messages in a thread.
    layouts: dict of {message_id: layout_data_json_string}
    """
    with get_connection() as conn:
        for message_id, layout_data in layouts.items():
            conn.execute(
                'UPDATE messages SET layout_data = ? WHERE id = ? AND thread_id = ?',
                (layout_data, message_id, thread_id)
            )
        return True

def clear_thread_layouts(thread_id):
    """Clear all layout data for a thread (triggers regeneration on next load)."""
    with get_connection() as conn:
        conn.execute(
            'UPDATE messages SET layout_data = NULL WHERE thread_id = ?',
            (thread_id,)
        )
        return True

def import_thread(data):
    """Import a thread with messages from JSON data.

    data: dict with 'title' and optional 'messages' array
    Each message should have: writer_name, content, parent_id (can reference old IDs), layout_data
    """
    import json

    with get_connection() as conn:
        # Create the thread
        cursor = conn.execute(
            'INSERT INTO threads (title) VALUES (?)',
            (data['title'],)
        )
        thread_id = cursor.lastrowid

        # Import messages if provided
        messages = data.get('messages', [])
        if messages:
            # Build a map from old IDs to new IDs
            old_to_new_id = {}

            # Sort messages so parents come before children
            # Messages with null parent_id first, then by original order
            sorted_messages = sorted(messages, key=lambda m: (m.get('parent_id') is not None, messages.index(m)))

            for msg in sorted_messages:
                old_id = msg.get('id')
                old_parent_id = msg.get('parent_id')

                # Map old parent_id to new parent_id
                new_parent_id = None
                if old_parent_id is not None:
                    new_parent_id = old_to_new_id.get(old_parent_id)

                # Insert the message
                cursor = conn.execute('''
                    INSERT INTO messages (thread_id, parent_id, writer_name, content, layout_data)
                    VALUES (?, ?, ?, ?, ?)
                ''', (
                    thread_id,
                    new_parent_id,
                    msg.get('writer_name', 'Unknown'),
                    msg.get('content', ''),
                    msg.get('layout_data')
                ))

                # Map old ID to new ID
                if old_id is not None:
                    old_to_new_id[old_id] = cursor.lastrowid

    # Return the created thread with messages (after commit)
    return get_thread_with_messages(thread_id)
