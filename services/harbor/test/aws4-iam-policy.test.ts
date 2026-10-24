import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
};

type Policy = {
  Version: string;
  Statement: Statement[];
};

const policy = JSON.parse(
  readFileSync(
    new URL("../scripts/aws/iam-harbor-worker.json", import.meta.url),
    "utf8",
  ),
) as Policy;

function statement(sid: string): Statement {
  const found = policy.Statement.find((candidate) => candidate.Sid === sid);
  if (!found) throw new Error(`missing IAM statement ${sid}`);
  return found;
}

function actions(value: Statement["Action"]): string[] {
  return Array.isArray(value) ? value : [value];
}

describe("AWS-4 harbor-worker IAM policy", () => {
  it("contains only the package's required actions", () => {
    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement.every(({ Effect }) => Effect === "Allow")).toBe(true);
    expect(new Set(policy.Statement.flatMap(({ Action }) => actions(Action)))).toEqual(
      new Set([
        "kms:Sign",
        "kms:GetPublicKey",
        "kms:CreateKey",
        "kms:CreateAlias",
        "kms:TagResource",
        "kms:ScheduleKeyDeletion",
        "kms:Decrypt",
        "bedrock:InvokeGuardrailChecks",
      ]),
    );
    expect(JSON.stringify(policy)).not.toMatch(/kms:\*|bedrock:\*/);
  });

  it("limits signing and public-key reads to tagged Ed25519 delegate keys", () => {
    expect(statement("SignWithTaggedDelegateKeys")).toMatchObject({
      Action: "kms:Sign",
      Resource: "arn:aws:kms:us-east-1:*:key/*",
      Condition: {
        StringLike: { "aws:ResourceTag/harbor:principal": "?*" },
        StringEquals: {
          "kms:KeySpec": "ECC_NIST_EDWARDS25519",
          "kms:KeyUsage": "SIGN_VERIFY",
          "kms:SigningAlgorithm": "ED25519_SHA_512",
          "kms:MessageType": "RAW",
        },
      },
    });
    expect(statement("ReadTaggedDelegatePublicKeys")).toMatchObject({
      Action: "kms:GetPublicKey",
      Resource: "arn:aws:kms:us-east-1:*:key/*",
      Condition: {
        StringLike: { "aws:ResourceTag/harbor:principal": "?*" },
        StringEquals: {
          "kms:KeySpec": "ECC_NIST_EDWARDS25519",
          "kms:KeyUsage": "SIGN_VERIFY",
        },
      },
    });
  });

  it("requires complete non-mainnet tags when creating or tagging keys", () => {
    for (const sid of ["CreateTaggedDelegateKeys", "TagExistingDelegateKeys"]) {
      const conditions = statement(sid).Condition;
      expect(conditions?.StringLike).toMatchObject({
        "aws:RequestTag/harbor:principal": "?*",
        "aws:RequestTag/harbor:owner": "?*",
      });
      expect(conditions?.StringEquals?.["aws:RequestTag/harbor:network"]).toEqual([
        "testnet",
        "devnet",
      ]);
      expect(conditions?.["ForAllValues:StringEquals"]?.["aws:TagKeys"]).toEqual([
        "harbor:principal",
        "harbor:owner",
        "harbor:network",
      ]);
    }
    expect(statement("CreateTaggedDelegateKeys")).toMatchObject({
      Action: "kms:CreateKey",
      Resource: "*",
      Condition: {
        StringEquals: {
          "kms:KeySpec": "ECC_NIST_EDWARDS25519",
          "kms:KeyUsage": "SIGN_VERIFY",
          "kms:KeyOrigin": "AWS_KMS",
        },
        Bool: { "kms:MultiRegion": "false" },
      },
    });
    expect(statement("TagExistingDelegateKeys").Condition?.StringLike).toMatchObject({
      "aws:ResourceTag/harbor:principal": "?*",
    });
  });

  it("limits aliases to Harbor test networks and tagged Ed25519 target keys", () => {
    expect(statement("CreateHarborDelegateAliases")).toMatchObject({
      Action: "kms:CreateAlias",
      Resource: "arn:aws:kms:us-east-1:*:alias/harbor/testnet/*",
    });
    expect(statement("CreateHarborDevnetDelegateAliases")).toMatchObject({
      Action: "kms:CreateAlias",
      Resource: "arn:aws:kms:us-east-1:*:alias/harbor/devnet/*",
    });
    expect(statement("AttachAliasesOnlyToTaggedDelegateKeys")).toMatchObject({
      Action: "kms:CreateAlias",
      Resource: "arn:aws:kms:us-east-1:*:key/*",
      Condition: {
        StringLike: { "aws:ResourceTag/harbor:principal": "?*" },
        StringEquals: {
          "kms:KeySpec": "ECC_NIST_EDWARDS25519",
          "kms:KeyUsage": "SIGN_VERIFY",
        },
      },
    });
  });

  it("allows only seven-day deletion and KEK-alias decryption", () => {
    expect(statement("ScheduleTaggedDelegateKeyDeletion")).toMatchObject({
      Action: "kms:ScheduleKeyDeletion",
      Resource: "arn:aws:kms:us-east-1:*:key/*",
      Condition: {
        StringLike: { "aws:ResourceTag/harbor:principal": "?*" },
        NumericEquals: { "kms:ScheduleKeyDeletionPendingWindowInDays": 7 },
      },
    });
    expect(statement("DecryptHarborKek")).toMatchObject({
      Action: "kms:Decrypt",
      Resource: "arn:aws:kms:us-east-1:*:key/*",
      Condition: {
        "ForAnyValue:StringEquals": {
          "kms:ResourceAliases": ["alias/harbor/kek"],
        },
      },
    });
  });

  it("uses wildcards only where the AWS actions have no resource type", () => {
    const wildcardStatements = policy.Statement.filter(({ Resource }) =>
      (Array.isArray(Resource) ? Resource : [Resource]).includes("*"),
    );
    expect(wildcardStatements.map(({ Sid }) => Sid).sort()).toEqual([
      "CreateTaggedDelegateKeys",
      "InvokeGuardrailChecks",
    ]);
    expect(statement("InvokeGuardrailChecks")).toMatchObject({
      Action: "bedrock:InvokeGuardrailChecks",
      Resource: "*",
    });
  });
});
