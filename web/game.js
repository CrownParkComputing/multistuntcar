/**
 * game.js – Three.js front-end for MultiStuntCar
 *
 * Architecture
 * ────────────
 * The compiled WASM module (stuntcarracer.js) handles:
 *   • All physics via CarBehaviour() (unchanged from the original C++ port).
 *   • Track geometry export (js_fill_track_vertices).
 *
 * Three.js renders the scene.  Each requestAnimationFrame:
 *   1. JS input flags → js_step_physics(dt, input).
 *   2. js_get_player_state() → update car mesh transform.
 *   3. js_get_viewpoint()    → update camera.
 *   4. renderer.render()     → present frame.
 *
 * Coordinate mapping
 * ──────────────────
 * The WASM functions return coordinates in "render units":
 *   X, Z  ∈ [0, ~65 000]   (one grid cube = 4 096 units)
 *   Y     uses game-internal Y-down convention (larger Y = lower altitude).
 *
 * For Three.js (Y-up):  threeY = -wasmY
 *
 * Camera
 * ──────
 * Cockpit-style follow cam: the camera is placed at the viewpoint returned by
 * js_get_viewpoint() and looks along the car's forward direction.
 *
 * Key constants (must match src/StuntCarRacer.cpp / src/Car.h)
 * ─────────────────────────────────────────────────────────────
 * PERSPECTIVE_NEAR  = 5
 * PERSPECTIVE_FAR   = 262 144
 * VCAR_WIDTH/LENGTH/HEIGHT = 162 / 256 / 162  (render units)
 */

import * as THREE from 'three';

// ─── Constants ───────────────────────────────────────────────────────────────
const PERSPECTIVE_NEAR = 5;
const PERSPECTIVE_FAR  = 262144;
const VCAR_WIDTH  = 162;
const VCAR_LENGTH = 256;
const VCAR_HEIGHT = 162;

// KEY bitmasks (must match Car_Behaviour.h)
const KEY_LEFT  = 0x01;
const KEY_RIGHT = 0x02;
const KEY_ACCEL = 0x04;
const KEY_BRAKE = 0x08;
const KEY_BOOST = 0x10;

// Game modes (must match GameModeType in StuntCarRacer.h)
const MODE_TRACK_MENU    = 0;
const MODE_TRACK_PREVIEW = 1;
const MODE_GAME          = 2;
const MODE_GAME_OVER     = 3;

const SPEED_MAX_DISPLAY = 240;  // matches COCKPIT_SPEEDBAR_MAX in Car.h

// ─── Module-level state ───────────────────────────────────────────────────────
let wasmReady  = false;
let gameActive = false;

let renderer, scene, camera;
let trackMesh = null;
let carMesh   = null;
let groundMesh = null;

// Scratch Float32Arrays backed by WASM heap (allocated once per track load)
let statePtr   = 0;   // 7 floats: player state
let viewPtr    = 0;   // 6 floats: viewpoint
let trackPtr   = 0;   // N*6 floats: track vertices
let stateView  = null;
let viewView   = null;

let inputMask = 0;
let lastTime  = 0;
let prevLap   = 1;

// ─── DOM references ───────────────────────────────────────────────────────────
const loadingEl  = document.getElementById('loading');
const loadingBar = document.getElementById('loading-bar');
const loadingTxt = document.getElementById('loading-text');
const menuEl     = document.getElementById('menu');
const hudEl      = document.getElementById('hud');
const startBtn   = document.getElementById('start-btn');
const trackSel   = document.getElementById('track-select');
const lapValue   = document.getElementById('lap-value');
const speedValue = document.getElementById('speed-value');
const speedFill  = document.getElementById('speed-fill');
const holes      = Array.from({ length: 6 }, (_, i) => document.getElementById('hole' + i));
const threeCanvas = document.getElementById('threejs-canvas');

// ─── Input handling ───────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
    switch (e.code) {
        case 'ArrowLeft':  inputMask |= KEY_LEFT;  break;
        case 'ArrowRight': inputMask |= KEY_RIGHT; break;
        case 'ArrowUp':    inputMask |= KEY_ACCEL; break;
        case 'ArrowDown':  inputMask |= KEY_BRAKE; break;
        case 'Space':
        case 'ShiftLeft':
        case 'ShiftRight': inputMask |= KEY_BOOST; break;
        case 'KeyM':
            if (gameActive) returnToMenu();
            break;
        default: return;
    }
    e.preventDefault();
});

window.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'ArrowLeft':  inputMask &= ~KEY_LEFT;  break;
        case 'ArrowRight': inputMask &= ~KEY_RIGHT; break;
        case 'ArrowUp':    inputMask &= ~KEY_ACCEL; break;
        case 'ArrowDown':  inputMask &= ~KEY_BRAKE; break;
        case 'Space':
        case 'ShiftLeft':
        case 'ShiftRight': inputMask &= ~KEY_BOOST; break;
        default: return;
    }
    e.preventDefault();
});

