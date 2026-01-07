/**
 * Unit tests for spiral intersection detection.
 * Run with: node test/intersection-unit-test.js
 */

// Segment intersection function (same as in spiral.js)
function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const ccw = (px, py, qx, qy, rx, ry) =>
        (ry - py) * (qx - px) > (qy - py) * (rx - px);
    return ccw(ax1, ay1, bx1, by1, bx2, by2) !== ccw(ax2, ay2, bx1, by1, bx2, by2) &&
           ccw(ax1, ay1, ax2, ay2, bx1, by1) !== ccw(ax1, ay1, ax2, ay2, bx2, by2);
}

// Check spiral intersection (same as in spiral.js)
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

// Test runner
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${e.message}`);
        failed++;
    }
}

function assertEqual(actual, expected, msg = '') {
    if (actual !== expected) {
        throw new Error(`${msg} Expected ${expected}, got ${actual}`);
    }
}

// =============================================================================
// segmentsIntersect tests
// =============================================================================

console.log('\n--- segmentsIntersect tests ---\n');

test('crossing segments should intersect', () => {
    // X shape: (0,0)-(10,10) crosses (0,10)-(10,0)
    const result = segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0);
    assertEqual(result, true);
});

test('parallel horizontal segments should not intersect', () => {
    // Two horizontal lines at different Y
    const result = segmentsIntersect(0, 0, 10, 0, 0, 5, 10, 5);
    assertEqual(result, false);
});

test('parallel vertical segments should not intersect', () => {
    // Two vertical lines at different X
    const result = segmentsIntersect(0, 0, 0, 10, 5, 0, 5, 10);
    assertEqual(result, false);
});

test('collinear non-overlapping segments should not intersect', () => {
    // Same line but not overlapping
    const result = segmentsIntersect(0, 0, 5, 0, 10, 0, 15, 0);
    assertEqual(result, false);
});

test('T-junction should intersect', () => {
    // Horizontal (0,5)-(10,5) and vertical (5,0)-(5,10)
    const result = segmentsIntersect(0, 5, 10, 5, 5, 0, 5, 10);
    assertEqual(result, true);
});

test('L-shape (touching at endpoint) detects as intersection', () => {
    // (0,0)-(5,0) and (5,0)-(5,5) - touch at (5,0)
    // CCW algorithm detects this as intersection (conservative for our use case)
    const result = segmentsIntersect(0, 0, 5, 0, 5, 0, 5, 5);
    assertEqual(result, true);
});

test('segments far apart should not intersect', () => {
    const result = segmentsIntersect(0, 0, 10, 10, 100, 100, 110, 110);
    assertEqual(result, false);
});

test('diagonal crossing should intersect', () => {
    // (0,0)-(100,50) crosses (50,0)-(50,100)
    const result = segmentsIntersect(0, 0, 100, 50, 50, 0, 50, 100);
    assertEqual(result, true);
});

test('nearly parallel segments should not intersect', () => {
    const result = segmentsIntersect(0, 0, 100, 1, 0, 10, 100, 11);
    assertEqual(result, false);
});

// =============================================================================
// checkSpiralIntersection tests
// =============================================================================

console.log('\n--- checkSpiralIntersection tests ---\n');

// Helper to create a simple polyline as "spiral points"
function makeLine(x1, y1, x2, y2, numPoints = 20) {
    const points = [];
    for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        points.push({
            x: x1 + (x2 - x1) * t,
            y: y1 + (y2 - y1) * t
        });
    }
    return points;
}

test('two crossing lines should detect intersection', () => {
    const line1 = makeLine(0, 0, 100, 100);
    const line2 = makeLine(0, 100, 100, 0);
    const result = checkSpiralIntersection(line1, [{ points: line2 }], 0);
    assertEqual(result, true);
});

test('two parallel lines should not intersect', () => {
    const line1 = makeLine(0, 0, 100, 0);
    const line2 = makeLine(0, 20, 100, 20);
    const result = checkSpiralIntersection(line1, [{ points: line2 }], 0);
    assertEqual(result, false);
});

test('skipSegments should ignore early segments', () => {
    // Lines that cross near the start
    const line1 = makeLine(0, 0, 100, 100, 10);
    const line2 = makeLine(0, 10, 10, 0, 10);  // Crosses line1 near start

    // With skipSegments=0, should detect
    const result1 = checkSpiralIntersection(line1, [{ points: line2 }], 0);
    assertEqual(result1, true, 'skip=0: ');

    // With skipSegments=5, should not detect (crossing is in first few segments)
    const result2 = checkSpiralIntersection(line1, [{ points: line2 }], 5);
    assertEqual(result2, false, 'skip=5: ');
});

test('empty existing spirals should return false', () => {
    const line1 = makeLine(0, 0, 100, 100);
    const result = checkSpiralIntersection(line1, [], 0);
    assertEqual(result, false);
});

test('spiral with null points should be skipped', () => {
    const line1 = makeLine(0, 0, 100, 100);
    const result = checkSpiralIntersection(line1, [{ points: null }, {}], 0);
    assertEqual(result, false);
});

test('multiple spirals - detect intersection with any', () => {
    const newLine = makeLine(50, 0, 50, 100);  // Vertical line at x=50
    const spiral1 = { points: makeLine(0, 0, 40, 0) };  // Horizontal, doesn't cross
    const spiral2 = { points: makeLine(0, 50, 100, 50) };  // Horizontal at y=50, crosses

    const result = checkSpiralIntersection(newLine, [spiral1, spiral2], 0);
    assertEqual(result, true);
});

test('multiple spirals - no intersection', () => {
    const newLine = makeLine(50, 0, 50, 100);  // Vertical at x=50
    const spiral1 = { points: makeLine(0, 0, 40, 0) };  // Left of x=50
    const spiral2 = { points: makeLine(60, 0, 100, 0) };  // Right of x=50

    const result = checkSpiralIntersection(newLine, [spiral1, spiral2], 0);
    assertEqual(result, false);
});

// =============================================================================
// Edge cases with spiral-like curves
// =============================================================================

console.log('\n--- Spiral curve edge cases ---\n');

// Helper to create an arc (simplified spiral)
function makeArc(cx, cy, radius, startAngle, endAngle, numPoints = 30) {
    const points = [];
    for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        const angle = startAngle + (endAngle - startAngle) * t;
        points.push({
            x: cx + radius * Math.cos(angle),
            y: cy + radius * Math.sin(angle)
        });
    }
    return points;
}

test('two arcs curving away should not intersect', () => {
    // Arc curving up-right
    const arc1 = makeArc(0, 0, 50, 0, Math.PI / 2);
    // Arc curving down-right (different center)
    const arc2 = makeArc(100, 0, 50, Math.PI, Math.PI * 1.5);

    const result = checkSpiralIntersection(arc1, [{ points: arc2 }], 0);
    assertEqual(result, false);
});

test('two arcs crossing should intersect', () => {
    // Two circles that cross
    const arc1 = makeArc(0, 0, 50, 0, Math.PI * 2);
    const arc2 = makeArc(40, 0, 50, 0, Math.PI * 2);

    const result = checkSpiralIntersection(arc1, [{ points: arc2 }], 0);
    assertEqual(result, true);
});

test('concentric arcs should not intersect', () => {
    const arc1 = makeArc(0, 0, 30, 0, Math.PI);
    const arc2 = makeArc(0, 0, 50, 0, Math.PI);

    const result = checkSpiralIntersection(arc1, [{ points: arc2 }], 0);
    assertEqual(result, false);
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
