// Bug Swarm: rendering, input and juice. Rules live in game/{config,schedule,score}.ts.
//
// Performance notes (mid-range Android is the target):
//  - one <canvas>, DPR capped at 2, everything pre-rendered to offscreen canvases
//    (code background, bug/golden/feature sprites) and blitted each frame
//  - fixed-size pools for entities, particles, rings and floaters; no per-frame allocation
//  - no shadowBlur / ctx.filter; shimmer is a pulsing alpha overlay
//  - round time accumulates clamped dt, so it never runs faster than wall time
import { GAME } from './game/config.ts';
import { buildSchedule, type Kind, type Spawn } from './game/schedule.ts';
import { Scorer, type Tally } from './game/score.ts';

export interface RunResult extends Tally {
  seed: number;
  bugs: number;
  max_combo: number;
  taps: number;
  score: number;
  escaped: number;
  wall_ms: number;
}

export interface StartOptions {
  seed: number;
  onEnd: (r: RunResult) => void;
}

const FONT = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';
const HUD_H = 58;
const LINE_H = 22;
const GUTTER = 38;
const SPRITE = 48; // CSS px box for bug sprites
const MAX_W = 540; // playfield width cap (CSS px)

const C = {
  bg: '#0d1117',
  gutter: '#0a0d12',
  lineNo: '#3d4450',
  hud: '#e6edf3',
  dim: '#7d8590',
  red: '#f85149',
  green: '#3fb950',
  gold: '#f2c94c',
  purple: '#a371f7',
};

// ---------------------------------------------------------------- pools

interface Entity {
  on: boolean;
  kind: Kind;
  x: number;
  y: number;
  heading: number;
  turn: number;
  speed: number;
  age: number;
  dying: number; // >0 while the squash animation plays (seconds elapsed)
  base: number; // inward direction of the edge it entered from
  axis: number; // px length used to scale its speed
  vx: number; // dodge/dart impulse, px/s, decays
  vy: number;
  hp: number; // 2 for armored bugs until cracked
  flash: number; // seconds of hit flash left
  entered: boolean; // has been fully inside the playfield
}
interface Particle { on: boolean; x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface Ring { on: boolean; x: number; y: number; life: number; max: number; r0: number; r1: number; color: string }
interface Floater { on: boolean; x: number; y: number; life: number; max: number; text: string; color: string; size: number }

const pool = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

// ---------------------------------------------------------------- sound (off by default)

class Sfx {
  private ctx: AudioContext | null = null;
  enabled = false;
  constructor() {
    try { this.enabled = localStorage.getItem('bs.sound') === '1'; } catch { /* private mode */ }
  }
  toggle(): boolean {
    this.enabled = !this.enabled;
    try { localStorage.setItem('bs.sound', this.enabled ? '1' : '0'); } catch { /* ignore */ }
    if (this.enabled) this.unlock();
    return this.enabled;
  }
  /** Must be called from a user gesture (iOS). */
  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }
  play(kind: 'squash' | 'golden' | 'regress'): void {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    if (kind === 'regress') {
      o.type = 'square';
      o.frequency.setValueAtTime(140, t);
      o.frequency.linearRampToValueAtTime(70, t + 0.18);
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    } else {
      o.type = kind === 'golden' ? 'triangle' : 'sine';
      const f = kind === 'golden' ? 900 : 520 + Math.random() * 120;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.25, t + 0.08);
      g.gain.setValueAtTime(kind === 'golden' ? 0.18 : 0.14, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    }
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.22);
  }
}

const buzz = (p: number | number[]) => {
  if ('vibrate' in navigator) try { navigator.vibrate(p); } catch { /* ignore */ }
};

// ---------------------------------------------------------------- fake Go code for the background

const CODE = `package main

import (
	"errors"
	"fmt"
	"net/http"
)

// Network holds everyone Jemeel met at DevFest.
type Network struct {
	nodes map[string]*Dev
}

func (n *Network) Connect(you *Dev) error {
	if you == nil {
		return errors.New("who dis")
	}
	n.nodes[you.Handle] = you // TODO: fix bugs
	return nil
}

func main() {
	net := &Network{nodes: map[string]*Dev{}}
	http.HandleFunc("/connect", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "build failing")
	})
	for i := 0; i < len(bugs); i++ {
		go squash(bugs[i]) // what could go wrong
	}
	log.Fatal(http.ListenAndServe(":8080", nil))
}
`.split('\n');

const KW = new Set(['package', 'import', 'type', 'struct', 'func', 'return', 'if', 'for', 'go', 'nil', 'map', 'error']);
const TOKEN = /(\/\/.*$)|("[^"]*")|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;

