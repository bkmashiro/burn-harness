import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Global user preferences that persist across all projects.
 * Stored at ~/.config/burn/preferences.yaml
 *
 * These are learned from user interactions and project patterns:
 * - Coding style preferences
 * - Preferred languages/frameworks
 * - Common instructions for all agents
 * - YOLO mode defaults
 */

export interface UserPreferences {
  // Coding style (injected into all agent prompts)
  codingStyle?: string;

  // Default focus areas for brainstorming
  defaultFocusAreas?: string[];

  // Instructions that apply to all projects
  globalInstructions?: string;

  // YOLO mode defaults
  yoloDefaults?: {
    workers?: number;
    budget?: number;
    seed?: number;
    focusAreas?: string[];
  };

  // Learned patterns from previous projects
  patterns?: {
    preferredLanguages?: string[];
    preferredFrameworks?: string[];
    avoidPatterns?: string[];
    codeConventions?: string[];
  };

  // Last updated timestamp
  updatedAt?: string;
}

const PREFS_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".config",
  "burn"
);
const PREFS_FILE = path.join(PREFS_DIR, "preferences.yaml");

export function loadUserPreferences(): UserPreferences {
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const content = fs.readFileSync(PREFS_FILE, "utf-8");
      return (YAML.parse(content) as UserPreferences) ?? {};
    }
  } catch {
    // Corrupted file — return empty
  }
  return {};
}

export function saveUserPreferences(prefs: UserPreferences): void {
  prefs.updatedAt = new Date().toISOString();
  fs.mkdirSync(PREFS_DIR, { recursive: true });
  fs.writeFileSync(PREFS_FILE, YAML.stringify(prefs), "utf-8");
}

export function mergePreferencesIntoPrompt(prefs: UserPreferences): string {
  const parts: string[] = [];

  if (prefs.globalInstructions) {
    parts.push(prefs.globalInstructions);
  }

  if (prefs.codingStyle) {
    parts.push(`Coding style preferences:\n${prefs.codingStyle}`);
  }

  if (prefs.patterns?.codeConventions?.length) {
    parts.push(`Code conventions:\n${prefs.patterns.codeConventions.map(c => `- ${c}`).join("\n")}`);
  }

  if (prefs.patterns?.avoidPatterns?.length) {
    parts.push(`Avoid these patterns:\n${prefs.patterns.avoidPatterns.map(p => `- ${p}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

export function getPreferencesPath(): string {
  return PREFS_FILE;
}
