"use strict";
// Xiao Xiong & Xiao Xiong Mao skydiving from outer space. Plain canvas + hand-rolled physics.

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const overlay = document.getElementById("overlay");
const sbTrack = document.getElementById("sb-track");
const sbText = document.getElementById("sb-text");
const sbMarkers = [document.getElementById("sb-m0"), document.getElementById("sb-m1")];

// ---- tuning ----
const GRAVITY = 900;          // px/s^2
const DRAG_FREEFALL = 0.0011; // quadratic drag coefficient (at sea-level air density)
const DRAG_CHUTE = 0.04;
const STEER = 700;            // horizontal push px/s^2
const START_ALT = 30000;      // px from the C-17 down to the ground
const SAFE_LANDING_SPEED = 230;
// how each obstacle is named on the end screen
const OB_NAME = { satellite: "a satellite", debris: "space debris", iss: "the space station", meteor: "a meteor", balloon: "a weather balloon",
  jet: "a jet", bird: "a bird", airliner: "an airliner", hotair: "a hot-air balloon", drone: "a drone", storm: "a storm cloud" };
const R = 32;                 // collision radius
const IMG_H = 96;             // drawn avatar height
const STEP = 1 / 60;
const MAX_HP = 100;
const LIVES = 2;               // per dude
const RESPAWN_INVULN = 2.5;    // seconds of protection after losing a life
const RESPAWN_HEIGHT = 2600;   // px above the ground a dude comes back after a splat
const MEDKIT_HEAL = 40;        // HP restored by a health kit
const MEDKIT_R = 30;
const MEDKIT_COUNT = 10;       // scattered at random over the whole fall
// barrier pick-ups: touching one gives a forcefield for a short time
const BARRIER_COUNT = 10;
const BARRIER_R = 28;
const SHIELD_TIME = 2.5;       // seconds the forcefield lasts
const SHIELD_LARGE_FACTOR = 0.25; // large obstacles still do this share of their damage through the forcefield
// small obstacles are stopped completely by the forcefield; everything else counts as large
const SMALL_OBSTACLES = new Set(["debris", "meteor", "balloon", "bird", "drone"]);
const REF_SPEED = 350;        // closing speed (px/s) at which an obstacle deals its base damage
const SIDEBAR_W = 260;        // keep in sync with #sidebar in style.css
let W = Math.max(300, innerWidth - SIDEBAR_W); // play-area width

// ---- Earth's atmosphere ----
// Game distance is not linear in real altitude (that would squash the troposphere to nothing),
// so each layer gets its own share of the fall: [fraction of the fall, real altitude in km].
const BREAKS = [[0, 800], [0.08, 700], [0.35, 85], [0.5, 50], [0.7, 12], [1, 0]];
const LAYERS = [
  { name: "Exosphere", color: "#05050f" },
  { name: "Thermosphere", color: "#14143a" },
  { name: "Mesosphere", color: "#2a2f66" },
  { name: "Stratosphere", color: "#3b5fb0" },
  { name: "Troposphere", color: "#6cb6ff" },
];
const LANDMARKS = [
  { km: 408, label: "ISS orbit" },
  { km: 100, label: "Kármán line (space ends)" },
  { km: 25, label: "Ozone layer" },
  { km: 11, label: "Airliners" },
  { km: 8.8, label: "Mt Everest" },
];
const START_KM = BREAKS[0][1];
function altKm(y) {
  const f = clamp(y / START_ALT, 0, 1);
  for (let i = 0; i < BREAKS.length - 1; i++) {
    const [f0, a0] = BREAKS[i], [f1, a1] = BREAKS[i + 1];
    if (f <= f1) return a0 + (a1 - a0) * (f - f0) / (f1 - f0);
  }
  return 0;
}
function fracOfAlt(km) {
  for (let i = 0; i < BREAKS.length - 1; i++) {
    const [f0, a0] = BREAKS[i], [f1, a1] = BREAKS[i + 1];
    if (km <= a0 && km >= a1) return f0 + (f1 - f0) * (a0 - km) / (a0 - a1);
  }
  return 1;
}
function layerIndex(km) { return km > 700 ? 0 : km > 85 ? 1 : km > 50 ? 2 : km > 12 ? 3 : 4; }

// ---- avatars ----
function loadImg(src) {
  const img = new Image();
  img.ok = false;
  img.onload = () => (img.ok = true);
  img.src = src;
  return img;
}
const IMGS = {
  limoDrive: loadImg("backgrounds/limo_drive.jpg"),
  airbase: loadImg("backgrounds/airbase.jpg"),
  ground: loadImg("backgrounds/c17_ground.jpg"),
  takeoff: loadImg("backgrounds/c17_takeoff.jpg"),
  ramp: loadImg("backgrounds/c17_ramp.jpg"),
  exo: loadImg("backgrounds/exosphere.jpg"),
  thermo: loadImg("backgrounds/thermosphere.jpg"),
  meso: loadImg("backgrounds/mesosphere.jpg"),
  tropo: loadImg("backgrounds/troposphere.jpg"),
  mcBase: loadImg("backgrounds/minecraft_base.png"),
};
const PHOTOS = {
  xx: loadImg("TheDudesAvatars/xiaoxiong.png"),
  xxm: loadImg("TheDudesAvatars/xiaoxiongmao.png"),
};

// a solid-red copy of an avatar (same shape, transparent background), built once and reused for the damage flash
const RED_FLASH_TIME = 0.5;
const redCache = {};
function redVersion(key) {
  if (redCache[key]) return redCache[key];
  const img = PHOTOS[key], cv = document.createElement("canvas");
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "source-atop"; // only paint where the avatar already has pixels
  g.fillStyle = "rgba(255,20,20,.85)"; g.fillRect(0, 0, cv.width, cv.height);
  return (redCache[key] = cv);
}

// ---- input ----
// Xiao Xiong: arrow keys. Xiao Xiong Mao: A/D + W. Each dude opens their own parachute.
const keys = {};
let touchDir = 0;
addEventListener("keydown", e => {
  if (e.repeat) return;
  keys[e.code] = true;
  if (["Space", "ArrowUp", "ArrowLeft", "ArrowRight", "ArrowDown"].includes(e.code)) e.preventDefault();
  if (e.code === "KeyR") return reset();
  if (e.code === "KeyM") { // mute / unmute the intro music
    muted = !muted;
    if (muted) { stopMusic(); stopGameMusic(); } // unmuting mid-fall restarts the falling music on the next frame
    toast = { text: muted ? "Music off (M)" : "Music on (M)", until: performance.now() + 1500 };
    return;
  }
  if (state === "start") { // 1 = single player (Xiao Xiong), 2 = both dudes; Space repeats the last choice
    if (e.code === "Digit1" || e.code === "Numpad1") return choosePlayers(1);
    if (e.code === "Digit2" || e.code === "Numpad2") return choosePlayers(2);
    if (e.code === "Space") return startIntro();
    return;
  }
  if (state === "intro" && ["Space", "ArrowUp", "KeyW", "Enter"].includes(e.code)) return start(); // skip cutscene
  if (state === "outro") { if (["Space", "Enter"].includes(e.code)) finishOutro(); return; } // skip cutscene
  if (state === "end" && e.code === "Space") return reset();
  if (e.code === "KeyP" && (state === "falling" || state === "paused")) {
    state = state === "paused" ? "falling" : "paused";
    showOverlay(state === "paused" ? "<h1>Paused</h1>Press P to continue" : "");
    return;
  }
  if (e.code === "KeyV") {
    splitMode = (splitMode + 1) % 3;
    toast = { text: `Split screen: ${SPLIT_LABELS[splitMode]}`, until: performance.now() + 2000 };
    return;
  }
  if (state !== "falling") return;
  if (e.code === "ArrowUp") bears[0].toggleChute();
  if (e.code === "KeyW") bears[numPlayers === 1 ? 0 : 1].toggleChute(); // alone, both sets of keys fly Xiao Xiong
});
addEventListener("keyup", e => (keys[e.code] = false));
canvas.addEventListener("pointerdown", e => {
  if (state === "start") return choosePlayers(e.clientX < W / 2 ? 1 : 2); // tap left half: 1 player, right half: 2
  if (state === "intro") return start();
  if (state === "outro") { if (outroT > 1) finishOutro(); return; }
  if (state === "end") return reset();
  touchDir = e.clientX < W / 2 ? -1 : 1;
  if (state === "falling" && e.clientY < innerHeight * 0.25) bears.forEach(b => b.toggleChute());
});
addEventListener("pointerup", () => (touchDir = 0));

// ---- helpers ----
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function showOverlay(html) { overlay.innerHTML = html; }

// full-screen strobe + slam-in text when a dude dies
const deathEl = document.getElementById("death");
function deathFlash(name) {
  deathEl.innerHTML = `<span>The ${name} died,<br>he will no longer respawn</span>`;
  deathEl.classList.remove("show");
  void deathEl.offsetWidth; // restart the CSS animation
  deathEl.classList.add("show");
}

// ---- bear ----
class Bear {
  constructor(name, key, left, right, x, vx) {
    this.name = name; this.key = key; this.left = left; this.right = right;
    this.x = x; this.y = 0; this.vx = vx; this.vy = 0;
    this.angle = 0; this.av = 0;
    this.chute = false; this.deploy = 0; // deploy 0..1 ramps up so opening isn't an instant stop
    this.done = null;                    // null | "landed" | "crashed"
    this.points = 0;
    this.hp = MAX_HP; this.dead = false; this.flash = 0; this.hitCd = 0;
    this.shield = 0;   // seconds of forcefield left
    this.redFlash = 0; // seconds left of the red "ouch" flash after taking damage
    this.lives = LIVES; this.invuln = 0; this.respawnAt = 0;
  }
  // hit the ground too fast: squash flat with a wobble, burst of stuffing, dust ring and a "SPLAT!"
  drawSplat(c) {
    const e = (performance.now() - this.splatAt) / 1000, ground = this.y + IMG_H / 2;
    const sy = 0.26 + 0.74 * Math.exp(-e * 16) + Math.sin(e * 32) * Math.exp(-e * 7) * 0.14;
    const sx = 1 + (1 - sy) * 0.95;
    c.save();
    c.translate(this.x, ground);
    // dust ring racing outwards along the ground
    const ring = clamp(e / 0.55, 0, 1);
    if (ring < 1) {
      c.strokeStyle = `rgba(235,225,200,${0.8 * (1 - ring)})`; c.lineWidth = 10 * (1 - ring) + 2;
      c.beginPath(); c.ellipse(0, -4, 30 + ring * 170, 8 + ring * 26, 0, 0, 7); c.stroke();
    }
    // the flattened dude, pinned at the feet
    c.save(); c.scale(sx, sy);
    const img = PHOTOS[this.key];
    if (img.ok) { const w = IMG_H * img.naturalWidth / img.naturalHeight; c.drawImage(img, -w / 2, -IMG_H, w, IMG_H); }
    else { c.fillStyle = this.key === "xx" ? "#b9793f" : "#eee"; c.beginPath(); c.arc(0, -R, R, 0, 7); c.fill(); }
    c.restore();
    // stuffing flying out and falling back
    for (const f of this.fluff) {
      const life = clamp(1 - e / 1.3, 0, 1);
      if (!life) continue;
      const fx = Math.cos(f.a) * f.v * e, fy = Math.min(0, -Math.sin(f.a) * f.v * e + 520 * e * e);
      c.fillStyle = `rgba(255,255,255,${life})`;
      c.beginPath(); c.arc(fx, fy - 6, f.r * (0.6 + 0.4 * life), 0, 7); c.fill();
    }
    // "SPLAT!" pops in, then fades
    const pop = clamp(e / 0.18, 0, 1), fade = clamp((2.2 - e) / 0.5, 0, 1);
    if (fade > 0) {
      c.translate(0, -IMG_H * 0.9 - 30 * pop); c.rotate(-0.12); c.scale(0.4 + 0.6 * pop + Math.sin(e * 20) * Math.exp(-e * 6) * 0.2, 0.4 + 0.6 * pop);
      c.globalAlpha = fade; c.font = "900 46px sans-serif"; c.textAlign = "center";
      c.lineWidth = 8; c.strokeStyle = "#5a0000"; c.fillStyle = "#ffd21e";
      c.strokeText("SPLAT!", 0, 0); c.fillText("SPLAT!", 0, 0);
    }
    c.restore();
    c.fillStyle = "#fff"; c.font = "bold 14px sans-serif"; c.textAlign = "center";
    c.strokeStyle = "rgba(0,0,0,.6)"; c.lineWidth = 3;
    c.strokeText(this.name, this.x, ground + 22); c.fillText(this.name, this.x, ground + 22);
  }
  toggleChute() { if (!this.done && !this.dead) { this.chute = !this.chute; this.av += rand(-2, 2); } }
  draw(c) {
    if (this.dead || this.hidden) return; // dead dudes vanish from the sky; hidden ones are inside the limo
    if (this.done === "crashed") return this.drawSplat(c);
    c.save();
    c.translate(this.x, this.y - (this.hop || 0));
    if (this.deploy > 0.05 && !this.done) drawChute(c, this.deploy);
    c.rotate(this.angle);
    if (this.flash > 0 && Math.floor(this.flash * 20) % 2) c.globalAlpha = 0.35;
    const img = PHOTOS[this.key];
    if (img.ok) {
      const w = IMG_H * img.naturalWidth / img.naturalHeight;
      c.drawImage(img, -w / 2, -IMG_H / 2, w, IMG_H);
      if (this.redFlash > 0) { // damage: pulse the dude red, fading out
        const pulse = 0.55 + 0.45 * Math.sin(this.redFlash * 38);
        c.globalAlpha *= clamp(this.redFlash / RED_FLASH_TIME, 0, 1) * pulse;
        c.drawImage(redVersion(this.key), -w / 2, -IMG_H / 2, w, IMG_H);
      }
    } else {
      c.fillStyle = this.redFlash > 0 ? "#e22" : this.key === "xx" ? "#b9793f" : "#eee";
      c.beginPath(); c.arc(0, 0, R, 0, 7); c.fill();
    }
    c.restore();
    if (this.shield > 0) drawForcefield(c, this.x, this.y, this.shield);
    c.fillStyle = "#fff"; c.font = "bold 14px sans-serif"; c.textAlign = "center";
    c.strokeStyle = "rgba(0,0,0,.6)"; c.lineWidth = 3;
    const ty = this.y - IMG_H / 2 - 8 - (this.deploy > 0.05 && !this.done ? 140 * this.deploy : 0);
    c.strokeText(this.name, this.x, ty);
    c.fillText(this.name, this.x, ty);
    drawHealthBar(c, this.x - 30, ty - 20, 60, 8, this.hp);
  }
}

