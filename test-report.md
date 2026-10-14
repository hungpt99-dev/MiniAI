# Nexio full-test report — Windows 11 only, read-only (no code fixed)

Date: 2026-10-14. Tester: OpenCode agent (this session). Statuses:
PASS (with evidence file) / FAIL (evidence) / BLOCKED (missing need stated) /
N/A (only if docs/product/implementation-status.md marks Planned — never used below).

## 1. Environment summary

| Item | Value | Evidence |
|---|---|---|
| OS | Windows 11 Pro 10.0.26200 x64, non-admin? unknown (no VM/fresh user — same dev box) | test-evidence/env-windows.txt |
| Node / npm | v20.15.1 / 10.7.0 (repo requires ≥22.5) | test-evidence/env-versions.txt |
| Repo | commit cb862cf + **38 modified + 12 untracked files (uncommitted)** | test-evidence/env-versions.txt |
| macOS | No Mac available | — |
| Providers/keys | None (no throwaway keys, no Ollama probed) | — |
| App run | Never launched (no screenshots/recordings possible here) | — |
| Sandbox C:\NexioTest | Not created (destructive-adjacent fixtures out of scope on dev box) | — |

Real secrets seen in logs/UI/notifications: **none** (repo grep finds only
`sk-abc123…`, `AKIAIOSFODNN7EXAMPLE`, `MIIE…` fixtures in tests).

## 2. Automated suites (Part 1)

| # | Command | Result | Evidence |
|---|---|---|---|
| 1a | `npm run lint` (tsc + i18n:check) | **PASS** | test-evidence/lint.txt |
| 1b | `npm run typecheck` | **PASS** (via lint) | test-evidence/lint.txt |
| 1c | `npm run format:check` | **BLOCKED** — script does not exist | package.json |
| 1d | `npm test` (vitest) | **FAIL (env)** — 468 pass / 58 fail / 33 skip (39 files); all 58 fail at `node:sqlite requires Node 22.5+` (this box runs Node 20). New suites pass: tasks 17, safety 6, subtasks 4, UI 12, i18n-global 15, store 4 fail on sqlite only. 13 pure memory tests pass (classifier multilingual, fast-path, offline-null, secrets-block, Turkish) | test-evidence/vitest.txt, memory-passed.txt |
| 1e | `npm run build` (tsc + copy-renderer) | **PASS** | test-evidence/build.txt |
| 2 | Coverage; modules <80% | **BLOCKED** — no coverage tooling/config | package.json |
| 3 | E2E (CDP suite, 3× + flaky list) | **BLOCKED** — needs built app + display + providers; not attempted | e2e/suite.js |
| 4a | `npm run i18n:check` | **PASS** (2 untranslated-key warns: `app.name`, `tasks.agentTag` — both intentional) | test-evidence/i18n-check.txt |
| 4b | `npm run assets:check` | **PASS** (exit 0) | test-evidence/assets-check.txt |
| 4c | Docs link check (37 md files) | **PASS** — 0 broken (script kept as evidence) | test-evidence/docs-links.txt (+.js) |
| 4d | `madge --circular`, knip | **BLOCKED** — not installed | npm ls evidence below |
| 4e | `npm audit` (review) | **FAIL (advisories, review-only)** — vitest mocker (moderate), electron-builder/tar chain (high), **Electron GHSA-v3j7/v64w/9f4c/j84w** (high) | test-evidence/npm-audit.txt |
| 5 | `electron-builder --dir`, installers, unpacked grep, fonts | **BLOCKED** (no build cache; first run downloads toolchain) — static only: productName `Nexio`, files `dist/**`+pkg+MCP SDK (no `design/`, no `src`), icon.ico/icns/png + tray 16/20/24/32 + 4 woff2 fonts present, zero `MiniAI`/opencode strings in `src/` (only legacy DB-migration paths + legacy settings keys, both intentional and tested) | electron-builder.yml, test-evidence/ (dir listings in §6) |
| 6 | Provider conformance + live smoke | **Partial: PASS (mock, 43 tests)** / **BLOCKED (live — no keys)** | test-evidence/vitest.txt:27 |

## 3. Real-environment matrix (Part 2)

Reason codes: [no-app] app never launched here · [no-mac] no Mac · [no-keys] no
provider keys · [no-sandbox] fixtures not created · [node20] needs Node ≥22.5.

