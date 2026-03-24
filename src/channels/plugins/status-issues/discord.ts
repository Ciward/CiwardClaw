// Shim: re-exports from extension.
// Keep this pointed at the narrow export module so importing this shim
// does not pull the full status-issues implementation graph eagerly.
export * from "../../../../extensions/discord/src/status-issues.export.js";
