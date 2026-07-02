/**
 * Format Nigerian Naira consistently across the UI.
 */
export function formatNaira(value) {
  return `₦${Number(value || 0).toLocaleString()}`;
}