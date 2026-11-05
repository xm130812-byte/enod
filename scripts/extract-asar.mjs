import fs from 'node:fs/promises';
import path from 'node:path';

const asarPath = process.argv[2] || 'D:\\deepseek\\resources\\app.asar';
const outDir = process.argv[3] || 'D:\\something\\md-reader\\.devdata\\dsh-asar';
const filter = (process.argv[4] || '.css').toLowerCase();

const fd = await fs.open(asarPath, 'r');
try {
  const head = Buffer.alloc(16);
  await fd.read(head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const headerBuf = Buffer.alloc(headerSize);
  await fd.read(headerBuf, 0, headerSize, 16);
  const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/g, ''));
  const dataStart = 16 + headerSize;

  const found = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, full);
      else if (full.toLowerCase().endsWith(filter)) {
        if (entry.offset === undefined) {
          console.log(`skip (unpacked/no offset): ${full}`);
          continue;
        }
        found.push({ path: full, offset: Number(entry.offset), size: entry.size });
      }
    }
  };
  walk(header, '');

  await fs.mkdir(outDir, { recursive: true });
  const index = [];
  for (const item of found) {
    const buf = Buffer.alloc(item.size);
    await fd.read(buf, 0, item.size, dataStart + item.offset);
    const safeName = item.path.replace(/[\\/]/g, '__');
    await fs.writeFile(path.join(outDir, safeName), buf);
    index.push({ path: item.path, size: item.size, file: safeName });
  }
  await fs.writeFile(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`extracted ${index.length} ${filter} files -> ${outDir}`);
  for (const item of index.sort((a, b) => b.size - a.size).slice(0, 20)) {
    console.log(`${String(item.size).padStart(8)}  ${item.path}`);
  }
} finally {
  await fd.close();
}