function hpColor(hp) { return hp > 60 ? "#4cd964" : hp > 30 ? "#ffcc00" : "#ff3b30"; }
function drawHealthBar(c, x, y, w, h, hp) {
  c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(x - 1, y - 1, w + 2, h + 2);
  c.fillStyle = hpColor(hp); c.fillRect(x, y, w * clamp(hp, 0, MAX_HP) / MAX_HP, h);
}

// barrier pick-up: a glowing blue hexagon with a shield emblem
function drawBarrier(c, x, y, seed) {
  c.save(); c.translate(x, y);
  const pulse = 0.5 + 0.5 * Math.sin(time * 5 + seed);
  const glow = c.createRadialGradient(0, 0, 6, 0, 0, 56);
  glow.addColorStop(0, `rgba(90,200,255,${0.45 + 0.2 * pulse})`); glow.addColorStop(1, "rgba(90,200,255,0)");
  c.fillStyle = glow; c.beginPath(); c.arc(0, 0, 56, 0, 7); c.fill();
  c.rotate(Math.sin(time * 1.5 + seed) * 0.15);
  const hex = r => { c.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); } c.closePath(); };
  const g = c.createLinearGradient(0, -BARRIER_R, 0, BARRIER_R);
  g.addColorStop(0, "#bff0ff"); g.addColorStop(0.5, "#2f9bff"); g.addColorStop(1, "#1446b8");
  hex(BARRIER_R); c.fillStyle = g; c.fill(); c.lineWidth = 3; c.strokeStyle = "#eaffff"; c.stroke();
  hex(BARRIER_R - 7); c.lineWidth = 1.5; c.strokeStyle = "rgba(255,255,255,.55)"; c.stroke();
  // shield emblem
  c.beginPath(); c.moveTo(0, -13); c.lineTo(11, -8); c.lineTo(11, 2); c.quadraticCurveTo(10, 11, 0, 15); c.quadraticCurveTo(-10, 11, -11, 2); c.lineTo(-11, -8); c.closePath();
  c.fillStyle = "#fff"; c.fill();
  c.fillStyle = "#2f9bff"; c.fillRect(-1.5, -8, 3, 17); c.fillRect(-7, -2, 14, 3);
  c.restore();
}
// the forcefield bubble around a protected dude; it flickers in the last three quarters of a second
function drawForcefield(c, x, y, left) {
  const fading = left < 0.75 ? (Math.floor(left * 14) % 2 ? 0.35 : 1) : 1, r = 62 + Math.sin(time * 8) * 2;
  c.save(); c.translate(x, y); c.globalAlpha = fading;
  const g = c.createRadialGradient(0, 0, r * 0.55, 0, 0, r);
  g.addColorStop(0, "rgba(90,200,255,0)"); g.addColorStop(0.8, "rgba(90,200,255,.22)"); g.addColorStop(1, "rgba(190,240,255,.75)");
  c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill();
  c.lineWidth = 2.5; c.strokeStyle = "rgba(220,250,255,.9)"; c.stroke();
  c.lineWidth = 4; c.strokeStyle = "rgba(255,255,255,.8)"; // moving glint
  c.beginPath(); c.arc(0, 0, r - 5, time * 3, time * 3 + 0.9); c.stroke();
  // time left, as an arc that empties
  c.lineWidth = 3; c.strokeStyle = "#6cd0ff";
  c.beginPath(); c.arc(0, 0, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left / SHIELD_TIME); c.stroke();
  c.restore();
}

const CHUTE_IMG = loadImg("sprites/parachute.png");
const MEDKIT_IMG = loadImg("sprites/medkit.png");
const C17_DOOR_IMG = loadImg("sprites/c17_door.png");
const LIMO_IMG = loadImg("sprites/limo.png");
function drawChute(c, d) {
  const s = 0.4 + 0.6 * d;
  const cw = 150 * s, top = -178 * s; // canopy width and the y of its top edge, relative to the bear
  if (CHUTE_IMG.ok) {
    const ch = cw * CHUTE_IMG.naturalHeight / CHUTE_IMG.naturalWidth, rim = top + ch * 0.82;
    // suspension lines fan out from the harness to the canopy's rim
    c.strokeStyle = "rgba(235,235,225,.8)"; c.lineWidth = 1;
    c.beginPath();
    for (const f of [-0.46, -0.3, -0.15, 0, 0.15, 0.3, 0.46]) { c.moveTo(0, -IMG_H * 0.3); c.lineTo(cw * f, rim - Math.abs(f) * ch * 0.25); }
    c.stroke();
    c.drawImage(CHUTE_IMG, -cw / 2, top, cw, ch);
    return;
  }
  c.strokeStyle = "rgba(255,255,255,.85)"; c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(0, -IMG_H * 0.3); c.lineTo(-55 * s, -85 * s);
  c.moveTo(0, -IMG_H * 0.3); c.lineTo(55 * s, -85 * s);
  c.moveTo(0, -IMG_H * 0.3); c.lineTo(0, -90 * s);
  c.stroke();
  const g = c.createLinearGradient(-60, -130, 60, -80);
  g.addColorStop(0, "#ff5a5a"); g.addColorStop(0.5, "#ffd24a"); g.addColorStop(1, "#4aa8ff");
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(-62 * s, -85 * s);
  c.quadraticCurveTo(0, -165 * s, 62 * s, -85 * s);
  c.quadraticCurveTo(30 * s, -95 * s, 0, -85 * s);
  c.quadraticCurveTo(-30 * s, -95 * s, -62 * s, -85 * s);
  c.fill();
}

// ---- obstacles ----
// parts are collision circles [dx, dy, r]; dx is mirrored with the direction of travel.
const OBSTACLES = {
  satellite: { dmg: 25, parts: [[0, 0, 40]], vx: () => rand(-40, 40), spin: () => rand(-0.5, 0.5) },
  debris: { dmg: 15, parts: [[0, 0, 26]], vx: () => rand(-130, 130), spin: () => rand(-3, 3) },
  iss: { dmg: 45, parts: [[-150, 0, 50], [-75, 0, 30], [0, 0, 30], [75, 0, 30], [150, 0, 50]], vx: () => rand(-30, 30), spin: () => 0 },
  meteor: { dmg: 35, parts: [[0, 0, 20]], vx: () => rand(-280, 280), vy: () => rand(150, 350), spin: () => rand(-2, 2) },
  balloon: { dmg: 15, parts: [[0, 0, 36], [0, 56, 12]], vx: () => rand(-50, 50), spin: () => 0 },
  jet: { dmg: 35, parts: [[-58, 0, 16], [0, 0, 30], [58, 0, 18]], vx: () => rand(260, 420) * (Math.random() < 0.5 ? -1 : 1), spin: () => 0 },
  bird: { dmg: 8, parts: [[-26, -8, 16], [0, 4, 18], [26, -8, 16]], vx: () => rand(50, 110) * (Math.random() < 0.5 ? -1 : 1), spin: () => 0 },
  airliner: { dmg: 40, parts: [[-100, 0, 18], [-50, 0, 24], [0, 0, 34], [50, 0, 24], [100, 0, 20]], vx: () => rand(160, 260) * (Math.random() < 0.5 ? -1 : 1), spin: () => 0 },
  hotair: { dmg: 20, parts: [[0, -22, 46], [0, 52, 12]], vx: () => rand(-35, 35), spin: () => 0 },
  drone: { dmg: 12, parts: [[0, 0, 26]], vx: () => rand(100, 180) * (Math.random() < 0.5 ? -1 : 1), spin: () => 0 },
  storm: { dmg: 18, parts: [[-70, 20, 55], [0, -30, 65], [70, 20, 55]], vx: () => rand(-30, 30), spin: () => 0 },
};
function makeObstacle(kind, x, y) {
  const d = OBSTACLES[kind];
  return { kind, x, y, vx: d.vx(), vy: d.vy ? d.vy() : 0, rot: rand(0, 6), spin: d.spin(), parts: d.parts, dmg: d.dmg, seed: rand(0, 6) };
}

// real photos (cut out to transparent PNGs) for each obstacle; w = drawn width in px.
// noseLeft: the photo faces left, so mirror it when travelling right. spin: rotate with o.rot.
const OB_PHOTO = {
  satellite: { w: 150, spin: true },
  debris: { w: 60, spin: true },
  iss: { w: 400 },
  meteor: { w: 170 },
  balloon: { w: 88 },
  jet: { w: 170, noseLeft: true, turn: true }, // seen from below: turn it round rather than mirror the lettering
  bird: { w: 96 },
  airliner: { w: 250, noseLeft: true },
  hotair: { w: 104, dy: -6 },
  drone: { w: 84 },
  storm: { w: 300, dy: 10 },
};
for (const k in OB_PHOTO) OB_PHOTO[k].img = loadImg(`obstacles/${k}.png`);

function drawObstaclePhoto(c, o, P) {
  const img = P.img, w = P.w, h = w * img.naturalHeight / img.naturalWidth;
  const dir = Math.sign(o.vx) || 1;
  c.save(); c.translate(o.x, o.y);
  if (o.kind === "meteor") {
    // the photo's fireball head is at the left with the tail trailing right; point the tail away from the motion
    c.rotate(Math.atan2(-o.vy, -o.vx) + 0.17);
    c.globalCompositeOperation = "lighter";
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 30);
    g.addColorStop(0, "rgba(190,255,235,.7)"); g.addColorStop(1, "rgba(120,220,255,0)");
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, 30, 0, 7); c.fill();
    c.drawImage(img, -w * 0.12, -h * 0.6, w, h);
  } else {
    if (o.kind === "balloon") { // instrument package hanging under the balloon
      c.strokeStyle = "rgba(230,230,230,.9)"; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(0, 28); c.lineTo(0, 50); c.stroke();
      c.fillStyle = "#d8d8d8"; c.fillRect(-8, 50, 16, 13); c.fillStyle = "#c33"; c.fillRect(-8, 50, 16, 4);
    }
    if (o.kind === "storm" && Math.sin(time * 6 + o.seed * 3) > 0.7) {
      c.strokeStyle = "#fff9b0"; c.lineWidth = 4; c.lineJoin = "round"; c.shadowColor = "#fff36b"; c.shadowBlur = 18;
      c.beginPath(); c.moveTo(0, 40); c.lineTo(-14, 80); c.lineTo(4, 80); c.lineTo(-10, 128); c.stroke();
      c.shadowBlur = 0;
    }
    if (P.spin) c.rotate(o.rot);
    if (P.noseLeft && dir > 0) { if (P.turn) c.rotate(Math.PI); else c.scale(-1, 1); }
    if (o.kind === "bird") c.scale(1, 0.88 + 0.12 * Math.sin(time * 9 + o.seed)); // wingbeat
    c.drawImage(img, -w / 2, -h / 2 + (P.dy || 0), w, h);
  }
  c.restore();
}

