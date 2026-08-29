#!/usr/bin/env node
"use strict";

const { start } = require("./machine/app.ts");
const { selectModel } = require("./machine/models.ts");

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { selectModel, start };
