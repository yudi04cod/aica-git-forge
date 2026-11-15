// Process lifecycle for the forge entry: how this process and the trial env
// find each other, and how the process learns that it may exit.
//
// The env speaks first, through MAKEFUN_ENV_URL: the variable names the env's
// origin. Without an origin there is no trial to serve, so the process writes
// a line to stderr and exits 1 at once. With one, the life of the process is:
//
//   1. Build the forge (app.ts) and listen on port 0. The kernel chooses the
//      port; 8080 is never ours to take, because the env listens there.
//   2. POST {"port": N} to the env's /register endpoint. The env pairs the
//      address the request arrived from with N and dials that base URL from
//      then on. A 200 means we are registered. A 409 means an earlier
//      register already won the slot — not this process's problem to fix, so
//      it carries on to the wait like any other process. A 400 or 405 is the
//      env rejecting the call itself, a contract breach: fatal, exit 1.
//      Anything else — a refused connection, a timeout, an unexpected
//      status — means the env is probably still starting, so we retry.
//   3. Poll GET /done. The env answers at once: {"done": false} while the
//      suite runs, {"done": true} once it has finished and written the
//      export the scorer reads. So this is a poll, never a held-open
//      request, and a failed poll means nothing more than "not done yet".
//   4. On done: close the server and exit 0 — the only way this process
//      ever exits 0.
//
// Both retry loops pace themselves identically: a pause that starts at a
// quarter second, doubles after each miss, and never grows past two
// seconds, so a slow env is waited out without being hammered.
//
// This file imports the forge factory from app.ts and nothing else: no
// packages, no Node built-ins — only globals (fetch, AbortSignal, timers,
// process).

import { createApp } from './app.ts';

/** The env's origin with any trailing slashes removed; empty when unset. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long one call to the env may run before it counts as a miss. */
const CALL_TIMEOUT_MS = 30_000;

/** Retry pacing: the first pause after a miss, and the ceiling for all pauses. */
const FIRST_PAUSE_MS = 250;
const MAX_PAUSE_MS = 2_000;

/**
 * A pause source for a single retry loop. Every call waits out the current
 * pause and then lengthens the next one: doubling from FIRST_PAUSE_MS, with
 * both the pause and the doubling exponent capped so neither runs away.
 * Each loop gets its own pacer, so the two loops pace independently.
 */
function newPacer(): () => Promise<void> {
  let misses = 0;
  return () =>
    new Promise<void>((resolve) => {
      const pauseMs = Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(misses, 8));
      misses += 1;
      setTimeout(resolve, pauseMs);
    });
}

/** The env refused the register call on contract grounds (HTTP 400/405). */
class RegisterRefused extends Error {}

/**
 * Tell the env which port the forge bound, retrying until the env accepts.
 * Resolves when the register lands (200) or turns out to have already been
 * won by an earlier register (409). Throws RegisterRefused on 400/405;
 * every other outcome — network failure, timeout, odd status — is retried.
 */
async function announcePort(port: number): Promise<void> {
  const pace = newPacer();
  for (;;) {
    let refusal: RegisterRefused | null = null;
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        refusal = new RegisterRefused(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch {
      // The call never landed — the env may still be starting. The retry
      // below is the whole response to that.
    }
    if (refusal !== null) throw refusal;
    await pace();
  }
}

/**
 * Poll the env's /done endpoint until its body is {"done": true}, and
 * resolve only then. A non-OK status, an unreadable body, or a body whose
 * done is anything but exactly true all mean the trial is still running.
 */
async function awaitTrialEnd(): Promise<void> {
  const pace = newPacer();
  for (;;) {
    try {
      const res = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Unreachable, timed out, or garbled: in every case, not done.
    }
    await pace();
  }
}

/**
 * Bind the forge to an ephemeral port, announce the port to the env, then
 * hold the process open until the env ends the trial. Resolves once the
 * server is closed after done; rejects on a bind failure or a refused
 * register, which the caller turns into exit 1.
 */
async function run(): Promise<void> {
  const server = createApp();
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  process.stdout.write(`[entry] listening on port ${boundPort}\n`);

  await announcePort(boundPort);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitTrialEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