function drawObstacle(c, o) {
  if (OB_PHOTO[o.kind].img.ok) return drawObstaclePhoto(c, o, OB_PHOTO[o.kind]);
  const dir = Math.sign(o.vx) || 1;
  c.save(); c.translate(o.x, o.y);
  const body = (col, fn) => { c.fillStyle = col; c.beginPath(); fn(); c.fill(); };
  switch (o.kind) {
    case "satellite":
      c.rotate(o.rot);
      c.fillStyle = "#c9a227"; c.fillRect(-16, -16, 32, 32);
      c.fillStyle = "#2b5fd0"; c.fillRect(-70, -10, 48, 20); c.fillRect(22, -10, 48, 20);
      c.strokeStyle = "#9bb8ff"; c.lineWidth = 1;
      for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(i * 8 + (i < 0 ? -46 : 46), -10); c.lineTo(i * 8 + (i < 0 ? -46 : 46), 10); c.stroke(); }
      c.fillStyle = "#ddd"; c.beginPath(); c.arc(0, -22, 7, 0, 7); c.fill();
      break;
    case "debris":
      c.rotate(o.rot);
      body("#7d7468", () => { c.moveTo(-18, -6); c.lineTo(-4, -20); c.lineTo(16, -10); c.lineTo(20, 8); c.lineTo(2, 20); c.lineTo(-16, 12); });
      break;
    case "iss":
      c.fillStyle = "#2b5fd0";
      for (const sx of [-150, -105, 105, 150]) { c.fillRect(sx - 18, -50, 36, 100); }
      c.fillStyle = "#cfd3da"; c.fillRect(-120, -10, 240, 20);
      c.fillStyle = "#e9ecf1"; c.beginPath(); c.arc(-30, 0, 24, 0, 7); c.arc(30, 0, 24, 0, 7); c.fill();
      c.fillStyle = "#fff"; c.font = "bold 12px sans-serif"; c.textAlign = "center"; c.fillText("ISS", 0, 4);
      break;
    case "meteor": {
      const sp = Math.hypot(o.vx, o.vy) || 1, tx = -o.vx / sp, ty = -o.vy / sp;
      const g = c.createLinearGradient(0, 0, tx * 120, ty * 120);
      g.addColorStop(0, "rgba(255,200,80,.95)"); g.addColorStop(1, "rgba(255,80,0,0)");
      c.strokeStyle = g; c.lineWidth = 26; c.lineCap = "round";
      c.beginPath(); c.moveTo(0, 0); c.lineTo(tx * 120, ty * 120); c.stroke();
      body("#ffb347", () => c.arc(0, 0, 20, 0, 7));
      body("#fff3c0", () => c.arc(0, 0, 10, 0, 7));
      break;
    }
    case "balloon":
      c.strokeStyle = "#ddd"; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(-14, 30); c.lineTo(0, 52); c.moveTo(14, 30); c.lineTo(0, 52); c.stroke();
      body("#f4f1e8", () => c.ellipse(0, 0, 32, 38, 0, 0, 7));
      c.fillStyle = "#c33"; c.fillRect(-9, 50, 18, 14);
      break;
    case "jet":
      c.scale(dir, 1);
      body("#8b99ad", () => c.ellipse(0, 0, 54, 9, 0, 0, 7));
      body("#6b7a91", () => { c.moveTo(-8, 0); c.lineTo(-30, -26); c.lineTo(-18, 0); c.lineTo(-30, 26); });
      body("#6b7a91", () => { c.moveTo(-48, 0); c.lineTo(-58, -14); c.lineTo(-40, 0); });
      body("#7fd2ff", () => c.ellipse(30, -3, 12, 4, 0, 0, 7));
      break;
    case "bird": {
      c.scale(dir, 1);
      const flap = Math.sin(time * 10 + o.seed) * 12;
      body("#333", () => c.ellipse(0, 0, 24, 13, 0, 0, 7));
      c.strokeStyle = "#333"; c.lineWidth = 5;
      c.beginPath(); c.moveTo(-4, 0); c.lineTo(-18, -18 - flap); c.moveTo(-4, 0); c.lineTo(-18, 18 + flap); c.stroke();
      body("#f90", () => { c.moveTo(24, -3); c.lineTo(34, 0); c.lineTo(24, 4); });
      break;
    }
    case "airliner":
      c.scale(dir, 1);
      body("#f2f4f8", () => c.ellipse(0, 0, 100, 18, 0, 0, 7));
      body("#d9dde5", () => { c.moveTo(-10, 4); c.lineTo(-45, 48); c.lineTo(-25, 48); c.lineTo(22, 4); });
      body("#d9dde5", () => { c.moveTo(-10, -4); c.lineTo(-45, -48); c.lineTo(-25, -48); c.lineTo(22, -4); });
      body("#c33", () => { c.moveTo(-90, -4); c.lineTo(-108, -34); c.lineTo(-78, -6); });
      c.fillStyle = "#4a90d9";
      for (let i = -60; i < 70; i += 14) { c.beginPath(); c.arc(i, -4, 3, 0, 7); c.fill(); }
      body("#4a90d9", () => c.ellipse(86, -2, 12, 6, 0, 0, 7));
      break;
    case "hotair": {
      const g = c.createLinearGradient(-46, 0, 46, 0);
      g.addColorStop(0, "#e53935"); g.addColorStop(0.5, "#ffd24a"); g.addColorStop(1, "#4aa8ff");
      c.fillStyle = g; c.beginPath(); c.ellipse(0, -12, 44, 52, 0, 0, 7); c.fill();
      c.strokeStyle = "#654"; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(-26, 30); c.lineTo(-10, 52); c.moveTo(26, 30); c.lineTo(10, 52); c.stroke();
      c.fillStyle = "#8a5a2c"; c.fillRect(-12, 52, 24, 16);
      break;
    }
    case "drone":
      c.fillStyle = "#222"; c.fillRect(-14, -5, 28, 10);
      c.strokeStyle = "#222"; c.lineWidth = 3;
      for (const sx of [-1, 1]) {
        c.beginPath(); c.moveTo(sx * 14, 0); c.lineTo(sx * 30, -8); c.stroke();
        c.strokeStyle = "rgba(60,60,60,.6)"; c.beginPath(); c.ellipse(sx * 30, -10, 14 * Math.abs(Math.cos(time * 40)), 2, 0, 0, 7); c.stroke();
        c.strokeStyle = "#222";
      }
      c.fillStyle = "#e33"; c.beginPath(); c.arc(0, 0, 3, 0, 7); c.fill();
      break;
    case "storm": {
      body("#4b5260", () => { c.arc(-55, 0, 32, 0, 7); c.arc(0, -8, 42, 0, 7); c.arc(55, 0, 32, 0, 7); });
      body("#3a404c", () => { c.arc(-25, 12, 28, 0, 7); c.arc(28, 12, 28, 0, 7); });
      if (Math.sin(time * 6 + o.seed * 3) > 0.7) {
        c.strokeStyle = "#fff36b"; c.lineWidth = 5; c.lineJoin = "round";
        c.beginPath(); c.moveTo(0, 30); c.lineTo(-12, 62); c.lineTo(4, 62); c.lineTo(-8, 100); c.stroke();
      }
      break;
    }
  }
  c.restore();
}

// ---- world ----
let state, bears, score, gems, diamonds, medkits, barriers, obstacles, clouds, spaceStars, time, wind, popups;

// ---- diamond score: kept in local storage so it survives closing the page ----
const DIAMOND_KEY = "dudesSkydive.diamonds";
let lastDiamonds = 0, bestDiamonds = 0;
try { ({ last: lastDiamonds = 0, best: bestDiamonds = 0 } = JSON.parse(localStorage.getItem(DIAMOND_KEY)) || {}); } catch (e) {} // storage blocked or empty
function saveDiamonds(n) {
  lastDiamonds = n; bestDiamonds = Math.max(bestDiamonds, n);
  try { localStorage.setItem(DIAMOND_KEY, JSON.stringify({ last: lastDiamonds, best: bestDiamonds })); } catch (e) {}
}

// ---- single / two player ----
let numPlayers = 2;
const players = () => bears.filter(b => !b.absent);
// in single-player mode Xiao Xiong Mao sits the jump out: flagged absent, and treated as already gone everywhere else
function applyPlayers() {
  const solo = numPlayers === 1, b = bears[1];
  b.absent = solo; b.dead = solo; b.done = solo ? "dead" : null;
  if (solo) bears[0].x = W / 2;
}
function choosePlayers(n) {
  numPlayers = n;
  applyPlayers();
  startIntro();
}

let runId = 0;
function reset() {
  stopMusic(); stopGameMusic();
  runId++;
  deathEl.classList.remove("show");
  state = "start";
  outroT = 0; riders = []; endAtBase = false;
  score = 0; time = 0; popups = [];
  wind = { phase: rand(0, 100), x: 0 };
  const w = W;
  bears = [
    new Bear("Xiao Xiong", "xx", "ArrowLeft", "ArrowRight", w / 2 - 70, -40),
    new Bear("Xiao Xiong Mao", "xxm", "KeyA", "KeyD", w / 2 + 70, 40),
  ];
  applyPlayers();
  resetViews();
  gems = []; diamonds = 0; obstacles = []; clouds = [];
  for (let y = 1500; y < START_ALT - 600; y += rand(300, 500)) gems.push({ x: rand(0.1, 0.9) * w, y, got: false, seed: rand(0, 6) });
  // health kits: touch one to get HP back. Placed fully at random, so some stretches have several and some none
  barriers = [];
  for (let i = 0; i < BARRIER_COUNT; i++) barriers.push({ x: rand(0.05, 0.95) * w, y: rand(1200, START_ALT - 800), got: false, seed: rand(0, 6) });
  medkits = [];
  for (let i = 0; i < MEDKIT_COUNT; i++) medkits.push({ x: rand(0.05, 0.95) * w, y: rand(1200, START_ALT - 800), got: false, seed: rand(0, 6) });
  // each atmosphere layer has its own hazards
  for (let y = 1200; y < START_ALT - 700; y += rand(200, 340)) {
    const alt = altKm(y), r = Math.random();
    const kind = alt > 85 ? (r < 0.4 ? "satellite" : "debris")
      : alt > 50 ? "meteor"
      : alt > 12 ? (r < 0.6 ? "balloon" : "jet")
      : r < 0.35 ? "bird" : r < 0.55 ? "airliner" : r < 0.7 ? "hotair" : r < 0.85 ? "drone" : "storm";
    obstacles.push(makeObstacle(kind, rand(0.05, 0.95) * w, y));
  }
  obstacles.push(makeObstacle("iss", w * rand(0.3, 0.7), fracOfAlt(408) * START_ALT));
  for (let i = 0; i < 70; i++) clouds.push({ x: rand(0, 1), y: rand(fracOfAlt(10) * START_ALT, START_ALT), s: rand(0.6, 1.8) });
  spaceStars = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random(), r: rand(0.5, 1.8), p: rand(0, 6) }));
  showOverlay("<h1>Xiao Xiong &amp; Xiao Xiong Mao</h1>Jump out of the C-17 and fall all the way to Earth!\n\n1 player: Xiao Xiong, ← → (or A D) steer, ↑ (or W) parachute\n2 players: Xiao Xiong ← → ↑ · Xiao Xiong Mao A D W · V: split screen\n\nThe air is thin up here. Open your parachute before you reach the ground!\nGrab the glowing health kits to heal. Blue hexagons give a 2.5 s forcefield. Collect the diamonds! Each dude has 2 lives.\nLand safely and a limo takes you to your Minecraft base!\n\n<b>Press 1 for single player · Press 2 for two players</b>\n(or tap the left / right half of the screen)\nM: music on / off");
}

// cutscene: drive the limo to the air force base, walk in, board the C-17, take off, then walk off the ramp
const DRIVE_LEN = 3.6, ARRIVE_LEN = 5.6, BOARD_LEN = 4.2, TAKEOFF_LEN = 3.8, JUMP_LEN = 7;
const INTRO_LEN = DRIVE_LEN + ARRIVE_LEN + BOARD_LEN + TAKEOFF_LEN + JUMP_LEN;
let introT = 0;
// ---- intro music: synthesised with Web Audio and scored to the five cutscene scenes ----
let music = null, muted = false;
const midi = m => 440 * 2 ** ((m - 69) / 12);

// the instruments: every time passed to them is relative to T0 on audio context `ac`; sound goes to node `out`
function makeSynth(ac, out, T0) {
  const nbuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), nd = nbuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  // one note. o: type, g (gain), to (glide to this frequency), lp (low-pass Hz), sus (hold instead of decaying)
  const tone = (t, f, d, o = {}) => {
    const osc = ac.createOscillator(), g = ac.createGain(), peak = o.g ?? 0.15;
    osc.type = o.type || "square"; osc.frequency.setValueAtTime(f, T0 + t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, T0 + t + d);
    g.gain.setValueAtTime(0.0001, T0 + t);
    g.gain.linearRampToValueAtTime(peak, T0 + t + (o.sus ? 0.06 : 0.01));
    if (o.sus) g.gain.setValueAtTime(peak, T0 + t + d - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, T0 + t + d);
    let node = osc;
    if (o.lp) { const fl = ac.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = o.lp; osc.connect(fl); node = fl; }
    node.connect(g); g.connect(out);
    osc.start(T0 + t); osc.stop(T0 + t + d + 0.05);
  };
  // filtered noise burst. o: g, type, f (filter Hz), f2 (sweep to), swell (fade in over the whole length)
  const noise = (t, d, o = {}) => {
    const src = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain(), peak = o.g ?? 0.2;
    src.buffer = nbuf; src.loop = true;
    fl.type = o.type || "highpass"; fl.frequency.setValueAtTime(o.f || 2000, T0 + t);
    if (o.f2) fl.frequency.exponentialRampToValueAtTime(o.f2, T0 + t + d);
    g.gain.setValueAtTime(0.0001, T0 + t);
    if (o.swell) { g.gain.exponentialRampToValueAtTime(peak, T0 + t + d * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, T0 + t + d); }
    else { g.gain.linearRampToValueAtTime(peak, T0 + t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, T0 + t + d); }
    src.connect(fl); fl.connect(g); g.connect(out);
    src.start(T0 + t); src.stop(T0 + t + d + 0.05);
  };
  const kick = (t, g = 0.5) => tone(t, 150, 0.2, { type: "sine", to: 40, g });
  const snare = (t, g = 0.22) => { noise(t, 0.13, { g, f: 1500 }); tone(t, 190, 0.08, { type: "triangle", g: g * 0.6 }); };
  const hat = (t, g = 0.07) => noise(t, 0.04, { g, f: 7000 });
  const crash = (t, g = 0.2) => noise(t, 1.4, { g, f: 4000 });
  const chord = (t, notes, d, o) => notes.forEach(n => tone(t, midi(n), d, o));
  return { tone, noise, kick, snare, hat, crash, chord };
}

