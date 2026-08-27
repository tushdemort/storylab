import { expect, test } from "@playwright/test";

const config = {
  id: "00000000-0000-4000-8000-000000000010",
  version: 1,
  consentMarkdown: "## Study consent\n\nRead this study information.",
  keystrokeDisclosure: "Chat and story typing, including deleted drafts, will be recorded.",
  attentionPrompt: "Complete this sentence.",
  instructionMarkdown: "Create one story together.",
  ideationInstructionMarkdown: "Develop ideas privately.",
  ideationPrompt: "Draft possible story ideas.",
  discussionInstructionMarkdown: "Discuss ideas with your partner.",
  discussionPrompt: "Choose a direction together.",
  outlineInstructionMarkdown: "Create a shared outline.",
  outlinePrompt: "Plan the beginning, middle, and ending.",
  writingInstructionMarkdown: "Write and approve the final story.",
  writingPrompt: "Write the complete final story.",
  waitSeconds: 300,
  chatSeconds: 1200,
  ideationSeconds: 120,
  discussionSeconds: 120,
  outlineSeconds: 120,
  writingSeconds: 120,
  reconnectSeconds: 120,
  quizQuestions: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { configurable: true, get: () => true });
  });
  await page.route("**/api/participant/state", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ error: "Participant session required." }),
  }));
  await page.route("**/api/study", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ config }),
  }));
});

test("shows consent, disclosure, and participant ID entry", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Create something together/i })).toBeVisible();
  await expect(page.getByText(/deleted drafts/i)).toBeVisible();
  await expect(page.getByLabel("Participant ID")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});
