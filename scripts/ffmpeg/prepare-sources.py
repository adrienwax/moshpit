"""Download exact FFmpeg build sources into a NEW local build directory (no compilation)."""
import argparse
import hashlib
import json
import posixpath
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import urllib.request
import zipfile


def safe_parts(name):
    parts = PurePosixPath(name).parts
    if not parts or name.startswith('/') or '\\' in name or ':' in name or '..' in parts:
        raise ValueError('Unsafe archive member: ' + name)
    return parts


def extract(archive, destination):
    if zipfile.is_zipfile(str(archive)):
        with zipfile.ZipFile(str(archive)) as z:
            for member in z.infolist():
                parts = safe_parts(member.filename)
                dest = destination.joinpath(*parts[1:])
                if member.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                elif len(parts) > 1:
                    payload = z.read(member)
                    if (member.external_attr >> 16) & 0o170000 == 0o120000:
                        # zimg has documentation links to headers in its own archive.
                        link = posixpath.normpath(posixpath.join(posixpath.dirname(member.filename), payload.decode()))
                        target_parts = safe_parts(link)
                        if target_parts[0] != parts[0]:
                            raise ValueError('Archive link escapes its source tree')
                        target = z.getinfo(link)
                        if (target.external_attr >> 16) & 0o170000 == 0o120000:
                            raise ValueError('Chained archive link refused')
                        payload = z.read(target)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(payload)
    else:
        with tarfile.open(str(archive)) as t:
            for member in t.getmembers():
                parts = safe_parts(member.name)
                if member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
                    raise ValueError('Unsupported tar member: ' + member.name)
                dest = destination.joinpath(*parts[1:])
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                elif len(parts) > 1:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(t.extractfile(member).read())


def prepare(manifest, output, reuse=None):
    data = json.loads(manifest.read_text(encoding='utf-8'))
    output.mkdir(parents=True, exist_ok=False)
    archives = output / 'archives'
    archives.mkdir()
    for item in data['components']:
        suffix = '.tar.gz' if item['url'].endswith('.tar.gz') else '.zip'
        name = '{}-source-{}{}'.format(item['component'], item['commit'], suffix)
        archive = archives / name
        if reuse and (reuse/name).is_file():
            shutil.copyfile(str(reuse/name), str(archive))
        else:
            with urllib.request.urlopen(item['url'], timeout=60) as response, archive.open('xb') as f:
                shutil.copyfileobj(response, f)
        if archive.stat().st_size != item['bytes'] or hashlib.sha256(archive.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Source archive checksum/size mismatch: ' + name)
        directory = item.get('directory', item['component'])
        safe_parts(directory)
        extract(archive, output/'sources'/directory)
    (output/'sources.json').write_text(json.dumps(data, indent=2)+'\n', encoding='utf-8')
    print('Pinned sources ready; no build, install or upload performed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--reuse-archives', type=Path)
    args = parser.parse_args()
    prepare(Path(__file__).with_name('sources.json'), args.output.resolve(), args.reuse_archives)
