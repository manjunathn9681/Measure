/**
 * Measure WebAR — app.js
 * Production-ready WebAR measuring app using Three.js + WebXR hit-testing.
 * Falls back to a raycasting demo mode on desktop/non-AR browsers.
 *
 * Architecture:
 *  - MeasureApp  : orchestrator, lifecycle, WebXR session
 *  - SceneManager: Three.js scene, renderer, camera
 *  - ReticleManager: hit-test reticle placement
 *  - MeasurementManager: points, lines, distance labels
 *  - HUDManager  : UI state machine
 *  - DemoMode    : desktop mouse-click fallback
 */

import * as THREE from 'three';
import { XRButton } from 'three/addons/webxr/XRButton.js';

/* ══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════════════════════════ */
const CM_PER_METER  = 100;
const IN_PER_METER  = 39.3701;
const RETICLE_SCALE = 0.08;          // metres radius
const PIN_RADIUS    = 0.008;         // 8 mm radius sphere
const LINE_SEGMENTS = 64;
const LABEL_CANVAS_W = 512;
const LABEL_CANVAS_H = 128;
const MAX_MEASUREMENTS = 20;         // keep history bounded

/* ══════════════════════════════════════════════════════════════════════════
   UTILITY HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

/** Euclidean 3D distance in metres */
function dist3D(a, b) {
  return Math.sqrt(
    Math.pow(b.x - a.x, 2) +
    Math.pow(b.y - a.y, 2) +
    Math.pow(b.z - a.z, 2)
  );
}

/** Format a distance in metres into { cm, inches, label } */
function formatDistance(metres) {
  const cm     = metres * CM_PER_METER;
  const inches = metres * IN_PER_METER;
  const feet   = Math.floor(inches / 12);
  const inRem  = inches % 12;
  return {
    cm:     cm.toFixed(1),
    inches: inches.toFixed(1),
    ft:     feet,
    inRem:  inRem.toFixed(1),
    label:  cm >= 100
      ? `${(cm / 100).toFixed(2)} m`
      : `${cm.toFixed(1)} cm`,
    labelIn: feet > 0
      ? `${feet}′ ${inRem.toFixed(0)}″`
      : `${inches.toFixed(1)}″`,
  };
}

