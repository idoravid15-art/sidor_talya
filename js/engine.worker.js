// Module worker: new Worker('js/engine.worker.js', { type: 'module' })
import { solve } from './engine.js';

self.onmessage = (e) => {
  const { config, opts = {} } = e.data || {};
  try {
    const result = solve(config, {
      ...opts,
      onProgress: (p) => self.postMessage({ type: 'progress', pct: p.pct, best: p.best }),
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