// ─── Three.js initialisation ──────────────────────────────────────────────────
function initThree() {
    renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x336699);  // sky blue (matches game backdrop)

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x336699, PERSPECTIVE_FAR * 0.3, PERSPECTIVE_FAR);

    camera = new THREE.PerspectiveCamera(
        60,
        window.innerWidth / window.innerHeight,
        PERSPECTIVE_NEAR,
        PERSPECTIVE_FAR
    );
    camera.position.set(0, 0, 0);

    // Ambient + directional light for the flat-shaded track
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(0.5, 1.0, 0.3);
    scene.add(dirLight);

    // Car box mesh (dimensions in render units; Y-up so height is in Y axis)
    const carGeo = new THREE.BoxGeometry(VCAR_WIDTH, VCAR_HEIGHT, VCAR_LENGTH);
    const carMat = new THREE.MeshLambertMaterial({ color: 0xff4400 });
    carMesh = new THREE.Mesh(carGeo, carMat);
    scene.add(carMesh);
    carMesh.visible = false;

    window.addEventListener('resize', onResize);
}

function onResize() {
    if (!renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Track geometry ───────────────────────────────────────────────────────────
function buildTrackMesh() {
    if (trackMesh) {
        scene.remove(trackMesh);
        trackMesh.geometry.dispose();
        trackMesh = null;
    }
    if (groundMesh) {
        scene.remove(groundMesh);
        groundMesh.geometry.dispose();
        groundMesh = null;
    }

    const M = window.Module;
    const vtxCount = M._js_get_track_vertex_count();
    if (vtxCount <= 0) return;

    const floatCount = vtxCount * 6;

    // Allocate WASM heap for the vertex dump
    if (trackPtr) M._free(trackPtr);
    trackPtr = M._malloc(floatCount * 4);
    M._js_fill_track_vertices(trackPtr);

    // Transfer to JS Float32Array
    const raw = new Float32Array(M.HEAPF32.buffer, trackPtr, floatCount);

    const positions = new Float32Array(vtxCount * 3);
    const colors    = new Float32Array(vtxCount * 3);

    for (let i = 0; i < vtxCount; i++) {
        // Negate Y for Three.js Y-up world space
        positions[i * 3 + 0] =  raw[i * 6 + 0];  // x
        positions[i * 3 + 1] = -raw[i * 6 + 1];  // y  (negated)
        positions[i * 3 + 2] =  raw[i * 6 + 2];  // z
        colors[i * 3 + 0]    =  raw[i * 6 + 3];  // r
        colors[i * 3 + 1]    =  raw[i * 6 + 4];  // g
        colors[i * 3 + 2]    =  raw[i * 6 + 5];  // b
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    // DoubleSide because winding order is designed for Y-down and may be
    // reversed after Y negation; DoubleSide ensures all faces are visible.
    const mat = new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
    });

    trackMesh = new THREE.Mesh(geo, mat);
    scene.add(trackMesh);

    // Large flat ground plane so the world doesn't look empty
    const groundGeo = new THREE.PlaneGeometry(200000, 200000);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x336633, side: THREE.DoubleSide });
    groundMesh = new THREE.Mesh(groundGeo, groundMat);
    // Position ground at the approximate track surface level
    groundMesh.rotation.x = -Math.PI / 2;  // lie flat in XZ plane
    groundMesh.position.y = -340;           // slightly below track surface (~320 game units)
    scene.add(groundMesh);
}

// ─── Allocate per-frame WASM scratch memory ───────────────────────────────────
function allocateScratch() {
    const M = window.Module;
    if (statePtr) M._free(statePtr);
    if (viewPtr)  M._free(viewPtr);
    statePtr  = M._malloc(7 * 4);   // 7 floats
    viewPtr   = M._malloc(6 * 4);   // 6 floats
    stateView = new Float32Array(M.HEAPF32.buffer, statePtr, 7);
    viewView  = new Float32Array(M.HEAPF32.buffer, viewPtr, 6);
}

// ─── Start a race on the selected track ──────────────────────────────────────
function startRace(trackId) {
    const M = window.Module;

    inputMask = 0;
    const ok = M._js_select_track(trackId);
    if (!ok) {
        console.error('js_select_track(' + trackId + ') failed');
        return;
    }

    buildTrackMesh();
    allocateScratch();

    carMesh.visible = true;
    menuEl.style.display = 'none';
    hudEl.style.display  = 'block';
    prevLap = 1;
    lapValue.textContent = '1';
    holes.forEach(h => h.classList.remove('hit'));

    gameActive = true;
    lastTime   = performance.now();
}

function returnToMenu() {
    gameActive = false;
    carMesh.visible = false;
    hudEl.style.display  = 'none';
    menuEl.style.display = 'block';
    inputMask = 0;
}

// ─── HUD update ───────────────────────────────────────────────────────────────
function updateHud(speed, lap) {
    const speedInt = Math.round(speed);
    speedValue.textContent = speedInt;
    const pct = Math.min(100, (speedInt / SPEED_MAX_DISPLAY) * 100);
    speedFill.style.width = pct + '%';
    speedFill.style.background = speedInt > SPEED_MAX_DISPLAY ? '#f00' : '#0f0';

    if (lap !== prevLap) {
        lapValue.textContent = lap;
        prevLap = lap;
    }
}

