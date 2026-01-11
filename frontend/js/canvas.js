/**
 * Canvas rendering engine for Nomai-style spirals.
 */
class NomaiCanvas {
    constructor(canvasElement) {
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.messages = [];
        this.selectedId = null;
        this.hoveredId = null;
        this.translatedIds = new Set(); // Track which messages have been translated
        this.transitionProgress = new Map(); // Track color transition progress (id -> progress 0-1)
        this.activeTransition = null; // Currently animating transition { id, animationId }
        this.layoutEngine = null;
        this.visibleMessageIds = new Set(); // For animated loading
        this.animationTimeout = null; // For cancelling animation

        // Preview spiral for drawing mode
        this.previewSpiral = null; // { points, bezierPath }
        this.previewBranchPoint = null; // { x, y } where preview connects to parent
        this.branchPointMarker = null; // { x, y } for branch point selection mode
        this.branchPointLabel = null; // Text to show near marker (e.g., "45%")

        // Colors
        this.colors = {
            curve: '#00d9ff',
            curveGlow: 'rgba(0, 217, 255, 0.4)',
            selected: '#888888',
            selectedGlow: 'rgba(136, 136, 136, 0.5)',
            endpoint: '#00d9ff'
        };

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    /**
     * Handle canvas resize.
     */
    resize() {
        const container = this.canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;

        // Set display size
        this.canvas.style.width = container.clientWidth + 'px';
        this.canvas.style.height = container.clientHeight + 'px';

        // Set actual size in memory (scaled for HiDPI)
        this.canvas.width = container.clientWidth * dpr;
        this.canvas.height = container.clientHeight * dpr;

        // Reset transform and scale context for HiDPI
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Store logical dimensions
        this.width = container.clientWidth;
        this.height = container.clientHeight;

        // Update layout engine
        if (this.layoutEngine) {
            this.layoutEngine.updateDimensions(this.width, this.height);
        } else {
            this.layoutEngine = new TreeLayoutEngine(this.width, this.height);
        }

        // Re-layout and render if we have messages
        if (this.messages.length > 0) {
            this.relayout();
        }
        this.render();
    }

    /**
     * Set messages and compute layout.
     * @param {Array} messages - Messages from API (may include layout_data)
     * @param {Function} onLayoutsGenerated - Callback with layouts to save
     */
    setMessages(messages, onLayoutsGenerated = null) {
        this.cancelAnimation();
        this.rawMessages = messages;
        this.relayout();
        // Show all messages immediately
        this.visibleMessageIds = new Set(this.messages.map(m => m.id));
        this.render();

        // Check if any messages need their layouts saved
        if (onLayoutsGenerated) {
            const layoutsToSave = this.getLayoutsToSave();
            if (Object.keys(layoutsToSave).length > 0) {
                onLayoutsGenerated(layoutsToSave);
            }
        }
    }

    /**
     * Set messages with animated reveal (one by one).
     * @param {Array} messages - Messages from API
     * @param {number} delay - Delay between each message in ms
     * @param {Function} onLayoutsGenerated - Callback with layouts to save
     * @param {Function} onComplete - Callback when animation completes
     */
    setMessagesAnimated(messages, delay = 300, onLayoutsGenerated = null, onComplete = null) {
        this.cancelAnimation();
        this.rawMessages = messages;
        this.relayout();
        this.visibleMessageIds = new Set();
        this.render();

        // Get messages in tree order (parents before children)
        const orderedMessages = this.getMessagesInTreeOrder();

        let index = 0;
        const revealNext = () => {
            if (index < orderedMessages.length) {
                this.visibleMessageIds.add(orderedMessages[index].id);
                this.render();
                index++;
                this.animationTimeout = setTimeout(revealNext, delay);
            } else {
                // Animation complete
                this.animationTimeout = null;
                if (onLayoutsGenerated) {
                    const layoutsToSave = this.getLayoutsToSave();
                    if (Object.keys(layoutsToSave).length > 0) {
                        onLayoutsGenerated(layoutsToSave);
                    }
                }
                if (onComplete) onComplete();
            }
        };

        revealNext();
    }

    /**
     * Get messages ordered by tree traversal (parents before children).
     */
    getMessagesInTreeOrder() {
        const ordered = [];
        const visited = new Set();

        // Build parent map
        const childrenMap = new Map();
        const roots = [];
        this.messages.forEach(m => {
            if (m.parent_id === null) {
                roots.push(m);
            } else {
                if (!childrenMap.has(m.parent_id)) {
                    childrenMap.set(m.parent_id, []);
                }
                childrenMap.get(m.parent_id).push(m);
            }
        });

        // DFS traversal
        const traverse = (node) => {
            if (visited.has(node.id)) return;
            visited.add(node.id);
            ordered.push(node);
            const children = childrenMap.get(node.id) || [];
            children.forEach(traverse);
        };

        roots.forEach(traverse);
        return ordered;
    }

    /**
     * Cancel any ongoing animation.
     */
    cancelAnimation() {
        if (this.animationTimeout) {
            clearTimeout(this.animationTimeout);
            this.animationTimeout = null;
        }
    }

    /**
     * Check if animation is in progress.
     */
    isAnimating() {
        return this.animationTimeout !== null;
    }

    /**
     * Recompute layout for current messages.
     */
    relayout() {
        if (!this.layoutEngine) {
            this.layoutEngine = new TreeLayoutEngine(this.width, this.height);
        }
        this.messages = this.layoutEngine.layoutTree(this.rawMessages || []);
    }

    /**
     * Get layout data for messages that need saving.
     * @returns {Object} Map of message ID to layout JSON string
     */
    getLayoutsToSave() {
        const layouts = {};
        this.messages.forEach(msg => {
            if (msg.needsLayoutSave && msg.spiralData && msg.spiralData.layoutParams) {
                layouts[msg.id] = JSON.stringify({
                    offsetX: msg.spiralData.layoutParams.offsetX,
                    offsetY: msg.spiralData.layoutParams.offsetY,
                    startAngle: msg.spiralData.layoutParams.startAngle,
                    overrides: msg.spiralData.layoutParams.overrides
                });
            }
        });
        return layouts;
    }

    /**
     * Get collision conflicts detected during layout.
     * @returns {Array} Array of conflict info objects
     */
    getCollisionConflicts() {
        return this.layoutEngine ? this.layoutEngine.collisionConflicts : [];
    }

    /**
     * Set preview spiral for drawing mode.
     * @param {Object} spiralData - { points, bezierPath } or null to clear
     * @param {Object} branchPoint - { x, y } where preview connects to parent
     */
    setPreviewSpiral(spiralData, branchPoint = null) {
        this.previewSpiral = spiralData;
        this.previewBranchPoint = branchPoint;
        this.render();
    }

    /**
     * Clear preview spiral.
     */
    clearPreviewSpiral() {
        this.previewSpiral = null;
        this.previewBranchPoint = null;
        this.render();
    }

    /**
     * Set branch point marker for selection mode.
     * @param {Object} point - { x, y } position
     * @param {number} branchT - 0-1 value for label
     */
    setBranchPointMarker(point, branchT) {
        this.branchPointMarker = point;
        this.branchPointLabel = `${Math.round(branchT * 100)}%`;
        this.render();
    }

    /**
     * Clear branch point marker.
     */
    clearBranchPointMarker() {
        this.branchPointMarker = null;
        this.branchPointLabel = null;
        this.render();
    }

    /**
     * Draw the branch point marker (green circle with label).
     */
    drawBranchPointMarker() {
        if (!this.branchPointMarker) return;

        const ctx = this.ctx;
        ctx.save();

        // Draw glow
        ctx.shadowColor = 'rgba(0, 255, 100, 0.8)';
        ctx.shadowBlur = 12;

        // Draw marker circle
        ctx.beginPath();
        ctx.arc(this.branchPointMarker.x, this.branchPointMarker.y, 8, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(0, 255, 100, 0.6)';
        ctx.fill();
        ctx.strokeStyle = '#00ff64';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw label
        if (this.branchPointLabel) {
            ctx.shadowBlur = 0;
            ctx.font = 'bold 12px "Segoe UI", sans-serif';
            ctx.fillStyle = '#00ff64';
            ctx.textAlign = 'left';
            ctx.fillText(this.branchPointLabel, this.branchPointMarker.x + 14, this.branchPointMarker.y + 4);
        }

        ctx.restore();
    }

    /**
     * Draw the preview spiral (semi-transparent, dashed).
     */
    drawPreviewSpiral() {
        if (!this.previewSpiral || !this.previewSpiral.bezierPath) return;

        const ctx = this.ctx;
        const bezierPath = this.previewSpiral.bezierPath;

        ctx.save();

        // Draw glow
        ctx.shadowColor = 'rgba(0, 217, 255, 0.6)';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = 'rgba(0, 217, 255, 0.7)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([8, 6]); // Dashed line

        ctx.beginPath();
        if (bezierPath.length > 0) {
            ctx.moveTo(bezierPath[0].start.x, bezierPath[0].start.y);
            bezierPath.forEach(seg => {
                ctx.bezierCurveTo(
                    seg.cp1.x, seg.cp1.y,
                    seg.cp2.x, seg.cp2.y,
                    seg.end.x, seg.end.y
                );
            });
        }
        ctx.stroke();

        // Draw endpoint marker
        if (this.previewSpiral.points && this.previewSpiral.points.length > 0) {
            const lastPoint = this.previewSpiral.points[this.previewSpiral.points.length - 1];
            ctx.setLineDash([]); // Solid for endpoint
            ctx.beginPath();
            ctx.arc(lastPoint.x, lastPoint.y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(0, 217, 255, 0.7)';
            ctx.fill();
        }

        // Draw branch point marker
        if (this.previewBranchPoint) {
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(this.previewBranchPoint.x, this.previewBranchPoint.y, 6, 0, 2 * Math.PI);
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.restore();
    }

    /**
     * Render all spirals to canvas.
     */
    render() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);

        if (this.messages.length === 0 && !this.previewSpiral) {
            this.drawEmptyState();
            return;
        }

        // Draw all spirals (children start at parent endpoints, no connection lines needed)
        this.messages.forEach(msg => {
            if (!msg.spiralData) return;
            // Skip if not visible (during animated loading)
            if (this.visibleMessageIds.size > 0 && !this.visibleMessageIds.has(msg.id)) return;

            const isSelected = msg.id === this.selectedId;
            const isHovered = msg.id === this.hoveredId && !isSelected;
            const isTranslated = this.translatedIds.has(msg.id);
            const progress = this.transitionProgress.get(msg.id) || 0;

            this.drawSpiral(msg, { isSelected, isHovered, isTranslated, transitionProgress: progress });
        });

        // Draw branch point marker
        this.drawBranchPointMarker();

        // Draw preview spiral on top
        this.drawPreviewSpiral();

        // DEBUG: Draw unexpected coinciding pixels in red
        this.drawDebugPixels();
    }

    /**
     * Draw debug markers for unexpected pixel coincidences.
     */
    drawDebugPixels() {
        if (!window.debugUnexpectedPixels || window.debugUnexpectedPixels.length === 0) return;

        const ctx = this.ctx;
        ctx.save();

        window.debugUnexpectedPixels.forEach(pixel => {
            // Draw a bright red circle at each unexpected coincidence
            ctx.beginPath();
            ctx.arc(pixel.x, pixel.y, 6, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
            ctx.fill();

            // Add a yellow outline for visibility
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 2;
            ctx.stroke();
        });

        ctx.restore();
    }

    /**
     * Draw empty state message.
     */
    drawEmptyState() {
        const ctx = this.ctx;
        ctx.fillStyle = 'rgba(136, 136, 136, 0.5)';
        ctx.font = '16px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Select a thread or create a new one', this.width / 2, this.height / 2);
        ctx.fillText('Click + to add messages', this.width / 2, this.height / 2 + 30);
    }

    /**
     * Interpolate between two hex colors.
     */
    lerpColor(color1, color2, t) {
        const c1 = parseInt(color1.slice(1), 16);
        const c2 = parseInt(color2.slice(1), 16);

        const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
        const r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;

        const r = Math.round(r1 + (r2 - r1) * t);
        const g = Math.round(g1 + (g2 - g1) * t);
        const b = Math.round(b1 + (b2 - b1) * t);

        return `rgb(${r}, ${g}, ${b})`;
    }

    /**
     * Draw a single spiral with effects.
     */
    drawSpiral(msg, { isSelected, isHovered, isTranslated, transitionProgress }) {
        const ctx = this.ctx;
        const { bezierPath, points, scale } = msg.spiralData;

        if (bezierPath.length === 0) return;

        // Determine colors - use transition progress for smooth color change
        let strokeColor, glowColor;

        if (isTranslated) {
            // Fully translated - grey
            strokeColor = this.colors.selected;
            glowColor = this.colors.selectedGlow;
        } else if (transitionProgress > 0) {
            // Transitioning - interpolate from blue to grey
            strokeColor = this.lerpColor(this.colors.curve, this.colors.selected, transitionProgress);
            const alpha = 0.4;
            const grey = Math.round(136 * transitionProgress + 0 * (1 - transitionProgress));
            const cyan = Math.round(217 * (1 - transitionProgress));
            glowColor = `rgba(${grey}, ${grey + cyan}, ${255 - (255-136)*transitionProgress}, ${alpha})`;
        } else {
            // Not translated - blue
            strokeColor = this.colors.curve;
            glowColor = this.colors.curveGlow;
        }

        // Draw glow effect for selected/hovered
        if (isSelected || isHovered) {
            ctx.save();
            ctx.shadowColor = glowColor;
            ctx.shadowBlur = isSelected ? 20 : 12;
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = isSelected ? 4 : 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            this.drawBezierPath(bezierPath);
            ctx.restore();
        }

        // Draw main curve with variable width
        ctx.strokeStyle = strokeColor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Draw curve segments with tapering width
        for (let i = 0; i < bezierPath.length; i++) {
            const seg = bezierPath[i];
            const progress = i / bezierPath.length;
            // Taper from thick to thin
            const lineWidth = (3.5 - progress * 1.5) * scale;

            ctx.beginPath();
            ctx.lineWidth = Math.max(1, lineWidth);
            ctx.moveTo(seg.start.x, seg.start.y);
            ctx.bezierCurveTo(
                seg.cp1.x, seg.cp1.y,
                seg.cp2.x, seg.cp2.y,
                seg.end.x, seg.end.y
            );
            ctx.stroke();
        }

        // Draw endpoint marker
        const lastPoint = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(lastPoint.x, lastPoint.y, 4 * scale, 0, 2 * Math.PI);
        ctx.fillStyle = strokeColor; // Use same color as the spiral
        ctx.fill();

        // Add small glow to endpoint if selected or transitioning
        if (isSelected || transitionProgress > 0) {
            ctx.beginPath();
            ctx.arc(lastPoint.x, lastPoint.y, 6 * scale, 0, 2 * Math.PI);
            ctx.fillStyle = glowColor;
            ctx.fill();
        }
    }

    /**
     * Draw a complete bezier path.
     */
    drawBezierPath(bezierPath) {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(bezierPath[0].start.x, bezierPath[0].start.y);

        bezierPath.forEach(seg => {
            ctx.bezierCurveTo(
                seg.cp1.x, seg.cp1.y,
                seg.cp2.x, seg.cp2.y,
                seg.end.x, seg.end.y
            );
        });

        ctx.stroke();
    }

    /**
     * Set selected message ID (does not start transition - use startTransition).
     */
    setSelected(id) {
        this.selectedId = id;
        this.render();
    }

    /**
     * Start or resume color transition for a message.
     * @param {number} id - Message ID
     * @param {number} duration - Animation duration in ms (default 5000)
     */
    startTransition(id, duration = 5000) {
        // Already fully translated
        if (this.translatedIds.has(id)) {
            return 1;
        }

        // Stop any existing transition
        this.pauseTransition();
        const startProgress = this.transitionProgress.get(id) || 0;
        const remainingDuration = duration * (1 - startProgress);
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const additionalProgress = elapsed / duration;
            const progress = Math.min(startProgress + additionalProgress, 1);

            this.transitionProgress.set(id, progress);
            this.render();

            if (progress < 1) {
                this.activeTransition = {
                    id: id,
                    animationId: requestAnimationFrame(animate)
                };
            } else {
                // Transition complete
                this.translatedIds.add(id);
                this.activeTransition = null;
                this.render();
            }
        };

        this.activeTransition = {
            id: id,
            animationId: requestAnimationFrame(animate)
        };

        return startProgress;
    }

    /**
     * Pause the current transition.
     */
    pauseTransition() {
        if (this.activeTransition) {
            cancelAnimationFrame(this.activeTransition.animationId);
            this.activeTransition = null;
        }
    }

    /**
     * Get current transition progress for a message.
     */
    getTransitionProgress(id) {
        if (this.translatedIds.has(id)) return 1;
        return this.transitionProgress.get(id) || 0;
    }

    /**
     * Clear all translated messages (when switching threads).
     */
    clearTranslated() {
        this.translatedIds.clear();
        this.transitionProgress.clear();
        this.pauseTransition();
    }

    /**
     * Set hovered message ID.
     */
    setHovered(id) {
        if (this.hoveredId !== id) {
            this.hoveredId = id;
            this.render();
        }
    }

    /**
     * Get message by ID.
     */
    getMessage(id) {
        return this.messages.find(m => m.id === id);
    }
}

// Export
window.NomaiCanvas = NomaiCanvas;
