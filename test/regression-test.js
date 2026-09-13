const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./frontend-test-helpers');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function geometry() { return loadFrontend(['spiral.js', 'canvas.js', 'interaction.js']); }

test('conversation indentation preserves readable width on deep branches', () => {
    const { window: { ConversationOutline } } = loadFrontend(['outline.js']);
    assert.equal(ConversationOutline.calculateIndent(6, 320), 18);

    const indent = ConversationOutline.calculateIndent(20, 320);
    assert.ok(indent > 0 && indent < 18);
    const deepestWidth = 320 - 24 - 20 * (indent + Math.min(1, indent));
    assert.ok(deepestWidth >= 179.9);

    const extremeIndent = ConversationOutline.calculateIndent(200, 320);
    const extremeWidth = 320 - 24 - 200 * (extremeIndent + Math.min(1, extremeIndent));
    assert.ok(extremeWidth >= 179);
});

test('export/import retains exact curves with new database IDs', () => {
    const ctx = geometry();
    const Engine = ctx.window.TreeLayoutEngine;
    const original = new Engine(1000, 700).layoutTree([
        { id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }
    ]);
    const restored = new Engine(1000, 700).layoutTree(original.map(m => ({
        id: m.id + 100, parent_id: m.parent_id === null ? null : m.parent_id + 100,
        layout_data: JSON.stringify(m.spiralData.layoutParams)
    })));
    assert.deepEqual(plain(restored.map(m => m.spiralData.points)), plain(original.map(m => m.spiralData.points)));
});

test('legacy layout gets a seed without changing its geometry; invalid JSON regenerates', () => {
    const { window: { TreeLayoutEngine: Engine } } = geometry();
    const before = new Engine(900, 600).layoutTree([{ id: 20, parent_id: null }])[0];
    const legacy = { ...before.spiralData.layoutParams };
    delete legacy.seed;
    const after = new Engine(900, 600).layoutTree([{ id: 20, parent_id: null, layout_data: JSON.stringify(legacy) }])[0];
    assert.deepEqual(plain(after.spiralData.points), plain(before.spiralData.points));
    assert.equal(after.spiralData.layoutParams.seed, 20);
    assert.equal(after.needsLayoutSave, true);
    const recovered = new Engine(900, 600).layoutTree([{ id: 30, parent_id: null, layout_data: 'bad JSON' }])[0];
    assert.ok(recovered.spiralData.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('Allow overlap keeps the requested curve; Auto-adjust finds a different clear curve', () => {
    const ctx = geometry();
    const Engine = ctx.window.TreeLayoutEngine;
    const prefs = { userDrawn: true, startAngle: 0, curvatureTightness: 0.3, curvatureDir: 'cw', lengthScale: 1 };
    const root = { id: 1, parent_id: null, layout_data: JSON.stringify({ userPrefs: prefs }) };
    const child = choice => ({ id: 2, parent_id: 1, layout_data: JSON.stringify({ userPrefs: { ...prefs, branchT: 0, ...choice } }) });
    const allowed = new Engine(1000, 700).layoutTree([root, child({ allowOverlap: true })]);
    assert.deepEqual(plain(allowed[0].spiralData.points), plain(allowed[1].spiralData.points));
    const adjusted = new Engine(1000, 700).layoutTree([root, child({ autoAdjust: true })]);
    assert.equal(ctx.checkSpiralIntersection(adjusted[1].spiralData.points, [{ nodeId: 1, points: adjusted[0].spiralData.points }], 3, 1), false);
    assert.notDeepEqual(plain(adjusted[1].spiralData.points), plain(allowed[1].spiralData.points));
});

test('selection path contains only selected message and ancestors and clears on deselection', () => {
    const { window: { NomaiCanvas } } = geometry();
    const canvas = { messages: [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 1 }, { id: 4, parent_id: 2 }], render() {} };
    NomaiCanvas.prototype.setSelected.call(canvas, 4);
    assert.deepEqual([...canvas.selectedPath], [4, 2, 1]);
    NomaiCanvas.prototype.setSelected.call(canvas, null);
    assert.equal(canvas.selectedPath.size, 0);
});

test('touch double-tap leaves branch selection open until the next gesture', () => {
    const ctx = loadFrontend(['interaction.js'], { window: { matchMedia: () => ({ matches: true }) } });
    const message = { id: 1, spiralData: { points: [{ x: 100, y: 100, progress: 0 }, { x: 150, y: 100, progress: 1 }] } };
    const canvas = { canvas: { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), style: {} },
        camera: { scale: 1 }, messages: [message], visibleMessageIds: new Set([1]),
        screenToWorld: (x, y) => ({ x, y }), setSelected() {}, fitToContent() {} };
    const interaction = new ctx.window.InteractionHandler(canvas);
    for (let i = 0; i < 2; i++) {
        interaction.handleMouseDown({ clientX: 100, clientY: 100 });
        interaction.handleMouseUp();
    }
    assert.equal(interaction.drawingState, 'selectingBranch');
    interaction.handleMouseDown({ clientX: 150, clientY: 100 });
    interaction.handleMouseUp();
    assert.equal(interaction.drawingState, 'drawingSpiral');
    assert.equal(interaction.branchT, 1);
    interaction.cancelDrawing();
    assert.equal(interaction.parentMessage, null);
    assert.equal(interaction.isMouseDown, false);
});

function appHarness() {
    const elements = new Map(), storage = new Map();
    let busy = false;
    const document = { addEventListener() {}, querySelector: () => busy ? {} : null,
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, { value: '', textContent: '',
                classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} });
            return elements.get(id);
        } };
    const ctx = loadFrontend(['app.js'], { document, console: { error() {} },
        localStorage: { getItem: key => storage.get(key) || null, removeItem: key => storage.delete(key) } });
    const app = Object.create(ctx.NomaiApp.prototype);
    Object.assign(app, { currentThreadId: null, currentUserId: 1, threadLoadGeneration: 0,
        pendingTranslations: new Map(), translationSaves: new Map(),
        interaction: { isDrawing: () => false, isMouseDown: false, cancelDrawing() {} },
        stopTranslation() {}, updateConversation() {}, renderThreadOptions() {},
        clearSelection() { this.selectedMessage = null; },
        canvas: { messages: [], translatedIds: new Set(), revealTimers: new Set(), drawAnimations: new Map(),
            clearTranslated() { this.translatedIds.clear(); }, setMessages(messages) { this.messages = messages; },
            setMessagesProgressiveReveal(messages) { this.messages = messages; }, getMessage(id) { return this.messages.find(m => m.id === id); },
            restoreTranslated(ids) { ids.forEach(id => this.translatedIds.add(id)); }, getTranslatedIds() { return [...this.translatedIds]; } }
    });
    ctx.api = { getThread: async id => ({ id, user_id: 1, created_at: 'test', messages: [{ id: id * 10, parent_id: null }] }),
        getTranslations: async () => [], getThreadCollaborators: async () => [], saveTranslations: async () => {} };
    ctx.toast = { error() {} };
    return { app, ctx, storage, setBusy: value => { busy = value; } };
}

