import * as THREE from 'three';
import { StudioAssets, type StudioMaterials } from './geometry';
import type { DragonPose } from './types';

/** Articulated, replaceable character rig. All coordinates are local metres.
 * Identity reference: site/img/scene1-web.jpg; no downloaded character assets. */
export function createDragon(parent: THREE.Object3D, a: StudioAssets, m: StudioMaterials) {
  const root = new THREE.Group(); parent.add(root); root.position.set(0, 0, -0.12); root.rotation.y = 0.12;
  const chest = new THREE.Group(); root.add(chest);
  a.sphere(chest, [0.56, 0.64, 0.38], [0, 1.48, 0], m.knit);
  a.box(chest, [0.42, 0.48, 0.12], [0, 1.53, 0.35], m.blue, 0.12);
  for (let i = 0; i < 5; i++) a.box(chest, [0.27, 0.018, 0.025], [0, 1.40 + i * 0.06, 0.418], m.iron, 0.008);
  a.sphere(chest, [0.018, 0.018, 0.012], [0.13, 1.75, 0.415], m.glow);
  a.cylinder(chest, [0, 1.93, 0], [0, 2.19, 0.05], 0.24, m.darkBlue, 0.22);
  for (let i = 0; i < 4; i++) {
    const ring = a.mesh(chest, new THREE.TorusGeometry(0.236, 0.025, 8, 32), m.brass, [0, 1.99 + i * 0.055, 0.02]); ring.rotation.x = Math.PI / 2;
  }
  const wings: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const wing = new THREE.Group(); wing.position.set(side * 0.43, 1.87, -0.33); wing.scale.x = side; wing.rotation.y = side * -0.28; root.add(wing); wings.push(wing);
    const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(0.20, 0.89); shape.lineTo(1.15, 0.73);
    shape.quadraticCurveTo(0.91, 0.62, 0.94, 0.37); shape.quadraticCurveTo(0.64, 0.40, 0.55, 0.08); shape.quadraticCurveTo(0.28, 0.19, 0, 0);
    a.mesh(wing, new THREE.ShapeGeometry(shape, 24), m.membrane, [0, 0, 0.005]);
    for (const [p, q] of [ [[0, 0, 0], [0.20, 0.89, 0]], [[0.20, 0.89, 0], [1.15, 0.73, 0]], [[0.20, 0.89, 0], [0.94, 0.37, 0]], [[0.20, 0.89, 0], [0.55, 0.08, 0]] ]) a.cylinder(wing, p, q, 0.042, m.red);
    for (const p of [[0, 0, 0.035], [0.20, 0.89, 0.035]]) {
      a.sphere(wing, [0.075, 0.075, 0.035], p, m.darkBlue); a.sphere(wing, [0.032, 0.032, 0.016], [p[0], p[1], p[2] + 0.025], m.brass);
    }
  }
  a.tapered(root, [[0.28, 0.82, -0.24], [0.88, 0.44, -0.48], [1.38, 0.32, -0.04], [1.52, 0.58, 0.46], [1.25, 0.79, 0.55]], 0.22, m.blue);
  for (let i = 0; i < 5; i++) {
    const spike = a.mesh(root, new THREE.ConeGeometry(0.095 - i * 0.008, 0.18, 4), m.red, [0.6 + i * 0.19, 0.63 - Math.sin(i * 0.6) * 0.1, -0.36 + i * 0.12]); spike.rotation.z = -0.15;
  }
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group(); arm.position.set(side * 0.47, 1.77, 0.03); root.add(arm); arms.push(arm);
    a.cylinder(arm, [0, 0, 0], [side * 0.24, -0.39, 0.2], 0.17, m.knit, 0.145);
    a.sphere(arm, [0.16, 0.18, 0.19], [side * 0.05, -0.03, 0], m.blue);
    a.sphere(arm, [0.055, 0.18, 0.18], [side * 0.18, -0.035, 0.01], m.red);
    a.sphere(arm, [0.024, 0.065, 0.065], [side * 0.233, -0.035, 0.01], m.brass);
    a.sphere(arm, [0.15, 0.13, 0.14], [side * 0.24, -0.39, 0.2], m.darkBlue);
    a.cylinder(arm, [side * 0.24, -0.39, 0.22], [side * 0.17, -0.62, 0.63], 0.14, m.knit, 0.115);
    a.cylinder(arm, [side * 0.17, -0.61, 0.59], [side * 0.16, -0.65, 0.68], 0.128, m.brass);
    a.box(arm, [0.29, 0.13, 0.29], [side * 0.14, -0.69, 0.75], m.blue, 0.05);
    for (let i = -1; i <= 1; i++) {
      const x = side * 0.14 + i * 0.095;
      a.sphere(arm, [0.047, 0.046, 0.07], [x, -0.69, 0.9], m.darkBlue);
      a.tapered(arm, [[x, -0.69, 0.91], [x, -0.70, 0.99], [x, -0.755, 1.055]], 0.037, m.ivory);
    }
  }
  const head = new THREE.Group(); head.position.set(0, 2.25, 0.13); root.add(head);
  a.box(head, [0.98, 0.72, 0.81], [0, 0.08, 0], m.blue, 0.19);
  a.box(head, [0.86, 0.32, 0.94], [0, -0.19, 0.56], m.blue, 0.11);
  a.box(head, [0.15, 0.43, 0.08], [0, 0.16, 0.423], m.red, 0.025);
  a.box(head, [0.16, 0.045, 0.71], [0, -0.009, 0.66], m.red, 0.018);
  for (const side of [-1, 1]) {
    a.sphere(head, [0.07, 0.22, 0.29], [side * 0.48, -0.16, 0.15], m.red);
    a.sphere(head, [0.018, 0.083, 0.083], [side * 0.546, -0.15, 0.16], m.brass);
    a.sphere(head, [0.012, 0.047, 0.047], [side * 0.56, -0.15, 0.16], m.iron);
    a.box(head, [0.035, 0.008, 0.07], [side * 0.57, -0.15, 0.16], m.brass, 0.002);
    const nostril = new THREE.Group(); nostril.position.set(side * 0.28, -0.095, 1.006); nostril.rotation.x = -0.15; head.add(nostril);
    const ring = a.mesh(nostril, new THREE.TorusGeometry(0.071, 0.018, 10, 28), m.darkBlue);
    ring.scale.y = 1.1; a.sphere(nostril, [0.056, 0.063, 0.012], [0, 0, -0.009], m.black);
    for (let i = 0; i < 3; i++) a.sphere(head, [0.012, 0.012, 0.009], [side * 0.35, -0.29, 0.48 + i * 0.17], m.brass);
    const earShape = new THREE.Shape(); earShape.moveTo(0, 0); earShape.lineTo(side * 0.37, 0.12); earShape.lineTo(side * 0.17, -0.12); earShape.closePath();
    a.mesh(head, new THREE.ExtrudeGeometry(earShape, { depth: 0.06, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.01, bevelSegments: 2, steps: 1 }), m.red, [side * 0.43, 0.22, -0.13]);
  }
  const eyes: THREE.Group[] = [], pupils: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const socket = new THREE.Group(); socket.position.set(side * 0.322, 0.19, 0.397); socket.rotation.y = side * 0.28; head.add(socket);
    a.sphere(socket, [0.19, 0.205, 0.06], [0, 0, 0], m.darkBlue);
    const eye = new THREE.Group(); socket.add(eye); eyes.push(eye);
    a.sphere(eye, [0.15, 0.166, 0.065], [0, 0, 0.024], m.amber);
    const pupil = new THREE.Group(); pupil.position.set(0.018, 0.006, 0.083); eye.add(pupil); pupils.push(pupil);
    a.sphere(pupil, [0.034, 0.103, 0.014], [0, 0, 0], m.black);
    a.sphere(eye, [0.029, 0.035, 0.009], [-0.042, 0.067, 0.084], m.ivory);
    a.sphere(eye, [0.011, 0.013, 0.008], [0.052, -0.048, 0.083], m.ivory);
    const brow = a.box(socket, [0.34, 0.065, 0.095], [0, 0.185, 0.04], m.red, 0.025); brow.rotation.z = side * 0.09;
  }
  const jaw = new THREE.Group(); jaw.position.set(0, -0.405, -0.02); head.add(jaw);
  a.box(jaw, [0.9, 0.17, 1.11], [0, -0.06, 0.55], m.red, 0.08);
  const lip = a.box(jaw, [0.78, 0.06, 0.94], [0, 0.03, 0.60], m.black, 0.03);
  a.sphere(jaw, [0.17, 0.018, 0.15], [0, 0.063, 0.88], m.tongue);
  for (const side of [-1, 1]) {
    a.tapered(head, [[side * 0.32, -0.32, 0.84], [side * 0.32, -0.38, 0.87]], 0.03, m.ivory);
    a.tube(head, [[side * 0.41, -0.31, 0.3], [side * 0.43, -0.33, 0.66], [side * 0.38, -0.32, 1.005]], 0.018, m.darkBlue);
  }
  a.sphere(head, [0.54, 0.37, 0.46], [0, 0.63, -0.035], m.knit);
  const band = a.mesh(head, new THREE.CylinderGeometry(0.53, 0.53, 0.17, 64), m.knit, [0, 0.4, -0.025]); band.scale.z = 0.88;
  for (let i = 0; i < 44; i++) {
    const angle = i / 44 * Math.PI * 2;
    a.cylinder(head, [Math.sin(angle) * 0.532, 0.325, Math.cos(angle) * 0.471 - 0.025], [Math.sin(angle) * 0.532, 0.474, Math.cos(angle) * 0.471 - 0.025], 0.009, m.knit);
  }
  a.box(head, [0.13, 0.105, 0.017], [0.21, 0.4, 0.435], m.darkBlue, 0.008);
  for (let i = 0; i < 3; i++) a.box(head, [0.012, 0.045 - i * 0.007, 0.01], [0.18 + i * 0.027, 0.4, 0.449], m.brass, 0.002);
  for (const side of [-1, 1]) a.tapered(head, [[side * 0.425, 0.60, -0.10], [side * 0.64, 0.78, -0.10], [side * 0.68, 1.03, -0.15], [side * 0.56, 1.2, -0.17]], 0.10, m.ivory);
  a.sphere(head, [0.08, 0.07, 0.08], [0, 0.994, -0.035], m.knit);
  return {
    update(pose: DragonPose) {
      head.rotation.set(pose.headPitch, pose.headYaw, pose.headRoll);
      head.position.y = 2.25 + pose.breath;
      chest.scale.y = 1 + pose.breath * 0.4;
      jaw.rotation.x = pose.jaw * 0.30; lip.scale.x = 1 - pose.round * 0.08;
      eyes.forEach(eye => { eye.scale.y = Math.max(0.055, 1 - pose.blink * 0.95); });
      pupils.forEach(pupil => { pupil.position.x = 0.018 + pose.gazeX; pupil.position.y = 0.006 + pose.gazeY; });
      arms[1].rotation.z = pose.gesture * 0.035; arms[1].rotation.x = -pose.gesture * 0.035;
      wings.forEach((wing, i) => { wing.rotation.z = (i ? -1 : 1) * pose.breath * 0.8; });
    },
  };
}
