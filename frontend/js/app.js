/**
 * Main application controller.
 */
class NomaiApp {
    constructor() {
        this.canvas = null;
        this.interaction = null;
        this.currentThreadId = null;
        this.selectedMessage = null;

        this.init();
    }

    /**
     * Initialize the application.
     */
    async init() {
        // Initialize canvas
        const canvasEl = document.getElementById('spiral-canvas');
        this.canvas = new NomaiCanvas(canvasEl);

        // Initialize interaction handler
        this.interaction = new InteractionHandler(this.canvas, {
            onSelect: (msg) => this.handleMessageSelect(msg),
            onHover: (msg) => this.handleMessageHover(msg),
            onMouseDown: (msg) => this.handleMouseDown(msg),
            onMouseUp: (msg) => this.handleMouseUp(msg)
        });

        // Bind UI events
        this.bindUIEvents();

        // Load threads
        await this.loadThreads();
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
     * Load a specific thread.
     */
    async loadThread(threadId) {
        try {
            const thread = await api.getThread(threadId);
            this.currentThreadId = threadId;
            this.canvas.clearTranslated(); // Reset translated state for new thread
            this.canvas.setMessages(thread.messages);
            this.clearSelection();
        } catch (err) {
            console.error('Failed to load thread:', err);
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
     * Handle message selection.
     */
    handleMessageSelect(message) {
        this.selectedMessage = message;
        this.updateParentSelection(message);
        // Show current translation state (don't animate - wait for mouse down)
        this.updateTranslationPanel(message);
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

        // Start spiral color transition
        const startProgress = this.canvas.startTransition(message.id);

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
    }

    /**
     * Start text animation from a given progress.
     */
    startTextAnimation(message, startProgress = 0) {
        const writerEl = document.getElementById('writer-name');
        const contentEl = document.getElementById('message-content');

        // Cancel any ongoing animation
        this.pauseTextAnimation();

        // Already fully translated - show immediately
        if (this.canvas.translatedIds.has(message.id)) {
            writerEl.textContent = message.writer_name;
            contentEl.innerHTML = `<p>${this.escapeHtml(message.content)}</p>`;
            return;
        }

        const writerText = message.writer_name;
        const contentText = message.content;
        const totalChars = writerText.length + contentText.length;
        const duration = 800;
        const startTime = performance.now();

        // Store current message for tracking
        this.animatingMessageId = message.id;

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const additionalProgress = elapsed / duration;
            const progress = Math.min(startProgress + additionalProgress, 1);
            const charsToShow = Math.floor(progress * totalChars);

            // Show writer name first, then content
            if (charsToShow <= writerText.length) {
                writerEl.textContent = writerText.slice(0, charsToShow);
                contentEl.innerHTML = '<p></p>';
            } else {
                writerEl.textContent = writerText;
                const contentChars = charsToShow - writerText.length;
                contentEl.innerHTML = `<p>${this.escapeHtml(contentText.slice(0, contentChars))}</p>`;
            }

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
            const progress = this.canvas.getTransitionProgress(message.id);
            const writerText = message.writer_name;
            const contentText = message.content;
            const totalChars = writerText.length + contentText.length;
            const charsToShow = Math.floor(progress * totalChars);

            // Show text up to current progress
            if (charsToShow <= writerText.length) {
                writerEl.textContent = writerText.slice(0, charsToShow);
                contentEl.innerHTML = charsToShow > 0 ? '<p></p>' : '<p class="placeholder">Hold to translate...</p>';
            } else {
                writerEl.textContent = writerText;
                const contentChars = charsToShow - writerText.length;
                contentEl.innerHTML = `<p>${this.escapeHtml(contentText.slice(0, contentChars))}</p>`;
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
     * Show message creation modal.
     */
    showMessageModal() {
        if (!this.currentThreadId) {
            alert('Please select or create a thread first');
            return;
        }

        document.getElementById('message-modal').classList.remove('hidden');
        document.getElementById('writer-input').value = '';
        document.getElementById('content-input').value = '';
        document.getElementById('writer-input').focus();

        // Update parent selection display
        this.updateParentSelection(this.selectedMessage);
    }

    /**
     * Hide message creation modal.
     */
    hideMessageModal() {
        document.getElementById('message-modal').classList.add('hidden');
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

        const parentId = this.selectedMessage ? this.selectedMessage.id : null;

        try {
            await api.createMessage(this.currentThreadId, parentId, writerName, content);
            this.hideMessageModal();
            this.clearParentSelection();
            await this.loadThread(this.currentThreadId);
        } catch (err) {
            console.error('Failed to create message:', err);
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
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new NomaiApp();
});
