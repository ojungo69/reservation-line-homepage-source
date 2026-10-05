export function DetailRow({
  label,
  value,
  className,
}: Readonly<{
  label: string;
  value: string;
  className?: string;
}>) {
  return (
    <div className={className ?? "flex justify-between text-sm"}>
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
