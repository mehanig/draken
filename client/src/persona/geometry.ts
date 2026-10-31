import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export class StudioAssets {
  geometries = new Set<THREE.BufferGeometry>();
  materials = new Set<THREE.Material>();
  textures = new Set<THREE.Texture>();
  material(parameters: THREE.MeshPhysicalMaterialParameters) {
    const value = new THREE.MeshPhysicalMaterial(parameters); this.materials.add(value); return value;
  }
  texture(canvas: HTMLCanvasElement, repeat = 1) {
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(repeat, repeat); texture.anisotropy = 4;
    this.textures.add(texture); return texture;
  }
  mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, position: number[] = [0, 0, 0]) {
    this.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  box(parent: THREE.Object3D, size: number[], position: number[], material: THREE.Material, radius = 0.025) {
    return this.mesh(parent, new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(radius, Math.min(...size) * 0.45)), material, position);
  }
  sphere(parent: THREE.Object3D, size: number[], position: number[], material: THREE.Material) {
    const mesh = this.mesh(parent, new THREE.SphereGeometry(1, 28, 18), material, position); mesh.scale.set(size[0], size[1], size[2]); return mesh;
  }
  cylinder(parent: THREE.Object3D, a: number[], b: number[], radius: number, material: THREE.Material, endRadius = radius) {
    const start = new THREE.Vector3(...a as [number, number, number]), end = new THREE.Vector3(...b as [number, number, number]);
    const mesh = this.mesh(parent, new THREE.CylinderGeometry(endRadius, radius, start.distanceTo(end), 20), material);
    mesh.position.copy(start.add(end).multiplyScalar(0.5)); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...b as [number, number, number]).sub(new THREE.Vector3(...a as [number, number, number])).normalize()); return mesh;
  }
  tube(parent: THREE.Object3D, points: number[][], radius: number, material: THREE.Material) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p as [number, number, number])));
    return this.mesh(parent, new THREE.TubeGeometry(curve, 28, radius, 8, false), material);
  }
  tapered(parent: THREE.Object3D, points: number[][], radius: number, material: THREE.Material) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p as [number, number, number])));
    const steps = 28, sides = 12, frames = curve.computeFrenetFrames(steps, false), positions: number[] = [], indices: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const center = curve.getPointAt(i / steps), r = radius * Math.pow(1 - i / steps, 0.8) + 0.001;
      for (let j = 0; j <= sides; j++) {
        const angle = j / sides * Math.PI * 2;
        const p = center.clone().addScaledVector(frames.normals[i], Math.cos(angle) * r).addScaledVector(frames.binormals[i], Math.sin(angle) * r);
        positions.push(p.x, p.y, p.z);
        if (i < steps && j < sides) { const n = i * (sides + 1) + j; indices.push(n, n + sides + 1, n + 1, n + 1, n + sides + 1, n + sides + 2); }
      }
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    return this.mesh(parent, geometry, material);
  }
  dispose() {
    this.geometries.forEach(g => g.dispose()); this.materials.forEach(m => m.dispose()); this.textures.forEach(t => t.dispose());
    this.geometries.clear(); this.materials.clear(); this.textures.clear();
  }
}

function canvas(size = 512) { const c = document.createElement('canvas'); c.width = c.height = size; return { canvas: c, ctx: c.getContext('2d')! }; }
function random(seed: number) { return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }; }

export function createMaterials(a: StudioAssets) {
  const wood = (base: string, grain: string) => {
    const c = canvas(); const rand = random(81); c.ctx.fillStyle = base; c.ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 950; i++) {
      const y = rand() * 512; c.ctx.strokeStyle = grain; c.ctx.globalAlpha = 0.04 + rand() * 0.12; c.ctx.lineWidth = 0.3 + rand() * 1.1;
      c.ctx.beginPath(); c.ctx.moveTo(0, y); c.ctx.bezierCurveTo(120, y + rand() * 12, 350, y - rand() * 8, 512, y + rand() * 4); c.ctx.stroke();
    }
    return a.texture(c.canvas);
  };
  const knit = canvas(256); knit.ctx.fillStyle = '#bf9a52'; knit.ctx.fillRect(0, 0, 256, 256);
  for (let y = -16; y < 272; y += 16) for (let x = 0; x < 256; x += 16) {
    knit.ctx.lineCap = 'round'; knit.ctx.strokeStyle = '#8b6e3b'; knit.ctx.lineWidth = 5;
    knit.ctx.beginPath(); knit.ctx.moveTo(x + 3, y + 2); knit.ctx.lineTo(x + 8, y + 14); knit.ctx.lineTo(x + 13, y + 2); knit.ctx.stroke();
    knit.ctx.strokeStyle = '#e3c888'; knit.ctx.lineWidth = 2;
    knit.ctx.beginPath(); knit.ctx.moveTo(x + 4, y + 2); knit.ctx.lineTo(x + 8, y + 12); knit.ctx.lineTo(x + 12, y + 2); knit.ctx.stroke();
  }
  const weave = a.texture(knit.canvas, 2.5);
  const plaster = canvas(); const rand = random(71); plaster.ctx.fillStyle = '#7b8a7d'; plaster.ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 16000; i++) { plaster.ctx.fillStyle = rand() > 0.5 ? '#d3d3be' : '#6d8176'; plaster.ctx.globalAlpha = 0.1; plaster.ctx.fillRect(rand() * 512, rand() * 512, 1.5, 1.5); }
  const oak = wood('#9c754b', '#352818'), redWood = wood('#934b39', '#331b12');
  const blue = a.material({ color: '#486872', metalness: 0.5, roughness: 0.36, clearcoat: 0.3, clearcoatRoughness: 0.3 });
  return {
    blue, darkBlue: a.material({ color: '#273e48', metalness: 0.4, roughness: 0.43 }),
    red: a.material({ map: redWood, bumpMap: redWood, bumpScale: 0.007, roughness: 0.5, clearcoat: 0.15 }),
    oak: a.material({ map: oak, bumpMap: oak, bumpScale: 0.006, roughness: 0.52, clearcoat: 0.12 }),
    knit: a.material({ map: weave, bumpMap: weave, bumpScale: 0.035, roughness: 0.94, sheen: 0.55, sheenColor: '#dac594' }),
    brass: a.material({ color: '#ba9661', metalness: 0.77, roughness: 0.36 }),
    iron: a.material({ color: '#202b2e', metalness: 0.65, roughness: 0.46 }),
    ivory: a.material({ color: '#ede1ba', roughness: 0.43 }),
    amber: a.material({ color: '#edc96b', roughness: 0.2, metalness: 0.16, clearcoat: 1, emissive: '#b88b36', emissiveIntensity: 0.12 }),
    black: a.material({ color: '#101718', roughness: 0.42 }),
    tongue: a.material({ color: '#9c6050', roughness: 0.7 }),
    membrane: a.material({ color: '#bda064', roughness: 0.9, side: THREE.DoubleSide }),
    wall: a.material({ map: a.texture(plaster.canvas, 2), roughness: 1 }),
    cream: a.material({ color: '#ded2b5', roughness: 0.86 }),
    green: a.material({ color: '#2d573d', roughness: 0.68, side: THREE.DoubleSide }),
    terracotta: a.material({ color: '#9b6650', roughness: 0.9 }),
    paper: a.material({ color: '#e4dbc3', roughness: 0.88 }),
    glow: a.material({ color: '#ffdf9c', emissive: '#ffcb75', emissiveIntensity: 2, roughness: 1 }),
  };
}
export type StudioMaterials = ReturnType<typeof createMaterials>;