// schedule the whole intro score on `ac`, starting at time T0, into node `out`
function scheduleIntroMusic(ac, out, T0) {
  const { tone, noise, kick, snare, hat, crash, chord } = makeSynth(ac, out, T0);

  // 1) limo drive: a bouncy road groove (8 beats)
  let t0 = 0, b = DRIVE_LEN / 8;
  const bass = [40, 40, 52, 40, 43, 40, 45, 47, 40, 40, 52, 40, 47, 45, 43, 38];
  const lead = [76, 0, 79, 76, 0, 83, 81, 0, 79, 0, 76, 79, 81, 0, 83, 86];
  for (let i = 0; i < 16; i++) {
    const t = t0 + i * b / 2;
    tone(t, midi(bass[i]), b * 0.45, { type: "sawtooth", lp: 600, g: 0.22 });
    if (lead[i]) tone(t, midi(lead[i]), b * 0.4, { g: 0.06 });
    hat(t, i % 2 ? 0.09 : 0.05);
    if (i % 2 === 0) kick(t);
    if (i % 4 === 2) snare(t);
  }

  // 2) arriving at the air force base: a military march with a brass fanfare (12 beats)
  t0 += DRIVE_LEN; b = ARRIVE_LEN / 12;
  const fanfare = [60, 60, 64, 67, 72, 0, 67, 0, 72, 72, 76, 79];
  for (let i = 0; i < 12; i++) {
    const t = t0 + i * b;
    snare(t, 0.2); snare(t + b * 0.5, 0.12); snare(t + b * 0.75, 0.12);
    if (i % 2 === 0) kick(t, 0.4);
    tone(t, midi(i % 2 ? 43 : 48), b * 0.8, { type: "triangle", g: 0.2 });
    if (fanfare[i]) {
      const d = i === 11 ? b * 1.1 : fanfare[i + 1] === 0 ? b * 1.8 : b * 0.85;
      tone(t, midi(fanfare[i]), d, { type: "sawtooth", lp: 1900, g: 0.1, sus: true });
      tone(t, midi(fanfare[i] - 12), d, { type: "sawtooth", lp: 1200, g: 0.06, sus: true });
    }
  }

  // 3) boarding the C-17: a tense climb that builds to the take-off (8 beats)
  t0 += ARRIVE_LEN; b = BOARD_LEN / 8;
  const roots = [38, 38, 41, 41, 43, 43, 45, 46];
  const pads = [[62, 65, 69], [65, 69, 72], [67, 70, 74], [69, 73, 76]];
  for (let i = 0; i < 8; i++) {
    const t = t0 + i * b;
    kick(t, 0.45);
    tone(t, midi(roots[i]), b * 0.4, { type: "sawtooth", lp: 500, g: 0.22 });
    tone(t + b / 2, midi(roots[i]), b * 0.4, { type: "sawtooth", lp: 500, g: 0.16 });
    if (i % 2 === 0) chord(t, pads[i / 2], b * 2, { type: "sawtooth", lp: 1300, g: 0.035 + i * 0.004, sus: true });
  }
  for (let k = 0; k < 16; k++) snare(t0 + b * 6 + k * b / 8, 0.04 + k * 0.012); // snare roll into the take-off

  // 4) take-off: engines spool up, then a triumphant chord as the C-17 climbs
  t0 += BOARD_LEN;
  noise(t0, TAKEOFF_LEN, { g: 0.22, type: "lowpass", f: 150, f2: 3500, swell: true });
  tone(t0, 55, TAKEOFF_LEN, { type: "sawtooth", to: 165, lp: 900, g: 0.12, sus: true });
  tone(t0, 82.4, TAKEOFF_LEN, { type: "sawtooth", to: 247, lp: 900, g: 0.07, sus: true });
  const lift = t0 + TAKEOFF_LEN * 0.45;
  crash(lift, 0.16); kick(lift, 0.6);
  chord(lift, [45, 57, 64, 69, 73, 76], TAKEOFF_LEN * 0.55, { type: "sawtooth", lp: 2600, g: 0.05, sus: true });
  [69, 73, 76, 81, 85, 88].forEach((n, i) => tone(lift + 0.25 + i * 0.16, midi(n), 0.5, { g: 0.05 }));

  // 5) the jump: wind and a heartbeat on the ramp, a hit on "GO GO GO!", then falling whistles
  t0 += TAKEOFF_LEN;
  noise(t0, JUMP_LEN, { g: 0.12, type: "bandpass", f: 500, f2: 1400, swell: true });
  tone(t0, midi(81), 3.8, { type: "sawtooth", lp: 1500, g: 0.025, sus: true });
  tone(t0, midi(82), 3.8, { type: "sawtooth", lp: 1500, g: 0.02, sus: true }); // uneasy semitone
  for (let t = 0.3; t < 3.7; t += 0.85) { kick(t0 + t, 0.5); kick(t0 + t + 0.19, 0.32); }
  const go = t0 + 3.9;
  crash(go, 0.22); kick(go, 0.7);
  chord(go, [40, 52, 59, 64, 67, 71], 2.6, { type: "sawtooth", lp: 2200, g: 0.05, sus: true });
  tone(t0 + 4.4, 1800, 1.9, { type: "sine", to: 300, g: 0.08, sus: true });  // Xiao Xiong falls away
  tone(t0 + 4.55, 1500, 1.9, { type: "sine", to: 250, g: 0.06, sus: true }); // Xiao Xiong Mao follows
}

// the ride to the Minecraft base: the road groove again, then a sparkling fanfare when the chest opens
function scheduleOutroMusic(ac, out, T0) {
  const { tone, noise, kick, snare, hat, crash, chord } = makeSynth(ac, out, T0);
  const b = 0.45, ride = OUT_DRIVE_LEN + BASE_LEN;
  const bass = [48, 48, 60, 48, 53, 53, 55, 55], lead = [76, 0, 79, 84, 0, 81, 79, 0, 77, 0, 81, 84, 0, 83, 86, 0];
  for (let i = 0; i * b / 2 < ride - 0.3; i++) {
    const t = i * b / 2;
    tone(t, midi(bass[i % 8]), b * 0.45, { type: "sawtooth", lp: 600, g: 0.2 });
    if (lead[i % 16]) tone(t, midi(lead[i % 16]), b * 0.4, { g: 0.055 });
    hat(t, i % 2 ? 0.08 : 0.045);
    if (i % 2 === 0) kick(t, 0.42);
    if (i % 4 === 2) snare(t, 0.18);
  }
  // the chest: a held breath, then it opens
  const open = ride + CHEST_OPEN;
  tone(ride, midi(43), CHEST_OPEN, { type: "sawtooth", lp: 500, g: 0.12, sus: true });
  noise(ride, CHEST_OPEN, { g: 0.08, type: "bandpass", f: 400, f2: 3000, swell: true });
  crash(open, 0.18); kick(open, 0.6);
  chord(open, [48, 60, 64, 67, 72, 76], 3.4, { type: "sawtooth", lp: 2400, g: 0.05, sus: true });
  [84, 88, 91, 96, 91, 88, 91, 96, 100, 96, 91, 96, 100, 103, 100, 108].forEach((n, i) => tone(open + 0.15 + i * 0.14, midi(n), 0.4, { type: "sine", g: 0.07 }));
}

function startMusic(schedule = scheduleIntroMusic) {
  stopMusic();
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC || muted) return;
  try {
    const ac = new AC(), master = ac.createGain();
    const limiter = ac.createDynamicsCompressor(); // keeps the loud take-off and "GO!" hits from distorting
    master.gain.value = 0.6; master.connect(limiter); limiter.connect(ac.destination);
    schedule(ac, master, ac.currentTime + 0.05);
    music = { ac, master };
  } catch (e) { music = null; } // no audio device: play the intro silently
}
function stopMusic() {
  if (!music) return;
  const m = music; music = null;
  m.master.gain.setTargetAtTime(0, m.ac.currentTime, 0.08); // quick fade so skipping doesn't click
  setTimeout(() => m.ac.close(), 600);
}

// ---- falling music: a loop written one bar at a time, so it can follow the fall ----
// Each atmosphere layer adds instruments and speeds up: drifting pads in space, full-speed drums near the ground.
let gameMusic = null;
const GM_BEAT = [0.5, 0.47, 0.44, 0.41, 0.375];                 // seconds per beat in each layer (120 -> 160 bpm)
const GM_CHORDS = [[45, 57, 60, 64], [41, 53, 57, 60], [48, 60, 64, 67], [43, 55, 59, 62]]; // Am F C G: [bass, triad]
const GM_ARP = [1, 2, 3, 2, 1, 3, 2, 3];
const GM_LEAD = [[81, 0, 84, 81, 0, 79, 81, 0], [77, 0, 81, 84, 0, 81, 77, 0], [79, 0, 84, 88, 0, 84, 79, 0], [79, 0, 83, 86, 0, 83, 81, 79]];

function scheduleGameBar(m, layer, bar) {
  const { tone, noise, kick, snare, hat, crash, chord } = m.synth, t0 = m.nextBar, b = GM_BEAT[layer], c = GM_CHORDS[bar % 4];
  if (layer !== m.layer) { // crossing into a new layer: a crash and a whoosh mark the change
    if (m.layer !== -1) { crash(t0, 0.14); noise(t0, b * 2, { g: 0.1, type: "bandpass", f: 4000, f2: 300 }); }
    m.layer = layer;
  }
  chord(t0, c.slice(1), b * 4, { type: "sawtooth", lp: layer < 2 ? 800 : 1400, g: layer < 2 ? 0.04 : 0.028, sus: true }); // pad
  if (layer < 2) { // space: slow, floating
    for (let i = 0; i < 4; i++) tone(t0 + i * b, midi(c[GM_ARP[i * 2]] + 12), b * 1.6, { type: "sine", g: 0.07 });
    tone(t0, midi(c[0] - 12), b * 3.5, { type: "sine", g: 0.16, sus: true });
    if (layer === 1) { kick(t0, 0.3); for (let i = 0; i < 8; i++) hat(t0 + i * b / 2, 0.025); }
    return;
  }
  for (let i = 0; i < 8; i++) {
    const t = t0 + i * b / 2;
    tone(t, midi(c[0] - (layer >= 3 && i % 2 ? 0 : 12)), b * 0.42, { type: "sawtooth", lp: 550, g: 0.17 }); // bass
    tone(t, midi(c[GM_ARP[i]] + 12), b * 0.35, { g: 0.035 });                                                // arpeggio
    if (i % 2 === 0) kick(t, 0.42);
    if (layer >= 3) {
      hat(t, i % 2 ? 0.07 : 0.04);
      if (layer === 4) hat(t + b / 4, 0.03);
      if (i % 4 === 2) snare(t, 0.17);
      const n = GM_LEAD[bar % 4][i];
      if (n) tone(t, midi(n + (layer === 4 ? 0 : -12)), b * 0.45, { type: "square", g: 0.05 });
    }
  }
}

function startGameMusic() {
  stopGameMusic();
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC || muted) return;
  try {
    const ac = new AC(), master = ac.createGain(), limiter = ac.createDynamicsCompressor();
    master.gain.value = 0.5; master.connect(limiter); limiter.connect(ac.destination);
    gameMusic = { ac, master, synth: makeSynth(ac, master, 0), nextBar: ac.currentTime + 0.08, bar: 0, layer: -1 };
  } catch (e) { gameMusic = null; }
}
function stopGameMusic(after = 0) {
  if (!gameMusic) return;
  const m = gameMusic; gameMusic = null;
  if (!after) m.master.gain.setTargetAtTime(0, m.ac.currentTime, 0.08);
  setTimeout(() => m.ac.close(), 600 + after * 1000);
}
// called every frame: keep about a quarter of a second of music scheduled ahead, and follow pause
function tickGameMusic() {
  const m = gameMusic;
  if (!m) { if (state === "falling" && !muted && !music) startGameMusic(); return; }
  if (state === "paused") { if (m.ac.state === "running") m.ac.suspend(); return; }
  if (m.ac.state === "suspended") m.ac.resume();
  if (state !== "falling") return;
  const live = bears.filter(b => !b.done), ref = live.length ? live : players();
  const layer = layerIndex(altKm(Math.max(...ref.map(b => b.y)))); // follow whoever is lowest
  if (m.nextBar < m.ac.currentTime) m.nextBar = m.ac.currentTime + 0.05; // fell behind (tab was hidden): don't play catch-up
  while (m.nextBar < m.ac.currentTime + 0.25) {
    scheduleGameBar(m, layer, m.bar++);
    m.nextBar += GM_BEAT[layer] * 4;
  }
}
// the run is over: cut the loop and play a short ending
function endGameMusic(won) {
  const m = gameMusic;
  if (!m) return;
  const now = m.ac.currentTime;
  m.master.gain.cancelScheduledValues(now);
  const { tone, crash, kick } = m.synth;
  if (won) { [60, 64, 67, 72, 76, 79, 84].forEach((n, i) => tone(now + 0.1 + i * 0.11, midi(n), i === 6 ? 1.2 : 0.3, { g: 0.09 })); crash(now + 0.76, 0.14); }
  else { [64, 63, 62, 61, 60, 52].forEach((n, i) => tone(now + 0.1 + i * 0.22, midi(n), i === 5 ? 1.3 : 0.3, { type: "sawtooth", lp: 900, g: 0.12 })); kick(now + 1.2, 0.5); }
  stopGameMusic(3);
}

function startIntro() {
  state = "intro"; introT = 0;
  showOverlay("");
  startMusic(); // started by the key press / tap, which is what lets the browser play sound
}
function start() {
  stopMusic();
  startGameMusic();
  state = "falling";
  showOverlay("");
  snapViews = true;
}

