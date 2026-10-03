// Option pour activer ou désactiver l'animation (true = activé, false = désactivé)
const ENABLE_ANIMATION = true;

document.addEventListener('DOMContentLoaded', () => {
    if (!ENABLE_ANIMATION) {
        // Masquer l'iframe du cabinet dentaire si l'animation est désactivée
        const iframe = document.querySelector('iframe[src*="cabinet-dentaire.html"]');
        if (iframe) iframe.style.display = 'none';
        return;
    }

    const triggerWord = document.getElementById('easter-egg-trigger');
    if (!triggerWord) return;

    triggerWord.addEventListener('click', () => {
        showEasterEgg();
    });
});

function showEasterEgg() {
    highScore = Math.max(highScore, lireRecord());
    const modal = document.getElementById('easter-egg-modal');
    modal.classList.remove('hidden');
    initGame();
}

// Attach hide to the global window so the inline onclick can find it
window.hideEasterEgg = function () {
    const modal = document.getElementById('easter-egg-modal');
    modal.classList.add('hidden');
    stopGame();
}

// Game variables
let canvas, ctx;
let gameLoop;
let isPlaying = false;
let score = 0;
// Record partagé par tous les postes (document "record_jeu" en base)
let highScore = 0;
function lireRecord() {
    const record = typeof window.getDocument === "function" ? Number(window.getDocument("record_jeu")) : 0;
    return Number.isFinite(record) ? record : 0;
}
let frameCount = 0;
let gameSpeed = 5;

let tooth = {
    x: 50,
    y: 150,
    width: 30,
    height: 30,
    dy: 0,
    gravity: 0.6,
    jumpPower: -10,
    grounded: false,
    jumpsLeft: 2,
    angle: 0
};

let obstacles = [];
let clouds = [];
let particles = [];

