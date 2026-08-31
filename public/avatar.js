// Living agent avatars.
//
// Each adversary gets a small WebGL entity that behaves rather than sits there:
// a wireframe shell around a glowing core, breathing while idle, spinning up
// while it works, flaring when it lands a hit, and going cold when repelled.
//
// One shared animation loop drives every avatar. Geometry is seeded from the
// agent id, so each one is recognisably itself every time you load the page.

import * as THREE from './vendor/three.module.min.js';

const AVATARS = new Set();
const STAGES = new Set();
const FIELDS = new Set();
let looping = false;

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const SHELLS = [
  (r) => new THREE.IcosahedronGeometry(r, 0),
  (r) => new THREE.OctahedronGeometry(r, 0),
  (r) => new THREE.DodecahedronGeometry(r, 0),
  (r) => new THREE.TetrahedronGeometry(r, 0),
  (r) => new THREE.IcosahedronGeometry(r, 1),
];

const STATES = {
  idle:      { spin: 0.22, pulse: 0.05, core: 0.30, shell: 0.55, wobble: 0.10 },
  awake:     { spin: 0.55, pulse: 0.09, core: 0.52, shell: 0.78, wobble: 0.22 },
  hover:     { spin: 1.15, pulse: 0.14, core: 0.78, shell: 0.95, wobble: 0.40 },
  working:   { spin: 1.35, pulse: 0.16, core: 0.85, shell: 1.00, wobble: 0.45 },
  landed:    { spin: 2.40, pulse: 0.30, core: 1.60, shell: 1.00, wobble: 0.80 },
  repelled:  { spin: 0.10, pulse: 0.02, core: 0.10, shell: 0.22, wobble: 0.03 },
};

export class Avatar {
  constructor(canvas, { color = '#ffffff', seed = 'x', size = 76 } = {}) {
    this.canvas = canvas;
    this.color = new THREE.Color(color);
    this.state = 'idle';
    this.t = Math.random() * 100;
    this.energy = 0;      // eased toward the target state
    this.flare = 0;       // decaying spike when a hit lands

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(size, size, false);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.z = 4.2;

    const h = hash(seed);

    // outer shell - the recognisable silhouette
    this.shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(SHELLS[h % SHELLS.length](1.35)),
      new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.55 }),
    );
    this.scene.add(this.shell);

    // inner core - the "eye". Brightness is how hard it is working.
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.42, 2),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.3 }),
    );
    this.scene.add(this.core);

    // halo - only really visible when it lands a hit
    this.halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 20, 20),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0 }),
    );
    this.scene.add(this.halo);

    this.axis = new THREE.Vector3(
      ((h >> 3) % 10) / 20 + 0.15,
      1,
      ((h >> 7) % 10) / 20 - 0.25,
    ).normalize();

    AVATARS.add(this);
    startLoop();
  }

  set(state) {
    if (state === this.state) return;
    if (state === 'landed') this.flare = 1;
    this.state = state;
  }

  step(dt) {
    const s = STATES[this.state] || STATES.idle;
    this.t += dt;

    // ease toward the state's energy so transitions feel physical, not switched
    this.energy += (s.spin - this.energy) * Math.min(dt * 3.5, 1);
    this.flare = Math.max(0, this.flare - dt * 1.6);

    this.shell.rotateOnAxis(this.axis, this.energy * dt);
    this.shell.material.opacity += (s.shell - this.shell.material.opacity) * Math.min(dt * 4, 1);

    const breathe = 1 + Math.sin(this.t * (1.4 + this.energy)) * s.pulse;
    const flareScale = 1 + this.flare * 0.55;
    this.core.scale.setScalar(breathe * flareScale);
    this.shell.scale.setScalar(1 + (breathe - 1) * 0.35 + this.flare * 0.18);

    const coreTarget = Math.min(1, s.core + this.flare * 0.6);
    this.core.material.opacity += (coreTarget - this.core.material.opacity) * Math.min(dt * 4, 1);

    this.halo.material.opacity = this.flare * 0.22;
    this.halo.scale.setScalar(1 + this.flare * 1.3);

    // a slight tumble so it never looks like a spinning logo
    this.core.rotation.y += dt * s.wobble;
    this.core.rotation.x = Math.sin(this.t * 0.7) * s.wobble * 0.4;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    AVATARS.delete(this);
    this.shell.geometry.dispose();
    this.core.geometry.dispose();
    this.halo.geometry.dispose();
    this.renderer.dispose();
  }
}

export function disposeAll() {
  for (const a of [...AVATARS]) a.dispose();
}

let last = 0;
function startLoop() {
  if (looping) return;
  looping = true;
  const tick = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05) || 0.016;
    last = now;
    for (const a of AVATARS) a.step(dt);
    for (const st of STAGES) st.step(dt);
    for (const f of FIELDS) f.step(dt);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** WebGL can be unavailable (older machines, some remote desktops). Fail soft. */
// ── Shared stage: many avatars, ONE WebGL context ────────────────────────────
// A browser allows roughly 16 live WebGL contexts. Fourteen roster icons plus
// the ones on the attack stage would sit right on that ceiling and start
// dropping contexts. So the roster uses the three.js multiple-views pattern
// instead: a single renderer, one canvas, and a scissored viewport per item.

