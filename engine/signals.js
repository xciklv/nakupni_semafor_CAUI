const WEIGHT = { low: 1, medium: 3, high: 6 };

function signal({ id, module, severity, title, evidence, source = null, hard = false }) {
  if (!Object.hasOwn(WEIGHT, severity)) throw new Error('Neplatná závažnost: ' + severity);
  return { id, module, severity, title, evidence, source, hard };
}

if (typeof module !== 'undefined') module.exports = { WEIGHT, signal };
