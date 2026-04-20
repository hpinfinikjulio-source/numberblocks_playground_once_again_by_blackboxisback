/* New module: drawing helper utilities moved out of main.js for clarity.
   This file provides exported drawing functions used by the renderer.
*/

export function drawEye(ctx, x, y, size) {
    ctx.fillStyle = 'white';
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'black';
    ctx.beginPath(); ctx.arc(x, y, size * 0.4, 0, Math.PI * 2); ctx.fill();

    // Pupil shine: small white highlight at upper-left of pupil
    try {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const shineX = x - size * 0.12;
        const shineY = y - size * 0.18;
        const shineR = Math.max(1, size * 0.12);
        ctx.beginPath();
        ctx.arc(shineX, shineY, shineR, 0, Math.PI * 2);
        ctx.fill();
    } catch (e) {
        // fail-safe: don't break drawing if canvas operations error
    }
}

export function drawFlower(ctx, x, y, size) {
    const colors = ['#FF69B4', '#FFD700', '#FFFFFF', '#87CEEB'];
    const color = colors[Math.abs(Math.floor(x * 123)) % colors.length];
    ctx.fillStyle = color;
    for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(x + Math.cos(angle) * size, y - size + Math.sin(angle) * size, size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.fillStyle = '#FFA500';
    ctx.beginPath();
    ctx.arc(x, y - size, size * 0.6, 0, Math.PI * 2);
    ctx.fill();
}

export function drawStone(ctx, x, y, size) {
    ctx.fillStyle = '#999';
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * 0.6, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#777';
    ctx.lineWidth = 1;
    ctx.stroke();
}

export function drawStar(ctx, x, y, radius, color = '#001f7a', points = 5, innerRatio = 0.5) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const angle = (i * Math.PI) / points;
        const r = (i % 2 === 0) ? radius : radius * innerRatio;
        const sx = x + Math.cos(angle) * r;
        const sy = y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

export function drawRoundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

export function drawSquareEye(ctx, x, y, size) {
    const radius = size * 0.4;
    ctx.fillStyle = 'white';
    drawRoundedRect(ctx, x - size, y - size, size * 2, size * 2, radius);
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = 'black';
    drawRoundedRect(ctx, x - (size * 0.4), y - (size * 0.4), size * 0.8, size * 0.8, radius * 0.4);
    ctx.fill();

    // Pupil shine: small rounded white highlight near upper-left inside the black pupil
    try {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const shineW = Math.max(2, size * 0.18);
        const shineH = Math.max(1, size * 0.12);
        const sx = x - size * 0.12;
        const sy = y - size * 0.16;
        drawRoundedRect(ctx, sx - shineW/2, sy - shineH/2, shineW, shineH, Math.min(4, shineH/2));
        ctx.fill();
    } catch (e) {}
}

export function drawEvilEye(ctx, x, y, size) {
    ctx.fillStyle = '#ff0000';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    
    ctx.beginPath();
    ctx.moveTo(x - size * 1.5, y - size);
    ctx.lineTo(x + size * 1.5, y + size);
    ctx.lineTo(x - size * 1.5, y + size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x - size * 0.5, y + size * 0.2, size * 0.3, 0, Math.PI * 2);
    ctx.fill();

    // Add small shine to the evil pupil for consistency
    try {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        const sx = x - size * 0.62;
        const sy = y + size * 0.05;
        const sr = Math.max(1, size * 0.07);
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
    } catch (e) {}
}

export function drawQuarterEye(ctx, x, y, size) {
    ctx.save();
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, size * 1.5, 0, Math.PI * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, size * 1.0, 0, Math.PI * 0.5);
    ctx.closePath();
    ctx.fill();

    // shine
    try {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const sx = x - size * 0.2;
        const sy = y - size * 0.2;
        const sr = Math.max(1, size * 0.08);
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
    } catch (e) {}
    ctx.restore();
}

export function drawRectangularEye(ctx, x, y, size) {
    const width = size * 0.85;
    const height = size * 1.3;
    const radius = size * 0.3;
    
    ctx.fillStyle = 'white';
    drawRoundedRect(ctx, x - width, y - height, width * 2, height * 2, radius);
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = 'black';
    drawRoundedRect(ctx, x - (width * 0.45), y - (height * 0.45), width * 0.9, height * 0.9, radius * 0.3);
    ctx.fill();

    // pupil shine
    try {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const sx = x - width * 0.15;
        const sy = y - height * 0.2;
        const srW = Math.max(2, size * 0.18);
        const srH = Math.max(1, size * 0.10);
        drawRoundedRect(ctx, sx - srW/2, sy - srH/2, srW, srH, Math.min(4, srH/2));
        ctx.fill();
    } catch (e) {}
}

export function drawSpeechBubble(ctx, x, y, text, unitSize) {
    ctx.save();
    ctx.font = `bold ${unitSize * 0.4}px Learninglings, sans-serif`;
    const metrics = ctx.measureText(text);
    const padding = 12;
    const w = Math.max(unitSize * 1.5, metrics.width + padding * 2);
    const h = unitSize * 0.75;
    const rx = x - w / 2;
    const ry = y - h;

    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 8, ry + h - 1);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 8, ry + h - 1);
    ctx.fill();
    ctx.stroke();

    drawRoundedRect(ctx, rx, ry, w, h, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, ry + h / 2);
    ctx.restore();
}

export function drawThreeQuartersEye(ctx, x, y, size) {
    ctx.save();
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, size * 1.5, 0, Math.PI * 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, size * 0.9, 0, Math.PI * 1.5);
    ctx.closePath();
    ctx.fill();

    // small shine
    try {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const sx = x - size * 0.18;
        const sy = y - size * 0.14;
        const sr = Math.max(1, size * 0.09);
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
    } catch (e) {}
    ctx.restore();
}

export function drawGrass(ctx, x, y, size) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + size * 0.2, y - size, x + size * 0.5, y - size * 1.2);
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - size * 0.1, y - size * 0.8, x - size * 0.3, y - size * 0.9);
    ctx.stroke();
}