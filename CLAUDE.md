# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nomai Thread Viewer is a web app inspired by Outer Wilds that displays threaded messages as Nomai-style spiral glyphs on a canvas. Users create threads, add messages that branch from each other, and "translate" messages by holding down on spirals. Translating a message progressively reveals its text and, upon completion, animates its child messages into view.

## Development Commands

```bash
# Run locally with local SQLite (recommended for dev)
./run_local.sh
# Or: source venv/bin/activate && python backend/app.py

# Run with Turso (remote DB) - reads .env for credentials
./run.sh

# Install dependencies
source venv/bin/activate
pip install -r backend/requirements.txt

# Load sample data
python backend/load_sample.py

# Run intersection tests
node test/intersection-unit-test.js
```

The app serves at http://localhost:5000 - Flask serves both the API and frontend static files from a single server.

## Architecture

### Backend (`backend/`)
- **app.py**: Flask REST API + static file server. Lazy-initializes the database on first request (avoids gunicorn fork issues with libsql/tokio). All routes under `/api/`.
- **database.py**: Database layer supporting both local SQLite and remote Turso (libsql). Uses `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` env vars to switch. Turso's libsql is imported lazily to avoid tokio runtime issues before gunicorn fork. Row conversion differs between backends (`sqlite3.Row` vs manual `rows_to_dicts`).

**API endpoints**: CRUD for threads and messages, bulk layout save/clear (`PUT/DELETE /api/threads/<id>/layouts`), thread export/import (`GET /api/threads/<id>/export`, `POST /api/threads/import`), Discord notifications (`POST /api/threads/<id>/notify-discord`), debug info (`GET /api/debug`).

**Database schema**: `threads` (id, title, created_at) and `messages` (id, thread_id, parent_id, writer_name, content, layout_data, created_at). Messages form a tree via `parent_id`. The `layout_data` JSON column stores spiral positioning parameters for deterministic replay.

### Frontend (`frontend/`)
Vanilla JS with classes exported to `window` (no build step, no module system). Script load order in `index.html` matters: api.js -> toast.js -> spiral.js -> canvas.js -> interaction.js -> app.js. Scripts use manual cache-busting query params (e.g. `?v=21`) — bump the version when changing frontend files for deployed updates (login.html's stylesheet link too). Debug instrumentation (pixel-coincidence scan + canvas overlap markers) is opt-in via `?debug=1`.

**Key classes:**
- **`SpiralGenerator`** (spiral.js): Generates Archimedean spiral points with Catmull-Rom-to-Bezier conversion. Uses seeded RNG (`seededRandom`) for deterministic spiral shapes from message IDs. Supports both auto-generated spirals (~100 degree curl) and user-drawn spirals (exact transform parameters).
- **`TreeLayoutEngine`** (spiral.js): Positions spirals on canvas. Children branch from points along parent spirals. Uses iterative collision avoidance: generates parameter variations (angle, length, curvature, direction) and tests each with analytical Bezier-Bezier intersection detection (recursive subdivision). Saves successful layout params to `layout_data` for deterministic replay on reload.
- **`NomaiCanvas`** (canvas.js): HiDPI-aware rendering with glow effects. Manages three reveal modes: immediate (`setMessages`), animated sequential (`setMessagesAnimated`), and progressive reveal (`setMessagesProgressiveReveal` - only roots shown initially, children appear after parent translation). Handles spiral draw-in animations and cyan-to-grey color transitions.
- **`InteractionHandler`** (interaction.js): State machine with three states: IDLE, SELECTING_BRANCH, DRAWING_SPIRAL. Double-click enters drawing mode; mouse wheel adjusts curvature during preview. Hit detection uses point-distance on spiral sample points.
- **`NomaiApp`** (app.js): Main controller. Orchestrates UI, API calls, modal dialogs, text reveal animation (25 chars/sec), and translation state persistence via localStorage.

### Key Data Flow
1. **Layout persistence**: When spirals are generated, `layoutParams` (offset from center, angle, collision-avoidance overrides) are saved to the backend via `layout_data`. On reload, saved params replay deterministically without re-running collision avoidance.
2. **Progressive reveal**: Only root messages visible initially. Translating a parent (hold-click until complete) triggers `revealChildren()` which animates child spirals drawing in. Translation progress is saved to localStorage per thread.
3. **Drawing mode**: Double-click spiral -> select branch point along parent -> drag to set direction/length, scroll wheel for curvature -> confirm -> modal opens with pre-filled spiral parameters.

## Deployment

Deployed on Render (`render.yaml`): gunicorn serves Flask app with 120s timeout. Turso credentials and `DISCORD_WEBHOOK_URL` set in Render dashboard. The `.env` file (not committed) holds credentials for local remote-DB testing; see `.env.example`.
