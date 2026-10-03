#!/usr/bin/env node
// Guided Joy-Con 2 motion recording through a RUNNING game server (native bridge), for tuning the motion pipeline with real data.
// Usage: node tools/record-imu.mjs [--port 8137] [--side R|L|any] [--out-dir recordings] [--steps steps.json]
// It connects the controller itself (hold SYNC when asked), then walks through labelled motion steps with countdowns and writes
// one JSON line per report: {"t":<wall ms>,"ht":<helper ms>,"step":"<name>","hex":"<126 hex chars>"}.
// Close the game tab in the browser first: the bridge serves one session at a time.
// Clay Rush hardware session (docs/game-design.md 11): node tools/record-imu.mjs --steps tools/shooting-steps.json, then
// node tools/analyze-shots.mjs (newest recording) for the trigger jerk and the recommended triggerCompMs. Without --steps the
// default plan below is the sword plan of the previous game (the one of recordings/imu-2026-09-30T18-42-24.jsonl).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const PORT = Number(opt('port', 8137))
const SIDE = opt('side', 'any')
const OUT_DIR = opt('out-dir', 'recordings')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.join(OUT_DIR, `imu-${STAMP}.jsonl`)

const DEFAULT_STEPS = [
  { name: 'rest_table', seconds: 12, text: 'Lay the Joy-Con (or the sword) FLAT on the table, hands off. Do not touch it.' },
  { name: 'hold_still', seconds: 10, text: 'Pick it up and hold it like the sword, pointing at the screen centre. Hold as still as you can.' },
  { name: 'yaw_sweep', seconds: 22, text: 'Keep pointing at the screen. Slowly sweep LEFT then RIGHT, about 60 degrees each side, 5 round trips (about 4 s each).' },
  { name: 'pitch_sweep', seconds: 22, text: 'Slowly move the tip UP then DOWN, about 40 degrees each side, 5 round trips.' },
  { name: 'roll_360', seconds: 18, text: 'Point at the screen and ROLL it around its own long axis, like turning a key: 4 full turns (about 4 s each).' },
  { name: 'table_spin_360', seconds: 18, text: 'Lay it FLAT on the table and spin it slowly on the table like a bottle: 4 full turns (about 4 s each).' },
  { name: 'fast_swings_h', seconds: 14, text: 'Pointing at the screen, do 8 FAST horizontal slashes, about one every 1.5 s.' },
  { name: 'fast_swings_v', seconds: 14, text: 'Now 8 FAST vertical slashes (top to bottom), about one every 1.5 s.' },
  { name: 'return_still', seconds: 12, text: 'Return to EXACTLY the starting pose, pointing at the screen centre, and hold still.' },
]
const STEPS = opt('steps') ? JSON.parse(fs.readFileSync(opt('steps'), 'utf8')) : DEFAULT_STEPS
const T = JSON.parse(opt('texts') ? fs.readFileSync(opt('texts'), 'utf8') : '{}')
const say = (key, fallback) => T[key] ?? fallback

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bell = () => process.stdout.write('\x07')

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body)
    const headers = { 'X-Joycon-Ninja': '1' }
    if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data) }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

let current = null // current step name, null outside steps
let streaming = false
let lastState = ''
let fatal = null
const out = (fs.mkdirSync(OUT_DIR, { recursive: true }), fs.createWriteStream(OUT))
const counts = {}
let firstWall = {}, lastWall = {}

function onEvent(ev) {
  if (ev.type === 'status') {
    if (ev.state !== lastState) { lastState = ev.state; console.log(`  [bridge] ${ev.state}${ev.code ? ' (' + ev.code + ')' : ''}${ev.message ? ': ' + ev.message : ''}`) }
    if (ev.state === 'streaming') streaming = true
    if (ev.state === 'error' || ev.state === 'disconnected') { if (current !== null || !streaming) fatal = ev }
  } else if (ev.type === 'report' && current !== null) {
    const now = Date.now()
    out.write(JSON.stringify({ t: now, ht: ev.t, step: current, hex: ev.hex }) + '\n')
    counts[current] = (counts[current] || 0) + 1
    firstWall[current] ??= now
    lastWall[current] = now
  }
}

