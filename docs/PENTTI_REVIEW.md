# Pentti Project Review

Date: 2026-04-11

## Scope

This document reviews the NanoClaw-based bot project "Pentti" with emphasis on:

- Architecture
- Code quality
- Maintainability
- Good engineering practices (DRY, YAGNI, separation of concerns)
- Tests and test coverage
- Security

Review method:

- Read core runtime, container, IPC, persistence, routing, setup, and channel modules
- Read existing architecture and security documentation
- Reviewed existing test suite
- Ran `npx vitest run --coverage`

Coverage snapshot from the review run:

- Test files: 23 passed
- Tests: 408 passed
- Total coverage: 59.18% statements, 51.94% branches, 59.70% functions, 60.12% lines

High-risk coverage gaps from the run:

- `src/index.ts`: 5.59% lines
- `src/mount-security.ts`: 4.00% lines
- `src/ipc.ts`: 48.27% lines
- `src/task-scheduler.ts`: 45.74% lines

## Executive Summary

The project is directionally strong. Its core design choices are better than average for an AI-agent host: container isolation, explicit mount boundaries, group-level separation, and a credential proxy that keeps Anthropic credentials out of containers are all solid architectural decisions.

The main weaknesses are concentrated at the trust boundaries and in test coverage of the most critical runtime code:

- The credential proxy can become externally reachable on some Linux setups
- Remote control is insufficiently authorized for a host-privileged capability
- The voice API is too permissive and too easy to abuse for message injection or memory exhaustion
- Some secrets are still exposed to containers or persisted in accessible logs
- The main orchestrator and mount security logic are among the least-tested parts of the system

## Findings By Criticality

## Critical

### 1. Credential proxy can become a network-reachable credential oracle

Affected files:

- `src/container-runtime.ts:23-40`
- `src/index.ts:590-594`
- `src/credential-proxy.ts:268-309`

Why this matters:

On Linux, when `docker0` is not found, `PROXY_BIND_HOST` falls back to `0.0.0.0`. The credential proxy does not authenticate callers. If that fallback is used on a reachable interface, any client that can connect to the port can send requests to allowed Anthropic paths and have Pentti inject real credentials.

Impact:

- Abuse of Anthropic credentials
- Unexpected billing exposure
- Expansion of the attack surface beyond the intended container boundary

Assessment:

This is the most serious issue found because it weakens the core isolation model described in `docs/SECURITY.md`.

Recommended fix:

- Fail closed instead of binding to `0.0.0.0`
- Bind only to loopback or a verified container-only interface
- Add explicit client authentication between container and proxy
- Reduce the allowed path surface further if possible

## High

### 2. Remote control is authorized by group, not by trusted sender

Affected files:

- `src/index.ts:651-659`
- `src/index.ts:613-645`
- `src/remote-control.ts:112-127`

Why this matters:

`/remote-control` is intercepted before normal sender filtering and only checks whether the command came from the main group. Starting remote control also auto-confirms the Claude prompt by writing `y` to stdin.

Impact:

- Any sender who can post in the main group may be able to start or stop host-level remote control
- This grants access to a highly privileged operator capability with insufficient authorization

Assessment:

This is a high-severity security issue because it affects direct control of the host-side Claude session.

Recommended fix:

- Require explicit sender-level authorization before accepting `/remote-control`
- Restrict remote control to a configured owner/admin list
- Remove auto-confirm, or require an additional local confirmation step
- Add direct tests for the interception path in `src/index.ts`

### 3. Voice API is overly permissive and vulnerable to memory abuse

Affected files:

- `src/voice-api.ts:64-66`
- `src/voice-api.ts:84-86`
- `src/voice-api.ts:98-115`
- `src/voice-api.ts:133-141`
- `src/voice-api.ts:162-166`
- `src/voice-api.ts:175-183`

Why this matters:

The voice API:

- Listens on `0.0.0.0`
- Accepts arbitrary `jid` and `sender` query parameters
- Marks injected messages as `is_from_me: true`
- Buffers request bodies fully before applying limits
- Has no explicit text-body size limit for `/message`

Impact:

- A leaked token can be used as a high-privilege message injection capability
- Large requests can exhaust memory in the single orchestrator process
- `is_from_me: true` weakens trust assumptions in downstream logic

Recommended fix:

- Bind to localhost by default
- Remove arbitrary `jid` and `sender` overrides or strictly whitelist them
- Treat API-injected content as a distinct sender type, not `is_from_me`
- Enforce streaming limits while reading request bodies
- Add max size limits for `/message`

## Medium

### 4. Secret handling is inconsistent with the documented isolation model

Affected files:

- `src/container-runner.ts:290-296`
- `src/container-runner.ts:374-399`
- `src/container-runner.ts:665-689`

Why this matters:

**RESOLVED.** The credential proxy now handles all external service credentials via path-based routing. `WOLFRAM_APP_ID` is no longer passed as an env var — containers use `WOLFRAM_API_URL` pointing at the proxy. HA credentials were also moved out of `shared-mcp.json` into the proxy; the MCP config in containers points at the proxy URL with no auth headers.

~~The project correctly keeps Anthropic credentials out of containers through a proxy, but other secrets are still passed directly. `WOLFRAM_APP_ID` is injected into the container environment. On error or verbose logging, full container args can be written into per-group logs that are accessible from the same group's writable area.~~
- Extend the proxy pattern to other secrets where practical
- Review all container env passthroughs for least privilege

### 5. Per-group writable agent runner enables durable compromise of a group runtime

Affected files:

- `src/container-runner.ts:226-248`

Why this matters:

The host copies `container/agent-runner/src` into a persistent per-group directory and mounts it read-write into later containers. This makes prompt-injection or malicious tool-assisted modification persistent for that group.

Impact:

- Group-level persistence across runs
- Harder debugging and incident recovery
- Increased gap between "container is ephemeral" and actual runtime behavior

Recommended fix:

- Make the mounted runner read-only by default
- Treat runner customization as an explicit admin action
- Add reset/checksum tooling so drift is visible and recoverable

### 6. Remote-control restore trusts PID liveness alone

Affected files:

- `src/remote-control.ts:38-44`
- `src/remote-control.ts:51-72`
- `src/remote-control.ts:94-99`
- `src/remote-control.ts:214-221`

Why this matters:

The restore logic trusts `process.kill(pid, 0)` as proof that the saved process still belongs to the remote-control session. PID reuse can cause the wrong process to be adopted and later signalled.

Impact:

- Incorrect process restoration after restart
- Risk of signalling an unrelated process

Recommended fix:

- Persist and verify stronger identity information such as command line, start time, or a generated session token

### 7. Main runtime file is doing too much and is under-tested

Affected files:

- `src/index.ts:1-810`
- `src/routing.test.ts:29-170`

Why this matters:

`src/index.ts` owns startup, shutdown, state loading, trigger handling, queueing, remote control, channel bootstrap, scheduler bootstrap, IPC bootstrap, voice API bootstrap, and the main message loop. This is a maintainability risk and also explains why the most critical orchestration logic has the weakest test coverage.

Impact:

- Harder to reason about state transitions
- More regression risk when changing runtime behavior
- Difficult unit testing because responsibilities are tightly coupled

Recommended fix:

- Split orchestration into smaller modules with narrow responsibilities
- Extract trigger/session command authorization into shared pure functions
- Add direct tests for the real message loop and error/rollback behavior

### 8. Trigger and sender authorization logic is duplicated

Affected files:

- `src/index.ts:184-230`
- `src/index.ts:461-500`

Why this matters:

Trigger presence and sender authorization are implemented in more than one path. The logic is similar but not centralized.

Impact:

- DRY violation
- Risk of future drift between code paths
- Harder audits and harder tests

Recommended fix:

- Extract one shared decision function for trigger/session-command authorization
- Reuse it in both the message loop and queued processing path

### 9. Mount security is business-critical but barely tested

Affected files:

- `src/mount-security.ts:54-419`

Why this matters:

This module controls whether host paths can be mounted into containers, yet coverage is effectively absent.

Impact:

- High-confidence security assumptions with low test confidence
- Greater chance of regression in path validation, symlink handling, or read-only enforcement

Recommended fix:

