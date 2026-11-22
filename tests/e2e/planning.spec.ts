/**
 * Critical journeys through the real UI on the demo build. The demo keeps its data in the page
 * and resets when you switch person, so each journey runs as one person; "Simulate teammates
 * voting" stands in for everyone else.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const PEOPLE = ['Max Moderator', 'Mia Member', 'Sam Developer', 'Lee Tester'];

/** A revealed result must show values and counts only, never who voted what. */
async function expectAnonymous(results: Locator): Promise<void> {
  await expect(results.getByText(/shown without names/)).toBeVisible();

  for (const name of PEOPLE) {
    await expect(results.getByText(name)).toHaveCount(0);
  }
}

async function openAs(page: Page, person: string): Promise<void> {
  await page.goto(`./?as=${person}`);
  await expect(page.getByRole('heading', { name: 'Planning Poker', level: 1 })).toBeVisible();
}

test('a moderator creates, publishes, overrides and completes a session, then finds its summary', async ({
  page,
}) => {
  await openAs(page, 'moderator');

  // Create a draft.
  await page.getByRole('button', { name: 'Planning Sessions' }).click();
  await page.getByRole('textbox', { name: 'Session name' }).fill('E2E sprint');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { name: 'E2E sprint Draft' })).toBeVisible();

  // Participants: two voters from the team.
  await page.getByRole('button', { name: 'Next: Participants' }).click();
  await page.getByRole('button', { name: 'Add as voter (Mia Member)' }).click();
  await page.getByRole('button', { name: 'Add as voter (Sam Developer)' }).click();
  await expect(page.getByText('2 voters · 1 observer')).toBeVisible();

  // Scoring defaults, then a ticket by key and the Jira destination field.
  await page.getByRole('button', { name: 'Next: Scoring and voting' }).click();
  await page.getByRole('button', { name: 'Next: Tickets' }).click();
  await page.getByRole('textbox', { name: 'Jira issue keys' }).fill('PP-7');
  await page.getByRole('button', { name: 'Add tickets' }).click();
  await expect(page.getByText('Dark mode for settings')).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Field', exact: true })
    .selectOption({ label: 'Story points (number)' });

  // Review and publish.
  await page.getByRole('button', { name: 'Next: Review and publish' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Ready to publish' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish session' }).click();
  await expect(page.getByRole('heading', { name: 'E2E sprint Active' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '0 of 2 voted' })).toBeVisible();

  // Teammates join and vote; the round reveals by itself, anonymously.
  await page.getByRole('button', { name: 'Simulate teammates voting' }).click();
  const results = page.getByRole('region', { name: /^Results/ });
  await expect(results).toBeVisible();
  await expectAnonymous(results);

  // Override with a reason; the estimate is saved to Jira.
  await page.getByRole('button', { name: /Set estimate with a reason/ }).click();
  const form = page.getByRole('form', { name: 'Set the estimate' });
  await form.getByRole('radio', { name: '8', exact: true }).check();
  await form.getByRole('textbox', { name: /Reason/ }).fill('Includes the migration');
  await form.getByRole('button', { name: 'Set estimate' }).click();
  await expect(page.getByText('Final estimate: 8')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Saving to Jira' })).toContainText('Saved');

  // Complete (two-step confirmation).
  await page.getByRole('button', { name: 'Complete session' }).click();
  await page.getByRole('button', { name: 'Yes, complete session' }).click();
  await expect(page.getByRole('heading', { name: 'E2E sprint Completed' })).toBeVisible();

  // History lists it; the summary shows the override and its reason.
  await page.getByRole('button', { name: 'Session History' }).click();
  const row = page.getByRole('row', { name: /^E2E sprint Platform Completed/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Summary of E2E sprint' }).click();
  await expect(page.getByRole('heading', { name: 'E2E sprint Completed' })).toBeVisible();
  const outcome = page.getByRole('row', { name: /PP-7 Dark mode for settings/ });
  await expect(outcome).toContainText('Override');
  await expect(outcome).toContainText('Reason: Includes the migration');
  await expect(outcome).toContainText('Saved to Jira');
});

test('an invited member joins, votes and sees an anonymous result', async ({ page }) => {
  await openAs(page, 'member');

  await page.getByRole('button', { name: 'Join Sprint 42 planning' }).click();
  await page.getByRole('button', { name: 'Open Sprint 42 planning' }).click();
  await expect(page.getByRole('heading', { name: 'Sprint 42 planning Active' })).toBeVisible();

  const cards = page.getByRole('list', { name: 'Your vote' });
  await cards.getByRole('button', { name: '5', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '1 of 2 voted' })).toBeVisible();

  await page.getByRole('button', { name: 'Simulate teammates voting' }).click();
  const results = page.getByRole('region', { name: /^Results/ });
  await expect(results).toBeVisible();
  await expectAnonymous(results);
  await expect(results.getByText(/2 votes/)).toBeVisible();
});

test('an observer follows the room but cannot vote', async ({ page }) => {
  await openAs(page, 'observer');

  await page.getByRole('button', { name: /^Join Sprint 42 planning/ }).click();
  await page.getByRole('button', { name: 'Open Sprint 42 planning' }).click();
  await expect(page.getByRole('heading', { name: 'Sprint 42 planning Active' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Your vote' })).toHaveCount(0);
});
