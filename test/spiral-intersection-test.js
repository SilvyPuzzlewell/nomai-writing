/**
 * Test for spiral intersection detection.
 * Run with: node test/spiral-intersection-test.js
 */

// Exercise the shipped layout engine; the verification sampler is independent.
const { loadFrontend } = require('./frontend-test-helpers');
const geometry = loadFrontend();
let layoutSeed = 1;
geometry.Math = Object.create(Math);
geometry.Math.random = () => {
    layoutSeed = (Math.imul(layoutSeed, 1664525) + 1013904223) >>> 0;
    return layoutSeed / 4294967296;
};
const { sampleBezierCurve, segmentsIntersect } = geometry;
const { TreeLayoutEngine } = geometry.window;

// Verification function to find any remaining intersections
// Uses sampled Bezier curves to match actual rendered paths
function findIntersections(layoutNodes) {
    const intersections = [];
    const spirals = layoutNodes.filter(n => n.spiralData);
    const samplesPerSegment = 4;

    for (let i = 0; i < spirals.length; i++) {
        for (let j = i + 1; j < spirals.length; j++) {
            // Sample the Bezier curves for accurate intersection detection
            const sampledA = sampleBezierCurve(spirals[i].spiralData.points, samplesPerSegment);
            const sampledB = sampleBezierCurve(spirals[j].spiralData.points, samplesPerSegment);

            const isParentChild = spirals[j].parent_id === spirals[i].id ||
                                  spirals[i].parent_id === spirals[j].id;

            const skipSegments = 5 * samplesPerSegment; // Adjust for sampled density
            for (let a = skipSegments; a < sampledA.length - 1; a++) {
                for (let b = skipSegments; b < sampledB.length - 1; b++) {
                    if (segmentsIntersect(
                        sampledA[a].x, sampledA[a].y,
                        sampledA[a + 1].x, sampledA[a + 1].y,
                        sampledB[b].x, sampledB[b].y,
                        sampledB[b + 1].x, sampledB[b + 1].y
                    )) {
                        intersections.push({
                            spiral1: { id: spirals[i].id, segment: Math.floor(a / samplesPerSegment) },
                            spiral2: { id: spirals[j].id, segment: Math.floor(b / samplesPerSegment) },
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

/**
 * Check for pixel coincidences between non-parent-child spirals.
 * This catches visual overlaps that segment intersection might miss.
 * Skips first few points of each spiral (start/branch area).
 */
function checkPixelCoincidence(layoutNodes, samplesPerSegment = 20, skipPoints = 5) {
    const spirals = layoutNodes.filter(n => n.spiralData);

    // Build nodeId -> index map
    const nodeIdToIndex = new Map();
    spirals.forEach((s, idx) => nodeIdToIndex.set(s.id, idx));

    // Map: "x,y" -> array of spiral indices
    const pixelMap = new Map();

    spirals.forEach((spiral, spiralIndex) => {
        const sampledPoints = sampleBezierCurve(spiral.spiralData.points, samplesPerSegment);

        // Skip first few points (start/branch area) to allow root/branch overlap
        sampledPoints.slice(skipPoints * samplesPerSegment).forEach(point => {
            const px = Math.round(point.x);
            const py = Math.round(point.y);
            const key = `${px},${py}`;

            if (!pixelMap.has(key)) {
                pixelMap.set(key, []);
            }
            const owners = pixelMap.get(key);
            if (!owners.includes(spiralIndex)) {
                owners.push(spiralIndex);
            }
        });
    });

    // Check for unexpected coincidences
    const unexpected = [];
    pixelMap.forEach((owners, key) => {
        if (owners.length > 1) {
            for (let i = 0; i < owners.length; i++) {
                for (let j = i + 1; j < owners.length; j++) {
                    const s1 = spirals[owners[i]];
                    const s2 = spirals[owners[j]];
                    // Check parent-child relationship
                    const isParentChild = s2.parent_id === s1.id || s1.parent_id === s2.id;
                    if (!isParentChild) {
                        unexpected.push({
                            pixel: key,
                            spiral1: s1.id,
                            spiral2: s2.id
                        });
                    }
                }
            }
        }
    });

    return unexpected;
}

// Run tests
console.log("Spiral Intersection Tests\n" + "=".repeat(50) + "\n");

const engine = new TreeLayoutEngine(800, 600);
let totalIntersections = 0;
let failedTests = 0;

// Track failed layouts for JSON export
const failedLayouts = [];

for (const testCase of testCases) {
    const layout = engine.layoutTree(testCase.messages);
    const intersections = findIntersections(layout);
    const pixelOverlaps = checkPixelCoincidence(layout);

    const hasIntersections = intersections.length > 0;
    const hasPixelOverlaps = pixelOverlaps.length > 0;
    const status = (!hasIntersections && !hasPixelOverlaps) ? "✓ PASS" : "✗ FAIL";

    console.log(`${status}: ${testCase.name}`);
    console.log(`   Messages: ${testCase.messages.length}, Intersections: ${intersections.length}, Pixel overlaps: ${pixelOverlaps.length}`);

    if (hasIntersections) {
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

    if (hasPixelOverlaps && !hasIntersections) {
        failedTests++;
        console.log(`   Pixel overlaps (non-parent-child):`);
        const uniquePairs = new Set();
        for (const overlap of pixelOverlaps) {
            const pairKey = `${Math.min(overlap.spiral1, overlap.spiral2)}-${Math.max(overlap.spiral1, overlap.spiral2)}`;
            if (!uniquePairs.has(pairKey)) {
                uniquePairs.add(pairKey);
                console.log(`   - Spirals ${overlap.spiral1} and ${overlap.spiral2} overlap at ${overlap.pixel}`);
            }
            if (uniquePairs.size >= 5) break;
        }
        if (uniquePairs.size < pixelOverlaps.length) {
            console.log(`   ... and more overlapping pixels`);
        }
    }
    console.log();
}

console.log("=".repeat(50));
console.log(`Total: ${testCases.length - failedTests}/${testCases.length} passed`);
console.log(`Total intersections found: ${totalIntersections}`);

// =============================================================================
// Randomized stress test with complex branching tree (~30 nodes)
// =============================================================================

console.log("\n" + "=".repeat(50));
console.log("Randomized Stress Test: Complex Branching Trees");
console.log("=".repeat(50) + "\n");

/**
 * Generate a complex tree with ~n nodes and multiple branch points.
 * @param {number} n - Approximate number of nodes
 * @param {number} seed - Random seed for reproducibility
 */
function generateComplexTree(n, seed) {
    const messages = [];
    let nextId = 1;

    // Seeded random for reproducibility
    function random() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    }

    // Create root
    messages.push({ id: nextId++, parent_id: null });

    // Track nodes that can have children (not too deep)
    const availableParents = [1];
    const nodeDepths = new Map([[1, 0]]);
    const maxDepth = 8;

    while (messages.length < n && availableParents.length > 0) {
        // Pick a random parent from available nodes
        const parentIdx = Math.floor(random() * availableParents.length);
        const parentId = availableParents[parentIdx];
        const parentDepth = nodeDepths.get(parentId);

        // Create 1-3 children for this parent
        const numChildren = 1 + Math.floor(random() * 3);

        for (let i = 0; i < numChildren && messages.length < n; i++) {
            const childId = nextId++;
            messages.push({ id: childId, parent_id: parentId });

            const childDepth = parentDepth + 1;
            nodeDepths.set(childId, childDepth);

            // Add to available parents if not too deep
            if (childDepth < maxDepth) {
                availableParents.push(childId);
            }
        }

        // Remove parent if it has enough children or randomly
        if (random() > 0.3) {
            availableParents.splice(parentIdx, 1);
        }
    }

    return messages;
}

/**
 * Extract layout data for JSON export.
 */
function extractLayoutData(layout, messages) {
    return {
        messages: messages,
        spirals: layout
            .filter(n => n.spiralData)
            .map(n => ({
                id: n.id,
                parent_id: n.parent_id,
                points: n.spiralData.points.map(p => ({ x: p.x, y: p.y })),
                startX: n.spiralData.startX,
                startY: n.spiralData.startY,
                endX: n.spiralData.endX,
                endY: n.spiralData.endY
            }))
    };
}

const numRandomTests = 10;
const nodesPerTest = 25;
let randomTestsPassed = 0;
let randomTestsFailed = 0;
const allTestLayouts = [];

// Use larger canvas for stress tests
const stressEngine = new TreeLayoutEngine(1200, 900);

// Track statistics
let totalCollisions = 0;
let totalNodes = 0;

for (let testNum = 0; testNum < numRandomTests; testNum++) {
    const seed = 12345 + testNum * 9999;
    const messages = generateComplexTree(nodesPerTest, seed);

    layoutSeed = seed;
    const layout = stressEngine.layoutTree(messages);
    const intersections = findIntersections(layout);
    const pixelOverlaps = checkPixelCoincidence(layout);

    const hasIntersections = intersections.length > 0;
    const hasPixelOverlaps = pixelOverlaps.length > 0;
    const collisionCount = intersections.length + pixelOverlaps.length;
    const passed = !hasIntersections && !hasPixelOverlaps;

    totalCollisions += collisionCount;
    totalNodes += messages.length;

    const status = passed ? "✓ PASS" : "✗ FAIL";
    console.log(`${status}: Random tree #${testNum + 1} (seed=${seed})`);
    console.log(`   Nodes: ${messages.length}, Intersections: ${intersections.length}, Pixel overlaps: ${pixelOverlaps.length}`);

    // Save layout data
    const layoutData = extractLayoutData(layout, messages);
    layoutData.seed = seed;
    layoutData.testNum = testNum + 1;
    layoutData.passed = passed;
    layoutData.intersections = intersections.length;
    layoutData.pixelOverlaps = pixelOverlaps.length;
    allTestLayouts.push(layoutData);

    if (passed) {
        randomTestsPassed++;
    } else {
        randomTestsFailed++;
        failedTests++;

        if (hasIntersections) {
            for (const inter of intersections.slice(0, 3)) {
                console.log(`   - Spiral ${inter.spiral1.id} intersects ${inter.spiral2.id}`);
            }
        }
        if (hasPixelOverlaps) {
            const uniquePairs = new Set();
            for (const overlap of pixelOverlaps.slice(0, 3)) {
                const pairKey = `${Math.min(overlap.spiral1, overlap.spiral2)}-${Math.max(overlap.spiral1, overlap.spiral2)}`;
                if (!uniquePairs.has(pairKey)) {
                    uniquePairs.add(pairKey);
                    console.log(`   - Pixel overlap: ${overlap.spiral1} & ${overlap.spiral2} at ${overlap.pixel}`);
                }
            }
        }
    }
}

console.log("\n" + "-".repeat(50));
console.log(`Random tests: ${randomTestsPassed}/${numRandomTests} passed (0 collisions)`);
console.log(`Detected intersections/pixel coincidences: ${totalCollisions} in ${totalNodes} nodes`);

// Save all test layouts to JSON
const fs = require('fs');
const outputDir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'nomai-stress-'));
const outputPath = require('path').join(outputDir, 'test-layouts.json');
fs.writeFileSync(outputPath, JSON.stringify(allTestLayouts, null, 2));
console.log(`\nSaved ${allTestLayouts.length} test layouts to ${outputPath}`);

// Also save just the failed layouts if any
if (randomTestsFailed > 0) {
    const failedPath = require('path').join(outputDir, 'failed-layouts.json');
    const failed = allTestLayouts.filter(l => !l.passed);
    fs.writeFileSync(failedPath, JSON.stringify(failed, null, 2));
    console.log(`Saved ${failed.length} failed layouts to ${failedPath}`);
}

console.log("\n" + "=".repeat(50));
console.log(`FINAL: ${testCases.length + numRandomTests - failedTests}/${testCases.length + numRandomTests} total passed`);
console.log("=".repeat(50));

process.exit(failedTests > 0 ? 1 : 0);
