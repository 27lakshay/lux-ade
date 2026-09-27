#!/usr/bin/env python3
"""Waits in a provider's process group until <directory>/escape-now exists,
then becomes escapee.py with the given linger: a descendant that ignores TERM
and HUP, leaves the group and is reparented to launchd after `linger` seconds.
It exits without escaping once its parent, the provider, is gone.

Usage: escape_watcher.py <directory> <linger seconds>
"""
import os
import sys
import time

directory, linger = sys.argv[1], sys.argv[2]
parent = os.getppid()
trigger = os.path.join(directory, "escape-now")
while not os.path.exists(trigger):
    if os.getppid() != parent:
        sys.exit(0)
    time.sleep(0.02)
escapee = os.path.join(os.path.dirname(os.path.abspath(__file__)), "escapee.py")
os.execv(sys.executable, [sys.executable, escapee, directory, linger])
