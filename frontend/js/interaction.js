/**
 * Interaction handler for canvas - click, hover, and spiral drawing.
 *
 * Drawing flow:
 * 1. Double-click on spiral → enter branch point selection
 * 2. Move mouse → branch point follows along spiral
 * 3. Click → confirm branch point, enter spiral drawing
 * 4. Move mouse → preview spiral follows
 * 5. Click → confirm spiral, trigger callback to open modal
 */
class InteractionHandler {
    // Drawing states
    static STATE_IDLE = 'idle';
    static STATE_SELECTING_BRANCH = 'selectingBranch';
    static STATE_DRAWING_SPIRAL = 'drawingSpiral';

    constructor(nomaiCanvas, callbacks = {}) {
        this.canvas = nomaiCanvas;
        this.onSelect = callbacks.onSelect || (() => {});
        this.onHover = callbacks.onHover || (() => {});
        this.onMouseDown = callbacks.onMouseDown || (() => {});
        this.onMouseUp = callbacks.onMouseUp || (() => {});

        // Drawing mode callbacks
        this.onBranchPointMove = callbacks.onBranchPointMove || (() => {});
        this.onBranchPointConfirm = callbacks.onBranchPointConfirm || (() => {});
        this.onSpiralPreview = callbacks.onSpiralPreview || (() => {});
        this.onSpiralConfirm = callbacks.onSpiralConfirm || (() => {});
        this.onDrawingCancel = callbacks.onDrawingCancel || (() => {});

        this.hitThreshold = 12; // pixels
        this.isMouseDown = false;
        this.activeMessage = null;

        // Drawing state machine
        this.drawingState = InteractionHandler.STATE_IDLE;
        this.parentMessage = null;
        this.branchPoint = null;
        this.branchT = 0;
        this.gesturePath = [];

        // Real-time preview state
        this.previewCurvature = 0.043; // Default ~100°, range: 0 = ~72°, 1.0 = 720°
        this.previewCurvatureDir = 1; // 1 = CW, -1 = CCW

        // Double-click detection
        this.lastClickTime = 0;
        this.lastClickPos = null;
        this.doubleClickThreshold = 300; // ms
        this.doubleClickDistance = 10; // pixels

        this.bindEvents();
    }

