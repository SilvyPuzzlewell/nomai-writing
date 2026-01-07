import sqlite3
import os
from contextlib import contextmanager

DATABASE_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'threads.db')

def init_db():
    """Initialize the database with schema."""
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
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
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

def create_message(thread_id, parent_id, writer_name, content):
    """Create a new message in a thread."""
    with get_connection() as conn:
        cursor = conn.execute('''
            INSERT INTO messages (thread_id, parent_id, writer_name, content)
            VALUES (?, ?, ?, ?)
        ''', (thread_id, parent_id, writer_name, content))
        return {
            'id': cursor.lastrowid,
            'thread_id': thread_id,
            'parent_id': parent_id,
            'writer_name': writer_name,
            'content': content
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
