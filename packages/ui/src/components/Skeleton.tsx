export function SkeletonRow() {
  return (
    <tr className="animate-pulse font-mono">
      <td className="p-2.5">
        <div className="h-4 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-32" />
      </td>
      <td className="p-2.5">
        <div className="h-4 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-24" />
      </td>
      <td className="p-2.5">
        <div className="h-4 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-16" />
      </td>
      <td className="p-2.5">
        <div className="h-4 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-16" />
      </td>
      <td className="p-2.5">
        <div className="h-4 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-20" />
      </td>
      <td className="p-2.5">
        <div className="h-4 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-12" />
      </td>
      <td className="p-2.5">
        <div className="h-4 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-28" />
      </td>
    </tr>
  );
}

export function RunListSkeleton() {
  return (
    <tbody data-testid="skeleton-run-list" className="divide-y divide-[var(--border-hairline)]">
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
    </tbody>
  );
}

export function RunDetailSkeleton() {
  return (
    <div
      data-testid="skeleton-run-detail"
      className="flex flex-col gap-4 font-mono text-xs animate-pulse"
    >
      <div className="h-10 bg-[var(--bg-panel)] border border-[var(--border-hairline)] w-full" />
      <div className="h-28 bg-[var(--bg-panel)] border border-[var(--border-hairline)] w-full" />
      <div className="h-60 bg-[var(--bg-subtle)] border border-[var(--border-hairline)] w-full" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-64 bg-[var(--bg-panel)] border border-[var(--border-hairline)]" />
        <div className="h-64 bg-[var(--bg-panel)] border border-[var(--border-hairline)]" />
      </div>
    </div>
  );
}
