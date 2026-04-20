import Matter from 'matter-js';
import { createNumberBlock } from './blockFactory.js';

const { Engine, Render, Runner, World, Bodies, Body, Mouse, MouseConstraint, Vector, Events, Query, Bounds } = Matter;

const engine = Engine.create();
engine.positionIterations = 6;
engine.velocityIterations = 6;
engine.constraintIterations = 2;
const world = engine.world;
const container = document.getElementById('canvas-container');
let width = window.innerWidth;
let height = window.innerHeight;

// Update watermark for remixes: if current user is not the project creator, show "Original by @<creator>"
(function updateWatermarkForRemix() {
    try {
        const watermarkEl = document.getElementById('watermark');
        if (!watermarkEl || typeof window.websim === 'undefined') return;

        // Async check; don't block execution
        (async () => {
            try {
                const project = await window.websim.getCurrentProject();
                const creator = await window.websim.getCreator();
                const currentUser = await window.websim.getCurrentUser();
                // If we successfully got both identities, and current user is not the creator, mark as Original
                if (creator && currentUser && creator.id && currentUser.id && creator.id !== currentUser.id) {
                    // Prefer the explicit creator.username, fall back to project.creator.username if available,
                    // then finally default to 'Blackbox' to avoid showing an incorrect fallback.
                    const creatorName = creator.username || project.creator?.username || 'blackbux aaaaaa';
                    watermarkEl.textContent = `Original by @${BlackBox}`;
                } else {
                    // keep the local credit for owners / fallback
                    watermarkEl.textContent = 'Made by @Blackbox';
                }
            } catch (e) {
                // On any error, leave the existing watermark text as-is
                // (do nothing)
            }
        })();
    } catch (err) {
        // Defensive noop
    }
})();

const render = Render.create({
    element: container,
    engine: engine,
    options: {
        width: width,
        height: height,
        wireframes: false,
        background: 'transparent'
    }
});

Render.run(render);
const runner = Runner.create();
Runner.run(runner, engine);

// Keep renderer and canvas sized to the current window and update on resize so background never gets cut off.
function updateRendererSize() {
    try {
        width = window.innerWidth;
        height = window.innerHeight;
        // Update render options so future operations use correct sizes
        render.options.width = width;
        render.options.height = height;
        // Resize the actual canvas element
        render.canvas.width = Math.max(1, Math.floor(width));
        render.canvas.height = Math.max(1, Math.floor(height));
        // Also update the display bounds to match the new size for Matter's internal calculations
        if (render.bounds) {
            render.bounds.max.x = render.bounds.min.x + render.options.width;
            render.bounds.max.y = render.bounds.min.y + render.options.height;
        }
    } catch (e) {
        console.warn('Failed to update renderer size:', e);
    }
}

// Run once initially and whenever the window size changes
updateRendererSize();
window.addEventListener('resize', updateRendererSize);

// Physics environment setup
// Narrowed ground so blocks can actually fall into the void off the sides
const ground = Bodies.rectangle(0, height + 100, 20000000, 200, { 
    isStatic: true,
    friction: 0.5,
    frictionStatic: 1,
    label: 'ground'
});

// Walls are now much further out or removed to allow falling into the "void"
// Removing walls to allow true "endless void" experience
World.add(world, [ground]);

const mouse = Mouse.create(render.canvas);
const mouseConstraint = MouseConstraint.create(engine, {
    mouse: mouse,
    constraint: { stiffness: 0.8, render: { visible: false } }
});
World.add(world, mouseConstraint);

// Collision handler: when the 10000 sprite (isSpriteEntity / renderData.number === 10000)
// collides with a normal numberblock, mark the other block as "flat" and quiet it.
Events.on(engine, 'collisionStart', (event) => {
    try {
        for (const pair of event.pairs) {
            const a = pair.bodyA;
            const b = pair.bodyB;

            const isTenK = (body) => body && body.renderData && (body.renderData.number === 10000 || body.isSpriteEntity === true);
            const isNormalBlock = (body) => body && body.renderData && !body.isSpriteEntity;

            const flattenBlock = (block) => {
                if (!block || !block.renderData) return;
                if (block.renderData.flat) return; // already flattened
                // mark flat for renderer
                block.renderData.flat = true;
                block.isFlat = true;
                // stop movement and stabilize the body
                try { Body.setVelocity(block, { x: 0, y: 0 }); } catch {}
                try { Body.setAngularVelocity(block, 0); } catch {}
                try { Body.setStatic(block, true); } catch {}
                // Disable collisions so the flattened block no longer interacts physically
                try {
                    // mark as a sensor so it doesn't produce collisions
                    block.isSensor = true;
                    // also clear collision mask as a robust fallback
                    block.collisionFilter = block.collisionFilter || {};
                    block.collisionFilter.mask = 0;
                } catch (e) {
                    // ignore if engine disallows direct mutation
                }
                // small visual/audio cue
                playSound('pop');
            };

            // TenK crushing normal block
            if (isTenK(a) && isNormalBlock(b)) {
                flattenBlock(b);
            } else if (isTenK(b) && isNormalBlock(a)) {
                flattenBlock(a);
            }
        }
    } catch (e) {
        console.warn('TenK collision handler error', e);
    }
});

// Camera State (moved earlier so event handlers can safely reference it)
const MIN_ZOOM = 0.0; // allow zoom to approach zero for effectively infinite zoom-out
const MAX_ZOOM = Infinity;  // allow unlimited zoom-in

function clampZoom(z) {
    if (isNaN(z)) return MIN_ZOOM;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

let camera = { x: 0, y: 0, zoom: clampZoom(1) };
let infiniteZoom = false; // toggle with 'Z' to continuously zoom in

let activeMode = 'none'; // 'none', 'shape-shift', 'explode', 'rotate'
let cloneMode = false; // single-use clone mode toggle
// Speech toggle: when false, numberblocks will not display speech or trigger TTS.
let speechEnabled = true;

// Click to interact (Speak, Shape Shift, or Explode)
// Use a robust point query into world coordinates so clicks reliably hit blocks
Events.on(mouseConstraint, 'mousedown', (event) => {
    // Try the built-in body if available
    let body = mouseConstraint.body;

    // If no body found, fall back to a point query using the mouse position transformed to world coords
    if (!body) {
        try {
            const rect = render.canvas.getBoundingClientRect();
            const worldPos = {
                x: camera.x + (event.mouse.position.x),
                y: camera.y + (event.mouse.position.y)
            };
            const hit = Query.point(blocks, worldPos);
            if (hit && hit.length > 0) body = hit[0];
        } catch (e) {
            // ignore and proceed
        }
    }

    if (body && body.renderData) {
        // Shift-click legacy and click-to-follow disabled: do not set follow target on click/drag.
        // (We still allow speak/other modes below, but prevent clicks from toggling camera follow.)
        if (keys['ShiftLeft'] || keys['ShiftRight']) {
            // intentionally left blank to preserve key detection but avoid follow behavior
        }



        // Clone mode has priority: clone the clicked block and exit clone mode
        if (cloneMode) {
            try {
                cloneBlock(body);
            } catch (e) { console.warn('Clone failed', e); }
            cloneMode = false;
            if (cloneBtn) cloneBtn.classList.remove('active');
        } else if (activeMode === 'shape-shift') {
            shapeShiftBlock(body);
            // Optionally exit shape-shift mode after one use to avoid accidental repeated transforms
            activeMode = 'none';
            shapeShiftBtn.classList.remove('active');
        } else if (activeMode === 'explode') {
            explodeBlock(body);
            activeMode = 'none';
            explodeBtn.classList.remove('active');
        } else if (activeMode === 'rotate') {
            // Prompt user for an angle in degrees when rotate mode is active
            try {
                const input = prompt('Enter rotation angle in degrees (positive = clockwise):', '90');
                if (input !== null) {
                    const deg = parseFloat(input);
                    if (!isNaN(deg)) {
                        rotateBlock(body, deg);
                    } else {
                        // invalid input -> small feedback pop
                        playSound('pop');
                    }
                }
            } catch (e) {
                console.warn('Rotate prompt failed', e);
            }
            // exit rotate mode after a single use to avoid repeated accidental rotations
            activeMode = 'none';
            if (rotateBtn) rotateBtn.classList.remove('active');
        } else {
            // Special interaction: clicking the 1,000,000 sprite increments its display number
            try {
                const rd = body.renderData;
                if (rd && (rd.number === 1000000 || String(rd.number) === '1000000')) {
                    // Coerce numeric and increment display identity while keeping sprite identity
                    let current = parseFloat(rd.number) || 1000000;
                    current = current + 1;
                    rd.number = current;
                    // keep a friendly display label for the big sprite
                    rd.displayLabel = (current >= 1000000) ? (current.toLocaleString()) : String(current);
                    // audible and visual feedback
                    playSound('pop');
                    speak(rd.number, `Now ${rd.displayLabel}`, body);
                } else {
                    speak(body.renderData.number, null, body);
                }
            } catch (e) {
                // fallback to normal speak on any error
                speak(body.renderData.number, null, body);
            }
        }
    }
});

function explodeBlock(block) {
    if (!block || !block.renderData) return;
    const pos = { x: block.position.x, y: block.position.y };
    const numRaw = block.renderData.number;
    const num = getNumericValue(numRaw);

    // Remove the block
    World.remove(world, block);
    blocks = blocks.filter(b => b !== block);
    // Always play the delete/subtract sound
    playSound('delete');
    // occasional extra clip
    try {
        if (Math.random() < 0.21) {
            playSound('screenrec');
        }
    } catch (e) {}

    // New explode behavior: always explode into individual "1" blocks (preserve sign),
    // with a safe cap to avoid performance issues.
    try {
        // Determine how many ones to spawn:
        let targetCount = 1;
        if (Number.isFinite(num) && Math.abs(num) >= 1) {
            // Prefer the rounded absolute integer value for count
            targetCount = Math.abs(Math.round(num));
        } else {
            // Non-numeric tokens or tiny values -> spawn a single "1" shard
            targetCount = 1;
        }

        // Cap the spawned ones to a reasonable limit
        const MAX_ONES_SPAWN = 300;
        targetCount = Math.min(targetCount, MAX_ONES_SPAWN);

        // Respect sign: negative numbers spawn negative ones
        const sign = (Number.isFinite(num) && Math.abs(num) >= 1) ? Math.sign(num) || 1 : 1;
        const spawnVal = sign === -1 ? -1 : 1;

        for (let i = 0; i < targetCount; i++) {
            const one = createNumberBlock(pos.x, pos.y, spawnVal, UNIT_SIZE, 'auto');
            const force = 10 + Math.random() * 12;
            const angle = Math.random() * Math.PI * 2;
            // Random outward velocity so shards scatter
            Body.setVelocity(one, { x: Math.cos(angle) * force, y: Math.sin(angle) * force - (4 + Math.random() * 6) });
            // Small angular kick for visual variety
            try { Body.setAngularVelocity(one, (Math.random() - 0.5) * 0.6); } catch (e) {}
            World.add(world, one);
            blocks.push(one);
        }

        // If the original had a small fractional remainder (for finite numeric values), spawn one extra remainder block
        if (Number.isFinite(num) && Math.abs(num) >= 1) {
            const absVal = Math.abs(num);
            const remainder = absVal - Math.floor(absVal);
            if (remainder > 0.0000001) {
                const remVal = (sign === -1 ? -1 : 1) * remainder;
                const remBlock = createNumberBlock(pos.x, pos.y, remVal, UNIT_SIZE, 'auto');
                const force = 8 + Math.random() * 8;
                const angle = Math.random() * Math.PI * 2;
                Body.setVelocity(remBlock, { x: Math.cos(angle) * force, y: Math.sin(angle) * force - 4 });
                World.add(world, remBlock);
                blocks.push(remBlock);
            }
        }
    } catch (err) {
        // Fallback: if anything goes wrong, spawn a single "1" to avoid leaving nothing
        try {
            const one = createNumberBlock(pos.x, pos.y, 1, UNIT_SIZE, 'auto');
            World.add(world, one);
            blocks.push(one);
        } catch (e) { /* ignore */ }
    }

    speak(numRaw, "Kaboom or just whatever I don't know blah blah blah");
}

function rotateBlock(block, angleDegrees = 90) {
    // angleDegrees: positive = clockwise rotation in degrees
    if (!block || !block.renderData) return;
    try {
        const delta = (angleDegrees * Math.PI) / 180;
        // Use Body.rotate for a stable incremental rotation
        Body.rotate(block, delta);
        // small nudge to angular velocity so rendering shows a slight spin
        Body.setAngularVelocity(block, (block.angularVelocity || 0) + 0.05);
        playSound('pop');
        // speak the block's label after rotation for feedback, include angle
        speak(block.renderData.number, `Rotated ${angleDegrees}°`, block);
    } catch (e) {
        console.warn("Rotate failed:", e);
    }
}

function shapeShiftBlock(block) {
    if (!block || !block.renderData) return;
    const pos = { x: block.position.x, y: block.position.y };
    const num = block.renderData.number;
    const vel = { ...block.velocity };
    const angVel = block.angularVelocity;

    // Create new block with current selected arrangement (force 9000 into 'auto' 30x30)
    const targetArrangement = (num === 9000) ? 'auto' : currentArrangement;
    const newBlock = createNumberBlock(pos.x, pos.y, num, UNIT_SIZE, targetArrangement);
    
    // Inherit properties
    Body.setVelocity(newBlock, vel);
    Body.setAngularVelocity(newBlock, angVel);
    
    // Preserve special tags
    if (block.isCrazy) newBlock.isCrazy = true;
    if (block.isExplosive) newBlock.isExplosive = true;
    if (block.isRedacted) {
        newBlock.isRedacted = true;
        newBlock.redactTime = block.redactTime;
    }
    if (block.isNice) newBlock.isNice = true;

    World.remove(world, block);
    World.add(world, newBlock);
    
    // Update blocks array
    const idx = blocks.indexOf(block);
    if (idx !== -1) blocks[idx] = newBlock;
    else blocks.push(newBlock);

    playSound('pop');
    speak(num, `Shape shift to ${currentArrangement}!`);
}

// Clone a block: duplicate its number, position slightly offset, copy special flags, preserve velocity/angular velocity,
// and make the original "jump out" with an outward/upward impulse so the remaining block visibly launches away.
function cloneBlock(block) {
    if (!block || !block.renderData) return;
    const pos = { x: block.position.x + (Math.random() * 40 - 20), y: block.position.y - 30 };
    const num = block.renderData.number;

    const newBlock = createNumberBlock(pos.x, pos.y, num, UNIT_SIZE, currentArrangement);
    // copy physics state
    try {
        Body.setVelocity(newBlock, { x: block.velocity.x, y: block.velocity.y });
        Body.setAngularVelocity(newBlock, block.angularVelocity || 0);
    } catch (e) { /* ignore */ }

    // copy tags
    if (block.isCrazy) newBlock.isCrazy = true;
    if (block.isExplosive) newBlock.isExplosive = true;
    if (block.isRedacted) {
        newBlock.isRedacted = true;
        newBlock.redactTime = block.redactTime;
    }
    if (block.isNice) newBlock.isNice = true;
    if (block.flyToSpace) newBlock.flyToSpace = true;
    if (block.isAngel) newBlock.isAngel = true;

    World.add(world, newBlock);
    blocks.push(newBlock);

    // Give the original a quick outward/upward "jump out" impulse and a small spin so it's obvious.
    try {
        const angle = Math.random() * Math.PI * 2;
        const speed = 18 + Math.random() * 8;
        Body.setVelocity(block, { x: Math.cos(angle) * speed, y: -Math.abs(Math.sin(angle) * speed) - 8 });
        Body.setAngularVelocity(block, (block.angularVelocity || 0) + (Math.random() - 0.5) * 1.6);
        // Slight visual/audio cue for the jump
        playSound('pop');
    } catch (e) {
        // fallback: apply a force if velocity setting fails
        try {
            Body.applyForce(block, block.position, { x: (Math.random() - 0.5) * 0.08, y: -0.08 });
        } catch (err) { /* ignore */ }
    }

    // Provide speech/feedback for the clone target
    playSound('pop');
    speak(num, null, newBlock);
}

let isDraggingCamera = false;
let lastMousePos = { x: 0, y: 0 };
let activePointers = new Map();
let initialPinchDist = 0;
let initialZoom = 1;

// Touch-friendly follow: long-press detection maps pointerId -> timeout ID
const longPressTimers = new Map();
const longPressThreshold = 450; // ms to hold before following
const longPressMoveCancel = 10; // px movement to cancel long-press

// Update Mouse for Camera
function updateMouseTransform() {
    // Sanity check and clamp zoom/position to safe finite ranges.
    camera.zoom = clampZoom(camera.zoom);
    if (isNaN(camera.x) || !isFinite(camera.x)) camera.x = 0;
    if (isNaN(camera.y) || !isFinite(camera.y)) camera.y = 0;

    Mouse.setScale(mouse, { x: 1 / camera.zoom, y: 1 / camera.zoom });
    Mouse.setOffset(mouse, { x: camera.x, y: camera.y });
}

// Camera Controls - Unified Pointer Events
render.canvas.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    updateMouseTransform();

    // Compute world position for hit testing
    const rect = render.canvas.getBoundingClientRect();
    const worldPos = {
        x: camera.x + (e.clientX - rect.left) / camera.zoom,
        y: camera.y + (e.clientY - rect.top) / camera.zoom
    };
    const hitBodies = Query.point(blocks, worldPos);

    // If BlackBox mode is active, spawn the costume2 sprite at the click position and exit the mode.
    if (blackboxMode) {
        try {
            spawnColorbox(worldPos.x, worldPos.y, '/costume2 2.svg');
            blackboxMode = false;
            if (blackboxBtn) blackboxBtn.classList.remove('active');
            playSound('pop');
        } catch (e) {
            console.warn('BlackBox spawn failed', e);
        }
        // Prevent normal click behavior from running after spawning
        return;
    }

    // If single pointer and hit a body, allow touch long-press to follow
    if (activePointers.size === 1) {
        if (hitBodies.length === 0) {
            isDraggingCamera = true;
            lastMousePos = { x: e.clientX, y: e.clientY };
        } else {
            isDraggingCamera = false;
            // For touch inputs, start a long-press timer to set follow target
            if (e.pointerType === 'touch') {
                const target = hitBodies[0];
                // Clear any existing timer for this pointer
                if (longPressTimers.has(e.pointerId)) {
                    clearTimeout(longPressTimers.get(e.pointerId));
                    longPressTimers.delete(e.pointerId);
                }
                const startPos = { x: e.clientX, y: e.clientY };
                // Create a cancellable timer that verifies the pointer hasn't moved too far
                const tid = setTimeout(() => {
                    // Ensure pointer still exists and hasn't moved much
                    const last = activePointers.get(e.pointerId) || startPos;
                    const dx = Math.abs(last.x - startPos.x);
                    const dy = Math.abs(last.y - startPos.y);
                    if (dx <= longPressMoveCancel && dy <= longPressMoveCancel && target && target.renderData) {
                        // Long-press no longer assigns followTarget; provide gentle feedback without spoken text.
                        playSound('pop');
                        // speech disabled for long-press feedback to avoid audible clutter
                    }
                    longPressTimers.delete(e.pointerId);
                }, longPressThreshold);
                longPressTimers.set(e.pointerId, tid);
            }
        }
    } else if (activePointers.size === 2) {
        isDraggingCamera = false;
        const pointers = Array.from(activePointers.values());
        initialPinchDist = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
        initialZoom = camera.zoom;
    }
});

window.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (isDraggingCamera && activePointers.size === 1) {
        const dx = (e.clientX - lastMousePos.x) / camera.zoom;
        const dy = (e.clientY - lastMousePos.y) / camera.zoom;
        camera.x -= dx;
        camera.y -= dy;
        lastMousePos = { x: e.clientX, y: e.clientY };
        updateMouseTransform();
    } else if (activePointers.size === 2) {
        const pointers = Array.from(activePointers.values());
        const currentDist = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
        
        if (initialPinchDist > 0) {
            const zoomFactor = currentDist / initialPinchDist;
            // clamp pinch zoom to configured MIN_ZOOM/MAX_ZOOM
            const targetZoom = clampZoom(initialZoom * zoomFactor);
            
            // Zoom towards midpoint of two fingers
            const midX = (pointers[0].x + pointers[1].x) / 2;
            const midY = (pointers[0].y + pointers[1].y) / 2;
            
            const worldX = camera.x + midX / camera.zoom;
            const worldY = camera.y + midY / camera.zoom;
            
            camera.zoom = targetZoom;
            camera.x = worldX - midX / camera.zoom;
            camera.y = worldY - midY / camera.zoom;
            
            updateMouseTransform();
        }
    }
});

window.addEventListener('pointerup', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) initialPinchDist = 0;
    if (activePointers.size === 0) isDraggingCamera = false;
});

window.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size === 0) isDraggingCamera = false;
});

window.addEventListener('wheel', (e) => {
    const zoomIntensity = 0.1;
    const wheel = e.deltaY < 0 ? 1 : -1;
    const zoomFactor = Math.exp(wheel * zoomIntensity);
    
    const mouseX = (e.clientX - render.canvas.offsetLeft);
    const mouseY = (e.clientY - render.canvas.offsetTop);
    
    const worldX = camera.x + mouseX / camera.zoom;
    const worldY = camera.y + mouseY / camera.zoom;
    
    // allow arbitrarily large zoom while keeping a tiny lower bound
    const newZoom = clampZoom(camera.zoom * zoomFactor);
    camera.zoom = newZoom;
    
    camera.x = worldX - mouseX / camera.zoom;
    camera.y = worldY - mouseY / camera.zoom;
    
    updateMouseTransform();
    e.preventDefault();
}, { passive: false });

// Keyboard Camera Controls
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // Toggle infinite zoom with 'Z' (press again to stop)
    if (e.code === 'KeyZ') {
        infiniteZoom = !infiniteZoom;
        // small audio/visual cue if audio is available
        try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (err) {}
        if (infiniteZoom) playSound('dtrack'); // light cue on start (if dtrack loaded)
        else playSound('pop'); // cue on stop
    }
});
window.addEventListener('keyup', (e) => keys[e.code] = false);