export class SharedStage {
  constructor(container, clipEl){
    this.container = container;
    // Draw coordinates are relative to `container`, but visibility is tested
    // against `clipEl` - otherwise items scrolled out of a scrolling list keep
    // painting over the rest of the panel.
    this.clipEl = clipEl || container;
    this.items = [];
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position:'absolute', inset:'0', width:'100%', height:'100%', pointerEvents:'none', zIndex:'6',
    });
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas:this.canvas, alpha:true, antialias:true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setScissorTest(true);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.z = 4.2;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.drawn = 0;
    this.resize();
    STAGES.add(this);
    startLoop();
  }

  resize(){
    const r = this.container.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(r.width));
    this.h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(this.w, this.h, false);
  }

  /**
   * anchor  = the element whose box this avatar is drawn into
   * hoverEl = what you actually point at (a whole row, not a 34px icon)
   */
  add(anchor, { color = '#fff', seed = 'x', hoverEl = null } = {}){
    const scene = new THREE.Scene();
    const c = new THREE.Color(color);
    const h = hash(seed);

    const shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(SHELLS[h % SHELLS.length](1.35)),
      new THREE.LineBasicMaterial({ color:c, transparent:true, opacity:0.55 }));
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.40, 2),
      new THREE.MeshBasicMaterial({ color:c, transparent:true, opacity:0.32 }));
    scene.add(shell); scene.add(core);

    const item = {
      anchor, scene, shell, core,
      base:'idle',        // what it does at rest - lifts to 'awake' when selected
      hovering:false,
      get state(){ return this.hovering ? 'hover' : this.base; },
      t: Math.random()*100, energy:0, flare:0,
      axis: new THREE.Vector3(((h>>3)%10)/20+0.15, 1, ((h>>7)%10)/20-0.25).normalize(),
      setSelected(on){ this.base = on ? 'awake' : 'idle'; },
    };
    // Point at the whole row, not the icon - a 34px hover target is a miss.
    const hot = hoverEl || anchor;
    hot.addEventListener('pointerenter', () => { item.hovering = true; });
    hot.addEventListener('pointerleave', () => { item.hovering = false; });
    this.items.push(item);
    return item;
  }

  step(dt){
    if (!this.items.length) return;
    const box = this.container.getBoundingClientRect();
    const clip = this.clipEl.getBoundingClientRect();
    if (Math.round(box.width) !== this.w || Math.round(box.height) !== this.h) this.resize();

    for (const it of this.items){
      const r = it.anchor.getBoundingClientRect();
      const x = Math.floor(r.left - box.left);
      const yFromBottom = Math.floor(box.bottom - r.bottom);
      const w = Math.floor(r.width), hh = Math.floor(r.height);
      if (!w || !hh) continue;
      // skip anything scrolled out of the visible list
      if (r.bottom < clip.top + 2 || r.top > clip.bottom - 2) continue;

      const s = STATES[it.state] || STATES.idle;
      it.t += dt;
      it.energy += (s.spin - it.energy) * Math.min(dt*3.5, 1);
      it.flare = Math.max(0, it.flare - dt*1.6);

      it.shell.rotateOnAxis(it.axis, it.energy * dt);
      it.shell.material.opacity += (s.shell - it.shell.material.opacity) * Math.min(dt*4, 1);
      const breathe = 1 + Math.sin(it.t * (1.4 + it.energy)) * s.pulse;
      it.core.scale.setScalar(breathe * (1 + it.flare*0.5));
      it.core.material.opacity += (Math.min(1, s.core + it.flare*0.6) - it.core.material.opacity) * Math.min(dt*4, 1);
      it.core.rotation.y += dt * s.wobble;

      this.renderer.setViewport(x, yFromBottom, w, hh);
      this.renderer.setScissor(x, yFromBottom, w, hh);
      this.renderer.render(it.scene, this.camera);
      this.drawn++;
    }
  }

  dispose(){
    window.removeEventListener('resize', this._onResize);
    for (const it of this.items){ it.shell.geometry.dispose(); it.core.geometry.dispose(); }
    this.items = [];
    this.renderer.dispose();
    this.canvas.remove();
    STAGES.delete(this);
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// ── Ambient field ────────────────────────────────────────────────────────────
// A slow drift of very faint wireframe forms behind the whole page. Deliberately
// under-stated: same geometric language as the agents, at a fraction of the
// contrast, so it reads as texture rather than decoration. Anything livelier
// competes with the transcripts, which are the actual content.

export class AmbientField {
  constructor({ colors = ['#C8613F'], count = 9, opacity = 0.07 } = {}) {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position:'fixed', inset:'0', width:'100%', height:'100%',
      pointerEvents:'none', zIndex:'0',
    });
    document.body.prepend(this.canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas:this.canvas, alpha:true, antialias:true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.z = 26;

    this.shapes = [];
    for (let i = 0; i < count; i++) {
      const c = new THREE.Color(colors[i % colors.length]);
      const geo = SHELLS[i % SHELLS.length](2.4 + (i % 4) * 1.5);
      const m = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color:c, transparent:true, opacity }),
      );
      m.position.set((i % 5 - 2) * 11 + (i % 3), ((i * 7) % 5 - 2) * 8, -6 - (i % 5) * 5);
      m.userData = {
        spin: 0.02 + (i % 5) * 0.012,
        axis: new THREE.Vector3((i % 3) / 3 + 0.2, 1, (i % 4) / 4 - 0.3).normalize(),
        driftY: ((i % 2) ? 1 : -1) * (0.12 + (i % 3) * 0.05),
      };
      this.scene.add(m); this.shapes.push(m);
      geo.dispose();
    }

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    FIELDS.add(this);
    startLoop();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  step(dt) {
    for (const m of this.shapes) {
      m.rotateOnAxis(m.userData.axis, m.userData.spin * dt);
      m.position.y += m.userData.driftY * dt;
      if (m.position.y > 22) m.position.y = -22;
      if (m.position.y < -22) m.position.y = 22;
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    for (const m of this.shapes) m.geometry.dispose();
    this.renderer.dispose(); this.canvas.remove(); FIELDS.delete(this);
  }
}
