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
 * Uses sampled Bezier curves to match the actual rendered paths.
 * Skips the first few segments near branch points.
 */
function checkSpiralIntersection(newPoints, existingSpirals, skipSegments = 3) {
    const samplesPerSegment = 4;
    // Sample the new spiral's Bezier curve
    const sampledNew = sampleBezierCurve(newPoints, samplesPerSegment);
    // Adjust skip count for the higher density of sampled points
    const skipSampled = skipSegments * samplesPerSegment;

    for (const existing of existingSpirals) {
        // Use cached sampled points if available, otherwise sample on the fly
        const sampledExisting = existing.sampledPoints ||
            (existing.points ? sampleBezierCurve(existing.points, samplesPerSegment) : null);

        if (!sampledExisting) continue;

        for (let i = skipSampled; i < sampledNew.length - 1; i++) {
            for (let j = skipSampled; j < sampledExisting.length - 1; j++) {
                if (segmentsIntersect(
                    sampledNew[i].x, sampledNew[i].y,
                    sampledNew[i + 1].x, sampledNew[i + 1].y,
                    sampledExisting[j].x, sampledExisting[j].y,
                    sampledExisting[j + 1].x, sampledExisting[j + 1].y
                )) {
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
        this.baseCurvature = options.curvature || 3.2;  // ~180 degrees of curl
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

        // Add randomness based on seed
        const [rLen, rCurve, rDir] = seededRandoms(seed, 3);

        // Apply overrides for collision avoidance
        const lengthScale = overrides.lengthScale ?? 1;
        const curvatureScale = overrides.curvatureScale ?? 1;
        const angleOffset = overrides.angleOffset ?? 0;

        const length = this.baseLength * scale * (0.85 + rLen * 0.3) * lengthScale;
        const curvatureSign = overrides.curvatureSign ?? (rDir > 0.5 ? 1 : -1);
        const curvature = this.baseCurvature * (0.85 + rCurve * 0.3) * curvatureSign * curvatureScale;

        // Apply angle offset
        const adjustedStartAngle = startAngle + angleOffset;

        // Integration step size
        const dt = 1 / this.numPoints;
        let x = centerX;
        let y = centerY;

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
        this.width = canvasWidth;
        this.height = canvasHeight;
        this.centerX = canvasWidth / 2;
        this.centerY = canvasHeight / 2;
        this.spiralGenerator = new SpiralGenerator();
        this.occupiedPoints = [];
        this.allSpirals = []; // Track all spirals for intersection detection
    }

    /**
     * Build layout for entire message tree.
     */
    layoutTree(messages) {
        if (!messages || messages.length === 0) return [];

        // Reset tracking for fresh layout
        this.occupiedPoints = [];
        this.allSpirals = [];

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
     * Score how "open" a direction is from a given point.
     * Higher score = more empty space in that direction.
     */
    scoreDirection(fromX, fromY, angle, scale) {
        const sampleDistance = 150 * scale;
        const sampleX = fromX + Math.cos(angle) * sampleDistance;
        const sampleY = fromY + Math.sin(angle) * sampleDistance;

        // Find minimum distance to any occupied point
        let minDist = Infinity;
        for (const pt of this.occupiedPoints) {
            const d = Math.hypot(sampleX - pt.x, sampleY - pt.y);
            minDist = Math.min(minDist, d);
        }

        // Penalize directions that go off-canvas
        const margin = 50;
        if (sampleX < margin || sampleX > this.width - margin ||
            sampleY < margin || sampleY > this.height - margin) {
            minDist *= 0.3;
        }

        return minDist;
    }

    /**
     * Select angle from candidates using weighted random (non-deterministic).
     */
    selectWeightedAngle(candidates) {
        const totalScore = candidates.reduce((sum, c) => sum + c.score, 0);
        if (totalScore === 0) return candidates[Math.floor(candidates.length / 2)].angle;

        const r = Math.random();
        let cumulative = 0;
        for (const c of candidates) {
            cumulative += c.score / totalScore;
            if (r <= cumulative) return c.angle;
        }
        return candidates[candidates.length - 1].angle;
    }

    /**
     * Generate parameter variations for collision avoidance.
     * Returns an array of override objects to try in order.
     */
    generateParameterVariations(seed) {
        const variations = [];
        const [rDir] = seededRandoms(seed, 1);
        const preferredSign = rDir > 0.5 ? 1 : -1;

        // Try different combinations: curvature direction, length, curvature tightness, angle offset
        const curvatureSigns = [preferredSign, -preferredSign];
        const lengthScales = [1.0, 0.7, 0.5, 0.35];
        const curvatureScales = [1.0, 0.6, 0.3];
        // Much wider angle range - full circle coverage
        const angleOffsets = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.0, -2.0, 2.5, -2.5, Math.PI, -Math.PI];

        // Generate variations - try angle offsets first (most effective for avoiding collisions)
        for (const angleOffset of angleOffsets) {
            for (const curvatureSign of curvatureSigns) {
                for (const lengthScale of lengthScales) {
                    for (const curvatureScale of curvatureScales) {
                        variations.push({
                            curvatureSign,
                            lengthScale,
                            curvatureScale,
                            angleOffset
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
        // Scale down spirals for deeper messages
        const scale = Math.max(0.4, 1 - (depth - 1) * 0.15);

        let points = null;
        let usedOverrides = {};

        // Check for saved layout data
        const savedLayout = node.layout_data ? JSON.parse(node.layout_data) : null;

        if (savedLayout && savedLayout.overrides) {
            // Use saved overrides for deterministic replay
            usedOverrides = savedLayout.overrides;
            points = this.spiralGenerator.generateSpiralPoints(
                startX, startY, startAngle, scale, node.id, usedOverrides
            );
        } else {
            // Generate parameter variations for collision avoidance
            const variations = this.generateParameterVariations(node.id);

            // Try each variation until we find one that doesn't intersect
            let foundNonIntersecting = false;
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
                    break; // Found a non-intersecting configuration
                }

                // If this is the last attempt, use it anyway (best effort)
                if (attempt === variations.length - 1) {
                    usedOverrides = overrides;
                    console.warn(`Node ${node.id}: Could not find non-intersecting config after ${variations.length} attempts`);
                }
            }
            if (foundNonIntersecting) {
                console.log(`Node ${node.id}: Found non-intersecting config, allSpirals count: ${this.allSpirals.length}`);
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
        // Cache sampled Bezier points for efficient intersection detection
        const sampledPoints = sampleBezierCurve(points, 4);
        this.allSpirals.push({ points, sampledPoints });

        // Track occupied regions for space-aware branching
        this.occupiedPoints.push(
            { x: startX, y: startY },
            { x: endPoint.x, y: endPoint.y }
        );
        const midIdx = Math.floor(points.length / 2);
        this.occupiedPoints.push({ x: points[midIdx].x, y: points[midIdx].y });

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

                // Check for saved child angle
                const childSavedLayout = child.layout_data ? JSON.parse(child.layout_data) : null;
                let childAngle;

                if (childSavedLayout && childSavedLayout.startAngle !== undefined) {
                    // Use saved angle for deterministic replay
                    childAngle = childSavedLayout.startAngle;
                } else {
                    // Calculate child's starting angle - branch towards unexplored regions
                    const parentTangent = branchPoint.theta;
                    const parentCurvature = points.curvature || this.spiralGenerator.baseCurvature;
                    const outwardDir = parentCurvature > 0 ? -1 : 1;
                    const baseAngle = parentTangent + outwardDir * Math.PI / 2;

                    // Generate candidate angles and score them by distance to occupied regions
                    const candidates = [];
                    const numCandidates = 5;
                    const spreadAngle = Math.PI / 3; // ±60° spread around base

                    for (let i = 0; i < numCandidates; i++) {
                        const t = i / (numCandidates - 1);
                        const candidateAngle = baseAngle + (t - 0.5) * spreadAngle;
                        const score = this.scoreDirection(childStartX, childStartY, candidateAngle, scale);
                        candidates.push({ angle: candidateAngle, score });
                    }

                    childAngle = this.selectWeightedAngle(candidates);
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

// Export for use in other modules
window.SpiralGenerator = SpiralGenerator;
window.TreeLayoutEngine = TreeLayoutEngine;
