// Generates build/icon.png (1024px master) and build/icon.ico (multi-size)
// from the diagonal chain mark. Run with:
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/gen-app-icon.cjs
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'build')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const MASTER = 1024

const PAGE_W = 1200
const PAGE_H = 1400
const ROW_Y = 1080
const GAP = 24

function iconSvg(size, attrs = '') {
  // Tiny sizes get a bigger, slightly heavier mark so the pair still reads.
  const small = size <= 24
  const fill = small ? 0.76 : 0.64
  const stroke = small ? 5 : 4.2
  const gapStroke = small ? 6.4 : 5.8
  const scale = (fill * 1024) / 42.7 // 42.7 = rotated art bounding width in 44-units
  const offset = 512 - 22 * scale
  return `<svg ${attrs} xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="bg${size}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0071e3"/>
      <stop offset="1" stop-color="#5856d6"/>
    </linearGradient>
    <mask id="cut${size}">
      <rect x="0" y="0" width="1024" height="1024" fill="#fff"/>
      <ellipse cx="15" cy="22" rx="9.5" ry="8" fill="none" stroke="#000" stroke-width="${gapStroke}"/>
    </mask>
  </defs>
  <rect width="1024" height="1024" rx="230" fill="url(#bg${size})"/>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(4)})" stroke="#fff" stroke-width="${stroke}" fill="none">
    <g transform="rotate(-32 22 22)">
      <ellipse cx="29" cy="22" rx="9.5" ry="8" mask="url(#cut${size})"/>
      <ellipse cx="15" cy="22" rx="9.5" ry="8"/>
    </g>
  </g>
</svg>`
}

function pageHtml() {
  const marks = []
  const layout = []
  marks.push(iconSvg(MASTER, 'style="position:absolute;left:0;top:0"'))
  let x = GAP
  for (const size of ICO_SIZES) {
    marks.push(iconSvg(size, `style="position:absolute;left:${x}px;top:${ROW_Y}px"`))
    layout.push({ size, x, y: ROW_Y })
    x += size + GAP
  }
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    </style></head><body>${marks.join('')}</body></html>`,
    layout
  }
}

function buildIco(images) {
  const count = images.length
  const header = Buffer.alloc(6 + count * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((image) => image.png)])
}

app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(join(OUT_DIR, 'icons'), { recursive: true })

  const { html, layout } = pageHtml()
  const win = new BrowserWindow({
    width: PAGE_W,
    height: PAGE_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 500))

  const master = await win.webContents.capturePage({ x: 0, y: 0, width: MASTER, height: MASTER })
  writeFileSync(join(OUT_DIR, 'icon.png'), master.toPNG())

  const images = []
  for (const { size, x, y } of layout) {
    const image = await win.webContents.capturePage({ x, y, width: size, height: size })
    const png = image.toPNG()
    writeFileSync(join(OUT_DIR, 'icons', `icon-${size}.png`), png)
    // BGRA bitmap: index 3 is the alpha of the top-left pixel
    console.log(`rendered ${size}px  ${image.getSize().width}x${image.getSize().height}  corner alpha=${image.toBitmap()[3]}`)
    images.push({ size, png })
  }

  writeFileSync(join(OUT_DIR, 'icon.ico'), buildIco(images))
  console.log('wrote build/icon.png + build/icon.ico')
  win.destroy()
  app.quit()
})
