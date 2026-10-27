// Execute through agent-browser eval --stdin while /motion.html is open.
(async () => {
  const api = window.__mayaMotionFixture;
  if (!api) throw new Error('Open the developer-only /motion.html fixture first.');
  const checks = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, pass, evidence) => {
    checks.push({ name, pass: Boolean(pass), ...(evidence === undefined ? {} : { evidence }) });
    if (!pass) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
  };
  const cellOf = id => api.snapshot().positions.find(p => p.positionId === id)?.cellId;
  const card = id => document.querySelector(`.position-card[data-cell-id="${cellOf(id)}"]`);
  const effect = id => document.querySelector(`.maya-fx[data-effect-id="${cellOf(id)}"]`);
  const reveal = async id => { api.reveal(id); const p = api.snapshot().positions.find(item => item.positionId === id); const threshold = p.status === 'won' ? p.touchTimeMs : p.endMs; const deadline = performance.now() + 6000; while (api.diagnostics().playheadMs < threshold && performance.now() < deadline) await delay(40); await delay(25); };
  const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;

  api.reset({ historical: true });
  await delay(160);
  check('Hydrated terminal history does not mount cards or replay bursts', api.diagnostics().cardCount === 0 && api.diagnostics().activeEffects === 0);
  api.setMarket('btc-usd'); api.setMarket('eth-usd');
  check('Switching markets does not replay historical results', api.diagnostics().activeEffects === 0);

  api.reset();
  await delay(200);
  const id = api.place();
  const element = card(id);
  check('Acceptance creates one card and a placement response', Boolean(element) && effect(id)?.dataset.kind === 'place');
  for (let i = 0; i < 24; i++) api.publish();
  check('Card DOM survives fresh snapshot objects', card(id) === element);
  await delay(reduced ? 1100 : 570);
  check('Entrance advances to open without replacing the card', card(id) === element && element.dataset.phase === 'open', element.dataset.phase);
  check('Placement response expires independently', !effect(id));
  const additions = [];
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && node.matches('.maya-fx')) additions.push(node.dataset.kind);
  });
  observer.observe(document.querySelector('.maya-feedback'), { childList: true });
  api.settle(id, 'won');
  await reveal(id);
  const winEffect = effect(id);
  check('One terminal transition preserves card DOM and locks phase', card(id) === element && element.dataset.phase === 'won');
  check('Win shows the exact locked gross payout', winEffect?.querySelector('.maya-fx__caption')?.textContent === '+$12.55');
  if (reduced) check('Reduced motion suppresses moving rings', getComputedStyle(winEffect.querySelector('.maya-fx__energy')).display === 'none');
  for (let i = 0; i < 20; i++) { api.publish(); api.settle(id, 'won'); }
  await delay(30);
  check('Repeated updates do not replay terminal effects', effect(id) === winEffect && additions.filter(kind => kind === 'win').length === 1, additions);
  await delay(1530);
  check('Won card leaves the chart after its terminal animation', !card(id));
  if (!reduced) check('Floating payout remains after its card is gone', Boolean(effect(id)));
  await delay(850);
  check('Terminal effects and cards fully clean up', !effect(id) && !card(id));
  api.publish(); api.setMarket('btc-usd'); api.setMarket('eth-usd');
  check('Retired cards cannot remount after snapshots or market switches', !card(id) && !effect(id));
  observer.disconnect();

  api.reset();
  const inFlight = api.place();
  api.settle(inFlight, 'won'); await reveal(inFlight);
  check('Fresh win is visible before switching markets', Boolean(effect(inFlight)));
  api.setMarket('btc-usd');
  check('Switching markets immediately clears old chart effects', api.diagnostics().activeEffects === 0);
  api.setMarket('eth-usd');
  check('Returning to a market does not replay its win', !effect(inFlight) && !card(inFlight));

  api.reset();
  const hidden = api.place();
  api.setMarket('btc-usd'); api.settle(hidden, 'lost'); await delay(65); api.setMarket('eth-usd');
  check('An off-market settlement is not celebrated on return', !effect(hidden) && !card(hidden));

  api.reset();
  const missed = api.place({ bucketOffset: 1 });
  const returned = api.place({ bucketOffset: -1 });
  api.settle(missed, 'lost'); api.settle(returned, 'refunded'); await reveal(missed); await reveal(returned);
  check('Miss and refund use distinct phases', card(missed)?.dataset.phase === 'lost' && card(returned)?.dataset.phase === 'refunded');
  await delay(1250);
  check('Missed card disappears after 1200ms', !card(missed));
  await delay(520);
  check('Refund card and response disappear without lingering', !card(returned) && !effect(returned));

  api.reset();
  const restored = api.place();
  api.replayView();
  await delay(100);
  check('Restored open position is visible without a placement replay', Boolean(card(restored)) && !effect(restored));
  await delay(400);
  const frames = [];
  for (let i = 0; i < 80; i++) {
    await new Promise(requestAnimationFrame);
    const diagnostics = api.diagnostics();
    frames.push({ at: performance.now(), time: diagnostics.playheadMs, price: diagnostics.displayedPrice, x: Number.parseFloat(card(restored)?.style.left ?? '0') });
  }
  const playheadSteps = frames.slice(1).map((frame, i) => frame.time - frames[i].time);
  const movement = frames.slice(1).map((frame, i) => frame.x - frames[i].x);
  const advancing = playheadSteps.filter(step => step > 0).length;
  const moving = movement.filter(step => step < 0).length;
  check('Playhead advances smoothly between 1s observations', advancing >= 45 && Math.min(...playheadSteps) >= 0 && Math.max(...playheadSteps) < 150, { advancingFrames: advancing, measuredFrames: playheadSteps.length, maxStepMs: Math.max(...playheadSteps) });
  check('Canonical cards move continuously with the timeline', moving >= 45 && card(restored) !== null, { movingFrames: moving, maximumShiftPx: Math.max(...movement.map(Math.abs)) });
  check('Display interpolation has many distinct price states', new Set(frames.map(frame => frame.price.toFixed(5))).size > 25);
  check('Verification runs through the explicitly labeled developer entry', document.title.includes('Developer motion fixture'));
  window.__mayaMotionVerification = { reducedMotion: reduced, checks, diagnostics: api.diagnostics(), frames };
  return { reducedMotion: reduced, checks, diagnostics: api.diagnostics() };
})()
