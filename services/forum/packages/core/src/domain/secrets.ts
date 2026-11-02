export interface SecretMetadata {
  id: string;
  ownerIdentityId: string;
  name: string;
  tags: string[];
  expiresAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SecretRepository {
  list(ownerIdentityId?: string): SecretMetadata[];
  get(id: string, ownerIdentityId?: string): SecretMetadata | null;
  create(input: Omit<SecretMetadata, 'createdAt' | 'updatedAt'>): SecretMetadata;
  update(id: string, ownerIdentityId: string, input: Pick<SecretMetadata, 'name' | 'tags' | 'expiresAt' | 'enabled'>): SecretMetadata | null;
  delete(id: string, ownerIdentityId?: string): boolean;
}

export interface SecretBroker {
  putSecret(id: string, input: { value: string; name: string; tags: string[]; expiresAt: string | null; enabled: boolean }): Promise<void>;
  disableSecret(id: string): Promise<void>;
  deleteSecret(id: string): Promise<void>;
}
