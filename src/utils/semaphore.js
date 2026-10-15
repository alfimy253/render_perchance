import { AppError } from './errors.js';

/**
 * Tiny in-process counting semaphore.
 *
 * It only protects the memory of ONE function instance (each generation job runs
 * its own Chromium, ~300-600 MB). It is not shared state: nothing survives the
 * request, and different Vercel instances never coordinate.
 */
export class Semaphore {
  /** @param {number} max */
  constructor(max) {
    this.max = Math.max(1, max | 0);
    this.active = 0;
    /** @type {Array<{ grant: () => void, reject: (e: Error) => void }>} */
    this.waiters = [];
  }

  get pending() {
    return this.waiters.length;
  }

  /**
   * Resolves with a release() function once a slot is free.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<() => void>}
   */
  acquire({ timeoutMs = 0, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new AppError('CLIENT_ABORTED'));

    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.#releaser());
    }

    if (timeoutMs <= 0) {
      return Promise.reject(new AppError('BUSY', undefined, { details: { active: this.active, max: this.max } }));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          cleanup();
          this.active += 1;
          resolve(this.#releaser());
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.#remove(waiter);
        waiter.reject(new AppError('BUSY', undefined, { details: { waitedMs: timeoutMs, max: this.max } }));
      }, timeoutMs);
      const onAbort = () => {
        this.#remove(waiter);
        waiter.reject(new AppError('CLIENT_ABORTED'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  #remove(waiter) {
    const i = this.waiters.indexOf(waiter);
    if (i !== -1) this.waiters.splice(i, 1);
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next.grant();
    };
  }
}