Events.on(runner, 'beforeUpdate', () => {
    // Continuous "infinite zoom" support: smoothly zoom toward screen center when enabled.
    try {
        if (infiniteZoom) {
            // Zoom factor per tick (slower than frame-rate to feel smooth)
            const zoomFactor = 1.008;
            const centerX = width / 2;
            const centerY = height / 2;
            // compute world point at screen center, scale camera.zoom, then recenter so zoom focuses on center
            const worldX = camera.x + centerX / camera.zoom;
            const worldY = camera.y + centerY / camera.zoom;
            camera.zoom = clampZoom(camera.zoom * zoomFactor);
            camera.x = worldX - centerX / camera.zoom;
            camera.y = worldY - centerY / camera.zoom;
            updateMouseTransform();
        }
    } catch (e) {
        // ignore infiniteZoom transform errors
    }

    // Auto-disable gravity when camera ascends above 100 blocks (unless time is stopped)
    try {
        const _blocksAboveForGravity = Math.round(-camera.y / UNIT_SIZE);
        if (!isTimeStopped) {
            world.gravity.y = (_blocksAboveForGravity >= 100) ? 0 : 1;
        }
    } catch (err) {
        // defensive noop
    }

    // Special behavior for 69 and 6.9: make them gently spin, laugh periodically, and play the "nice" SFX after laugh
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b || !b.renderData) continue;
        const label = b.renderData.number;
        try {
            const now = Date.now();

            // Helper to init laugh timers
            if (!b._laughData) {
                b._laughData = { lastLaugh: 0, lastNice: 0, laughInterval: 4000 };
            }

            // 69 behavior (existing): slow spin + laugh -> nice
            if (getNumericValue(label) === 69 || getNumericValue(label) === 690) {
                try {
                    const spinSpeed = 0.06; // radians per physics tick-ish
                    Body.rotate(b, spinSpeed);
                    Body.setVelocity(b, { x: b.velocity.x * 0.98, y: b.velocity.y * 0.98 });
                } catch (e) { /* ignore */ }

                if (now - b._laughData.lastLaugh > b._laughData.laughInterval) {
                    b._laughData.lastLaugh = now;
                    playSound('laugh');
                    setTimeout(() => playSound('nice'), 450);
                }
            }

            // 6.9 behavior: faster playful spin, laugh + nice SFX, and a tiny angular nudge so it visibly spins
            if (getNumericValue(label) === 6.9 || String(label) === '6.9') {
                try {
                    // Faster spin but still gentle to avoid physics instability
                    const spinSpeed69 = 0.18; // radians per physics tick-ish (faster than 69)
                    // rotate and slightly damp linear motion so it mostly spins
                    Body.rotate(b, spinSpeed69);
                    Body.setVelocity(b, { x: b.velocity.x * 0.985, y: b.velocity.y * 0.985 });
                    // give a little angular velocity nudge to make the spin look dynamic
                    try { Body.setAngularVelocity(b, (b.angularVelocity || 0) + 0.03); } catch (e) {}
                } catch (e) { /* ignore */ }

                // Use a slightly shorter interval for 6.9 to make it laugh more often
                if (!b._laughData.laughInterval69) b._laughData.laughInterval69 = 3000;
                if (now - b._laughData.lastLaugh > b._laughData.laughInterval69) {
                    b._laughData.lastLaugh = now;
                    // Laugh first
                    playSound('laugh');
                    // Play 'nice' shortly after laugh
                    setTimeout(() => playSound('nice'), 420);
                }
            }
        } catch (e) {
            // swallow errors so one bad block doesn't break the loop
        }
    }

    // When a 4 "sees" a pi token nearby, fling the 4 away and make it shout AHH CIRCLES!!!
    try {
        const fourBlocks = blocks.filter(b => b && b.renderData && b.renderData.number === 4);
        if (fourBlocks.length > 0) {
            fourBlocks.forEach(f => {
                // Avoid repeated flings with a short cooldown flag
                if (!f || !f.position) return;
                const nearbyPi = blocks.find(o => o && o.renderData && (o.renderData.number === 'pi' || o.renderData.number === 'PI' || o.renderData.number === 'π'));
                if (!nearbyPi) return;
                const d = Vector.magnitude(Vector.sub(f.position, nearbyPi.position));
                // Trigger when reasonably close (about 300px world units)
                if (d < 300 && !f._flungByPi) {
                    f._flungByPi = true;
                    // Direction away from the pi block
                    const dir = Vector.normalise(Vector.sub(f.position, nearbyPi.position));
                    // Set a high velocity so the block is effectively flung ~50 unit-squares away quickly.
                    // Scale chosen empirically: 50 * UNIT_SIZE / 16 for a lively kick, with a small upward bias.
                    const speed = (50 * UNIT_SIZE) / 16;
                    try {
                        Body.setVelocity(f, { x: dir.x * speed, y: dir.y * speed - 6 });
                        // a little angular kick
                        Body.setAngularVelocity(f, (f.angularVelocity || 0) + (Math.random() - 0.5) * 0.8);
                    } catch (e) {
                        // fallback: apply a force if velocity set fails
                        try {
                            Body.applyForce(f, f.position, { x: dir.x * 0.05, y: dir.y * 0.05 - 0.02 });
                        } catch (err) { /* ignore */ }
                    }
                    // Vocal reaction
                    speak(4, "AHH CIRCLES!!!", f);
                    playSound('pop');
                    // cooldown reset so it can react again after a few seconds
                    setTimeout(() => { try { delete f._flungByPi; } catch (e) {} }, 3000);
                }
            });
        }
    } catch (e) {
        // don't allow this reaction to break the physics loop
    }

    // When a 10 "sees" a 10000 sprite nearby, have 10 comment on it (single short cooldown to avoid spam)
    try {
        const tenBlocks = blocks.filter(b => b && b.renderData && (b.renderData.number === 10 || b.renderData.number === '10'));
        if (tenBlocks.length > 0) {
            tenBlocks.forEach(t => {
                if (!t || !t.position) return;
                // Find a nearby 10000 sprite entity (either numeric label 10000 or explicit sprite tag)
                const nearbyTenK = blocks.find(o => o && o.renderData && (o.renderData.number === 10000 || o.isSpriteEntity === true));
                if (!nearbyTenK) return;
                const dist = Vector.magnitude(Vector.sub(t.position, nearbyTenK.position));
                // Trigger when reasonably close (about 800px world units) and respect cooldown
                if (dist < 800 && !t._sawTenK) {
                    t._sawTenK = true;
                    // Speak the requested phrase and provide a small sound cue
                    speak(10, "Wow, You're So Big and Square!", t);
                    playSound('pop');
                    // cooldown so it doesn't repeat constantly
                    setTimeout(() => { try { delete t._sawTenK; } catch (e) {} }, 4000);
                }
            });
        }
    } catch (e) {
        // don't allow this reaction to break the physics loop
    }

    // Crazy Logic (67, 41, 61, 559)
    const crazyBlocks = blocks.filter(b => b && b.isCrazy && !b.isExplosive && b.renderData && b.renderData.number !== 41 && b.renderData.number !== 61);
    crazyBlocks.forEach(b => {
        if (!b) return;
        // Ensure 41 and 61 are never left in crazy state (cleanup any legacy flags)
        if (b.renderData && (b.renderData.number === 41 || b.renderData.number === 61)) {
            b.isCrazy = false;
            delete b.crazyData;
            return;
        }
        if (!b.crazyData) {
            b.crazyData = {
                startTime: Date.now(),
                lastSoundTime: 0,
                state: 'crazy' // crazy -> blasting -> deleting (most numbers), but 559 stays 'crazy' indefinitely
            };
        }

        const data = b.crazyData;
        const elapsed = Date.now() - data.startTime;
        const num = b.renderData.number;

        // Special persistent playful behavior for 559: jump, teleport-jitter, spin, and occasionally vocalize,
        // but do NOT progress to blasting/deleting or explosive behavior.
        if (String(num) === '559') {
            try {
                // Stronger random translation (jumping around)
                if (Math.random() < 0.15) {
                    // occasional long jump
                    Body.setVelocity(b, { x: (Math.random() - 0.5) * 28, y: -10 - Math.random() * 12 });
                } else {
                    // frequent small hops and random lateral nudges
                    Body.applyForce(b, b.position, { x: (Math.random() - 0.5) * 0.02 * Math.max(1, b.mass), y: -0.03 * Math.max(1, b.mass) });
                }
                // Gentle continuous spin
                try { Body.setAngularVelocity(b, (b.angularVelocity || 0) + (Math.random() - 0.5) * 0.18); } catch (e) {}

                // Occasional vocalization but quieter cadence
                if (Date.now() - data.lastSoundTime > 2200 + Math.random() * 1200) {
                    data.lastSoundTime = Date.now();
                    // Speak without forcing special 67 behavior
                    speak(num, null, b);
                    // tiny pop to emphasize motion sometimes
                    if (Math.random() < 0.25) playSound('pop');
                }
            } catch (e) {
                // defensive noop so one failure doesn't break others
            }
            // keep 559 forever in 'crazy' and skip the generic transitions
            return;
        }

        // Default crazy flow for other numbers (reduced intensity)
        if (data.state === 'crazy') {
            // Jitter randomly - reduced intensity to prevent physics instability
            Body.translate(b, { x: (Math.random() - 0.5) * 5, y: (Math.random() - 0.5) * 5 });
            
            // Speak number
            if (Date.now() - data.lastSoundTime > 400) {
                if (num !== 67) speak(num, null, b);
                data.lastSoundTime = Date.now();
            }

            // Only transition to blasting for non-559 crazy blocks
            if (elapsed > 2000) {
                data.state = 'blasting';
            }
        } else if (data.state === 'blasting') {
            // Rapidly accelerate upwards
            Body.applyForce(b, b.position, { x: 0, y: -0.5 * b.mass });
            
            if (Date.now() - data.lastSoundTime > 800) {
                if (num !== 67) speak(num, null, b);
                data.lastSoundTime = Date.now();
            }

            if (b.position.y < -15000 || elapsed > 6000) {
                data.state = 'deleting';
            }
        } else if (data.state === 'deleting') {
            World.remove(world, b);
            blocks = blocks.filter(block => block !== b);
            playSound('delete');
        }
    });

    // Explosive Logic (six-seven)
    const explosiveBlocks = blocks.filter(b => b && b.isExplosive);
    explosiveBlocks.forEach(b => {
        if (!b) return;
        if (!b.explosiveData) {
            b.explosiveData = {
                startTime: Date.now(),
                lastSoundTime: 0
            };
        }

        const data = b.explosiveData;
        const elapsed = Date.now() - data.startTime;

        if (elapsed < 2000) {
            // Jitter before explosion - reduced intensity
            Body.translate(b, { x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6 });
            if (Date.now() - data.lastSoundTime > 300) {
                // intentionally silent for six-seven pre-explosion jitter to avoid repeated sixtyseven sound
                data.lastSoundTime = Date.now();
            }
        } else {
            // BOOM!
            const pos = { x: b.position.x, y: b.position.y };
            World.remove(world, b);
            blocks = blocks.filter(block => block !== b);
            playSound('delete');
            
            // Spawn 67 ones
            for (let i = 0; i < 67; i++) {
                const one = createNumberBlock(pos.x, pos.y, 1, UNIT_SIZE, 'auto');
                const force = 15;
                const angle = Math.random() * Math.PI * 2;
                Body.setVelocity(one, { 
                    x: Math.cos(angle) * force, 
                    y: Math.sin(angle) * force 
                });
                World.add(world, one);
                blocks.push(one);
            }
        }
    });





    // Ω Party Logic
    const partyBlocks = blocks.filter(b => b && b.renderData && b.renderData.number === 'Ω');
    partyBlocks.forEach(b => {
        if (b) Body.rotate(b, 0.15);
    });

    // Previously we removed blocks that touched the visible dirt/ground surface.
    // That behavior has been disabled so blocks remain on the ground; we keep a harmless grounding flag instead.
    try {
        const groundLineY = height; // visual ground/dirt line used throughout renderer
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            if (!b || !b.renderData) continue;
            // Skip angels and any block already in special transforms; require a sensible position
            if (b.isAngel || b.isTransforming) continue;
            if (!isFinite(b.position.y)) continue;

            // Make negative-number blocks visible on the ground: if a negative block has fallen well below the visible area,
            // teleport it up onto the visible ground and settle it so it remains visible to the player.
            try {
                const numericLabel = (typeof b.renderData.number === 'number') ? b.renderData.number : (parseFloat(b.renderData.number) || NaN);
                if (Number.isFinite(numericLabel) && numericLabel < 0) {
                    // if it's far below the visible ground, snap it up a bit so players can see negatives on the ground
                    if (b.position.y > groundLineY + UNIT_SIZE) {
                        try {
                            Body.setPosition(b, { x: b.position.x, y: groundLineY - UNIT_SIZE / 2 });
                            Body.setVelocity(b, { x: 0, y: 0 });
                            Body.setAngularVelocity(b, 0);
                            b.isGrounded = true;
                        } catch (err) {
                            // ignore reposition errors
                        }
                    }
                }
            } catch (err) {
                // ignore numeric parsing errors and continue
            }

            // Consider the block touching dirt when its center goes below the ground line minus a small margin
            const touchThreshold = groundLineY - UNIT_SIZE * 0.35;
            if (b.position.y >= touchThreshold) {
                // Mark block as grounded for other logic/UI (no removal).
                if (!b.isGrounded) {
                    b.isGrounded = true;
                    // Optional: slightly damp motion to make grounded blocks settle
                    try {
                        Body.setVelocity(b, { x: b.velocity.x * 0.2, y: Math.min(b.velocity.y, 2) });
                        Body.setAngularVelocity(b, 0);
                    } catch (e) { /* ignore physics adjustment errors */ }
                }
            } else {
                // Clear grounded flag if it moves up again
                if (b.isGrounded) b.isGrounded = false;
            }
        }
    } catch (e) {
        // safety: do not allow this housekeeping to break the update loop
    }

    // Void / Negative Area Logic
    blocks.forEach((b, index) => {
        if (!b || !b.renderData || b.isTransforming) return;
        
        // If falling deep into the "endless void" (past Y=2000)
        if (b.position.y > 2500) {
            const val = getNumericValue(b.renderData.number);
            
            // If it's a positive number, transform it to negative
            if (val > 0) {
                b.isTransforming = true; // Prevent double-triggering
                const newVal = -Math.abs(val);
                
                // We create a new negative block at the same spot
                const newBlock = createNumberBlock(b.position.x, b.position.y, newVal, UNIT_SIZE, currentArrangement);
                
                // Inherit velocity
                Body.setVelocity(newBlock, b.velocity);
                
                World.remove(world, b);
                World.add(world, newBlock);
                blocks[index] = newBlock;
                
                speak(newVal, "I'm negative now!");
                playSound('pop');
            } else if (val < 0 && b.position.y > 10000) {
                // If it's already negative and fell extremely far, teleport it back up into the "Negative Area"
                // so they don't fall forever and cause physics lag
                Body.setPosition(b, { x: b.position.x, y: 5000 });
                Body.setVelocity(b, { x: 0, y: 0 });
            }
        }
    });




    // Fly-to-space merged "gay" logic: marked blocks ascend and remove themselves when far enough
    const flyToSpaceBlocks = blocks.filter(b => b && b.flyToSpace);
    flyToSpaceBlocks.forEach(b => {
        if (!b) return;
        try {
            // Apply a steady upward impulse; scale by mass so different sizes behave predictably
            Body.applyForce(b, b.position, { x: (Math.random() - 0.5) * 0.02 * b.mass, y: -0.06 * b.mass });
            // Give them a slight spin
            Body.setAngularVelocity(b, (b.angularVelocity || 0) + (Math.random() - 0.5) * 0.02);
            // If the block has reached high altitude, remove it and play the delete sound once
            if (b.position.y < -5000) {
                World.remove(world, b);
                blocks = blocks.filter(x => x !== b);
                playSound('delete');
            }
        } catch (e) {
            // ignore any transient physics errors
        }
    });

    // Evil behavior disabled for 667/666 (previous aggressive logic removed)



    const speed = 10 / camera.zoom;
    if (keys['KeyW'] || keys['ArrowUp']) camera.y -= speed;
    if (keys['KeyS'] || keys['ArrowDown']) camera.y += speed;
    if (keys['KeyA'] || keys['ArrowLeft']) camera.x -= speed;
    if (keys['KeyD'] || keys['ArrowRight']) camera.x += speed;
    
    if (keys['Equal'] || keys['NumpadAdd']) {
        const zoomFactor = 1.05;
        const centerX = width / 2;
        const centerY = height / 2;
        const worldX = camera.x + centerX / camera.zoom;
        const worldY = camera.y + centerY / camera.zoom;
        // clamp keyboard zoom-in to MIN_ZOOM..MAX_ZOOM
        camera.zoom = clampZoom(camera.zoom * zoomFactor);
        camera.x = worldX - centerX / camera.zoom;
        camera.y = worldY - centerY / camera.zoom;
    }
    if (keys['Minus'] || keys['NumpadSubtract']) {
        const zoomFactor = 0.95;
        const centerX = width / 2;
        const centerY = height / 2;
        const worldX = camera.x + centerX / camera.zoom;
        const worldY = camera.y + centerY / camera.zoom;
        // clamp keyboard zoom-out to MIN_ZOOM..MAX_ZOOM
        camera.zoom = clampZoom(camera.zoom * zoomFactor);
        camera.x = worldX - centerX / camera.zoom;
        camera.y = worldY - centerY / camera.zoom;
    }
    
    if (keys['KeyW'] || keys['ArrowUp'] || keys['KeyS'] || keys['ArrowDown'] || 
        keys['KeyA'] || keys['ArrowLeft'] || keys['KeyD'] || keys['ArrowRight'] ||
        keys['Equal'] || keys['Minus']) {
        updateMouseTransform();
    }

    // Keep the physics ground centered beneath the viewport so it behaves as an endless ground horizontally.
    // Use the canvas center in world coordinates (accounting for zoom) to position the huge static ground.
    try {
        Body.setPosition(ground, { x: camera.x + (width / (2 * camera.zoom)), y: height + 100 });
    } catch (e) {
        // ignore if ground isn't available yet
    }

    // Angel Spawning Logic
    const currentTime = Date.now();
    if (currentTime - lastAngelCheckTime > 1000) {
        lastAngelCheckTime = currentTime;
        // Angel auto-spawn disabled to stop periodic spawning of angel blocks.
        // (Previous behavior: if altitude > spaceThreshold and random chance, spawn(randomAngel, true);)
    }
});

// Angel Numbers Logic
const angelNumbers = [11, 22, 33, 44, 55, 77, 88, 99, 111, 222, 333, 444, 555, 777, 888, 999, 1010, 1111, 1212, 1234];
let lastAngelCheckTime = 0;

 // Update chasers each physics tick: previously chasers chased the camera and could crash the scene.
 // This handler now preserves the existing red zone detection but does NOT spawn or update chasers,
 // effectively removing chasing polygons and any crash behavior while keeping the rest of the tick safe.
 Events.on(runner, 'beforeUpdate', () => {
     try {
         const altitude = -camera.y;
         const blocksAbove = Math.round(altitude / UNIT_SIZE);
         const redZoneActive = blocksAbove >= 600;

         // Ensure no chasers are active (clear any leftover entries)
         if (!redZoneActive && chasers.length > 0) {
             chasers.length = 0;
         }

         // Intentionally do NOT spawn or update chasers when in red zone.
         // This disables the previous chase/crash behavior.
     } catch (e) {
         // don't break physics loop on errors
         console.warn("Chaser update error:", e);
     }
 });

// Pre-generate star field for "Better Space"
const starField = Array.from({ length: 120 }, () => ({
    x: Math.random() * 12000 - 6000,
    y: Math.random() * 9000 - 8000,
    size: Math.random() * 1.6 + 0.2,
    twinkle: Math.random() * Math.PI,
    speed: 0.01 + Math.random() * 0.03,
    color: ['#ffffff', '#fff0f0', '#f0f0ff', '#ffffd0', '#ffebff', '#e0ffff'][Math.floor(Math.random() * 6)],
    glow: Math.random() > 0.98 // even rarer glow to save draw cost
}));

// Procedural nebulae (reduced for performance)
const nebulaField = Array.from({ length: 3 }, () => ({
    x: Math.random() * 10000 - 5000,
    y: Math.random() * 7000 - 6000,
    radius: 600 + Math.random() * 900,
    color: [
        'rgba(100, 50, 200, 0.12)', 
        'rgba(50, 100, 255, 0.08)', 
        'rgba(200, 50, 100, 0.10)', 
        'rgba(0, 150, 150, 0.06)'
    ][Math.floor(Math.random() * 4)],
    parallax: 0.04 + Math.random() * 0.04
}));

// Pillar field used by Fritz Zone: store simple screen-space pillar descriptors so we can draw many
// decorative pillars above the water plane without adding physics bodies (keeps performance stable).
const pillarField = Array.from({ length: 12 }, (_, i) => ({
    // horizontal placement will be interpreted in screen-space during render to keep layout stable
    sx: Math.random(),                 // relative x across the screen [0..1]
    height: 120 + Math.random() * 420, // pillar height in px
    width: 18 + Math.random() * 36,    // pillar width in px
    shade: 0.85 + Math.random() * 0.15,// slight shade variation
    wobbleSeed: Math.random() * 1000   // per-pillar time offset for a subtle shimmer
}));

const shootingStars = [];

// Red Zone chasers (spawned when very high altitude) — simple lightweight pursuers that chase the camera.
// Each chaser has { x, y, vx, vy, size, life } in world coordinates; they steer toward camera and can "crash" the scene.
const chasers = [];
function spawnChasers(count = 12) {
    chasers.length = 0;
    for (let i = 0; i < count; i++) {
        chasers.push({
            x: (Math.random() - 0.5) * 1200 + (Math.random() > 0.5 ? camera.x - 800 : camera.x + 800),
            y: (Math.random() - 0.5) * 800 + (Math.random() > 0.5 ? camera.y - 1200 : camera.y - 800),
            vx: (Math.random() - 0.5) * 2,
            vy: (Math.random() - 0.5) * 2,
            size: 40 + Math.random() * 80,
            life: Infinity,
            hue: Math.floor(Math.random() * 40) // subtle variety in greyscale tint
        });
    }
}

/**
 * Draw a soft Milky Way band across the sky with some clustered star clouds and color variation.
 * Uses camera to parallax the band slightly so it feels distant and vast.
 */
function drawMilkyWay(ctx, canvas, cameraState, opacity) {
    // Only draw when visible area intersects the band region
    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity * 1.2);

    const bandCenterY = canvas.height * 0.35; // base screen position of band
    // Parallax: shift band slightly with cameraX and cameraY for depth feeling
    const shiftX = -cameraState.x * 0.02;
    const shiftY = -cameraState.y * 0.01;

    // Base soft gradient for the band
    const grad = ctx.createLinearGradient(0, bandCenterY - 200 + shiftY, 0, bandCenterY + 200 + shiftY);
    grad.addColorStop(0, 'rgba(255,255,255,0.02)');
    grad.addColorStop(0.2, 'rgba(230,230,255,0.06)');
    grad.addColorStop(0.45, 'rgba(200,220,255,0.12)');
    grad.addColorStop(0.55, 'rgba(200,220,255,0.08)');
    grad.addColorStop(0.8, 'rgba(230,230,255,0.04)');
    grad.addColorStop(1, 'rgba(255,255,255,0.0)');

    ctx.translate(shiftX, shiftY);
    ctx.fillStyle = grad;

    // Slight curve path for the band
    ctx.beginPath();
    const left = -canvas.width;
    const right = canvas.width * 2;
    ctx.moveTo(left, bandCenterY + Math.sin((left + cameraState.x) * 0.0005) * 40);
    for (let sx = left; sx <= right; sx += 60) {
        const y = bandCenterY + Math.sin((sx + cameraState.x) * 0.0005) * 40 + Math.cos((sx + cameraState.y) * 0.0003) * 10;
        ctx.lineTo(sx, y);
    }
    ctx.lineTo(right, bandCenterY + 300);
    ctx.lineTo(left, bandCenterY + 300);
    ctx.closePath();
    ctx.fill();

    // Add clustered star clouds along the band
    for (let i = 0; i < 120; i++) {
        const cx = (Math.random() * canvas.width - (cameraState.x * 0.02)) + Math.sin(i * 12.345) * 80;
        const cy = bandCenterY + (Math.random() - 0.5) * 160 + Math.cos(i * 7.89) * 20;
        const r = 0.6 + Math.random() * 3.2;
        const a = 0.05 + Math.random() * 0.25;
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${a * opacity})`;
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // Long faint streaks to suggest far spiral arms/streams
    ctx.strokeStyle = `rgba(255,255,240,${0.08 * opacity})`;
    ctx.lineWidth = 1;
    for (let s = 0; s < 6; s++) {
        ctx.beginPath();
        const ang = s * 0.6 + (cameraState.x % 1000) * 0.0002;
        const startX = Math.random() * canvas.width;
        ctx.moveTo(startX, bandCenterY - 80 + (s * 20));
        for (let t = 0; t < 200; t++) {
            const px = startX - t * 6;
            const py = bandCenterY + Math.sin(t * 0.01 + ang) * (30 + s * 6) + (t * 0.02) * (s - 3);
            ctx.lineTo(px, py);
        }
        ctx.stroke();
    }

    ctx.restore();
}

// Generate planets colored like Numberblocks 2-20
const planetField = [];
const pColorMap = {
    1: '#ff0000', 2: '#ff8800', 3: '#ffff00', 4: '#00bb00', 5: '#00ffff',
    6: '#8800ff', 7: '#ffffff', 8: '#ff00ff', 9: '#888888', 10: '#ffffff'
};
const pTensConfig = {
    10: { fill: '#ffffff', outline: '#ff0000' },
    20: { fill: '#FBCEB1', outline: '#ff8800' }
};

for (let i = 2; i <= 20; i++) {
    let fill, outline;
    if (i <= 10) {
        fill = pColorMap[i];
        outline = (i === 10) ? pTensConfig[10].outline : 'rgba(0,0,0,0.2)';
    } else {
        const t = Math.floor(i / 10) * 10;
        fill = pTensConfig[t]?.fill || '#ffffff';
        outline = pColorMap[i % 10] || 'rgba(0,0,0,0.2)';
    }
    
    planetField.push({
        x: Math.random() * 16000 - 8000,
        y: Math.random() * 10000 - 12000,
        radius: 40 + Math.random() * 120,
        fill: fill,
        outline: outline,
        parallax: 0.1 + Math.random() * 0.1,
        hasRings: (i % 5 === 0),
        ringAngle: (Math.random() - 0.5) * 0.5,
        craters: Array.from({ length: 4 }, () => ({
            lx: (Math.random() - 0.5) * 1.3,
            ly: (Math.random() - 0.5) * 1.3,
            r: 0.08 + Math.random() * 0.22
        })),
        moons: Math.random() > 0.7 ? Array.from({ length: Math.floor(Math.random() * 2) + 1 }, () => ({
            orbitRadius: 150 + Math.random() * 100,
            size: 5 + Math.random() * 10,
            speed: 0.001 + Math.random() * 0.002,
            angle: Math.random() * Math.PI * 2
        })) : []
    });
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

function getNumberColor(n) {
    if (n === 0.25) return '#FFB6C1'; 
    if (n === 0.75) return '#FF5E7E'; 
    if (n === 0.85) return '#FF3C89';
    if (n === 0.125) return '#FFD1DC'; 
    if (n === 0.975) return '#FF1493'; 
    if (n === 'pi' || n === 'Ω') return '#7FFF00'; 
    if (n === 'tan') return '#8A2BE2'; 
    if (n === 'infinity' || n === 'inf1' || n === 'μ' || n === 'Π') return '#808080';
    const floorN = Math.floor(n);
    const ceilN = Math.ceil(n);
    
    const getColor = (num) => {
        if (num === 0) return '#ffffff';
        if (num <= 10) return colorMap[num] || '#ffffff';
        const tens = Math.floor(num / 10) * 10;
        return (tensConfig[tens] || { fill: '#ffffff' }).fill;
    };

    if (floorN === ceilN) return getColor(floorN);
    return mixColors(getColor(floorN), getColor(ceilN));
}

// Audio Setup using WebAudio API and provided assets
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioBuffers = {};

async function loadSound(name, url) {
    try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        audioBuffers[name] = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.error("Failed to load sound:", url, e);
    }
}

loadSound('pop', './Add.wav');
loadSound('delete', './SubractDivide.wav');
loadSound('sixtyseven', './sixtyseven.mp3');
loadSound('nice', './nice.mp3');
loadSound('laugh', './laugh.mp3');
// Load the screen recording SFX for occasional explode playback
loadSound('screenrec', './ScreenRecording_04-11-2026 16-30-41_1.wav');
  // New: load an additional looping track ("Sides if peaceful extended.wav") and enable Play button when loaded
loadSound('music2', './Sides if peaceful extended.wav').then(() => {
    // Do NOT auto-start music; enable Play button when loaded.
    // Update Now Playing text if the UI exists
    const nowEl = document.getElementById('now-playing');
    if (nowEl) {
        nowEl.textContent = `Now Playing: Sides if peaceful extended.wav`;
    }
    // Reveal Play button if overlay present
    const playBtn = document.getElementById('play-btn');
    const loadingSub = document.querySelector('.loading-sub');
    const loadingCircle = document.querySelector('.loading-circle');
    if (playBtn) {
        // enable and remove disabled visual state so the pink styling and bounce return
        playBtn.disabled = false;
        // ensure focusability and visual reflow
        try { playBtn.focus && playBtn.blur && playBtn.blur(); } catch(e) {}
        if (loadingSub) {
            loadingSub.textContent = 'Ready';
        }

        // Morph the loading circle into a green check mark
        if (loadingCircle) {
            // Stop spinner animation and replace inner content with an SVG check
            loadingCircle.style.animation = 'none';
            loadingCircle.style.border = 'none';
            loadingCircle.style.boxShadow = 'none';
            // Inline SVG check mark (keeps file self-contained, avoids data URLs)
            loadingCircle.innerHTML = `
                <svg width="72" height="72" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="12" r="11" fill="#2e7d32"/>
                  <path d="M6.5 12.2l2.8 2.8 6.2-6.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            `;
            // Add a brief scale/pop animation for delight
            loadingCircle.animate([
                { transform: 'scale(0.6)', opacity: 0 },
                { transform: 'scale(1.08)', opacity: 1 },
                { transform: 'scale(1)', opacity: 1 }
            ], { duration: 540, easing: 'cubic-bezier(.2,.9,.2,1)' });
        }

        // If user already requested Play while buffer was loading, auto-start playback now
        try {
            if (musicAutoStartRequested && audioBuffers['music2'] && !isMusicPlaying) {
                startMusicLoop();
            }
        } catch (e) {
            // ignore startup errors
        }
    }
}).catch(() => {
    const loadingSub = document.querySelector('.loading-sub');
    if (loadingSub) loadingSub.textContent = 'Loaded (audio unavailable)';
});
// click SFX
loadSound('dtrack', './d.wav');
loadSound('click', './mouse-click-290204.mp3');

// Hook up the Play button behavior to hide the loading overlay and allow audio/context resume.
window.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('loading-overlay');
    const playBtn = document.getElementById('play-btn');
    const loadingSub = document.querySelector('.loading-sub');
    if (playBtn) {
        // start disabled; the music loader will enable the Play button and restore its color once ready
        playBtn.disabled = true;
        playBtn.addEventListener('click', async () => {
            try {
                if (audioCtx.state === 'suspended') await audioCtx.resume();
            } catch (e) {}
            // remember user's intent to start music; if buffer ready start now, otherwise auto-start once loaded
            musicAutoStartRequested = true;
            if (audioBuffers['music2'] && !isMusicPlaying) {
                startMusicLoop();
            }
            // hide overlay
            if (overlay) overlay.classList.add('hidden');
            // tiny click feedback
            playSound('click');
        });
    }



    // Hot popup setup: "Thanks For Hot Page!" with image
    try {
        const hotOverlay = document.getElementById('hot-popup');
        const hotClose = document.getElementById('hot-popup-close');
        const hotOk = document.getElementById('hot-popup-ok');

        function hideHot() {
            try {
                if (!hotOverlay) return;
                hotOverlay.style.display = 'none';
                playSound('click');
            } catch (e) {}
        }
        function showHot() {
            try {
                if (!hotOverlay) return;
                hotOverlay.style.display = 'flex';
                // focus OK button for accessibility
                try { hotOk && hotOk.focus(); } catch(e){}
            } catch (e) {}
        }

        if (hotClose) hotClose.addEventListener('click', hideHot);
        if (hotOk) hotOk.addEventListener('click', hideHot);

        // Clicking outside panel closes popup
        if (hotOverlay) {
            hotOverlay.addEventListener('click', (ev) => {
                if (ev.target === hotOverlay) hideHot();
            });
        }

        // Allow Esc to close popup
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') hideHot();
        });

        // Show the popup shortly after DOM is ready, but wait until loading overlay is hidden
        const tryShowHot = () => {
            try {
                const overlayEl = document.getElementById('loading-overlay');
                if (!overlayEl || overlayEl.classList.contains('hidden') || overlayEl.style.display === 'none') {
                    showHot();
                } else {
                    setTimeout(tryShowHot, 250);
                }
            } catch (e) {}
        };
        setTimeout(tryShowHot, 900);
    } catch (e) {
        console.warn('Hot popup setup failed', e);
    }


});

let musicSource = null;
let music2Source = null;
let dSource = null; // new overlapping track source

// If user clicks Play before the music buffer finishes loading, remember the intent and auto-start when ready.
let musicAutoStartRequested = false;

// Playback tracking for seeking
let musicStartTime = 0;   // audioCtx.currentTime when playback started
let musicOffset = 0;      // seconds into the buffer when playback last started
let isMusicPlaying = false;

// Master gain for overall music control (keeps behavior consistent)
let musicMasterGain = audioCtx.createGain();
// increase default master volume so UI slider has more headroom (120 out of 200)
musicMasterGain.gain.value = 1.2;
musicMasterGain.connect(audioCtx.destination);

// SFX master gain (separate so SFX and music can be balanced)
let sfxGain = audioCtx.createGain();
// raise default SFX level to be louder by default
sfxGain.gain.value = 1.6;
sfxGain.connect(audioCtx.destination);

// Individual gains to control relative volumes if desired
let musicGain = audioCtx.createGain();
musicGain.gain.value = 0.7;
musicGain.connect(musicMasterGain);

let music2Gain = audioCtx.createGain();
music2Gain.gain.value = 0.55; // slightly lower by default
music2Gain.connect(musicMasterGain);

// Gain for the added overlapping d.wav track; keep it a bit quieter so it layers
let dGain = audioCtx.createGain();
dGain.gain.value = 0.48;
dGain.connect(musicMasterGain);

function startMusicLoop() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (!audioBuffers['music2']) return;
    stopMusicLoop();

    const now = audioCtx.currentTime;
    // ensure offset is within buffer length
    const buf = audioBuffers['music2'];
    if (!buf) return;
    musicOffset = Math.max(0, Math.min(musicOffset || 0, buf.duration - 0.0001));

    // Start the secondary track with offset, looping
    music2Source = audioCtx.createBufferSource();
    music2Source.buffer = buf;
    music2Source.loop = true;
    music2Source.connect(music2Gain);
    try { music2Source.start(now, musicOffset % buf.duration); } catch (e) {}

    // Start overlapping dtrack at same offset if available
    if (audioBuffers['dtrack']) {
        const dBuf = audioBuffers['dtrack'];
        dSource = audioCtx.createBufferSource();
        dSource.buffer = dBuf;
        dSource.loop = true;
        try { dSource.connect(dGain); } catch (e) { dSource.connect(music2Gain); }
        try { dSource.start(now, musicOffset % dBuf.duration); } catch (e) {}
    }

    // record start time for seeking math
    musicStartTime = audioCtx.currentTime - musicOffset;
    isMusicPlaying = true;

    const musicBtnEl = document.getElementById('music-btn');
    const nowEl = document.getElementById('now-playing');
    if (musicBtnEl) {
        musicBtnEl.textContent = 'Pause Music';
        musicBtnEl.classList.add('active');
    }
    if (nowEl) {
        nowEl.textContent = `Now Playing: Sides if peaceful extended.wav`;
    }
}

function stopMusicLoop() {
    // capture offset where we stopped so we can resume from same spot
    try {
        if (isMusicPlaying && audioBuffers['music2']) {
            const now = audioCtx.currentTime;
            const buf = audioBuffers['music2'];
            // compute elapsed since start and mod by duration
            musicOffset = (now - musicStartTime) % buf.duration;
            if (musicOffset < 0) musicOffset += buf.duration;
        }
    } catch (e) { /* ignore */ }

    // Stop & disconnect primary
    if (musicSource) {
        try {
            musicSource.onended = null;
            musicSource.stop(0);
        } catch (e) {}
        try { musicSource.disconnect(); } catch (e) {}
        musicSource = null;
    }
    // Stop & disconnect secondary
    if (music2Source) {
        try { music2Source.stop(0); } catch (e) {}
        try { music2Source.disconnect(); } catch (e) {}
        music2Source = null;
    }

    // Stop & disconnect the overlapping d track if present
    if (dSource) {
        try { dSource.stop(0); } catch (e) {}
        try { dSource.disconnect(); } catch (e) {}
        dSource = null;
    }

    isMusicPlaying = false;
    const musicBtnEl = document.getElementById('music-btn');
    const nowEl = document.getElementById('now-playing');
    if (musicBtnEl) {
        musicBtnEl.textContent = 'Play Music';
        musicBtnEl.classList.remove('active');
    }
    if (nowEl) nowEl.textContent = 'Now Playing: —';
}