    /**
     * Bind mouse/touch events.
     */
    bindEvents() {
        const canvasEl = this.canvas.canvas;

        canvasEl.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        canvasEl.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        canvasEl.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        canvasEl.addEventListener('mouseleave', () => this.handleMouseLeave());

        // Escape key to cancel drawing
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.drawingState !== InteractionHandler.STATE_IDLE) {
                this.cancelDrawing();
            }
        });

        // Touch support
        canvasEl.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            this.handleMouseDown(touch);
        });
        canvasEl.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.handleMouseUp();
        });
        canvasEl.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            this.handleMouseMove(touch);
        });

        // Mouse wheel for curvature control during spiral drawing
        canvasEl.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
    }

    /**
     * Get canvas coordinates from event.
     */
    getCanvasCoords(event) {
        const rect = this.canvas.canvas.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };
    }

    /**
     * Find which message spiral is at a given point.
     */
    findMessageAtPoint(x, y) {
        for (const msg of this.canvas.messages) {
            if (!msg.spiralData) continue;

            for (const point of msg.spiralData.points) {
                const dist = Math.hypot(x - point.x, y - point.y);
                if (dist <= this.hitThreshold) {
                    return msg;
                }
            }

            // Also check endpoint
            const endDist = Math.hypot(x - msg.spiralData.endX, y - msg.spiralData.endY);
            if (endDist <= this.hitThreshold + 4) {
                return msg;
            }
        }
        return null;
    }

    /**
     * Find the closest point on a specific spiral to the given coordinates.
     */
    findClosestPointOnSpiral(x, y, message) {
        if (!message || !message.spiralData) return null;

        let closestPoint = null;
        let closestDist = Infinity;
        let closestT = 0;

        for (const point of message.spiralData.points) {
            const dist = Math.hypot(x - point.x, y - point.y);
            if (dist < closestDist) {
                closestDist = dist;
                closestPoint = { x: point.x, y: point.y };
                closestT = point.progress;
            }
        }

        return {
            point: closestPoint,
            branchT: closestT,
            distance: closestDist
        };
    }

    /**
     * Find the exact point on any spiral closest to coordinates.
     */
    findPointOnSpiral(x, y) {
        let bestResult = null;
        let bestDist = Infinity;

        for (const msg of this.canvas.messages) {
            if (!msg.spiralData) continue;

            for (const point of msg.spiralData.points) {
                const dist = Math.hypot(x - point.x, y - point.y);
                if (dist <= this.hitThreshold && dist < bestDist) {
                    bestDist = dist;
                    bestResult = {
                        message: msg,
                        point: { x: point.x, y: point.y },
                        branchT: point.progress
                    };
                }
            }
        }

        return bestResult;
    }

    /**
     * Check if this is a double-click.
     */
    isDoubleClick(coords) {
        const now = Date.now();
        const timeDiff = now - this.lastClickTime;

        if (this.lastClickPos && timeDiff < this.doubleClickThreshold) {
            const dist = Math.hypot(
                coords.x - this.lastClickPos.x,
                coords.y - this.lastClickPos.y
            );
            if (dist < this.doubleClickDistance) {
                this.lastClickTime = 0;
                this.lastClickPos = null;
                return true;
            }
        }

        this.lastClickTime = now;
        this.lastClickPos = coords;
        return false;
    }

    /**
     * Cancel current drawing operation.
     */
    cancelDrawing() {
        this.drawingState = InteractionHandler.STATE_IDLE;
        this.parentMessage = null;
        this.branchPoint = null;
        this.branchT = 0;
        this.gesturePath = [];
        this.onDrawingCancel();
        this.canvas.canvas.style.cursor = 'default';
    }

    /**
     * Handle mouse down.
     */
    handleMouseDown(event) {
        this.isMouseDown = true;
        const coords = this.getCanvasCoords(event);

        // State machine handling
        switch (this.drawingState) {
            case InteractionHandler.STATE_IDLE:
                this.handleIdleClick(coords);
                break;

            case InteractionHandler.STATE_SELECTING_BRANCH:
                // Click confirms branch point
                this.confirmBranchPoint(coords);
                break;

            case InteractionHandler.STATE_DRAWING_SPIRAL:
                // Click confirms spiral
                this.confirmSpiral(coords);
                break;
        }
    }

    /**
     * Handle click in idle state.
     */
    handleIdleClick(coords) {
        const isDouble = this.isDoubleClick(coords);
        const message = this.findMessageAtPoint(coords.x, coords.y);

        if (isDouble && message) {
            // Double-click on spiral → enter branch selection mode
            this.parentMessage = message;
            this.drawingState = InteractionHandler.STATE_SELECTING_BRANCH;

            // Find initial branch point
            const pointInfo = this.findClosestPointOnSpiral(coords.x, coords.y, message);
            this.branchPoint = pointInfo.point;
            this.branchT = pointInfo.branchT;

            this.canvas.setSelected(message.id);
            this.onBranchPointMove(message, this.branchPoint, this.branchT);
            this.canvas.canvas.style.cursor = 'crosshair';
        } else if (message) {
            // Single click → normal selection/translation
            this.activeMessage = message;
            this.canvas.setSelected(message.id);
            this.onSelect(message);
            this.onMouseDown(message);
        } else {
            this.canvas.setSelected(null);
            this.onSelect(null);
        }
    }

    /**
     * Confirm branch point and enter spiral drawing mode.
     */
    confirmBranchPoint(coords) {
        this.drawingState = InteractionHandler.STATE_DRAWING_SPIRAL;
        this.gesturePath = [coords];
        // Reset preview params to defaults (~100°)
        this.previewCurvature = 0.043;
        this.previewCurvatureDir = 1;
        this.onBranchPointConfirm(this.parentMessage, this.branchPoint, this.branchT);
    }

    /**
     * Confirm spiral and trigger modal open.
     */
    confirmSpiral(coords) {
        this.gesturePath.push(coords);

        this.onSpiralConfirm({
            parentMessage: this.parentMessage,
            branchPoint: this.branchPoint,
            branchT: this.branchT,
            gesturePath: this.gesturePath,
            endPoint: coords,
            previewParams: {
                curvature: this.previewCurvature,
                curvatureDir: this.previewCurvatureDir
            }
        });

        // Reset to idle
        this.drawingState = InteractionHandler.STATE_IDLE;
        this.canvas.canvas.style.cursor = 'default';
    }

    /**
     * Handle mouse up.
     */
    handleMouseUp(event) {
        if (this.isMouseDown && this.activeMessage &&
            this.drawingState === InteractionHandler.STATE_IDLE) {
            this.onMouseUp(this.activeMessage);
        }
        this.isMouseDown = false;
    }

    /**
     * Handle mouse move.
     */
    handleMouseMove(event) {
        const coords = this.getCanvasCoords(event);

        switch (this.drawingState) {
            case InteractionHandler.STATE_SELECTING_BRANCH:
                this.handleBranchPointMove(coords);
                break;

            case InteractionHandler.STATE_DRAWING_SPIRAL:
                this.handleSpiralMove(coords);
                break;

            default:
                this.handleIdleMove(coords);
                break;
        }
    }

    /**
     * Handle mouse move while selecting branch point.
     */
    handleBranchPointMove(coords) {
        // Find closest point on parent spiral
        const pointInfo = this.findClosestPointOnSpiral(
            coords.x, coords.y, this.parentMessage
        );

        if (pointInfo && pointInfo.distance < 100) {
            this.branchPoint = pointInfo.point;
            this.branchT = pointInfo.branchT;
            this.onBranchPointMove(this.parentMessage, this.branchPoint, this.branchT);
        }

        this.canvas.canvas.style.cursor = 'crosshair';
    }

    /**
     * Handle mouse move while drawing spiral.
     */
    handleSpiralMove(coords) {
        this.gesturePath.push(coords);

        // Determine curvature direction from gesture path (cross product)
        if (this.gesturePath.length > 3 && this.branchPoint) {
            const start = this.branchPoint;
            const end = coords;
            const midIndex = Math.floor(this.gesturePath.length / 2);
            const mid = this.gesturePath[midIndex];

            const dragVec = { x: end.x - start.x, y: end.y - start.y };
            const cross = dragVec.x * (mid.y - start.y) - dragVec.y * (mid.x - start.x);
            this.previewCurvatureDir = cross > 0 ? -1 : 1;
        }

        this.onSpiralPreview(this.branchPoint, coords, this.gesturePath, {
            curvature: this.previewCurvature,
            curvatureDir: this.previewCurvatureDir
        });
        this.canvas.canvas.style.cursor = 'crosshair';
    }

    /**
     * Handle mouse move in idle state.
     */
    handleIdleMove(coords) {
        const message = this.findMessageAtPoint(coords.x, coords.y);
        const newHoveredId = message ? message.id : null;

        this.canvas.setHovered(newHoveredId);
        this.onHover(message);

        this.canvas.canvas.style.cursor = message ? 'pointer' : 'default';
    }

    /**
     * Handle mouse leave.
     */
    handleMouseLeave() {
        if (this.drawingState === InteractionHandler.STATE_IDLE) {
            this.canvas.setHovered(null);
            this.onHover(null);
        }
    }

    /**
     * Handle mouse wheel - adjust curvature during spiral drawing.
     */
    handleWheel(event) {
        if (this.drawingState !== InteractionHandler.STATE_DRAWING_SPIRAL) {
            return; // Only handle wheel during spiral drawing
        }

        event.preventDefault();

        // Adjust curvature based on wheel delta
        const delta = event.deltaY > 0 ? -0.05 : 0.05;
        this.previewCurvature = Math.max(0.1, Math.min(1.0, this.previewCurvature + delta));

        // Get current mouse position and update preview
        const coords = this.getCanvasCoords(event);
        this.onSpiralPreview(this.branchPoint, coords, this.gesturePath, {
            curvature: this.previewCurvature,
            curvatureDir: this.previewCurvatureDir
        });
    }

    /**
     * Get current drawing state.
     */
    getDrawingState() {
        return this.drawingState;
    }

    /**
     * Check if currently in any drawing mode.
     */
    isDrawing() {
        return this.drawingState !== InteractionHandler.STATE_IDLE;
    }
}

// Export
window.InteractionHandler = InteractionHandler;
