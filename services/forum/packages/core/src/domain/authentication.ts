export const AuthenticationMethodValues = ['password', 'webauthn', 'verification', 'internal'] as const;
export type AuthenticationMethod = (typeof AuthenticationMethodValues)[number];

export const WebAuthnCeremonyValues = ['registration', 'authentication'] as const;
export type WebAuthnCeremony = (typeof WebAuthnCeremonyValues)[number];

export interface WebAuthnCredential {
  id: string;
  identityId: string;
  name: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  updatedAt: string;
}