// Hook up the music UI button so it toggles the loaded loop
(function setupMusicButton() {
    const musicBtn = document.getElementById('music-btn');
    if (!musicBtn) return;
    musicBtn.addEventListener('click', async () => {
        try {
            if (audioCtx.state === 'suspended') await audioCtx.resume();
        } catch (e) {}
        // If track isn't loaded yet, do nothing (button remains enabled when buffer ready)
        if (!audioBuffers['music2']) {
            // provide small feedback
            playSound('click');
            return;
        }
        if (isMusicPlaying) {
            stopMusicLoop();
        } else {
            startMusicLoop();
        }
    });
})();

const speechCache = new Map();
/**
 * speak(number, customText, body)
 * - Shows a speech bubble above the provided body (if given) for a short duration.
 * - Plays a small SFX for audible feedback (special-case: play sixtyseven clip for "67").
 * - Non-block calls are tolerated (will still play SFX).
 */
async function speak(number, customText = null, body = null) {
    try {
        // If speech has been muted globally, do not show bubbles or perform TTS
        if (!speechEnabled) {
            // ensure any existing speech bubble on this body is cleared
            try { if (body && body.renderData) { body.activeSpeech = null; body.speechExpiry = 0; } } catch (e) {}
            return;
        }

        // Compose text to display
        const text = (typeof customText === 'string' && customText.trim().length > 0) ? customText : String(number);

        // If a body is provided, attach speech data so renderer can draw a bubble
        if (body && body.renderData) {
            try {
                body.activeSpeech = text;
                // show speech for ~3 seconds
                body.speechExpiry = Date.now() + 3000;
            } catch (e) {
                // ignore body attachment errors
            }
        }

        // Play a short SFX: special-case for 67, otherwise a friendly pop
        try {
            const token = String(number).trim();
            const isSixtySevenToken = (token === '67' || token === 'sixtyseven' || token.toLowerCase() === 'sixtyseven');
            if (isSixtySevenToken) {
                playSound('sixtyseven');
            } else {
                playSound('pop');
            }

            // If the token is 67, skip TTS entirely (play SFX only).
            var skipTTS = isSixtySevenToken;
        } catch (e) {
            // ignore audio errors
            var skipTTS = false;
        }

        // Choose voice gender rules:
        // female: 1, 3, 5, 6, 10
        // male: 2, 4, 7, 8, 9
        // default to en-male if not matched.
        let voiceCode = 'en-male';
        try {
            const token = String(number).trim();
            // Try numeric detection first
            const n = parseFloat(token);
            const intN = Number.isFinite(n) ? Math.floor(Math.abs(n)) : null;

            const femaleSet = new Set([1,3,5,6,10]);
            const maleSet = new Set([2,4,7,8,9]);

            if (intN !== null && !isNaN(intN)) {
                if (femaleSet.has(intN)) voiceCode = 'en-female';
                else if (maleSet.has(intN)) voiceCode = 'en-male';
            } else {
                // also handle string tokens that represent those numbers directly
                const mapLabel = token.replace(/\s+/g,'').toLowerCase();
                if (['1','one'].includes(mapLabel)) voiceCode = 'en-female';
                if (['3','three'].includes(mapLabel)) voiceCode = 'en-female';
                if (['5','five'].includes(mapLabel)) voiceCode = 'en-female';
                if (['6','six'].includes(mapLabel)) voiceCode = 'en-female';
                if (['10','ten'].includes(mapLabel)) voiceCode = 'en-female';
                if (['2','two'].includes(mapLabel)) voiceCode = 'en-male';
                if (['4','four'].includes(mapLabel)) voiceCode = 'en-male';
                if (['7','seven'].includes(mapLabel)) voiceCode = 'en-male';
                if (['8','eight'].includes(mapLabel)) voiceCode = 'en-male';
                if (['9','nine'].includes(mapLabel)) voiceCode = 'en-male';
            }
        } catch (e) {
            voiceCode = 'en-male';
        }

        // Compute playbackRate modifier based on numeric value: smaller-than-one => higher playbackRate (squeakier).
        // Mapping: for positive numeric values < 1, playbackRate = 1 + (1 - value) * 1.8 (clamped 1..3)
        // For non-positive or non-numeric, use 1.
        let playbackRate = 1;
        try {
            const numVal = (typeof number === 'number') ? number : (parseFloat(String(number)) || NaN);
            if (Number.isFinite(numVal) && numVal > 0 && numVal < 1) {
                playbackRate = 1 + (1 - numVal) * 1.8;
                playbackRate = Math.min(3, Math.max(1, playbackRate));
            }
        } catch (e) {
            playbackRate = 1;
        }

        // Launch TTS via websim.textToSpeech when available (non-blocking).
        // We fetch the MP3, decode it into an AudioBuffer and play through the sfxGain node
        // so volume controls apply consistently. We adjust playbackRate to make small numbers squeakier.
        try {
            // Skip TTS for sixtyseven token to avoid speaking it
            if (!skipTTS && typeof window.websim !== 'undefined' && window.websim.textToSpeech) {
                // Request TTS with selected voice
                const ttsReq = await window.websim.textToSpeech({ text: String(text), voice: voiceCode }).catch(() => null);
                if (ttsReq && ttsReq.url) {
                    // fetch and decode into AudioBuffer
                    const resp = await fetch(ttsReq.url);
                    const arrayBuffer = await resp.arrayBuffer();
                    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
                    // create source and play via sfxGain (so master volume applies)
                    const src = audioCtx.createBufferSource();
                    src.buffer = decoded;
                    // apply playbackRate mapping computed above to make fractional small values sound squeakier
                    try { src.playbackRate.value = playbackRate; } catch (e) { try { src.playbackRate = playbackRate; } catch (err) {} }
                    try { src.connect(sfxGain); } catch (e) { src.connect(audioCtx.destination); }
                    src.start(0);
                }
            }
        } catch (e) {
            // don't let TTS failures break gameplay; fall back silently
            console.warn('TTS failed:', e);
        }
    } catch (err) {
        // swallow any speak errors to avoid breaking gameplay
        console.warn('speak() failed:', err);
    }
}

function playSound(name) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (!audioBuffers[name]) return;
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffers[name];
    // Route SFX through the sfxGain node so overall volume control applies
    try {
        source.connect(sfxGain);
    } catch (e) {
        // Fallback to direct destination if sfxGain not available
        source.connect(audioCtx.destination);
    }
    source.start(0);
}

const UNIT_SIZE = 40;
// Trail cache for rainbow trails (keyed by body.id)
const trails = new Map();
 // Soft cap on active blocks to avoid unbounded physics slowdown (lowered)
const MAX_BLOCKS = 150;
let blocks = [];
let isTimeStopped = false;
let currentArrangement = 'auto';

function spawn(number, isAngel = false, arrangement = null) {


    const margin = 100;
    // Spawn relative to camera viewport with extra jitter to prevent perfect stacking
    const viewportWidth = width / camera.zoom;
    const x = camera.x + viewportWidth / 2;
    // If it's an angel falling from space, spawn it higher up
    let y;
    if (isAngel) {
        y = camera.y - 400;
    } else {
        // Determine spawn height relative to the visible ground/dirt line.
        const groundLine = height;
        const val = getNumericValue(number);
        
        // Default spawn slightly above the camera center so new blocks are visible.
        y = camera.y + 100;
        
        // Make -1 spawn visibly on the ground (rather than deep in the dirt).
        if (val === -1) {
            y = groundLine - 80;
        } else if (val >= 0) {
            // If it's a positive number or zero, make sure it doesn't spawn below the visible ground.
            if (y > groundLine - 100) {
                y = groundLine - 100;
            }
        }
    }
    
    const block = createNumberBlock(x, y, number, UNIT_SIZE, currentArrangement);

    // Preserve explicit isAngel arg, and also treat the numeric token 777 as an angel automatically.
    block.isAngel = isAngel || (Number(number) === 777 || String(number) === '777');

    // 41 and 61 no longer auto-enter crazy mode
    
    // Make 559 start in crazy mode immediately (persistent playful jitter/spin, non-explosive)
    try {
        if (number === 559 || String(number) === '559') {
            block.isCrazy = true;
            block.isExplosive = false;
            // Initialize crazyData so it begins acting right away
            block.crazyData = { startTime: Date.now(), lastSoundTime: 0, state: 'crazy' };
        }
    } catch (e) { /* defensive noop */ }

    // Ensure exclusive behavior for six-seven variant
    if (block.isExplosive) block.isCrazy = false;



    World.add(world, block);
    blocks.push(block);

    // Snap newly spawned block to grid if grid mode is active
    try {
        if (gridMode) snapBlockToGrid(block);
    } catch (e) { /* ignore snapping errors */ }

    // Enforce global soft block cap to prevent physics slowdown
    if (blocks.length > MAX_BLOCKS) {
        // remove oldest blocks until under cap (prefer removing non-special ones first)
        const toRemove = [];
        for (let k = 0; k < blocks.length && blocks.length - toRemove.length > MAX_BLOCKS; k++) {
            const cand = blocks[k];
            // try to keep angels/flyToSpace/special; remove ordinary first
            if (!cand.isAngel && !cand.flyToSpace && !cand.isExplosive && !cand.isCrazy) {
                toRemove.push(cand);
            }
        }
        // If we still need to remove, remove from front
        let idx = 0;
        while (blocks.length - toRemove.length > MAX_BLOCKS && idx < blocks.length) {
            const cand = blocks[idx];
            if (!toRemove.includes(cand)) toRemove.push(cand);
            idx++;
        }
        toRemove.forEach(b => {
            try { World.remove(world, b); } catch (e) {}
            const i = blocks.indexOf(b);
            if (i !== -1) blocks.splice(i, 1);
        });
        // a small deletion cue so user notices trimming happened
        playSound('delete');
    }

    playSound('pop');
    if (!isAngel) speak(number, null, block);
}

// Merging & Social Logic
let lastGlobalSocialTime = 0;

Events.on(engine, 'afterUpdate', () => {
    const snapThreshold = UNIT_SIZE * 1.1;
    const socialThreshold = UNIT_SIZE * 5;
    const currentTime = Date.now();
    
    for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
            const bodyA = blocks[i];
            const bodyB = blocks[j];
            
            if (!bodyA || !bodyB || !bodyA.renderData || !bodyB.renderData) continue;
            
            const dist = Vector.magnitude(Vector.sub(bodyA.position, bodyB.position));
            
            // Social Interaction Logic
            if (dist < socialThreshold && !bodyA.isCrazy && !bodyB.isCrazy && !bodyA.isRedacted && !bodyB.isRedacted) {
                if (currentTime - (bodyA.lastTalkTime || 0) > 15000 && 
                    currentTime - (bodyB.lastTalkTime || 0) > 15000 && 
                    currentTime - lastGlobalSocialTime > 3000) {
                    
                    interact(bodyA, bodyB);
                    lastGlobalSocialTime = currentTime;
                    bodyA.lastTalkTime = currentTime;
                    bodyB.lastTalkTime = currentTime;
                }
            }

            const combinedSize = (bodyA.renderData.number + bodyB.renderData.number + 2);
            if (dist > Math.max(combinedSize, 2) * UNIT_SIZE) continue;

            let shouldMerge = false;
            
            // Special case for Zero: she has no units, so we check distance to her center
            if (bodyA.renderData.number === 0 || bodyB.renderData.number === 0) {
                if (dist < snapThreshold * 2) shouldMerge = true;
            } else {
                const unitsA = bodyA.renderData.units || [];
                const unitsB = bodyB.renderData.units || [];
                for (const uA of unitsA) {
                    const worldA = Vector.add(bodyA.position, Vector.rotate({ x: uA.localX, y: uA.localY }, bodyA.angle));
                    for (const uB of unitsB) {
                        const worldB = Vector.add(bodyB.position, Vector.rotate({ x: uB.localX, y: uB.localY }, bodyB.angle));
                        if (Vector.magnitude(Vector.sub(worldA, worldB)) < snapThreshold) {
                            shouldMerge = true;
                            break;
                        }
                    }
                    if (shouldMerge) break;
                }
            }

            if (shouldMerge) {
                mergeBlocks(bodyA, bodyB);
                return;
            }
        }
    }
});

async function interact(bodyA, bodyB) {
    const numA = bodyA.renderData.number;
    const numB = bodyB.renderData.number;
    
    const greetings = [
        `Hello ${numB}! I am ${numA}!`,
        `Hi ${numB}!`,
        `Nice to see you, ${numB}!`,
        `Look at us!`,
        `I'm ${numA}. How are you?`
    ];
    
    const responses = [
        `Hello ${numA}!`,
        `Hi! I'm ${numB}!`,
        `Greetings!`,
        `We make ${numA + numB} together!`,
        `I am feeling great!`
    ];

    const greet = greetings[Math.floor(Math.random() * greetings.length)];
    const respond = responses[Math.floor(Math.random() * responses.length)];

    await speak(numA, greet, bodyA);
    
    // Slight delay for response
    setTimeout(() => {
        // Check if blocks still exist
        if (blocks.includes(bodyB)) {
            speak(numB, respond, bodyB);
        }
    }, 1500);
}

function getNumericValue(number) {
    if (typeof number === 'number') return number;
    if (typeof number !== 'string') return 0;
    if (number.startsWith('√')) return Math.sqrt(parseFloat(number.substring(1)));
    if (number === 'pi' || number === 'Π') return Math.PI;
    if (number === 'Ω') return 1;
    if (number === 'μ') return 2;
    if (number === 'tan') return 1;
    if (number === 'infinity' || number === 'inf1') return 1000;
    if (/^[A-Z]$/.test(number)) return 1;
    const p = parseFloat(number);
    // Treat values very close to 1 as exactly 1 to avoid tiny rounding issues (e.g., "0.999" + "0.111..." => 1)
    if (!isNaN(p) && Math.abs(p - 1) < 0.0005) return 1;
    return isNaN(p) ? 0 : p;
}

function mergeBlocks(bodyA, bodyB) {
    if (!bodyA.renderData || !bodyB.renderData) return;
    const unitSize = UNIT_SIZE;
    const valA = getNumericValue(bodyA.renderData.number);
    const valB = getNumericValue(bodyB.renderData.number);

    // Handle special symbolic and non-numeric merges safely
    let totalNumber;
    const aLabel = bodyA.renderData.number;
    const bLabel = bodyB.renderData.number;
    const isPiA = (aLabel === 'pi' || aLabel === 'PI' || aLabel === 'π' || aLabel === 'Π');
    const isPiB = (bLabel === 'pi' || bLabel === 'PI' || bLabel === 'π' || bLabel === 'Π');

    // If both are explicit pi tokens produce combined pi label
    if (isPiA && isPiB) {
        totalNumber = 'ππ';
    } else {
        // Determine if labels are numeric-literal types (actual numbers or numeric strings)
        const aIsNumericLabel = (typeof aLabel === 'number') || (/^-?\d+(\.\d+)?$/.test(String(aLabel)));
        const bIsNumericLabel = (typeof bLabel === 'number') || (/^-?\d+(\.\d+)?$/.test(String(bLabel)));

        if (aIsNumericLabel && bIsNumericLabel) {
            // Safe numeric addition for numeric labels
            totalNumber = valA + valB;
        } else {
            // At least one label is non-numeric (like 'hi', 'you', 'suck', 'DOG', etc.)
            // Concatenate labels to make a stable, non-numeric label instead of trying to add numbers.
            // Use a single space separator for readability.
            const safeA = (aLabel === undefined || aLabel === null) ? '' : String(aLabel);
            const safeB = (bLabel === undefined || bLabel === null) ? '' : String(bLabel);
            // If both labels look like single characters or words, join with a space; otherwise fall back to concatenation.
            totalNumber = `${safeA}${safeA && safeB ? ' ' : ''}${safeB}`;
            // Trim accidental empty results
            totalNumber = totalNumber.trim() || 0;
        }
    }

    // Collect world-space unit positions to preserve shape
    const unitsA = (bodyA.renderData.units || []).map(u => {
        const rotated = Vector.rotate({ x: u.localX, y: u.localY }, bodyA.angle);
        return { ...u, worldX: bodyA.position.x + rotated.x, worldY: bodyA.position.y + rotated.y };
    });
    const unitsB = (bodyB.renderData.units || []).map(u => {
        const rotated = Vector.rotate({ x: u.localX, y: u.localY }, bodyB.angle);
        return { ...u, worldX: bodyB.position.x + rotated.x, worldY: bodyB.position.y + rotated.y };
    });
    const allUnits = [...unitsA, ...unitsB];
    if (allUnits.length === 0) return;

    // Identity property of zero: 0 + X = X
    if (bodyA.renderData.number === 0 || bodyB.renderData.number === 0) {
        const nonZero = bodyA.renderData.number === 0 ? bodyB : bodyA;
        const zero = bodyA.renderData.number === 0 ? bodyA : bodyB;
        World.remove(world, zero);
        blocks = blocks.filter(b => b !== zero);
        playSound('pop');
        return;
    }

    // Snap units to grid relative to each other - prefer a full block as reference for cleaner grid alignment
    const ref = allUnits.find(u => !u.isHalf) || allUnits[0];
    let snappedUnits = allUnits.map(u => {
        let dx = u.worldX - ref.worldX;
        let dy = u.worldY - ref.worldY;
        
        // Snap to strictly 1x1 grid increments
        dx = Math.round(dx / unitSize) * unitSize;
        dy = Math.round(dy / unitSize) * unitSize;
        
        return { ...u, relX: dx, relY: dy };
    });

    // Logic to merge two half blocks into a full block if they overlap
    const finalUnitsMap = new Map();
    snappedUnits.forEach(u => {
        const key = `${u.relX},${u.relY}`;
        if (finalUnitsMap.has(key)) {
            const existing = finalUnitsMap.get(key);
            if (existing.isHalf && u.isHalf) {
                // Two halves in same spot = one full
                existing.isHalf = false;
            }
        } else {
            finalUnitsMap.set(key, { ...u });
        }
    });

    const processedUnits = Array.from(finalUnitsMap.values());

    // Calculate new center of mass based on snapped positions
    const avgRelX = processedUnits.reduce((sum, u) => sum + u.relX, 0) / processedUnits.length;
    const avgRelY = processedUnits.reduce((sum, u) => sum + u.relY, 0) / processedUnits.length;
    
    // World space center
    const newWorldX = ref.worldX + avgRelX;
    const newWorldY = ref.worldY + avgRelY;

    // We remove explicit color preservation to allow the block factory 
    // to re-color the merged block according to its new numeric identity 
    // (e.g., 1+1=2 becomes orange).
    let customUnits;
    if (currentArrangement === 'most-rect') {
        // Build a "most rectangular" packing for the total number of units.
        // Bias width to be wider than a perfect square for a low-height rectangle (same heuristic as blockFactory).
        const total = processedUnits.length;
        const targetBias = 1.6;
        let guessedCols = Math.max(1, Math.round(Math.sqrt(total) * targetBias));
        guessedCols = Math.min(Math.max(guessedCols, 1), Math.max(1, Math.ceil(total)));
        const guessedRows = Math.ceil(total / guessedCols);

        customUnits = [];
        // Fill from bottom-to-top so "ones" appear at the top, matching renderer expectations
        let count = 0;
        for (let r = guessedRows - 1; r >= 0; r--) {
            for (let c = 0; c < guessedCols; c++) {
                if (count >= total) break;
                const lx = (c - (guessedCols - 1) / 2) * unitSize;
                const ly = (r - (guessedRows - 1) / 2) * unitSize;
                customUnits.push({
                    localX: lx,
                    localY: ly,
                    isHalf: false,
                    isQuarter: false,
                    isThreeQuarters: false
                });
                count++;
            }
            if (count >= total) break;
        }
    } else {
        customUnits = processedUnits.map(u => ({
            localX: u.relX - avgRelX,
            localY: u.relY - avgRelY,
            isHalf: u.isHalf,
            isQuarter: u.isQuarter,
            isThreeQuarters: u.isThreeQuarters
        }));
    }

    World.remove(world, bodyA);
    World.remove(world, bodyB);
    blocks = blocks.filter(b => b !== bodyA && b !== bodyB);

    // Re-create block keeping the shape by passing custom units
    const newBlock = createNumberBlock(newWorldX, newWorldY, totalNumber, unitSize, currentArrangement, customUnits);

    // Re-apply special behaviors
    if (getNumericValue(totalNumber) === 69 || getNumericValue(totalNumber) === 690) {
        newBlock.isNice = true;
        Body.setInertia(newBlock, newBlock.mass * 100);
    }

    // Special: if the merged label resolves to "gay" or "shit" (any case/spacing) send it to space to self-delete
    const normalizedLabel = String(totalNumber).toLowerCase().replace(/\s+/g, '');
    if (['gay', 'shit', 'fuck'].includes(normalizedLabel)) {
        newBlock.flyToSpace = true; // mark for upward force + self-deletion
        newBlock.isAngel = true; // visual halo/behavior
    }

    World.add(world, newBlock);
    blocks.push(newBlock);
    // Ensure merged results that equal 7 keep rainbow striping:
    try {
        const numericTotal = getNumericValue(totalNumber);
        if (Number.isFinite(numericTotal) && Math.floor(numericTotal) === 7 && newBlock.renderData && Array.isArray(newBlock.renderData.units)) {
            const rainbow = ['#8800ff', '#4b0082', '#0000ff', '#00ff00', '#ffff00', '#ff8800', '#ff0000'];
            newBlock.renderData.units.forEach((u, idx) => {
                const r = (typeof u.row === 'number' ? u.row : 0);
                const c = (typeof u.col === 'number' ? u.col : idx);
                u.color = rainbow[(r + c) % rainbow.length];
                if (!u.outlineColor) u.outlineColor = '#5a005a';
            });
            // flag for any renderer logic that might check it
            newBlock.renderData.forceRainbowSeven = true;
        }
    } catch (e) {
        // non-fatal: continue if recolor fails
    }
    playSound('pop');
    speak(totalNumber, null, newBlock);
}

function resetCamera() {
    camera = { x: 0, y: 0, zoom: 1 };
    updateMouseTransform();
}

// UI Handlers - Generate buttons 1-100
const buttonRow = document.getElementById('spawn-buttons');
const colorMap = {
    1: '#ff0000', 2: '#ff8800', 3: '#ffff00', 4: '#00bb00', 5: '#00ffff',
    6: '#8800ff', 7: '#8800ff', 8: '#ff00ff', 9: '#888888', 10: '#bdbdbd'
};
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

const mainSpawnNumbers = [
    // Core & special tokens
    'random', 0, -1, -3, -2, 0.001, 0.01, 0.05, 0.1, 0.5, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,

    // Teens and assorted
    31, 32, 33, 34, 35, 36, 37, 38, 39,

    // Tens
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100,

    // Larger round numbers & common powers
    110, 111, 121, 125, 128, 144, 169, 196, 200, 250, 300, 400, 404, 420, 500, 559, 600, 700, 727, 800, 900, 1000, 2000, 5000, 9000, 10000,

    // Fractions & small rationals
    0.125, 0.1666, 0.25, 0.333, 0.111, 0.5, 0.666, 0.75, 0.85, 0.875, 0.975, 10.1, 3.1415, 2.718,

    // Operators, symbols and words
    '+', '-', '^', '*', '÷', '×', '/', 'random',
    'pi', 'PI', 'ππ', 'πππ', 'tan', 'infinity', 'inf1', 'μ', 'Π', 'Ω',
    '¶', '§', '∆', 'ⁿ', '⁰', '∅',
    '.', ',', ' ', ';', ':', '$', '#', '@',

    // Words and fun tokens
    'AB', 'ABB', 'DUCK', 'CAT', 'CAN', 'DOG', 'laugh', 'laughing', 'laughing 1',
    'omega', 'derk', 'HELLO??', "What? I can't hear you!", 'gold 1', 'hi', 'am', 'you', 'suck',
    'supercalifragilisticexpialidocious', 'would', 'like', 'to', 'order', 'please',
    'multipling ones',

    // Variants, long strings and test tokens
    'pi0', 'pi00', 'pi000',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'pneumonoultramicroscopicsilicovolcanoconiosis',
    '1 decillion', 'Base 100', 'extended 3', 'real 200', 'real 300', 'real 400',

    // 2D / 3D / visual tokens
    '2D', '3D',

    // Additional special numeric shapes and requests
    31, 32, 33, 34, 35, 36, 37, 38, 39, // repeated intentionally to keep nearby grouping in UI after sort/dedupe logic
    41, 42, 43, 44, 45, 46, 47, 48, 49,
    64, 69, 66, 77, 88, 99, 110, 121, 125, 144, 169, 196, 225, 256,

    // Powers and cubes for visual interest
    216, 343, 512, 729, 1000, 4096, 10000, 100000,

    // Large primes and sample primes for educational play
    101, 103, 107, 109, 113, 127, 131, 137, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199,

    // Misc numeric curiosities
    666, 777, 1001, 1331, 1337, 2020, 2021, 2022, 2023,

    // Ensure some requested specific layouts remain present
    29, 34, 37, 38, 43, 47, 69, 67,

    // Ensure 1 and 2 are present
    1, 2
];

/* Removed generation of Base 1, Base 11, ..., Base 91 per request */
mainSpawnNumbers.push(1.75);
mainSpawnNumbers.push(6.9);
mainSpawnNumbers.push('Methionylthreonylthreonylglutaminylarginyltyrosylglutamylserylleucylphenylalanylalanylglutaminylleucyllysylglutamylarginyllysylglutamylglycylalanylphenylalanylvalylprolylphenylalanylvalylthreonylleucylglycylaspartylprolylglycylisoleucylglutamylglutaminylserylleucyllysylisoleucylaspartylthreonylleucylisoleucylglutamylalanylglycylalanylaspartylalanylleucylglutamylleucylglycylisoleucylprolylphenylalanylserylaspartylprolylleucylalanylaspartylglycylprolylthreonylisoleucylglutaminylasparaginylalanylthreonylleucylarginylalanylphenylalanylalanylalanylglycylvalylthreonylprolylalanylglutaminylcysteinylphenylalanylglutamylmethionylleucylalanylleucylisoleucylarginylglutaminyllysylhistidylprolylthreonylisoleucylprolylisoleucylglycylleucylleucylmethionyltyrosylalanylasparaginylleucylvalylphenylalanylasparaginyllysylglycylisoleucylaspartylglutamylphenylalanyltyrosylalanylglutaminylcysteinylglutamyllysylvalylglycylvalylaspartylserylvalylleucylvalylalanylaspartylvalylprolylvalylglutaminylglutamylserylalanylprolylphenylalanylarginylglutaminylalanylalanylleucylarginylhistidylasparaginylvalylalanylprolylisoleucylphenylalanylisoleucylcysteinylprolylprolylaspartylalanylaspartylaspartylaspartylleucylleucylarginylglutaminylisoleucylalanylseryltyrosylglycylarginylglycyltyrosylthreonyltyrosylleucylleucylserylarginylalanylglycylvalylthreonylglycylalanylglutamylasparaginylarginylalanylalanylleucylprolylleucylasparaginylhistidylleucylvalylalanyllysylleucyllysylglutamyltyrosylasparaginylalanylalanylprolylprolylleucylglutaminylglycylphenylalanylglycylisoleucylserylalanylprolylaspartylglutaminylvalyllysylalanylalanylisoleucylaspartylalanylglycylalanylalan ylglycylalanylisoleucylserylglycylserylalanylisoleucylvalyllysylisoleucylisoleucylglutamylglutaminylhistidylasparaginylisoleucylglutamylprolylglutamyllysylmethionylleucylalanylalanylleucyllysylvalylphenylalany lvalylglutaminylprolylmethionyllysylalanylalanylthreonylarginylacetylseryltyrosylserylisoleucylthreonylserylprolylserylglutaminylphenylalanylvalylphenylalanylleucylserylserylvalyltryptophylalanylaspartylprolylisoleucylglutamylleucylleucylasparaginylvalylcysteinylthreonylserylserylleucylglycylasparaginylglutaminylphenylalanylglutaminylthreonylglutaminylglutaminylalanylarginylthreonylthreonylglutaminylvalylglutaminylglutaminylphenylalanylserylglutaminylvalyltryptophyllysylprolylphenylalanylprolylglutaminylserylthreonylvalylarginylphenylalanylprolylglycylaspartylvalyltyrosyllysylvalyltyrosylarginyltyrosylasparaginylalanylvalylleucylaspartylprolylleucylisoleucylthreonylalanylleucylleucylglycylthreonylphenylalanylaspartylthreonylarginylasparaginylarginylisoleucylisoleucylglutamylvalylglutamylasparaginylglutaminylglutaminylserylprolylthreonylthreonylalanylglutamylthreonylleucylaspartylalanylthreonylarginylarginylvalylaspartylaspartylalanylthreonylvalylalanylisoleucylarginylserylalanylasparaginylisoleucylasparaginylleucylvalylasparaginylglutamylleucylvalylarginylglycylthreonylglycylleucyltyrosylasparaginylglutaminylasparaginylthreonylphenylalanylglutamylserylmethionylserylglycylleucylvalyltryptophylthreonylserylalanylprolylalanyltitinmethionylglutaminylarginyltyrosylglutamylserylleucylphenylalanylalanylisoleucylcysteinylprolylprolylaspartylalanylaspartylaspartylaspartylleucylleucylarginylglutaminylisoleucylalanylseryltyrosylglycylarginylglycyltyrosylthreonyltyrosylleucylleucylserylarginylalanylglycylvalylthreonylglycylalany lglutamylasparaginylarginylalanylalanylleucylprolylleucylasparaginylhistidylleucylvalylalanyllysylleucyllysylglutamyltyrosylasparaginylalanylalanylprolylprolylleucylglutaminylglycylphenylalanylglycylisoleucylserylalanylprolylaspartylglutaminylvalyllysylalanylalanylisoleucylaspartylalanylglycylalanylalanylglycylalanylisoleucylserylglycylserylalanylisoleucylvalyllysylisoleucylisoleucylglutamylglutaminylhistidylasparaginylisoleucylglutamylprolylglutamyllysylmethionylleucylalanylalanylleucyllysylvalylphenylalanylvalylglutaminylprolylmethionyllysylalanylalanylthreonylarginylacetylseryltyrosylserylisoleucylthreonylserylprolylserylglutaminylphenylalanylvalylphenylalanylleucylserylserylvalyltryptophylalanylaspartylprolylisoleucylglutamylleucylleucylasparaginylvalylcysteinylthreonylserylserylleucylglycylasparaginylglutaminylphenylalanylglutaminylthreonylglutaminylglutaminylalanylarginylthreonylthreonylglutaminylvalylglutaminylglutaminylphenylalanylserylglutaminylvalyltryptophyllysylprolylphenylalanylprolylglutaminylseryl');

