#!/usr/bin/env bash
# Run inside an isolated MSYS2 UCRT64 shell. All output stays under the argument.
set -euo pipefail
root="$(cd "${1:?Pass the prepared build directory}" && pwd -P)"
prefix="$root/prefix"
jobs="${KRAB_BUILD_JOBS:-4}"
test "$MSYSTEM" = UCRT64
for name in ffmpeg x264 zlib snappy dav1d zimg; do test -d "$root/sources/$name"; done
mkdir -p "$prefix/lib/pkgconfig" "$prefix/include" "$root/build"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
pacman -Q > "$root/toolchain-packages.txt"
gcc --version > "$root/compiler-version.txt"

cd "$root/sources/zlib"
make -f win32/Makefile.gcc -j"$jobs" libz.a
cp libz.a "$prefix/lib/"
cp zlib.h zconf.h "$prefix/include/"
# FFmpeg detects zlib using its headers/library, not this toolchain's shared zlib.

cd "$root/sources/x264"
bash ./configure --prefix="$prefix" --host=x86_64-w64-mingw32 --enable-static --disable-cli --disable-opencl --extra-ldflags=-static
make -j"$jobs"
make install-lib-static

cmake -S "$root/sources/snappy" -B "$root/build/snappy" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF \
  -DSNAPPY_BUILD_TESTS=OFF -DSNAPPY_BUILD_BENCHMARKS=OFF
cmake --build "$root/build/snappy" --parallel "$jobs"
cmake --install "$root/build/snappy"

meson setup "$root/build/dav1d" "$root/sources/dav1d" --prefix="$prefix" --libdir=lib \
  --buildtype=release --default-library=static --wrap-mode=nodownload \
  -Denable_tests=false -Denable_tools=false -Denable_examples=false
meson compile -C "$root/build/dav1d" -j "$jobs"
meson install -C "$root/build/dav1d"
cd "$root/sources/zimg"
bash ./autogen.sh
bash ./configure --prefix="$prefix" --host=x86_64-w64-mingw32 --enable-static --disable-shared --disable-testapp --disable-example --disable-unit-test
make -j"$jobs"
make install

cd "$root/build"
mkdir -p ffmpeg
cd ffmpeg
bash "$root/sources/ffmpeg/configure" \
  --prefix="$prefix" --target-os=mingw32 --arch=x86_64 \
  --disable-autodetect --disable-network --disable-doc --disable-debug --disable-ffplay \
  --disable-shared --enable-static --enable-gpl --enable-libx264 --enable-libsnappy --enable-zlib --enable-libdav1d --enable-libzimg \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib -static" \
  --extra-libs='-lstdc++ -lwinpthread' --extra-version=krab-local-1
make -j"$jobs"
make install
cp ffbuild/config.log "$root/ffmpeg-config.log"
cp config.h "$root/ffmpeg-config.h"
"$prefix/bin/ffmpeg.exe" -version > "$root/ffmpeg-version.txt"
"$prefix/bin/ffprobe.exe" -version > "$root/ffprobe-version.txt"
objdump -p "$prefix/bin/ffmpeg.exe" > "$root/ffmpeg-pe.txt"
objdump -p "$prefix/bin/ffprobe.exe" > "$root/ffprobe-pe.txt"
printf '\nControlled FFmpeg build completed. Capability and distribution review still required.\n'
