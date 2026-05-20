import sqlite3
import os
from contextlib import contextmanager
from werkzeug.security import generate_password_hash, check_password_hash

# Turso configuration (remote database)
TURSO_DATABASE_URL = os.environ.get('TURSO_DATABASE_URL')
TURSO_AUTH_TOKEN = os.environ.get('TURSO_AUTH_TOKEN')

# Use environment variable for database path, with fallback to local data directory
DATABASE_PATH = os.environ.get(
    'DATABASE_PATH',
    os.path.join(os.path.dirname(__file__), '..', 'data', 'threads.db')
)

# Lazy import of libsql to avoid tokio initialization before gunicorn fork
_libsql = None

def get_libsql():
    """Lazily import libsql to avoid fork issues with tokio runtime."""
    global _libsql
    if _libsql is None:
        import libsql_experimental as libsql
        _libsql = libsql
    return _libsql

def init_db():
    """Initialize the database with schema."""
    # Ensure database directory exists (only for local SQLite)
    if not TURSO_DATABASE_URL:
        db_dir = os.path.dirname(DATABASE_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)

    with get_connection() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                discord_webhook TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                user_id INTEGER,
                share_token TEXT,
                share_mode TEXT DEFAULT 'view',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
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

            CREATE TABLE IF NOT EXISTS thread_collaborators (
                thread_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (thread_id, user_id),
                FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS friendships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id INTEGER NOT NULL,
                receiver_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(sender_id, receiver_id)
            );
        ''')
        # Add layout_data column if it doesn't exist (migration for existing DBs)
        try:
            conn.execute('ALTER TABLE messages ADD COLUMN layout_data TEXT')
        except (sqlite3.OperationalError, ValueError):
            pass  # Column already exists
        # Add user_id column to threads if it doesn't exist (migration)
        try:
            conn.execute('ALTER TABLE threads ADD COLUMN user_id INTEGER')
        except (sqlite3.OperationalError, ValueError):
            pass
        # Add discord_webhook column to users if it doesn't exist (migration)
        try:
            conn.execute('ALTER TABLE users ADD COLUMN discord_webhook TEXT')
        except (sqlite3.OperationalError, ValueError):
            pass
        # Add share_token column to threads if it doesn't exist (migration)
        try:
            conn.execute('ALTER TABLE threads ADD COLUMN share_token TEXT')
        except (sqlite3.OperationalError, ValueError):
            pass
        # Add share_mode column to threads if it doesn't exist (migration)
        try:
            conn.execute("ALTER TABLE threads ADD COLUMN share_mode TEXT DEFAULT 'view'")
        except (sqlite3.OperationalError, ValueError):
            pass
        # Create index on share_token (after column is guaranteed to exist)
        try:
            conn.execute('CREATE INDEX IF NOT EXISTS idx_threads_share_token ON threads(share_token)')
        except (sqlite3.OperationalError, ValueError):
            pass

def rows_to_dicts(columns, rows):
    """Convert rows to list of dicts using column names."""
    if not rows:
        return []
    return [dict(zip(columns, row)) for row in rows]

def row_to_dict(columns, row):
    """Convert a single row to dict using column names."""
    if not row:
        return None
    return dict(zip(columns, row))

@contextmanager
def get_connection():
    """Context manager for database connections."""
    if TURSO_DATABASE_URL:
        libsql = get_libsql()
        conn = libsql.connect(database=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)
    else:
        conn = sqlite3.connect(DATABASE_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

# =========================================================================
# User functions
# =========================================================================

def create_user(username, password):
    """Create a new user. Returns user dict or raises on duplicate."""
    password_hash = generate_password_hash(password)
    with get_connection() as conn:
        cursor = conn.execute(
            'INSERT INTO users (username, password_hash) VALUES (?, ?)',
            (username, password_hash)
        )
        return {
            'id': get_last_insert_id(conn, cursor),
            'username': username
        }

def get_user_by_username(username):
    """Look up a user by username."""
    with get_connection() as conn:
        cursor = conn.execute(
            'SELECT id, username, password_hash FROM users WHERE username = ?',
            (username,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        if TURSO_DATABASE_URL:
            return row_to_dict(['id', 'username', 'password_hash'], row)
        return dict(row)

def authenticate_user(username, password):
    """Verify credentials. Returns user dict (without hash) or None."""
    user = get_user_by_username(username)
    if user and check_password_hash(user['password_hash'], password):
        return {'id': user['id'], 'username': user['username']}
    return None

def get_user_by_id(user_id):
    """Look up a user by ID."""
    with get_connection() as conn:
        cursor = conn.execute(
            'SELECT id, username, discord_webhook FROM users WHERE id = ?',
            (user_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        if TURSO_DATABASE_URL:
            return row_to_dict(['id', 'username', 'discord_webhook'], row)
        return dict(row)

def set_user_discord_webhook(user_id, webhook):
    """Set (or clear, when empty) the user's personal Discord webhook URL."""
    value = (webhook or '').strip() or None
    with get_connection() as conn:
        conn.execute(
            'UPDATE users SET discord_webhook = ? WHERE id = ?',
            (value, user_id)
        )

def get_thread_notify_targets(thread_id, exclude_user_id):
    """Return discord_webhook URLs for all thread participants (owner +
    collaborators) except exclude_user_id, skipping those without a webhook."""
    with get_connection() as conn:
        cursor = conn.execute('''
            SELECT u.discord_webhook
            FROM users u
            WHERE u.id != ?
              AND u.discord_webhook IS NOT NULL
              AND u.discord_webhook != ''
              AND (
                u.id = (SELECT user_id FROM threads WHERE id = ?)
                OR u.id IN (
                    SELECT user_id FROM thread_collaborators WHERE thread_id = ?
                )
              )
        ''', (exclude_user_id, thread_id, thread_id))
        rows = cursor.fetchall()
        return [row[0] for row in rows]

def claim_orphan_threads(user_id):
    """Assign all threads with user_id IS NULL to the given user."""
    with get_connection() as conn:
        conn.execute(
            'UPDATE threads SET user_id = ? WHERE user_id IS NULL',
            (user_id,)
        )

# =========================================================================
# Thread functions
# =========================================================================

def get_all_threads(user_id):
    """Get all threads for a user (owned + collaborated) with message counts."""
    with get_connection() as conn:
        cursor = conn.execute('''
            SELECT t.id, t.title, t.created_at,
                   COUNT(m.id) as message_count,
                   CASE WHEN t.user_id = ? THEN 1 ELSE 0 END as is_owner
            FROM threads t
            LEFT JOIN messages m ON t.id = m.thread_id
            WHERE t.user_id = ?
               OR t.id IN (SELECT thread_id FROM thread_collaborators WHERE user_id = ?)
            GROUP BY t.id
            ORDER BY t.created_at DESC
        ''', (user_id, user_id, user_id))
        rows = cursor.fetchall()
        cols = ['id', 'title', 'created_at', 'message_count', 'is_owner']
        if TURSO_DATABASE_URL:
            return rows_to_dicts(cols, rows)
        return [dict(row) for row in rows]

def get_thread_with_messages(thread_id):
    """Get a thread with all its messages."""
    with get_connection() as conn:
        # Get thread
        cursor = conn.execute(
            'SELECT id, title, created_at, user_id FROM threads WHERE id = ?',
            (thread_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        if TURSO_DATABASE_URL:
            thread = row_to_dict(['id', 'title', 'created_at', 'user_id'], row)
        else:
            thread = dict(row)

        # Get messages
        cursor = conn.execute('''
            SELECT id, thread_id, parent_id, writer_name, content, layout_data, created_at
            FROM messages
            WHERE thread_id = ?
            ORDER BY created_at
        ''', (thread_id,))
        rows = cursor.fetchall()
        msg_cols = ['id', 'thread_id', 'parent_id', 'writer_name', 'content', 'layout_data', 'created_at']
        if TURSO_DATABASE_URL:
            messages = rows_to_dicts(msg_cols, rows)
        else:
            messages = [dict(row) for row in rows]

        return {
            'id': thread['id'],
            'title': thread['title'],
            'created_at': thread['created_at'],
            'user_id': thread['user_id'],
            'messages': messages
        }

def get_thread_owner(thread_id):
    """Return the user_id that owns a thread, or None."""
    with get_connection() as conn:
        cursor = conn.execute(
            'SELECT user_id FROM threads WHERE id = ?',
            (thread_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        if TURSO_DATABASE_URL:
            return row[0]
        return row['user_id']

def create_thread(title, user_id):
    """Create a new thread owned by user_id."""
    with get_connection() as conn:
        cursor = conn.execute(
            'INSERT INTO threads (title, user_id) VALUES (?, ?)',
            (title, user_id)
        )
        return {
            'id': get_last_insert_id(conn, cursor),
            'title': title
        }

def delete_thread(thread_id):
    """Delete a thread and all its messages."""
    with get_connection() as conn:
        conn.execute('DELETE FROM threads WHERE id = ?', (thread_id,))
        return True

def add_collaborator(thread_id, user_id):
    """Add a user as a collaborator on a thread. Idempotent."""
    with get_connection() as conn:
        try:
            conn.execute(
                'INSERT INTO thread_collaborators (thread_id, user_id) VALUES (?, ?)',
                (thread_id, user_id)
            )
        except (sqlite3.IntegrityError, Exception):
            pass  # Already a collaborator

def is_collaborator(thread_id, user_id):
    """Check if a user is a collaborator on a thread."""
    with get_connection() as conn:
        cursor = conn.execute(
            'SELECT 1 FROM thread_collaborators WHERE thread_id = ? AND user_id = ?',
            (thread_id, user_id)
        )
        return cursor.fetchone() is not None

def get_thread_collaborators(thread_id):
    """List collaborators with usernames for a thread."""
    with get_connection() as conn:
        cursor = conn.execute('''
            SELECT tc.user_id, u.username
            FROM thread_collaborators tc
            JOIN users u ON tc.user_id = u.id
            WHERE tc.thread_id = ?
            ORDER BY u.username
        ''', (thread_id,))
        rows = cursor.fetchall()
        cols = ['user_id', 'username']
        if TURSO_DATABASE_URL:
            return rows_to_dicts(cols, rows)
        return [dict(row) for row in rows]

def remove_collaborator(thread_id, user_id):
    """Remove a user from thread collaborators."""
    with get_connection() as conn:
        conn.execute(
            'DELETE FROM thread_collaborators WHERE thread_id = ? AND user_id = ?',
            (thread_id, user_id)
        )

# =========================================================================
# Friendship functions
# =========================================================================

def search_users(query, current_user_id):
    """Search users by username, excluding current user. Limit 20."""
    with get_connection() as conn:
        cursor = conn.execute(
            'SELECT id, username FROM users WHERE username LIKE ? AND id != ? LIMIT 20',
            (f'%{query}%', current_user_id)
        )
        rows = cursor.fetchall()
        cols = ['id', 'username']
        if TURSO_DATABASE_URL:
            return rows_to_dicts(cols, rows)
        return [dict(row) for row in rows]

def send_friend_request(sender_id, receiver_id):
    """Send a friend request. If reverse pending exists, auto-accept both."""
    with get_connection() as conn:
        # Check if a friendship already exists in either direction
        cursor = conn.execute(
            'SELECT id, sender_id, receiver_id, status FROM friendships WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)',
            (sender_id, receiver_id, receiver_id, sender_id)
        )
        row = cursor.fetchone()
        if row:
            if TURSO_DATABASE_URL:
                existing = row_to_dict(['id', 'sender_id', 'receiver_id', 'status'], row)
            else:
                existing = dict(row)

            if existing['status'] == 'accepted':
                return {'status': 'already_friends'}

            # Reverse pending request exists — auto-accept
            if existing['sender_id'] == receiver_id and existing['status'] == 'pending':
                conn.execute(
                    'UPDATE friendships SET status = ? WHERE id = ?',
                    ('accepted', existing['id'])
                )
                return {'status': 'accepted'}

            # Same-direction pending already exists
            return {'status': 'already_pending'}

        # Create new request
        conn.execute(
            'INSERT INTO friendships (sender_id, receiver_id, status) VALUES (?, ?, ?)',
            (sender_id, receiver_id, 'pending')
        )
        return {'status': 'pending'}

def get_pending_requests(user_id):
    """Get incoming pending friend requests with sender username."""
    with get_connection() as conn:
        cursor = conn.execute('''
            SELECT f.id, f.sender_id, u.username as sender_username, f.created_at
            FROM friendships f
            JOIN users u ON f.sender_id = u.id
            WHERE f.receiver_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
        ''', (user_id,))
        rows = cursor.fetchall()
        cols = ['id', 'sender_id', 'sender_username', 'created_at']
        if TURSO_DATABASE_URL:
            return rows_to_dicts(cols, rows)
        return [dict(row) for row in rows]

def get_outgoing_requests(user_id):
    """Get outgoing pending friend requests with receiver username."""
    with get_connection() as conn:
        cursor = conn.execute('''
            SELECT f.id, f.receiver_id, u.username as receiver_username, f.created_at
            FROM friendships f
            JOIN users u ON f.receiver_id = u.id
            WHERE f.sender_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
        ''', (user_id,))
        rows = cursor.fetchall()
        cols = ['id', 'receiver_id', 'receiver_username', 'created_at']
        if TURSO_DATABASE_URL:
            return rows_to_dicts(cols, rows)
        return [dict(row) for row in rows]

def respond_to_friend_request(friendship_id, user_id, action):
    """Accept or decline a friend request. Verifies receiver_id matches user_id."""
    with get_connection() as conn:
        cursor = conn.execute(
            'SELECT id, receiver_id, status FROM friendships WHERE id = ?',
            (friendship_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        if TURSO_DATABASE_URL:
            friendship = row_to_dict(['id', 'receiver_id', 'status'], row)
        else:
            friendship = dict(row)

        if friendship['receiver_id'] != user_id:
            return None
        if friendship['status'] != 'pending':
            return {'status': friendship['status']}

        if action == 'accept':
            conn.execute(
                'UPDATE friendships SET status = ? WHERE id = ?',
                ('accepted', friendship_id)
            )
            return {'status': 'accepted'}
        else:
            conn.execute(
                'DELETE FROM friendships WHERE id = ?',
                (friendship_id,)
            )
            return {'status': 'declined'}

def get_friends(user_id):
    """Get accepted friends (in either direction) with friend username."""
    with get_connection() as conn:
        cursor = conn.execute('''
            SELECT
                CASE WHEN f.sender_id = ? THEN f.receiver_id ELSE f.sender_id END as friend_id,
                CASE WHEN f.sender_id = ? THEN u2.username ELSE u1.username END as friend_username
            FROM friendships f
            JOIN users u1 ON f.sender_id = u1.id
            JOIN users u2 ON f.receiver_id = u2.id
            WHERE (f.sender_id = ? OR f.receiver_id = ?) AND f.status = 'accepted'
            ORDER BY friend_username
        ''', (user_id, user_id, user_id, user_id))
        rows = cursor.fetchall()
        cols = ['friend_id', 'friend_username']
        if TURSO_DATABASE_URL:
            return rows_to_dicts(cols, rows)
        return [dict(row) for row in rows]

def are_friends(user_id, other_user_id):
    """Check if two users are friends."""
    with get_connection() as conn:
        cursor = conn.execute(
            "SELECT 1 FROM friendships WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)) AND status = 'accepted'",
            (user_id, other_user_id, other_user_id, user_id)
        )
        return cursor.fetchone() is not None

def remove_friend(user_id, friend_user_id):
    """Remove a friendship and cascade-remove collaborator access on threads owned by either user."""
    with get_connection() as conn:
        # Delete friendship row
        conn.execute(
            'DELETE FROM friendships WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)',
            (user_id, friend_user_id, friend_user_id, user_id)
        )
        # Remove collaborator access on threads owned by user_id
        conn.execute('''
            DELETE FROM thread_collaborators
            WHERE user_id = ? AND thread_id IN (SELECT id FROM threads WHERE user_id = ?)
        ''', (friend_user_id, user_id))
        # Remove collaborator access on threads owned by friend_user_id
        conn.execute('''
            DELETE FROM thread_collaborators
            WHERE user_id = ? AND thread_id IN (SELECT id FROM threads WHERE user_id = ?)
        ''', (user_id, friend_user_id))

def get_pending_request_count(user_id):
    """Count incoming pending friend requests."""
    with get_connection() as conn:
        cursor = conn.execute(
            "SELECT COUNT(*) FROM friendships WHERE receiver_id = ? AND status = 'pending'",
            (user_id,)
        )
        row = cursor.fetchone()
        if TURSO_DATABASE_URL:
            return row[0] if row else 0
        return row[0] if row else 0

# =========================================================================
# Message functions
# =========================================================================

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
            'id': get_last_insert_id(conn, cursor),
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

def get_message_thread_id(message_id):
    """Get the thread_id for a message."""
    with get_connection() as conn:
        cursor = conn.execute(
            'SELECT thread_id FROM messages WHERE id = ?',
            (message_id,)
        )
        row = cursor.fetchone()
        if not row:
            return None
        if TURSO_DATABASE_URL:
            return row[0]
        return row['thread_id']

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

def get_last_insert_id(conn, cursor):
    """Get last insert ID - works for both sqlite3 and libsql."""
    if TURSO_DATABASE_URL:
        result = conn.execute('SELECT last_insert_rowid()').fetchone()
        return result[0] if result else None
    return cursor.lastrowid

def import_thread(data, user_id):
    """Import a thread with messages from JSON data.

    data: dict with 'title' and optional 'messages' array
    Each message should have: writer_name, content, parent_id (can reference old IDs), layout_data
    """
    import json

    with get_connection() as conn:
        # Create the thread
        cursor = conn.execute(
            'INSERT INTO threads (title, user_id) VALUES (?, ?)',
            (data['title'], user_id)
        )
        thread_id = get_last_insert_id(conn, cursor)

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
                    old_to_new_id[old_id] = get_last_insert_id(conn, cursor)

    # Return the created thread with messages (after commit)
    return get_thread_with_messages(thread_id)
