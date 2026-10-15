const WEIGHT = { low: 1, medium: 3, high: 6 };
const SIGNAL_EVIDENCE_MAX = 300;

function signal({ id, module, severity, title, evidence, source = null, hard = false }) {
  if (!Object.hasOwn(WEIGHT, severity)) throw new Error('Neplatná závažnost: ' + severity);
  const cap = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n - 1) + '…' : v);
  return { id, module, severity, title: cap(title, 120), evidence: cap(evidence, SIGNAL_EVIDENCE_MAX), source, hard };
}

if (typeof module !== 'undefined') module.exports = { WEIGHT, signal };
