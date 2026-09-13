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

        // Pointer-class tuning. A fingertip contact patch is ~40px across and
        // drifts several px over a multi-second hold, so mouse-grade
        // thresholds make both of the app's primary gestures fail on a phone.
        const coarse = typeof window.matchMedia === 'function' &&
            window.matchMedia('(pointer: coarse)').matches;
        this.coarsePointer = coarse;

        this.hitThreshold = coarse ? 22 : 12; // screen pixels (divided by camera scale for world-space tests)
        this.panMoveThreshold = coarse ? 10 : 4; // screen px before a press counts as a pan
        this.isMouseDown = false;
        this.activeMessage = null;

        // Pan/zoom gesture state (screen coordinates)
        this.panSession = null; // { startX, startY, lastX, lastY, moved }
        this.holdStartScreen = null; // where a translate-hold began
        this.holdCancelDistance = coarse ? 18 : 8; // screen px of drag that cancels a hold
        this.pinchDist = null; // last two-finger distance for pinch zoom
        this.pinchMid = null; // last two-finger midpoint, for pinch-panning

        // Touch produces no hover, so the drawing flow switches from
        // move-then-click to press-drag-release.
        this.pressDrag = coarse;
        this.lastCoords = null; // most recent world coords, for release-confirm

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
        this.doubleClickThreshold = coarse ? 400 : 300; // ms
        this.doubleClickDistance = coarse ? 28 : 10; // pixels

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

        // A translate hold lasts seconds - long enough for the OS to claim the
        // gesture as a long-press. touch-action and preventDefault cover most
        // of it; this closes the desktop right-click and Android menu cases.
        canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());

        // Touch support (single finger maps to mouse; two fingers pinch/pan)
        canvasEl.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (e.touches.length >= 2) {
                // Entering a two-finger gesture: release any hold/pan first
                if (this.activeMessage && this.isMouseDown) {
                    this.onMouseUp(this.activeMessage);
                }
                this.activeMessage = null;
                this.holdStartScreen = null;
                this.panSession = null;
                this.isMouseDown = false;
                this.pinchDist = this.touchDistance(e.touches);
                this.pinchMid = this.touchMidpoint(e.touches);
                return;
            }
            this.handleMouseDown(e.touches[0]);
        });
        canvasEl.addEventListener('touchend', (e) => {
            e.preventDefault();
            if (e.touches.length >= 2) {
                // Still pinching with the remaining fingers - re-seed so the
                // scale doesn't jump
                this.pinchDist = this.touchDistance(e.touches);
                this.pinchMid = this.touchMidpoint(e.touches);
                return;
            }

            const wasPinching = this.pinchDist !== null;
            this.pinchDist = null;
            this.pinchMid = null;

            if (wasPinching && e.touches.length === 1) {
                // Dropping from pinch to one finger: hand the survivor over to
                // panning, otherwise it is dead input until it is lifted.
                const screen = this.getScreenCoords(e.touches[0]);
                this.panSession = {
                    startX: screen.x, startY: screen.y,
                    lastX: screen.x, lastY: screen.y,
                    moved: true
                };
                this.isMouseDown = true;
                return;
            }
            if (wasPinching) return;

            this.handleMouseUp();
            // Touch has no hover, so nothing else would ever clear it and the
            // last tapped spiral would stay highlighted forever
            this.canvas.setHovered(null);
        });
        canvasEl.addEventListener('touchcancel', (e) => {
            e.preventDefault();
            this.pinchDist = null;
            this.pinchMid = null;
            if (this.drawingState !== InteractionHandler.STATE_IDLE) {
                this.cancelDrawing();
            }
            this.handleMouseUp();
            this.handleMouseLeave();
        });
        canvasEl.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length >= 2) {
                // Pinch works in every state - you need to zoom in to place a
                // spiral accurately, not just to browse
                const dist = this.touchDistance(e.touches);
                const mid = this.touchMidpoint(e.touches);
                if (this.pinchDist && this.pinchMid) {
                    this.canvas.zoomAt(mid.x, mid.y, dist / this.pinchDist);
                    // Two-finger pan: the world tracks the fingers instead of
                    // only scaling under them
                    this.canvas.panBy(mid.x - this.pinchMid.x, mid.y - this.pinchMid.y);
                }
                this.pinchDist = dist;
                this.pinchMid = mid;
                return;
            }
            if (this.pinchDist !== null) return; // mid-pinch bookkeeping
            this.handleMouseMove(e.touches[0]);
        });

        // Mouse wheel: zoom when idle, curvature while drawing
        canvasEl.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
    }

    /**
     * Get world coordinates from event (through the camera).
     * All hit tests, drawing gestures and previews operate in world space.
     */
    getCanvasCoords(event) {
        const screen = this.getScreenCoords(event);
        return this.canvas.screenToWorld(screen.x, screen.y);
    }

    /**
     * Get raw screen (canvas CSS pixel) coordinates from event.
     * Used for pan deltas, zoom anchors and gesture thresholds.
     */
    getScreenCoords(event) {
        const rect = this.canvas.canvas.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };
    }

    /**
     * Distance between two touches (screen px).
     */
    touchDistance(touches) {
        return Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY
        );
    }

    /**
     * Midpoint of two touches in canvas screen coordinates.
     */
    touchMidpoint(touches) {
        const rect = this.canvas.canvas.getBoundingClientRect();
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
            y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top
        };
    }

    /**
     * Find which message spiral is at a given point.
     */
    findMessageAtPoint(x, y) {
        // World-space threshold: constant hit feel in screen pixels at any zoom
        const threshold = this.hitThreshold / this.canvas.camera.scale;

        for (const msg of this.canvas.messages) {
            if (!msg.spiralData) continue;
            // Only hit-test visible spirals (progressive reveal hides children)
            if (this.canvas.visibleMessageIds.size > 0 &&
                !this.canvas.visibleMessageIds.has(msg.id)) continue;

            for (const point of msg.spiralData.points) {
                const dist = Math.hypot(x - point.x, y - point.y);
                if (dist <= threshold) {
                    return msg;
                }
            }

            // Also check endpoint
            const endDist = Math.hypot(x - msg.spiralData.endX, y - msg.spiralData.endY);
            if (endDist <= threshold + 4 / this.canvas.camera.scale) {
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
        const threshold = this.hitThreshold / this.canvas.camera.scale;

        for (const msg of this.canvas.messages) {
            if (!msg.spiralData) continue;

            for (const point of msg.spiralData.points) {
                const dist = Math.hypot(x - point.x, y - point.y);
                if (dist <= threshold && dist < bestDist) {
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
        this.gestureAnchor = null;
        this.skipBranchRelease = false;
        this.activeMessage = null;
        this.isMouseDown = false;
        this.panSession = null;
        this.holdStartScreen = null;
        this.onDrawingCancel();
        this.canvas.canvas.style.cursor = 'default';
    }

    /**
     * Set spiral curl from the drawing HUD. The mouse wheel is the only other
     * way to reach this, so on touch it is the only way.
     * @param {number} value - 0 (~72 degrees) to 1.0 (~720 degrees)
     */
    setCurvature(value) {
        this.previewCurvature = Math.max(0, Math.min(1.0, value));
        this.refreshPreview();
    }

    /**
     * Flip the spiral's winding direction. Inferring it from the gesture's
     * cross product is unreliable with a fingertip, so it is also explicit.
     */
    toggleCurvatureDir() {
        this.previewCurvatureDir = -this.previewCurvatureDir;
        this.refreshPreview();
    }

    /**
     * Redraw the preview with the current params, without needing a new
     * pointer position.
     */
    refreshPreview() {
        if (this.drawingState !== InteractionHandler.STATE_DRAWING_SPIRAL) return;
        if (!this.branchPoint || !this.lastCoords) return;
        this.onSpiralPreview(this.branchPoint, this.lastCoords, this.gesturePath, {
            curvature: this.previewCurvature,
            curvatureDir: this.previewCurvatureDir
        });
    }

    /**
     * Handle mouse down.
     */
    handleMouseDown(event) {
        this.isMouseDown = true;
        const coords = this.getCanvasCoords(event);
        const screen = this.getScreenCoords(event);
        this.lastCoords = coords;

        // State machine handling
        switch (this.drawingState) {
            case InteractionHandler.STATE_IDLE:
                this.handleIdleClick(coords, screen);
                break;

            case InteractionHandler.STATE_SELECTING_BRANCH:
                // Pointer: click confirms the hovered branch point.
                // Touch: pressing begins the adjustment, release confirms -
                // otherwise the very first touch would confirm whatever the
                // double-tap happened to land on.
                if (this.pressDrag) {
                    this.handleBranchPointMove(coords);
                } else {
                    this.confirmBranchPoint(coords);
                }
                break;

            case InteractionHandler.STATE_DRAWING_SPIRAL:
                if (this.pressDrag) {
                    this.gestureAnchor = coords;
                } else {
                    this.confirmSpiral(coords);
                }
                break;
        }
    }

    /**
     * Handle click in idle state.
     */
    handleIdleClick(coords, screen) {
        const isDouble = this.isDoubleClick(screen);
        const message = this.findMessageAtPoint(coords.x, coords.y);

        if (isDouble && message) {
            // Double-click on spiral → enter branch selection mode
            this.parentMessage = message;
            this.drawingState = InteractionHandler.STATE_SELECTING_BRANCH;
            this.skipBranchRelease = this.pressDrag;

            // Find initial branch point
            const pointInfo = this.findClosestPointOnSpiral(coords.x, coords.y, message);
            this.branchPoint = pointInfo.point;
            this.branchT = pointInfo.branchT;

            this.canvas.setSelected(message.id);
            this.onBranchPointMove(message, this.branchPoint, this.branchT);
            this.canvas.canvas.style.cursor = 'crosshair';
        } else if (isDouble) {
            // Double-click on empty space → fit everything into view
            this.canvas.fitToContent();
        } else if (message) {
            // Single click → normal selection/translation
            this.activeMessage = message;
            this.holdStartScreen = screen;
            this.canvas.setSelected(message.id);
            this.onSelect(message);
            this.onMouseDown(message);
        } else {
            // Empty space → pan candidate. Deselect happens on mouseup only
            // if the pointer didn't drag (so panning keeps the selection).
            this.panSession = {
                startX: screen.x, startY: screen.y,
                lastX: screen.x, lastY: screen.y,
                moved: false
            };
            this.canvas.canvas.style.cursor = 'grabbing';
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
        this.gestureAnchor = null;
        this.canvas.canvas.style.cursor = 'default';
    }

    /**
     * Handle mouse up.
     */
    handleMouseUp(event) {
        // Touch drawing: the release is what commits each step
        if (this.pressDrag && this.drawingState !== InteractionHandler.STATE_IDLE) {
            const coords = this.lastCoords;
            this.isMouseDown = false;

            if (this.drawingState === InteractionHandler.STATE_SELECTING_BRANCH) {
                if (this.skipBranchRelease) {
                    this.skipBranchRelease = false;
                    return;
                }
                if (coords) this.confirmBranchPoint(coords);
                return;
            }

            // Ignore a stray tap that never became a drag - confirming here
            // would create a zero-length spiral
            const anchor = this.gestureAnchor;
            const dragged = coords && anchor &&
                Math.hypot(coords.x - anchor.x, coords.y - anchor.y) > 20;
            if (dragged) this.confirmSpiral(coords);
            this.gestureAnchor = null;
            return;
        }

        if (this.panSession) {
            if (!this.panSession.moved) {
                // Plain click on empty space: deselect
                this.canvas.setSelected(null);
                this.onSelect(null);
            }
            this.panSession = null;
            this.canvas.canvas.style.cursor = 'default';
        }

        if (this.isMouseDown && this.activeMessage &&
            this.drawingState === InteractionHandler.STATE_IDLE) {
            this.onMouseUp(this.activeMessage);
        }
        this.holdStartScreen = null;
        this.isMouseDown = false;
    }

    /**
     * Handle mouse move.
     */
    handleMouseMove(event) {
        const coords = this.getCanvasCoords(event);
        const screen = this.getScreenCoords(event);
        this.lastCoords = coords;

        switch (this.drawingState) {
            case InteractionHandler.STATE_SELECTING_BRANCH:
                this.handleBranchPointMove(coords);
                break;

            case InteractionHandler.STATE_DRAWING_SPIRAL:
                this.handleSpiralMove(coords);
                break;

            default:
                this.handleIdleMove(coords, screen);
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

        if (pointInfo && pointInfo.distance < 100 / this.canvas.camera.scale) {
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
    handleIdleMove(coords, screen) {
        // Active pan drag
        if (this.panSession && this.isMouseDown) {
            const dx = screen.x - this.panSession.lastX;
            const dy = screen.y - this.panSession.lastY;
            this.panSession.lastX = screen.x;
            this.panSession.lastY = screen.y;

            if (!this.panSession.moved) {
                const total = Math.hypot(
                    screen.x - this.panSession.startX,
                    screen.y - this.panSession.startY
                );
                if (total > this.panMoveThreshold) this.panSession.moved = true;
            }

            this.canvas.panBy(dx, dy);
            this.canvas.canvas.style.cursor = 'grabbing';
            return;
        }

        // Holding on a spiral: a real drag cancels the hold (progress is
        // preserved by the pause) and converts into a pan
        if (this.isMouseDown && this.activeMessage && this.holdStartScreen) {
            const dist = Math.hypot(
                screen.x - this.holdStartScreen.x,
                screen.y - this.holdStartScreen.y
            );
            if (dist > this.holdCancelDistance) {
                this.onMouseUp(this.activeMessage);
                this.activeMessage = null;
                this.holdStartScreen = null;
                this.panSession = {
                    startX: screen.x, startY: screen.y,
                    lastX: screen.x, lastY: screen.y,
                    moved: true
                };
                this.canvas.canvas.style.cursor = 'grabbing';
            }
            return;
        }

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
            // Pause any hold in progress - mouseup outside the canvas would
            // otherwise leave the translation running forever
            if (this.isMouseDown && this.activeMessage) {
                this.onMouseUp(this.activeMessage);
            }
            this.activeMessage = null;
            this.holdStartScreen = null;
            this.panSession = null;
            this.isMouseDown = false;
            this.canvas.setHovered(null);
            this.onHover(null);
            this.canvas.canvas.style.cursor = 'default';
        }
    }

    /**
     * Handle mouse wheel - zoom in idle mode, curvature during spiral drawing.
     */
    handleWheel(event) {
        event.preventDefault();

        if (this.drawingState === InteractionHandler.STATE_DRAWING_SPIRAL) {
            // Adjust curvature based on wheel delta
            const delta = event.deltaY > 0 ? -0.05 : 0.05;
            this.previewCurvature = Math.max(0, Math.min(1.0, this.previewCurvature + delta));

            // Get current mouse position and update preview
            const coords = this.getCanvasCoords(event);
            this.onSpiralPreview(this.branchPoint, coords, this.gesturePath, {
                curvature: this.previewCurvature,
                curvatureDir: this.previewCurvatureDir
            });
            return;
        }

        if (this.drawingState === InteractionHandler.STATE_SELECTING_BRANCH) {
            return; // No wheel action while picking a branch point
        }

        // Idle: zoom centered on the cursor
        const screen = this.getScreenCoords(event);
        this.canvas.zoomAt(screen.x, screen.y, event.deltaY < 0 ? 1.1 : 1 / 1.1);
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
