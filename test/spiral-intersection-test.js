/**
 * Test for spiral intersection detection.
 * Run with: node test/spiral-intersection-test.js
 */

// Copy the spiral generation code for testing (Node.js doesn't have window)
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
        this.baseCurvature = options.curvature || 3.0;
        this.numPoints = options.numPoints || 50;
    }

    generateSpiralPoints(centerX, centerY, startAngle = 0, scale = 1, seed = 0, forceCurvatureSign = null, curvatureScale = 1) {
        const points = [];
        const [rLen, rCurve, rDir] = seededRandoms(seed, 3);
        const length = this.baseLength * scale * (0.85 + rLen * 0.3);
        const curvatureSign = forceCurvatureSign !== null ? forceCurvatureSign : (rDir > 0.5 ? 1 : -1);
        const curvature = this.baseCurvature * (0.85 + rCurve * 0.3) * curvatureSign * curvatureScale;

        const dt = 1 / this.numPoints;
        let x = centerX;
        let y = centerY;

        for (let i = 0; i <= this.numPoints; i++) {
            const t = i / this.numPoints;
            const theta = startAngle + curvature * t;
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

function segmentsIntersectInternal(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const ccw = (ax, ay, bx, by, cx, cy) =>
        (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
    return ccw(ax1, ay1, bx1, by1, bx2, by2) !== ccw(ax2, ay2, bx1, by1, bx2, by2) &&
           ccw(ax1, ay1, ax2, ay2, bx1, by1) !== ccw(ax1, ay1, ax2, ay2, bx2, by2);
}

function checkSpiralIntersection(newPoints, existingSpirals, skipSegments = 5) {
    for (const existing of existingSpirals) {
        if (!existing.spiralData || !existing.spiralData.points) continue;
        const existingPoints = existing.spiralData.points;

        for (let i = skipSegments; i < newPoints.length - 1; i++) {
            for (let j = skipSegments; j < existingPoints.length - 1; j++) {
                if (segmentsIntersectInternal(
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

class TreeLayoutEngine {
    constructor(canvasWidth, canvasHeight) {
        this.centerX = canvasWidth / 2;
        this.centerY = canvasHeight / 2;
        this.spiralGenerator = new SpiralGenerator();
        this.allSpirals = [];
    }

    layoutTree(messages) {
        if (!messages || messages.length === 0) return [];

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

    layoutSubtree(node, startX, startY, startAngle, depth, allocatedAngle, parentSpiralData) {
        const baseScale = Math.max(0.4, 1 - (depth - 1) * 0.1);

        const [rCurl] = seededRandoms(node.id + 2000, 1);
        const randomCurlSign = rCurl > 0.5 ? 1 : -1;

        let points;
        const maxAttempts = 30;

        for (let i = 0; i < maxAttempts; i++) {
            const curlSign = (i % 2 === 0) ? randomCurlSign : -randomCurlSign;
            const stage = Math.floor(i / 4);

            const scaleMultiplier = Math.max(0.25, 1.0 - stage * 0.12);
            const curvatureScale = Math.max(0.15, 1.0 - stage * 0.1);

            const angleVariant = i % 4;
            let angleAdjust = 0;
            if (angleVariant === 1) angleAdjust = 0.3 + stage * 0.1;
            else if (angleVariant === 2) angleAdjust = -(0.3 + stage * 0.1);
            else if (angleVariant === 3) angleAdjust = 0.6 + stage * 0.15;

            const scale = baseScale * scaleMultiplier;
            const adjustedAngle = startAngle + angleAdjust;

            points = this.spiralGenerator.generateSpiralPoints(
                startX, startY, adjustedAngle, scale, node.id, curlSign, curvatureScale
            );

            if (!checkSpiralIntersection(points, this.allSpirals)) {
                break;
            }
        }

        const endPoint = points[points.length - 1];
        const endAngle = startAngle + (points.curvature || this.spiralGenerator.baseCurvature);

        node.spiralData = {
            points,
            startX, startY,
            endX: endPoint.x, endY: endPoint.y,
            startAngle, endAngle,
            curvature: points.curvature,
            depth, scale: baseScale
        };

        this.allSpirals.push(node);

        if (node.children.length > 0) {
            const numChildren = node.children.length;

            node.children.forEach((child, index) => {
                const [rBranch] = seededRandoms(child.id + 500, 1);
                const baseT = 0.4 + (index / Math.max(1, numChildren)) * 0.5;
                const randomOffset = (rBranch - 0.5) * 0.2;
                const branchT = Math.max(0.3, Math.min(0.95, baseT + randomOffset));

                const branchIndex = Math.floor(branchT * (points.length - 1));
                const branchPoint = points[branchIndex];

                const childStartX = branchPoint.x;
                const childStartY = branchPoint.y;

                const parentTangent = branchPoint.theta;
                const [rAngle, rSide] = seededRandoms(child.id + 1000, 2);
                const side = (index % 2 === 0) ? (rSide > 0.5 ? 1 : -1) : (rSide > 0.5 ? -1 : 1);
                const baseAngle = side * (Math.PI / 4 + rAngle * Math.PI / 4);
                const siblingSpread = Math.floor(index / 2) * 0.15 * side;
                const angleOffset = baseAngle + siblingSpread;
                const childAngle = parentTangent + angleOffset;

                const childAllocatedAngle = allocatedAngle * (child.subtreeWeight / node.subtreeWeight) * 0.8;

                this.layoutSubtree(
                    child, childStartX, childStartY, childAngle,
                    depth + 1, childAllocatedAngle, node.spiralData
                );
            });
        }
    }
}

// Line segment intersection detection
function ccw(A, B, C) {
    return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
}

function segmentsIntersect(A, B, C, D) {
    return ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
}

function getSegments(spiralData) {
    const segments = [];
    const points = spiralData.points;
    for (let i = 0; i < points.length - 1; i++) {
        segments.push({
            start: { x: points[i].x, y: points[i].y },
            end: { x: points[i + 1].x, y: points[i + 1].y },
            index: i
        });
    }
    return segments;
}

function findIntersections(layoutNodes) {
    const intersections = [];
    const spirals = layoutNodes.filter(n => n.spiralData);

    for (let i = 0; i < spirals.length; i++) {
        for (let j = i + 1; j < spirals.length; j++) {
            const segmentsA = getSegments(spirals[i].spiralData);
            const segmentsB = getSegments(spirals[j].spiralData);

            // Skip first few segments of child if it branches from parent
            // (they will naturally share the branch point)
            const isParentChild = spirals[j].parent_id === spirals[i].id ||
                                  spirals[i].parent_id === spirals[j].id;

            // Skip first 5 segments on both spirals (near branch points)
            const skipSegments = 5;
            for (const segA of segmentsA) {
                if (segA.index < skipSegments) continue;
                for (const segB of segmentsB) {
                    if (segB.index < skipSegments) continue;

                    if (segmentsIntersect(segA.start, segA.end, segB.start, segB.end)) {
                        intersections.push({
                            spiral1: { id: spirals[i].id, segment: segA.index },
                            spiral2: { id: spirals[j].id, segment: segB.index },
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
        name: "The Spiral Display Problem (13 messages, deep tree with branch)",
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
            { id: 43, parent_id: 41 },  // Branch here - two children of 41
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
        name: "Deep linear chain",
        messages: Array.from({ length: 15 }, (_, i) => ({
            id: i + 1,
            parent_id: i === 0 ? null : i
        }))
    },
    {
        name: "Binary tree",
        messages: [
            { id: 1, parent_id: null },
            { id: 2, parent_id: 1 },
            { id: 3, parent_id: 1 },
            { id: 4, parent_id: 2 },
            { id: 5, parent_id: 2 },
            { id: 6, parent_id: 3 },
            { id: 7, parent_id: 3 }
        ]
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
