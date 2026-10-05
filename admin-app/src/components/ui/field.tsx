import type React from "react";

/**
 * ラベル + 入力の縦積み。
 *
 * id は任意。非フォームのグループ（空き枠など）は id を渡さず、React が htmlFor を
 * 省くので <label> が labelable でない要素を指さずに済む。
 *
 * 裏を返すと、フォームの入力に対して id を渡し忘れてもコンパイルは通る。ラベルが
 * 入力と結び付かないまま出るので、入力を伴う Field には必ず id を渡すこと。
 */
export function Field({
  id,
  label,
  children,
}: Readonly<{ id?: string; label: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
