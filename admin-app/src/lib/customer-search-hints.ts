export function needsFullPhoneHint(query: string, isStaff: boolean): boolean {
  return isStaff && /^\d{3,10}$/.test(query.trim());
}
