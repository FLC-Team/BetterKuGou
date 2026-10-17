const fs = require('node:fs')
const path = require('node:path')

const directory = path.resolve(__dirname, '../installer/assets')
const frameRate = 25
const themes = {
  light: { background: [252, 250, 247], accent: [119, 95, 143], soft: [178, 151, 193], surface: [255, 255, 255] },
  dark: { background: [33, 31, 36], accent: [200, 178, 222], soft: [162, 135, 184], surface: [44, 40, 50] }
}

function chunk(name, body) {
  const header = Buffer.alloc(8)
  header.write(name)
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body, ...(body.length & 1 ? [Buffer.alloc(1)] : [])])
}

function list(name, children) { return chunk('LIST', Buffer.concat([Buffer.from(name), ...children])) }

/** Encode independent RLE8 keyframes supported by Windows' codec-free SysAnimate32. */
function rleFrame(pixels, width, height) {
  const bytes = []
  for (let y = height - 1; y >= 0; y--) {
    let x = 0
    while (x < width) {
      const value = pixels[y * width + x]
      let count = 1
      while (count < 255 && x + count < width && pixels[y * width + x + count] === value) count++
      if (count >= 3) {
        bytes.push(count, value)
        x += count
      } else {
        const start = x
        x += count
        while (x < width && x - start < 252) {
          if (x + 2 < width && pixels[y * width + x] === pixels[y * width + x + 1] && pixels[y * width + x] === pixels[y * width + x + 2]) break
          x++
        }
        const length = x - start
        if (length < 3) {
          for (let index = start; index < x; index++) bytes.push(1, pixels[y * width + index])
        } else {
          bytes.push(0, length)
          for (let index = start; index < x; index++) bytes.push(pixels[y * width + index])
          if (length & 1) bytes.push(0)
        }
      }
    }
    bytes.push(0, 0)
  }
  bytes.push(0, 1)
  return Buffer.from(bytes)
}

/** Write one silent non-interleaved video stream, a fixed palette and a keyframe index. */
function avi(frames, width, height, palette) {
  const largest = Math.max(...frames.map(frame => frame.length))
  const header = Buffer.alloc(56)
  header.writeUInt32LE(1000000 / frameRate, 0)
  header.writeUInt32LE(largest * frameRate, 4)
  header.writeUInt32LE(0x10, 12)
  header.writeUInt32LE(frames.length, 16)
  header.writeUInt32LE(1, 24)
  header.writeUInt32LE(largest, 28)
  header.writeUInt32LE(width, 32)
  header.writeUInt32LE(height, 36)
  const stream = Buffer.alloc(56)
  stream.write('vids', 0)
  stream.write('mrle', 4)
  stream.writeUInt32LE(1, 20)
  stream.writeUInt32LE(frameRate, 24)
  stream.writeUInt32LE(frames.length, 32)
  stream.writeUInt32LE(largest, 36)
  stream.writeInt32LE(-1, 40)
  stream.writeInt16LE(width, 52)
  stream.writeInt16LE(height, 54)
  const bitmap = Buffer.alloc(40 + 256 * 4)
  bitmap.writeUInt32LE(40, 0)
  bitmap.writeInt32LE(width, 4)
  bitmap.writeInt32LE(height, 8)
  bitmap.writeUInt16LE(1, 12)
  bitmap.writeUInt16LE(8, 14)
  bitmap.writeUInt32LE(1, 16)
  bitmap.writeUInt32LE(width * height, 20)
  bitmap.writeUInt32LE(256, 32)
  palette.forEach(([red, green, blue], index) => {
    bitmap[40 + index * 4] = blue
    bitmap[41 + index * 4] = green
    bitmap[42 + index * 4] = red
  })
  let offset = 4
  const index = Buffer.alloc(frames.length * 16)
  const video = frames.map((frame, number) => {
    index.write('00dc', number * 16)
    index.writeUInt32LE(0x10, number * 16 + 4)
    index.writeUInt32LE(offset, number * 16 + 8)
    index.writeUInt32LE(frame.length, number * 16 + 12)
    const content = chunk('00dc', frame)
    offset += content.length
    return content
  })
  const body = Buffer.concat([Buffer.from('AVI '), list('hdrl', [chunk('avih', header),
    list('strl', [chunk('strh', stream), chunk('strf', bitmap)])]), list('movi', video), chunk('idx1', index)])
  return chunk('RIFF', body)
}

