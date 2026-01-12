/**
 * Sample a point along a cubic Bezier curve at parameter t.
 */
function sampleBezierPoint(p0, cp1, cp2, p1, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;

    return {
        x: mt3 * p0.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * p1.x,
        y: mt3 * p0.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * p1.y
    };
}

/**
 * Convert raw spiral points to densely sampled points along the Bezier curves.
 * This matches the actual rendered curve path.
 */
function sampleBezierCurve(points, samplesPerSegment = 4) {
    if (points.length < 2) return points.map(p => ({ x: p.x, y: p.y }));

    const sampled = [];

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        // Catmull-Rom to Bezier conversion (same as pointsToBezierPath)
        const cp1 = {
            x: p1.x + (p2.x - p0.x) / 6,
            y: p1.y + (p2.y - p0.y) / 6
        };
        const cp2 = {
            x: p2.x - (p3.x - p1.x) / 6,
            y: p2.y - (p3.y - p1.y) / 6
        };

        // Sample this Bezier segment
        const startJ = (i === 0) ? 0 : 1; // Skip first point after first segment to avoid duplicates
        for (let j = startJ; j <= samplesPerSegment; j++) {
            const t = j / samplesPerSegment;
            sampled.push(sampleBezierPoint(p1, cp1, cp2, p2, t));
        }
    }

    return sampled;
}

// ============================================================================
// Analytical Bezier-Bezier Intersection Detection
// Uses recursive subdivision with bounding box culling
// ============================================================================

/**
 * Compute midpoint between two points.
 */
function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Compute axis-aligned bounding box for a cubic Bezier curve.
 * For cubic Bezier, curve is contained within convex hull of control points.
 */
function bezierBoundingBox(p0, cp1, cp2, p1) {
    return {
        minX: Math.min(p0.x, cp1.x, cp2.x, p1.x),
        maxX: Math.max(p0.x, cp1.x, cp2.x, p1.x),
        minY: Math.min(p0.y, cp1.y, cp2.y, p1.y),
        maxY: Math.max(p0.y, cp1.y, cp2.y, p1.y)
    };
}

/**
 * Check if two axis-aligned bounding boxes overlap.
 */
function boxesOverlap(box1, box2) {
    return !(box1.maxX < box2.minX || box2.maxX < box1.minX ||
             box1.maxY < box2.minY || box2.maxY < box1.minY);
}

/**
 * Split a cubic Bezier curve at t=0.5 using de Casteljau's algorithm.
 * Returns two Bezier curves (left and right halves).
 */
function splitBezier(p0, cp1, cp2, p1) {
    const m01 = midpoint(p0, cp1);
    const m12 = midpoint(cp1, cp2);
    const m23 = midpoint(cp2, p1);
    const m012 = midpoint(m01, m12);
    const m123 = midpoint(m12, m23);
    const mid = midpoint(m012, m123);

    return {
        left: { p0: p0, cp1: m01, cp2: m012, p1: mid },
        right: { p0: mid, cp1: m123, cp2: m23, p1: p1 }
    };
}

/**
 * Check if two cubic Bezier curves intersect using recursive subdivision.
 * This is an analytical approach that converges to true intersections.
 *
 * @param {Object} curve1 - First Bezier curve {p0, cp1, cp2, p1}
 * @param {Object} curve2 - Second Bezier curve {p0, cp1, cp2, p1}
 * @param {number} depth - Current recursion depth
 * @param {number} maxDepth - Maximum recursion depth (default 16)
 * @param {number} tolerance - Size threshold for convergence (default 4.0 pixels to account for line width)
 * @returns {boolean} True if curves intersect
 */
