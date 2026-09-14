#!/usr/bin/env node
/**
 * Regenerate the platform app icons from the brand SVG sources in
 * OBrowser_Logo_v1/.
 *
 *   node scripts/generate-icons.js
 *
 * Produces obrowser.icns (macOS), obrowser.ico (Windows), obrowser.png (Linux)
 * and obrowser.svg, which are the paths referenced by package.json and main.js.
 *
 * Two things are deliberate:
 *
 * 1. macOS icons get a transparent margin. Apple's grid puts the rounded plate
 *    in 824 of a 1024 canvas, so a full-bleed plate would render visibly larger
 *    than every neighbouring icon in the Dock. Windows and Linux icons stay
 *    full-bleed, which is their convention.
 * 2. Small sizes are rendered from obrowser-favicon.svg, a variant whose ring is
 *    thickened for tiny rendering, rather than downscaling the large artwork
 *    until the ring disappears.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'OBrowser_Logo_v1', 'svg');
const APP_SVG = path.join(ASSETS, 'obrowser-app.svg');
const SMALL_SVG = path.join(ASSETS, 'obrowser-favicon.svg');

// Apple's macOS app icon grid: the plate fills 824 of a 1024 canvas.
const MAC_PLATE_RATIO = 824 / 1024;
// Below this displayed point size, use the small-optimised artwork.
const SMALL_ART_MAX_PT = 16;

/**
 * Render one square icon.
 * @param {number} px - Output edge length in pixels
 * @param {number} pt - Displayed point size, which selects the artwork
 * @param {boolean} pad - Apply the macOS transparent margin
 * @returns {Promise<Buffer>} PNG buffer
 */
async function render(px, pt, pad) {
  const svg = pt <= SMALL_ART_MAX_PT ? SMALL_SVG : APP_SVG;
  const plate = pad ? Math.round(px * MAC_PLATE_RATIO) : px;

  // density scales the SVG rasterisation so the plate is crisp at `plate` px.
  const art = await sharp(svg, { density: Math.max(72, Math.ceil((plate / 512) * 72 * 4)) })
    .resize(plate, plate, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  if (!pad) return art;

  const offset = Math.round((px - plate) / 2);
  return sharp({
    create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: art, top: offset, left: offset }])
    .png()
    .toBuffer();
}

/**
 * Build an .ico containing PNG-compressed images at several sizes.
 * Hand-assembled because sharp cannot write the ICO container.
 * @param {Array<{size: number, data: Buffer}>} images - Sorted ascending
 * @returns {Buffer} ICO file contents
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((img, i) => {
    const at = i * 16;
    // 256 is encoded as 0 in a single byte.
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 0);
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(img.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, directory, ...images.map(i => i.data)]);
}

async function main() {
  for (const svg of [APP_SVG, SMALL_SVG]) {
    if (!fs.existsSync(svg)) throw new Error(`Missing brand asset: ${svg}`);
  }

  // ---- macOS .icns -------------------------------------------------------
  // Each entry is [file pixels, displayed points].
  const icnsEntries = [
    ['icon_16x16.png', 16, 16],
    ['icon_16x16@2x.png', 32, 16],
    ['icon_32x32.png', 32, 32],
    ['icon_32x32@2x.png', 64, 32],
    ['icon_128x128.png', 128, 128],
    ['icon_128x128@2x.png', 256, 128],
    ['icon_256x256.png', 256, 256],
    ['icon_256x256@2x.png', 512, 256],
    ['icon_512x512.png', 512, 512],
    ['icon_512x512@2x.png', 1024, 512]
  ];

  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'obrowser-')) + '/obrowser.iconset';
  fs.mkdirSync(iconset, { recursive: true });
  for (const [name, px, pt] of icnsEntries) {
    fs.writeFileSync(path.join(iconset, name), await render(px, pt, true));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ROOT, 'obrowser.icns')]);
  fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  console.log('obrowser.icns  ', icnsEntries.length, 'layers, plate at 80.5% with transparent margin');

  // ---- Windows .ico ------------------------------------------------------
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of icoSizes) {
    icoImages.push({ size, data: await render(size, size, false) });
  }
  fs.writeFileSync(path.join(ROOT, 'obrowser.ico'), buildIco(icoImages));
  console.log('obrowser.ico   ', icoSizes.join(', '), '(full-bleed)');

  // ---- Linux .png --------------------------------------------------------
  fs.writeFileSync(path.join(ROOT, 'obrowser.png'), await render(1024, 1024, false));
  console.log('obrowser.png    1024 (full-bleed)');

  // ---- Vector source -----------------------------------------------------
  fs.copyFileSync(APP_SVG, path.join(ROOT, 'obrowser.svg'));
  console.log('obrowser.svg    copied from OBrowser_Logo_v1/svg/obrowser-app.svg');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
