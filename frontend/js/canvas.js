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
        this.revealedIds = new Set(); // Track which messages have been revealed (for progressive reveal)
        this.useProgressiveReveal = false; // Whether to use progressive reveal mode
        this.onMessageRevealed = null; // Callback when a message is fully revealed (translated)
        this.drawProgress = new Map(); // Track draw animation progress for each spiral (id -> 0-1)
        this.drawAnimations = new Map(); // Active draw animations (id -> animationId)

        // Layout cache: ensures spirals never change once computed (survives relayout/reload)
        this.layoutCache = new Map(); // message ID -> layout_data JSON string

        // Preview spiral for drawing mode
        this.previewSpiral = null; // { points, bezierPath }
        this.previewBranchPoint = null; // { x, y } where preview connects to parent
        this.branchPointMarker = null; // { x, y } for branch point selection mode
        this.branchPointLabel = null; // Text to show near marker (e.g., "45%")

        // Camera - render-only view transform (screen = world * scale + offset).
        // World coordinates (layouts, hit data, drawing gestures) never change.
        this.camera = { offsetX: 0, offsetY: 0, scale: 1 };
        this.minScale = 0.2;
        this.maxScale = 4;

        // Static starfield background (offscreen canvas, rebuilt on resize)
        this.starfieldCanvas = null;

        // Colors are read from CSS custom properties so the palette lives in one place
        this.readThemeColors();

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    /**
     * Read the color palette from CSS custom properties.
     * Falls back to hardcoded values if the stylesheet isn't loaded.
     */
    readThemeColors() {
        const css = getComputedStyle(document.documentElement);
        const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;

        const curve = v('--curve-color', '#00d9ff');
        const translated = v('--translated-color', '#8d80b5');
        const accent = v('--accent-color', '#ff9a3c');

        this.colors = {
            curve,
            curveGlow: this.rgba(curve, 0.4),
            translated,
            translatedGlow: this.rgba(translated, 0.5),
            accent,
            scanline: '#dffaff',
            endpoint: curve
        };
    }

    /**
     * Parse a 6-digit hex color into { r, g, b }.
     */
    hexToRgb(hex) {
        const c = parseInt(hex.slice(1), 16);
        return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
    }

    /**
     * Build an rgba() string from a hex color and alpha.
     */
    rgba(hex, alpha) {
        const { r, g, b } = this.hexToRgb(hex);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    /**
     * Interpolate between two hex colors, returning rgba() with the given alpha.
     */
    lerpRgba(hexA, hexB, t, alpha) {
        const a = this.hexToRgb(hexA);
        const b = this.hexToRgb(hexB);
        const r = Math.round(a.r + (b.r - a.r) * t);
        const g = Math.round(a.g + (b.g - a.g) * t);
        const bl = Math.round(a.b + (b.b - a.b) * t);
        return `rgba(${r}, ${g}, ${bl}, ${alpha})`;
    }

    // =========================================================================
    // Camera
    // =========================================================================

    /**
     * Convert screen (canvas CSS pixel) coordinates to world coordinates.
     */
    screenToWorld(x, y) {
        return {
            x: (x - this.camera.offsetX) / this.camera.scale,
            y: (y - this.camera.offsetY) / this.camera.scale
        };
    }

    /**
     * Convert world coordinates to screen coordinates.
     */
    worldToScreen(x, y) {
        return {
            x: x * this.camera.scale + this.camera.offsetX,
            y: y * this.camera.scale + this.camera.offsetY
        };
    }

    /**
     * Pan the camera by a screen-space delta.
     */
    panBy(dx, dy) {
        this.camera.offsetX += dx;
        this.camera.offsetY += dy;
        this.render();
    }

    /**
     * Zoom by a factor, keeping the world point under (screenX, screenY) fixed.
     */
    zoomAt(screenX, screenY, factor) {
        const world = this.screenToWorld(screenX, screenY);
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.camera.scale * factor));
        this.camera.scale = newScale;
        this.camera.offsetX = screenX - world.x * newScale;
        this.camera.offsetY = screenY - world.y * newScale;
        this.render();
    }

    /**
     * Reset the camera to the default view.
     */
    resetView() {
        this.camera = { offsetX: 0, offsetY: 0, scale: 1 };
        this.render();
    }

    /**
     * Fit all spirals (including not-yet-revealed ones, so the view doesn't
     * jump as children appear) into the viewport.
     */
    fitToContent(padding = 70) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        this.messages.forEach(msg => {
            if (!msg.spiralData || !msg.spiralData.points) return;
            msg.spiralData.points.forEach(p => {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            });
        });

        if (minX === Infinity) {
            this.resetView();
            return;
        }

        const bw = Math.max(maxX - minX, 1);
        const bh = Math.max(maxY - minY, 1);
        const fitScale = Math.min((this.width - padding * 2) / bw, (this.height - padding * 2) / bh);
        const scale = Math.max(this.minScale, Math.min(fitScale, 1.25));

        this.camera.scale = scale;
        this.camera.offsetX = this.width / 2 - (minX + bw / 2) * scale;
        this.camera.offsetY = this.height / 2 - (minY + bh / 2) * scale;
        this.render();
    }

    // =========================================================================
    // Starfield background
    // =========================================================================

    /**
     * Build the static starfield on an offscreen canvas (called on resize).
     */
    buildStarfield() {
        const w = this.width, h = this.height;
        if (!w || !h) {
            this.starfieldCanvas = null;
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(w * dpr));
        off.height = Math.max(1, Math.round(h * dpr));
        const octx = off.getContext('2d');
        octx.scale(dpr, dpr);

        const count = Math.round((w * h) / 6000);
        for (let i = 0; i < count; i++) {
            const x = Math.random() * w;
            const y = Math.random() * h;
            const r = 0.4 + Math.random() * 0.9;
            const alpha = 0.15 + Math.random() * 0.55;

            // Mostly white stars, with the occasional cyan or warm one
            const tint = Math.random();
            let color = `rgba(255, 255, 255, ${alpha})`;
            if (tint > 0.93) color = `rgba(160, 235, 255, ${alpha})`;
            else if (tint > 0.87) color = `rgba(255, 205, 160, ${alpha})`;

            octx.beginPath();
            octx.arc(x, y, r, 0, 2 * Math.PI);
            octx.fillStyle = color;
            octx.fill();
        }

        this.starfieldCanvas = off;
    }

    /**
     * Blit the starfield (screen space, fixed - no parallax).
     */
    drawStarfield() {
        if (!this.starfieldCanvas) return;
        this.ctx.drawImage(this.starfieldCanvas, 0, 0, this.width, this.height);
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

        // Rebuild the starfield for the new dimensions
        this.buildStarfield();

        // Re-layout and render if we have messages
        if (this.messages.length > 0) {
            this.relayout();
            // Relayout re-centers content around the new canvas center, so
            // refit the camera to keep everything in view
            this.fitToContent();
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
        // Show all messages immediately (non-progressive mode)
        this.useProgressiveReveal = false;
        this.visibleMessageIds = new Set(this.messages.map(m => m.id));
        this.revealedIds = new Set(this.messages.map(m => m.id));
        this.fitToContent();

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
        this.useProgressiveReveal = false;
        this.fitToContent();

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
     * Set messages with progressive reveal - only show roots initially.
     * Children are revealed when their parent is translated.
     * @param {Array} messages - Messages from API
     * @param {Function} onLayoutsGenerated - Callback with layouts to save
     * @param {Function} onMessageRevealed - Callback when a message finishes translating
     */
    setMessagesProgressiveReveal(messages, onLayoutsGenerated = null, onMessageRevealed = null, preserveCamera = false) {
        this.cancelAnimation();
        this.rawMessages = messages;
        this.relayout();
        this.useProgressiveReveal = true;
        this.onMessageRevealed = onMessageRevealed;

        // Initially reveal only root messages
        this.revealedIds = new Set();
        this.messages.forEach(m => {
            if (m.parent_id === null) {
                this.revealedIds.add(m.id);
            }
        });

        // Also add already-translated messages and their ancestors to revealed set
        this.translatedIds.forEach(id => {
            this.revealedIds.add(id);
            // Reveal children of translated messages
            this.messages.forEach(m => {
                if (m.parent_id === id) {
                    this.revealedIds.add(m.id);
                }
            });
        });

        // Show all revealed messages
        this.visibleMessageIds = new Set(this.revealedIds);
        if (preserveCamera) {
            this.render();
        } else {
            this.fitToContent();
        }

        // Save layouts
        if (onLayoutsGenerated) {
            const layoutsToSave = this.getLayoutsToSave();
            if (Object.keys(layoutsToSave).length > 0) {
                onLayoutsGenerated(layoutsToSave);
            }
        }
    }

    /**
     * Reveal children of a message with gradual draw animation.
     * @param {number} parentId - ID of the parent message whose children should be revealed
     * @param {number} delay - Delay between starting each child's animation in ms
     */
    revealChildren(parentId, delay = 600) {
        // Find direct children of this parent that aren't revealed yet
        const children = this.messages.filter(m =>
            m.parent_id === parentId && !this.revealedIds.has(m.id)
        );

        if (children.length === 0) return;

        const drawDuration = 1500; // Time to draw each spiral in ms

        let index = 0;
        const startNextAnimation = () => {
            if (index < children.length) {
                const child = children[index];
                this.revealedIds.add(child.id);
                this.visibleMessageIds.add(child.id);
                this.startDrawAnimation(child.id, drawDuration);
                index++;
                this.animationTimeout = setTimeout(startNextAnimation, delay);
            } else {
                this.animationTimeout = null;
            }
        };

        startNextAnimation();
    }

    /**
     * Start a gradual draw animation for a spiral.
     * @param {number} id - Message ID
     * @param {number} duration - Animation duration in ms
     */
    startDrawAnimation(id, duration = 1500) {
        // Cancel any existing animation for this id
        if (this.drawAnimations.has(id)) {
            cancelAnimationFrame(this.drawAnimations.get(id));
        }

        this.drawProgress.set(id, 0);
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            this.drawProgress.set(id, progress);
            this.render();

            if (progress < 1) {
                this.drawAnimations.set(id, requestAnimationFrame(animate));
            } else {
                this.drawAnimations.delete(id);
                this.drawProgress.delete(id); // Fully drawn, no longer needed
            }
        };

        this.drawAnimations.set(id, requestAnimationFrame(animate));
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
     * Applies cached layouts to ensure existing spirals never change position.
     */
    relayout() {
        if (!this.layoutEngine) {
            this.layoutEngine = new TreeLayoutEngine(this.width, this.height);
        }

        // Apply cached layouts to rawMessages so existing spirals stay fixed
        if (this.rawMessages && this.layoutCache.size > 0) {
            this.rawMessages.forEach(msg => {
                if (this.layoutCache.has(msg.id)) {
                    msg.layout_data = this.layoutCache.get(msg.id);
                }
            });
        }

        this.messages = this.layoutEngine.layoutTree(this.rawMessages || []);

        // Cache all computed layouts for future relayouts
        this.messages.forEach(msg => {
            if (msg.spiralData && msg.spiralData.layoutParams) {
                this.layoutCache.set(msg.id, JSON.stringify({
                    offsetX: msg.spiralData.layoutParams.offsetX,
                    offsetY: msg.spiralData.layoutParams.offsetY,
                    startAngle: msg.spiralData.layoutParams.startAngle,
                    overrides: msg.spiralData.layoutParams.overrides
                }));
            }
        });
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
     * Draw the branch point marker (accent circle with label).
     */
    drawBranchPointMarker() {
        if (!this.branchPointMarker) return;

        const ctx = this.ctx;
        ctx.save();

        // Draw glow
        ctx.shadowColor = this.rgba(this.colors.accent, 0.8);
        ctx.shadowBlur = 12;

        // Draw marker circle
        ctx.beginPath();
        ctx.arc(this.branchPointMarker.x, this.branchPointMarker.y, 8, 0, 2 * Math.PI);
        ctx.fillStyle = this.rgba(this.colors.accent, 0.6);
        ctx.fill();
        ctx.strokeStyle = this.colors.accent;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw label
        if (this.branchPointLabel) {
            ctx.shadowBlur = 0;
            ctx.font = 'bold 12px "Space Grotesk", "Segoe UI", sans-serif';
            ctx.fillStyle = this.colors.accent;
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
        ctx.shadowColor = this.rgba(this.colors.curve, 0.6);
        ctx.shadowBlur = 15;
        ctx.strokeStyle = this.rgba(this.colors.curve, 0.7);
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
            ctx.fillStyle = this.rgba(this.colors.curve, 0.7);
            ctx.fill();
        }

        // Draw branch point marker
        if (this.previewBranchPoint) {
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(this.previewBranchPoint.x, this.previewBranchPoint.y, 6, 0, 2 * Math.PI);
            ctx.strokeStyle = this.colors.accent;
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

        // Background stars are fixed in screen space (drawn before the camera transform)
        this.drawStarfield();

        if (this.messages.length === 0 && !this.previewSpiral) {
            this.drawEmptyState();
            return;
        }

        // Everything below is drawn in world space through the camera
        ctx.save();
        ctx.translate(this.camera.offsetX, this.camera.offsetY);
        ctx.scale(this.camera.scale, this.camera.scale);

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

        // DEBUG: Draw unexpected coinciding pixels in red (world coords, opt-in via ?debug=1)
        if (window.NOMAI_DEBUG) {
            this.drawDebugPixels();
        }

        ctx.restore();
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
        ctx.textAlign = 'center';
        ctx.fillStyle = this.rgba(this.colors.curve, 0.55);
        ctx.font = '16px "Space Grotesk", "Segoe UI", sans-serif';
        ctx.fillText('Select a thread or create a new one', this.width / 2, this.height / 2);
        ctx.fillStyle = 'rgba(152, 162, 184, 0.6)';
        ctx.font = '13px "Space Grotesk", "Segoe UI", sans-serif';
        ctx.fillText('Glyphs appear here — hold one to translate it', this.width / 2, this.height / 2 + 28);
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

        // Check if this spiral is being animated (gradual draw)
        const drawProgress = this.drawProgress.get(msg.id);
        const isDrawing = drawProgress !== undefined && drawProgress < 1;
        const segmentsToDraw = isDrawing
            ? Math.ceil(drawProgress * bezierPath.length)
            : bezierPath.length;

        if (segmentsToDraw === 0) return;

        // Determine colors - use transition progress for smooth color change
        let strokeColor, glowColor;

        if (isTranslated) {
            // Fully translated - Nomai purple
            strokeColor = this.colors.translated;
            glowColor = this.colors.translatedGlow;
        } else if (transitionProgress > 0) {
            // Transitioning - interpolate from cyan to purple
            strokeColor = this.lerpColor(this.colors.curve, this.colors.translated, transitionProgress);
            glowColor = this.lerpRgba(this.colors.curve, this.colors.translated, transitionProgress, 0.4);
        } else {
            // Not translated - cyan
            strokeColor = this.colors.curve;
            glowColor = this.colors.curveGlow;
        }

        // Get the partial path for drawing animations
        const pathToDraw = bezierPath.slice(0, segmentsToDraw);

        // Faint ambient glow so idle glyphs read as luminous writing
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 8;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        this.drawBezierPath(pathToDraw);
        ctx.restore();

        // Draw stronger glow effect for selected/hovered
        if (isSelected || isHovered) {
            ctx.save();
            ctx.shadowColor = glowColor;
            ctx.shadowBlur = isSelected ? 20 : 12;
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = isSelected ? 4 : 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            this.drawBezierPath(pathToDraw);
            ctx.restore();
        }

        // Draw main curve with variable width
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Translator effect: while transitioning, the glyph is recolored
        // segment-by-segment from base to tip (like the game's translator tool)
        const isTransitioning = !isTranslated && !isDrawing &&
            transitionProgress > 0 && transitionProgress < 1;
        const frontier = isTransitioning ? transitionProgress * bezierPath.length : -1;

        // Draw curve segments with tapering width
        for (let i = 0; i < segmentsToDraw; i++) {
            const seg = bezierPath[i];
            const progress = i / bezierPath.length;
            // Taper from thick to thin
            const lineWidth = (3.5 - progress * 1.5) * scale;

            ctx.strokeStyle = frontier >= 0
                ? (i < frontier ? this.colors.translated : this.colors.curve)
                : strokeColor;

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

        // Bright scanline dot at the translation frontier
        if (isTransitioning && points.length > 0) {
            const idx = Math.min(
                Math.floor(transitionProgress * (points.length - 1)),
                points.length - 1
            );
            const p = points[idx];
            ctx.save();
            ctx.shadowColor = this.colors.curveGlow;
            ctx.shadowBlur = 16;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(3, 5 * scale), 0, 2 * Math.PI);
            ctx.fillStyle = this.colors.scanline;
            ctx.fill();
            ctx.restore();
        }

        // Draw endpoint marker at the current drawing position
        const endpointIndex = isDrawing
            ? Math.min(Math.floor(drawProgress * (points.length - 1)), points.length - 1)
            : points.length - 1;
        const endPoint = points[endpointIndex];
        ctx.beginPath();
        ctx.arc(endPoint.x, endPoint.y, 4 * scale, 0, 2 * Math.PI);
        ctx.fillStyle = strokeColor; // Use same color as the spiral
        ctx.fill();

        // Add small glow to endpoint if selected or transitioning
        if (isSelected || transitionProgress > 0) {
            ctx.beginPath();
            ctx.arc(endPoint.x, endPoint.y, 6 * scale, 0, 2 * Math.PI);
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

                // In progressive reveal mode, reveal children with animation
                if (this.useProgressiveReveal) {
                    this.revealChildren(id, 600);
                }

                // Notify callback
                if (this.onMessageRevealed) {
                    this.onMessageRevealed(id);
                }
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
        this.useProgressiveReveal = false;
        this.revealedIds.clear();
        this.onMessageRevealed = null;
        // Clear any active draw animations
        this.drawAnimations.forEach(animId => cancelAnimationFrame(animId));
        this.drawAnimations.clear();
        this.drawProgress.clear();
        // Clear layout cache when switching threads
        this.layoutCache.clear();
    }

    /**
     * Clear the layout cache (e.g., when regenerating layouts).
     */
    clearLayoutCache() {
        this.layoutCache.clear();
    }

    /**
     * Mark a message as translated (without animation).
     * @param {number} id - Message ID to mark as translated
     */
    markTranslated(id) {
        this.translatedIds.add(id);
        this.transitionProgress.set(id, 1);
    }

    /**
     * Get all translated message IDs.
     * @returns {Array} Array of translated message IDs
     */
    getTranslatedIds() {
        return Array.from(this.translatedIds);
    }

    /**
     * Restore translated state from saved data.
     * @param {Array} ids - Array of message IDs to mark as translated
     */
    restoreTranslated(ids) {
        ids.forEach(id => {
            this.translatedIds.add(id);
            this.transitionProgress.set(id, 1);
        });
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
