#!/usr/bin/env node
import {join} from 'node:path';
import {serve} from '../../providers/claude/bridge.mjs';
import {fakeSdk} from '../../providers/claude/fake-sdk.mjs';
process.env.ADE_CLAUDE_BIN=process.execPath;
// A managed-account launch clears the environment and sets CLAUDE_CONFIG_DIR,
// so its call log and release files live in that account's home.
const directory=process.env.ADE_MOCK_CLAUDE_DIR??(process.env.CLAUDE_CONFIG_DIR&&join(process.env.CLAUDE_CONFIG_DIR,'ade-mock'));
if(!directory)throw new Error('Set ADE_MOCK_CLAUDE_DIR or CLAUDE_CONFIG_DIR for the Claude mock');
serve(fakeSdk(directory));
