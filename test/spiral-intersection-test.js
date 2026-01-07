/**
 * Test for spiral intersection detection.
 * Run with: node test/spiral-intersection-test.js
 */

// Copy the spiral generation code for testing (Node.js doesn't have window)
function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const ccw = (px, py, qx, qy, rx, ry) =>
        (ry - py) * (qx - px) > (qy - py) * (rx - px);
    return ccw(ax1, ay1, bx1, by1, bx2, by2) !== ccw(ax2, ay2, bx1, by1, bx2, by2) &&
           ccw(ax1, ay1, ax2, ay2, bx1, by1) !== ccw(ax1, ay1, ax2, ay2, bx2, by2);
}

function checkSpiralIntersection(newPoints, existingSpirals, skipSegments = 5) {
    for (const existing of existingSpirals) {
        if (!existing.points) continue;
        const existingPoints = existing.points;

        for (let i = skipSegments; i < newPoints.length - 1; i++) {
            for (let j = skipSegments; j < existingPoints.length - 1; j++) {
                if (segmentsIntersect(
                    newPoints[i].x, newPoints[i].y,
                    newPoints[i + 1].x, newPoints[i + 1].y,
                    existingPoints[j].x, existingPoints[j].y,
                    existingPoints[j + 1].x, existingPoints[j + 1].y
                )) {
                    return true;
                }
            }
        }
    }
    return false;
}

function seededRandom(seed) {
    const x = Math.sin(seed * 9301 + 49297) * 233280;
    return x - Math.floor(x);
}

function seededRandoms(seed, count) {
    const values = [];
    for (let i = 0; i < count; i++) {
        values.push(seededRandom(seed * 1000 + i * 127));
    }
    return values;
}

class SpiralGenerator {
    constructor(options = {}) {
        this.baseLength = options.length || 280;
        this.baseCurvature = options.curvature || 3.2;
        this.numPoints = options.numPoints || 50;
    }

    generateSpiralPoints(centerX, centerY, startAngle = 0, scale = 1, seed = 0, overrides = {}) {
        const points = [];
        const [rLen, rCurve, rDir] = seededRandoms(seed, 3);

        const lengthScale = overrides.lengthScale ?? 1;
        const curvatureScale = overrides.curvatureScale ?? 1;
        const angleOffset = overrides.angleOffset ?? 0;

        const length = this.baseLength * scale * (0.85 + rLen * 0.3) * lengthScale;
        const curvatureSign = overrides.curvatureSign ?? (rDir > 0.5 ? 1 : -1);
        const curvature = this.baseCurvature * (0.85 + rCurve * 0.3) * curvatureSign * curvatureScale;

        const adjustedStartAngle = startAngle + angleOffset;
        const dt = 1 / this.numPoints;
        let x = centerX;
        let y = centerY;

        for (let i = 0; i <= this.numPoints; i++) {
            const t = i / this.numPoints;
            const theta = adjustedStartAngle + curvature * t;
            points.push({ x, y, theta, progress: t });

            if (i < this.numPoints) {
                const stepSize = length * dt;
                x += stepSize * Math.cos(theta);
                y += stepSize * Math.sin(theta);
            }
        }
        points.curvature = curvature;
        return points;
    }
}

class TreeLayoutEngine {
    constructor(canvasWidth, canvasHeight) {
        this.width = canvasWidth;
        this.height = canvasHeight;
        this.centerX = canvasWidth / 2;
        this.centerY = canvasHeight / 2;
        this.spiralGenerator = new SpiralGenerator();
        this.occupiedPoints = [];
        this.allSpirals = [];
    }

