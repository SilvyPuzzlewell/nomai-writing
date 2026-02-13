/**
 * Main application controller.
 */
class NomaiApp {
    constructor() {
        this.canvas = null;
        this.interaction = null;
        this.currentThreadId = null;
        this.selectedMessage = null;

        // Drawing mode state
        this.drawnSpiralParams = null; // Stores { branchT, curvatureDir, curvatureTightness, startAngle }
        this.spiralGenerator = null; // Reusable spiral generator

        // Cache last used writer name
        this.lastWriterName = '';

        this.init();
    }

    /**
     * Initialize the application.
     */
    async init() {
        // Initialize canvas
        const canvasEl = document.getElementById('spiral-canvas');
        this.canvas = new NomaiCanvas(canvasEl);

        // Initialize spiral generator for preview
        this.spiralGenerator = new SpiralGenerator();

        // Initialize interaction handler
        this.interaction = new InteractionHandler(this.canvas, {
            onSelect: (msg) => this.handleMessageSelect(msg),
            onHover: (msg) => this.handleMessageHover(msg),
            onMouseDown: (msg) => this.handleMouseDown(msg),
            onMouseUp: (msg) => this.handleMouseUp(msg),
            // Drawing mode callbacks (new flow)
            onBranchPointMove: (msg, point, branchT) => this.handleBranchPointMove(msg, point, branchT),
            onBranchPointConfirm: (msg, point, branchT) => this.handleBranchPointConfirm(msg, point, branchT),
            onSpiralPreview: (branchPt, currentPt, path, previewParams) => this.handleSpiralPreview(branchPt, currentPt, path, previewParams),
            onSpiralConfirm: (data) => this.handleSpiralConfirm(data),
            onDrawingCancel: () => this.handleDrawingCancel()
        });

        // Bind UI events
        this.bindUIEvents();

        // Load user info
        await this.loadUserInfo();

        // Load threads
        await this.loadThreads();

        // Auto-select thread from URL param (e.g. after accepting a share invite)
        const urlParams = new URLSearchParams(window.location.search);
        const threadParam = urlParams.get('thread');
        if (threadParam) {
            const threadId = parseInt(threadParam);
            if (threadId) {
                document.getElementById('thread-selector').value = threadId;
                await this.loadThread(threadId);
                // Clean URL
                window.history.replaceState({}, '', '/');
            }
        }
    }

    /**
     * Load and display current user info.
     */
    async loadUserInfo() {
        try {
            const user = await api.getMe();
            if (user) {
                const usernameEl = document.getElementById('current-username');
                if (usernameEl) usernameEl.textContent = user.username;
            }
        } catch (err) {
            // Will redirect to login via authFetch 401 handler
        }
    }

    /**
     * Bind UI event handlers.
     */
    bindUIEvents() {
        // Thread selector
        document.getElementById('thread-selector').addEventListener('change', (e) => {
            const threadId = e.target.value;
            if (threadId) {
                this.loadThread(parseInt(threadId));
            } else {
                this.clearBoard();
            }
        });

        // New thread button
        document.getElementById('new-thread-btn').addEventListener('click', () => {
            this.showThreadModal();
        });

        // Regenerate layout button
        document.getElementById('regenerate-btn').addEventListener('click', () => {
            this.handleRegenerateLayout();
        });

        // Export button
        document.getElementById('export-btn').addEventListener('click', () => {
            this.handleExport();
        });

        // Import button
        document.getElementById('import-btn').addEventListener('click', () => {
            document.getElementById('import-file').click();
        });

        // Notify Discord button
        document.getElementById('notify-btn').addEventListener('click', () => {
            this.handleNotifyDiscord();
        });

        // Import file input
        document.getElementById('import-file').addEventListener('change', (e) => {
            this.handleImport(e);
        });

        // Clear board button
        document.getElementById('clear-thread-btn').addEventListener('click', () => {
            this.handleClearBoard();
        });

        // FAB add button
        document.getElementById('fab-add').addEventListener('click', () => {
            this.showMessageModal();
        });

        // Thread form
        document.getElementById('thread-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleCreateThread();
        });

        document.getElementById('thread-cancel-btn').addEventListener('click', () => {
            this.hideThreadModal();
        });

