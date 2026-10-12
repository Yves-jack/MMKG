/** 图谱 / 导图写权限：仅老师与助教（与 MMKG auth.UserRole 对齐） */

const STAFF_ROLES = new Set([
  "teacher",
  "teacherenrollment",
  "ta",
  "taenrollment",
  "teachingassistant",
  "teachingassistantenrollment",
]);

export function normalizeEnrollmentRole(role: string | null | undefined): string {
  return String(role || "").trim().toLowerCase();
}

export function isStaffEnrollmentRole(role: string | null | undefined): boolean {
  return STAFF_ROLES.has(normalizeEnrollmentRole(role));
}

/**
 * 从 kg_token 明文段窥探 role（仅用于前端 UI；写操作仍由后端验签鉴权）。
 * 格式与 mmkg_api.auth.verify_jxb_token 一致：base64url(payload|"|"|sig64)。
 */
export function peekKgTokenRole(kgToken: string | null | undefined): string | null {
  const token = String(kgToken || "").trim();
  if (!token) return null;
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (token.length % 4)) % 4);
    const binary = atob(padded);
    if (binary.length < 65 || binary.charCodeAt(binary.length - 65) !== 124) return null;
    const payload = JSON.parse(binary.slice(0, -65));
    const role = String(payload?.role || "").trim();
    return role || null;
  } catch {
    return null;
  }
}

/**
 * - 独立打开（无 embed）：本地调试可编辑
 * - 嵌入交学伴 / 视频检索：仅老师、助教可编辑
 */
export function canEditKnowledgeGraph(opts: {
  embedMode?: string | null;
  role?: string | null;
  kgToken?: string | null;
}): boolean {
  const embed = String(opts.embedMode || "").trim();
  if (!embed) return true;
  const role = opts.role || peekKgTokenRole(opts.kgToken);
  return isStaffEnrollmentRole(role);
}
