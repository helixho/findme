/** B direction: related perspectives, with room for revision. */
export function FindMeMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="20" cy="15" rx="10" ry="12" />
      <ellipse cx="15" cy="24" rx="10" ry="12" transform="rotate(-50 15 24)" />
      <ellipse cx="25" cy="24" rx="10" ry="12" transform="rotate(50 25 24)" />
    </svg>
  );
}
