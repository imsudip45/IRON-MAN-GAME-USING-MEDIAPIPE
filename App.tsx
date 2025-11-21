import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  limit, 
  onSnapshot,
  serverTimestamp 
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

// --- Global Definitions & Types ---

declare global {
  var __firebase_config: any;
  var __app_id: string;
  var __initial_auth_token: string;
}

interface GameState {
  status: 'menu' | 'playing' | 'gameover';
  health: number;
  score: number;
  wave: number;
  enemies: Enemy[];
  beamCharges: number; // 0 to 5 (Ammo count)
}

interface Enemy {
  id: string;
  mesh: THREE.Mesh;
  hitbox: THREE.Mesh; // Invisible larger mesh for easier aiming
  hp: number;
  maxHp: number;
  wobbleOffset: number;
  speedOffset: number;
  velocity: THREE.Vector3; // Physics velocity for smooth steering
}

interface LeaderboardEntry {
  id: string;
  nickname: string;
  score: number;
}

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
}

interface ElectricalArc {
    mesh: THREE.Line;
    life: number;
}

interface Shockwave {
    mesh: THREE.Mesh;
    light: THREE.PointLight;
    life: number;
    direction: THREE.Vector3 | null; // null indicates omni-directional 360 blast
}

interface DamageText {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
}

interface HandInput {
  x: number; // 0-1 relative to screen
  y: number; // 0-1 relative to screen
  detected: boolean;
  gesture: string;
}

// --- Constants ---

const PLAYER_HEIGHT = 1.5;
const FLIGHT_SPEED = 15.0; // Automatic forward speed
const REPULSOR_COOLDOWN_MS = 200;
const BEAM_DURATION_MS = 1000;
const WAVE_DURATION_SEC = 45;
const MAX_BEAM_CHARGES = 5;
const BEAM_REGEN_MS = 1000; // 1 Second per charge (5 charges in 5 seconds)
const BEAM_AOE_RADIUS = 3.5; // Wide destruction radius

// --- Helper Functions ---

const createTextTexture = (text: string, color: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = 'bold 140px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.fillText(text, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
};

// --- Helper Components ---

