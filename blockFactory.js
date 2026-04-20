import Matter from 'matter-js';

const { Bodies, Body } = Matter;

/**
 * Creates a Matter.js body for a specific Numberblock.
 * Now creates a composite body made of unit squares.
 */
export function createNumberBlock(x, y, number, unitSize, arrangement = 'auto', customUnits = null) {
    let cols = 1;
    let rows = 1;
    let baseColor = 'white';

    const colorMap = {
        1: '#ff0000',
        2: '#ff8800',
        3: '#ffff00',
        4: '#00bb00',
        5: '#00ffff',
        6: '#8800ff',
        7: '#d6b4fc', // flipped: move 7 to purple (rainbow still supported in renderer)
        8: '#ff00ff',
        9: '#888888', // greyscale for 9
        10: '#bdbdbd', // light grey instead of white
        404: '#ffffff' // default white for 404 (not forced blue)
    };

    const isRoot = typeof number === 'string' && number.startsWith('√');
    const rootVal = isRoot ? Math.sqrt(parseFloat(number.substring(1))) : null;
    const isLetter = typeof number === 'string' && /^[A-Za-z]$/.test(number);
    
    let numericValue = isRoot ? rootVal : (isLetter ? 1 : parseFloat(number));
    
    // Safety check for non-numeric strings like "extended 3"
    if (isNaN(numericValue) && typeof number === 'string') {
        const matches = number.match(/\d+/);
        if (matches) numericValue = parseFloat(matches[0]);
        else numericValue = 1; // Default to 1 instead of NaN
    }

    if (number === 'ππ' || number === 'PI') numericValue = Math.PI * (number === 'ππ' ? 2 : 1);
    if (number === 'πππ') numericValue = Math.PI * 3;
    if (number === 'DOG') numericValue = 3;
    if (number === '2D') numericValue = 2;
    if (number === 'Base 100') numericValue = 1011;

    // If the token is a very long string made of repeated "a" characters, treat it as a 4-block
    if (typeof number === 'string' && /^a{10,}$/i.test(number)) {
        numericValue = 4;
    }

    if (typeof number === 'string' && number.startsWith('Base ')) {
        const baseVal = parseInt(number.split(' ')[1]);
        numericValue = isNaN(baseVal) ? 1 : baseVal;
    }
    if (['AB', 'ABB', 'DUCK', 'CAT', 'CAN'].includes(number)) {
        numericValue = number.length;
    }
    if (number === '¶' || number === '§' || number === 'ⁿ') numericValue = 1;
    if (number === '∆') numericValue = 3;
    if (number === '⁰' || number === '∅') numericValue = 0;

    // Special display tag: treat "1 decillion" as a single block (numeric value 1)
    // but present its number tag as 10^33 for display/identity purposes.
    let displayTag = null;
    if (typeof number === 'string' && number.toLowerCase() === '1 decillion') {
        numericValue = 1;
        displayTag = '10^33';
        // Visual tweak: make the 10^33 / "1 decillion" block navy blue for clear identification
        baseColor = '#001f3f'; // navy
    }

    // Special: gold one should behave as a normal "1" but render gold
    if (typeof number === 'string' && number.toLowerCase() === 'gold 1') {
        numericValue = 1;
        baseColor = '#FFD700';
    }

    const letterColors = {
        'A': '#FF5252', 'B': '#FF4081', 'C': '#E040FB', 'D': '#7C4DFF',
        'E': '#536DFE', 'F': '#448AFF', 'G': '#40C4FF', 'H': '#18FFFF',
        'I': '#64FFDA', 'J': '#69F0AE', 'K': '#B2FF59', 'L': '#EEFF41',
        'M': '#FFFF00', 'N': '#FFD740', 'O': '#FFAB40', 'P': '#FF6E40',
        'Q': '#D7CCC8', 'R': '#F5F5F5', 'S': '#CFD8DC', 'T': '#FFCDD2',
        'U': '#F8BBD0', 'V': '#E1BEE7', 'W': '#D1C4E9', 'X': '#C5CAE9',
        'Y': '#BBDEFB', 'Z': '#B3E5FC',
        // Ꙗ mixes A (#FF5252) and I (#64FFDA)
        'Ꙗ': '#B2A996'
    };

    const symbolColors = {
        '¶': '#E91E63', '§': '#FFEB3B', '∆': '#2196F3', 'ⁿ': '#9C27B0', '⁰': '#ffffff', '∅': '#F44336'
    };

    if (number === 'pi' || number === 'PI' || number === 'Ω' || number === 'ππ' || number === 'πππ') {
        baseColor = '#7FFF00';
    } else if (symbolColors[number]) {
        baseColor = symbolColors[number];
    } else if (number === 'DOG') {
        baseColor = '#8B4513';
    } else if (number === 'tan') {
        baseColor = '#8A2BE2'; 
    } else if (number === 'infinity' || number === 'inf1' || number === 'μ' || number === 'Π') {
        baseColor = '#808080';
    } else if (isLetter) {
        // Support lowercase letters by normalizing to uppercase for color lookup
        const letterKey = typeof number === 'string' ? number.toUpperCase() : number;
        baseColor = letterColors[letterKey] || '#ffffff';
    } else if (typeof numericValue === 'number' && numericValue < 0) {
        // Special-case: -3 should appear as pure blue (#0000ff), -2 is bright-blue, others get cyan
        const negFloor = Math.floor(numericValue);
        if (negFloor === -3) {
            baseColor = '#0000ff'; // pure blue for -3
        } else if (negFloor === -2) {
            baseColor = '#007bff'; // bright blue for -2
        } else {
            baseColor = '#00ffff';
        }
    } else {
        baseColor = colorMap[Math.floor(numericValue)] || '#ffffff';
    }

    // Normalize near-1 floating imprecision (e.g., 0.999) to exact 1 so small fractional rounding doesn't prevent expected merges/behaviour.
    if (typeof numericValue === 'number' && Math.abs(numericValue - 1) < 0.0005) {
        numericValue = 1;
    }
    const tensValue = Math.floor(numericValue / 10) * 10;

    // Force rainbow styling for any block whose integer value is 7 (e.g., 7, 7.0).
    const forceRainbowSeven = (typeof numericValue === 'number' && Math.floor(numericValue) === 7);
    const onesValue = numericValue % 10;

    const tensConfig = {
        10: { fill: '#ffffff', outline: '#ff0000' },
        20: { fill: '#FBCEB1', outline: '#ff8800' },
        30: { fill: '#FFFFE0', outline: '#ffff00' },
        40: { fill: '#90EE90', outline: '#00bb00' },
        50: { fill: '#ADD8E6', outline: '#0000ff' },
        60: { fill: '#CBC3E3', outline: '#8800ff' },
        70: { fill: '#D8BFD8', outline: '#ee82ee' },
        80: { fill: '#FFB6C1', outline: '#ff1493' },
        90: { fill: '#d3d3d3', outline: '#888888' },
        100: { fill: '#ffffff', outline: '#ff0000' }
    };

    const isFraction = numericValue % 1 !== 0;
    const intPart = Math.floor(numericValue);
    let unitsData = [];

    if (customUnits) {
        // Sort units to ensure color mapping is consistent.
        // We sort Y descending (bottom-to-top) so that "ones" units (highest indices) 
        // appear at the top of the stack for compound numbers like 11, 12, etc.
        customUnits.sort((a, b) => (b.localY - a.localY) || (a.localX - b.localX));
        unitsData = customUnits.map(u => ({
            lx: u.localX,
            ly: u.localY,
            isHalf: u.isHalf,
            isQuarter: u.isQuarter,
            isThreeQuarters: u.isThreeQuarters,
            color: u.color,
            outlineColor: u.outlineColor,
            r: 0, c: 0, cols: 1, rows: 1 
        }));
    } else if (arrangement === 'auto') {
        const autoLayouts = {
            4: [2, 2], 6: [3, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2],
            12: [4, 3], 14: [7, 2], 15: [5, 3], 16: [4, 4], 18: [6, 3],
            20: [5, 4], 21: [7, 3], 24: [8, 3], 25: [5, 5], 27: [9, 3],
            28: [7, 4], 30: [6, 5], 32: [8, 4], 33: [11, 3], 35: [7, 5], 36: [6, 6],
            39: [13, 3],
            40: [10, 4], 42: [7, 6], 45: [9, 5], 48: [8, 6], 49: [7, 7],
            50: [10, 5],
            51: [17, 3],
            54: [9, 6],
            55: [11, 5],
            56: [8, 7], 60: [10, 6], 63: [9, 7],
            64: [8, 8], 70: [10, 7], 72: [9, 8], 80: [10, 8], 81: [9, 9],
            90: [10, 9], 100: [10, 10],
            // Explicit perfect-square layouts
            121: [11, 11],
            144: [12, 12],
            169: [13, 13],
            196: [14, 14],
            225: [15, 15],
            256: [16, 16],
            289: [17, 17],
            324: [18, 18],
            361: [19, 19],
            400: [20, 20],
            441: [21, 21],
            484: [22, 22],
            529: [23, 23],
            576: [24, 24],
            625: [25, 25],
            676: [26, 26],
            729: [27, 27],
            784: [28, 28],
            841: [29, 29],
            900: [30, 30],
            961: [31, 31],
            1024: [32, 32],
            // Large explicit layout for 10000: 100 rows x 100 columns (100x100 block)
            10000: [100, 100], // 10000 -> 100 cols x 100 rows (100x100)
            100000: [20, 20], // 100000 -> 20 cols x 20 rows (20x20) to match requested large-size spawn
            1000000: [100, 100], // 1000000 -> represented as a giant 100x100 sprite (special non-mergeable)
            // Explicit 5000 layout: 50 rows x 10 columns (10x50 block)
            5000: [50, 10], // 5000 -> 10 cols x 50 rows (10x50)
            // Explicit 9000 layout per request: 30 cols x 30 rows (30x30)
            9000: [30, 30],
            // Add explicit 1089 layout: 33 cols x 33 rows (33x33 square)
            1089: [33, 33],
            // Make thousands 3000/4000/6000/7000/8000 use 10 columns × N rows (rows = 30,40,60,70,80 respectively)
            3000: [30, 10],
            4000: [40, 10],
            6000: [60, 10],
            7000: [70, 10],
            8000: [80, 10],
            // Explicit 69 layout: 23 rows x 3 columns (3x23 form)
            69: [23, 3],
            // Explicit 34 layout to make 34 appear as a 5x6 base with a 4-unit cap
            34: [5, 6],
            // Explicit 108 layout: 12 rows x 9 columns
            108: [12, 9],
            // User-requested 11 x n appearances:
            44: [11, 4],
            66: [11, 6],
            67: [4, 17],
            68: [17, 4],
            77: [11, 7],
            88: [11, 8],
            99: [11, 9]
        };

        if (numericValue === 1000 || number === 'infinity') {
            cols = 10; rows = 10;
        } else if (numericValue === 2.25) {
            // Special: represent 2.25 as a single 1.5x1.5 block
            cols = 1; rows = 1;
            unitsData.push({
                r: 0, c: 0, cols: 1, rows: 1,
                isHalf: false, isQuarter: false, isThreeQuarters: false,
                isEighth: false, isNearlyFull: false,
                isOnePointFive: true
            });
        } else if (numericValue === 2000) {
            // Explicit layout for 2000 requested: 10 columns x 20 rows and orange base color
            cols = 10; rows = 20;
            baseColor = '#ff8800';
        } else if (numericValue === 400) {
            // Explicit layout for 400: render as a 20x20 block
            cols = 20; rows = 20;
            // keep baseColor as determined earlier (no override)
        } else if (numericValue === 10000) {
            // New: 10000 is a 20x50 block and should be white
            cols = 20; rows = 50;
            baseColor = '#ffffff';
        } else if (number === 'inf1') {
            cols = 1; rows = 1;
        } else if (number === 'μ') {
            cols = 1; rows = 2;
        } else if (number === '3D') {
            // Render "3D" as a 1x3x3 stacked block: 1 column, 3 rows, 3 layers (depth), producing a tall 3-high column with 3 layered slices.
            const layers = 3;
            const baseRows = 3;
            const baseCols = 1; // single column
            cols = baseCols;
            rows = baseRows;
            baseColor = '#d9e6ff';
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        } else if (numericValue === 27) {
            // 27 rendered as a 3x3 "cube" - three stacked 3x3 layers with slight parallax to suggest depth
            const layers = 3;
            const baseRows = 3;
            const baseCols = 3;
            cols = baseCols;
            rows = baseRows;
            // For layering we'll add a 'layer' property to unit descriptors and let later position calc account for it.
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        } else if (numericValue === 125) {
            // 125 rendered as a 5x5 "cube" - five stacked 5x5 layers to represent 5^3 visually
            const layers = 5;
            const baseRows = 5;
            const baseCols = 5;
            cols = baseCols;
            rows = baseRows;
            // Create layered unit descriptors with a layer index for slight parallax in rendering
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        } else if (numericValue === 216) {
            // 216 rendered as a 6x6x6 cube (six stacked 6x6 layers to represent 6^3 visually)
            const layers = 6;
            const baseRows = 6;
            const baseCols = 6;
            cols = baseCols;
            rows = baseRows;
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        } else if (numericValue === 343) {
            // 343 rendered as a 7x7x7 cube (seven stacked 7x7 layers to represent 7^3 visually)
            const layers = 7;
            const baseRows = 7;
            const baseCols = 7;
            cols = baseCols;
            rows = baseRows;
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        } else if (numericValue === 512) {
            // 512 rendered as an 8x8x8 cube (eight stacked 8x8 layers to represent 8^3 visually)
            const layers = 8;
            const baseRows = 8;
            const baseCols = 8;
            cols = baseCols;
            rows = baseRows;
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        // 729: prefer a 9x9x9 layered cube representation (9 layers of 9x9) while a 27x27 square still exists in autoLayouts as a fallback
        } else if (numericValue === 729) {
            // 729 rendered as a 9x9x9 cube (nine stacked 9x9 layers to represent 9^3 visually)
            const layers = 9;
            const baseRows = 9;
            const baseCols = 9;
            cols = baseCols;
            rows = baseRows;
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        } else if (numericValue === 1331) {
            // 1331 rendered as an 11x11x11 cube (eleven stacked 11x11 layers to represent 11^3 visually)
            const layers = 11;
            const baseRows = 11;
            const baseCols = 11;
            cols = baseCols;
            rows = baseRows;
            // Create layered unit descriptors with a layer index for slight parallax in rendering
            for (let l = 0; l < layers; l++) {
                for (let r = 0; r < baseRows; r++) {
                    for (let c = 0; c < baseCols; c++) {
                        unitsData.push({
                            r, c, cols: baseCols, rows: baseRows,
                            layer: l,
                            isHalf: false, isQuarter: false, isThreeQuarters: false,
                            isEighth: false, isNearlyFull: false
                        });
                    }
                }
            }
        } else if (numericValue === 31) {
            // Calendar layout: 7 columns, 5 rows for dates only (no weekday header), show exactly 31 date cells
            cols = 7;
            rows = 5; // rows 0-4 = date grid (5 weeks)
            // Create grid rows and fill only 31 date cells; stop once we've placed 31 cells.
            let dateCount = 0;
            const totalDates = 31;
            outerLoop:
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    if (dateCount >= totalDates) break outerLoop;
                    unitsData.push({
                        r, c, cols, rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                    dateCount++;
                }
            }
        } else if (numericValue === 29) {
            // Special layout for 29: render a 10-row x 2-column base (20 units) plus a tall 9-unit column on the right.
            const baseRows = 10;
            const baseCols = 2; // 10x2 = 20
            cols = baseCols + 1; // add extra column on right for the 9 overflow units
            rows = baseRows;
            // Fill the main 10x2 base from bottom to top (20 units)
            for (let r = baseRows - 1; r >= 0; r--) {
                for (let c = 0; c < baseCols; c++) {
                    if (unitsData.length >= 20) break;
                    unitsData.push({
                        r, c, cols, rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                }
            }
            // Add 9 units in the rightmost column (column index = baseCols)
            const overflowCount29 = 9;
            for (let k = 0; k < overflowCount29; k++) {
                // place starting from the bottom (largest r) upwards
                const r = baseRows - 1 - k;
                unitsData.push({
                    r, c: baseCols, cols, rows,
                    isHalf: false, isQuarter: false, isThreeQuarters: false,
                    isEighth: false, isNearlyFull: false
                });
            }
        } else if (numericValue === 67) {
            // Special layout for 67: make a 10-row x 6-column base (60 units) plus a 7-unit rightmost column
            const baseRows = 10;
            const baseCols = 6; // 10x6 = 60
            cols = baseCols + 1; // add extra column on right for the 7 overflow units
            rows = baseRows;
            // Fill the main 10x6 base from bottom to top (60 units)
            for (let r = baseRows - 1; r >= 0; r--) {
                for (let c = 0; c < baseCols; c++) {
                    if (unitsData.length >= 60) break;
                    unitsData.push({
                        r, c, cols, rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                }
            }
            // Add 7 units in the rightmost column (column index = baseCols)
            const overflowCount67 = 7;
            for (let k = 0; k < overflowCount67; k++) {
                // place starting from the bottom (largest r) upwards
                const r = baseRows - 1 - k;
                unitsData.push({
                    r, c: baseCols, cols, rows,
                    isHalf: false, isQuarter: false, isThreeQuarters: false,
                    isEighth: false, isNearlyFull: false
                });
            }
        } else if (numericValue === 37) {
            // Special layout for 37: make a 10x3 base (30 units) and place the remaining 7 units
            // as a single rightmost column spanning from the bottom upwards.
            const baseRows = 10;
            const baseCols = 3; // 10x3 = 30
            cols = baseCols + 1; // add extra column on right for the 7 overflow units
            rows = baseRows;
            // Fill the main 10x3 base from bottom to top
            for (let r = baseRows - 1; r >= 0; r--) {
                for (let c = 0; c < baseCols; c++) {
                    if (unitsData.length >= 30) break;
                    unitsData.push({
                        r, c, cols, rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                }
            }
            // Add 7 units in the rightmost column (column index = baseCols)
            const overflowCount = 7;
            for (let k = 0; k < overflowCount; k++) {
                // place starting from the bottom (largest r) upwards
                const r = baseRows - 1 - k;
                unitsData.push({
                    r, c: baseCols, cols, rows,
                    isHalf: false, isQuarter: false, isThreeQuarters: false,
                    isEighth: false, isNearlyFull: false
                });
            }
        } else if (numericValue === 38) {
            // Special layout for 38: a 10x3 base (30 units) plus a tall 8-unit column on the right.
            // This produces a visual "10x3 with a tall 8-block on the right".
            const baseRows = 10;
            const baseCols = 3; // 10x3 = 30
            cols = baseCols + 1; // add extra column on right for the 8 overflow units
            rows = baseRows;
            // Fill the main 10x3 base from bottom to top
            for (let r = baseRows - 1; r >= 0; r--) {
                for (let c = 0; c < baseCols; c++) {
                    if (unitsData.length >= 30) break;
                    unitsData.push({
                        r, c, cols, rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                }
            }
            // Add 8 units in the rightmost column (column index = baseCols)
            const overflowCount38 = 8;
            for (let k = 0; k < overflowCount38; k++) {
                // place starting from the bottom (largest r) upwards
                const r = baseRows - 1 - k;
                unitsData.push({
                    r, c: baseCols, cols, rows,
                    isHalf: false, isQuarter: false, isThreeQuarters: false,
                    isEighth: false, isNearlyFull: false
                });
            }
        } else if (numericValue === 43) {
            // Special layout for 43: render a 10-row x 4-column base (40 units) plus a 3-unit rightmost column
            const baseRows = 10;
            const baseCols = 4; // 10x4 = 40
            cols = baseCols + 1; // add extra column on right for the 3 overflow units
            rows = baseRows;
            // Fill the main 10x4 base from bottom to top (40 units)
            for (let r = baseRows - 1; r >= 0; r--) {
                for (let c = 0; c < baseCols; c++) {
                    if (unitsData.length >= 40) break;
                    unitsData.push({
                        r, c, cols, rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                }
            }
            // Add 3 units in the rightmost column (column index = baseCols)
            const overflowCount43 = 3;
            for (let k = 0; k < overflowCount43; k++) {
                // place starting from the bottom (largest r) upwards
                const r = baseRows - 1 - k;
                unitsData.push({
                    r, c: baseCols, cols, rows,
                    isHalf: false, isQuarter: false, isThreeQuarters: false,
                    isEighth: false, isNearlyFull: false
                });
            }
        } else if (numericValue === 47) {
            // Special layout for 47: render a 10-row x 4-column base (40 units) plus a tall 7-unit rightmost column
            const baseRows = 10;
            const baseCols = 4; // 10x4 = 40
            cols = baseCols + 1; // add extra column on right for the 7 overflow units
            rows = baseRows;
            // Fill the main 10x4 base from bottom to top (40 units)
            for (let r = baseRows - 1; r >= 0; r--) {
                for (let c = 0; c < baseCols; c++) {
                    if (unitsData.length >= 40) break;
                    unitsData.push({
                        r, c, cols, rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                }
            }
            // Add 7 units in the rightmost column (column index = baseCols)
            const overflowCount47 = 7;
            for (let k = 0; k < overflowCount47; k++) {
                // place starting from the bottom (largest r) upwards
                const r = baseRows - 1 - k;
                unitsData.push({
                    r, c: baseCols, cols, rows,
                    isHalf: false, isQuarter: false, isThreeQuarters: false,
                    isEighth: false, isNearlyFull: false
                });
            }
        } else if (numericValue === 22) {
            // Special layout for 22: a 5x4 base (20 units) with a wide 2-unit row centered on top
            const baseRows = 5;
            const baseCols = 4;
            rows = baseRows + 1; // include the extra top row in total rows
            cols = baseCols;
            // fill base from bottom to top using rows 1..baseRows so row 0 can be the top 2-unit row
            for (let r = baseRows; r >= 1; r--) {
                if (unitsData.length >= 20) break;
                for (let c = 0; c < baseCols; c++) {
                    if (unitsData.length >= 20) break;
                    unitsData.push({
                        r, c, cols: baseCols, rows: rows,
                        isHalf: false, isQuarter: false, isThreeQuarters: false,
                        isEighth: false, isNearlyFull: false
                    });
                }
            }
            // Add top centered wide 2-unit row at row index 0 (directly above the base)
            const topRowIndex = 0;
            const topCols = 2;
            const startC = Math.floor((baseCols - topCols) / 2);
            for (let tc = 0; tc < topCols; tc++) {
                unitsData.push({
                    r: topRowIndex,
                    c: startC + tc,
                    cols: baseCols,
                    rows: rows,
                    isHalf: false, isQuarter: false, isThreeQuarters: false,
                    isEighth: false, isNearlyFull: false
                });
            }
        } else if (autoLayouts[numericValue]) {
            [rows, cols] = autoLayouts[numericValue];
        } else if (numericValue > 100) {
            cols = 10;
            rows = Math.ceil(numericValue / 10);
        } else if (numericValue > 10) {
            // Default for large odd/prime numbers or unspecified composite ones
            cols = 2;
            rows = Math.ceil(numericValue / 2);
        } else {
            rows = Math.ceil(numericValue);
            cols = 1;
        }
        // Fill from bottom to top so that "ones" (last units) are at the top
        for (let r = rows - 1; r >= 0; r--) {
            if (unitsData.length >= Math.ceil(numericValue)) break;
            for (let c = 0; c < cols; c++) {
                if (unitsData.length >= Math.ceil(numericValue)) break;
                // Fraction handling logic
                const isEighth = (numericValue === 0.125) && unitsData.length === 0;
                const isQuarter = (numericValue === 0.25) && unitsData.length === 0;
                const isThreeQuarters = (numericValue === 0.75) && unitsData.length === 0;
                const isNearlyFull = (numericValue === 0.975) && unitsData.length === 0;
                const isHalf = isFraction && !isEighth && !isQuarter && !isThreeQuarters && !isNearlyFull && unitsData.length === 0;
                
                unitsData.push({ 
                    r, c, cols, rows, 
                    isHalf, isQuarter, isThreeQuarters, 
                    isEighth, isNearlyFull 
                });
            }
        }

        // Special handling for 34: arrange as a 5x6 base (30 units) with a 4-unit row centered on top to total 34.
        if (Math.floor(numericValue) === 34) {
            // Shift existing base row indices down by 1 so we have a free top row (adjust centering)
            for (let u of unitsData) {
                u.r = u.r + 1;
                u.rows = rows + 1;
            }
            // Add a single top row of 4 units centered across the columns
            const topCols = 4;
            const startC = Math.floor((cols - topCols) / 2);
            for (let tc = 0; tc < topCols; tc++) {
                const c = startC + tc;
                unitsData.push({
                    r: 0,
                    c: c,
                    cols: cols,
                    rows: rows + 1,
                    isHalf: false,
                    isQuarter: false,
                    isThreeQuarters: false,
                    isEighth: false,
                    isNearlyFull: false
                });
            }
        }
    } else if (arrangement === 'tall') {
        rows = Math.ceil(numericValue); cols = 1;
        for (let r = 0; r < rows; r++) {
            unitsData.push({ r, c: 0, cols, rows, isHalf: isFraction && r === 0 });
        }
    } else if (arrangement === 'wide') {
        rows = 1; cols = Math.ceil(numericValue);
        for (let c = 0; c < cols; c++) unitsData.push({ r: 0, c, cols, rows, isHalf: isFraction && c === cols - 1 });
    } else if (arrangement === 'most-rect') {
        // "Most Rectangular" -- aim for a strongly rectangular packing where width >> height.
        // Strategy: bias column count toward a wider layout by scaling the sqrt heuristic.
        // This produces compact, low-height rectangles useful for visually rectangular shapes.
        const targetBias = 1.6; // >1 => wider than square, tweakable
        const totalUnits = Math.ceil(numericValue);
        // compute an initial guess for cols (biased sqrt)
        let guessedCols = Math.max(1, Math.round(Math.sqrt(totalUnits) * targetBias));
        // clamp to sensible bounds
        guessedCols = Math.min(Math.max(guessedCols, 1), Math.max(1, Math.ceil(totalUnits)));
        cols = guessedCols;
        rows = Math.ceil(totalUnits / cols);
        // Fill from bottom-to-top to keep ones at top, similar to auto
        for (let r = rows - 1; r >= 0; r--) {
            for (let c = 0; c < cols; c++) {
                if (unitsData.length >= totalUnits) break;
                const isEighth = (numericValue === 0.125) && unitsData.length === 0;
                const isQuarter = (numericValue === 0.25) && unitsData.length === 0;
                const isThreeQuarters = (numericValue === 0.75) && unitsData.length === 0;
                const isNearlyFull = (numericValue === 0.975) && unitsData.length === 0;
                const isHalf = isFraction && !isEighth && !isQuarter && !isThreeQuarters && !isNearlyFull && unitsData.length === 0;
                
                unitsData.push({ r, c, cols, rows, isHalf, isQuarter, isThreeQuarters, isEighth, isNearlyFull });
            }
        }
    } else if (arrangement === 'step') {
        let count = 0;
        let currentRow = 0;
        let currentCol = 0;
        let maxOnThisRow = 1;
        
        // Calculate bounds first for centering
        const tempUnits = [];
        while(count < Math.ceil(numericValue)) {
            tempUnits.push({ r: currentRow, c: currentCol, isHalf: isFraction && count === intPart });
            count++;
            currentCol++;
            if (currentCol >= maxOnThisRow) {
                currentCol = 0;
                currentRow++;
                maxOnThisRow++;
            }
        }
        const maxR = currentRow;
        const maxC = Math.max(...tempUnits.map(u => u.c));
        tempUnits.forEach(u => unitsData.push({ ...u, rows: maxR + 1, cols: maxC + 1 }));
    }

    // Special-case tokens that must be non-mergeable / unmergeable:
    // - plain "add" token
    // - the long corrupted token starting with 'a̷' (various user-provided variants)
    const LONG_CORRUPTED_PREFIX = 'a̷';
    const isExplicitAdd = (number === 'add' || String(number).toLowerCase() === 'add');
    const isLongCorrupted = (typeof number === 'string' && String(number).startsWith(LONG_CORRUPTED_PREFIX));
    const parts = [];
    const units = [];

    // If this token must be unmergeable, create a single simple physics part and ensure no unit descriptors
    // are provided to the renderer (renderData.units = []) so the merge code treats it as non-mergeable.
    if (isExplicitAdd || isLongCorrupted) {
        // create a single visual rectangle part so it exists in the world
        try {
            const spritePart = Bodies.rectangle(x, y, unitSize * 1.1, unitSize * 1.1, { chamfer: { radius: 6 } });
            parts.push(spritePart);
        } catch (e) {
            // fallback to a tiny sensor part if rectangle creation fails
            try { parts.push(Bodies.circle(x, y, unitSize * 0.5)); } catch (err) {}
        }
        // mark that this body should be treated as a non-mergeable sprite-like entity
        // (we will set renderData.units = [] later so merging logic naturally ignores it)
        // Also provide a distinct baseColor so it remains visually identifiable.
        baseColor = (isExplicitAdd) ? '#FFD700' : (isLongCorrupted ? '#ffe6f0' : baseColor);
    }

    function mixColors(color1, color2) {
        const parse = (c) => {
            if (c.startsWith('#')) {
                if (c.length === 4) return [parseInt(c[1]+c[1], 16), parseInt(c[2]+c[2], 16), parseInt(c[3]+c[3], 16)];
                return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
            }
            return [255, 255, 255];
        };
        const rgb1 = parse(color1);
        const rgb2 = parse(color2);
        const mixed = rgb1.map((v, i) => Math.floor((v + rgb2[i]) / 2));
        return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
    }

    const hundredThreshold = (typeof numericValue === 'number') ? Math.floor(Math.abs(numericValue) / 100) * 100 : 0;
    const currentTensValue = Math.floor((Math.floor(number) % 100) / 10) * 10;
    const currentOnesValue = Math.floor(number % 10);
    const seventyColors = ['#FFFFFF', '#FBCEB1', '#FFFFE0', '#90EE90', '#ADD8E6', '#CBC3E3', '#D8BFD8'];

    const hundredStyles = {
        2000: { fill1: '#ffd9b3', fill2: '#ffb3b3', outline: '#ff0000' },
        3000: { fill1: '#ffffb3', fill2: '#ffd9b3', outline: '#ff8800' },
        4000: { fill1: '#b3ffb3', fill2: '#ffffb3', outline: '#ffff00' },
        5000: { fill1: '#b3d9ff', fill2: '#b3ffb3', outline: '#00bb00' },
        10000: { fill1: '#ffffff', fill2: '#ffffff', outline: '#cccccc' }, // 10000: pure white style
        100: { fill1: '#ffb3b3', fill2: '#ff6666', outline: '#cc0000' },
        200: { fill1: '#ffd9b3', fill2: '#ff9933', outline: '#e67300' },
        300: { fill1: '#ffffb3', fill2: '#ffff4d', outline: '#cccc00' },
        400: { fill1: '#b3ffb3', fill2: '#4dff4d', outline: '#00cc00' },
        500: { fill1: '#b3d9ff', fill2: '#4da6ff', outline: '#0066cc' },
        600: { fill1: '#d9b3ff', fill2: '#a64dff', outline: '#6600cc' },
        700: { fill1: '#EE82EE', fill2: '#D8BFD8', outline: '#737373' },
        800: { fill1: '#ffb3ff', fill2: '#ff4dff', outline: '#cc00cc' },
        900: { fill1: '#bfbfbf', fill2: '#666666', outline: '#333333' },
        1000: { fill1: '#ff0000', fill2: '#bb0000', outline: '#880000' }
    };

    if (number === 0.125) baseColor = '#FFD1DC';
    else if (number === 0.25) baseColor = '#FFB6C1';
    else if (number === 0.475) baseColor = '#FF9FB6';
    else if (number === 0.625) baseColor = '#FF7B9C';
    else if (number === 0.75) baseColor = '#FF5E7E';
    else if (number === 0.85) baseColor = '#FF3C89';
    else if (number === 0.875) baseColor = '#FF298B';
    else if (number === 0.975) baseColor = '#FF1493';

    const operators = ['+', '-', '^', '*', '÷', '×', '/', '?', 'random'];
    const isRound = (number === 0 || number === 'pi' || number === 'PI' || number === 'tan' || number === 'Π' || number === 'Ω' || isLetter || number === 'ππ' || number === 'πππ' || number === '¶' || number === '§' || number === 'ⁿ' || number === '⁰' || number === '∅' || operators.includes(number)) && number !== 4;
    const isTriangle = (number === '∆');
    
    if (isRound || isTriangle) {
        // Round or Polygon logic
        // Slightly reduce circle radius so circular units don't completely overlap neighboring units and cause visual hiding.
        const circleRadius = unitSize * 0.52;
        
        // Special-case: render numeric 3.14 as a 2x2 circle cluster
        if (typeof numericValue === 'number' && Math.abs(numericValue - 3.14) < 0.0001) {
            // Arrange four circular parts in a 2x2 grid to form a larger "2x2 circle" appearance.
            const offset = unitSize * 0.36;
            parts.push(Bodies.circle(x - offset, y - offset, circleRadius));
            parts.push(Bodies.circle(x + offset, y - offset, circleRadius));
            parts.push(Bodies.circle(x - offset, y + offset, circleRadius));
            parts.push(Bodies.circle(x + offset, y + offset, circleRadius));
            
            // Create corresponding unit descriptors so renderer can place faces/labels if needed
            units.push(
                { localX: -offset, localY: -offset, color: 'transparent', outlineColor: 'transparent', originalNumber: number, isTenPart: false, row: 0, col: 0 },
                { localX:  offset, localY: -offset, color: 'transparent', outlineColor: 'transparent', originalNumber: number, isTenPart: false, row: 0, col: 1 },
                { localX: -offset, localY:  offset, color: 'transparent', outlineColor: 'transparent', originalNumber: number, isTenPart: false, row: 1, col: 0 },
                { localX:  offset, localY:  offset, color: 'transparent', outlineColor: 'transparent', originalNumber: number, isTenPart: false, row: 1, col: 1 }
            );
        } else if (number === 'ππ') {
            parts.push(Bodies.circle(x - unitSize * 0.36, y, circleRadius));
            parts.push(Bodies.circle(x + unitSize * 0.36, y, circleRadius));
            units.push({
                localX: 0, localY: 0,
                color: 'transparent', outlineColor: 'transparent',
                originalNumber: number, isTenPart: false, row: 0, col: 0
            });
        } else if (number === 'πππ') {
            parts.push(Bodies.circle(x - unitSize * 0.72, y, circleRadius));
            parts.push(Bodies.circle(x, y, circleRadius));
            parts.push(Bodies.circle(x + unitSize * 0.72, y, circleRadius));
            units.push({
                localX: 0, localY: 0,
                color: 'transparent', outlineColor: 'transparent',
                originalNumber: number, isTenPart: false, row: 0, col: 0
            });
        } else if (number === '∆') {
            parts.push(Bodies.polygon(x, y, 3, unitSize * 0.7));
            units.push({
                localX: 0, localY: 0,
                color: 'transparent', outlineColor: 'transparent',
                originalNumber: number, isTenPart: false, row: 0, col: 0
            });
        } else {
            parts.push(Bodies.circle(x, y, circleRadius));
            units.push({
                localX: 0, localY: 0,
                color: 'transparent', outlineColor: 'transparent',
                originalNumber: number, isTenPart: false, row: 0, col: 0
            });
        }
    } else {
        unitsData.forEach((uData, unitIdx) => {
            const { r, c, cols: totalCols, rows: totalRows, isHalf, isQuarter, isThreeQuarters } = uData;
            
            let lx, ly;
            if (customUnits) {
                lx = uData.lx;
                ly = uData.ly;
            } else {
                lx = (c - (totalCols - 1) / 2) * unitSize;
                ly = (r - (totalRows - 1) / 2) * unitSize;
                
                // If this unit is part of a stacked "layer" (3D cube simulation), offset it slightly
                // so layers appear stacked diagonally (simple faux-parallax).
                if (uData.layer !== undefined) {
                    const layerOffset = (uData.layer - (Math.floor(uData.layer / Math.max(1, uData.layer + 1)) * 0)) ; // noop placeholder
                    // Use a small consistent offset per layer
                    const depthOffset = unitSize * 0.35;
                    lx += (uData.layer) * depthOffset;
                    ly -= (uData.layer) * depthOffset;
                }
                
                if (isQuarter) {
                    // Quarter-sized
                } else if (isThreeQuarters) {
                    ly = (r - (totalRows - 1) / 2) * unitSize + (unitSize * 0.125);
                } else if (isFraction) {
                    if (isHalf) {
                        ly = (r - (totalRows - 1) / 2) * unitSize + (unitSize * 0.25);
                    }
                }
            }

            const skipPhysics = number > 1000 && (r % 2 !== 0 || c % 2 !== 0);
            
            let part = null;
            if (!skipPhysics) {
                let sizeH = unitSize;
                let sizeW = unitSize;
                if (uData.isOnePointFive) { sizeH = unitSize * 1.5; sizeW = unitSize * 1.5; }
                else if (uData.isEighth) { sizeH = unitSize * 0.125; }
                else if (uData.isQuarter) { sizeH = unitSize * 0.25; }
                else if (uData.isThreeQuarters) { sizeH = unitSize * 0.75; }
                else if (uData.isNearlyFull) { sizeH = unitSize * 0.975; }
                else if (uData.isHalf) { sizeH = unitSize * 0.5; }

                part = Bodies.rectangle(x + lx, y + ly, sizeW, sizeH, {
                    chamfer: { radius: 4 }
                });
                parts.push(part);

                // If this unit is an eighth (very small), add an invisible larger sensor part
                // so it can be reliably hit by pointer queries / mouse constraint even though the visible
                // physics rectangle is tiny.
                if (uData.isEighth) {
                    try {
                        const sensorRadius = Math.max(unitSize * 0.35, Math.max(sizeW, sizeH));
                        const sensor = Bodies.circle(x + lx, y + ly, sensorRadius, {
                            isSensor: true,
                            isStatic: false,
                            render: { visible: false }
                        });
                        // Keep the sensor non-intrusive in collision handling by giving it near-zero mass/inertia where supported.
                        try { sensor.inverseMass = 0; sensor.mass = 0; } catch (e) {}
                        parts.push(sensor);
                    } catch (err) {
                        // safe fallback: if sensor creation fails, continue without breaking block creation
                    }
                }
            }

            let finalColor = uData.color || baseColor;
            let outlineColor = uData.outlineColor || null;
            let isTenPart = false;

            // If this block represents the integer 7, override normal coloring and apply a rainbow striping
            if (forceRainbowSeven) {
                const rainbow = ['#8800ff', '#4b0082', '#0000ff', '#00ff00', '#ffff00', '#ff8800', '#ff0000'];
                // Use row+col (or unitIdx fallback) to distribute colors across the shape evenly
                const idx = (typeof uData.r === 'number' && typeof uData.c === 'number') ? ((uData.r + uData.c) % rainbow.length) : (unitIdx % rainbow.length);
                finalColor = rainbow[(idx + rainbow.length) % rainbow.length];
                outlineColor = outlineColor || '#5a005a';
            }

            if (uData.color) {
                // Color preserved from merge
            } else if (isFraction) {
                const floorN = Math.floor(numericValue);
                const ceilN = Math.ceil(numericValue);
                const color1 = floorN === 0 ? '#ffffff' : (colorMap[floorN] || (tensConfig[Math.floor(floorN/10)*10]||{fill:'#fff'}).fill);
                const color2 = colorMap[ceilN] || (tensConfig[Math.floor(ceilN/10)*10]||{fill:'#fff'}).fill;
                finalColor = mixColors(color1, color2);
            } else if (unitIdx < hundredThreshold) {
                const whichHundred = (Math.floor(unitIdx / 100) + 1) * 100;
                const hStyle = hundredStyles[whichHundred] || hundredStyles[100];
                
                if (number === 1000) {
                    // Global checkerboard for 1000
                    finalColor = (r + c) % 2 === 0 ? '#ff0000' : '#880000';
                    outlineColor = '#440000';
                } else {
                    const localHundredIdx = unitIdx % 100;
                    const hR = Math.floor(localHundredIdx / 10);
                    const hC = localHundredIdx % 10;
                    finalColor = (hR + hC) % 2 === 0 ? hStyle.fill1 : hStyle.fill2;
                    outlineColor = hStyle.outline;
                }
                isTenPart = true;
            } else if (unitIdx < hundredThreshold + currentTensValue) {
                if (currentTensValue === 70) {
                    finalColor = seventyColors[c % seventyColors.length];
                    outlineColor = '#CBC3E3';
                } else {
                    const tConfig = tensConfig[currentTensValue] || { fill: '#ffffff', outline: '#ff0000' };
                    finalColor = tConfig.fill;
                    outlineColor = tConfig.outline;
                }
                isTenPart = true;
            } else {
                finalColor = colorMap[currentOnesValue] || '#ffffff';
                isTenPart = (number === 10);
            }

            units.push({
                localX: lx,
                localY: ly,
                isHalf,
                isQuarter,
                isThreeQuarters,
                color: finalColor,
                outlineColor: outlineColor,
                originalNumber: number,
                isTenPart: isTenPart,
                row: r,
                col: c
            });
        });
    }

    // If this is exactly the single-digit 7, make its top-most unit lavender and the bottom-most unit red.
    // Also color the second-from-bottom unit orange, third-from-bottom yellow, the middle unit green,
    // the second-from-top unit indigo, and the third-from-top unit cyan.
    // We consider the unit with the smallest localY (top) and largest localY (bottom).
    if ((typeof numericValue === 'number' && Math.floor(numericValue) === 7) && units && units.length > 0) {
        // Sort a copy of units by localY ascending (top -> bottom)
        const sortedByY = units.slice().sort((a, b) => a.localY - b.localY);
        const topUnit = sortedByY[0];
        const secondTopUnit = sortedByY.length >= 2 ? sortedByY[1] : null;
        const thirdTopUnit = sortedByY.length >= 3 ? sortedByY[2] : null;
        const bottomUnit = sortedByY[sortedByY.length - 1];
        const secondBottomUnit = sortedByY.length >= 2 ? sortedByY[sortedByY.length - 2] : null;
        const thirdBottomUnit = sortedByY.length >= 3 ? sortedByY[sortedByY.length - 3] : null;

        // Determine the middle unit (for odd counts it's the center, for even counts pick the lower-middle)
        const middleIndex = Math.floor((sortedByY.length - 1) / 2);
        const middleUnit = sortedByY[middleIndex] || null;

        // Top unit: now violet per request
        if (topUnit) {
            topUnit.color = '#EE82EE';
            if (!topUnit.outlineColor) topUnit.outlineColor = '#c070c0';
        }

        // Purple for the second-from-top unit
        if (secondTopUnit) {
            secondTopUnit.color = '#8800ff';
            if (!secondTopUnit.outlineColor) secondTopUnit.outlineColor = '#5a005a';
        }

        // Cyan for the third-from-top unit
        if (thirdTopUnit) {
            thirdTopUnit.color = '#00ffff';
            if (!thirdTopUnit.outlineColor) thirdTopUnit.outlineColor = '#008b8b';
        }

        // Make the bottom unit red to emphasize the base
        if (bottomUnit) {
            bottomUnit.color = '#ff0000';
            if (!bottomUnit.outlineColor) bottomUnit.outlineColor = '#800000';
        }

        // Make the second-from-bottom unit orange
        if (secondBottomUnit) {
            secondBottomUnit.color = '#ff8800';
            if (!secondBottomUnit.outlineColor) secondBottomUnit.outlineColor = '#b35f00';
        }

        // Make the third-from-bottom unit yellow
        if (thirdBottomUnit) {
            thirdBottomUnit.color = '#FFFF00';
            if (!thirdBottomUnit.outlineColor) thirdBottomUnit.outlineColor = '#b3b300';
        }

        // Make the middle unit green
        if (middleUnit) {
            middleUnit.color = '#00bb00';
            if (!middleUnit.outlineColor) middleUnit.outlineColor = '#007700';
        }
    }



    // Special: for blocks in the 70s (70–79), color the leftmost 10 units pastel red
    if ((typeof numericValue === 'number' && Math.floor(numericValue) >= 70 && Math.floor(numericValue) < 80) && units && units.length > 0) {
        // Sort units left-to-right (then bottom-to-top for tie-break) and pick the leftmost 10 units
        const sortedByX = units.slice().sort((a, b) => {
            if (a.localX !== b.localX) return a.localX - b.localX;
            return a.localY - b.localY;
        });
        const leftCount = 10;
        const leftUnits = sortedByX.slice(0, leftCount);

        // Use a small tolerance when matching positions to account for float offsets
        const eps = 0.6;
        units.forEach(u => {
            for (let lu of leftUnits) {
                if (Math.abs(u.localX - lu.localX) <= eps && Math.abs(u.localY - lu.localY) <= eps) {
                    u.color = '#ffb3b3'; // pastel red
                    if (!u.outlineColor) u.outlineColor = '#cc8a8a';
                    break;
                }
            }
        });

        // Also ensure any remaining plain white units (default '#ffffff') are recolored to pastel red
        // so there are no stray white blocks in 7x families.
        units.forEach(u => {
            if (!u.color || u.color === '#ffffff' || u.color.toLowerCase() === 'white') {
                u.color = '#ffb3b3';
                if (!u.outlineColor) u.outlineColor = '#cc8a8a';
            }
        });
    }

    // Add a single larger spot marker to each unit of number 6 so renderer can draw one clear violet spot on each unit.
    if ((typeof numericValue === 'number' && Math.floor(numericValue) === 6) && units && units.length > 0) {
        units.forEach(u => {
            // mark each unit with a spot flag and a consistent spot color (#ad4fff)
            u.spot = true;
            u.spotColor = u.spotColor || '#ad4fff';
        });
    }

    // Create a compound body. Matter-JS Body.create is most stable with an array of parts.
    // We add a tiny sensor at the center to ensure there's always a root part if needed.
    const body = Body.create({
        parts: parts.length > 0 ? parts : [Bodies.rectangle(x, y, 1, 1, { isSensor: true })],
        restitution: 0,
        friction: 0.5,
        frictionStatic: 1,
        frictionAir: 0.05,
        inertia: Infinity,
        render: { visible: false }
    });

    // Reset center of mass to be the spawn point X, Y for predictable rendering
    // But Body.create already calculates CoM. Let's just calculate relative offsets from the body's actual final position.
    const bodyPos = body.position;
    const finalUnits = units.map((u) => {
        const worldPos = { x: x + u.localX, y: y + u.localY };
        const local = Matter.Vector.rotate(Matter.Vector.sub(worldPos, bodyPos), -body.angle);
        return { ...u, localX: local.x, localY: local.y };
    });

    // Cache shape properties to avoid per-frame calculations in renderer
    const factorCount = (n) => {
        if (typeof n !== 'number' || n > 1000) return 0;
        let count = 0;
        for (let i = 1; i <= n; i++) if (n % i === 0) count++;
        return count;
    };
    const isSquare = typeof numericValue === 'number' && numericValue > 0 && Math.sqrt(numericValue) % 1 === 0;
    const isSuperRect = typeof numericValue === 'number' && numericValue > 1 && !isSquare && (numericValue === 1000 || factorCount(numericValue) >= 6);

    // If this token is explicitly meant to be unmergeable (like "add" or the long corrupted 'a̷' token),
    // present it as a sprite-like non-mergeable entity by providing an empty units array and tagging flags.
    const mustBeNonMergable = isExplicitAdd || isLongCorrupted;

    body.renderData = {
        // Use displayTag when present so this block shows the large exponent label,
        // while numericValue remains 1 for physics/merging behavior.
        number: displayTag || number,
        unitSize,
        // When non-mergeable, provide an empty units array so merge logic ignores this body.
        units: mustBeNonMergable ? [] : finalUnits,
        isSquare,
        isSuperRect,
        isRound,
        isTriangle,
        baseColor,
        // Special display label: show "66 + 1" for numeric 67 while preserving numeric identity
        displayLabel: (typeof numericValue === 'number' && Math.floor(numericValue) === 67) ? '66 + 1' : null
    };

    // Tag the body as a sprite-like, non-mergeable entity so other systems can quickly detect it.
    if (mustBeNonMergable) {
        body.isSpriteEntity = true;
        body.isNonMergable = true;
        // keep a lightweight lock so other code avoids renaming/merging it
        body.lockName = true;
    }

    return body;
}