export function Rating({ value }: { value: number }) {
  return (
    <span className="text-star shrink-0 tracking-wider" aria-label={`${value} out of 5`}>
      {"★".repeat(value)}
      <span className="opacity-25">{"★".repeat(5 - value)}</span>
    </span>
  );
}