function initGame() {
    canvas = document.getElementById('easter-egg-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    // reset game state
    tooth.y = 150;
    tooth.dy = 0;
    tooth.angle = 0;
    score = 0;
    frameCount = 0;
    gameSpeed = 5;
    obstacles = [];
    clouds = [];
    particles = [];
    isPlaying = true;

    // Create some initial clouds
    for (let i = 0; i < 3; i++) {
        clouds.push({
            x: Math.random() * canvas.width,
            y: Math.random() * (canvas.height / 2),
            speed: Math.random() * 0.5 + 0.2,
            scale: Math.random() * 0.5 + 0.5
        });
    }

    document.addEventListener('keydown', handleJump);
    canvas.addEventListener('mousedown', handleJump);

    // Clear any existing loop just in case
    if (gameLoop) cancelAnimationFrame(gameLoop);
    gameLoop = requestAnimationFrame(update);
}

function stopGame() {
    isPlaying = false;
    if (gameLoop) cancelAnimationFrame(gameLoop);
    document.removeEventListener('keydown', handleJump);
    if (canvas) canvas.removeEventListener('mousedown', handleJump);
}

function createParticles(x, y, color, count) {
    for (let i = 0; i < count; i++) {
        particles.push({
            x: x,
            y: y,
            vx: (Math.random() - 0.5) * 5,
            vy: (Math.random() - 0.5) * 5,
            life: 1,
            color: color
        });
    }
}

function handleJump(e) {
    // Empêcher le scroll quand on appuie sur espace
    if (e.type === 'keydown' && e.code === 'Space') {
        e.preventDefault();
    }

    if ((e.type === 'keydown' && e.code === 'Space') || e.type === 'mousedown') {
        if (!isPlaying) {
            initGame(); // restart
            return;
        }
        if (tooth.jumpsLeft > 0) {
            tooth.dy = tooth.jumpPower;
            tooth.grounded = false;
            tooth.jumpsLeft--;
            createParticles(tooth.x + tooth.width / 2, tooth.y + tooth.height, '#fff', 10);

            // Add a little spin effect
            tooth.spinTarget = (tooth.spinTarget || 0) + Math.PI * 2;
        }
    }
}

function update() {
    if (!isPlaying) return;

    // Difficulty increases over time
    if (frameCount % 600 === 0 && gameSpeed < 12) {
        gameSpeed += 0.5;
    }

    // Sky gradient
    let grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#87CEEB'); // Sky blue
    grad.addColorStop(1, '#E0F6FF'); // Light blue
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Clouds
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '30px Arial';
    clouds.forEach((c) => {
        c.x -= c.speed;
        if (c.x < -50) {
            c.x = canvas.width + 50;
            c.y = Math.random() * (canvas.height / 2);
        }
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.scale(c.scale, c.scale);
        ctx.fillText('☁️', 0, 0);
        ctx.restore();
    });

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.02;
        if (p.life <= 0) {
            particles.splice(i, 1);
            continue;
        }
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    // Tooth physics
    tooth.dy += tooth.gravity;
    tooth.y += tooth.dy;

    if (tooth.y + tooth.height >= canvas.height - 20) {
        if (!tooth.grounded) {
            createParticles(tooth.x + tooth.width / 2, canvas.height - 20, '#ddd', 5);
        }
        tooth.y = canvas.height - 20 - tooth.height;
        tooth.dy = 0;
        tooth.grounded = true;
        tooth.jumpsLeft = 2; // Reset jumps
    }

    // Draw Tooth
    ctx.save();
    ctx.translate(tooth.x + tooth.width / 2, tooth.y + tooth.height / 2);

    // Smooth rotation
    if (tooth.spinTarget) {
        tooth.angle += (tooth.spinTarget - tooth.angle) * 0.1;
    }
    ctx.rotate(tooth.angle);

    ctx.font = '30px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🦷', 0, 0);
    ctx.restore();

    // Reset alignment
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Obstacles
    // Spawn rate depends on game speed
    let spawnRate = Math.max(40, Math.floor(120 - gameSpeed * 5));
    if (frameCount % spawnRate === 0) {
        const types = [
            { e: '🍬', type: 'ground' },
            { e: '🧊', type: 'ground' },
            { e: '🍫', type: 'ground' },
            { e: '🦠', type: 'flyer' } // Bactérie volante
        ];
        let randType = types[Math.floor(Math.random() * types.length)];

        let obsY = canvas.height - 40;
        let obsSize = 25;

        if (randType.type === 'flyer') {
            obsY = canvas.height - 70 - Math.random() * 40; // Hauteur variable
        }

        obstacles.push({
            x: canvas.width,
            y: obsY,
            width: obsSize,
            height: obsSize,
            emoji: randType.e,
            type: randType.type,
            offsetY: 0,
            time: Math.random() * 100 // pour l'animation
        });
    }

    for (let i = obstacles.length - 1; i >= 0; i--) {
        let obs = obstacles[i];

        // Speed variation based on type
        let currentObsSpeed = gameSpeed;
        if (obs.type === 'flyer') {
            currentObsSpeed *= 1.2;
            // Bobbing effect for flyers
            obs.time += 0.1;
            obs.offsetY = Math.sin(obs.time) * 10;
        }

        obs.x -= currentObsSpeed;

        ctx.font = '25px Arial';
        ctx.fillText(obs.emoji, obs.x, obs.y + 22 + obs.offsetY);

        // Collision detection (hitbox plus petite pour être moins frustrant)
        let hitboxMargin = 8;
        if (
            tooth.x + hitboxMargin < obs.x + obs.width - hitboxMargin &&
            tooth.x + tooth.width - hitboxMargin > obs.x + hitboxMargin &&
            tooth.y + hitboxMargin < obs.y + obs.height + obs.offsetY - hitboxMargin &&
            tooth.y + tooth.height - hitboxMargin > obs.y + obs.offsetY + hitboxMargin
        ) {
            isPlaying = false; // Game Over
            createParticles(tooth.x + tooth.width / 2, tooth.y + tooth.height / 2, 'red', 30);
            if (score > highScore) {
                highScore = score;
                if (typeof window.setDocument === "function" && highScore > lireRecord()) {
                    window.setDocument("record_jeu", highScore);
                }
            }
        }

        // Remove offscreen obstacles
        if (obs.x + obs.width < 0) {
            obstacles.splice(i, 1);
            score++;
        }
    }

    // Draw Ground
    ctx.beginPath();
    ctx.moveTo(0, canvas.height - 20);
    ctx.lineTo(canvas.width, canvas.height - 20);
    ctx.strokeStyle = '#2c3e50';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Draw ground details (moving lines)
    ctx.lineWidth = 2;
    for (let i = 0; i < canvas.width + 20; i += 20) {
        let lineX = (i - (frameCount * gameSpeed) % 20);
        ctx.beginPath();
        ctx.moveTo(lineX, canvas.height - 20);
        ctx.lineTo(lineX - 10, canvas.height);
        ctx.strokeStyle = '#34495e';
        ctx.stroke();
    }

    // Score & High Score
    ctx.fillStyle = '#2c3e50';
    ctx.font = 'bold 20px Arial';
    ctx.fillText('Score: ' + score, 10, 30);

    ctx.textAlign = 'right';
    ctx.fillText('High Score: ' + highScore, canvas.width - 10, 30);
    ctx.textAlign = 'left';

    if (!isPlaying) {
        // Render one last time without clearing to show particles explosion

        // Game Over screen
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';

        ctx.font = 'bold 40px Arial';
        ctx.fillStyle = '#ff6b6b';
        ctx.fillText('Aïe, la carie !', canvas.width / 2, canvas.height / 2 - 20);

        ctx.font = 'bold 20px Arial';
        ctx.fillStyle = '#fff';
        ctx.fillText('Score Final : ' + score, canvas.width / 2, canvas.height / 2 + 15);
        ctx.font = '16px Arial';
        ctx.fillText('Clique ou Espace pour rejouer', canvas.width / 2, canvas.height / 2 + 45);

        ctx.textAlign = 'left';
    } else {
        frameCount++;
        gameLoop = requestAnimationFrame(update);
    }
}
