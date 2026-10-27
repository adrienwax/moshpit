// L15: the render-backend abstraction. WebGL2 is the first (only) backend; WebGL objects never
// leave this file — nodes and the runtime hold opaque `Target` handles. A later WebGPU backend
// replaces this module without touching node code.
//
// §6 + audit S2: every texture is accounted against a VRAM budget at allocation time, so a graph
// that will not fit fails with GPU_VRAM_EXCEEDED before it starts, not mid-render.
//
// L21: the per-frame paths (draw, copy, blit, upload, read) allocate nothing. Uniforms are one
// `float u[16]` array set with uniform1fv(loc, data, 0, 16): no subarray views, no boxed doubles.

import { MoshpitError } from '../errors';

export type TargetFormat = 'rgba8' | 'rgba16f';

export interface Target {
  readonly id: number;
  readonly w: number;
  readonly h: number;
  readonly format: TargetFormat;
  readonly bytes: number;
  readonly purpose: string;
}

interface GLTarget extends Target { tex: WebGLTexture; fbo: WebGLFramebuffer }

export interface Program { readonly name: string }
interface GLProgram extends Program { p: WebGLProgram; u: WebGLUniformLocation | null; inputs: number }

/** Exported for the golden shader tests (e2e/app.spec.ts), which compile engine shaders as shipped. */
export const VS = `#version 300 es
out vec2 v; void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); v = p; gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`;

