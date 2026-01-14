#!/bin/bash

# Nomai Thread Viewer - Start the server
# Flask serves both the API and frontend static files

cd "$(dirname "$0")"

# Load .env file if it exists
if [ -f .env ]; then
    echo "Loading environment from .env file..."
    export $(grep -v '^#' .env | xargs)
fi

echo "Starting Nomai Thread Viewer..."
source venv/bin/activate

# Show which database is being used
if [ -n "$TURSO_DATABASE_URL" ]; then
    echo "Using Turso database: ${TURSO_DATABASE_URL:0:40}..."
else
    echo "Using local SQLite database"
fi

python backend/app.py

# Server runs at http://localhost:5000
