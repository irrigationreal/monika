/** Optional in-memory bearer storage for API keys and internal clients. Browser
 * authentication uses the server's opaque HttpOnly cookie and needs no storage. */
export interface TokenStorage {
  getAuthToken(): string | null;
  setAuthToken(token: string | null): void;
}

export class MemoryTokenStorage implements TokenStorage {
  private authToken: string | null = null;

  getAuthToken(): string | null {
    return this.authToken;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
  }
}
