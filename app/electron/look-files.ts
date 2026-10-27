import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LOOK_EXTENSION, LOOK_MAX_BYTES, lookProblem, parsePortableLook } from '../../engine/src/project/lookIO';

export async function readLookFile(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LOOK_MAX_BYTES) lookProblem('Choose a look file no larger than 4 MB.');
    // Bound the actual read too: a file can grow between stat and read.
    const buffer = Buffer.alloc(LOOK_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > LOOK_MAX_BYTES) lookProblem('Choose a look file no larger than 4 MB.');
    const text = buffer.subarray(0, offset).toString('utf8');
    parsePortableLook(text);
    return text;
  } finally { await handle.close(); }
}

/** The path is used exactly as confirmed in the native dialog, with no extension rewriting. */
export async function writeLookFile(file: string, text: string): Promise<void> {
  if (!file.toLowerCase().endsWith(LOOK_EXTENSION)) lookProblem(`Use a filename ending in ${LOOK_EXTENSION}.`);
  parsePortableLook(text);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
