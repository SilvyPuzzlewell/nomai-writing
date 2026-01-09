#!/bin/bash

# Nomai Thread Viewer - Start both backend and frontend servers

cleanup() {
    echo "Shutting down servers..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

cd "$(dirname "$0")"

# Start backend server
echo "Starting backend server on port 5000..."
source venv/bin/activate
python backend/app.py &
BACKEND_PID=$!

# Start frontend server
echo "Starting frontend server on port 8000..."
cd frontend
python -m http.server 8000 &
FRONTEND_PID=$!

echo ""
echo "Servers running:"
echo "  Backend:  http://localhost:5000"
echo "  Frontend: http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop both servers"

wait
