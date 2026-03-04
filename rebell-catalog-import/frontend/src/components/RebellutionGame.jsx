import { useEffect, useRef } from 'react'
import characterSrc from '../assets/rebel-character.png'

const W = 640
const H = 230
const GROUND = 190

const CHAR_W = 52
const CHAR_H = 72
const CHAR_X = 80

const GRAVITY = 0.72
const JUMP_V   = -14.5

const COMPETITORS = [
  { name: 'Revolut',  color: '#7B2FBE', textColor: '#fff', w: 72, h: 54 },
  { name: 'Satispay', color: '#E63B2E', textColor: '#fff', w: 78, h: 58 },
  { name: 'N26',      color: '#1A9651', textColor: '#fff', w: 52, h: 50 },
  { name: 'Wise',     color: '#A8E04A', textColor: '#333', w: 70, h: 52 },
  { name: 'PayPal',   color: '#0070BA', textColor: '#fff', w: 68, h: 60 },
  { name: 'Monzo',    color: '#FF5F00', textColor: '#fff', w: 64, h: 52 },
  { name: 'Klarna',   color: '#FFB3C7', textColor: '#333', w: 70, h: 54 },
  { name: 'Stripe',   color: '#635BFF', textColor: '#fff', w: 66, h: 56 },
  { name: 'Bunq',     color: '#00C4A7', textColor: '#fff', w: 56, h: 50 },
  { name: 'Qonto',    color: '#F04E37', textColor: '#fff', w: 64, h: 54 },
]

function makeState() {
  return {
    charY: GROUND - CHAR_H,
    charVY: 0,
    onGround: true,
    obstacles: [],
    score: 0,
    speed: 4.2,
    frame: 0,
    over: false,
    started: false,
    nextObstacleIn: 90,
    stars: Array.from({ length: 28 }, () => ({
      x: Math.random() * W,
      y: 10 + Math.random() * (GROUND - 60),
      r: Math.random() * 1.5 + 0.4,
      speed: Math.random() * 0.4 + 0.15,
    })),
  }
}

function rr(ctx, x, y, w, h, radius = 5) {
  ctx.beginPath()
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, radius)
  } else {
    ctx.rect(x, y, w, h)
  }
}

