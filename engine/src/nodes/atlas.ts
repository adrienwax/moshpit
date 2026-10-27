// Phase 2.1 + 2.4: the effect atlas. Every placeable effect is filed by LOOK (an outcome category,
// then a subcategory: the backbone the browser and the radial organise by) and explained in five
// parts: Does / Use when / Works best with / Watch out / Try next. Outcome first, plain words.
// The six families stay on the defs as secondary metadata. atlas.test.ts keeps it complete.

export const LOOKS = {
  'Melt & Smear': ['Motion bleed', 'Bloom', 'Liquefy'],
  'Fracture & Displace': ['Macroblock', 'Slice & shear', 'Pixel sort', 'Warp'],
  'Stutter & Repeat': ['Frame repeat', 'Freeze & hold', 'Time fracture'],
  'Decay & Corrupt': ['VHS & analog', 'Compression', 'Noise'],
  'Echo & Trail': ['Feedback', 'Delay', 'Tunnel'],
  'Colour & Split': ['Channel split', 'Chroma shift', 'Tone & grade'],
  Utility: ['Routing', 'Convert', 'Blend & switch'],
} as const;
export type LookCategory = keyof typeof LOOKS;
export interface Look { cat: LookCategory; sub: string }

export interface Explanation {
  does: string;
  useWhen: string;
  worksWith: string;
  watchOut: string;
  tryNext: string;
}
export interface AtlasEntry { looks: Look[]; explain: Explanation }

const L = (cat: LookCategory, sub: string): Look => ({ cat, sub });

