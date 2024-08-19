<div align="center">

# LSIF Tools

CLI tool for interacting with a [LSIF](https://microsoft.github.io/language-server-protocol/specifications/lsif/0.4.0/specification/) index

</div>

## Install

TODO

## Generating an index

The easiest way to generate an index is with sourcegraphs scip tooling. You can see a fill list of indexers [here](https://github.com/sourcegraph/scip?tab=readme-ov-file#tools-using-scip). Youi will need to install an indexer and the `scip` cli tool for converting your index to lsif

```bash
# Run the indexer
scip-typescript index

# Convert your index
scip convert
```

This will give you a `dump.lsif` that you can feed in to this tool

## Usage

Right now this is still early days, there is only one command `unused-definitions`. This will find all of the definitions in an index that has no references, in other words dead code.

```bash
lsif-tools unused-definitions \
    -d ~/path/to/dump.lsif \
    -f ~/path/to/file-one.ts ~/path/to/file-two.ts
```

