/**
 * Mock Secrets Service for testing
 *
 * Provides in-memory secret storage without requiring vault configuration
 */
export class MockSecretsService {
  private secrets: Map<string, { key: string; value: string; source: string }> = new Map();

  constructor(prePopulatedSecrets?: Array<{ key: string; value: string; source: string }>) {
    if (prePopulatedSecrets) {
      for (const secret of prePopulatedSecrets) {
        this.secrets.set(secret.key, secret);
      }
    }
  }

  async getSecrets(userId: string): Promise<Array<{ key: string; value: string; source: string }>> {
    return Array.from(this.secrets.values());
  }

  async saveSecretToVault(
    userId: string,
    key: string,
    value: string,
    source: string
  ): Promise<void> {
    this.secrets.set(key, { key, value, source });
  }

  async deleteSecret(userId: string, key: string): Promise<void> {
    this.secrets.delete(key);
  }

  clearSecrets(): void {
    this.secrets.clear();
  }
}