function bezierCurvesIntersect(curve1, curve2, depth = 0, maxDepth = 16, tolerance = 4.0) {
    // Get bounding boxes
    const box1 = bezierBoundingBox(curve1.p0, curve1.cp1, curve1.cp2, curve1.p1);
    const box2 = bezierBoundingBox(curve2.p0, curve2.cp1, curve2.cp2, curve2.p1);

    // Quick reject if boxes don't overlap
    if (!boxesOverlap(box1, box2)) return false;

    // Compute sizes of bounding boxes
    const size1 = Math.max(box1.maxX - box1.minX, box1.maxY - box1.minY);
    const size2 = Math.max(box2.maxX - box2.minX, box2.maxY - box2.minY);

    // If both curves are small enough and overlapping, intersection found
    if (size1 < tolerance && size2 < tolerance) {
        return true;
    }

    // Max depth reached - assume intersection if boxes still overlap
    if (depth >= maxDepth) return true;

    // Subdivide the larger curve and recurse
    if (size1 > size2) {
        const { left, right } = splitBezier(curve1.p0, curve1.cp1, curve1.cp2, curve1.p1);
        return bezierCurvesIntersect(left, curve2, depth + 1, maxDepth, tolerance) ||
               bezierCurvesIntersect(right, curve2, depth + 1, maxDepth, tolerance);
    } else {
        const { left, right } = splitBezier(curve2.p0, curve2.cp1, curve2.cp2, curve2.p1);
        return bezierCurvesIntersect(curve1, left, depth + 1, maxDepth, tolerance) ||
               bezierCurvesIntersect(curve1, right, depth + 1, maxDepth, tolerance);
    }
}

/**
 * Convert spiral points to array of Bezier curve segments.
 * Uses Catmull-Rom to Bezier conversion.
 */
function pointsToBezierSegments(points) {
    if (points.length < 2) return [];

    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        // Catmull-Rom to Bezier conversion
        segments.push({
            p0: { x: p1.x, y: p1.y },
            cp1: {
                x: p1.x + (p2.x - p0.x) / 6,
                y: p1.y + (p2.y - p0.y) / 6
            },
            cp2: {
                x: p2.x - (p3.x - p1.x) / 6,
                y: p2.y - (p3.y - p1.y) / 6
            },
            p1: { x: p2.x, y: p2.y }
        });
    }
    return segments;
}

// ============================================================================
// Legacy line segment intersection (kept for compatibility)
// ============================================================================

/**
 * Check if two line segments intersect.
 * Uses counter-clockwise orientation test.
 */
function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    // Standard line segment intersection using cross products
    const d1x = ax2 - ax1, d1y = ay2 - ay1;
    const d2x = bx2 - bx1, d2y = by2 - by1;

    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-10) return false; // Parallel

    const dx = bx1 - ax1, dy = by1 - ay1;
    const t = (dx * d2y - dy * d2x) / cross;
    const u = (dx * d1y - dy * d1x) / cross;

    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Check if a new spiral intersects with any existing spirals.
 * Uses analytical Bezier-Bezier intersection detection via recursive subdivision.
 *
 * Skip logic:
 * - Skip first few Bezier segments of NEW spiral (branch point area)
 * - Check against ALL segments of existing spirals
 */
