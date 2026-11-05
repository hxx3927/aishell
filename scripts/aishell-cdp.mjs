/**
 * Minimal CDP driver for the running AIShell window.
 *
 *   node scripts/aishell-cdp.mjs text
 *   node scripts/aishell-cdp.mjs eval "window.aishell ? 'api ok' : 'no api'"
 *   node scripts/aishell-cdp.mjs click-text "新建会话"
 *   node scripts/aishell-cdp.mjs shot scripts/shots/01.png
 *   node scripts/aishell-cdp.mjs press Enter
 *   node scripts/aishell-cdp.mjs type "hello"
 *
 * Requires the app to be started with --remote-debugging-port=9222.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = process.env.CDP_PORT || 9222
const [command, ...rest] = process.argv.slice(2)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target; is the app running with --remote-debugging-port?')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
const logs = []

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${message.params.exceptionDetails?.text} ${message.params.exceptionDetails?.exception?.description ?? ''}`)
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    logs.push(`[console.error] ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    logs.push(`[log] ${message.params.entry.text}`)
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Runtime.enable')
await send('Log.enable')

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

try {
  switch (command) {
    case 'text': {
      console.log(await evaluate('document.body.innerText'))
      break
    }
    case 'eval': {
      console.log(JSON.stringify(await evaluate(rest.join(' ')), null, 2))
      break
    }
    case 'click-text': {
      const wanted = rest.join(' ')
      const value = await evaluate(`(() => {
        const els = [...document.querySelectorAll('button, a, [role="button"]')]
        const el = els.find(e => e.textContent?.trim() === ${JSON.stringify(wanted)})
          ?? els.find(e => e.textContent?.includes(${JSON.stringify(wanted)}))
        if (!el) return 'NOT_FOUND'
        el.click()
        return 'OK ' + el.tagName + ' ' + el.textContent?.trim().slice(0, 40)
      })()`)
      console.log(value)
      break
    }
    case 'click': {
      const selector = rest.join(' ')
      const value = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return 'NOT_FOUND'
        el.click()
        return 'OK'
      })()`)
      console.log(value)
      break
    }
    case 'hover': {
      const selector = rest.join(' ')
      const rect = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`)
      if (!rect) {
        console.log('NOT_FOUND')
        break
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
      console.log('hover', selector, 'at', Math.round(rect.x), Math.round(rect.y))
      break
    }
    case 'window-close': {
      await evaluate('window.close()')
      break
    }
    case 'press': {
      const key = rest[0] ?? 'Enter'
      // "Ctrl+Shift+V" -> modifiers 2|8, code KeyV
      if (key.includes('+')) {
        const parts = key.split('+')
        const name = parts.pop()
        let modifiers = 0
        for (const part of parts) {
          if (part === 'Ctrl') modifiers |= 2
          if (part === 'Alt') modifiers |= 1
          if (part === 'Shift') modifiers |= 8
          if (part === 'Meta') modifiers |= 4
        }
        const upper = name.length === 1 ? name.toUpperCase() : name
        const code = name.length === 1 ? `Key${upper}` : name
        const vk = name.length === 1 ? upper.charCodeAt(0) : undefined
        const info = { code, key: name, modifiers, windowsVirtualKeyCode: vk }
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...info })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...info })
        break
      }
      const map = {
        Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
        Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
        Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
        ArrowDown: {
          code: 'ArrowDown',
          key: 'ArrowDown',
          windowsVirtualKeyCode: 40,
          text: '\u001b[B'
        },
        ArrowUp: {
          code: 'ArrowUp',
          key: 'ArrowUp',
          windowsVirtualKeyCode: 38,
          text: '\u001b[A'
        }
      }
      const info = map[key] ?? { code: key, key }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...info })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...info })
      break
    }
    case 'type': {
      await send('Input.insertText', { text: rest.join(' ') })
      break
    }
    case 'fill': {
      const joined = rest.join(' ')
      const split = joined.indexOf('=')
      const placeholder = split === -1 ? joined : joined.slice(0, split)
      const value = split === -1 ? '' : joined.slice(split + 1)
      const result = await evaluate(`(() => {
        const input = [...document.querySelectorAll('input')]
          .find(el => el.placeholder === ${JSON.stringify(placeholder)})
        if (!input) return 'NOT_FOUND'
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(value)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'OK'
      })()`)
      console.log('fill', placeholder, '->', result)
      break
    }
    case 'set-value': {
      const index = Number(rest[0])
      const value = rest.slice(1).join(' ')
      const result = await evaluate(`(() => {
        const inputs = [...document.querySelectorAll('input')]
        const input = inputs[${index}]
        if (!input) return 'NOT_FOUND (' + inputs.length + ' inputs)'
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(value)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'OK ' + (input.placeholder || input.type)
      })()`)
      console.log('set-value', index, '->', result)
      break
    }
    case 'dblclick-text': {
      const wanted = rest.join(' ')
      const value = await evaluate(`(() => {
        const els = [...document.querySelectorAll('div,button')]
        const el = els.reverse().find(e => e.textContent?.trim() === ${JSON.stringify(wanted)})
        if (!el) return 'NOT_FOUND'
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return 'OK'
      })()`)
      console.log(value)
      break
    }
    case 'inputs': {
      console.log(
        JSON.stringify(
          await evaluate(
            `[...document.querySelectorAll('input')].map((el, i) => ({ i, type: el.type, placeholder: el.placeholder, value: el.value }))`
          ),
          null,
          2
        )
      )
      break
    }
    case 'shot': {
      const path = rest[0] || `scripts/shots/shot-${Date.now()}.png`
      const result = await send('Page.captureScreenshot', { format: 'png' })
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.from(result.data, 'base64'))
      console.log('screenshot:', path)
      break
    }
    default: {
      console.error(
        'usage: text | eval <expr> | click-text <text> | click <sel> | hover <sel> | dblclick-text <text> | fill <placeholder>=<value> | set-value <index> <value> | inputs | shot <path> | press <key> | type <text>'
      )
      break
    }
  }
  if (logs.length) console.log(logs.join('\n'))
} finally {
  ws.close()
}
