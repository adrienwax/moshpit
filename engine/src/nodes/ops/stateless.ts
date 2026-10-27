// The 17 stateless image ops, ported from Moshpit 1 (src/ops.ts cfd5d8c: OPS defs for params and
// help, imageChainFilter for the six CSS filters, applyImagePixelOps for the pixel loops) to GLSL.
// They will not pixel-match the CPU/CSS renders and are not meant to (D4, R8).
//
// Texture orientation: v.y = 0 is the top row (frames upload unflipped and read back the same
// way), so Moshpit 1's top-down y maps directly. Colour: t0 is linear-light; ops Moshpit 1 defined
// on 8-bit display values convert with toGamma/toLinear around their maths.

import { imageOp, P, type GpuOp } from './spec';

const tone = (k: string, label: string, blurb: string, params: Parameters<typeof imageOp>[4], body: string) =>
  imageOp(k, label, 'Tone', blurb, params, `void main(){ vec4 s = texture(t0, v); vec3 c = toGamma(s.rgb); ${body} o = vec4(WETMIX(s.rgb, toLinear(clamp(c, 0.0, 1.0))), s.a); }`);

export const STATELESS_OPS: GpuOp[] = [
  // ── Tone: Moshpit 1's six CSS filters, with the filter-effects matrices, in display space ──
  tone('fx.saturation', 'Saturation', 'Pull colour out or push it in. 0 is grayscale.',
    [P('amount', 'Amount', 'float', 100, '100 is the source unchanged. 0 is grayscale; above 100 pushes colour past the source.', { min: 0, max: 300, unit: '%', onNode: true, ctOrder: 1, initial: 170 })],
    `float k = P_amount / 100.0; mat3 m = mat3(0.213 + 0.787*k, 0.213 - 0.213*k, 0.213 - 0.213*k, 0.715 - 0.715*k, 0.715 + 0.285*k, 0.715 - 0.715*k, 0.072 - 0.072*k, 0.072 - 0.072*k, 0.072 + 0.928*k); c = m * c;`),
  tone('fx.contrast', 'Contrast', 'Push blacks and whites apart, or collapse them toward grey.',
    [P('amount', 'Amount', 'float', 100, '100 is the source unchanged. 0 flattens to flat grey; above 100 pushes contrast past the source.', { min: 0, max: 300, unit: '%', onNode: true, ctOrder: 1, initial: 150 })],
    `c = (c - 0.5) * (P_amount / 100.0) + 0.5;`),
  tone('fx.brightness', 'Brightness', 'Push the picture darker or brighter.',
    [P('level', 'Level', 'float', 100, '100 is unchanged; 0 is black, above 100 blows out toward white.', { min: 0, max: 300, unit: '%', onNode: true, ctOrder: 1, initial: 70 })],
    `c = c * (P_level / 100.0);`),
  tone('fx.hue-rotate', 'Hue rotate', 'Spin every colour around the wheel by a fixed angle.',
    [P('degrees', 'Degrees', 'float', 0, '0 leaves colour unchanged; 180 is the fullest rotation.', { min: -180, max: 180, unit: '°', onNode: true, ctOrder: 1, initial: 90 })],
    `float a = radians(P_degrees), cs = cos(a), sn = sin(a);
     mat3 m = mat3(0.213 + cs*0.787 - sn*0.213, 0.213 - cs*0.213 + sn*0.143, 0.213 - cs*0.213 - sn*0.787,
                   0.715 - cs*0.715 - sn*0.715, 0.715 + cs*0.285 + sn*0.140, 0.715 - cs*0.715 + sn*0.715,
                   0.072 - cs*0.072 + sn*0.928, 0.072 - cs*0.072 - sn*0.283, 0.072 + cs*0.928 + sn*0.072);
     c = m * c;`),
  tone('fx.invert', 'Invert', 'Flip every colour to its negative.',
    [P('amount', 'Amount', 'float', 100, '100 is a full negative; partial values mix toward it.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 })],
    `c = mix(c, 1.0 - c, P_amount / 100.0);`),
  tone('fx.sepia', 'Sepia', 'Tint the picture toward a warm monochrome.',
    [P('amount', 'Amount', 'float', 100, '100 is a full sepia tint.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 })],
    `vec3 sp = mat3(0.393, 0.349, 0.272, 0.769, 0.686, 0.534, 0.189, 0.168, 0.131) * c; c = mix(c, sp, P_amount / 100.0);`),
  imageOp('fx.posterize', 'Posterize', 'Tone', 'Quantise every channel to a handful of levels: real banding, not a filter imitating it.',
    [P('levels', 'Levels', 'int', 6, 'How many steps each channel is quantised to. Lower is harsher.', { min: 2, max: 32, step: 1, onNode: true, ctOrder: 1, modulatable: true, initial: 4 })],
    `void main(){ vec4 s = texture(t0, v); float n = max(2.0, floor(P_levels + 0.5)) - 1.0; vec3 c = floor(toGamma(s.rgb) * n + 0.5) / n; o = vec4(WETMIX(s.rgb, toLinear(c)), s.a); }`),

  // ── Plane ──
  imageOp('fx.channel-isolation', 'Channel isolation', 'Plane', 'Drop one or two colour channels outright. Real corruption of the decoded picture, not a colour filter.',
    [P('keepR', 'Keep red', 'bool', true, 'Off zeroes the red channel.', { onNode: true, ctOrder: 1 }), P('keepG', 'Keep green', 'bool', false, 'Off zeroes the green channel.', { onNode: true, ctOrder: 2 }), P('keepB', 'Keep blue', 'bool', true, 'Off zeroes the blue channel.', { onNode: true, ctOrder: 3 })],
    `void main(){ vec4 s = texture(t0, v); vec3 k = vec3(P_keepR, P_keepG, P_keepB); o = vec4(WETMIX(s.rgb, s.rgb * k), s.a); }`),
  imageOp('fx.chroma-drift', 'Chroma drift', 'Plane', 'Bias the blue-difference and red-difference colour values. Pixels stay in place. Animate Cb and Cr with an LFO; use Plane desync for spatial separation.',
    [P('cb', 'Cb shift', 'float', 24, 'Blue-difference offset. Negative pulls toward yellow, positive toward blue.', { min: -128, max: 128, onNode: true, ctOrder: 1, initial: 60 }),
     P('cr', 'Cr shift', 'float', -24, 'Red-difference offset. Negative pulls toward green, positive toward red.', { min: -128, max: 128, onNode: true, ctOrder: 2, initial: -60 })],
    // BT.601 full-range RGB↔YCbCr on 0..255 display values, as Moshpit 1 does.
    `void main(){ vec4 s = texture(t0, v); vec3 c = toGamma(s.rgb) * 255.0;
       float y = dot(c, vec3(0.299, 0.587, 0.114));
       float cb = clamp(dot(c, vec3(-0.168736, -0.331264, 0.5)) + 128.0 + P_cb, 0.0, 255.0);
       float cr = clamp(dot(c, vec3(0.5, -0.418688, -0.081312)) + 128.0 + P_cr, 0.0, 255.0);
       vec3 r = vec3(y + 1.402 * (cr - 128.0), y - 0.344136 * (cb - 128.0) - 0.714136 * (cr - 128.0), y + 1.772 * (cb - 128.0)) / 255.0;
       o = vec4(WETMIX(s.rgb, toLinear(clamp(r, 0.0, 1.0))), s.a); }`),

  // ── Geometry ──
  imageOp('fx.mirror', 'Mirror', 'Geometry', 'Reflect one half of the frame onto the other, horizontal or vertical.',
    [P('vertical', 'Vertical', 'bool', false, 'Off mirrors left/right. On mirrors top/bottom.', { onNode: true, ctOrder: 1 }), P('flip', 'Flip', 'bool', false, 'Off: the first half (left/top) is the source. On: the second half (right/bottom) is the source.', { onNode: true, ctOrder: 2 })],
    `void main(){ vec4 s = texture(t0, v); float a = P_vertical > 0.5 ? v.y : v.x; bool second = a >= 0.5;
       bool dst = P_flip > 0.5 ? !second : second;
       vec2 m = P_vertical > 0.5 ? vec2(v.x, 1.0 - v.y) : vec2(1.0 - v.x, v.y);
       o = dst ? vec4(WETMIX(s.rgb, texture(t0, m).rgb), s.a) : s; }`),
  imageOp('fx.transform', 'Transform', 'Geometry', 'Rotate, scale and offset the picture, and move the crop centre when zoomed in.',
    [P('turn', 'Turn', 'int', 0, 'Quarter turns. Off the right angles, rotate leaves wedges by design.', { min: 0, max: 3, step: 1, unit: '×90', ctOrder: 5 }),
     P('rotate', 'Rotate', 'float', 0, 'Fine rotation on top of the turn, around the frame centre.', { min: -180, max: 180, unit: '°', onNode: true, ctOrder: 1 }),
     P('scale', 'Scale', 'float', 100, '100 is the source unchanged.', { min: 10, max: 400, unit: '%', onNode: true, ctOrder: 2 }),
     P('offsetX', 'Offset X', 'float', 0, 'Shift the picture horizontally, in 1080p pixels.', { min: -500, max: 500, unit: 'px', onNode: true, ctOrder: 3 }),
     P('offsetY', 'Offset Y', 'float', 0, 'Shift the picture vertically, in 1080p pixels.', { min: -500, max: 500, unit: 'px', ctOrder: 4 }),
     P('cropX', 'Crop X', 'float', 50, 'Where a zoomed-in crop is centred, left to right. 50 is centred.', { min: 0, max: 100, unit: '%' }),
     P('cropY', 'Crop Y', 'float', 50, 'Where a zoomed-in crop is centred, top to bottom. 50 is centred.', { min: 0, max: 100, unit: '%' })],
    `void main(){ vec4 s = texture(t0, v); float aspect = RES.x / RES.y; float sc = max(0.01, P_scale / 100.0);
       float a = radians(floor(P_turn + 0.5) * 90.0 + P_rotate), cs = cos(a), sn = sin(a);
       vec2 p = (v - 0.5 - PX(vec2(P_offsetX, P_offsetY))) * vec2(aspect, 1.0);
       p = mat2(cs, sn, -sn, cs) * p / sc;
       vec2 crop = (vec2(P_cropX, P_cropY) - 50.0) / 100.0 * max(0.0, 1.0 - 1.0 / sc);
       vec2 q = p / vec2(aspect, 1.0) + 0.5 + crop;
       vec3 r = (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) ? vec3(0.0) : texture(t0, q).rgb;
       o = vec4(WETMIX(s.rgb, r), s.a); }`),
  imageOp('fx.row-displacement', 'Row displacement', 'Geometry', 'Shift horizontal bands sideways: rolling shutter, VHS tracking, screen tearing, or a wave melt, by curve.',
    [P('band', 'Band', 'float', 20, 'Height of each displaced band, in 1080p pixels.', { min: 1, max: 200, unit: 'px', onNode: true, ctOrder: 2 }),
     P('amount', 'Amount', 'float', 60, 'Maximum horizontal shift, in 1080p pixels.', { min: -200, max: 200, unit: 'px', onNode: true, ctOrder: 1 }),
     P('curve', 'Curve', 'enum', 'sine', 'Linear is a rolling-shutter shear; sine a wave melt; random a tracking error; stepped a single tearing seam.', { options: ['linear', 'sine', 'random', 'stepped'], onNode: true, ctOrder: 3 }),
     P('speed', 'Speed', 'float', 20, 'How fast the sine and random curves drift over time. 0 holds still.', { min: 0, max: 100, ctOrder: 4 })],
    `void main(){ vec4 s = texture(t0, v); float y = v.y * RES.y; float bandPx = max(1.0, P_band * RES.y / 1080.0);
       float bands = max(1.0, ceil(RES.y / bandPx)); float bi = min(bands - 1.0, floor(y / bandPx));
       int curve = int(P_curve + 0.5); float sh;
       if (curve == 0) sh = P_amount * ((bi / max(1.0, bands - 1.0)) * 2.0 - 1.0);
       else if (curve == 1) sh = P_amount * sin(bi * 0.6 + FRAME * (P_speed / 100.0) * 0.5);
       else if (curve == 2) { uint seedT = uint(floor(FRAME * (P_speed / 100.0 + 0.02))); uint h = uint(bi) * 2654435761u + seedT * 40503u; sh = P_amount * (float(h % 100000u) / 100000.0 * 2.0 - 1.0); }
       else sh = bi < bands / 2.0 ? 0.0 : P_amount;
       vec2 q = vec2(clamp(v.x - sh / 1920.0, 0.0, 1.0), v.y);
       o = vec4(WETMIX(s.rgb, texture(t0, q).rgb), s.a); }`),
  imageOp('fx.pixel-stretch', 'Pixel stretch', 'Geometry', 'Smear one line of colour outward from a source row or column: a streak, not a shift.',
    [P('mode', 'Mode', 'enum', 'horizontal', 'Horizontal smears sideways from a column; vertical down from a row; wave lets the source column ripple over time.', { options: ['horizontal', 'vertical', 'wave'], onNode: true, ctOrder: 3 }),
     P('origin', 'Origin', 'float', 50, 'Where the source line sits across the frame.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 }),
     P('reach', 'Reach', 'float', 30, 'How far the smear reaches from the source line. 0 is off.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 2 }),
     P('speed', 'Speed', 'float', 30, 'How fast the source line ripples, in wave mode only.', { min: 0, max: 100, ctOrder: 4 })],
    `void main(){ vec4 s = texture(t0, v); int mode = int(P_mode + 0.5); float reach = P_reach / 100.0; vec2 q = v; bool hit;
       if (mode == 1) { float sy = P_origin / 100.0; hit = abs(v.y - sy) <= reach; q = vec2(v.x, sy); }
       else { float sx = P_origin; if (mode == 2) sx = clamp(sx + sin(v.y * RES.y * 0.08 + FRAME * (P_speed / 100.0) * 0.5) * 20.0, 0.0, 100.0);
              sx /= 100.0; hit = abs(v.x - sx) <= reach; q = vec2(sx, v.y); }
       o = hit && reach > 0.0 ? vec4(WETMIX(s.rgb, texture(t0, q).rgb), s.a) : s; }`),
  imageOp('fx.resolution-crush', 'Resolution crush', 'Geometry', 'Draw at a lower internal resolution and scale back: blocky or soft, your choice.',
    [P('factor', 'Factor', 'int', 8, 'How many times smaller the intermediate draw is. Higher is chunkier.', { min: 2, max: 32, step: 1, onNode: true, ctOrder: 1, initial: 16 }),
     P('smooth', 'Smooth', 'bool', false, 'Off: blocky nearest-neighbour. On: soft bilinear reconstruction.', { onNode: true, ctOrder: 2 })],
    // Two passes (gpu/ops.ts ResolutionCrush): block averages into a small target, then this reconstruction.
    `void main(){ vec4 s = texture(t0, v); vec2 small = vec2(textureSize(t1, 0));
       vec3 r = P_smooth > 0.5 ? texture(t1, v).rgb : texelFetch(t1, ivec2(min(floor(v * small), small - 1.0)), 0).rgb;
       o = vec4(WETMIX(s.rgb, r), s.a); }`),

  // ── Degrade ──
  imageOp('fx.soft-blur', 'Soft blur', 'Degrade', 'A gentle box blur: softens raw, rough footage without touching timing.',
    [P('radius', 'Radius', 'float', 3, 'Blur radius in 1080p pixels. 0 is off.', { min: 0, max: 12, unit: 'px', onNode: true, ctOrder: 1, initial: 6 })],
    // Separable: gpu/ops.ts SoftBlur runs this body twice, u[11] = 0 horizontal, 1 vertical (wet applies on the second).
    `void main(){ vec4 s = texture(t0, v); float r = floor(P_radius * RES.y / 1080.0 + 0.5);
       vec2 dir = u[11] > 0.5 ? vec2(0.0, TEXEL.y) : vec2(TEXEL.x, 0.0); vec3 acc = vec3(0.0);
       for (int k = -24; k <= 24; k++) { if (float(abs(k)) > r) continue; acc += texture(t0, clamp(v + dir * float(k), vec2(0.0), vec2(1.0))).rgb; }
       vec3 b = acc / (2.0 * r + 1.0);
       o = u[11] > 0.5 ? vec4(WETMIX(texture(t2, v).rgb, b), s.a) : vec4(b, s.a); }`),
  imageOp('fx.salt-pepper', 'Salt & pepper', 'Degrade', 'Sparse random black and white pixels: impulse noise, not grain.',
    [P('density', 'Density', 'float', 5, 'Chance any given pixel is hit. 0 is off.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 })],
    // Moshpit 1's integer hash of pixel index and frame: deterministic per pixel per frame (L11).
    `void main(){ vec4 s = texture(t0, v); uint px = uint(floor(gl_FragCoord.x)) + uint(floor(gl_FragCoord.y)) * uint(RES.x + 0.5);
       uint h = px * 374761393u + uint(FRAME) * 668265263u; float roll = float(h % 100000u) / 100000.0;
       vec3 r = roll < P_density / 100.0 * clamp(P_wet, 0.0, 1.0) ? vec3((h & 0x10000u) != 0u ? 1.0 : 0.0) : s.rgb;
       o = vec4(r, s.a); }`),
];

/** Plane desync (fx.plane-desync) predates this table; its def stays in defs.ts and its shader here. dy sign follows Moshpit 1 (shaderVersion 2). */
export const PLANE_DESYNC_GLSL = `void main(){
  vec2 off = PX(vec2(P_dx, P_dy)) * P_amount;
  vec4 c = texture(t0, v);
  vec4 s = texture(t0, clamp(v - off, vec2(0.0), vec2(1.0)));
  float g = (NOISE - 0.5) * P_noise * 0.25;
  int ch = int(P_channel + 0.5);
  if (ch == 0) c.r = s.r + g; else if (ch == 1) c.g = s.g + g; else c.b = s.b + g;
  o = vec4(max(c.rgb, 0.0), c.a);
}`;
