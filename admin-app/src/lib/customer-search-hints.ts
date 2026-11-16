// Match only the backend's short-phone boundary; normalization stays server-side.
export function isShortPhoneQuery(query: string): boolean {
  const trimmed = query.trim();
  return trimmed !== "" && /^[+\d\s\-().]*$/.test(trimmed) && trimmed.replace(/\D/g, "").length < 3;
}

export function needsFullPhoneHint(query: string, isStaff: boolean): boolean {
  return isStaff && /^\d{3,10}$/.test(query.trim());
}
