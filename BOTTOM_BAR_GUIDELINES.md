---
name: bottom-bar-guidelines
description: >-
  Documents fixed bottom status bars for SPAs and internal tools: content zones (brand,
  environment, API health, version, links), rendering via portal to document.body,
  main-area bottom padding, health endpoint polling, and anti-patterns. Use when
  implementing global footer chrome, status strip, dev/prod indicators, or aligning
  with LENS BottomBar and Layout.jsx patterns.
---

# Bottom bar guidelines

Single-file reference for adding a **fixed bottom status strip** to web apps (SPA/tools). Use as constraints for agents or share with teammates. Pattern matches **LENS** (`BottomBar.jsx` + `Layout.jsx`). **YAML front matter above** lets the same file load as a skill in Cursor and similar agents that read `name` + `description` for routing.

---

## 1. Purpose

| Goal | Detail |
|------|--------|
| **Trust** | Show API reachability and version without opening DevTools. |
| **Orientation** | DEV / STAGING / PROD obvious at a glance. |
| **Shortcuts** | Persistent links (home, history, docs, repo). |

**Not for:** primary CTAs, forms, or dense navigation — keep the bar thin and informational.

---

## 2. What to include (inventory)

| Priority | Item | Notes |
|----------|------|--------|
| P0 | App name → link home | Semibold; first anchor in the bar. |
| P0 | Environment badge | `DEV` vs `PROD` (and `STAGING` if used); **distinct colors**. |
| P0 | API status | Small dot + “online” / “offline”; poll health endpoint on an interval. |
| P1 | Version | Semver or build label from `/health` (or build-time `import.meta.env`). |
| P1 | Quick links | Internal routes + external repo/support (`target="_blank"`, `rel="noreferrer"`). |
| P2 | Stage tag | e.g. `BETA`, `PREVIEW` — subtle badge. |
| P2 | Uptime | If backend exposes `uptime_s`; humanize (e.g. `2h 15m`). |
| P3 | Center tagline | One line; **must not block clicks** (`pointer-events-none`). |

**Minimum:** P0 + one P1 link cluster.

---

## 3. Layout zones (one row)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ LEFT: brand · env · ● API · uptime · version   CENTER (optional tagline)   RIGHT: links │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Height:** ~28–36px (`h-8` in Tailwind).
- **Typography:** `text-xs`, muted body (`text-gray-500`), top border to separate from content.
- **Status dot:** ~8px circle; pair color with text for accessibility.

---

## 4. Critical implementation rules

| # | Rule | Why |
|---|------|-----|
| L1 | **`padding-bottom` on main content** ≥ bar height | Last lines of the page stay scrollable above the bar. |
| L2 | **Render bar via portal to `document.body`** | `position: fixed` breaks under ancestor `transform`/`filter`; portal avoids that. |
| L3 | **Modest `z-index`** (e.g. `z-30`) | Above page; below modals/toasts. |
| L4 | Health query: **`retry: false`**, interval **15–60s** | Avoid retry storms when API is down; balance freshness vs load. |

---

## 5. Backend contract (suggested)

`GET /health` (or `/api/health`) JSON:

| Field | Type | Role |
|-------|------|------|
| `status` | string | `"ok"` when process is healthy. |
| `version` | string | Display in bar. |
| `uptime_s` | int (optional) | Seconds since start. |

**Online** = fetch succeeds **and** `status === 'ok'`. Anything else → **offline**.

---

## 6. Ship checklist

- [ ] Main wrapper has **`pb-*`** matching bar height.
- [ ] Bar uses **portal → `document.body`** (or equivalent documented fix).
- [ ] Env badge visible; colors differ by environment.
- [ ] Version shown for support/debug.
- [ ] External links: `_blank` + `noreferrer`.
- [ ] Center line (if any): **`pointer-events-none`**.
- [ ] Narrow screens: hide or collapse low-priority chips if needed.

---

## 7. Anti-patterns

| Avoid | Instead |
|-------|---------|
| Fixed bar inside transformed ancestor without portal | Portal to `body` |
| No bottom padding on scroll area | Match bar height with `pb-*` |
| Health poll every second | 30s default unless ops require tighter |
| Secrets / internal URLs in the bar | Safe-for-screenshots copy only |

---

## 8. Reference in this repo

- `frontend/src/components/BottomBar.jsx` — portal, polling, zones.
- `frontend/src/components/Layout.jsx` — `pb-8` on children.

Replace product name, tagline, and URLs when reusing elsewhere.

---

*Agent-scale format: skim tables → apply checklist → verify section 4 (layout rules).*
