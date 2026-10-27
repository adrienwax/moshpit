# Local installer candidate
Build with `node app/pack.mjs --installer --candidate`, with reviewed local FFmpeg binaries
via MOSHPIT_FFMPEG_DIR and Python/Pillow via KRAB_BUILD_PYTHON. The packaging tool is locked.
The candidate has its own product ID, settings and CT endpoint. The installer does not
launch it automatically; uninstall preserves user data. Do not distribute this unsigned
candidate until binary licences/source, clean-machine checks and signing are resolved.
