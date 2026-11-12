// Packages the Windows installer with the electron-builder binaries pulled from
// npmmirror. electron-builder fetches winCodeSign / NSIS from GitHub, which
// times out on this network; the mirror makes `npm run build:win` work as-is
// from any shell (cmd, PowerShell and Git Bash alike).
import { spawnSync } from 'node:child_process'

const MIRRORS = {
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/'
}

for (const [key, value] of Object.entries(MIRRORS)) {
  if (!process.env[key]) process.env[key] = value
}

const result = spawnSync('npx', ['electron-builder', '--win', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: process.env
})
process.exit(result.status ?? 1)
