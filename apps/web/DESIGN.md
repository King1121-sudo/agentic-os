# DESIGN.md — Agentic OS Console

> Written at finish, from the built world. The audit trail lives in `.impeccable/surface-brief.md` and `PRODUCT.md`.

## World

**Command-environment HUD.** A deep space-field (`#060a10`) carries a fixed architectural grid (44px cells, cyan hairlines at ~1.6% alpha) — the instrument substrate the brief pins. Surfaces are translucent dark panels (`rgba(10,16,25,.72)` + 6px backdrop blur) with hairline cyan corner ticks (24px dashed segments). Concentric circular geometry exists ONLY around the JARVIS Core. Light theme is the same HUD language inverted (`#eef2f5` field, teal-ink lines) — one world, two ambients.

## Color system

| Token | Dark | Role |
|---|---|---|
| `--cyan` | `#39d0d8` | system information — the primary accent; active work, links-adjacent chrome, primary actions |
| `--blue` | `#4f8cff` | electric blue — links, secondary data |
| `--orange` | `#ffb454` | **attention/action** — approvals, warnings, deadlines, action-required states. Reserved: never decorative |
| `--green` | `#2ee6a8` | success / live |
| `--red` | `#ff5d5d` | failure / danger |
| `--purple` | `#b18cff` | memory / graph / derived |

Status colors carry a secondary signal (icon/label) always — never color alone. All text/surface pairs ≥4.5:1 (fg-faint `#6b7a8d` = 4.53:1 on field).

## Type

- `--sans: IBM Plex Sans` (400/500/600/700) — interface voice; instrument-panel heritage without costume.
- `--mono: JetBrains Mono` (400/500/600) — identifiers, event types, metrics, timestamps, data. Never for prose.
- Page title `.page-h1` = 17px/700 everywhere (dashboard cap < 28px per TypeUI). Card/panel labels 11px/600 uppercase tracked 0.10em. Eyebrows 9.5px mono, tracked 0.16em.

## Components

- **Panel** (`.card`/`.jarvis-panel`): translucent, `--r-lg` 14px, corner ticks. One primitive, used everywhere.
- **Buttons**: base = outlined raise; primary = cyan-tinted gradient fill + glow on hover; danger = red outline. One size language (`button.xs` the only step down). Adjacent buttons share height/padding.
- **Status dots**: semantic tones (`d-cyan` pulses for executing, `d-amber` for waiting, `d-green` solid for live/success, `d-red` for failure). Pulse = `jarvisPulse` opacity keyframe.
- **Badges**: inline, content-sized, semantic-tinted.
- **Native selects**: arrow stripped, custom chevron, `color-scheme` dark/light.
- **Event rows / trace timelines**: mono event-type column + dim summary; trace steps carry kind-colored pins.

## The Core (Home only)

Three concentric rings (dashed outer rotating 26s, mid 14s reverse, solid inner), breathing nucleus with "J", real agent satellites positioned by angle on the orbit field. Mode-driven: `idle/thinking/executing/waiting/approval_required/error` change ring color/speed/animation — all from real state (`selectJarvisMode`: health, approvals, agent statuses, last event). No fake states.

## Motion

Semantic only, transform/opacity, all disabled under `prefers-reduced-motion`. Palette entrance 180ms ease-out. Status pulses 1.1–2s. Ring rotations 5–26s (calm). Panel/hover transitions 120ms.

## Voice

`VoiceState` machine (idle/listening/processing/error live; speaking/interrupted reserved for real TTS). Voice chip shows mono uppercase state; transcript ("heard: …") surfaces interim results. Text and voice route through the same `POST /api/command`.

## Responsive

- \>1240px: cockpit 3-bank grid (attention/deadlines | core+command | agents/sentinels/feed).
- 1240→820px: 2-column, right bank wraps horizontal.
- <820px: single column; rail collapses to a bottom bar (safe-area aware); content padding 14px; crumb hidden.

## What not to do here

- No concentric geometry outside the Core.
- No glass/blur as decoration (only the specific panel/toolbar surfaces).
- No fake data, no synthetic pulses — every animated state reads real kernel state.
- Orange is reserved for attention; cyan is the only structural accent.
- Never restyle a subsystem into a separate visual app — one shell, one language.