        // Message form
        document.getElementById('message-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleCreateMessage();
        });

        document.getElementById('cancel-btn').addEventListener('click', () => {
            this.hideMessageModal();
        });

        document.getElementById('clear-parent-btn').addEventListener('click', () => {
            this.clearParentSelection();
        });

        // Close modals on backdrop click
        document.getElementById('thread-modal').addEventListener('click', (e) => {
            if (e.target.id === 'thread-modal') this.hideThreadModal();
        });

        document.getElementById('message-modal').addEventListener('click', (e) => {
            if (e.target.id === 'message-modal') this.hideMessageModal();
        });

        // Collision modal buttons
        document.getElementById('collision-allow-btn').addEventListener('click', () => {
            this.handleCollisionAllow();
        });

        document.getElementById('collision-adjust-btn').addEventListener('click', () => {
            this.hideCollisionModal();
        });

        document.getElementById('collision-modal').addEventListener('click', (e) => {
            if (e.target.id === 'collision-modal') this.hideCollisionModal();
        });

        // Spiral settings toggle
        document.getElementById('spiral-settings-toggle').addEventListener('click', () => {
            this.toggleSpiralSettings();
        });

        // Branch point slider
        document.getElementById('branch-point').addEventListener('input', (e) => {
            e.target.dataset.modified = 'true';
            this.updateBranchPointLabel(e.target.value);
        });

        // Curvature tightness slider
        document.getElementById('curv-tightness').addEventListener('input', (e) => {
            e.target.dataset.modified = 'true';
            this.updateTightnessLabel(e.target.value);
        });

        // Delete message button
        document.getElementById('delete-message-btn').addEventListener('click', () => {
            this.handleDeleteMessage();
        });

        // Logout button
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.handleLogout());
        }

        // Share button
        const shareBtn = document.getElementById('share-btn');
        if (shareBtn) {
            shareBtn.addEventListener('click', () => this.showShareModal());
        }

        // Share modal events
        const shareModal = document.getElementById('share-modal');
        if (shareModal) {
            shareModal.addEventListener('click', (e) => {
                if (e.target.id === 'share-modal') this.hideShareModal();
            });
            document.getElementById('share-close-btn').addEventListener('click', () => {
                this.hideShareModal();
            });
            document.getElementById('share-copy-btn').addEventListener('click', () => {
                this.copyShareLink();
            });
            document.getElementById('share-mode-select').addEventListener('change', (e) => {
                this.updateShareMode(e.target.value);
            });
            document.getElementById('share-revoke-btn').addEventListener('click', () => {
                this.revokeShare();
            });
        }
    }

    /**
     * Load all threads into selector.
     */
    async loadThreads() {
        try {
            const threads = await api.getThreads();
            const selector = document.getElementById('thread-selector');

            // Keep first option
            selector.innerHTML = '<option value="">Select a thread...</option>';

            threads.forEach(thread => {
                const option = document.createElement('option');
                option.value = thread.id;
                option.textContent = `${thread.title} (${thread.message_count} messages)`;
                selector.appendChild(option);
            });

            // If we had a thread selected, re-select it
            if (this.currentThreadId) {
                selector.value = this.currentThreadId;
            }
        } catch (err) {
            console.error('Failed to load threads:', err);
        }
    }

    /**
     * Load a specific thread with progressive reveal.
     * Only root messages shown initially; children appear when parents are translated.
     */
    async loadThread(threadId) {
        try {
            const thread = await api.getThread(threadId);

            // Only clear translation state when switching to a different thread
            if (this.currentThreadId !== threadId) {
                this.canvas.clearTranslated();
                // Restore saved translation state from localStorage
                this.loadTranslationState(threadId);
            }
            this.currentThreadId = threadId;

            // Use progressive reveal - only roots visible initially
            this.canvas.setMessagesProgressiveReveal(thread.messages, (layouts) => {
                this.saveLayouts(threadId, layouts);
                this.checkForCollisionConflicts();
            }, (messageId) => {
                // Called when a message finishes translating - save state
                this.saveTranslationState();
            });

            this.clearSelection();
        } catch (err) {
            console.error('Failed to load thread:', err);
        }
    }

    /**
     * Check for collision conflicts after layout and show warning if needed.
     */
    checkForCollisionConflicts() {
        const conflicts = this.canvas.getCollisionConflicts();
        if (conflicts.length > 0) {
            this.pendingCollisionConflicts = conflicts;
            this.showCollisionModal();
        }
    }

    /**
     * Show collision warning modal.
     */
    showCollisionModal() {
        document.getElementById('collision-modal').classList.remove('hidden');
    }

    /**
     * Hide collision warning modal.
     */
    hideCollisionModal() {
        document.getElementById('collision-modal').classList.add('hidden');
        this.pendingCollisionConflicts = null;
    }

    /**
     * Handle user choosing to allow overlap.
     */
    handleCollisionAllow() {
        // For now, just hide the modal - allowing overlap would require
        // re-rendering without collision avoidance, which is a more complex feature
        this.hideCollisionModal();
        // Future enhancement: store allowOverlap flag and re-render
    }

    // =========================================================================
    // Drawing Mode Handlers (Canvas-first workflow)
    // =========================================================================

    /**
     * Handle branch point moving along spiral (during selection).
     */
    handleBranchPointMove(parentMessage, point, branchT) {
        this.canvas.setBranchPointMarker(point, branchT);
        this.updateStatusIndicator('Move along spiral to select branch point, click to confirm');
    }

    /**
     * Handle branch point confirmed - now entering spiral drawing mode.
     */
    handleBranchPointConfirm(parentMessage, point, branchT) {
        this.drawingParentMessage = parentMessage;
        this.drawingBranchPoint = point;
        this.drawingBranchT = branchT;
        this.updateStatusIndicator('Drag to set direction & length, scroll to adjust curl, click to confirm');
    }

    /**
     * Handle spiral preview during drawing.
     * Spiral endpoint matches cursor position; mouse wheel controls curvature.
     */
    handleSpiralPreview(branchPoint, currentPoint, gesturePath, previewParams = {}) {
        if (!branchPoint) return;

        // Vector from branch point to cursor (target endpoint)
        const dx = currentPoint.x - branchPoint.x;
        const dy = currentPoint.y - branchPoint.y;
        const targetDist = Math.hypot(dx, dy);
        const targetAngle = Math.atan2(dy, dx);

        // Skip if cursor too close to branch point
        if (targetDist < 20) return;

        // Get curvature from preview params (controlled by wheel)
        const curvature = previewParams.curvature ?? 0.043; // Default ~100°
        const curvatureDir = previewParams.curvatureDir ?? 1;

        // Map curvature (0.1-1.0) to curvatureScale (0.1-1.0)
        // At 0.1: ~72° curl, at 1.0: 720° curl (full spiral)
        const curvatureScale = 0.1 + curvature * 0.9;

        // Generate a reference spiral at origin pointing right (angle=0)
        // Use a fixed seed for consistent preview shape
        const refPoints = this.spiralGenerator.generateSpiralPoints(
            0, 0, 0, 1.0, 12345,
            {
                curvatureSign: curvatureDir,
                curvatureScale: curvatureScale,
                lengthScale: 1.0,
                userDrawn: true
            }
        );

        // Get endpoint of reference spiral
        const refEnd = refPoints[refPoints.length - 1];
        const refDist = Math.hypot(refEnd.x, refEnd.y);
        const refAngle = Math.atan2(refEnd.y, refEnd.x);

        // Safety check
        if (refDist < 1) return;

        // Calculate scale and rotation to map reference endpoint to cursor
        const scale = targetDist / refDist;
        const rotation = targetAngle - refAngle;

        // Transform all points: scale, rotate, translate to branch point
        const cosR = Math.cos(rotation);
        const sinR = Math.sin(rotation);

        const transformedPoints = refPoints.map(p => {
            const sx = p.x * scale;
            const sy = p.y * scale;
            return {
                x: branchPoint.x + sx * cosR - sy * sinR,
                y: branchPoint.y + sx * sinR + sy * cosR,
                theta: p.theta + rotation,
                progress: p.progress
            };
        });

        const bezierPath = this.spiralGenerator.pointsToBezierPath(transformedPoints);

        // Store the transform parameters for use when confirming
        this.lastPreviewTransform = {
            startAngle: rotation,
            lengthScale: scale,
            curvatureSign: curvatureDir,
            curvatureScale: curvatureScale,
            userDrawn: true
        };

        // Update canvas preview
        this.canvas.clearBranchPointMarker();
        this.canvas.setPreviewSpiral(
            { points: transformedPoints, bezierPath },
            branchPoint
        );

        // Update status indicator - show curl in degrees
        const curlDegrees = Math.round((0.1 + curvature * 0.9) * 720);
        const dirLabel = curvatureDir === 1 ? 'CW' : 'CCW';
        this.updateStatusIndicator(`Curl: ${curlDegrees}° ${dirLabel} (scroll to adjust)`);
    }

    /**
     * Handle spiral confirmed - open modal with parameters.
     */
    handleSpiralConfirm(data) {
        if (!data.branchPoint) {
            // No branch point - cancel
            this.handleDrawingCancel();
            return;
        }

        // Use the stored transform from the last preview
        const transform = this.lastPreviewTransform || {};

        // Store the drawn parameters including exact transform for layout engine
        this.drawnSpiralParams = {
            branchT: data.branchT,
            curvatureDir: transform.curvatureSign === 1 ? 'cw' : 'ccw',
            curvatureTightness: transform.curvatureScale || 0.65,
            // These parameters ensure the spiral matches the preview exactly
            startAngle: transform.startAngle,
            lengthScale: transform.lengthScale,
            userDrawn: true
        };

        // Set parent message for the modal
        this.selectedMessage = data.parentMessage;

        // Clear status indicator
        this.updateStatusIndicator('');

        // Open the modal with parent pre-selected
        this.showMessageModalWithDrawnSpiral();
    }

    /**
     * Handle drawing cancelled (Escape key or click outside).
     */
    handleDrawingCancel() {
        this.canvas.clearPreviewSpiral();
        this.canvas.clearBranchPointMarker();
        this.drawnSpiralParams = null;
        this.lastPreviewTransform = null;
        this.drawingParentMessage = null;
        this.drawingBranchPoint = null;
        this.drawingBranchT = null;
        this.updateStatusIndicator('');
    }

    /**
     * Show message modal with pre-drawn spiral.
     */
    showMessageModalWithDrawnSpiral() {
        if (!this.currentThreadId) {
            alert('Please select or create a thread first');
            this.handleDrawingCancel();
            return;
        }

        document.getElementById('message-modal').classList.remove('hidden');
        document.getElementById('writer-input').value = this.lastWriterName;
        document.getElementById('content-input').value = '';
        document.getElementById('content-input').focus();

        // Update parent selection display
        this.updateParentSelection(this.selectedMessage);

        // Update sliders to show drawn values
        this.updateSlidersFromDrawnParams();

        // Update hint to show confirmed values
        if (this.drawnSpiralParams) {
            this.updateDrawingHint(
                `Branch: ${Math.round(this.drawnSpiralParams.branchT * 100)}%, ` +
                `Direction: ${this.drawnSpiralParams.curvatureDir.toUpperCase()}`
            );
        }
    }

    /**
     * Calculate spiral parameters from a drag gesture.
     */
    calculateSpiralParamsFromGesture(startPoint, endPoint, gesturePath) {
        // Calculate start angle (direction from branch point to drag end)
        const startAngle = Math.atan2(
            endPoint.y - startPoint.y,
            endPoint.x - startPoint.x
        );

        // Calculate drag vector
        const dragVec = {
            x: endPoint.x - startPoint.x,
            y: endPoint.y - startPoint.y
        };
        const dragLength = Math.hypot(dragVec.x, dragVec.y);

        // Determine curvature direction from gesture path
        let curvatureDir = 'cw';
        if (gesturePath.length > 3) {
            const midIndex = Math.floor(gesturePath.length / 2);
            const midPoint = gesturePath[midIndex];

            // Cross product to determine which side the midpoint is on
            const cross = dragVec.x * (midPoint.y - startPoint.y) -
                          dragVec.y * (midPoint.x - startPoint.x);
            curvatureDir = cross > 0 ? 'ccw' : 'cw';
        }

        // Calculate tightness from gesture deviation
        let maxDeviation = 0;
        for (const point of gesturePath) {
            const deviation = this.perpendicularDistance(point, startPoint, endPoint);
            maxDeviation = Math.max(maxDeviation, deviation);
        }

        // Normalize: more deviation = tighter curl (lower value)
        const deviationRatio = maxDeviation / Math.max(dragLength, 50);
        const curvatureTightness = Math.max(0.3, Math.min(1.0, 1.0 - deviationRatio * 1.5));

        return {
            startAngle,
            curvatureDir,
            curvatureTightness
        };
    }

    /**
     * Calculate perpendicular distance from a point to a line segment.
     */
    perpendicularDistance(point, lineStart, lineEnd) {
        const dx = lineEnd.x - lineStart.x;
        const dy = lineEnd.y - lineStart.y;
        const lineLengthSq = dx * dx + dy * dy;

        if (lineLengthSq === 0) {
            return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
        }

        // Project point onto line
        const t = Math.max(0, Math.min(1,
            ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lineLengthSq
        ));

        const projX = lineStart.x + t * dx;
        const projY = lineStart.y + t * dy;

        return Math.hypot(point.x - projX, point.y - projY);
    }

    /**
     * Update slider UI values from drawn parameters (for display).
     */
    updateSlidersFromDrawnParams() {
        if (!this.drawnSpiralParams) return;

        // Update branch point slider
        const branchSlider = document.getElementById('branch-point');
        if (branchSlider) {
            branchSlider.value = Math.round(this.drawnSpiralParams.branchT * 100);
            this.updateBranchPointLabel(branchSlider.value);
        }

        // Update direction radio
        const dirValue = this.drawnSpiralParams.curvatureDir;
        const dirRadio = document.querySelector(`input[name="curv-dir"][value="${dirValue}"]`);
        if (dirRadio) dirRadio.checked = true;

        // Update tightness slider
        const tightnessSlider = document.getElementById('curv-tightness');
        if (tightnessSlider) {
            tightnessSlider.value = Math.round(this.drawnSpiralParams.curvatureTightness * 100);
            this.updateTightnessLabel(tightnessSlider.value);
        }
    }

    /**
     * Update the drawing hint text in the modal.
     */
    updateDrawingHint(text) {
        const hintEl = document.getElementById('drawing-hint');
        if (hintEl) {
            hintEl.textContent = text;
        }
    }

    /**
     * Update status indicator on canvas.
     */
    updateStatusIndicator(text) {
        let indicator = document.getElementById('drawing-status');
        if (!indicator && text) {
            // Create indicator if it doesn't exist
            indicator = document.createElement('div');
            indicator.id = 'drawing-status';
            indicator.className = 'drawing-status';
            document.getElementById('canvas-container').appendChild(indicator);
        }
        if (indicator) {
            indicator.textContent = text;
            indicator.style.display = text ? 'block' : 'none';
        }
    }

    /**
     * Save layout data to the server.
     */
    async saveLayouts(threadId, layouts) {
        try {
            await api.saveLayouts(threadId, layouts);
        } catch (err) {
            console.error('Failed to save layouts:', err);
        }
    }

    /**
     * Clear the board.
     */
    clearBoard() {
        this.currentThreadId = null;
        this.canvas.clearTranslated();
        this.canvas.setMessages([]);
        this.clearSelection();
        document.getElementById('thread-selector').value = '';
    }

    /**
     * Handle clear board button.
     */
    async handleClearBoard() {
        if (!this.currentThreadId) return;

        if (confirm('Are you sure you want to delete this thread and all its messages?')) {
            try {
                await api.deleteThread(this.currentThreadId);
                this.clearBoard();
                await this.loadThreads();
            } catch (err) {
                console.error('Failed to delete thread:', err);
            }
        }
    }

    /**
     * Handle regenerate layout button.
     */
    async handleRegenerateLayout() {
        if (!this.currentThreadId) return;

        try {
            // Clear saved layouts on server
            await api.clearLayouts(this.currentThreadId);
            // Clear cached layouts so regeneration computes fresh
            this.canvas.clearLayoutCache();
            // Reload thread (will regenerate and save new layouts)
            await this.loadThread(this.currentThreadId);
        } catch (err) {
            console.error('Failed to regenerate layout:', err);
        }
    }

    /**
     * Handle export button - download thread as JSON.
     */
    async handleExport() {
        if (!this.currentThreadId) {
            alert('Please select a thread to export');
            return;
        }

        try {
            const data = await api.exportThread(this.currentThreadId);

            // Create download
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `${data.title.replace(/[^a-z0-9]/gi, '_')}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Failed to export thread:', err);
            alert('Failed to export thread');
        }
    }

    /**
     * Handle import - read JSON file and create thread.
     */
    async handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (!data.title) {
                alert('Invalid file: missing thread title');
                return;
            }

            const thread = await api.importThread(data);

            // Reload threads list and select the imported one
            await this.loadThreads();
            document.getElementById('thread-selector').value = thread.id;
            await this.loadThread(thread.id);

            alert(`Imported thread "${thread.title}" with ${thread.messages?.length || 0} messages.\nOnly root messages shown - translate them to reveal children.`);
        } catch (err) {
            console.error('Failed to import thread:', err);
            alert('Failed to import thread: ' + err.message);
        }

        // Reset file input
        event.target.value = '';
    }

    /**
     * Handle notify Discord button.
     */
    async handleNotifyDiscord() {
        if (!this.currentThreadId) {
            alert('Please select a thread first');
            return;
        }

        try {
            await api.notifyDiscord(this.currentThreadId);
            alert('Discord notification sent!');
        } catch (err) {
            alert('Failed to notify Discord: ' + err.message);
        }
    }

    /**
     * Handle message selection.
     */
    handleMessageSelect(message) {
        this.selectedMessage = message;
        this.updateParentSelection(message);
        // Show current translation state (don't animate - wait for mouse down)
        this.updateTranslationPanel(message);
        // Show/hide delete button
        const deleteBtn = document.getElementById('delete-message-btn');
        if (message) {
            deleteBtn.classList.remove('hidden');
        } else {
            deleteBtn.classList.add('hidden');
        }
    }

    /**
     * Handle delete message button.
     */
    async handleDeleteMessage() {
        if (!this.selectedMessage) return;

        const msg = this.selectedMessage;
        if (confirm(`Delete "${msg.writer_name}'s" message? This will also delete all replies.`)) {
            try {
                await api.deleteMessage(msg.id);
                this.clearSelection();
                await this.loadThread(this.currentThreadId);
            } catch (err) {
                console.error('Failed to delete message:', err);
            }
        }
    }

    /**
     * Handle message hover.
     */
    handleMessageHover(message) {
        // Could add hover preview here if desired
    }

    /**
     * Handle mouse down - start translation.
     */
    handleMouseDown(message) {
        if (!message) return;

        // Calculate duration based on content length only (author shown immediately)
        const totalChars = message.content.length;
        const charsPerSecond = 25;
        const duration = (totalChars / charsPerSecond) * 1000;

        // Start spiral color transition
        const startProgress = this.canvas.startTransition(message.id, duration);

        // Start text animation from current progress
        this.startTextAnimation(message, startProgress);
    }

    /**
     * Handle mouse up - pause translation.
     */
    handleMouseUp(message) {
        // Pause spiral transition
        this.canvas.pauseTransition();

        // Pause text animation
        this.pauseTextAnimation();
    }

    /**
     * Clear selection.
     */
    clearSelection() {
        this.selectedMessage = null;
        this.canvas.setSelected(null);
        this.updateTranslationPanel(null);
        document.getElementById('delete-message-btn').classList.add('hidden');
    }

    /**
     * Start text animation from a given progress.
     */
    startTextAnimation(message, startProgress = 0) {
        const writerEl = document.getElementById('writer-name');
        const contentEl = document.getElementById('message-content');

        // Cancel any ongoing animation
        this.pauseTextAnimation();

        // Always show author name immediately
        writerEl.textContent = message.writer_name;

        // Already fully translated - show content immediately
        if (this.canvas.translatedIds.has(message.id)) {
            contentEl.innerHTML = `<p>${this.escapeHtml(message.content)}</p>`;
            return;
        }

        const contentText = message.content;
        const totalChars = contentText.length;
        const charsPerSecond = 25; // Constant rate regardless of length
        const duration = (totalChars / charsPerSecond) * 1000;
        const startTime = performance.now();

        // Store current message for tracking
        this.animatingMessageId = message.id;

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const additionalProgress = elapsed / duration;
            const progress = Math.min(startProgress + additionalProgress, 1);
            const charsToShow = Math.floor(progress * totalChars);

            // Show content progressively
            contentEl.innerHTML = `<p>${this.escapeHtml(contentText.slice(0, charsToShow))}</p>`;

            if (progress < 1) {
                this.textAnimationId = requestAnimationFrame(animate);
            } else {
                this.textAnimationId = null;
                this.animatingMessageId = null;
            }
        };

        this.textAnimationId = requestAnimationFrame(animate);
    }

    /**
     * Pause text animation.
     */
    pauseTextAnimation() {
        if (this.textAnimationId) {
            cancelAnimationFrame(this.textAnimationId);
            this.textAnimationId = null;
        }
    }

    /**
     * Update the translation panel (show current state without animation).
     */
    updateTranslationPanel(message) {
        const writerEl = document.getElementById('writer-name');
        const contentEl = document.getElementById('message-content');

        this.pauseTextAnimation();

        if (message) {
            // Always show author name immediately
            writerEl.textContent = message.writer_name;

            const progress = this.canvas.getTransitionProgress(message.id);
            const contentText = message.content;
            const charsToShow = Math.floor(progress * contentText.length);

            // Show content up to current progress
            if (charsToShow === 0) {
                contentEl.innerHTML = '<p class="placeholder">Hold to translate...</p>';
            } else {
                contentEl.innerHTML = `<p>${this.escapeHtml(contentText.slice(0, charsToShow))}</p>`;
            }
        } else {
            writerEl.textContent = '';
            contentEl.innerHTML = '<p class="placeholder">Click on a spiral to translate...</p>';
        }
    }

    /**
     * Update parent selection display.
     */
    updateParentSelection(message) {
        const parentLabel = document.getElementById('selected-parent');
        const clearBtn = document.getElementById('clear-parent-btn');

        if (message) {
            parentLabel.textContent = `${message.writer_name}'s message`;
            clearBtn.classList.remove('hidden');
        } else {
            parentLabel.textContent = 'Root (new branch)';
            clearBtn.classList.add('hidden');
        }
    }

    /**
     * Clear parent selection.
     */
    clearParentSelection() {
        this.selectedMessage = null;
        this.canvas.setSelected(null);
        this.updateParentSelection(null);
    }

    /**
     * Toggle spiral settings visibility.
     */
    toggleSpiralSettings() {
        const settings = document.getElementById('spiral-settings');
        const arrow = document.querySelector('.toggle-arrow');
        settings.classList.toggle('hidden');
        arrow.classList.toggle('expanded');
    }

    /**
     * Reset spiral settings to defaults.
     */
    resetSpiralSettings() {
        // Collapse settings
        document.getElementById('spiral-settings').classList.add('hidden');
        document.querySelector('.toggle-arrow').classList.remove('expanded');

        // Reset branch point slider
        const branchSlider = document.getElementById('branch-point');
        branchSlider.value = 50;
        branchSlider.dataset.modified = 'false';
        document.getElementById('branch-point-value').textContent = 'Auto';

        // Reset curvature direction
        document.querySelector('input[name="curv-dir"][value="auto"]').checked = true;

        // Reset curvature tightness slider
        const tightnessSlider = document.getElementById('curv-tightness');
        tightnessSlider.value = 100;
        tightnessSlider.dataset.modified = 'false';
        document.getElementById('curv-tightness-value').textContent = 'Normal';
    }

    /**
     * Update branch point label from slider value.
     */
    updateBranchPointLabel(value) {
        document.getElementById('branch-point-value').textContent = `${value}%`;
    }

    /**
     * Update curvature tightness label from slider value.
     */
    updateTightnessLabel(value) {
        const label = document.getElementById('curv-tightness-value');
        if (value <= 50) {
            label.textContent = 'Tight';
        } else if (value <= 80) {
            label.textContent = 'Normal';
        } else {
            label.textContent = 'Loose';
        }
    }

    /**
     * Update branch point visibility based on parent selection.
     */
    updateBranchPointVisibility() {
        const branchGroup = document.getElementById('branch-point-group');
        if (this.selectedMessage) {
            branchGroup.classList.remove('hidden');
        } else {
            branchGroup.classList.add('hidden');
        }
    }

    /**
     * Collect spiral preferences from form inputs or drawn parameters.
     * @returns {Object|null} Spiral preferences or null if all auto
     */
    collectSpiralPreferences() {
        // If we have drawn parameters, use those
        if (this.drawnSpiralParams) {
            return { ...this.drawnSpiralParams };
        }

        // Otherwise fall back to slider values
        const prefs = {};

        // Branch point (only if parent selected and user modified)
        const branchSlider = document.getElementById('branch-point');
        if (this.selectedMessage && branchSlider.dataset.modified === 'true') {
            prefs.branchT = parseInt(branchSlider.value) / 100;
        }

        // Curvature direction
        const curvDir = document.querySelector('input[name="curv-dir"]:checked').value;
        if (curvDir !== 'auto') {
            prefs.curvatureDir = curvDir;
        }

        // Curvature tightness (only if user modified)
        const tightnessSlider = document.getElementById('curv-tightness');
        if (tightnessSlider.dataset.modified === 'true') {
            prefs.curvatureTightness = parseInt(tightnessSlider.value) / 100;
        }

        return Object.keys(prefs).length > 0 ? prefs : null;
    }

    /**
     * Show thread creation modal.
     */
    showThreadModal() {
        document.getElementById('thread-modal').classList.remove('hidden');
        document.getElementById('thread-title-input').value = '';
        document.getElementById('thread-title-input').focus();
    }

    /**
     * Hide thread creation modal.
     */
    hideThreadModal() {
        document.getElementById('thread-modal').classList.add('hidden');
    }

    /**
     * Handle thread creation.
     */
    async handleCreateThread() {
        const titleInput = document.getElementById('thread-title-input');
        const title = titleInput.value.trim();

        if (!title) return;

        try {
            const thread = await api.createThread(title);
            this.hideThreadModal();
            await this.loadThreads();
            document.getElementById('thread-selector').value = thread.id;
            await this.loadThread(thread.id);
        } catch (err) {
            console.error('Failed to create thread:', err);
        }
    }

    /**
     * Show message creation modal (for + button, no pre-drawn spiral).
     */
    showMessageModal() {
        if (!this.currentThreadId) {
            alert('Please select or create a thread first');
            return;
        }

        document.getElementById('message-modal').classList.remove('hidden');
        document.getElementById('writer-input').value = this.lastWriterName;
        document.getElementById('content-input').value = '';
        document.getElementById('content-input').focus();

        // Update parent selection display
        this.updateParentSelection(this.selectedMessage);

        // Reset spiral settings to defaults
        this.resetSpiralSettings();

        // Show/hide branch point based on parent selection
        this.updateBranchPointVisibility();

        // Clear any drawn params (using sliders instead)
        this.drawnSpiralParams = null;

        // Update hint
        this.updateDrawingHint('Use sliders below, or cancel and double-click a spiral to draw (drag for length, scroll for curl)');
    }

    /**
     * Hide message creation modal.
     */
    hideMessageModal() {
        document.getElementById('message-modal').classList.add('hidden');

        // Clear preview if any
        this.canvas.clearPreviewSpiral();
        this.drawnSpiralParams = null;
        this.lastPreviewTransform = null;
    }

    /**
     * Handle message creation.
     */
    async handleCreateMessage() {
        const writerName = document.getElementById('writer-input').value.trim();
        const content = document.getElementById('content-input').value.trim();

        if (!writerName || !content) {
            alert('Please fill in both writer name and content');
            return;
        }

        // Cache writer name for next message
        this.lastWriterName = writerName;

        const parentId = this.selectedMessage ? this.selectedMessage.id : null;
        const spiralPrefs = this.collectSpiralPreferences();

        try {
            const newMessage = await api.createMessage(this.currentThreadId, parentId, writerName, content, spiralPrefs);
            this.hideMessageModal();
            this.clearParentSelection();

            // Mark the new message as already translated (you wrote it, so you know what it says)
            this.canvas.markTranslated(newMessage.id);

            await this.loadThread(this.currentThreadId);

            // Save translation state after reload
            this.saveTranslationState();
        } catch (err) {
            console.error('Failed to create message:', err);
        }
    }

    // =========================================================================
    // Auth & Share Handlers
    // =========================================================================

    async handleLogout() {
        await api.logout();
        window.location.href = '/login';
    }

    async showShareModal() {
        if (!this.currentThreadId) {
            alert('Please select a thread first');
            return;
        }

        try {
            const data = await api.shareThread(this.currentThreadId);
            const url = window.location.origin + data.url;

            document.getElementById('share-link-input').value = url;
            document.getElementById('share-mode-select').value = data.share_mode;
            document.getElementById('share-modal').classList.remove('hidden');
        } catch (err) {
            console.error('Failed to create share link:', err);
            alert('Failed to create share link');
        }
    }

    hideShareModal() {
        document.getElementById('share-modal').classList.add('hidden');
    }

    copyShareLink() {
        const input = document.getElementById('share-link-input');
        input.select();
        navigator.clipboard.writeText(input.value).then(() => {
            const btn = document.getElementById('share-copy-btn');
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        });
    }

    async updateShareMode(mode) {
        if (!this.currentThreadId) return;
        try {
            await api.shareThread(this.currentThreadId, mode);
        } catch (err) {
            console.error('Failed to update share mode:', err);
        }
    }

    async revokeShare() {
        if (!this.currentThreadId) return;
        if (!confirm('Revoke this share link? Anyone with the link will lose access.')) return;

        try {
            await api.unshareThread(this.currentThreadId);
            this.hideShareModal();
        } catch (err) {
            console.error('Failed to revoke share:', err);
        }
    }

    /**
     * Escape HTML to prevent XSS.
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Save translation state to localStorage.
     */
    saveTranslationState() {
        if (!this.currentThreadId) return;
        const key = `nomai_translated_${this.currentThreadId}`;
        const ids = this.canvas.getTranslatedIds();
        localStorage.setItem(key, JSON.stringify(ids));
    }

    /**
     * Load translation state from localStorage.
     */
    loadTranslationState(threadId) {
        const key = `nomai_translated_${threadId}`;
        const stored = localStorage.getItem(key);
        if (stored) {
            try {
                const ids = JSON.parse(stored);
                this.canvas.restoreTranslated(ids);
            } catch (e) {
                console.error('Failed to parse translation state:', e);
            }
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new NomaiApp();
});
