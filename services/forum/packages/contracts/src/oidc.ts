import { z } from 'zod';

export const OidcEnabledResponseDtoSchema = z.object({
  enabled: z.boolean(),
  providerKey: z.string().nullable()
});
export type OidcEnabledResponseDto = z.infer<typeof OidcEnabledResponseDtoSchema>;

export const OidcExternalIdentityDtoSchema = z.object({
  id: z.string(),
  providerKey: z.string(),
  issuer: z.string(),
  subject: z.string(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable().optional()
});
export type OidcExternalIdentityDto = z.infer<typeof OidcExternalIdentityDtoSchema>;

export const OidcExternalIdentityListResponseDtoSchema = z.object({
  items: z.array(OidcExternalIdentityDtoSchema)
});
export type OidcExternalIdentityListResponseDto = z.infer<typeof OidcExternalIdentityListResponseDtoSchema>;

export const OidcUnlinkRequestSchema = z.object({
  externalIdentityId: z.string().min(1)
});
export type OidcUnlinkRequest = z.infer<typeof OidcUnlinkRequestSchema>;

export const OidcUnlinkResponseDtoSchema = z.object({
  ok: z.boolean()
});
export type OidcUnlinkResponseDto = z.infer<typeof OidcUnlinkResponseDtoSchema>;

export const OidcLinkRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  // returned by /auth/oidc/callback when needsLink=true
  issuer: z.string().optional(),
  providerKey: z.string().optional(),
  subject: z.string().min(1)
});
export type OidcLinkRequest = z.infer<typeof OidcLinkRequestSchema>;

export const OidcLinkResponseDtoSchema = z.object({
  token: z.string(),
  refreshToken: z.string().optional(),
  linked: z.boolean().optional()
});
export type OidcLinkResponseDto = z.infer<typeof OidcLinkResponseDtoSchema>;
