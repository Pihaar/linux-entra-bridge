/**
 * Shared utilities for the Linux Entra Bridge extension.
 * Imported by background.js, popup.js, and options.js.
 */

/** @type {typeof browser | typeof chrome} Cross-browser API compatibility. */
export const api = typeof browser !== "undefined" ? browser : chrome;

/**
 * Truncate a string to max characters (prevent information disclosure).
 * @param {string|*} msg - Message to truncate (non-strings are converted)
 * @param {number} [max=200] - Maximum character length
 * @returns {string} Truncated string
 */
export function truncateMsg(msg, max = 200) {
  if (typeof msg !== "string") return String(msg);
  return msg.length > max ? msg.slice(0, max) + "\u2026" : msg;
}

/**
 * Send a message to the background script via runtime.sendMessage.
 * Resolves with the response, or undefined on error (never rejects).
 * @param {Object} msg - Message to send
 * @returns {Promise<*>}
 */
export function sendMsg(msg) {
  return new Promise((resolve) => {
    try { api.runtime.sendMessage(msg, resolve); } catch { resolve(undefined); }
  });
}
