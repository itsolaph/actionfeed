#!/usr/bin/env bash
# Installs Solidity dependencies (base-std, MIT; it vendors forge-std) into contracts/lib without git submodules.
set -euo pipefail
cd "$(dirname "$0")"
[ -d lib/base-std ] || forge install --no-git base/base-std