function drawCodeLine(ctx: CanvasRenderingContext2D, line: string, x: number, y: number) {
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let cx = x;
  while ((m = TOKEN.exec(line)) && m[0] !== '') {
    const s = m[0].replace(/\t/g, '  ');
    let color = '#c9d1d9';
    if (m[1]) color = '#8b949e';
    else if (m[2]) color = '#a5d6ff';
    else if (m[3]) {
      if (KW.has(s)) color = '#ff7b72';
      else if (/^[A-Z]/.test(s)) color = '#ffa657';
      else if (line[TOKEN.lastIndex] === '(') color = '#d2a8ff';
    }
    if (!m[4]) {
      ctx.fillStyle = color;
      ctx.fillText(s, cx, y);
    }
    cx += ctx.measureText(s).width;
  }
}

// ---------------------------------------------------------------- sprites

function offscreen(w: number, h: number, dpr: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const x = c.getContext('2d')!;
  x.scale(dpr, dpr);
  return [c, x];
}

function bugSprite(dpr: number, body: string, shell: string, head: string, legPhase: number) {
  const [c, x] = offscreen(SPRITE, SPRITE, dpr);
  x.translate(SPRITE / 2, SPRITE / 2);
  x.strokeStyle = head;
  x.lineWidth = 1.8;
  x.lineCap = 'round';
  // legs: three per side, alternating tripod gait
  for (let i = 0; i < 3; i++) {
    const lx = -6 + i * 6;
    const swing = ((i % 2 === 0) === (legPhase === 0) ? 1 : -1) * 3;
    x.beginPath();
    x.moveTo(lx, -4); x.lineTo(lx + swing, -12);
    x.moveTo(lx, 4); x.lineTo(lx - swing, 12);
    x.stroke();
  }
  // antennae
  x.beginPath();
  x.moveTo(12, -2); x.quadraticCurveTo(17, -4, 19, -9);
  x.moveTo(12, 2); x.quadraticCurveTo(17, 4, 19, 9);
  x.stroke();
  // body
  x.fillStyle = body;
  x.beginPath(); x.ellipse(-1, 0, 10.5, 7.5, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = head;
  x.beginPath(); x.arc(10, 0, 4.6, 0, Math.PI * 2); x.fill();
  // shell seam + spots
  x.strokeStyle = shell;
  x.lineWidth = 1.2;
  x.beginPath(); x.moveTo(-11, 0); x.lineTo(8, 0); x.stroke();
  x.fillStyle = shell;
  for (const [sx, sy] of [[-5, -3.5], [-5, 3.5], [1, -3], [1, 3]]) {
    x.beginPath(); x.arc(sx, sy, 1.5, 0, Math.PI * 2); x.fill();
  }
  // highlight
  x.fillStyle = 'rgba(255,255,255,0.28)';
  x.beginPath(); x.ellipse(-3, -3.5, 5, 2, -0.2, 0, Math.PI * 2); x.fill();
  return c;
}

// Steel plating over a darker bug: reads as "this one needs two taps".
function armorPlate(c: HTMLCanvasElement, dpr: number) {
  const x = c.getContext('2d')!;
  x.setTransform(dpr, 0, 0, dpr, (SPRITE / 2) * dpr, (SPRITE / 2) * dpr);
  x.strokeStyle = '#c9d1d9';
  x.lineWidth = 2.4;
  x.beginPath(); x.ellipse(-1, 0, 11.5, 8.5, 0, 0, Math.PI * 2); x.stroke();
  x.lineWidth = 1.4;
  x.beginPath(); x.moveTo(-5, -8); x.lineTo(-5, 8); x.moveTo(2, -8); x.lineTo(2, 8); x.stroke();
  return c;
}

function glowSprite(dpr: number) {
  const [c, x] = offscreen(SPRITE, SPRITE, dpr);
  const g = x.createRadialGradient(SPRITE / 2, SPRITE / 2, 2, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  g.addColorStop(0, 'rgba(255,236,150,0.9)');
  g.addColorStop(1, 'rgba(255,200,60,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, SPRITE, SPRITE);
  return c;
}

// ctx.roundRect is missing on iOS < 16
function roundRect(x: CanvasRenderingContext2D, l: number, t: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(l + r, t);
  x.arcTo(l + w, t, l + w, t + h, r);
  x.arcTo(l + w, t + h, l, t + h, r);
  x.arcTo(l, t + h, l, t, r);
  x.arcTo(l, t, l + w, t, r);
  x.closePath();
}

const FEAT_W = 58;
const FEAT_H = 28;
function featureSprite(dpr: number) {
  const [c, x] = offscreen(FEAT_W + 4, FEAT_H + 4, dpr);
  x.translate(2, 2);
  x.fillStyle = '#1f6f34';
  x.strokeStyle = C.green;
  x.lineWidth = 1.5;
  roundRect(x, 0, 0, FEAT_W, FEAT_H, 7);
  x.fill(); x.stroke();
  x.fillStyle = '#fff';
  x.font = `bold 13px ${FONT}`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('✓ feat', FEAT_W / 2, FEAT_H / 2 + 1);
  return c;
}

// ---------------------------------------------------------------- the game

type State = 'idle' | 'countdown' | 'playing' | 'ending' | 'done';

export class BugSwarm {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly sfx = new Sfx();
  showFps = false;

  private w = 0;
  private h = 0;
  private dpr = 1;
  private rectX = 0;
  private rectY = 0;
  private bg!: HTMLCanvasElement;
  private sprites!: { bug: HTMLCanvasElement[]; armor: HTMLCanvasElement[]; gold: HTMLCanvasElement[]; glow: HTMLCanvasElement; feat: HTMLCanvasElement };

  private entities = pool<Entity>(48, () => ({ on: false, kind: 'bug', x: 0, y: 0, heading: 0, turn: 0, speed: 1, age: 0, dying: 0, base: 0, axis: 1, vx: 0, vy: 0, hp: 1, flash: 0, entered: false }));
  private live: Entity[] = []; // draw order (oldest first); compacted in place
  private particles = pool<Particle>(160, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, color: '', size: 2 }));
  private rings = pool<Ring>(24, () => ({ on: false, x: 0, y: 0, life: 0, max: 1, r0: 0, r1: 0, color: '' }));
  private floaters = pool<Floater>(24, () => ({ on: false, x: 0, y: 0, life: 0, max: 1, text: '', color: '', size: 14 }));

  private state: State = 'idle';
  private paused = false;
  private raf = 0;
  private lastTs = 0;
  private opts: StartOptions | null = null;
  private schedule: Spawn[] = [];
  private nextSpawn = 0;
  private time = 0; // round seconds
  private countdown = 0;
  private endTimer = 0;
  private wallStart = 0;
  private scorer = new Scorer();
  private taps = 0;
  private armorShown = false;
  private escaped = 0;
  private shake = 0;
  private comboPop = 0;
  private lastMul = 1;
  private timerText = '';
  private timerTenths = -1;
  private fps = { frames: 0, acc: 0, worst: 0, shown: '' };

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bs-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;

    this.canvas.addEventListener('pointerdown', this.onPointer, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  // ------------------------------------------------------------ lifecycle

  start(opts: StartOptions): void {
    this.opts = opts;
    this.schedule = buildSchedule(opts.seed);
    this.nextSpawn = 0;
    for (const e of this.entities) e.on = false;
    for (const p of this.particles) p.on = false;
    for (const r of this.rings) r.on = false;
    for (const f of this.floaters) f.on = false;
    this.live.length = 0;
    this.scorer = new Scorer();
    this.time = 0;
    this.taps = 0;
    this.armorShown = false;
    this.escaped = 0;
    this.shake = 0;
    this.comboPop = 0;
    this.lastMul = 1;
    this.timerTenths = -1;
    this.countdown = GAME.countdownFrom + 0.45;
    this.state = 'countdown';
    this.paused = document.hidden;
    this.resize();
    this.loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onPointer);
    window.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.remove();
  }

  private loop() {
    cancelAnimationFrame(this.raf);
    this.lastTs = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (ts: number) => {
    const raw = this.lastTs ? (ts - this.lastTs) / 1000 : 1 / 60;
    this.lastTs = ts;
    const dt = Math.min(raw, 0.05);
    if (this.showFps) this.trackFps(raw);

    if (!this.paused) this.update(dt);
    this.render();

    if (this.state === 'done') return; // stop the loop between rounds
    this.raf = requestAnimationFrame(this.frame);
  };

  // ------------------------------------------------------------ update

  private update(dt: number) {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = 'playing';
        this.wallStart = performance.now();
      }
      this.updateFx(dt);
      return;
    }
    if (this.state === 'ending') {
      this.endTimer -= dt * 1000;
      this.updateFx(dt * 0.25); // slow-mo the leftovers during the freeze-frame
      if (this.endTimer <= 0) this.finish();
      return;
    }
    if (this.state !== 'playing') return;

    this.time += dt;
    this.scorer.tick(this.time);
    if (this.scorer.multiplier !== this.lastMul) {
      if (this.scorer.multiplier > this.lastMul) this.comboPop = 1;
      this.lastMul = this.scorer.multiplier;
    }

    while (this.nextSpawn < this.schedule.length && this.schedule[this.nextSpawn].t <= this.time) {
      this.spawn(this.schedule[this.nextSpawn++]);
    }

    const ramp = 1 + GAME.speedRamp * Math.min(1, this.time / GAME.seconds);
    const evade = this.evade();
    const top = HUD_H;
    const pad = 22; // how far outside the playfield before a bug counts as gone

    for (const e of this.live) {
      if (!e.on) continue;
      if (e.flash > 0) e.flash -= dt;
      if (e.dying > 0) {
        e.dying += dt;
        if (e.dying * 1000 >= GAME.splatMs) e.on = false;
        continue;
      }
      e.age += dt;
      const golden = e.kind === 'golden';
      const turnRate = golden ? GAME.goldenTurnRate : GAME.turnRate;
      // smooth random wander around the entry direction: turn velocity does a damped random walk
      e.turn += (Math.random() * 2 - 1) * turnRate * 4 * dt;
      e.turn *= 1 - Math.min(1, 3 * dt);
      e.heading += e.turn * dt;
      const maxH = golden ? 1.2 : GAME.maxHeading;
      const off = e.heading - e.base;
      if (off > maxH) { e.heading = e.base + maxH; e.turn = -Math.abs(e.turn); }
      if (off < -maxH) { e.heading = e.base - maxH; e.turn = Math.abs(e.turn); }

      // evasive darts: random sideways bursts, more frequent as the round goes on
      if (e.kind !== 'feature') {
        const rate = golden ? 2.5 : GAME.dartRate * evade;
        if (Math.random() < rate * dt) {
          const side = Math.random() < 0.5 ? 1 : -1;
          const k = GAME.dodgeSpeed * (0.45 + 0.25 * evade);
          e.vx += -Math.sin(e.heading) * side * k;
          e.vy += Math.cos(e.heading) * side * k;
        }
      }

      const mul = golden ? GAME.goldenSpeedMul : e.kind === 'feature' ? GAME.featureSpeedMul : 1;
      const v = GAME.bugSpeed * e.axis * ramp * mul * e.speed;
      e.x += (Math.cos(e.heading) * v + e.vx) * dt;
      e.y += (Math.sin(e.heading) * v + e.vy) * dt;
      const damp = 1 - Math.min(1, 6 * dt);
      e.vx *= damp;
      e.vy *= damp;

      const inside = e.x > 0 && e.x < this.w && e.y > top && e.y < this.h;
      if (inside) e.entered = true;
      const gone = e.entered
        ? e.x < -pad || e.x > this.w + pad || e.y < top - pad || e.y > this.h + pad
        : e.age > 3; // safety: never got in
      if (golden && e.age >= GAME.goldenLifetime) {
        e.on = false;
        this.puff(e.x, e.y, C.gold, 'deployed');
      } else if (gone) {
        e.on = false;
        if (e.kind !== 'feature') {
          this.escaped++;
          this.puff(Math.min(this.w - 24, Math.max(24, e.x)), Math.min(this.h - 14, Math.max(top + 14, e.y)), C.dim, 'escaped');
        }
      }
    }
    this.compact();
    this.updateFx(dt);

    if (this.time >= GAME.seconds) {
      this.time = GAME.seconds;
      this.state = 'ending';
      this.endTimer = GAME.endFreezeMs;
      buzz(20);
    }
  }

  private updateFx(dt: number) {
    for (const p of this.particles) {
      if (!p.on) continue;
      p.life += dt;
      if (p.life >= p.max) { p.on = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 3 * dt;
      p.vy *= 1 - 3 * dt;
    }
    for (const r of this.rings) if (r.on && (r.life += dt) >= r.max) r.on = false;
    for (const f of this.floaters) {
      if (!f.on) continue;
      f.life += dt;
      f.y -= 46 * dt;
      if (f.life >= f.max) f.on = false;
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.5);
    if (this.comboPop > 0) this.comboPop = Math.max(0, this.comboPop - dt * 3);
  }

  private compact() {
    let j = 0;
    for (let i = 0; i < this.live.length; i++) if (this.live[i].on) this.live[j++] = this.live[i];
    this.live.length = j;
  }

  private onScreen(kind: Kind): number {
    let n = 0;
    for (const e of this.live) if (e.on && e.dying === 0 && e.kind === kind) n++;
    return n;
  }

  private spawn(s: Spawn) {
    let kind = s.kind;
    // On-screen caps depend on play, so they substitute a plain bug rather
    // than altering the seeded schedule.
    if (kind === 'golden' && this.onScreen('golden') >= GAME.maxGoldenOnScreen) kind = 'bug';
    if (kind === 'feature' && this.onScreen('feature') >= GAME.maxFeaturesOnScreen) kind = 'bug';
    const e = this.entities.find((x) => !x.on);
    if (!e) return;
    const lines = Math.max(1, Math.floor((this.h - HUD_H - 16) / LINE_H));
    const fieldH = this.h - HUD_H;
    const across = (m: number) => m + s.pos * (this.w - 2 * m);
    e.on = true;
    e.kind = kind;
    switch (s.edge) {
      case 'left': // crawls out of a code line
        e.x = GUTTER - 6;
        e.y = HUD_H + 8 + (Math.floor(s.pos * lines) + 0.5) * LINE_H;
        e.base = 0;
        break;
      case 'right':
        e.x = this.w + 14;
        e.y = HUD_H + 24 + s.pos * (fieldH - 48);
        e.base = Math.PI;
        break;
      case 'top': // drops out from under the HUD bar
        e.x = across(GUTTER + 16);
        e.y = HUD_H - 10;
        e.base = Math.PI / 2;
        break;
      case 'bottom':
        e.x = across(GUTTER + 16);
        e.y = this.h + 14;
        e.base = -Math.PI / 2;
        break;
    }
    const vertical = s.edge === 'top' || s.edge === 'bottom';
    e.axis = vertical ? fieldH * GAME.verticalAxis : this.w;
    e.heading = e.base + s.heading;
    e.turn = 0;
    e.speed = s.speed;
    e.age = 0;
    e.dying = 0;
    e.vx = 0;
    e.vy = 0;
    e.flash = 0;
    e.entered = false;
    e.hp = kind === 'bug' && s.armored ? 2 : 1;
    if (e.hp > 1 && !this.armorShown) {
      this.armorShown = true;
      this.floater(Math.min(this.w - 70, Math.max(70, e.x)), Math.min(this.h - 40, Math.max(HUD_H + 30, e.y)), '🛡 armored: 2 taps', '#c9d1d9', 13);
    }
    this.live.push(e);
  }

  // ------------------------------------------------------------ input

  private onPointer = (ev: PointerEvent) => {
    ev.preventDefault();
    this.sfx.unlock();
    if (this.paused) {
      this.paused = false;
      this.lastTs = 0;
      return;
    }
    if (this.state !== 'playing') return;
    this.taps++;
    const x = ev.clientX - this.rectX;
    const y = ev.clientY - this.rectY;

    // topmost (most recently spawned) live entity within the hit radius
    let hit: Entity | null = null;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      if (!e.on || e.dying > 0) continue;
      const dx = x - e.x;
      const dy = y - e.y;
      const inside = e.kind === 'feature'
        ? Math.abs(dx) <= FEAT_W / 2 + 6 && Math.abs(dy) <= GAME.hitRadius
        : dx * dx + dy * dy <= GAME.hitRadius * GAME.hitRadius;
      if (inside) { hit = e; break; } // live[] is in spawn order, so the first match from the end is topmost
    }
    if (hit) this.squash(hit);

    // Near misses spook nearby bugs into jinking away (stronger later in the round).
    const evade = this.evade();
    const r2 = GAME.dodgeRadius * GAME.dodgeRadius;
    for (const e of this.live) {
      if (!e.on || e.dying > 0 || e === hit || e.kind === 'feature') continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const chance = e.kind === 'golden' ? 1 : GAME.dodgeChance * evade;
      if (Math.random() >= chance) continue;
      const d = Math.sqrt(d2) || 1;
      const k = GAME.dodgeSpeed * (0.6 + 0.4 * (1 - d / GAME.dodgeRadius));
      e.vx += (dx / d) * k;
      e.vy += (dy / d) * k;
    }
  };

  /** 0 → 1: how evasive bugs are right now. */
  private evade(): number {
    return Math.max(0, Math.min(1, (this.time - GAME.evadeFrom) / (GAME.seconds - GAME.evadeFrom)));
  }

  private squash(e: Entity) {
    if (e.hp > 1) {
      // armored: first tap cracks the shell and knocks it back
      e.hp--;
      e.flash = 0.14;
      this.scorer.crack(this.time);
      const a = e.heading + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
      e.vx += Math.cos(a) * GAME.dodgeSpeed * 0.7;
      e.vy += Math.sin(a) * GAME.dodgeSpeed * 0.7;
      this.burst(e.x, e.y, '#c9d1d9', 5, 26);
      this.floater(e.x, e.y - 16, 'crack!', '#c9d1d9', 14);
      buzz(6);
      this.sfx.play('squash');
      return;
    }
    e.dying = 0.0001;
    const pts = this.scorer.hit(e.kind, this.time);
    if (e.kind === 'feature') {
      this.shake = 1;
      this.lastMul = 1;
      this.burst(e.x, e.y, C.green, 8, 46);
      this.floater(e.x, e.y - 18, 'Regression! −3', C.red, 17);
      buzz([30, 30, 30]);
      this.sfx.play('regress');
    } else if (e.kind === 'golden') {
      this.burst(e.x, e.y, C.gold, 12, 60);
      this.floater(e.x, e.y - 20, 'CRITICAL FIX +5', C.gold, 18);
      buzz(10);
      this.sfx.play('golden');
    } else {
      this.burst(e.x, e.y, '#ff7b72', 5, 34);
      const mul = this.scorer.multiplier;
      this.floater(e.x, e.y - 16, mul > 1 ? `+${pts} ×${mul}` : `+${pts}`, mul === 3 ? C.purple : mul === 2 ? '#ffa657' : C.hud, 15 + mul * 2);
      buzz(10);
      this.sfx.play('squash');
    }
    if (this.scorer.multiplier > this.lastMul) {
      this.comboPop = 1;
      this.lastMul = this.scorer.multiplier;
    }
  }

  // ------------------------------------------------------------ fx helpers

  private burst(x: number, y: number, color: string, n: number, ringR: number) {
    const r = this.rings.find((q) => !q.on);
    if (r) Object.assign(r, { on: true, x, y, life: 0, max: GAME.splatMs / 1000, r0: 6, r1: ringR, color });
    for (let i = 0; i < n; i++) {
      const p = this.particles.find((q) => !q.on);
      if (!p) break;
      const a = Math.random() * Math.PI * 2;
      const s = 70 + Math.random() * 120;
      p.on = true; p.x = x; p.y = y; p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s;
      p.life = 0; p.max = 0.35 + Math.random() * 0.15; p.color = color; p.size = 2 + Math.random() * 2.5;
    }
  }

  private puff(x: number, y: number, color: string, text: string) {
    const r = this.rings.find((q) => !q.on);
    if (r) Object.assign(r, { on: true, x, y, life: 0, max: 0.35, r0: 4, r1: 18, color });
    this.floater(x - 10, y - 8, text, color, 11);
  }

  private floater(x: number, y: number, text: string, color: string, size: number) {
    const f = this.floaters.find((q) => !q.on) ?? this.floaters[0];
    f.on = true; f.x = x; f.y = y; f.life = 0; f.max = 0.75; f.text = text; f.color = color; f.size = size;
  }

  // ------------------------------------------------------------ render

  private render() {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.bg, 0, 0);

    const sx = this.shake > 0 ? (Math.random() * 2 - 1) * 9 * this.shake : 0;
    const sy = this.shake > 0 ? (Math.random() * 2 - 1) * 7 * this.shake : 0;
    const t = performance.now() / 1000;

    // rings
    for (const r of this.rings) {
      if (!r.on) continue;
      const p = r.life / r.max;
      ctx.setTransform(dpr, 0, 0, dpr, (r.x + sx) * dpr, (r.y + sy) * dpr);
      ctx.globalAlpha = (1 - p) * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * (1 - p) + 1;
      ctx.beginPath();
      ctx.arc(0, 0, r.r0 + (r.r1 - r.r0) * (1 - (1 - p) * (1 - p)), 0, Math.PI * 2);
      ctx.stroke();
    }

    // entities
    const half = SPRITE / 2;
    for (const e of this.live) {
      if (!e.on) continue;
      const x = e.x + sx;
      const y = e.y + sy;
      if (e.kind === 'feature') {
        const bob = e.dying > 0 ? 0 : Math.sin(e.age * 5) * 2;
        const p = e.dying > 0 ? e.dying / (GAME.splatMs / 1000) : 0;
        ctx.setTransform(dpr * (1 + p * 0.3), 0, 0, dpr * (1 - p * 0.6), x * dpr, (y + bob) * dpr);
        ctx.globalAlpha = 1 - p;
        ctx.drawImage(this.sprites.feat, -FEAT_W / 2 - 2, -FEAT_H / 2 - 2, FEAT_W + 4, FEAT_H + 4);
        continue;
      }
      const golden = e.kind === 'golden';
      const frames = golden ? this.sprites.gold : e.hp > 1 ? this.sprites.armor : this.sprites.bug;
      const frame = frames[Math.floor(e.age * (golden ? 22 : 14)) & 1];
      const cos = Math.cos(e.heading);
      const sin = Math.sin(e.heading);
      let ax = 1;
      let ay = 1;
      if (e.dying > 0) {
        const p = e.dying / (GAME.splatMs / 1000);
        ax = 1.35;
        ay = 0.35;
        ctx.globalAlpha = 1 - p;
      } else {
        ctx.globalAlpha = 1;
        if (golden) {
          const pulse = 1 + Math.sin(t * 14) * 0.08;
          ax = ay = pulse * 1.1;
          const fade = Math.min(1, (GAME.goldenLifetime - e.age) / 0.25);
          ctx.globalAlpha = Math.max(0, fade);
          ctx.setTransform(dpr * 1.5, 0, 0, dpr * 1.5, x * dpr, y * dpr);
          const ga = ctx.globalAlpha;
          ctx.globalAlpha = ga * (0.35 + 0.3 * Math.sin(t * 10));
          ctx.drawImage(this.sprites.glow, -half, -half, SPRITE, SPRITE);
          ctx.globalAlpha = ga;
        }
      }
      ctx.setTransform(dpr * cos * ax, dpr * sin * ax, -dpr * sin * ay, dpr * cos * ay, x * dpr, y * dpr);
      ctx.drawImage(frame, -half, -half, SPRITE, SPRITE);
      if (e.flash > 0) {
        ctx.globalAlpha = Math.min(1, e.flash / 0.14);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // particles
    for (const p of this.particles) {
      if (!p.on) continue;
      ctx.setTransform(dpr, 0, 0, dpr, (p.x + sx) * dpr, (p.y + sy) * dpr);
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    }

    // floaters
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floaters) {
      if (!f.on) continue;
      ctx.globalAlpha = 1 - (f.life / f.max) ** 2;
      ctx.font = `bold ${f.size}px ${FONT}`;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, Math.min(w - 50, Math.max(50, f.x)), f.y);
    }
    ctx.globalAlpha = 1;

    this.renderHud(t);
    this.renderOverlay(t);
    if (this.showFps) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = C.green;
      ctx.fillText(this.fps.shown, 6, h - 10);
    }
  }

  private renderHud(t: number) {
    const { ctx, dpr, w } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(13,17,23,0.88)';
    ctx.fillRect(0, 0, w, HUD_H);
    ctx.fillStyle = '#21262d';
    ctx.fillRect(0, HUD_H - 1, w, 1);

    // timer
    const left = Math.max(0, GAME.seconds - this.time);
    const tenths = Math.ceil(left * 10);
    if (tenths !== this.timerTenths) {
      this.timerTenths = tenths;
      this.timerText = (tenths / 10).toFixed(1);
    }
    const hurry = this.state === 'playing' && left <= GAME.redTimerAt;
    const pulse = hurry ? 1 + 0.12 * Math.max(0, Math.sin(t * Math.PI * 4)) : 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.dim;
    ctx.font = `11px ${FONT}`;
    ctx.fillText('ci timeout', 14, 16);
    ctx.save();
    ctx.translate(14, 38);
    ctx.scale(pulse, pulse);
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillStyle = hurry ? C.red : C.hud;
    ctx.fillText(`${this.timerText}s`, 0, 0);
    ctx.restore();

    // score
    ctx.textAlign = 'center';
    ctx.fillStyle = C.dim;
    ctx.font = `11px ${FONT}`;
    ctx.fillText('bugs fixed', w / 2, 16);
    ctx.font = `bold 24px ${FONT}`;
    ctx.fillStyle = C.hud;
    ctx.fillText(String(this.scorer.score), w / 2, 38);

    // combo (right side, leaves room for the mute button above it in the page)
    const combo = this.scorer.combo;
    const mul = this.scorer.multiplier;
    if (combo >= 2) {
      const pop = 1 + this.comboPop * 0.45;
      const color = mul === 3 ? C.purple : mul === 2 ? '#ffa657' : C.green;
      ctx.save();
      ctx.translate(w - 62, 34);
      ctx.scale(pop, pop);
      ctx.textAlign = 'right';
      ctx.font = `bold ${mul > 1 ? 24 : 18}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(`×${mul}`, 0, 0);
      ctx.restore();
      ctx.textAlign = 'right';
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(`combo ${combo}`, w - 62, 52 - 1);
      // window bar: how long until the combo drops
      const remain = Math.max(0, 1 - (this.time - this.scorer.lastHit) / GAME.comboWindow);
      ctx.fillRect(0, HUD_H - 3, w * remain, 3);
    }
  }

  private renderOverlay(t: number) {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.paused) {
      ctx.fillStyle = 'rgba(1,4,9,0.72)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = C.hud;
      ctx.font = `bold 28px ${FONT}`;
      ctx.fillText('Paused', w / 2, h / 2 - 14);
      ctx.font = `14px ${FONT}`;
      ctx.fillStyle = C.dim;
      ctx.fillText('tap to resume', w / 2, h / 2 + 18);
      return;
    }
    if (this.state === 'countdown') {
      ctx.fillStyle = 'rgba(1,4,9,0.55)';
      ctx.fillRect(0, HUD_H, w, h - HUD_H);
      const n = Math.ceil(this.countdown - 0.45);
      const frac = (this.countdown - 0.45) % 1;
      const label = n >= 1 ? String(n) : 'go fix it!';
      const s = n >= 1 ? 1 + Math.max(0, frac) * 0.5 : 1;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(s, s);
      ctx.globalAlpha = n >= 1 ? 0.4 + 0.6 * (1 - Math.max(0, frac)) : 1;
      ctx.fillStyle = n >= 1 ? C.hud : C.green;
      ctx.font = `bold ${n >= 1 ? 84 : 34}px ${FONT}`;
      ctx.fillText(label, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = C.dim;
      ctx.fillText('tap bugs · avoid ✓ feat · chain combos', w / 2, h / 2 + 80);
      ctx.fillText('they get faster and sneakier', w / 2, h / 2 + 100);
      return;
    }
    if (this.state === 'ending') {
      const p = 1 - this.endTimer / GAME.endFreezeMs;
      ctx.fillStyle = `rgba(1,4,9,${0.2 + p * 0.5})`;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = C.green;
      ctx.font = `bold 30px ${FONT}`;
      ctx.globalAlpha = Math.min(1, p * 3);
      ctx.fillText('Build complete', w / 2, h / 2);
      ctx.globalAlpha = 1;
      void t;
    }
  }

  // ------------------------------------------------------------ misc

  private finish() {
    this.state = 'done';
    const s = this.scorer;
    const r: RunResult = {
      ...s.tally,
      seed: this.opts!.seed,
      bugs: s.bugs,
      max_combo: s.maxCombo,
      taps: this.taps,
      score: s.score,
      escaped: this.escaped,
      wall_ms: Math.round(performance.now() - this.wallStart),
    };
    this.opts!.onEnd(r);
  }

  private onVisibility = () => {
    if (document.hidden && (this.state === 'playing' || this.state === 'countdown')) {
      this.paused = true;
      this.render();
    }
  };

  private trackFps(raw: number) {
    const f = this.fps;
    f.frames++;
    f.acc += raw;
    if (raw > f.worst) f.worst = raw;
    if (f.acc >= 1) {
      f.shown = `${Math.round(f.frames / f.acc)} fps · worst ${Math.round(f.worst * 1000)}ms`;
      f.frames = 0; f.acc = 0; f.worst = 0;
    }
  }

  private resize = () => {
    const vv = window.visualViewport;
    // Cap the playfield width so desktop plays like a phone (one leaderboard, mixed devices).
    const w = Math.min(MAX_W, Math.round(vv ? vv.width : window.innerWidth));
    const h = Math.round(vv ? vv.height : window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, GAME.maxDpr);
    const rect = () => {
      const r = this.canvas.getBoundingClientRect();
      this.rectX = r.left;
      this.rectY = r.top;
    };
    if (w === this.w && h === this.h && dpr === this.dpr && this.bg) return rect();
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    rect();
    this.buildBackground();
    this.sprites = {
      bug: [0, 1].map((p) => bugSprite(dpr, '#f85149', '#8e1519', '#5c0f12', p)),
      armor: [0, 1].map((p) => armorPlate(bugSprite(dpr, '#b62324', '#5c0f12', '#3d0a0c', p), dpr)),
      gold: [0, 1].map((p) => bugSprite(dpr, C.gold, '#9a6b00', '#6b4a00', p)),
      glow: glowSprite(dpr),
      feat: featureSprite(dpr),
    };
    for (const e of this.live) e.y = Math.min(e.y, h - 10);
    if (this.state === 'done' || this.paused) this.render();
  };

  private buildBackground() {
    const { w, h, dpr } = this;
    const [c, x] = offscreen(w, h, dpr);
    x.fillStyle = C.bg;
    x.fillRect(0, 0, w, h);
    x.fillStyle = C.gutter;
    x.fillRect(0, 0, GUTTER, h);
    x.font = `12px ${FONT}`;
    x.textBaseline = 'middle';
    const lines = Math.ceil((h - HUD_H) / LINE_H) + 1;
    for (let i = 0; i < lines; i++) {
      const y = HUD_H + 8 + (i + 0.5) * LINE_H;
      x.globalAlpha = 1;
      x.textAlign = 'right';
      x.fillStyle = C.lineNo;
      x.fillText(String(i + 1), GUTTER - 8, y);
      x.textAlign = 'left';
      x.globalAlpha = 0.32;
      drawCodeLine(x, CODE[i % CODE.length], GUTTER + 10, y);
    }
    this.bg = c;
  }
}
