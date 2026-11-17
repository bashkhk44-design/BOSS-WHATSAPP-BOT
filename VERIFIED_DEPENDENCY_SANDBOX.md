# Verified dependency runtime in the Docker sandbox

The customer-project tester can now accept a prebuilt offline dependency artifact directory as an explicit input. When sandbox runtime tests are enabled and the customer's lockfile declares packages, the tester requires that artifact, verifies it against the exact package-lock file, and unpacks it with `offline-dependency-unpack.js` before invoking Docker.

The resulting `node_modules` directory is mounted read-only at `/workspace/node_modules`. The project source remains a separate read-only mount. The container continues to use a digest-pinned image, `--network=none`, read-only root filesystem, bounded memory/CPU/PIDs, non-root UID, dropped capabilities, no-new-privileges, and a bounded timeout.

## Fail-closed behavior

- Missing verified artifacts for a project with locked packages prevents runtime tests from starting.
- Missing or malformed package-lock data for declared dependencies prevents runtime tests from starting.
- Artifact lockfile digest, package mapping, SHA-512 and SRI checks are enforced by the offline unpacker.
- A symlinked runtime node_modules root is rejected before Docker is invoked.
- No npm install, lifecycle script, shell installer, package download, or network access is performed during this stage.

## Scope and safety boundary

This is an explicit preparation-stage integration. The caller must supply an artifact directory produced by the separately controlled dependency-artifact preparation step; this change does not download packages or create artifacts. The new argument is not wired to production request orchestration, the worker, Render, or Neon. Sandbox execution remains opt-in via `BOSS_SANDBOX_ENABLED=YES`, and the image must remain pinned via `BOSS_SANDBOX_IMAGE`.

The tests verify argument construction, read-only mount configuration, fail-closed behavior, and the existing synthetic Docker smoke test. They do not claim that arbitrary customer projects have been executed successfully or that a real registry/proxy download was performed.