- Add direct tests for allowlist loading, invalid configs, symlink resolution, blocked patterns, allowed-root matching, and read-only downgrades
- Add tests for `validateAdditionalMounts()` output paths and edge cases

### 10. IPC watcher behavior is not covered as well as IPC authorization

Affected files:

- `src/ipc.ts:221-372`
- `src/ipc.ts:374-589`

Why this matters:

The authorization logic has decent tests, but the actual watcher loop that scans files, quarantines malformed input, cleans error files, and dispatches work has meaningful untested behavior.

Impact:

- Lower confidence in production file-processing paths
- More risk around malformed input handling and operational recovery

Recommended fix:

- Add tests for real watcher directory scanning
- Test malformed JSON quarantine behavior
- Test cleanup of stale error files
- Test dispatch of both message and task IPC files from disk

### 11. Scheduler execution paths have limited test depth

Affected files:

- `src/task-scheduler.ts:78-239`
- `src/task-scheduler.ts:243-277`

Why this matters:

The scheduler has some tests, but most of the interesting runtime behavior is not exercised: task execution, result forwarding, group lookup failure, session handling, logging, and retry/close behavior.

Impact:

- Lower confidence in task execution correctness
- Potential regressions in one of the more operationally important features

Recommended fix:

- Add tests for `runTask()` success, failure, missing group, invalid folder, result forwarding, and context-mode behavior
- Add end-to-end queue interaction tests for due tasks

## Low

### 12. Several setup tests are surrogate tests rather than behavior tests

Affected files:

- `setup/service.test.ts:11-187`
- `setup/environment.test.ts:12-121`
- `setup/register.test.ts:12-257`

Why this matters:

Several tests reconstruct strings, SQL snippets, or helper logic instead of importing and exercising the real setup steps.

Impact:

- False confidence
- Setup regressions can slip through while tests still pass

Recommended fix:

- Convert setup tests to import the real modules and mock filesystem/process boundaries
- Prefer behavior tests over duplicate implementation tests

### 13. Logger setup is duplicated in one security-sensitive module

Affected files:

- `src/logger.ts:1-16`
- `src/mount-security.ts:12-21`

Why this matters:

Most of the project uses the shared logger, but `src/mount-security.ts` creates a separate `pino` instance.

Impact:

- Inconsistent logging behavior
- Small maintainability issue

Recommended fix:

- Reuse the shared logger unless there is a strong reason not to

## What Is Working Well

### Architecture and security model

- The overall design is coherent and understandable for a system of this kind
- Container isolation plus explicit mounts is a strong foundation
- Group-level session and IPC separation is well aligned with the trust model
- Path validation in `src/group-folder.ts` is good and simple
- The image path resolution in `src/ipc.ts` handles traversal concerns properly

### Code quality

- Many modules are reasonably focused and readable
- The project generally favors direct implementations over unnecessary abstraction
- The credential proxy is one of the stronger modules in the codebase from both design and implementation perspectives

### Testing

- The project already has a meaningful automated test suite
- Channel tests are substantial and more realistic than typical integration-adjacent unit tests
- `src/credential-proxy.test.ts` is strong and covers real behavior well
- `src/ipc-auth.test.ts` covers important authorization rules
- `src/sender-allowlist.test.ts`, `src/db.test.ts`, and `src/voice-api.test.ts` add useful depth

## Recommended Priorities

### Priority 1

- Fix credential proxy binding and add authentication
- Lock down remote control by trusted sender, not just group
- Harden the voice API and reduce its privilege surface

### Priority 2

- Remove secret leakage into logs and containers
- Revisit writable persistent `agent-runner` behavior
- Add direct tests for mount security and the main orchestrator

### Priority 3

- Refactor `src/index.ts` into smaller orchestration modules
- Remove duplicated authorization logic
- Replace surrogate setup tests with tests against the actual setup steps

## Final Assessment

Pentti is built on a good architectural base and shows clear signs of deliberate engineering. The most important improvements are not cosmetic. They are boundary-hardening and confidence-building work:

- Harden external interfaces
- Tighten privileged operations
- Align secret handling with the documented model
- Raise test confidence in the most critical runtime paths

If those areas are addressed, the project will become materially stronger in security, maintainability, and operational reliability.
