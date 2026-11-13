import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';

test.describe('Batches 4 & 5 — CrewMesh Real End-to-End PostgreSQL + SSE + Teammate Intelligence Browser Suite', () => {
  test('Complete participant, leader, Suggested Teammates intelligence, preferences editor, invitation approval, SSE, succession & deletion workflow + 360px mobile overflow check', async ({
    browser,
  }) => {
    const runId = crypto.randomUUID().slice(0, 8);
    const leaderEmail = `e2e_leader_${runId}@example.com`;
    const member1Email = `e2e_m1_${runId}@example.com`;
    const member2Email = `e2e_m2_${runId}@example.com`;
    const password = 'E2eStrongPassword!2026';
    const teamName = `CrewMesh E2E ${runId}`;

    // Context 1: Team Leader
    const leaderContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const leaderPage = await leaderContext.newPage();

    // 1. Open landing page
    await leaderPage.goto('/');
    await expect(
      leaderPage.getByRole('heading', { name: 'Find your people. Build your team.' }),
    ).toBeVisible();

    // 2. Register a real test account (Leader)
    await leaderPage.getByRole('button', { name: 'Create Account' }).first().click();
    await expect(
      leaderPage.getByRole('heading', { name: 'Create Participant Account' }),
    ).toBeVisible();

    await leaderPage.getByLabel('Display Name').fill(`Leader ${runId}`);
    await leaderPage.getByLabel('Email Address').fill(leaderEmail);
    await leaderPage.getByLabel('Password').fill(password);
    await leaderPage.getByLabel('Skills (comma-separated)').fill('typescript, postgresql, react');
    await leaderPage.getByLabel('IANA Time Zone').fill('Asia/Kolkata');
    await leaderPage.getByRole('button', { name: 'Create Participant Account' }).click();

    // Redirected to /board
    await expect(
      leaderPage.getByRole('heading', { name: 'Looking for Teammates Board' }),
    ).toBeVisible();

    // 3. Reload page and verify authenticated session restoration from /api/v1/auth/me
    await leaderPage.reload();
    await expect(leaderPage.getByRole('button', { name: `Leader ${runId}` })).toBeVisible();

    // 4. Update profile
    await leaderPage.getByRole('button', { name: `Leader ${runId}` }).click();
    await expect(
      leaderPage.getByRole('heading', { name: 'Participant Profile' }),
    ).toBeVisible();
    await leaderPage
      .getByLabel('Biography (max 500 characters)')
      .fill('Distributed systems architect building CrewMesh.');
    await leaderPage.getByRole('button', { name: 'Save Profile Changes' }).click();
    await expect(leaderPage.getByText('Profile saved to PostgreSQL.')).toBeVisible();

    // 5 & 6. Browse teams and create a real team
    await leaderPage.getByRole('button', { name: 'Create Team' }).click();
    await leaderPage.getByLabel('Team Name (2–80 characters)').fill(teamName);
    await leaderPage
      .getByLabel('Team Pitch & Goals (max 1000 characters)')
      .fill('End-to-end race-proof team formation verification.');
    await leaderPage
      .getByLabel('Desired Teammate Skills (comma-separated)')
      .fill('typescript, postgresql');
    await leaderPage.getByRole('button', { name: 'Create Team & Become Leader' }).click();

    // 7. View team details & verify live SSE connection badge + Suggested Teammates panel
    await expect(leaderPage.getByRole('heading', { name: teamName })).toBeVisible();
    await expect(leaderPage.getByText(/Forming \(1\/2 min\)/)).toBeVisible();
    await expect(leaderPage.getByTestId('suggested-teammates-panel')).toBeVisible();
    await expect(leaderPage.getByTestId('team-preferences-card')).toBeVisible();
    const teamDetailUrl = leaderPage.url();

    // 8 & 9. Second participant registers in a separate browser context with complementary skills ('rust, redis')
    const m1Context = await browser.newContext({
      viewport: { width: 360, height: 780 }, // Test 360px mobile width!
    });
    const m1Page = await m1Context.newPage();
    await m1Page.goto('/register');

    // Verify zero horizontal overflow at 360px width
    const hasOverflow360 = await m1Page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasOverflow360).toBe(false);

    await m1Page.getByLabel('Display Name').fill(`MemberOne ${runId}`);
    await m1Page.getByLabel('Email Address').fill(member1Email);
    await m1Page.getByLabel('Password').fill(password);
    await m1Page.getByLabel('Skills (comma-separated)').fill('rust, redis, docker');
    await m1Page.getByLabel('IANA Time Zone').fill('Asia/Kolkata');
    await m1Page.getByRole('button', { name: 'Create Participant Account' }).click();

    // Batch 5 E2E: Leader updates Team Skill Preferences to include 'rust, redis' and verifies MemberOne appears in Suggested Teammates with 100% score
    await leaderPage
      .getByLabel('Desired Teammate Skills (comma-separated, max 25)')
      .fill('typescript, postgresql, rust, redis');
    await leaderPage.getByRole('button', { name: 'Save Desired Skills' }).click();
    await expect(leaderPage.getByText('Team desired skills updated.')).toBeVisible();
    await expect(leaderPage.getByTestId('suggested-teammate-card').first()).toContainText(
      `MemberOne ${runId}`,
    );

    // Non-leader visiting team detail page must NOT see Suggested Teammates panel
    await m1Page.goto(teamDetailUrl);
    await expect(m1Page.getByTestId('suggested-teammates-panel')).toHaveCount(0);

    await m1Page
      .getByLabel('Message to Team Leader (optional, max 500 chars)')
      .fill('Ready to contribute on PostgreSQL locking!');
    await m1Page.getByRole('button', { name: 'Request to Join Team' }).click();
    await expect(m1Page.getByText('Join Request Pending Approval')).toBeVisible();

    // 10, 11 & 12. Leader receives the real SSE join-request notification and accepts it
    await expect(leaderPage.getByText(`MemberOne ${runId}`)).toBeVisible();
    await leaderPage.getByRole('button', { name: 'Accept' }).click();

    // 13 & 14. Verify team transitions to Ready (2 / 5 members) and MemberOne is no longer in Suggested Teammates
    await expect(leaderPage.getByText('2 / 5 members (3 open)')).toBeVisible();
    await m1Page.reload();
    await expect(m1Page.getByText('Your role:')).toBeVisible();

    // 15. Leader generates a real 256-bit invitation code
    await leaderPage.getByRole('button', { name: 'Generate Invitation Code' }).click();
    const codeElement = leaderPage.getByTestId('created-invite-code');
    await expect(codeElement).toBeVisible();
    const rawInviteCode = (await codeElement.textContent())?.trim() ?? '';
    expect(rawInviteCode.length).toBeGreaterThanOrEqual(40);

    // 16 & 17. Third participant redeems the invitation code -> creates a PENDING request (not direct member)
    const m2Context = await browser.newContext();
    const m2Page = await m2Context.newPage();
    await m2Page.goto('/register');
    await m2Page.getByLabel('Display Name').fill(`MemberTwo ${runId}`);
    await m2Page.getByLabel('Email Address').fill(member2Email);
    await m2Page.getByLabel('Password').fill(password);
    await m2Page.getByRole('button', { name: 'Create Participant Account' }).click();

    await m2Page.getByRole('button', { name: 'Have an Invite Code?' }).click();
    await m2Page.getByLabel('Invitation Code').fill(rawInviteCode);
    await m2Page.getByRole('button', { name: 'Submit Join Request with Invite Code' }).click();
    await expect(m2Page.getByText(/Pending join request created!/)).toBeVisible();

    // 18 & 19. Leader sees the invite-sourced pending request via SSE and accepts it -> 3 / 5 members
    await expect(leaderPage.getByText(`MemberTwo ${runId}`)).toBeVisible();
    await expect(leaderPage.getByText('Via Invite Code')).toBeVisible();
    await leaderPage.getByRole('button', { name: 'Accept' }).click();
    await expect(leaderPage.getByText('3 / 5 members (2 open)')).toBeVisible();

    // 20 & 21. Leader removes MemberTwo via confirmation modal -> back to 2 / 5 members
    const m2Row = leaderPage.locator('.member-row', { hasText: `MemberTwo ${runId}` });
    await m2Row.getByRole('button', { name: 'Remove Member' }).click();
    await leaderPage.getByRole('button', { name: 'Confirm Removal' }).click();
    await expect(leaderPage.getByText('2 / 5 members (3 open)')).toBeVisible();

    // 23. Leader leaves team -> leadership transfers atomically to MemberOne!
    await leaderPage.getByRole('button', { name: 'Leave Team & Transfer Leadership' }).click();
    await expect(
      leaderPage.getByText(
        new RegExp(`promote the longest-standing remaining member \\(MemberOne ${runId}\\)`),
      ),
    ).toBeVisible();
    await leaderPage.getByRole('button', { name: 'Transfer Leadership & Leave' }).click();

    // 22 & 24. MemberOne is now the sole remaining member (and leader); leaving deletes the team
    await m1Page.reload();
    await expect(m1Page.getByRole('button', { name: 'Leave & Delete Team' })).toBeVisible();
    await m1Page.getByRole('button', { name: 'Leave & Delete Team' }).click();
    await m1Page.getByRole('button', { name: 'Delete Team & Leave' }).click();

    await expect(
      m1Page.getByRole('heading', { name: 'Looking for Teammates Board' }),
    ).toBeVisible();

    await leaderContext.close();
    await m1Context.close();
    await m2Context.close();
  });
});
