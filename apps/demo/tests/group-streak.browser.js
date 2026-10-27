// Developer-only integration proof; explicit outcomes never mutate the paper engine.
(async () => {
  const api = window.__mayaMotionFixture;
  if (!api) throw new Error('Open /motion.html first.');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const checks = [];
  const check = (name, pass, evidence) => {
    checks.push({ name, pass: Boolean(pass), ...(evidence === undefined ? {} : { evidence }) });
    if (!pass) { window.__mayaGroupStreakVerification = { checks }; throw new Error(`${name}: ${JSON.stringify(evidence)}`); }
  };
  const position = id => api.snapshot().positions.find(item => item.positionId === id);
  const card = id => document.querySelector(`.position-card[data-cell-id="${position(id).cellId}"]`);
  const effect = id => document.querySelector(`.maya-fx[data-effect-id="${position(id).cellId}"]`);
  const reveal = async id => { api.reveal(id); const p = position(id); const threshold = p.status === 'won' ? p.touchTimeMs : p.endMs; const deadline = performance.now() + 6000; while (api.diagnostics().playheadMs < threshold && performance.now() < deadline) await delay(40); await delay(25); };
  api.reset(); api.setRunning(false); api.showTools(false);
  const first = api.place({ stakeCents: '100', grossX100: '251' });
  const element = card(first);
  const second = api.place({ sameAs: first, stakeCents: '100', grossX100: '251' });
  check('Two accepted legs retain two intents but one canonical card', api.intents.length === 2 && api.diagnostics().cardCount === 1 && card(first) === element && position(first).cellId === position(second).cellId);
  check('Two one-dollar stakes display exactly two dollars', element.querySelector('b').textContent === '$2.00');
  check('Repeated-square count is visibly marked as two', element.dataset.betCount === '2' && getComputedStyle(element, '::before').content.includes('2'), getComputedStyle(element, '::before').content);
  check('The card shows the sum of both locked returns', element.querySelector('span').textContent === '$5.02 return');
  const third = api.place({ sameAs: first, stakeCents: '500', grossX100: '320' });
  check('A changed stake increments the existing card exactly', card(first) === element && element.querySelector('b').textContent === '$7.00' && element.dataset.betCount === '3');
  check('Different accepted odds retain individual values', api.snapshot().positions.map(item => item.grossX100).join(',') === '320,251,251');
  check('Mixed locked odds show an exact summed return rather than an invented average', element.querySelector('span').textContent === '$21.02 return' && !element.querySelector('span').textContent.includes('X'));
  const touch = position(first).startMs + 1000;
  let rejected = false;
  try { api.settle(first, 'won', { touchTimeMs: position(first).endMs }); } catch { rejected = true; }
  check('Fixture refuses touch times outside the half-open window', rejected && position(first).status === 'open');
  api.settle(first, 'won', { touchTimeMs: touch });
  api.settle(second, 'won', { touchTimeMs: touch });
  check('A partially settled group does not emit a terminal celebration', effect(first)?.dataset.kind !== 'win' && api.diagnostics().winStreak === 0);
  api.settle(third, 'won', { touchTimeMs: touch });
  await delay(reduced ? 1100 : 580);
  check('Financially won group stays visually pending before the playhead reaches touch time', api.diagnostics().playheadMs < touch && !effect(first) && element.dataset.phase !== 'won');
  api.advance(touch - 1200 - api.snapshot().nowMs);
  await delay(180);
  check('Advancing close to the touch still cannot celebrate early', api.diagnostics().playheadMs < touch && effect(first)?.dataset.kind !== 'win' && api.diagnostics().winStreak === 0);
  await reveal(first);
  const won = effect(first);
  check('Crossing the actual touch timestamp releases one grouped win', api.diagnostics().playheadMs >= touch && won?.dataset.kind === 'win' && api.diagnostics().winStreak === 1);
  check('Grouped terminal payout is the exact sum of all three legs', won?.querySelector('.maya-fx__caption').textContent === '+$21.02');
  check('Three winning legs in one square count as one win', won?.dataset.winVariant === 'ring' && won?.dataset.streak === '1' && !won?.querySelector('.maya-fx__streak'));
  for (let i = 0; i < 12; i++) api.publish();
  check('Fresh snapshots neither remount nor replay the grouped result', effect(first) === won && card(first) === element && api.diagnostics().winStreak === 1);
  const variants = [{ streak: 1, variant: won.dataset.winVariant }];
  for (let streak = 2; streak <= 5; streak++) {
    const id = api.place({ stakeCents: '100' }); api.settle(id, 'won'); await reveal(id);
    const celebration = effect(id);
    const expected = streak === 2 ? 'double-ring' : streak < 5 ? 'starburst' : 'nova';
    variants.push({ streak, variant: celebration?.dataset.winVariant });
    check(`Distinct canonical win ${streak} selects its real streak variant`, api.diagnostics().winStreak === streak && celebration?.dataset.winVariant === expected && celebration?.dataset.streak === String(streak));
  }
  const miss = api.place(); api.settle(miss, 'lost'); await reveal(miss);
  check('A distinct missed square resets the winning streak', api.diagnostics().winStreak === 0 && effect(miss)?.dataset.kind === 'loss');
  const restarted = api.place(); api.settle(restarted, 'won'); await reveal(restarted);
  check('First win after a miss returns to the original ring', api.diagnostics().winStreak === 1 && effect(restarted)?.dataset.winVariant === 'ring' && !effect(restarted)?.querySelector('.maya-fx__streak'));
  await delay(2450);
  const streakBeforeRefresh = api.diagnostics().winStreak;
  for (let i = 0; i < 10; i++) api.publish();
  check('Expired grouped effects do not replay on later snapshots', api.diagnostics().activeEffects === 0 && api.diagnostics().cardCount === 0 && api.diagnostics().winStreak === streakBeforeRefresh);
  api.replayView(); await delay(100);
  check('Reloaded terminal history is silent and cannot rebuild a streak', api.diagnostics().activeEffects === 0 && api.diagnostics().cardCount === 0 && api.diagnostics().winStreak === 0);
  api.setMarket('btc-usd'); api.setMarket('eth-usd'); await delay(100);
  check('Historical results stay silent after market switching', api.diagnostics().activeEffects === 0 && api.diagnostics().winStreak === 0);
  const result = { reducedMotion: reduced, checks, variants, diagnostics: api.diagnostics(), positions: api.snapshot().positions.length };
  window.__mayaGroupStreakVerification = result;
  return result;
})()
