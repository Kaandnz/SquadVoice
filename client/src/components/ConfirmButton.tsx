import { ReactNode, useEffect, useState } from 'react';

interface ConfirmButtonProps {
  onConfirm: () => void;
  children: ReactNode;
  /** Shown on the button after the first click; a second click runs onConfirm. */
  armedLabel?: ReactNode;
  className?: string;
  armedClassName?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * Two-click guard for irreversible actions (delete history, kick, delete channel).
 * Avoids window.confirm, which blocks the page and is unreliable inside Tauri webviews.
 * Disarms itself after a few seconds or when focus leaves the button.
 */
export function ConfirmButton({
  onConfirm,
  children,
  armedLabel = 'Emin misin?',
  className,
  armedClassName = 'action-pill danger confirm-armed',
  title,
  disabled,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={armed ? armedClassName : className}
      title={armed ? 'Onaylamak için tekrar tıkla' : title}
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? armedLabel : children}
    </button>
  );
}