const HUD = ({ 
  gameState, 
  timer, 
  onStart,
  hitMarker,
  isFiring,
  handInput
}: { 
  gameState: GameState; 
  timer: number; 
  onStart: () => void;
  hitMarker: boolean;
  isFiring: boolean;
  handInput: HandInput;
}) => {
  const hpPercent = Math.max(0, gameState.health);
  const beamAmmo = gameState.beamCharges;
  const beamReady = beamAmmo > 0;
  
  let hpColor = "bg-cyan-400";
  if (hpPercent < 50) hpColor = "bg-yellow-400";
  if (hpPercent < 20) hpColor = "bg-red-500 animate-pulse";

  const reticleX = handInput.x * 100;
  const reticleY = handInput.y * 100;

  return (
    <div className="absolute inset-0 pointer-events-none select-none font-sans text-white">
      {hpPercent < 30 && (
        <div className="absolute inset-0 shadow-[inset_0_0_100px_rgba(239,68,68,0.5)] animate-pulse z-0"></div>
      )}

      {gameState.status === 'playing' && (
        <>
          {/* Top Left: Score & Wave */}
          <div className="absolute top-6 left-6 flex flex-col gap-1 z-10">
            <div className="text-3xl font-black tracking-widest text-cyan-300 drop-shadow-[0_0_10px_rgba(34,211,238,0.8)] italic">
              {gameState.score.toString().padStart(6, '0')}
            </div>
            <div className="flex items-center gap-2 text-cyan-100/80">
              <span className="text-xs bg-cyan-900/50 px-2 py-0.5 rounded border border-cyan-500/30">WAVE {gameState.wave}</span>
              <span className="text-xs font-mono text-cyan-500/80">T-{timer.toFixed(1)}</span>
            </div>
          </div>

          {/* Top Center: Health Bar */}
          <div className="absolute top-6 left-1/2 -translate-x-1/2 w-96 z-10">
            <div className="flex justify-between text-[10px] text-cyan-500 mb-1 font-mono tracking-widest">
              <span>ARMOR INTEGRITY</span>
              <span>{hpPercent}%</span>
            </div>
            <div className="h-3 bg-slate-900/80 border border-slate-700 skew-x-[-12deg] relative group">
              <div 
                className={`h-full transition-all duration-300 ${hpColor} shadow-[0_0_10px_currentColor] relative`} 
                style={{ width: `${hpPercent}%` }}
              >
                  <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-white/50"></div>
              </div>
            </div>
          </div>

          {/* Dynamic Reticle */}
          <div 
            className="fixed pointer-events-none z-20 will-change-transform"
            style={{ 
                left: `${reticleX}%`, 
                top: `${reticleY}%`,
                transform: 'translate(-50%, -50%)'
            }}
          >
             {/* Outer Ring */}
             <div 
                className={`rounded-full border border-cyan-400/60 flex items-center justify-center transition-all duration-100
                    ${isFiring ? 'w-16 h-16 scale-110 opacity-100' : 'w-8 h-8 opacity-60'}
                    ${handInput.gesture === 'Open_Palm' && beamReady ? 'border-blue-400 shadow-[0_0_20px_#3b82f6]' : 'shadow-[0_0_10px_cyan]'}
                `}
              >
                {/* Center Dot */}
                <div className={`w-1 h-1 rounded-full ${beamReady && handInput.gesture === 'Open_Palm' ? 'bg-blue-400' : 'bg-cyan-300'}`}></div>
              </div>
              
              {/* Hit Marker */}
              {hitMarker && (
                  <div className="absolute inset-0 flex items-center justify-center">
                      <div className="absolute w-[2px] h-6 bg-red-500 rotate-45 shadow-[0_0_8px_red]"></div>
                      <div className="absolute w-[2px] h-6 bg-red-500 -rotate-45 shadow-[0_0_8px_red]"></div>
                  </div>
              )}

              {/* Gesture Label */}
              {handInput.detected && (
                <div className="absolute top-10 left-1/2 -translate-x-1/2 text-[9px] font-mono text-cyan-300 whitespace-nowrap uppercase tracking-widest bg-black/50 px-1">
                   {handInput.gesture === 'Closed_Fist' ? 'REPULSOR' : 
                    handInput.gesture === 'Open_Palm' ? 'UNIBEAM' : 'TRACKING'}
                </div>
              )}
          </div>

          {/* Bottom Center: Beam Status */}
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 text-center flex flex-col items-center gap-4 z-10">
            <div className="flex flex-col items-center gap-1">
               <div className="text-[10px] font-mono text-cyan-600 tracking-[0.2em] mb-1">UNIBEAM CAPACITOR</div>
               <div className="flex gap-1">
                 {[...Array(MAX_BEAM_CHARGES)].map((_, i) => (
                    <div 
                        key={i}
                        className={`w-12 h-3 skew-x-[-12deg] border border-slate-800 transition-all duration-300
                            ${i < beamAmmo 
                                ? 'bg-blue-500 shadow-[0_0_10px_#3b82f6]' // Filled
                                : 'bg-slate-900/50' // Empty
                            }
                        `}
                    />
                 ))}
               </div>
               <div className={`mt-2 text-xs font-bold tracking-widest ${beamReady ? 'text-blue-300 animate-pulse drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]' : 'text-slate-500'}`}>
                 {beamReady ? '[ UNIBEAM READY // GESTURE: PALM ]' : `RECHARGING... ${beamAmmo}/${MAX_BEAM_CHARGES}`}
               </div>
            </div>
          </div>
        </>
      )}

      {/* Menu / Game Over Modal */}
      {gameState.status !== 'playing' && (
        <div className="absolute inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center pointer-events-auto z-50">
          <div className="bg-slate-900/90 border border-cyan-500/30 p-10 max-w-lg w-full shadow-[0_0_100px_rgba(6,182,212,0.2)] relative overflow-hidden clip-path-polygon">
             <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-50"></div>
             
             <div className="text-center mb-8">
                <h1 className="text-6xl font-black italic text-transparent bg-clip-text bg-gradient-to-b from-white to-cyan-400 mb-2 drop-shadow-sm">
                STARK
                </h1>
                <h2 className="text-cyan-600 tracking-[0.5em] text-sm font-mono border-y border-cyan-900 py-2">COMBAT SIMULATOR V2.0</h2>
             </div>

             {gameState.status === 'gameover' && (
               <div className="mb-8 text-center bg-red-900/20 border border-red-900/50 p-4 rounded">
                 <div className="text-red-500 font-bold text-3xl mb-1 tracking-tighter">CRITICAL FAILURE</div>
                 <div className="text-slate-400 font-mono text-sm">FINAL SCORE // <span className="text-white font-bold text-lg">{gameState.score}</span></div>
               </div>
             )}

             <button
               onClick={onStart}
               className="w-full py-5 bg-cyan-500/5 hover:bg-cyan-400/10 border border-cyan-500/50 hover:border-cyan-400 text-cyan-300 font-bold tracking-[0.2em] transition-all duration-200 hover:shadow-[0_0_30px_rgba(34,211,238,0.2)] uppercase relative overflow-hidden group"
             >
               <span className="relative z-10">{gameState.status === 'gameover' ? 'REBOOT SYSTEM' : 'INITIATE PROTOCOL'}</span>
               <div className="absolute inset-0 bg-cyan-400/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
             </button>

             <div className="mt-6 flex justify-between text-[10px] text-slate-600 font-mono text-center w-full">
               <span className="flex-1 border-r border-slate-800">FIST: SHOOT</span>
               <span className="flex-1 border-r border-slate-800">PALM: UNIBEAM</span>
               <span className="flex-1">HAND: AIM</span>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

// --- Main App Component ---

const App: React.FC = () => {
  // --- Refs ---
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  
  // Game Engine Refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameIdRef = useRef<number>(0);
  const enemiesRef = useRef<Enemy[]>([]);
  const activeLinesRef = useRef<{ mesh: THREE.Mesh; timestamp: number }[]>([]);
  const electricalArcsRef = useRef<ElectricalArc[]>([]);
  const shockwavesRef = useRef<Shockwave[]>([]); 
  const particlesRef = useRef<Particle[]>([]);
  const damageTextsRef = useRef<DamageText[]>([]);
  const shakeIntensityRef = useRef<number>(0);
  const muzzleLightRef = useRef<THREE.PointLight | null>(null);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const starsRef = useRef<THREE.Points | null>(null);
  
  // Cached Assets (Performance Optimization)
  const sharedMaterialsRef = useRef<{
    particle: THREE.MeshBasicMaterial;
    enemy: THREE.MeshStandardMaterial;
    enemyRing: THREE.MeshBasicMaterial;
    shockwave: THREE.MeshBasicMaterial;
  } | null>(null);
  const sharedGeometriesRef = useRef<{
    particle: THREE.TetrahedronGeometry;
    enemy: THREE.SphereGeometry;
    enemyRing: THREE.TorusGeometry;
    hitbox: THREE.SphereGeometry;
    omniSphere: THREE.SphereGeometry;
  } | null>(null);
  
  const lastShotTimeRef = useRef<number>(0);
  const waveStartTimeRef = useRef<number>(0);
  const gestureRecognizerRef = useRef<any>(null);
  const lastGestureTimeRef = useRef<number>(0);
  
  const beamRegenTimerRef = useRef<number>(0);

  // Input & Aiming Refs
  // cursorPositionRef tracks the SMOOTHED 0-1 coords used for rendering
  const cursorPositionRef = useRef({ x: 0.5, y: 0.5 });
  // targetCursorPositionRef tracks the RAW 0-1 coords from input
  const targetCursorPositionRef = useRef({ x: 0.5, y: 0.5 });

  // Firebase Refs
  const dbRef = useRef<any>(null);
  const authRef = useRef<any>(null);
  const userIdRef = useRef<string | null>(null);

  // --- State ---
  const [gameState, setGameState] = useState<GameState>({
    status: 'menu',
    health: 100,
    score: 0,
    wave: 1,
    enemies: [],
    beamCharges: 5 
  });
  const [timer, setTimer] = useState(45);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [nickname, setNickname] = useState(`STARK-${Math.floor(Math.random() * 999)}`);
  const [hitMarker, setHitMarker] = useState(false);
  const [isFiring, setIsFiring] = useState(false);
  const [handInput, setHandInput] = useState<HandInput>({ x: 0.5, y: 0.5, detected: false, gesture: 'None' });

  // --- Audio Helper ---
  const playSound = useCallback((type: 'shoot' | 'hit' | 'beam' | 'alarm' | 'low_hp') => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'shoot') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.exponentialRampToValueAtTime(110, t + 0.15);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.start(t);
        osc.stop(t + 0.15);
    } else if (type === 'hit') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.start(t);
        osc.stop(t + 0.1);
    } else if (type === 'beam') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, t);
        osc.frequency.linearRampToValueAtTime(600, t + 0.2);
        osc.frequency.linearRampToValueAtTime(50, t + 1.0);
        
        gain.gain.setValueAtTime(0.0, t);
        gain.gain.linearRampToValueAtTime(0.5, t + 0.1);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
        
        const bufferSize = ctx.sampleRate * 1.0;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.6;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.3, t);
        noiseGain.gain.linearRampToValueAtTime(0, t + 1.0);
        noise.connect(noiseGain);
        noiseGain.connect(ctx.destination);
        noise.start(t);
        
        osc.start(t);
        osc.stop(t + 1.0);
    } else if (type === 'low_hp') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, t);
        osc.frequency.setValueAtTime(0, t + 0.1);
        gain.gain.setValueAtTime(0.05, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.2);
        osc.start(t);
        osc.stop(t + 0.2);
    }
  }, []);

  // --- Initialization: Firebase ---
  useEffect(() => {
    if (typeof __firebase_config !== 'undefined' && !dbRef.current) {
      try {
        const app = initializeApp(__firebase_config);
        dbRef.current = getFirestore(app);
        authRef.current = getAuth(app);
        signInAnonymously(authRef.current).then(creds => {
            userIdRef.current = creds.user.uid;
        });
      } catch (e) {
        console.error("Firebase Init Error:", e);
      }
    }
  }, []);

  // --- Initialization: MediaPipe & Camera ---
  useEffect(() => {
    const initMediaPipe = async () => {
      if (!videoRef.current) return;

      try {
        console.log("Initializing MediaPipe...");
        const { FilesetResolver, GestureRecognizer } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/+esm");

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm"
        );
        
        gestureRecognizerRef.current = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });
        console.log("Gesture Recognizer loaded");

        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: { ideal: 30 } } });
        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
        }
      } catch (err) {
        console.error("MediaPipe/Camera Init Error:", err);
      }
    };

    initMediaPipe();
  }, []);

  // --- Leaderboard Listener ---
  useEffect(() => {
    if (!dbRef.current || !__app_id) return;
    const scoresRef = collection(dbRef.current, `artifacts/${__app_id}/public/data/stark_protocol_scores`);
    const q = query(scoresRef, orderBy("score", "desc"), limit(10));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: LeaderboardEntry[] = [];
      snapshot.forEach((doc) => {
        entries.push({ id: doc.id, ...doc.data() } as LeaderboardEntry);
      });
      setLeaderboard(entries);
    });
    return () => unsubscribe();
  }, []);

  // --- Game Logic: 3D Setup & Loop ---
  useEffect(() => {
    if (!mountRef.current) return;

    // 1. Setup Three.js
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); 
    scene.fog = new THREE.FogExp2(0x000000, 0.015);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, PLAYER_HEIGHT, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Reduced pixel ratio for performance
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Initialize Cached Materials & Geometries
    sharedMaterialsRef.current = {
      particle: new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 1.0 }),
      enemy: new THREE.MeshStandardMaterial({ 
        color: 0x222222, 
        emissive: 0xff0000, 
        emissiveIntensity: 0.8,
        roughness: 0.2,
        metalness: 0.8
      }),
      enemyRing: new THREE.MeshBasicMaterial({ color: 0xff3300 }),
      shockwave: new THREE.MeshBasicMaterial({ 
          color: 0x88ffff, 
          transparent: true, 
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
      })
    };
    
    // BIGGER ENEMIES UPDATE: Increased dimensions
    sharedGeometriesRef.current = {
        particle: new THREE.TetrahedronGeometry(0.15),
        enemy: new THREE.SphereGeometry(1.2, 16, 16), // Radius increased from 0.3 to 1.2
        enemyRing: new THREE.TorusGeometry(1.4, 0.05, 8, 16), // Scaled up ring
        hitbox: new THREE.SphereGeometry(2.0, 8, 8), // Larger hitbox
        omniSphere: new THREE.SphereGeometry(1, 32, 32) // For 360 shockwave
    };
    // Orient ring correctly
    sharedGeometriesRef.current.enemyRing.rotateX(Math.PI / 2);

    // Environment
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1000;
    const starPos = new Float32Array(starCount * 3);
    for(let i=0; i<starCount*3; i++) {
        starPos[i] = (Math.random() - 0.5) * 200;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, transparent: true, opacity: 0.8 });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);
    starsRef.current = stars;

    const ambientLight = new THREE.AmbientLight(0x222222);
    scene.add(ambientLight);
    const hemiLight = new THREE.HemisphereLight(0x00ffff, 0xff0000, 0.2);
    scene.add(hemiLight);

    const gridHelper = new THREE.GridHelper(200, 100, 0x00ffff, 0x001133);
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.2;
    scene.add(gridHelper);
    gridHelperRef.current = gridHelper;

    const muzzleLight = new THREE.PointLight(0x00ffff, 0, 10);
    camera.add(muzzleLight);
    muzzleLight.position.set(0.3, -0.3, -1);
    muzzleLightRef.current = muzzleLight;

    scene.add(camera);

    // Input Listeners
    const handleKeyDown = (e: KeyboardEvent) => {
      switch(e.code) {
        case 'Space': 
          setHandInput(prev => ({ ...prev, gesture: 'Open_Palm' }));
          setTimeout(() => triggerUnibeam(), 0);
          break;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;
        targetCursorPositionRef.current = { x, y };
        setHandInput(prev => ({ ...prev, x, y, detected: false }));
    };

    const handleMouseDown = () => {
       fireRepulsor();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mousedown', handleMouseDown);

    // --- Combat Functions ---

    const addShake = (intensity: number) => {
        shakeIntensityRef.current = Math.min(shakeIntensityRef.current + intensity, 2.0);
    };

    const spawnDamageText = (pos: THREE.Vector3, amount: number, isCrit: boolean = false) => {
        const color = isCrit ? '#00ffff' : '#ffffff';
        const map = createTextTexture(amount.toString(), color);
        const material = new THREE.SpriteMaterial({ map: map, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(material);
        
        sprite.position.copy(pos);
        sprite.position.y += 1.0; // Higher offset for bigger enemies
        sprite.scale.set(1.5, 1.5, 1.5);
        
        scene.add(sprite);
        damageTextsRef.current.push({ sprite, velocity: new THREE.Vector3(0, 1.5, 0), life: 1.0 });
    };

    const spawnExplosion = (pos: THREE.Vector3) => {
      const count = 8; 
      for (let i = 0; i < count; i++) {
        // Reusing Material and Geometry
        const mesh = new THREE.Mesh(
            sharedGeometriesRef.current!.particle, 
            sharedMaterialsRef.current!.particle.clone() // Clone material to handle independent fade opacity
        );
        mesh.position.copy(pos);
        mesh.position.x += (Math.random() - 0.5) * 1.0; // Bigger explosion spread
        
        const velocity = new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2
        );
        scene.add(mesh);
        particlesRef.current.push({ mesh, velocity, life: 0.8 });
      }
      const light = new THREE.PointLight(0xffaa00, 2, 10);
      light.position.copy(pos);
      scene.add(light);
      setTimeout(() => scene.remove(light), 100);
    };

    const spawnShockwave = (origin: THREE.Vector3, direction: THREE.Vector3 | null) => {
         // If direction is null, it is an OMNI (360) shockwave (Sphere)
         // Otherwise it is a directional ring
         let geometry = sharedGeometriesRef.current!.enemyRing;
         if (!direction) geometry = sharedGeometriesRef.current!.omniSphere;

         const mesh = new THREE.Mesh(
             geometry,
             sharedMaterialsRef.current!.shockwave.clone()
         );
         
         mesh.position.copy(origin);
         if (direction) {
            mesh.scale.set(2,2,2); 
            mesh.lookAt(origin.clone().add(direction));
         } else {
            // Omni shockwave starts small
            mesh.scale.set(0.1, 0.1, 0.1);
         }
         
         const light = new THREE.PointLight(0x0088ff, 4, 15);
         mesh.add(light);

         scene.add(mesh);
         shockwavesRef.current.push({ mesh, light, life: 0, direction });
    };

    const generateLightning = (start: THREE.Vector3, end: THREE.Vector3) => {
        const points = [];
        points.push(start);
        const segments = 10;
        for (let i = 1; i < segments; i++) {
            const lerpPos = start.clone().lerp(end, i / segments);
            lerpPos.x += (Math.random() - 0.5) * 2.0;
            lerpPos.y += (Math.random() - 0.5) * 2.0;
            lerpPos.z += (Math.random() - 0.5) * 2.0;
            points.push(lerpPos);
        }
        points.push(end);
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({ color: 0x00aaff });
        const line = new THREE.Line(geo, mat);
        scene.add(line);
        electricalArcsRef.current.push({ mesh: line, life: 0.2 });
    };

    const triggerUnibeam = () => {
      setGameState(prev => {
          if (prev.beamCharges <= 0) return prev; 

          playSound('beam');
          addShake(2.0); // Massive Shake

          const raycaster = new THREE.Raycaster();
          const mouseVec = new THREE.Vector2(
            (cursorPositionRef.current.x * 2) - 1,
            -(cursorPositionRef.current.y * 2) + 1
          );
          raycaster.setFromCamera(mouseVec, camera);
          const rayDir = raycaster.ray.direction.normalize();
          const rayOrigin = raycaster.ray.origin;
          const endPoint = rayOrigin.clone().add(rayDir.multiplyScalar(100));

          const distance = 100;
          const startPoint = new THREE.Vector3(0.3, -0.3, -0.5).applyMatrix4(camera.matrixWorld);
          
          const cylGeo = new THREE.CylinderGeometry(0.8, 0.8, distance, 16, 1, true);
          cylGeo.rotateX(-Math.PI / 2);
          cylGeo.translate(0, 0, distance/2);
          const mat = new THREE.MeshBasicMaterial({ 
              color: 0x2288ff, 
              transparent: true, 
              opacity: 0.8,
              blending: THREE.AdditiveBlending,
              side: THREE.DoubleSide
          });
          const beamMesh = new THREE.Mesh(cylGeo, mat);
          beamMesh.position.copy(startPoint);
          beamMesh.lookAt(endPoint);
          scene.add(beamMesh);
          
          for(let k=0; k<8; k++) generateLightning(startPoint, endPoint);

          // 360 DEGREE SHOCKWAVE
          spawnShockwave(startPoint, null);
          
          activeLinesRef.current.push({ mesh: beamMesh, timestamp: Date.now() + 500 }); 

          // OMNI-DIRECTIONAL DAMAGE LOGIC
          const enemiesToRemove: number[] = [];
          enemiesRef.current.forEach((enemy, idx) => {
              // Instead of calculating distance to a beam ray, calculate distance to player camera
              // This ensures the 360 visual shockwave matches the hitbox.
              const dist = enemy.mesh.position.distanceTo(camera.position);
              
              // 80 units is essentially the entire visible combat corridor
              if (dist < 80) {
                  spawnExplosion(enemy.mesh.position);
                  spawnDamageText(enemy.mesh.position, 9999, true);
                  enemiesToRemove.push(idx);
              }
          });

          enemiesToRemove.sort((a, b) => b - a).forEach(idx => {
              const enemy = enemiesRef.current[idx];
              scene.remove(enemy.mesh);
              scene.remove(enemy.hitbox);
              enemiesRef.current.splice(idx, 1);
          });

          return { ...prev, beamCharges: prev.beamCharges - 1, score: prev.score + (enemiesToRemove.length * 50) };
      });
    };

    const fireRepulsor = () => {
        const now = Date.now();
        if (now - lastShotTimeRef.current < REPULSOR_COOLDOWN_MS) return;
        lastShotTimeRef.current = now;
        playSound('shoot');
        addShake(0.08);
        setIsFiring(true);
        setTimeout(() => setIsFiring(false), 100);

        if (muzzleLightRef.current) {
            muzzleLightRef.current.color.setHex(0x00ffff);
            muzzleLightRef.current.intensity = 2;
            setTimeout(() => { if (muzzleLightRef.current) muzzleLightRef.current.intensity = 0; }, 50);
        }

        const raycaster = new THREE.Raycaster();
        const mouseVec = new THREE.Vector2(
            (cursorPositionRef.current.x * 2) - 1,
            -(cursorPositionRef.current.y * 2) + 1
        );
        raycaster.setFromCamera(mouseVec, camera);
        
        const enemyHitboxes = enemiesRef.current.map(e => e.hitbox);
        const intersects = raycaster.intersectObjects(enemyHitboxes);

        let targetPoint = raycaster.ray.origin.clone().add(raycaster.ray.direction.multiplyScalar(100));
        let hitIndex = -1;

        if (intersects.length > 0) {
             targetPoint = intersects[0].point;
             hitIndex = enemiesRef.current.findIndex(e => e.hitbox === intersects[0].object);
        }

        const startPoint = new THREE.Vector3(0.25, -0.3, -0.4).applyMatrix4(camera.matrixWorld);
        const distance = startPoint.distanceTo(targetPoint);
        
        const cylGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 6);
        cylGeo.rotateX(-Math.PI / 2); 
        const mat = new THREE.MeshBasicMaterial({ color: 0xccffff });
        const beam = new THREE.Mesh(cylGeo, mat);
        
        beam.position.copy(startPoint).lerp(targetPoint, 0.5);
        beam.lookAt(targetPoint);
        beam.scale.z = distance;
        
        scene.add(beam);
        activeLinesRef.current.push({ mesh: beam, timestamp: now });

        const glowGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 6);
        glowGeo.rotateX(-Math.PI / 2);
        const glowMat = new THREE.MeshBasicMaterial({ 
            color: 0x00ffff, 
            transparent: true, 
            opacity: 0.3, 
            blending: THREE.AdditiveBlending 
        });
        const glowBeam = new THREE.Mesh(glowGeo, glowMat);
        glowBeam.position.copy(beam.position);
        glowBeam.quaternion.copy(beam.quaternion);
        glowBeam.scale.z = distance;
        scene.add(glowBeam);
        activeLinesRef.current.push({ mesh: glowBeam, timestamp: now });

        if (hitIndex !== -1) {
            setHitMarker(true);
            setTimeout(() => setHitMarker(false), 100);
            
            const enemy = enemiesRef.current[hitIndex];
            const dmg = 100; // ONE SHOT KILL UPDATE
            enemy.hp -= dmg;
            
            spawnDamageText(enemy.mesh.position, dmg);
            playSound('hit');

            if (enemy.hp <= 0) {
                destroyEnemy(hitIndex, 10);
            } else {
                (enemy.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0xffffff);
                setTimeout(() => {
                     if(enemy.mesh) (enemy.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0xff0000);
                }, 50);
            }
        }
    };

    const destroyEnemy = (index: number, points: number) => {
        const enemy = enemiesRef.current[index];
        spawnExplosion(enemy.mesh.position);
        scene.remove(enemy.mesh);
        scene.remove(enemy.hitbox);
        enemiesRef.current.splice(index, 1);
        
        setGameState(prev => ({ 
            ...prev, 
            score: prev.score + points
        }));
    };

    // --- Animation Loop ---
    let lastTime = performance.now();

    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);
      const time = performance.now();
      const delta = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;
      const now = Date.now();

      // INPUT SMOOTHING (LERP)
      cursorPositionRef.current.x = THREE.MathUtils.lerp(cursorPositionRef.current.x, targetCursorPositionRef.current.x, 0.15);
      cursorPositionRef.current.y = THREE.MathUtils.lerp(cursorPositionRef.current.y, targetCursorPositionRef.current.y, 0.15);

      if (gameState.status === 'playing') {
          setHandInput(prev => ({
              ...prev,
              x: cursorPositionRef.current.x,
              y: cursorPositionRef.current.y
          }));

          // AUTO-FORWARD MOVEMENT
          camera.position.z -= FLIGHT_SPEED * delta;

          if (gridHelperRef.current) {
            gridHelperRef.current.position.z = camera.position.z;
            gridHelperRef.current.position.x = camera.position.x;
          }
          if (starsRef.current) {
             starsRef.current.position.z = camera.position.z;
          }

          // PARALLAX AIMING
          const targetRotY = (0.5 - cursorPositionRef.current.x) * 0.6; 
          const targetRotX = (0.5 - cursorPositionRef.current.y) * 0.4;
          
          camera.rotation.y = THREE.MathUtils.lerp(camera.rotation.y, targetRotY, delta * 5);
          camera.rotation.x = THREE.MathUtils.lerp(camera.rotation.x, targetRotX, delta * 5);

          // UNIBEAM REGENERATION
          if (gameState.beamCharges < MAX_BEAM_CHARGES) {
              beamRegenTimerRef.current += delta * 1000;
              if (beamRegenTimerRef.current >= BEAM_REGEN_MS) {
                   setGameState(prev => ({
                       ...prev,
                       beamCharges: Math.min(prev.beamCharges + 1, MAX_BEAM_CHARGES)
                   }));
                   beamRegenTimerRef.current = 0;
              }
          } else {
              beamRegenTimerRef.current = 0;
          }
      }

      // Camera Shake
      if (shakeIntensityRef.current > 0) {
          const shakeX = (Math.random() - 0.5) * shakeIntensityRef.current;
          const shakeY = (Math.random() - 0.5) * shakeIntensityRef.current;
          camera.position.x += shakeX;
          camera.position.y = PLAYER_HEIGHT + shakeY;
          shakeIntensityRef.current = Math.max(0, shakeIntensityRef.current - (delta * 5));
      } else {
          camera.position.y = PLAYER_HEIGHT;
          camera.position.x = 0;
      }

      // Update Beams
      activeLinesRef.current = activeLinesRef.current.filter(l => {
          if (now - l.timestamp > 100) { 
              scene.remove(l.mesh);
              l.mesh.geometry.dispose();
              (l.mesh.material as THREE.Material).dispose();
              return false;
          }
          return true;
      });

      // Update Electrical Arcs
      for (let i = electricalArcsRef.current.length - 1; i >= 0; i--) {
          const arc = electricalArcsRef.current[i];
          arc.life -= delta;
          if (arc.life <= 0) {
              scene.remove(arc.mesh);
              electricalArcsRef.current.splice(i, 1);
          }
      }

      // Update Shockwaves
      for (let i = shockwavesRef.current.length - 1; i >= 0; i--) {
          const sw = shockwavesRef.current[i];
          sw.life += delta * 4.0; 
          const scale = 1 + (sw.life * 30.0); 
          
          if (sw.direction) {
             // Directional Ring
             sw.mesh.scale.set(scale, scale, 1);
             sw.mesh.position.add(sw.direction.clone().multiplyScalar(delta * 60));
          } else {
             // Omni Sphere (360)
             sw.mesh.scale.set(scale, scale, scale);
             // Omni shockwaves don't translate fast, they expand fast
          }
          
          const opacity = Math.max(0, 0.9 - (sw.life * 0.4));
          (sw.mesh.material as THREE.Material).opacity = opacity;
          if (sw.light) sw.light.intensity = opacity * 4;

          if (sw.life > 2.5) {
              scene.remove(sw.mesh);
              shockwavesRef.current.splice(i, 1);
          }
      }

      // Update Particles
      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const p = particlesRef.current[i];
        p.life -= delta * 2.0;
        p.mesh.position.add(p.velocity.clone().multiplyScalar(delta * 8));
        p.mesh.rotation.x += delta * 5;
        (p.mesh.material as THREE.Material).opacity = p.life;
        if (p.life <= 0) {
          scene.remove(p.mesh);
          particlesRef.current.splice(i, 1);
        }
      }

      // Update Damage Texts
      for (let i = damageTextsRef.current.length - 1; i >= 0; i--) {
          const dt = damageTextsRef.current[i];
          dt.life -= delta * 1.0;
          dt.sprite.position.add(dt.velocity.clone().multiplyScalar(delta));
          (dt.sprite.material as THREE.SpriteMaterial).opacity = dt.life;
          if (dt.life <= 0) {
              scene.remove(dt.sprite);
              damageTextsRef.current.splice(i, 1);
          }
      }

      // MediaPipe Polling
      if (videoRef.current && gestureRecognizerRef.current && videoRef.current.readyState === 4) {
          if (now - lastGestureTimeRef.current > 40) { 
            const results = gestureRecognizerRef.current.recognizeForVideo(videoRef.current, now);
            lastGestureTimeRef.current = now;
            
            let gesture = 'None';
            let detected = false;
            let x = targetCursorPositionRef.current.x; 
            let y = targetCursorPositionRef.current.y;

            if (results.landmarks && results.landmarks.length > 0) {
                detected = true;
                const hand = results.landmarks[0];
                const pointer = hand[8]; 
                x = 1.0 - pointer.x; 
                y = pointer.y;
                if (results.gestures.length > 0) gesture = results.gestures[0][0].categoryName;
                
                targetCursorPositionRef.current = { x, y };
            }

            setHandInput(prev => ({ ...prev, detected, gesture })); 

            if (detected && gameState.status === 'playing') {
                if (gesture === "Closed_Fist") fireRepulsor();
                else if (gesture === "Open_Palm") triggerUnibeam();
            }
          }
      }

      if (gameState.status !== 'playing') return;

      // Game Timer
      const elapsedWave = (now - waveStartTimeRef.current) / 1000;
      const remaining = Math.max(0, WAVE_DURATION_SEC - elapsedWave);
      setTimer(remaining);

      if (remaining <= 0) {
         setGameState(prev => ({ ...prev, wave: prev.wave + 1 }));
         waveStartTimeRef.current = now;
      }

      // Enemy Spawning - REDUCED RATE
      const targetEnemyCount = Math.min(15, 2 + (gameState.wave * 2));
      if (enemiesRef.current.length < targetEnemyCount && Math.random() < 0.015) {
          const spawnDistance = 60;
          const spawnZ = camera.position.z - spawnDistance;
          const spawnX = camera.position.x + (Math.random() - 0.5) * 30; 
          const spawnY = camera.position.y + (Math.random() * 8) - 2;
          
          const mesh = new THREE.Mesh(sharedGeometriesRef.current!.enemy, sharedMaterialsRef.current!.enemy);
          const ring = new THREE.Mesh(sharedGeometriesRef.current!.enemyRing, sharedMaterialsRef.current!.enemyRing);
          mesh.add(ring);

          const hitbox = new THREE.Mesh(sharedGeometriesRef.current!.hitbox, new THREE.MeshBasicMaterial({ visible: false }));
          
          mesh.position.set(spawnX, spawnY, spawnZ);
          hitbox.position.copy(mesh.position);
          
          scene.add(mesh);
          scene.add(hitbox);

          enemiesRef.current.push({ 
              id: Math.random().toString(), 
              mesh, 
              hitbox,
              hp: 100, 
              maxHp: 100,
              wobbleOffset: Math.random() * Math.PI * 2,
              speedOffset: Math.random() * 2,
              velocity: new THREE.Vector3(0, 0, 0)
          });
      }

      // Enemy Logic
      for (let i = enemiesRef.current.length - 1; i >= 0; i--) {
          const enemy = enemiesRef.current[i];
          
          const approachSpeed = 5.0 + (gameState.wave * 0.3) + enemy.speedOffset;
          const targetPos = camera.position.clone();
          targetPos.y = 1.0; 
          
          const desiredDir = targetPos.sub(enemy.mesh.position).normalize();
          const distToPlayer = enemy.mesh.position.distanceTo(camera.position);
          
          const steerFactor = distToPlayer < 20 ? 0.5 * delta : 5.0 * delta;
          
          const currentDir = enemy.velocity.clone().normalize();
          if (currentDir.length() === 0) enemy.velocity.copy(desiredDir);

          const newDir = currentDir.lerp(desiredDir, steerFactor).normalize();
          enemy.velocity.copy(newDir).multiplyScalar(approachSpeed);
          
          enemy.mesh.position.add(enemy.velocity.clone().multiplyScalar(delta));
          enemy.hitbox.position.copy(enemy.mesh.position);

          enemy.mesh.children[0].rotation.z += 5 * delta;
          enemy.mesh.lookAt(camera.position);

          const pX = camera.position.x;
          const pZ = camera.position.z;
          const ePos = enemy.mesh.position;
          const hitRadius = 1.5; // Collision radius increased for bigger enemies
          const pWidth = 0.5; 
          const pHeight = 1.8;
          const pDepth = 0.5;

          const collisionX = Math.abs(ePos.x - pX) < (pWidth + hitRadius);
          const collisionZ = Math.abs(ePos.z - pZ) < (pDepth + hitRadius);
          const collisionY = ePos.y < (pHeight + hitRadius) && ePos.y > -hitRadius;

          if (collisionX && collisionZ && collisionY) {
              spawnExplosion(camera.position.clone().add(new THREE.Vector3(0,0,-1))); 
              addShake(1.0);
              destroyEnemy(i, 0); 
              
              setGameState(prev => {
                  const newHp = prev.health - 20;
                  if (newHp <= 20 && newHp > 0) playSound('low_hp');
                  if (newHp <= 0) {
                      document.exitPointerLock();
                      submitScore(prev.score);
                      return { ...prev, health: 0, status: 'gameover' };
                  }
                  return { ...prev, health: newHp };
              });
          }
          else if (enemy.mesh.position.z > camera.position.z + 20) {
              scene.remove(enemy.mesh);
              scene.remove(enemy.hitbox);
              enemiesRef.current.splice(i, 1);
          }
      }
      renderer.render(scene, camera);
    };

    frameIdRef.current = requestAnimationFrame(animate);

    const handleResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mousedown', handleMouseDown);
      cancelAnimationFrame(frameIdRef.current);
      if (mountRef.current) mountRef.current.removeChild(renderer.domElement);
    };
  }, [gameState.status, gameState.wave, playSound]); 

  // --- Helper: Submit Score ---
  const submitScore = async (finalScore: number) => {
      if (!dbRef.current || !userIdRef.current || !__app_id) return;
      try {
          await addDoc(collection(dbRef.current, `artifacts/${__app_id}/public/data/stark_protocol_scores`), {
              nickname: nickname,
              score: finalScore,
              userId: userIdRef.current,
              timestamp: serverTimestamp()
          });
      } catch(e) {
          console.error("Score submit fail", e);
      }
  };

  // --- Handlers ---
  const startGame = () => {
    if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
    }

    setGameState({
        status: 'playing',
        health: 100,
        score: 0,
        wave: 1,
        enemies: [],
        beamCharges: 5 // Start fully charged
    });
    waveStartTimeRef.current = Date.now();
    beamRegenTimerRef.current = 0; 
    
    enemiesRef.current.forEach(e => {
        sceneRef.current?.remove(e.mesh);
        sceneRef.current?.remove(e.hitbox);
    });
    enemiesRef.current = [];
    particlesRef.current.forEach(p => {
      sceneRef.current?.remove(p.mesh);
      // Do not dispose material/geo as they are shared now
    });
    particlesRef.current = [];
    damageTextsRef.current.forEach(t => sceneRef.current?.remove(t.sprite));
    damageTextsRef.current = [];
    
    if (cameraRef.current) {
        cameraRef.current.rotation.set(0, 0, 0);
        cameraRef.current.position.set(0, PLAYER_HEIGHT, 0);
    }
  };

  return (
    <div className="relative w-full h-full bg-black text-white overflow-hidden">
      <div ref={mountRef} className="w-full h-screen cursor-none" />
      <HUD 
        gameState={gameState} 
        timer={timer} 
        onStart={startGame} 
        hitMarker={hitMarker}
        isFiring={isFiring}
        handInput={handInput}
      />

      {/* Camera Feed & Gesture Guides */}
      <div className="absolute bottom-6 right-6 z-40 flex flex-col items-end gap-2 pointer-events-none">
          <div className="bg-slate-900/80 border border-cyan-500/30 p-3 rounded-md backdrop-blur w-48 pointer-events-auto">
             <h4 className="text-cyan-400 text-[10px] font-bold tracking-widest border-b border-cyan-500/30 pb-1 mb-2">GESTURE COMMANDS</h4>
             <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-slate-300 font-mono">FIRE</span>
                <div className="flex items-center gap-2">
                    <span className="text-[9px] text-cyan-600 uppercase">Closed Fist</span>
                    <div className="w-2 h-2 bg-red-500 rounded-sm shadow-[0_0_5px_red]"></div>
                </div>
             </div>
             <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-slate-300 font-mono">UNIBEAM</span>
                <div className="flex items-center gap-2">
                    <span className="text-[9px] text-cyan-600 uppercase">Open Palm</span>
                    <div className="w-2 h-2 bg-blue-400 rounded-sm shadow-[0_0_5px_#3b82f6]"></div>
                </div>
             </div>
             <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-300 font-mono">AIM</span>
                <div className="flex items-center gap-2">
                    <span className="text-[9px] text-cyan-600 uppercase">Move Hand</span>
                    <div className="w-2 h-2 border border-cyan-400 rounded-full"></div>
                </div>
             </div>
          </div>

          <div className="relative w-48 h-36 border border-cyan-500/50 rounded-lg overflow-hidden shadow-[0_0_15px_rgba(6,182,212,0.3)] bg-black">
             <video 
                ref={videoRef} 
                className="w-full h-full object-cover scale-x-[-1]" 
                autoPlay 
                playsInline 
                muted 
             />
             <div className="absolute top-1 left-2 text-[9px] text-cyan-400 font-mono tracking-widest bg-black/50 px-1 rounded">SYS.OPTICS // LIVE</div>
          </div>
      </div>

      {/* Leaderboard */}
      {gameState.status !== 'playing' && (
        <div className="absolute right-8 top-8 w-64 bg-slate-900/80 border border-cyan-500/30 p-4 backdrop-blur max-h-[80vh] overflow-y-auto z-50">
            <h3 className="text-cyan-400 font-bold tracking-widest mb-4 border-b border-cyan-500/30 pb-2">TOP AGENTS</h3>
            <table className="w-full text-sm text-left">
                <thead>
                    <tr className="text-slate-500 text-xs">
                        <th className="pb-2">ID</th>
                        <th className="pb-2 text-right">PTS</th>
                    </tr>
                </thead>
                <tbody>
                    {leaderboard.map((entry, idx) => (
                        <tr key={entry.id} className="border-b border-slate-800/50 hover:bg-cyan-500/5">
                            <td className="py-2 text-cyan-100 font-mono truncate max-w-[100px]">{idx + 1}. {entry.nickname}</td>
                            <td className="py-2 text-right text-yellow-400 font-bold">{entry.score}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {gameState.status === 'gameover' && (
                <div className="mt-4 pt-4 border-t border-cyan-500/30">
                    <label className="text-xs text-slate-500 block mb-1">CALLSIGN</label>
                    <input 
                        type="text" 
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value.toUpperCase())}
                        className="w-full bg-slate-950 border border-slate-700 text-cyan-300 px-2 py-1 text-sm focus:border-cyan-500 outline-none uppercase"
                        maxLength={10}
                    />
                </div>
            )}
        </div>
      )}
    </div>
  );
};

export default App;