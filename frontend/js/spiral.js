/**
 * Seeded random number generator for deterministic randomness.
 * Uses message ID to ensure same spiral looks the same on re-render.
 */
function seededRandom(seed) {
    const x = Math.sin(seed * 9301 + 49297) * 233280;
    return x - Math.floor(x);
}

/**
 * Get multiple seeded random values from a seed.
 */
function seededRandoms(seed, count) {
    const values = [];
    for (let i = 0; i < count; i++) {
        values.push(seededRandom(seed * 1000 + i * 127));
    }
    return values;
}

/**
 * Spiral generation - creates true coiling spirals like Nomai writing.
 * Uses Archimedean spiral math with randomized parameters.
 */
class SpiralGenerator {
    constructor(options = {}) {
        this.baseLength = options.length || 80;
        this.baseCurvature = options.curvature || 3.2;  // ~180 degrees of curl
        this.numPoints = options.numPoints || 50;
    }

    /**
     * Generate points along a true coiling spiral.
     * Uses Archimedean spiral: position computed by integrating along the curve.
     */
    generateSpiralPoints(centerX, centerY, startAngle = 0, scale = 1, seed = 0) {
        const points = [];

        // Add randomness based on seed
        const [rLen, rCurve] = seededRandoms(seed, 2);
        const length = this.baseLength * scale * (0.85 + rLen * 0.3);
        const curvature = this.baseCurvature * (0.85 + rCurve * 0.3);

        // Integration step size
        const dt = 1 / this.numPoints;
        let x = centerX;
        let y = centerY;

        for (let i = 0; i <= this.numPoints; i++) {
            const t = i / this.numPoints;

            // Current angle along the spiral
            const theta = startAngle + curvature * t;

            // Store point
            points.push({
                x: x,
                y: y,
                theta: theta,
                progress: t
            });

            // Move along the spiral for next point
            // Step in the direction of current angle, with step size proportional to length
            if (i < this.numPoints) {
                const stepSize = length * dt;
                x += stepSize * Math.cos(theta);
                y += stepSize * Math.sin(theta);
            }
        }

        // Store the curvature used for this spiral (needed for child angle calculation)
        points.curvature = curvature;

        return points;
    }

    /**
     * Convert points to smooth bezier curves using Catmull-Rom spline conversion.
     */
    pointsToBezierPath(points) {
        if (points.length < 2) return [];

        const bezierSegments = [];
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[Math.max(0, i - 1)];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[Math.min(points.length - 1, i + 2)];

            // Catmull-Rom to Bezier conversion
            bezierSegments.push({
                start: { x: p1.x, y: p1.y },
                cp1: {
                    x: p1.x + (p2.x - p0.x) / 6,
                    y: p1.y + (p2.y - p0.y) / 6
                },
                cp2: {
                    x: p2.x - (p3.x - p1.x) / 6,
                    y: p2.y - (p3.y - p1.y) / 6
                },
                end: { x: p2.x, y: p2.y }
            });
        }
        return bezierSegments;
    }
}

/**
 * Tree layout engine - positions message spirals on the canvas.
 * Children branch from points along parent spirals, curving outward to prevent crossing.
 */
class TreeLayoutEngine {
    constructor(canvasWidth, canvasHeight) {
        this.centerX = canvasWidth / 2;
        this.centerY = canvasHeight / 2;
        this.spiralGenerator = new SpiralGenerator();
    }

    /**
     * Build layout for entire message tree.
     */
    layoutTree(messages) {
        if (!messages || messages.length === 0) return [];

        // Build message map and find roots
        const messageMap = new Map();
        const roots = [];

        messages.forEach(m => {
            messageMap.set(m.id, {
                ...m,
                children: [],
                spiralData: null
            });
        });

        messages.forEach(m => {
            const node = messageMap.get(m.id);
            if (m.parent_id === null) {
                roots.push(node);
            } else {
                const parent = messageMap.get(m.parent_id);
                if (parent) {
                    parent.children.push(node);
                } else {
                    roots.push(node);
                }
            }
        });

        // Calculate subtree sizes for proportional spacing
        roots.forEach(root => this.calculateSubtreeSize(root));

        // Layout roots - distribute evenly around center
        const totalWeight = roots.reduce((sum, r) => sum + r.subtreeWeight, 0);
        let currentAngle = -Math.PI / 2; // Start from top

        roots.forEach((root) => {
            const angleAllocation = (root.subtreeWeight / totalWeight) * 2 * Math.PI;
            const startAngle = currentAngle + angleAllocation / 2;
            this.layoutSubtree(root, this.centerX, this.centerY, startAngle, 1, angleAllocation, null);
            currentAngle += angleAllocation;
        });

        return Array.from(messageMap.values());
    }

