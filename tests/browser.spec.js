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
