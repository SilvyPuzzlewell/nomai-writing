#!/bin/bash

# Nomai Thread Viewer - Start the server
# Flask serves both the API and frontend static files

cd "$(dirname "$0")"

# Ensure Turso env vars are unset (use local SQLite)
unset TURSO_DATABASE_URL
unset TURSO_AUTH_TOKEN

echo "Starting Nomai Thread Viewer..."
source venv/bin/activate

# Create data directory if it doesn't exist
mkdir -p data

echo "Using local SQLite database"
python backend/app.py

# Server runs at http://localhost:5000