function openEvents() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/__bridge/events', headers: { Accept: 'text/event-stream', 'X-Joycon-Ninja': '1' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`events endpoint answered ${res.statusCode}`)); return }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          for (const line of block.split('\n')) if (line.startsWith('data:')) { try { onEvent(JSON.parse(line.slice(5).trim())) } catch { /* heartbeat or partial */ } }
        }
      })
      resolve(req)
    })
    req.on('error', reject)
  })
}

async function waitFor(cond, ms, label) {
  const t0 = Date.now()
  while (!cond()) {
    if (fatal) throw new Error(`${label}: bridge reported ${fatal.state}${fatal.code ? ' ' + fatal.code : ''} ${fatal.message ?? ''}`)
    if (Date.now() - t0 > ms) throw new Error(`${label}: timed out after ${Math.round(ms / 1000)} s`)
    await sleep(100)
  }
}

async function main() {
  console.log('\n=== Joy-Con 2 motion recording ===')
  const st = await request('GET', '/__bridge/status').catch(() => null)
  if (!st || st.status !== 200) throw new Error(`no game server with the native bridge on port ${PORT}`)
  console.log(`  bridge status: ${st.body}`)
  const events = await openEvents()
  await request('POST', '/__bridge/disconnect', {}).catch(() => {})
  await sleep(2500)
  fatal = null; streaming = false
  await request('POST', '/__bridge/connect', { side: SIDE })
  bell()
  console.log('\n' + say('sync', '>>> HOLD THE SYNC BUTTON on the Joy-Con now, until the lights sweep (you have about 45 s). <<<'))
  await waitFor(() => streaming, 75000, 'connecting')
  bell()
  console.log('\n' + say('connected', 'CONNECTED. The guided motion steps start in 6 seconds. Follow the instructions on screen.'))
  out.write(JSON.stringify({ type: 'meta', stamp: STAMP, port: PORT, side: SIDE, steps: STEPS.map((s) => ({ name: s.name, seconds: s.seconds })) }) + '\n')
  await sleep(6000)
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i]
    console.log(`\n--- ${say('step', 'STEP')} ${i + 1}/${STEPS.length}: ${s.name} (${s.seconds} s) ---`)
    console.log(s.text)
    for (let k = 3; k >= 1; k--) { process.stdout.write(`\r  ${say('getready', 'get ready')}... ${k} `); bell(); await sleep(1000) }
    process.stdout.write(`\r  ${say('go', 'GO')}!                \n`)
    const start = Date.now()
    current = s.name
    bell()
    while (Date.now() - start < s.seconds * 1000) {
      if (fatal) throw new Error(`lost the controller during ${s.name}: ${fatal.state} ${fatal.message ?? ''}`)
      process.stdout.write(`\r  ${Math.max(0, Math.ceil(s.seconds - (Date.now() - start) / 1000))} s   `)
      await sleep(250)
    }
    const end = Date.now()
    current = null
    out.write(JSON.stringify({ type: 'step', name: s.name, startMs: start, endMs: end, packets: counts[s.name] || 0 }) + '\n')
    process.stdout.write('\r  done.          \n')
    bell()
  }
  await request('POST', '/__bridge/disconnect', {}).catch(() => {})
  events.destroy()
  await new Promise((r) => out.end(r))
  console.log('\n=== ' + say('finished', 'FINISHED. You can put the Joy-Con down.') + ' ===')
  for (const s of STEPS) {
    const n = counts[s.name] || 0
    const dur = lastWall[s.name] && firstWall[s.name] ? (lastWall[s.name] - firstWall[s.name]) / 1000 : 0
    console.log(`  ${s.name.padEnd(16)} ${String(n).padStart(5)} packets  ${dur > 0 ? (n / dur).toFixed(1) : '0'} Hz`)
  }
  console.log(`\nSaved: ${OUT}`)
}

main().catch(async (e) => {
  console.error('\nERROR: ' + e.message)
  await request('POST', '/__bridge/disconnect', {}).catch(() => {})
  out.end()
  process.exit(1)
})
