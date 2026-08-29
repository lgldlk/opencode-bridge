#!/usr/bin/env node
"use strict";

const { createManagerApp, managerConfig, start } = require("./manager/app.ts");
const { loadConfig } = require("./manager/registry.ts");

if (require.main === module) start();

module.exports = { createManagerApp, loadConfig, managerConfig, start };
