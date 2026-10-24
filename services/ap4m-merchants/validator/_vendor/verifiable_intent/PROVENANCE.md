# verifiable-intent verification subset

- Upstream: `https://github.com/agent-intent/verifiable-intent`
- Version: `0.1.0`
- Commit: `1dc3d4189512041fb3d0f8348fe100dfe25ced91`
- License: Apache-2.0; see `LICENSE` in this directory.
- Vendored scope: verification only. Issuance, private-key, model, example,
  constraint-checker, and key-bound issuance modules are intentionally omitted.

The five implementation files below are byte-identical to the pinned commit:

| File | SHA-256 |
| --- | --- |
| `crypto/disclosure.py` | `d60bae87c632ad4e810729d56a36504f9e981ba3e1f4ff13815ccb0d78a32fc8` |
| `crypto/signing.py` | `a0ffdaf7e008ac46dda511cb7202347d4f3509547576d3ef08539f9066b76c12` |
| `crypto/sd_jwt.py` | `9cffee34421e7078bc1a4aa1fbb1f20ad1074dde4bfbd24ecf0c2c89b514c447` |
| `verification/integrity.py` | `9114cf260ee9263e64792abbf20f07ad083b5a412ef79c3071189d81ae3ffa5b` |
| `verification/chain.py` | `dd3341d1feb4a657ec53c1db0d627bcbc06477b94a1e669dffb1c616bec55512` |

The package `__init__.py` files are intentionally modified minimal shims so
importing the subset cannot expose omitted signing or issuance APIs.
