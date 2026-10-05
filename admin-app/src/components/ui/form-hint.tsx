// 保存ボタンが disabled のとき、その理由をボタン付近にインライン表示する。
// disabled なボタンは押しても何も起きず理由が伝わらないため、判定元の
// 「最初に満たされていない条件」を1つだけ文言で示す。id は呼び出し側で
// ボタンの aria-describedby と対応付ける。
// role="status" のライブリージョンは常時マウントし (reason が無いときは空)、
// テキストの変化として読み上げさせる。条件付きマウントだと「テキスト入りで
// 出現」となり支援技術が変化を検知できず、aria-describedby の参照先も
// 消えたり現れたりしてしまう。
// reason には文言そのもの (string | null) か、下の InvalidReason をそのまま渡せる
// (message を表示)。呼び出し側での `?.message ?? null` の繰り返しを不要にする。
export function FormHint({ id, reason }: Readonly<{ id: string; reason: InvalidReason | string }>) {
  const message = typeof reason === "string" ? reason : (reason?.message ?? null);
  return (
    <p id={id} role="status" className="text-xs text-muted-foreground">
      {message}
    </p>
  );
}

// 「最初に満たされていない条件」とその対象フィールド。field: null は
// 単一のフォームコントロールに対応しない条件 (曜日グループ等) を表す。
export type InvalidReason<F extends string = string> = {
  field: F | null;
  message: string;
} | null;

// 現在の不成立条件が指すフィールドにだけ aria-invalid と、FormHint 本文を
// 読み上げさせる aria-describedby を付ける。ヒントは最初から可視なので
// aria-invalid も操作前から付ける (表示と読み上げの一致)。Input には
// aria-invalid の装飾クラスが無いため見た目は変わらない。
export function invalidFieldProps<F extends string>(
  invalid: InvalidReason<F>,
  field: F,
  hintId: string,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return invalid?.field === field
    ? { "aria-invalid": true, "aria-describedby": hintId }
    : {};
}