// ---- physics ----
const hearts = b => "♥".repeat(b.lives) + "♡".repeat(LIVES - b.lives);
function hurt(b, o, amount, prefix) {
  if (b.invuln > 0) return; // just lost a life: briefly protected
  if (b.shield > 0) {
    if (SMALL_OBSTACLES.has(o.kind)) { // the forcefield stops small things outright
      b.hitCd = 0.6;
      popups.push({ x: b.x, y: b.y - 60, t: 1, text: "Blocked!", color: "#6cd0ff" });
      return;
    }
    amount *= SHIELD_LARGE_FACTOR; prefix = "Shield " + prefix;
  }
  const dmg = Math.round(amount);
  b.hp = Math.max(0, b.hp - dmg); b.hitCd = 0.6; b.redFlash = RED_FLASH_TIME;
  score = Math.max(0, score - dmg * 2);
  popups.push({ x: b.x, y: b.y - 60, t: 1.2, text: `${prefix}-${dmg}` });
  if (b.hp > 0 || b.dead) return;
  b.lives--;
  if (b.lives > 0) { // lose a life and carry on with full health
    b.hp = MAX_HP; b.invuln = RESPAWN_INVULN;
    popups.push({ x: b.x, y: b.y - 90, t: 1.8, text: `Life lost! ${b.lives} left` });
  } else { b.dead = true; b.done = "dead"; b.chute = false; b.killer = OB_NAME[o.kind]; deathFlash(b.name); }
}
function update(dt) {
  time += dt;
  for (const b of bears) {
    b.shield = Math.max(0, b.shield - dt);
    b.flash = Math.max(0, b.flash - dt); b.redFlash = Math.max(0, b.redFlash - dt); b.hitCd = Math.max(0, b.hitCd - dt); b.invuln = Math.max(0, b.invuln - dt);
    if (b.invuln > 0) b.flash = Math.max(b.flash, 0.1); // keep blinking while protected
    // after a splat with lives to spare, come back above the ground for another go
    if (b.respawnAt && time >= b.respawnAt) {
      b.respawnAt = 0; b.done = null; b.splatAt = 0;
      b.y = START_ALT - RESPAWN_HEIGHT; b.vx = 0; b.vy = 0; b.hp = MAX_HP; b.chute = false; b.deploy = 0; b.invuln = RESPAWN_INVULN;
      popups.push({ x: b.x, y: b.y - 90, t: 1.8, text: `${b.lives} ${b.lives === 1 ? "life" : "lives"} left`, color: "#4cd964" });
    }
  }
  for (const p of popups) { p.t -= dt; p.y -= 40 * dt; }
  popups = popups.filter(p => p.t > 0);
  wind.phase += dt * 0.4;
  wind.x = Math.sin(wind.phase) * 90 + Math.sin(wind.phase * 2.7) * 50;

  for (const b of bears) {
    if (b.done) continue;
    const solo = numPlayers === 1;
    const dir = b.dead ? 0 : (keys[b.right] || (solo && keys.KeyD) ? 1 : 0) - (keys[b.left] || (solo && keys.KeyA) ? 1 : 0) || touchDir;
    b.deploy = clamp(b.deploy + (b.chute ? 1 : -2) * dt, 0, 1);
    // air gets denser towards the ground
    const density = 0.4 + 0.6 * (1 - clamp(altKm(b.y) / 100, 0, 1)) ** 2;
    const k = (DRAG_FREEFALL + (DRAG_CHUTE - DRAG_FREEFALL) * b.deploy) * density;
    const rvx = b.vx - wind.x * density, rvy = b.vy;
    const speed = Math.hypot(rvx, rvy);
    const ax = dir * STEER * (1 - 0.4 * b.deploy) - k * rvx * speed;
    const ay = GRAVITY - k * rvy * speed;
    b.vx += ax * dt; b.vy += ay * dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
    // lean into horizontal acceleration, spring back with damping
    const target = clamp(-ax * 0.0006, -0.7, 0.7);
    b.av += (-(b.angle - target) * 25 - b.av * 4) * dt;
    b.angle += b.av * dt;
    // wrap around the screen edges
    if (b.x < -R) b.x = W + R;
    if (b.x > W + R) b.x = -R;
  }

  // the dudes bump into each other
  const [a, c] = bears;
  if (!a.done && !c.done) {
    const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
    if (d < R * 2 && d > 0) {
      const nx = dx / d, ny = dy / d, push = (R * 2 - d) / 2;
      a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push;
      const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
      if (vn < 0) {
        a.vx += nx * vn * 0.9; a.vy += ny * vn * 0.9;
        c.vx -= nx * vn * 0.9; c.vy -= ny * vn * 0.9;
        a.av += rand(-3, 3); c.av += rand(-3, 3);
      }
    }
  }

  for (const b of bears) {
    if (b.done) continue;
    for (const s of gems) {
      if (!s.got && Math.abs(b.x - s.x) < R + 18 && Math.abs(b.y - s.y) < R + 18) { s.got = true; score += 100; diamonds++; }
    }
    for (const br of barriers) {
      if (br.got || Math.abs(b.x - br.x) > R + BARRIER_R || Math.abs(b.y - br.y) > R + BARRIER_R) continue;
      br.got = true;
      b.shield = SHIELD_TIME;
      popups.push({ x: b.x, y: b.y - 60, t: 1.2, text: "Forcefield!", color: "#6cd0ff" });
    }
    for (const m of medkits) {
      if (m.got || Math.abs(b.x - m.x) > R + MEDKIT_R || Math.abs(b.y - m.y) > R + MEDKIT_R) continue;
      m.got = true;
      const healed = Math.min(MEDKIT_HEAL, MAX_HP - b.hp);
      b.hp += healed;
      popups.push({ x: b.x, y: b.y - 60, t: 1.4, text: `+${Math.round(healed)} HP`, color: "#4cd964" });
    }
    for (const o of obstacles) {
      if (Math.abs(o.y - b.y) > 200) continue;
      const dir = Math.sign(o.vx) || 1;
      for (const [px, py, pr] of o.parts) {
        const cx = o.x + px * dir, cy = o.y + py;
        const ddx = b.x - cx, ddy = b.y - cy, dd = Math.hypot(ddx, ddy);
        if (dd < R + pr && dd > 0) {
          const bx = ddx / dd, by = ddy / dd;
          b.x = cx + bx * (R + pr); b.y = cy + by * (R + pr);
          // closing speed must be measured before the bounce changes our velocity
          const closing = -((b.vx - o.vx) * bx + (b.vy - o.vy) * by);
          const vn = b.vx * bx + b.vy * by;
          if (vn < 0) { b.vx -= 1.8 * vn * bx; b.vy -= 1.8 * vn * by; }
          b.av += rand(-8, 8);
          // damage = the obstacle's base damage, scaled by how fast you hit it
          if (b.hitCd === 0 && closing > 30) hurt(b, o, o.dmg * clamp(closing / REF_SPEED, 0.4, 2), "");
        }
      }
    }
  }
  for (const o of obstacles) {
    o.x += o.vx * dt; o.y += o.vy * dt; o.rot += o.spin * dt;
    if (o.x < -250) o.x = W + 250;
    if (o.x > W + 250) o.x = -250;
  }

  // landing
  for (const b of bears) {
    if (b.done || b.y + IMG_H / 2 < START_ALT) continue;
    b.y = START_ALT - IMG_H / 2;
    const impact = b.vy;
    const onPad = Math.abs(b.x - W / 2) < 120;
    if (b.dead || impact > SAFE_LANDING_SPEED) {
      b.done = "crashed";
      b.lives--;
      if (b.lives > 0) b.respawnAt = time + 2.2; // watch the splat, then respawn
      // splat: the animation runs on wall-clock time because the game stops updating once everyone is down
      b.splatAt = performance.now();
      b.fluff = Array.from({ length: 18 }, () => ({ a: rand(0.2, Math.PI - 0.2), v: rand(140, 420), r: rand(4, 10) }));
    } else {
      b.done = "landed";
      b.points = (onPad ? 500 : 0) + Math.max(0, Math.round(300 - impact));
      score += b.points;
    }
    b.vx = 0; b.vy = 0; b.angle = 0; b.av = 0;
  }

  // the run ends when both have landed/crashed, or immediately when both are dead
  const allDead = bears.every(b => b.dead);
  if (allDead || bears.every(b => b.done && !b.respawnAt)) {
    riders = bears.filter(b => b.done === "landed"); // whoever landed safely gets the limo ride
    state = riders.length ? "outro" : "end";
    endGameMusic(riders.length > 0);
    const splatted = bears.some(b => b.done === "crashed");
    const line = b => `${b.name}: ${b.dead ? `out of lives, knocked out by ${b.killer}!` : b.done === "landed" ? `soft landing! +${b.points}` : "splat! Out of lives"}`;
    const total = diamonds + (riders.length ? DIAMONDS : 0), record = total > bestDiamonds; // the chest's stack counts too
    saveDiamonds(total);
    const html = `<h1>${allDead ? "Game over" : "Touchdown!"}</h1>${players().map(line).join("\n")}\n\nScore: ${Math.round(score)}\n💎 Diamonds: ${riders.length ? `${diamonds} collected + ${DIAMONDS} from the chest = ${total}` : total}${record ? " · new best!" : `\nBest: ${bestDiamonds}`}\n\nPress Space, R or tap to play again`;
    if (riders.length) return startOutro(html);
    const run = runId;
    if (splatted) setTimeout(() => { if (run === runId && state === "end") showOverlay(html); }, 1600); // let the splat play first
    else showOverlay(html);
  }
}

// ---- render ----
function resize() {
  const dpr = devicePixelRatio || 1;
  W = Math.max(300, innerWidth - SIDEBAR_W);
  canvas.style.width = W + "px";
  canvas.width = W * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);

// C-17 seen from below, nose up, rear ramp down at the bottom; (x, y) is the centre of the fuselage
function drawC17(c, x, y, k) {
  c.save(); c.translate(x, y); c.scale(k, k);
  const g = c.createLinearGradient(-260, 0, 260, 0);
  g.addColorStop(0, "#5f6872"); g.addColorStop(0.5, "#9aa3ad"); g.addColorStop(1, "#5f6872");
  c.fillStyle = g; c.strokeStyle = "#2b3138"; c.lineWidth = 2; c.lineJoin = "round";
  const poly = pts => { c.beginPath(); pts.forEach(([a, b], i) => (i ? c.lineTo(a, b) : c.moveTo(a, b))); c.closePath(); c.fill(); c.stroke(); };
  for (const m of [1, -1]) {
    poly([[m * 28, -70], [m * 262, 62], [m * 262, 94], [m * 28, 52]]);             // wing
    poly([[m * 22, 212], [m * 96, 258], [m * 96, 276], [m * 22, 262]]);            // tailplane
    for (const ex of [100, 185]) {                                                  // engines
      const ey = -70 + (ex - 28) / 234 * 132;
      c.fillStyle = "#3d444c"; c.fillRect(m * ex - 9, ey - 26, 18, 54); c.fillStyle = g;
    }
  }
  c.beginPath();                                                                    // fuselage
  c.moveTo(0, -282); c.quadraticCurveTo(32, -240, 31, -190); c.lineTo(31, 226); c.lineTo(22, 268);
  c.lineTo(-22, 268); c.lineTo(-31, 226); c.lineTo(-31, -190); c.quadraticCurveTo(-32, -240, 0, -282);
  c.fill(); c.stroke();
  c.fillStyle = "#20262c"; c.beginPath(); c.moveTo(-20, 268); c.lineTo(20, 268); c.lineTo(26, 300); c.lineTo(-26, 300); c.fill(); // open ramp
  c.restore();
}

// ---- opening cutscene: Xiao Xiong and Xiao Xiong Mao walk off the C-17 ramp ----
const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const RAMP_EDGE_Y = x => 1832 + (1125 - x) * 0.178; // the ramp's far edge in the 1125x2000 photo

// draw a photo cover-fitted and zoomed, keeping photo point (cx, cy) as near the screen centre as the edges allow
function drawKenBurns(img, cx, cy, zoom, dx = 0, dy = 0) {
  const w = W, h = innerHeight;
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight) * zoom;
  const ox = clamp(w / 2 - cx * s, w - img.naturalWidth * s, 0) + dx, oy = clamp(h / 2 - cy * s, h - img.naturalHeight * s, 0) + dy;
  ctx.drawImage(img, ox, oy, img.naturalWidth * s, img.naturalHeight * s);
  return { s, ox, oy };
}
function introCaption(text, t, len, fadeIn = true) {
  const w = W, h = innerHeight;
  ctx.font = "bold 18px sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#fff";
  ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = 4;
  ctx.strokeText(text, 20, h - 28); ctx.fillText(text, 20, h - 28);
  ctx.textAlign = "right"; ctx.font = "14px sans-serif";
  ctx.strokeText("Space to skip · M mutes music", w - 16, h - 28); ctx.fillText("Space to skip · M mutes music", w - 16, h - 28);
  const fade = 1 - clamp(Math.min(fadeIn ? t / 0.35 : 1, (len - t) / 0.35), 0, 1); // fade through black at both ends
  if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, w, h); }
}

// scene 1: the dudes walk up the ramp of the parked C-17 (also the backdrop of the title screen)
function renderBoarding(t, title) {
  const w = W, h = innerHeight, img = IMGS.ground;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (!img.ok) return;
  const v = drawKenBurns(img, 545, 420, lerp(1.38, 1.62, ease(t / BOARD_LEN)));
  if (title) { ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(0, 0, w, h); return; }
  // path in photo px: [x, y of the feet, bear height]; tarmac -> foot of the ramp -> top of the ramp -> inside the hold
  const PATH = [[0, 640, 720, 150], [0.22, 560, 615, 118], [0.8, 430, 438, 50], [1, 395, 400, 30]];
  [bears[1], bears[0]].forEach((b, n) => {
    const i = 1 - n, p = ease((t - 0.4 - i * 0.55) / 2.9);
    if (p <= 0 || b.absent) return;
    let k = 1; while (k < PATH.length - 1 && p > PATH[k][0]) k++;
    const A = PATH[k - 1], B = PATH[k], u = (p - A[0]) / (B[0] - A[0]);
    const x = lerp(A[1], B[1], u) + (i ? 46 : -10) * (1 - p * 0.75), y = lerp(A[2], B[2], u), bh = lerp(A[3], B[3], u) * v.s;
    const bimg = PHOTOS[b.key];
    if (!bimg.ok) return;
    ctx.save();
    ctx.globalAlpha = clamp((1 - p) / 0.12, 0, 1); // they disappear into the hold
    ctx.translate(v.ox + x * v.s, v.oy + y * v.s - (p < 1 ? Math.abs(Math.sin(t * 9 + i)) * bh * 0.08 : 0));
    ctx.rotate(p < 1 ? Math.sin(t * 9 + i) * 0.09 : 0);
    const bw = bh * bimg.naturalWidth / bimg.naturalHeight;
    ctx.drawImage(bimg, -bw / 2, -bh * 0.95, bw, bh);
    ctx.restore();
  });
  introCaption("Boarding the C-17 Globemaster III", t, BOARD_LEN);
}

// scene 2: take-off
function renderTakeoff(t) {
  const w = W, h = innerHeight, img = IMGS.takeoff;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (!img.ok) return;
  const u = ease(t / TAKEOFF_LEN);
  // engine rumble plus a slow push-in while the ground drops away
  drawKenBurns(img, lerp(760, 820, u), lerp(640, 560, u), lerp(1.04, 1.22, u), Math.sin(t * 47) * 2.5, Math.sin(t * 61) * 2.5);
  introCaption(t < TAKEOFF_LEN * 0.55 ? "Take-off!" : "Climbing to 800 km…", t, TAKEOFF_LEN);
}

