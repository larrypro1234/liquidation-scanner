// Hidden page the background worker opens so alerts can play even when the
// dashboard tab is closed (service workers can't play audio themselves).

let ctx = null;

// Two-tone siren: square waves alternating high/low, through a compressor so
// it's as loud as the speakers allow without distorting.
function siren(seconds, volume) {
  ctx = ctx || new AudioContext();
  const out = ctx.createDynamicsCompressor();
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  const step = 0.22;
  for (let i = 0; i * step < seconds; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = i % 2 ? 988 : 1319;
    const t = t0 + i * step;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    g.gain.setValueAtTime(volume, t + step - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + step - 0.005);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + step);
  }
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.target !== 'offscreen' || msg.type !== 'alarm') return;
  const kind = msg.kind || 'new';
  if (kind === 'new') siren(3, 0.9);          // new lot: loud, ~3 s
  else if (kind === 'drop') siren(1.4, 0.7);  // price drop: shorter
  else siren(0.9, 0.5);                       // CAPTCHA / block: short heads-up
  chrome.runtime.sendMessage({ type: 'alarm-played', kind, at: Date.now() }).catch(() => {});
});
