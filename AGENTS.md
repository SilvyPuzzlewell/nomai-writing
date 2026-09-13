# Repository Guidelines

## Project Structure & Module Organization

`backend/` contains the Flask application, SQLite/Turso database layer, validation helpers, and sample-data loader. `frontend/` is a build-free client: HTML entry points live at its root, styles are in `frontend/css/`, JavaScript is in `frontend/js/`, and bundled fonts are in `frontend/fonts/`. Automated checks live in `test/`; Python files cover API behavior, while Node scripts exercise geometry, regressions, and browser flows. Runtime SQLite files belong in ignored `data/`. Keep deployment secrets in the ignored `.env`, using `.env.example` only as a safe template.

## Build, Test, and Development Commands

Create the environment and install dependencies:

```bash
python3 -m venv venv
venv/bin/pip install -r backend/requirements.txt
./run_local.sh
```

The local launcher serves the Flask API and static frontend at `http://localhost:5000`; there is no frontend build step. Run the CI-equivalent checks with:

```bash
venv/bin/python -m unittest discover -s test -p test_backend.py
node test/intersection-unit-test.js
node test/regression-test.js
node test/spiral-intersection-test.js
```

For end-to-end UI coverage, use Node 22+ and Chromium: `CHROME_BIN=/path/to/chrome node test/browser-test.js`.

## Coding Style & Naming Conventions

Follow the existing four-space indentation and concise, dependency-light style. Use `snake_case` for Python functions and variables, `PascalCase` for Python/JavaScript classes, and `camelCase` for JavaScript methods and values. Keep API routes under `/api/`. Frontend scripts expose classes through `window`; preserve the script order in `frontend/index.html`. When deploying changed frontend assets, update their cache-busting `?v=` values. No formatter or linter is configured, so match adjacent code and avoid unrelated reformatting.

## Testing Guidelines

Add Python `unittest` methods named `test_*` for backend changes and focused `*-test.js` files for frontend or geometry behavior. Tests must use temporary databases and must not depend on Turso credentials. Run all CI commands before submitting; run the browser suite when changing interaction, layout, accessibility, or refresh behavior.

## Commit & Pull Request Guidelines

Recent commits favor short, imperative subjects such as `Fix spiral intersection detection` and `Add layout persistence`. Keep each commit focused. Pull requests should explain user-visible behavior, identify affected backend/frontend areas, list commands run, and link relevant issues. Include screenshots for visual or responsive UI changes and call out schema, environment-variable, or migration implications.
