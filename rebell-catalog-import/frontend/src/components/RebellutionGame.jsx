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

const COIN_R = 11

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

// Coin spawn heights: low (ground), mid (half jump), high (apex)
const COIN_HEIGHTS = [
  GROUND - 28,   // low  — collectible while running
  GROUND - 95,   // mid  — requires a jump
  GROUND - 148,  // high — requires jumping near apex
]

// Coin spawn patterns
function makeCoinCluster(baseX) {
  const pattern = Math.floor(Math.random() * 4)
  const coins = []

  if (pattern === 0) {
    // Horizontal line at one height
    const hy = COIN_HEIGHTS[Math.floor(Math.random() * COIN_HEIGHTS.length)]
    const count = 3 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++)
      coins.push({ x: baseX + i * 34, y: hy, bob: Math.random() * Math.PI * 2 })

  } else if (pattern === 1) {
    // Arc — traces a jump parabola
    const steps = 5
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1)
      const arcY = GROUND - 28 - Math.sin(t * Math.PI) * 120
      coins.push({ x: baseX + i * 38, y: arcY, bob: Math.random() * Math.PI * 2 })
    }

  } else if (pattern === 2) {
    // Two rows: ground + mid (collect both by jumping)
    for (let i = 0; i < 3; i++) {
      coins.push({ x: baseX + i * 34, y: COIN_HEIGHTS[0], bob: Math.random() * Math.PI * 2 })
      coins.push({ x: baseX + i * 34, y: COIN_HEIGHTS[1], bob: Math.random() * Math.PI * 2 })
    }

  } else {
    // Single high coin — skill reward
    coins.push({ x: baseX + 20, y: COIN_HEIGHTS[2], bob: 0 })
  }

  return coins
}

function makeState() {
  return {
    charY: GROUND - CHAR_H,
    charVY: 0,
    onGround: true,
    obstacles: [],
    coins: [],
    coinEffects: [],
    coinsCollected: 0,
    score: 0,
    speed: 4.2,
    frame: 0,
    over: false,
    started: false,
    nextObstacleIn: 90,
    nextCoinIn: 55,
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
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius)
  else ctx.rect(x, y, w, h)
}

