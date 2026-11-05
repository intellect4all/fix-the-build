// Sums gzipped size of everything a page loads from web/dist. Budget: 120 KB.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = new URL('../web/dist/', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
let total = 0;
for (const f of walk(dist)) {
  const gz = gzipSync(readFileSync(f), { level: 9 }).length;
  total += gz;
  console.log(`${(gz / 1024).toFixed(1).padStart(7)} KB  ${relative(dist, f)}`);
}
const budget = 120 * 1024;
console.log(`${(total / 1024).toFixed(1).padStart(7)} KB  TOTAL (all pages, gzipped) — budget 120 KB per page`);
if (total > budget) { console.error('OVER BUDGET'); process.exit(1); }
