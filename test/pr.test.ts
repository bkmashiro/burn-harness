import { describe, it, expect } from "vitest";
import { generatePRTitle, buildPRBody, type PRDetails } from "../src/git/pr.js";

describe("generatePRTitle", () => {
  it("generates title from task type and name", () => {
    const title = generatePRTitle("bug", "fix login redirect loop");
    expect(title).toBe("burn(bug): Login redirect loop");
  });

  it("strips common prefixes", () => {
    expect(generatePRTitle("feature", "Add user dashboard")).toBe("burn(feature): User dashboard");
    expect(generatePRTitle("bug", "Fix memory leak in parser")).toBe("burn(bug): Memory leak in parser");
    expect(generatePRTitle("refactor", "Refactor auth module")).toBe("burn(refactor): Auth module");
  });

  it("truncates long titles at word boundary", () => {
    const longTitle = "implement a comprehensive user authentication system with OAuth2 support and session management";
    const result = generatePRTitle("feature", longTitle);
    expect(result.length).toBeLessThanOrEqual(80); // burn(feature): + 60 max
    expect(result).toContain("...");
  });

  it("handles empty title gracefully", () => {
    const result = generatePRTitle("chore", "");
    expect(result).toBe("burn(chore): ");
  });
});

describe("buildPRBody", () => {
  const baseDetails: PRDetails = {
    title: "burn(bug): Fix login issue",
    taskId: "01ABCDEF12345",
    taskType: "bug",
    taskPriority: 2,
    description: "Fix the login redirect loop when session expires",
    cliName: "claude",
    diffStat: " src/auth.ts | 15 +++---\n 1 file changed, 9 insertions(+), 6 deletions(-)",
  };

  it("includes task info section", () => {
    const body = buildPRBody(baseDetails);
    expect(body).toContain("## Task");
    expect(body).toContain("`01ABCDEF12345`");
    expect(body).toContain("bug");
    expect(body).toContain("claude");
  });

  it("includes description", () => {
    const body = buildPRBody(baseDetails);
    expect(body).toContain("## Description");
    expect(body).toContain("login redirect loop");
  });

  it("includes diff stats", () => {
    const body = buildPRBody(baseDetails);
    expect(body).toContain("## Changes");
    expect(body).toContain("src/auth.ts");
  });

  it("includes cost info when provided", () => {
    const body = buildPRBody({ ...baseDetails, costUsd: 0.45, tokensUsed: 12000 });
    expect(body).toContain("$0.45");
    expect(body).toContain("12,000");
  });

  it("includes critic score when provided", () => {
    const body = buildPRBody({
      ...baseDetails,
      criticScore: 8,
      criticIssues: ["Minor: could add more tests"],
    });
    expect(body).toContain("## Critic Review");
    expect(body).toContain("Score: 8/10");
    expect(body).toContain("could add more tests");
  });

  it("shows correct emoji for critic scores", () => {
    expect(buildPRBody({ ...baseDetails, criticScore: 9 })).toContain("🟢");
    expect(buildPRBody({ ...baseDetails, criticScore: 6 })).toContain("🟡");
    expect(buildPRBody({ ...baseDetails, criticScore: 3 })).toContain("🔴");
  });

  it("includes test results when provided", () => {
    const body = buildPRBody({
      ...baseDetails,
      testResults: { passed: 42, failed: 0, skipped: 3 },
    });
    expect(body).toContain("42 passed");
    expect(body).toContain("0 failed");
    expect(body).toContain("3 skipped");
    expect(body).toContain("✅");
  });

  it("shows failure emoji when tests fail", () => {
    const body = buildPRBody({
      ...baseDetails,
      testResults: { passed: 40, failed: 2, skipped: 0 },
    });
    expect(body).toContain("❌");
  });

  it("includes typecheck status", () => {
    const body = buildPRBody({ ...baseDetails, typeCheckPassed: true });
    expect(body).toContain("No errors");

    const body2 = buildPRBody({ ...baseDetails, typeCheckPassed: false });
    expect(body2).toContain("Type errors detected");
  });

  it("includes burn-harness attribution", () => {
    const body = buildPRBody(baseDetails);
    expect(body).toContain("burn-harness");
  });
});
