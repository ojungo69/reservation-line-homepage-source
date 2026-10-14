export function CustomerSearchHints({
  showFullPhoneHint = false,
  truncated = false,
  className,
}: Readonly<{
  showFullPhoneHint?: boolean;
  truncated?: boolean;
  className?: string;
}>) {
  return (
    <>
      {showFullPhoneHint && <p className={className}>電話番号は全桁で入力してください</p>}
      {truncated && <p className={className}>20件を超えています。名前をもう少し入力してください</p>}
    </>
  );
}
