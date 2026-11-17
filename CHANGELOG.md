# Changelog

## 0.8.5 — 2026-11-17

- docs: record the memory-only write route (HANDOFF 29) and its re-evaluation
- feat(write): auto-captured memories never go into AGENTS.md (align with Claude Code)


## 0.8.4 — 2026-11-16

- fix(storage): never overwrite a history copy written in the same millisecond
- docs(readme): update the command section for the /memory picker and merged subcommands
- refactor(command): drop the standalone /memory_extract and /memory_pending commands
- feat(command): /memory overview aligned with the panel, subcommand picker, help/status, Chinese messages
- fix(client): register the client module under the npm package name; add a Memory entry to the right-bar start page


## 0.8.3 — 2026-11-15

- ci: note why windows+node 18 is intentionally not in the matrix
- fix: use fileURLToPath instead of import.meta.dirname so tests run on node 18
- ci: add scheduled multi-platform test workflow (ubuntu 18/20, windows 20)
- fix: ship scripts/install-deps.mjs so the README step works after npm install
- docs: record the npm publish and the Linux-only CI failures


## 0.8.2 — 2026-11-15

- release: v0.8.1
- fix: skip Windows-only cmd-quoting cases on other platforms
- fix: make tests run on Linux CI (portable absolute path, skip embedder-only cases)
- feat: publish to npm as @lovenndme/dsh-workspace-memory with CI release pipeline
- Panel redesign: overview map, review cards, instructions and memories pages
- Preview: memory panel redesign (approved static preview)
- Docs: rewrite README for users, move design notes to docs/DESIGN.md
- Memory admission redesign: source-based routing, call-time destinations
- HANDOFF: record the real-memory cleanup (24.7)
- Tests: never launch real processes (stop popping terminal windows)
- Docs: README/HANDOFF/CLAUDE.md for the review-and-fix round
- Host: harden routes, self-healing recall, word-boundary keywords, slug guard
- Storage: block id path traversal, lossless frontmatter, safer AGENTS.md edits
- Panel: fix save races, pending edits, AGENTS.md positional writes
- Pin LF line endings via .gitattributes
- Baseline before code-review fixes


## 0.8.1 — 2026-11-15

- fix: skip Windows-only cmd-quoting cases on other platforms
- fix: make tests run on Linux CI (portable absolute path, skip embedder-only cases)
- feat: publish to npm as @lovenndme/dsh-workspace-memory with CI release pipeline
- Panel redesign: overview map, review cards, instructions and memories pages
- Preview: memory panel redesign (approved static preview)
- Docs: rewrite README for users, move design notes to docs/DESIGN.md
- Memory admission redesign: source-based routing, call-time destinations
- HANDOFF: record the real-memory cleanup (24.7)
- Tests: never launch real processes (stop popping terminal windows)
- Docs: README/HANDOFF/CLAUDE.md for the review-and-fix round
- Host: harden routes, self-healing recall, word-boundary keywords, slug guard
- Storage: block id path traversal, lossless frontmatter, safer AGENTS.md edits
- Panel: fix save races, pending edits, AGENTS.md positional writes
- Pin LF line endings via .gitattributes
- Baseline before code-review fixes

