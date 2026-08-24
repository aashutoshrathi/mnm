/**
 * src/confetti.js
 * Lightweight zero-dependency canvas confetti particle system.
 */

let confettiAnimationId = null;

export function burstConfetti(primaryColor = '#FF4262', secondaryColor = '#3D9BFF') {
  if (typeof document === 'undefined') return;
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (confettiAnimationId) {
    cancelAnimationFrame(confettiAnimationId);
    confettiAnimationId = null;
  }

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  const w = rect.width || (typeof window !== 'undefined' ? window.innerWidth : 360) || 360;
  const h = rect.height || (typeof window !== 'undefined' ? window.innerHeight : 640) || 640;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const resolveHex = (c, fallback) => {
    if (!c || typeof c !== 'string') return fallback;
    if (c.includes('--red')) return '#FF4262';
    if (c.includes('--blue')) return '#3D9BFF';
    if (c.includes('--yellow')) return '#FFD23F';
    return c.startsWith('#') || c.startsWith('rgb') ? c : fallback;
  };

  const pColor = resolveHex(primaryColor, '#FF4262');
  const sColor = resolveHex(secondaryColor, '#3D9BFF');

  const colors = [
    pColor,
    sColor,
    '#FFD700', // Gold
    '#2EE898', // Bright Emerald
    '#FFFFFF', // White
    '#FF8E3D', // Tangerine
    '#B44DFF', // Purple
  ];

  const count = 90;
  const particles = [];

  for (let i = 0; i < count; i++) {
    particles.push({
      x: w * 0.5 + (Math.random() - 0.5) * (w * 0.4),
      y: h * 0.25 + (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 10 - 4,
      size: Math.random() * 7 + 5,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 12,
      wobble: Math.random() * 10,
      wobbleSpeed: Math.random() * 0.1 + 0.05,
      opacity: 1,
      shape: Math.random() > 0.3 ? 'rect' : 'circle',
    });
  }

  const startTime = Date.now();
  const duration = 4200;

  function frame() {
    const elapsed = Date.now() - startTime;
    if (elapsed > duration) {
      ctx.clearRect(0, 0, w, h);
      confettiAnimationId = null;
      return;
    }

    ctx.clearRect(0, 0, w, h);

    const fadeStart = duration * 0.7;
    const globalFade = elapsed > fadeStart ? 1 - (elapsed - fadeStart) / (duration - fadeStart) : 1;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.32; // gravity
      p.vx *= 0.985; // air resistance
      p.rotation += p.rotSpeed;
      p.wobble += p.wobbleSpeed;

      const alpha = Math.max(0, globalFade * p.opacity);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.scale(Math.sin(p.wobble), 1);
      ctx.fillStyle = p.color;

      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size * 0.5, -p.size * 0.3, p.size, p.size * 0.6);
      }
      ctx.restore();
    }

    confettiAnimationId = requestAnimationFrame(frame);
  }

  confettiAnimationId = requestAnimationFrame(frame);
}

export function stopConfetti() {
  if (confettiAnimationId && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(confettiAnimationId);
    confettiAnimationId = null;
  }
  if (typeof document === 'undefined') return;
  const canvas = document.getElementById('confetti-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }
}
