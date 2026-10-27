// Shared project/default/output choices. Portrait is explicit; existing landscape defaults stay first.
export const PROJECT_RESOLUTIONS = [
  { w: 1920, h: 1080, label: '1920×1080' },
  { w: 3840, h: 2160, label: '3840×2160' },
  { w: 1280, h: 720, label: '1280×720' },
  { w: 1080, h: 1920, label: '1080×1920' },
] as const;
