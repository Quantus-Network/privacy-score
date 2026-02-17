#!/bin/bash
set -e

echo "=== TypeScript tests ==="
cd ts && npm test && cd ..

echo ""
echo "=== Dart tests ==="
cd dart && dart test && cd ..

echo ""
echo "All tests passed!"
