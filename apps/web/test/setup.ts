import { cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll } from 'vitest';
import { init } from '@xmrswap/sdk';

beforeAll(async () => {
  await init();
});

afterEach(() => {
  cleanup();
  if (typeof window !== 'undefined') {
    window.location.hash = '';
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.title = '';
  }
});

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;
  }
  // jsdom has no SubtleCrypto; Node's is the same Web Crypto API.
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => undefined;
  }
  // jsdom does not implement <dialog> methods.
  if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
}
