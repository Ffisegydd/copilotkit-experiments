export function Rating({ value }: { value: number }) {
  return (
    <span className="rating" aria-label={`${value} out of 5`}>
      {"★".repeat(value)}
      <span className="dim">{"★".repeat(5 - value)}</span>
    </span>
  );
}