export default function RebellutionGame() {
  const canvasRef = useRef(null)
  const stateRef  = useRef(makeState())
  const hiRef     = useRef(0)
  const hiCoinsRef = useRef(0)
  const rafRef    = useRef(null)
  const imgRef    = useRef(null)

  useEffect(() => {
    const img = new Image()
    img.src = characterSrc
    imgRef.current = img

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function doJump() {
      const s = stateRef.current
      if (!s.started) { s.started = true; return }
      if (s.over) {
        stateRef.current = makeState()
        stateRef.current.started = true
        return
      }
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

      // Spawn obstacles
      s.nextObstacleIn--
      if (s.nextObstacleIn <= 0) {
        const e = COMPETITORS[Math.floor(Math.random() * COMPETITORS.length)]
        s.obstacles.push({ ...e, x: W + 10 })
        s.nextObstacleIn = 62 + Math.floor(Math.random() * 72)
      }

      // Spawn coins
      s.nextCoinIn--
      if (s.nextCoinIn <= 0) {
        const cluster = makeCoinCluster(W + 20)
        for (const c of cluster) s.coins.push({ ...c, collected: false })
        s.nextCoinIn = 70 + Math.floor(Math.random() * 55)
      }

      // Move everything
      for (const o of s.obstacles) o.x -= s.speed
      s.obstacles = s.obstacles.filter(o => o.x + o.w > -10)

      for (const c of s.coins) c.x -= s.speed
      s.coins = s.coins.filter(c => c.x + COIN_R > -10 && !c.collected)

      for (const st of s.stars) { st.x -= st.speed; if (st.x < 0) st.x = W }

      // Coin effects update (particles move + fade)
      for (const e of s.coinEffects) {
        e.life--
        if (e.vx !== undefined) { e.x += e.vx; e.y += e.vy; e.vy += 0.18 }
      }
      s.coinEffects = s.coinEffects.filter(e => e.life > 0)

      // Coin collection
      for (const c of s.coins) {
        if (c.collected) continue
        if (
          CHAR_X + CHAR_W - 6 > c.x - COIN_R &&
          CHAR_X + 6          < c.x + COIN_R &&
          s.charY + 6         < c.y + COIN_R &&
          s.charY + CHAR_H - 6 > c.y - COIN_R
        ) {
          c.collected = true
          s.coinsCollected++
          if (s.coinsCollected > hiCoinsRef.current) hiCoinsRef.current = s.coinsCollected

          // Spawn burst particles
          for (let i = 0; i < 7; i++) {
            const angle = (i / 7) * Math.PI * 2
            s.coinEffects.push({
              x: c.x, y: c.y,
              vx: Math.cos(angle) * (1.5 + Math.random() * 2),
              vy: Math.sin(angle) * (1.5 + Math.random() * 2) - 1,
              life: 18, maxLife: 18,
            })
          }
          // "+1" floating text
          s.coinEffects.push({
            type: 'text', x: c.x, y: c.y - 10,
            life: 28, maxLife: 28,
          })
        }
      }

      // Obstacle collision (inset hitbox)
      const INSET = 8
      for (const o of s.obstacles) {
        if (
          CHAR_X + CHAR_W - INSET > o.x + INSET &&
          CHAR_X + INSET          < o.x + o.w - INSET &&
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
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      for (const st of s.stars) {
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill()
      }

      // Ground
      ctx.strokeStyle = '#1c2535'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(0, GROUND); ctx.lineTo(W, GROUND); ctx.stroke()

      // Animated ground dashes
      const spd = s.started && !s.over ? s.speed : 0
      ctx.strokeStyle = '#232d3f'; ctx.lineWidth = 1.5
      const off = -(s.frame * spd) % 48
      for (let x = off; x < W; x += 48) {
        ctx.beginPath(); ctx.moveTo(x, GROUND + 7); ctx.lineTo(x + 22, GROUND + 7); ctx.stroke()
      }

      // ── Coins ──
      for (const c of s.coins) {
        const by = Math.sin(s.frame * 0.08 + c.bob) * 3.5

        // Outer glow
        ctx.save()
        ctx.globalAlpha = 0.22
        const grd = ctx.createRadialGradient(c.x, c.y + by, 0, c.x, c.y + by, COIN_R + 8)
        grd.addColorStop(0, '#FFD700')
        grd.addColorStop(1, 'transparent')
        ctx.fillStyle = grd
        ctx.beginPath(); ctx.arc(c.x, c.y + by, COIN_R + 8, 0, Math.PI * 2); ctx.fill()
        ctx.restore()

        // Coin body
        const coinGrd = ctx.createRadialGradient(c.x - 3, c.y + by - 3, 1, c.x, c.y + by, COIN_R)
        coinGrd.addColorStop(0, '#FFE566')
        coinGrd.addColorStop(0.6, '#FFD700')
        coinGrd.addColorStop(1, '#B8860B')
        ctx.fillStyle = coinGrd
        ctx.beginPath(); ctx.arc(c.x, c.y + by, COIN_R, 0, Math.PI * 2); ctx.fill()

        // Rim
        ctx.strokeStyle = '#996600'; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(c.x, c.y + by, COIN_R, 0, Math.PI * 2); ctx.stroke()

        // Shine
        ctx.save()
        ctx.globalAlpha = 0.5
        ctx.fillStyle = '#FFF9C4'
        ctx.beginPath(); ctx.arc(c.x - 3.5, c.y + by - 3.5, COIN_R * 0.3, 0, Math.PI * 2); ctx.fill()
        ctx.restore()

        // "R" letter
        ctx.fillStyle = '#7A5000'
        ctx.font = `bold ${COIN_R + 1}px Arial`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('R', c.x, c.y + by + 1)
      }

      // ── Coin effects ──
      for (const e of s.coinEffects) {
        const alpha = e.life / e.maxLife
        ctx.save()
        ctx.globalAlpha = alpha
        if (e.type === 'text') {
          ctx.fillStyle = '#FFD700'
          ctx.font = 'bold 13px monospace'
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          const rise = (1 - alpha) * 22
          ctx.fillText('+1', e.x, e.y - rise)
        } else {
          ctx.fillStyle = '#FFD700'
          ctx.beginPath(); ctx.arc(e.x, e.y, 2.5, 0, Math.PI * 2); ctx.fill()
        }
        ctx.restore()
      }

      // ── Character ──
      const cy = s.charY
      ctx.save()
      ctx.translate(CHAR_X + CHAR_W / 2, cy + CHAR_H)
      if (!s.onGround) ctx.rotate(0.06)
      else if (s.started && !s.over) ctx.translate(0, Math.abs(Math.sin(s.frame * 0.3)) * 1.5)
      ctx.translate(-(CHAR_W / 2), -CHAR_H)

      if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
        const legBob = (s.onGround && s.started && !s.over) ? Math.sin(s.frame * 0.35) * 3 : 0
        ctx.drawImage(imgRef.current, 0, legBob, CHAR_W, CHAR_H - legBob)
      } else {
        ctx.fillStyle = '#2F85A4'
        rr(ctx, 0, 0, CHAR_W, CHAR_H, 6); ctx.fill()
        ctx.fillStyle = 'white'
        ctx.font = `bold ${Math.round(CHAR_W * 0.5)}px Arial`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('R', CHAR_W / 2, CHAR_H / 2)
      }
      ctx.restore()

      // Shadow
      ctx.save()
      ctx.globalAlpha = 0.18 + (1 - Math.min(1, (GROUND - CHAR_H - s.charY) / 120)) * 0.25
      ctx.fillStyle = '#000'
      ctx.beginPath()
      const sW = CHAR_W * (0.5 + (1 - Math.min(1, (GROUND - CHAR_H - s.charY) / 100)) * 0.35)
      ctx.ellipse(CHAR_X + CHAR_W / 2, GROUND + 5, sW / 2, 5, 0, 0, Math.PI * 2); ctx.fill()
      ctx.restore()

      // ── Obstacles ──
      for (const o of s.obstacles) {
        const ox = o.x, oy = GROUND - o.h
        ctx.fillStyle = 'rgba(0,0,0,0.22)'
        rr(ctx, ox + 4, oy + 4, o.w, o.h, 6); ctx.fill()
        ctx.fillStyle = o.color
        rr(ctx, ox, oy, o.w, o.h, 6); ctx.fill()
        ctx.fillStyle = 'rgba(255,255,255,0.13)'
        rr(ctx, ox + 4, oy + 4, o.w - 8, 14, [4, 4, 0, 0]); ctx.fill()
        const fs = Math.max(9, Math.min(13, (o.w - 8) / o.name.length * 1.7))
        ctx.fillStyle = o.textColor
        ctx.font = `bold ${fs}px Arial`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(o.name, ox + o.w / 2, oy + o.h / 2)
      }

      // ── HUD ──
      // Coin counter (top left)
      ctx.save()
      // Coin icon
      const cGrd = ctx.createRadialGradient(20, 16, 1, 20, 16, 9)
      cGrd.addColorStop(0, '#FFE566'); cGrd.addColorStop(1, '#B8860B')
      ctx.fillStyle = cGrd
      ctx.beginPath(); ctx.arc(20, 16, 9, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = '#996600'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(20, 16, 9, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = '#7A5000'; ctx.font = 'bold 9px Arial'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('R', 20, 17)
      // Count
      ctx.fillStyle = '#FFD700'; ctx.font = 'bold 13px monospace'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(`× ${s.coinsCollected}`, 34, 16)
      ctx.restore()

      // Score (top right)
      ctx.fillStyle = '#2F85A4'; ctx.font = 'bold 13px monospace'
      ctx.textAlign = 'right'; ctx.textBaseline = 'top'
      ctx.fillText(Math.floor(s.score).toString().padStart(5, '0'), W - 14, 10)
      ctx.fillStyle = '#2a3547'; ctx.font = '10px monospace'
      ctx.fillText(`HI ${hiRef.current.toString().padStart(5, '0')}`, W - 14, 26)

      // ── Overlays ──
      if (!s.started) {
        ctx.fillStyle = 'rgba(10,12,17,0.72)'; ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('Press Space or tap to play', W / 2, H / 2)
      }

      if (s.over) {
        ctx.fillStyle = 'rgba(10,12,17,0.82)'; ctx.fillRect(0, 0, W, H)
        ctx.fillStyle = '#ef4444'; ctx.font = 'bold 22px Arial'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('GAME OVER', W / 2, H / 2 - 22)
        // Coin tally
        ctx.fillStyle = '#FFD700'; ctx.font = 'bold 14px Arial'
        ctx.fillText(`🪙 ${s.coinsCollected} Rebell Coins collected`, W / 2, H / 2 + 4)
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '11px Arial'
        ctx.fillText('Space or tap to try again', W / 2, H / 2 + 24)
      }
    }

    function loop() { update(); draw(); rafRef.current = requestAnimationFrame(loop) }
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