| ID | Result | Evidence / missing need |
|---|---|---|
| A1 | BLOCKED [no-app] | installer/tray/Dock never exercised |
| A2 | BLOCKED [no-app] | onboarding flows need UI |
| A3 | BLOCKED [no-app] | MiniAI migration paths exist in code+tests only (`db.ts:18-26`, contract test) |
| A4 | BLOCKED [no-app] | uninstall/single-instance need OS |
| A5 | BLOCKED [no-app] | unit-level PASS: `i18n:check`, `i18n-global` (plurals ru/ar, pseudo, RTL flags, `Intl` sizes/counts); Arabic mirror + pseudo screenshots missing |
| B1–B5 | BLOCKED [no-app] | hotkey/layout/blur/DPI/scroll/fonts need window (fonts ship: 4 woff2) |
| C1–C4 | BLOCKED [no-app] | live-region/plural unit asserts exist (`view-single`, `i18n`) but no SR run |
| D1 | BLOCKED [no-app] | |
| D2 | BLOCKED [no-keys] | coded contract PASS: non-English always falls to model (`intent.test`); multilingual few-shots asserted; live routing untested |
| D3 | PASS | `slash.test` (ranking/groups) + `view-single` palette asserts — vitest.txt |
| D4 | PASS | `view-single` view-slash asserts — vitest.txt |
| E1,E2,E4 | BLOCKED [no-app] | |
| E3 | PASS (logic) | `tasks-safety` Ask `MODE_READ_ONLY` + `ask-mode.test` (17 ✓) — vitest.txt |
| F1–F4,F6–F8 | BLOCKED [no-app/node20] | tool/policy unit tests exist but DB-gated here |
| F5 | BLOCKED [node20] | injection-card loop tests exist, fail here only on sqlite — needs Node 22 CI |
| G1,G2 | BLOCKED [no-app] | scheduler spawn/queue logic PASS (`tasks.test`) — vitest.txt |
| G3 | PASS (logic) | locks serialize/file+folder, reads-note, release, deadlock-cap — vitest.txt:tasks.test |
| G4 | BLOCKED [no-app] | card-in-own-view + notify coded; needs hidden-window run |
| G5 | PASS (logic) | caps/dedupe/circuit (`tasks.test`), first-confirm + untrusted-note (`tasks-safety`) — vitest.txt; live 4-folder fan-out BLOCKED |
| G6 | PASS (logic) | cross-parent forgery rejected, Ask exclusion, UI contract (`tasks-subtasks`, `tasks-ui`) — vitest.txt |
| G7 | BLOCKED [no-app] | quit/sleep/prune paths coded, never executed |
| H1–H3,H5 | BLOCKED [node20/no-app] | store/loop tests DB-gated here |
| H4 | PASS (logic) | 12-language classifier contract + fast-path + offline-null — memory-passed.txt |
| I1,I3,I4 | BLOCKED [no-app] | |
| I2 | PASS (logic) | `attachments.test` (33 ✓) + `attachments-documents` (65 ✓) incl. zip-slip/symlink/macros/encrypted/empty — vitest.txt |
| J1,J2 | BLOCKED [no-keys] | mock conformance 43 ✓; live values untested |
| J3 | BLOCKED [no-app] | switch-row asserts (`view-single`) only |
| J4 | BLOCKED [no-app] | needs packaged-app disk inspection |
| K1–K4 | BLOCKED [no-app/node20] | hook/mcp/store tests DB- or shell-gated (see D-hooks-01) |
| L1,L3,L4 | BLOCKED [no-app] | |
| L2 | BLOCKED [no-app] | perf numbers never measured |
| L5 | Partial | PASS: zero MiniAI/opencode UI strings (grep), 0 broken doc links, banner assets present; BLOCKED: banner render, screenshots, per-OS shortcut verification |

## 4. Counts

- Automated: PASS 7 (lint, typecheck, build, i18n:check, assets:check, docs-links, mock conformance) / FAIL 2 (vitest env-gated, npm-audit advisories) / BLOCKED 6 (format:check, coverage, e2e, madge/knip, packaging, live smoke).
- Matrix: PASS 8 (D3, D4, E3-logic, G3-logic, G5-logic, G6-logic, H4-logic, I2-logic) + 1 partial (L5) / FAIL 0 / BLOCKED rest. macOS column: 100% BLOCKED.
- New-code suites in this tree: 17 + 6 + 4 + 12 + 15 passing; 4 store tests sqlite-gated.

## 5. Defects

| ID | Sev | Section | Repro | Expected / Actual | Evidence | Suspected cause |
|---|---|---|---|---|---|---|
| D-hooks-01 | **High** | K3/loop | `npx vitest run tests/unit/extensions.test.ts` on Win11 + Node 20 | hook `node -e …process.exit(2)` → block/`blocked`; actual exit 0 / `ran` | vitest.txt (`exit 2 blocks…`, `hook block stops…`) | Windows shell quoting in `runHookCommand` (env) or real bypass — **unresolved; hook blocking unverified on Windows** |
| D-tree-02 | Low | process | `git status --short` | clean tree; actual 38 modified + 12 untracked over cb862cf | env-versions.txt | two tasks' work uncommitted |
| D-audit-03 | Med | L4/deps | `npm audit` | Electron GHSA-v3j7 (fetch CORS), v64w (redirect→file), 9f4c (iframe popup bypass), j84w + builder tar path | npm-audit.txt | upstream; fixes are breaking upgrades |
| D-tool-04 | Low | process | `npm run format:check`, coverage, knip/madge | missing scripts/tools | package.json | never set up |

## 6. Security findings (first, separately)

1. **Repo secret scan: clean.** Only obvious fixtures (`sk-abc123…`, `AKIAIOSFODNN7EXAMPLE`, `MIIE…`) in tests. No Blockers seen in code.
2. **Hook enforcement on Windows is unproven** (D-hooks-01): the two tests that would prove exit-2 blocking fail on this box. Treat hooks as untrusted-console-only until green on Win+Mac CI.
3. **Electron advisories** (D-audit-03) deserve a version plan; the app opens local files and URLs.
4. **Injection matrix (F5/H3/G5-untrusted) unexecuted**: fixtures in `untrusted/` were never created and no live run attempted — the scanner/card paths are unit-tested only.
5. Notifications/approval payloads and hidden-window behavior never observed live.

## 7. Recommendation: **NO-GO on both OSes**

Top 5 fixes before release: (1) resolve D-hooks-01 on Win+Mac CI and re-run the full matrix live; (2) run the DB-gated suites (F/H/K memory, tasks-store, settings) on Node ≥22.5; (3) execute E2E + Part 2 A–L on real Win11 + macOS (arm64 + Intel) with throwaway keys; (4) commit the tree and cut the release from a clean tag; (5) disposition `npm audit` highs (Electron upgrade path).

Could not test: everything marked BLOCKED above — all real-app behavior (install, hotkey, layout, modes, tools, approvals, tasks live, memory live, attachments live, providers live, extensions live, perf/a11y/privacy, packaging/installers); anything macOS; anything needing keys, sandbox destruction, or Node 22.
