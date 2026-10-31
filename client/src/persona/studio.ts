import * as THREE from 'three';
import { StudioAssets, type StudioMaterials } from './geometry';

/** Quiet, human-scale workshop. No external textures, HDRIs, fonts or telemetry. */
export function createStudio(scene: THREE.Scene, a: StudioAssets, m: StudioMaterials) {
  const floor = a.material({ color: '#938571', map: m.oak.map, roughness: 0.75 });
  for (let i = 0; i < 18; i++) a.box(scene, [0.65, 0.10, 12], [-5.8 + i * 0.665, -0.07, 0], floor, 0.004).castShadow = false;
  a.box(scene, [11, 6, 0.16], [0, 2.8, -2.2], m.wall).castShadow = false;
  a.box(scene, [0.16, 6, 9], [-4.5, 2.8, 0], m.cream).castShadow = false;
  // Architectural rails, oak acoustic slats, subtle indirect amber strip.
  for (let i = 0; i < 15; i++) a.box(scene, [0.075, 3.7, 0.055], [1.7 + i * 0.17, 1.95, -2.08], m.oak, 0.01);
  a.box(scene, [2.5, 0.025, 0.035], [2.85, 3.82, -2.02], m.glow, 0.003);
  // A dusk window with softly luminous panes and distant architectural silhouettes.
  const sky = document.createElement('canvas'); sky.width = 256; sky.height = 512;
  const ctx = sky.getContext('2d')!; const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#294959'); gradient.addColorStop(0.65, '#8ba8a7'); gradient.addColorStop(1, '#d1bd97'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 16; i++) { const h = 30 + (i * 29 % 90); ctx.fillStyle = '#4b6a71'; ctx.fillRect(i * 19, 512 - h, 14, h); }
  const pane = a.material({ map: a.texture(sky), emissive: '#b1c6c9', emissiveMap: a.texture(sky), emissiveIntensity: 0.5, roughness: 1 });
  a.box(scene, [2.3, 2.55, 0.1], [-2.48, 2.52, -2.08], m.iron, 0.025);
  a.box(scene, [2.12, 2.36, 0.035], [-2.48, 2.52, -2.01], pane, 0.005);
  for (const x of [-3.58, -2.48, -1.38]) a.box(scene, [0.045, 2.4, 0.06], [x, 2.52, -1.97], m.iron, 0.005);
  a.box(scene, [2.3, 0.055, 0.08], [-2.48, 2.48, -1.96], m.iron);
  a.box(scene, [2.56, 0.12, 0.40], [-2.48, 1.21, -1.9], m.oak);
  // Small workshop shelves, books and an analogue clock, not a busy dashboard.
  for (const y of [1.35, 2.75]) a.box(scene, [1.35, 0.075, 0.4], [0.33, y, -1.91], m.oak);
  for (let i = 0; i < 6; i++) {
    const book = a.box(scene, [0.1, 0.35 + i % 3 * 0.07, 0.24], [-0.15 + i * 0.13, 1.58 + i % 3 * 0.035, -1.87], [m.red, m.darkBlue, m.cream][i % 3], 0.008);
    book.rotation.z = i === 5 ? -0.12 : 0;
    a.box(book, [0.065, 0.012, 0.007], [0, 0.10, 0.124], m.brass, 0.002);
  }
  const clock = new THREE.Group(); clock.position.set(0.22, 3.02, -1.84); scene.add(clock);
  a.sphere(clock, [0.23, 0.23, 0.06], [0, 0, 0], m.darkBlue);
  a.sphere(clock, [0.20, 0.20, 0.017], [0, 0, 0.055], m.cream);
  a.box(clock, [0.014, 0.13, 0.01], [0, 0.055, 0.075], m.iron, 0.003);
  const hand = a.box(clock, [0.1, 0.015, 0.01], [0.036, -0.025, 0.077], m.iron, 0.003); hand.rotation.z = -0.5;
  // Framed geometric print, a quiet nod to the shared Bauhaus family identity.
  a.box(scene, [0.71, 0.94, 0.06], [3.4, 2.65, -1.99], m.darkBlue);
  a.box(scene, [0.62, 0.85, 0.01], [3.4, 2.65, -1.95], m.paper, 0.002);
  const purple = a.material({ color: '#76588a', roughness: 1 });
  const disk = a.mesh(scene, new THREE.CircleGeometry(0.18, 48), m.red, [3.35, 2.79, -1.939]); disk.castShadow = false;
  a.box(scene, [0.26, 0.25, 0.008], [3.52, 2.48, -1.933], purple, 0.001);
  // Ergonomic upholstered chair.
  a.box(scene, [1.18, 1.30, 0.18], [0, 1.30, -0.65], m.darkBlue, 0.16);
  a.box(scene, [1.12, 0.16, 0.9], [0, 0.72, -0.24], m.darkBlue, 0.07);
  a.cylinder(scene, [0, 0.16, -0.3], [0, 0.68, -0.3], 0.07, m.iron);
  // Wide solid-oak desk and slim powder-coated legs.
  a.box(scene, [4.9, 0.16, 2.10], [0, 0.94, 1.10], m.oak, 0.055);
  for (const x of [-2.15, 2.15]) for (const z of [0.34, 1.88]) a.box(scene, [0.08, 0.91, 0.08], [x, 0.43, z], m.iron, 0.015);
  a.box(scene, [1.40, 0.012, 0.75], [0.10, 1.028, 1.15], m.darkBlue, 0.04);
  // Closed notebook, pencil, ceramic mug and a restrained laptop screen edge.
  const notebook = a.box(scene, [0.48, 0.05, 0.34], [1.35, 1.065, 1.48], m.red, 0.013); notebook.rotation.y = -0.17;
  a.box(notebook, [0.44, 0.025, 0.31], [0, 0.003, 0], m.paper, 0.002);
  a.cylinder(scene, [1.08, 1.11, 1.47], [1.56, 1.11, 1.29], 0.012, m.brass);
  a.mesh(scene, new THREE.CylinderGeometry(0.13, 0.11, 0.23, 40, 1, true), m.cream, [-1.05, 1.14, 1.25]);
  a.mesh(scene, new THREE.CylinderGeometry(0.106, 0.106, 0.006, 40), a.material({ color: '#39271e', roughness: 0.2 }), [-1.05, 1.23, 1.25]);
  const mugHandle = a.mesh(scene, new THREE.TorusGeometry(0.095, 0.024, 10, 28), m.cream, [-1.20, 1.15, 1.25]); mugHandle.rotation.y = Math.PI / 2;
  const laptop = new THREE.Group(); laptop.position.set(0.1, 1.04, 1.74); laptop.rotation.y = -0.06; scene.add(laptop);
  a.box(laptop, [0.88, 0.035, 0.50], [0, 0, 0], m.iron, 0.02);
  const lid = a.box(laptop, [0.88, 0.53, 0.028], [0, 0.25, 0.17], m.darkBlue, 0.025); lid.rotation.x = -0.12;
  a.box(lid, [0.15, 0.018, 0.007], [0, 0, 0.02], m.brass, 0.003);
  // Adjustable task lamp: warm practical light, distinct from the window key.
  a.mesh(scene, new THREE.CylinderGeometry(0.22, 0.25, 0.045, 40), m.iron, [-1.95, 1.05, 0.5]);
  a.cylinder(scene, [-1.95, 1.08, 0.5], [-2.0, 1.83, 0.48], 0.025, m.brass);
  a.cylinder(scene, [-2.0, 1.83, 0.48], [-1.61, 2.03, 0.56], 0.026, m.brass);
  const shade = a.mesh(scene, new THREE.ConeGeometry(0.25, 0.22, 40, 1, true), m.red, [-1.57, 1.96, 0.57]); shade.rotation.z = -0.17;
  a.sphere(scene, [0.17, 0.02, 0.17], [-1.55, 1.86, 0.57], m.glow);
  const lamp = new THREE.PointLight('#ffd39c', 9, 5, 2); lamp.position.set(-1.55, 1.80, 0.57); scene.add(lamp);
  // Rubber plant with bowed leaves, ceramic planter and visible soil.
  a.mesh(scene, new THREE.CylinderGeometry(0.27, 0.21, 0.48, 32), m.terracotta, [1.97, 1.27, 0.28]);
  a.mesh(scene, new THREE.CylinderGeometry(0.245, 0.245, 0.02, 32), m.iron, [1.97, 1.50, 0.28]);
  for (let i = 0; i < 8; i++) {
    const angle = i * 2.4, y = 1.70 + i * 0.105, x = 1.97 + Math.sin(angle) * 0.28, z = 0.28 + Math.cos(angle) * 0.28;
    a.tube(scene, [[1.97, 1.49, 0.28], [1.96, y - 0.1, 0.28], [x, y, z]], 0.012, m.green);
    const leaf = a.sphere(scene, [0.105, 0.025, 0.23], [x, y, z], m.green); leaf.rotation.set(0.3 + i % 2 * 0.2, angle, -Math.sin(angle) * 0.3);
  }
}
