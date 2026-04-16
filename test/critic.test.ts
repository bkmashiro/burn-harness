import { describe, it, expect } from "vitest";
import { Critic, type CriticResult, type AutomatedCheckResult } from "../src/core/critic.js";

// Test the parseTestResults method by creating a critic with minimal config
// We can test the static-like behavior by instantiating with mock deps

describe("Critic", () => {
  describe("parseTestResults", () => {
    // We need access to the method — create a minimal Critic
    const mockConfig = {
      git: { baseBranch: "main" },
    } as any;
    const mockRegistry = {} as any;
    const critic = new Critic(mockConfig, mockRegistry);

    it("parses Jest/Vitest output", () => {
      const checks: AutomatedCheckResult[] = [
        {
          name: "tests",
          passed: true,
          output: "Tests: 15 passed, 2 failed, 1 skipped",
        },
      ];
      const result = critic.parseTestResults(checks);
      expect(result).toBeDefined();
      expect(result!.passed).toBe(15);
      expect(result!.failed).toBe(2);
      expect(result!.skipped).toBe(1);
    });

    it("parses pytest output", () => {
      const checks: AutomatedCheckResult[] = [
        {
          name: "pytest",
          passed: true,
          output: "10 passed, 3 failed, 2 skipped in 5.23s",
        },
      ];
      const result = critic.parseTestResults(checks);
      expect(result).toBeDefined();
      expect(result!.passed).toBe(10);
      expect(result!.failed).toBe(3);
      expect(result!.skipped).toBe(2);
    });

    it("returns undefined when no test checks", () => {
      const checks: AutomatedCheckResult[] = [
        { name: "typecheck", passed: true, output: "No errors" },
      ];
      expect(critic.parseTestResults(checks)).toBeUndefined();
    });

    it("returns zeros for unparseable output", () => {
      const checks: AutomatedCheckResult[] = [
        { name: "tests", passed: true, output: "Some random output" },
      ];
      const result = critic.parseTestResults(checks);
      expect(result).toBeDefined();
      expect(result!.passed).toBe(0);
      expect(result!.failed).toBe(0);
    });
  });
});
