'use strict';
//
// The browser pass the README used to describe as done by hand, now scripted.
//
// Each participant is a separate browser context, which is a separate
// localStorage and therefore a separate voter id, the same as separate people.
// The protocol suite already proves the server; these prove the page: that
// what the server says actually reaches the DOM, in the right place, inert.

const { test, expect } = require('@playwright/test');

// Any uncaught error in any page fails the test that opened it.
const pageErrors = [];

async function person(browser, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto('/arena');
  return { ctx, page };
}

test.afterEach(() => {
  expect(pageErrors, 'uncaught errors in the page').toEqual([]);
  pageErrors.length = 0;
});

async function fillModal(page, name, stance, handle) {
  await expect(page.locator('#modal')).toHaveClass(/active/);
  await page.locator('#nameInput').fill(name);
  if (handle) await page.locator('#handleInput').fill(handle);
  const pick = { pro: '#stancePro', con: '#stanceCon', undecided: '#stanceUnd' }[stance || 'undecided'];
  await page.locator(pick).click();
  await page.locator('#modalJoin').click();
  await expect(page.locator('#room')).toHaveClass(/active/);
}

async function joinFromLobby(page, topic, name, stance) {
  await page.locator('#roomList .room-card', { hasText: topic }).getByRole('button', { name: 'Join' }).click();
  await fillModal(page, name, stance);
}

const bubble = (page, text) => page.locator('#debateMsgs .bubble', { hasText: text });

