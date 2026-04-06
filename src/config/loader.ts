import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { BurnConfigSchema, type BurnConfig } from "./schema.js";

export function loadConfig(projectRoot?: string, profile?: string): BurnConfig {
  const root = projectRoot ?? process.cwd();
  const layers: Record<string, unknown>[] = [];

  // Layer 1: User-level defaults
  const userConfig = path.join(
    process.env.HOME ?? "~",
    ".config",
    "burn",
    "config.yaml"
  );
  if (fs.existsSync(userConfig)) {
    layers.push(parseYaml(userConfig));
  }

  // Layer 2: Project config
  const projectConfig = path.join(root, "burn.yaml");
  if (fs.existsSync(projectConfig)) {
    layers.push(parseYaml(projectConfig));
  }

  // Layer 3: Local overrides
  const localConfig = path.join(root, "burn.local.yaml");
  if (fs.existsSync(localConfig)) {
    layers.push(parseYaml(localConfig));
  }

  // Merge layers
  const merged = deepMerge({}, ...layers);

  // Apply profile if specified
  if (profile && merged.profiles && typeof merged.profiles === "object") {
    const profileConfig = (merged.profiles as Record<string, unknown>)[profile];
    if (profileConfig && typeof profileConfig === "object") {
      deepMerge(merged, profileConfig as Record<string, unknown>);
    }
  }

  return BurnConfigSchema.parse(merged);
}

function parseYaml(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, "utf-8");
  return (YAML.parse(content) as Record<string, unknown>) ?? {};
}

function deepMerge(
  target: Record<string, unknown>,
  ...sources: Record<string, unknown>[]
): Record<string, unknown> {
  for (const source of sources) {
    for (const key of Object.keys(source)) {
      const sourceVal = source[key];
      const targetVal = target[key];
      if (
        sourceVal &&
        typeof sourceVal === "object" &&
        !Array.isArray(sourceVal) &&
        targetVal &&
        typeof targetVal === "object" &&
        !Array.isArray(targetVal)
      ) {
        target[key] = deepMerge(
          targetVal as Record<string, unknown>,
          sourceVal as Record<string, unknown>
        );
      } else {
        target[key] = sourceVal;
      }
    }
  }
  return target;
}
