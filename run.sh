#!/bin/bash

# Nomai Thread Viewer - Start the server
# Flask serves both the API and frontend static files

cd "$(dirname "$0")"

echo "Starting Nomai Thread Viewer..."
source venv/bin/activate
python backend/app.py

# Server runs at http://localhost:5000
