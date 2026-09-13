/**
 * Main application controller.
 */

// Translation panel copy (single source so the strings can't drift apart)
const COPY_HOLD_TO_TRANSLATE = 'Hold on a spiral to translate it…';

// Touch and mouse get different instructions - "scroll to adjust" and
// "double-click" are unreachable on a phone.
const IS_COARSE = typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

// Past this much progress a translation keeps running after release. A
// 500-character message is 20 seconds at 25 chars/sec, and holding a finger
// still for that long is not a gesture anyone completes on a phone - so the
// hold is what commits to the translation, not what powers it.
const TRANSLATION_LATCH_AT = 0.15;

/**
 * Build the translation panel's empty state from its <template>, so the
 * markup exists in exactly one place.
 */
function panelEmptyNode() {
    const tpl = document.getElementById('panel-empty-template');
    const node = tpl.content.cloneNode(true);
    const hint = node.querySelector('.hint');
    if (hint) {
        hint.innerHTML = IS_COARSE ? hint.dataset.hintCoarse : hint.dataset.hintFine;
    }
    return node;
}

/** Short haptic tick, where the device supports it. */
function haptic(pattern) {
    if (!navigator.vibrate) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate(pattern);
}

class NomaiApp {
    constructor() {
        this.canvas = null;
        this.interaction = null;
        this.currentThreadId = null;
        this.selectedMessage = null;
        this.threadLoadGeneration = 0;
        this.threadListGeneration = 0;
        this.loadingThreadId = null;
        this.foregroundLoading = false;
        this.pendingTranslations = new Map();
        this.translationSaves = new Map();
        this.composerVersion = 0;
        this.threads = [];
        this.threadedConversation = false;
        this.conversationVisible = false;

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

        // Translation panel becomes a draggable sheet below 900px
        this.sheet = new BottomSheet(document.getElementById('translation-panel'), {
            grabs: [
                document.getElementById('sheet-handle'),
                document.getElementById('panel-header')
            ],
            scroller: document.getElementById('message-content'),
            onSnap: () => this.syncCanvasInsets()
        });
        this.syncCanvasInsets();
        this.outline = new ConversationOutline(document.getElementById('outline-list'), id => {
            const message = this.canvas.getMessage(id);
            if (message && !this.foregroundLoading) this.handleMessageSelect(message);
        });
        this.canvas.onVisibilityChange = () => this.updateConversation();
        const outlineDetails = document.getElementById('conversation-outline');
        outlineDetails.open = !this.sheet.enabled;
        outlineDetails.addEventListener('toggle', () => {
            if (outlineDetails.open && this.sheet.enabled) this.sheet.snapTo(BottomSheet.FULL);
        });

        // Bind UI events
        this.bindUIEvents();

        // Paint the panel's empty state (its markup lives in a <template>)
        this.updateTranslationPanel(null);

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
                // Strip the thread param but keep the debug flag alive
                window.history.replaceState({}, '', window.NOMAI_DEBUG ? '/?debug=1' : '/');
            }
        }

        // Start polling for friend request badge
        this.updateFriendBadge();
        this.badgeInterval = setInterval(() => this.updateFriendBadge(), 30000);
        this.refreshInterval = setInterval(() => this.refreshThreads(), 15000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.refreshThreads();
        });
        window.addEventListener('online', () => this.refreshThreads());

        // Re-render once the heading webfont is ready (canvas text uses it)
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => this.canvas.render());
        }
    }

    /**
     * Load and display current user info.
     */
    async loadUserInfo() {
        try {
            const user = await api.getMe();
            if (user) {
                this.currentUserId = user.id;
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
        this.bindHeaderMenu();
        document.getElementById('write-message-btn').addEventListener('click', () => this.showMessageModal());
        document.getElementById('translate-message-btn').addEventListener('click', () => {
            if (this.selectedMessage && !this.foregroundLoading) this.handleMouseDown(this.selectedMessage);
        });
        const threadedToggle = document.getElementById('threaded-view-toggle');
        threadedToggle.checked = this.threadedConversation;
        threadedToggle.addEventListener('change', event => {
            this.setThreadedConversation(event.currentTarget.checked);
        });

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

        document.getElementById('collision-adjust-btn').addEventListener('click', () => this.finishCollisionChoice('adjust'));
        document.getElementById('collision-cancel-btn').addEventListener('click', () => this.hideCollisionModal());

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
            tab.addEventListener('click', (e) => this.switchFriendsTab(e.currentTarget.dataset.tab));
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

        // Settings button + modal events
        document.getElementById('settings-btn').addEventListener('click', () => {
            this.showSettingsModal();
        });
        document.getElementById('settings-modal').addEventListener('click', (e) => {
            if (e.target.id === 'settings-modal') this.hideSettingsModal();
        });
        document.getElementById('settings-close-btn').addEventListener('click', () => {
            this.hideSettingsModal();
        });
        document.getElementById('settings-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleSaveSettings();
        });

        // Canvas view controls
        document.getElementById('zoom-in-btn').addEventListener('click', () => {
            this.canvas.zoomAt(this.canvas.width / 2, this.canvas.height / 2, 1.25);
        });
        document.getElementById('zoom-out-btn').addEventListener('click', () => {
            this.canvas.zoomAt(this.canvas.width / 2, this.canvas.height / 2, 1 / 1.25);
        });
        document.getElementById('fit-view-btn').addEventListener('click', () => {
            this.canvas.fitToContent();
        });

        // Escape closes the topmost open modal (drawing mode has its own Escape
        // handler, and a modal is never open while drawing)
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (this.interaction && this.interaction.isDrawing()) return;
            if (this.isHeaderMenuOpen()) {
                this.hideHeaderMenu();
                document.getElementById('header-menu-btn').focus();
                return;
            }
            const hideFns = {
                'message-modal': () => this.hideMessageModal(),
                'thread-modal': () => this.hideThreadModal(),
                'collision-modal': () => this.hideCollisionModal(),
                'confirm-modal': () => this.pendingConfirmCancel && this.pendingConfirmCancel(),
                'friends-modal': () => this.hideFriendsModal(),
                'collaborators-modal': () => this.hideCollaboratorsModal(),
                'settings-modal': () => this.hideSettingsModal()
            };
            const open = document.querySelector('.modal:not(.hidden)');
            if (open && hideFns[open.id]) hideFns[open.id]();
        });

        this.bindDrawingControls();
    }

    /**
     * On-canvas controls for spiral drawing.
     *
     * Curl was previously bound only to the mouse wheel and cancel only to
     * Escape, so on a touch device the curl was stuck at its default and there
     * was no way out of drawing mode at all.
     */
    bindDrawingControls() {
        const slider = document.getElementById('curl-slider');
        const dirBtn = document.getElementById('curl-dir-btn');
        const cancelBtn = document.getElementById('draw-cancel-btn');

        slider.addEventListener('input', (e) => {
            this.interaction.setCurvature(parseFloat(e.target.value));
        });
        dirBtn.addEventListener('click', () => {
            this.interaction.toggleCurvatureDir();
            this.syncDrawingControls();
        });
        cancelBtn.addEventListener('click', () => {
            this.interaction.cancelDrawing();
        });
    }

    /**
     * Show or hide the drawing controls and mirror the handler's current
     * curl/direction into them.
     */
    syncDrawingControls(visible = null) {
        const bar = document.getElementById('drawing-controls');
        if (!bar) return;

        const show = visible === null
            ? this.interaction.getDrawingState() === InteractionHandler.STATE_DRAWING_SPIRAL
            : visible;
        bar.classList.toggle('hidden', !show);
        document.body.classList.toggle('is-drawing', this.interaction.isDrawing());
        if (!show) return;

        document.getElementById('curl-slider').value = this.interaction.previewCurvature;
        document.getElementById('curl-dir-btn').textContent =
            this.interaction.previewCurvatureDir === 1 ? '↻' : '↺';
    }

    /**
     * Tell the canvas how much of it the collapsed sheet covers, so fitting
     * frames content in the part that is actually visible.
     */
    syncCanvasInsets() {
        if (!this.sheet || !this.sheet.enabled) {
            this.canvas.setViewInsets(null);
            return;
        }
        const peek = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek'), 10
        );
        this.canvas.setViewInsets({ bottom: Number.isFinite(peek) ? peek : 96 });
    }

    // =========================================================================
    // Overflow menu
    // =========================================================================

    /**
     * Bind the header overflow menu. Every secondary control lives in here at
     * all widths, which is what lets the visible header stay at a readable
     * size instead of being clamped down to fit ten buttons.
     */
    bindHeaderMenu() {
        const btn = document.getElementById('header-menu-btn');
        const menu = document.getElementById('header-menu');
        const backdrop = document.getElementById('header-menu-backdrop');

        btn.addEventListener('click', () => this.toggleHeaderMenu());
        backdrop.addEventListener('click', () => this.hideHeaderMenu());

        // Any action inside the menu closes it; the handlers themselves are
        // bound separately in bindUIEvents()
        menu.addEventListener('click', (e) => {
            if (e.target.closest('.btn')) this.hideHeaderMenu();
        });
    }

    toggleHeaderMenu() {
        const menu = document.getElementById('header-menu');
        if (menu.classList.contains('hidden')) this.showHeaderMenu();
        else this.hideHeaderMenu();
    }

    showHeaderMenu() {
        document.getElementById('header-menu').classList.remove('hidden');
        document.getElementById('header-menu-backdrop').classList.remove('hidden');
        document.getElementById('header-menu-btn').setAttribute('aria-expanded', 'true');
    }

    hideHeaderMenu() {
        document.getElementById('header-menu').classList.add('hidden');
        document.getElementById('header-menu-backdrop').classList.add('hidden');
        document.getElementById('header-menu-btn').setAttribute('aria-expanded', 'false');
    }

    isHeaderMenuOpen() {
        return !document.getElementById('header-menu').classList.contains('hidden');
    }

    // =========================================================================
    // Confirmation dialog
    // =========================================================================

    /**
     * Styled replacement for native confirm(), which is unreadable on mobile
     * and breaks out of the app's visual language.
     * @returns {Promise<boolean>}
     */
    confirmDialog(message, { title = 'Confirm', confirmLabel = 'Delete' } = {}) {
        const modal = document.getElementById('confirm-modal');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-body').textContent = message;
        okBtn.textContent = confirmLabel;

        // Focus Cancel, not the destructive button - Enter should never be
        // what deletes a thread
        this.openModal(modal);
        cancelBtn.focus();

        return new Promise((resolve) => {
            const done = (result) => {
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                modal.removeEventListener('click', onBackdrop);
                this.closeModal(modal);
                resolve(result);
            };
            const onOk = () => done(true);
            const onCancel = () => done(false);
            const onBackdrop = (e) => {
                if (e.target === modal) done(false);
            };

            this.pendingConfirmCancel = onCancel;
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            modal.addEventListener('click', onBackdrop);
        });
    }

    // =========================================================================
    // Modal focus management
    // =========================================================================

    /**
     * Show a modal and trap focus inside it. The dialogs are marked
     * aria-modal, but nothing was stopping Tab from walking out into the
     * page behind them.
     */
    openModal(modal) {
        this.lastFocused = document.activeElement;
        modal.classList.remove('hidden');

        if (!modal.dataset.trapBound) {
            modal.addEventListener('keydown', (e) => {
                if (e.key !== 'Tab') return;
                const items = modal.querySelectorAll(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                const focusable = Array.from(items).filter((el) => el.offsetParent !== null);
                if (focusable.length === 0) return;

                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            });
            modal.dataset.trapBound = '1';
        }
    }

    closeModal(modal) {
        modal.classList.add('hidden');
        if (this.lastFocused && this.lastFocused.focus) {
            this.lastFocused.focus();
            this.lastFocused = null;
        }
    }

    /**
     * Show the settings modal, pre-filled with the user's Discord webhook.
     */
    async showSettingsModal() {
        const input = document.getElementById('discord-webhook-input');
        input.value = '';
        this.openModal(document.getElementById('settings-modal'));
        try {
            const me = await api.getMe();
            if (me && me.discord_webhook) input.value = me.discord_webhook;
        } catch (err) {
            // Leave the field empty on failure
        }
    }

    hideSettingsModal() {
        this.closeModal(document.getElementById('settings-modal'));
    }

    /**
     * Save the user's personal Discord webhook URL.
     */
    async handleSaveSettings() {
        const url = document.getElementById('discord-webhook-input').value.trim();
        try {
            await api.setDiscordWebhook(url);
            this.hideSettingsModal();
            toast.success(url ? 'Discord webhook saved.' : 'Discord webhook cleared.');
        } catch (err) {
            toast.error('Failed to save: ' + err.message);
        }
    }

    /**
     * Load all threads into selector.
     */
    async loadThreads({ quiet = false } = {}) {
        const generation = ++this.threadListGeneration;
        try {
            const threads = await api.getThreads();
            if (generation !== this.threadListGeneration) return;
            this.threads = threads;
            this.renderThreadOptions();
        } catch (err) {
            if (!quiet) toast.error(err.message);
        }
    }

    renderThreadOptions() {
        const selector = document.getElementById('thread-selector');
        const selected = this.loadingThreadId || this.currentThreadId || '';
        const fragment = document.createDocumentFragment();
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'Select a thread...';
        fragment.append(empty);
        for (const thread of this.threads) {
            const option = document.createElement('option');
            option.value = thread.id;
            let unread = thread.unread_count || 0;
            if (thread.id === this.currentThreadId) {
                unread = this.canvas.messages.filter(m => !this.canvas.translatedIds.has(m.id)).length;
            }
            option.textContent = `${thread.title} (${thread.message_count} messages${unread ? ` · ${unread} unread` : ''})`;
            fragment.append(option);
        }
        selector.replaceChildren(fragment);
        selector.value = selected;
    }

    isInteracting() {
        return this.interaction.isDrawing() || this.interaction.isMouseDown ||
            !!this.canvas.activeTransition || this.canvas.revealTimers.size > 0 ||
            this.canvas.drawAnimations.size > 0 || !!document.querySelector('.modal:not(.hidden)');
    }

    async refreshThreads() {
        if (document.hidden || this.pollInFlight) return;
        this.pollInFlight = true;
        try {
            await Promise.all([...this.pendingTranslations.keys()].map(id => this.flushTranslations(id)));
            await this.loadThreads({ quiet: true });
            if (this.currentThreadId && !this.loadingThreadId && !this.isInteracting()) {
                await this.loadThread(this.currentThreadId, { background: true });
            }
        } finally {
            this.pollInFlight = false;
        }
    }

    /** Fetch everything before committing any state; a newer request always wins. */
    async loadThread(threadId, { background = false } = {}) {
        if (background && (this.loadingThreadId || this.isInteracting() || this.currentThreadId !== threadId)) return false;
        if (!background) {
            this.stopTranslation();
            this.interaction.cancelDrawing();
            if (this.currentThreadId !== threadId) this.clearBoard();
        }
        const generation = ++this.threadLoadGeneration;
        this.loadingThreadId = threadId;
        this.foregroundLoading = !background;
        document.getElementById('canvas-container').setAttribute('aria-busy', String(!background));
        document.getElementById('thread-selector').value = threadId;
        try {
            const [thread, progress, collaborators] = await Promise.all([
                api.getThread(threadId), this.fetchTranslationProgress(threadId),
                api.getThreadCollaborators(threadId).catch(() => null)
            ]);
            if (generation !== this.threadLoadGeneration || (background && this.isInteracting())) return false;
            const sameThread = this.currentThreadId === threadId;
            const snapshot = JSON.stringify(thread);
            if (background && snapshot === this.threadSnapshot &&
                progress.ids.every(id => this.canvas.translatedIds.has(id)) &&
                !this.readLegacyTranslations(thread).entries.length) {
                this.updateThreadPermissions(collaborators);
                const status = document.getElementById('thread-updates');
                if (status.textContent.startsWith('Could not refresh')) status.textContent = '';
                return true;
            }
            const oldIds = new Set(sameThread ? this.canvas.messages.map(m => m.id) : []);
            const selectedId = sameThread ? this.selectedMessage?.id : null;
            if (!sameThread) this.canvas.clearTranslated();
            this.restoreTranslationState(thread, progress, sameThread);
            this.currentThreadId = threadId;
            this.currentThreadOwnerId = thread.user_id;
            this.currentThreadCreatedAt = thread.created_at;
            this.threadSnapshot = snapshot;
            this.updateThreadPermissions(collaborators);
            this.canvas.setMessagesProgressiveReveal(thread.messages,
                layouts => {
                    this.saveLayouts(threadId, layouts);
                    this.checkForCollisionConflicts();
                },
                id => this.saveTranslation(id, threadId), sameThread);
            const selected = this.canvas.getMessage(selectedId);
            if (selected && this.canvas.visibleMessageIds.has(selected.id)) this.handleMessageSelect(selected);
            else this.clearSelection();
            if (background) {
                const added = thread.messages.filter(m => !oldIds.has(m.id)).length;
                if (added) document.getElementById('thread-updates').textContent =
                    `${added} new ${added === 1 ? 'message' : 'messages'}. Translate the conversation to uncover replies.`;
            }
            this.updateConversation();
            this.renderThreadOptions();
            return true;
        } catch (err) {
            if (generation === this.threadLoadGeneration) {
                if (err.status === 403 || err.status === 404) {
                    this.clearBoard();
                    document.getElementById('thread-updates').textContent = 'This thread is no longer available.';
                } else if (background) document.getElementById('thread-updates').textContent = 'Could not refresh. Retrying automatically.';
                else toast.error(err.message);
            }
            return false;
        } finally {
            if (generation === this.threadLoadGeneration) {
                this.loadingThreadId = null;
                this.foregroundLoading = false;
                document.getElementById('canvas-container').setAttribute('aria-busy', 'false');
                document.getElementById('thread-selector').value = this.currentThreadId || '';
            }
        }
    }

    updateThreadPermissions(collaborators) {
        const active = !!this.currentThreadId;
        const owner = active && this.currentUserId === this.currentThreadOwnerId;
        for (const id of ['clear-thread-btn', 'regenerate-btn']) {
            document.getElementById(id).classList.toggle('hidden', !owner);
        }
        document.getElementById('collaborators-btn').classList.toggle('hidden', !active);
        this.updateWriteMessageVisibility();
        this.updateConversationVisibility();
        if (collaborators !== null) document.getElementById('notify-btn').classList.toggle('hidden', !active || !collaborators?.length);
    }

    updateConversation() {
        if (this.outline) this.outline.render(this.canvas);
        const unread = this.canvas.messages.filter(m => !this.canvas.translatedIds.has(m.id)).length;
        document.getElementById('thread-unread-count').textContent = unread ? `${unread} unread` : 'All translated';
        this.updateWriteMessageVisibility();
        this.updateReadingActions();
    }

    updateWriteMessageVisibility() {
        const canStartConversation = !!this.currentThreadId && this.canvas.messages.length === 0;
        document.getElementById('write-message-btn').classList.toggle('hidden', !canStartConversation);
    }

    updateConversationVisibility() {
        const outline = document.getElementById('conversation-outline');
        const show = !!this.currentThreadId && this.threadedConversation;
        const wasShowing = !!this.conversationVisible;
        this.conversationVisible = show;
        outline.classList.toggle('hidden', !show);
        if (!show) outline.open = false;
        else if (!wasShowing) outline.open = true;
    }

    setThreadedConversation(threaded) {
        this.threadedConversation = !!threaded;
        document.getElementById('threaded-view-toggle').checked = this.threadedConversation;
        this.updateConversationVisibility();
        this.updateConversation();
    }

    updateReadingActions() {
        const message = this.selectedMessage;
        document.getElementById('reading-actions').classList.toggle('hidden', !message);
        const button = document.getElementById('translate-message-btn');
        const complete = message && this.canvas.translatedIds.has(message.id);
        button.disabled = !message || complete;
        button.textContent = complete ? 'Translated' :
            (message && this.canvas.isTransitionRunning(message.id) ? 'Pause' : 'Translate');
    }

    checkForCollisionConflicts() {
        const conflicts = this.canvas.getCollisionConflicts();
        if (conflicts.length) toast.info('Adjusted spiral placement to avoid overlap where possible.');
    }

    showCollisionModal() {
        this.openModal(document.getElementById('collision-modal'));
        return new Promise(resolve => { this.resolveCollision = resolve; });
    }

    finishCollisionChoice(choice) {
        const resolve = this.resolveCollision;
        this.resolveCollision = null;
        this.closeModal(document.getElementById('collision-modal'));
        if (resolve) resolve(choice);
    }

    hideCollisionModal() { this.finishCollisionChoice(null); }
    handleCollisionAllow() { this.finishCollisionChoice('allow'); }

    /**
     * Handle branch point moving along spiral (during selection).
     */
    handleBranchPointMove(parentMessage, point, branchT) {
        // Drawing takes over from reading: a latched translation would
        // otherwise keep revealing text in the panel mid-gesture
        this.stopTranslation();
        this.canvas.setBranchPointMarker(point, branchT);
        this.updateStatusIndicator(IS_COARSE
            ? 'Drag along the spiral to place the branch, then lift'
            : 'Move along spiral to select branch point, click to confirm');
        this.syncDrawingControls(false);
    }

    /**
     * Handle branch point confirmed - now entering spiral drawing mode.
     */
    handleBranchPointConfirm(parentMessage, point, branchT) {
        this.stopTranslation();
        this.drawingParentMessage = parentMessage;
        this.drawingBranchPoint = point;
        this.drawingBranchT = branchT;
        this.updateStatusIndicator(IS_COARSE
            ? 'Drag to aim, set the curl below, then lift to place'
            : 'Drag to set direction & length, scroll or use the slider for curl, click to confirm');
        this.syncDrawingControls(true);
        // The sheet would sit on top of the controls
        if (this.sheet) this.sheet.collapse();
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
        this.updateStatusIndicator(`Curl: ${curlDegrees}° ${dirLabel}`);
        this.syncDrawingControls(true);
    }

    /**
     * Handle spiral confirmed - open modal with parameters.
     */
    async handleSpiralConfirm(data) {
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

        const threadId = this.currentThreadId;
        const generation = this.threadLoadGeneration;
        const existing = this.canvas.messages.filter(m => m.spiralData)
            .map(m => ({ points: m.spiralData.points, nodeId: m.id }));
        if (this.canvas.previewSpiral && checkSpiralIntersection(this.canvas.previewSpiral.points, existing, 3, data.parentMessage.id)) {
            this.syncDrawingControls(false);
            const choice = await this.showCollisionModal();
            if (!choice || this.currentThreadId !== threadId || this.threadLoadGeneration !== generation) {
                this.handleDrawingCancel();
                return;
            }
            this.drawnSpiralParams.allowOverlap = choice === 'allow';
            this.drawnSpiralParams.autoAdjust = choice === 'adjust';
        }
        // Set parent message for the modal
        this.selectedMessage = data.parentMessage;

        // Clear status indicator
        this.updateStatusIndicator('');
        this.syncDrawingControls(false);

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
        this.syncDrawingControls(false);
    }

    /**
     * Show message modal with pre-drawn spiral.
     */
    showMessageModalWithDrawnSpiral() {
        if (!this.currentThreadId) {
            toast.info('Select or create a thread first.');
            this.handleDrawingCancel();
            return;
        }

        this.composerVersion++;
        this.composerThreadId = this.currentThreadId;
        document.getElementById('message-modal-title').textContent = 'Write a reply';
        this.openModal(document.getElementById('message-modal'));
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
            toast.error(err.message);
        }
    }

    /**
     * Clear the board.
     */
    clearBoard() {
        this.threadLoadGeneration++;
        this.loadingThreadId = null;
        this.foregroundLoading = false;
        this.stopTranslation();
        this.interaction.cancelDrawing();
        this.threadSnapshot = null;
        this.currentThreadId = null;
        this.currentThreadOwnerId = null;
        this.canvas.clearTranslated();
        this.canvas.setMessages([]);
        this.clearSelection();
        document.getElementById('thread-selector').value = '';
        document.getElementById('collaborators-btn').classList.add('hidden');
        document.getElementById('notify-btn').classList.add('hidden');
        document.getElementById('clear-thread-btn').classList.add('hidden');
        document.getElementById('thread-updates').textContent = '';
        document.getElementById('canvas-container').setAttribute('aria-busy', 'false');
        this.updateThreadPermissions([]);
        this.updateConversation();
    }

    /**
     * Handle clear board button.
     */
    async handleClearBoard() {
        if (!this.currentThreadId || this.foregroundLoading) return;

        const threadId = this.currentThreadId;
        const ok = await this.confirmDialog(
            'This deletes the thread and every message in it. This cannot be undone.',
            { title: 'Delete thread', confirmLabel: 'Delete thread' }
        );
        if (ok && this.currentThreadId === threadId) {
            try {
                await api.deleteThread(threadId);
                if (this.currentThreadId === threadId) this.clearBoard();
                await this.loadThreads();
                toast.success('Thread deleted.');
            } catch (err) {
                console.error('Failed to delete thread:', err);
                toast.error(err.message);
            }
        }
    }

    /**
     * Handle regenerate layout button.
     */
    async handleRegenerateLayout() {
        if (!this.currentThreadId || this.foregroundLoading) return;
        const threadId = this.currentThreadId;
        try {
            // Clear saved layouts on server
            await api.clearLayouts(threadId);
            if (this.currentThreadId !== threadId) return;
            // Clear cached layouts so regeneration computes fresh
            this.canvas.clearLayoutCache();
            // Reload thread (will regenerate and save new layouts)
            await this.loadThread(this.currentThreadId);
        } catch (err) {
            console.error('Failed to regenerate layout:', err);
            toast.error(err.message);
        }
    }

    /**
     * Handle export button - download thread as JSON.
     */
    async handleExport() {
        if (!this.currentThreadId) {
            toast.info('Select a thread to export first.');
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
            toast.success('Thread exported.');
        } catch (err) {
            console.error('Failed to export thread:', err);
            toast.error(err.message);
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
                toast.error('Invalid file: missing thread title');
                event.target.value = '';
                return;
            }

            const thread = await api.importThread(data);

            // Reload threads list and select the imported one
            await this.loadThreads();
            document.getElementById('thread-selector').value = thread.id;
            await this.loadThread(thread.id);

            toast.success(`Imported "${thread.title}" (${thread.messages?.length || 0} messages). Translate the roots to reveal replies.`);
        } catch (err) {
            console.error('Failed to import thread:', err);
            toast.error('Import failed: ' + err.message);
        }

        // Reset file input
        event.target.value = '';
    }

    /**
     * Handle notify Discord button.
     */
    async handleNotifyDiscord() {
        if (!this.currentThreadId) {
            toast.info('Select a thread first.');
            return;
        }

        try {
            const result = await api.notifyDiscord(this.currentThreadId);
            if (result.success) {
                const n = result.notified || 0;
                toast.success(`Discord notification sent to ${n} ${n === 1 ? 'person' : 'people'}.`);
            } else {
                toast.info(result.message || 'No one was notified.');
            }
        } catch (err) {
            toast.error('Failed to notify Discord: ' + err.message);
        }
    }

    /**
     * Handle message selection.
     */
    handleMessageSelect(message) {
        // Moving to a different glyph ends any latched translation, so it
        // doesn't keep running on a spiral you are no longer reading
        const previous = this.selectedMessage;
        if (previous && (!message || message.id !== previous.id)) {
            this.stopTranslation();
        }

        this.selectedMessage = message;
        this.canvas.setSelected(message ? message.id : null);
        // Show current translation state (don't animate - wait for mouse down)
        this.updateTranslationPanel(message);
        // Show/hide delete button
        const deleteBtn = document.getElementById('delete-message-btn');
        if (message && this.currentUserId === this.currentThreadOwnerId) {
            deleteBtn.classList.remove('hidden');
        } else {
            deleteBtn.classList.add('hidden');
        }

        // On mobile, bring the sheet up far enough to read into
        if (this.sheet) {
            if (message) this.sheet.reveal();
            else this.sheet.collapse();
        }
        this.updateConversation();
    }

    /**
     * Handle delete message button.
     */
    async handleDeleteMessage() {
        if (!this.selectedMessage || this.foregroundLoading) return;
        const threadId = this.currentThreadId;
        const msg = this.selectedMessage;
        const ok = await this.confirmDialog(
            `Delete ${msg.writer_name}'s message? Every reply beneath it goes too.`,
            { title: 'Delete message', confirmLabel: 'Delete' }
        );
        if (ok && this.currentThreadId === threadId) {
            try {
                await api.deleteMessage(msg.id);
                if (this.currentThreadId !== threadId) return;
                this.clearSelection();
                await this.loadThread(threadId);
                await this.loadThreads();
            } catch (err) {
                console.error('Failed to delete message:', err);
                toast.error(err.message);
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
     * How long a full translation takes for the given text.
     * 25 chars/sec, but never under 2s so a stray click can't
     * instantly translate a short message - you have to hold.
     */
    translationDuration(content) {
        const charsPerSecond = 25;
        return Math.max(2000, (content.length / charsPerSecond) * 1000);
    }

    /**
     * Handle mouse down - start translation.
     */
    handleMouseDown(message) {
        if (!message || this.foregroundLoading) return;

        // A latched translation is already running unattended - pressing it
        // again is how you pause it.
        if (this.canvas.isTransitionRunning(message.id)) {
            this.stopTranslation();
            return;
        }

        // Duration based on content length only (author shown immediately)
        const duration = this.translationDuration(message.content);

        // Start spiral color transition
        const startProgress = this.canvas.startTransition(message.id, duration);

        // Start text animation from current progress
        this.startTextAnimation(message, startProgress);

        if (startProgress < 1) haptic(8);
        this.updateReadingActions();
    }

    /**
     * Handle mouse up. Past the latch point the translation carries on by
     * itself; before it, releasing pauses as usual.
     */
    handleMouseUp(message) {
        if (message && this.canvas.isTransitionRunning(message.id)) {
            const progress = this.canvas.getTransitionProgress(message.id);
            if (progress >= TRANSLATION_LATCH_AT && progress < 1) return;
        }
        this.stopTranslation();
    }

    /**
     * Pause the spiral transition and the text reveal together.
     */
    stopTranslation() {
        this.canvas.pauseTransition();
        this.pauseTextAnimation();
        this.updateReadingActions();
    }

    /**
     * Clear selection.
     */
    clearSelection() {
        this.stopTranslation();
        this.selectedMessage = null;
        this.canvas.setSelected(null);
        this.updateTranslationPanel(null);
        document.getElementById('delete-message-btn').classList.add('hidden');
        this.updateConversation();
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
            this.setTranslationProgress(1);
            return;
        }

        const contentText = message.content;
        const totalChars = contentText.length;
        // Must match the spiral transition so text and color stay in sync
        const duration = this.translationDuration(contentText);
        const startTime = performance.now();

        // Store current message for tracking
        this.animatingMessageId = message.id;
        contentEl.classList.add('translating');

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const additionalProgress = elapsed / duration;
            const progress = Math.min(startProgress + additionalProgress, 1);
            const charsToShow = Math.floor(progress * totalChars);

            // Show content progressively
            contentEl.innerHTML = `<p>${this.escapeHtml(contentText.slice(0, charsToShow))}</p>`;
            this.setTranslationProgress(progress);

            if (progress < 1) {
                this.textAnimationId = requestAnimationFrame(animate);
            } else {
                this.textAnimationId = null;
                this.animatingMessageId = null;
                contentEl.classList.remove('translating');
                haptic([12, 40, 12]);
                this.updateConversation();
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
        const contentEl = document.getElementById('message-content');
        if (contentEl) contentEl.classList.remove('translating');
    }

    /**
     * Drive the thin progress bar under the panel header.
     * Hidden at 0 (nothing started) and at 1 (fully translated).
     */
    setTranslationProgress(progress) {
        const track = document.getElementById('translation-progress');
        const bar = document.getElementById('translation-progress-bar');
        if (!track || !bar) return;
        track.classList.toggle('hidden', progress <= 0 || progress >= 1);
        bar.style.width = `${Math.min(100, Math.round(progress * 100))}%`;

        const writerEl = document.getElementById('writer-name');
        if (writerEl) writerEl.classList.toggle('translated', progress >= 1);
        if (this.threadedConversation && this.outline && this.selectedMessage) {
            this.outline.updateTranslation(this.selectedMessage, progress);
        }

        this.updatePeekPreview();
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
            this.setTranslationProgress(progress);

            // Show content up to current progress
            if (charsToShow === 0) {
                contentEl.innerHTML = `<p class="placeholder">${COPY_HOLD_TO_TRANSLATE}</p>`;
            } else {
                contentEl.innerHTML = `<p>${this.escapeHtml(contentText.slice(0, charsToShow))}</p>`;
            }
        } else {
            writerEl.textContent = '';
            writerEl.classList.remove('translated');
            this.setTranslationProgress(0);
            contentEl.replaceChildren(panelEmptyNode());
        }
        this.updatePeekPreview();
    }

    /**
     * One-line summary shown in the panel header while the mobile sheet is
     * collapsed, so a peeked sheet still carries information.
     */
    updatePeekPreview() {
        const el = document.getElementById('peek-preview');
        if (!el) return;

        // Only visible on a collapsed mobile sheet - skip the work otherwise
        // (this runs from the per-frame progress update)
        if (!this.sheet || !this.sheet.enabled || this.sheet.state !== BottomSheet.PEEK) {
            if (el.textContent) el.textContent = '';
            return;
        }

        const msg = this.selectedMessage;
        if (!msg) {
            // The collapsed sheet is otherwise just an empty bar
            el.textContent = 'Tap a glyph on the wall to begin';
            return;
        }

        const progress = this.canvas.getTransitionProgress(msg.id);
        if (progress <= 0) {
            el.textContent = 'Press and hold the spiral to translate';
            return;
        }
        const shown = msg.content.slice(0, Math.floor(progress * msg.content.length));
        el.textContent = shown.replace(/\s+/g, ' ').trim() || 'Translating…';
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
        this.openModal(document.getElementById('thread-modal'));
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
        this.closeModal(document.getElementById('thread-modal'));
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
            if (await this.loadThread(thread.id)) this.showMessageModal();
        } catch (err) {
            console.error('Failed to create thread:', err);
            toast.error(err.message);
        }
    }

    /** Show the root-message composer for an empty conversation. */
    showMessageModal() {
        if (!this.currentThreadId || this.foregroundLoading) {
            toast.info('Select or create a thread first.');
            return;
        }
        if (this.canvas.messages.length) {
            toast.info('Draw from a spiral to write a reply.');
            return;
        }

        this.stopTranslation();
        this.interaction.cancelDrawing();
        this.handleMessageSelect(null);
        this.composerVersion++;
        this.composerThreadId = this.currentThreadId;
        document.getElementById('message-modal-title').textContent = 'Write a message';
        this.openModal(document.getElementById('message-modal'));
        document.getElementById('content-input').value = '';
        document.getElementById('content-input').focus();

        // Clear any drawn params
        this.drawnSpiralParams = null;
    }

    /**
     * Hide message creation modal.
     */
    hideMessageModal() {
        this.composerVersion++;
        this.closeModal(document.getElementById('message-modal'));

        // Clear preview if any
        this.canvas.clearPreviewSpiral();
        this.drawnSpiralParams = null;
        this.lastPreviewTransform = null;
    }

    /**
     * Handle message creation.
     */
    async handleCreateMessage() {
        if (this.submittingMessage) return;
        const threadId = this.composerThreadId;
        const version = this.composerVersion;
        if (!threadId || threadId !== this.currentThreadId || this.foregroundLoading) return;
        const writerName = document.getElementById('current-username').textContent.trim();
        const content = document.getElementById('content-input').value.trim();
        if (!content) { toast.info('Enter a message first.'); return; }
        const parentId = this.selectedMessage ? this.selectedMessage.id : null;
        const spiralPrefs = this.collectSpiralPreferences();
        if (parentId && !spiralPrefs?.userDrawn) {
            toast.info('Draw from a spiral to write a reply.');
            return;
        }
        if (!parentId && this.canvas.messages.length) {
            toast.info('Draw from a spiral to write a reply.');
            return;
        }
        this.submittingMessage = true;
        const button = document.getElementById('add-message-btn');
        button.disabled = true;
        try {
            const newMessage = await api.createMessage(threadId, parentId, writerName, content, spiralPrefs);
            this.saveTranslation(newMessage.id, threadId);
            if (this.currentThreadId === threadId && version === this.composerVersion) {
                this.hideMessageModal();
                this.clearParentSelection();
                this.canvas.markTranslated(newMessage.id);
                await this.loadThread(threadId);
            }
            await this.loadThreads();
        } catch (err) {
            toast.error(err.message);
        } finally {
            this.submittingMessage = false;
            button.disabled = false;
        }
    }

    // =========================================================================
    // Auth Handlers
    // =========================================================================

    async handleLogout() {
        if (this.badgeInterval) clearInterval(this.badgeInterval);
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        await api.logout();
        window.location.href = '/login';
    }

    // =========================================================================
    // Friends Modal
    // =========================================================================

    async showFriendsModal() {
        this.openModal(document.getElementById('friends-modal'));
        this.switchFriendsTab('my-friends');
    }

    hideFriendsModal() {
        this.closeModal(document.getElementById('friends-modal'));
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
            toast.error(err.message);
        }
    }

    async handleAcceptRequest(requestId) {
        try {
            await api.acceptFriendRequest(requestId);
            this.loadFriendRequests();
            this.updateFriendBadge();
        } catch (err) {
            console.error('Failed to accept request:', err);
            toast.error(err.message);
        }
    }

    async handleDeclineRequest(requestId) {
        try {
            await api.declineFriendRequest(requestId);
            this.loadFriendRequests();
            this.updateFriendBadge();
        } catch (err) {
            console.error('Failed to decline request:', err);
            toast.error(err.message);
        }
    }

    async handleRemoveFriend(friendUserId) {
        const ok = await this.confirmDialog(
            'Remove this friend? They will lose access to your shared threads.',
            { title: 'Remove friend', confirmLabel: 'Remove' }
        );
        if (!ok) return;
        try {
            await api.removeFriend(friendUserId);
            this.loadFriendsList();
            // Reload threads in case collaborator access changed
            await this.loadThreads();
        } catch (err) {
            console.error('Failed to remove friend:', err);
            toast.error(err.message);
        }
    }

    async updateFriendBadge() {
        try {
            const data = await api.getPendingRequestCount();
            const badge = document.getElementById('friend-request-badge');
            const tabBadge = document.getElementById('tab-request-badge');
            // Friends now lives inside the overflow menu, so surface pending
            // requests on the menu button itself
            const menuDot = document.getElementById('header-menu-dot');
            if (data.count > 0) {
                badge.textContent = data.count;
                badge.classList.remove('hidden');
                if (tabBadge) {
                    tabBadge.textContent = data.count;
                    tabBadge.classList.remove('hidden');
                }
                if (menuDot) menuDot.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
                if (tabBadge) tabBadge.classList.add('hidden');
                if (menuDot) menuDot.classList.add('hidden');
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
            toast.info('Select a thread first.');
            return;
        }

        this.openModal(document.getElementById('collaborators-modal'));
        await this.loadCollaborators();
    }

    hideCollaboratorsModal() {
        this.closeModal(document.getElementById('collaborators-modal'));
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
            toast.error(err.message);
        }
    }

    async handleRemoveCollaborator(userId) {
        try {
            await api.removeThreadCollaborator(this.currentThreadId, userId);
            await this.loadCollaborators();
        } catch (err) {
            console.error('Failed to remove collaborator:', err);
            toast.error(err.message);
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

    // =========================================================================
    // Translation progress
    //
    // Stored per user in the database rather than localStorage, so reading
    // progress follows the account instead of the browser profile.
    // =========================================================================

    /**
     * Fetch this user's translated message ids for a thread.
     * Never throws: losing progress should degrade to "nothing translated
     * yet", not block the thread from opening.
     * @returns {Promise<{ok: boolean, ids: number[]}>}
     */
    async fetchTranslationProgress(threadId) {
        try {
            return { ok: true, ids: await api.getTranslations(threadId) };
        } catch (err) {
            console.error('Failed to load translation progress:', err);
            return { ok: false, ids: [] };
        }
    }

    /**
     * Record that a message is fully translated by this user.
     *
     * Fire-and-forget: this fires from the reveal animation's completion, and
     * blocking or alerting there would be worse than a lost write. A single
     * retry re-sends the whole known set, so one dropped request on a flaky
     * connection doesn't quietly cost the user their progress.
     */
    saveTranslation(messageId, threadId = this.currentThreadId) {
        if (!threadId || !messageId) return;
        if (!this.pendingTranslations.has(threadId)) this.pendingTranslations.set(threadId, new Set());
        this.pendingTranslations.get(threadId).add(messageId);
        this.flushTranslations(threadId);
        if (threadId === this.currentThreadId) {
            this.updateConversation();
            this.renderThreadOptions();
        }
    }

    async flushTranslations(threadId) {
        if (this.translationSaves.has(threadId)) return this.translationSaves.get(threadId);
        const ids = [...(this.pendingTranslations.get(threadId) || [])];
        if (!ids.length) return;
        const saving = api.saveTranslations(threadId, ids).then(() => {
            const pending = this.pendingTranslations.get(threadId);
            ids.forEach(id => pending?.delete(id));
            if (!pending?.size) this.pendingTranslations.delete(threadId);
        }).catch(err => console.error('Translation save will retry:', err))
            .finally(() => this.translationSaves.delete(threadId));
        this.translationSaves.set(threadId, saving);
        return saving;
    }

    restoreTranslationState(thread, progress, preserveLocal = false) {
        const valid = new Set((thread.messages || []).map(m => m.id));
        const local = preserveLocal ? this.canvas.getTranslatedIds() : [];
        const pending = [...(this.pendingTranslations.get(thread.id) || [])];
        const ids = new Set([...progress.ids, ...local, ...pending].filter(id => valid.has(id)));
        const legacy = this.readLegacyTranslations(thread);
        legacy.ids.filter(id => valid.has(id)).forEach(id => ids.add(id));
        // Keep the original local copy until the server confirms the upload.
        if (progress.ok && legacy.entries.length) {
            const migrated = legacy.ids.filter(id => valid.has(id));
            api.saveTranslations(thread.id, migrated).then(() => {
                for (const [key, value] of legacy.entries) {
                    try {
                        if (localStorage.getItem(key) === value) localStorage.removeItem(key);
                    } catch (err) { /* Storage can be unavailable in private browsing. */ }
                }
            }).catch(err => console.error('Legacy progress retained for retry:', err));
        }
        for (const id of this.canvas.translatedIds) {
            if (!valid.has(id)) this.canvas.translatedIds.delete(id);
        }
        this.canvas.restoreTranslated([...ids]);
    }

    readLegacyTranslations(thread) {
        const keys = [`nomai_translated_${thread.id}_${thread.created_at || ''}`, `nomai_translated_${thread.id}`];
        const ids = [], entries = [];
        for (const key of keys) {
            try {
                const value = localStorage.getItem(key);
                if (!value) continue;
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) {
                    ids.push(...parsed.filter(Number.isInteger));
                    entries.push([key, value]);
                }
            } catch (err) { /* Invalid or inaccessible legacy data must not block reading. */ }
        }
        return { ids, entries };
    }

}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new NomaiApp();
});