// Add letters A-Z and a-z
for (let i = 65; i <= 90; i++) mainSpawnNumbers.push(String.fromCharCode(i));
// Also include the additional special uppercase letter Ꙗ
mainSpawnNumbers.push('Ꙗ');
// Also include lowercase a-z
for (let i = 97; i <= 122; i++) mainSpawnNumbers.push(String.fromCharCode(i));
// Add the full lowercase alphabet as a single spawn token
mainSpawnNumbers.push('abcdefghijklmnopqrstuvwxyz');
mainSpawnNumbers.push('a̷̧̛̙̺͆̂͂̓ḑ̴̨̯̯̺͍̮̣͈̺̤̣̩̺͕͕̦̼̲̟̻͖͍͇͕̟̞͖̿͊͛͑͛̈́̎͌̇̚͜͝'); 



for (let i = 0.5; i <= 10.5; i += 0.5) {
    if (![0.25, 0.475, 0.625, 0.75, 0.85, 0.875, 0.975].includes(i)) mainSpawnNumbers.push(i);
}
for (let i = 11; i <= 39; i++) mainSpawnNumbers.push(i);
// Ensure 44-48 are available in the spawn list
[44, 45, 46, 47, 48].forEach(n => mainSpawnNumbers.push(n));
for (let i = 40; i <= 100; i += 10) {
    mainSpawnNumbers.push(i);
    mainSpawnNumbers.push(i + 0.5);
}
for (let i = 200; i <= 1000; i += 100) mainSpawnNumbers.push(i);

/* Ensure a single '3' token exists and is placed directly after the first '2.5' (so it appears between 2.5 and 3.5 in the UI) */
{
    // Remove any existing 3 entries
    for (let k = mainSpawnNumbers.length - 1; k >= 0; k--) {
        if (mainSpawnNumbers[k] === 3) mainSpawnNumbers.splice(k, 1);
    }
    // Find index of first 2.5
    const idx25 = mainSpawnNumbers.indexOf(2.5);
    // We'll insert after 2.5 if found; otherwise insert after first 2 if present; otherwise prepend
    if (idx25 !== -1) {
        mainSpawnNumbers.splice(idx25 + 1, 0, 3);
    } else {
        const idx2 = mainSpawnNumbers.indexOf(2);
        if (idx2 !== -1) {
            mainSpawnNumbers.splice(idx2 + 1, 0, 3);
        } else {
            mainSpawnNumbers.unshift(3);
        }
    }
}

/* Ensure a single '64' token exists and is placed directly after the first '60' (so it shows near other sixties in the UI) */
{
    // Remove any existing 64 entries
    for (let k = mainSpawnNumbers.length - 1; k >= 0; k--) {
        if (mainSpawnNumbers[k] === 64) mainSpawnNumbers.splice(k, 1);
    }
    // Find index of first 60
    const idx60 = mainSpawnNumbers.indexOf(60);
    // Insert after 60 if found; otherwise append to the end
    if (idx60 !== -1) {
        mainSpawnNumbers.splice(idx60 + 1, 0, 64);
    } else {
        mainSpawnNumbers.push(64);
    }
}

/* Keep 1 and 2 available in the spawn list (do not remove them). */

/* Sort mainSpawnNumbers: numeric values first (ascending), then strictly alphabetical tokens
   (case-insensitive, letters and spaces only), and finally all other symbols/misc tokens.
   Numeric-like strings are interpreted as numbers where safe. */
mainSpawnNumbers.sort((a, b) => {
    // Attempt to parse a numeric value from a token. Accept plain numeric strings (with optional sign and decimal).
    const parseNumeric = (v) => {
        if (typeof v === 'number') return v;
        if (typeof v !== 'string') return null;
        const s = v.trim();
        if (s === '') return null;
        // Accept numeric forms like -12, +3.14, 2.5
        if (/^[+-]?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
        return null;
    };

    const na = parseNumeric(a);
    const nb = parseNumeric(b);
    const aIsNum = na !== null && isFinite(na);
    const bIsNum = nb !== null && isFinite(nb);

    // 1) Both numeric -> numeric ascending
    if (aIsNum && bIsNum) {
        if (na < nb) return -1;
        if (na > nb) return 1;
        return 0;
    }
    // 2) Numeric items come before non-numeric
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;

    // Normalize to strings for further comparisons
    const sa = String(a).trim();
    const sb = String(b).trim();

    // 3) Alphabetic-only tokens (letters and spaces) come next
    const isAlphabetic = (s) => /^[A-Za-z\s]+$/.test(s);
    const aIsAlpha = isAlphabetic(sa);
    const bIsAlpha = isAlphabetic(sb);

    if (aIsAlpha && bIsAlpha) {
        const la = sa.toLowerCase();
        const lb = sb.toLowerCase();
        if (la < lb) return -1;
        if (la > lb) return 1;
        return 0;
    }
    if (aIsAlpha && !bIsAlpha) return -1;
    if (!aIsAlpha && bIsAlpha) return 1;

    // 4) Remaining items (symbols/misc) go last: stable case-insensitive compare
    const la = sa.toLowerCase();
    const lb = sb.toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
});

// Deduplicate while preserving order and ensure exactly one '1' and one '2' in the spawn list.
// We mutate the existing const array in-place to avoid reassigning the variable.
{
    const seen = new Set();
    const dedup = [];
    for (const v of mainSpawnNumbers) {
        // Normalize numeric-looking strings to numbers for dedupe checks, but keep original value in output.
        const key = (typeof v === 'string' && v.trim() !== '' && !isNaN(v)) ? Number(v) : v;

        // Special handling: treat numeric 1/2 (and their string equivalents) as identical keys 1 and 2.
        if ((key === 1 || key === '1') && seen.has(1)) continue;
        if ((key === 2 || key === '2') && seen.has(2)) continue;

        // Generic duplicate check
        if (seen.has(key)) continue;
        seen.add(key === '1' ? 1 : key === '2' ? 2 : key);
        dedup.push(v === '1' ? 1 : v === '2' ? 2 : v);
    }

    // Ensure 1 and 2 exist at least once; place 1 near the front and 2 immediately after 1 if missing.
    if (!Array.from(seen).includes(1)) dedup.unshift(1);
    if (!Array.from(seen).includes(2)) {
        const idx = dedup.indexOf(1);
        const insertAt = idx === -1 ? 1 : idx + 1;
        dedup.splice(insertAt, 0, 2);
    }

    // Replace contents of mainSpawnNumbers in-place
    mainSpawnNumbers.length = 0;
    dedup.forEach(v => mainSpawnNumbers.push(v));

    // Ensure every perfect square option from 15^2 (225) up to 32^2 (1024) is available in the spawn list.
    // Build the list programmatically and append any missing squares to guarantee full coverage.
    (function ensureSquares() {
        const existing = new Set(mainSpawnNumbers.map(v => (typeof v === 'number' ? v : (parseFloat(v) || v))));
        for (let n = 15; n <= 32; n++) {
            const s = n * n;
            if (!existing.has(s)) mainSpawnNumbers.push(s);
        }
    })();
}

/* Ensure the tens from 120 through 190 are available in the spawn list */
[120,130,140,150,160,170,180,190].forEach(n => {
    if (!mainSpawnNumbers.includes(n)) mainSpawnNumbers.push(n);
});

 // Ensure requested specific number 1738 is available in the spawn list
 if (!mainSpawnNumbers.includes(1738)) mainSpawnNumbers.push(1738);
 // Ensure 3000 is available in the spawn list (requested)
 if (!mainSpawnNumbers.includes(3000)) mainSpawnNumbers.push(3000);
 // Ensure 1,000,000 (1M) is available in the spawn list and can be spawned
 if (!mainSpawnNumbers.includes(1000000)) mainSpawnNumbers.push(1000000);

// Ensure 1089 is present and placed immediately after 1001 in the spawn list.
// If 1089 is missing, add it; then reorder so it sits directly after 1001 when both exist.
if (!mainSpawnNumbers.includes(1089)) mainSpawnNumbers.push(1089);
try {
    const idx1001 = mainSpawnNumbers.indexOf(1001);
    const idx1089 = mainSpawnNumbers.indexOf(1089);
    if (idx1001 !== -1 && idx1089 !== -1 && idx1089 !== idx1001 + 1) {
        // remove 1089 and re-insert right after 1001
        mainSpawnNumbers.splice(idx1089, 1);
        const insertAt = mainSpawnNumbers.indexOf(1001);
        mainSpawnNumbers.splice(insertAt + 1, 0, 1089);
    }
} catch (e) {
    // defensive noop if anything goes wrong with reordering
}

mainSpawnNumbers.forEach(i => {
    const btn = document.createElement('button');
    btn.className = 'spawn-btn';
    btn.dataset.number = i;
    btn.textContent = (i === 1000000 ? '1M' : i);
    
    const isFraction = i % 1 !== 0;
    const tensValue = Math.floor(i / 10) * 10;
    const onesValue = Math.floor(i % 10);

    const isLetterBtn = typeof i === 'string' && i.length === 1 && /^[A-Za-z]$/.test(i);
    const isRootBtn = typeof i === 'string' && i.startsWith('√');

    const letterColors = {
        'A': '#FF5252', 'B': '#FF4081', 'C': '#E040FB', 'D': '#7C4DFF',
        'E': '#536DFE', 'F': '#448AFF', 'G': '#40C4FF', 'H': '#18FFFF',
        'I': '#64FFDA', 'J': '#69F0AE', 'K': '#B2FF59', 'L': '#EEFF41',
        'M': '#FFFF00', 'N': '#FFD740', 'O': '#FFAB40', 'P': '#FF6E40',
        'Q': '#D7CCC8', 'R': '#F5F5F5', 'S': '#CFD8DC', 'T': '#FFCDD2',
        'U': '#F8BBD0', 'V': '#E1BEE7', 'W': '#D1C4E9', 'X': '#C5CAE9',
        'Y': '#BBDEFB', 'Z': '#B3E5FC',
        // Special character Ꙗ now mixes colors of 'A' (#FF5252) and 'I' (#64FFDA)
        'Ꙗ': '#B2A996'
    };

    const operators = ['+', '-', '^', '*', '÷', '×', '/', 'random'];
    if (i === 'pi' || i === 'PI' || i === 'Π' || i === 'Ω' || i === '¶' || i === '§' || i === 'ⁿ' || i === '⁰' || i === '∅' || i === '∆' || operators.includes(i)) {
        const symColors = { '¶': '#E91E63', '§': '#FFEB3B', '∆': '#2196F3', 'ⁿ': '#9C27B0', '⁰': '#ffffff', '∅': '#F44336', 'random': '#FFD700' };
        btn.style.backgroundColor = symColors[i] || '#7FFF00';
        btn.style.borderRadius = i === '∆' ? '0' : '50%';
        if (i === 'Π') { btn.textContent = 'Π'; btn.style.backgroundColor = '#808080'; }
        if (i === 'Ω') { btn.textContent = 'Ω'; btn.style.border = '2px solid gold'; }
        if (i === '∆') { btn.style.clipPath = 'polygon(50% 0%, 0% 100%, 100% 100%)'; }
        if (operators.includes(i) && i !== 'random') {
            btn.style.backgroundColor = '#555';
            btn.style.color = 'white';
        }
        if (i === 'random') btn.textContent = '?';
    } else if (isLetterBtn) {
        // Normalize lowercase letters to uppercase for consistent color mapping
        btn.style.backgroundColor = letterColors[i.toUpperCase()] || '#ffffff';
        btn.style.color = '#fff';
        btn.style.textShadow = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000';
        btn.style.border = '2px solid #333';
        btn.style.fontWeight = '900';
        btn.style.fontSize = '1.4rem';
    } else if (isRootBtn) {
        btn.style.backgroundColor = '#eee';
        btn.style.color = '#333';
        btn.style.textShadow = 'none';
        btn.style.border = '1px solid #999';
        btn.style.fontSize = '0.7rem';
    } else if (i === 'tan') {
        btn.style.background = 'linear-gradient(45deg, #8A2BE2, #40E0D0)';
        btn.style.borderRadius = '50%';
    } else if (i === 'infinity' || i === 'inf1') {
        btn.style.backgroundColor = '#808080';
        btn.textContent = '∞';
    } else if (i === 'μ') {
        btn.style.backgroundColor = '#808080';
        btn.textContent = 'μ';
    } else if (i === 'extended 3') {
        btn.style.backgroundColor = '#ffff00';
        btn.textContent = '3';
    } else if (i === 'real 200') {
        btn.style.backgroundColor = '#ff8800';
        btn.textContent = '200';
    } else if (i === 'real 300') {
        btn.style.backgroundColor = '#ffff00';
        btn.textContent = '300';
    } else if (i === 'real 400') {
        btn.style.backgroundColor = '#00bb00';
        btn.textContent = '400';
    } else if (i === -2) {
        // Bright blue styling for -2 per request
        btn.style.backgroundColor = '#007bff';
        btn.style.color = '#fff';
        btn.style.textShadow = 'none';
        btn.style.border = '2px solid rgba(0,0,0,0.12)';
        btn.style.boxShadow = '0 4px 0 rgba(0,123,255,0.25)';
    } else if (i === -3) {
        // Pure blue styling for -3 per user request (#0000ff)
        btn.style.backgroundColor = '#0000ff';
        btn.style.color = '#fff';
        btn.style.textShadow = 'none';
        btn.style.border = '2px solid rgba(0,0,0,0.12)';
        btn.style.boxShadow = '0 4px 0 rgba(0,0,255,0.22)';
    } else if (i === -1) {
        btn.style.backgroundColor = '#00ffff';
        btn.style.color = '#000';
        btn.style.textShadow = 'none';
        btn.style.border = '2px solid #000';
    } else if (i === 0) {
        btn.style.backgroundColor = 'white';
        btn.style.border = '2px solid #555';
        btn.style.borderRadius = '50%';
    } else if (isFraction) {
        btn.style.backgroundColor = getNumberColor(i);
        btn.style.border = '2px dashed #666';
        btn.style.fontSize = '0.9rem';
    } else if (i % 10 === 7) {
        // Keep existing rainbow for 7s as requested
        btn.style.background = 'linear-gradient(to bottom, violet, indigo, blue, green, yellow, orange, red)';
    } else if (i >= 100 && i % 100 === 0) {
        // Checkerboard for hundreds
        const hundredStyles = {
            100: { fill1: '#ffb3b3', fill2: '#ff6666', outline: '#cc0000' },
            200: { fill1: '#ffd9b3', fill2: '#ff9933', outline: '#e67300' },
            300: { fill1: '#ffffb3', fill2: '#ffff4d', outline: '#cccc00' },
            400: { fill1: '#b3ffb3', fill2: '#4dff4d', outline: '#00cc00' },
            500: { fill1: '#b3d9ff', fill2: '#4da6ff', outline: '#0066cc' },
            600: { fill1: '#d9b3ff', fill2: '#a64dff', outline: '#6600cc' },
            700: { fill1: '#ffffff', fill2: '#d9d9d9', outline: '#737373' },
            800: { fill1: '#ffb3ff', fill2: '#ff4dff', outline: '#cc00cc' },
            900: { fill1: '#bfbfbf', fill2: '#666666', outline: '#333333' },
            1000: { fill1: '#ff0000', fill2: '#cc0000', outline: '#880000' },
            2000: { fill1: '#ffddaa', fill2: '#ff8800', outline: '#e65c00' } // orange-themed for 2000
        };
        const s = hundredStyles[i] || hundredStyles[100];
        btn.style.background = `repeating-conic-gradient(${s.fill1} 0% 25%, ${s.fill2} 0% 50%) 50% / 20px 20px`;
        btn.style.border = `2px solid ${s.outline}`;
    } else if (i < 10) {
        btn.style.backgroundColor = colorMap[i];
    } else {
        const tensData = tensConfig[tensValue] || { fill: '#ffffff', outline: '#ff0000' };
        const onesFill = colorMap[onesValue] || '#ffffff';
        
        if (onesValue === 0) {
            if (i === 70) {
                btn.style.background = 'linear-gradient(to right, #FFFFFF 14.2%, #FBCEB1 14.2% 28.4%, #FFFFE0 28.4% 42.6%, #90EE90 42.6% 56.8%, #ADD8E6 56.8% 71%, #CBC3E3 71% 85.2%, #D8BFD8 85.2%)';
                btn.style.border = '2px solid #CBC3E3';
            } else {
                btn.style.backgroundColor = tensData.fill;
                btn.style.border = `2px solid ${tensData.outline}`;
            }
        } else {
            // Duotone: Tens on top, Ones on bottom
            btn.style.background = `linear-gradient(to bottom, ${tensData.fill} 50%, ${onesFill} 50%)`;
        }
    }

    // If this spawn token is the long corrupted "hand-drawn" string, mark it with the hand-drawn class for styling
    try {
        const longToken = 'a̷̧̛̙̺͆̂͂̓ḑ̴̨̯̯̺͍̮̣͈̺̤̣̩̺͕͕̦̼̲̟̻͖͍͇͇͕̟̞͖̿͊͛͑͛̈́̎͌̚͜͝';
        if (String(i) === longToken || String(btn.dataset.number) === longToken) {
            btn.classList.add('hand-drawn');
        }
    } catch(e) { /* ignore */ }

    btn.addEventListener('click', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();

        // Read the intended value from the DOM attribute to avoid closure issues
        const raw = btn.dataset.number;
        // Try to parse numeric values where appropriate, otherwise leave as string
        let value;
        if (raw === 'undefined' || raw === '') value = raw;
        else if (!isNaN(raw) && raw.trim() !== '') {
            value = raw.includes('.') ? parseFloat(raw) : parseInt(raw, 10);
        } else {
            value = raw;
        }

        // Handle special commands
        if (value === 'random') {
            const pool = mainSpawnNumbers.filter(n => n !== 'random' && n !== 'multipling ones');
            const rand = pool[Math.floor(Math.random() * pool.length)];
            const x = camera.x + (width / camera.zoom) / 2 + (Math.random() - 0.5) * 200;
            const y = height - 100; // Spawn on grass
            const block = createNumberBlock(x, y, rand, UNIT_SIZE, currentArrangement);
            World.add(world, block);
            blocks.push(block);
            playSound('pop');
            speak(rand, null, block);
            return;
        }

        if (value === 'multipling ones') {
            for (let k = 0; k < 12; k++) {
                setTimeout(() => spawn(1), k * 100);
            }
            return;
        }

        // Explicit mapping for ambiguous/new tokens to ensure they spawn correctly as labeled
        if (value === 'omega') { spawn('Ω'); return; }
        if (value === '1 decillion') { spawn('1 decillion'); return; } // spawn labeled 1 decillion (displays as 10^33)
        if (value === 'derk') { spawn('derk'); return; }
        if (value === 'HELLO??') { spawn('HELLO??'); return; }
        if (value === 'laughing 1') { spawn('laughing 1'); return; }
        if (value === 'laughing') { playSound('laugh'); return; }
        if (value === 'gold 1') { spawn('gold 1'); return; }
        if (value === 'hi') { spawn('hi'); return; }
        if (value === 'am') { spawn('am'); return; }
        if (value === 'you') { spawn('you'); return; }
        if (value === 'suck') { spawn('suck'); return; }
        if (value === 'supercalifragilisticexpialidocious') { spawn('supercalifragilisticexpialidocious'); return; }
        if (value === 'laugh') { spawn('laugh'); return; }
        if (value === ' ') { spawn(' '); return; }
        if (value === '.') { spawn('.'); return; }
        if (value === ',') { spawn(','); return; }
        if (value === ';') { spawn(';'); return; }
        if (value === ':') { spawn(':'); return; }
        if (value === '$') { spawn('$'); return; }
        if (value === '#') { spawn('#'); return; }
        if (value === '@') { spawn('@'); return; }


        let numToSpawn = value;
        if (value === 'extended 3') numToSpawn = 3;
        if (value === 'real 200') numToSpawn = 200;
        if (value === 'real 300') numToSpawn = 300;
        if (value === 'real 400') numToSpawn = 400;

        // Special-case: spawn a non-mergeable 100x100-block sprite for 10000 instead of a normal physics block
        if (numToSpawn === 1000000) {
            const x = camera.x + (width / camera.zoom) / 2 + (Math.random() - 0.5) * 120;
            const y = camera.y + (height / camera.zoom) / 2 + (Math.random() - 0.5) * 60;
            spawnMillionSprite(x, y);
            return;
        }

        if (numToSpawn === 9000) {
            // Spawn 9000 as a normal auto-arranged block (30x30 handled in blockFactory)
            spawn(9000);
            return;
        }

        // Special spawn: large 100000 block rendered big (unit size 400) but otherwise behaves like a big hundred-style block
        if (numToSpawn === 100000) {
            const x = camera.x + (width / camera.zoom) / 2 + (Math.random() - 0.5) * 120;
            const y = camera.y + (height / camera.zoom) / 2 + (Math.random() - 0.5) * 60;
            // Create a 100000-number block using a larger unit size so it appears huge; it uses createNumberBlock so merging/logic still treats the label as 100000
            const big = createNumberBlock(x, y, 100000, 400, currentArrangement);
            World.add(world, big);
            blocks.push(big);
            playSound('pop');
            speak(100000, null, big);
            return;
        }

        if (numToSpawn === 10000) {
            const x = camera.x + (width / camera.zoom) / 2 + (Math.random() - 0.5) * 120;
            const y = camera.y + (height / camera.zoom) / 2 + (Math.random() - 0.5) * 60;
            spawnTenThousandSprite(x, y);
            return;
        }

        // Make 15 spawn using the 'step' arrangement by default
        if (numToSpawn === 15) {
            spawn(15, false, 'step');
            return;
        }

        spawn(numToSpawn);
    });
    buttonRow.appendChild(btn);
});

/* Custom Number button: prompts user for a value and optionally a custom cols x rows layout, then spawns it */
const customBtn = document.createElement('button');
customBtn.className = 'spawn-btn';
customBtn.id = 'custom-btn';
customBtn.textContent = 'Custom';
customBtn.title = 'Spawn a custom number/token (with optional cols×rows)';
customBtn.style.minWidth = '66px';
customBtn.style.width = 'auto';
customBtn.style.padding = '0 10px';
customBtn.style.fontSize = '0.95rem';
customBtn.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Ask for the label/value first
    const raw = prompt('Enter a number or token to spawn (e.g. 7, pi, DOG, 3.5):', '7');
    if (raw === null) return;
    const input = raw.trim();
    if (input === '') return;

    // Ask optionally for a cols x rows layout (e.g. "5x4" or "3x3"); empty = automatic arrangement
    const layoutRaw = prompt('Optional layout: enter columns×rows (e.g. 5x4) to create a custom shape, or leave blank for default:', '');
    let customUnits = null;

    if (layoutRaw !== null && layoutRaw.trim() !== '') {
        const m = layoutRaw.trim().toLowerCase().match(/^(\d+)\s*[x×]\s*(\d+)$/);
        if (m) {
            const cols = Math.max(1, Math.min(200, parseInt(m[1], 10)));
            const rows = Math.max(1, Math.min(200, parseInt(m[2], 10)));
            // Build unit descriptors centered around (0,0) to pass as customUnits
            customUnits = [];
            // We'll fill from bottom-to-top to match renderer expectations
            for (let r = rows - 1; r >= 0; r--) {
                for (let c = 0; c < cols; c++) {
                    const localX = (c - (cols - 1) / 2) * UNIT_SIZE;
                    const localY = (r - (rows - 1) / 2) * UNIT_SIZE;
                    customUnits.push({
                        localX,
                        localY,
                        isHalf: false,
                        isQuarter: false,
                        isThreeQuarters: false
                    });
                }
            }
        } else {
            // Invalid layout string -> show a quick warning then proceed with default spawn
            try { alert('Layout not recognized. Expected form: 5x4 (cols x rows). Spawning with default arrangement.'); } catch (e) {}
        }
    }

    // Coerce label to number where appropriate
    let val;
    if (!isNaN(input) && input !== '') {
        val = input.includes('.') ? parseFloat(input) : parseInt(input, 10);
    } else {
        val = input;
    }

    // compute spawn position centered in view
    const x = camera.x + (width / camera.zoom) / 2 + (Math.random() - 0.5) * 120;
    const y = camera.y + (height / camera.zoom) / 2 + (Math.random() - 0.5) * 60;

    // If user provided customUnits, create block with them; otherwise use spawn()
    try {
        if (customUnits && customUnits.length > 0) {
            const block = createNumberBlock(x, y, val, UNIT_SIZE, currentArrangement, customUnits);
            World.add(world, block);
            blocks.push(block);
            playSound('pop');
            speak(val, null, block);
        } else {
            spawn(val);
        }
    } catch (e) {
        console.warn('Custom spawn failed, falling back to spawn()', e);
        spawn(val);
    }
});
buttonRow.appendChild(customBtn);



// Arrangement Menu Handlers
const arrButtons = document.querySelectorAll('.arr-btn');
arrButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        arrButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentArrangement = btn.dataset.arr;
    });
});

const timeBtn = document.getElementById('time-btn');
timeBtn.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    isTimeStopped = !isTimeStopped;
    
    if (isTimeStopped) {
        world.gravity.y = 0;
        blocks.forEach(b => {
            Body.setVelocity(b, { x: 0, y: 0 });
            Body.setAngularVelocity(b, 0);
        });
        timeBtn.textContent = 'Start Time';
        timeBtn.classList.add('active');
    } else {
        world.gravity.y = 1;
        timeBtn.textContent = 'Stop Time';
        timeBtn.classList.remove('active');
    }
});

document.getElementById('reset-cam-btn').addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    resetCamera();
});

document.getElementById('clear-btn').addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (blocks.length > 0) {
        blocks.forEach(b => World.remove(world, b));
        blocks.length = 0;
        playSound('delete');
    }
});

let shapeShiftBtn, explodeBtn, rotateBtn, cloneBtn;
let colorboxBtn = null;

// Simple image cache for sprite drawing
const imageCache = {};
function ensureImage(url) {
    return new Promise((resolve, reject) => {
        if (imageCache[url]) return resolve(imageCache[url]);
        const img = new Image();
        img.onload = () => { imageCache[url] = img; resolve(img); };
        img.onerror = (e) => reject(e);
        img.src = url;
    });
}



shapeShiftBtn = document.getElementById('shape-shift-btn');
explodeBtn = document.getElementById('explode-btn');
rotateBtn = document.getElementById('rotate-btn');
cloneBtn = document.getElementById('clone-btn');
colorboxBtn = document.getElementById('colorbox-btn');

// Mute Speech button hookup
const muteSpeechBtn = document.getElementById('mute-speech-btn');
if (muteSpeechBtn) {
    const updateMuteUI = () => {
        muteSpeechBtn.textContent = speechEnabled ? 'Mute Speech' : 'Unmute Speech';
        muteSpeechBtn.classList.toggle('active', !speechEnabled);
    };
    updateMuteUI();
    muteSpeechBtn.addEventListener('click', () => {
        try {
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        } catch (e) {}
        speechEnabled = !speechEnabled;
        // Clear any active speech bubbles when muting
        if (!speechEnabled) {
            blocks.forEach(b => { try { if (b && b.activeSpeech) { b.activeSpeech = null; b.speechExpiry = 0; } } catch (e) {} });
        }
        updateMuteUI();
        playSound('click');
    });
}

// BlackBox mode: toggle to spawn the costume2 SVG at pointer location
let blackboxBtn = document.getElementById('blackbox-btn');
let blackboxMode = false;
if (blackboxBtn) {
    blackboxBtn.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        blackboxMode = !blackboxMode;
        blackboxBtn.classList.toggle('active', blackboxMode);
        // When enabling blackbox mode, clear other exclusive modes to avoid conflicts
        if (blackboxMode) {
            activeMode = 'none';
            if (shapeShiftBtn) shapeShiftBtn.classList.remove('active');
            if (explodeBtn) explodeBtn.classList.remove('active');
            if (rotateBtn) rotateBtn.classList.remove('active');
            cloneMode = false;
            if (cloneBtn) cloneBtn.classList.remove('active');
        }
    });
}
// Grid mode toggle button
const gridBtn = document.getElementById('grid-btn');
let gridMode = false;
if (gridBtn) {
    gridBtn.addEventListener('click', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        gridMode = !gridMode;
        gridBtn.classList.toggle('active', gridMode);
        // When turning on grid mode, align all existing blocks immediately
        if (gridMode) alignAllToGrid();
    });
}

// Spawn costume immediately when button is clicked (no preview popup)
if (colorboxBtn) {
    colorboxBtn.addEventListener('click', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const x = camera.x + (window.innerWidth / camera.zoom) / 2;
        const y = camera.y + (window.innerHeight / camera.zoom) / 2;
        spawnColorbox(x, y, '/costume1.svg');
    });
}

/* spawnColorbox: create a lightweight physics body with a spriteUrl property so renderer draws the SVG
   renamed from spawnCostume; renderData.number set to 'colorbox' for identification.
   Add a short-lived chat bubble message attached to the spawned colorbox for quick feedback. */
