#!/usr/bin/env node
/** cowork CLI 可执行入口（node bin/cowork.mjs ... / npm bin）。 */
import { main } from '../src/cli.mjs'

const code = await main(process.argv.slice(2))
if (typeof code === 'number') process.exitCode = code
