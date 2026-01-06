# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nomai Thread Viewer is a web app inspired by Outer Wilds that displays threaded messages as Nomai-style spiral glyphs on a canvas. Users create threads, add messages that branch from each other, and "translate" messages by holding down on spirals.

## Development Commands

### Backend (Python/Flask)
```bash
# Activate virtual environment
source venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt

# Run the backend server (port 5000)
python backend/app.py
```

### Frontend
The frontend is static HTML/JS/CSS. Serve it with any static file server or open `frontend/index.html` directly. The frontend expects the backend API at `http://localhost:5000/api`.

## Architecture

### Backend (`backend/`)
- **app.py**: Flask REST API with endpoints for threads and messages
- **database.py**: SQLite database layer with context manager pattern

Database schema: `threads` (id, title, created_at) and `messages` (id, thread_id, parent_id, writer_name, content, created_at). Messages form a tree via `parent_id` foreign key. Database stored at `data/threads.db`.

### Frontend (`frontend/js/`)
The frontend uses vanilla JS with classes exported to `window`:

- **spiral.js**: `SpiralGenerator` creates curved arc points using Catmull-Rom to Bezier conversion. `TreeLayoutEngine` positions message spirals in a tree layout where children branch from parent endpoints.
- **canvas.js**: `NomaiCanvas` handles HiDPI canvas rendering, spiral drawing with glow effects, and color transitions (cyan→grey) as messages are translated.
- **interaction.js**: `InteractionHandler` manages mouse/touch events, hit detection on spiral paths, and drag-to-translate behavior.
- **app.js**: `NomaiApp` is the main controller - orchestrates UI events, API calls, modal dialogs, and text reveal animation.
- **api.js**: `api` object with async methods wrapping fetch calls to backend endpoints.

### Key Interaction Flow
1. User holds mouse down on a spiral
2. `InteractionHandler` detects hit, calls `NomaiApp.handleMouseDown()`
3. `NomaiCanvas.startTransition()` animates spiral color from cyan to grey
4. `NomaiApp.startTextAnimation()` progressively reveals text in the translation panel
5. Releasing mouse pauses both animations; re-pressing resumes from current progress
