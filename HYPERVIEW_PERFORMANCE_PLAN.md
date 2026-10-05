# PHD HyperView — Performance Plan

## Goal
Reach Speckle-class opening/navigation behavior while preserving PHD 360 4D controls, BIM identity and premium visual quality.

## Non-negotiable architecture
- One active model per project.
- Speckle Bundle = source of truth.
- PHD3D = prepared geometry master.
- HyperView Render Cache = server-side render artifact.
- OPFS = device-local cache-first copy.
- GPU = working set only, not a second database.
- 4D/WBS/Sets/Disciplines = state overlays, never geometry rebuilds.

## Stage 0 — Baseline + cleanup ✅ EXECUTED
Acceptance:
- Single active viewer engine.
- No legacy Speckle viewer runtime in bundle.
- One active Speckle connection for BEMISA.
- Build/lint clean.

## Stage 1 — OPFS cache-first ✅ EXECUTED
Work:
- Warm the complete PHD3D binary cache into OPFS from HyperView packs without decoding/rendering every chunk.
- Build local Fast Cache after hydration.
- Use priority order: HyperView pack -> Fast OPFS -> chunk OPFS -> network fallback.
- Request persistent browser storage.
Acceptance:
- First session can stream from server packs.
- Later sessions open from OPFS with near-zero chunk network requests.

## Stage 2 — Full residency correctness gate ✅ EXECUTED
Work:
- Keep every prepared PHD3D chunk resident until a real global HLOD exists.
- Group multiple source chunks into GPU super-batches to reduce draw calls.
- Do not evict geometry merely because it leaves the camera.
- Recover missing renderable objects after full residency is reached.
Acceptance:
- 100% of prepared geometry is visible in the Viewer.
- Status reaches MODELO COMPLETO RESIDENTE.
- No region disappears because of camera-based eviction.

## Stage 3 — True global HLOD 🔴 NEXT
Work:
- Replace the current 192-object preview with a real whole-model simplified artifact built from 100% of PHD3D geometry.
- Keep that global artifact permanently visible.
- Only after this artifact is validated may high-detail geometry return to camera-based working-set eviction.
Acceptance:
- Whole-model context represents 100% of the plant.
- No blank zones when detailed chunks are evicted.
- High-detail replacement does not produce holes or visible popping.

## Stage 4 — 4D state engine ✅ EXECUTED
Work:
- Keep geometry immutable.
- Update only object color/visibility state on date changes.
- Apply deltas instead of recoloring every resident object.
Acceptance:
- 4D play/date change does not trigger geometry loads or mesh rebuilds.

## Stage 5 — Premium quality at rest ✅ EXECUTED
Work:
- FastNav during motion.
- PBR + AO after camera idle.
- Original materials first, industrial semantic fallback second.
Acceptance:
- Smooth motion with premium still-frame quality.

## Stage 6 — Telemetry and gates ✅ EXECUTED
Metrics:
- TTFP (time to first pixels)
- TTI (time to interactive)
- OPFS hit ratio
- render-pack hit ratio
- network chunk count
- resident chunks/objects
- frame time while moving / idle
- 4D apply time
Targets:
- TTI <= 3 s on warmed device for current BEMISA model.
- OPFS hit ratio >= 95% on second open.
- Camera interaction >= 45 FPS target on typical engineering desktop.
- No geometry rebuild on 4D date change.