/** Rasterize antialiased capsules into two fixed palette ramps; no external font or codec is needed. */
function renderFrame(kind, frame, scale, theme) {
  const width = Math.round((kind === 'install' ? 448 : 80) * scale)
  const height = Math.round((kind === 'install' ? 76 : 80) * scale)
  const pixels = new Uint8Array(width * height)
  function capsule(x1, y1, x2, y2, radius, opacity = 1, ramp = 0) {
    x1 *= scale; y1 *= scale; x2 *= scale; y2 *= scale; radius *= scale
    const dx = x2 - x1; const dy = y2 - y1
    const length = dx * dx + dy * dy
    const left = Math.max(0, Math.floor(Math.min(x1, x2) - radius - 1))
    const right = Math.min(width, Math.ceil(Math.max(x1, x2) + radius + 1))
    const top = Math.max(0, Math.floor(Math.min(y1, y2) - radius - 1))
    const bottom = Math.min(height, Math.ceil(Math.max(y1, y2) + radius + 1))
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const projection = length ? Math.max(0, Math.min(1, ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / length)) : 0
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x + 0.5 - x1 - projection * dx, y + 0.5 - y1 - projection * dy)))
      const value = Math.round(coverage * opacity * 127)
      const index = y * width + x
      if (value > (pixels[index] & 127)) pixels[index] = value ? value + ramp * 128 : 0
    }
  }
  if (kind === 'install') {
    const phase = frame / 50 * Math.PI * 2
    capsule(16, 38, 94, 38, 0.5, 0.16)
    capsule(354, 38, 432, 38, 0.5, 0.16)
    for (let bar = 0; bar < 35; bar++) {
      const position = (bar - 17) / 17
      const envelope = Math.pow(Math.cos(position * Math.PI / 2), 1.6)
      const pulse = (Math.sin(phase * 2 - bar * 0.31) + 1) / 2
      const halfHeight = 2 + envelope * (7 + pulse * 19)
      const x = 105 + bar * 7
      capsule(x, 38 - halfHeight, x, 38 + halfHeight, 2.1, 0.54 + envelope * 0.46, bar % 5 === 0 ? 1 : 0)
    }
    for (let dot = 0; dot < 3; dot++) {
      const glow = 0.25 + 0.45 * (Math.sin(phase - dot * 0.7) + 1) / 2
      capsule(38 + dot * 10, 38, 38 + dot * 10, 38, 1.5, glow)
      capsule(390 + dot * 10, 38, 390 + dot * 10, 38, 1.5, glow)
    }
  } else {
    const progress = Math.min(1, frame / 13)
    const eased = 1 - Math.pow(1 - progress, 3)
    // A quiet halo settles around the drawn check; the final frame stays visible.
    const radius = 25 + (1 - eased) * 5
    for (let segment = 0; segment < 80; segment++) {
      const a = segment / 80 * Math.PI * 2
      const b = (segment + 1) / 80 * Math.PI * 2
      capsule(40 + Math.cos(a) * radius, 40 + Math.sin(a) * radius,
        40 + Math.cos(b) * radius, 40 + Math.sin(b) * radius, 0.65, 0.18 * eased)
    }
    const first = Math.min(1, eased / 0.38)
    const second = Math.max(0, (eased - 0.38) / 0.62)
    capsule(27, 40, 27 + first * 9, 40 + first * 9, 2.4, 1)
    if (second) capsule(36, 49, 36 + second * 18, 49 - second * 20, 2.4, 1)
  }
  return rleFrame(pixels, width, height)
}

function generate() {
  fs.mkdirSync(directory, { recursive: true })
  let total = 0
  for (const [name, theme] of Object.entries(themes)) for (const dpi of [96, 120, 144, 192]) {
    for (const kind of ['install', 'success']) {
      const background = kind === 'success' ? theme.surface : theme.background
      const palette = [theme.accent, theme.soft].flatMap(color => Array.from({ length: 128 }, (_, step) =>
        color.map((channel, index) => Math.round(background[index] + (channel - background[index]) * step / 127))))
      const count = kind === 'install' ? 50 : 15
      const scale = dpi / 96
      const frames = Array.from({ length: count }, (_, frame) => renderFrame(kind, frame, scale, theme))
      const output = avi(frames, Math.round((kind === 'install' ? 448 : 80) * scale), Math.round((kind === 'install' ? 76 : 80) * scale), palette)
      fs.writeFileSync(path.join(directory, `${kind}-${name}-${dpi}.avi`), output)
      total += output.length
    }
  }
  process.stdout.write(`Generated 16 silent native installer clips (${Math.ceil(total / 1024)} KiB).\n`)
}

if (require.main === module) generate()
module.exports = { generate }
