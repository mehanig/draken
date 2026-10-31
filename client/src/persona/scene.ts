import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { StudioAssets, createMaterials } from './geometry';
import { createStudio } from './studio';
import { createDragon } from './dragon';
import { PersonaMotion } from './motion';
import { SoftBackground } from './background';
import type { PersonaInput, PersonaScene } from './types';

/** Imperative renderer. The host owns scheduling/visibility; this module never
 * acquires a microphone, plays audio, fetches data, or knows about Draken's API. */
export function createPersonaScene(canvas: HTMLCanvasElement): PersonaScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  const assets = new StudioAssets(); const scene = new THREE.Scene(), backdrop = new THREE.Scene();
  const motion = new PersonaMotion();
  let environment: THREE.WebGLRenderTarget | undefined, background: SoftBackground | undefined;
  try {
    const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
    const software = info ? /swiftshader|llvmpipe|software/i.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : false;
    const pixelBudget = software ? 160000 : 900000;
    canvas.dataset.quality = software ? 'economy' : 'full';
    renderer.shadowMap.enabled = !software; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    backdrop.background = new THREE.Color('#849087');
    const generator = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    try { environment = generator.fromScene(room, 0.04); scene.environment = environment.texture; scene.environmentIntensity = 0.30; }
    finally { room.dispose(); generator.dispose(); }
    backdrop.environment = scene.environment; backdrop.environmentIntensity = scene.environmentIntensity;
    scene.add(new THREE.HemisphereLight('#dde7e4', '#64513a', 0.65));
    const key = new THREE.DirectionalLight('#ffead0', 2.1); key.position.set(-3, 6, 4); key.castShadow = true;
    key.shadow.mapSize.set(software ? 512 : 1024, software ? 512 : 1024); key.shadow.camera.left = -4; key.shadow.camera.right = 4; key.shadow.camera.top = 5; key.shadow.camera.bottom = -3;
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 18; key.shadow.normalBias = 0.035; key.shadow.bias = -0.0001; scene.add(key);
    const fill = new THREE.DirectionalLight('#a3cad6', 1.0); fill.position.set(3.5, 3.8, -0.8); scene.add(fill);
    const front = new THREE.DirectionalLight('#ffe7c4', 0.45); front.position.set(0.5, 3, 5); scene.add(front);
    const materials = createMaterials(assets);
    if (software) assets.materials.forEach(material => {
      if (material instanceof THREE.MeshPhysicalMaterial) { material.clearcoat = 0; material.sheen = 0; }
    });
    scene.children.forEach(light => { if (light instanceof THREE.Light) { const copy = light.clone(); copy.castShadow = false; backdrop.add(copy); } });
    createStudio(backdrop, scene, assets, materials);
    const dragon = createDragon(scene, assets, materials);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 35);
    camera.position.set(1.3, 2.65, 5.8); camera.lookAt(0, 2.12, 0.15);
    background = new SoftBackground(renderer);
    let input: PersonaInput = { mode: 'idle', motion: true, playback: null }, last = 0, lastShadow = -1, width = 0, height = 0, disposed = false;
    return {
      maxFps: software ? 10 : 30,
      update(next) { input = next; },
      resize(nextWidth, nextHeight) {
        if (disposed || !nextWidth || !nextHeight || (width === nextWidth && height === nextHeight)) return;
        width = nextWidth; height = nextHeight;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, software ? 1 : 1.5, Math.sqrt(pixelBudget / (width * height))));
        renderer.setSize(width, height, false); camera.aspect = width / height;
        camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(16)) * Math.max(1, 1.45 / camera.aspect)));
        camera.updateProjectionMatrix(); background!.resize(width, height);
      },
      render(time) {
        if (disposed) return;
        const pose = motion.sample(input, time, last ? time - last : 1 / 30); last = time;
        dragon.update(pose);
        if (time - lastShadow > (software ? 1.5 : 0.5)) { renderer.shadowMap.needsUpdate = true; lastShadow = time; }
        background!.render(backdrop, camera, scene);
        canvas.dataset.background = 'blurred'; canvas.dataset.backgroundRenders = String(background!.renders);
        // Small presentation diagnostics; never expose text or audio samples.
        canvas.dataset.mouth = String(Math.round(pose.jaw * 100));
      },
      dispose() {
        if (disposed) return; disposed = true; input = { mode: 'ended', motion: false, playback: null };
        motion.dispose(); key.shadow.dispose(); background?.dispose(); assets.dispose(); environment?.dispose(); scene.clear(); backdrop.clear();
        renderer.dispose(); renderer.forceContextLoss(); delete canvas.dataset.mouth;
      },
    };
  } catch (error) {
    background?.dispose(); assets.dispose(); environment?.dispose(); scene.clear(); backdrop.clear(); renderer.dispose(); renderer.forceContextLoss(); throw error;
  }
}
