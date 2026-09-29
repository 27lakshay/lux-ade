# Domain documentation

ADE uses one shared glossary in [CONTEXT.md](../../CONTEXT.md). The same resource identities cross
the daemon, SDK, CLI and desktop; package-specific glossaries would duplicate them.

Before changing a term, ownership rule or contract, compare the glossary with the
[current architecture](../architecture.md), the relevant [v1 spec](../../.scratch/ade-v1/README.md)
and its decision register. The [architecture proposal](../proposed-architecture.md) explains
earlier choices and remaining scope; it is not evidence that behavior is implemented.

Keep CONTEXT.md to short definitions. Put ownership, lifecycle, wire shapes and migration rules
in architecture, contracts or the owning spec. Record a new product decision in the spec and
[decision register](../../.scratch/ade-v1/decisions.md), preserving feature IDs.
