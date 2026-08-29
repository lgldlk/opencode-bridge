"use strict";

const crypto = require("node:crypto");

function requestToken(req, alternateHeader = "x-api-key") {
  const authorization = req.headers.authorization || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  const alternate = req.headers[alternateHeader];
  return typeof alternate === "string" ? alternate : "";
}

function timingSafeEquals(value, expected) {
  if (!value || !expected || value.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function hasValidToken(req, expected, alternateHeader) {
  return timingSafeEquals(requestToken(req, alternateHeader), expected);
}

module.exports = { hasValidToken, requestToken, timingSafeEquals };
