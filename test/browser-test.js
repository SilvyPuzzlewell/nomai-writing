/** Local Chromium integration checks. Node 22+, no npm dependencies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nomai-ui-test-'));
const python = process.env.PYTHON || path.join(root, 'venv/bin/python');
const chromeBin = process.env.CHROME_BIN || '/snap/chromium/current/usr/lib/chromium-browser/chrome';
let fixture, chrome, socket;
let fixtureOutput = '', chromeOutput = '';
const errors = [];

async function eventually(fn, label, timeout = 15000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await fn()) return;
        await delay(100);
    }
    throw new Error('Timed out: ' + label);
}

(async () => {
    fixture = spawn(python, ['test/browser_fixture.py'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    fixture.stdout.on('data', data => { fixtureOutput += data; });
    fixture.stderr.on('data', data => { fixtureOutput += data; });
    await eventually(() => /FIXTURE_URL=(http:\/\/[^\s]+)/.test(fixtureOutput), 'fixture startup');
    const origin = fixtureOutput.match(/FIXTURE_URL=(http:\/\/[^\s]+)/)[1];
    chrome = spawn(chromeBin, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
        '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', data => { chromeOutput += data; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    await eventually(() => fs.existsSync(portFile), 'Chromium startup');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 0;
    const pending = new Map();
    socket.onmessage = event => {
        const response = JSON.parse(event.data);
        if (response.id) {
            const promise = pending.get(response.id);
            pending.delete(response.id);
            if (response.error) promise.reject(new Error(JSON.stringify(response.error)));
            else promise.resolve(response.result);
        } else if (response.method === 'Runtime.exceptionThrown') {
            errors.push(response.params.exceptionDetails.exception?.description || response.params.exceptionDetails.text);
        }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        if (expression.startsWith('await ')) expression = '(async () => (' + expression + '))()';
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    const wait = (expression, label) => eventually(() => evaluate(expression).catch(() => false), label);
    const key = async (key, code = key, windowsVirtualKeyCode = 13) => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : undefined });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    };
    const activate = async selector => {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        if (process.env.DEBUG_BROWSER_TEST) console.log('focus', selector, await evaluate('({active: document.activeElement.outerHTML, open: document.getElementById(\"conversation-outline\").open, busy: app.foregroundLoading})'));
        await key('Enter');
    };
    const screenshot = async filename => {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(os.tmpdir(), filename), Buffer.from(shot.data, 'base64'));
    };
    const renderLongConversation = count => evaluate(`(() => {
        const messages = Array.from({length:${count}}, (_, index) => ({
            id:index + 1, parent_id:index ? index : null,
            writer_name:'Explorer ' + (index + 1), content:'Translated field note ' + (index + 1)
        }));
        const ids = new Set(messages.map(message => message.id));
        app.outline.render({messages, visibleMessageIds:ids, selectedPath:ids,
            selectedId:${count}, translatedIds:ids, getTransitionProgress:() => 1});
    })()`);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: origin + '/login' });
    await wait('!!document.getElementById("login-form")', 'login form');
    await evaluate(`document.getElementById('login-username').value='owner'; document.getElementById('login-password').value='nomai-test-password'; document.getElementById('login-form').requestSubmit()`);
    await wait('window.app && app.threads.length === 2', 'authenticated app');
    assert.equal(await evaluate('await app.loadThread(1)'), true);
    assert.equal(await evaluate('document.getElementById("threaded-view-toggle").checked'), false);
    assert.equal(await evaluate('document.getElementById("reply-message-btn")'), null);
    assert.equal(await evaluate('document.getElementById("write-message-btn").classList.contains("hidden")'), true);
    assert.equal(await evaluate('document.getElementById("conversation-outline").classList.contains("hidden")'), true);
    await evaluate('app.handleMessageSelect(app.canvas.getMessage(1))');
    assert.equal(await evaluate('document.getElementById("message-content").textContent.length > 0'), true);
    await evaluate('document.getElementById("threaded-view-toggle").click()');
    assert.equal(await evaluate('document.getElementById("conversation-outline").classList.contains("hidden")'), false);
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#outline-list button")].map(b=>Number(b.dataset.messageId))'), [1]);
    assert.equal(await evaluate('document.getElementById("outline-list").textContent.includes("hidden conclusion")'), false);
    await renderLongConversation(30);
    const desktopIndent = await evaluate('parseFloat(document.getElementById("outline-list").style.getPropertyValue("--outline-indent"))');
    assert.ok(desktopIndent > 0 && desktopIndent < 18);
    assert.ok(await evaluate('[...document.querySelectorAll("#outline-list .outline-message")].at(-1).getBoundingClientRect().width >= 179'));
    assert.equal(await evaluate('document.getElementById("outline-list").scrollHeight > document.getElementById("outline-list").clientHeight'), true);
    const desktopOutlinePoint = await evaluate(`(() => { const r=document.getElementById('outline-list').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: desktopOutlinePoint.x, y: desktopOutlinePoint.y, deltaX: 0, deltaY: 300 });
    await delay(100);
    assert.equal(await evaluate('document.getElementById("outline-list").scrollTop > 0'), true);
    await activate('#outline-list button[data-message-id="1"]');
    assert.equal(await evaluate('app.selectedMessage.id'), 1);
    await activate('#translate-message-btn');
    await wait('app.canvas.translatedIds.has(1) && app.canvas.visibleMessageIds.has(2)', 'keyboard translation and child reveal');
    await wait('!app.isInteracting()', 'reveal animation finished');
    await evaluate('app.handleMessageSelect(app.canvas.getMessage(2))');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#outline-list button")].map(b=>Number(b.dataset.messageId))'), [1, 2]);
    assert.equal(await evaluate('!!document.querySelector("#outline-list ol ol button[data-message-id=\\"2\\"]")'), true);
    assert.equal(await evaluate('getComputedStyle(document.getElementById("message-content")).display'), 'none');
    assert.equal(await evaluate('!!document.querySelector("#outline-list button[data-message-id=\\"3\\"]")'), false);
    await activate('#outline-list button[data-message-id="2"]');
    assert.deepEqual(await evaluate('[...app.canvas.selectedPath].sort()'), [1, 2]);
    await evaluate('app.canvas.zoomAt(300,200,1.2); app.canvas.panBy(25,-10)');
    const camera = await evaluate('app.canvas.camera');
    const response = await fetch(origin + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'reader', password: 'nomai-test-password' })
    });
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const addReply = () => fetch(origin + '/api/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ thread_id: 1, parent_id: 1, writer_name: 'reader', content: 'A new discovery.' })
    });
    assert.equal((await addReply()).status, 201);
    await eventually(() => evaluate('app.canvas.messages.length === 5'), 'automatic shared-thread polling', 20000);
    assert.equal(await evaluate('document.getElementById(\"thread-unread-count\").textContent'), '4 unread');
    assert.equal(await evaluate('app.selectedMessage.id'), 2);
    assert.equal(await evaluate('!!document.querySelector("#outline-list button[data-message-id=\\"4\\"]")'), false);
    assert.deepEqual(await evaluate('app.canvas.camera'), camera);
    assert.match(await evaluate('document.getElementById("thread-updates").textContent'), /1 new message/);
    await screenshot('nomai-desktop.png');
    await evaluate('app.drawnSpiralParams={userDrawn:true}; app.showMessageModalWithDrawnSpiral()');
    await evaluate('document.getElementById("content-input").value="Keep this draft"');
    await addReply();
    await evaluate('await app.refreshThreads()');
    assert.equal(await evaluate('app.canvas.messages.length'), 5);
    assert.equal(await evaluate('document.getElementById("content-input").value'), 'Keep this draft');
    await activate('#cancel-btn');
    await evaluate('await app.refreshThreads()');
    assert.equal(await evaluate('app.canvas.messages.length'), 6);
    console.log('PASS keyboard outline, desktop scrolling, spoiler boundaries, selected path, live updates, camera and draft preservation');

    await evaluate('await app.loadThread(2)');
    assert.equal(await evaluate('document.getElementById("regenerate-btn").classList.contains("hidden")'), false);
    assert.equal(await evaluate('document.getElementById("write-message-btn").classList.contains("hidden")'), false);
    await activate('#write-message-btn');
    await activate('#cancel-btn');
    await activate('#write-message-btn');
    await evaluate('document.getElementById("content-input").value="A new root"');
    await activate('#add-message-btn');
    await wait('!app.submittingMessage && app.canvas.messages.length===1', 'root creation after cancel');
    assert.equal(await evaluate('app.canvas.messages[0].parent_id'), null);
    assert.equal(await evaluate('document.getElementById("write-message-btn").classList.contains("hidden")'), true);
    console.log('PASS empty-thread recovery and root-only automatic message creation');

    for (const choice of ['allow', 'adjust']) {
        const before = await evaluate('app.canvas.messages.length');
        await evaluate(`(() => {
            const parent = app.canvas.messages.find(m => m.parent_id === null);
            const points = parent.spiralData.points;
            const firstStep = Math.hypot(points[1].x-points[0].x, points[1].y-points[0].y);
            const overrides = parent.spiralData.layoutParams.overrides;
            app.lastPreviewTransform = {
                startAngle: parent.spiralData.startAngle + (overrides.angleOffset || 0),
                lengthScale: firstStep * app.spiralGenerator.numPoints / app.spiralGenerator.baseLength,
                curvatureScale: Math.abs(points.curvature) / app.spiralGenerator.baseCurvature,
                curvatureSign: Math.sign(points.curvature)
            };
            app.canvas.setPreviewSpiral({points, bezierPath:parent.spiralData.bezierPath},points[0]);
            app.handleSpiralConfirm({parentMessage:parent,branchPoint:points[0],branchT:0});
        })()`);
        await wait('!document.getElementById("collision-modal").classList.contains("hidden")', 'collision choice');
        await activate('#collision-' + choice + '-btn');
        await wait('!document.getElementById("message-modal").classList.contains("hidden")', 'composer after collision choice');
        assert.equal(await evaluate('app.drawnSpiralParams.' + (choice === 'allow' ? 'allowOverlap' : 'autoAdjust')), true);
        await evaluate('document.getElementById("content-input").value=' + JSON.stringify('Placement: ' + choice));
        await activate('#add-message-btn');
        await wait('!app.submittingMessage && app.canvas.messages.length===' + (before+1), 'save chosen layout');
        if (choice === 'allow') {
            assert.ok(await evaluate(`(() => {
                const parent=app.canvas.messages.find(m=>m.parent_id===null);
                const added=app.canvas.messages.find(m=>m.content==='Placement: allow');
                return Math.max(...added.spiralData.points.map((p,i)=>Math.hypot(p.x-parent.spiralData.points[i].x,p.y-parent.spiralData.points[i].y)));
            })()`) < 1e-8);
        }
    }
    console.log('PASS overlap choices survive creation and saved-layout replay');

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await send('Page.navigate', { url: origin + '/?thread=1' });
    await wait('window.app && app.currentThreadId===1 && !app.loadingThreadId', 'mobile thread');
    assert.equal(await evaluate('document.getElementById("threaded-view-toggle").checked'), false);
    assert.equal(await evaluate('document.getElementById("conversation-outline").classList.contains("hidden")'), true);
    assert.equal(await evaluate('app.interaction.pressDrag'), true);
    await evaluate(`(() => {const point=app.canvas.messages[0].spiralData.points[25]; const screen=app.canvas.worldToScreen(point.x,point.y); app.canvas.panBy(150-screen.x,140-screen.y);})()`);
    const point = await evaluate(`(() => {const r=app.canvas.canvas.getBoundingClientRect(); return {x:r.left+150,y:r.top+140};})()`);
    const touch = (type, position = point) => send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{ x: position.x, y: position.y, id: 1 }]
    });
    await touch('touchStart'); await touch('touchEnd');
    await touch('touchStart'); await touch('touchEnd');
    assert.equal(await evaluate('app.interaction.drawingState'), 'selectingBranch');
    await touch('touchStart'); await touch('touchMove', { x: point.x + 15, y: point.y + 10 }); await touch('touchEnd');
    assert.equal(await evaluate('app.interaction.drawingState'), 'drawingSpiral');
    await activate('#draw-cancel-btn');
    await evaluate('app.handleMessageSelect(app.canvas.getMessage(2)); document.getElementById("threaded-view-toggle").click()');
    await wait('app.sheet.state === BottomSheet.FULL', 'expanded mobile threaded conversation');
    await delay(350);
    await renderLongConversation(30);
    const mobileIndent = await evaluate('parseFloat(document.getElementById("outline-list").style.getPropertyValue("--outline-indent"))');
    assert.ok(mobileIndent > desktopIndent && mobileIndent < 18);
    assert.ok(await evaluate('[...document.querySelectorAll("#outline-list .outline-message")].at(-1).getBoundingClientRect().width >= 179'));
    assert.equal(await evaluate('document.getElementById("outline-list").scrollHeight > document.getElementById("outline-list").clientHeight'), true);
    const outlinePoints = await evaluate(`(() => { const r=document.getElementById('outline-list').getBoundingClientRect(); return {
        start:{x:r.left+r.width/2,y:r.top+r.height*0.75}, end:{x:r.left+r.width/2,y:r.top+r.height*0.25}
    }; })()`);
    await touch('touchStart', outlinePoints.start);
    await touch('touchMove', outlinePoints.end);
    await touch('touchEnd');
    await delay(100);
    assert.equal(await evaluate('document.getElementById("outline-list").scrollTop > 0'), true);
    await activate('#outline-list button[data-message-id="2"]');
    assert.equal(await evaluate('app.selectedMessage.id'), 2);
    await delay(350);
    await screenshot('nomai-mobile.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    assert.deepEqual(errors, []);
    console.log('PASS mobile branch selection, touch scrolling and responsive outline; no browser exceptions');
    console.log('Screenshots: /tmp/nomai-desktop.png, /tmp/nomai-mobile.png');
})().catch(error => {
    console.error(error);
    if (process.env.DEBUG_BROWSER_TEST) console.error(fixtureOutput, chromeOutput);
    process.exitCode = 1;
}).finally(async () => {
    socket?.close();
    chrome?.kill();
    fixture?.kill();
    await delay(400);
    fs.rmSync(profile, { recursive: true, force: true });
});
