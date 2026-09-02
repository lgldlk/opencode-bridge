"use strict";

const crypto = require("node:crypto");
import type { IncomingMessage } from "node:http";

function requestToken(req: IncomingMessage, alternateHeader = "x-api-key"): string {
  const authorization = req.headers.authorization || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  const alternate = req.headers[alternateHeader];
  return typeof alternate === "string" ? alternate : "";
}

function timingSafeEquals(value: string, expected: string): boolean {
  if (!value || !expected || value.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function hasValidToken(req: IncomingMessage, expected: string, alternateHeader?: string): boolean {
  return timingSafeEquals(requestToken(req, alternateHeader), expected);
}

module.exports = { hasValidToken, requestToken, timingSafeEquals };