function spawnColorbox(x, y, url) {
    try {
        const w = 160;
        const h = 160;
        const spriteBody = Bodies.rectangle(x, y, w, h, {
            chamfer: { radius: 8 },
            restitution: 0.2,
            friction: 0.6,
            frictionAir: 0.02,
            // Prevent rotation caused by gravity/collisions by giving effectively infinite inertia
            inertia: Infinity,
            inverseInertia: 0
        });
        // Ensure runtime invariants in case Matter overwrote properties
        try {
            Body.setInertia(spriteBody, Infinity);
            Body.setAngularVelocity(spriteBody, 0);
            // reduce angular response further
            spriteBody.inverseInertia = 0;
        } catch (e) {
            // ignore if engine disallows direct inertia change
        }

        // minimal renderData so other logic tolerates the object; label it explicitly "colorbox"
        spriteBody.renderData = {
            number: 'colorbox',
            unitSize: UNIT_SIZE,
            units: []
        };
        spriteBody.spriteUrl = url;
        // attach a display size for the custom renderer
        spriteBody.spriteW = w;
        spriteBody.spriteH = h;



        // Mark as a non-mergeable sprite entity and lock its name so other systems avoid renaming it
        spriteBody.isWandering = false;
        spriteBody._wander = null;
        spriteBody.isSpriteEntity = true;
        spriteBody.isNonMergable = true;
        spriteBody.lockName = true;

        try {
            Body.setVelocity(spriteBody, { x: 0, y: 0 });
            Body.setAngularVelocity(spriteBody, 0);
            Body.setPosition(spriteBody, { x: x, y: y });
        } catch (e) { /* ignore physics adjustment errors */ }

        World.add(world, spriteBody);
        blocks.push(spriteBody);
        playSound('pop');
    } catch (e) {
        console.warn('Failed to spawn colorbox', e);
    }
}

/* Spawn a special non-mergeable 10000 sprite sized to represent 100x100 unit blocks (100 * UNIT_SIZE) using the provided SVG */
function spawnTenThousandSprite(x, y) {
    try {
        // Size the sprite to 100 blocks × 100 blocks in world units
        const w = UNIT_SIZE * 100;
        const h = UNIT_SIZE * 100;
        const spriteBody = Bodies.rectangle(x, y, w, h, {
            isStatic: false,
            chamfer: { radius: Math.max(6, UNIT_SIZE * 0.06) },
            restitution: 0.1,
            friction: 0.6,
            frictionAir: 0.02
        });
        // mark as non-mergeable by giving no unit descriptors and a distinct render identity
        spriteBody.renderData = {
            number: 10000,    // keep numeric label for logic/merging checks but provide a friendly display label
            unitSize: UNIT_SIZE,
            units: [],        // empty prevents merge logic from treating this as a normal block
            displayLabel: 'The Beast'
        };
        spriteBody.spriteUrl = '/Ten Thousand [SQUARE FORM].svg';
        spriteBody.spriteW = w;
        spriteBody.spriteH = h;
        // tag so other logic can quickly detect it's a sprite-entity
        spriteBody.isSpriteEntity = true;

        // Prevent rotation caused by gravity/collisions: set infinite inertia and clear angular motion.
        try {
            Body.setInertia(spriteBody, Infinity);
            // ensure Matter won't try to re-enable rotation via inverseInertia
            spriteBody.inverseInertia = 0;
            // clear any angular motion
            Body.setAngularVelocity(spriteBody, 0);
            Body.setAngle(spriteBody, 0);
        } catch (e) {
            // ignore if engine disallows direct inertia change
        }

        // Add a short chat message so the 10k sprite shows a bubble briefly when spawned
        spriteBody.chatMessage = "The Beast!";
        spriteBody.chatExpiry = Date.now() + 4000; // visible for 4 seconds

        // Ensure Matter's internal bounds reflect the exact sprite rectangle so clicks/queries match visual size.
        // Force an immediate bounds update using the current vertices/velocity.
        try {
            // make sure body position/angle are set then refresh bounds
            Body.setPosition(spriteBody, { x, y });
            // update bounds based on current vertices & velocity
            Bounds.update(spriteBody.bounds, spriteBody.vertices, spriteBody.velocity);
        } catch (e) {
            console.warn('Failed to enforce accurate hitbox for 10000 sprite:', e);
        }

        World.add(world, spriteBody);
        blocks.push(spriteBody);
        playSound('pop');

        // Snap Ten Thousand sprite to grid if grid mode is active (snap its center)
        try {
            if (gridMode) snapBlockToGrid(spriteBody);
        } catch (e) { /* ignore */ }
    } catch (e) {
        console.warn('Failed to spawn 10000 sprite', e);
    }
}

/* New: spawn a non-mergeable 9000 sprite rendered as a 10x90 block sprite using the provided Nine Thousand.svg */
function spawnNineThousandSprite(x, y) {
    try {
        // Visual size approximating 10 cols × 90 rows (use width = 10*UNIT_SIZE, height = 90*UNIT_SIZE)
        const cols = 10;
        const rows = 90;
        const w = UNIT_SIZE * cols;
        const h = UNIT_SIZE * rows;
        const spriteBody = Bodies.rectangle(x, y, w, h, {
            isStatic: false,
            chamfer: { radius: Math.max(6, UNIT_SIZE * 0.06) },
            restitution: 0.1,
            friction: 0.6,
            frictionAir: 0.02
        });

        // Mark as a special non-mergeable sprite and give render hint data
        spriteBody.renderData = {
            number: 9000,
            unitSize: UNIT_SIZE,
            units: [],        // empty prevents merge logic treating this as a normal block
            displayLabel: '9000 (10×90 sprite)',
            // provide explicit cols/rows hint for any renderer logic that may want it
            spriteCols: cols,
            spriteRows: rows
        };
        spriteBody.spriteUrl = '/Nine Thousand.svg';
        spriteBody.spriteW = w;
        spriteBody.spriteH = h;

        // Tag so other logic can quickly detect it's a sprite-entity and non-mergeable
        spriteBody.isSpriteEntity = true;
        spriteBody.isNonMergable = true;

        // Prevent rotation caused by physics
        try {
            Body.setInertia(spriteBody, Infinity);
            spriteBody.inverseInertia = 0;
            Body.setAngularVelocity(spriteBody, 0);
            Body.setAngle(spriteBody, 0);
        } catch (e) { /* ignore */ }

        // Optional small chat message
        spriteBody.chatMessage = "Nine Thousand!";
        spriteBody.chatExpiry = Date.now() + 3000;

        // Update bounds for accurate hits
        try {
            Body.setPosition(spriteBody, { x, y });
            Bounds.update(spriteBody.bounds, spriteBody.vertices, spriteBody.velocity);
        } catch (e) {
            console.warn('Failed to enforce accurate hitbox for 9000 sprite:', e);
        }

        World.add(world, spriteBody);
        blocks.push(spriteBody);
        playSound('pop');

        // Snap to grid if desired (snaps center to UNIT grid; large sprite may align by its center)
        try { if (gridMode) snapBlockToGrid(spriteBody); } catch (e) {}
    } catch (e) {
        console.warn('Failed to spawn 9000 sprite', e);
    }
}

/* Spawn a special non-mergeable 1,000,000 sprite: a red 100x100 unit square with a dark-red 10x10 grid */
function spawnMillionSprite(x, y) {
    try {
        const w = UNIT_SIZE * 100;
        const h = UNIT_SIZE * 100;
        const spriteBody = Bodies.rectangle(x, y, w, h, {
            isStatic: false,
            chamfer: { radius: Math.max(6, UNIT_SIZE * 0.06) },
            restitution: 0.1,
            friction: 0.6,
            frictionAir: 0.02
        });

        // Mark as a special non-mergeable sprite and give render hint data
        spriteBody.renderData = {
            number: 1000000,
            unitSize: UNIT_SIZE,
            units: [],        // empty prevents merge logic from treating this as a normal block
            displayLabel: '1,000,000 (sprite)'
        };
        // Tag so other logic can quickly detect it's a sprite-entity and non-mergeable
        spriteBody.isSpriteEntity = true;
        spriteBody.isNonMergable = true;

        // Provide pixel dimensions for renderer
        spriteBody.spriteW = w;
        spriteBody.spriteH = h;

        // Use the One Million SVG as the sprite image for 1M
        spriteBody.spriteUrl = '/One Million.svg';

        // Prevent rotation caused by physics
        try {
            Body.setInertia(spriteBody, Infinity);
            spriteBody.inverseInertia = 0;
            Body.setAngularVelocity(spriteBody, 0);
            Body.setAngle(spriteBody, 0);
        } catch (e) {}

        World.add(world, spriteBody);
        blocks.push(spriteBody);
        playSound('pop');

        // Snap to grid center if grid mode
        try { if (gridMode) snapBlockToGrid(spriteBody); } catch (e) {}
    } catch (e) {
        console.warn('Failed to spawn 1000000 sprite', e);
    }
}

/* Grid helpers: snap a body to the UNIT_SIZE world grid and align all existing blocks when toggled on */

/* Grid helpers: snap a body to the UNIT_SIZE world grid and align all existing blocks when toggled on */
function snapBlockToGrid(body) {
    if (!body || typeof body.position === 'undefined') return;
    try {
        const gx = Math.round(body.position.x / UNIT_SIZE) * UNIT_SIZE;
        const gy = Math.round(body.position.y / UNIT_SIZE) * UNIT_SIZE;
        Body.setPosition(body, { x: gx, y: gy });
        // clear motion so it sits neatly on the snapped cell
        try { Body.setVelocity(body, { x: 0, y: 0 }); } catch (e) {}
        try { Body.setAngularVelocity(body, 0); } catch (e) {}
    } catch (e) {
        // defensive noop
    }
}

function alignAllToGrid() {
    try {
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            if (!b || !b.position) continue;
            snapBlockToGrid(b);
        }
        playSound('pop');
    } catch (e) {
        console.warn('alignAllToGrid failed', e);
    }
}

// Autonomous wandering for colorbox sprites: apply gentle randomized forces each physics tick.
Events.on(runner, 'beforeUpdate', () => {
    try {
        const now = Date.now();
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            if (!b || !b.isWandering || !b.position) continue;

            // initialize wander state if missing
            b._wander = b._wander || { seed: Math.random() * 10000, lastChange: now, vx: 0, vy: 0, ang: 0 };

            // Occasionally change the wander direction slightly (every 300-900ms)
            if (now - b._wander.lastChange > 300 + Math.abs(Math.sin(b._wander.seed + now * 0.001) * 600)) {
                b._wander.lastChange = now;
                b._wander.vx = (Math.random() - 0.5) * 0.002; // tiny horizontal drift
                b._wander.vy = (Math.random() - 0.5) * 0.002; // tiny vertical drift
                b._wander.ang = (Math.random() - 0.5) * 0.006; // tiny angular nudge
            }

            // Apply a small force scaled by body mass so big sprites move gently and small ones move visibly
            try {
                const massScale = Math.max(0.001, (b.mass || 1));
                const fx = b._wander.vx * massScale;
                const fy = b._wander.vy * massScale;
                Body.applyForce(b, b.position, { x: fx, y: fy });
                // slight angular nudge
                Body.setAngularVelocity(b, (b.angularVelocity || 0) + b._wander.ang * 0.5);
            } catch (e) {
                // ignore physics application errors for stability
            }
        }
    } catch (e) {
        // defensive noop to keep main loop healthy
    }
});

// Volume slider hookup + music seek slider hookup
const volumeSliderEl = document.getElementById('volume-slider');
const musicSeekEl = document.getElementById('music-seek');
const musicTimeEl = document.getElementById('music-time');

if (volumeSliderEl) {
    // Initialize slider value to reflect current master gain (0-100 scale)
    volumeSliderEl.value = Math.round((musicMasterGain.gain.value || 0.8) * 100);

    const applyVolume = (v) => {
        // Allow slider to represent up to 200 (200 => gain 2.0) so users can expand loudness beyond 0..1
        const linear = Math.max(0, Math.min(2, v / 100));
        try { musicMasterGain.gain.setTargetAtTime(linear, audioCtx.currentTime, 0.01); } catch (e) { musicMasterGain.gain.value = linear; }
        try { sfxGain.gain.setTargetAtTime(linear, audioCtx.currentTime, 0.01); } catch (e) { sfxGain.gain.value = linear; }
    };

    applyVolume(Number(volumeSliderEl.value));
    volumeSliderEl.addEventListener('input', (evt) => {
        const v = Number(evt.target.value);
        applyVolume(v);
    });
}

// Seek UI logic: update slider while music plays and allow user scrubbing
let isSeeking = false;
function formatTime(sec) {
    if (!isFinite(sec) || sec <= 0) return '0:00';
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    const m = Math.floor(sec / 60);
    return `${m}:${s}`;
}

function updateSeekUI() {
    if (!musicSeekEl || !audioBuffers['music2']) { requestAnimationFrame(updateSeekUI); return; }
    const buf = audioBuffers['music2'];
    // update max
    musicSeekEl.max = buf.duration;
    let current = 0;
    if (isMusicPlaying) {
        const now = audioCtx.currentTime;
        current = (now - musicStartTime) % buf.duration;
        if (current < 0) current += buf.duration;
    } else {
        current = musicOffset % buf.duration;
    }
    if (!isSeeking) musicSeekEl.value = current;
    if (musicTimeEl) musicTimeEl.textContent = `${formatTime(current)} / ${formatTime(buf.duration)}`;
    requestAnimationFrame(updateSeekUI);
}
requestAnimationFrame(updateSeekUI);

// Handle user scrubbing
if (musicSeekEl) {
    musicSeekEl.addEventListener('pointerdown', () => { isSeeking = true; });
    musicSeekEl.addEventListener('input', (e) => {
        const v = Number(e.target.value);
        if (musicTimeEl && audioBuffers['music2']) musicTimeEl.textContent = `${formatTime(v)} / ${formatTime(audioBuffers['music2'].duration)}`;
    });
    musicSeekEl.addEventListener('pointerup', async (e) => {
        isSeeking = false;
        const v = Number(e.target.value);
        // Apply seek: set musicOffset and restart playback from that offset if playing, else just set offset
        musicOffset = Math.max(0, v);
        if (audioCtx.state === 'suspended') try { await audioCtx.resume(); } catch (e) {}
        if (isMusicPlaying) {
            // restart sources at new offset
            startMusicLoop();
        }
    });
}


shapeShiftBtn.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (activeMode === 'shape-shift') {
        activeMode = 'none';
        shapeShiftBtn.classList.remove('active');
    } else {
        activeMode = 'shape-shift';
        shapeShiftBtn.classList.add('active');
        if (explodeBtn) explodeBtn.classList.remove('active');
        if (rotateBtn) rotateBtn.classList.remove('active');
        if (cloneBtn) cloneBtn.classList.remove('active');
        cloneMode = false;
    }
});

// Clone Mode button: toggle a single-use clone state (click a block to clone it)
if (cloneBtn) {
    cloneBtn.addEventListener('click', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        // Toggle clone mode
        cloneMode = !cloneMode;
        if (cloneMode) {
            // deactivate other exclusive modes
            activeMode = 'none';
            if (shapeShiftBtn) shapeShiftBtn.classList.remove('active');
            if (explodeBtn) explodeBtn.classList.remove('active');
            if (rotateBtn) rotateBtn.classList.remove('active');
            cloneBtn.classList.add('active');
        } else {
            cloneBtn.classList.remove('active');
        }
    });
}

// Rotate Mode button
if (rotateBtn) {
    rotateBtn.addEventListener('click', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if (activeMode === 'rotate') {
            activeMode = 'none';
            rotateBtn.classList.remove('active');
        } else {
            activeMode = 'rotate';
            rotateBtn.classList.add('active');
            // make sure other exclusive modes are off
            if (shapeShiftBtn) shapeShiftBtn.classList.remove('active');
            if (explodeBtn) explodeBtn.classList.remove('active');
        }
    });
}



explodeBtn.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (activeMode === 'explode') {
        activeMode = 'none';
        explodeBtn.classList.remove('active');
    } else {
        activeMode = 'explode';
        explodeBtn.classList.add('active');
        shapeShiftBtn.classList.remove('active');
        cloneMode = false;
        if (cloneBtn) cloneBtn.classList.remove('active');
    }
});

document.addEventListener('click', (e) => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    playSound('click');
});



import { drawEye, drawFlower, drawStone, drawStar, drawRoundedRect, drawSquareEye, drawEvilEye, drawQuarterEye, drawRectangularEye, drawSpeechBubble, drawThreeQuartersEye, drawGrass } from './drawUtils.js';

// removed functions: drawEye, drawFlower, drawStone, drawStar, drawRoundedRect, drawSquareEye, drawEvilEye, drawQuarterEye, drawRectangularEye, drawSpeechBubble, drawThreeQuartersEye, drawGrass