export const ATLAS: Record<string, AtlasEntry> = {
  // ---------- Bitstream (before the Decode) ----------
  'mosh.hold': {
    looks: [L('Melt & Smear', 'Bloom'), L('Stutter & Repeat', 'Freeze & hold')],
    explain: {
      does: 'Repeats a few P-frames several times, so their motion is applied again and again and the picture keeps drifting the same way.',
      useWhen: 'You want the classic datamosh bloom: a picture that swells and pours in one direction instead of cutting to the next shot.',
      worksWith: 'Footage with steady, directional motion (pans, walking subjects, zooms) on a motion block straight after a picture block.',
      watchOut: 'Too many repeats smear everything into mud; on near-still footage nothing moves.',
      tryNext: 'Speed below 100 % for a slower pour, or Feedback trail after the Decode to keep the ghost.',
    },
  },
  'mosh.stride': {
    looks: [L('Stutter & Repeat', 'Time fracture')],
    explain: {
      does: 'Keeps only every Nth P-frame and drops the rest, so the motion arrives in jumps and the smear moves in steps.',
      useWhen: 'You want a choppy, rhythmic mosh that lurches forward rather than flowing, for example on a beat.',
      worksWith: 'Fast, continuous motion; a stride that divides the beat length at the project tempo.',
      watchOut: 'The block gets shorter by the stride. Inverted stride keeps the frames normally dropped.',
      tryNext: 'Hold after it (the Hard Datamosh recipe), or Stride slip for the same rhythm without losing length.',
    },
  },
  'mosh.reorder': {
    looks: [L('Melt & Smear', 'Motion bleed'), L('Stutter & Repeat', 'Time fracture')],
    explain: {
      does: 'Plays a window of P-frames reversed, ping-ponged or strided inside one keyframe group, so the motion runs the wrong way over the picture.',
      useWhen: 'You want a short, contained reversal of motion inside a block without touching the rest of it.',
      worksWith: 'Clear, single-direction motion where reversing it reads; windows of 10–30 frames.',
      watchOut: 'The window stops at the next keyframe, so a long window may act on fewer frames than it says.',
      tryNext: 'Reverse for the whole block, or Hold inside the same window for a reversed bloom.',
    },
  },
  'mosh.reverse': {
    looks: [L('Melt & Smear', 'Motion bleed')],
    explain: {
      does: 'Plays the block\'s P-frames backwards, so every motion vector pushes the picture opposite to how it was filmed.',
      useWhen: 'You want the incoming clip to pull the old picture apart in reverse, an unsettling backwards melt.',
      worksWith: 'Strong motion with a clear direction; chunked reversal keeps short forward runs inside it.',
      watchOut: 'Reversed P-frames build on the wrong reference, so the smear grows fast and can bury the image.',
      tryNext: 'Ping-pong to come back forwards, or Reorder to reverse only a window.',
    },
  },
  'mosh.pingpong': {
    looks: [L('Stutter & Repeat', 'Time fracture')],
    explain: {
      does: 'Plays the P-frame run forwards then backwards, lap after lap, so the motion folds back over itself.',
      useWhen: 'You want a breathing, back-and-forth smear that returns toward where it started, like a held loop.',
      worksWith: 'Short blocks of rhythmic motion; laps matched to bars at the project tempo.',
      watchOut: 'Each lap lengthens the block, and the smear compounds on every turn.',
      tryNext: 'Resolution crush after the Decode (the Beat Chop recipe), or a pause at each end.',
    },
  },
  'mosh.stride-slip': {
    looks: [L('Stutter & Repeat', 'Frame repeat')],
    explain: {
      does: 'Updates the motion only once every N frames and repeats the last real one in between, a stutter that keeps the block\'s length.',
      useWhen: 'You want a frame-rate stutter on the smear without the block getting shorter or out of time.',
      worksWith: 'Steady motion; N matched to a beat division.',
      watchOut: 'Repeated frames re-apply their motion, so the stutter also smears harder than plain Stride.',
      tryNext: 'Stride for real gaps, or Hold for one long bloom instead of many short ones.',
    },
  },
  'mosh.speed': {
    looks: [L('Melt & Smear', 'Bloom'), L('Stutter & Repeat', 'Time fracture')],
    explain: {
      does: 'Plays the block faster or slower at any rate; slowing repeats P-frames, so their motion is applied twice and the picture smears.',
      useWhen: 'You want a heavier, slower melt (under 100 %), or a quick, thinned-out pass (over 100 %).',
      worksWith: 'Any motion block; 50 % doubles the smear and the block\'s length on the arrangement.',
      watchOut: 'The block\'s length changes with the rate, which moves everything after it.',
      tryNext: 'Speed ramp to change the rate across the block, or Hold for a smear at one moment only.',
    },
  },
  'mosh.speed-ramp': {
    looks: [L('Melt & Smear', 'Bloom')],
    explain: {
      does: 'Changes the playback rate across the block, from a start rate to an end rate, so the smear winds up or grinds to a halt.',
      useWhen: 'You want the mosh to build into a drop, or to slow and pile up as a section ends.',
      worksWith: 'Longer motion blocks at a phrase boundary; a ramp from 100 % down to 25 % reads as a collapse.',
      watchOut: 'Slow ends lengthen the block a lot; very slow rates can sit on one frame\'s motion for seconds.',
      tryNext: 'Feedback trail after the Decode to hold the tail, or Hold at the slow end.',
    },
  },
  // ---------- Plane ----------
  'fx.plane-desync': {
    looks: [L('Colour & Split', 'Channel split')],
    explain: {
      does: 'Shifts one colour channel sideways and up or down, out of register with the other two, so edges split into colour fringes.',
      useWhen: 'You want a misregistered print or a broken projector look, hard colour edges on every outline.',
      worksWith: 'High-contrast footage with clear edges; small offsets with a little noise.',
      watchOut: 'Large offsets read as a ghost image rather than a fringe.',
      tryNext: 'Plane desync (temporal) to split the channel in time instead of space.',
    },
  },
  'fx.channel-isolation': {
    looks: [L('Colour & Split', 'Channel split'), L('Decay & Corrupt', 'Compression')],
    explain: {
      does: 'Drops one or two colour channels outright, leaving the picture in the remaining primaries like a damaged signal.',
      useWhen: 'You want a harsh, broken-feed colour cast that looks like a fault rather than a grade.',
      worksWith: 'Colourful footage, and Switch to flick channels in and out on the beat.',
      watchOut: 'Dropping two channels leaves a single-colour image that can lose most detail.',
      tryNext: 'Chroma drift for a softer colour fault, or Hue rotate to choose which colour survives.',
    },
  },
  'fx.chroma-drift': {
    looks: [L('Colour & Split', 'Chroma shift'), L('Decay & Corrupt', 'VHS & analog')],
    explain: {
      does: 'Biases the blue-difference and red-difference colour values; pixels stay in place.',
      useWhen: 'You want a drifting colour cast under a mosh, with an LFO slowly changing Cb and Cr.',
      worksWith: 'Neutral, grey or skin-toned areas, where the colour shift shows most; LFOs on Cb and Cr.',
      watchOut: 'On saturated colour bars small shifts barely show; push past ±60 there.',
      tryNext: 'Plane desync for spatial channel separation, or Chroma trail for colour that lags in time.',
    },
  },
  'fx.plane-desync-temporal': {
    looks: [L('Colour & Split', 'Channel split'), L('Echo & Trail', 'Delay')],
    explain: {
      does: 'Pulls one or more colour channels from a frame N back, so moving things leave coloured ghosts behind them.',
      useWhen: 'You want motion to split into colour in time: a red past chasing a cyan present.',
      worksWith: 'Movement against a still background; a few frames back.',
      watchOut: 'Still footage shows nothing; it needs motion to separate.',
      tryNext: 'Chroma trail for a graded lag per channel.',
    },
  },
  'fx.field-desync': {
    looks: [L('Decay & Corrupt', 'VHS & analog'), L('Stutter & Repeat', 'Time fracture')],
    explain: {
      does: 'Takes alternating rows from a frame N back and keeps the rest in the present, a combed, interlaced split in time.',
      useWhen: 'You want broken-interlace combing on motion, like a bad deinterlace or a dropped field.',
      worksWith: 'Fast horizontal motion; one or two frames back.',
      watchOut: 'Fine row patterns can flicker or moiré when the render is scaled down.',
      tryNext: 'Row displacement for tracking errors, or Salt & pepper for tape dropout.',
    },
  },
  'fx.chroma-trail': {
    looks: [L('Echo & Trail', 'Delay'), L('Colour & Split', 'Chroma shift')],
    explain: {
      does: 'Lags each colour channel by a different number of frames, so trails separate into red, green and blue instead of grey.',
      useWhen: 'You want rainbow ghosting on moving shapes, psychedelic but tied to real motion.',
      worksWith: 'Bright moving subjects on a dark ground; a medium spread.',
      watchOut: 'Wide spreads turn fast motion into three separate copies.',
      tryNext: 'Echo taps for distinct ghosts (the Ghost Echo recipe).',
    },
  },
  // ---------- Feedback ----------
  'fx.feedback': {
    looks: [L('Echo & Trail', 'Tunnel')],
    explain: {
      does: 'Blends each frame over a zoomed, turned copy of the previous output, so trails spiral inwards or out like a video tunnel.',
      useWhen: 'You want a hypnotic, recursive tunnel or vortex built from your own footage.',
      worksWith: 'A small zoom and a slight turn; slow decay for long tunnels.',
      watchOut: 'High decay with zoom can fill the frame with its own recursion and lose the source.',
      tryNext: 'Feedback trail for a still trail without the zoom.',
    },
  },
  'fx.feedback-trail': {
    looks: [L('Echo & Trail', 'Feedback')],
    explain: {
      does: 'Blends each frame toward one from N frames back, so moving things leave a soft, fading trail.',
      useWhen: 'You want to hold the ghost of a mosh after it, or soften motion into a dreamy smear.',
      worksWith: 'After a Mosh op on the Decode\'s side; 40–70 % amount.',
      watchOut: 'At high amounts fast cuts take a long time to clear.',
      tryNext: 'Soft blur after it (the Dream Melt recipe), or Drift trail to make the trail travel.',
    },
  },
  'fx.drift-trail': {
    looks: [L('Echo & Trail', 'Feedback'), L('Melt & Smear', 'Liquefy')],
    explain: {
      does: 'Blends toward a past frame that is nudged sideways, so the trail drifts off in one direction instead of sitting on the subject.',
      useWhen: 'You want the picture to look like it is melting or being blown sideways.',
      worksWith: 'Small drift values; motion against the drift direction.',
      watchOut: 'Large drift shifts the whole frame, not just the trail.',
      tryNext: 'Breath trail for a depth that rises and falls.',
    },
  },
  'fx.breath-trail': {
    looks: [L('Echo & Trail', 'Feedback')],
    explain: {
      does: 'A feedback trail whose depth rises and falls on a slow cycle, in step across every block that uses it.',
      useWhen: 'You want trails that swell and recede with the music without wiring an LFO yourself.',
      worksWith: 'A cycle of one or two bars; a floor above zero so it never fully clears.',
      watchOut: 'The cycle follows the timeline, so a single short block may only see part of it.',
      tryNext: 'Feedback trail with an LFO on Amount for full control.',
    },
  },
  'fx.echo-taps': {
    looks: [L('Echo & Trail', 'Delay')],
    explain: {
      does: 'Adds several past frames at falling weight, so motion leaves distinct ghost copies rather than one smear.',
      useWhen: 'You want a stepped, strobing echo of movement, like a multiple exposure.',
      worksWith: 'Fast, simple shapes; three or four taps a few frames apart.',
      watchOut: 'Many taps on busy footage stack into noise.',
      tryNext: 'Chroma trail after it (the Ghost Echo recipe).',
    },
  },
  // ---------- Tone ----------
  'fx.saturation': {
    looks: [L('Colour & Split', 'Tone & grade')],
    explain: {
      does: 'Pulls colour out toward grey or pushes it beyond the source, without changing brightness.',
      useWhen: 'You want to calm a garish mosh, or make a dull one shout.',
      worksWith: 'The end of a chain, after the effects that move colour.',
      watchOut: 'Heavy saturation exaggerates compression blocks.',
      tryNext: 'Contrast, or Hue rotate for a different palette.',
    },
  },
  'fx.contrast': {
    looks: [L('Colour & Split', 'Tone & grade')],
    explain: {
      does: 'Pushes blacks and whites apart, or collapses them toward grey for a washed, faded picture.',
      useWhen: 'You want a moshed section to punch harder, or to sit back as faded background.',
      worksWith: 'The end of a chain; small amounts.',
      watchOut: 'High contrast crushes shadow and highlight detail, including the smear inside them.',
      tryNext: 'Brightness to place the level, or Posterize for hard steps.',
    },
  },
  'fx.brightness': {
    looks: [L('Colour & Split', 'Tone & grade')],
    explain: {
      does: 'Pushes the whole picture darker or brighter.',
      useWhen: 'You want to sit a section under another, or to fade one up or down with an LFO or a Value.',
      worksWith: 'A Value driving it across several blocks for one master level.',
      watchOut: 'Very bright settings clip highlights to flat white.',
      tryNext: 'Contrast for shape, not just level.',
    },
  },
  'fx.hue-rotate': {
    looks: [L('Colour & Split', 'Tone & grade')],
    explain: {
      does: 'Spins every colour around the colour wheel by a fixed angle, keeping brightness and saturation.',
      useWhen: 'You want a whole new palette from the same footage, or a slow colour cycle with an LFO.',
      worksWith: 'Colourful footage; an LFO on Degrees.',
      watchOut: 'Skin and familiar objects turn strange fast.',
      tryNext: 'Channel isolation to keep only part of the new palette.',
    },
  },
  'fx.invert': {
    looks: [L('Colour & Split', 'Tone & grade')],
    explain: {
      does: 'Flips every colour to its negative; partial amounts wash toward grey.',
      useWhen: 'You want a hard flash on a hit, or a negative-film section.',
      worksWith: 'Switch or a Value to flick it on for a few frames.',
      watchOut: 'At 50 % the picture goes flat grey.',
      tryNext: 'Mix in difference mode for an inverted overlay of two branches.',
    },
  },
  'fx.sepia': {
    looks: [L('Colour & Split', 'Tone & grade')],
    explain: {
      does: 'Tints the picture toward a warm monochrome, like old print.',
      useWhen: 'You want an aged, archival feel under a decay look.',
      worksWith: 'Salt & pepper and Soft blur for worn film.',
      watchOut: 'It removes the colour that colour effects later in the chain would move.',
      tryNext: 'Put it last in the chain, after colour effects.',
    },
  },
  'fx.posterize': {
    looks: [L('Decay & Corrupt', 'Compression'), L('Colour & Split', 'Tone & grade')],
    explain: {
      does: 'Quantises every channel to a handful of levels, so smooth gradients break into hard bands.',
      useWhen: 'You want a cheap-codec, banded look on smears and gradients.',
      worksWith: 'Gradients, skies, soft light, and smeared areas; four levels or fewer.',
      watchOut: 'On flat, saturated colour it changes almost nothing; it needs gradients.',
      tryNext: 'Resolution crush for blocky instead of banded.',
    },
  },
  // ---------- Geometry ----------
  'fx.mirror': {
    looks: [L('Fracture & Displace', 'Warp')],
    explain: {
      does: 'Reflects one half of the frame onto the other, horizontally or vertically.',
      useWhen: 'You want symmetric, kaleidoscope-like shapes out of a moshed picture.',
      worksWith: 'Off-centre motion, which becomes symmetric patterns.',
      watchOut: 'Centred subjects just look doubled.',
      tryNext: 'Transform to move the axis before mirroring.',
    },
  },
  'fx.transform': {
    looks: [L('Fracture & Displace', 'Warp')],
    explain: {
      does: 'Rotates, scales and offsets the picture, and moves the crop centre when zoomed in.',
      useWhen: 'You want to reframe a moshed shot, or drive a zoom or turn with an LFO.',
      worksWith: 'Feedback loop, where small transforms become tunnels.',
      watchOut: 'Scaling down shows the border; scaling up softens detail.',
      tryNext: 'Mirror after it for symmetry.',
    },
  },
  'fx.row-displacement': {
    looks: [L('Fracture & Displace', 'Slice & shear'), L('Decay & Corrupt', 'VHS & analog')],
    explain: {
      does: 'Shifts horizontal bands sideways by a curve: tearing, rolling shutter, VHS tracking or a wave.',
      useWhen: 'You want the picture to tear or wobble along its rows, like a failing tape or screen.',
      worksWith: 'Strong verticals, which show the shear most; animated speed.',
      watchOut: 'Tall bands with large amounts slice the frame into unrelated strips.',
      tryNext: 'Field desync for time-based row damage.',
    },
  },
  'fx.pixel-stretch': {
    looks: [L('Fracture & Displace', 'Pixel sort')],
    explain: {
      does: 'Smears one row or column of colour outward from a source line, a streak that drags pixels across the frame.',
      useWhen: 'You want the streaked, pixel-sort-like look of a scanner or broken sensor.',
      worksWith: 'Bright, colourful source lines; reach under half the frame.',
      watchOut: 'It replaces what lies in the streak\'s path rather than blending.',
      tryNext: 'Row displacement for a sideways shear instead of a streak.',
    },
  },
  'fx.resolution-crush': {
    looks: [L('Fracture & Displace', 'Macroblock'), L('Decay & Corrupt', 'Compression')],
    explain: {
      does: 'Draws the picture at a lower internal resolution and scales it back, blocky or soft.',
      useWhen: 'You want big chunky pixels on a hit, or the low-resolution look of a dropped stream.',
      worksWith: 'Fine detail and diagonals, where the blocks show; factors of 16 or more for a loud look.',
      watchOut: 'At the default ×8, large flat colour areas look almost unchanged at full screen.',
      tryNext: 'Ping-pong before the Decode (the Beat Chop recipe).',
    },
  },
  // ---------- Degrade ----------
  'fx.soft-blur': {
    looks: [L('Melt & Smear', 'Liquefy')],
    explain: {
      does: 'A gentle blur that softens rough or noisy footage without changing timing.',
      useWhen: 'You want a moshed section to melt into softness, or to tame harsh compression edges.',
      worksWith: 'After Feedback trail (the Dream Melt recipe); small radius.',
      watchOut: 'It also softens the hard block edges that make a mosh read as a mosh.',
      tryNext: 'Feedback trail before it for a dreamy smear.',
    },
  },
  'fx.salt-pepper': {
    looks: [L('Decay & Corrupt', 'Noise')],
    explain: {
      does: 'Scatters sparse random black and white pixels across the picture: impulse noise, like dropout, not grain.',
      useWhen: 'You want signal damage on top of a decay look, or crackle on a hit.',
      worksWith: 'Low density; dark or mid-grey areas where it shows.',
      watchOut: 'High density covers the picture and fights compression.',
      tryNext: 'Field desync or Row displacement for structured damage.',
    },
  },
  // ---------- Utility ----------
  'decode.webcodecs': {
    looks: [L('Utility', 'Convert')],
    explain: {
      does: 'Turns the encoded stream into pictures: everything before it moshes the bitstream, everything after it works on pixels.',
      useWhen: 'Always present; place it yourself only to see or move the boundary.',
      worksWith: 'Mosh ops on its left, picture effects on its right.',
      watchOut: 'Deleting it keeps the wire; the block still decodes once.',
      tryNext: 'Reroute (stream) to tidy wires before it.',
    },
  },
  'route.mix': {
    looks: [L('Utility', 'Blend & switch')],
    explain: {
      does: 'Blends two pictures by a mode (mix, add, screen, difference, multiply), optionally through a mask.',
      useWhen: 'You want two branches of the graph in one frame: a clean copy under a moshed one, or a difference overlay.',
      worksWith: 'A clean branch and an effected branch from the same Decode.',
      watchOut: 'Add and screen brighten fast; difference of two near-identical branches is near black.',
      tryNext: 'Switch to cut between branches instead of blending.',
    },
  },
  'route.switch': {
    looks: [L('Utility', 'Blend & switch')],
    explain: {
      does: 'Picks one of up to four pictures by its Input number.',
      useWhen: 'You want to hot-swap looks on the beat with an LFO or a Value.',
      worksWith: 'A stepped LFO on Input.',
      watchOut: 'Every branch is computed even when not shown, so heavy branches cost time.',
      tryNext: 'Mix to crossfade instead of cut.',
    },
  },
  'route.delay': {
    looks: [L('Utility', 'Routing')],
    explain: {
      does: "Outputs last frame's input: the only way to wire a loop.",
      useWhen: 'You want to build your own feedback from any chain of effects.',
      worksWith: 'Mix with a small amount of the delayed frame.',
      watchOut: 'A loop at full mix never clears.',
      tryNext: 'Feedback trail for a ready-made loop.',
    },
  },
  'route.reroute': {
    looks: [L('Utility', 'Routing')],
    explain: {
      does: 'Passes a picture wire on unchanged, a bend point to tidy the graph.',
      useWhen: 'Wires cross or run behind nodes.',
      worksWith: 'Double-click any picture wire to add one.',
      watchOut: 'Nothing; it changes no pixels.',
      tryNext: 'Null for a named point.',
    },
  },
  'route.reroute-stream': {
    looks: [L('Utility', 'Routing')],
    explain: {
      does: 'Passes an encoded wire on unchanged, before the Decode.',
      useWhen: 'Bitstream wires cross or run behind nodes.',
      worksWith: 'Chains of Mosh ops between the Clip and the Decode.',
      watchOut: 'Nothing; it changes no frames.',
      tryNext: 'Reroute for picture wires.',
    },
  },
  'route.null': {
    looks: [L('Utility', 'Routing')],
    explain: {
      does: 'A named checkpoint that passes its picture on unchanged.',
      useWhen: 'You want to add nodes before a point later without rewiring what follows it.',
      worksWith: 'The end of a chain, before the Output.',
      watchOut: 'Nothing; it changes no pixels.',
      tryNext: 'Switch to choose between several chains at that point.',
    },
  },
};
