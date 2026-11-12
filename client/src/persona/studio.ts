import * as THREE from 'three';
import { StudioAssets, type StudioMaterials } from './geometry';

/** A quiet call backdrop. Room details sit behind the focus plane; only the
 * seated character, chair and uncluttered desk belong to the sharp foreground. */
export function createStudio(room: THREE.Scene, foreground: THREE.Scene, a: StudioAssets, m: StudioMaterials) {
  a.box(room, [12, 0.10, 12], [0, -0.07, 0], a.material({ color: '#827565', roughness: 1 })).castShadow = false;
  a.box(room, [11, 6, 0.16], [0, 2.8, -2.2], m.wall).castShadow = false;
  a.box(room, [0.16, 6, 9], [-4.5, 2.8, 0], m.cream).castShadow = false;
  const sky = document.createElement('canvas'); sky.width = 64; sky.height = 256;
  const ctx = sky.getContext('2d')!, gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#405d68'); gradient.addColorStop(0.7, '#8ba09d'); gradient.addColorStop(1, '#b7b49c');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 256);
  const skyTexture = a.texture(sky);
  const pane = a.material({ map: skyTexture, emissive: '#b1c6c9', emissiveMap: skyTexture, emissiveIntensity: 0.25, roughness: 1 });
  a.box(room, [2.05, 2.48, 0.1], [-2.65, 2.48, -2.08], m.darkBlue, 0.025);
  a.box(room, [1.90, 2.33, 0.035], [-2.65, 2.48, -2.01], pane, 0.005);
  a.box(room, [0.045, 2.35, 0.06], [-2.65, 2.48, -1.97], m.darkBlue, 0.005);
  a.box(room, [2.20, 0.09, 0.30], [-2.65, 1.21, -1.9], m.oak);
  a.box(room, [1.65, 0.86, 0.55], [2.0, 0.54, -1.60], m.oak, 0.04);
  a.mesh(room, new THREE.CylinderGeometry(0.25, 0.20, 0.42, 32), m.terracotta, [2.0, 1.18, -1.58]);
  a.mesh(room, new THREE.CylinderGeometry(0.225, 0.225, 0.02, 32), m.iron, [2.0, 1.39, -1.58]);
  for (let i = 0; i < 6; i++) {
    const angle = i * 2.4, y = 1.60 + i * 0.14, x = 2.0 + Math.sin(angle) * 0.30, z = -1.58 + Math.cos(angle) * 0.26;
    a.tube(room, [[2.0, 1.38, -1.58], [2.0, y - 0.1, -1.58], [x, y, z]], 0.012, m.green);
    const leaf = a.sphere(room, [0.11, 0.018, 0.24], [x, y, z], m.green); leaf.rotation.set(0.4, angle, -Math.sin(angle) * 0.3);
  }
  a.mesh(room, new THREE.CylinderGeometry(0.27, 0.30, 0.06, 32), m.darkBlue, [-1.9, 0.04, -1.3]);
  a.cylinder(room, [-1.9, 0.07, -1.3], [-1.9, 1.90, -1.3], 0.022, m.brass);
  a.mesh(room, new THREE.CylinderGeometry(0.22, 0.35, 0.39, 32, 1, true), m.cream, [-1.9, 2.0, -1.3]);
  a.sphere(room, [0.23, 0.015, 0.23], [-1.9, 1.81, -1.3], m.glow);
  const lamp = new THREE.PointLight('#ffd6a4', 5, 4, 2); lamp.position.set(-1.9, 1.80, -1.3); room.add(lamp); foreground.add(lamp.clone());
  a.box(foreground, [1.18, 1.30, 0.18], [0, 1.30, -0.65], m.darkBlue, 0.16);
  a.box(foreground, [1.12, 0.16, 0.9], [0, 0.72, -0.24], m.darkBlue, 0.07);
  a.cylinder(foreground, [0, 0.16, -0.3], [0, 0.68, -0.3], 0.07, m.iron);
  a.box(foreground, [4.9, 0.16, 2.10], [0, 0.94, 1.10], m.oak, 0.055);
  for (const x of [-2.15, 2.15]) for (const z of [0.34, 1.88]) a.box(foreground, [0.08, 0.91, 0.08], [x, 0.43, z], m.iron, 0.015);
}
