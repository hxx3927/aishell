// Renders docs/design/link-wordmark.html to docs/design/link-wordmark.png so the wordmark
// candidates can be reviewed as an image. Run with:
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/render-wordmark-preview.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 1160,
    show: true,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#161617',
    webPreferences: { offscreen: false }
  })
  await win.loadFile(join(__dirname, '..', 'docs', 'design', 'link-wordmark.html'))
  // Give the page a moment to lay out before capturing.
  await new Promise((resolve) => setTimeout(resolve, 600))
  const image = await win.webContents.capturePage()
  writeFileSync(join(__dirname, '..', 'docs', 'design', 'link-wordmark.png'), image.toPNG())
  app.quit()
})