/** Every fragment shader gets: `v` (uv), `o` (out), samplers t0..t3, and `u[16]`. */
export const FS_HEAD = `#version 300 es
precision highp float; in vec2 v; out vec4 o; uniform sampler2D t0, t1, t2, t3; uniform float u[16];
vec3 toLinear(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toGamma(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

export interface Budget {
  /** Bytes the engine may allocate on the GPU. */
  bytes: number;
}

/**
 * Phase 0.3: who to tell when a WebGL context is lost (a driver reset). The host restarts the
 * worker: a lost context never renders again, and failing silently was the alternative.
 */
let contextLost: (() => void) | null = null;
export function onGpuContextLost(fn: () => void) {
  contextLost = fn;
}
/** Backends alive in this process, newest last (the test hook loses the newest one's context). */
export const liveBackends = new Set<GL2Backend>();

export class GL2Backend {
  readonly gl: WebGL2RenderingContext;
  readonly gpuName: string;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  liveBytes = 0;
  peakBytes = 0;
  private disposed = false;
  private nextId = 1;
  private programs = new Map<string, GLProgram>();
  private copyProg: GLProgram;

  constructor(readonly budget: Budget, canvas?: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas ?? new OffscreenCanvas(16, 16);
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new MoshpitError('GPU_UNAVAILABLE', { why: 'no WebGL2' });
    (this.canvas as EventTarget).addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      liveBackends.delete(this);
      if (!this.disposed) contextLost?.(); // dispose() loses the context on purpose
    });
    liveBackends.add(this);
    if (!gl.getExtension('EXT_color_buffer_float')) throw new MoshpitError('GPU_UNAVAILABLE', { why: 'no EXT_color_buffer_float (RGBA16F targets, L17)' });
    this.gl = gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.disable(gl.BLEND);
    this.copyProg = this.program('copy', 'void main(){ o = texture(t0, v); }', 1) as GLProgram;
  }

  /** Compile once, cached by name. `inputs` = how many of t0..t3 the shader reads. */
  program(name: string, body: string, inputs: number): Program {
    const hit = this.programs.get(name);
    if (hit) return hit;
    const gl = this.gl, p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS_HEAD + body]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new MoshpitError('GPU_SHADER_COMPILE', { program: name, log: gl.getShaderInfoLog(s) });
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new MoshpitError('GPU_SHADER_COMPILE', { program: name, log: gl.getProgramInfoLog(p) });
    gl.useProgram(p);
    for (let i = 0; i < 4; i++) { const loc = gl.getUniformLocation(p, `t${i}`); if (loc) gl.uniform1i(loc, i); }
    const prog: GLProgram = { name, p, u: gl.getUniformLocation(p, 'u'), inputs };
    this.programs.set(name, prog);
    return prog;
  }

  /** Allocate a render target, accounted against the budget. */
  target(w: number, h: number, format: TargetFormat, purpose: string): Target {
    const bytes = w * h * (format === 'rgba16f' ? 8 : 4);
    if (this.liveBytes + bytes > this.budget.bytes) {
      throw new MoshpitError('GPU_VRAM_EXCEEDED', { purpose, needBytes: bytes, liveBytes: this.liveBytes, budgetBytes: this.budget.bytes });
    }
    const gl = this.gl, tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format === 'rgba16f' ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new MoshpitError('GPU_UNAVAILABLE', { why: 'incomplete framebuffer', format });
    this.liveBytes += bytes;
    if (this.liveBytes > this.peakBytes) this.peakBytes = this.liveBytes;
    const t: GLTarget = { id: this.nextId++, w, h, format, bytes, purpose, tex, fbo };
    return t;
  }

  release(t: Target | null | undefined): void {
    if (!t) return;
    const g = t as GLTarget;
    this.gl.deleteTexture(g.tex); this.gl.deleteFramebuffer(g.fbo);
    this.liveBytes -= t.bytes;
  }

  /** Draw `prog` into `out`, sampling `a..d` on units 0..3. `u` must be a Float32Array(16). */
  draw(prog: Program, out: Target, u: Float32Array | null, a: Target | null, b: Target | null = null, c: Target | null = null, d: Target | null = null): void {
    const gl = this.gl, P = prog as GLProgram;
    gl.useProgram(P.p);
    if (u !== null && P.u !== null) gl.uniform1fv(P.u, u, 0, 16);
    if (a !== null) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, (a as GLTarget).tex); }
    if (b !== null) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (b as GLTarget).tex); }
    if (c !== null) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, (c as GLTarget).tex); }
    if (d !== null) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, (d as GLTarget).tex); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, (out as GLTarget).fbo);
    gl.viewport(0, 0, out.w, out.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Shader copy: converts format and resamples size. */
  copy(from: Target, to: Target): void {
    this.draw(this.copyProg, to, null, from);
  }

  /** Exact same-size, same-format copy. */
  blit(from: Target, to: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, (from as GLTarget).fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, (to as GLTarget).fbo);
    gl.blitFramebuffer(0, 0, from.w, from.h, 0, 0, to.w, to.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  clear(t: Target, r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (t as GLTarget).fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  uploadFrame(t: Target, frame: VideoFrame): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, (t as GLTarget).tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }

  uploadRGBA8(t: Target, px: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, (t as GLTarget).tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  readRGBA8(t: Target, out: Uint8Array): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (t as GLTarget).fbo);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  }

  /** Float read/write for spilling state to disk (RGBA16F → float32 on the CPU side). */
  readFloat(t: Target, out: Float32Array): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (t as GLTarget).fbo);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, out);
  }

  uploadFloat(t: Target, data: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, (t as GLTarget).tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, data);
  }

  /** Present a target on the canvas (preview). Resizes the canvas to the target. */
  present(t: Target): void {
    const gl = this.gl;
    if (this.canvas.width !== t.w || this.canvas.height !== t.h) { this.canvas.width = t.w; this.canvas.height = t.h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, t.w, t.h);
    gl.useProgram(this.copyProg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, (t as GLTarget).tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  finish(): void { this.gl.finish(); }

  dispose(): void {
    this.disposed = true;
    liveBackends.delete(this);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.liveBytes = 0;
  }
}

/** The colour pipeline (L17): ingress to linear-light RGBA16F, egress back to display-encoded 8-bit. */
export const COLOUR_SHADERS = {
  ingress: 'void main(){ vec4 c = texture(t0, v); o = vec4(toLinear(c.rgb), 1.0); }',
  egress: 'void main(){ vec4 c = texture(t0, v); o = vec4(toGamma(c.rgb), 1.0); }',
};