export default function RebellutionGame() {
  const canvasRef = useRef(null)
  const stateRef  = useRef(makeState())
  const hiRef     = useRef(0)
  const rafRef    = useRef(null)
  const imgRef    = useRef(null)

  useEffect(() => {
    // Preload character sprite
    const img = new Image()
    img.src = characterSrc
    imgRef.current = img

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function doJump() {
      const s = stateRef.current
      if (!s.started) { s.started = true; return }
      if (s.over) { stateRef.current = makeState(); stateRef.current.started = true; return }
      if (s.onGround) { s.charVY = JUMP_V; s.onGround = false }
    }

    function onKey(e) {
      if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); doJump() }
    }

    window.addEventListener('keydown', onKey)
    canvas.addEventListener('click', doJump)
    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); doJump() }, { passive: false })

    function update() {
      const s = stateRef.current
      if (!s.started || s.over) return

      s.frame++
      s.score += s.speed * 0.045
      if (s.frame % 380 === 0) s.speed = Math.min(s.speed + 0.55, 13)

      // Physics
      s.charVY += GRAVITY
      s.charY  += s.charVY
      if (s.charY >= GROUND - CHAR_H) {
        s.charY  = GROUND - CHAR_H
        s.charVY = 0
        s.onGround = true
      }

      // Spawn
      s.nextObstacleIn--
      if (s.nextObstacleIn <= 0) {
        const e = COMPETITORS[Math.floor(Math.random() * COMPETITORS.length)]
        s.obstacles.push({ ...e, x: W + 10 })
        s.nextObstacleIn = 62 + Math.floor(Math.random() * 72)
      }

      for (const o of s.obstacles) o.x -= s.speed
      s.obstacles = s.obstacles.filter(o => o.x + o.w > -10)
      for (const st of s.stars) { st.x -= st.speed; if (st.x < 0) st.x = W }

      // Collision (inset hitbox so it feels fair)
      const INSET = 8
      for (const o of s.obstacles) {
        if (
          CHAR_X + CHAR_W - INSET > o.x + INSET &&
          CHAR_X + INSET        < o.x + o.w - INSET &&
          s.charY + CHAR_H - INSET > GROUND - o.h + INSET
        ) {
          s.over = true
          if (Math.floor(s.score) > hiRef.current) hiRef.current = Math.floor(s.score)
        }
      }
    }

    function draw() {
      const s = stateRef.current
      ctx.clearRect(0, 0, W, H)

      // BG
      ctx.fillStyle = '#0a0c11'
      ctx.fillRect(0, 0, W, H)

      // Stars
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      for (const st of s.stars) {
        ctx.beginPath()
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2)
        ctx.fill()
      }

      // Ground
      ctx.strokeStyle = '#1c2535'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(0, GROUND); ctx.lineTo(W, GROUND); ctx.stroke()

      // Animated ground dashes
      const spd = s.started && !s.over ? s.speed : 0
      ctx.strokeStyle = '#232d3f'
      ctx.lineWidth = 1.5
      const off = -(s.frame * spd) % 48
      for (let x = off; x < W; x += 48) {
        ctx.beginPath(); ctx.moveTo(x, GROUND + 7); ctx.lineTo(x + 22, GROUND + 7); ctx.stroke()
      }

      // ── Character ──
      const img = imgRef.current
      const cy  = s.charY

      // Squash/stretch: slight x-scale on landing, slight lean on jump
      ctx.save()
      ctx.translate(CHAR_X + CHAR_W / 2, cy + CHAR_H)
      if (!s.onGround) {
        // Lean forward slightly when in air
        ctx.rotate(0.06)
      } else if (s.started && !s.over) {
        // Tiny bounce bob
        const bob = Math.abs(Math.sin(s.frame * 0.3)) * 1.5
        ctx.translate(0, bob)
      }
      ctx.translate(-(CHAR_W / 2), -CHAR_H)

      if (img.complete && img.naturalWidth > 0) {
        // Running leg animation via vertical sprite shift (bob feet)
        const legBob = (s.onGround && s.started && !s.over)
          ? Math.sin(s.frame * 0.35) * 3
          : 0
        ctx.drawImage(img, 0, legBob, CHAR_W, CHAR_H - legBob)
      } else {
        // Fallback block if image not loaded
        ctx.fillStyle = '#2F85A4'
        rr(ctx, 0, 0, CHAR_W, CHAR_H, 6)
        ctx.fill()
        ctx.fillStyle = 'white'
        ctx.font = `bold ${Math.round(CHAR_W * 0.5)}px Arial`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('R', CHAR_W / 2, CHAR_H / 2)
      }
      ctx.restore()

      // Shadow under character
      ctx.save()
      ctx.globalAlpha = 0.18 + (1 - Math.min(1, (GROUND - CHAR_H - s.charY) / 120)) * 0.25
      ctx.fillStyle = '#000'
      ctx.beginPath()
      const shadowW = CHAR_W * (0.5 + (1 - Math.min(1, (GROUND - CHAR_H - s.charY) / 100)) * 0.35)
      ctx.ellipse(CHAR_X + CHAR_W / 2, GROUND + 5, shadowW / 2, 5, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // ── Obstacles ──
      for (const o of s.obstacles) {
        const ox = o.x
        const oy = GROUND - o.h

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.22)'
        rr(ctx, ox + 4, oy + 4, o.w, o.h, 6)
        ctx.fill()

        // Body
        ctx.fillStyle = o.color
        rr(ctx, ox, oy, o.w, o.h, 6)
        ctx.fill()

        // Top gloss
        ctx.fillStyle = 'rgba(255,255,255,0.13)'
        rr(ctx, ox + 4, oy + 4, o.w - 8, 14, [4, 4, 0, 0])
        ctx.fill()

        // Name
        const fs = Math.max(9, Math.min(13, (o.w - 8) / o.name.length * 1.7))
        ctx.fillStyle = o.textColor
        ctx.font = `bold ${fs}px Arial`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(o.name, ox + o.w / 2, oy + o.h / 2)
      }

      // ── Score ──
      ctx.fillStyle = '#2F85A4'
      ctx.font = 'bold 13px monospace'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'top'
      ctx.fillText(Math.floor(s.score).toString().padStart(5, '0'), W - 14, 10)

      ctx.fillStyle = '#2a3547'
      ctx.font = '10px monospace'
      ctx.fillText(`HI ${hiRef.current.toString().padStart(5, '0')}`, W - 14, 26)

      // ── Overlays ──
      if (!s.started) {
        ctx.fillStyle = 'rgba(10,12,17,0.72)'
        ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        ctx.font = '13px Arial'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('Press Space or tap to play', W / 2, H / 2)
      }

      if (s.over) {
        ctx.fillStyle = 'rgba(10,12,17,0.82)'
        ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = '#ef4444'
        ctx.font = 'bold 22px Arial'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('GAME OVER', W / 2, H / 2 - 18)
        ctx.fillStyle = 'rgba(255,255,255,0.55)'
        ctx.font = '12px Arial'
        ctx.fillText(`Score: ${Math.floor(s.score)}  ·  Space or tap to try again`, W / 2, H / 2 + 14)
      }
    }

    function loop() {
      update()
      draw()
      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      className="w-full block"
      style={{ cursor: 'pointer', imageRendering: 'pixelated' }}
    />
  )
}
