import type { CLIAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { AnthropicSDKAdapter } from "./anthropic-sdk.js";
import { CustomAdapter, type CustomAdapterConfig } from "./custom.js";
import type { BurnConfig } from "../config/schema.js";

const builtinFactories: Record<string, () => CLIAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  anthropic: () => new AnthropicSDKAdapter(),
};

export class AdapterRegistry {
  private adapters = new Map<string, CLIAdapter>();
  private rateLimitedUntil = new Map<string, number>();

  constructor(private config: BurnConfig) {
    for (const name of config.cli.preference) {
      // Built-in adapters
      const factory = builtinFactories[name];
      if (factory) {
        this.adapters.set(name, factory());
        continue;
      }

      // Custom adapter — check if there's a custom config
      const customConfig = (config.cli as Record<string, unknown>)[name];
      if (customConfig && typeof customConfig === "object" && "command" in customConfig) {
        this.adapters.set(
          name,
          new CustomAdapter(customConfig as CustomAdapterConfig)
        );
      }
    }
  }

  async selectAdapter(_taskType?: string): Promise<CLIAdapter | null> {
    const now = Date.now();

    for (const name of this.config.cli.preference) {
      const adapter = this.adapters.get(name);
      if (!adapter) continue;

      // Skip if rate-limited
      const limitUntil = this.rateLimitedUntil.get(name) ?? 0;
      if (now < limitUntil) continue;

      // Check availability
      if (!(await adapter.isAvailable())) continue;

      return adapter;
    }

    return null;
  }

  markRateLimited(adapterName: string, durationMs: number): void {
    this.rateLimitedUntil.set(adapterName, Date.now() + durationMs);
  }

  isRateLimited(adapterName: string): boolean {
    const limitUntil = this.rateLimitedUntil.get(adapterName) ?? 0;
    return Date.now() < limitUntil;
  }

  getAdapter(name: string): CLIAdapter | undefined {
    return this.adapters.get(name);
  }

  listAdapters(): string[] {
    return [...this.adapters.keys()];
  }
}
