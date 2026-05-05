import { Type, type Static } from "@sinclair/typebox";

const addressPattern = "^0x[0-9a-fA-F]{40}$";

export const RegistrySchema = Type.Object({
  version: Type.Literal(1),
  chains: Type.Array(
    Type.Object({
      chainId: Type.Integer({ minimum: 1 }),
      forwarderAddress: Type.String({ pattern: addressPattern }),
      rpcUrls: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      macroPolicy: Type.Union([
        Type.Object({
          mode: Type.Literal("allowlist"),
          allowedMacros: Type.Array(
            Type.Object({
              domain: Type.String({ minLength: 1 }),
              address: Type.String({ pattern: addressPattern }),
            }),
            { minItems: 1 },
          ),
        }, { additionalProperties: false }),
        Type.Object({
          mode: Type.Literal("open"),
        }, { additionalProperties: false }),
      ]),
      allowedMacros: Type.Optional(
        Type.Array(
          Type.Object({
            domain: Type.String({ minLength: 1 }),
            address: Type.String({ pattern: addressPattern }),
          }),
        ),
      ),
    }),
    { minItems: 1 },
  ),
});

export type Registry = Static<typeof RegistrySchema>;
export type RegistryChain = Registry["chains"][number];
export type RegistryAllowedMacro = Extract<RegistryChain["macroPolicy"], { mode: "allowlist" }>["allowedMacros"][number];
