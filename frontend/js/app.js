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

        // Auto-select thread from URL param
        const urlParams = new URLSearchParams(window.location.search);
        const threadParam = urlParams.get('thread');
        if (threadParam) {
            const threadId = parseInt(threadParam);
            if (threadId) {
                document.getElementById('thread-selector').value = threadId;
                await this.loadThread(threadId);
                window.history.replaceState({}, '', '/');
            }
        }

        // Start polling for friend request badge
        this.updateFriendBadge();
        this.badgeInterval = setInterval(() => this.updateFriendBadge(), 30000);
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


        // Delete message button
        document.getElementById('delete-message-btn').addEventListener('click', () => {
            this.handleDeleteMessage();
        });

        // Logout button
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.handleLogout());
        }

        // Friends button
        document.getElementById('friends-btn').addEventListener('click', () => {
            this.showFriendsModal();
        });

        // Friends modal events
        document.getElementById('friends-modal').addEventListener('click', (e) => {
            if (e.target.id === 'friends-modal') this.hideFriendsModal();
        });
        document.getElementById('friends-close-btn').addEventListener('click', () => {
            this.hideFriendsModal();
        });

        // Friends tab switching
        document.querySelectorAll('.friends-tab').forEach(tab => {
            tab.addEventListener('click', (e) => this.switchFriendsTab(e.target.dataset.tab));
        });

        // Friend search with debounce
        let searchTimeout = null;
        document.getElementById('friend-search-input').addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.searchFriends(e.target.value.trim()), 300);
        });

        // Collaborators button
        document.getElementById('collaborators-btn').addEventListener('click', () => {
            this.showCollaboratorsModal();
        });

        // Collaborators modal events
        document.getElementById('collaborators-modal').addEventListener('click', (e) => {
            if (e.target.id === 'collaborators-modal') this.hideCollaboratorsModal();
        });
        document.getElementById('collaborators-close-btn').addEventListener('click', () => {
            this.hideCollaboratorsModal();
        });
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
            this.currentThreadOwnerId = thread.user_id;

            // Show collaborators button when a thread is selected
            document.getElementById('collaborators-btn').classList.remove('hidden');

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
        document.getElementById('content-input').value = '';
        document.getElementById('content-input').focus();
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
        this.currentThreadOwnerId = null;
        this.canvas.clearTranslated();
        this.canvas.setMessages([]);
        this.clearSelection();
        document.getElementById('thread-selector').value = '';
        document.getElementById('collaborators-btn').classList.add('hidden');
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
     * Clear parent selection.
     */
    clearParentSelection() {
        this.selectedMessage = null;
        this.canvas.setSelected(null);
    }


    /**
     * Collect spiral preferences from form inputs or drawn parameters.
     * @returns {Object|null} Spiral preferences or null if all auto
     */
    collectSpiralPreferences() {
        if (this.drawnSpiralParams) {
            return { ...this.drawnSpiralParams };
        }
        return null;
    }

    /**
     * Show thread creation modal.
     */
    async showThreadModal() {
        document.getElementById('thread-modal').classList.remove('hidden');
        document.getElementById('thread-title-input').value = '';
        document.getElementById('thread-title-input').focus();

        // Populate friend checklist
        const checklist = document.getElementById('thread-friends-checklist');
        try {
            const friends = await api.getFriends();
            if (friends.length === 0) {
                checklist.innerHTML = '<p class="hint">No friends yet. Add friends to share threads with them.</p>';
            } else {
                checklist.innerHTML = friends.map(f => `
                    <label class="checkbox-label friend-checkbox">
                        <input type="checkbox" value="${f.friend_id}"> ${this.escapeHtml(f.friend_username)}
                    </label>
                `).join('');
            }
        } catch (err) {
            checklist.innerHTML = '<p class="hint">Failed to load friends</p>';
        }
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

        // Collect checked friend IDs
        const friendIds = Array.from(
            document.querySelectorAll('#thread-friends-checklist input[type="checkbox"]:checked')
        ).map(cb => parseInt(cb.value));

        try {
            const thread = await api.createThread(title, friendIds);
            this.hideThreadModal();
            await this.loadThreads();
            document.getElementById('thread-selector').value = thread.id;
            await this.loadThread(thread.id);
            this.showMessageModal(); // prompt for root message
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
        document.getElementById('content-input').value = '';
        document.getElementById('content-input').focus();

        // Clear any drawn params
        this.drawnSpiralParams = null;
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
        const writerName = document.getElementById('current-username').textContent.trim();
        const content = document.getElementById('content-input').value.trim();

        if (!content) {
            alert('Please enter a message');
            return;
        }

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
    // Auth Handlers
    // =========================================================================

    async handleLogout() {
        if (this.badgeInterval) clearInterval(this.badgeInterval);
        await api.logout();
        window.location.href = '/login';
    }

    // =========================================================================
    // Friends Modal
    // =========================================================================

    async showFriendsModal() {
        document.getElementById('friends-modal').classList.remove('hidden');
        this.switchFriendsTab('my-friends');
    }

    hideFriendsModal() {
        document.getElementById('friends-modal').classList.add('hidden');
    }

    switchFriendsTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.friends-tab[data-tab="${tabName}"]`).classList.add('active');

        // Update tab content
        document.querySelectorAll('.friends-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(`tab-${tabName}`).classList.add('active');

        // Load tab data
        if (tabName === 'my-friends') this.loadFriendsList();
        if (tabName === 'requests') this.loadFriendRequests();
        if (tabName === 'add-friend') {
            document.getElementById('friend-search-input').value = '';
            document.getElementById('friend-search-results').innerHTML = '<p class="hint">Type at least 2 characters to search</p>';
            document.getElementById('friend-search-input').focus();
        }
    }

    async loadFriendsList() {
        const container = document.getElementById('friends-list');
        try {
            const friends = await api.getFriends();
            if (friends.length === 0) {
                container.innerHTML = '<p class="hint">No friends yet. Use the "Add Friend" tab to find people.</p>';
                return;
            }
            container.innerHTML = friends.map(f => `
                <div class="friend-row">
                    <span class="friend-username">${this.escapeHtml(f.friend_username)}</span>
                    <button class="btn btn-small btn-danger" data-friend-id="${f.friend_id}">Remove</button>
                </div>
            `).join('');
            container.querySelectorAll('.btn-danger').forEach(btn => {
                btn.addEventListener('click', () => this.handleRemoveFriend(parseInt(btn.dataset.friendId)));
            });
        } catch (err) {
            container.innerHTML = '<p class="hint">Failed to load friends</p>';
        }
    }

    async loadFriendRequests() {
        try {
            const data = await api.getFriendRequests();
            const incomingEl = document.getElementById('incoming-requests');
            const outgoingEl = document.getElementById('outgoing-requests');

            if (data.incoming.length === 0) {
                incomingEl.innerHTML = '<p class="hint">No pending requests</p>';
            } else {
                incomingEl.innerHTML = data.incoming.map(r => `
                    <div class="request-row">
                        <span class="friend-username">${this.escapeHtml(r.sender_username)}</span>
                        <div class="request-actions">
                            <button class="btn btn-small btn-primary accept-btn" data-id="${r.id}">Accept</button>
                            <button class="btn btn-small btn-danger decline-btn" data-id="${r.id}">Decline</button>
                        </div>
                    </div>
                `).join('');
                incomingEl.querySelectorAll('.accept-btn').forEach(btn => {
                    btn.addEventListener('click', () => this.handleAcceptRequest(parseInt(btn.dataset.id)));
                });
                incomingEl.querySelectorAll('.decline-btn').forEach(btn => {
                    btn.addEventListener('click', () => this.handleDeclineRequest(parseInt(btn.dataset.id)));
                });
            }

            if (data.outgoing.length === 0) {
                outgoingEl.innerHTML = '<p class="hint">No outgoing requests</p>';
            } else {
                outgoingEl.innerHTML = data.outgoing.map(r => `
                    <div class="request-row">
                        <span class="friend-username">${this.escapeHtml(r.receiver_username)}</span>
                        <span class="hint">Pending</span>
                    </div>
                `).join('');
            }
        } catch (err) {
            console.error('Failed to load friend requests:', err);
        }
    }

    async searchFriends(query) {
        const container = document.getElementById('friend-search-results');
        if (query.length < 2) {
            container.innerHTML = '<p class="hint">Type at least 2 characters to search</p>';
            return;
        }

        try {
            const users = await api.searchUsers(query);
            if (users.length === 0) {
                container.innerHTML = '<p class="hint">No users found</p>';
                return;
            }
            container.innerHTML = users.map(u => `
                <div class="search-result-row">
                    <span class="friend-username">${this.escapeHtml(u.username)}</span>
                    <button class="btn btn-small btn-primary" data-user-id="${u.id}">Add</button>
                </div>
            `).join('');
            container.querySelectorAll('.btn-primary').forEach(btn => {
                btn.addEventListener('click', () => this.handleSendFriendRequest(parseInt(btn.dataset.userId), btn));
            });
        } catch (err) {
            container.innerHTML = '<p class="hint">Search failed</p>';
        }
    }

    async handleSendFriendRequest(userId, btn) {
        try {
            const result = await api.sendFriendRequest(userId);
            if (result.status === 'accepted') {
                btn.textContent = 'Friends!';
            } else if (result.status === 'already_friends') {
                btn.textContent = 'Already friends';
            } else if (result.status === 'already_pending') {
                btn.textContent = 'Pending';
            } else {
                btn.textContent = 'Sent!';
            }
            btn.disabled = true;
        } catch (err) {
            alert(err.message);
        }
    }

    async handleAcceptRequest(requestId) {
        try {
            await api.acceptFriendRequest(requestId);
            this.loadFriendRequests();
            this.updateFriendBadge();
        } catch (err) {
            console.error('Failed to accept request:', err);
        }
    }

    async handleDeclineRequest(requestId) {
        try {
            await api.declineFriendRequest(requestId);
            this.loadFriendRequests();
            this.updateFriendBadge();
        } catch (err) {
            console.error('Failed to decline request:', err);
        }
    }

    async handleRemoveFriend(friendUserId) {
        if (!confirm('Remove this friend? They will lose access to your shared threads.')) return;
        try {
            await api.removeFriend(friendUserId);
            this.loadFriendsList();
            // Reload threads in case collaborator access changed
            await this.loadThreads();
        } catch (err) {
            console.error('Failed to remove friend:', err);
        }
    }

    async updateFriendBadge() {
        try {
            const data = await api.getPendingRequestCount();
            const badge = document.getElementById('friend-request-badge');
            const tabBadge = document.getElementById('tab-request-badge');
            if (data.count > 0) {
                badge.textContent = data.count;
                badge.classList.remove('hidden');
                if (tabBadge) {
                    tabBadge.textContent = data.count;
                    tabBadge.classList.remove('hidden');
                }
            } else {
                badge.classList.add('hidden');
                if (tabBadge) tabBadge.classList.add('hidden');
            }
        } catch (err) {
            // Silently ignore badge update failures
        }
    }

    // =========================================================================
    // Collaborators Modal
    // =========================================================================

    async showCollaboratorsModal() {
        if (!this.currentThreadId) {
            alert('Please select a thread first');
            return;
        }

        document.getElementById('collaborators-modal').classList.remove('hidden');
        await this.loadCollaborators();
    }

    hideCollaboratorsModal() {
        document.getElementById('collaborators-modal').classList.add('hidden');
    }

    async loadCollaborators() {
        const listEl = document.getElementById('collaborators-list');
        const addEl = document.getElementById('add-collaborator-list');

        try {
            const [collaborators, friends] = await Promise.all([
                api.getThreadCollaborators(this.currentThreadId),
                api.getFriends()
            ]);

            const me = await api.getMe();
            const isOwner = me && this.currentThreadOwnerId === me.id;

            // Show current collaborators
            if (collaborators.length === 0) {
                listEl.innerHTML = '<p class="hint">No collaborators yet</p>';
            } else {
                listEl.innerHTML = collaborators.map(c => `
                    <div class="friend-row">
                        <span class="friend-username">${this.escapeHtml(c.username)}</span>
                        ${isOwner ? `<button class="btn btn-small btn-danger remove-collab" data-user-id="${c.user_id}">Remove</button>` : ''}
                    </div>
                `).join('');
                if (isOwner) {
                    listEl.querySelectorAll('.remove-collab').forEach(btn => {
                        btn.addEventListener('click', () => this.handleRemoveCollaborator(parseInt(btn.dataset.userId)));
                    });
                }
            }

            // Show friends that can be added (not already collaborators, owner only)
            if (!isOwner) {
                addEl.innerHTML = '<p class="hint">Only the thread owner can add collaborators</p>';
                return;
            }

            const collabIds = new Set(collaborators.map(c => c.user_id));
            const addable = friends.filter(f => !collabIds.has(f.friend_id));

            if (addable.length === 0) {
                addEl.innerHTML = '<p class="hint">All friends are already collaborators</p>';
            } else {
                addEl.innerHTML = addable.map(f => `
                    <div class="friend-row">
                        <span class="friend-username">${this.escapeHtml(f.friend_username)}</span>
                        <button class="btn btn-small btn-primary add-collab" data-user-id="${f.friend_id}">Add</button>
                    </div>
                `).join('');
                addEl.querySelectorAll('.add-collab').forEach(btn => {
                    btn.addEventListener('click', () => this.handleAddCollaborator(parseInt(btn.dataset.userId)));
                });
            }
        } catch (err) {
            listEl.innerHTML = '<p class="hint">Failed to load collaborators</p>';
            addEl.innerHTML = '';
            console.error('Failed to load collaborators:', err);
        }
    }

    async handleAddCollaborator(userId) {
        try {
            await api.addThreadCollaborator(this.currentThreadId, userId);
            await this.loadCollaborators();
        } catch (err) {
            alert(err.message);
        }
    }

    async handleRemoveCollaborator(userId) {
        try {
            await api.removeThreadCollaborator(this.currentThreadId, userId);
            await this.loadCollaborators();
        } catch (err) {
            console.error('Failed to remove collaborator:', err);
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