/** Show a temporary toast notification */
function showToast(msg, duration = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

/* ══════════════════════════════════════════════════════════════════════════
   SCENE MANAGER
   ══════════════════════════════════════════════════════════════════════════ */
class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;

    /* Renderer */
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    /* Scene */
    this.scene = new THREE.Scene();

    /* Camera */
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.01, 100
    );

    /* Lights */
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const point   = new THREE.PointLight(0xffffff, 1.8, 8);
    point.position.set(0, 2, 1);
    this.scene.add(ambient, point);

    /* Resize */
    window.addEventListener('resize', this._onResize.bind(this));
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  dispose() {
    window.removeEventListener('resize', this._onResize.bind(this));
    this.renderer.dispose();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   RETICLE MANAGER
   Renders the floating surface-snapping reticle ring + surface normal plane.
   ══════════════════════════════════════════════════════════════════════════ */
class ReticleManager {
  constructor(scene) {
    this.scene = scene;
    this.visible = false;
    this.position = new THREE.Vector3();
    this.matrix = new THREE.Matrix4();

    this._buildGeometry();
  }

  _buildGeometry() {
    /* Outer ring */
    const ringGeo = new THREE.RingGeometry(
      RETICLE_SCALE * 0.7, RETICLE_SCALE, 36
    );
    ringGeo.rotateX(-Math.PI / 2);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.90,
      depthTest: false,
    });

    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.visible = false;
    this.ring.renderOrder = 999;
    this.scene.add(this.ring);

    /* Inner dot */
    const dotGeo = new THREE.CircleGeometry(RETICLE_SCALE * 0.1, 24);
    dotGeo.rotateX(-Math.PI / 2);

    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xff6b35,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });

    this.dot = new THREE.Mesh(dotGeo, dotMat);
    this.dot.renderOrder = 1000;
    this.ring.add(this.dot);

    /* Cross-hair lines */
    const lineGeo = new THREE.BufferGeometry();
    const hs = RETICLE_SCALE * 1.2;
    lineGeo.setFromPoints([
      new THREE.Vector3(-hs, 0, 0), new THREE.Vector3(-RETICLE_SCALE * 0.8, 0, 0),
      new THREE.Vector3( RETICLE_SCALE * 0.8, 0, 0), new THREE.Vector3(hs, 0, 0),
      new THREE.Vector3(0, 0, -hs), new THREE.Vector3(0, 0, -RETICLE_SCALE * 0.8),
      new THREE.Vector3(0, 0,  RETICLE_SCALE * 0.8), new THREE.Vector3(0, 0, hs),
    ]);

    const lineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
    });

    this.crosshair = new THREE.LineSegments(lineGeo, lineMat);
    this.crosshair.renderOrder = 998;
    this.ring.add(this.crosshair);
  }

  /** Update reticle from a WebXR hit-test result pose matrix */
  updateFromHitMatrix(hitMatrix) {
    this.matrix.fromArray(hitMatrix.elements ?? hitMatrix);
    this.ring.visible = true;
    this.ring.matrix.fromArray(hitMatrix.elements ?? hitMatrix);
    this.ring.matrixAutoUpdate = false;

    // Extract world position
    this.position.setFromMatrixPosition(this.ring.matrix);
    this.visible = true;
  }

  /** Update reticle from a plain Vector3 (demo mode) */
  updateFromPosition(pos) {
    this.ring.visible = true;
    this.ring.matrixAutoUpdate = true;
    this.ring.position.copy(pos);
    this.position.copy(pos);
    this.visible = true;
  }

  hide() {
    this.ring.visible = false;
    this.visible = false;
  }

  /** Animate the reticle (bob + rotate) */
  animate(t) {
    if (!this.ring.visible) return;
    this.dot.material.opacity = 0.7 + 0.3 * Math.sin(t * 3);
    this.crosshair.material.opacity = 0.3 + 0.2 * Math.abs(Math.sin(t * 2));
  }

  getCurrentPosition() {
    return this.position.clone();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   MEASUREMENT MANAGER
   Handles points, connecting lines, and distance label sprites.
   ══════════════════════════════════════════════════════════════════════════ */
class MeasurementManager {
  constructor(scene) {
    this.scene  = scene;
    this.points = [];     // Array<THREE.Vector3>
    this.history = [];    // Array<{cm, in, label, labelIn}>

    /* Materials (shared) */
    this._pinMat = new THREE.MeshStandardMaterial({
      color: 0xff6b35,
      metalness: 0.1,
      roughness: 0.3,
      emissive: 0xff3b20,
      emissiveIntensity: 0.3,
    });

    this._lineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 2,
      transparent: true,
      opacity: 0.85,
    });

    /* Groups for easy clearing */
    this._pinGroup   = new THREE.Group();
    this._lineGroup  = new THREE.Group();
    this._labelGroup = new THREE.Group();
    scene.add(this._pinGroup, this._lineGroup, this._labelGroup);

    /* Active measurement objects */
    this._activePin0   = null;
    this._activePin1   = null;
    this._activeLine   = null;
    this._activeLabel  = null;
  }

  /** Place a new measurement pin at position */
  placePin(pos) {
    if (this.points.length >= 2) {
      this._commitMeasurement();
    }

    this.points.push(pos.clone());

    const geo  = new THREE.SphereGeometry(PIN_RADIUS, 24, 24);
    const mesh = new THREE.Mesh(geo, this._pinMat.clone());
    mesh.position.copy(pos);

    // Pin glow ring
    const ringGeo = new THREE.RingGeometry(PIN_RADIUS * 1.8, PIN_RADIUS * 2.6, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff6b35, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    mesh.add(ring);

    // Vertical pole
    const poleGeo = new THREE.CylinderGeometry(0.0015, 0.001, 0.04, 8);
    const poleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.6,
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = -0.02;
    mesh.add(pole);

    this._pinGroup.add(mesh);

    if (this.points.length === 1) {
      this._activePin0 = mesh;
    } else {
      this._activePin1 = mesh;
      this._drawLine();
    }

    return pos;
  }

  /** Draw / update the rubber-band line between point[0] and a current position */
  updateRubberBand(current) {
    if (this.points.length !== 1) return;
    this._clearActiveLine();

    const pts = [this.points[0], current];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const dashes  = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.02,
      gapSize: 0.01,
      transparent: true,
      opacity: 0.6,
    });
    this._activeLine = new THREE.Line(lineGeo, dashes);
    this._activeLine.computeLineDistances();
    this._lineGroup.add(this._activeLine);

    // Also update live label
    const d = dist3D(this.points[0], current);
    this._updateActiveLabel(this.points[0], current, d);
  }

  _drawLine() {
    this._clearActiveLine();

    const p0  = this.points[0];
    const p1  = this.points[1];
    const pts = [];

    // Slightly elevated arc line for visual clarity
    const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
    mid.y += 0.015;

    const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
    const curvePoints = curve.getPoints(LINE_SEGMENTS);
    pts.push(...curvePoints);

    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this._activeLine = new THREE.Line(geo, this._lineMat.clone());
    this._lineGroup.add(this._activeLine);

    const d = dist3D(p0, p1);
    this._updateActiveLabel(p0, p1, d);

    return d;
  }

  /** Build / refresh the floating distance label sprite */
  _updateActiveLabel(p0, p1, distMetres) {
    if (this._activeLabel) {
      this._labelGroup.remove(this._activeLabel);
      this._activeLabel.material.map?.dispose();
      this._activeLabel.material.dispose();
      this._activeLabel.geometry.dispose();
      this._activeLabel = null;
    }

    const fmt = formatDistance(distMetres);
    const sprite = this._buildLabelSprite(fmt);

    const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
    mid.y += 0.08; // float above

    sprite.position.copy(mid);
    sprite.scale.set(0.22, 0.055, 1);
    this._activeLabel = sprite;
    this._labelGroup.add(sprite);

    return fmt;
  }

  /** Render distance label onto a canvas and return a Sprite */
  _buildLabelSprite(fmt) {
    const canvas = document.createElement('canvas');
    canvas.width  = LABEL_CANVAS_W;
    canvas.height = LABEL_CANVAS_H;
    const ctx = canvas.getContext('2d');

    // Rounded pill background
    const r = 24;
    ctx.clearRect(0, 0, LABEL_CANVAS_W, LABEL_CANVAS_H);

    // Shadow
    ctx.shadowColor   = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur    = 20;
    ctx.shadowOffsetY = 6;

    ctx.fillStyle = 'rgba(28, 28, 30, 0.88)';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(LABEL_CANVAS_W - r, 0);
    ctx.quadraticCurveTo(LABEL_CANVAS_W, 0, LABEL_CANVAS_W, r);
    ctx.lineTo(LABEL_CANVAS_W, LABEL_CANVAS_H - r);
    ctx.quadraticCurveTo(LABEL_CANVAS_W, LABEL_CANVAS_H, LABEL_CANVAS_W - r, LABEL_CANVAS_H);
    ctx.lineTo(r, LABEL_CANVAS_H);
    ctx.quadraticCurveTo(0, LABEL_CANVAS_H, 0, LABEL_CANVAS_H - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();

    // Border
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Accent left strip
    const grad = ctx.createLinearGradient(0, 0, 0, LABEL_CANVAS_H);
    grad.addColorStop(0, '#FF6B35');
    grad.addColorStop(1, '#FF3B30');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 10, LABEL_CANVAS_H);

    // Primary text: cm
    ctx.fillStyle   = '#FFFFFF';
    ctx.font        = `bold 58px -apple-system, Inter, sans-serif`;
    ctx.textAlign   = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${fmt.cm} cm`, 24, LABEL_CANVAS_H / 2 - 8);

    // Secondary text: inches
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font      = `400 30px -apple-system, Inter, sans-serif`;
    ctx.fillText(`${fmt.inches} in`, 24, LABEL_CANVAS_H / 2 + 30);

    const texture  = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite   = new THREE.Sprite(material);
    sprite.renderOrder = 999;
    return sprite;
  }

  /** Finalise and archive the current 2-point measurement */
  _commitMeasurement() {
    if (this.points.length < 2) return;
    const d = dist3D(this.points[0], this.points[1]);
    const fmt = formatDistance(d);
    if (this.history.length >= MAX_MEASUREMENTS) this.history.shift();
    this.history.push(fmt);

    // Freeze active objects (keep in scene, reset tracking refs)
    this._activePin0  = null;
    this._activePin1  = null;
    this._activeLine  = null;
    this._activeLabel = null;
    this.points = [];
  }

  /** Remove rubber-band line only */
  _clearActiveLine() {
    if (this._activeLine) {
      this._lineGroup.remove(this._activeLine);
      this._activeLine.geometry.dispose();
      this._activeLine.material.dispose();
      this._activeLine = null;
    }
  }

  /** Undo last placed point */
  undo() {
    if (this.points.length === 0 && this.history.length > 0) {
      // pop last committed measurement visuals
      this.history.pop();
      this._removeLastChild(this._pinGroup);
      this._removeLastChild(this._pinGroup);
      this._removeLastChild(this._lineGroup);
      this._removeLastChild(this._labelGroup);
      return 'measurement';
    }

    if (this.points.length === 2) {
      this.points.pop();
      this._removeLastChild(this._pinGroup);
      this._clearActiveLine();
      this._clearActiveLabel();
      return 'point';
    }

    if (this.points.length === 1) {
      this.points = [];
      this._removeLastChild(this._pinGroup);
      this._clearActiveLabel();
      return 'point';
    }

    return 'none';
  }

  _clearActiveLabel() {
    if (this._activeLabel) {
      this._labelGroup.remove(this._activeLabel);
      this._activeLabel.material.map?.dispose();
      this._activeLabel.material.dispose();
      this._activeLabel.geometry.dispose();
      this._activeLabel = null;
    }
  }

  _removeLastChild(group) {
    const child = group.children[group.children.length - 1];
    if (!child) return;
    group.remove(child);
    child.traverse(obj => {
      obj.geometry?.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
  }

  /** Clear everything */
  clearAll() {
    this.points = [];
    this.history = [];
    this._activePin0  = null;
    this._activePin1  = null;
    this._activeLine  = null;
    this._activeLabel = null;

    for (const group of [this._pinGroup, this._lineGroup, this._labelGroup]) {
      while (group.children.length > 0) {
        this._removeLastChild(group);
      }
    }
  }

  /** Get current live distance if 2 points exist */
  getLiveDistance() {
    if (this.points.length === 2) {
      return dist3D(this.points[0], this.points[1]);
    }
    return null;
  }

  getPointCount() { return this.points.length; }
  getHistory()    { return this.history; }
}

/* ══════════════════════════════════════════════════════════════════════════
   HUD MANAGER
   Drives the UI state machine and DOM updates.
   ══════════════════════════════════════════════════════════════════════════ */
class HUDManager {
  constructor(onAddPoint, onClear, onUndo, onClose, onScreenshot) {
    this._onAddPoint   = onAddPoint;
    this._onClear      = onClear;
    this._onUndo       = onUndo;
    this._onClose      = onClose;
    this._onScreenshot = onScreenshot;

    /* DOM refs */
    this._hud             = document.getElementById('hud');
    this._hintBar         = document.getElementById('hint-bar');
    this._hintText        = document.getElementById('hint-text');
    this._hintSpinner     = this._hintBar.querySelector('.hint-spinner');
    this._distPanel       = document.getElementById('distance-panel');
    this._distCm          = document.getElementById('dist-cm');
    this._distIn          = document.getElementById('dist-in');
    this._measureList     = document.getElementById('measurements-list');
    this._measureScroll   = document.getElementById('measurements-scroll');
    this._addPointBtn     = document.getElementById('add-point-btn');
    this._clearBtn        = document.getElementById('clear-btn');
    this._undoBtn         = document.getElementById('undo-btn');
    this._closeBtn        = document.getElementById('close-btn');
    this._screenshotBtn   = document.getElementById('screenshot-btn');

    this._surfaceDetected = false;
    this._itemCount       = 0;

    this._bindEvents();
  }

  _bindEvents() {
    this._addPointBtn.addEventListener('click',   () => this._onAddPoint());
    this._clearBtn.addEventListener('click',      () => { this._onClear(); this._renderHistory([]); });
    this._undoBtn.addEventListener('click',       () => this._onUndo());
    this._closeBtn.addEventListener('click',      () => this._onClose());
    this._screenshotBtn.addEventListener('click', () => this._onScreenshot());
  }

  show()  { this._hud.classList.remove('hidden'); }
  hide()  { this._hud.classList.add('hidden'); }

  /** Update the hint text */
  setHint(text, spinning = true) {
    this._hintText.textContent = text;
    this._hintSpinner.style.display = spinning ? 'block' : 'none';
    this._hintBar.classList.remove('hidden');
  }

  hideHint() { this._hintBar.classList.add('hidden'); }

  /** Called every frame with measurement state */
  update(pointCount, distMetres, history, surfaceDetected) {
    if (surfaceDetected !== this._surfaceDetected) {
      this._surfaceDetected = surfaceDetected;
      if (surfaceDetected) {
        this.setHint('Tap to place a point', false);
        this._addPointBtn.style.opacity = '1';
        this._addPointBtn.style.pointerEvents = 'all';
      } else {
        this.setHint('Move your phone to detect a surface…', true);
        this._addPointBtn.style.opacity = '0.4';
        this._addPointBtn.style.pointerEvents = 'none';
      }
    }

    if (pointCount === 1) {
      this.setHint('Tap to place the second point', false);
    }

    if (distMetres !== null) {
      const fmt = formatDistance(distMetres);
      this._distCm.textContent = `${fmt.cm} cm`;
      this._distIn.textContent = `${fmt.inches}″`;
      this._distPanel.classList.remove('hidden');
      this.hideHint();
    } else if (pointCount === 0) {
      this._distPanel.classList.add('hidden');
      if (surfaceDetected) this.setHint('Tap to place a point', false);
    }

    this._renderHistory(history);
  }

  _renderHistory(history) {
    if (history.length === 0) {
      this._measureList.classList.add('hidden');
      this._measureScroll.innerHTML = '';
      this._itemCount = 0;
      return;
    }

    this._measureList.classList.remove('hidden');

    // Only re-render if count changed
    if (history.length === this._itemCount) return;
    this._itemCount = history.length;

    this._measureScroll.innerHTML = '';
    history.slice().reverse().forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'measurement-item';
      item.style.animationDelay = `${i * 0.04}s`;
      item.innerHTML = `
        <div class="measurement-dot"></div>
        <div>
          <div class="measurement-text">${m.cm} cm</div>
          <div class="measurement-sub">${m.inches} in</div>
        </div>
      `;
      this._measureScroll.appendChild(item);
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   DEMO MODE  (Desktop / non-AR fallback)
   Uses mouse raycasting against a virtual floor plane.
   ══════════════════════════════════════════════════════════════════════════ */
class DemoMode {
  constructor(camera, scene) {
    this._camera   = camera;
    this._scene    = scene;
    this._raycaster = new THREE.Raycaster();
    this._mouse    = new THREE.Vector2(-9999, -9999);
    this._floor    = this._buildFloor();
    this._active   = false;

    this._onMouseMove  = this._onMouseMove.bind(this);
    this._onTouchMove  = this._onTouchMove.bind(this);
  }

  _buildFloor() {
    // Invisible hit plane at y = -0.5 m
    const geo  = new THREE.PlaneGeometry(40, 40);
    const mat  = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.5;
    this._scene.add(mesh);
    return mesh;
  }

  activate() {
    this._active = true;

    // Decorate scene for demo: soft gradient background + subtle grid
    this._scene.background = new THREE.Color(0x1a1a2e);
    this._scene.fog = new THREE.Fog(0x1a1a2e, 8, 20);

    const gridHelper = new THREE.GridHelper(20, 40, 0x333355, 0x222240);
    gridHelper.position.y = -0.5;
    this._scene.add(gridHelper);
    this._grid = gridHelper;

    // Camera position for desktop demo
    this._camera.position.set(0, 1.6, 2);
    this._camera.lookAt(0, -0.2, 0);

    window.addEventListener('mousemove',  this._onMouseMove, { passive: true });
    window.addEventListener('touchmove',  this._onTouchMove, { passive: true });
  }

  deactivate() {
    this._active = false;
    window.removeEventListener('mousemove',  this._onMouseMove);
    window.removeEventListener('touchmove',  this._onTouchMove);
  }

  _onMouseMove(e) {
    this._mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    this._mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  _onTouchMove(e) {
    const t = e.touches[0];
    this._mouse.x =  (t.clientX / window.innerWidth)  * 2 - 1;
    this._mouse.y = -(t.clientY / window.innerHeight) * 2 + 1;
  }

  /** Returns a THREE.Vector3 hit point or null */
  getHitPoint() {
    if (!this._active) return null;
    this._raycaster.setFromCamera(this._mouse, this._camera);
    const hits = this._raycaster.intersectObject(this._floor);
    return hits.length > 0 ? hits[0].point : null;
  }

  isActive() { return this._active; }
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN APP
   ══════════════════════════════════════════════════════════════════════════ */
class MeasureApp {
  constructor() {
    this._canvas      = document.getElementById('ar-canvas');
    this._scene       = new SceneManager(this._canvas);
    this._reticle     = new ReticleManager(this._scene.scene);
    this._measurements = new MeasurementManager(this._scene.scene);
    this._demoMode    = new DemoMode(this._scene.camera, this._scene.scene);

    this._xrSession   = null;
    this._hitTestSrc  = null;
    this._isAR        = false;
    this._clock       = new THREE.Clock();

    this._hud = new HUDManager(
      () => this._addPoint(),
      () => this._clearAll(),
      () => this._undo(),
      () => this._exitAR(),
      () => this._screenshot()
    );

    this._initSplash();
  }

  /* ── Splash / Permission Screen ─────────────────────────────────────── */
  async _initSplash() {
    const statusDot  = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const startBtn   = document.getElementById('start-ar-btn');
    const demoBtn    = document.getElementById('start-demo-btn');

    statusDot.classList.add('checking');
    statusText.textContent = 'Checking WebXR support…';

    const supported = await this._checkWebXR();

    if (supported) {
      statusDot.className = 'status-dot supported';
      statusText.textContent = 'WebXR AR Ready!';
      startBtn.disabled = false;
      startBtn.addEventListener('click', () => this._startAR());
    } else {
      statusDot.className = 'status-dot unsupported';
      statusText.textContent = 'WebXR not available — use Demo Mode';
      startBtn.disabled = true;
    }

    statusDot.classList.remove('checking');

    demoBtn.addEventListener('click', () => this._startDemo());
  }

  async _checkWebXR() {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
      return false;
    }
  }

  _hideSplash() {
    const splash = document.getElementById('splash-screen');
    splash.classList.add('fade-out');
    setTimeout(() => splash.classList.add('hidden'), 550);
  }

  /* ── Start WebXR AR Session ──────────────────────────────────────────── */
  async _startAR() {
    this._hideSplash();

    try {
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'light-estimation'],
        domOverlay: { root: document.getElementById('hud') },
      });

      this._xrSession = session;
      this._isAR      = true;

      this._scene.renderer.xr.setReferenceSpaceType('local');
      await this._scene.renderer.xr.setSession(session);

      session.addEventListener('end', () => this._onSessionEnd());

      // Request hit-test source
      const viewerSpace = await session.requestReferenceSpace('viewer');
      this._hitTestSrc  = await session.requestHitTestSource({ space: viewerSpace });

      this._scene.renderer.xr.addEventListener('sessionstart', () => {
        this._hud.show();
        this._hud.setHint('Move your phone to detect a surface…');
      });

      // Tap to add point via 'select' event
      session.addEventListener('select', () => this._addPoint());

      this._scene.renderer.setAnimationLoop((t, frame) => this._renderAR(t, frame));

    } catch (err) {
      this._showError('AR Session Failed', err.message || 'Could not start AR. Ensure camera permissions are granted.');
    }
  }

  /* ── Start Demo Mode ─────────────────────────────────────────────────── */
  _startDemo() {
    this._hideSplash();
    this._demoMode.activate();
    this._isAR = false;

    this._hud.show();
    this._hud.setHint('Click / tap anywhere to place measurement points', false);

    // Tap / click for demo mode
    this._canvas.addEventListener('click',     () => this._addPoint());
    this._canvas.addEventListener('touchend',  (e) => { e.preventDefault(); this._addPoint(); }, { passive: false });

    showToast('Demo Mode — click to place points');
    this._scene.renderer.setAnimationLoop((t) => this._renderDemo(t));
  }

  /* ── AR Render Loop ──────────────────────────────────────────────────── */
  _renderAR(timestamp, frame) {
    const t = this._clock.getElapsedTime();
    if (!frame) return;

    const refSpace = this._scene.renderer.xr.getReferenceSpace();
    const session  = this._scene.renderer.xr.getSession();

    if (this._hitTestSrc) {
      const results = frame.getHitTestResults(this._hitTestSrc);
      if (results.length > 0) {
        const hit  = results[0];
        const pose = hit.getPose(refSpace);
        if (pose) {
          this._reticle.updateFromHitMatrix(pose.transform.matrix);
          this._hud.update(
            this._measurements.getPointCount(),
            this._measurements.getLiveDistance(),
            this._measurements.getHistory(),
            true
          );

          // Update rubber band if first point placed
          if (this._measurements.getPointCount() === 1) {
            this._measurements.updateRubberBand(this._reticle.getCurrentPosition());
          }
        }
      } else {
        this._reticle.hide();
        this._hud.update(
          this._measurements.getPointCount(),
          this._measurements.getLiveDistance(),
          this._measurements.getHistory(),
          false
        );
      }
    }

    this._reticle.animate(t);
    this._scene.renderer.render(this._scene.scene, this._scene.camera);
  }

  /* ── Demo Render Loop ────────────────────────────────────────────────── */
  _renderDemo(timestamp) {
    const t   = this._clock.getElapsedTime();
    const hit = this._demoMode.getHitPoint();

    if (hit) {
      this._reticle.updateFromPosition(hit);
      if (this._measurements.getPointCount() === 1) {
        this._measurements.updateRubberBand(hit);
      }
    } else {
      this._reticle.hide();
    }

    this._hud.update(
      this._measurements.getPointCount(),
      this._measurements.getLiveDistance(),
      this._measurements.getHistory(),
      !!hit
    );

    this._reticle.animate(t);
    this._scene.renderer.render(this._scene.scene, this._scene.camera);
  }

  /* ── Point Actions ───────────────────────────────────────────────────── */
  _addPoint() {
    if (!this._reticle.visible) {
      showToast('No surface detected — move your camera');
      return;
    }

    const pos = this._reticle.getCurrentPosition();
    this._measurements.placePin(pos);

    const count = this._measurements.getPointCount();
    if (count === 1) {
      showToast('First point placed — tap for second point');
    } else if (count === 2) {
      const d   = this._measurements.getLiveDistance();
      const fmt = formatDistance(d);
      showToast(`📏 ${fmt.cm} cm  ·  ${fmt.inches}"`);
    }
  }

  _undo() {
    const result = this._measurements.undo();
    if (result === 'none') {
      showToast('Nothing to undo');
    } else {
      showToast(result === 'measurement' ? 'Measurement removed' : 'Point removed');
    }
    this._hud.update(
      this._measurements.getPointCount(),
      this._measurements.getLiveDistance(),
      this._measurements.getHistory(),
      this._reticle.visible
    );
  }

  _clearAll() {
    this._measurements.clearAll();
    showToast('All measurements cleared');
    this._hud.update(0, null, [], this._reticle.visible);
  }

  /* ── Screenshot ──────────────────────────────────────────────────────── */
  _screenshot() {
    try {
      this._scene.renderer.render(this._scene.scene, this._scene.camera);
      const dataURL = this._canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href     = dataURL;
      a.download = `measure-${Date.now()}.png`;
      a.click();
      showToast('📸 Screenshot saved!');
    } catch (err) {
      showToast('Screenshot failed — check permissions');
    }
  }

  /* ── Exit / Lifecycle ────────────────────────────────────────────────── */
  _exitAR() {
    if (this._xrSession) {
      this._xrSession.end().catch(() => {});
    } else {
      this._onSessionEnd();
    }
  }

  _onSessionEnd() {
    this._xrSession  = null;
    this._hitTestSrc = null;
    this._hud.hide();
    this._measurements.clearAll();
    this._demoMode.deactivate();

    // Restore splash
    const splash = document.getElementById('splash-screen');
    splash.classList.remove('hidden', 'fade-out');
    showToast('AR session ended');
  }

  /* ── Error Display ───────────────────────────────────────────────────── */
  _showError(title, msg) {
    document.getElementById('error-title').textContent   = title;
    document.getElementById('error-message').textContent = msg;
    document.getElementById('error-overlay').classList.remove('hidden');
    document.getElementById('error-dismiss-btn').addEventListener('click', () => {
      document.getElementById('error-overlay').classList.add('hidden');
    }, { once: true });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  new MeasureApp();

  // Register Service Worker for PWA + HTTPS context (optional, graceful)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {/* SW optional */});
  }
});