test('a full debate, end to end, in real tabs', async ({ browser }) => {
  const topic = `Browsers should argue ${Date.now() % 100000}`;
  const alice = await person(browser);
  const bob = await person(browser);
  const carol = await person(browser);
  const mallory = await person(browser);
  const drifter = await person(browser);

  await test.step('create, claim PRO, post', async () => {
    await alice.page.locator('#topicInput').fill(topic);
    await alice.page.locator('#createBtn').click();
    await fillModal(alice.page, 'Alice', 'pro', 'alice-pw');
    await expect(alice.page.locator('#headerTopic')).toHaveText(topic);
    // Everyone arrives as audience: the hint, not a composer.
    await expect(alice.page.locator('#debateHint')).toBeVisible();
    await alice.page.locator('#proBtn').click();
    // The composer appears the instant the seat ack lands.
    await expect(alice.page.locator('#debateComposer')).toBeVisible();
    await expect(alice.page.locator('#proWho')).toHaveText('Alice');
    await expect(alice.page.locator('#proHandle')).toHaveText('@alice-pw');
    await alice.page.locator('#debateInput').fill('Opening for the motion.');
    await alice.page.locator('#debateInput').press('Enter');
    await expect(bubble(alice.page, 'Opening for the motion.')).toHaveClass(/pro/);
  });

  await test.step('the lobby updates live as seats fill', async () => {
    const card = bob.page.locator('#roomList .room-card', { hasText: topic });
    await expect(card).toContainText('PRO · Alice');
    await expect(card).toContainText('CON open');
  });

  await test.step('closing a tab frees the seat it held', async () => {
    await joinFromLobby(drifter.page, topic, 'Drifter', 'con');
    await drifter.page.locator('#conBtn').click();
    await expect(alice.page.locator('#conWho')).toHaveText('Drifter');
    await drifter.ctx.close();
    await expect(alice.page.locator('#conWho')).toHaveText('Open seat');
  });

  await test.step('a second person claims CON and replies', async () => {
    await joinFromLobby(bob.page, topic, 'Bob', 'con');
    // History is replayed to a late joiner.
    await expect(bubble(bob.page, 'Opening for the motion.')).toBeVisible();
    await bob.page.locator('#conBtn').click();
    await expect(bob.page.locator('#debateComposer')).toBeVisible();
    await bob.page.locator('#debateInput').fill('Opening against it.');
    await bob.page.locator('#debateSend').click();
    await expect(bubble(alice.page, 'Opening against it.')).toHaveClass(/con/);
  });

  await test.step('the audience view: no composer, sidebar chat, the gauge', async () => {
    await joinFromLobby(carol.page, topic, 'Carol', 'undecided');
    await expect(carol.page.locator('#debateComposer')).toBeHidden();
    await expect(carol.page.locator('#debateHint')).toBeVisible();
    await expect(carol.page.locator('#leanPro')).toBeVisible();
    await carol.page.locator('#audInput').fill('Both of you are wrong.');
    await carol.page.locator('#audInput').press('Enter');
    // Cross-tab delivery of an audience message.
    await expect(alice.page.locator('#audMsgs .chatline', { hasText: 'Both of you are wrong.' })).toBeVisible();
    await expect(bob.page.locator('#audMsgs .chatline', { hasText: 'Both of you are wrong.' })).toBeVisible();
    await carol.page.locator('#leanCon').click();
    await expect(alice.page.locator('#gaugeRead')).toContainText('con');
  });

  await test.step('the typing indicator crosses tabs', async () => {
    await bob.page.locator('#debateInput').pressSequentially('thinking', { delay: 20 });
    await expect(alice.page.locator('#typing')).toContainText('Bob (CON) is typing');
    await bob.page.locator('#debateInput').fill('');
  });

  await test.step('markup in a name and a message renders as inert text', async () => {
    const evilName = '<img src=x onerror=a()>';
    await joinFromLobby(mallory.page, topic, evilName, 'undecided');
    await mallory.page.locator('#audInput').fill('<script>window.__pwned=1</script><b>bold</b>');
    await mallory.page.locator('#audInput').press('Enter');
    const line = alice.page.locator('#audMsgs .chatline', { hasText: '<script>' });
    await expect(line).toBeVisible();
    await expect(line).toContainText(evilName);
    for (const p of [alice.page, bob.page, carol.page]) {
      // Zero injected nodes, and nothing ran.
      expect(await p.locator('#audMsgs img, #audMsgs script, #audMsgs b, #debateMsgs img').count()).toBe(0);
      expect(await p.evaluate(() => window.__pwned)).toBeUndefined();
    }
  });

  await test.step('the floor bar, and yielding it', async () => {
    await expect(alice.page.locator('#startRow')).toBeVisible();
    await expect(carol.page.locator('#startRow')).toBeHidden();
    await alice.page.locator('#startBtn').click();
    const bar = alice.page.locator('#floorBar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveClass(/pro/);
    await expect(alice.page.locator('#floorHolder')).toHaveText('You have the floor');
    await expect(alice.page.locator('#floorRound')).toContainText('Opening');
    await expect(bob.page.locator('#debateInput')).toBeDisabled();
    await expect(bob.page.locator('#debateInput')).toHaveAttribute('placeholder', 'PRO has the floor.');
    await alice.page.locator('#debateInput').fill('On the clock now.');
    await alice.page.locator('#debateInput').press('Enter');
    await expect(bubble(bob.page, 'On the clock now.')).toBeVisible();
    await alice.page.locator('#yieldBtn').click();
    await expect(bob.page.locator('#floorHolder')).toHaveText('You have the floor');
    await expect(bob.page.locator('#floorBar')).toHaveClass(/con/);
    await expect(alice.page.locator('#debateInput')).toBeDisabled();
    await expect(bob.page.locator('#debateInput')).toBeEnabled();
    await bob.page.locator('#debateInput').fill('And my answer.');
    await bob.page.locator('#debateInput').press('Enter');
    await expect(bubble(carol.page, 'And my answer.')).toBeVisible();
  });

  await test.step('calling it is two clicks, and the result card replaces the composers', async () => {
    await alice.page.locator('#callIt').click();
    await expect(alice.page.locator('#callIt')).toHaveText('Sure? End it');
    await alice.page.locator('#callIt').click();
    for (const p of [alice.page, bob.page, carol.page]) {
      await expect(p.locator('#resultCard')).toBeVisible();
      await expect(p.locator('#debateComposer')).toBeHidden();
      await expect(p.locator('#audInput')).toBeDisabled();
    }
    // Carol went undecided to CON: one point of swing to CON.
    await expect(carol.page.locator('#resultSwing .n')).toHaveText('-1');
    await expect(carol.page.locator('#resultLine')).toContainText('Bob moved the room by 1');
    // Rematch is for the two who argued, and nobody else.
    await expect(alice.page.locator('#resultRematch')).toBeVisible();
    await expect(bob.page.locator('#resultRematch')).toBeVisible();
    await expect(carol.page.locator('#resultRematch')).toBeHidden();
    await expect(carol.page.locator('#resultCopy')).toBeVisible();
  });

  await test.step('the permalink renders the record with no script', async () => {
    const href = await carol.page.locator('#resultOpen').getAttribute('href');
    expect(href).toMatch(/^\/d\/[0-9a-f]{6}$/);
    const res = await carol.page.goto(href);
    expect(res.headers()['content-security-policy']).toContain("script-src 'none'");
    await expect(carol.page.locator('h1.motion')).toHaveText(topic);
    await expect(carol.page.locator('.swing .n')).toHaveText('-1');
    await expect(carol.page.locator('.arg.pro', { hasText: 'On the clock now.' })).toBeVisible();
    expect(await carol.page.locator('.floor img, .floor script').count()).toBe(0);
  });

  await test.step('a rematch swaps the seats in both tabs', async () => {
    await alice.page.locator('#resultRematch').click();
    await expect(alice.page.locator('#resultCard')).toBeHidden();
    await expect(alice.page.locator('#conWho')).toHaveText('Alice');
    await expect(bob.page.locator('#proWho')).toHaveText('Bob');
    await expect(bob.page.locator('#debateComposer')).toBeVisible();
  });

  for (const p of [alice, bob, carol, mallory]) await p.ctx.close();
});

test('the archive and a debater page render without script', async ({ page }) => {
  const res = await page.goto('/archive');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-security-policy']).toContain("script-src 'none'");
  await expect(page.locator('h1')).toContainText('record');
  await page.locator('input[name=q]').fill('Browsers should argue');
  await page.locator('form button').click();
  await expect(page).toHaveURL(/q=Browsers/);
  await expect(page.locator('.rec').first()).toContainText('Browsers should argue');

  const me = await page.goto('/u/alice-pw');
  expect(me.status()).toBe(200);
  expect(me.headers()['content-security-policy']).toContain("script-src 'none'");
  await expect(page.locator('h1')).toHaveText('@alice-pw');
  await expect(page.locator('.rec').first()).toContainText('lost');
  await expect(page.locator('.stat.total .v')).toHaveText('-1');
});

test('a challenge posted in one tab and taken in another seats both', async ({ browser }) => {
  const motion = `Board test ${Date.now() % 100000}`;
  const poster = await person(browser);
  const taker = await person(browser);
  await expect(poster.page.locator('#challengeList .board-empty')).toBeVisible();
  await poster.page.locator('#challengeInput').fill(motion);
  await poster.page.locator('#chCon').click();
  await poster.page.locator('#challengeBtn').click();
  // No name stored in this browser yet, so the name-only modal asks first.
  await expect(poster.page.locator('#stanceRow')).toBeHidden();
  await poster.page.locator('#nameInput').fill('Poster');
  await poster.page.locator('#modalJoin').click();
  const card = taker.page.locator('#challengeList .challenge-card', { hasText: motion });
  await expect(card).toContainText('wants a PRO');
  await expect(poster.page.locator('#challengeList .challenge-card', { hasText: motion }).getByRole('button'))
    .toHaveText('Withdraw');
  await card.getByRole('button', { name: 'Take PRO' }).click();
  await taker.page.locator('#nameInput').fill('Taker');
  await taker.page.locator('#modalJoin').click();
  for (const p of [poster.page, taker.page]) {
    await expect(p.locator('#room')).toHaveClass(/active/);
    await expect(p.locator('#proWho')).toHaveText('Taker');
    await expect(p.locator('#conWho')).toHaveText('Poster');
    await expect(p.locator('#debateComposer')).toBeVisible();
  }
  for (const p of [poster, taker]) await p.ctx.close();
});

// ---------------------------------------------------------------------------
// A phone, 390 pixels wide
// ---------------------------------------------------------------------------
// The body clips horizontal overflow, so "does the page scroll sideways" would
// pass even with a button half off the screen. Each control is measured
// instead: fully inside the viewport, and actually usable.

async function onScreen(page, selector) {
  await expect(page.locator(selector)).toBeVisible();
  const box = await page.locator(selector).boundingBox();
  const vp = page.viewportSize();
  expect(box, `${selector} has a box`).not.toBeNull();
  expect(box.x, `${selector} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${selector} top edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${selector} right edge`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height, `${selector} bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
}

test('a phone at 390 pixels can debate, watch and read the result', async ({ browser }) => {
  const topic = `Phones should be enough ${Date.now() % 100000}`;
  const phone = await person(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desk = await person(browser);
  const p = phone.page;

  await p.locator('#topicInput').fill(topic);
  await p.locator('#createBtn').click();
  await onScreen(p, '#modalJoin');
  await fillModal(p, 'Alessandra Featherstone', 'pro');
  for (const sel of ['#leaveBtn', '#soundBtn', '#headerCount', '#tabStage', '#tabSide', '#proBtn', '#conBtn']) {
    await onScreen(p, sel);
  }
  await p.locator('#proBtn').click();
  for (const sel of ['#debateInput', '#debateSend', '#callIt', '#gauge']) await onScreen(p, sel);
  await p.locator('#debateInput').fill('Typed on a phone.');
  await p.locator('#debateSend').click();
  await expect(bubble(p, 'Typed on a phone.')).toBeVisible();

  await joinFromLobby(desk.page, topic, 'Desk', 'con');
  await desk.page.locator('#conBtn').click();
  await desk.page.locator('#debateInput').fill('Typed on a desk.');
  await desk.page.locator('#debateInput').press('Enter');

  await onScreen(p, '#startBtn');
  await p.locator('#startBtn').click();
  for (const sel of ['#floorBar', '#floorClock', '#yieldBtn']) await onScreen(p, sel);
  await p.locator('#yieldBtn').click();
  await expect(desk.page.locator('#floorHolder')).toHaveText('You have the floor');

  // The audience panel is a tab away on a phone, and works when opened.
  await p.locator('#tabSide').click();
  await expect(p.locator('#audInput')).toBeVisible();
  await onScreen(p, '#audInput');
  await onScreen(p, '#audSend');
  await p.locator('#audInput').fill('Sidebar from a phone.');
  await p.locator('#audSend').click();
  await expect(desk.page.locator('#audMsgs .chatline', { hasText: 'Sidebar from a phone.' })).toBeVisible();
  await p.locator('#tabStage').click();

  await p.locator('#callIt').click();
  await p.locator('#callIt').click();
  await expect(p.locator('#resultCard')).toBeVisible();
  for (const sel of ['#resultSwing', '#resultLine', '#resultOpen', '#resultCopy', '#resultRematch']) {
    await onScreen(p, sel);
  }

  for (const x of [phone, desk]) await x.ctx.close();
});

// ---------------------------------------------------------------------------
// The keyboard alone
// ---------------------------------------------------------------------------

async function tabTo(page, selector, limit = 60) {
  for (let i = 0; i < limit; i++) {
    if (await page.evaluate((sel) => document.activeElement && document.activeElement.matches(sel), selector)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`could not reach ${selector} with Tab`);
}

test('join, claim, post, yield and call it with the keyboard alone', async ({ browser }) => {
  const topic = `Keyboards are enough ${Date.now() % 100000}`;
  const kb = await person(browser);
  const other = await person(browser);
  const watcher = await person(browser);
  const k = kb.page;

  await tabTo(k, '#topicInput');
  await k.keyboard.type(topic);
  await k.keyboard.press('Enter');
  // The modal takes focus, and Enter in the name box joins.
  await expect(k.locator('#nameInput')).toBeFocused();
  await k.keyboard.type('Kay');
  await k.keyboard.press('Enter');
  await expect(k.locator('#room')).toHaveClass(/active/);

  // A visible ring on whatever has focus, in the flyer's own dashed cut line.
  await tabTo(k, '#proBtn');
  const ring = await k.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(ring).toBe('dashed');
  await k.keyboard.press('Enter');
  // Sitting down puts the cursor where the speaking happens.
  await expect(k.locator('#debateInput')).toBeFocused();
  await k.keyboard.type('Every word of this was typed.');
  await k.keyboard.press('Enter');
  await expect(bubble(k, 'Every word of this was typed.')).toBeVisible();

  await joinFromLobby(other.page, topic, 'Mouse', 'con');
  await other.page.locator('#conBtn').click();
  await other.page.locator('#debateInput').fill('I used a mouse.');
  await other.page.locator('#debateInput').press('Enter');

  // Escape closes the join modal and gives focus back to what opened it.
  const join = watcher.page.locator('#roomList .room-card', { hasText: topic }).getByRole('button', { name: 'Join' });
  await join.focus();
  await watcher.page.keyboard.press('Enter');
  await expect(watcher.page.locator('#modal')).toHaveClass(/active/);
  await watcher.page.keyboard.press('Escape');
  await expect(watcher.page.locator('#modal')).not.toHaveClass(/active/);
  await expect(join).toBeFocused();
  await watcher.page.keyboard.press('Enter');
  await watcher.page.keyboard.type('Watcher');
  await watcher.page.keyboard.press('Enter');
  await expect(k.locator('#headerCount')).toHaveText('1 watching');

  await tabTo(k, '#startBtn');
  await k.keyboard.press('Enter');
  // Turn changes are read out: assertively to the debater whose turn it is.
  await expect(k.locator('#announcer')).toHaveText('Opening. You have the floor.');
  await expect(watcher.page.locator('#announcer')).toHaveText('Opening. PRO has the floor.');
  await tabTo(k, '#debateInput');
  await k.keyboard.type('On the clock, by keyboard.');
  await k.keyboard.press('Enter');
  await expect(bubble(other.page, 'On the clock, by keyboard.')).toBeVisible();
  await tabTo(k, '#yieldBtn');
  await k.keyboard.press('Enter');
  await expect(other.page.locator('#announcer')).toHaveText('Opening. You have the floor.');

  // The stage and the sidebar are logs a screen reader follows.
  await expect(k.locator('#debateMsgs')).toHaveAttribute('role', 'log');
  await expect(k.locator('#audMsgs')).toHaveAttribute('role', 'log');

  await tabTo(k, '#callIt');
  await k.keyboard.press('Enter');
  await expect(k.locator('#callIt')).toHaveText('Sure? End it');
  await k.keyboard.press('Enter');
  await expect(k.locator('#resultCard')).toBeVisible();
  await expect(watcher.page.locator('#resultCard')).toBeVisible();

  // The count in the header is live: the watcher leaving takes it down.
  await watcher.ctx.close();
  await expect(k.locator('#headerCount')).toHaveText('0 watching');

  for (const x of [kb, other]) await x.ctx.close();
});

test('the sound toggle is remembered and the tone needs no file', async ({ browser }) => {
  const a = await person(browser);
  const topic = `Quiet please ${Date.now() % 100000}`;
  await a.page.locator('#topicInput').fill(topic);
  await a.page.locator('#createBtn').click();
  await fillModal(a.page, 'Hush', 'pro');
  await expect(a.page.locator('#soundBtn')).toHaveAttribute('aria-pressed', 'true');
  await a.page.locator('#soundBtn').click();
  await expect(a.page.locator('#soundBtn')).toHaveAttribute('aria-pressed', 'false');
  expect(await a.page.evaluate(() => localStorage.getItem('debateSound'))).toBe('off');
  await a.page.reload();
  await a.page.locator('#roomList .room-card', { hasText: topic }).getByRole('button', { name: 'Join' }).click();
  await fillModal(a.page, 'Hush', 'pro');
  await expect(a.page.locator('#soundBtn')).toHaveAttribute('aria-pressed', 'false');
  // The tone is synthesized, so the page makes no media request for one.
  const media = [];
  a.page.on('request', (req) => { if (/\.(mp3|wav|ogg|m4a)$/i.test(req.url())) media.push(req.url()); });
  await a.page.locator('#soundBtn').click();
  expect(media).toEqual([]);
  await a.ctx.close();
});