    /**
     * Calculate subtree size for proportional angle allocation.
     */
    calculateSubtreeSize(node) {
        if (node.children.length === 0) {
            node.subtreeWeight = 1;
            return 1;
        }
        let weight = 1;
        node.children.forEach(child => {
            weight += this.calculateSubtreeSize(child);
        });
        node.subtreeWeight = weight;
        return weight;
    }

    /**
     * Recursively layout a subtree within an allocated angle range.
     * parentSpiralData is used to determine branch point and outward direction.
     */
    layoutSubtree(node, startX, startY, startAngle, depth, allocatedAngle, parentSpiralData) {
        // Scale down spirals for deeper messages
        const scale = Math.max(0.4, 1 - (depth - 1) * 0.15);

        // Generate spiral with seeded randomness based on message ID
        const points = this.spiralGenerator.generateSpiralPoints(
            startX, startY, startAngle, scale, node.id
        );
        const bezierPath = this.spiralGenerator.pointsToBezierPath(points);

        // Get endpoint
        const endPoint = points[points.length - 1];

        // Get the ending angle (direction the curve is facing at the end)
        const endAngle = startAngle + (points.curvature || this.spiralGenerator.baseCurvature);

        // Store spiral data
        node.spiralData = {
            points: points,
            bezierPath: bezierPath,
            startX: startX,
            startY: startY,
            endX: endPoint.x,
            endY: endPoint.y,
            startAngle: startAngle,
            endAngle: endAngle,
            curvature: points.curvature,
            depth: depth,
            scale: scale
        };

        // Layout children - they branch from various points along this spiral
        if (node.children.length > 0) {
            const numChildren = node.children.length;

            // Distribute children along the parent spiral (from 30% to 85% of the way)
            // with some randomness based on child ID
            node.children.forEach((child, index) => {
                // Base branch point distributed along the spiral
                const baseT = 0.3 + (index / Math.max(1, numChildren - 1)) * 0.55;

                // Add randomness to branch point
                const [rBranch] = seededRandoms(child.id + 500, 1);
                const branchT = Math.max(0.25, Math.min(0.9, baseT + (rBranch - 0.5) * 0.15));

                // Get the point along parent where child branches
                const branchIndex = Math.floor(branchT * (points.length - 1));
                const branchPoint = points[branchIndex];

                // Child starts at this branch point
                const childStartX = branchPoint.x;
                const childStartY = branchPoint.y;

                // Calculate child's starting angle - branch OUTWARD from the parent's curl
                // The parent curls in direction of increasing theta
                // Child should branch perpendicular, to the outside of the curl
                const parentTangent = branchPoint.theta;

                // Branch outward: perpendicular to tangent, on the outside of the curl
                // Since parent curls clockwise (positive curvature), outside is to the left
                // That means perpendicular - PI/2
                const [rAngle] = seededRandoms(child.id + 1000, 1);
                const angleOffset = -Math.PI / 2 + (rAngle - 0.5) * 0.4; // Outward with some variance
                const childAngle = parentTangent + angleOffset;

                // Give each child a portion of the allocated angle for its subtree
                const childAllocatedAngle = allocatedAngle * (child.subtreeWeight / node.subtreeWeight) * 0.8;

                this.layoutSubtree(
                    child,
                    childStartX,
                    childStartY,
                    childAngle,
                    depth + 1,
                    childAllocatedAngle,
                    node.spiralData
                );
            });
        }
    }

    /**
     * Update dimensions when canvas resizes.
     */
    updateDimensions(width, height) {
        this.centerX = width / 2;
        this.centerY = height / 2;
    }
}

// Export for use in other modules
window.SpiralGenerator = SpiralGenerator;
window.TreeLayoutEngine = TreeLayoutEngine;
