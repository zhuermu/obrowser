// Regenerate raster exports and the review sheet from the editable SVG masters.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.env.OBROWSER_NODE_MODULES
  ? path.join(process.env.OBROWSER_NODE_MODULES, 'sharp')
  : '/Users/lixiaowei/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root = path.resolve(__dirname, '..');
const svgDir = path.join(root, 'svg');
const pngDir = path.join(root, 'png');
const favDir = path.join(root, 'favicon');
const source = (file) => fs.readFileSync(path.join(svgDir, file), 'utf8');
const uri = (file) => 'data:image/svg+xml;base64,' + Buffer.from(source(file)).toString('base64');
const image = (file, x, y, w, h) => `<image href="${uri(file)}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;

async function main() {
  fs.mkdirSync(pngDir, { recursive: true });
  fs.mkdirSync(favDir, { recursive: true });
  const jobs = [];
  for (const file of fs.readdirSync(svgDir).filter(f => f.endsWith('.svg'))) {
    const name = path.basename(file, '.svg');
    const widths = name.includes('favicon') ? [16, 24, 32, 48, 64]
      : name.includes('lockup') ? [960, 1920] : [256, 512, 1024];
    for (const width of widths) {
      const dir = name.includes('favicon') ? favDir : pngDir;
      jobs.push(sharp(Buffer.from(source(file))).resize({ width }).png()
        .toFile(path.join(dir, `${name}-${width}.png`)));
    }
  }
  await Promise.all(jobs);

  // ICO supports PNG-encoded frames. Keep all relevant desktop favicon sizes.
  const sizes = [16, 32, 48, 64];
  const frames = sizes.map(s => fs.readFileSync(path.join(favDir, `obrowser-favicon-${s}.png`)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const p = 6 + i * 16;
    header[p] = s;
    header[p + 1] = s;
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(frames[i].length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += frames[i].length;
  });
  fs.writeFileSync(path.join(favDir, 'favicon.ico'), Buffer.concat([header, ...frames]));

  const board = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1060" viewBox="0 0 1440 1060">
    <rect width="1440" height="1060" fill="#F3F4F8"/>
    <g font-family="Arial, sans-serif" fill="#12182B">
      <text x="56" y="58" font-size="17" letter-spacing="2.5">OBROWSER / IDENTITY 01</text>
      <text x="1384" y="58" text-anchor="end" fill="#626A7E" font-size="15">O + OBJECT</text>
      <rect x="40" y="96" width="1360" height="420" rx="20" fill="#FFFFFF"/>
      ${image('obrowser-lockup-color.svg', 192, 160, 1056, 282)}
      <text x="720" y="474" text-anchor="middle" fill="#626A7E" font-size="15" letter-spacing="4">OBJECT STORAGE. IN VIEW.</text>
      <rect x="40" y="540" width="438" height="334" rx="20" fill="#FFFFFF"/>
      <text x="68" y="580" fill="#626A7E" font-size="14" letter-spacing="1.5">01 / MONOCHROME</text>
      ${image('obrowser-mark-mono.svg', 154, 612, 210, 210)}
      <rect x="501" y="540" width="438" height="334" rx="20" fill="#12182B"/>
      <text x="529" y="580" fill="#BDC3D5" font-size="14" letter-spacing="1.5">02 / REVERSED</text>
      ${image('obrowser-mark-white.svg', 615, 612, 210, 210)}
      <rect x="962" y="540" width="438" height="334" rx="20" fill="#E8ECFF"/>
      <text x="990" y="580" fill="#626A7E" font-size="14" letter-spacing="1.5">03 / APP ICON</text>
      ${image('obrowser-app.svg', 1099, 634, 164, 164)}
      <text x="56" y="939" fill="#626A7E" font-size="14" letter-spacing="1.5">SMALL BY DESIGN</text>
      ${image('obrowser-favicon.svg', 259, 913, 32, 32)}
      <text x="301" y="936" fill="#626A7E" font-size="13">32</text>
      ${image('obrowser-favicon.svg', 352, 917, 24, 24)}
      <text x="386" y="936" fill="#626A7E" font-size="13">24</text>
      ${image('obrowser-favicon.svg', 437, 921, 16, 16)}
      <text x="463" y="936" fill="#626A7E" font-size="13">16 px</text>
      <rect x="1035" y="916" width="24" height="24" rx="6" fill="#3558F5"/>
      <text x="1069" y="934" fill="#626A7E" font-size="14">#3558F5</text>
      <rect x="1220" y="916" width="24" height="24" rx="6" fill="#7448F5"/>
      <text x="1254" y="934" fill="#626A7E" font-size="14">#7448F5</text>
      <path d="M56 978H1384" stroke="#DCDFE8"/>
      <text x="56" y="1016" fill="#626A7E" font-size="14">One open O. One object. Nothing extra.</text>
      <text x="1384" y="1016" text-anchor="end" fill="#626A7E" font-size="14">DESIGN PROPOSAL / NOT TRADEMARK-CLEARED</text>
    </g>
  </svg>`;
  fs.writeFileSync(path.join(root, 'obrowser-review.svg'), board);
  await sharp(Buffer.from(board)).png().toFile(path.join(root, 'obrowser-review.png'));
  const checks = [];
  for (const dir of [pngDir, favDir]) {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.png'))) {
      const meta = await sharp(path.join(dir, file)).metadata();
      checks.push({file: path.relative(root, path.join(dir, file)), width: meta.width, height: meta.height, alpha: meta.hasAlpha});
    }
  }
  fs.writeFileSync(path.join(root, 'source', 'export-checks.json'), JSON.stringify(checks, null, 2) + '\n');
  console.log(JSON.stringify({svgs: fs.readdirSync(svgDir).length, rasterExports: checks.length, alpha: checks.every(c=>c.alpha), board: '1440 × 1060'}, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