    layoutTree(messages) {
        if (!messages || messages.length === 0) return [];

        this.occupiedPoints = [];
        this.allSpirals = [];

        const messageMap = new Map();
        const roots = [];

        messages.forEach(m => {
            messageMap.set(m.id, { ...m, children: [], spiralData: null });
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

        roots.forEach(root => this.calculateSubtreeSize(root));

        const totalWeight = roots.reduce((sum, r) => sum + r.subtreeWeight, 0);
        let currentAngle = -Math.PI / 2;

        roots.forEach((root) => {
            const angleAllocation = (root.subtreeWeight / totalWeight) * 2 * Math.PI;
            const startAngle = currentAngle + angleAllocation / 2;
            this.layoutSubtree(root, this.centerX, this.centerY, startAngle, 1, angleAllocation, null);
            currentAngle += angleAllocation;
        });

        return Array.from(messageMap.values());
    }

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

    generateParameterVariations(seed) {
        const variations = [];
        const [rDir] = seededRandoms(seed, 1);
        const preferredSign = rDir > 0.5 ? 1 : -1;

        const curvatureSigns = [preferredSign, -preferredSign];
        const lengthScales = [1.0, 0.75, 0.5];
        const curvatureScales = [1.0, 0.7, 0.4];
        const angleOffsets = [0, 0.4, -0.4, 0.8, -0.8];

        for (const lengthScale of lengthScales) {
            for (const curvatureSign of curvatureSigns) {
                for (const angleOffset of angleOffsets) {
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

    scoreDirection(fromX, fromY, angle, scale) {
        const sampleDistance = 150 * scale;
        const sampleX = fromX + Math.cos(angle) * sampleDistance;
        const sampleY = fromY + Math.sin(angle) * sampleDistance;

        let minDist = Infinity;
        for (const pt of this.occupiedPoints) {
            const d = Math.hypot(sampleX - pt.x, sampleY - pt.y);
            minDist = Math.min(minDist, d);
        }

        const margin = 50;
        if (sampleX < margin || sampleX > this.width - margin ||
            sampleY < margin || sampleY > this.height - margin) {
            minDist *= 0.3;
        }

        return minDist;
    }

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

    layoutSubtree(node, startX, startY, startAngle, depth, allocatedAngle, parentSpiralData) {
        const scale = Math.max(0.4, 1 - (depth - 1) * 0.15);
        const variations = this.generateParameterVariations(node.id);

        let points = null;
        let usedOverrides = {};

        for (let attempt = 0; attempt < variations.length; attempt++) {
            const overrides = variations[attempt];

            points = this.spiralGenerator.generateSpiralPoints(
                startX, startY, startAngle, scale, node.id, overrides
            );

            if (!checkSpiralIntersection(points, this.allSpirals)) {
                usedOverrides = overrides;
                break;
            }

            if (attempt === variations.length - 1) {
                usedOverrides = overrides;
            }
        }

        const endPoint = points[points.length - 1];
        const endAngle = startAngle + (usedOverrides.angleOffset || 0) +
            (points.curvature || this.spiralGenerator.baseCurvature);

        node.spiralData = {
            points,
            startX, startY,
            endX: endPoint.x, endY: endPoint.y,
            startAngle, endAngle,
            curvature: points.curvature,
            depth, scale
        };

        this.allSpirals.push({ points });

        this.occupiedPoints.push(
            { x: startX, y: startY },
            { x: endPoint.x, y: endPoint.y }
        );
        const midIdx = Math.floor(points.length / 2);
        this.occupiedPoints.push({ x: points[midIdx].x, y: points[midIdx].y });

        if (node.children.length > 0) {
            const numChildren = node.children.length;

            node.children.forEach((child, index) => {
                const baseT = 0.3 + (index / Math.max(1, numChildren - 1)) * 0.55;
                const [rBranch] = seededRandoms(child.id + 500, 1);
                const branchT = Math.max(0.25, Math.min(0.9, baseT + (rBranch - 0.5) * 0.15));

                const branchIndex = Math.floor(branchT * (points.length - 1));
                const branchPoint = points[branchIndex];

                const childStartX = branchPoint.x;
                const childStartY = branchPoint.y;

                const parentTangent = branchPoint.theta;
                const parentCurvature = points.curvature || this.spiralGenerator.baseCurvature;
                const outwardDir = parentCurvature > 0 ? -1 : 1;
                const baseAngle = parentTangent + outwardDir * Math.PI / 2;

                const candidates = [];
                const numCandidates = 5;
                const spreadAngle = Math.PI / 3;

                for (let i = 0; i < numCandidates; i++) {
                    const t = i / (numCandidates - 1);
                    const candidateAngle = baseAngle + (t - 0.5) * spreadAngle;
                    const score = this.scoreDirection(childStartX, childStartY, candidateAngle, scale);
                    candidates.push({ angle: candidateAngle, score });
                }

                const childAngle = this.selectWeightedAngle(candidates);
                const childAllocatedAngle = allocatedAngle * (child.subtreeWeight / node.subtreeWeight) * 0.8;

                this.layoutSubtree(
                    child, childStartX, childStartY, childAngle,
                    depth + 1, childAllocatedAngle, node.spiralData
                );
            });
        }
    }
}

// Verification function to find any remaining intersections
function findIntersections(layoutNodes) {
    const intersections = [];
    const spirals = layoutNodes.filter(n => n.spiralData);

    for (let i = 0; i < spirals.length; i++) {
        for (let j = i + 1; j < spirals.length; j++) {
            const pointsA = spirals[i].spiralData.points;
            const pointsB = spirals[j].spiralData.points;

            const isParentChild = spirals[j].parent_id === spirals[i].id ||
                                  spirals[i].parent_id === spirals[j].id;

            const skipSegments = 5;
            for (let a = skipSegments; a < pointsA.length - 1; a++) {
                for (let b = skipSegments; b < pointsB.length - 1; b++) {
                    if (segmentsIntersect(
                        pointsA[a].x, pointsA[a].y,
                        pointsA[a + 1].x, pointsA[a + 1].y,
                        pointsB[b].x, pointsB[b].y,
                        pointsB[b + 1].x, pointsB[b + 1].y
                    )) {
                        intersections.push({
                            spiral1: { id: spirals[i].id, segment: a },
                            spiral2: { id: spirals[j].id, segment: b },
                            isParentChild
                        });
                    }
                }
            }
        }
    }

    return intersections;
}

// Test cases
const testCases = [
    {
        name: "Deep tree with branch (13 messages)",
        messages: [
            { id: 33, parent_id: null },
            { id: 34, parent_id: 33 },
            { id: 35, parent_id: 34 },
            { id: 36, parent_id: 35 },
            { id: 37, parent_id: 36 },
            { id: 38, parent_id: 37 },
            { id: 39, parent_id: 38 },
            { id: 40, parent_id: 39 },
            { id: 41, parent_id: 40 },
            { id: 42, parent_id: 41 },
            { id: 43, parent_id: 41 },
            { id: 44, parent_id: 43 },
            { id: 45, parent_id: 44 }
        ]
    },
    {
        name: "Wide tree (one parent, many children)",
        messages: [
            { id: 1, parent_id: null },
            { id: 2, parent_id: 1 },
            { id: 3, parent_id: 1 },
            { id: 4, parent_id: 1 },
            { id: 5, parent_id: 1 },
            { id: 6, parent_id: 1 }
        ]
    },
    {
        name: "Multiple roots",
        messages: [
            { id: 1, parent_id: null },
            { id: 2, parent_id: 1 },
            { id: 3, parent_id: 1 },
            { id: 10, parent_id: null },
            { id: 11, parent_id: 10 },
            { id: 12, parent_id: 10 }
        ]
    },
    {
        name: "Deep linear chain (15 messages)",
        messages: Array.from({ length: 15 }, (_, i) => ({
            id: i + 1,
            parent_id: i === 0 ? null : i
        }))
    },
    {
        name: "Binary tree (7 messages)",
        messages: [
            { id: 1, parent_id: null },
            { id: 2, parent_id: 1 },
            { id: 3, parent_id: 1 },
            { id: 4, parent_id: 2 },
            { id: 5, parent_id: 2 },
            { id: 6, parent_id: 3 },
            { id: 7, parent_id: 3 }
        ]
    },
    {
        name: "Very deep chain (20 messages)",
        messages: Array.from({ length: 20 }, (_, i) => ({
            id: i + 1,
            parent_id: i === 0 ? null : i
        }))
    }
];

// Run tests
console.log("Spiral Intersection Tests\n" + "=".repeat(50) + "\n");

const engine = new TreeLayoutEngine(800, 600);
let totalIntersections = 0;
let failedTests = 0;

for (const testCase of testCases) {
    const layout = engine.layoutTree(testCase.messages);
    const intersections = findIntersections(layout);

    const status = intersections.length === 0 ? "✓ PASS" : "✗ FAIL";
    console.log(`${status}: ${testCase.name}`);
    console.log(`   Messages: ${testCase.messages.length}, Intersections: ${intersections.length}`);

    if (intersections.length > 0) {
        failedTests++;
        totalIntersections += intersections.length;
        for (const inter of intersections.slice(0, 5)) {
            console.log(`   - Spiral ${inter.spiral1.id} (seg ${inter.spiral1.segment}) ` +
                       `intersects Spiral ${inter.spiral2.id} (seg ${inter.spiral2.segment})` +
                       (inter.isParentChild ? " [parent-child]" : ""));
        }
        if (intersections.length > 5) {
            console.log(`   ... and ${intersections.length - 5} more`);
        }
    }
    console.log();
}

console.log("=".repeat(50));
console.log(`Total: ${testCases.length - failedTests}/${testCases.length} passed`);
console.log(`Total intersections found: ${totalIntersections}`);

process.exit(failedTests > 0 ? 1 : 0);
