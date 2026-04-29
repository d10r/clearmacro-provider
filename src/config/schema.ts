import { Type, type Static } from "@sinclair/typebox";

const addressPattern = "^0x[0-9a-fA-F]{40}$";

export const RegistrySchema = Type.Object({
  version: Type.Literal(1),
  chains: Type.Array(
    Type.Object({
      chainId: Type.Integer({ minimum: 1 }),
      name: Type.String({ minLength: 1 }),
      enabled: Type.Boolean(),
      ozRelayerId: Type.String({ minLength: 1 }),
      rpcs: Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1 }),
          url: Type.String({ minLength: 1 }),
        }),
        { minItems: 1 },
      ),
      confirmations: Type.Optional(Type.Integer({ minimum: 1 })),
      superfluidHost: Type.String({ pattern: addressPattern }),
      forwarders: Type.Object({
        clearMacroV1: Type.String({ pattern: addressPattern }),
        permit2ClearMacroV1: Type.String({ pattern: addressPattern }),
      }),
      providers: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      macros: Type.Array(
        Type.Object({
          address: Type.String({ pattern: addressPattern }),
          name: Type.String({ minLength: 1 }),
          enabled: Type.Boolean(),
          supportedKinds: Type.Array(Type.Union([Type.Literal("clearMacroV1"), Type.Literal("permit2ClearMacroV1")])),
        }),
        { minItems: 1 },
      ),
    }),
    { minItems: 1 },
  ),
  clients: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      enabled: Type.Boolean(),
      apiTokenHash: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      allowedChains: Type.Array(Type.Integer({ minimum: 1 })),
      allowedProviders: Type.Array(Type.String({ minLength: 1 })),
      allowedMacros: Type.Array(Type.String({ pattern: addressPattern })),
    }),
    { minItems: 1 },
  ),
});

export type Registry = Static<typeof RegistrySchema>;
export type RegistryChain = Registry["chains"][number];
export type RegistryMacro = RegistryChain["macros"][number];
export type RegistryClient = Registry["clients"][number];

