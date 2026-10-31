import * as THREE from 'three';

const vertexShader = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const blurShader = `uniform sampler2D image; uniform vec2 stepSize; varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(image, vUv) * 0.137022;
  gl_FragColor += (texture2D(image, vUv + stepSize) + texture2D(image, vUv - stepSize)) * 0.129618;
  gl_FragColor += (texture2D(image, vUv + stepSize * 2.0) + texture2D(image, vUv - stepSize * 2.0)) * 0.109719;
  gl_FragColor += (texture2D(image, vUv + stepSize * 3.0) + texture2D(image, vUv - stepSize * 3.0)) * 0.083109;
  gl_FragColor += (texture2D(image, vUv + stepSize * 4.0) + texture2D(image, vUv - stepSize * 4.0)) * 0.056331;
  gl_FragColor += (texture2D(image, vUv + stepSize * 5.0) + texture2D(image, vUv - stepSize * 5.0)) * 0.034166;
  gl_FragColor += (texture2D(image, vUv + stepSize * 6.0) + texture2D(image, vUv - stepSize * 6.0)) * 0.018544;
}`;

/** Call-style background separation, not a CSS blur over the character.
 * The room and its two blur passes are cached until the camera/size changes.
 * Only a single cached image is composited behind the sharp rig each frame. */
export class SoftBackground {
  private targets: THREE.WebGLRenderTarget[];
  private geometry = new THREE.PlaneGeometry(2, 2);
  private blur = new THREE.ShaderMaterial({ vertexShader, fragmentShader: blurShader, toneMapped: false,
    depthTest: false, depthWrite: false, uniforms: { image: { value: null }, stepSize: { value: new THREE.Vector2() } } });
  private display = new THREE.ShaderMaterial({ vertexShader, depthTest: false, depthWrite: false,
    uniforms: { image: { value: null } }, fragmentShader: `uniform sampler2D image; varying vec2 vUv;
void main() { gl_FragColor = texture2D(image, vUv);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}` });
  private screen = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad = new THREE.Mesh(this.geometry, this.blur);
  private dirty = true;
  private disposed = false;
  renders = 0;
  constructor(private renderer: THREE.WebGLRenderer) {
    const type = renderer.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.targets = Array.from({ length: 2 }, () => new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: true }));
    this.quad.frustumCulled = false; this.screen.add(this.quad);
  }
  resize(width: number, height: number) {
    // Half-resolution room; roughly 6 CSS pixels of blur at a 640px call width.
    const w = Math.max(1, Math.round(Math.min(640, width * 0.5))), h = Math.max(1, Math.round(w * height / width));
    this.dirty = true;
    if (w === this.targets[0].width && h === this.targets[0].height) return;
    this.targets.forEach(target => target.setSize(w, h));
  }
  render(room: THREE.Scene, camera: THREE.Camera, foreground: THREE.Scene) {
    if (this.disposed) return;
    const r = this.renderer, previous = r.getRenderTarget(), autoClear = r.autoClear;
    try {
      r.autoClear = true;
      if (this.dirty) {
        const [image, scratch] = this.targets;
        r.setRenderTarget(image); r.render(room, camera);
        this.quad.material = this.blur; this.blur.uniforms.image.value = image.texture;
        this.blur.uniforms.stepSize.value.set(1 / image.width, 0);
        r.setRenderTarget(scratch); r.render(this.screen, this.camera);
        this.blur.uniforms.image.value = scratch.texture; this.blur.uniforms.stepSize.value.set(0, 1 / image.height);
        r.setRenderTarget(image); r.render(this.screen, this.camera);
        this.display.uniforms.image.value = image.texture; this.dirty = false; this.renders++;
        r.shadowMap.needsUpdate = true;
      }
      this.quad.material = this.display;
      r.setRenderTarget(previous); r.render(this.screen, this.camera);
      r.autoClear = false; r.clearDepth(); r.render(foreground, camera);
    } finally { r.setRenderTarget(previous); r.autoClear = autoClear; }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.targets.forEach(target => target.dispose()); this.geometry.dispose(); this.blur.dispose(); this.display.dispose(); this.screen.clear();
  }
}
