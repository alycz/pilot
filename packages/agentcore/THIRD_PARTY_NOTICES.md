# AgentCore Runtime third-party notices

The Runtime uses the following pinned AWS SDK packages under the Apache License
2.0. Their package distributions include the complete license text, which must
remain in any redistributed Runtime image:

- `@aws-sdk/client-bedrock-agentcore` 3.1156.0 — Apache-2.0
- `@aws-sdk/client-dynamodb` 3.1156.0 — Apache-2.0

The container build installs these packages through the checked-in pnpm
lockfile. Do not prune package `LICENSE` files or this notice from a distributed
image.
