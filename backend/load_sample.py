#!/usr/bin/env python3
"""Load sample thread data from JSON into the database."""

import json
import os
import sys

# Add backend to path
sys.path.insert(0, os.path.dirname(__file__))

import database

def load_sample_data(json_path):
    """Load sample thread and messages from JSON file."""
    with open(json_path, 'r') as f:
        data = json.load(f)

    # Initialize database
    database.init_db()

    # Create thread
    thread = database.create_thread(data['thread']['title'])
    thread_id = thread['id']
    print(f"Created thread: {data['thread']['title']} (id={thread_id})")

    # Map old IDs to new IDs
    id_map = {}

    # Sort messages by ID to ensure parents are created before children
    messages = sorted(data['messages'], key=lambda m: m['id'])

    for msg in messages:
        # Map parent_id to new ID
        parent_id = None
        if msg['parent_id'] is not None:
            parent_id = id_map.get(msg['parent_id'])

        # Create message
        new_msg = database.create_message(
            thread_id=thread_id,
            parent_id=parent_id,
            writer_name=msg['writer_name'],
            content=msg['content']
        )

        # Store ID mapping
        id_map[msg['id']] = new_msg['id']
        print(f"  Added message from {msg['writer_name']} (id={new_msg['id']})")

    print(f"\nLoaded {len(messages)} messages into thread '{data['thread']['title']}'")

if __name__ == '__main__':
    json_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'sample_thread.json')
    load_sample_data(json_path)
