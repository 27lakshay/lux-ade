#!/usr/bin/env node
import {serve} from '../../providers/claude/bridge.mjs';
import {fakeSdk} from '../../providers/claude/fake-sdk.mjs';
process.env.ADE_CLAUDE_BIN=process.execPath;
serve(fakeSdk(process.env.ADE_MOCK_CLAUDE_DIR));
