---
name: bottom-bar-guidelines
description: >-
  Guides implementation of a fixed bottom application bar (health, version, environment,
  quick links). Use when adding global status chrome, footer strip, dev/prod indicators,
  API heartbeat UI, or matching LENS-style BottomBar; covers portal rendering and layout padding.
---

# Bottom bar guidelines (web apps)

Use this when scaffolding or refining **persistent bottom chrome**: a thin fixed strip that surfaces **trust + orientation + shortcuts** without stealing vertical space from the main UI.

## When to include one

- Multi-page SPA where users benefit from **always-visible** API reachability and **build/version** identity.
- Internal tools and beta products where **DEV vs PROD** must be obvious at a glance.
- Apps that pair a **frontend** with a **backend** you can probe (`/health` or equivalent).

Skip or simplify for marketing one-pagers, embedded widgets, or mobile-first flows where a fixed bar overlaps critical controls (use a drawer or settings screen instead).

## What to show (recommended inventory)

Prioritize **signal density** in one row (~32px height). Group into three zones:

| Zone | Typical contents | Notes |
|------|------------------|--------|
| **Left** | App name (link home), optional **stage badge** (Beta/Preview), **environment** (DEV / STAGING / PROD), **API status** (dot + online/offline), **uptime** (from health payload if available), **semver or git short SHA** | Environment should use **distinct colors** (e.g. sky = dev, violet = prod). Health should **poll** on an interval (e.g. 30s), not only on load. |
| **Center** (optional) | Short **tagline**, build ID, or “read-only” disclaimer | `absolute` centered with `pointer-events-none` so it never blocks clicks on side links. Keep **one line**, `whitespace-nowrap` or truncate on small viewports. |
| **Right** | **Internal links** (History, System, Docs) and **external** repo/support links (`target="_blank"`, `rel="noreferrer"`) | Order by frequency of use. |

**Minimum viable bar:** left cluster (app + env + API + version) + right cluster (1–2 links).

## UX and visual rules

- **Height:** fixed **~28–36px** (`h-8` in Tailwind). **Text:** `text-xs`, muted foreground (`text-gray-500`), borders `border-t` to separate from content.
- **Status dot:** small **8px circle**—green when healthy, red when unreachable; pair with text “API online / offline” for colorblind accessibility.
- **Links:** home brand link semibold; secondary links hover to darker gray.
- **Don’t** put primary CTAs or forms in the bar; it’s **metadata + navigation**, not the main workflow.

## Layout integration (critical)

1. **Main content bottom padding**  
   Add **`padding-bottom` equal to bar height** on the scrollable root wrapper (e.g. `pb-8` for `h-8`) so the last page content isn’t hidden behind the bar.

2. **Render with a portal**  
   Render the bar into **`document.body`** via `createPortal` (React) or equivalent.  
   **Why:** `position: fixed` is affected by **ancestor transforms / filters / perspective**, which can pin the bar to a transformed ancestor instead of the viewport. Porting to `body` avoids that class of bugs.

3. **Stacking**  
   Use a modest **`z-index`** (e.g. `z-30`) below modals/toasts but above normal content.

## Data contract (backend)

Expose a lightweight **`GET /health`** (or `/api/health`) returning JSON, for example:

- `status`: `"ok"` when the service process is live.
- `version`: string (semver or build label).
- `uptime_s`: optional integer seconds since process start (nice for operator confidence).

The frontend maps `status === 'ok'` + successful fetch to **online**; network error or non-OK → **offline**. Use **`retry: false`** on the health query so a down API doesn’t hammer retries.

## Implementation checklist

When adding or reviewing a bottom bar:

- [ ] Content height + **`pb-*`** on layout wrapper so nothing is obscured.
- [ ] Bar mounted via **portal to `document.body`** (or documented alternative if framework differs).
- [ ] Health fetch **refetches on an interval**; offline state is obvious.
- [ ] **DEV/PROD** (and staging if applicable) visually distinct.
- [ ] Version visible for **support and debugging**.
- [ ] External links safe: **`rel="noreferrer"`**, **`target="_blank"`**.
- [ ] Center tagline (if any) does not intercept clicks (`pointer-events-none`).
- [ ] Responsive: on **narrow screens**, hide or collapse low-priority chips (uptime, tagline) behind a single “Status” popover if needed.

## Reference implementation (this repo)

See `frontend/src/components/BottomBar.jsx` and `frontend/src/components/Layout.jsx`:

- Portal + fixed bar + three-zone layout.
- `@tanstack/react-query` polling `getHealth`.
- `import.meta.env.PROD` for DEV/PROD badge.

Copy the **structure**, not the **copy**: replace product name, tagline, GitHub URL, and badges with the new project’s values.

## Anti-patterns

- Embedding the bar inside a deeply nested div with **CSS transform** without a portal—risk of broken fixed positioning.
- No bottom padding on main content—users cannot scroll to see the last lines.
- Polling health every second—use **15–60s** unless operators explicitly need faster drift detection.
- Showing secrets (API keys, internal hostnames) in the bar—keep it **safe for screenshots**.

---

*Skill scope: global footer / status strip patterns. For full app shell (nav header + sidebar), compose separately.*