function checkSpiralIntersection(newPoints, existingSpirals, skipSegments = 3) {
    // Convert new spiral points to Bezier segments
    const newBeziers = pointsToBezierSegments(newPoints);

    for (const existing of existingSpirals) {
        // Use cached Bezier segments if available, otherwise compute
        const existingBeziers = existing.bezierSegments ||
            (existing.points ? pointsToBezierSegments(existing.points) : null);

        if (!existingBeziers) continue;

        // Check new spiral's Bezier segments (after skip) against all existing segments
        for (let i = skipSegments; i < newBeziers.length; i++) {
            for (let j = 0; j < existingBeziers.length; j++) {
                if (bezierCurvesIntersect(newBeziers[i], existingBeziers[j])) {
                    return true;
                }
            }
        }
    }
    return false;
}

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
        this.baseLength = options.length || 280;
        this.baseCurvature = options.curvature || (4 * Math.PI);  // Up to 720 degrees of curl
        this.numPoints = options.numPoints || 50;
    }

    /**
     * Generate points along a true coiling spiral.
     * Uses Archimedean spiral: position computed by integrating along the curve.
     * @param {number} centerX - Start X position
     * @param {number} centerY - Start Y position
     * @param {number} startAngle - Initial direction angle
     * @param {number} scale - Overall scale factor
     * @param {number} seed - Seed for deterministic randomness
     * @param {object} overrides - Optional parameter overrides for collision avoidance
     * @param {number} overrides.curvatureSign - Force curl direction (1 or -1)
     * @param {number} overrides.curvatureScale - Multiply curvature (0-1 for tighter)
     * @param {number} overrides.lengthScale - Multiply length (0-1 for shorter)
     * @param {number} overrides.angleOffset - Add to start angle
     */
    generateSpiralPoints(centerX, centerY, startAngle = 0, scale = 1, seed = 0, overrides = {}) {
        const points = [];

        // Apply overrides for collision avoidance
        const lengthScale = overrides.lengthScale ?? 1;
        const curvatureScale = overrides.curvatureScale ?? 1;
        const angleOffset = overrides.angleOffset ?? 0;

        // User-drawn spirals set this flag explicitly
        const isUserDrawn = overrides.userDrawn === true;

        let length, curvature, curvatureSign;
        if (isUserDrawn) {
            // Use exact values without randomness for user-drawn spirals
            length = this.baseLength * scale * lengthScale;
            curvatureSign = overrides.curvatureSign ?? 1;
            curvature = this.baseCurvature * curvatureSign * curvatureScale;
        } else {
            // Auto-generated spirals: use ~100° base with slight randomness
            const [rLen, rCurve, rDir] = seededRandoms(seed, 3);
            length = this.baseLength * scale * (0.85 + rLen * 0.3) * lengthScale;
            curvatureSign = overrides.curvatureSign ?? (rDir > 0.5 ? 1 : -1);
            // Base of 100° (0.139) with small variation up to ~140° (0.194)
            const autoScale = 0.139 + rCurve * 0.055;
            curvature = this.baseCurvature * autoScale * curvatureSign * curvatureScale;
        }

        // Apply angle offset
        const adjustedStartAngle = startAngle + angleOffset;

        // Integration step size
        const dt = 1 / this.numPoints;
        let x = centerX;
        let y = centerY;

        // Calculate spiral tightening factor based on total curvature
        // More curvature = more tightening to create true spiral effect
        const totalCurvatureRads = Math.abs(curvature);
        // Tightening increases with curvature: at 2π (360°), reduce to 30% at end
        const maxTightening = Math.min(0.85, totalCurvatureRads / (2 * Math.PI) * 0.7);

        for (let i = 0; i <= this.numPoints; i++) {
            const t = i / this.numPoints;

            // Current angle along the spiral
            const theta = adjustedStartAngle + curvature * t;

            // Store point
            points.push({
                x: x,
                y: y,
                theta: theta,
                progress: t
            });

            // Move along the spiral for next point
            // Decrease step size as we progress to create inward-curling spiral
            if (i < this.numPoints) {
                const tighteningFactor = 1 - t * maxTightening;
                const stepSize = length * dt * tighteningFactor;
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
        this.width = canvasWidth;
        this.height = canvasHeight;
        this.centerX = canvasWidth / 2;
        this.centerY = canvasHeight / 2;
        this.spiralGenerator = new SpiralGenerator();
        this.occupiedPoints = [];
        this.allSpirals = []; // Track all spirals for intersection detection
        this.collisionConflicts = []; // Track messages where user prefs caused collisions
    }

    /**
     * Build layout for entire message tree.
     */
    layoutTree(messages) {
        if (!messages || messages.length === 0) return [];

        // Reset tracking for fresh layout
        this.occupiedPoints = [];
        this.allSpirals = [];
        this.collisionConflicts = [];

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

        // DEBUG: Check for pixel coincidence across all spirals
        debugCheckPixelCoincidence(this.allSpirals);

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
     * Score how "open" a direction is from a given point.
     * Higher score = more empty space in that direction.* Samples multiple points along the potential path.
     */
    scoreDirection(fromX, fromY, angle, scale) {
        // Sample multiple points along the direction to better assess openness
        const sampleDistances = [80 * scale, 150 * scale, 220 * scale];
        let totalScore = 0;

        for (const dist of sampleDistances) {
            const sampleX = fromX + Math.cos(angle) * dist;
            const sampleY = fromY + Math.sin(angle) * dist;

            // Find minimum distance to any occupied point
            let minDist = Infinity;
            for (const pt of this.occupiedPoints) {
                const d = Math.hypot(sampleX - pt.x, sampleY - pt.y);
                minDist = Math.min(minDist, d);
            }

            // Heavily penalize directions that go off-canvas
            const margin = 50;
            if (sampleX < margin || sampleX > this.width - margin ||
                sampleY < margin || sampleY > this.height - margin) {
                minDist *= 0.1;
            }

            totalScore += minDist;
        }

        return totalScore;
    }

    /**
     * Find a good angle from candidates - picks from top scorers with slight randomness.
     */
    selectBestAngle(candidates) {
        if (candidates.length === 0) return 0;

        // Sort by score descending
        const sorted = [...candidates].sort((a, b) => b.score - a.score);

        // Pick randomly from top 3 candidates (if available)
        const topN = Math.min(3, sorted.length);
        const picked = sorted[Math.floor(Math.random() * topN)];

        // Add small random angle perturbation (±15°)
        const perturbation = (Math.random() - 0.5) * (Math.PI / 6);

        return picked.angle + perturbation;
    }

    /**
     * Generate parameter variations for collision avoidance.
     * Returns an array of override objects to try in order.
     * @param {number} seed - Seed for deterministic randomness
     * @param {Object} userOverrides - User-specified overrides to respect
     */
    generateParameterVariations(seed, userOverrides = {}) {
        const variations = [];
        const [rDir] = seededRandoms(seed, 1);
        const preferredSign = rDir > 0.5 ? 1 : -1;

        // Respect user curvature direction if specified, otherwise try both
        const curvatureSigns = userOverrides.curvatureSign !== undefined
            ? [userOverrides.curvatureSign]
            : [preferredSign, -preferredSign];

        // Respect user length scale if specified (from drawn spiral), otherwise try variations
        const lengthScales = userOverrides.lengthScale !== undefined
            ? [userOverrides.lengthScale]
            : [1.0, 0.7, 0.5, 0.35];

        // Respect user curvature tightness if specified, otherwise try variations
        const baseTightness = userOverrides.curvatureScale ?? 1.0;
        let curvatureScales = userOverrides.curvatureScale !== undefined
            ? [baseTightness, baseTightness * 0.8, baseTightness * 1.2].filter(s => s >= 0.1 && s <= 1.5)
            : [1.0, 0.6, 0.3];
        // Ensure we always have at least one value
        if (curvatureScales.length === 0) {
            curvatureScales = [baseTightness];
        }

        // If user drew the spiral, don't vary angle
        // Otherwise try wider angle range for collision avoidance
        const isUserDrawn = userOverrides.userDrawn === true;
        const angleOffsets = isUserDrawn
            ? [0]
            : [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.0, -2.0, 2.5, -2.5, Math.PI, -Math.PI];

        // Generate variations - try angle offsets first (most effective for avoiding collisions)
        for (const angleOffset of angleOffsets) {
            for (const curvatureSign of curvatureSigns) {
                for (const lengthScale of lengthScales) {
                    for (const curvatureScale of curvatureScales) {
                        variations.push({
                            curvatureSign,
                            lengthScale,
                            curvatureScale,
                            angleOffset,
                            userDrawn: isUserDrawn
                        });
                    }
                }
            }
        }

        return variations;
    }

    /**
     * Recursively layout a subtree within an allocated angle range.
     * parentSpiralData is used to determine branch point and outward direction.
     * Uses intersection detection and retries with different parameters if needed.
     * If node has saved layout_data, uses those parameters for deterministic replay.
     */
    layoutSubtree(node, startX, startY, startAngle, depth, allocatedAngle, parentSpiralData) {
        // Check for saved layout data first to determine if user-drawn
        const savedLayout = node.layout_data ? JSON.parse(node.layout_data) : null;
        const userPrefs = savedLayout?.userPrefs || {};

        // Scale down spirals for deeper messages, but not for user-drawn spirals
        // User-drawn spirals should maintain their exact drawn size
        const isUserDrawn = userPrefs.userDrawn === true;
        const scale = isUserDrawn ? 1.0 : Math.max(0.4, 1 - (depth - 1) * 0.15);

        let points = null;
        let usedOverrides = {};

        if (savedLayout && savedLayout.overrides) {
            // Use saved position and overrides for deterministic replay
            const savedStartX = savedLayout.offsetX !== undefined
                ? this.centerX + savedLayout.offsetX
                : startX;
            const savedStartY = savedLayout.offsetY !== undefined
                ? this.centerY + savedLayout.offsetY
                : startY;
            const savedStartAngle = savedLayout.startAngle !== undefined
                ? savedLayout.startAngle
                : startAngle;

            usedOverrides = savedLayout.overrides;
            points = this.spiralGenerator.generateSpiralPoints(
                savedStartX, savedStartY, savedStartAngle, scale, node.id, usedOverrides
            );

            // Update startX/Y/Angle for this node's children to use
            startX = savedStartX;
            startY = savedStartY;
            startAngle = savedStartAngle;
        } else {
            // Apply user preferences to initial overrides
            const userOverrides = {};
            const hasUserPrefs = Object.keys(userPrefs).length > 0;
            if (userPrefs.curvatureDir === 'cw') {
                userOverrides.curvatureSign = 1;
            } else if (userPrefs.curvatureDir === 'ccw') {
                userOverrides.curvatureSign = -1;
            }
            if (userPrefs.curvatureTightness !== undefined) {
                userOverrides.curvatureScale = userPrefs.curvatureTightness;
            }
            if (userPrefs.lengthScale !== undefined) {
                userOverrides.lengthScale = userPrefs.lengthScale;
            }
            if (userPrefs.userDrawn) {
                userOverrides.userDrawn = true;
            }

            // If user specified exact startAngle, use it directly (from drawn spiral)
            if (userPrefs.startAngle !== undefined) {
                startAngle = userPrefs.startAngle;
            }

            // Generate parameter variations for collision avoidance
            const variations = this.generateParameterVariations(node.id, userOverrides);

            // Try each variation until we find one that doesn't intersect
            let foundNonIntersecting = false;
            let userPrefsCollided = false;
            for (let attempt = 0; attempt < variations.length; attempt++) {
                const overrides = variations[attempt];

                points = this.spiralGenerator.generateSpiralPoints(
                    startX, startY, startAngle, scale, node.id, overrides
                );

                // Check for intersection with existing spirals
                const intersects = checkSpiralIntersection(points, this.allSpirals);
                if (!intersects) {
                    usedOverrides = overrides;
                    foundNonIntersecting = true;
                    // If this wasn't the first attempt and user had preferences, collision occurred
                    if (attempt > 0 && hasUserPrefs) {
                        userPrefsCollided = true;
                    }
                    break; // Found a non-intersecting configuration
                }

                // If this is the last attempt, use it anyway (best effort)
                if (attempt === variations.length - 1) {
                    usedOverrides = overrides;
                    userPrefsCollided = hasUserPrefs; // User prefs definitely collided
                    console.warn(`Node ${node.id}: Could not find non-intersecting config after ${variations.length} attempts`);
                }
            }
            if (foundNonIntersecting) {
                console.log(`Node ${node.id}: Found non-intersecting config, allSpirals count: ${this.allSpirals.length}`);
            }

            // Track collision conflict for user notification
            if (userPrefsCollided) {
                this.collisionConflicts.push({
                    nodeId: node.id,
                    writerName: node.writer_name,
                    userPrefs: userPrefs,
                    usedOverrides: usedOverrides
                });
            }

            // Mark that this node needs its layout saved
            node.needsLayoutSave = true;
        }

        const bezierPath = this.spiralGenerator.pointsToBezierPath(points);

        // Get endpoint
        const endPoint = points[points.length - 1];

        // Get the ending angle (direction the curve is facing at the end)
        const endAngle = startAngle + (usedOverrides.angleOffset || 0) +
            (points.curvature || this.spiralGenerator.baseCurvature);

        // Store spiral data with layout params for persistence
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
            scale: scale,
            // Layout params for persistence (normalized to canvas center)
            layoutParams: {
                offsetX: startX - this.centerX,
                offsetY: startY - this.centerY,
                startAngle: startAngle,
                overrides: usedOverrides
            }
        };

        // Track this spiral for future intersection checks
        // Cache Bezier segments for efficient analytical intersection detection
        // Include node ID and parent ID for debug coincidence filtering
        const bezierSegments = pointsToBezierSegments(points);
        this.allSpirals.push({
            points,
            bezierSegments,
            nodeId: node.id,
            parentId: node.parent_id
        });

        // Track occupied regions for space-aware branching
        // Sample more points along the spiral for better coverage
        const numOccupiedSamples = 6;
        for (let i = 0; i <= numOccupiedSamples; i++) {
            const idx = Math.floor((i / numOccupiedSamples) * (points.length - 1));
            this.occupiedPoints.push({ x: points[idx].x, y: points[idx].y });
        }

        // Layout children - they branch from various points along this spiral
        if (node.children.length > 0) {
            const numChildren = node.children.length;

            // Distribute children along the parent spiral (from 30% to 85% of the way)
            // with some randomness based on child ID
            node.children.forEach((child, index) => {
                // Check for user-specified branch point
                const childSavedLayout = child.layout_data ? JSON.parse(child.layout_data) : null;
                const childUserPrefs = childSavedLayout?.userPrefs || {};

                let branchT;
                if (childUserPrefs.branchT !== undefined) {
                    // User specified exact branch point
                    branchT = childUserPrefs.branchT;
                } else {
                    // Base branch point distributed along the spiral
                    const baseT = 0.3 + (index / Math.max(1, numChildren - 1)) * 0.55;

                    // Add randomness to branch point
                    const [rBranch] = seededRandoms(child.id + 500, 1);
                    branchT = Math.max(0.25, Math.min(0.9, baseT + (rBranch - 0.5) * 0.15));
                }

                // Get the point along parent where child branches
                const branchIndex = Math.floor(branchT * (points.length - 1));
                const branchPoint = points[branchIndex];

                // Child starts at this branch point
                const childStartX = branchPoint.x;
                const childStartY = branchPoint.y;

                // Check for saved child angle (reuse childSavedLayout from above)
                let childAngle;

                if (childSavedLayout && childSavedLayout.startAngle !== undefined) {
                    // Use saved angle for deterministic replay
                    childAngle = childSavedLayout.startAngle;
                } else {
                    // Calculate child's starting angle - branch towards unexplored regions
                    // Test candidates across full circle to find the most open direction
                    const candidates = [];
                    const numCandidates = 12; // Every 30 degrees

                    for (let i = 0; i < numCandidates; i++) {
                        const candidateAngle = (i / numCandidates) * 2 * Math.PI;
                        const score = this.scoreDirection(childStartX, childStartY, candidateAngle, scale);
                        candidates.push({ angle: candidateAngle, score });
                    }

                    // Always pick the most open direction
                    childAngle = this.selectBestAngle(candidates);
                }

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
        this.width = width;
        this.height = height;
        this.centerX = width / 2;
        this.centerY = height / 2;
    }
}

/**
 * DEBUG: Check every pixel of every spiral and log coinciding pixels.
 * Samples all spiral Bezier curves densely and reports overlaps.
 * Filters out expected parent-child coincidences at branch points.
 * Skips first few points of each spiral (start/branch area).
 */
function debugCheckPixelCoincidence(spirals) {
    console.log("=== DEBUG: Checking pixel coincidence across all spirals ===");
    console.log(`Total spirals to check: ${spirals.length}`);

    // Build nodeId -> spiralIndex map for parent lookup
    const nodeIdToIndex = new Map();
    spirals.forEach((spiral, idx) => {
        if (spiral.nodeId !== undefined) {
            nodeIdToIndex.set(spiral.nodeId, idx);
        }
    });

    // Map: "x,y" -> array of spiral indices that occupy that pixel
    const pixelMap = new Map();

    // High sample rate to catch all pixels
    const samplesPerSegment = 20;
    const skipPoints = 5; // Skip start/branch area

    spirals.forEach((spiral, spiralIndex) => {
        if (!spiral.points || spiral.points.length < 2) return;

        // Get densely sampled points along the Bezier curve
        const sampledPoints = sampleBezierCurve(spiral.points, samplesPerSegment);

        console.log(`Spiral ${spiralIndex} (nodeId=${spiral.nodeId}, parentId=${spiral.parentId}): ${sampledPoints.length} sampled points (skipping first ${skipPoints})`);

        // Skip first few points (start/branch area)
        sampledPoints.slice(skipPoints).forEach((point, pointIndex) => {
            // Round to pixel coordinates
            const px = Math.round(point.x);
            const py = Math.round(point.y);
            const key = `${px},${py}`;

            // Log every pixel
            console.log(`  Spiral ${spiralIndex}, point ${pointIndex + skipPoints}: pixel (${px}, ${py})`);

            if (!pixelMap.has(key)) {
                pixelMap.set(key, []);
            }

            // Track which spiral owns this pixel (avoid duplicates within same spiral)
            const owners = pixelMap.get(key);
            if (!owners.includes(spiralIndex)) {
                owners.push(spiralIndex);
            }
        });
    });

    // Helper to check if two spirals are parent-child
    function areParentChild(idx1, idx2) {
        const s1 = spirals[idx1];
        const s2 = spirals[idx2];
        // s1 is parent of s2?
        if (s2.parentId !== null && nodeIdToIndex.get(s2.parentId) === idx1) return true;
        // s2 is parent of s1?
        if (s1.parentId !== null && nodeIdToIndex.get(s1.parentId) === idx2) return true;
        return false;
    }

    // Find and report coinciding pixels
    console.log("\n=== Coinciding pixels (same pixel occupied by multiple spirals) ===");
    let expectedCoincidenceCount = 0;
    let unexpectedCoincidenceCount = 0;

    pixelMap.forEach((owners, key) => {
        if (owners.length > 1) {
            // Check all pairs of owners
            for (let i = 0; i < owners.length; i++) {
                for (let j = i + 1; j < owners.length; j++) {
                    const idx1 = owners[i];
                    const idx2 = owners[j];
                    if (areParentChild(idx1, idx2)) {
                        expectedCoincidenceCount++;
                        console.log(`EXPECTED (parent-child) at pixel ${key}: spirals ${idx1} and ${idx2}`);
                    } else {
                        unexpectedCoincidenceCount++;
                        console.log(`*** UNEXPECTED *** at pixel ${key}: spirals ${idx1} (nodeId=${spirals[idx1].nodeId}) and ${idx2} (nodeId=${spirals[idx2].nodeId})`);
                    }
                }
            }
        }
    });

    console.log(`\n--- Summary ---`);
    console.log(`Expected (parent-child) coincidences: ${expectedCoincidenceCount}`);
    console.log(`UNEXPECTED coincidences: ${unexpectedCoincidenceCount}`);

    if (unexpectedCoincidenceCount === 0) {
        console.log("All coincidences are at expected parent-child branch points.");
    } else {
        console.log(`WARNING: Found ${unexpectedCoincidenceCount} unexpected pixel overlaps between non-related spirals!`);
    }

    console.log("=== END DEBUG ===\n");

    // Store unexpected pixels globally for visual debugging
    window.debugUnexpectedPixels = [];
    pixelMap.forEach((owners, key) => {
        if (owners.length > 1) {
            for (let i = 0; i < owners.length; i++) {
                for (let j = i + 1; j < owners.length; j++) {
                    if (!areParentChild(owners[i], owners[j])) {
                        const [x, y] = key.split(',').map(Number);
                        window.debugUnexpectedPixels.push({ x, y, spirals: [owners[i], owners[j]] });
                    }
                }
            }
        }
    });

    console.log(`Stored ${window.debugUnexpectedPixels.length} unexpected pixels in window.debugUnexpectedPixels for visual debug`);

    return unexpectedCoincidenceCount;
}

// Export for use in other modules
window.SpiralGenerator = SpiralGenerator;
window.TreeLayoutEngine = TreeLayoutEngine;
window.debugCheckPixelCoincidence = debugCheckPixelCoincidence;