// one dude drawn standing on photo point (x, y) with height bh (all in photo px) in a Ken Burns view v
function drawIntroDude(b, v, x, y, bh, t, alpha = 1, walking = true) {
  const img = PHOTOS[b.key];
  if (!img.ok || alpha <= 0 || b.absent) return;
  const hh = bh * v.s, ww = hh * img.naturalWidth / img.naturalHeight, ph = b.key === "xx" ? 0 : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(v.ox + x * v.s, v.oy + y * v.s - (walking ? Math.abs(Math.sin(t * 9 + ph)) * hh * 0.08 : 0));
  ctx.rotate(walking ? Math.sin(t * 9 + ph) * 0.09 : 0);
  ctx.drawImage(img, -ww / 2, -hh * 0.95, ww, hh);
  ctx.restore();
}

// scene 1: riding in the limo (the dudes are visible through the windscreen)
function renderDrive(t, len = DRIVE_LEN, caption = "Driving to the air force base", crew = bears) {
  const w = W, h = innerHeight, img = IMGS.limoDrive;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (!img.ok) return;
  const u = t / len;
  // pan along the limo towards the cab, with a road-bump bob
  const v = drawKenBurns(img, lerp(700, 1230, ease(u)), 520, lerp(1.12, 1.5, ease(u)), 0, Math.sin(t * 13) * 3 + Math.sin(t * 29) * 1.5);
  const P = (x, y) => [v.ox + x * v.s, v.oy + y * v.s];
  ctx.save();
  ctx.beginPath(); // windscreen outline in photo px
  [[1022, 236], [1376, 250], [1442, 336], [1032, 392]].forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
  ctx.closePath(); ctx.clip();
  drawIntroDude(crew[0], v, 1300, 410, 190, t, 0.92, false);  // the first dude takes the wheel
  if (crew[1]) drawIntroDude(crew[1], v, 1140, 400, 175, t + 1, 0.92, false);
  ctx.fillStyle = "rgba(20,40,60,.28)"; ctx.fillRect(0, 0, w, h); // tinted glass over them
  ctx.restore();
  introCaption(caption, t, len);
}

// scene 2: the limo pulls up outside the base and the dudes walk in
function renderArrive(t) {
  const w = W, h = innerHeight, img = IMGS.airbase;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (!img.ok) return;
  const v = drawKenBurns(img, 1050, 1080, lerp(1.0, 1.1, ease(t / ARRIVE_LEN)));
  // the limo rolls in along the drive from the bottom left and stops right of the entrance
  const d = 1 - Math.pow(1 - clamp(t / 2.5, 0, 1), 3); // ease-out
  const lx = lerp(-520, 1330, d), ly = lerp(1640, 1440, d), lw = lerp(820, 600, d);
  const L = LIMO_IMG;
  const walkOut = (i) => ease((t - 2.9 - i * 0.5) / 2.1);
  const drawDudes = () => [0, 1].forEach(i => {
    const p = walkOut(i);
    if (p <= 0) return;
    // out of the limo's back door, across the forecourt, in through the entrance
    drawIntroDude(bears[i], v, lerp(1060, 885 + i * 26, p), lerp(1415, 1238, p), lerp(125, 46, p), t, clamp((1 - p) / 0.12, 0, 1), p < 1);
  });
  if (L.ok) {
    const lh = lw * L.naturalHeight / L.naturalWidth;
    const settle = Math.sin(clamp((t - 2.3) / 0.5, 0, 1) * Math.PI) * 5; // nose dips as it brakes
    ctx.save();
    ctx.translate(v.ox + lx * v.s, v.oy + (ly + settle + (d < 1 ? Math.sin(t * 22) * 2 : 0)) * v.s);
    ctx.fillStyle = "rgba(0,0,0,.3)"; ctx.beginPath(); ctx.ellipse(0, -6 * v.s, lw * 0.48 * v.s, 16 * v.s, 0, 0, 7); ctx.fill(); // shadow
    ctx.drawImage(L, -lw / 2 * v.s, -lh * v.s, lw * v.s, lh * v.s);
    ctx.restore();
  }
  drawDudes();
  introCaption(t < 2.7 ? "Arriving at the air force base" : "Heading inside", t, ARRIVE_LEN);
}

function renderIntro() {
  if (state === "start") return renderBoarding(0, true);
  let t = introT;
  if (t < DRIVE_LEN) return renderDrive(t);
  if ((t -= DRIVE_LEN) < ARRIVE_LEN) return renderArrive(t);
  if ((t -= ARRIVE_LEN) < BOARD_LEN) return renderBoarding(t);
  if ((t -= BOARD_LEN) < TAKEOFF_LEN) return renderTakeoff(t);
  renderJump(t - TAKEOFF_LEN);
}

// scene 3: over the drop zone they walk off the open ramp
function renderJump(t) {
  const w = W, h = innerHeight, img = IMGS.ramp;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (!img.ok) return;
  const s = Math.max(w / 1125, h / 2000);                  // cover-fit scale: photo px -> screen px
  const viewW = w / s, viewH = h / s;
  const camX = (1125 - viewW) / 2;
  // the camera starts on the fuselage, tilts down to the ramp as they walk out, then follows them off the edge
  const camY = Math.max(0, lerp(0, 2000 - viewH, ease((t - 0.2) / 1.6)) - 560 * ease((t - 4.6) / 1.8));
  ctx.drawImage(img, camX, camY, viewW, viewH, 0, 0, w, h);

  const toScreen = (x, y) => [(x - camX) * s, (y - camY) * s];
  const BEAR_H = 330;
  const walkers = [
    { b: bears[0], from: [1330, 2150], to: [640, 1924], delay: 0.0, fall: [470, 1250] },
    { b: bears[1], from: [1480, 2190], to: [830, 1894], delay: 0.35, fall: [800, 1180] },
  ];
  for (const wk of walkers) {
    if (wk.b.absent) continue;
    const walk = ease((t - 1.3 - wk.delay) / 2.4);
    let x = lerp(wk.from[0], wk.to[0], walk), y = lerp(wk.from[1], wk.to[1], walk);
    let size = lerp(1.25, 1, walk), ang = 0, falling = false;
    const stepping = t > 1.3 + wk.delay && t < 3.7 + wk.delay;
    if (stepping) { y -= Math.abs(Math.sin(t * 9)) * 18; ang = Math.sin(t * 9) * 0.1; }
    const hop = clamp((t - 3.9 - wk.delay * 0.4) / 0.5, 0, 1);
    if (hop > 0) { y -= Math.sin(Math.PI * hop) * 70; x -= hop * 25; }
    const fall = ease((t - 4.4 - wk.delay * 0.4) / 1.9);
    if (fall > 0) {
      falling = true;
      const ex = x, ey = RAMP_EDGE_Y(x);
      x = lerp(ex, wk.fall[0], fall); y = lerp(ey - 10, wk.fall[1], fall);
      size = lerp(1, 0.22, fall); ang = fall * (wk.b === bears[0] ? 5 : -4.2);
    }
    if (t < 1.3 + wk.delay) continue;
    const [sx, sy] = toScreen(x, y);
    ctx.save();
    if (falling) { // once they are beyond the ramp the floor hides their lower half
      ctx.beginPath();
      const P = [[0, 0], [1125, 0], [1125, 1832], [180, 2000], [0, 2000]].map(([a, b]) => toScreen(a, b));
      P.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.clip();
    }
    ctx.translate(sx, sy); ctx.rotate(ang);
    const bimg = PHOTOS[wk.b.key], hh = BEAR_H * size * s;
    if (bimg.ok) {
      const ww = hh * bimg.naturalWidth / bimg.naturalHeight;
      ctx.drawImage(bimg, -ww / 2, -hh * (falling ? 0.5 : 0.95), ww, hh);
    }
    ctx.restore();
    // name tag while they walk
    if (!falling) {
      ctx.fillStyle = "#fff"; ctx.font = "bold 16px sans-serif"; ctx.textAlign = "center";
      ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = 3;
      ctx.strokeText(wk.b.name, sx, sy - hh * 0.95 - 8); ctx.fillText(wk.b.name, sx, sy - hh * 0.95 - 8);
    }
  }

  introCaption(t < 3.8 ? "C-17 Globemaster III · rear ramp open · 800 km" : "GO GO GO!", t, JUMP_LEN);
}

// ---- ending cutscene: a safe landing earns a limo ride to the Minecraft base and its chest of diamonds ----
const PICKUP_LEN = 5.4, OUT_DRIVE_LEN = 3.2, BASE_LEN = 6.4, CHEST_LEN = 7;
const OUTRO_LEN = PICKUP_LEN + OUT_DRIVE_LEN + BASE_LEN + CHEST_LEN;
const CHEST_OPEN = 1.3;  // seconds into the chest scene that the lid lifts
const DIAMONDS = 64;     // a full stack
const LIMO_ARRIVE = 1.8, LIMO_LEAVE = 3.8; // pickup: the limo has stopped / pulls away
let outroT = 0, riders = [], endHtml = "", limoStop = 0, outroMusicOn = false, endAtBase = false;
const easeOut = t => 1 - (1 - clamp(t, 0, 1)) ** 3;
const frac = v => v - Math.floor(v);
const hash = (i, k) => frac(Math.sin(i * 127.1 + k * 311.7) * 43758.5453); // repeatable "random" per diamond

function startOutro(html) {
  endHtml = html; outroT = 0; outroMusicOn = false;
  riders.forEach(b => (b.fromX = b.x));
  limoStop = clamp(riders.reduce((s, b) => s + b.x, 0) / riders.length + 50, 230, W - 230);
}
function finishOutro() {
  state = "end"; endAtBase = true;
  showOverlay(endHtml);
}
function updateOutro(dt) {
  outroT += dt; time += dt;
  for (const p of popups) { p.t -= dt; p.y -= 40 * dt; }
  popups = popups.filter(p => p.t > 0);
  if (outroT < PICKUP_LEN) {
    // once the limo has stopped, the dudes waddle over to its door and climb in
    riders.forEach((b, i) => {
      const p = ease((outroT - LIMO_ARRIVE - 0.1 - i * 0.35) / 1.3), walking = p > 0 && p < 1;
      b.x = lerp(b.fromX, limoStop - 50, p);
      b.hop = walking ? Math.abs(Math.sin(time * 9 + i)) * 8 : 0;
      b.angle = walking ? Math.sin(time * 9 + i) * 0.09 : 0;
      b.hidden = p >= 1;
    });
  } else if (!outroMusicOn) { outroMusicOn = true; startMusic(scheduleOutroMusic); }
  if (outroT >= OUTRO_LEN) finishOutro();
}

// pickup: the limo drives in along the ground from the left, waits, then leaves to the right (world coordinates)
function drawWorldLimo(c) {
  const L = LIMO_IMG, t = outroT, far = W + 500;
  if (!L.ok) return;
  const x = t < LIMO_LEAVE ? limoStop - far * (1 - easeOut(t / LIMO_ARRIVE)) : limoStop + far * ((t - LIMO_LEAVE) / (PICKUP_LEN - LIMO_LEAVE)) ** 2;
  const moving = t < LIMO_ARRIVE || t > LIMO_LEAVE, lw = 440, lh = lw * L.naturalHeight / L.naturalWidth;
  c.fillStyle = "rgba(0,0,0,.3)"; c.beginPath(); c.ellipse(x, START_ALT + 2, lw * 0.48, 12, 0, 0, 7); c.fill();
  c.drawImage(L, x - lw / 2, START_ALT + 8 - lh + (moving ? Math.sin(time * 22) * 1.5 : 0), lw, lh);
}

// where a walker is along a path of [progress, x, y, height] waypoints
function alongPath(path, p) {
  let k = 1; while (k < path.length - 1 && p > path[k][0]) k++;
  const A = path[k - 1], B = path[k], u = (p - A[0]) / (B[0] - A[0]);
  return [lerp(A[1], B[1], u), lerp(A[2], B[2], u), lerp(A[3], B[3], u)];
}

// the limo pulls up in front of the base and the dudes climb the long wooden stairs (path in the 640x360 screenshot's px)
const BASE_PATH = [[0, 250, 357, 66], [0.2, 306, 353, 62], [0.75, 316, 262, 32], [1, 318, 206, 13]];
function renderBase(t) {
  const w = W, h = innerHeight, img = IMGS.mcBase;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (!img.ok) return;
  ctx.imageSmoothingEnabled = false; // keep the blocks crisp
  const v = drawKenBurns(img, 318, 250, lerp(1, 1.08, ease(t / BASE_LEN)));
  ctx.imageSmoothingEnabled = true;
  [...riders].reverse().forEach((b, n) => {
    const i = riders.length - 1 - n, p = ease((t - 2.5 - i * 0.5) / 3.2);
    if (p <= 0) return;
    const [x, y, bh] = alongPath(BASE_PATH, p);
    drawIntroDude(b, v, x + (i ? 12 : -6) * (1 - p), y, bh, t, clamp((1 - p) / 0.12, 0, 1), p < 1);
  });
  // the limo is parked in the foreground with its nose at the foot of the stairs
  const L = LIMO_IMG;
  if (L.ok) {
    const lw = Math.min(w * 0.62, h * 0.95), lh = lw * L.naturalHeight / L.naturalWidth, d = easeOut(t / 2.2);
    const x = lerp(-lw, v.ox + 292 * v.s - lw / 2, d);
    ctx.drawImage(L, x - lw / 2, h - 4 - lh + (d < 1 ? Math.sin(t * 22) * 2 : 0), lw, lh);
  }
  introCaption(t < 2.4 ? "Arriving at the Minecraft base" : "Up the stairs!", t, BASE_LEN);
}

