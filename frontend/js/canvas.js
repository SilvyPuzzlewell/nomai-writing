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
     */
    setMessages(messages) {
        this.rawMessages = messages;
        this.relayout();
        this.render();
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
     * Render all spirals to canvas.
     */
    render() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);

        if (this.messages.length === 0) {
            this.drawEmptyState();
            return;
        }

        // Draw all spirals (children start at parent endpoints, no connection lines needed)
        this.messages.forEach(msg => {
            if (!msg.spiralData) return;

            const isSelected = msg.id === this.selectedId;
            const isHovered = msg.id === this.hoveredId && !isSelected;
            const isTranslated = this.translatedIds.has(msg.id);
            const progress = this.transitionProgress.get(msg.id) || 0;

            this.drawSpiral(msg, { isSelected, isHovered, isTranslated, transitionProgress: progress });
        });
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
     */
    startTransition(id) {
        // Already fully translated
        if (this.translatedIds.has(id)) {
            return 1;
        }

        // Stop any existing transition
        this.pauseTransition();

        const duration = 5000; // ms
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
