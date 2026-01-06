/**
 * Interaction handler for canvas - click and hover detection on curved paths.
 */
class InteractionHandler {
    constructor(nomaiCanvas, callbacks = {}) {
        this.canvas = nomaiCanvas;
        this.onSelect = callbacks.onSelect || (() => {});
        this.onHover = callbacks.onHover || (() => {});
        this.onMouseDown = callbacks.onMouseDown || (() => {});
        this.onMouseUp = callbacks.onMouseUp || (() => {});
        this.hitThreshold = 12; // pixels
        this.isMouseDown = false;
        this.activeMessage = null;

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

        // Handle mouseup outside canvas
        document.addEventListener('mouseup', () => {
            if (this.isMouseDown) {
                this.handleMouseUp();
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
        canvasEl.addEventListener('touchcancel', () => {
            this.handleMouseUp();
        });
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
        // Check each message's spiral points
        for (const msg of this.canvas.messages) {
            if (!msg.spiralData) continue;

            // Check distance to sampled points on the spiral
            for (const point of msg.spiralData.points) {
                const dist = Math.sqrt(
                    Math.pow(x - point.x, 2) + Math.pow(y - point.y, 2)
                );
                if (dist <= this.hitThreshold) {
                    return msg;
                }
            }

            // Also check endpoint (the circle)
            const endX = msg.spiralData.endX;
            const endY = msg.spiralData.endY;
            const endDist = Math.sqrt(
                Math.pow(x - endX, 2) + Math.pow(y - endY, 2)
            );
            if (endDist <= this.hitThreshold + 4) {
                return msg;
            }
        }
        return null;
    }

    /**
     * Handle mouse down - start translation.
     */
    handleMouseDown(event) {
        this.isMouseDown = true;
        const coords = this.getCanvasCoords(event);
        const message = this.findMessageAtPoint(coords.x, coords.y);

        this.activeMessage = message;

        if (message) {
            this.canvas.setSelected(message.id);
            this.onSelect(message);
            this.onMouseDown(message);
        } else {
            this.canvas.setSelected(null);
            this.onSelect(null);
        }
    }

    /**
     * Handle mouse up - pause translation.
     */
    handleMouseUp(event) {
        if (this.isMouseDown && this.activeMessage) {
            this.onMouseUp(this.activeMessage);
        }
        this.isMouseDown = false;
    }

    /**
     * Handle mouse move for hover effects.
     */
    handleMouseMove(event) {
        const coords = this.getCanvasCoords(event);
        const message = this.findMessageAtPoint(coords.x, coords.y);

        const newHoveredId = message ? message.id : null;

        this.canvas.setHovered(newHoveredId);
        this.onHover(message);

        // Update cursor
        this.canvas.canvas.style.cursor = message ? 'pointer' : 'default';
    }

    /**
     * Handle mouse leave.
     */
    handleMouseLeave() {
        this.canvas.setHovered(null);
        this.onHover(null);
    }
}

// Export
window.InteractionHandler = InteractionHandler;
