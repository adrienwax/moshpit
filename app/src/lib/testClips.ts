// The HD test footage (the colour and motion clips), ready to browse from first run as the "test
// clips" favourite. Optional development footage, not a Starter Mosh prerequisite: the starter
// also uses the current Source folder or a native folder picker. The clips are not shipped inside the portable
// exe. The worker adds the folder as a library root when it exists,
// since the browser only lists folders under a root; MOSHPIT_TEST_CLIPS overrides it ('' turns it off).
// Preload exposes only this optional path, not process.env. Keep this module safe for the worker too.
export const TEST_CLIPS_DIR = (typeof window === 'undefined' ? undefined : window.moshpitHost?.testClipsDir) ?? '';
export const TEST_CLIPS_NAME = 'test clips';