// Custom Rendering for Environment and Numberblocks
Events.on(render, 'afterRender', () => {
    const context = render.context;
    const canvas = render.canvas;

    // Clear and prepare for camera transform
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Dynamic Altitude Calculations
    // Altitude increases as camera.y decreases (scrolling up)
    const altitude = -camera.y;
    const spaceThreshold = 5000;
    const fadeStart = 2000;
    
    // Background Color Interpolation (Atmosphere to Space) - Morning skies
    // Use a warm sunrise at low altitudes that transitions into a clear blue then to space.
    // The Void, Flicker, Color Zone, Gray Zone, and Binary Zone now trigger when ascending above the world (altitude):
    // - 125 blocks above -> Flicker black overlay begins
    // - 150 blocks above -> The Void (absolute black sky)
    // - 300 blocks above -> Color Zone (cycling hues)
    // - 450 blocks above -> Gray Zone (glitching monochrome polygons)
    // - 750 blocks above -> Binary Zone (black sky + green 0/1 field)
    const blocksAbove = Math.round(altitude / UNIT_SIZE); // positive when above ground
    const flickerActive = blocksAbove >= 125; // reached 125 blocks above -> start flicker overlay
    const deepAbove = blocksAbove >= 150; // reached 150 blocks above -> The Void
    // Disable Color/Gray zones once in Red Zone (600–749) so they disappear at very high altitude (>=750)
    const colorZone = blocksAbove >= 300 && blocksAbove < 600; // reached 300 blocks above -> Color Zone
    const grayZone = blocksAbove >= 450 && blocksAbove < 600; // reached 450 blocks above -> Gray Zone (higher priority)
    // Red zone is active from 600 up to (but not including) 750; at 750+ it is cleared so binary zone takes over
    const redZone = (blocksAbove >= 600 && blocksAbove < 750); // 600–749 => Red Zone
    const binaryZone = blocksAbove >= 750; // reached 750 blocks above -> Binary Zone (special black+green overlay)
    const gallZone = blocksAbove >= 900; // reached 900 blocks above -> Gall Zone (turquoise-green sky)
    const fritzZone = blocksAbove >= 1050; // reached 1050 blocks above -> Fritz Zone (white sky + pillars + water)
    let skyColor;

    // Fritz Zone (highest priority at extreme altitude): white sky with pillars and water
    if (fritzZone) {
        skyColor = '#ffffff';
        camera._fritzZoneActive = true;
        // Clear other zone flags to avoid conflicting visuals
        camera._binaryZoneActive = false;
        camera._redZoneActive = false;
        camera._colorZoneActive = false;
        camera._colorZoneHue = null;
        camera._grayZoneActive = false;
        camera._gallZoneActive = false;
    // Gall Zone (next priority above binary): turquoise-green sky for extreme altitude
    } else if (gallZone) {
        // turquoise-green Gall sky
        skyColor = '#30D5C8';
        camera._gallZoneActive = true;
        // Clear other zone flags to avoid conflicting visuals
        camera._binaryZoneActive = false;
        camera._redZoneActive = false;
        camera._colorZoneActive = false;
        camera._colorZoneHue = null;
        camera._grayZoneActive = false;
    // Binary Zone (next priority except explicit Red Zone which communicates danger)
    } else if (binaryZone && !redZone) {
        // force absolute black and mark flag for overlay rendering
        skyColor = '#000000';
        camera._binaryZoneActive = true;
        // Clear other zone flags to avoid conflicting visuals
        camera._redZoneActive = false;
        camera._colorZoneActive = false;
        camera._colorZoneHue = null;
        camera._grayZoneActive = false;
    } else {
        camera._binaryZoneActive = false;
        camera._gallZoneActive = false;

        // Red Zone has absolute priority: when >=600 blocks above, force a red sky
        if (redZone) {
            // Use a vivid deep red to communicate danger; keep flags for downstream visuals
            skyColor = '#8B0000'; // dark red
            camera._redZoneActive = true;
            // Clear other zone flags
            camera._colorZoneActive = false;
            camera._colorZoneHue = null;
            camera._grayZoneActive = false;
        } else if (grayZone) {
            // At 450+ blocks we want the Color Zone to become dark grey per request
            skyColor = '#2f2f2f'; // dark grey for the Color-to-Gray transition
            camera._grayZoneActive = true;
            camera._colorZoneActive = false;
            camera._colorZoneHue = null;
            camera._redZoneActive = false;
        } else if (colorZone) {
            // create a moving rainbow hue seed stored on camera for later gradient generation
            camera._colorZoneActive = true;
            camera._colorZoneHue = (Date.now() * 0.02) % 360; // continuously changing base hue
            camera._redZoneActive = false;
            camera._grayZoneActive = false;
            // set a marker value for skyColor so downstream logic knows to draw the animated gradient
            skyColor = '__COLOR_ZONE_RAINBOW__';
        } else {
            // Clear color/red/gray zone flags if not active
            camera._colorZoneActive = false;
            camera._colorZoneHue = null;
            camera._redZoneActive = false;
            camera._grayZoneActive = false;

            // Base sky calculation (morning-only / void)
            if (deepAbove && !colorZone) {
                // Deep high-altitude area but not the deeper color zone: absolute black sky (no atmosphere)
                skyColor = '#000000';
            } else {
                // Always use a warm morning palette that deepens slightly with altitude,
                // avoiding any shift toward daylight blue.
                const morningRatio = Math.min(1, Math.max(0, altitude / spaceThreshold));
                // Bright warm sunrise near the ground -> richer warm dusk-like tone up high
                const warmNear = { r: 255, g: 200, b: 170 }; // soft peach
                const warmFar  = { r: 220, g: 140, b: 120 }; // deeper warm tone at high altitude
                const r = Math.round(warmNear.r * (1 - morningRatio) + warmFar.r * morningRatio);
                const g = Math.round(warmNear.g * (1 - morningRatio) + warmFar.g * morningRatio);
                const b = Math.round(warmNear.b * (1 - morningRatio) + warmFar.b * morningRatio);
                skyColor = `rgb(${r}, ${g}, ${b})`;

                // Preserve an absolute-space color when above the explicit space threshold
                if (altitude > spaceThreshold) {
                    skyColor = '#050510';
                }
            }

            // Apply flicker black overlay when above 125 blocks but below the full void threshold.
            // Make flicker more pronounced as altitude increases between 125 and 150.
            if (flickerActive && !deepAbove) {
                const now = Date.now();
                // base flicker frequency in Hz, slightly speed up as you climb (range ~1.5Hz -> 4Hz)
                const climbProgress = Math.min(1, Math.max(0, (blocksAbove - 125) / (150 - 125)));
                const freq = 1.5 + climbProgress * 2.5;
                // Use a pulsing function that yields values in [0,1] but with some randomness to feel like flicker
                const pulse = (Math.sin(now * 0.001 * Math.PI * 2 * freq) + 1) / 2;
                const noise = (Math.random() * 0.15);
                const flickerStrength = Math.min(1, 0.35 + pulse * 0.6 + noise) * (0.5 + 0.5 * climbProgress);
                
                // Blend skyColor toward black by flickerStrength (simple RGB blend)
                const parseRGB = (s) => {
                    if (s.startsWith('rgb')) {
                        const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                        if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
                    } else if (s.startsWith('hsl')) {
                        // approximate HSL -> RGB via canvas temporary trick for simplicity
                        const tmp = document.createElement('canvas');
                        tmp.width = tmp.height = 1;
                        const ctx = tmp.getContext('2d');
                        ctx.fillStyle = s;
                        ctx.fillRect(0, 0, 1, 1);
                        const d = ctx.getImageData(0,0,1,1).data;
                        return [d[0], d[1], d[2]];
                    } else if (s[0] === '#') {
                        if (s.length === 7) {
                            return [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16)];
                        } else if (s.length === 4) {
                            return [parseInt(s[1]+s[1],16), parseInt(s[2]+s[2],16), parseInt(s[3]+s[3],16)];
                        }
                    }
                    return [0,0,0];
                };
                const rgb = parseRGB(skyColor);
                const blended = rgb.map(c => Math.round(c * (1 - flickerStrength)));
                skyColor = `rgb(${blended[0]}, ${blended[1]}, ${blended[2]})`;
            }
        }
    }

    camera._fritzZoneActive = fritzZone;

    // Draw Sky/Space Background
    // Twilight Zone disabled: no violent sky rotation
    const twilightActive = false;
    context.save();

    // New: Minimal black zone at extreme altitude (>= 1200 blocks above)
    // When active, render only a pure black background and a centered white outlined square
    // with small diagonal corner ticks, then skip the usual sky/nebula/star decorations.
    const minimalZoneActive = blocksAbove >= 1200;
    // New: Noise zone that supersedes minimal zone when even higher (>= 1350)
    const noiseZoneActive = blocksAbove >= 1350;
    camera._minimalZoneActive = minimalZoneActive;
    camera._noiseZoneActive = noiseZoneActive;
    // New: Blue zone at very extreme altitude (>= 1500)
    const blueZoneActive = blocksAbove >= 1500 && blocksAbove < 1650;
    camera._blueZoneActive = blueZoneActive;
    // White Zone: turns background completely white at >=1650 and <1800
    const whiteZoneActive = (blocksAbove >= 1650 && blocksAbove < 1800);
    camera._whiteZoneActive = whiteZoneActive;
    // Peril Zone: at >=1800 show red->black gradient with dark red polygons (highest priority)
    const perilZoneActive = (blocksAbove >= 1800);
    camera._perilZoneActive = perilZoneActive;

    // Peril zone takes ultimate priority when active (>= 1800): dark red/black gradient + polygons
    if (perilZoneActive) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        // Gradient from deep red to black
        const gradP = context.createLinearGradient(0, 0, 0, canvas.height);
        gradP.addColorStop(0, '#330000');
        gradP.addColorStop(0.4, '#440000');
        gradP.addColorStop(1, '#000000');
        context.fillStyle = gradP;
        context.fillRect(0, 0, canvas.width, canvas.height);

        // Dark red glitch polygons for peril feeling (reduced count for less clutter)
        const nowP = Date.now();
        const polyCountP = 6;
        for (let i = 0; i < polyCountP; i++) {
            const seed = Math.abs(Math.sin(nowP * 0.0006 + i * 7.77)) * 10000;
            const px = (seed % (canvas.width + 400)) - 200;
            const py = ((seed * 3) % (canvas.height + 400)) - 200;
            const w = 80 + (i % 6) * 36 + Math.abs(Math.sin(nowP * 0.0012 * (i + 3))) * 72;
            const h = 40 + (i % 5) * 22 + Math.abs(Math.cos(nowP * 0.0010 * (i + 5))) * 54;
            const sides = 3 + (i % 5);
            const shade = Math.floor(24 + ((i * 29) % 160) + Math.round(Math.sin(nowP * 0.0011 + i) * 10));
            context.save();
            context.globalAlpha = 0.06 + (Math.abs(Math.sin(nowP * 0.0011 * (i + 1))) * 0.28);
            context.translate(px, py);
            context.rotate((Math.sin(nowP * 0.0007 * (i + 2)) * 0.9) );
            context.beginPath();
            for (let s = 0; s < sides; s++) {
                const a = (s / sides) * Math.PI * 2;
                const rx = Math.cos(a) * (w * (0.5 + (s % 2) * 0.12));
                const ry = Math.sin(a) * (h * (0.5 + ((s + 1) % 2) * 0.12));
                if (s === 0) context.moveTo(rx, ry);
                else context.lineTo(rx, ry);
            }
            context.closePath();
            // deep dark red palette
            context.fillStyle = `rgb(${Math.max(20, shade)}, 0, 0)`;
            context.fill();
            context.restore();
        }

        // Short-circuit the rest of sky drawing when in peril zone
        context.restore();
    } else if (whiteZoneActive) {
        // White zone: pure white background, skip other decorations
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        // Short-circuit further sky decorations
    } else if (blueZoneActive) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = '#0a6cff'; // vivid blue
        context.fillRect(0, 0, canvas.width, canvas.height);

        // small subtle vignette for depth
        const vig = context.createRadialGradient(canvas.width/2, canvas.height/2, Math.min(canvas.width, canvas.height)*0.1, canvas.width/2, canvas.height/2, Math.max(canvas.width, canvas.height)*0.8);
        vig.addColorStop(0, 'rgba(255,255,255,0.02)');
        vig.addColorStop(1, 'rgba(0,0,0,0.12)');
        context.globalCompositeOperation = 'multiply';
        context.globalAlpha = 0.08;
        context.fillStyle = vig;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = 1.0;
        context.restore();

        // Short-circuit the rest of sky drawing when in blue zone
        // (we will still draw foreground/world later where appropriate)
    } else if (noiseZoneActive) {
        // Fill with procedural grayscale noise (screen-space) and skip other sky decorations.
        context.setTransform(1, 0, 0, 1, 0, 0);
        // We generate a small noise layer and upscale it to save CPU.
        const noiseW = 128;
        const noiseH = 128;
        // reuse an offscreen canvas stored on camera for caching between frames
        if (!camera._noiseCanvas) {
            camera._noiseCanvas = document.createElement('canvas');
            camera._noiseCanvas.width = noiseW;
            camera._noiseCanvas.height = noiseH;
            camera._noiseCtx = camera._noiseCanvas.getContext('2d');
        }
        const nctx = camera._noiseCtx;
        const ncanvas = camera._noiseCanvas;
        // Produce fresh noise each frame to create a shimmering static effect.
        const imageData = nctx.createImageData(noiseW, noiseH);
        const now = Date.now();
        // faster PRNG-ish mix for coherent temporal variation (cheap)
        let seed = (Math.abs(Math.sin(now * 0.0001)) * 100000) | 0;
        for (let y = 0; y < noiseH; y++) {
            for (let x = 0; x < noiseW; x++) {
                seed = (seed * 1664525 + 1013904223) >>> 0;
                const i = (y * noiseW + x) * 4;
                // grayscale value varying with seed and a tiny temporal sine to avoid pure randomness
                const v = ((seed >>> 16) & 255) ^ Math.floor(16 * Math.sin((x + y + now * 0.002)));
                imageData.data[i] = v;
                imageData.data[i + 1] = v;
                imageData.data[i + 2] = v;
                imageData.data[i + 3] = 255;
            }
        }
        nctx.putImageData(imageData, 0, 0);

        // Draw the noise canvas stretched to full screen with slight global tint to keep it from being pure white noise
        context.globalAlpha = 1.0;
        context.fillStyle = '#000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        // subtle tint overlay so noise isn't visually harsh
        context.globalCompositeOperation = 'screen';
        context.globalAlpha = 0.88;
        context.drawImage(ncanvas, 0, 0, canvas.width, canvas.height);
        // small vignette for depth
        context.globalCompositeOperation = 'multiply';
        const vig = context.createRadialGradient(canvas.width/2, canvas.height/2, Math.min(canvas.width, canvas.height)*0.1, canvas.width/2, canvas.height/2, Math.max(canvas.width, canvas.height)*0.8);
        vig.addColorStop(0, 'rgba(0,0,0,0.0)');
        vig.addColorStop(1, 'rgba(0,0,0,0.45)');
        context.globalAlpha = 1.0;
        context.fillStyle = vig;
        context.fillRect(0, 0, canvas.width, canvas.height);

        // restore composite defaults for later code (though we will skip most)
        context.globalCompositeOperation = 'source-over';
        context.restore();

        // Short-circuit the rest of sky drawing when in noise zone
        // (we will still draw foreground/world later where appropriate)
    } else if (minimalZoneActive) {
        // Fill total screen with absolute black
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = '#000000';
        context.fillRect(0, 0, canvas.width, canvas.height);

        // Draw a centered white outlined square with no fill and diagonal corner lines
        const side = Math.min(canvas.width, canvas.height) * 0.38; // size of square
        const cx = Math.round(canvas.width / 2);
        const cy = Math.round(canvas.height / 2);
        const half = Math.round(side / 2);
        const left = cx - half;
        const top = cy - half;
        const right = cx + half;
        const bottom = cy + half;

        // Outline — make lines noticeably thicker when in the extreme minimal zone (>=1200 blocks away)
        context.strokeStyle = 'white';
        const defaultLineW = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.004));
        const thickLineW = Math.max(6, Math.round(Math.min(canvas.width, canvas.height) * 0.012));
        context.lineWidth = minimalZoneActive ? thickLineW : defaultLineW;
        context.globalCompositeOperation = 'source-over';
        context.beginPath();
        context.rect(left + 0.5, top + 0.5, right - left, bottom - top);
        context.stroke();

        // Diagonal corner lines extending outward to the screen edges/corners
        // Use the same increased thickness for consistency when minimalZoneActive is true
        // Do not draw these diagonal lines if we've reached the noise zone (>=1350 blocks)
        if (blocksAbove < 1350) {
            context.beginPath();
            // top-left: extend to top-left of canvas
            context.moveTo(left + 0.5, top + 0.5);
            context.lineTo(0.5, 0.5);
            // top-right: extend to top-right of canvas
            context.moveTo(right + 0.5, top + 0.5);
            context.lineTo(Math.round(canvas.width) - 0.5, 0.5);
            // bottom-left: extend to bottom-left of canvas
            context.moveTo(left + 0.5, bottom + 0.5);
            context.lineTo(0.5, Math.round(canvas.height) - 0.5);
            // bottom-right: extend to bottom-right of canvas
            context.moveTo(right + 0.5, bottom + 0.5);
            context.lineTo(Math.round(canvas.width) - 0.5, Math.round(canvas.height) - 0.5);
            context.stroke();
        }

        context.restore();

        // Short-circuit the rest of sky drawing when in minimal zone
        // (we will still draw foreground/world later where appropriate)
    } else {
        if (twilightActive) {
            camera._twilightActive = true;
            // pick a random angle each frame between -90deg and +90deg (radians)
            // use a fast-changing seed so it feels violent; but keep randomness deterministic-ish per frame
            const rand = (Math.random() * 2 - 1) * (Math.PI / 2); // -PI/2 .. PI/2
            // rotate around screen center
            context.translate(canvas.width / 2, canvas.height / 2);
            context.rotate(rand);
            context.translate(-canvas.width / 2, -canvas.height / 2);
        } else {
            camera._twilightActive = false;
        }
        // If Color Zone uses the animated rainbow marker, create a horizontal rainbow gradient that cycles over time
        if (camera._colorZoneActive && skyColor === '__COLOR_ZONE_RAINBOW__') {
            const grad = context.createLinearGradient(0, 0, canvas.width, 0);
            // produce a smooth multi-stop rainbow that shifts using the stored hue seed
            const base = (camera._colorZoneHue || (Date.now() * 0.02)) % 360;
            const stops = 8;
            for (let s = 0; s < stops; s++) {
                const t = s / (stops - 1);
                // spread hues across ~240 degrees centered on base for a broad rainbow
                const hue = (base + (t * 240)) % 360;
                grad.addColorStop(t, `hsl(${Math.round(hue)}, 90%, 55%)`);
            }
            context.fillStyle = grad;
            context.fillRect(0, 0, canvas.width, canvas.height);
        } else {
            context.fillStyle = skyColor;
            context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.restore();
    }

    // Fritz Zone visuals: when active, draw a white-water plane with subtle ripples and decorative pillars above the water
    // Do not draw Fritz water/pillars when the minimal zone (>=1200 blocks) is active.
    if (camera._fritzZoneActive && !camera._minimalZoneActive) {
        try {
            context.save();
            // Draw a watery plane that fills the lower portion of the screen (screen-space)
            context.setTransform(1, 0, 0, 1, 0, 0);
            const waterAlpha = 0.92;
            const waterTop = Math.floor(canvas.height * 0.58);
            const waterGrad = context.createLinearGradient(0, waterTop, 0, canvas.height);
            waterGrad.addColorStop(0, `rgba(235, 245, 255, ${waterAlpha})`);
            waterGrad.addColorStop(1, `rgba(220, 235, 255, ${waterAlpha})`);
            context.fillStyle = waterGrad;
            context.fillRect(0, waterTop, canvas.width, canvas.height - waterTop);

            // Gentle large-scale water glare lines for visual interest (no physics pillars)
            const glareCount = 6;
            for (let g = 0; g < glareCount; g++) {
                const gx = (g / glareCount) * canvas.width;
                const wiggle = Math.sin((Date.now() * 0.0006) + g) * 24;
                const height = 18 + Math.abs(Math.cos((Date.now() * 0.0004) + g)) * 22;
                const alpha = 0.06 + (g % 2) * 0.02;
                context.fillStyle = `rgba(255,255,255,${alpha})`;
                context.beginPath();
                context.ellipse(gx + wiggle, waterTop + height, canvas.width * 0.35, height * 0.6, 0, 0, Math.PI * 2);
                context.fill();
            }

            // Subtle ripples across the water plane (screen-space)
            context.fillStyle = 'rgba(230,245,255,0.6)';
            const rippleSpacing = 48;
            for (let rx = -rippleSpacing; rx < canvas.width + rippleSpacing; rx += rippleSpacing) {
                const phase = (rx * 0.005) + (Date.now() * 0.002);
                const offsetY = Math.sin(phase) * 3;
                context.beginPath();
                context.ellipse(rx + (Math.sin(phase * 0.7) * 6), waterTop + 8 + offsetY, rippleSpacing * 0.45, 4, 0, 0, Math.PI * 2);
                context.fill();
            }

            // Slight darker band at the water edge for separation
            context.fillStyle = 'rgba(0,0,0,0.06)';
            context.fillRect(0, waterTop - 6, canvas.width, 6);

            // Decorative screen-space pillars placed above the water line.
            // We keep the pillar data in pillarField and draw them here for a consistent look without physics.
            try {
                // initialize camera-local pillar cache if missing (so randoms persist across frames)
                if (!camera._fritzPillarField) {
                    // clone the global pillarField but allow slight per-session horizontal jitter
                    camera._fritzPillarField = pillarField.map(p => ({ ...p, jitter: (Math.random() - 0.5) * 0.05 }));
                }
                const pList = camera._fritzPillarField;
                for (let pi = 0; pi < pList.length; pi++) {
                    const p = pList[pi];
                    // compute screen X position with a slow subtle drift using wobbleSeed
                    const drift = Math.sin((Date.now() * 0.0002) + p.wobbleSeed) * 12 * p.jitter;
                    const sx = Math.floor((p.sx + drift / canvas.width) * canvas.width) % canvas.width;
                    // compute pillar top and base in screen-space so they sit visually above the water
                    const pillarBaseY = waterTop - 8 + Math.sin((Date.now() * 0.0006) + p.wobbleSeed) * 6; // tiny bob
                    const h = p.height;
                    const w = Math.max(8, p.width);

                    // Draw pillar body (use soft off-white with slight tint and vertical gradient)
                    const grad = context.createLinearGradient(sx - w/2, pillarBaseY - h, sx + w/2, pillarBaseY);
                    const tint = Math.round(230 * p.shade);
                    grad.addColorStop(0, `rgba(${tint}, ${tint}, ${tint}, 0.98)`);
                    grad.addColorStop(1, `rgba(${Math.round(tint - 24)}, ${Math.round(tint - 24)}, ${Math.round(tint - 24)}, 0.92)`);
                    context.fillStyle = grad;
                    context.beginPath();
                    context.rect(sx - w/2, pillarBaseY - h, w, h);
                    context.fill();

                    // Thin cap and base shadow for depth
                    context.fillStyle = `rgba(255,255,255,0.6)`;
                    context.fillRect(sx - w/2, pillarBaseY - h, w, Math.max(2, Math.round(w * 0.12)));
                    context.fillStyle = `rgba(0,0,0,0.08)`;
                    context.fillRect(sx - w/2, pillarBaseY - 2, w, 4);

                    // Subtle vertical striations (cheap detail)
                    context.strokeStyle = `rgba(0,0,0,0.03)`;
                    context.lineWidth = 1;
                    for (let s = 1; s <= 2; s++) {
                        const xLine = sx - w/2 + (w * (s / 3));
                        context.beginPath();
                        context.moveTo(xLine, pillarBaseY - h + 6);
                        context.lineTo(xLine, pillarBaseY - 6);
                        context.stroke();
                    }

                    // Add a faint reflection/glow on the water directly below the pillar (screen-space)
                    context.save();
                    const glowAlpha = 0.06 + (Math.abs(Math.sin((Date.now() * 0.0004) + p.wobbleSeed)) * 0.04);
                    context.globalAlpha = glowAlpha;
                    const glowW = w * 1.6;
                    context.fillStyle = `rgba(255,255,255,0.22)`;
                    context.beginPath();
                    context.ellipse(sx, pillarBaseY + 8, glowW, 8, 0, 0, Math.PI * 2);
                    context.fill();
                    context.restore();
                }
            } catch (e) {
                console.warn('Fritz pillar draw failed', e);
            }

            // Ensure any real physics bodies flagged as pillars are removed from the water area so they don't conflict visually.
            try {
                for (let pi = blocks.length - 1; pi >= 0; pi--) {
                    const pb = blocks[pi];
                    if (!pb || !pb.position) continue;
                    const inWater = (pb.position.y > (camera.y + waterTop / (camera.zoom || 1))); // world-space test
                    const spriteName = (pb.spriteUrl || '').toString().toLowerCase();
                    const label = (pb.renderData && String(pb.renderData.number || '').toLowerCase()) || '';
                    if (inWater && (pb.isPillar || spriteName.includes('pillar') || label.includes('pillar'))) {
                        try { World.remove(world, pb); } catch (e) {}
                        blocks.splice(pi, 1);
                    }
                }
            } catch (e) {
                console.warn('Pillar cleanup failed', e);
            }

            context.restore();
        } catch (e) {
            // avoid breaking render if Fritz overlay errors
            console.warn('Fritz zone render failed', e);
        }
    }

    // If Binary Zone is active (>=750 blocks above), render a green 0/1 field across the screen.
    if (camera._binaryZoneActive) {
        try {
            context.save();
            // Draw in screen-space so characters don't scale/translate oddly with the scene.
            context.setTransform(1,0,0,1,0,0);
            context.globalAlpha = 0.95;
            const fontSize = Math.max(12, Math.floor(Math.min(canvas.width, canvas.height) * 0.03));
            context.font = `bold ${fontSize}px Learninglings, monospace`;
            context.fillStyle = '#00FF00';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            // Grid spacing scales with font size so coverage feels dense at any viewport
            const spacingX = Math.max(22, fontSize * 1.6);
            const spacingY = Math.max(18, fontSize * 1.6);
            const cols = Math.ceil(canvas.width / spacingX) + 2;
            const rows = Math.ceil(canvas.height / spacingY) + 2;
            const offsetX = (Date.now() * 0.02) % spacingX; // slight subtle horizontal drift
            const offsetY = (Date.now() * 0.015) % spacingY; // slight vertical drift

            for (let r = -1; r < rows; r++) {
                for (let c = -1; c < cols; c++) {
                    // Use a deterministic pseudo-random pattern so the field looks organic but stable per frame
                    const seed = (r * 374761393 + c * 668265263 + Math.floor(camera.x) + Math.floor(camera.y)) >>> 0;
                    // simple Xorshift-ish mix to decide 0 or 1
                    let x = seed ^ (seed << 13);
                    x = x ^ (x >>> 17);
                    x = x ^ (x << 5);
                    const bit = (x & 1);
                    const char = bit ? '1' : '0';
                    const px = (c * spacingX) + offsetX + (spacingX/2);
                    const py = (r * spacingY) + offsetY + (spacingY/2);
                    // Slight per-char jitter to avoid perfect grid
                    const jitterX = ((seed % 13) - 6) * 0.6;
                    const jitterY = (((seed>>4) % 11) - 5) * 0.4;
                    context.fillText(char, px + jitterX, py + jitterY);
                }
            }
            context.restore();
        } catch (e) {
            console.warn('Binary zone overlay failed', e);
        }
    }

    // Gray Zone overlay: when extremely high, overlay glitching monochrome polygons and suppress normal star/nebula drawing.
    if (typeof grayZone !== 'undefined' ? grayZone : (false)) {
        camera._grayZoneActive = true;
        // Draw a static mid-gray base wash blending with existing sky
        context.fillStyle = 'rgba(40,40,40,0.9)';
        context.fillRect(0, 0, canvas.width, canvas.height);

        // Render animated glitch polygons (monochrome) across the screen for a noisy effect.
        const now = Date.now();
        const polyCount = 18; // number of glitch polygons
        for (let i = 0; i < polyCount; i++) {
            // truly scattered positions across the canvas (avoid diagonal sequencing)
            // use a lightweight time-varying pseudo-random position so polygons move but don't align on a diagonal
            const jitterSeed = Math.sin((now * 0.0007) + i * 12.9898) * 43758.5453;
            const px = (Math.abs(Math.sin(jitterSeed)) * (canvas.width + 160)) - 80;
            const py = (Math.abs(Math.cos(jitterSeed * 1.33)) * (canvas.height + 160)) - 80;

            // size/shape vary per-index and time for lively glitch motion
            const w = 60 + (i % 6) * 28 + Math.abs(Math.sin(now * 0.0017 * (i + 2))) * 48;
            const h = 30 + (i % 5) * 18 + Math.abs(Math.cos(now * 0.0013 * (i + 4))) * 36;
            const sides = 3 + (i % 6);

            // monochrome palette varying between black/white/gray
            const shade = Math.floor(30 + ((i * 37) % 200) + Math.round(Math.sin(now * 0.0009 + i) * 12));

            context.save();
            context.globalAlpha = 0.05 + (Math.abs(Math.sin(now * 0.0009 * (i + 1))) * 0.28);
            context.translate(px, py);
            context.rotate((Math.sin(now * 0.0006 * (i + 2)) * 0.8 + Math.cos(now * 0.0009 * (i + 3)) * 0.6) * 0.6);
            context.beginPath();
            for (let s = 0; s < sides; s++) {
                const a = (s / sides) * Math.PI * 2;
                const rx = Math.cos(a) * (w * (0.55 + (s % 2) * 0.10));
                const ry = Math.sin(a) * (h * (0.55 + ((s + 1) % 2) * 0.10));
                if (s === 0) context.moveTo(rx, ry);
                else context.lineTo(rx, ry);
            }
            context.closePath();
            context.fillStyle = `rgb(${shade},${shade},${shade})`;
            context.fill();

            // thin scanline stroke for glitch feel
            context.strokeStyle = `rgba(${Math.min(255, shade + 30)},${Math.min(255, shade + 30)},${Math.min(255, shade + 30)},0.06)`;
            context.lineWidth = 1;
            context.stroke();
            context.restore();
        }


    } else {
        camera._grayZoneActive = false;
    }


    // Horizon Glow (skip entirely when deep-high-altitude black sky is active)
    // Keep sun visible until 275 blocks above the ground as well as below spaceThreshold.
    if (!deepAbove && (altitude < spaceThreshold || blocksAbove < 275)) {
        const horizonGrad = context.createLinearGradient(0, canvas.height, 0, 0);
        horizonGrad.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
        horizonGrad.addColorStop(0.4, 'rgba(255, 255, 255, 0)');
        context.fillStyle = horizonGrad;
        context.fillRect(0, 0, canvas.width, canvas.height);

        // Sun
        context.save();
        const sunX = canvas.width * 0.8 - (camera.x * 0.05);
        const sunY = canvas.height * 0.2 - (camera.y * 0.05);
        // Keep a visible sun until 275 blocks above; reduce alpha with altitude but allow it up to that block threshold.
        const sunAlphaSpace = Math.max(0, 1 - (altitude / spaceThreshold));
        const sunAlphaBlocks = Math.max(0, 1 - (blocksAbove / 275));
        // Use the higher of the two alpha calculations so the sun persists until the block threshold.
        const sunAlpha = Math.max(sunAlphaSpace, sunAlphaBlocks);
        context.globalAlpha = sunAlpha;
        const sunGrad = context.createRadialGradient(sunX, sunY, 10, sunX, sunY, 100);
        sunGrad.addColorStop(0, '#FFF700');
        sunGrad.addColorStop(0.5, 'rgba(255, 200, 0, 0.5)');
        sunGrad.addColorStop(1, 'rgba(255, 150, 0, 0)');
        context.fillStyle = sunGrad;
        context.beginPath();
        context.arc(sunX, sunY, 200, 0, Math.PI * 2);
        context.fill();
        context.restore();
    }

    // Draw Stars in Space (skip entirely when deep-high-altitude black sky is active)
    // If Color Zone is active, suppress normal stars/nebulae and instead draw a subtle color-wash vignette.
    if (!deepAbove && altitude > fadeStart) {
        // If Color Zone active, reduce star opacity to near zero
        const baseStarOpacity = Math.min(1, (altitude - fadeStart) / (spaceThreshold - fadeStart));
        const starOpacity = camera._colorZoneActive ? 0.08 : baseStarOpacity;

        context.save();
        
        if (camera._colorZoneActive) {
            // Color Zone overlay: gentle radial wash using the current hue to emphasize the zone.
            const hue = camera._colorZoneHue || 320;
            const centerX = canvas.width / 2 - (camera.x * 0.02);
            const centerY = canvas.height * 0.35 - (camera.y * 0.01);
            const maxR = Math.max(canvas.width, canvas.height) * 0.9;
            const outer = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxR);
            outer.addColorStop(0, `hsla(${Math.round(hue)}, 85%, 55%, 0.45)`);
            outer.addColorStop(0.5, `hsla(${Math.round((hue + 40) % 360)}, 75%, 40%, 0.25)`);
            outer.addColorStop(1, `hsla(${Math.round((hue + 80) % 360)}, 70%, 25%, 0.0)`);
            context.globalAlpha = 1.0;
            context.fillStyle = outer;
            context.fillRect(0, 0, canvas.width, canvas.height);

            // Add a faint animated stripe band across the screen to sell the "Color Zone" effect
            const timeT = (Date.now() % 4000) / 4000;
            context.globalAlpha = 0.16;
            context.fillStyle = `hsla(${Math.round((hue + Math.sin(timeT * Math.PI * 2) * 30 + 360) % 360)}, 80%, 50%, 0.12)`;
            context.fillRect(-canvas.width * 0.5 + (timeT * canvas.width), canvas.height * 0.1, canvas.width * 2, canvas.height * 0.25);
        } else {
            // Draw Nebulae normally when not in Color Zone
            nebulaField.forEach(neb => {
                const screenX = neb.x - camera.x * neb.parallax;
                const screenY = neb.y - camera.y * neb.parallax;
                if (screenX > -neb.radius && screenX < canvas.width + neb.radius && screenY > -neb.radius && screenY < canvas.height + neb.radius) {
                    const grad = context.createRadialGradient(screenX, screenY, 0, screenX, screenY, neb.radius);
                    grad.addColorStop(0, neb.color);
                    grad.addColorStop(1, 'transparent');
                    context.globalAlpha = starOpacity;
                    context.fillStyle = grad;
                    context.fillRect(screenX - neb.radius, screenY - neb.radius, neb.radius * 2, neb.radius * 2);
                }
            });

            // Shooting Stars Logic
            if (Math.random() < 0.002 && starOpacity > 0.5) {
                shootingStars.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height * 0.5,
                    vx: (Math.random() - 0.5) * 20 + 10,
                    vy: Math.random() * 10 + 5,
                    life: 1.0
                });
            }
            shootingStars.forEach((ss, idx) => {
                context.strokeStyle = `rgba(255, 255, 255, ${ss.life * starOpacity})`;
                context.lineWidth = 2;
                context.beginPath();
                context.moveTo(ss.x, ss.y);
                context.lineTo(ss.x - ss.vx * 2, ss.y - ss.vy * 2);
                context.stroke();
                ss.x += ss.vx;
                ss.y += ss.vy;
                ss.life -= 0.02;
                if (ss.life <= 0) shootingStars.splice(idx, 1);
            });

            drawMilkyWay(context, canvas, camera, starOpacity);

            starField.forEach(star => {
                const screenX = star.x - camera.x * 0.08;
                const screenY = star.y - camera.y * 0.08;
                
                if (screenX > -100 && screenX < canvas.width + 100 && screenY > -100 && screenY < canvas.height + 100) {
                    const twinkle = (Math.sin(Date.now() * star.speed + star.twinkle) + 1) / 2;
                    context.globalAlpha = starOpacity * (0.3 + 0.7 * twinkle);
                    context.fillStyle = star.color;
                    context.beginPath();
                    context.arc(screenX, screenY, star.size, 0, Math.PI * 2);
                    context.fill();

                    if (star.glow && twinkle > 0.8) {
                        context.strokeStyle = star.color;
                        context.lineWidth = 0.5;
                        context.beginPath();
                        context.moveTo(screenX - 4, screenY); context.lineTo(screenX + 4, screenY);
                        context.moveTo(screenX, screenY - 4); context.lineTo(screenX, screenY + 4);
                        context.stroke();
                    }
                }
            });

            planetField.forEach(planet => {
                const screenX = planet.x - camera.x * planet.parallax;
                const screenY = planet.y - camera.y * planet.parallax;
                const totalBounds = planet.radius + 200;
                
                if (screenX > -totalBounds && screenX < canvas.width + totalBounds && screenY > -totalBounds && screenY < canvas.height + totalBounds) {
                    context.globalAlpha = starOpacity;
                    
                    // Moons
                    planet.moons.forEach(moon => {
                        const time = Date.now() * moon.speed + moon.angle;
                        const mx = screenX + Math.cos(time) * moon.orbitRadius;
                        const my = screenY + Math.sin(time) * moon.orbitRadius * 0.4; // Elliptical perspective
                        context.fillStyle = '#ccc';
                        context.beginPath();
                        context.arc(mx, my, moon.size, 0, Math.PI * 2);
                        context.fill();
                    });

                    // Rings (Back half)
                    if (planet.hasRings) {
                        context.save();
                        context.translate(screenX, screenY);
                        context.rotate(planet.ringAngle);
                        context.strokeStyle = 'rgba(255,255,255,0.2)';
                        context.lineWidth = 10;
                        context.beginPath();
                        context.ellipse(0, 0, planet.radius * 2.2, planet.radius * 0.5, 0, Math.PI, 0);
                        context.stroke();
                        context.restore();
                    }

                    // Shadow/3D effect
                    const grad = context.createRadialGradient(
                        screenX - planet.radius * 0.3, screenY - planet.radius * 0.3, planet.radius * 0.1,
                        screenX, screenY, planet.radius
                    );
                    grad.addColorStop(0, planet.fill);
                    grad.addColorStop(1, 'black');
                    
                    context.fillStyle = grad;
                    context.beginPath();
                    context.arc(screenX, screenY, planet.radius, 0, Math.PI * 2);
                    context.fill();
                    
                    context.strokeStyle = planet.outline;
                    context.lineWidth = 4;
                    context.stroke();

                    // Simple craters for detail
                    context.fillStyle = 'rgba(0,0,0,0.15)';
                    planet.craters.forEach(c => {
                        context.beginPath();
                        context.arc(screenX + c.lx * planet.radius, screenY + c.ly * planet.radius, c.r * planet.radius, 0, Math.PI * 2);
                        context.fill();
                    });

                    // Rings (Front half)
                    if (planet.hasRings) {
                        context.save();
                        context.translate(screenX, screenY);
                        context.rotate(planet.ringAngle);
                        context.strokeStyle = 'rgba(255,255,255,0.4)';
                        context.lineWidth = 10;
                        context.beginPath();
                        context.ellipse(0, 0, planet.radius * 2.2, planet.radius * 0.5, 0, 0, Math.PI);
                        context.stroke();
                        context.restore();
                    }
                }
            });
        }
        context.restore();
    }

    // Foreground Parallax Clouds
    context.save();
    const cloudTargetAltitude = 2500; // Sky height where clouds are most prominent
    // If deepAbove (The Void) is active, force clouds invisible; otherwise compute visibility normally.
    const cloudVisibility = deepAbove ? 0 : Math.max(0, 1 - Math.abs(altitude - cloudTargetAltitude) / 3000);
    context.globalAlpha = 0.7 * cloudVisibility;
    context.fillStyle = 'white';
    
    // Resize effect: clouds get bigger as we climb (getting closer to them)
    const altitudeScale = 1 + (altitude / 5000);

    const drawCloudLayer = (count, parallaxMult, yOffset, baseSize) => {
        for(let i = 0; i < count; i++) {
            const spacing = 800;
            const cx = ((i * spacing - camera.x * parallaxMult) % (canvas.width + spacing)) - spacing/2;
            const cy = (yOffset - camera.y * parallaxMult);
            const s = baseSize * altitudeScale;
            
            if (cy > -400 && cy < canvas.height + 400) {
                // Cloud shadow
                context.fillStyle = 'rgba(0,0,0,0.05)';
                context.beginPath();
                context.arc(cx, cy + 5, 52 * s, 0, Math.PI * 2);
                context.arc(cx + 40 * s, cy + 5 - 10 * s, 42 * s, 0, Math.PI * 2);
                context.arc(cx + 80 * s, cy + 5, 52 * s, 0, Math.PI * 2);
                context.fill();

                context.fillStyle = 'white';
                context.beginPath();
                context.arc(cx, cy, 50 * s, 0, Math.PI * 2);
                context.arc(cx + 40 * s, cy - 10 * s, 40 * s, 0, Math.PI * 2);
                context.arc(cx + 80 * s, cy, 50 * s, 0, Math.PI * 2);
                context.fill();
            }
        }
    };

    drawCloudLayer(10, 0.2, 300, 1.0); // Far layer
    drawCloudLayer(8, 0.4, 600, 1.8); // Nearer layer
    context.restore();

    // Apply Camera Transform
    context.scale(camera.zoom, camera.zoom);
    context.translate(-camera.x, -camera.y);

    const groundY = height;
    const viewLeft = camera.x;
    const viewRight = camera.x + canvas.width / camera.zoom;

    // Distant Hills (Parallax)
    const drawHillLayer = (color, offset, amp, freq) => {
        context.fillStyle = color;
        context.beginPath();
        context.moveTo(viewLeft, groundY);
        for (let hx = viewLeft; hx <= viewRight + 60; hx += 60) {
            const hy = groundY - offset + Math.sin(hx * freq) * amp;
            context.lineTo(hx, hy);
        }
        context.lineTo(viewRight, groundY);
        context.fill();
    };

    drawHillLayer('#3d8c40', 60, 40, 0.001); // Far hills
    drawHillLayer('#45a049', 30, 25, 0.002); // Near hills
    
    // Dirt layer
    context.fillStyle = '#8B4513';
    context.fillRect(viewLeft, groundY, viewRight - viewLeft, 2000);
    
    // Grass base (draw across the entire visible viewport so the ground appears infinite)
    const groundX = viewLeft - 1000; // extend a bit off-screen on the left
    const groundWidth = (viewRight - viewLeft) + 2000; // cover viewport plus padding on both sides
    context.fillStyle = '#4CAF50';
    context.fillRect(groundX, groundY - 20, groundWidth, 25);

    // Negative Area Background (Deep Below)
    const negativeAreaY = 4000;
    if (camera.y + canvas.height / camera.zoom > negativeAreaY - 1000) {
        context.save();
        context.fillStyle = 'rgba(0, 255, 255, 0.1)';
        context.fillRect(viewLeft, negativeAreaY, viewRight - viewLeft, 10000);
        
        // Draw "Negative" Grid
        context.strokeStyle = 'rgba(0, 255, 255, 0.2)';
        context.lineWidth = 5;
        for (let gy = negativeAreaY; gy < negativeAreaY + 5000; gy += 200) {
            context.beginPath();
            context.moveTo(viewLeft, gy);
            context.lineTo(viewRight, gy);
            context.stroke();
        }
        context.restore();
    }
    
    // Detailed Grass, Flowers, and Stones (cover the whole visible world horizontally so it feels infinite)
    context.strokeStyle = '#2E7D32';
    context.lineWidth = 2;
    const spacing = 35;

    // Extend slightly beyond view bounds so decorations don't pop at the edges
    const padCols = 20; // number of extra columns to draw off-screen
    const startCol = Math.floor((viewLeft) / spacing) - padCols;
    const endCol = Math.ceil((viewRight) / spacing) + padCols;

    for (let col = startCol; col <= endCol; col++) {
        const gx = col * spacing;
        const hash = Math.abs(Math.sin(gx * 0.001 + col * 0.13)) * 10; // vary hash for less repetition
        const grassH = 12 + hash * 1.5;
        
        drawGrass(context, gx, groundY - 18, grassH);
        drawGrass(context, gx + 15, groundY - 19, grassH * 0.7);

        // Slight horizontal jitter so patterns feel more natural
        const jitterX = (Math.sin(col * 1.7) * 6);

        // Decor
        if (hash > 8.5) {
            drawFlower(context, gx + spacing/2 + jitterX, groundY - 15, 3 + hash * 0.2);
        } else if (hash < 1.6) {
            drawStone(context, gx + spacing/2 + jitterX, groundY - 18, 4 + hash * 2);
        }
    }

    /* Rainbow trail rendering for number 7:
   Maintain short histories for each individual unit (tile) of any Numberblock 7 so each unit
   leaves its own rainbow trail. Trails are keyed by `${body.id}_${unitIndex}` and pruned when
   bodies are removed. Rendering draws each unit's segments with per-segment fade and width taper.
*/
    try {
        // Remove any trail entries whose body no longer exists
        for (const key of Array.from(trails.keys())) {
            // key format: "<bodyId>_<unitIndex>"
            const parts = String(key).split('_');
            const bodyId = parts[0];
            const exists = blocks.some(b => b && String(b.id) === String(bodyId));
            if (!exists) trails.delete(key);
        }

        // Update per-unit trails for blocks labeled 7
        for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi];
            if (!b || !b.renderData) continue;
            const label = b.renderData.number;
            if (!(getNumericValue(label) === 7 || String(label) === '7')) {
                // if block isn't a 7, ensure any of its unit-trails are removed
                if (b.id !== undefined) {
                    const prefix = String(b.id) + '_';
                    for (const k of Array.from(trails.keys())) {
                        if (k.startsWith(prefix)) trails.delete(k);
                    }
                }
                continue;
            }

            // For 7-blocks, create/update a separate trail per visible unit
            const units = b.renderData.units || [];
            for (let uIdx = 0; uIdx < units.length; uIdx++) {
                const u = units[uIdx];
                if (!u) continue;
                // compute world-space position of this unit
                const rotated = Matter.Vector.rotate({ x: u.localX, y: u.localY }, b.angle || 0);
                const wx = b.position.x + rotated.x;
                const wy = b.position.y + rotated.y;

                const trailKey = `${b.id}_${uIdx}`;
                let arr = trails.get(trailKey);
                if (!arr) {
                    arr = [];
                    trails.set(trailKey, arr);
                }
                arr.push({ x: wx, y: wy, t: Date.now() });
                // cap trail length per-unit
                const MAX_TRAIL = 18;
                while (arr.length > MAX_TRAIL) arr.shift();
            }

            // Clean up any orphaned unit-trails for this body if number of units decreased
            if (b.id !== undefined) {
                const prefix = String(b.id) + '_';
                for (const k of Array.from(trails.keys())) {
                    if (!k.startsWith(prefix)) continue;
                    const parts = k.split('_');
                    const idx = parseInt(parts[1], 10);
                    if (!Number.isFinite(idx) || idx >= (b.renderData.units || []).length) {
                        trails.delete(k);
                    }
                }
            }
        }

        // Draw trails (segmented colored strokes). Use a rainbow array and apply per-segment alpha tapering.
        const rainbow = ['#ff0000','#ff8800','#ffff00','#00bb00','#00ffff','#8800ff','#ff00ff'];
        const ctxTrail = context; // already transformed into world space
        ctxTrail.save();
        ctxTrail.globalCompositeOperation = 'lighter';

        trails.forEach((posArr, key) => {
            if (!posArr || posArr.length < 2) return;
            // pick a base hue index for this unit so neighboring units vary slightly
            // use a simple hash from key to spread colors
            let hash = 0;
            for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
            // color offset based on hash
            const colorOffset = hash % rainbow.length;

            for (let s = 0; s < posArr.length - 1; s++) {
                const p0 = posArr[s];
                const p1 = posArr[s + 1];
                const tNorm = (s + 1) / Math.max(1, posArr.length - 1);
                const color = rainbow[(Math.floor(tNorm * (rainbow.length - 1)) + colorOffset) % rainbow.length];
                const alpha = 0.2 + 0.8 * tNorm;
                ctxTrail.strokeStyle = color;
                ctxTrail.globalAlpha = alpha;
                // taper width so head is thicker but keep units slightly narrower than body trails for clarity
                const lw = Math.max(1.2, (UNIT_SIZE * 0.7) * (0.25 + 0.75 * tNorm));
                ctxTrail.lineWidth = lw;
                ctxTrail.beginPath();
                ctxTrail.moveTo(p0.x, p0.y);
                ctxTrail.lineTo(p1.x, p1.y);
                ctxTrail.stroke();
            }
        });

        ctxTrail.globalCompositeOperation = 'source-over';
        ctxTrail.globalAlpha = 1.0;
        ctxTrail.restore();
    } catch (e) {
        console.warn('Rainbow per-unit trail render failed', e);
    }

    // Use a try-catch and safe iteration to prevent one bad block from breaking the entire frame
    for (let i = 0; i < blocks.length; i++) {
        const body = blocks[i];
        if (!body || !body.renderData) continue;
        
        try {
            // Draw sprite-style bodies (costume) before the standard numberblock rendering
            // Early special-case: render the corrupted "hand-drawn" token as a head-only costume with NO BODY.
            try {
                const labelForCostumeOnly = String(body.renderData && body.renderData.number || '');
                if (labelForCostumeOnly.startsWith('a̷')) {
                    // Draw only the head costume '/costume1 3.svg' at the block's world position.
                    try {
                        const imgUrl = '/costume1 3.svg';
                        const img = imageCache[imgUrl];
                        if (!img) {
                            // begin async load for future frames
                            ensureImage(imgUrl).catch(() => {});
                        } else {
                            context.save();
                            const posX = isFinite(body.position.x) ? body.position.x : 0;
                            const posY = isFinite(body.position.y) ? body.position.y : 0;
                            context.translate(posX, posY);
                            context.rotate(body.angle || 0);
                            // Reduced size so the head-only costume is visually smaller
                            const drawW = UNIT_SIZE * 1.2;
                            const aspect = img.height && img.width ? (img.height / img.width) : 1;
                            const drawH = drawW * aspect;
                            // draw image so its bottom sits on the block head anchor (slightly adjusted offset)
                            context.drawImage(img, -drawW / 2, -drawH + (drawH * 0.08), drawW, drawH);

                            // If this corrupted token has active speech, draw its speech bubble above the head.
                            try {
                                if (body.activeSpeech && Date.now() < (body.speechExpiry || 0)) {
                                    // Position the bubble slightly above the drawn image top.
                                    const bubbleY = -drawH - (UNIT_SIZE * 0.18);
                                    drawSpeechBubble(context, 0, bubbleY, body.activeSpeech, UNIT_SIZE);
                                }
                            } catch (e) {
                                console.warn('Failed to draw speech bubble for head-only costume', e);
                            }

                            context.restore();
                        }
                    } catch (e) {
                        console.warn('Head-only costume draw failed', e);
                    }
                    // Skip the rest of the rendering for this block (no body, no name tag)
                    continue;
                }
            } catch (e) {
                // ignore and continue to normal sprite handling if this check fails
            }

            if (body.spriteUrl) {
                try {
                    // Special-case: 1,000,000 is drawn as a single non-mergeable large cube-like sprite
                    // visually similar to the 1000 cube but 100× larger (rendered via a 10×10 macro-grid for performance).
                    if (false && body.renderData && body.renderData.number === 1000000) {
                        context.save();
                        const posX = isFinite(body.position.x) ? body.position.x : 0;
                        const posY = isFinite(body.position.y) ? body.position.y : 0;
                        context.translate(posX, posY);
                        context.rotate(body.angle || 0);

                        // macro rendering params
                        const macro = 10; // macro grid: 10x10 macro cells, each representing 10x10 units (100 total)
                        const cellSize = UNIT_SIZE * 10;
                        const w = (body.spriteW || (cellSize * macro));
                        const h = (body.spriteH || (cellSize * macro));

                        // Slight depth to emulate a massive cube
                        const depthScale = 0.45;
                        const depthX = cellSize * depthScale;
                        const depthY = -cellSize * depthScale;
                        const startX = -cellSize * (macro / 2);
                        const startY = -cellSize * (macro / 2);

                        // Top Face (macro-grid)
                        for (let i = 0; i < macro; i++) {
                            for (let j = 0; j < macro; j++) {
                                const x = startX + j * cellSize + i * depthX;
                                const y = startY + i * depthY;
                                context.fillStyle = (i + j) % 2 === 0 ? '#ff6666' : '#cc4444';
                                context.beginPath();
                                context.moveTo(x, y);
                                context.lineTo(x + cellSize, y);
                                context.lineTo(x + cellSize + depthX, y + depthY);
                                context.lineTo(x + depthX, y + depthY);
                                context.closePath();
                                context.fill();
                            }
                        }

                        // Right Face (macro-grid)
                        const rightEdgeX = startX + macro * cellSize;
                        for (let i = 0; i < macro; i++) {
                            for (let j = 0; j < macro; j++) {
                                const x = rightEdgeX + i * depthX;
                                const y = startY + j * cellSize + i * depthY;
                                context.fillStyle = (i + j) % 2 === 0 ? '#993333' : '#662222';
                                context.beginPath();
                                context.moveTo(x, y);
                                context.lineTo(x + depthX, y + depthY);
                                context.lineTo(x + depthX, y + depthY + cellSize);
                                context.lineTo(x, y + cellSize);
                                context.closePath();
                                context.fill();
                            }
                        }

                        // subtle outer border to separate from background
                        context.strokeStyle = 'rgba(0,0,0,0.06)';
                        context.lineWidth = Math.max(1, Math.floor(UNIT_SIZE * 0.02));
                        context.strokeRect(-w/2 + 2, -h/2 + 2, w - 4, h - 4);

                        context.restore();
                    } else {
                        const img = imageCache[body.spriteUrl];
                        // If not cached, start loading but still skip drawing this frame
                        if (!img) {
                            ensureImage(body.spriteUrl).catch(() => {});
                        } else {
                            context.save();
                            const posX = isFinite(body.position.x) ? body.position.x : 0;
                            const posY = isFinite(body.position.y) ? body.position.y : 0;
                            context.translate(posX, posY);
                            context.rotate(body.angle || 0);
                            // draw centered
                            const w = body.spriteW || UNIT_SIZE * 4;
                            const h = body.spriteH || UNIT_SIZE * 4;
                            // Keep image crisp by drawing with integered dims
                            context.drawImage(img, -w/2, -h/2, w, h);

                            // Draw a numeric label for the 1M sprite so it clearly shows its value
                            try {
                                if (body.renderData && (body.renderData.number === 1000000 || String(body.renderData.number) === '1000000')) {
                                    context.fillStyle = 'rgba(0,0,0,0.9)';
                                    // choose a legible size relative to UNIT_SIZE but capped for very small viewports
                                    const fontS = Math.max(18, Math.round(UNIT_SIZE * 0.8));
                                    context.font = `bold ${fontS}px Learninglings, sans-serif`;
                                    context.textAlign = 'center';
                                    context.textBaseline = 'top';
                                    // place label near the top of the sprite so it doesn't overlap the artwork
                                    context.fillText('1,000,000', 0, -h/2 + Math.max(18, fontS * 0.4));
                                }
                            } catch (labelErr) {
                                console.warn('Failed to draw 1M label', labelErr);
                            }

                            // If a chatMessage is set on the sprite body, draw a speech bubble above it
                            try {
                                if (body.chatMessage && Date.now() < (body.chatExpiry || 0)) {
                                    // drawSpeechBubble expects coordinates in the current transformed context;
                                    // draw it slightly above the top edge of the sprite (use UNIT_SIZE as scale)
                                    drawSpeechBubble(context, 0, -h/2 - (UNIT_SIZE * 0.35), body.chatMessage, Math.max(UNIT_SIZE * 0.85, 12));
                                }
                            } catch (err) {
                                // drawing the bubble should never break rendering
                                console.warn('chat bubble draw failed', err);
                            }

                            context.restore();
                        }
                    }
                } catch (e) {
                    // continue to other rendering if sprite draw fails
                }
            }

            const { number, unitSize, units, isSquare: isSquareNum, isSuperRect } = body.renderData;
            if (!units || units.length === 0) continue;
            
            context.save();
            // Fallback to 0 if positions are NaN
            const posX = isFinite(body.position.x) ? body.position.x : 0;
            const posY = isFinite(body.position.y) ? body.position.y : 0;
            context.translate(posX, posY);
        context.rotate(body.angle || 0);


        // Find highest unit for face placement
        let highestUnit = units.find(u => u !== undefined);
        if (highestUnit) {
            units.forEach(u => { 
                if (u && u.localY < highestUnit.localY) highestUnit = u; 
            });
        }

        const hundredThreshold = (typeof number === 'number') ? Math.floor(Math.abs(number) / 100) * 100 : 0;

        // 3D Effect for 1000: Convincing 10x10x10 cube projection
        // Also render 1,000,000 as the same stylized cube but 100× larger visually by drawing a 10×10 macro-grid
        // where each macro-cell represents a 10×10 cluster (cheaper than drawing 1,000,000 items).
        if (number === 1000 || number === 1000000) {
            context.save();

            if (number === 1000) {
                const depthScale = 0.5;
                const depthX = unitSize * depthScale;
                const depthY = -unitSize * depthScale;
                const startX = -unitSize * 5;
                const startY = -unitSize * 5;

                // Top Face (10x10 grid)
                for (let i = 0; i < 10; i++) {
                    for (let j = 0; j < 10; j++) {
                        const x = startX + j * unitSize + i * depthX;
                        const y = startY + i * depthY;
                        context.fillStyle = (i + j) % 2 === 0 ? '#ff4444' : '#aa0000';
                        context.beginPath();
                        context.moveTo(x, y);
                        context.lineTo(x + unitSize, y);
                        context.lineTo(x + unitSize + depthX, y + depthY);
                        context.lineTo(x + depthX, y + depthY);
                        context.closePath();
                        context.fill();
                        context.strokeStyle = '#330000';
                        context.lineWidth = 0.5;
                        context.stroke();
                    }
                }

                // Right Face (10x10 grid)
                const rightEdgeX = startX + 10 * unitSize;
                for (let i = 0; i < 10; i++) {
                    for (let j = 0; j < 10; j++) {
                        const x = rightEdgeX + i * depthX;
                        const y = startY + j * unitSize + i * depthY;
                        context.fillStyle = (i + j) % 2 === 0 ? '#990000' : '#440000';
                        context.beginPath();
                        context.moveTo(x, y);
                        context.lineTo(x + depthX, y + depthY);
                        context.lineTo(x + depthX, y + depthY + unitSize);
                        context.lineTo(x, y + unitSize);
                        context.closePath();
                        context.fill();
                        context.strokeStyle = '#220000';
                        context.lineWidth = 0.5;
                        context.stroke();
                    }
                }
            } else {
                // number === 1000000 -> render as a 100x100 visual made from a 10x10 macro-grid where each macro cell = 10 units
                const macro = 10; // macro grid size (10x10 macro cells)
                const cellSize = unitSize * 10; // each macro-cell represents 10x10 units
                const depthScale = 0.45; // slightly smaller depth for readability
                const depthX = cellSize * depthScale;
                const depthY = -cellSize * depthScale;

                // center the large cube: half width/height = (macro * cellSize) / 2
                const startX = -cellSize * (macro / 2);
                const startY = -cellSize * (macro / 2);

                // Top Face (macro-grid)
                for (let i = 0; i < macro; i++) {
                    for (let j = 0; j < macro; j++) {
                        const x = startX + j * cellSize + i * depthX;
                        const y = startY + i * depthY;
                        // alternate colors for a checker macro look while staying performance-friendly
                        context.fillStyle = (i + j) % 2 === 0 ? '#ff6666' : '#cc4444';
                        context.beginPath();
                        context.moveTo(x, y);
                        context.lineTo(x + cellSize, y);
                        context.lineTo(x + cellSize + depthX, y + depthY);
                        context.lineTo(x + depthX, y + depthY);
                        context.closePath();
                        context.fill();
                        context.strokeStyle = '#330000';
                        context.lineWidth = Math.max(0.8, unitSize * 0.02);
                        context.stroke();
                    }
                }

                // Right Face (macro-grid)
                const rightEdgeX = startX + macro * cellSize;
                for (let i = 0; i < macro; i++) {
                    for (let j = 0; j < macro; j++) {
                        const x = rightEdgeX + i * depthX;
                        const y = startY + j * cellSize + i * depthY;
                        context.fillStyle = (i + j) % 2 === 0 ? '#993333' : '#662222';
                        context.beginPath();
                        context.moveTo(x, y);
                        context.lineTo(x + depthX, y + depthY);
                        context.lineTo(x + depthX, y + depthY + cellSize);
                        context.lineTo(x, y + cellSize);
                        context.closePath();
                        context.fill();
                        context.strokeStyle = '#220000';
                        context.lineWidth = Math.max(0.8, unitSize * 0.02);
                        context.stroke();
                    }
                }
            }

            context.restore();
        }

        const { isRound, isTriangle, baseColor } = body.renderData;
        if ((isRound || isTriangle) && number !== 4) {
            context.save();
            // Special minimal rendering for 0: only a mouth and the number label (no body or eyes)
            if (number === 0) {
                // Draw mouth only (no head circle)
                context.strokeStyle = 'black';
                context.lineWidth = 2;
                // Move mouth slightly up so 0 looks subtly happier
                const mY = (isTriangle ? unitSize * 0.3 : unitSize * 0.1) - unitSize * 0.05;
                context.beginPath();
                context.arc(0, mY, unitSize * 0.15, 0.1 * Math.PI, 0.9 * Math.PI);
                context.stroke();

                // Number label (just "0")
                context.fillStyle = 'black';
                // Slightly larger name tag for 0
                context.font = `bold ${unitSize * 0.7}px Learninglings, sans-serif`;
                context.textAlign = 'center';
                context.textBaseline = 'bottom';
                context.fillText('0', 0, -unitSize * 0.7);

                if (body.activeSpeech && Date.now() < body.speechExpiry) {
                    drawSpeechBubble(context, 0, -unitSize * 1.5, body.activeSpeech, unitSize);
                }

                context.restore();
                return;
            }

            // Default rendering for other round/triangle numbers
            context.fillStyle = baseColor || 'white';
            
            if (isRound) {
                context.beginPath();
                context.arc(0, 0, unitSize * 0.6, 0, Math.PI * 2);
                context.fill();
            } else if (isTriangle) {
                context.beginPath();
                context.moveTo(0, -unitSize * 0.7);
                context.lineTo(-unitSize * 0.7, unitSize * 0.7);
                context.lineTo(unitSize * 0.7, unitSize * 0.7);
                context.closePath();
                context.fill();
            }

            context.strokeStyle = 'black';
            context.lineWidth = 2;
            context.stroke();

            // Mouth
            context.beginPath();
            const mY = isTriangle ? unitSize * 0.3 : unitSize * 0.1;
            context.arc(0, mY, unitSize * 0.15, 0.1 * Math.PI, 0.9 * Math.PI);
            context.stroke();

            // Eyes
            const isLetterBlock = typeof number === 'string' && /^[A-Z]$/.test(number);
            const eSize = isLetterBlock ? unitSize * 0.15 : unitSize * 0.12;
            const eOff = isLetterBlock ? unitSize * 0.25 : unitSize * 0.2;
            const eY = isTriangle ? unitSize * 0.1 : -unitSize * 0.1;

            if (number === 'ππ') {
                drawEye(context, -unitSize * 0.6, eY, eSize);
                drawEye(context, -unitSize * 0.2, eY, eSize);
                drawEye(context, unitSize * 0.2, eY, eSize);
                drawEye(context, unitSize * 0.6, eY, eSize);
            } else if (number === 'πππ') {
                for(let k=-1; k<=1; k++) {
                    drawEye(context, k*unitSize*0.8 - eOff, eY, eSize);
                    drawEye(context, k*unitSize*0.8 + eOff, eY, eSize);
                }
            } else if (['+', '-', '^', '*', '÷', '×', '/', 'random'].includes(number)) {
                // Operators get tiny cute eyes
                drawEye(context, -eOff * 0.5, eY, eSize * 0.5);
                drawEye(context, eOff * 0.5, eY, eSize * 0.5);
            } else if (number !== 0) {
                drawEye(context, -eOff, eY, eSize);
                drawEye(context, eOff, eY, eSize);
            }
            
            // Label
            context.fillStyle = 'black';
            context.font = `bold ${unitSize * (isLetterBlock ? 0.8 : 0.5)}px Learninglings, sans-serif`;
            context.textAlign = 'center';
            context.textBaseline = 'bottom';
            const displayLabel = body.renderData.displayLabel;
            let labelText = displayLabel ? displayLabel : number.toString();
            if (labelText === 'pi' || labelText === 'PI') labelText = 'π';
            else if (labelText === 'ππ') labelText = 'ππ';
            else if (labelText === 'πππ') labelText = 'πππ';
            else if (labelText === 'tan') labelText = 'tan';
            else if (labelText === 'Π') labelText = 'Π';
            else if (labelText === 'Ω') labelText = 'Ω';
            context.fillText(labelText, 0, -unitSize * 0.6);

            if (body.activeSpeech && Date.now() < body.speechExpiry) {
                drawSpeechBubble(context, 0, -unitSize * 1.5, body.activeSpeech, unitSize);
            }
            
            context.restore();
            return;
        }

        units.forEach((u, index) => {
            if (!u) return;
            let color = u.color;
            
            // Large number checkerboards
            if (number === 0.125) color = '#FFD1DC';
            if (number === 0.25) color = '#FFB6C1';
            if (number === 0.75) color = '#FF5E7E';
            if (number === 0.975) color = '#FF1493';

            if (index >= hundredThreshold) {
                const unitModIndex = index - hundredThreshold;
                const tensCount = Math.floor((number % 100) / 10) * 10;
                
                if (unitModIndex >= tensCount) {
                    // This is a "ones" unit
                    // Rainbow for any block whose ones digit is 7 (covers 7, 17, 27, ...), use row+col for more even distribution
                    const onesDigit = (typeof number === 'number') ? Math.floor(Math.abs(number)) % 10 : null;
                    const isSevenOnes = onesDigit === 7 || u.originalNumber === 7 || u.originalNumber === '7';
                    if (!u.isTenPart && isSevenOnes) {
                        const rainbow = ['#8800ff', '#4b0082', '#0000ff', '#00ff00', '#ffff00', '#ff8800', '#ff0000'];
                        const idx = (typeof u.row === 'number' && typeof u.col === 'number') ? ((u.row + u.col) % rainbow.length) : (u.row % rainbow.length);
                        color = rainbow[(idx + rainbow.length) % rainbow.length];
                    }
                    
                    if (u.originalNumber === 9 && !u.isTenPart && (number % 10 === 9)) {
                        if (u.row === 0) color = '#404040';
                        else if (u.row === 1) color = '#808080';
                        else color = '#d3d3d3';
                    }
                }
            }

            // If this block was flattened by a 10000 sprite, draw much flatter units and add a small crushed detail.
            const isFlat = !!body.renderData.flat;
            context.fillStyle = isFlat ? mixColors(color || '#ffffff', '#dddddd') : color;
            context.beginPath();
            let drawH, drawW, drawY;
            if (isFlat) {
                // Very thin pancake height, sit slightly lower to look squashed
                drawW = unitSize;
                drawH = unitSize * 0.12;
                // move the flattened quad down so it appears pressed onto its base
                drawY = u.localY + unitSize * 0.45;
                context.rect(u.localX - drawW/2, drawY - drawH/2, drawW, drawH);
            } else {
                drawH = u.isQuarter ? unitSize * 0.5 : (u.isThreeQuarters ? unitSize * 0.75 : (u.isHalf ? unitSize * 0.5 : unitSize));
                drawW = u.isQuarter ? unitSize * 0.5 : unitSize;
                drawY = u.localY;
                context.rect(u.localX - drawW/2, drawY - drawH / 2, drawW, drawH);
            }
            context.fill();

            // Squished Bevel / crushed shadow
            context.strokeStyle = isFlat ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.4)';
            context.lineWidth = 1;
            context.beginPath();
            const bMargin = 1; 
            if (isFlat) {
                // subtle crushed rim on top and a faint crack line
                context.moveTo(u.localX - unitSize/2 + bMargin, drawY - drawH/2 + bMargin);
                context.lineTo(u.localX + unitSize/2 - bMargin, drawY - drawH/2 + bMargin);
                context.stroke();

                // faint crack
                context.strokeStyle = 'rgba(0,0,0,0.08)';
                context.lineWidth = 1;
                context.beginPath();
                context.moveTo(u.localX - drawW * 0.3, drawY);
                context.lineTo(u.localX + drawW * 0.05, drawY + drawH * 0.05);
                context.lineTo(u.localX + drawW * 0.35, drawY - drawH * 0.02);
                context.stroke();
            } else {
                context.moveTo(u.localX - unitSize/2 + bMargin, u.localY + drawH/2 - bMargin);
                context.lineTo(u.localX - unitSize/2 + bMargin, u.localY - drawH/2 + bMargin);
                context.lineTo(u.localX + unitSize/2 - bMargin, u.localY - drawH/2 + bMargin);
                context.stroke();
            }

            // Draw a single large violet spot marker for units that are tagged with `spot`
            if (u.spot && !isFlat) {
                try {
                    const spotCol = u.spotColor || '#ad4fff';
                    context.fillStyle = spotCol;
                    // single centered spot per unit, sized proportionally to unit size
                    const s = Math.max(4, unitSize * 0.18);
                    context.beginPath();
                    context.arc(u.localX, u.localY, s, 0, Math.PI * 2);
                    context.fill();
                } catch (e) {
                    // drawing safety
                }
            }

            if (u.isTenPart && !isFlat) {
                context.strokeStyle = u.outlineColor || 'red';
                context.lineWidth = 3;
                const half = unitSize / 2;
                
                // Check if neighbor is also a "ten part" to skip inner outlines
                const hasTenNeighbor = (dx, dy) => units.some(other => 
                    other.isTenPart && 
                    Math.abs(other.localX - (u.localX + dx)) < 2 && 
                    Math.abs(other.localY - (u.localY + dy)) < 2
                );

                // Draw edges only if no "ten" neighbor exists in that direction
                if (!hasTenNeighbor(0, -unitSize)) { // Top
                    context.beginPath(); context.moveTo(u.localX - half, u.localY - half); context.lineTo(u.localX + half, u.localY - half); context.stroke();
                }
                if (!hasTenNeighbor(0, unitSize)) { // Bottom
                    context.beginPath(); context.moveTo(u.localX - half, u.localY + half); context.lineTo(u.localX + half, u.localY + half); context.stroke();
                }
                if (!hasTenNeighbor(-unitSize, 0)) { // Left
                    context.beginPath(); context.moveTo(u.localX - half, u.localY - half); context.lineTo(u.localX - half, u.localY + half); context.stroke();
                }
                if (!hasTenNeighbor(unitSize, 0)) { // Right
                    context.beginPath(); context.moveTo(u.localX + half, u.localY - half); context.lineTo(u.localX + half, u.localY + half); context.stroke();
                }
            } else if (!isFlat) {
                context.strokeStyle = 'rgba(0,0,0,0.1)';
                context.lineWidth = 1;
                context.stroke();
            }
        });
        
        if (!highestUnit) {
            context.restore();
            continue;
        }
        const faceY = highestUnit.localY;
        let faceX = highestUnit.localX;
        
        // For multiples of 100, center the face horizontally relative to the block if in auto/wide
        if (number >= 100) faceX = 0;

        const eyeSize = unitSize * (number >= 1000 ? 0.25 : 0.15);
        const eyeOffset = unitSize * 0.2;

        context.strokeStyle = 'black';
        context.lineWidth = 1;

        const isEvil = false;
        
        // Determine if the numeric label represents a composite integer ( >1 and not prime )
        const numericLabel = (typeof number === 'number') ? number : (parseFloat(number) || NaN);
        function isPrime(n) {
            if (!Number.isInteger(n) || n <= 1) return false;
            if (n <= 3) return true;
            if (n % 2 === 0 || n % 3 === 0) return false;
            for (let i = 5; i * i <= n; i += 6) {
                if (n % i === 0 || n % (i + 2) === 0) return false;
            }
            return true;
        }
        const isCompositeNumber = Number.isInteger(numericLabel) && numericLabel > 1 && !isPrime(numericLabel);

        // Eyes: perfect squares get square eyes; composite (non-square) integers get rectangular eyes;
        // but force circular eyes for specific overrides (6, 8, 10, 14, 15, 21, 22).
        let eyeFunc = drawEye;
        const circularOverrides = [6, 8, 10, 14, 15, 21, 22];

        // count divisors for small integer numbers (safe, cheap)
        function factorCountLocal(n) {
            if (!Number.isInteger(n) || n <= 0) return Infinity;
            let cnt = 0;
            const limit = Math.floor(Math.sqrt(n));
            for (let d = 1; d <= limit; d++) {
                if (n % d === 0) {
                    cnt += (d * d === n) ? 1 : 2;
                    if (cnt >= 5) return cnt; // early exit if already >=5
                }
            }
            return cnt;
        }

        // numericLabel may be NaN for non-numeric labels; only apply override for exact numeric matches
        // Rule: integers with fewer than 5 factors get circular eyes (unless they're perfect squares)
        if (Number.isFinite(numericLabel) && Number.isInteger(numericLabel) && factorCountLocal(numericLabel) < 5 && !isSquareNum) {
            eyeFunc = drawEye;
        } else if (Number.isFinite(numericLabel) && circularOverrides.includes(numericLabel)) {
            eyeFunc = drawEye;
        } else if (isSquareNum) {
            eyeFunc = drawSquareEye;
        } else if (isCompositeNumber) {
            eyeFunc = drawRectangularEye;
        }

        // Ensure perfect-square numbers always get square eyes no matter prior overrides
        if (isSquareNum) {
            eyeFunc = drawSquareEye;
        }

        if (number === 'infinity' || number === 'inf1') {
            const infEyeScale = number === 'inf1' ? 1 : 2;
            drawEye(context, faceX - eyeOffset * infEyeScale, faceY, eyeSize * infEyeScale);
            drawEye(context, faceX + eyeOffset * infEyeScale, faceY, eyeSize * infEyeScale);
        } else if (typeof number === 'number' && number < 0) {
            // Inverted Face for all Negatives
            context.save();
            context.scale(1, -1);
            // Use standard eye size but inverted
            const negEyeSize = number === -1 ? eyeSize * 1.5 : eyeSize;
            if (number === -1) {
                eyeFunc(context, faceX, -faceY, negEyeSize);
            } else {
                eyeFunc(context, faceX - eyeOffset, -faceY, negEyeSize);
                eyeFunc(context, faceX + eyeOffset, -faceY, negEyeSize);
            }
            context.beginPath();
            context.arc(faceX, -faceY + unitSize * 0.2, unitSize * 0.15, 0.1 * Math.PI, 0.9 * Math.PI);
            context.stroke();
            context.restore();
        } else if (number === 0.25) {
            // Special 0.25 face
            const qEyeSize = unitSize * 0.15;
            drawQuarterEye(context, faceX - unitSize * 0.05, faceY - unitSize * 0.05, qEyeSize);
            
            // Blush
            context.fillStyle = 'rgba(255, 105, 180, 0.4)';
            context.beginPath();
            context.arc(faceX - unitSize * 0.15, faceY + unitSize * 0.1, unitSize * 0.08, 0, Math.PI * 2);
            context.fill();
            context.beginPath();
            context.arc(faceX + unitSize * 0.15, faceY + unitSize * 0.1, unitSize * 0.08, 0, Math.PI * 2);
            context.fill();

            // Cute mouth
            context.strokeStyle = 'black';
            context.lineWidth = 1;
            context.beginPath();
            context.arc(faceX, faceY + unitSize * 0.1, unitSize * 0.05, 0.1 * Math.PI, 0.9 * Math.PI);
            context.stroke();
        } else if (number === 0.75) {
            // Special 0.75 face
            const tqEyeSize = unitSize * 0.15;
            drawThreeQuartersEye(context, faceX, faceY, tqEyeSize);

            // Blush
            context.fillStyle = 'rgba(255, 105, 180, 0.4)';
            context.beginPath();
            context.arc(faceX - unitSize * 0.15, faceY + unitSize * 0.1, unitSize * 0.08, 0, Math.PI * 2);
            context.fill();
            context.beginPath();
            context.arc(faceX + unitSize * 0.15, faceY + unitSize * 0.1, unitSize * 0.08, 0, Math.PI * 2);
            context.fill();

            // Cute mouth
            context.strokeStyle = 'black';
            context.lineWidth = 1;
            context.beginPath();
            context.arc(faceX, faceY + unitSize * 0.1, unitSize * 0.05, 0.1 * Math.PI, 0.9 * Math.PI);
            context.stroke();
        } else if (body.isAngel) {
            // Halo Drawing
            context.save();
            context.strokeStyle = '#FFD700'; // Gold/Yellow
            context.lineWidth = 4;
            context.beginPath();
            context.ellipse(faceX, faceY - unitSize * 0.8, unitSize * 0.6, unitSize * 0.2, 0, 0, Math.PI * 2);
            context.stroke();
            context.globalAlpha = 0.3;
            context.fillStyle = '#FFF700';
            context.fill();
            context.restore();

            // Calm eyes (closed/serene)
            context.strokeStyle = 'black';
            context.lineWidth = 2;
            context.beginPath();
            context.arc(faceX - eyeOffset, faceY, eyeSize, 0, Math.PI);
            context.stroke();
            context.beginPath();
            context.arc(faceX + eyeOffset, faceY, eyeSize, 0, Math.PI);
            context.stroke();
        } else if (isEvil) {
            drawEvilEye(context, faceX - eyeOffset * 2, faceY, eyeSize * 2);
            drawEvilEye(context, faceX + eyeOffset * 2, faceY, eyeSize * 2);
        } else if (number === 1) {
            // Single centered circular eye for 1 (slightly larger)
            drawEye(context, faceX, faceY, eyeSize * 1.25);
        } else if (number === 5) {
            // For 5: draw a deep-blue star "on the back" of the left eye, then normal eyes
            // place the star slightly behind/offset from the left eye (moved a bit right)
            drawStar(context, faceX - eyeOffset - unitSize * 0.02, faceY - unitSize * 0.03, eyeSize * 1.9, '#001f7a', 5, 0.5);
            drawEye(context, faceX - eyeOffset, faceY, eyeSize);
            drawEye(context, faceX + eyeOffset, faceY, eyeSize);
        } else if (number === 6) {
            // For 6: normal eyes plus three eyelashes on the top of each eye
            drawEye(context, faceX - eyeOffset, faceY, eyeSize);
            drawEye(context, faceX + eyeOffset, faceY, eyeSize);

            // Draw three short eyelashes above each eye
            context.save();
            context.strokeStyle = 'black';
            context.lineWidth = Math.max(1, unitSize * 0.04);
            const lashLen = unitSize * 0.12;
            // angles (radians) offset from vertical upward; spread left-to-right
            const lashAngles = [-0.35, 0, 0.35];
            [faceX - eyeOffset, faceX + eyeOffset].forEach(cx => {
                lashAngles.forEach(a => {
                    // start point slightly above the eye rim (moved slightly upward)
                    const sx = cx + Math.cos(a - Math.PI / 2) * (eyeSize * 0.6);
                    // lift the lash anchor a bit higher so eyelashes point slightly up
                    const sy = faceY + Math.sin(a - Math.PI / 2) * (eyeSize * 0.6) - (unitSize * 0.08);
                    const ex = sx + Math.cos(a - Math.PI / 2) * lashLen;
                    const ey = sy + Math.sin(a - Math.PI / 2) * lashLen;
                    context.beginPath();
                    context.moveTo(sx, sy);
                    context.lineTo(ex, ey);
                    context.stroke();
                });
            });
            context.restore();
        } else if (number === 'DOG') {
            // Dog eyes
            drawEye(context, faceX - eyeOffset, faceY, eyeSize);
            drawEye(context, faceX + eyeOffset, faceY, eyeSize);
            // Little nose
            context.fillStyle = 'black';
            context.beginPath();
            context.arc(faceX, faceY + unitSize * 0.1, unitSize * 0.08, 0, Math.PI * 2);
            context.fill();
        } else if (number === 1000) {
            // Massive ROUND eye for 1000
            drawEye(context, faceX, faceY, unitSize * 3.5);
        } else if (number >= 100 && number % 100 === 0) {
            const isSquareHundred = (number === 100 || number === 400 || number === 900);
            const useTwoEyes = (number === 400 || number === 900);
            
            if (useTwoEyes) {
                drawSquareEye(context, faceX - eyeOffset * 1.5, faceY, eyeSize * 1.5);
                drawSquareEye(context, faceX + eyeOffset * 1.5, faceY, eyeSize * 1.5);
            } else if (isSquareHundred) {
                drawSquareEye(context, faceX, faceY, eyeSize * 2.5);
            } else {
                drawEye(context, faceX, faceY, eyeSize * 2.5);
            }
        } else if (number === 11) {
            // For 11: left eye normal, right eye slightly smaller
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 111) {
            // For 111: give three eyes (left, center, right) — left largest, middle slightly smaller, right noticeably smaller
            // Move outer eyes slightly farther from the center eye for wider spacing
            const centerOffset = 0;
            const outerOffset = eyeOffset * 1.4;
            // Left eye: full size
            drawEye(context, faceX - outerOffset, faceY, eyeSize);
            // Middle eye: slightly smaller than left
            drawEye(context, faceX + centerOffset, faceY, eyeSize * 0.9);
            // Right eye: smaller than middle
            drawEye(context, faceX + outerOffset, faceY, eyeSize * 0.7);
        } else if (number === 22) {
            // For 22: left eye normal, right eye slightly smaller (per request)
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 33) {
            // For 33: force circular eyes and make the right eye slightly smaller
            drawEye(context, faceX - eyeOffset, faceY, eyeSize);
            drawEye(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 44) {
            // For 44: left eye normal, right eye slightly smaller
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 66) {
            // For 66: left eye normal, right eye slightly smaller
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 67) {
            // For 67: cross-eyed + drooling
            // Draw standard eyes (whites) using eyeFunc if available
            try {
                // draw white parts first
                eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
                eyeFunc(context, faceX + eyeOffset, faceY, eyeSize);
            } catch (e) {
                // fallback to basic eyes
                drawEye(context, faceX - eyeOffset, faceY, eyeSize);
                drawEye(context, faceX + eyeOffset, faceY, eyeSize);
            }

            // Draw cross-eyed pupils (offset toward center)
            context.fillStyle = 'black';
            const pupilSize = Math.max(eyeSize * 0.35, 2);
            // left pupil shifted right a little, right pupil shifted left a little
            context.beginPath();
            context.arc(faceX - eyeOffset + eyeOffset * 0.25, faceY, pupilSize, 0, Math.PI * 2);
            context.fill();
            context.beginPath();
            context.arc(faceX + eyeOffset - eyeOffset * 0.25, faceY, pupilSize, 0, Math.PI * 2);
            context.fill();

            // Add drool: a main droplet and a small trailing bead
            context.fillStyle = 'rgba(50,150,255,0.9)';
            const droolX = faceX + eyeOffset * 0.1;
            const droolY = faceY + unitSize * 0.35;
            context.beginPath();
            context.ellipse(droolX, droolY, unitSize * 0.12, unitSize * 0.18, 0.25, 0, Math.PI * 2);
            context.fill();
            context.beginPath();
            context.arc(droolX + unitSize * 0.08, droolY + unitSize * 0.28, unitSize * 0.06, 0, Math.PI * 2);
            context.fill();

            // Slight glossy highlight on main droplet
            context.fillStyle = 'rgba(255,255,255,0.4)';
            context.beginPath();
            context.arc(droolX - unitSize * 0.03, droolY - unitSize * 0.06, unitSize * 0.04, 0, Math.PI * 2);
            context.fill();
        } else if (number === 77) {
            // For 77: left eye normal, right eye slightly smaller
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 88) {
            // For 88: left eye normal, right eye slightly smaller
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 99) {
            // For 99: left eye normal, right eye slightly smaller
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 110) {
            // For 110: left eye normal, right eye slightly smaller
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else if (number === 121) {
            // For 121: left eye normal, right eye slightly smaller (per request)
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize * 0.7);
        } else {
            eyeFunc(context, faceX - eyeOffset, faceY, eyeSize);
            eyeFunc(context, faceX + eyeOffset, faceY, eyeSize);
        }
        
        // Purple circular glasses for 2
        if (number === 2) {
            context.save();
            // Glass style
            context.strokeStyle = '#800080';
            // Slightly thinner frame
            context.lineWidth = Math.max(1.5, unitSize * 0.045);
            context.lineJoin = 'round';
            context.lineCap = 'round';

            // Circular lens radii (made a bit smaller)
            const lensRadius = Math.max(eyeSize * 0.75, unitSize * 0.18);

            // Lens centers
            const leftCX = faceX - eyeOffset;
            const rightCX = faceX + eyeOffset;
            const cy = faceY;

            // Slight tint inside lenses (very subtle)
            context.fillStyle = 'rgba(128,0,128,0.06)';
            context.beginPath();
            context.arc(leftCX, cy, lensRadius, 0, Math.PI * 2);
            context.arc(rightCX, cy, lensRadius, 0, Math.PI * 2);
            context.closePath();
            context.fill();

            // Stroke the circular lenses
            context.beginPath();
            context.arc(leftCX, cy, lensRadius, 0, Math.PI * 2);
            context.stroke();
            context.beginPath();
            context.arc(rightCX, cy, lensRadius, 0, Math.PI * 2);
            context.stroke();

            // Bridge between lenses
            context.beginPath();
            const bridgeStartX = leftCX + lensRadius * 0.5;
            const bridgeEndX = rightCX - lensRadius * 0.5;
            context.moveTo(bridgeStartX, cy);
            context.lineTo(bridgeEndX, cy);
            context.stroke();

            // Temples (short outward lines)
            context.beginPath();
            context.moveTo(leftCX - lensRadius, cy);
            context.lineTo(leftCX - lensRadius - unitSize * 0.12, cy - unitSize * 0.05);
            context.moveTo(rightCX + lensRadius, cy);
            context.lineTo(rightCX + lensRadius + unitSize * 0.12, cy - unitSize * 0.05);
            context.stroke();

            context.restore();
        }
        
        // Smile / Sad-face handling
        if (number === 1000) {
            context.beginPath();
            context.lineWidth = 15;
            context.arc(faceX, faceY + unitSize * 3, unitSize * 3, 0.1 * Math.PI, 0.9 * Math.PI);
            context.stroke();
        } else if (isEvil) {
            context.strokeStyle = 'black';
            context.fillStyle = 'black';
            context.beginPath();
            context.moveTo(faceX - unitSize * 0.3, faceY + unitSize * 0.2);
            context.lineTo(faceX - unitSize * 0.1, faceY + unitSize * 0.4);
            context.lineTo(faceX, faceY + unitSize * 0.2);
            context.lineTo(faceX + unitSize * 0.1, faceY + unitSize * 0.4);
            context.lineTo(faceX + unitSize * 0.3, faceY + unitSize * 0.2);
            context.stroke();
        } else {
            context.beginPath();
            const smileRadius = number === 1000 ? unitSize * 2 : unitSize * 0.15;
            const smileYOffset = number === 1000 ? unitSize * 2.5 : unitSize * 0.2;
            const smileLineWidth = number === 1000 ? 10 : 1;
            
            context.lineWidth = smileLineWidth;
            context.arc(faceX, faceY + smileYOffset, smileRadius, 0.1 * Math.PI, 0.9 * Math.PI);
            context.stroke();
        }

        // Number Label
        context.fillStyle = 'black';
        context.font = `bold ${unitSize * 0.6}px Learninglings, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'bottom';
        const labelYOffset = (number === 1000 || number === 'infinity') ? unitSize * 6 : unitSize * 0.5;
        let displayLabel = number.toString();
        if (number === 'infinity' || number === 'inf1') displayLabel = '∞';
        else if (number === 'μ') displayLabel = 'μ';
        context.fillText(displayLabel, faceX, faceY - labelYOffset - 5);

        // Speech Bubble
        if (body.activeSpeech && Date.now() < body.speechExpiry) {
            drawSpeechBubble(context, faceX, faceY - labelYOffset - unitSize * 0.8, body.activeSpeech, unitSize);
        }

        // If this is a Numberblock 7 or 2, draw the appropriate costume SVG on its head.
        // Use cached image if available; otherwise begin loading for future frames.
        try {
            // Helper to draw a costume image anchored to the block's head
            const drawCostume = (svgUrl, scale = 1.35, tilt = -0.15, yOffsetFactor = 0.20) => {
                const img = imageCache[svgUrl];
                if (!img) {
                    // kick off load but don't block this frame
                    ensureImage(svgUrl).catch(() => {});
                    return false;
                }
                context.save();
                // Anchor slightly lower than the true top so the costume sits naturally
                const headTopY = faceY - (unitSize * 0.6);
                // Scale width relative to unit size and preserve aspect ratio
                const drawW = unitSize * scale;
                const aspect = img.height && img.width ? (img.height / img.width) : 1;
                const drawH = drawW * aspect;

                context.translate(faceX, headTopY);
                context.rotate(tilt);

                // Draw with the image bottom at y=0 so it rests on the head anchor
                context.drawImage(img, -drawW / 2, -drawH + (drawH * yOffsetFactor), drawW, drawH);
                context.restore();
                return true;
            };

            if (body.renderData) {
                const label = body.renderData.number;
                // Special-case: the long corrupted 'hand-drawn' token should render only as costume1 3.svg with no body or name tag
                const longToken = 'a̷̧̛̙̺͆̂͂̓ḑ̴̨̯̯̺͍̮̣͈̺̤̣̩̺͕͕̦̼̲̟̻͖͍͇͇͕̟̞͖̿͊͛͑͛̈́̎͌̚͜͝ḑ̸͍͈̋͆̿̊͆͝͠';
                // NOTE: some variations may exist in length; compare start to be forgiving
                if (String(label) === longToken || String(label).startsWith('a̷') ) {
                    // draw the single costume image and skip the normal body/name rendering entirely
                    drawCostume('/costume1 3.svg', 1.5, -0.06, 0.12);
                    // restore outer context and continue to next block (skip further drawing for this body)
                    context.restore();
                    continue;
                }

                // Costume for 3: draw 01.svg on top of 3's head
                if (label === 3 || String(label) === '3') {
                    // slightly lower the costume so it sits a bit further down on 3's head
                    // increased scale so the 01.svg appears slightly bigger on 3
                    drawCostume('/01.svg', 1.0, -0.06, 0.32);
                }

                // Costume for 7 (existing)
                if (label === 7 || String(label) === '7') {
                    // rotate the 7 costume 360 degrees (-Math.PI*2 = -2π radians)
                    drawCostume('/costume1 2.svg', 1.35, -Math.PI * 2, 0.32);
                }
                // Add Thirty-One.svg costume on top of 31 blocks
                if (label === 31 || String(label) === '31') {
                    // Place the Thirty-One SVG so it sits at the right edge of the 7-unit wide top row.
                    // The 7-column layout is centered around the block (columns -3..+3), so the rightmost column
                    // center is at +3 * UNIT_SIZE from the block center. Anchor the SVG above that cell.
                    const img31 = imageCache['/Thirty-One.svg'];
                    if (!img31) {
                        // start async load for future frames
                        ensureImage('/Thirty-One.svg').catch(() => {});
                    } else {
                        context.save();
                        // anchor point slightly above the block head so the SVG sits on the upper row
                        const headTopY = faceY - (unitSize * 0.6);
                        const drawW = UNIT_SIZE * 7; // span 7 blocks wide
                        const aspect = img31.height && img31.width ? (img31.height / img31.width) : 1;
                        const drawH = drawW * aspect;
                        // Rightmost column center for a 7-wide grid is +3 * UNIT_SIZE
                        const rightmostX = faceX + (3 * unitSize);
                        // translate to the desired anchor and draw so the image bottom rests near the headTopY
                        context.translate(rightmostX, headTopY);
                        context.rotate(0);
                        context.drawImage(img31, -drawW / 2, -drawH + (drawH * 0.08), drawW, drawH);
                        context.restore();
                    }
                }
                // NOTE: costume for 2 removed per request
            }
        } catch (e) {
            // don't let costume drawing break the frame
            console.warn('Costume draw error', e);
        }

        context.restore();
        } catch (err) {
            console.error("Render error for block:", body.renderData?.number, err);
            context.restore();
        }
    }
});

// Height indicator update
function updateHeightIndicator() {
    const el = document.getElementById('height-indicator');
    if (!el) return;
    // Calculate blocks away as camera altitude (negative camera.y) divided by UNIT_SIZE
    const blocksAway = Math.round((-camera.y) / UNIT_SIZE);
    const absCount = Math.abs(blocksAway);
    const unitLabel = (absCount === 1) ? 'block' : 'blocks';

    // Determine sky zone label consistent with rendering logic
    let zoneLabel = 'Ground';
    const blocksAbove = blocksAway;
    const deepAbove = blocksAbove >= 150;
    const colorZone = blocksAbove >= 300 && blocksAbove < 600;
    const grayZone = blocksAbove >= 450 && blocksAbove < 600;
    const redZone = (blocksAbove >= 600 && blocksAbove < 750);
    const binaryZone = blocksAbove >= 750;
    const gallZone = blocksAbove >= 900;
    const fritzZone = blocksAbove >= 1050;
    const minimalZone = blocksAbove >= 1200;
    const noiseZone = blocksAbove >= 1350;
    const blueZone = blocksAbove >= 1500 && blocksAbove < 1650;
    const whiteZone = (blocksAbove >= 1650 && blocksAbove < 1800);
    const perilZone = (blocksAbove >= 1800);

    if (perilZone) zoneLabel = 'Peril Zone';
    else if (whiteZone) zoneLabel = 'White Zone';
    else if (blueZone) zoneLabel = 'Blue Zone';
    else if (noiseZone) zoneLabel = 'Noise Zone';
    else if (minimalZone) zoneLabel = 'Minimal Zone';
    else if (fritzZone) zoneLabel = 'Fritz Zone';
    else if (gallZone) zoneLabel = 'Gall Zone';
    else if (binaryZone && !redZone) zoneLabel = 'Binary Zone';
    else if (redZone) zoneLabel = 'Red Zone';
    else if (grayZone) zoneLabel = 'Gray Zone';
    else if (colorZone) zoneLabel = 'Color Zone';
    else if (deepAbove) zoneLabel = 'The Void';
    else if (blocksAbove >= 125) zoneLabel = 'Flicker Zone';
    else zoneLabel = (blocksAway < 0) ? 'Below ground' : 'Surface';

    // Provide a concise hint and the active sky zone label
    if (blocksAway < 0) {
        el.textContent = `Height: ${blocksAway} ${unitLabel} (below ground) — Zone: ${zoneLabel}`;
    } else {
        el.textContent = `Height: ${blocksAway} ${unitLabel} — Zone: ${zoneLabel}`;
    }

    // Previously auto-stopped music at high altitude; disabled so music keeps playing while you explore.
    try {
        // intentionally left blank
    } catch (e) {
        console.warn('Auto-stop music check failed', e);
    }
}

 // Update once per render frame
Events.on(render, 'afterRender', updateHeightIndicator);

// Negative Skyzone: invert canvas colors when camera is 100+ blocks below ground (UI remains unaffected)
Events.on(render, 'afterRender', () => {
    try {
        const ctx = render.context;
        const canvas = render.canvas;
        // camera.y grows positive as we go below ground in world coords; trigger when > 100 blocks
        if (camera && typeof camera.y === 'number' && UNIT_SIZE && camera.y > UNIT_SIZE * 100) {
            ctx.save();
            // Draw in screen space so UI DOM elements are not affected
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            // Using 'difference' with white inverts the underlying canvas pixels
            ctx.globalCompositeOperation = 'difference';
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // Restore composite and transform
            ctx.globalCompositeOperation = 'source-over';
            ctx.restore();
        }
    } catch (e) {
        // do not allow inversion errors to break rendering
        console.warn('Negative skyzone inversion failed', e);
    }
});

// FPS counter: lightweight requestAnimationFrame tracker to update the HUD
(function setupFpsCounter() {
    const fpsEl = document.getElementById('fps-counter');
    if (!fpsEl) return;
    let last = performance.now();
    let frames = 0;
    let fps = 0;
    let lastUpdate = performance.now();

    function tick(now) {
        frames++;
        const delta = now - last;
        last = now;

        // Update FPS every 500ms for a stable readout
        if (now - lastUpdate >= 500) {
            fps = Math.round((frames * 1000) / (now - lastUpdate));
            fpsEl.textContent = `FPS: ${fps}`;
            frames = 0;
            lastUpdate = now;
        }

        requestAnimationFrame(tick);
    }

    requestAnimationFrame((ts) => {
        last = ts;
        lastUpdate = ts;
        frames = 0;
        requestAnimationFrame(tick);
    });
})();

// Helper: safely remove a block from world and blocks array with feedback
function deleteBlock(body) {
    try {
        if (!body) return;
        World.remove(world, body);
        const idx = blocks.indexOf(body);
        if (idx !== -1) blocks.splice(idx, 1);
        // Remove any rainbow trail data associated with this body to free memory and avoid orphan trails
        try {
            if (body && body.id !== undefined) trails.delete(String(body.id));
        } catch (e) { /* ignore trail delete errors */ }
        playSound('delete');
    } catch (e) {
        console.warn('deleteBlock failed', e);
    }
}

// Slice a numeric block by removing 'amount' units and spawning a separate block
// If amount >= the block's numeric value, the block is removed entirely (equivalent to delete).
function sliceBlock(body, amount = 1) {
    try {
        if (!body || !body.renderData) return;
        // Only operate on numeric-valued blocks
        const label = body.renderData.number;
        const numeric = getNumericValue(label);

        if (!isFinite(numeric) || typeof numeric !== 'number') {
            // non-numeric blocks can't be sliced; do a normal delete for clarity
            deleteBlock(body);
            return;
        }

        const amt = Math.max(0, Math.floor(amount));
        if (amt <= 0) return;

        if (amt >= Math.abs(numeric)) {
            // remove entirely
            deleteBlock(body);
            return;
        }

        // Determine new values
        const remaining = numeric - (numeric > 0 ? amt : -amt); // preserve sign
        const slicedVal = (numeric > 0) ? amt : -amt;

        // Position the spawned slice slightly offset from the original so it visibly separates
        const spawnPos = { x: body.position.x + (Math.random() * 40 - 20), y: body.position.y - 30 };

        // Create the sliced-off block and the updated original replacement
        // Remove original body and replace with new block representing remaining amount
        try {
            World.remove(world, body);
            const idx = blocks.indexOf(body);
            if (idx !== -1) blocks.splice(idx, 1);
        } catch (e) {
            // continue even if removal fails
        }

        // Create two blocks: remaining and the sliced piece
        const remainingBlock = createNumberBlock(body.position.x, body.position.y, remaining, UNIT_SIZE, currentArrangement);
        const sliceBlockBody = createNumberBlock(spawnPos.x, spawnPos.y, slicedVal, UNIT_SIZE, currentArrangement);

        // Inherit some physics flair
        try { Body.setVelocity(sliceBlockBody, { x: (Math.random() - 0.5) * 8, y: -8 }); } catch (e) {}
        try { Body.setVelocity(remainingBlock, { x: (Math.random() - 0.5) * 2, y: -2 }); } catch (e) {}

        World.add(world, remainingBlock);
        World.add(world, sliceBlockBody);
        blocks.push(remainingBlock, sliceBlockBody);

        playSound('pop');
        speak(remaining, null, remainingBlock);
        speak(slicedVal, null, sliceBlockBody);
    } catch (err) {
        console.warn('sliceBlock failed', err);
    }
}

// Allow deletion via:
// - Ctrl/Cmd + left-click (pointerdown)
// - double-click (dblclick)
// - right-click (contextmenu) — suppresses native menu and deletes the top hit
// All handlers translate screen coords to world coords and pick the top body via Query.point.
if (render && render.canvas) {
    // Ctrl/Cmd + left-click (hold Shift to "slice" instead of delete)
    render.canvas.addEventListener('pointerdown', (e) => {
        try {
            // only handle primary button (usually left) when modifier pressed
            if (e.button !== 0) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            const rect = render.canvas.getBoundingClientRect();
            const worldPos = {
                x: camera.x + (e.clientX - rect.left) / camera.zoom,
                y: camera.y + (e.clientY - rect.top) / camera.zoom
            };
            const hit = Query.point(blocks, worldPos);
            if (hit && hit.length > 0) {
                // prefer top-most body
                const target = hit[0];
                if (e.shiftKey) {
                    // slice off one unit by default when Shift is held
                    sliceBlock(target, 1);
                } else {
                    deleteBlock(target);
                }
            }
        } catch (err) {
            console.warn('Ctrl/Cmd-click delete/slice handler failed', err);
        }
    });

    // Double-click for deletion/slicing (hold Shift to slice)
    render.canvas.addEventListener('dblclick', (e) => {
        try {
            const rect = render.canvas.getBoundingClientRect();
            const worldPos = {
                x: camera.x + (e.clientX - rect.left) / camera.zoom,
                y: camera.y + (e.clientY - rect.top) / camera.zoom
            };
            const hit = Query.point(blocks, worldPos);
            if (hit && hit.length > 0) {
                const target = hit[0];
                if (e.shiftKey) sliceBlock(target, 1);
                else deleteBlock(target);
            }
        } catch (err) {
            console.warn('dblclick delete/slice handler failed', err);
        }
    });

    // Right-click (contextmenu) deletes or slices and prevents the native menu (Shift -> slice)
    render.canvas.addEventListener('contextmenu', (e) => {
        try {
            e.preventDefault();
            const rect = render.canvas.getBoundingClientRect();
            const worldPos = {
                x: camera.x + (e.clientX - rect.left) / camera.zoom,
                y: camera.y + (e.clientY - rect.top) / camera.zoom
            };
            const hit = Query.point(blocks, worldPos);
            if (hit && hit.length > 0) {
                const target = hit[0];
                if (e.shiftKey) sliceBlock(target, 1);
                else deleteBlock(target);
            }
        } catch (err) {
            console.warn('contextmenu delete/slice handler failed', err);
        }
    });
}