// Minecraft-style blocks, drawn rather than photographed
function mcPlanks(x, y, u, base, dark) {
  ctx.fillStyle = base; ctx.fillRect(x, y, u + 1, u + 1);
  ctx.fillStyle = dark;
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(x, y + (i + 1) * u / 4 - u / 16, u + 1, u / 16);                 // gap between boards
    ctx.fillRect(x + (i % 2 ? u * 0.25 : u * 0.7), y + i * u / 4, u / 16, u / 4); // board ends
  }
}
function mcBlock(x, y, u, base, light, dark) {
  const e = u / 8;
  ctx.fillStyle = dark; ctx.fillRect(x, y, u, u);
  ctx.fillStyle = light; ctx.fillRect(x, y, u - e, u - e);
  ctx.fillStyle = base; ctx.fillRect(x + e, y + e, u - 2 * e, u - 2 * e);
  ctx.fillStyle = light; ctx.fillRect(x + 2 * e, y + 2 * e, 2 * e, e); ctx.fillRect(x + 5 * e, y + 4 * e, e, e);
  ctx.fillStyle = dark; ctx.fillRect(x + 4 * e, y + 5 * e, 2 * e, e); ctx.fillRect(x + 2 * e, y + 4 * e, e, e);
}
function drawDiamond(x, y, r, rot) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(r, r);
  const poly = (col, pts) => { ctx.fillStyle = col; ctx.beginPath(); pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.closePath(); ctx.fill(); };
  poly("#127f8c", [[-0.72, -0.62], [0.72, -0.62], [1.14, -0.1], [0, 1.16], [-1.14, -0.1]]); // outline
  poly("#4ee3e8", [[-0.6, -0.5], [0.6, -0.5], [1, -0.1], [0, 1], [-1, -0.1]]);
  poly("#b4fbff", [[-0.6, -0.5], [0.6, -0.5], [1, -0.1], [-1, -0.1]]);
  poly("#2cc0cf", [[0.35, -0.1], [1, -0.1], [0, 1]]);
  poly("#fff", [[-0.5, -0.4], [-0.1, -0.4], [-0.3, -0.2], [-0.7, -0.2]]);
  ctx.restore();
}

// inside the base: walls of planks, stacks of diamond and gold blocks, and the chest. `still` holds the last frame behind the end screen
function renderChest(t, still) {
  const w = W, h = innerHeight, now = performance.now() / 1000;
  const u = Math.ceil(Math.max(w / 11, h / 7)), floorY = Math.round(h * 0.8);
  for (let x = 0; x < w; x += u) {
    for (let y = floorY - u; y > -u; y -= u) mcPlanks(x, y, u, "#b08d57", "#7d6238");
    for (let y = floorY; y < h; y += u) mcPlanks(x, y, u, "#6f5330", "#4a361d");
  }
  ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(0, floorY, w, 8);
  // torches
  for (const tx of [w * 0.27, w * 0.73]) {
    const ty = floorY - u * 1.9, s = u / 8, fl = 0.75 + 0.25 * Math.sin(now * 11 + tx);
    const g = ctx.createRadialGradient(tx, ty, 2, tx, ty, u * 1.6);
    g.addColorStop(0, `rgba(255,200,90,${0.45 * fl})`); g.addColorStop(1, "rgba(255,200,90,0)");
    ctx.fillStyle = g; ctx.fillRect(tx - u * 1.6, ty - u * 1.6, u * 3.2, u * 3.2);
    ctx.fillStyle = "#6b4a23"; ctx.fillRect(tx - s / 2, ty, s, s * 4);
    ctx.fillStyle = "#ffb52e"; ctx.fillRect(tx - s / 2, ty - s, s, s);
    ctx.fillStyle = "#fff4b0"; ctx.fillRect(tx - s / 4, ty - s * 0.75, s / 2, s / 2);
  }
  // the loot: diamond blocks stacked on the left, gold on the right
  const bs = Math.round(u * 0.62);
  [3, 2, 1].forEach((n, col) => {
    for (let r = 1; r <= n; r++) {
      mcBlock(col * bs, floorY - r * bs, bs, "#62e3dc", "#c4fbf7", "#2aa39e");
      mcBlock(w - (col + 1) * bs, floorY - r * bs, bs, "#f6d33c", "#fff7a8", "#c08f22");
    }
  });

  const cs = clamp(Math.min(w, h) * 0.3, 120, 260), px = cs / 16, cx = w / 2, open = ease((t - CHEST_OPEN) / 0.5);
  // the dudes on either side, jumping for joy once it opens
  riders.forEach((b, i) => {
    const img = PHOTOS[b.key];
    if (!img.ok) return;
    const dh = cs * 1.25, dw = dh * img.naturalWidth / img.naturalHeight;
    const x = cx + (i ? 1 : -1) * cs * 1.15, y = floorY - Math.abs(Math.sin(now * 7 + i * 1.3)) * cs * (0.03 + 0.2 * open);
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(now * 7 + i * 1.3) * 0.08 * open);
    ctx.drawImage(img, -dw / 2, -dh * 0.97, dw, dh);
    ctx.restore();
  });
  // chest: body, the dark inside heaped with diamonds, then the lid lifting up and back
  const bx = cx - 7 * px, bodyTop = floorY - 10 * px, lift = open * 7 * px;
  if (open > 0) {
    const g = ctx.createRadialGradient(cx, bodyTop, px, cx, bodyTop, cs * 1.5);
    g.addColorStop(0, `rgba(120,255,255,${0.55 * open})`); g.addColorStop(1, "rgba(120,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(cx - cs * 1.5, bodyTop - cs * 1.5, cs * 3, cs * 3);
    ctx.fillStyle = "#1c1206"; ctx.fillRect(bx + px, bodyTop - lift, 12 * px, lift + px);
    for (let i = 0; i < 9; i++) drawDiamond(bx + (2.2 + i * 1.2) * px, bodyTop - Math.min(lift - px, (1 + hash(i, 5) * 1.6) * px), px * 1.3, hash(i, 6) - 0.5);
  }
  ctx.fillStyle = "#3f2a0e"; ctx.fillRect(bx, bodyTop, 14 * px, 10 * px);
  ctx.fillStyle = "#a4691c"; ctx.fillRect(bx + px, bodyTop + px, 12 * px, 8 * px);
  ctx.fillStyle = "#8a5615"; ctx.fillRect(bx + px, bodyTop + 4 * px, 12 * px, px); ctx.fillRect(bx + px, bodyTop + 7 * px, 12 * px, px);
  const lidH = 5 * px * (1 - 0.45 * open), lidY = bodyTop - lift - lidH + px * (1 - open);
  ctx.fillStyle = "#3f2a0e"; ctx.fillRect(bx, lidY, 14 * px, lidH);
  ctx.fillStyle = "#c58a2e"; ctx.fillRect(bx + px, lidY + px * 0.8, 12 * px, lidH - px * 1.6);
  ctx.fillStyle = "#3f2a0e"; ctx.fillRect(cx - 1.5 * px, lidY + lidH - 2 * px, 3 * px, 4.5 * px * (1 - 0.5 * open)); // latch
  ctx.fillStyle = "#d8d8d8"; ctx.fillRect(cx - px, lidY + lidH - 1.5 * px, 2 * px, 3.5 * px * (1 - 0.5 * open));
  // diamonds burst out and rain down onto the floor
  const grav = cs * 6, r = px * 1.7;
  for (let i = 0; i < 30; i++) {
    const a0 = t - CHEST_OPEN - 0.3 - i * 0.08;
    if (a0 < 0) continue;
    const ang = -Math.PI / 2 + (hash(i, 1) - 0.5) * 1.5, sp = cs * (3 + hash(i, 2) * 1.8), vy = Math.sin(ang) * sp;
    const drop = floorY - r + hash(i, 3) * (h - floorY) * 0.5 - bodyTop;       // how far below the chest's rim it comes to rest
    const a = Math.min(a0, (-vy + Math.sqrt(vy * vy + 2 * grav * drop)) / grav); // stop when it lands
    drawDiamond(cx + Math.cos(ang) * sp * a, bodyTop + vy * a + grav * a * a / 2, r, a * 6 * (hash(i, 4) - 0.5));
  }
  const n = clamp(Math.floor((t - CHEST_OPEN - 0.3) / 0.045), 0, DIAMONDS);
  if (n > 0) {
    ctx.font = `900 ${Math.round(cs * 0.3)}px monospace`; ctx.textAlign = "center"; ctx.lineWidth = 8;
    ctx.strokeStyle = "#0b3b42"; ctx.fillStyle = "#7ff6fb";
    ctx.strokeText(`💎 × ${n}`, cx, floorY - cs * 1.75); ctx.fillText(`💎 × ${n}`, cx, floorY - cs * 1.75);
  }
  if (still) { ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(0, 0, w, h); return; } // dimmed behind the end screen
  introCaption(t < CHEST_OPEN ? "Inside the base…" : "A chest full of DIAMONDS!", t, CHEST_LEN + 1); // no fade-out: the end screen follows
}

function renderOutro() {
  if (endAtBase) return renderChest(CHEST_LEN, true);
  let t = outroT - PICKUP_LEN;
  if (t < OUT_DRIVE_LEN) return renderDrive(t, OUT_DRIVE_LEN, "Off to the Minecraft base!", riders);
  if ((t -= OUT_DRIVE_LEN) < BASE_LEN) return renderBase(t);
  renderChest(t - BASE_LEN);
}

// ---- photographic sky: each atmosphere layer cross-fades into the next ----
// fully visible between lo and hi km, fading out over `fade` km on either side
const SKY_LAYERS = [
  { img: IMGS.exo, lo: 600, hi: 800, fade: 260 },
  { img: IMGS.thermo, lo: 150, hi: 450, fade: 260 },
  { img: IMGS.meso, lo: 25, hi: 85, fade: 75 },
];
function drawCover(img, vw, h, slide) { // cover-fit; slide (0..1) drifts the photo vertically
  const sc = Math.max(vw / img.naturalWidth, h * 1.3 / img.naturalHeight);
  const iw = img.naturalWidth * sc, ih = img.naturalHeight * sc;
  ctx.drawImage(img, (vw - iw) / 2, -(ih - h) * slide, iw, ih);
}
function drawSkyPhotos(vw, h, km) {
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, vw, h);
  const slide = clamp(1 - km / START_KM, 0, 1);
  for (const L of SKY_LAYERS) {
    if (!L.img.ok) continue;
    const d = km > L.hi ? km - L.hi : km < L.lo ? L.lo - km : 0;
    const a = clamp(1 - d / L.fade, 0, 1);
    if (a > 0) { ctx.globalAlpha = a; drawCover(L.img, vw, h, slide); }
  }
  const T = IMGS.tropo;
  const ta = clamp(1 - Math.max(0, km - 10) / 20, 0, 1);
  if (T.ok && ta > 0) {
    ctx.globalAlpha = ta;
    const sc = Math.max(vw / T.naturalWidth, h * 1.2 / T.naturalHeight), ih = T.naturalHeight * sc;
    // falling through the troposphere scrolls from the cloud tops down to the fields
    ctx.drawImage(T, (vw - T.naturalWidth * sc) / 2, -(ih - h) * clamp((12 - km) / 12, 0, 1), T.naturalWidth * sc, ih);
  }
  ctx.globalAlpha = 1;
}

// ---- views / split screen ----
// V cycles split-screen: auto (split when the dudes can't share one view) -> always -> off.
// view 0 is the shared camera; views 1 and 2 follow Xiao Xiong and Xiao Xiong Mao.
// splitT eases 0 -> 1 as the screen splits: at 0 the two halves show the left and right of the shared
// view (so they join into one picture), at 1 each half is centred on its own dude.
const SPLIT_LABELS = ["Off", "Auto (splits when out of view)", "Always"];
const SPLIT_TIME = 0.9; // seconds for the split/merge transition
let splitMode = 1, splitActive = false, splitT = 0, splitOrder = [0, 1], lastRender = 0;
let shakeX = 0, shakeY = 0;
let snapViews = true, toast = { text: "", until: 0 };
const views = [0, 1, 2].map(() => ({ camTop: 0, camX: 0, zoom: 1 }));

function resetViews() {
  views.forEach(v => { v.camTop = -innerHeight * 0.4; v.camX = W / 2; v.zoom = 1; });
  splitActive = false; splitT = 0; snapViews = true;
}

function followView(v, ys, xc, h, minZoom, snap = snapViews) {
  const fy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const spread = Math.max(...ys) - Math.min(...ys);
  // zoom out when the targets are far apart vertically so both stay on screen
  const tz = clamp(h * 0.6 / (spread + 250), minZoom, 1);
  const viewH = h / tz;
  const top = Math.min(fy - viewH * 0.4, START_ALT - viewH * 0.8);
  const k = snap ? 1 : 0.15;
  v.zoom += (tz - v.zoom) * (snap ? 1 : 0.1);
  v.camTop += (top - v.camTop) * k;
  v.camX += (xc - v.camX) * k;
  return fy;
}

// the landing zone: the farmland from the photo, tiled (every other tile mirrored so seams don't show)
function drawGround() {
  const T = IMGS.tropo, top = START_ALT, depth = 3000;
  if (!T.ok) { ctx.fillStyle = "#4b6b3a"; ctx.fillRect(-2 * W, top, W * 5, depth); return; }
  const tw = 640 * 1.6, th = 480 * 1.6;
  let i = 0;
  for (let x = -3 * tw; x < W + 3 * tw; x += tw, i++) {
    for (let y = top, j = 0; y < top + depth; y += th, j++) {
      ctx.save(); ctx.translate(x + (i % 2 ? tw : 0), y + (j % 2 ? th : 0)); ctx.scale(i % 2 ? -1 : 1, j % 2 ? -1 : 1);
      ctx.drawImage(T, 0, 1020, 640, 480, 0, 0, tw, th); ctx.restore();
    }
  }
  ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fillRect(-2 * W, top, W * 5, 6); // so the ground line reads against the photo sky
}

