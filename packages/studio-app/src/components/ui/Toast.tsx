import { useEffect, useRef, useState } from "react";
import { TOAST_EVENT_NAME, type ToastEventDetail } from "../../lib/notify";
import { cn } from "./cn";

interface ToastItem {
  id: number;
  status: "completed" | "failed";
  jobName: string;
  jobId: string;
  message: string;
}

const AUTO_DISMISS_MS = 6000;
const MAX_VISIBLE = 3;

export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  useEffect(() => {
    const onToast = (ev: Event) => {
      const detail = (ev as CustomEvent<ToastEventDetail>).detail;
      if (!detail) return;
      const id = counterRef.current++;
      setToasts((prev) => {
        const next = [
          ...prev,
          {
            id,
            status: detail.status,
            jobName: detail.jobName,
            jobId: detail.jobId,
            message: detail.message,
          },
        ];
        return next.length > MAX_VISIBLE ? next.slice(-MAX_VISIBLE) : next;
      });
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);
    };
    window.addEventListener(TOAST_EVENT_NAME, onToast);
    return () => window.removeEventListener(TOAST_EVENT_NAME, onToast);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed top-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          toast={t}
          onDismiss={() =>
            setToasts((prev) => prev.filter((x) => x.id !== t.id))
          }
        />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: () => void;
}) {
  const tone =
    toast.status === "completed"
      ? "border-emerald-200 bg-white dark:border-emerald-400/30 dark:bg-zinc-950"
      : "border-red-200 bg-white dark:border-red-400/30 dark:bg-zinc-950";
  const accent =
    toast.status === "completed"
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-red-700 dark:text-red-300";

  function openJob() {
    window.location.hash = `#/jobs/${encodeURIComponent(toast.jobId)}`;
    onDismiss();
  }

  return (
    <div
      className={cn(
        "pointer-events-auto rounded-lg border px-4 py-3 shadow-sm",
        tone,
      )}
      role="status"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className={cn("text-xs font-medium uppercase tracking-wider", accent)}>
            {toast.status === "completed" ? "Training run completed" : "Training run failed"}
          </div>
          <div className="mt-0.5 truncate text-sm text-zinc-900 dark:text-zinc-100">
            {toast.message}
          </div>
          <button
            type="button"
            onClick={openJob}
            className="mt-1.5 inline-flex items-center text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            Open job
          </button>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mr-1 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