test('late collaborator response cannot overwrite a newer thread', async () => {
    const { app, ctx } = appHarness();
    let resolveA;
    ctx.api.getThreadCollaborators = id => id === 1 ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve([]);
    const first = app.loadThread(1);
    await tick();
    assert.equal(await app.loadThread(2), true);
    resolveA([]);
    assert.equal(await first, false);
    assert.equal(app.currentThreadId, 2);
    assert.equal(app.canvas.messages[0].id, 20);
});

test('clearing the board invalidates an in-flight thread load', async () => {
    const { app, ctx } = appHarness();
    let resolve;
    ctx.api.getThreadCollaborators = () => new Promise(done => { resolve = done; });
    const loading = app.loadThread(1);
    app.clearBoard();
    resolve([]);
    assert.equal(await loading, false);
    assert.equal(app.currentThreadId, null);
    assert.equal(app.canvas.messages.length, 0);
});

test('refresh arriving after a composer opens leaves the current view alone', async () => {
    const { app, ctx, setBusy } = appHarness();
    await app.loadThread(1);
    let resolve;
    ctx.api.getThread = () => new Promise(done => { resolve = done; });
    const loading = app.loadThread(1, { background: true });
    setBusy(true);
    resolve({ id: 1, messages: [{ id: 99, parent_id: null }], user_id: 1 });
    assert.equal(await loading, false);
    assert.equal(app.canvas.messages[0].id, 10);
});

test('legacy translations survive upload failure and disappear only after success', async () => {
    const { app, ctx, storage } = appHarness();
    const thread = { id: 1, created_at: 'test', messages: [{ id: 10 }] };
    storage.set('nomai_translated_1_test', '[10]');
    ctx.api.saveTranslations = async () => { throw new Error('offline'); };
    app.restoreTranslationState(thread, { ok: true, ids: [] });
    await tick();
    assert.equal(storage.get('nomai_translated_1_test'), '[10]');
    assert.equal(app.canvas.translatedIds.has(10), true);
    ctx.api.saveTranslations = async () => {};
    app.restoreTranslationState(thread, { ok: true, ids: [] });
    await tick();
    assert.equal(storage.has('nomai_translated_1_test'), false);
});


test('collision checks protect unrelated glyphs near a branch and include stroke width', () => {
    const ctx = geometry();
    const points = Array.from({ length: 8 }, (_, i) => ({ x: i * 10, y: 0 }));
    const crossing = { nodeId: 99, points: [{ x: 5, y: -10 }, { x: 5, y: 10 }] };
    assert.equal(ctx.checkSpiralIntersection(points, [crossing], 3, 1), true);
    const near = { points: [{ x: 0, y: 1 }, { x: 70, y: 1 }] };
    assert.equal(ctx.checkSpiralIntersection(points, [near], 0), true);
});