// skyW/skyX: the width the sky photo is fitted to and its x offset, so two half views can share one continuous sky
function drawView(v, x0, vw, h, fy, skyW = vw, skyX = 0) {
  const viewH = h / v.zoom;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, 0, vw, h); ctx.clip();
  ctx.translate(x0, 0);

  const km = altKm(fy);
  ctx.save(); ctx.translate(skyX, 0);
  drawSkyPhotos(skyW, h, km);
  const spaceA = clamp((km - 100) / 250, 0, 1) * 0.8; // a few twinkling stars over the space photos
  if (spaceA > 0) {
    for (const s of spaceStars) {
      ctx.fillStyle = `rgba(255,255,255,${spaceA * (0.5 + 0.5 * Math.sin(time * 2 + s.p)) * (s.y > 0.5 ? 0.4 : 1)})`;
      ctx.beginPath(); ctx.arc(s.x * skyW, ((s.y * h * 3 - v.camTop * 0.05) % h + h) % h, s.r, 0, 7); ctx.fill();
    }
  }
  ctx.restore();

  ctx.translate(vw / 2 + shakeX, shakeY); ctx.scale(v.zoom, v.zoom); ctx.translate(-v.camX, -v.camTop); // the world shakes, the sky photo stays put

  // the C-17's open rear door, which the dudes have just dropped out of
  if (C17_DOOR_IMG.ok) {
    const dw = 620, dh = dw * C17_DOOR_IMG.naturalHeight / C17_DOOR_IMG.naturalWidth;
    ctx.drawImage(C17_DOOR_IMG, W / 2 - dw * 0.5, -dh * 0.62 - 60, dw, dh);
  } else drawC17(ctx, W / 2, -270, 1);

  // ground + landing pad
  drawGround();
  ctx.fillStyle = "#e53935"; ctx.fillRect(W / 2 - 120, START_ALT - 4, 240, 8);
  ctx.fillStyle = "#fff"; ctx.fillRect(W / 2 - 60, START_ALT - 4, 120, 8);

  for (const s of gems) {
    if (!s.got && s.y > v.camTop - 100 && s.y < v.camTop + viewH + 100) drawDiamond(s.x, s.y + Math.sin(time * 3 + s.seed) * 4, 20, Math.sin(time * 2 + s.seed) * 0.15);
  }
  for (const br of barriers) {
    if (!br.got && br.y > v.camTop - 100 && br.y < v.camTop + viewH + 100) drawBarrier(ctx, br.x, br.y + Math.sin(time * 3 + br.seed) * 6, br.seed);
  }
  for (const m of medkits) {
    if (m.got || m.y < v.camTop - 100 || m.y > v.camTop + viewH + 100) continue;
    const bob = Math.sin(time * 3 + m.seed) * 6, mw = 72;
    ctx.save(); ctx.translate(m.x, m.y + bob);
    const glow = ctx.createRadialGradient(0, 0, 8, 0, 0, 58); // pulsing green halo so it reads as a pick-up
    glow.addColorStop(0, `rgba(90,255,140,${0.45 + 0.2 * Math.sin(time * 5 + m.seed)})`); glow.addColorStop(1, "rgba(90,255,140,0)");
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 58, 0, 7); ctx.fill();
    if (MEDKIT_IMG.ok) {
      const mh = mw * MEDKIT_IMG.naturalHeight / MEDKIT_IMG.naturalWidth;
      ctx.drawImage(MEDKIT_IMG, -mw / 2, -mh / 2, mw, mh);
    } else {
      ctx.fillStyle = "#fff"; ctx.fillRect(-24, -18, 48, 36); ctx.fillStyle = "#e33"; ctx.fillRect(-5, -13, 10, 26); ctx.fillRect(-13, -5, 26, 10);
    }
    ctx.restore();
  }

  for (const o of obstacles) {
    if (o.y < v.camTop - 250 || o.y > v.camTop + viewH + 250) continue;
    drawObstacle(ctx, o);
  }

  for (const b of bears) b.draw(ctx);
  if (state === "outro") drawWorldLimo(ctx);
  ctx.font = "bold 26px sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 4;
  for (const p of popups) {
    ctx.globalAlpha = clamp(p.t, 0, 1);
    ctx.strokeStyle = "#000"; ctx.fillStyle = p.color || "#ff3b30";
    ctx.strokeText(p.text, p.x, p.y); ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function render() {
  if (state === "start" || state === "intro") { renderIntro(); updateSidebar(); return; }
  if (endAtBase || (state === "outro" && outroT >= PICKUP_LEN)) { renderOutro(); updateSidebar(); return; }
  const h = innerHeight;
  const live = bears.filter(b => !b.done);
  const tracked = live.length ? live : riders.length ? riders : bears; // during the pickup, stay on whoever landed
  const ys = tracked.map(b => b.y);

  // split when both are alive and either can't share one readable view
  let want = false;
  if (live.length === 2 && splitMode) {
    const spread = Math.abs(bears[0].y - bears[1].y), dx = Math.abs(bears[0].x - bears[1].x);
    const needZoom = h * 0.6 / (spread + 250);
    want = splitMode === 2 || (splitActive ? !(needZoom > 0.6 && dx < 0.55 * W) : (needZoom < 0.5 || dx > 0.7 * W));
  }
  const now = performance.now(), dt = Math.min(0.1, (now - lastRender) / 1000);
  // ground-shake for the first moments after a splat
  const sinceSplat = Math.min(...bears.map(b => b.done === "crashed" && b.splatAt ? (now - b.splatAt) / 1000 : 9));
  const amp = sinceSplat < 0.45 ? 14 * (1 - sinceSplat / 0.45) : 0;
  shakeX = (Math.random() - 0.5) * amp; shakeY = (Math.random() - 0.5) * amp;
  lastRender = now;
  if (want && !splitActive) {
    // the dude further left gets the left half; snap the per-dude cameras so they start from the right place
    splitOrder = bears[0].x <= bears[1].x ? [0, 1] : [1, 0];
    if (splitT === 0) bears.forEach((b, i) => followView(views[i + 1], [b.y], b.x, h, 1, true));
  }
  splitActive = want;
  splitT = snapViews ? (want ? 1 : 0) : clamp(splitT + (want ? dt : -dt) / SPLIT_TIME, 0, 1);

  // the shared camera keeps tracking even while split, so merging back is seamless
  let fy = followView(views[0], ys, W / 2, h, 0.3);
  if (splitT === 0) {
    drawView(views[0], 0, W, h, fy);
  } else {
    const half = W / 2, e = ease(splitT), v0 = views[0];
    splitOrder.forEach((bi, side) => {
      const b = bears[bi], v = views[bi + 1];
      followView(v, [b.y], b.x, h, 1);
      // blend from "this half of the shared view" to "this dude's own view"
      const sharedX = v0.camX + (side ? 1 : -1) * (W / 4) / v0.zoom;
      const cam = { zoom: lerp(v0.zoom, v.zoom, e), camX: lerp(sharedX, v.camX, e), camTop: lerp(v0.camTop, v.camTop, e) };
      drawView(cam, side * half, half, h, lerp(fy, b.y, e), lerp(W, half, e), lerp(-side * half, 0, e));
    });
    ctx.fillStyle = `rgba(255,255,255,${e})`; ctx.fillRect(half - 2, 0, 4, h);
    if (live.length === 2) fy = (bears[0].y + bears[1].y) / 2;
  }
  snapViews = false;

  // HUD (left)
  const speed = Math.round(Math.max(0, ...bears.filter(b => !b.done).map(b => b.vy)));
  ctx.fillStyle = "#fff"; ctx.font = "bold 20px sans-serif"; ctx.textAlign = "left";
  ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.lineWidth = 4;
  const lines = [
    `${LAYERS[layerIndex(altKm(fy))].name}`, `Speed: ${speed} m/s`, `Score: ${Math.round(score)}`,
    ...players().map(b => `${b.name} chute: ${b.chute ? "OPEN" : "closed"}`),
    `Wind ${wind.x > 0 ? "→" : "←"} ${Math.abs(Math.round(wind.x / 10))}`,
    ...(numPlayers === 2 ? [`Split screen (V): ${SPLIT_LABELS[splitMode]}`] : []),
  ];
  lines.forEach((l, i) => { ctx.strokeText(l, 16, 30 + i * 26); ctx.fillText(l, 16, 30 + i * 26); });
  // health bars
  ctx.font = "bold 14px sans-serif";
  players().forEach((b, i) => {
    const y = 30 + lines.length * 26 + i * 34;
    const label = `${b.name}  ${hearts(b)}  ${Math.round(b.hp)} HP`;
    ctx.strokeText(label, 16, y); ctx.fillText(label, 16, y);
    drawHealthBar(ctx, 16, y + 5, 180, 12, b.hp);
  });
  // diamond counter (top right)
  ctx.font = "bold 26px sans-serif"; ctx.textAlign = "right";
  ctx.strokeText(`× ${diamonds}`, W - 16, 36); ctx.fillText(`× ${diamonds}`, W - 16, 36);
  drawDiamond(W - 34 - ctx.measureText(`× ${diamonds}`).width, 25, 13, 0);
  ctx.font = "bold 14px sans-serif";
  ctx.strokeText(`Best: ${bestDiamonds}`, W - 16, 58); ctx.fillText(`Best: ${bestDiamonds}`, W - 16, 58);

  if (performance.now() < toast.until) {
    ctx.font = "bold 28px sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 5;
    ctx.strokeText(toast.text, W / 2, 60); ctx.fillText(toast.text, W / 2, 60);
  }
  if (state === "outro") introCaption(outroT < LIMO_ARRIVE ? "Safe landing! Your limo is here" : outroT < LIMO_LEAVE ? "Hop in!" : "Off to the Minecraft base!", outroT, PICKUP_LEN, false);

  updateSidebar();
}

// sidebar: the atmosphere layers drawn to the fall's scale, spaceship at the top, ground at the bottom
function buildSidebar() {
  BREAKS.slice(0, -1).forEach(([f0, a0], i) => {
    const [f1, a1] = BREAKS[i + 1];
    const el = document.createElement("div");
    el.className = "sb-layer";
    el.style.cssText = `top:${f0 * 100}%;height:${(f1 - f0) * 100}%;background:${LAYERS[i].color}`;
    el.innerHTML = `<b>${LAYERS[i].name}</b><span>${a0 > 700 ? "700+" : a0} – ${a1} km</span>`;
    sbTrack.appendChild(el);
  });
  for (const m of LANDMARKS) {
    const el = document.createElement("div");
    el.className = "sb-mark";
    el.style.top = `${fracOfAlt(m.km) * 100}%`;
    el.textContent = `${m.label} · ${m.km} km`;
    sbTrack.appendChild(el);
  }
  // minimap layer: miniature obstacles drawn at their live positions, under the dude markers
  sbMap = document.createElement("canvas");
  sbMap.id = "sb-map";
  sbTrack.appendChild(sbMap);
  sbMarkers.forEach(m => sbTrack.appendChild(m));
}
let sbMap;
const MINI_SCALE = 0.1, MINI_MIN = 11; // miniature size relative to the in-game photo, and its smallest width in px

function drawMinimap(trackW, trackH) {
  const dpr = devicePixelRatio || 1;
  if (sbMap.width !== Math.round(trackW * dpr) || sbMap.height !== Math.round(trackH * dpr)) {
    sbMap.width = Math.round(trackW * dpr); sbMap.height = Math.round(trackH * dpr);
  }
  const g = sbMap.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, trackW, trackH);
  if (!obstacles) return;
  for (const o of obstacles) {
    // same mapping as the dude markers: world x across the track, world y down it
    const x = clamp(o.x / W, 0, 1) * trackW, y = clamp(o.y / START_ALT, 0, 1) * trackH;
    const P = OB_PHOTO[o.kind], img = P.img;
    if (!img.ok) { g.fillStyle = "#f55"; g.fillRect(x - 2, y - 2, 4, 4); continue; }
    const w = Math.max(MINI_MIN, P.w * MINI_SCALE), h = w * img.naturalHeight / img.naturalWidth;
    g.save(); g.translate(x, y);
    if (o.kind === "meteor") g.rotate(Math.atan2(-o.vy, -o.vx) + 0.17);
    else if (P.spin) g.rotate(o.rot);
    else if (P.noseLeft && o.vx > 0) { if (P.turn) g.rotate(Math.PI); else g.scale(-1, 1); }
    g.drawImage(img, -w / 2, -h / 2, w, h);
    g.restore();
  }
}

function updateSidebar() {
  const trackH = sbTrack.clientHeight, trackW = sbTrack.clientWidth;
  drawMinimap(trackW, trackH);
  bears.forEach((b, i) => {
    const frac = clamp(b.y / START_ALT, 0, 1), mw = sbMarkers[i].offsetWidth || 24;
    sbMarkers[i].style.display = b.dead ? "none" : "";
    sbMarkers[i].style.top = `${clamp(frac * trackH - 16, 0, trackH - 32)}px`;
    sbMarkers[i].style.left = `${clamp(b.x / W, 0, 1) * trackW - mw / 2}px`; // real horizontal position too
  });
  sbText.innerHTML = players().map(b => {
    const km = b.done && !b.dead ? 0 : altKm(b.y);
    const status = b.done ? (b.done === "landed" ? " ✔" : " ✖") : "";
    return `<div><b>${b.name}</b>${status}<br>${hearts(b)} · ${Math.round(b.hp)} HP<br>${LAYERS[layerIndex(km)].name}<br>alt ${km >= 100 ? Math.round(km) : km.toFixed(1)} km · fallen ${Math.round(START_KM - km)} km</div>`;
  }).join("");
}

// ---- main loop ----
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (acc >= STEP) {
    if (state === "falling") update(STEP);
    else if (state === "intro") { introT += STEP; if (introT >= INTRO_LEN) start(); }
    else if (state === "outro") updateOutro(STEP);
    acc -= STEP;
  }
  tickGameMusic();
  render();
  requestAnimationFrame(frame);
}

sbMarkers[0].src = "TheDudesAvatars/xiaoxiong.png";
sbMarkers[1].src = "TheDudesAvatars/xiaoxiongmao.png";
resize();
reset();
buildSidebar();
requestAnimationFrame(frame);
