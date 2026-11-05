// Renders a docs/*.html file to a PNG for design review. Run with:
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/render-docs-shot.cjs <in.html> <out.png> [w] [h]
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')

const [input, output, widthArg, heightArg] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: render-docs-shot.cjs <in.html> <out.png> [width] [height]')
  app.quit()
  process.exit(1)
}

// Render at 2x so the small-size icons stay legible in the review image.
app.commandLine.appendSwitch('force-device-scale-factor', '2')

const width = Number(widthArg) || 1360
const height = Number(heightArg) || 440
const toPath = (p) => (isAbsolute(p) ? p : join(process.cwd(), p))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#f5f5f7',
    webPreferences: { offscreen: true }
  })
  await win.loadFile(toPath(input))
  await new Promise((resolve) => setTimeout(resolve, 700))
  const image = await win.webContents.capturePage()
  writeFileSync(toPath(output), image.toPNG())
  console.log('wrote', output, image.getSize())
  app.quit()
})