// ─── Main render / physics loop ───────────────────────────────────────────────
const FIXED_STEP = 1 / 60;  // 60 Hz physics
let   accumulator = 0;

function animate(timestamp) {
    requestAnimationFrame(animate);

    const M = window.Module;
    if (!wasmReady || !M) return;

    renderer.render(scene, camera);
    if (!gameActive) return;

    const nowMs = timestamp;
    let   dt    = (nowMs - lastTime) / 1000;
    lastTime    = nowMs;
    if (dt > 0.25) dt = 0.25;  // clamp to avoid spiral-of-death

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 10) {
        M._js_step_physics(FIXED_STEP, inputMask);
        accumulator -= FIXED_STEP;
        steps++;
    }

    // Read back state
    M._js_get_player_state(statePtr);
    M._js_get_viewpoint(viewPtr);

    const carX  =  stateView[0];
    const carY  = -stateView[1];   // negate Y for Three.js Y-up
    const carZ  =  stateView[2];
    const carXA =  stateView[3];
    const carYA =  stateView[4];
    const carZA =  stateView[5];
    const speed =  stateView[6];
    const lap   =  M._js_get_lap() + 1;  // WASM lap is 0-based, HUD shows 1-based

    // Update car transform
    carMesh.position.set(carX, carY + VCAR_HEIGHT / 2, carZ);
    // The C++ renderer uses: mat4RotationY(ya + PI); Y is negated for Three.js.
    // With Y negated, rotating around Y reverses the handedness, so we negate ya.
    carMesh.rotation.order = 'YXZ';
    carMesh.rotation.y = -(carYA + Math.PI);
    carMesh.rotation.x =  carXA;
    carMesh.rotation.z =  carZA;

    // Camera: placed at the viewpoint, looking along the car's forward direction.
    // vp[0,2] are already >>= LOG_PRECISION (same render scale as carX/Z).
    // vp[1] is still raw / PRECISION → negate for Y-up.
    const vpX = viewView[0];
    const vpY = -viewView[1];
    const vpZ = viewView[2];
    camera.position.set(vpX, vpY, vpZ);

    // Car forward direction (in game: ya=0 → car faces -Z after ya+PI rotation)
    const fwdX = -Math.sin(carYA);
    const fwdZ = -Math.cos(carYA);
    camera.lookAt(vpX + fwdX * 800, vpY - 30, vpZ + fwdZ * 800);

    updateHud(speed, lap);
}

// ─── WASM module bootstrap ────────────────────────────────────────────────────

function setLoadingProgress(pct, text) {
    loadingBar.style.width = pct + '%';
    if (text) loadingTxt.textContent = text;
}

function onWasmReady() {
    const M = window.Module;

    // Enter headless mode: suppress SDL/OpenGL rendering loop
    M._js_set_headless(1);

    setLoadingProgress(100, 'Ready');
    setTimeout(() => {
        loadingEl.style.display = 'none';
        menuEl.style.display    = 'block';
        startBtn.disabled       = false;
    }, 200);

    wasmReady = true;
}

// Wire up the start button
startBtn.addEventListener('click', () => {
    const id = parseInt(trackSel.value, 10);
    startRace(id);
});

// Initialise Three.js immediately (doesn't require WASM)
initThree();

// Begin the render loop (will no-op until WASM is ready)
requestAnimationFrame(animate);

// ─── Load the WASM module ─────────────────────────────────────────────────────
//
// The compiled Emscripten output is stuntcarracer.js (sibling of this file).
// We inject a <script> tag so the Emscripten-generated JS bootstraps normally.
// The Module object is configured before the script runs.
//
window.Module = {
    // Point Emscripten's canvas at the tiny hidden element so SDL initialises
    // without disturbing the Three.js canvas.
    canvas: document.getElementById('canvas'),

    // Suppress Emscripten's default progress bar (we show our own).
    setStatus: (msg) => {
        if (!msg) return;
        const m = msg.match(/(\d+)\/(\d+)/);
        if (m) {
            const pct = Math.round((parseInt(m[1]) / parseInt(m[2])) * 90);
            setLoadingProgress(pct, 'Loading assets…');
        } else {
            setLoadingProgress(10, msg);
        }
    },

    // Called when the WASM module and all preloaded assets are ready.
    onRuntimeInitialized: onWasmReady,

    // Silence Emscripten's default print-to-stdout noise in the console.
    print:    (t) => {},
    printErr: (t) => console.warn('[WASM]', t),
};

setLoadingProgress(5, 'Loading engine…');

// Dynamically load the compiled WASM JS bundle.
// The path assumes both files live in the same directory (e.g. a CMake build output).
// Adjust WASM_JS_PATH to match your deployment layout if needed.
const WASM_JS_PATH = '../stuntcarracer.js';  // relative to web/index.html
const s = document.createElement('script');
s.src = WASM_JS_PATH;
s.onerror = () => {
    loadingTxt.textContent = 'Failed to load ' + WASM_JS_PATH;
    loadingBar.style.background = '#f00';
};
document.head.appendChild(s);
