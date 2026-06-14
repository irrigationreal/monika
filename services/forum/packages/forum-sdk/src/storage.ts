export interface TokenStorage {
  getAuthToken(): string | null;
  setAuthToken(token: string | null): void;
  getRefreshToken(): string | null;
  setRefreshToken(token: string | null): void;
}

export class MemoryTokenStorage implements TokenStorage {
  private authToken: string | null = null;
  private refreshToken: string | null = null;

  getAuthToken(): string | null {
    return this.authToken;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  getRefreshToken(): string | null {
    return this.refreshToken;
  }

  setRefreshToken(token: string | null): void {
    this.refreshToken = token;
  }
}

export class BrowserTokenStorage implements TokenStorage {
  private readonly authKey: string;
  private readonly refreshKey: string;
  private readonly fallback: MemoryTokenStorage;

  constructor(options?: { authKey?: string; refreshKey?: string }) {
    this.authKey = options?.authKey ?? 'cforum_auth_token';
    this.refreshKey = options?.refreshKey ?? 'cforum_refresh_token';
    this.fallback = new MemoryTokenStorage();
  }

  private hasStorage(): boolean {
    try {
      return typeof localStorage !== 'undefined';
    } catch {
      return false;
    }
  }

  getAuthToken(): string | null {
    if (this.hasStorage()) {
      return localStorage.getItem(this.authKey);
    }
    return this.fallback.getAuthToken();
  }

  setAuthToken(token: string | null): void {
    if (this.hasStorage()) {
      if (token) {
        localStorage.setItem(this.authKey, token);
      } else {
        localStorage.removeItem(this.authKey);
      }
      return;
    }
    this.fallback.setAuthToken(token);
  }

  getRefreshToken(): string | null {
    if (this.hasStorage()) {
      return localStorage.getItem(this.refreshKey);
    }
    return this.fallback.getRefreshToken();
  }

  setRefreshToken(token: string | null): void {
    if (this.hasStorage()) {
      if (token) {
        localStorage.setItem(this.refreshKey, token);
      } else {
        localStorage.removeItem(this.refreshKey);
      }
      return;
    }
    this.fallback.setRefreshToken(token);
  }
}
