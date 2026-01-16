#!/bin/bash

# Run the app locally with local SQLite database

cd "$(dirname "$0")"

# Ensure Turso env vars are unset (use local SQLite)
unset TURSO_DATABASE_URL
unset TURSO_AUTH_TOKEN

# Activate virtual environment if it exists
if [ -d "venv" ]; then
    source venv/bin/activate
fi

# Create data directory if it doesn't exist
mkdir -p data

# Run the Flask app
cd backend
python app.py
