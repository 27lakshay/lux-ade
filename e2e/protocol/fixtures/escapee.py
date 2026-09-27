#!/usr/bin/env python3
"""A descendant that is hard to stop: it ignores SIGTERM and SIGHUP and leaves
its process group with setsid. With a linger above 0 it also double-forks: the
intermediate parent stays `linger` seconds, long enough for the runtime's 1 s
tree observation to see the grandchild, then exits so the grandchild is
reparented to launchd. It writes its PID to <directory>/escaped.pid once it is
in place, then runs until it is killed.

Usage: escapee.py <directory> <linger seconds>
"""
import os
import signal
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
directory, linger = sys.argv[1], float(sys.argv[2])
os.makedirs(directory, exist_ok=True)
if linger > 0 and os.fork() > 0:
    time.sleep(linger)
    os._exit(0)
os.setsid()
while linger > 0 and os.getppid() != 1:
    time.sleep(0.02)
temporary = os.path.join(directory, "escaped.pid.tmp")
with open(temporary, "w") as handle:
    handle.write(str(os.getpid()))
os.rename(temporary, os.path.join(directory, "escaped.pid"))
while True:
    time.sleep(1)
