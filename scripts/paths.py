"""Shared source-tree paths; all build tools honor CARGO_TARGET_DIR."""
import os
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TARGET_DIR = Path(os.environ.get('CARGO_TARGET_DIR', PROJECT_ROOT / 'target')).resolve()
